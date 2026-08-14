import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAliasOtp } from './graphMailClient.js';

const CRED = { email: 'main@outlook.com', refreshToken: 'rt', clientId: 'cid' };

/** Cài fetch giả: token endpoint trả access_token; các folder trả mail cấu hình sẵn;
 *  /me/messages/<id> trả body. Trả về hàm khôi phục fetch gốc. */
function stubFetch(opts: {
  inbox?: any[];
  junk?: any[];
  bodies?: Record<string, string>;
  onCall?: (url: string) => void;
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    opts.onCall?.(url);
    if (url.includes('/oauth2/v2.0/token')) {
      return jsonRes({ access_token: 'AT', expires_in: 3600 });
    }
    if (url.includes('/mailFolders/inbox/messages')) return jsonRes({ value: opts.inbox ?? [] });
    if (url.includes('/mailFolders/junkemail/messages')) return jsonRes({ value: opts.junk ?? [] });
    const m = url.match(/\/me\/messages\/([^?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      return jsonRes({ body: { content: opts.bodies?.[id] ?? '' } });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

function msg(over: Partial<any>): any {
  return {
    id: 'm1',
    subject: '',
    receivedDateTime: '2026-08-14T10:00:00Z',
    from: { emailAddress: { address: 'noreply@service.com' } },
    toRecipients: [{ emailAddress: { address: 'main@outlook.com' } }],
    ccRecipients: [],
    bodyPreview: '',
    ...over,
  };
}

test('bắt OTP ngay trong bodyPreview, không cần tải body', async () => {
  let bodyCalls = 0;
  const restore = stubFetch({
    inbox: [msg({ bodyPreview: 'Your verification code is 483920' })],
    onCall: (u) => { if (u.includes('/me/messages/')) bodyCalls++; },
  });
  const r = await findAliasOtp(CRED);
  restore();
  assert.equal(r?.code, '483920');
  assert.equal(bodyCalls, 0, 'không được tải body khi preview đã đủ');
});

test('lọc đúng alias — bỏ mail gửi tới địa chỉ khác', async () => {
  const restore = stubFetch({
    inbox: [
      msg({ id: 'other', toRecipients: [{ emailAddress: { address: 'someoneelse@outlook.com' } }], bodyPreview: 'code 111111' }),
      msg({ id: 'mine', toRecipients: [{ emailAddress: { address: 'aliasx@outlook.com' } }], bodyPreview: 'code 222222' }),
    ],
  });
  const r = await findAliasOtp(CRED, { alias: 'ALIASX@outlook.com' });
  restore();
  assert.equal(r?.code, '222222');
  assert.equal(r?.message.id, 'mine');
});

test('khớp alias ở cc cũng nhận', async () => {
  const restore = stubFetch({
    inbox: [msg({ toRecipients: [], ccRecipients: [{ emailAddress: { address: 'aliasx@outlook.com' } }], bodyPreview: 'code 333333' })],
  });
  const r = await findAliasOtp(CRED, { alias: 'aliasx@outlook.com' });
  restore();
  assert.equal(r?.code, '333333');
});

test('preview thiếu OTP → tải body của đúng mail đó', async () => {
  const restore = stubFetch({
    inbox: [msg({ id: 'deep', bodyPreview: 'Nhấn vào đây để xác minh' })],
    bodies: { deep: '<p>Ma cua ban la <b>venum</b></p><p>654321</p>' },
  });
  const r = await findAliasOtp(CRED);
  restore();
  assert.equal(r?.code, '654321');
});

test('quét cả Junk, ưu tiên mail mới nhất', async () => {
  const restore = stubFetch({
    inbox: [msg({ id: 'old', receivedDateTime: '2026-08-14T09:00:00Z', bodyPreview: 'code 100000' })],
    junk: [msg({ id: 'new', receivedDateTime: '2026-08-14T10:30:00Z', bodyPreview: 'code 200000' })],
  });
  const r = await findAliasOtp(CRED);
  restore();
  assert.equal(r?.code, '200000', 'mail Junk mới hơn phải thắng');
});

test('includeJunk:false thì không đọc Junk', async () => {
  let junkRead = false;
  const restore = stubFetch({
    inbox: [msg({ bodyPreview: 'code 777777' })],
    junk: [msg({ id: 'j', bodyPreview: 'code 888888' })],
    onCall: (u) => { if (u.includes('junkemail')) junkRead = true; },
  });
  await findAliasOtp(CRED, { includeJunk: false });
  restore();
  assert.equal(junkRead, false);
});

test('seenIds chặn đọc lại mail cũ', async () => {
  const seen = new Set<string>(['m1']);
  const restore = stubFetch({ inbox: [msg({ id: 'm1', bodyPreview: 'code 999999' })] });
  const r = await findAliasOtp(CRED, { seenIds: seen });
  restore();
  assert.equal(r, null, 'mail đã seen phải bị bỏ qua');
});

test('không nhầm địa chỉ email trong body thành OTP', async () => {
  const restore = stubFetch({
    inbox: [msg({ id: 'x', bodyPreview: 'Xin chao', })],
    bodies: { x: 'Lien he user12345678@spam.com hoac ma: 246810' },
  });
  const r = await findAliasOtp(CRED);
  restore();
  assert.equal(r?.code, '246810');
});
