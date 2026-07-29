import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomicJson.js';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ProxyType = 'http' | 'https' | 'socks5';

export interface ProxyRecord {
  id: string;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tags: string[];
  /** null = chưa kiểm tra; true = Live; false = Dead. */
  alive: boolean | null;
  /** ms latency của lần check gần nhất, nếu Live. */
  latencyMs?: number;
  checkedAt?: string;
  createdAt: string;
  /** Proxy dạng API (vd mktproxy xoay): host/port là ảnh chụp gần nhất; IP thật
   *  lấy/động qua API bằng `apiKey` (key đơn hàng). Khi có, nút Test sẽ resolve
   *  lại IP hiện tại trước khi check. Vắng = proxy tĩnh thường. */
  apiProvider?: 'mktproxy';
  /** Key đơn hàng proxy xoay (dùng cho /proxies/new, /rotate-ip). Bí mật. */
  apiKey?: string;
}

export interface CreateProxyInput {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tags?: string[];
  apiProvider?: 'mktproxy';
  apiKey?: string;
}

/** "host:port:user:pass" hoặc "host:port" → các phần. user/pass optional. */
export function parseProxyLine(line: string): Omit<CreateProxyInput, 'type' | 'tags'> {
  const parts = line.trim().split(':');
  if (parts.length < 2) throw new Error(`Định dạng proxy không hợp lệ: "${line}"`);
  const [host, portRaw, username, password] = parts;
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Host/port không hợp lệ: "${line}"`);
  }
  return { host, port, username: username || undefined, password: password || undefined };
}

/** Trả về URL dạng "socks5://user:pass@host:port" để dùng cho agent / Playwright. */
export function proxyUrl(p: ProxyRecord): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@` : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

/** Chuỗi hiển thị "host:port:user:pass" giống bảng quản lý. */
export function proxyDisplay(p: ProxyRecord): string {
  const tail = p.username ? `:${p.username}:${p.password ?? ''}` : '';
  return `${p.host}:${p.port}${tail}`;
}

/** Lưu danh sách proxy trong một file JSON duy nhất. */
export class ProxyStore {
  private readonly file: string;
  private proxies = new Map<string, ProxyRecord>();

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.file = join(root, 'proxies.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, 'utf8');
      const list = JSON.parse(raw) as ProxyRecord[];
      this.proxies = new Map(list.map((p) => [p.id, p]));
    }
  }

  list(): ProxyRecord[] {
    return [...this.proxies.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ProxyRecord | undefined {
    return this.proxies.get(id);
  }

  async create(input: CreateProxyInput): Promise<ProxyRecord> {
    const record: ProxyRecord = {
      id: randomUUID(),
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
      tags: input.tags ?? [],
      alive: null,
      createdAt: new Date().toISOString(),
      apiProvider: input.apiProvider,
      apiKey: input.apiKey,
    };
    this.proxies.set(record.id, record);
    await this.persist();
    return record;
  }

  async update(id: string, patch: Partial<Omit<ProxyRecord, 'id' | 'createdAt'>>): Promise<ProxyRecord> {
    const existing = this.proxies.get(id);
    if (!existing) throw new Error(`Proxy not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.proxies.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!this.proxies.delete(id)) throw new Error(`Proxy not found: ${id}`);
    await this.persist();
  }

  /** Xóa nhiều proxy theo id (bỏ qua id không tồn tại). Trả số đã xóa. */
  async deleteMany(ids: string[]): Promise<number> {
    let removed = 0;
    for (const id of new Set(ids)) if (this.proxies.delete(id)) removed += 1;
    if (removed) await this.persist();
    return removed;
  }

  /** Xóa sạch kho proxy. Trả số đã xóa. */
  async clear(): Promise<number> {
    const count = this.proxies.size;
    if (!count) return 0;
    this.proxies.clear();
    await this.persist();
    return count;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.list());
  }
}
