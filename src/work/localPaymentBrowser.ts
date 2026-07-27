import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Camoufox } from 'camoufox-js';
import type { BrowserContext, Page } from 'playwright-core';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { createLogger } from '../logger.js';
import type { ProxyConfig } from '../types.js';
import type { PaymentBrowser, PaymentBrowserCreateInput, PaymentBrowserInput } from './paymentSessions.js';

const log = createLogger('payment-browser');
const WIDTH = 1280;
const HEIGHT = 720;
const FRAME_CACHE_MS = 75;
const PROXY_CHECK_INTERVAL_MS = 10_000;
const PROXY_CHECK_URL = 'https://api.ipify.org?format=json';
const PAYMENT_FIREFOX_PREFS = {
  'browser.urlbar.speculativeConnect.enabled': false,
  'media.peerconnection.enabled': false,
  'network.dns.disablePrefetch': true,
  'network.http.speculative-parallel-limit': 0,
  'network.predictor.enabled': false,
  'network.prefetch-next': false,
  'network.proxy.socks_remote_dns': true,
  'network.trr.mode': 5,
};

interface LocalSession {
  id: string;
  context: BrowserContext;
  activePage: Page;
  relayUrl?: string;
  profileDir: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  monitor: NodeJS.Timeout;
  checking: boolean;
  reported: boolean;
  latestFrame?: Buffer;
  frameAt: number;
  lastProxyCheckAt: number;
  lastProxyIp?: string;
  capture?: Promise<Buffer>;
}

function successUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (/capcut\.com$/i.test(url.hostname) && /\/commerce\/payment-result/i.test(url.pathname))
      || /\/(payment|checkout)[-_/]?(success|complete|result)\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function upstreamProxy(proxy: ProxyConfig | undefined): Promise<string> {
  if (!proxy?.server) throw new Error('Payment bắt buộc phải có proxy; kết nối trực tiếp đã bị chặn');
  const value = new URL(proxy.server);
  if (proxy.username) value.username = encodeURIComponent(proxy.username);
  if (proxy.password) value.password = encodeURIComponent(proxy.password);
  return anonymizeProxy(value.toString());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export class LocalPaymentBrowser implements PaymentBrowser {
  private readonly sessions = new Map<string, LocalSession>();
  private readonly starting = new Map<string, Promise<{ sessionId: string }>>();
  private readonly maxSessions: number;

  constructor() {
    const configured = Number(process.env.PAYMENT_MAX_SESSIONS || 3);
    this.maxSessions = Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
  }

  capacity(): number {
    return this.maxSessions;
  }

  async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    const existing = this.sessions.get(input.id);
    if (existing) return { sessionId: existing.id };
    const pending = this.starting.get(input.id);
    if (pending) return pending;
    if (this.sessions.size + this.starting.size >= this.maxSessions) {
      throw new Error(`App đang chạy đủ ${this.maxSessions} phiên thanh toán, hãy thử lại sau`);
    }
    const launch = this.launch(input);
    this.starting.set(input.id, launch);
    try {
      return await launch;
    } finally {
      this.starting.delete(input.id);
    }
  }

  async frame(sessionId: string): Promise<Buffer> {
    const session = this.requireSession(sessionId);
    if (session.latestFrame && Date.now() - session.frameAt < FRAME_CACHE_MS) return session.latestFrame;
    if (session.capture) return session.capture;
    session.capture = this.capture(session).finally(() => { session.capture = undefined; });
    return session.capture;
  }

  async input(sessionId: string, input: PaymentBrowserInput): Promise<void> {
    const session = this.requireSession(sessionId);
    const page = this.pageFor(session);
    if (input.type === 'click') {
      await page.mouse.click(clamp(input.x, 0, WIDTH), clamp(input.y, 0, HEIGHT), {
        button: input.button === 'right' ? 'right' : input.button === 'middle' ? 'middle' : 'left',
      });
      return;
    }
    if (input.type === 'move') {
      await page.mouse.move(clamp(input.x, 0, WIDTH), clamp(input.y, 0, HEIGHT));
      return;
    }
    if (input.type === 'wheel') {
      await page.mouse.wheel(clamp(input.deltaX, -2_000, 2_000), clamp(input.deltaY, -2_000, 2_000));
      return;
    }
    if (input.type === 'text') {
      await page.keyboard.insertText(input.text.slice(0, 2_000));
      return;
    }
    const key = input.key.slice(0, 40);
    if (!key) return;
    if (key.length === 1 && !input.altKey && !input.ctrlKey && !input.metaKey) {
      await page.keyboard.insertText(key);
      return;
    }
    const modifiers = [
      input.ctrlKey ? 'Control' : '',
      input.altKey ? 'Alt' : '',
      input.metaKey ? 'Meta' : '',
      input.shiftKey ? 'Shift' : '',
    ].filter(Boolean);
    const normalized = key === ' ' ? 'Space' : key;
    await page.keyboard.press([...modifiers, normalized].join('+'));
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    clearInterval(session.monitor);
    await session.context.close().catch(() => {});
    if (session.relayUrl) await closeAnonymizedProxy(session.relayUrl, true).catch(() => {});
    await rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private async launch(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    const profileDir = await mkdtemp(join(tmpdir(), 'teamhatde-pay-'));
    let context: BrowserContext | undefined;
    let relayUrl: string | undefined;
    try {
      const paymentRelayUrl = await upstreamProxy(input.proxy);
      relayUrl = paymentRelayUrl;
      const launchOptions = (headless: boolean) => ({
        user_data_dir: profileDir,
        headless,
        proxy: { server: paymentRelayUrl },
        block_webrtc: true,
        firefox_user_prefs: PAYMENT_FIREFOX_PREFS,
        humanize: 0.04,
        config: { showcursor: false },
      });
      try {
        context = await Camoufox(launchOptions(true)) as BrowserContext;
      } catch (error) {
        log.warn(`Camoufox payment headless lỗi, thử headful: ${(error as Error).message.split('\n')[0]}`);
        context = await Camoufox(launchOptions(false)) as BrowserContext;
      }
      if (input.expectedProxyIp) {
        const actualIp = await this.proxyIp(context);
        if (actualIp !== input.expectedProxyIp) {
          throw new Error(`Proxy payment sai IP: cần ${input.expectedProxyIp}, thực tế ${actualIp}`);
        }
      }
      const page = context.pages()[0] ?? await context.newPage();
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      const sessionId = input.id || randomUUID();
      const session = {
        id: sessionId,
        context,
        activePage: page,
        relayUrl,
        profileDir,
        expiresAt: new Date(input.expiresAt).getTime(),
        checking: false,
        reported: false,
        frameAt: 0,
        lastProxyCheckAt: Date.now(),
        lastProxyIp: input.expectedProxyIp,
      } as LocalSession;
      const watch = (next: Page) => {
        session.activePage = next;
        void next.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {});
        next.on('framenavigated', (frame) => {
          if (successUrl(frame.url())) void this.report(session, input, 'paid');
        });
      };
      context.on('page', watch);
      for (const openPage of context.pages()) watch(openPage);

      // The employee can watch the page finish loading; waiting for the full DOM only adds dead time.
      await page.goto(input.checkoutUrl, { waitUntil: 'commit', timeout: 45_000 });
      session.monitor = setInterval(() => void this.checkPayment(session, input), 1_000);
      session.monitor.unref?.();
      session.timer = setTimeout(() => void this.close(session.id), Math.max(1_000, session.expiresAt - Date.now()));
      session.timer.unref?.();
      this.sessions.set(session.id, session);
      return { sessionId: session.id };
    } catch (error) {
      await context?.close().catch(() => {});
      if (relayUrl) await closeAnonymizedProxy(relayUrl, true).catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async capture(session: LocalSession): Promise<Buffer> {
    const page = this.pageFor(session);
    const frame = await page.screenshot({ type: 'jpeg', quality: 68, timeout: 8_000 });
    session.latestFrame = frame;
    session.frameAt = Date.now();
    return frame;
  }

  private pageFor(session: LocalSession): Page {
    if (!session.activePage.isClosed()) return session.activePage;
    const pages = session.context.pages();
    let page: Page | undefined;
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      if (!pages[index].isClosed()) { page = pages[index]; break; }
    }
    if (!page) throw new Error('Trình duyệt thanh toán đã đóng');
    session.activePage = page;
    return page;
  }

  private requireSession(id: string): LocalSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Phiên trình duyệt chưa sẵn sàng hoặc đã đóng');
    return session;
  }

  private async checkPayment(session: LocalSession, input: PaymentBrowserCreateInput): Promise<void> {
    if (session.checking || session.reported) return;
    session.checking = true;
    try {
      if (input.expectedProxyIp && Date.now() - session.lastProxyCheckAt >= PROXY_CHECK_INTERVAL_MS) {
        session.lastProxyCheckAt = Date.now();
        let actualIp: string;
        try {
          actualIp = await this.proxyIp(session.context);
        } catch (error) {
          log.warn(`kiểm tra proxy payment ${session.id} lỗi: ${(error as Error).message}`);
          actualIp = '';
        }
        if (actualIp) {
          if (session.lastProxyIp && actualIp !== session.lastProxyIp) {
            log.warn(`gateway payment ${session.id} đổi egress ${session.lastProxyIp} → ${actualIp}; giữ nguyên phiên`);
          }
          session.lastProxyIp = actualIp;
        }
      }
      for (const page of session.context.pages()) {
        if (successUrl(page.url())) return void await this.report(session, input, 'paid');
        for (const frame of page.frames()) {
          if (successUrl(frame.url())) return void await this.report(session, input, 'paid');
          const text = await frame.locator('body').innerText({ timeout: 800 }).catch(() => '');
          if (/payment successful|payment completed|thanh toán thành công|giao dịch thành công/i.test(text)) {
            return void await this.report(session, input, 'paid');
          }
          if (/payment failed|payment declined|thanh toán thất bại|giao dịch thất bại/i.test(text)) {
            return void await this.report(session, input, 'failed', 'Trang thanh toán báo thất bại');
          }
        }
      }
    } finally {
      session.checking = false;
    }
  }

  private async proxyIp(context: BrowserContext, timeout = 10_000): Promise<string> {
    const response = await context.request.get(PROXY_CHECK_URL, { timeout });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const body = await response.json() as { ip?: string };
    if (!body.ip) throw new Error('Không đọc được IP proxy');
    return body.ip;
  }

  private async report(
    session: LocalSession,
    input: PaymentBrowserCreateInput,
    status: 'paid' | 'failed',
    error?: string,
  ): Promise<void> {
    if (session.reported) return;
    session.reported = true;
    clearInterval(session.monitor);
    if (status === 'paid' && input.expectedProxyIp) {
      try {
        const actualIp = await this.proxyIp(session.context, 2_000);
        if (session.lastProxyIp && actualIp !== session.lastProxyIp) {
          log.warn(`gateway payment ${session.id} đổi egress trước khi hoàn tất ${session.lastProxyIp} → ${actualIp}; vẫn xác nhận kết quả`);
        }
        session.lastProxyIp = actualIp;
      } catch (reason) {
        log.warn(`không kiểm tra được proxy cuối phiên ${session.id}: ${(reason as Error).message}`);
      }
    }
    try {
      await input.onStatus(status, error);
    } catch (reason) {
      log.warn(`cập nhật payment ${session.id} lỗi: ${(reason as Error).message}`);
    }
  }
}
