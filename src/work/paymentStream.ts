import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { createLogger } from '../logger.js';
import { shouldRestrictToPaymentRoutes } from '../server/paymentHostGuard.js';
import {
  parsePaymentBrowserInput,
  type PaymentBrowserInput,
} from './paymentSessions.js';

const log = createLogger('payment-stream');
const FRAME_INTERVAL_MS = 125;
const MAX_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_MS = 20_000;

type StreamTarget =
  | { kind: 'employee'; key: string }
  | { kind: 'control'; key: string };

export interface PaymentStreamPayments {
  frame(token: string): Promise<Buffer>;
  input(token: string, input: PaymentBrowserInput): Promise<void>;
  controlFrame(id: string): Promise<Buffer>;
  controlInput(id: string, input: PaymentBrowserInput): Promise<void>;
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

function streamTarget(pathname: string): StreamTarget | undefined {
  const employee = pathname.match(/^\/api\/work\/payment-sessions\/([^/]+)\/stream\/?$/);
  if (employee) return { kind: 'employee', key: decodeURIComponent(employee[1]) };
  const control = pathname.match(/^\/api\/work\/payment-control\/([^/]+)\/stream\/?$/);
  if (control) return { kind: 'control', key: decodeURIComponent(control[1]) };
  return undefined;
}

function rejectUpgrade(socket: Duplex, status: 400 | 404): void {
  const message = status === 404 ? 'Not Found' : 'Bad Request';
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function errorMessage(error: unknown): string {
  return (error as Error).message || 'Luồng thanh toán đã đóng';
}

export class PaymentStreamServer {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = requestUrl(request);
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    const target = streamTarget(url.pathname);
    if (!target) {
      rejectUpgrade(socket, 404);
      return;
    }
    const publicRequest = shouldRestrictToPaymentRoutes(
      url.hostname,
      this.getPaymentPublicUrl(),
      Boolean(request.headers['cf-ray']),
    );
    if (target.kind === 'control' && publicRequest) {
      rejectUpgrade(socket, 404);
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws, target));
  };

  constructor(
    private readonly server: Server,
    private readonly payments: PaymentStreamPayments,
    private readonly getPaymentPublicUrl: () => string | undefined,
  ) {
    server.on('upgrade', this.onUpgrade);
  }

  async close(): Promise<void> {
    this.server.off('upgrade', this.onUpgrade);
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private handleConnection(ws: WebSocket, target: StreamTarget): void {
    let stopped = false;
    let frameTimer: NodeJS.Timeout | undefined;
    let frameInFlight = false;
    let urgentFrame = true;
    let alive = true;
    let sentFrames = 0;
    let droppedFrames = 0;
    let captureAttempts = 0;
    let totalCaptureMs = 0;
    let maxCaptureMs = 0;
    let inputQueue = Promise.resolve();

    const frame = () => target.kind === 'employee'
      ? this.payments.frame(target.key)
      : this.payments.controlFrame(target.key);
    const input = (value: PaymentBrowserInput) => target.kind === 'employee'
      ? this.payments.input(target.key, value)
      : this.payments.controlInput(target.key, value);

    const scheduleFrame = (delay: number) => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      if (frameTimer) clearTimeout(frameTimer);
      frameTimer = setTimeout(() => void pumpFrame(), delay);
      frameTimer.unref?.();
    };

    const requestFrame = () => {
      urgentFrame = true;
      if (!frameInFlight) scheduleFrame(0);
    };

    const sendError = (error: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'error', message: errorMessage(error) }));
    };

    const pumpFrame = async () => {
      frameTimer = undefined;
      if (stopped || frameInFlight || ws.readyState !== WebSocket.OPEN) return;
      frameInFlight = true;
      urgentFrame = false;
      const startedAt = Date.now();
      try {
        const jpeg = await frame();
        if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) {
          ws.send(jpeg, { binary: true });
          sentFrames += 1;
        } else {
          droppedFrames += 1;
        }
      } catch (error) {
        sendError(error);
        ws.close(1011, 'Payment browser closed');
        return;
      } finally {
        frameInFlight = false;
      }
      const elapsed = Date.now() - startedAt;
      captureAttempts += 1;
      totalCaptureMs += elapsed;
      maxCaptureMs = Math.max(maxCaptureMs, elapsed);
      scheduleFrame(urgentFrame ? 0 : Math.max(0, FRAME_INTERVAL_MS - elapsed));
    };

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    ws.on('pong', () => { alive = true; });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(1003, 'Text input required');
        return;
      }
      let message: { type?: unknown; input?: unknown };
      try {
        message = JSON.parse(data.toString()) as { type?: unknown; input?: unknown };
      } catch {
        sendError(new Error('Dữ liệu điều khiển không hợp lệ'));
        return;
      }
      if (message.type !== 'input') return;
      inputQueue = inputQueue.then(async () => {
        await input(parsePaymentBrowserInput(message.input));
        requestFrame();
      }).catch((error) => {
        sendError(error);
        ws.close(1011, 'Payment input failed');
      });
    });
    ws.on('error', (error) => log.debug(`socket ${target.kind} lỗi: ${error.message}`));
    ws.on('close', () => {
      stopped = true;
      if (frameTimer) clearTimeout(frameTimer);
      clearInterval(heartbeat);
      const average = captureAttempts ? Math.round(totalCaptureMs / captureAttempts) : 0;
      log.debug(`đóng stream ${target.kind}: sent=${sentFrames}, dropped=${droppedFrames}, capture_avg=${average}ms, capture_max=${maxCaptureMs}ms`);
    });

    ws.send(JSON.stringify({ type: 'ready', transport: 'websocket' }));
    scheduleFrame(0);
  }
}
