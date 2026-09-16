import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomYopmailAccount, parseYopmailOtp } from './yopmail.js';

test('randomYopmailAccount: địa chỉ hợp lệ + mật khẩu đủ điều kiện CapCut', () => {
  for (let i = 0; i < 50; i += 1) {
    const a = randomYopmailAccount();
    assert.match(a.email, /^[a-z0-9]+@yopmail\.com$/);
    assert.equal(a.email, `${a.login}@yopmail.com`);
    // Mật khẩu >=8 ký tự, có chữ hoa, chữ thường và số.
    assert.ok(a.password.length >= 8, `mật khẩu quá ngắn: ${a.password}`);
    assert.match(a.password, /[A-Z]/);
    assert.match(a.password, /[a-z]/);
    assert.match(a.password, /[0-9]/);
  }
});

test('randomYopmailAccount: tôn trọng prefix', () => {
  const a = randomYopmailAccount('vip');
  assert.match(a.login, /^vip/);
});

test('randomYopmailAccount: gần như không trùng qua nhiều lần sinh', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) seen.add(randomYopmailAccount().login);
  assert.ok(seen.size > 195, `trùng quá nhiều: ${seen.size}/200`);
});

test('parseYopmailOtp: lấy mã từ body mail thật của CapCut', () => {
  const body =
    'Welcome to CapCut and your verification code is 044830 ' +
    'Hey there, Your verification code: 044830 The verification code will expire';
  assert.equal(parseYopmailOtp(body), '044830');
});

test('parseYopmailOtp: KHÔNG khớp danh sách inbox bị che mã', () => {
  // Trong danh sách inbox yopmail, mã hiển thị dạng "******" (không có chữ số).
  assert.equal(parseYopmailOtp('Welcome to CapCut and your verification code is ******'), null);
});

test('parseYopmailOtp: không có mã → null', () => {
  assert.equal(parseYopmailOtp('Chào bạn, không có mã ở đây'), null);
});
