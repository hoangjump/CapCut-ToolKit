import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAllowedPaymentRequest,
  isPaymentPublicHost,
  shouldRestrictToPaymentRoutes,
} from './paymentHostGuard.js';

test('payment public hostname only allows viewer assets and payment session routes', () => {
  assert.equal(isPaymentPublicHost('pay.example.com', 'https://pay.example.com'), true);
  assert.equal(isPaymentPublicHost('admin.example.com', 'https://pay.example.com'), false);
  assert.equal(isPaymentPublicHost('localhost', 'http://localhost:3000'), false);
  assert.equal(shouldRestrictToPaymentRoutes('127.0.0.1', 'https://pay.example.com', true), true);

  assert.equal(isAllowedPaymentRequest('GET', '/pay/token-123'), true);
  assert.equal(isAllowedPaymentRequest('GET', '/pay/health'), true);
  assert.equal(isAllowedPaymentRequest('GET', '/assets/index.js'), true);
  assert.equal(isAllowedPaymentRequest('GET', '/api/work/payment-sessions/token-123'), true);
  assert.equal(isAllowedPaymentRequest('POST', '/api/work/payment-sessions/token-123/claim'), true);
  assert.equal(isAllowedPaymentRequest('GET', '/api/work/payment-sessions/token-123/frame'), true);
  assert.equal(isAllowedPaymentRequest('GET', '/api/work/payment-sessions/token-123/stream'), true);
  assert.equal(isAllowedPaymentRequest('POST', '/api/work/payment-sessions/token-123/input'), true);
  assert.equal(isAllowedPaymentRequest('DELETE', '/api/work/payment-sessions/token-123'), true);
  assert.equal(isAllowedPaymentRequest('POST', '/api/work/payment-sessions/session-id/status'), false);
  assert.equal(isAllowedPaymentRequest('GET', '/api/work/payment-control'), false);
  assert.equal(isAllowedPaymentRequest('GET', '/api/work/payment-control/session-id/frame'), false);

  assert.equal(isAllowedPaymentRequest('GET', '/'), false);
  assert.equal(isAllowedPaymentRequest('GET', '/api/work/config'), false);
  assert.equal(isAllowedPaymentRequest('GET', '/api/profiles'), false);
  assert.equal(isAllowedPaymentRequest('POST', '/api/work/tasks'), false);
});
