import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Camoufox } from 'camoufox-js';
import type { BrowserContext, Page } from 'playwright-core';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { createLogger } from '../logger.js';
import type { ProxyConfig } from '../types.js';
import type { PaymentBrowser, PaymentBrowserCreateInput } from './paymentSessions.js';

const log = createLogger('payment-browser');
const WIDTH = 1280;
const HEIGHT = 720;
const PROXY_CHECK_URL = 'https://api.ipify.org?format=json';
const CAPCUT_VIP_CHECK_URL = 'https://commerce-api-sg.capcut.com/commerce/v3/trade/subscription_infos';
const CAPCUT_VIP_POLL_MS = 3_000;
// Payment frames must not block on remote web fonts that may stall behind the proxy.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
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
  nextVipCheckAt: number;
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

export function paymentFailureFromText(text: string): string | undefined {
  if (/couldn['’]?t process payment|transaction rejected due to risk issue|risk issue|try again later or contact customer support/i.test(text)) {
    return 'Cổng thanh toán từ chối do risk; lần thử tiếp theo sẽ dùng proxy mới';
  }
  if (/payment failed|payment declined|thanh toán thất bại|giao dịch thất bại/i.test(text)) {
    return 'Trang thanh toán báo thất bại';
  }
  return undefined;
}

export function capcutVipFromResponse(raw: unknown): { isVip: boolean; vipEndTime: number } {
  const body = raw as any;
  const vip = body?.data?.subscription_user_infos?.vip;
  const info = (vip?.vip_infos ?? []).find((item: any) => item?.is_vip);
  return { isVip: Boolean(info), vipEndTime: Number(info?.vip_end_time) || 0 };
}

export async function capturePaymentFrame(page: Pick<Page, 'screenshot'>, previous?: Buffer): Promise<Buffer> {
  try {
    return await page.screenshot({ type: 'jpeg', quality: 68, timeout: 5_000 });
  } catch (error) {
    if (previous && /screenshot: Timeout \d+ms exceeded/i.test((error as Error).message)) return previous;
    throw error;
  }
}

async function upstreamProxy(proxy: ProxyConfig | undefined): Promise<string> {
  if (!proxy?.server) throw new Error('Payment bắt buộc phải có proxy; kết nối trực tiếp đã bị chặn');
  const value = new URL(proxy.server);
  if (proxy.username) value.username = encodeURIComponent(proxy.username);
  if (proxy.password) value.password = encodeURIComponent(proxy.password);
  return anonymizeProxy(value.toString());
}


export class LocalPaymentBrowser implements PaymentBrowser {
  private readonly sessions = new Map<string, LocalSession>();
  private readonly starting = new Map<string, Promise<{ sessionId: string }>>();
  private maxSessions: number | null;

  constructor(maxSessions?: number | null) {
    const configured = Number(process.env.PAYMENT_MAX_SESSIONS);
    this.maxSessions = maxSessions === undefined
      ? (Number.isSafeInteger(configured) && configured > 0 ? configured : null)
      : maxSessions;
  }

  capacity(): number | null {
    return this.maxSessions;
  }

  setCapacity(maxSessions: number | null): void {
    this.maxSessions = maxSessions;
  }

  async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    const existing = this.sessions.get(input.id);
    if (existing) return { sessionId: existing.id };
    const pending = this.starting.get(input.id);
    if (pending) return pending;
    if (this.maxSessions !== null && this.sessions.size + this.starting.size >= this.maxSessions) {
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
      if (input.capcutCookies?.length) await context.addCookies(input.capcutCookies);
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
        nextVipCheckAt: Date.now() + CAPCUT_VIP_POLL_MS,
      } as LocalSession;
      const watch = (next: Page) => {
        session.activePage = next;
        void next.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {});
        next.on('framenavigated', (frame) => {
          if (!input.capcutCookies?.length && successUrl(frame.url())) void this.report(session, input, 'paid');
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
      const autoVerifyVip = Boolean(input.capcutCookies?.length);
      for (const page of session.context.pages()) {
        if (!autoVerifyVip && successUrl(page.url())) return void await this.report(session, input, 'paid');
        for (const frame of page.frames()) {
          if (!autoVerifyVip && successUrl(frame.url())) return void await this.report(session, input, 'paid');
          const text = await frame.locator('body').innerText({ timeout: 800 }).catch(() => '');
          if (!autoVerifyVip && /payment successful|payment completed|thanh toán thành công|giao dịch thành công/i.test(text)) {
            return void await this.report(session, input, 'paid');
          }
          const failure = paymentFailureFromText(text);
          if (failure) return void await this.report(session, input, 'failed', failure);
        }
      }
      if (autoVerifyVip && Date.now() >= session.nextVipCheckAt) {
        session.nextVipCheckAt = Date.now() + CAPCUT_VIP_POLL_MS;
        try {
          const vip = await this.checkCapcutVip(session);
          if (vip.isVip) return void await this.reportVip(session, input, vip.vipEndTime);
        } catch {
          // A transient API/proxy error should not interrupt an active payment.
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

  private async checkCapcutVip(session: LocalSession): Promise<{ isVip: boolean; vipEndTime: number }> {
    const response = await session.context.request.post(CAPCUT_VIP_CHECK_URL, {
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.capcut.com',
        Referer: 'https://www.capcut.com/',
        appId: '348188',
        appvr: '12.4.0',
        lan: 'en',
        loc: 'VN',
        pf: '7',
      },
      data: { scene: ['vip', 'workspace'], app_id: 348188, vip_levels: ['vip', 'ultra'] },
    });
    if (!response.ok()) throw new Error(`CapCut VIP API HTTP ${response.status()}`);
    return capcutVipFromResponse(await response.json());
  }

  private async reportVip(
    session: LocalSession,
    input: PaymentBrowserCreateInput,
    vipEndTime: number,
  ): Promise<void> {
    if (session.reported) return;
    session.reported = true;
    await input.onStatus('verifying').catch((reason) => {
      log.warn(`cập nhật trạng thái xác minh ${session.id} lỗi: ${(reason as Error).message}`);
    });
    try {
      await input.onStatus('paid', undefined, { vipEndTime });
      clearInterval(session.monitor);
    } catch (reason) {
      session.reported = false;
      session.nextVipCheckAt = Date.now() + CAPCUT_VIP_POLL_MS;
      log.warn(`cập nhật VIP ${session.id} lỗi: ${(reason as Error).message}`);
    }
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
    try {
      await input.onStatus(status, error);
    } catch (reason) {
      log.warn(`cập nhật payment ${session.id} lỗi: ${(reason as Error).message}`);
    }
  }
}
