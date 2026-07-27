import type { ProxyRecord, ProxyStore } from '../proxyStore.js';
import type { UsedIpStore } from '../usedIpStore.js';
import type { ProxyConfig } from '../types.js';
import type { ProxyLeaseRegistry } from '../proxyLeaseRegistry.js';

export interface RotatedPaymentProxy {
  proxy: ProxyConfig;
  egressIp?: string;
  retryAfterMs?: number;
}

export interface PaymentProxyLease {
  leaseId: string;
  proxy: ProxyConfig;
  egressIp: string;
}

interface PaymentProxyAllocatorOptions {
  rotate: (record: ProxyRecord) => Promise<RotatedPaymentProxy>;
  verify: (proxy: ProxyConfig, rotated: RotatedPaymentProxy, record: ProxyRecord) => Promise<string | undefined>;
  maxWaitMs?: number;
  pollMs?: number;
}

export class PaymentProxyAllocator {
  private cursor = 0;

  constructor(
    private readonly store: ProxyStore,
    private readonly usedIps: UsedIpStore,
    private readonly leases: ProxyLeaseRegistry,
    private readonly options: PaymentProxyAllocatorOptions,
  ) {}

  async acquire(sourceProxyId?: string): Promise<PaymentProxyLease> {
    const deadline = Date.now() + (this.options.maxWaitMs ?? 120_000);
    let lastError = 'Không có proxy MKTProxy phù hợp';
    for (;;) {
      const candidates = this.candidates(sourceProxyId);
      if (!candidates.length) throw new Error(lastError);
      let retryAfterMs = this.options.pollMs ?? 5_000;
      let tried = false;

      for (const record of candidates) {
        if (!this.leases.tryAcquire(record.id)) continue;
        tried = true;
        let keepLease = false;
        try {
          const rotated = await this.options.rotate(record);
          retryAfterMs = Math.max(retryAfterMs, rotated.retryAfterMs ?? 0);
          const actualIp = await this.options.verify(rotated.proxy, rotated, record);
          if (!actualIp) throw new Error(`Không xác minh được IP thực tế của proxy ${record.host}:${record.port}`);
          if (this.usedIps.has(actualIp)) {
            lastError = `IP ${actualIp} đã được dùng trước đó`;
            continue;
          }
          await this.usedIps.add(actualIp);
          keepLease = true;
          return { leaseId: record.id, proxy: rotated.proxy, egressIp: actualIp };
        } catch (error) {
          lastError = (error as Error).message;
        } finally {
          if (!keepLease) this.leases.release(record.id);
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Không lấy được IP proxy mới cho payment: ${lastError}`);
      }
      const waitMs = Math.min(
        remaining,
        Math.max(1, Math.min(retryAfterMs, 10_000)),
      );
      if (tried) await new Promise((resolve) => setTimeout(resolve, waitMs));
      else await this.leases.waitForRelease(waitMs);
    }
  }

  release(leaseId: string): void {
    this.leases.release(leaseId);
  }

  private candidates(sourceProxyId?: string): ProxyRecord[] {
    const source = sourceProxyId ? this.store.get(sourceProxyId) : undefined;
    const sourceTags = source?.tags ?? [];
    const matching = this.store.list().filter((record) => (
      record.apiProvider === 'mktproxy'
      && Boolean(record.apiKey)
      && record.alive !== false
      && (!sourceTags.length || sourceTags.every((tag) => record.tags.includes(tag)))
    ));
    if (!matching.length) return [];
    const offset = this.cursor % matching.length;
    this.cursor = (this.cursor + 1) % matching.length;
    return [...matching.slice(offset), ...matching.slice(0, offset)];
  }
}
