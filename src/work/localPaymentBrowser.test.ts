import assert from 'node:assert/strict';
import test from 'node:test';
import { capcutVipFromResponse, capturePaymentFrame, LocalPaymentBrowser, paymentFailureFromText } from './localPaymentBrowser.js';

test('detects the payment risk message shown by the checkout page', () => {
  const text = "Couldn't process payment\nTransaction rejected due to risk issue. Try again later or contact customer support for details.";

  assert.equal(
    paymentFailureFromText(text),
    'Cổng thanh toán từ chối do risk; lần thử tiếp theo sẽ dùng proxy mới',
  );
});

test('does not fail an active payment without a known failure message', () => {
  assert.equal(paymentFailureFromText('Scan the QR code to complete your payment'), undefined);
});

test('keeps the latest frame when a screenshot temporarily times out', async () => {
  const previous = Buffer.from('previous-jpeg');
  const page = {
    screenshot: async () => {
      throw new Error('page.screenshot: Timeout 5000ms exceeded. Call log: - waiting for fonts to load...');
    },
  };

  assert.equal(await capturePaymentFrame(page, previous), previous);
});

test('reads active VIP and expiry from the CapCut subscription response', () => {
  assert.deepEqual(capcutVipFromResponse({
    data: {
      subscription_user_infos: {
        vip: { vip_infos: [{ is_vip: false }, { is_vip: true, vip_end_time: 1_900_000_000 }] },
      },
    },
  }), { isVip: true, vipEndTime: 1_900_000_000 });
  assert.deepEqual(capcutVipFromResponse({ data: {} }), { isVip: false, vipEndTime: 0 });
});

test('payment browser has no hard session limit by default', () => {
  const previous = process.env.PAYMENT_MAX_SESSIONS;
  delete process.env.PAYMENT_MAX_SESSIONS;
  try {
    assert.equal(new LocalPaymentBrowser().capacity(), null);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_MAX_SESSIONS;
    else process.env.PAYMENT_MAX_SESSIONS = previous;
  }
});

test('payment browser capacity can be changed without restarting', () => {
  const browser = new LocalPaymentBrowser(null);
  assert.equal(browser.capacity(), null);
  browser.setCapacity(8);
  assert.equal(browser.capacity(), 8);
  browser.setCapacity(null);
  assert.equal(browser.capacity(), null);
});

test('payment browser verifies CapCut VIP without waiting for a VNC success page', async () => {
  const browser = new LocalPaymentBrowser(null);
  const statuses: string[] = [];
  const monitor = setInterval(() => {}, 10_000);
  monitor.unref?.();
  const session = {
    id: 'payment-session-1',
    context: {
      pages: () => [],
      request: {
        post: async () => ({
          ok: () => true,
          status: () => 200,
          json: async () => ({
            data: { subscription_user_infos: { vip: { vip_infos: [{ is_vip: true, vip_end_time: 1_900_000_000 }] } } },
          }),
        }),
      },
    },
    checking: false,
    reported: false,
    nextVipCheckAt: 0,
    monitor,
  };
  const input = {
    capcutCookies: [{
      name: 'sessionid', value: 'secret', domain: '.capcut.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax',
    }],
    onStatus: async (status: string) => { statuses.push(status); },
  };

  await (browser as any).checkPayment(session, input);

  assert.deepEqual(statuses, ['verifying', 'paid']);
  assert.equal(session.reported, true);
});

test('payment browser throttles background VIP checks to every three seconds', async () => {
  const browser = new LocalPaymentBrowser(null);
  let requests = 0;
  const monitor = setInterval(() => {}, 10_000);
  monitor.unref?.();
  const session = {
    id: 'payment-session-2',
    context: {
      pages: () => [],
      request: {
        post: async () => {
          requests += 1;
          return { ok: () => true, status: () => 200, json: async () => ({ data: {} }) };
        },
      },
    },
    checking: false,
    reported: false,
    nextVipCheckAt: 0,
    monitor,
  };
  const input = {
    capcutCookies: [{
      name: 'sessionid', value: 'secret', domain: '.capcut.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax',
    }],
    onStatus: async () => {},
  };
  const startedAt = Date.now();

  await (browser as any).checkPayment(session, input);
  await (browser as any).checkPayment(session, input);
  clearInterval(monitor);

  assert.equal(requests, 1);
  assert.ok(session.nextVipCheckAt >= startedAt + 3_000);
});

test('payment browser keeps polling when the paid callback fails once', async () => {
  const browser = new LocalPaymentBrowser(null);
  let paidAttempts = 0;
  const monitor = setInterval(() => {}, 10_000);
  monitor.unref?.();
  const session = {
    id: 'payment-session-3',
    context: {
      pages: () => [],
      request: {
        post: async () => ({
          ok: () => true,
          status: () => 200,
          json: async () => ({
            data: { subscription_user_infos: { vip: { vip_infos: [{ is_vip: true, vip_end_time: 1_900_000_000 }] } } },
          }),
        }),
      },
    },
    checking: false,
    reported: false,
    nextVipCheckAt: 0,
    monitor,
  };
  const input = {
    capcutCookies: [{
      name: 'sessionid', value: 'secret', domain: '.capcut.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax',
    }],
    onStatus: async (status: string) => {
      if (status !== 'paid') return;
      paidAttempts += 1;
      if (paidAttempts === 1) throw new Error('temporary store error');
    },
  };

  await (browser as any).checkPayment(session, input);
  assert.equal(session.reported, false);
  session.nextVipCheckAt = 0;
  await (browser as any).checkPayment(session, input);

  assert.equal(paidAttempts, 2);
  assert.equal(session.reported, true);
});
