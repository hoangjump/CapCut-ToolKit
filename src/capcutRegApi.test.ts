import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encMixMode } from './capcutRegApi.js';

/** Giải mã ngược (chỉ dùng trong test): hex → byte XOR 0x05 → UTF-8. */
function decMixMode(hex: string): string {
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((h) => (parseInt(h, 16) ^ 0x05) & 0xff));
  return new TextDecoder().decode(bytes);
}

test('encMixMode: khớp mẫu request thật (email marygreen…)', () => {
  // Lấy từ dump hook F12: email này mã hoá ra đúng chuỗi hex dưới.
  assert.equal(
    encMixMode('marygreen3cext2aa@hotmail.com'),
    '6864777c627760606b3666607d71376464456d6a7168646c692b666a68',
  );
});

test('encMixMode: khớp mẫu mã OTP thật (309184)', () => {
  assert.equal(encMixMode('309184'), '36353c343d31');
});

test('encMixMode ↔ decMixMode: đối xứng', () => {
  for (const s of ['test@outlook.com', 'P@ssw0rd!xyz', '000000', 'aZ9_@.']) {
    assert.equal(decMixMode(encMixMode(s)), s);
  }
});

test('encMixMode: chỉ ra ký tự hex, độ dài gấp đôi số byte', () => {
  const e = encMixMode('abc');
  assert.match(e, /^[0-9a-f]+$/);
  assert.equal(e.length, 6);
});
