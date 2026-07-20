import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectRecord, ProxyPoolFilter } from './types.js';

export interface CreateProjectInput {
  name: string;
  flowName: string;
  profileIds?: string[];
  mailId?: string;
  mailProvider?: 'dongvanfb' | 'selltaikhoan';
  buyAccountType?: string;
  buyQuality?: string;
  buyProductId?: string;
  smsbowerService?: string;
  concurrency?: number;
  ephemeralCount?: number;
  ephemeralProxyPool?: ProxyPoolFilter;
  blockImages?: boolean;
  telegramDistribution?: ProjectRecord['telegramDistribution'];
  note?: string;
}

/** Lưu danh sách project (automation job) trong một file JSON — clone pattern
 *  của ProxyStore. Mỗi project chỉ trỏ tên flow + danh sách profile để chạy. */
export class ProjectStore {
  private readonly file: string;
  private projects = new Map<string, ProjectRecord>();

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.file = join(root, 'projects.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, 'utf8');
      const list = JSON.parse(raw) as ProjectRecord[];
      this.projects = new Map(list.map((p) => [p.id, p]));
    }
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ProjectRecord | undefined {
    return this.projects.get(id);
  }

  async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      flowName: input.flowName,
      profileIds: input.profileIds ?? [],
      mailId: input.mailId,
      mailProvider: input.mailProvider,
      buyAccountType: input.buyAccountType,
      buyQuality: input.buyQuality,
      buyProductId: input.buyProductId,
      smsbowerService: input.smsbowerService,
      concurrency: input.concurrency,
      ephemeralCount: input.ephemeralCount,
      ephemeralProxyPool: input.ephemeralProxyPool,
      blockImages: input.blockImages,
      telegramDistribution: input.telegramDistribution,
      note: input.note,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(record.id, record);
    await this.persist();
    return record;
  }

  async update(id: string, patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt'>>): Promise<ProjectRecord> {
    const existing = this.projects.get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.projects.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!this.projects.delete(id)) throw new Error(`Project not found: ${id}`);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.list(), null, 2), 'utf8');
  }
}
