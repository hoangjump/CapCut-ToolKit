import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireMailWithFallback } from '../mailAllocation.js';
import { MailStore, type CreateMailInput } from '../mailStore.js';

function mail(email: string): CreateMailInput {
  return {
    email,
    password: 'secret',
    refreshToken: `refresh-${email}`,
    clientId: `client-${email}`,
    tags: ['backup'],
    status: 'available',
    source: 'manual',
  };
}

test('mail allocator reserves distinct stock records for concurrent profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mail-allocation-race-test-'));
  try {
    const store = new MailStore(root);
    await store.init();
    await store.createMany([mail('one@example.com'), mail('two@example.com')]);

    let apiCalls = 0;
    const [first, second] = await Promise.all([
      acquireMailWithFallback(store, { profileId: 'profile-one', strategy: 'stock-only', stockTags: ['backup'] }, async () => {
        apiCalls += 1;
        return mail('api-one@example.com');
      }),
      acquireMailWithFallback(store, { profileId: 'profile-two', strategy: 'stock-only', stockTags: ['backup'] }, async () => {
        apiCalls += 1;
        return mail('api-two@example.com');
      }),
    ]);

    assert.notEqual(first.id, second.id);
    assert.equal(apiCalls, 0);
    assert.deepEqual(new Set([first.reservedByProfileId, second.reservedByProfileId]), new Set(['profile-one', 'profile-two']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mail allocator falls back to stock after an API error and settles outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mail-allocation-fallback-test-'));
  try {
    const store = new MailStore(root);
    await store.init();
    const [stock, failedStock] = await store.createMany([mail('stock@example.com'), mail('failed@example.com')]);
    let apiCalls = 0;

    const acquired = await acquireMailWithFallback(store, { profileId: 'profile-one', strategy: 'api-then-stock' }, async () => {
      apiCalls += 1;
      throw new Error('provider hết mail');
    });
    assert.equal(acquired.id, stock.id);
    assert.equal(apiCalls, 1);

    await store.markUsed(acquired.id);
    assert.equal(store.get(acquired.id)?.status, 'used');
    assert.equal(store.get(acquired.id)?.reservedByProfileId, undefined);

    const failed = await store.reserveAvailable({ profileId: 'profile-two' });
    assert.equal(failed?.id, failedStock.id);
    await store.markFailed(failed!.id, 'flow lỗi');
    assert.equal(store.get(failed!.id)?.status, 'failed');
    assert.equal(store.get(failed!.id)?.lastError, 'flow lỗi');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reserved mail cannot be reset or deleted by management actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mail-allocation-protection-test-'));
  try {
    const store = new MailStore(root);
    await store.init();
    const created = await store.create(mail('reserved@example.com'));
    await store.reserveAvailable({ profileId: 'profile-one' });

    await assert.rejects(store.updateStatus([created.id], 'available'), /đang được giữ/i);
    await assert.rejects(store.delete(created.id), /đang được giữ/i);
    await assert.rejects(store.deleteMany([created.id]), /đang được giữ/i);
    await assert.rejects(store.clear(), /đang được giữ/i);
    assert.equal(store.get(created.id)?.status, 'reserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
