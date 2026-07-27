export class ProxyLeaseRegistry {
  private readonly leased = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  isLeased(id: string): boolean {
    return this.leased.has(id);
  }

  tryAcquire(id: string): boolean {
    if (this.leased.has(id)) return false;
    this.leased.add(id);
    return true;
  }

  release(id: string | undefined): void {
    if (!id || !this.leased.delete(id)) return;
    this.waiters.shift()?.();
  }

  waitForRelease(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, timeoutMs);
      this.waiters.push(wake);
    });
  }
}
