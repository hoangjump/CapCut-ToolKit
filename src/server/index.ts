import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ProxyStore,
  parseProxyLine,
  proxyDisplay,
  type ProxyRecord,
  type ProxyType,
} from '../proxyStore.js';
import { checkProxy } from '../proxyChecker.js';
import { ProfileManager } from '../profileManager.js';
import { BrowserManager } from '../browserManager.js';
import { ProxyLeaseRegistry } from '../proxyLeaseRegistry.js';
import { MailStore, parseMailLine, providerFromEmail } from '../mailStore.js';
import { UsedIpStore } from '../usedIpStore.js';
import { SettingsStore, maskKey } from '../settingsStore.js';
import { getBalance, getAccountTypes, buyMail, getCode, getMessages } from '../mailClient.js';
import * as selltaikhoan from '../selltaikhoanClient.js';
import * as smsbower from '../smsbowerClient.js';
import * as mktproxy from '../mktproxyClient.js';
import { ProjectStore } from '../projectStore.js';
import { runProject } from '../automation/runner.js';
import type { SheetRow } from '../automation/types.js';
import { flowMetas } from '../flows/index.js';
import { tileNow } from '../windowTiler.js';
import { profilePresets, projectPresets } from '../presets.js';
import {
  defaultAntiDetect,
  defaultBrowserSettings,
  defaultProxyRotation,
  type AntiDetectConfig,
  type BrowserSettings,
  type MailCodeType,
  type Profile,
  type ProjectRecord,
  type ProxyRotation,
  type ProxyPoolFilter,
  type ProxyConfig,
} from '../types.js';
import { createLogger, subscribeLogs, recentLogs } from '../logger.js';
import { TelegramClient } from '../work/telegramClient.js';
import { TelegramWorkService } from '../work/service.js';
import { TelegramWorkStore } from '../work/store.js';
import { registerTelegramWorkRoutes } from '../work/routes.js';
import { PaymentSessionService } from '../work/paymentSessions.js';
import { LocalPaymentBrowser } from '../work/localPaymentBrowser.js';
import { PaymentStreamServer } from '../work/paymentStream.js';
import { paymentHostGuard } from './paymentHostGuard.js';
import { TunnelManager } from './tunnelManager.js';
import { PaymentProxyAllocator, type RotatedPaymentProxy } from './paymentProxyAllocator.js';

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
  tunnel: TunnelManager;
  paymentSessions: PaymentSessionService;
  getPaymentPublicUrl: () => string | undefined;
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

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Normalize a project's ephemeral proxy-pool config from the request body.
 *  Accepts { tags?: string[], liveOnly?: boolean }. Returns undefined when the
 *  caller didn't enable a pool (falsey/empty) so ephemeral profiles fall back to
 *  a direct connection. An empty tags array means "any live proxy". */
function parseEphemeralPool(raw: unknown): ProxyPoolFilter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as { tags?: unknown; liveOnly?: unknown };
  const tags = Array.isArray(obj.tags)
    ? obj.tags.map(String).map((t) => t.trim()).filter(Boolean)
    : [];
  const liveOnly = obj.liveOnly === undefined ? true : Boolean(obj.liveOnly);
  return { tags, liveOnly };
}

function parseTelegramDistribution(raw: unknown): ProjectRecord['telegramDistribution'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { enabled?: unknown; allocations?: unknown };
  const allocations = Array.isArray(value.allocations)
    ? value.allocations
        .map((item) => item as { employeeId?: unknown; quantity?: unknown })
        .map((item) => ({ employeeId: String(item.employeeId ?? '').trim(), quantity: Number(item.quantity ?? 0) }))
        .filter((item) => item.employeeId && Number.isSafeInteger(item.quantity) && item.quantity >= 0)
    : [];
  return { enabled: value.enabled === true, allocations };
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

const VALID_TYPES: ProxyType[] = ['http', 'https', 'socks5'];

/** Shape returned to the UI — adds derived display string + status label.
 *  KHÔNG trả apiKey (bí mật) về UI, chỉ cờ isApi để hiển thị nhãn. */
function toDto(p: ProxyRecord) {
  const { apiKey, ...rest } = p;
  void apiKey;
  return {
    ...rest,
    display: proxyDisplay(p),
    status: p.alive === null ? 'unchecked' : p.alive ? 'live' : 'dead',
    isApi: Boolean(p.apiProvider),
    apiProvider: p.apiProvider,
  };
}

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
  const browsers = new BrowserManager(profiles, store, { headless }, {
    resolveApiProxy: (rec) => resolveFreshApiProxy(rec),
    proxyLeases,
  });

  const mails = new MailStore(storeRoot);
  await mails.init();

  const settings = new SettingsStore(storeRoot);
  await settings.init();
  const tunnel = new TunnelManager(settings);

  const telegramStore = new TelegramWorkStore(storeRoot);
  const paymentProxyAllocator = new PaymentProxyAllocator(store, usedIps, proxyLeases, {
    rotate: (record) => rotatePaymentProxy(record),
    verify: (proxy, rotated, record) => verifyPaymentProxy(proxy, rotated, record),
  });
  const paymentSessions = new PaymentSessionService(
    telegramStore,
    settings,
    new LocalPaymentBrowser(),
    paymentProxyAllocator,
  );
  const telegramClient = new TelegramClient();
  const telegramWork = new TelegramWorkService(telegramStore, settings, telegramClient, paymentSessions);
  await telegramWork.init();

  const projects = new ProjectStore(storeRoot);
  await projects.init();

  const app = express();
  app.use(paymentHostGuard(() => settings.getPaymentPublicUrl()));
  app.use(express.json());
  app.use(express.static(publicDir));

  // Employee/topic task management. This module has its own bot credentials so
  // it does not interfere with the existing registration notifications.
  registerTelegramWorkRoutes(app, telegramWork, paymentSessions, tunnel);
  app.get('/pay/health', (_req, res) => res.status(204).end());
  app.get('/pay/:token', (_req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.sendFile(join(publicDir, 'index.html'));
  });

  // Live log stream (SSE). Sends the ring buffer first so a client connecting
  // mid-run sees recent history, then streams each new line. The log bus in
  // logger.ts captures every scope, so this shows server + per-profile flow logs.
  app.get('/api/logs/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
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

  app.get('/api/proxies', (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').toLowerCase().trim();
    let list = store.list();
    if (q) {
      list = list.filter((p) => {
        const hay = `${proxyDisplay(p)} ${p.type} ${p.tags.join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    }
    res.json(list.map(toDto));
  });

  // Create one or many. Accepts {type, host, port, ...} OR {type, lines, tags}
  // where `lines` is a newline/comma separated blob of host:port:user:pass.
  app.post('/api/proxies', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const type: ProxyType = VALID_TYPES.includes(body.type) ? body.type : 'socks5';
      const tags: string[] = Array.isArray(body.tags)
        ? body.tags
        : typeof body.tags === 'string' && body.tags.trim()
          ? body.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
          : [];

      // Proxy dạng API (mktproxy xoay): tạo entry giữ key đơn hàng, rồi resolve
      // IP hiện tại qua /proxies/new để điền host/port + xác thực key. Key sai /
      // chưa có IP → xóa entry và báo lỗi.
      if (body.apiProvider === 'mktproxy' && body.apiKey) {
        const rec = await store.create({
          type, tags, host: '', port: 0,
          apiProvider: 'mktproxy', apiKey: String(body.apiKey).trim(),
        });
        const refreshed = await refreshApiProxy(rec);
        if (!refreshed.host) {
          await store.delete(rec.id);
          res.status(400).json({ error: 'Key proxy API không hợp lệ hoặc chưa có IP (đơn mới thử lại sau vài giây).' });
          return;
        }
        res.status(201).json([toDto(refreshed)]);
        return;
      }

      const created: ProxyRecord[] = [];
      if (typeof body.lines === 'string' && body.lines.trim()) {
        const lines = body.lines.split(/[\n,]+/).map((l: string) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const parsed = parseProxyLine(line);
          created.push(await store.create({ type, tags, ...parsed }));
        }
      } else {
        const port = Number(body.port);
        if (!body.host || !Number.isInteger(port)) {
          res.status(400).json({ error: 'host và port là bắt buộc' });
          return;
        }
        created.push(
          await store.create({
            type,
            host: String(body.host),
            port,
            username: body.username || undefined,
            password: body.password || undefined,
            tags,
          }),
        );
      }
      res.status(201).json(created.map(toDto));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/proxies/:id', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const patch: Partial<ProxyRecord> = {};
      if (body.type && VALID_TYPES.includes(body.type)) patch.type = body.type;
      if (body.host) patch.host = String(body.host);
      if (body.port !== undefined) patch.port = Number(body.port);
      if (body.username !== undefined) patch.username = body.username || undefined;
      if (body.password !== undefined) patch.password = body.password || undefined;
      if (body.tags !== undefined) {
        patch.tags = Array.isArray(body.tags)
          ? body.tags
          : String(body.tags).split(',').map((t) => t.trim()).filter(Boolean);
      }
      const updated = await store.update(String(req.params.id), patch);
      res.json(toDto(updated));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/proxies/:id', async (req: Request, res: Response) => {
    try {
      await store.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Proxy dạng API (mktproxy xoay): resolve IP hiện tại qua /proxies/new (fallback
  // /rotate-ip) rồi cập nhật ảnh chụp host/port/user/pass trên record để check +
  // để profile dùng bản mới nhất. Proxy tĩnh: trả nguyên record. Lỗi API thì giữ
  // ảnh chụp cũ (vẫn check được gateway).
  // IP công khai của máy đang chạy app (gọi TRỰC TIẾP, không qua proxy). Dùng để
  // whitelist cho proxy auth_type=ip_whitelist.
  async function getPublicIp(): Promise<string | null> {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8_000) });
      const j = (await res.json()) as { ip?: string };
      return j?.ip || null;
    } catch {
      return null;
    }
  }

  // Whitelist IP máy cho proxy xoay dạng ip_whitelist (best-effort). Proxy dùng
  // userpass thì endpoint này có thể lỗi — bỏ qua, không chặn luồng. Đây chính là
  // thứ khắc phục "read ECONNRESET": proxy chỉ nhận kết nối từ IP đã whitelist.
  async function ensureWhitelist(itemKey: string): Promise<void> {
    const accountKey = settings.getMktproxyKey();
    const ip = await getPublicIp();
    if (!ip) return;
    if (!accountKey) {
      log.warn('mktproxy: chưa có API key TÀI KHOẢN → không whitelist được IP (proxy ip_whitelist sẽ bị ECONNRESET). Nhập key tài khoản ở card "Mua proxy".');
      return;
    }
    try {
      await mktproxy.updateIpWhitelist(accountKey, itemKey, [ip]);
      log.info(`mktproxy: whitelist IP ${ip} cho đơn ${itemKey.slice(0, 6)}…`);
    } catch (e) {
      log.warn(`mktproxy: whitelist lỗi (${(e as Error).message}) — key TÀI KHOẢN phải đúng (KHÁC key đơn proxy).`);
    }
  }

  async function refreshApiProxy(proxy: ProxyRecord): Promise<ProxyRecord> {
    if (proxy.apiProvider !== 'mktproxy' || !proxy.apiKey) return proxy;
    if (proxyLeases.isLeased(proxy.id)) {
      log.warn(`mktproxy: proxy ${proxy.id} đang được một phiên sử dụng, bỏ qua rotate`);
      return proxy;
    }
    // Whitelist IP máy trước — proxy ip_whitelist sẽ reset kết nối nếu IP chưa
    // được cho phép (ECONNRESET). Chạy mỗi lần test để bám theo IP hiện tại.
    await ensureWhitelist(proxy.apiKey);
    try {
      // rotate-ip để KÍCH HOẠT egress: proxies/new chỉ đọc cache, đơn có thể chưa
      // "live" nên connect bị reset dù đã whitelist. rotate-ip trong cooldown trả
      // proxy hiện tại (an toàn, không tốn thêm). Fallback proxies/new nếu lỗi.
      let rp = await mktproxy.rotateIp(proxy.apiKey).catch(() => null);
      if (!rp || !rp.value) rp = await mktproxy.getCurrentProxy(proxy.apiKey).catch(() => null);
      if (!rp) return proxy;
      // DÙNG ĐÚNG protocol NCC trả (proxy này là HTTP, không phải socks5) — sai
      // giao thức là ECONNRESET. value thường không kèm user:pass (auth theo IP).
      const proto: ProxyType = rp?.protocol === 'socks5' ? 'socks5' : rp?.protocol === 'http' ? 'http' : proxy.type;
      const line = ((proto === 'socks5' ? rp?.socks5 : rp?.http) || rp?.value || '').trim();
      if (!line) return proxy;
      const parsed = parseProxyLine(line);
      return await store.update(proxy.id, {
        type: proto, host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password,
      });
    } catch (e) {
      log.warn(`mktproxy: refresh proxy API lỗi (${proxy.id}): ${(e as Error).message}`);
      return proxy;
    }
  }

  /** Dựng ProxyConfig gateway từ response rotate + cập nhật ảnh chụp record. */
  function buildApiConfig(record: ProxyRecord, rp: mktproxy.MktRotatingProxy): ProxyConfig | undefined {
    const proto: ProxyType = rp.protocol === 'socks5' ? 'socks5' : rp.protocol === 'http' ? 'http' : record.type;
    const line = ((proto === 'socks5' ? rp.socks5 : rp.http) || rp.value || '').trim();
    let host = '';
    let port = 0;
    let username: string | undefined;
    let password: string | undefined;
    try {
      const p = parseProxyLine(line);
      host = p.host; port = p.port; username = p.username; password = p.password;
    } catch {
      if (rp.ip && rp.port) { host = rp.ip; port = Number(rp.port); }
      else return undefined;
    }
    void store.update(record.id, { type: proto, host, port, username, password }).catch(() => {});
    return { server: `${proto}://${host}:${port}`, username, password };
  }

  async function rotatePaymentProxy(record: ProxyRecord): Promise<RotatedPaymentProxy> {
    if (record.apiProvider !== 'mktproxy' || !record.apiKey) {
      throw new Error('Payment strict chỉ sử dụng proxy xoay MKTProxy');
    }
    await ensureWhitelist(record.apiKey);
    let rotated = await mktproxy.rotateIp(record.apiKey).catch(() => null);
    if (!rotated?.value) rotated = await mktproxy.getCurrentProxy(record.apiKey).catch(() => null);
    if (!rotated?.value) throw new Error(`MKTProxy không trả proxy cho đơn ${record.apiKey.slice(0, 6)}…`);
    const proxy = buildApiConfig(record, rotated);
    if (!proxy) throw new Error(`MKTProxy trả cấu hình proxy không hợp lệ cho ${record.apiKey.slice(0, 6)}…`);
    return {
      proxy,
      egressIp: rotated.realIp || rotated.ip,
      retryAfterMs: Math.max(1_000, Number(rotated.second || 5) * 1_000),
    };
  }

  async function verifyPaymentProxy(
    proxy: ProxyConfig,
    rotated: RotatedPaymentProxy,
    record: ProxyRecord,
  ): Promise<string | undefined> {
    const parsed = new URL(proxy.server);
    const protocol = parsed.protocol.replace(':', '');
    const type: ProxyType = protocol === 'socks5' ? 'socks5' : protocol === 'https' ? 'https' : 'http';
    const checked = await checkProxy({
      ...record,
      type,
      host: parsed.hostname,
      port: Number(parsed.port),
      username: proxy.username,
      password: proxy.password,
    }, 10_000);
    await store.update(record.id, {
      alive: checked.alive,
      latencyMs: checked.latencyMs,
      checkedAt: new Date().toISOString(),
    });
    if (!checked.alive) throw new Error(`Proxy payment không hoạt động: ${checked.error || 'không kết nối được'}`);
    if (!checked.ip) throw new Error('Proxy payment không trả IP thực tế');
    if (rotated.egressIp && rotated.egressIp !== checked.ip) {
      log.warn(`mktproxy: API báo IP ${rotated.egressIp} nhưng kiểm tra thực tế là ${checked.ip}`);
    }
    log.info(`mktproxy: dành IP payment mới ${checked.ip} từ đơn ${record.apiKey?.slice(0, 6)}…`);
    return checked.ip;
  }

  /**
   * Rút proxy dạng API cho MỘT profile đăng ký: whitelist IP máy, rồi XOAY
   * (rotate-ip) tới khi egress `real_ip` CHƯA từng dùng reg CapCut (usedIps) →
   * đánh dấu đã dùng → trả config gateway. Tôn trọng cooldown (chờ `second` giây
   * giữa các lần xoay), trần chờ 4 phút; hết cách thì dùng IP hiện tại để không
   * treo. Nhờ vậy mỗi account một IP mới (100 account / 5 proxy ≈ 20 IP/proxy).
   */
  async function resolveFreshApiProxy(record: ProxyRecord): Promise<ProxyConfig | undefined> {
    if (record.apiProvider !== 'mktproxy' || !record.apiKey) {
      if (!record.host) return undefined;
      return { server: `${record.type}://${record.host}:${record.port}`, username: record.username, password: record.password };
    }
    await ensureWhitelist(record.apiKey);
    const deadline = Date.now() + 4 * 60_000;
    let last: mktproxy.MktRotatingProxy | null = null;
    for (let i = 0; i < 30 && Date.now() < deadline; i += 1) {
      let rp = await mktproxy.rotateIp(record.apiKey).catch(() => null);
      if (!rp || !rp.value) rp = await mktproxy.getCurrentProxy(record.apiKey).catch(() => null);
      if (!rp || !rp.value) break;
      last = rp;
      const egress = rp.realIp || rp.ip || '';
      if (!egress || !usedIps.has(egress)) {
        await usedIps.add(egress);
        log.info(`mktproxy: dùng IP mới ${egress || '(không rõ)'} cho reg (đơn ${record.apiKey.slice(0, 6)}…, đã dùng ${usedIps.count()})`);
        return buildApiConfig(record, rp);
      }
      const waitS = Math.min(rp.second && rp.second > 0 ? rp.second : 60, 65);
      if (Date.now() + waitS * 1000 >= deadline) break;
      log.info(`mktproxy: IP ${egress} đã dùng reg — chờ ${waitS}s xoay lại (đơn ${record.apiKey.slice(0, 6)}…)`);
      await new Promise((r) => setTimeout(r, waitS * 1000 + 500));
    }
    if (last?.value) {
      await usedIps.add(last.realIp || last.ip);
      log.warn('mktproxy: không lấy được IP mới sau khi chờ — dùng IP hiện tại');
      return buildApiConfig(record, last);
    }
    return undefined;
  }

  // Check a single proxy and persist the result. Proxy API được resolve IP mới trước.
  app.post('/api/proxies/:id/check', async (req: Request, res: Response) => {
    let proxy = store.get(String(req.params.id));
    if (!proxy) {
      res.status(404).json({ error: 'Proxy not found' });
      return;
    }
    proxy = await refreshApiProxy(proxy);
    const result = await checkProxy(proxy);
    const updated = await store.update(proxy.id, {
      alive: result.alive,
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString(),
    });
    res.json({ ...toDto(updated), checkResult: result });
  });

  // Check every proxy concurrently (bounded) — used by the "Làm mới" button.
  app.post('/api/proxies/check-all', async (_req: Request, res: Response) => {
    const all = store.list();
    const concurrency = 8;
    let i = 0;
    const worker = async () => {
      while (i < all.length) {
        const proxy = all[i++];
        const result = await checkProxy(proxy);
        await store.update(proxy.id, {
          alive: result.alive,
          latencyMs: result.latencyMs,
          checkedAt: new Date().toISOString(),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, worker));
    res.json(store.list().map(toDto));
  });

  // ---- Profiles ----------------------------------------------------------
  app.get('/api/profiles', (_req: Request, res: Response) => {
    res.json(profiles.list());
  });

  // Ids of profiles whose browser context is currently open. Must be registered
  // before '/api/profiles/:id' so "running" isn't captured as an id.
  app.get('/api/profiles/running', (_req: Request, res: Response) => {
    res.json({ running: browsers.openProfileIds() });
  });

  app.get('/api/profiles/:id', (req: Request, res: Response) => {
    const profile = profiles.get(String(req.params.id));
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json(profile);
  });

  app.post('/api/profiles', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (!body.name || !String(body.name).trim()) {
        res.status(400).json({ error: 'name là bắt buộc' });
        return;
      }
      const created = await profiles.create({
        name: String(body.name).trim(),
        group: typeof body.group === 'string' ? body.group.trim() || undefined : undefined,
        taskbarTitle: typeof body.taskbarTitle === 'string' ? body.taskbarTitle.trim() || undefined : undefined,
        proxy: body.proxy,
        proxyRotation: body.proxyRotation,
        antiDetect: body.antiDetect,
        browser: body.browser,
        notes: body.notes,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Merge anti-detect / browser settings so the UI can PATCH a subset.
  app.put('/api/profiles/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const existing = profiles.get(id);
      if (!existing) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }
      const body = req.body ?? {};
      const patch: Partial<Omit<Profile, 'id' | 'createdAt'>> = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (body.group !== undefined) patch.group = String(body.group).trim() || undefined;
      if (body.taskbarTitle !== undefined) patch.taskbarTitle = String(body.taskbarTitle).trim() || undefined;
      if (body.proxy !== undefined) patch.proxy = body.proxy || undefined;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.antiDetect && typeof body.antiDetect === 'object') {
        patch.antiDetect = {
          ...(existing.antiDetect ?? defaultAntiDetect()),
          ...(body.antiDetect as Partial<AntiDetectConfig>),
        };
      }
      if (body.browser && typeof body.browser === 'object') {
        patch.browser = {
          ...(existing.browser ?? defaultBrowserSettings()),
          ...(body.browser as Partial<BrowserSettings>),
        };
      }
      if (body.proxyRotation && typeof body.proxyRotation === 'object') {
        patch.proxyRotation = {
          ...(existing.proxyRotation ?? defaultProxyRotation()),
          ...(body.proxyRotation as Partial<ProxyRotation>),
        };
      }
      const updated = await profiles.update(id, patch);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Xóa TẤT CẢ profile. Đóng mọi browser đang mở trước (ProfileManager không sở
  // hữu context) để không rớt lại tiến trình Chromium mồ côi. Phải đăng ký TRƯỚC
  // '/api/profiles/:id' để Express không bắt nhầm chuỗi rỗng thành :id.
  app.delete('/api/profiles', async (req: Request, res: Response) => {
    try {
      const wipeData = String(req.query.wipeData ?? '') === 'true';
      await browsers.closeAll();
      const removed = await profiles.deleteAll({ wipeData });
      res.json({ removed });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/profiles/:id', async (req: Request, res: Response) => {
    try {
      const wipeData = String(req.query.wipeData ?? '') === 'true';
      await profiles.delete(String(req.params.id), { wipeData });
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Launch a profile's browser context (idempotent — returns ok if already open).
  app.post('/api/profiles/:id/open', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!profiles.get(id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    try {
      await browsers.open(id);
      res.json({ id, running: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Close a profile's browser context, flushing its session to disk.
  app.post('/api/profiles/:id/close', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      await browsers.close(id);
      res.json({ id, running: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Rotate a profile's proxy (pool: draw fresh; gateway: new session). If open,
  // the profile is closed + reopened so the new IP applies immediately. 400 for
  // 'static' (nothing to rotate) or an exhausted pool.
  app.post('/api/profiles/:id/rotate-proxy', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!profiles.get(id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    try {
      await browsers.rotate(id, 'manual');
      const updated = profiles.get(id);
      const proxy = updated?.proxy ? updated.proxy.server : null;
      res.json({ id, proxy, running: browsers.isOpen(id) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- Settings ----------------------------------------------------------
  // API key bills real money — never return it raw, only a masked preview.
  function settingsDto() {
    return {
      hasKey: Boolean(settings.getApiKey()),
      masked: maskKey(settings.getApiKey()),
      sheetWebhookUrl: settings.getSheetWebhookUrl() ?? '',
      hasMktproxyKey: Boolean(settings.getMktproxyKey()),
      mktproxyMasked: maskKey(settings.getMktproxyKey()),
      hasSelltaikhoanKey: Boolean(settings.getSelltaikhoanKey()),
      selltaikhoanMasked: maskKey(settings.getSelltaikhoanKey()),
      hasSmsbowerKey: Boolean(settings.getSmsbowerKey()),
      smsbowerMasked: maskKey(settings.getSmsbowerKey()),
      hasTelegram: Boolean(settings.getTelegramBotToken() && settings.getTelegramChatId()),
      telegramMasked: maskKey(settings.getTelegramBotToken()),
      telegramChatId: settings.getTelegramChatId() ?? '',
    };
  }

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(settingsDto());
  });

  app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (body.dongvanfbApiKey !== undefined) {
        await settings.setApiKey(String(body.dongvanfbApiKey));
      }
      if (body.sheetWebhookUrl !== undefined) {
        await settings.setSheetWebhookUrl(String(body.sheetWebhookUrl));
      }
      if (body.mktproxyApiKey !== undefined) {
        await settings.setMktproxyKey(String(body.mktproxyApiKey));
      }
      if (body.selltaikhoanApiKey !== undefined) {
        await settings.setSelltaikhoanKey(String(body.selltaikhoanApiKey));
      }
      if (body.smsbowerApiKey !== undefined) {
        await settings.setSmsbowerKey(String(body.smsbowerApiKey));
      }
      if (body.telegramBotToken !== undefined) {
        await settings.setTelegramBotToken(String(body.telegramBotToken));
      }
      if (body.telegramChatId !== undefined) {
        await settings.setTelegramChatId(String(body.telegramChatId));
      }
      res.json(settingsDto());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- Export / Import toàn bộ store (5 file JSON) -----------------------
  // Gói: profiles + projects + proxies + mails + settings. KHÔNG gồm thư mục
  // data/ (session từng hồ sơ) và shots/ — chỉ cấu hình, cho nhẹ & dễ chuyển máy.
  // LƯU Ý BẢO MẬT: settings.json chứa API key thật (mktproxy/dongvanfb/telegram)
  // ở dạng thô — file export mang theo secret, giữ kín như mật khẩu.
  const STORE_FILES = ['profiles', 'projects', 'proxies', 'mails', 'settings'] as const;

  app.get('/api/store/export', async (_req: Request, res: Response) => {
    try {
      const bundle: Record<string, unknown> = {
        _format: 'teamhatde-store',
        _version: 1,
        _exportedAt: new Date().toISOString(),
      };
      for (const name of STORE_FILES) {
        const file = join(storeRoot, `${name}.json`);
        if (existsSync(file)) {
          bundle[name] = JSON.parse(await readFile(file, 'utf8'));
        } else {
          bundle[name] = name === 'settings' ? {} : [];
        }
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="teamhatde-backup-${stamp}.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Gộp theo id, GIỮ bản đang có (imported chỉ thêm id mới). Với settings: giữ
  // key đang có, chỉ thêm key còn thiếu. Ghi file xong nạp lại store để vào RAM.
  app.post('/api/store/import', async (req: Request, res: Response) => {
    try {
      const bundle = req.body ?? {};
      if (bundle._format && bundle._format !== 'teamhatde-store') {
        res.status(400).json({ error: 'File không đúng định dạng backup của app.' });
        return;
      }
      const added: Record<string, number> = {};

      for (const name of ['profiles', 'projects', 'proxies', 'mails'] as const) {
        const incoming = bundle[name];
        if (!Array.isArray(incoming)) continue;
        const file = join(storeRoot, `${name}.json`);
        const current: Array<{ id?: string }> = existsSync(file)
          ? JSON.parse(await readFile(file, 'utf8'))
          : [];
        const seen = new Set(current.map((it) => it.id).filter(Boolean));
        let n = 0;
        for (const item of incoming as Array<{ id?: string }>) {
          if (item && item.id && !seen.has(item.id)) {
            current.push(item);
            seen.add(item.id);
            n += 1;
          }
        }
        added[name] = n;
        await writeFile(file, JSON.stringify(current, null, 2), 'utf8');
      }

      // settings: chỉ thêm key còn thiếu, không đè key đang có.
      if (bundle.settings && typeof bundle.settings === 'object') {
        const file = join(storeRoot, 'settings.json');
        const current: Record<string, unknown> = existsSync(file)
          ? JSON.parse(await readFile(file, 'utf8'))
          : {};
        let n = 0;
        for (const [k, v] of Object.entries(bundle.settings)) {
          if (current[k] === undefined && v !== undefined) {
            current[k] = v;
            n += 1;
          }
        }
        added.settings = n;
        await writeFile(file, JSON.stringify(current, null, 2), 'utf8');
      }

      // Nạp lại tất cả store từ đĩa vào Map trong RAM.
      await Promise.all([
        store.init(),
        profiles.init(),
        projects.init(),
        mails.init(),
        settings.init(),
      ]);

      res.json({ ok: true, added });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Sắp xếp lại cửa sổ Camoufox thành lưới (thủ công). No-op ngoài Windows.
  app.post('/api/windows/tile', async (_req: Request, res: Response) => {
    try {
      await tileNow();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- mktproxy.com (mua proxy) ------------------------------------------
  // products is public; balance/buy/orders need the stored X-API-Key.
  function requireMktKey(res: Response): string | null {
    const key = settings.getMktproxyKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key mktproxy (vào phần Cài đặt).' });
      return null;
    }
    return key;
  }

  app.get('/api/mktproxy/products', async (_req: Request, res: Response) => {
    try {
      res.json({ products: await mktproxy.listProducts(settings.getMktproxyKey()) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mktproxy/balance', async (_req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    try {
      res.json({ balance: await mktproxy.getBalance(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mktproxy/orders', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      res.json({ orders: await mktproxy.listOrders(key, { status }) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mktproxy/orders/:code', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    try {
      res.json(await mktproxy.getOrder(key, String(req.params.code)));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Import an order's delivered proxies into the ProxyStore library (dùng ngay ở
  // chế độ pool). Idempotent-ish: skips proxies whose host:port already exist.
  // PROXY XOAY: item chỉ có `key` (chưa kèm chuỗi proxy) — đơn xoay trả gateway
  // qua endpoint riêng. Ta gọi /proxies/new (đọc cache); nếu đơn mới chưa kích
  // hoạt (NO_PROXY_DATA) thì gọi /proxies/rotate-ip để lấy proxy lần đầu, rồi
  // chọn biến thể http/socks5 theo `type`.
  async function importProxiesToStore(
    proxies: mktproxy.MktProxyItem[],
    type: ProxyType,
    tags: string[],
  ): Promise<ProxyRecord[]> {
    const existing = new Set(store.list().map((p) => `${p.host}:${p.port}`));
    const created: ProxyRecord[] = [];
    for (const item of proxies) {
      let line = (item.proxy || '').trim();
      let itemType: ProxyType = type;
      // viaApi: đơn xoay giao qua key (không kèm chuỗi sẵn) — resolve IP hiện tại
      // và ĐÁNH DẤU là proxy dạng API (giữ key để Test/xoay lại sau này).
      const viaApi = !line && !!item.key;
      if (viaApi && item.key) {
        await ensureWhitelist(item.key);
        try {
          // rotate-ip để kích hoạt egress (xem ghi chú ở refreshApiProxy).
          let rp = await mktproxy.rotateIp(item.key).catch(() => null);
          if (!rp || !rp.value) rp = await mktproxy.getCurrentProxy(item.key).catch(() => null);
          // Lưu đúng protocol NCC trả (tránh ECONNRESET do sai giao thức).
          itemType = rp?.protocol === 'socks5' ? 'socks5' : rp?.protocol === 'http' ? 'http' : type;
          line = ((itemType === 'socks5' ? rp?.socks5 : rp?.http) || rp?.value || '').trim();
          log.info(`mktproxy: proxy xoay (key ${item.key.slice(0, 6)}…) → ${line || 'chưa lấy được'} [${itemType}]`);
        } catch (e) {
          log.warn(`mktproxy: lấy proxy xoay lỗi (key ${item.key.slice(0, 6)}…): ${(e as Error).message}`);
        }
      }
      if (!line) continue;
      let parsed;
      try {
        parsed = parseProxyLine(line);
      } catch {
        continue; // dòng proxy không parse được thì bỏ qua
      }
      if (existing.has(`${parsed.host}:${parsed.port}`)) continue;
      created.push(await store.create({
        type: itemType, tags, ...parsed,
        ...(viaApi ? { apiProvider: 'mktproxy' as const, apiKey: item.key } : {}),
      }));
      existing.add(`${parsed.host}:${parsed.port}`);
    }
    return created;
  }

  // Buy proxy(s) then poll the order until delivered, importing the resulting
  // proxies into the library. Body: { productCode, quantity?, duration?,
  // protocol?, customFields?, tags?, ipWhitelist? }.
  app.post('/api/mktproxy/buy', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    const body = req.body ?? {};
    if (!body.productCode) {
      res.status(400).json({ error: 'productCode là bắt buộc' });
      return;
    }
    const protocol = body.protocol === 'socks5' ? 'socks5' : body.protocol === 'http' ? 'http' : undefined;
    const importType: ProxyType = protocol === 'socks5' ? 'socks5' : 'http';
    const tags: string[] = Array.isArray(body.tags)
      ? body.tags.map(String).map((t: string) => t.trim()).filter(Boolean)
      : typeof body.tags === 'string' && body.tags.trim()
        ? body.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : ['mktproxy'];
    try {
      const buy = await mktproxy.buyProxy(key, {
        productCode: String(body.productCode),
        quantity: body.quantity !== undefined ? Number(body.quantity) : undefined,
        duration: body.duration !== undefined ? Number(body.duration) : undefined,
        protocol,
        customFields: body.customFields && typeof body.customFields === 'object' ? body.customFields : undefined,
        externalRef: body.externalRef ? String(body.externalRef) : undefined,
        ipWhitelist: Array.isArray(body.ipWhitelist) ? body.ipWhitelist.map(String) : undefined,
      });

      // Collect delivered proxies: from the buy response if present, else poll
      // GET /orders/{code} until in_use (max ~30s) — some products provision async.
      let proxies = buy.proxies;
      let orderStatus = 'delivered';
      if (proxies.length === 0 && buy.orderCode) {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const order = await mktproxy.getOrder(key, buy.orderCode);
          orderStatus = order.status;
          if (order.proxies.length) {
            proxies = order.proxies;
            break;
          }
          if (['failed', 'expired'].includes(order.status)) break;
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }

      const imported = await importProxiesToStore(proxies, importType, tags);
      log.info(`mktproxy buy: đơn ${buy.orderCode || '—'} status=${orderStatus} nhận=${proxies.length} nạp=${imported.length}`);
      if (!imported.length) {
        log.warn(`mktproxy buy: NẠP 0 PROXY. items=${JSON.stringify(proxies)} rawBuy=${JSON.stringify(buy.raw).slice(0, 600)}`);
      }
      res.json({
        orderCode: buy.orderCode,
        orderStatus,
        delivered: proxies.length,
        imported: imported.length,
        proxies: imported.map(toDto),
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Import an already-completed order's proxies (khi mua async chưa kịp giao lúc
  // bấm Mua, dùng nút này để nạp sau). Body: { tags?, protocol? }.
  app.post('/api/mktproxy/orders/:code/import', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    const body = req.body ?? {};
    const type: ProxyType = body.protocol === 'socks5' ? 'socks5' : 'http';
    const tags: string[] = Array.isArray(body.tags)
      ? body.tags.map(String).map((t: string) => t.trim()).filter(Boolean)
      : ['mktproxy'];
    try {
      const order = await mktproxy.getOrder(key, String(req.params.code));
      const imported = await importProxiesToStore(order.proxies, type, tags);
      res.json({ orderStatus: order.status, delivered: order.proxies.length, imported: imported.length, proxies: imported.map(toDto) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- Mail (dongvanfb) ---------------------------------------------------
  // Read/code endpoints need no API key (email+refresh+client auth); only
  // balance/buy hit api.dongvanfb.net with the stored key.
  function requireApiKey(res: Response): string | null {
    const key = settings.getApiKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key dongvanfb (vào phần Cài đặt).' });
      return null;
    }
    return key;
  }

  app.get('/api/mail/balance', async (_req: Request, res: Response) => {
    const key = requireApiKey(res);
    if (!key) return;
    try {
      res.json({ balance: await getBalance(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mail/account-types', async (_req: Request, res: Response) => {
    const key = requireApiKey(res);
    if (!key) return;
    try {
      res.json({ accountTypes: await getAccountTypes(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mail/buy', async (req: Request, res: Response) => {
    const key = requireApiKey(res);
    if (!key) return;
    const body = req.body ?? {};
    if (!body.accountType || !body.quality) {
      res.status(400).json({ error: 'accountType và quality là bắt buộc' });
      return;
    }
    try {
      const result = await buyMail(key, {
        accountType: String(body.accountType),
        quality: String(body.quality),
      });
      const created = await mails.createMany(
        result.mails.map((m) => ({
          email: m.email,
          password: m.password,
          refreshToken: m.refreshToken,
          clientId: m.clientId,
          provider: providerFromEmail(m.email),
          orderCode: result.orderCode,
        })),
      );
      res.json({
        orderCode: result.orderCode,
        price: result.price,
        balance: result.balance,
        bought: result.mails.length,
        added: created.length,
        mails: created,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- selltaikhoan.com (nhà cung cấp mail thứ 2, Outlook OAuth2 rẻ hơn) ---
  // Mail trả về cùng định dạng email|password|refresh_token|client_id nên nạp
  // thẳng vào MailStore; đọc OTP dùng chung tools như dongvanfb.
  function requireSelltaikhoanKey(res: Response): string | null {
    const key = settings.getSelltaikhoanKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key selltaikhoan (vào tab Mail).' });
      return null;
    }
    return key;
  }

  app.get('/api/selltaikhoan/balance', async (_req: Request, res: Response) => {
    const key = requireSelltaikhoanKey(res);
    if (!key) return;
    try {
      res.json({ balance: await selltaikhoan.getBalance(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/selltaikhoan/products', async (_req: Request, res: Response) => {
    const key = requireSelltaikhoanKey(res);
    if (!key) return;
    try {
      res.json({ products: await selltaikhoan.listProducts(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/selltaikhoan/buy', async (req: Request, res: Response) => {
    const key = requireSelltaikhoanKey(res);
    if (!key) return;
    const body = req.body ?? {};
    if (!body.productId) {
      res.status(400).json({ error: 'productId là bắt buộc' });
      return;
    }
    try {
      const amount = Math.max(1, Number(body.amount) || 1);
      const result = await selltaikhoan.buyProduct(key, String(body.productId), amount);
      const created = await mails.createMany(
        result.mails.map((m) => ({
          email: m.email,
          password: m.password,
          refreshToken: m.refreshToken,
          clientId: m.clientId,
          provider: providerFromEmail(m.email),
          orderCode: result.transId,
        })),
      );
      res.json({ transId: result.transId, bought: result.mails.length, added: created.length, mails: created });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- SmsBower (thuê gmail nhận OTP theo service, vd đăng ký ChatGPT) -------
  // Chỉ expose "rests" (tồn kho + giá + mã service) để chọn đúng service. Việc
  // thuê/đọc code/chốt do rentMailDep lo trong lúc chạy flow (tránh tốn tiền khi
  // bấm lung tung ở UI).
  app.get('/api/smsbower/rests', async (req: Request, res: Response) => {
    const key = settings.getSmsbowerKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key SmsBower (vào tab Mail).' });
      return;
    }
    try {
      const domain = req.query.domain ? String(req.query.domain) : 'gmail.com';
      res.json({ rests: await smsbower.getPriceRests(key, domain) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mails', (_req: Request, res: Response) => {
    res.json(mails.list());
  });

  app.post('/api/mails', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (typeof body.line === 'string' && body.line.trim()) {
        res.status(201).json(await mails.create(parseMailLine(body.line)));
        return;
      }
      if (!body.email || !body.refreshToken || !body.clientId) {
        res.status(400).json({ error: 'Cần email|password|refresh_token|client_id (hoặc các field email/refreshToken/clientId)' });
        return;
      }
      const created = await mails.create({
        email: String(body.email).trim(),
        password: body.password ? String(body.password) : undefined,
        refreshToken: String(body.refreshToken).trim(),
        clientId: String(body.clientId).trim(),
        note: body.note ? String(body.note) : undefined,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Xóa hàng loạt: body {ids: string[]} xóa các id đó; không body = xóa SẠCH kho.
  // Đăng ký TRƯỚC '/api/mails/:id' để "mails" không bị bắt nhầm thành :id.
  app.delete('/api/mails', async (req: Request, res: Response) => {
    try {
      const ids = req.body?.ids;
      const removed = Array.isArray(ids) ? await mails.deleteMany(ids.map(String)) : await mails.clear();
      res.json({ removed });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/mails/:id', async (req: Request, res: Response) => {
    try {
      await mails.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mails/:id/code', async (req: Request, res: Response) => {
    const mail = mails.get(String(req.params.id));
    if (!mail) {
      res.status(404).json({ error: 'Mail not found' });
      return;
    }
    const type = (String(req.body?.type ?? 'all')) as MailCodeType;
    try {
      const result = await getCode({
        email: mail.email,
        password: mail.password,
        refreshToken: mail.refreshToken,
        clientId: mail.clientId,
        type,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mails/:id/messages', async (req: Request, res: Response) => {
    const mail = mails.get(String(req.params.id));
    if (!mail) {
      res.status(404).json({ error: 'Mail not found' });
      return;
    }
    try {
      const messages = await getMessages({
        email: mail.email,
        password: mail.password,
        refreshToken: mail.refreshToken,
        clientId: mail.clientId,
      });
      res.json({ messages });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Ad-hoc code fetch for the profile panel — credentials passed inline, no
  // stored mail needed. Still no API key required (tools.* auth).
  app.post('/api/mail/code', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!body.email || !body.refresh_token || !body.client_id) {
      res.status(400).json({ error: 'Cần email, refresh_token, client_id' });
      return;
    }
    try {
      const result = await getCode({
        email: String(body.email).trim(),
        refreshToken: String(body.refresh_token).trim(),
        clientId: String(body.client_id).trim(),
        type: (String(body.type ?? 'all')) as MailCodeType,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- Flows (automation) -------------------------------------------------
  // Flows are TS code in src/flows/; this just exposes their metadata so the
  // Project tab can populate the flow dropdown.
  app.get('/api/flows', (_req: Request, res: Response) => {
    res.json(flowMetas());
  });

  app.get('/api/presets', (_req: Request, res: Response) => {
    res.json({ profilePresets, projectPresets });
  });

  // ---- Projects (automation jobs) -----------------------------------------
  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json(projects.list());
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const project = projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(project);
  });

  app.post('/api/projects', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (!body.name || !String(body.name).trim()) {
        res.status(400).json({ error: 'name là bắt buộc' });
        return;
      }
      if (!body.flowName || !String(body.flowName).trim()) {
        res.status(400).json({ error: 'flowName là bắt buộc' });
        return;
      }
      const created = await projects.create({
        name: String(body.name).trim(),
        flowName: String(body.flowName).trim(),
        profileIds: Array.isArray(body.profileIds) ? body.profileIds.map(String) : [],
        mailId: body.mailId ? String(body.mailId) : undefined,
        concurrency: body.concurrency !== undefined ? Number(body.concurrency) : undefined,
        ephemeralCount: body.ephemeralCount !== undefined ? Number(body.ephemeralCount) : undefined,
        mailProvider: body.mailProvider === 'selltaikhoan' ? 'selltaikhoan' : undefined,
        buyAccountType: body.buyAccountType ? String(body.buyAccountType) : undefined,
        buyQuality: body.buyQuality ? String(body.buyQuality) : undefined,
        buyProductId: body.buyProductId ? String(body.buyProductId) : undefined,
        smsbowerService: body.smsbowerService ? String(body.smsbowerService) : undefined,
        ephemeralProxyPool: parseEphemeralPool(body.ephemeralProxyPool),
        blockImages: body.blockImages === true ? true : undefined,
        headless: body.headless === true ? true : undefined,
        telegramDistribution: parseTelegramDistribution(body.telegramDistribution),
        note: body.note ? String(body.note) : undefined,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/projects/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!projects.get(id)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = req.body ?? {};
      const patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt'>> = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (typeof body.flowName === 'string' && body.flowName.trim()) patch.flowName = body.flowName.trim();
      if (Array.isArray(body.profileIds)) patch.profileIds = body.profileIds.map(String);
      if (body.mailId !== undefined) patch.mailId = body.mailId ? String(body.mailId) : undefined;
      if (body.concurrency !== undefined) patch.concurrency = Number(body.concurrency);
      if (body.ephemeralCount !== undefined) patch.ephemeralCount = Number(body.ephemeralCount);
      if (body.mailProvider !== undefined) patch.mailProvider = body.mailProvider === 'selltaikhoan' ? 'selltaikhoan' : undefined;
      if (body.buyAccountType !== undefined) patch.buyAccountType = body.buyAccountType ? String(body.buyAccountType) : undefined;
      if (body.buyQuality !== undefined) patch.buyQuality = body.buyQuality ? String(body.buyQuality) : undefined;
      if (body.buyProductId !== undefined) patch.buyProductId = body.buyProductId ? String(body.buyProductId) : undefined;
      if (body.smsbowerService !== undefined) patch.smsbowerService = body.smsbowerService ? String(body.smsbowerService) : undefined;
      if (body.ephemeralProxyPool !== undefined) patch.ephemeralProxyPool = parseEphemeralPool(body.ephemeralProxyPool);
      if (body.blockImages !== undefined) patch.blockImages = body.blockImages === true ? true : undefined;
      if (body.headless !== undefined) patch.headless = body.headless === true ? true : undefined;
      if (body.telegramDistribution !== undefined) patch.telegramDistribution = parseTelegramDistribution(body.telegramDistribution);
      if (body.note !== undefined) patch.note = String(body.note);
      const updated = await projects.update(id, patch);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    try {
      await projects.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Run a project's flow across its profiles (headful, low concurrency). Runs
  // synchronously — the batch is small, so we wait and return per-profile results.
  app.post('/api/projects/:id/run', async (req: Request, res: Response) => {
    const project = projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    // Smart Telegram distribution uses one fresh profile per allocated "con".
    // It intentionally requires ephemeral profiles so every link comes from a
    // clean account and total generated links matches the employee quota exactly.
    const distribution = project.telegramDistribution?.enabled ? project.telegramDistribution : undefined;
    if (distribution && project.flowName !== 'capcut-signin') {
      res.status(400).json({ error: 'Tự phân phối Telegram hiện chỉ áp dụng cho flow CapCut' });
      return;
    }
    if (distribution && project.profileIds.length) {
      res.status(400).json({ error: 'Tự phân phối cần dùng profile tạm; hãy bỏ chọn profile cố định' });
      return;
    }
    const distributionTotal = distribution
      ? distribution.allocations.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0)
      : 0;
    const ephemeralCount = distribution
      ? distributionTotal
      : project.profileIds.length ? 0 : (project.ephemeralCount ?? 0);
    if (!project.profileIds.length && ephemeralCount < 1) {
      res.status(400).json({ error: 'Project chưa chọn profile, cũng chưa đặt số profile tạm để tạo' });
      return;
    }
    // Resolve the bound mailbox (if any) into credentials for OTP steps.
    let mail;
    if (project.mailId) {
      const rec = mails.get(project.mailId);
      if (!rec) {
        res.status(400).json({ error: 'Mail đã gán không còn tồn tại' });
        return;
      }
      mail = { email: rec.email, refreshToken: rec.refreshToken, clientId: rec.clientId };
    }
    // Build the buyMail dependency only when an API key is configured. A flow that
    // calls ctx.buyMail() without a key gets a clear error (runner handles absent dep).
    // buyMail dep: chọn nhà cung cấp theo `provider` runner truyền vào (dongvanfb
    // hoặc selltaikhoan). Luôn dựng dep; kiểm tra đúng key của nhà cung cấp bên
    // trong. Cả hai trả cùng định dạng nên lưu MailStore + đọc OTP dùng chung.
    const buyMailDep = async (input: {
      provider: 'dongvanfb' | 'selltaikhoan';
      accountType?: string;
      quality?: string;
      productId?: string;
      profileName: string;
    }) => {
      let first: { email: string; password?: string; refreshToken: string; clientId: string } | undefined;
      let orderCode: string | undefined;
      if (input.provider === 'selltaikhoan') {
        const key = settings.getSelltaikhoanKey();
        if (!key) throw new Error('Chưa cấu hình API key selltaikhoan (vào tab Mail)');
        if (!input.productId) throw new Error('Thiếu ID sản phẩm selltaikhoan');
        const result = await selltaikhoan.buyProduct(key, input.productId, 1);
        first = result.mails[0];
        orderCode = result.transId;
      } else {
        const key = settings.getApiKey();
        if (!key) throw new Error('Chưa cấu hình API key dongvanfb (vào tab Mail)');
        if (!input.accountType || !input.quality) throw new Error('Thiếu accountType/quality');
        const result = await buyMail(key, { accountType: input.accountType, quality: input.quality });
        first = result.mails[0];
        orderCode = result.orderCode;
      }
      if (!first) throw new Error('Mua mail thành công nhưng không nhận được dữ liệu mail');
      // Persist to the store so the mailbox is visible/reusable in the Mail tab.
      const [saved] = await mails.createMany([
        {
          email: first.email,
          password: first.password,
          refreshToken: first.refreshToken,
          clientId: first.clientId,
          provider: providerFromEmail(first.email),
          orderCode,
          note: `auto-mua cho ${input.profileName}`,
        },
      ]);
      const chosen = first;
      const rec = saved ?? mails.list().find((m) => m.email.toLowerCase() === chosen.email.toLowerCase());
      return {
        cred: { email: chosen.email, refreshToken: chosen.refreshToken, clientId: chosen.clientId },
        email: chosen.email,
        password: chosen.password ?? rec?.password,
      };
    };
    // rentMail dep: thuê gmail dùng-một-lần từ SmsBower (flow đăng ký ChatGPT…).
    // getActivation lấy mail+mailId; trả mailbox có waitCode (poll getCode) +
    // success/cancel (setStatus 3/2) bám theo mailId + key. Luôn dựng; ném lỗi rõ
    // nếu chưa có key khi flow gọi ctx.rentMail().
    const rentMailDep = async (input: { service: string; profileName: string }) => {
      const key = settings.getSmsbowerKey();
      if (!key) throw new Error('Chưa cấu hình API key SmsBower (vào tab Mail)');
      // Dùng BATCH (count=1) thay vì thuê lẻ: mỗi mail có link getCodeBySignature
      // đọc all_codes NHIỀU LẦN (OpenAI gửi 2-3 mã) → chọn mã mới nhất chưa thử,
      // KHỎI request lại. (getActivation chỉ 1 mã/lần rồi khoá — không hợp.)
      const batch = await smsbower.getBatch(key, { service: input.service, domain: 'gmail.com', count: 1, time: 12 });
      const m = batch.mails[0];
      if (!m) throw new Error('SmsBower getBatch không trả mail nào');
      const tried = new Set<string>();
      // Poll link đọc mã tới khi có mã CHƯA THỬ; ưu tiên mã MỚI NHẤT (cuối mảng
      // all_codes). Dùng chung cho waitCode (mã đầu) lẫn nextCode (mã kế khi sai).
      const fetchNew = async (opts?: { tries?: number; intervalMs?: number }): Promise<string> => {
        const tries = opts?.tries ?? 40;
        const interval = opts?.intervalMs ?? 3_000;
        for (let i = 0; i < tries; i += 1) {
          const { allCodes, raw } = await smsbower.getCodeBySignature(m.url);
          // In MẪU phản hồi thô 1 lần (poll đầu) để lộ đúng cấu trúc JSON — nếu mã
          // về ở trường lạ thì thấy ngay, khỏi đoán.
          if (i === 0) log.info(`[${input.profileName}] SmsBower mẫu phản hồi đọc mã: ${JSON.stringify(raw).slice(0, 300)}`);
          for (let j = allCodes.length - 1; j >= 0; j -= 1) {
            if (!tried.has(allCodes[j])) {
              tried.add(allCodes[j]);
              log.info(`[${input.profileName}] SmsBower: đọc được mã ${allCodes[j]} cho ${m.mail} (poll ${i + 1}/${tries})`);
              return allCodes[j];
            }
          }
          // Log tiến trình (poll đầu + mỗi 5 lần) để KHÔNG im lặng suốt ~3 phút —
          // trước đây không log gì nên user tưởng tool "đứng" ở bước đọc mail.
          if (i === 0 || (i + 1) % 5 === 0) {
            log.info(`[${input.profileName}] SmsBower: chờ mã cho ${m.mail}... (poll ${i + 1}/${tries}, đã thấy ${allCodes.length} mã)`);
          }
          await new Promise((r) => setTimeout(r, interval));
        }
        throw new Error(`SmsBower: không nhận được mã mới cho ${m.mail} sau ${tries} lần đọc (all_codes hết mã chưa thử)`);
      };
      return {
        email: m.mail,
        mailId: `batch:${batch.batchId}`,
        waitCode: (opts?: { tries?: number; intervalMs?: number }) => fetchNew(opts),
        // nextCode: trả mã KHÁC (chưa thử) từ all_codes — không cần re-request.
        nextCode: (opts?: { tries?: number; intervalMs?: number }) => fetchNew(opts),
        success: async () => {}, // batch đã trả tiền, không cần chốt
        cancel: async () => {}, // batch không huỷ/hoàn lẻ được
      };
    };
    // Build the appendSheet dependency only when a Sheet webhook URL is configured.
    // POSTs one JSON row to the Apps Script web app; the runner wraps this so a
    // network hiccup logs + continues rather than failing the registration.
    const sheetUrl = settings.getSheetWebhookUrl();
    const appendSheetDep = sheetUrl
      ? async (row: unknown) => {
          const res = await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(row),
          });
          if (!res.ok) throw new Error(`Sheet webhook HTTP ${res.status}`);
        }
      : undefined;
    // Optional manager notification, separate from employee-topic distribution.
    // Keep it short and HTML-escaped so long checkout URLs/credentials cannot
    // break Telegram entity parsing.
    const tgToken = settings.getTelegramBotToken();
    const tgChatId = settings.getTelegramChatId();
    const notifyDep = tgToken && tgChatId
      ? async (row: SheetRow) => {
          const account = [row.email, row.password].filter(Boolean).join(' | ');
          const lines = [
            '✅ <b>CapCut đăng ký thành công</b>',
            account ? `📧 <code>${escapeTelegramHtml(account)}</code>` : '',
            row.checkoutUrl ? `💳 <a href="${escapeTelegramHtml(row.checkoutUrl)}">Link thanh toán</a>` : '',
          ].filter(Boolean);
          await telegramClient.sendMessage(tgToken, {
            chatId: tgChatId,
            text: lines.join('\n'),
            parseMode: 'HTML',
            disableLinkPreview: true,
          });
        }
      : undefined;
    // Ephemeral profiles: create N throwaway profiles now, run against them, and
    // delete them (with their browser data) in `finally` so nothing is left
    // behind — even if the flow throws. Fixed profiles are left untouched.
    // If the project set an ephemeralProxyPool, each temp profile launches in
    // pool mode: resolveProxy draws a fresh Live proxy (matching the tag filter)
    // per profile at open time — so N temp profiles get N different IPs instead
    // of all leaking the real one.
    const ephemeralPool = project.ephemeralProxyPool;
    const ephemeralIds: string[] = [];
    let distributionRunId: string | undefined;
    try {
      if (distribution) {
        const run = await telegramWork.startDistribution({
          projectId: project.id,
          projectName: project.name,
          allocations: distribution.allocations,
        });
        distributionRunId = run.id;
      }
      for (let i = 0; i < ephemeralCount; i += 1) {
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const created = await profiles.create({
          name: `tmp-${project.name}-${stamp}-${i + 1}`,
          proxyRotation: ephemeralPool
            ? { mode: 'pool', pool: ephemeralPool, rotateOnOpen: true, rotateOnFailure: true }
            : undefined,
          // ChatGPT: TẮT geoip + language 'real' (⇒ KHÔNG set locale gì cả). GỐC RỄ đã
          // probe xác nhận: Camoufox spoof Intl.DisplayNames theo "locale:region", và
          // hễ config CÓ locale:region (do geoip HAY ép locale sinh ra) thì spoof LỖI —
          // .of(bất kỳ mã nước nào) đều trả về CHÍNH nước của region đó. Dropdown quốc
          // gia ChatGPT build bằng Intl.DisplayNames.of(code) nên hiện "cả list 1 nước"
          // (US / NL / Việt Nam) → chọn sai. CHỈ khi config KHÔNG có locale:region
          // (geoip off + language 'real', không ép locale) thì DisplayNames mới đúng →
          // dropdown render đúng tên nước, selectCountry chọn được Netherlands.
          // Đánh đổi: timezone/geolocation không còn khớp IP proxy (chấp nhận cho flow
          // này; UI về mặc định Camoufox = en-US). Các flow khác GIỮ geoip như cũ.
          antiDetect:
            project.flowName === 'chatgpt-signup'
              ? { ...defaultAntiDetect(), geoip: false, language: 'real', blockImages: project.blockImages === true }
              : project.blockImages
                ? { ...defaultAntiDetect(), blockImages: true }
                : undefined,
        });
        ephemeralIds.push(created.id);
      }
      const runIds = project.profileIds.length ? project.profileIds : ephemeralIds;
      // Project chỉ ghi đè khi bật true headless. Khi tắt, giữ mặc định của
      // server: Electron=headful, Docker=virtual display.
      const runHeadless = project.headless === true ? true : headless;
      const results = await runProject(
        browsers,
        {
          profileIds: runIds,
          flowName: project.flowName,
          mail,
          mailProvider: project.mailProvider,
          buyAccountType: project.buyAccountType,
          buyQuality: project.buyQuality,
          buyProductId: project.buyProductId,
          smsbowerService: project.smsbowerService,
        },
        { concurrency: project.concurrency, headless: runHeadless, storeRoot },
        {
          buyMail: buyMailDep,
          rentMail: rentMailDep,
          appendSheet: appendSheetDep,
          notify: notifyDep,
          onResult: distributionRunId
            ? async (row, source) => {
                await telegramWork.enqueueCapcutResult(distributionRunId!, {
                  profileName: row.profileName,
                  email: row.email,
                  password: row.password,
                  mailLine: row.mailLine,
                  checkoutUrl: row.checkoutUrl!,
                  proxy: source.proxy,
                  proxyRecordId: source.proxyRecordId,
                });
              }
            : undefined,
        },
      );
      res.json({ results, distributionRunId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    } finally {
      if (distributionRunId) await telegramWork.finishDistribution(distributionRunId).catch(() => {});
      // Tear down throwaway profiles + their userDataDir. Best-effort: a failed
      // delete shouldn't mask the run result.
      for (const id of ephemeralIds) {
        try {
          await browsers.close(id).catch(() => {});
          await profiles.delete(id, { wipeData: true });
        } catch (e) {
          log.warn(`xóa profile tạm ${id} lỗi: ${(e as Error).message}`);
        }
      }
    }
  });

  return {
    app,
    storeRoot,
    headless,
    publicDir,
    tunnel,
    paymentSessions,
    getPaymentPublicUrl: () => settings.getPaymentPublicUrl(),
    close: async () => {
      await tunnel.close();
      await telegramWork.close();
      await browsers.closeAll();
    },
  };
}

export async function startServer(config: ServerConfig = {}): Promise<StartedServer> {
  const created = await createApp(config);
  const host = config.host ?? '0.0.0.0';
  const port = config.port ?? Number(process.env.PORT ?? 3000);

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = created.app.listen(port, host, () => resolve(listening));
    listening.once('error', reject);
  });
  const paymentStream = new PaymentStreamServer(server, created.paymentSessions, created.getPaymentPublicUrl);

  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;
  const urlHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${urlHost}:${resolvedPort}`;
  created.tunnel.setOrigin(url, Boolean(config.embeddedTunnel));
  if (config.embeddedTunnel) void created.tunnel.startIfEnabled();

  log.info(`proxy manager listening on ${url}`);
  log.info(`serving UI from ${created.publicDir}`);

  return {
    ...created,
    server,
    url,
    port: resolvedPort,
    close: async () => {
      await paymentStream.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw err;
      });
      await created.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
