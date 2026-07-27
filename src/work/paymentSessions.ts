import { randomBytes, randomUUID } from 'node:crypto';
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

export type PaymentBrowserInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
  | { type: 'text'; text: string };

function inputRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Dữ liệu điều khiển không hợp lệ');
  return raw as Record<string, unknown>;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} không hợp lệ`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} không hợp lệ`);
  return value;
}

export function parsePaymentBrowserInput(raw: unknown): PaymentBrowserInput {
  const value = inputRecord(raw);
  if (value.type === 'click') {
    if (value.button !== undefined && !['left', 'middle', 'right'].includes(String(value.button))) {
      throw new Error('Nút chuột không hợp lệ');
    }
    return {
      type: 'click',
      x: finiteNumber(value.x, 'Tọa độ X'),
      y: finiteNumber(value.y, 'Tọa độ Y'),
      button: value.button as 'left' | 'middle' | 'right' | undefined,
    };
  }
  if (value.type === 'move') {
    return { type: 'move', x: finiteNumber(value.x, 'Tọa độ X'), y: finiteNumber(value.y, 'Tọa độ Y') };
  }
  if (value.type === 'wheel') {
    return {
      type: 'wheel',
      deltaX: finiteNumber(value.deltaX, 'Độ cuộn X'),
      deltaY: finiteNumber(value.deltaY, 'Độ cuộn Y'),
    };
  }
  if (value.type === 'key') {
    if (typeof value.key !== 'string' || !value.key || value.key.length > 40) throw new Error('Phím không hợp lệ');
    return {
      type: 'key',
      key: value.key,
      altKey: optionalBoolean(value.altKey, 'Alt'),
      ctrlKey: optionalBoolean(value.ctrlKey, 'Ctrl'),
      metaKey: optionalBoolean(value.metaKey, 'Meta'),
      shiftKey: optionalBoolean(value.shiftKey, 'Shift'),
    };
  }
  if (value.type === 'text') {
    if (typeof value.text !== 'string' || value.text.length > 2_000) throw new Error('Nội dung dán không hợp lệ');
    return { type: 'text', text: value.text };
  }
  throw new Error('Loại điều khiển không hợp lệ');
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

export interface PaymentBrowser {
  create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  frame(sessionId: string): Promise<Buffer>;
  input(sessionId: string, input: PaymentBrowserInput): Promise<void>;
  capacity?(): number | null;
  setCapacity?(maxSessions: number | null): void;
}

export interface PaymentProxyProvider {
  acquire(sourceProxyId?: string): Promise<{
    leaseId: string;
    proxy: ProxyConfig;
    egressIp: string;
  }>;
  release(leaseId: string): void;
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

  configured(): boolean {
    const publicUrl = this.settings.getPaymentPublicUrl();
    if (!publicUrl) return false;
    try {
      normalizeHttpUrl(publicUrl, 'URL công khai');
      return true;
    } catch {
      return false;
    }
  }

  async createForTask(input: {
    taskId: string;
    employeeId: string;
    email: string;
    checkoutUrl: string;
    proxy?: ProxyConfig;
    proxyRecordId?: string;
    capcutCookies?: BrowserCookieSnapshot[];
  }): Promise<{ id: string; accessUrl: string } | undefined> {
    if (!this.configured()) return undefined;
    const publicUrl = normalizeHttpUrl(this.settings.getPaymentPublicUrl()!, 'URL công khai');
    normalizeHttpUrl(input.checkoutUrl, 'Link thanh toán');

    const accessToken = randomBytes(32).toString('base64url');
    const now = new Date();
    const session: WorkPaymentSession = {
      id: randomUUID(),
      accessToken,
      accessUrl: `${publicUrl}/pay/${accessToken}`,
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
    return { id: session.id, accessUrl: session.accessUrl };
  }

  accessUrlForTask(taskId: string): string | undefined {
    return this.store.snapshot().paymentSessions.find((item) => item.taskId === taskId)?.accessUrl;
  }

  async prepareForTask(taskId: string): Promise<boolean> {
    const session = this.store.snapshot().paymentSessions.find((item) => item.taskId === taskId);
    if (!session) return false;
    if (['ready', 'paid'].includes(session.status)) return true;
    if (['closed', 'expired'].includes(session.status)) return false;

    const current = this.control();
    if (current.maxSessions !== null && session.status !== 'starting' && current.running >= current.maxSessions) return false;
    try {
      const prepared = await this.claim(session.accessToken);
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

  getByToken(token: string): PaymentSessionDto {
    const session = this.requireToken(token);
    if (new Date(session.expiresAt).getTime() <= Date.now() && !['paid', 'verification_failed', 'closed', 'expired'].includes(session.status)) {
      void this.expireDue();
      return { ...dto(session), status: 'expired' };
    }
    return dto(session);
  }

  async claim(token: string): Promise<PaymentSessionDto> {
    const current = this.requireToken(token);
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

  async frame(token: string): Promise<Buffer> {
    const session = this.requireReadyToken(token);
    return this.useBrowser(session, (id) => this.browser.frame(id));
  }

  async input(token: string, input: PaymentBrowserInput): Promise<void> {
    const session = this.requireReadyToken(token);
    await this.useBrowser(session, (id) => this.browser.input(id, input));
  }

  async controlFrame(id: string): Promise<Buffer> {
    const session = this.requireReadyId(id);
    return this.useBrowser(session, (browserId) => this.browser.frame(browserId));
  }

  async controlInput(id: string, input: PaymentBrowserInput): Promise<void> {
    const session = this.requireReadyId(id);
    await this.useBrowser(session, (browserId) => this.browser.input(browserId, input));
  }

  async closeById(id: string): Promise<void> {
    this.requireId(id);
    await this.finish(id, 'closed');
  }

  async closeByToken(token: string): Promise<void> {
    const session = this.requireToken(token);
    await this.finish(session.id, 'closed');
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

  private requireToken(token: string): WorkPaymentSession {
    const session = this.store.snapshot().paymentSessions.find((item) => item.accessToken === token);
    if (!session) throw new Error('Link thanh toán không hợp lệ');
    return session;
  }

  private requireId(id: string): WorkPaymentSession {
    const session = this.store.snapshot().paymentSessions.find((item) => item.id === id);
    if (!session) throw new Error('Không tìm thấy phiên thanh toán');
    return session;
  }

  private requireReadyToken(token: string): WorkPaymentSession {
    const session = this.requireToken(token);
    if (session.status !== 'ready' || !session.browserSessionId) {
      throw new Error('Trình duyệt thanh toán chưa sẵn sàng hoặc đã đóng');
    }
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
