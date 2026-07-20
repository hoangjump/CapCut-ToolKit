import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TelegramWorkState } from './types.js';

function emptyState(): TelegramWorkState {
  return {
    version: 1,
    pollingOffset: 0,
    employees: [],
    tasks: [],
    earnings: [],
    processedUpdates: [],
  };
}

/**
 * Single-process transactional store. Every mutation is queued and persisted
 * before the next one starts, so simultaneous webhook events cannot double-pay
 * a task or overwrite each other's state.
 */
export class TelegramWorkStore {
  private readonly file: string;
  private state: TelegramWorkState = emptyState();
  private tail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.file = join(root, 'telegram-work.json');
  }

  async init(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    if (!existsSync(this.file)) return;
    const raw = await readFile(this.file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelegramWorkState>;
    this.state = {
      ...emptyState(),
      ...parsed,
      employees: parsed.employees ?? [],
      tasks: parsed.tasks ?? [],
      earnings: parsed.earnings ?? [],
      processedUpdates: parsed.processedUpdates ?? [],
    };
  }

  snapshot(): TelegramWorkState {
    return structuredClone(this.state);
  }

  async mutate<T>(fn: (draft: TelegramWorkState) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      await this.persist(draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(state: TelegramWorkState): Promise<void> {
    const data = JSON.stringify(state, null, 2);
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, data, 'utf8');
    try {
      await rename(temp, this.file);
    } catch {
      // Some Windows filesystems do not replace an existing destination atomically.
      await writeFile(this.file, data, 'utf8');
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}
