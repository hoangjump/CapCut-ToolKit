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

// --- errorMiddleware ---------------------------------------------------------
// Đặt cùng file test hạ tầng server cho gọn; không liên quan payment host guard.
test('error middleware keeps the real HTTP status instead of flattening to 400', async () => {
  const { errorMiddleware, HttpError } = await import('./http.js');
  const captured: Array<{ status: number; body: unknown }> = [];
  const res = {
    headersSent: false,
    status(code: number) { captured.push({ status: code, body: undefined }); return this; },
    json(body: unknown) { captured[captured.length - 1].body = body; return this; },
  };
  const run = (err: unknown) => {
    captured.length = 0;
    errorMiddleware({ warn: () => {} })(
      err,
      { method: 'POST', path: '/api/mails/import' } as never,
      res as never,
      (() => {}) as never,
    );
    return captured[0];
  };

  // Express ném lỗi mang status ở `status`; bỏ qua nó là 413 hoá thành 400 và
  // người dùng mất manh mối "body quá lớn".
  const tooLarge = Object.assign(new Error('request entity too large'), { status: 413 });
  const a = run(tooLarge);
  assert.equal(a.status, 413);
  assert.match((a.body as { error: string }).error, /chia file thành nhiều phần/);

  // http-errors dùng `statusCode`.
  const b = run(Object.assign(new Error('nope'), { statusCode: 404 }));
  assert.equal(b.status, 404);

  // HttpError của mình.
  assert.equal(run(new HttpError(409, 'đang bận')).status, 409);

  // Lỗi thường vẫn mặc định 400 như cũ.
  const d = run(new Error('Quota phải là số nguyên dương'));
  assert.equal(d.status, 400);
  assert.equal((d.body as { error: string }).error, 'Quota phải là số nguyên dương');

  // Status vô lý thì không được tin.
  assert.equal(run(Object.assign(new Error('x'), { status: 99 })).status, 400);
});
