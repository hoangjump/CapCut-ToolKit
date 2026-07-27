import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import WebSocket, { type RawData } from 'ws';
import type { PaymentBrowserInput } from './paymentSessions.js';
import { PaymentStreamServer, type PaymentStreamPayments } from './paymentStream.js';

class FakePayments implements PaymentStreamPayments {
  readonly inputs: Array<{ key: string; input: PaymentBrowserInput }> = [];

  async frame(token: string): Promise<Buffer> {
    return Buffer.from(`employee:${token}`);
  }

  async input(token: string, input: PaymentBrowserInput): Promise<void> {
    this.inputs.push({ key: token, input });
  }

  async controlFrame(id: string): Promise<Buffer> {
    return Buffer.from(`control:${id}`);
  }

  async controlInput(id: string, input: PaymentBrowserInput): Promise<void> {
    this.inputs.push({ key: id, input });
  }
}

async function start(): Promise<{
  server: Server;
  stream: PaymentStreamServer;
  payments: FakePayments;
  baseUrl: string;
}> {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const payments = new FakePayments();
  const stream = new PaymentStreamServer(server, payments, () => 'https://pay.example.com');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, stream, payments, baseUrl: `ws://127.0.0.1:${port}` };
}

function firstBinary(client: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Không nhận được frame WebSocket')), 2_000);
    client.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      clearTimeout(timeout);
      resolve(Buffer.from(data as Buffer));
    });
  });
}

async function waitForInput(payments: FakePayments): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!payments.inputs.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(payments.inputs.length, 1);
}

async function stop(server: Server, stream: PaymentStreamServer): Promise<void> {
  await stream.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('payment WebSocket keeps frames isolated and accepts input on the same connection', async () => {
  const runtime = await start();
  const clients = ['one', 'two', 'three'].map((token) => new WebSocket(
    `${runtime.baseUrl}/api/work/payment-sessions/${token}/stream`,
  ));
  try {
    const frames = clients.map(firstBinary);
    await Promise.all(clients.map((client) => once(client, 'open')));
    assert.deepEqual((await Promise.all(frames)).map((frame) => frame.toString()), [
      'employee:one',
      'employee:two',
      'employee:three',
    ]);

    clients[1].send(JSON.stringify({ type: 'input', input: { type: 'click', x: 12, y: 34 } }));
    await waitForInput(runtime.payments);
    assert.deepEqual(runtime.payments.inputs[0], {
      key: 'two',
      input: { type: 'click', x: 12, y: 34, button: undefined },
    });
  } finally {
    for (const client of clients) client.terminate();
    await stop(runtime.server, runtime.stream);
  }
});

test('public Cloudflare requests can stream employee frames but cannot open the admin stream', async () => {
  const runtime = await start();
  const employee = new WebSocket(`${runtime.baseUrl}/api/work/payment-sessions/public-token/stream`, {
    headers: { 'cf-ray': 'test-ray' },
  });
  const employeeFrame = firstBinary(employee);
  let admin: WebSocket | undefined;
  try {
    await once(employee, 'open');
    assert.equal((await employeeFrame).toString(), 'employee:public-token');
    admin = new WebSocket(`${runtime.baseUrl}/api/work/payment-control/session-1/stream`, {
      headers: { 'cf-ray': 'test-ray' },
    });
    admin.on('error', () => {});
    const status = await new Promise<number>((resolve) => {
      admin!.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      admin!.once('open', () => resolve(101));
    });
    assert.equal(status, 404);
  } finally {
    employee.terminate();
    admin?.terminate();
    await stop(runtime.server, runtime.stream);
  }
});
