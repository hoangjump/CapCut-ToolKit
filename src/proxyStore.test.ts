import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProxyStore, parseProxyLine } from './proxyStore.js';

async function seed(root: string, count: number): Promise<ProxyStore> {
  const store = new ProxyStore(root);
  await store.init();
  for (let i = 1; i <= count; i += 1) {
    // parseProxyLine nhận "host:port:user:pass", không phải URL.
    await store.create({ type: 'http', tags: [], ...parseProxyLine(`10.0.0.${i}:8080:user:pass`) });
  }
  return store;
}

test('bulk delete removes the listed proxies and survives unknown ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-store-test-'));
  try {
    const store = await seed(root, 4);
    const ids = store.list().map((proxy) => proxy.id);

    const removed = await store.deleteMany([ids[0], ids[2], 'khong-ton-tai', ids[0]]);
    assert.equal(removed, 2, 'id trùng và id lạ không được tính');
    assert.deepEqual(store.list().map((p) => p.id).sort(), [ids[1], ids[3]].sort());

    // Đã ghi xuống đĩa, không chỉ đổi trong RAM.
    const onDisk = JSON.parse(await readFile(join(root, 'proxies.json'), 'utf8')) as Array<{ id: string }>;
    assert.equal(onDisk.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clear empties the store and reports how many went', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-store-test-'));
  try {
    const store = await seed(root, 3);
    assert.equal(await store.clear(), 3);
    assert.deepEqual(store.list(), []);
    assert.equal(await store.clear(), 0, 'kho trống thì không ghi lại đĩa');

    const reopened = new ProxyStore(root);
    await reopened.init();
    assert.deepEqual(reopened.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
