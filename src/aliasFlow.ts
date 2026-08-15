import type { Page } from 'playwright-core';
import type { Logger } from './logger.js';

/**
 * TẠO ALIAS OUTLOOK cho một tài khoản Microsoft cá nhân.
 *
 * Cách làm bám sát console script đã tạo alias THẬT (aliashub-alias-console.js):
 * điền `#AssociatedIdLive` qua native setter (React/Fluent bỏ qua .value gán
 * thẳng), chọn domain @outlook.com, bấm `#SubmitYes` — có fallback theo CHỮ khi
 * id đổi. Phần điều khiển form chạy trong page.evaluate vì đó là môi trường
 * console script đã được kiểm chứng; điều hướng/chờ xác nhận thì Playwright lo.
 *
 * Microsoft KHÔNG có Graph API tạo alias cho tài khoản consumer — chỉ có form
 * account.live.com. Giới hạn 10 alias/tài khoản (và 10 lần tạo mới/năm).
 */

const ALIAS_LIMIT = 10;
const MANAGE_URL = 'https://account.live.com/names/manage';
const ADD_URL = 'https://account.live.com/AddAssocId';

export interface AliasCredentials {
  email: string;
  password: string;
}

/** Sinh tên alias ngẫu nhiên: prefix + chuỗi base36 + 2 số. Chữ thường, hợp lệ
 *  cho local-part Outlook (chữ/số, bắt đầu bằng chữ nhờ prefix). */
export function randomAliasName(prefix = 'hrs'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const tail = Math.floor(Math.random() * 90 + 10);
  return `${prefix}${rand}${tail}`.toLowerCase();
}

/** Kết quả một lần bấm Add, phân loại từ text trang xác nhận / lỗi. */
export type AliasSubmitOutcome =
  | { kind: 'created' }
  | { kind: 'duplicate' } // tên đã có người dùng → thử tên khác
  | { kind: 'limit' } // đã chạm trần 10 alias
  | { kind: 'unknown'; detail: string };

/** Phân loại text trang sau khi submit. Tách riêng để unit-test không cần trình
 *  duyệt. So khớp cả tiếng Anh lẫn tiếng Trung (layout account.live.com hay ra
 *  tiếng Trung theo IP proxy). */
export function classifySubmit(pageText: string): AliasSubmitOutcome {
  const t = pageText.toLowerCase();
  if (/already.*(taken|in use|exists)|不可用|已被使用|已被占用|已存在/.test(t)) return { kind: 'duplicate' };
  if (/(reached|maximum).*(limit|aliases)|too many|已达到|上限|最多/.test(t)) return { kind: 'limit' };
  // Trang danh sách quay lại (có "Remove"/"删除") = tạo xong.
  if (/remove|删除|primary alias|别名/.test(t)) return { kind: 'created' };
  return { kind: 'unknown', detail: pageText.slice(0, 200) };
}

/** Điền tên alias + chọn domain @outlook.com trên form AddAssocId. Trả về true
 *  nếu tìm thấy ô nhập. KHÔNG bấm submit ở đây — submit làm bằng Playwright
 *  (submitAliasForm) cho bền với UI mới. Fill dùng native setter vì React/Fluent
 *  bỏ qua .value gán thẳng. */
async function fillAliasForm(page: Page, name: string): Promise<boolean> {
  return page.evaluate((aliasName) => {
    const doc = (globalThis as any).document;
    const win = globalThis as any;
    const visible = (el: any) =>
      el && el.offsetParent !== null && !el.disabled && win.getComputedStyle(el).visibility !== 'hidden';
    const pick = (sels: string[]): any =>
      sels.map((s) => [...doc.querySelectorAll(s)].find(visible)).find(Boolean);
    function fillInput(el: any, value: string) {
      const proto =
        el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
    }

    const input = pick(["#AssociatedIdLive", "input[name='AssociatedIdLive']", "input[type='text']", "input[type='email']"]);
    if (!input) return false;
    input.focus();
    fillInput(input, aliasName);

    // Radio "tạo địa chỉ email mới" (@outlook.com).
    const radio = pick(["input[type='radio'][value*='Live' i]", '#LiveDomainBox', "input[type='radio']"]);
    if (radio && !radio.checked) radio.click();

    // Domain dạng dropdown ở một số layout → ép outlook.com.
    const domainSel = pick(["select[name*='Domain' i]", '#MemberNameDomain']);
    if (domainSel) {
      const opt = [...domainSel.options].find((o: any) => /outlook\.com/i.test(o.textContent || o.value));
      if (opt) {
        domainSel.value = opt.value;
        domainSel.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
    }
    return true;
  }, name);
}

/** Bấm nút Add trên form AddAssocId. UI cũ: #SubmitYes. UI mới: <button> "Add
 *  alias"/"Add". Thử nhiều locator theo id/type/chữ (getByRole bền với loại
 *  element + ngôn ngữ), không thấy thì nhấn Enter trong ô alias. */
async function submitAliasForm(page: Page, log: Logger): Promise<void> {
  const candidates = [
    page.locator('#SubmitYes'),
    page.locator("button[type='submit'], input[type='submit']"),
    page.getByRole('button', { name: /^\s*add\b/i }), // "Add", "Add alias", "Add email"…
    page.getByRole('button', { name: /thêm|添加/i }),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    const n = await el.count().catch(() => 0);
    if (n && (await el.isVisible().catch(() => false)) && (await el.isEnabled().catch(() => false))) {
      await el.click({ timeout: 5_000 }).catch(() => {});
      log.info('đã bấm nút Add');
      return;
    }
  }
  // Không thấy nút rõ ràng → nhấn Enter trong ô alias (form submit).
  await page.locator('#AssociatedIdLive, input[name="AssociatedIdLive"]').first().press('Enter').catch(() => {});
  log.info('không thấy nút Add — đã nhấn Enter');
}

/** Đếm alias hiện có trên trang quản lý, để tôn trọng trần 10. Đếm số dòng có
 *  nút Remove/删除 (mỗi alias phụ có một). Trả -1 nếu không đọc được. */
async function countExistingAliases(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const rows = [...doc.querySelectorAll('a, button')].filter((el: any) =>
        /^(remove|删除)$/i.test((el.innerText || '').trim()),
      );
      return rows.length;
    });
  } catch {
    return -1;
  }
}

export interface CreateAliasesOptions {
  page: Page;
  cred: AliasCredentials;
  /** Tổng số alias MUỐN tài khoản có sau khi chạy (kể cả alias đã tồn tại). Mặc định 10. */
  target?: number;
  prefix?: string;
  log: Logger;
  /** Đăng nhập account.live.com trước khi tạo (mặc định true). Đặt false nếu
   *  trang đã đăng nhập sẵn (test / phiên có cookie). */
  login?: boolean;
}

export interface CreateAliasesResult {
  created: string[];
  existingBefore: number;
  hitLimit: boolean;
}

/**
 * Đăng nhập account.live.com rồi tạo alias tới khi tài khoản đủ `target` (tối đa
 * 10). Trả danh sách alias MỚI tạo trong lần chạy này.
 *
 * KHÔNG tự ghi sheet — caller (runner) lo, để hàm này thuần về alias.
 */
export async function createAliases(opts: CreateAliasesOptions): Promise<CreateAliasesResult> {
  const { page, cred, log } = opts;
  const target = Math.min(opts.target ?? ALIAS_LIMIT, ALIAS_LIMIT);
  const prefix = opts.prefix ?? 'hrs';

  if (opts.login !== false) await loginLive(page, cred, log);

  await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const existingBefore = Math.max(0, await countExistingAliases(page));
  log.info(`tài khoản ${cred.email}: đang có ${existingBefore} alias, mục tiêu ${target}`);

  const created: string[] = [];
  let hitLimit = false;
  let need = target - existingBefore;
  let stall = 0; // số lần liên tiếp không rõ kết quả

  while (need > 0 && created.length < ALIAS_LIMIT) {
    const name = randomAliasName(prefix);
    await page.goto(ADD_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    const filled = await fillAliasForm(page, name);
    if (!filled) {
      log.warn(`không thấy form AddAssocId cho "${name}" — bỏ qua lần này`);
      await page.waitForTimeout(1000);
      continue;
    }
    await page.waitForTimeout(500);
    await submitAliasForm(page, log);
    await page.waitForTimeout(3000); // chờ trang xác nhận / lỗi

    const url = page.url();
    const bodyText =
      (await page.evaluate(() => (globalThis as any).document.body.innerText).catch(() => '')) || '';
    const outcome = classifySubmit(bodyText);
    // Tín hiệu thành công bền nhất: submit xong MS rời khỏi form AddAssocId (về
    // trang quản lý). Còn ở AddAssocId = form báo lỗi (trùng/không hợp lệ).
    const leftAddForm = !/AddAssocId/i.test(url);
    if (outcome.kind === 'created' || (leftAddForm && outcome.kind !== 'limit')) {
      created.push(`${name}@outlook.com`);
      need--;
      stall = 0;
      log.info(`✓ tạo alias ${name}@outlook.com (${created.length})`);
    } else if (outcome.kind === 'duplicate') {
      log.info(`tên "${name}" đã có người dùng, thử tên khác`);
      // không giảm need — vòng sau sinh tên khác
    } else if (outcome.kind === 'limit') {
      log.warn(`tài khoản đã chạm trần alias — dừng`);
      hitLimit = true;
      break;
    } else {
      stall += 1;
      log.warn(`kết quả không rõ khi tạo "${name}" (lần ${stall}): ${outcome.detail}`);
      if (stall >= 3) {
        log.warn('ba lần liên tiếp không rõ kết quả — dừng để tránh lặp mù');
        break;
      }
    }
  }

  return { created, existingBefore, hitLimit };
}

/** Đăng nhập account.live.com bằng email + password (selector chuẩn Microsoft
 *  identity). Đây là phần AUTOMATION đăng nhập — cần test sống trên tài khoản +
 *  proxy thật; 2FA/again-verify không xử lý ở đây (ném để runner ghi lỗi). */
/** Submit bước login MS hiện tại. UI cũ: #idSIButton9 (input[type=submit]). UI
 *  mới (2024+): <button type=submit> "Next"/"Sign in". Không thấy nút thì nhấn
 *  Enter — form MS submit được bằng Enter. Rồi chờ trang bước kế load. */
async function submitMsStep(page: Page): Promise<void> {
  const btn = await page.$('#idSIButton9, button[type=submit], input[type=submit]');
  if (btn) await btn.click().catch(() => {});
  else await page.keyboard.press('Enter').catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

export async function loginLive(page: Page, cred: AliasCredentials, log: Logger): Promise<void> {
  // Vào qua login.microsoftonline.com: login.live.com hay bị chặn/không tải qua
  // proxy dân cư VN. microsoftonline nhận diện tài khoản consumer (outlook/
  // hotmail) và chạy đúng UI identity dùng chung selector #i0116/#i0118.
  await page.goto('https://login.microsoftonline.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Bước email → submit.
  await page.fill('input[type=email], #i0116', cred.email, { timeout: 45_000 });
  await submitMsStep(page);

  // Bước password. Account consumer có thể bị redirect sang trang live — chờ ô
  // password xuất hiện thay vì gõ mù ngay.
  await page.waitForSelector('input[type=password], #i0118', { state: 'visible', timeout: 45_000 });
  await page.fill('input[type=password], #i0118', cred.password, { timeout: 45_000 });
  await submitMsStep(page);
  await page.waitForTimeout(3000);

  // "Stay signed in?" — bấm Yes để phiên bền, bỏ qua nếu không có.
  const stay = await page.$('#idSIButton9, #acceptButton, button[type=submit]');
  if (stay) {
    await stay.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  const url = page.url();
  if (/login\.(live|microsoftonline)\.com|\/login|error/i.test(url)) {
    log.warn(`sau đăng nhập vẫn ở ${url} — có thể sai mật khẩu / cần xác minh thêm (2FA)`);
  }
}
