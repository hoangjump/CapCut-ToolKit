import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from './types.js';

/** Mask an API key for display — keep the first/last few chars, hide the rest.
 *  "3645879248967a36" → "3645…7a36". Empty/short keys collapse to "•••". */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** App-level settings persisted to a single JSON file. Currently only holds the
 *  dongvanfb API key (a real-money secret) — kept local, returned to UI masked. */
export class SettingsStore {
  private readonly file: string;
  private settings: AppSettings = {};

  constructor(root = join(process.cwd(), 'profiles-store')) {
    this.file = join(root, 'settings.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, 'utf8');
      this.settings = JSON.parse(raw) as AppSettings;
    }
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  getApiKey(): string | undefined {
    return this.settings.dongvanfbApiKey;
  }

  async setApiKey(key: string | undefined): Promise<void> {
    this.settings.dongvanfbApiKey = key?.trim() || undefined;
    await this.persist();
  }

  getSheetWebhookUrl(): string | undefined {
    return this.settings.sheetWebhookUrl;
  }

  async setSheetWebhookUrl(url: string | undefined): Promise<void> {
    this.settings.sheetWebhookUrl = url?.trim() || undefined;
    await this.persist();
  }

  getMktproxyKey(): string | undefined {
    return this.settings.mktproxyApiKey;
  }

  async setMktproxyKey(key: string | undefined): Promise<void> {
    this.settings.mktproxyApiKey = key?.trim() || undefined;
    await this.persist();
  }

  getTelegramBotToken(): string | undefined {
    return this.settings.telegramBotToken;
  }

  async setTelegramBotToken(token: string | undefined): Promise<void> {
    this.settings.telegramBotToken = token?.trim() || undefined;
    await this.persist();
  }

  getTelegramChatId(): string | undefined {
    return this.settings.telegramChatId;
  }

  async setTelegramChatId(id: string | undefined): Promise<void> {
    this.settings.telegramChatId = id?.trim() || undefined;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
  }
}
