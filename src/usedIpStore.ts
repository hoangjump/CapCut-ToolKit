import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lưu các egress IP (real_ip) đã dùng để đăng ký CapCut. Mục đích: mỗi IP chỉ
 * reg 1 lần — khi rút proxy xoay cho một profile đăng ký, ta xoay tới khi ra IP
 * CHƯA có trong đây rồi mới dùng, tránh nhiều account cùng IP (dễ bị cờ).
 * Persist một mảng JSON trong STORE_ROOT.
 */
export class UsedIpStore {
  private readonly file: string;
  private ips = new Set<string>();

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.file = join(root, 'used-ips.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (existsSync(this.file)) {
      try {
        const raw = await readFile(this.file, 'utf8');
        const list = JSON.parse(raw) as string[];
        if (Array.isArray(list)) this.ips = new Set(list.filter((x) => typeof x === 'string'));
      } catch {
        this.ips = new Set();
      }
    }
  }

  has(ip: string): boolean {
    return this.ips.has(ip);
  }

  count(): number {
    return this.ips.size;
  }

  async add(ip: string | undefined): Promise<void> {
    if (!ip || this.ips.has(ip)) return;
    this.ips.add(ip);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify([...this.ips], null, 2), 'utf8');
  }
}
