import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProxyLeaseRegistry } from '../proxyLeaseRegistry.js';
import { ProxyStore } from '../proxyStore.js';
import { UsedIpStore } from '../usedIpStore.js';
import { PaymentProxyAllocator } from './paymentProxyAllocator.js';

test('payment proxy allocator skips used IPs, leases a fresh one and never falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payment-proxy-allocator-test-'));
  try {
    const store = new ProxyStore(root);
    await store.init();
    const first = await store.create({
      type: 'http', host: 'proxy-one.example', port: 8001, tags: ['vn'],
      apiProvider: 'mktproxy', apiKey: 'order-one',
    });
    const second = await store.create({
      type: 'http', host: 'proxy-two.example', port: 8002, tags: ['vn'],
      apiProvider: 'mktproxy', apiKey: 'order-two',
    });
    const used = new UsedIpStore(root);
    await used.init();
    await used.add('203.0.113.1');
    const leases = new ProxyLeaseRegistry();
    const allocator = new PaymentProxyAllocator(store, used, leases, {
      maxWaitMs: 30,
      pollMs: 1,
      rotate: async (record) => ({
        proxy: { server: `http://${record.host}:${record.port}` },
        egressIp: record.id === first.id ? '203.0.113.1' : '203.0.113.2',
        retryAfterMs: 1,
      }),
      verify: async (_proxy, rotated) => rotated.egressIp,
    });

    const acquired = await allocator.acquire(first.id);
    assert.equal(acquired.leaseId, second.id);
    assert.equal(acquired.egressIp, '203.0.113.2');
    assert.equal(leases.isLeased(second.id), true);
    assert.equal(used.has('203.0.113.2'), true);
    allocator.release(acquired.leaseId);
    assert.equal(leases.isLeased(second.id), false);

    const strict = new PaymentProxyAllocator(store, used, new ProxyLeaseRegistry(), {
      maxWaitMs: 5,
      pollMs: 1,
      rotate: async (record) => ({
        proxy: { server: `http://${record.host}:${record.port}` },
        egressIp: '203.0.113.1',
        retryAfterMs: 1,
      }),
      verify: async (_proxy, rotated) => rotated.egressIp,
    });
    await assert.rejects(strict.acquire(first.id), /không lấy được IP proxy mới/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
