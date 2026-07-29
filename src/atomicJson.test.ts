import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJsonAtomic } from './atomicJson.js';

test('atomic write replaces the file wholesale and leaves no temp behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-json-test-'));
  try {
    const file = join(root, 'proxies.json');
    await writeFile(file, JSON.stringify([{ id: 'cũ' }]), 'utf8');

    await writeJsonAtomic(file, [{ id: 'mới' }]);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [{ id: 'mới' }]);
    assert.deepEqual((await readdir(root)).sort(), ['proxies.json']);

    // 20 lời gọi ĐỒNG THỜI trên cùng file: mỗi lời gọi phải dùng file tạm riêng,
    // nếu không nội dung trộn vào nhau và JSON.parse sẽ ném. Và vì có hàng đợi,
    // bản ghi cuối theo thứ tự gọi phải là bản nằm lại trên đĩa.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeJsonAtomic(file, { lần: i })),
    );
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { lần: 19 });
    assert.deepEqual((await readdir(root)).sort(), ['proxies.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic write creates the file when it does not exist yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-json-test-'));
  try {
    const file = join(root, 'settings.json');
    await writeJsonAtomic(file, { apiKey: 'abc' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { apiKey: 'abc' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
