import { randomUUID } from 'node:crypto';
import type { SettingsStore } from '../settingsStore.js';
import { createLogger } from '../logger.js';
import type { BrowserCookieSnapshot, ProxyConfig } from '../types.js';
import type { TelegramWorkStore } from './store.js';
import type { PaymentSessionStatus, WorkPaymentSession } from './types.js';

const log = createLogger('payment-session');
const SESSION_LIFETIME_MS = 15 * 60_000;
const PAID_CONTROL_VISIBLE_MS = 15_000;

export interface PaymentSessionDto {
  status: PaymentSessionStatus;
  email: string;
  expiresAt: string;
  error?: string;
}

export interface PaymentAdminSessionDto {
  id: string;
  taskId: string;
  employeeId: string;
  employeeName: string;
  email: string;
  status: PaymentSessionStatus;
  viewable: boolean;
  proxyServer?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  error?: string;
}

export interface PaymentControlDto {
  maxSessions: number | null;
  running: number;
  sessions: PaymentAdminSessionDto[];
}

export interface PaymentBrowserCreateInput {
  id: string;
  checkoutUrl: string;
  proxy?: ProxyConfig;
  expectedProxyIp?: string;
  capcutCookies?: BrowserCookieSnapshot[];
  expiresAt: string;
  onStatus: (
    status: 'verifying' | 'paid' | 'verification_failed' | 'failed',
    error?: string,
    vip?: { vipEndTime: number },
  ) => Promise<void>;
}

export interface PaymentProxyProvider {
  acquire(sourceProxyId?: string): Promise<{ leaseId: string; proxy: ProxyConfig; egressIp: string }>;
  release(leaseId: string): void;
}

export interface PaymentBrowser {
  create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  capacity?(): number | null;
  setCapacity?(maxSessions: number | null): void;
}

function normalizeHttpUrl(raw: string, field: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} không hợp lệ`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${field} phải bắt đầu bằng http:// hoặc https://`);
  return value;
}

function dto(session: WorkPaymentSession): PaymentSessionDto {
  return {
    status: session.status,
    email: session.email,
    expiresAt: session.expiresAt,
    error: ['failed', 'verification_failed'].includes(session.status) ? session.error : undefined,
  };
}

export class PaymentSessionService {
  private cleanupTimer?: NodeJS.Timeout;
  private readonly starting = new Map<string, Promise<PaymentSessionDto>>();
  private onVipVerified?: (taskId: string, vipEndTime: number) => Promise<void>;

  constructor(
    private readonly store: TelegramWorkStore,
    private readonly settings: SettingsStore,
    private readonly browser: PaymentBrowser,
    private readonly proxyProvider?: PaymentProxyProvider,
  ) {}

  setVipVerifiedHandler(handler: (taskId: string, vipEndTime: number) => Promise<void>): void {
    this.onVipVerified = handler;
  }

  async init(): Promise<void> {
    await this.reconcilePersistedSessions();
    await this.expireDue();
    this.cleanupTimer = setInterval(() => void this.expireDue(), 30_000);
    this.cleanupTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    const active = this.store.snapshot().paymentSessions
      .filter((session) => session.browserSessionId || session.paymentProxyLeaseId)
      .map((session) => session.id);
    await Promise.all(active.map((id) => this.closeBrowser(id)));
    await this.browser.closeAll();
  }

  /** Xác minh VIP chạy bằng browser nền TẠI MÁY — không còn cần URL công khai
   *  hay Cloudflare tunnel. Luôn sẵn sàng miễn app đang chạy. */
  configured(): boolean {
    return true;
  }

  async createForTask(input: {
    taskId: string;
    employeeId: string;
    email: string;
    checkoutUrl: string;
    proxy?: ProxyConfig;
    proxyRecordId?: string;
    capcutCookies?: BrowserCookieSnapshot[];
  }): Promise<{ id: string } | undefined> {
    if (!this.configured()) return undefined;
    normalizeHttpUrl(input.checkoutUrl, 'Link thanh toán');

    const now = new Date();
    const session: WorkPaymentSession = {
      id: randomUUID(),
      taskId: input.taskId,
      employeeId: input.employeeId,
      email: input.email,
      checkoutUrl: input.checkoutUrl,
      proxy: input.proxy,
      proxyRecordId: input.proxyRecordId,
      capcutCookies: input.capcutCookies,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.store.mutate((state) => {
      state.paymentSessions.push(session);
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (task) {
        task.paymentSessionId = session.id;
        task.paymentStatus = 'pending';
      }
    });
    return { id: session.id };
  }

  /** Mở browser nền cho một phiên và chờ nó sẵn sàng. Trước đây việc này do
   *  nhân viên bấm vào trang /pay kích hoạt; giờ trang đó không còn nên app tự
   *  gọi — browser chỉ để POLL trạng thái VIP của CapCut, không stream đi đâu. */
  private async startSession(sessionId: string): Promise<PaymentSessionDto> {
    const current = this.store.snapshot().paymentSessions.find((item) => item.id === sessionId);
    if (!current) throw new Error('Không tìm thấy phiên thanh toán');
    if (
      new Date(current.expiresAt).getTime() <= Date.now()
      && !['paid', 'verification_failed', 'closed', 'expired'].includes(current.status)
    ) {
      await this.expireDue();
      return { ...dto(current), status: 'expired' };
    }
    if (['ready', 'verifying', 'paid', 'verification_failed', 'closed', 'expired'].includes(current.status)) return dto(current);
    const running = this.starting.get(current.id);
    if (running) return running;
    const promise = this.start(current.id);
    this.starting.set(current.id, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(current.id);
    }
  }

  async prepareForTask(taskId: string): Promise<boolean> {
    const session = this.store.snapshot().paymentSessions.find((item) => item.taskId === taskId);
    if (!session) return false;
    if (['ready', 'paid'].includes(session.status)) return true;
    if (['closed', 'expired'].includes(session.status)) return false;

    const current = this.control();
    if (current.maxSessions !== null && session.status !== 'starting' && current.running >= current.maxSessions) return false;
    try {
      const prepared = await this.startSession(session.id);
      return prepared.status === 'ready' || prepared.status === 'paid';
    } catch (error) {
      log.warn(`chuẩn bị trước phiên ${session.id} lỗi: ${(error as Error).message}`);
      return false;
    }
  }

  control(): PaymentControlDto {
    const state = this.store.snapshot();
    const now = Date.now();
    const employees = new Map(state.employees.map((employee) => [employee.id, employee.fullName]));
    const sessions = state.paymentSessions
      .filter((session) => (
        !['closed', 'expired'].includes(session.status)
        && (session.status !== 'paid' || now - new Date(session.updatedAt).getTime() < PAID_CONTROL_VISIBLE_MS)
      ))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50)
      .map((session): PaymentAdminSessionDto => ({
        id: session.id,
        taskId: session.taskId,
        employeeId: session.employeeId,
        employeeName: employees.get(session.employeeId) ?? session.employeeId,
        email: session.email,
        status: session.status,
        viewable: session.status === 'ready' && Boolean(session.browserSessionId),
        proxyServer: session.proxy?.server,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        updatedAt: session.updatedAt,
        error: ['failed', 'verification_failed'].includes(session.status) ? session.error : undefined,
      }));
    return {
      maxSessions: this.browser.capacity?.() ?? null,
      running: state.paymentSessions.filter((session) => (
        session.status === 'starting' || Boolean(session.browserSessionId)
      )).length,
      sessions,
    };
  }

  async updateCapacity(raw: unknown): Promise<PaymentControlDto> {
    const maxSessions = raw === null || raw === 0 ? null : Number(raw);
    if (maxSessions !== null && (!Number.isSafeInteger(maxSessions) || maxSessions <= 0)) {
      throw new Error('Giới hạn browser phải là số nguyên lớn hơn 0');
    }
    await this.settings.setPaymentMaxSessions(maxSessions);
    this.browser.setCapacity?.(maxSessions);
    return this.control();
  }

  async closeById(id: string): Promise<void> {
    this.requireId(id);
    await this.finish(id, 'closed');
  }

  async revokeTask(taskId: string): Promise<void> {
    const session = this.store.snapshot().paymentSessions.find((item) => item.taskId === taskId);
    if (session) await this.finish(session.id, 'closed');
  }

  private async updateFromBrowser(
    id: string,
    status: 'verifying' | 'paid' | 'verification_failed' | 'failed',
    error?: string,
    vip?: { vipEndTime: number },
  ): Promise<void> {
    if (status === 'paid' && vip && this.onVipVerified) {
      const taskId = this.store.snapshot().paymentSessions.find((item) => item.id === id)?.taskId;
      try {
        if (taskId) await this.onVipVerified(taskId, vip.vipEndTime);
      } catch (reason) {
        status = 'verification_failed';
        error = `Đã xác minh VIP nhưng không cộng được sản lượng: ${(reason as Error).message}`;
      }
    }
    await this.store.mutate((state) => {
      const session = state.paymentSessions.find((item) => item.id === id);
      if (!session) return;
      const now = new Date().toISOString();
      session.status = status;
      session.error = ['failed', 'verification_failed'].includes(status) ? error || 'Thanh toán thất bại' : undefined;
      if (status === 'paid') session.capcutCookies = undefined;
      session.updatedAt = now;
      const task = state.tasks.find((item) => item.id === session.taskId);
      if (task) {
        task.paymentStatus = status;
        if (status === 'verifying' || status === 'paid') task.paidAt ??= now;
        task.updatedAt = now;
      }
    });
    if (status === 'verifying') return;
    if (status === 'failed' || status === 'verification_failed') {
      await this.closeBrowser(id);
      return;
    }
    setTimeout(() => void this.closeBrowser(id), 1_500).unref?.();
  }

  private async start(id: string): Promise<PaymentSessionDto> {
    const session = await this.store.mutate((state) => {
      const found = state.paymentSessions.find((item) => item.id === id);
      if (!found) throw new Error('Không tìm thấy phiên thanh toán');
      found.status = 'starting';
      found.error = undefined;
      found.updatedAt = new Date().toISOString();
      const task = state.tasks.find((item) => item.id === found.taskId);
      if (task) task.paymentStatus = 'starting';
      return found;
    });

    try {
      const paymentProxy = this.proxyProvider
        ? await this.proxyProvider.acquire(session.proxyRecordId)
        : undefined;
      const proxy = paymentProxy?.proxy ?? session.proxy;
      if (!proxy?.server) {
        if (paymentProxy) this.proxyProvider?.release(paymentProxy.leaseId);
        throw new Error('Payment bắt buộc phải có proxy hợp lệ; không cho phép dùng IP máy');
      }
      if (paymentProxy) {
        await this.store.mutate((state) => {
          const found = state.paymentSessions.find((item) => item.id === id)!;
          found.proxy = paymentProxy.proxy;
          found.paymentProxyLeaseId = paymentProxy.leaseId;
          found.paymentProxyIp = paymentProxy.egressIp;
          found.updatedAt = new Date().toISOString();
        });
      }
      const created = await this.browser.create({
        id: session.id,
        checkoutUrl: session.checkoutUrl,
        proxy,
        expectedProxyIp: paymentProxy?.egressIp,
        capcutCookies: session.capcutCookies,
        expiresAt: session.expiresAt,
        onStatus: (status, error, vip) => this.updateFromBrowser(session.id, status, error, vip),
      });
      const saved = await this.store.mutate((state) => {
        const found = state.paymentSessions.find((item) => item.id === id)!;
        found.browserSessionId = created.sessionId;
        found.updatedAt = new Date().toISOString();
        const task = state.tasks.find((item) => item.id === found.taskId);
        if (found.status === 'starting') {
          found.status = 'ready';
          if (task) task.paymentStatus = 'ready';
        }
        return found;
      });
      if (['paid', 'failed', 'verification_failed'].includes(saved.status)) {
        setTimeout(() => void this.closeBrowser(id), saved.status === 'paid' ? 1_500 : 500).unref?.();
      }
      return dto(saved);
    } catch (error) {
      const failed = await this.store.mutate((state) => {
        const found = state.paymentSessions.find((item) => item.id === id)!;
        found.status = 'failed';
        found.error = (error as Error).message;
        found.updatedAt = new Date().toISOString();
        const task = state.tasks.find((item) => item.id === found.taskId);
        if (task) task.paymentStatus = 'failed';
        return found;
      });
      log.warn(`khởi động phiên ${id} lỗi: ${failed.error}`);
      await this.closeBrowser(id);
      throw error;
    }
  }

  private async closeBrowser(id: string): Promise<void> {
    const runtime = await this.store.mutate((state) => {
      const session = state.paymentSessions.find((item) => item.id === id);
      if (!session) return {};
      const browserSessionId = session.browserSessionId;
      const paymentProxyLeaseId = session.paymentProxyLeaseId;
      session.browserSessionId = undefined;
      session.paymentProxyLeaseId = undefined;
      return { browserSessionId, paymentProxyLeaseId };
    });
    if (runtime.browserSessionId) await this.browser.close(runtime.browserSessionId).catch(() => {});
    if (runtime.paymentProxyLeaseId) this.proxyProvider?.release(runtime.paymentProxyLeaseId);
  }

  private async useBrowser<T>(
    session: WorkPaymentSession,
    action: (browserSessionId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await action(session.browserSessionId!);
    } catch (error) {
      await this.store.mutate((state) => {
        const found = state.paymentSessions.find((item) => item.id === session.id);
        if (!found || found.status !== 'ready' || found.browserSessionId !== session.browserSessionId) return;
        found.status = 'failed';
        found.error = (error as Error).message || 'Trình duyệt thanh toán đã đóng';
        found.updatedAt = new Date().toISOString();
        const task = state.tasks.find((item) => item.id === found.taskId);
        if (task && task.paymentStatus !== 'paid') {
          task.paymentStatus = 'failed';
          task.updatedAt = found.updatedAt;
        }
      });
      await this.closeBrowser(session.id);
      throw error;
    }
  }

  private async finish(id: string, status: 'expired' | 'closed'): Promise<void> {
    await this.store.mutate((state) => {
      const session = state.paymentSessions.find((item) => item.id === id);
      if (!session) return;
      session.status = status;
      session.updatedAt = new Date().toISOString();
      const task = state.tasks.find((item) => item.id === session.taskId);
      if (task && task.paymentStatus !== 'paid') task.paymentStatus = status;
    });
    await this.closeBrowser(id);
  }

  private async expireDue(): Promise<void> {
    const due = this.store.snapshot().paymentSessions.filter((session) => (
      new Date(session.expiresAt).getTime() <= Date.now()
      && !['paid', 'verification_failed', 'expired', 'closed'].includes(session.status)
    ));
    await Promise.all(due.map((session) => this.finish(session.id, 'expired').catch((error) => {
      log.warn(`dọn phiên ${session.id} lỗi: ${(error as Error).message}`);
    })));
  }

  private async reconcilePersistedSessions(): Promise<void> {
    await this.store.mutate((state) => {
      for (const session of state.paymentSessions) {
        // Browser processes only live in memory, so their IDs cannot survive an app restart.
        session.browserSessionId = undefined;
        session.paymentProxyLeaseId = undefined;
        if (session.status === 'verifying') {
          session.status = 'verification_failed';
          session.error = 'App đã khởi động lại khi đang xác minh VIP; không thanh toán lại tài khoản này';
          session.updatedAt = new Date().toISOString();
          const task = state.tasks.find((item) => item.id === session.taskId);
          if (task && task.paymentStatus !== 'paid') {
            task.paymentStatus = 'verification_failed';
            task.updatedAt = session.updatedAt;
          }
          continue;
        }
        if (!['starting', 'ready'].includes(session.status)) continue;
        session.status = 'pending';
        session.error = undefined;
        session.updatedAt = new Date().toISOString();
        const task = state.tasks.find((item) => item.id === session.taskId);
        if (task && task.paymentStatus !== 'paid') {
          task.paymentStatus = 'pending';
          task.updatedAt = session.updatedAt;
        }
      }
    });
  }

  private requireId(id: string): WorkPaymentSession {
    const session = this.store.snapshot().paymentSessions.find((item) => item.id === id);
    if (!session) throw new Error('Không tìm thấy phiên thanh toán');
    return session;
  }

  private requireReadyId(id: string): WorkPaymentSession {
    const session = this.requireId(id);
    if (session.status !== 'ready' || !session.browserSessionId) {
      throw new Error('Trình duyệt thanh toán chưa sẵn sàng hoặc đã đóng');
    }
    return session;
  }
}
