import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../settingsStore.js';
import type { ProxyConfig } from '../types.js';
import {
  parsePaymentBrowserInput,
  PaymentSessionService,
  type PaymentBrowser,
  type PaymentBrowserCreateInput,
  type PaymentBrowserInput,
  type PaymentProxyProvider,
} from './paymentSessions.js';
import { TelegramWorkStore } from './store.js';

class FakeBrowser implements PaymentBrowser {
  readonly created: Array<PaymentBrowserCreateInput> = [];
  readonly closed: string[] = [];
  readonly inputs: PaymentBrowserInput[] = [];

  async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    this.created.push(input);
    return { sessionId: `browser-${input.id}` };
  }

  async close(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }

  async closeAll(): Promise<void> {}

  async frame(): Promise<Buffer> {
    return Buffer.from('jpeg');
  }

  async input(_sessionId: string, input: PaymentBrowserInput): Promise<void> {
    this.inputs.push(input);
  }

  capacity(): number { return 3; }
}

class PaidDuringCreateBrowser extends FakeBrowser {
  override async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    this.created.push(input);
    await input.onStatus('paid');
    return { sessionId: `browser-${input.id}` };
  }
}

class MissingFrameBrowser extends FakeBrowser {
  override async frame(): Promise<Buffer> {
    throw new Error('Phiên trình duyệt chưa sẵn sàng hoặc đã đóng');
  }
}

class FakePaymentProxyProvider implements PaymentProxyProvider {
  readonly acquired: Array<string | undefined> = [];
  readonly released: string[] = [];

  async acquire(sourceProxyId?: string) {
    this.acquired.push(sourceProxyId);
    return {
      leaseId: 'payment-proxy-1',
      proxy: { server: 'http://fresh-proxy.example:8080' },
      egressIp: '203.0.113.10',
    };
  }

  release(leaseId: string): void {
    this.released.push(leaseId);
  }
}

test('payment browser input rejects malformed public requests', () => {
  assert.deepEqual(parsePaymentBrowserInput({ type: 'click', x: 10, y: 20 }), {
    type: 'click', x: 10, y: 20, button: undefined,
  });
  assert.throws(() => parsePaymentBrowserInput({ type: 'click', x: '10', y: 20 }), /Tọa độ X/);
  assert.throws(() => parsePaymentBrowserInput({ type: 'key', key: 'A', ctrlKey: 'yes' }), /Ctrl/);
  assert.throws(() => parsePaymentBrowserInput({ type: 'unknown' }), /Loại điều khiển/);
});

test('payment session starts lazily, keeps proxy and marks paid without changing payroll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setPaymentPublicUrl('https://app.example');
    const store = new TelegramWorkStore(root);
    await store.init();
    await store.mutate((state) => {
      state.tasks.push({
        id: 'task-1',
        employeeId: 'employee-1',
        description: 'Thanh toán CapCut',
        quantity: 1,
        unitRate: 5_000,
        amount: 5_000,
        status: 'pending',
        deliveryStatus: 'sent',
        source: 'capcut-distribution',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const browser = new FakeBrowser();
    const service = new PaymentSessionService(store, settings, browser);
    await service.init();
    const proxy = { server: 'http://proxy.example:8080', username: 'user', password: 'pass' };

    const created = await service.createForTask({
      taskId: 'task-1',
      employeeId: 'employee-1',
      email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
      proxy,
    });
    assert.ok(created?.accessUrl.startsWith('https://app.example/pay/'));
    assert.equal(browser.created.length, 0);

    const token = created!.accessUrl.split('/').at(-1)!;
    assert.equal(service.getByToken(token).status, 'pending');
    const ready = await service.claim(token);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(browser.created[0].proxy, proxy);
    const control = service.control();
    assert.equal(control.maxSessions, 3);
    assert.equal(control.running, 1);
    assert.equal(control.sessions[0].viewable, true);
    assert.equal(control.sessions[0].proxyServer, proxy.server);
    assert.equal('accessToken' in control.sessions[0], false);
    assert.equal('checkoutUrl' in control.sessions[0], false);
    assert.equal((await service.controlFrame(control.sessions[0].id)).toString(), 'jpeg');
    assert.equal((await service.frame(token)).toString(), 'jpeg');
    await service.input(token, { type: 'click', x: 10, y: 20 });
    assert.deepEqual(browser.inputs[0], { type: 'click', x: 10, y: 20 });

    await browser.created[0].onStatus('paid');
    const task = store.snapshot().tasks[0];
    assert.equal(task.paymentStatus, 'paid');
    assert.ok(task.paidAt);
    assert.equal(store.snapshot().earnings.length, 0);
    assert.equal(service.getByToken(token).status, 'paid');
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('payment session can be prepared before the employee opens the Telegram link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-prepare-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setPaymentPublicUrl('https://app.example');
    const store = new TelegramWorkStore(root);
    await store.init();
    const browser = new FakeBrowser();
    const service = new PaymentSessionService(store, settings, browser);
    await service.init();
    await service.createForTask({
      taskId: 'task-prepare',
      employeeId: 'employee-1',
      email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
    });

    assert.equal(await service.prepareForTask('task-prepare'), true);
    assert.equal(browser.created.length, 1);
    assert.equal(store.snapshot().paymentSessions[0].status, 'ready');
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('payment preparation rotates to a fresh proxy and holds it until the session closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-proxy-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setPaymentPublicUrl('https://app.example');
    const store = new TelegramWorkStore(root);
    await store.init();
    const browser = new FakeBrowser();
    const proxies = new FakePaymentProxyProvider();
    const service = new PaymentSessionService(store, settings, browser, proxies);
    await service.init();
    const created = await service.createForTask({
      taskId: 'task-proxy',
      employeeId: 'employee-1',
      email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
      proxy: { server: 'http://registration-proxy.example:8080' },
      proxyRecordId: 'source-proxy-1',
    });
    const token = created!.accessUrl.split('/').at(-1)!;

    assert.equal(await service.prepareForTask('task-proxy'), true);
    assert.deepEqual(proxies.acquired, ['source-proxy-1']);
    assert.equal(browser.created[0].proxy?.server, 'http://fresh-proxy.example:8080');
    assert.equal(browser.created[0].expectedProxyIp, '203.0.113.10');
    assert.equal(store.snapshot().paymentSessions[0].paymentProxyIp, '203.0.113.10');

    await service.closeByToken(token);
    assert.deepEqual(proxies.released, ['payment-proxy-1']);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persisted ready sessions reset after app restart instead of returning endless frame conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-restart-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setPaymentPublicUrl('https://app.example');
    const store = new TelegramWorkStore(root);
    await store.init();
    await store.mutate((state) => {
      state.tasks.push({
        id: 'task-restart', employeeId: 'employee-1', description: 'Pay', quantity: 1,
        unitRate: 5_000, amount: 5_000, status: 'pending', deliveryStatus: 'sent',
        paymentStatus: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });
    const first = new PaymentSessionService(store, settings, new FakeBrowser());
    await first.init();
    const created = await first.createForTask({
      taskId: 'task-restart', employeeId: 'employee-1', email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
    });
    const token = created!.accessUrl.split('/').at(-1)!;
    await first.claim(token);
    await first.close();

    const reloadedStore = new TelegramWorkStore(root);
    await reloadedStore.init();
    const restarted = new PaymentSessionService(reloadedStore, settings, new FakeBrowser());
    await restarted.init();
    const session = reloadedStore.snapshot().paymentSessions[0];
    assert.equal(session.status, 'pending');
    assert.equal(session.browserSessionId, undefined);
    assert.equal(reloadedStore.snapshot().tasks[0].paymentStatus, 'pending');
    await restarted.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a crashed browser marks the session failed so the employee can retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-crash-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setPaymentPublicUrl('https://app.example');
    const store = new TelegramWorkStore(root);
    await store.init();
    await store.mutate((state) => {
      state.tasks.push({
        id: 'task-crash', employeeId: 'employee-1', description: 'Pay', quantity: 1,
        unitRate: 5_000, amount: 5_000, status: 'pending', deliveryStatus: 'sent',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });
    const service = new PaymentSessionService(store, settings, new MissingFrameBrowser());
    await service.init();
    const created = await service.createForTask({
      taskId: 'task-crash', employeeId: 'employee-1', email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
    });
    const token = created!.accessUrl.split('/').at(-1)!;
    await service.claim(token);

    await assert.rejects(service.frame(token), /đã đóng/);
    const session = store.snapshot().paymentSessions[0];
    assert.equal(session.status, 'failed');
    assert.equal(session.browserSessionId, undefined);
    assert.match(session.error ?? '', /đã đóng/);
    assert.equal(store.snapshot().tasks[0].paymentStatus, 'failed');
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('payment session stays disabled until the app has a public tunnel URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-disabled-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    const store = new TelegramWorkStore(root);
    await store.init();
    const service = new PaymentSessionService(store, settings, new FakeBrowser());
    await service.init();
    assert.equal(await service.createForTask({
      taskId: 'task-1',
      employeeId: 'employee-1',
      email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
    }), undefined);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paid status reported during browser creation is not overwritten by ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-session-race-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setPaymentPublicUrl('https://app.example');
    const store = new TelegramWorkStore(root);
    await store.init();
    const service = new PaymentSessionService(store, settings, new PaidDuringCreateBrowser());
    await service.init();
    const created = await service.createForTask({
      taskId: 'task-race',
      employeeId: 'employee-1',
      email: 'worker@example.com',
      checkoutUrl: 'https://cashier.example/checkout',
    });

    const token = created!.accessUrl.split('/').at(-1)!;
    assert.equal((await service.claim(token)).status, 'paid');
    assert.equal(service.getByToken(token).status, 'paid');
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
