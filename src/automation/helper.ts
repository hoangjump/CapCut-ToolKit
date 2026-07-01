import type { Page } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

/** Default per-action timeout — flows can override per call. */
const DEFAULT_TIMEOUT = 30_000;

/** Where screenshots land. Set once by the runner before flows run. */
let shotsDir = join(process.cwd(), 'profiles-store', 'shots');
export function setShotsDir(dir: string): void {
  shotsDir = dir;
}

/**
 * Thin wrapper over a Playwright `Page` giving flows a small, uniform verb set
 * (goto/click/fill/type/waitFor/…) with a shared default timeout and gentle
 * logging. Deliberately does NOT swallow errors — a failing step throws so the
 * runner records that profile as failed and moves on (see runBatch isolation).
 */
export class PageHelper {
  constructor(
    private readonly page: Page,
    private readonly log: Logger,
    private readonly timeout = DEFAULT_TIMEOUT,
  ) {}

  /** Navigate and wait for the DOM to be ready (not full network idle — SPAs
   *  often never idle). */
  async goto(url: string): Promise<void> {
    this.log.info(`goto ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
  }

  async click(selector: string): Promise<void> {
    this.log.info(`click ${selector}`);
    await this.page.click(selector, { timeout: this.timeout });
  }

  /** Clear then set a field's value in one shot (Playwright's fill). */
  async fill(selector: string, value: string): Promise<void> {
    this.log.info(`fill ${selector}`);
    await this.page.fill(selector, value, { timeout: this.timeout });
  }

  /** Type key-by-key with an optional delay — use when a site watches for real
   *  keystrokes (fill sets the value atomically and can trip such checks). */
  async type(selector: string, value: string, delay = 40): Promise<void> {
    this.log.info(`type ${selector}`);
    await this.page.locator(selector).pressSequentially(value, { delay, timeout: this.timeout });
  }

  async press(key: string): Promise<void> {
    this.log.info(`press ${key}`);
    await this.page.keyboard.press(key);
  }

  /** Wait for an element to reach a state (default 'visible'). */
  async waitFor(selector: string, state: 'attached' | 'visible' | 'hidden' = 'visible'): Promise<void> {
    this.log.info(`waitFor ${selector} (${state})`);
    await this.page.waitForSelector(selector, { state, timeout: this.timeout });
  }

  /** True if the selector matches at least one element right now (no waiting). */
  async exists(selector: string): Promise<boolean> {
    return (await this.page.locator(selector).count()) > 0;
  }

  /** Trimmed text content of the first match. */
  async text(selector: string): Promise<string> {
    const t = await this.page.locator(selector).first().textContent({ timeout: this.timeout });
    return (t ?? '').trim();
  }

  async sleep(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Full-page screenshot into <shotsDir>/<name>-<ts>.png. Returns the path. */
  async screenshot(name = 'shot'): Promise<string> {
    await mkdir(shotsDir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_');
    const path = join(shotsDir, `${safe}-${Date.now()}.png`);
    await this.page.screenshot({ path, fullPage: true });
    this.log.info(`screenshot ${path}`);
    return path;
  }
}
