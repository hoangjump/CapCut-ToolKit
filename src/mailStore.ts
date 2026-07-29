import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomicJson.js';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MailRecord, MailSource, MailStatus } from './types.js';

export interface CreateMailInput {
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
  provider?: string;
  tags?: string[];
  note?: string;
  orderCode?: string;
  status?: MailStatus;
  source?: MailSource;
  reservedByProfileId?: string;
}

const MAIL_STATUSES = new Set<MailStatus>(['unchecked', 'available', 'reserved', 'used', 'failed', 'disabled']);

function normalizeMail(record: MailRecord): MailRecord {
  return {
    ...record,
    tags: Array.isArray(record.tags) ? record.tags : [],
    status: MAIL_STATUSES.has(record.status) ? record.status : 'unchecked',
    source: record.source ?? 'manual',
  };
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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.file = join(root, 'mails.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, 'utf8');
      const list = JSON.parse(raw) as MailRecord[];
      const normalized = list.map(normalizeMail);
      this.mails = new Map(normalized.map((m) => [m.id, m]));
      if (normalized.some((mail, index) => mail.status !== list[index].status || mail.source !== list[index].source)) {
        await this.persist();
      }
    }
  }

  list(): MailRecord[] {
    return [...this.mails.values()].sort((a, b) => b.boughtAt.localeCompare(a.boughtAt));
  }

  get(id: string): MailRecord | undefined {
    return this.mails.get(id);
  }

  async create(input: CreateMailInput): Promise<MailRecord> {
    const email = input.email.trim();
    if ([...this.mails.values()].some((mail) => mail.email.toLowerCase() === email.toLowerCase())) {
      throw new Error(`Mail đã tồn tại trong kho: ${email}`);
    }
    const record: MailRecord = {
      id: randomUUID(),
      email,
      password: input.password,
      refreshToken: input.refreshToken,
      clientId: input.clientId,
      provider: input.provider ?? providerFromEmail(input.email),
      tags: input.tags ?? [],
      note: input.note,
      orderCode: input.orderCode,
      status: input.status ?? 'unchecked',
      source: input.source ?? 'manual',
      reservedByProfileId: input.reservedByProfileId,
      reservedAt: input.status === 'reserved' ? new Date().toISOString() : undefined,
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
        status: input.status ?? 'unchecked',
        source: input.source ?? 'manual',
        reservedByProfileId: input.reservedByProfileId,
        reservedAt: input.status === 'reserved' ? new Date().toISOString() : undefined,
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

  async updateStatus(ids: string[], status: Exclude<MailStatus, 'reserved'>): Promise<number> {
    const targets = [...new Set(ids)]
      .map((id) => this.mails.get(id))
      .filter((mail): mail is MailRecord => Boolean(mail));
    const reserved = targets.find((mail) => mail.status === 'reserved');
    if (reserved) {
      throw new Error(`Mail ${reserved.email} đang được giữ bởi một profile, chưa thể đổi trạng thái`);
    }

    const now = new Date().toISOString();
    let updated = 0;
    for (const mail of targets) {
      mail.status = status;
      mail.reservedByProfileId = undefined;
      mail.reservedAt = undefined;
      if (status === 'available') {
        mail.usedAt = undefined;
        mail.lastError = undefined;
      } else if (status === 'used') {
        mail.usedAt = now;
      }
      updated += 1;
    }
    if (updated) await this.persist();
    return updated;
  }

  async markChecked(id: string, error?: string): Promise<MailRecord> {
    await this.markCheckResults([{ id, error }]);
    const mail = this.mails.get(id);
    if (!mail) throw new Error(`Mail not found: ${id}`);
    return mail;
  }

  async markCheckResults(results: Array<{ id: string; error?: string }>): Promise<void> {
    const now = new Date().toISOString();
    let changed = false;
    for (const result of results) {
      const mail = this.mails.get(result.id);
      if (!mail) continue;
      mail.lastCheckedAt = now;
      mail.lastError = result.error;
      if (mail.status !== 'used' && mail.status !== 'reserved' && mail.status !== 'disabled') {
        mail.status = result.error ? 'failed' : 'available';
      }
      changed = true;
    }
    if (changed) await this.persist();
  }

  /** Reserve one available mailbox synchronously before persisting, so concurrent
   * profile workers cannot observe and acquire the same record. */
  async reserveAvailable(input: { profileId: string; tags?: string[] }): Promise<MailRecord | undefined> {
    const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
    const selected = [...this.mails.values()]
      .filter((mail) => mail.status === 'available' && tags.every((tag) => mail.tags.includes(tag)))
      .sort((a, b) => a.boughtAt.localeCompare(b.boughtAt))[0];
    if (!selected) return undefined;
    selected.status = 'reserved';
    selected.reservedByProfileId = input.profileId;
    selected.reservedAt = new Date().toISOString();
    selected.lastError = undefined;
    await this.persist();
    return selected;
  }

  async markUsed(id: string): Promise<MailRecord> {
    const mail = this.mails.get(id);
    if (!mail) throw new Error(`Mail not found: ${id}`);
    mail.status = 'used';
    mail.usedAt = new Date().toISOString();
    mail.reservedByProfileId = undefined;
    mail.reservedAt = undefined;
    mail.lastError = undefined;
    await this.persist();
    return mail;
  }

  async markFailed(id: string, error: string): Promise<MailRecord> {
    const mail = this.mails.get(id);
    if (!mail) throw new Error(`Mail not found: ${id}`);
    mail.status = 'failed';
    mail.lastError = error;
    mail.reservedByProfileId = undefined;
    mail.reservedAt = undefined;
    await this.persist();
    return mail;
  }

  async delete(id: string): Promise<void> {
    const mail = this.mails.get(id);
    if (!mail) throw new Error(`Mail not found: ${id}`);
    if (mail.status === 'reserved') {
      throw new Error(`Mail ${mail.email} đang được giữ bởi một profile, chưa thể xóa`);
    }
    this.mails.delete(id);
    await this.persist();
  }

  /** Xóa nhiều mail theo id (bỏ qua id không tồn tại). Trả số đã xóa. */
  async deleteMany(ids: string[]): Promise<number> {
    const targets = [...new Set(ids)]
      .map((id) => this.mails.get(id))
      .filter((mail): mail is MailRecord => Boolean(mail));
    const reserved = targets.find((mail) => mail.status === 'reserved');
    if (reserved) {
      throw new Error(`Mail ${reserved.email} đang được giữ bởi một profile, chưa thể xóa`);
    }

    let removed = 0;
    for (const mail of targets) if (this.mails.delete(mail.id)) removed += 1;
    if (removed) await this.persist();
    return removed;
  }

  /** Xóa sạch kho mail. Trả số đã xóa. */
  async clear(): Promise<number> {
    const count = this.mails.size;
    if (!count) return 0;
    const reserved = [...this.mails.values()].find((mail) => mail.status === 'reserved');
    if (reserved) {
      throw new Error(`Mail ${reserved.email} đang được giữ bởi một profile, chưa thể xóa sạch kho`);
    }
    this.mails.clear();
    await this.persist();
    return count;
  }

  private async persist(): Promise<void> {
    const snapshot = this.list();
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => writeJsonAtomic(this.file, snapshot));
    await this.writeQueue;
  }
}
