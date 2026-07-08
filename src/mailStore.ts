import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MailRecord } from './types.js';

export interface CreateMailInput {
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
  provider?: string;
  tags?: string[];
  note?: string;
  orderCode?: string;
}

/** "email|password|refresh_token|client_id" (dạng list_data của /user/buy) →
 *  input. password có thể trống. Ném lỗi nếu thiếu email/refresh/client. */
export function parseMailLine(line: string): CreateMailInput {
  const parts = line.trim().split('|');
  const [email, password, refreshToken, clientId] = parts;
  if (!email || !refreshToken || !clientId) {
    throw new Error(`Định dạng mail không hợp lệ (cần email|password|refresh_token|client_id): "${line}"`);
  }
  return {
    email: email.trim(),
    password: password?.trim() || undefined,
    refreshToken: refreshToken.trim(),
    clientId: clientId.trim(),
    provider: providerFromEmail(email),
  };
}

/** Suy provider từ domain của địa chỉ mail, ví dụ "hotmail"/"outlook". */
export function providerFromEmail(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).toLowerCase();
  const host = domain.split('.')[0];
  return host || undefined;
}

/** Lưu kho mail trong một file JSON duy nhất — clone pattern của ProxyStore. */
export class MailStore {
  private readonly file: string;
  private mails = new Map<string, MailRecord>();

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.file = join(root, 'mails.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, 'utf8');
      const list = JSON.parse(raw) as MailRecord[];
      this.mails = new Map(list.map((m) => [m.id, m]));
    }
  }

  list(): MailRecord[] {
    return [...this.mails.values()].sort((a, b) => b.boughtAt.localeCompare(a.boughtAt));
  }

  get(id: string): MailRecord | undefined {
    return this.mails.get(id);
  }

  async create(input: CreateMailInput): Promise<MailRecord> {
    const record: MailRecord = {
      id: randomUUID(),
      email: input.email,
      password: input.password,
      refreshToken: input.refreshToken,
      clientId: input.clientId,
      provider: input.provider ?? providerFromEmail(input.email),
      tags: input.tags ?? [],
      note: input.note,
      orderCode: input.orderCode,
      boughtAt: new Date().toISOString(),
    };
    this.mails.set(record.id, record);
    await this.persist();
    return record;
  }

  /** Nạp cả lô (dùng cho kết quả /user/buy). Bỏ qua dòng trùng email đã có. */
  async createMany(inputs: CreateMailInput[]): Promise<MailRecord[]> {
    const existingEmails = new Set([...this.mails.values()].map((m) => m.email.toLowerCase()));
    const created: MailRecord[] = [];
    for (const input of inputs) {
      if (existingEmails.has(input.email.toLowerCase())) continue;
      const record: MailRecord = {
        id: randomUUID(),
        email: input.email,
        password: input.password,
        refreshToken: input.refreshToken,
        clientId: input.clientId,
        provider: input.provider ?? providerFromEmail(input.email),
        tags: input.tags ?? [],
        note: input.note,
        orderCode: input.orderCode,
        boughtAt: new Date().toISOString(),
      };
      this.mails.set(record.id, record);
      existingEmails.add(record.email.toLowerCase());
      created.push(record);
    }
    if (created.length) await this.persist();
    return created;
  }

  async update(id: string, patch: Partial<Omit<MailRecord, 'id' | 'boughtAt'>>): Promise<MailRecord> {
    const existing = this.mails.get(id);
    if (!existing) throw new Error(`Mail not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.mails.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!this.mails.delete(id)) throw new Error(`Mail not found: ${id}`);
    await this.persist();
  }

  /** Xóa nhiều mail theo id (bỏ qua id không tồn tại). Trả số đã xóa. */
  async deleteMany(ids: string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) if (this.mails.delete(id)) removed += 1;
    if (removed) await this.persist();
    return removed;
  }

  /** Xóa sạch kho mail. Trả số đã xóa. */
  async clear(): Promise<number> {
    const count = this.mails.size;
    if (!count) return 0;
    this.mails.clear();
    await this.persist();
    return count;
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.list(), null, 2), 'utf8');
  }
}
