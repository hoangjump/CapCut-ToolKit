import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../settingsStore.js';
import type { ProxyConfig } from '../types.js';
import {
  PaymentSessionService,
  type PaymentBrowser,
  type PaymentBrowserCreateInput,
  type PaymentProxyProvider,
} from './paymentSessions.js';
import { TelegramWorkStore } from './store.js';

// Sau khi gỡ màn hình thanh toán từ xa: KHÔNG còn trang /pay, tunnel, stream hay
// điều khiển từ xa. Browser nền chỉ để POLL trạng thái VIP của CapCut. App tự
// kích hoạt qua prepareForTask(taskId); nhân viên không bấm gì để mở nó nữa.

const STATIC_PROXY: ProxyConfig = { server: 'http://proxy.example:8080', username: 'user', password: 'pass' };

class FakeBrowser implements PaymentBrowser {
  readonly created: Array<PaymentBrowserCreateInput> = [];
  readonly closed: string[] = [];
  private maxSessions: number | null = 3;

  async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    this.created.push(input);
    return { sessionId: `browser-${input.id}` };
  }
  async close(sessionId: string): Promise<void> { this.closed.push(sessionId); }
  async closeAll(): Promise<void> {}
  capacity(): number | null { return this.maxSessions; }
  setCapacity(maxSessions: number | null): void { this.maxSessions = maxSessions; }
}

class PaidDuringCreateBrowser extends FakeBrowser {
  override async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    await super.create(input);
    await input.onStatus('paid');
    return { sessionId: `browser-${input.id}` };
  }
}

class FakePaymentProxyProvider implements PaymentProxyProvider {
  readonly acquired: Array<string | undefined> = [];
  readonly released: string[] = [];

  async acquire(sourceProxyId?: string) {
    this.acquired.push(sourceProxyId);
    const attempt = this.acquired.length;
    return {
      leaseId: `payment-proxy-${attempt}`,
      proxy: { server: `http://fresh-proxy-${attempt}.example:8080` },
      egressIp: `203.0.113.${attempt + 9}`,
    };
  }
  release(leaseId: string): void { this.released.push(leaseId); }
}

/** Trạng thái một task đọc từ snapshot (không còn getByToken công khai). */
function sessionStatus(store: TelegramWorkStore, taskId: string): string | undefined {
  return store.snapshot().paymentSessions.find((s) => s.taskId === taskId)?.status;
}

async function withService(
  fn: (ctx: { service: PaymentSessionService; store: TelegramWorkStore; settings: SettingsStore }) => Promise<void>,
  browser: PaymentBrowser = new FakeBrowser(),
  proxies?: PaymentProxyProvider,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    const store = new TelegramWorkStore(root);
    await store.init();
    const service = new PaymentSessionService(store, settings, browser, proxies);
    await service.init();
    await fn({ service, store, settings });
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('fails closed instead of using the machine IP when proxy is missing', async () => {
  const browser = new FakeBrowser();
  await withService(async ({ service, store }) => {
    await service.createForTask({
      taskId: 'task-no-proxy', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
    });
    // Không proxy → không được mở browser bằng IP máy.
    assert.equal(await service.prepareForTask('task-no-proxy'), false);
    assert.equal(browser.created.length, 0);
    assert.equal(sessionStatus(store, 'task-no-proxy'), 'failed');
  }, browser);
});

test('verifies VIP and marks paid without touching payroll', async () => {
  const browser = new FakeBrowser();
  await withService(async ({ service, store }) => {
    await store.mutate((state) => {
      state.tasks.push({
        id: 'task-1', employeeId: 'e1', description: 'Pay', quantity: 1, unitRate: 5_000,
        amount: 5_000, status: 'pending', deliveryStatus: 'sent', source: 'capcut-distribution',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });
    await service.createForTask({
      taskId: 'task-1', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout', proxy: STATIC_PROXY,
    });

    assert.equal(await service.prepareForTask('task-1'), true);
    assert.deepEqual(browser.created[0].proxy, STATIC_PROXY);

    // Admin view không rò checkout URL/cookie.
    const control = service.control();
    assert.equal(control.running, 1);
    assert.equal('checkoutUrl' in control.sessions[0], false);

    await browser.created[0].onStatus('paid');
    const task = store.snapshot().tasks[0];
    assert.equal(task.paymentStatus, 'paid');
    assert.ok(task.paidAt);
    // VIP tự xác minh KHÔNG cộng công — công chỉ cộng khi nhân viên thả ❤️.
    assert.equal(store.snapshot().earnings.length, 0);
    assert.equal(sessionStatus(store, 'task-1'), 'paid');
  }, browser);
});

test('capacity is persisted and updated without restarting', async () => {
  await withService(async ({ service, settings }) => {
    assert.equal((await service.updateCapacity(7)).maxSessions, 7);
    assert.equal(settings.getPaymentMaxSessions(), 7);
    assert.equal((await service.updateCapacity(null)).maxSessions, null);
    assert.equal(settings.getPaymentMaxSessions(), null);
    await assert.rejects(service.updateCapacity(-1), /số nguyên lớn hơn 0/);
  });
});

test('keeps CapCut cookies private and verifies VIP before paid', async () => {
  const browser = new FakeBrowser();
  const verified: Array<{ taskId: string; vipEndTime: number }> = [];
  await withService(async ({ service, store }) => {
    service.setVipVerifiedHandler(async (taskId, vipEndTime) => { verified.push({ taskId, vipEndTime }); });
    const cookies = [{
      name: 'sessionid', value: 'secret', domain: '.capcut.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' as const,
    }];
    await service.createForTask({
      taskId: 'task-vip', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout', proxy: STATIC_PROXY, capcutCookies: cookies,
    });

    assert.equal(await service.prepareForTask('task-vip'), true);
    assert.deepEqual(browser.created[0].capcutCookies, cookies);

    await browser.created[0].onStatus('verifying');
    assert.equal(sessionStatus(store, 'task-vip'), 'verifying');
    await browser.created[0].onStatus('paid', undefined, { vipEndTime: 1_900_000_000 });
    assert.deepEqual(verified, [{ taskId: 'task-vip', vipEndTime: 1_900_000_000 }]);
    assert.equal(sessionStatus(store, 'task-vip'), 'paid');
    // Cookie bị xoá khỏi bản lưu sau khi xong.
    assert.equal(store.snapshot().paymentSessions[0].capcutCookies, undefined);
  }, browser);
});

test('VIP verification failure closes the browser without another attempt', async () => {
  const browser = new FakeBrowser();
  await withService(async ({ service, store }) => {
    const created = await service.createForTask({
      taskId: 'task-fail', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout', proxy: STATIC_PROXY,
    });
    await service.prepareForTask('task-fail');
    await browser.created[0].onStatus('verification_failed', 'CapCut chưa báo VIP');
    assert.equal(sessionStatus(store, 'task-fail'), 'verification_failed');
    assert.deepEqual(browser.closed, [`browser-${created!.id}`]);

    // Đã hỏng xác minh thì không mở lại browser lần nữa.
    assert.equal(await service.prepareForTask('task-fail'), false);
    assert.equal(browser.created.length, 1);
  }, browser);
});

test('preparation rotates to a fresh proxy and holds it until the session closes', async () => {
  const browser = new FakeBrowser();
  const proxies = new FakePaymentProxyProvider();
  await withService(async ({ service, store }) => {
    const created = await service.createForTask({
      taskId: 'task-proxy', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
      proxy: { server: 'http://registration-proxy.example:8080' }, proxyRecordId: 'source-proxy-1',
    });
    assert.equal(await service.prepareForTask('task-proxy'), true);
    assert.deepEqual(proxies.acquired, ['source-proxy-1']);
    assert.equal(browser.created[0].proxy?.server, 'http://fresh-proxy-1.example:8080');
    assert.equal(browser.created[0].expectedProxyIp, '203.0.113.10');
    assert.equal(store.snapshot().paymentSessions[0].paymentProxyIp, '203.0.113.10');

    await service.closeById(created!.id);
    assert.deepEqual(proxies.released, ['payment-proxy-1']);
  }, browser, proxies);
});

test('a risk failure releases the current lease before retrying with a fresh proxy', async () => {
  const browser = new FakeBrowser();
  const proxies = new FakePaymentProxyProvider();
  await withService(async ({ service }) => {
    await service.createForTask({
      taskId: 'task-risk', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout', proxyRecordId: 'source-proxy-1',
    });
    await service.prepareForTask('task-risk');
    await browser.created[0].onStatus('failed', 'Cổng thanh toán từ chối do risk');
    assert.deepEqual(proxies.released, ['payment-proxy-1']);

    assert.equal(await service.prepareForTask('task-risk'), true);
    assert.deepEqual(proxies.acquired, ['source-proxy-1', 'source-proxy-1']);
    assert.equal(browser.created[1].proxy?.server, 'http://fresh-proxy-2.example:8080');
    assert.equal(browser.created[1].expectedProxyIp, '203.0.113.11');
  }, browser, proxies);
});

test('persisted ready sessions reset to pending after app restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-restart-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    const store = new TelegramWorkStore(root);
    await store.init();
    const first = new PaymentSessionService(store, settings, new FakeBrowser());
    await first.init();
    await first.createForTask({
      taskId: 'task-restart', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout', proxy: STATIC_PROXY,
    });
    await first.prepareForTask('task-restart');
    await first.close();

    const reloaded = new TelegramWorkStore(root);
    await reloaded.init();
    const restarted = new PaymentSessionService(reloaded, settings, new FakeBrowser());
    await restarted.init();
    const session = reloaded.snapshot().paymentSessions[0];
    assert.equal(session.status, 'pending');
    assert.equal(session.browserSessionId, undefined);
    await restarted.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paid status reported during browser creation is not overwritten by ready', async () => {
  const browser = new PaidDuringCreateBrowser();
  await withService(async ({ service, store }) => {
    await service.createForTask({
      taskId: 'task-race', employeeId: 'e1', email: 'w@example.com',
      checkoutUrl: 'https://cashier.example/checkout', proxy: STATIC_PROXY,
    });
    assert.equal(await service.prepareForTask('task-race'), true);
    assert.equal(sessionStatus(store, 'task-race'), 'paid');
  }, browser);
});
