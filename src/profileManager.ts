import { randomUUID, randomInt } from 'node:crypto';
import { writeJsonAtomic } from './atomicJson.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile, ProxyConfig, ProxyRotation, AntiDetectConfig, BrowserSettings } from './types.js';
import { defaultAntiDetect, defaultBrowserSettings } from './types.js';

export interface CreateProfileInput {
  name: string;
  group?: string;
  taskbarTitle?: string;
  proxy?: ProxyConfig;
  proxyRotation?: ProxyRotation;
  antiDetect?: AntiDetectConfig;
  browser?: BrowserSettings;
  notes?: string;
}

/**
 * Stores profile metadata in a single JSON file and owns the on-disk layout:
 *   <root>/profiles.json        — metadata for every profile
 *   <root>/data/<profileId>/    — Chromium userDataDir (cookies, localStorage, …)
 */
export class ProfileManager {
  private readonly root: string;
  private readonly metaFile: string;
  private readonly dataDir: string;
  private profiles = new Map<string, Profile>();

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.root = root;
    this.metaFile = join(root, 'profiles.json');
    this.dataDir = join(root, 'data');
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    if (existsSync(this.metaFile)) {
      const raw = await readFile(this.metaFile, 'utf8');
      const list = JSON.parse(raw) as Profile[];
      this.profiles = new Map(list.map((p) => [p.id, p]));
    }
  }

  /** Absolute path to the Chromium userDataDir for a profile. */
  userDataDir(id: string): string {
    return join(this.dataDir, id);
  }

  list(): Profile[] {
    return [...this.profiles.values()];
  }

  get(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  async create(input: CreateProfileInput): Promise<Profile> {
    const profile: Profile = {
      id: randomUUID(),
      name: input.name,
      group: input.group,
      taskbarTitle: input.taskbarTitle,
      proxy: input.proxy,
      proxyRotation: input.proxyRotation,
      antiDetect: input.antiDetect ?? defaultAntiDetect(),
      browser: input.browser ?? defaultBrowserSettings(),
      seed: randomInt(0, 2 ** 31),
      createdAt: new Date().toISOString(),
      notes: input.notes,
    };
    this.profiles.set(profile.id, profile);
    await mkdir(this.userDataDir(profile.id), { recursive: true });
    await this.persist();
    return profile;
  }

  async update(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt'>>): Promise<Profile> {
    const existing = this.profiles.get(id);
    if (!existing) throw new Error(`Profile not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.profiles.set(id, updated);
    await this.persist();
    return updated;
  }

  /** Removes profile metadata and, optionally, its persisted browser data. */
  async delete(id: string, opts: { wipeData?: boolean } = {}): Promise<void> {
    if (!this.profiles.delete(id)) throw new Error(`Profile not found: ${id}`);
    if (opts.wipeData) {
      await rm(this.userDataDir(id), { recursive: true, force: true });
    }
    await this.persist();
  }

  /** Removes ALL profiles at once. Returns how many were deleted. Caller must
   *  close any open browser contexts first (ProfileManager doesn't own them). */
  async deleteAll(opts: { wipeData?: boolean } = {}): Promise<number> {
    const ids = [...this.profiles.keys()];
    this.profiles.clear();
    if (opts.wipeData) {
      for (const id of ids) {
        await rm(this.userDataDir(id), { recursive: true, force: true });
      }
    }
    await this.persist();
    return ids.length;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.metaFile, this.list());
  }
}
