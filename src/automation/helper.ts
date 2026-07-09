import type { Page } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

/** Default per-action timeout — flows can override per call. */
const DEFAULT_TIMEOUT = 30_000;

/** True khi chạy trên Windows. Cú lướt chuột (moveMouseTo) tách theo nền tảng:
 *  mỗi bước là một page.mouse.move → trên Win bắt vẽ lại con trỏ, máy vẽ chậm
 *  nên nhiều bước = lướt lê thê; Mac compositor phần cứng nhanh nên không thấy.
 *  Win dùng ít bước (nhanh), Mac giữ nhiều bước (mượt, cong tự nhiên hơn). */
const IS_WINDOWS = process.platform === 'win32';
const GLIDE_STEPS_MIN = IS_WINDOWS ? 8 : 18;
const GLIDE_STEPS_MAX = IS_WINDOWS ? 12 : 26;
const GLIDE_WAIT_MIN = IS_WINDOWS ? 4 : 6;
const GLIDE_WAIT_MAX = IS_WINDOWS ? 10 : 18;

/** Human-like pause before each interactive step. Random in [PACE_MIN, PACE_MAX]
 *  ms — override via env (or set PACE_MAX_MS=0 to disable for fast debugging). */
const PACE_MIN_MS = Number(process.env.PACE_MIN_MS ?? 1_000);
const PACE_MAX_MS = Number(process.env.PACE_MAX_MS ?? 3_000);

/** Where screenshots land. Set once by the runner before flows run. */
let shotsDir = join(process.cwd(), 'profiles-store', 'shots');
export function setShotsDir(dir: string): void {
  shotsDir = dir;
}

/** Random integer in [min, max]. */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random float in [min, max). */
function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Thin wrapper over a Playwright `Page` giving flows a small, uniform verb set
 * (goto/click/fill/type/waitFor/…) with a shared default timeout and gentle
 * logging. Deliberately does NOT swallow errors — a failing step throws so the
 * runner records that profile as failed and moves on (see runBatch isolation).
 */
export class PageHelper {
  /** Last known cursor position — so each move starts where the previous ended
   *  (a real cursor doesn't teleport back to 0,0 between actions). */
  private cursor = { x: 0, y: 0 };
  private mouseMoveBroken = false;

  constructor(
    private readonly page: Page,
    private readonly log: Logger,
    private readonly timeout = DEFAULT_TIMEOUT,
  ) {}

  /** Human-like idle pause before an interactive step. Random in the configured
   *  [PACE_MIN, PACE_MAX] window; skipped entirely when PACE_MAX_MS is 0. Public
   *  so flows can pace manually before a Promise.all that can't tolerate a paced
   *  click (see capcut step 12). */
  async pace(): Promise<void> {
    if (PACE_MAX_MS <= 0) return;
    const lo = Math.min(PACE_MIN_MS, PACE_MAX_MS);
    const hi = Math.max(PACE_MIN_MS, PACE_MAX_MS);
    const ms = randInt(lo, hi);
    this.log.info(`pace ${(ms / 1000).toFixed(1)}s`);
    await this.page.waitForTimeout(ms);
  }

  /** Glide the virtual cursor from its last position to a random point inside
   *  the target element, following a cubic Bézier curve in ~20 small steps so
   *  the motion looks hand-driven rather than a teleport. Leaves the cursor
   *  hovering over that point; callers click right after. No-op-safe: if the box
   *  can't be measured it just moves to the element's center via Playwright. */
  private async moveMouseTo(selector: string): Promise<void> {
    if (this.mouseMoveBroken) return;

    const box = await this.page.locator(selector).first()
      .boundingBox({ timeout: this.timeout })
      .catch(() => null);
    if (!box) return;

    // Aim for a random point in the middle 60% of the element (avoid the edges).
    const target = {
      x: box.x + randFloat(0.2, 0.8) * box.width,
      y: box.y + randFloat(0.2, 0.8) * box.height,
    };
    try {
      if (IS_WINDOWS) {
        // Camoufox `humanize` (bật ở browserManager) TỰ vẽ đường cong người cho
        // MỖI page.mouse.move ở tầng C++. Nên trên Win chỉ di 1 CÚ tới đích →
        // engine animate đúng 1 quỹ đạo (≤0.5s). Trước đây lướt 8-12 bước, mỗi
        // bước lại bị engine animate = CHỒNG LỚP → con trỏ "di mãi", khựng khi
        // máy vẽ chậm. Bỏ hẳn vòng lặp trên Win, giao đường cong cho Camoufox.
        await this.page.mouse.move(target.x, target.y);
      } else {
        // Mac (giữ nguyên — đang mượt): Bézier nhiều bước tự vẽ đường cong.
        const start = this.cursor;
        const c1 = { x: randFloat(start.x, target.x), y: randFloat(start.y, target.y) };
        const c2 = { x: randFloat(start.x, target.x), y: randFloat(start.y, target.y) };
        const steps = randInt(GLIDE_STEPS_MIN, GLIDE_STEPS_MAX);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          // Cubic Bézier: (1-t)^3·P0 + 3(1-t)^2·t·C1 + 3(1-t)·t^2·C2 + t^3·P1
          const x = u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * target.x;
          const y = u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * target.y;
          await this.page.mouse.move(x, y);
          await this.page.waitForTimeout(randInt(GLIDE_WAIT_MIN, GLIDE_WAIT_MAX));
        }
      }
      this.cursor = target;
    } catch (err) {
      this.mouseMoveBroken = true;
      this.log.warn(`mouse glide bỏ qua: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  private async domClick(selector: string): Promise<void> {
    await this.page.locator(selector).first().evaluate((node: any) => {
      const target = node.closest?.('button,[role="button"],a,label,input,textarea,select,[tabindex]') ?? node;
      const win = (globalThis as any).window;
      const Pointer = (globalThis as any).PointerEvent ?? (globalThis as any).MouseEvent;
      const pointerInit = { bubbles: true, cancelable: true, view: win, pointerType: 'mouse', button: 0 };
      const mouseInit = { bubbles: true, cancelable: true, view: win, button: 0 };
      for (const type of ['pointerdown', 'pointerup']) {
        target.dispatchEvent(new Pointer(type, pointerInit));
      }
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new (globalThis as any).MouseEvent(type, mouseInit));
      }
    });
  }

  private async clickTarget(selector: string, timeout = this.timeout): Promise<void> {
    // page.click() tạo sự kiện chuột TRUSTED ở tầng protocol — độc lập hoàn toàn
    // với hiệu ứng lướt chuột (moveMouseTo). Nên dù glide hỏng (mouseMoveBroken),
    // VẪN thử native click trước: giữ isTrusted=true. domClick (dispatchEvent →
    // isTrusted=false) là lối thoát CUỐI, chỉ dùng khi native click thật sự throw
    // — vì click synthetic vừa lộ bot vừa bị dropdown lv-select của CapCut từ chối.
    try {
      await this.page.click(selector, { timeout });
    } catch (err) {
      this.log.warn(`native click fallback (synthetic, untrusted): ${(err as Error).message.split('\n')[0]}`);
      await this.domClick(selector);
    }
  }

  /** Navigate and wait for the DOM to be ready (not full network idle — SPAs
   *  often never idle). */
  async goto(url: string): Promise<void> {
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.log.info(`goto ${url}${attempt > 1 ? ` (retry ${attempt}/${attempts})` : ''}`);
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
        return;
      } catch (err) {
        const msg = (err as Error).message;
        const retryable = /NS_ERROR_ABORT|ERR_ABORTED/i.test(msg);
        if (!retryable || attempt === attempts || this.page.isClosed()) throw err;
        this.log.warn(`goto aborted, retrying: ${msg.split('\n')[0]}`);
        await this.page.waitForTimeout(1_500 * attempt);
      }
    }
  }

  /** Human-paced click: idle pause → glide cursor to the element → click. Pass
   *  `{ pace: false }` to skip the idle pause (needed when the click is wrapped
   *  in a Promise.all that races a 'page'/popup event — a 5-10s pause would blow
   *  the event's timeout). The mouse glide still runs either way. */
  async click(selector: string, opts: { pace?: boolean } = {}): Promise<void> {
    if (opts.pace !== false) await this.pace();
    this.log.info(`click ${selector}`);
    await this.moveMouseTo(selector);
    await this.clickTarget(selector);
  }

  /** Clear then set a field's value in one shot (Playwright's fill). */
  async fill(selector: string, value: string): Promise<void> {
    await this.pace();
    this.log.info(`fill ${selector}`);
    await this.moveMouseTo(selector);
    await this.page.fill(selector, value, { timeout: this.timeout });
  }

  /** Type key-by-key with an optional delay — use when a site watches for real
   *  keystrokes (fill sets the value atomically and can trip such checks). */
  async type(selector: string, value: string, delay = 40): Promise<void> {
    await this.pace();
    this.log.info(`type ${selector}`);
    await this.moveMouseTo(selector);
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

  /** Value of an attribute on the first match (null if absent). */
  async attr(selector: string, name: string): Promise<string | null> {
    return this.page.locator(selector).first().getAttribute(name, { timeout: this.timeout });
  }

  /** Pick an option in a <select> — by value, label, or index (Playwright's
   *  selectOption accepts {value}/{label}/{index} or a raw value string). */
  async select(selector: string, value: string): Promise<void> {
    this.log.info(`select ${selector} = ${value}`);
    await this.page.selectOption(selector, value, { timeout: this.timeout });
  }

  /** Tick a checkbox/radio (no-op if already checked). */
  async check(selector: string): Promise<void> {
    this.log.info(`check ${selector}`);
    await this.page.check(selector, { timeout: this.timeout });
  }

  /** Untick a checkbox (no-op if already unchecked). */
  async uncheck(selector: string): Promise<void> {
    this.log.info(`uncheck ${selector}`);
    await this.page.uncheck(selector, { timeout: this.timeout });
  }

  /** Hover over an element (menus/tooltips that reveal on hover). */
  async hover(selector: string): Promise<void> {
    await this.pace();
    this.log.info(`hover ${selector}`);
    await this.moveMouseTo(selector);
    await this.page.hover(selector, { timeout: this.timeout });
  }

  /** Click only if the selector is present right now — handy for optional
   *  cookie/consent banners that may or may not appear. Returns whether it clicked. */
  async clickIfExists(selector: string): Promise<boolean> {
    if (!(await this.exists(selector))) return false;
    await this.pace();
    this.log.info(`clickIfExists ${selector}`);
    await this.moveMouseTo(selector);
    await this.clickTarget(selector);
    return true;
  }

  /** Wait until the page URL matches a substring or regex (post-submit redirect,
   *  SPA route change). */
  async waitForUrl(match: string | RegExp): Promise<void> {
    this.log.info(`waitForUrl ${match}`);
    const pred = typeof match === 'string'
      ? (url: URL) => url.href.includes(match)
      : (url: URL) => match.test(url.href);
    await this.page.waitForURL(pred, { timeout: this.timeout });
  }

  /** Wait until an element contains the given text (case-sensitive substring). */
  async waitForText(selector: string, text: string): Promise<void> {
    this.log.info(`waitForText ${selector} ~ ${text}`);
    await this.page.locator(selector, { hasText: text }).first()
      .waitFor({ state: 'visible', timeout: this.timeout });
  }

  /** How many elements the selector matches right now (no waiting). */
  async count(selector: string): Promise<number> {
    return this.page.locator(selector).count();
  }

  /** Type a string key-by-key at the keyboard level (not into a specific
   *  selector) — for split OTP inputs where each digit lands in its own box and
   *  focus auto-advances. Click/focus the first box first, then call this. */
  async typeKeys(value: string, delay = 120): Promise<void> {
    this.log.info(`typeKeys ${value.length} ký tự`);
    await this.page.keyboard.type(value, { delay });
  }

  /** Click something that opens a new tab/window and return the popup Page,
   *  already loaded. Used to catch the pipopay checkout window. Throws if no
   *  popup appears within the timeout. */
  async clickAndExpectPopup(selector: string): Promise<Page> {
    this.log.info(`clickAndExpectPopup ${selector}`);
    const [popup] = await Promise.all([
      this.page.context().waitForEvent('page', { timeout: this.timeout }),
      this.clickTarget(selector),
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: this.timeout }).catch(() => {});
    this.log.info(`popup mở: ${popup.url()}`);
    return popup;
  }

  async sleep(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Full-page screenshot into <shotsDir>/<name>-<ts>.png. Returns the path. */
  async screenshot(name = 'shot'): Promise<string> {
    const path = await snapshotPage(this.page, name);
    this.log.info(`screenshot ${path}`);
    return path;
  }
}

/** Full-page screenshot of ANY page (e.g. a popup tab the helper doesn't wrap)
 *  into <shotsDir>/<name>-<ts>.png. Returns the path. */
export async function snapshotPage(page: Page, name = 'shot'): Promise<string> {
  await mkdir(shotsDir, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const path = join(shotsDir, `${safe}-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
