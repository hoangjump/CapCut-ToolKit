import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { ProxyStore } from '../proxyStore.js';
import { ProfileManager } from '../profileManager.js';
import { BrowserManager } from '../browserManager.js';
import { ProxyLeaseRegistry } from '../proxyLeaseRegistry.js';
import { MailStore } from '../mailStore.js';
import { UsedIpStore } from '../usedIpStore.js';
import { SettingsStore } from '../settingsStore.js';
import { ProjectStore } from '../projectStore.js';
import { createLogger, subscribeLogs, recentLogs } from '../logger.js';
import { TelegramClient } from '../work/telegramClient.js';
import { TelegramWorkService } from '../work/service.js';
import { TelegramWorkStore } from '../work/store.js';
import { registerTelegramWorkRoutes } from '../work/routes.js';
import { PaymentSessionService } from '../work/paymentSessions.js';
import { LocalPaymentBrowser } from '../work/localPaymentBrowser.js';
import { PaymentProxyAllocator } from './paymentProxyAllocator.js';
import { createApiProxyHelpers } from './apiProxy.js';
import { errorMiddleware } from './http.js';
import { registerMailRoutes } from './routes/mails.js';
import { registerMktproxyRoutes } from './routes/mktproxy.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerProxyRoutes } from './routes/proxies.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerProjectRoutes } from './routes/projects.js';

const log = createLogger('server');

export interface ServerConfig {
  host?: string;
  port?: number;
  storeRoot?: string;
  headless?: boolean | 'virtual';
  publicDir?: string;
  embeddedTunnel?: boolean;
}

export interface CreatedApp {
  app: Express;
  storeRoot: string;
  headless: boolean | 'virtual';
  publicDir: string;
  paymentSessions: PaymentSessionService;
  close: () => Promise<void>;
}

export interface StartedServer extends CreatedApp {
  server: Server;
  url: string;
  port: number;
}

// Browser display mode. Camoufox (Firefox) is most convincing headful; its true
// headless mode has detectable tells. In a container (no X server) we run it
// headful inside a virtual display (Xvfb) instead of going truly headless.
//   HEADLESS=false   -> headful (a real on-screen window; local dev)
//   HEADLESS=virtual -> headful inside Xvfb (containers; the production default)
//   HEADLESS=true    -> true headless (fastest, but most detectable)
// Default when unset: 'virtual' in production (Docker), headful locally.
function parseHeadless(): boolean | 'virtual' {
  const env = process.env.HEADLESS;
  if (env === undefined) return process.env.NODE_ENV === 'production' ? 'virtual' : false;
  if (env === 'false') return false;
  if (env === 'virtual') return 'virtual';
  return true;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx) __dirname = src/server; in prod (tsc) = dist/server. Project root
// is two levels up in both cases.
const PROJECT_ROOT = join(__dirname, '..', '..');
// Ưu tiên UI mới (React/shadcn build ở web/dist); nếu chưa build thì fallback về
// UI cũ public/index.html (vanilla) để không bao giờ trắng màn hình.
function resolveDefaultPublicDir(): string {
  const webDist = join(PROJECT_ROOT, 'web', 'dist');
  return existsSync(join(webDist, 'index.html')) ? webDist : join(PROJECT_ROOT, 'public');
}
const DEFAULT_PUBLIC_DIR = resolveDefaultPublicDir();

export async function createApp(config: ServerConfig = {}): Promise<CreatedApp> {
  const storeRoot = config.storeRoot ?? process.env.STORE_ROOT ?? join(process.cwd(), 'profiles-store');
  const headless = config.headless ?? parseHeadless();
  const publicDir = config.publicDir ?? DEFAULT_PUBLIC_DIR;

  const store = new ProxyStore(storeRoot);
  await store.init();

  const profiles = new ProfileManager(storeRoot);
  await profiles.init();

  // IP đã dùng reg CapCut — để mỗi IP chỉ reg 1 lần.
  const usedIps = new UsedIpStore(storeRoot);
  await usedIps.init();
  const proxyLeases = new ProxyLeaseRegistry();

  // resolveApiProxy: mỗi lần pool rút proxy dạng API (mktproxy) cho một profile
  // đăng ký → XOAY tới khi ra egress IP CHƯA dùng reg rồi mới trả config gateway.
  // resolveFreshApiProxy là function declaration (hoisted) nên tham chiếu ở đây
  // hợp lệ dù khai báo bên dưới.
  const settings = new SettingsStore(storeRoot);
  await settings.init();

  // Helper proxy xoay mktproxy. Đặt trước BrowserManager vì nó nhận
  // resolveFreshApiProxy ngay lúc khởi tạo; route /api/proxies gọi lúc chạy.
  const {
    ensureWhitelist, refreshApiProxy, rotatePaymentProxy, verifyPaymentProxy, resolveFreshApiProxy } = createApiProxyHelpers({ store, usedIps, settings, proxyLeases });

  const browsers = new BrowserManager(profiles, store, { headless }, {
    resolveApiProxy: (rec) => resolveFreshApiProxy(rec),
    proxyLeases });

  const mails = new MailStore(storeRoot);
  await mails.init();

  const telegramStore = new TelegramWorkStore(storeRoot);
  const paymentProxyAllocator = new PaymentProxyAllocator(store, usedIps, proxyLeases, {
    rotate: (record) => rotatePaymentProxy(record),
    verify: (proxy, rotated, record) => verifyPaymentProxy(proxy, rotated, record) });
  const paymentSessions = new PaymentSessionService(
    telegramStore,
    settings,
    new LocalPaymentBrowser(settings.getPaymentMaxSessions()),
    paymentProxyAllocator,
  );
  const telegramClient = new TelegramClient();
  const telegramWork = new TelegramWorkService(telegramStore, settings, telegramClient, paymentSessions);
  await telegramWork.init();

  const projects = new ProjectStore(storeRoot);
  await projects.init();

  const app = express();
  // Danh sách mail OAuth2 có refresh token dài; vài nghìn dòng dễ vượt mức
  // 100 KB mặc định của Express dù dữ liệu hợp lệ.
  // Import kho mail gửi cả danh sách trong MỘT request JSON. Mail OAuth2 có
  // refresh token dài ~700 byte/dòng, nên 10 nghìn dòng đã ~7MB. Mức mặc định
  // 100 KB của Express chặn ngay từ ~140 dòng — đó chính là HTTP 413 mà bản cũ
  // gặp phải. 64mb cho thoải mái; vượt mức đó thì errorMiddleware trả câu tiếng
  // Việt bảo chia nhỏ file, chứ không phải "413" trống không.
  app.use(express.json({ limit: '64mb' }));
  app.use(express.static(publicDir));

  // Employee/topic task management. This module has its own bot credentials so
  // it does not interfere with the existing registration notifications.
  registerTelegramWorkRoutes(app, telegramWork);

  // Live log stream (SSE). Sends the ring buffer first so a client connecting
  // mid-run sees recent history, then streams each new line. The log bus in
  // logger.ts captures every scope, so this shows server + per-profile flow logs.
  app.get('/api/logs/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const send = (entry: unknown) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    for (const entry of recentLogs()) send(entry);
    const unsubscribe = subscribeLogs(send);
    // Heartbeat keeps the connection alive through proxies/idle periods.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  registerProxyRoutes(app, { store, refreshApiProxy });

  registerProfileRoutes(app, { profiles, browsers });

  registerSettingsRoutes(app, { store, profiles, mails, projects, settings, storeRoot });

  registerMktproxyRoutes(app, { store, settings, ensureWhitelist });

  registerMailRoutes(app, { mails, settings });

  registerProjectRoutes(app, { profiles, browsers, mails, projects, settings, telegramWork, storeRoot, headless });

  // Chốt chuỗi: mọi lỗi ném ra từ handler (kể cả reject của handler async, thứ
  // Express 4 KHÔNG tự bắt) đổ về đây thành JSON thay vì treo request.
  app.use(errorMiddleware(log));

  return {
    app,
    storeRoot,
    headless,
    publicDir,
    paymentSessions,
      close: async () => {
      await telegramWork.close();
      await browsers.closeAll();
    } };
}

export async function startServer(config: ServerConfig = {}): Promise<StartedServer> {
  const created = await createApp(config);
  // Mặc định CHỈ nghe loopback. Toàn bộ API quản trị không có xác thực, và
  // GET /api/store/export trả về API key thô + mail password — bind 0.0.0.0 là
  // phơi hết ra LAN. Docker cần nghe mọi interface thì đặt HOST=0.0.0.0.
  const host = config.host ?? process.env.HOST ?? '127.0.0.1';
  const port = config.port ?? Number(process.env.PORT ?? 3000);

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = created.app.listen(port, host, () => resolve(listening));
    listening.once('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  const urlHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${urlHost}:${resolvedPort}`;

  log.info(`proxy manager listening on ${url}`);
  log.info(`serving UI from ${created.publicDir}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    log.warn(`đang nghe trên ${host} — API quản trị KHÔNG có xác thực, chỉ dùng trong mạng bạn tin tưởng`);
  }

  return {
    ...created,
    server,
    url,
    port: resolvedPort,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw err;
      });
      await created.close();
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
