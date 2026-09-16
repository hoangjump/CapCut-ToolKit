import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOtp,
  stripHtml,
  pickTempmailDomain,
  createEmail,
  listMessages,
  pollTempmailOtp,
  type TempmailConfig,
} from './tempmailClient.js';

/** Fetch giả: map từ "METHOD path" → data trả về (đóng gói {success,data}). */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(url).replace('https://tempmail.id.vn/api', '');
    const key = `${method} ${path}`;
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({ success: false, message: 'not found' }) } as any;
    return { ok: true, status: 200, json: async () => ({ success: true, message: 'ok', data: routes[key] }) } as any;
  }) as unknown as typeof fetch;
}

test('extractOtp: lấy mã CapCut từ subject', () => {
  assert.equal(extractOtp('Welcome to CapCut and your verification code is 239865'), '239865');
});

test('extractOtp: không có mã → null', () => {
  assert.equal(extractOtp('Chào bạn'), null);
});

test('stripHtml: bỏ thẻ + gộp khoảng trắng', () => {
  assert.equal(stripHtml('<p>Your code: <b>123456</b></p>'), 'Your code: 123456');
});

test('pickTempmailDomain: tránh domain lộ liễu (tempmail/yopmail)', () => {
  for (let i = 0; i < 30; i += 1) {
    const d = pickTempmailDomain(['tempmail.id.vn', 'hathitrannhien.edu.vn', 'yopmail.com']);
    assert.equal(d, 'hathitrannhien.edu.vn');
  }
});

test('pickTempmailDomain: nếu tất cả đều lộ thì vẫn trả một cái', () => {
  const d = pickTempmailDomain(['tempmail.id.vn'], () => 0);
  assert.equal(d, 'tempmail.id.vn');
});

test('pickTempmailDomain: rỗng → undefined', () => {
  assert.equal(pickTempmailDomain([]), undefined);
});

test('createEmail: parse id + email từ API', async () => {
  const cfg: TempmailConfig = {
    token: 't',
    fetchImpl: fakeFetch({ 'POST /email/create': { id: 2688680, email: 'abc@hathitrannhien.edu.vn' } }),
  };
  const r = await createEmail(cfg, { domain: 'hathitrannhien.edu.vn' });
  assert.deepEqual(r, { id: '2688680', email: 'abc@hathitrannhien.edu.vn' });
});

test('listMessages: map items → meta', async () => {
  const cfg: TempmailConfig = {
    token: 't',
    fetchImpl: fakeFetch({
      'GET /email/1': { items: [{ id: 99, subject: 'S', from: 'admin@mail.capcut.com' }], pagination: {} },
    }),
  };
  const msgs = await listMessages(cfg, '1');
  assert.deepEqual(msgs, [{ id: '99', subject: 'S', from: 'admin@mail.capcut.com' }]);
});

test('pollTempmailOtp: đọc mã ngay ở subject (không cần đọc body)', async () => {
  const cfg: TempmailConfig = {
    token: 't',
    fetchImpl: fakeFetch({
      'GET /email/1': {
        items: [{ id: 5, subject: 'Welcome to CapCut and your verification code is 044830', from: 'admin@mail.capcut.com' }],
      },
    }),
  };
  const code = await pollTempmailOtp(cfg, '1', { tries: 1 });
  assert.equal(code, '044830');
});

test('pollTempmailOtp: subject không có mã → đọc body', async () => {
  const cfg: TempmailConfig = {
    token: 't',
    fetchImpl: fakeFetch({
      'GET /email/1': { items: [{ id: 7, subject: 'CapCut verification', from: 'admin@mail.capcut.com' }] },
      'GET /message/7': { subject: 'CapCut verification', body: '<p>your verification code is 555111</p>' },
    }),
  };
  const code = await pollTempmailOtp(cfg, '1', { tries: 1 });
  assert.equal(code, '555111');
});

test('pollTempmailOtp: hộp trống sau hết lượt → ném lỗi', async () => {
  const cfg: TempmailConfig = { token: 't', fetchImpl: fakeFetch({ 'GET /email/1': { items: [] } }) };
  await assert.rejects(() => pollTempmailOtp(cfg, '1', { tries: 2, intervalMs: 1 }), /không đọc được OTP/);
});
