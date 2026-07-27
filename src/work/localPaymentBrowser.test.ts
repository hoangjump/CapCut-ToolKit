import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentFailureFromText } from './localPaymentBrowser.js';

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
