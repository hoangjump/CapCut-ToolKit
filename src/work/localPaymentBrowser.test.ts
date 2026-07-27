import assert from 'node:assert/strict';
import test from 'node:test';
import { capcutVipFromResponse, capturePaymentFrame, paymentFailureFromText } from './localPaymentBrowser.js';

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
