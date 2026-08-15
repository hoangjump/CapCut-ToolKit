import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomAliasName, classifySubmit } from './aliasFlow.js';

test('randomAliasName: chữ thường, có prefix, đủ dài, không trùng nhau', () => {
  const a = randomAliasName('hrs');
  const b = randomAliasName('hrs');
  assert.match(a, /^hrs[a-z0-9]{6,}\d{2}$/);
  assert.equal(a, a.toLowerCase());
  assert.notEqual(a, b);
});

test('randomAliasName: đổi prefix', () => {
  assert.match(randomAliasName('shop'), /^shop/);
});

test('classifySubmit: nhận diện tên trùng (Anh + Trung)', () => {
  assert.equal(classifySubmit('This email is already taken.').kind, 'duplicate');
  assert.equal(classifySubmit('该用户名已被使用').kind, 'duplicate');
});

test('classifySubmit: nhận diện chạm trần alias', () => {
  assert.equal(classifySubmit("You've reached the maximum number of aliases.").kind, 'limit');
  assert.equal(classifySubmit('已达到别名上限').kind, 'limit');
});

test('classifySubmit: trang danh sách (có Remove) = đã tạo', () => {
  assert.equal(classifySubmit('alias@outlook.com Remove Primary alias').kind, 'created');
  assert.equal(classifySubmit('别名  删除').kind, 'created');
});

test('classifySubmit: giới hạn tần suất = ratelimit', () => {
  assert.equal(classifySubmit('We limit how frequently you can add aliases to your account. Please try again later.').kind, 'ratelimit');
});

test('classifySubmit: text lạ = unknown kèm trích đoạn', () => {
  const r = classifySubmit('Some totally unexpected page content here');
  assert.equal(r.kind, 'unknown');
  assert.equal((r as { detail: string }).detail.length > 0, true);
});
