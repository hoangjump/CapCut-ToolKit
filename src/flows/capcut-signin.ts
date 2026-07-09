import type { RegisteredFlow } from '../automation/types.js';
import { snapshotPage } from '../automation/helper.js';
import type { Page, Locator } from 'playwright-core';

/**
 * CapCut đăng ký tài khoản bằng email + tự mua mail dongvanfb + tự lấy OTP.
 *
 * NGÔN NGỮ TRANG — QUAN TRỌNG: nhiều nút của CapCut (Continue / Sign up / Open
 * CapCut) KHÔNG có class riêng để bắt, chỉ phân biệt được bằng CHỮ. Nên các
 * selector đó dùng XPath theo text tiếng Anh. Muốn chúng khớp, trang phải đang
 * là tiếng Anh → bước 1 (URL) phải ép `locale=en`. Nếu profile chạy proxy nước
 * khác mà không ép ngôn ngữ, các bước bấm-theo-text sẽ trượt.
 *
 * Selector class-based (lv_*, skip-*, verification_code_input, …) thì bền qua
 * ngôn ngữ — giữ nguyên.
 */

// --- Selector ---------------------------------------------------------------
// Chỉ khác nhau bằng text → phải là tiếng Anh (xem ghi chú trên).
const BTN_CONTINUE = "//span[normalize-space()='Continue']";
const BTN_SIGN_UP = "//span[normalize-space()='Sign up']";
// (Nút "Open CapCut" cuối wizard onboarding giờ bắt theo CHỮ trong reachDashboard
//  qua findVisibleByText, không cần selector riêng.)

// Nút "Continue with email" trên màn chọn cách đăng nhập (class ổn định).
const BTN_CONTINUE_EMAIL =
  "div[class='lv_third_part_sign_in_expand_new-button'] span[class='lv_third_part_sign_in_expand-label']";

const INPUT_EMAIL = "input[placeholder='Enter email']";
const INPUT_PASSWORD = "input[placeholder='Enter password']";

// Ngày sinh: Year là input thường; Month/Day là dropdown lv-select tùy biến.
const INPUT_YEAR = "input[placeholder='Year']";
const SEL_MONTH_TRIGGER = "//span[contains(text(),'Month')]";
const SEL_DAY_TRIGGER = "//span[contains(text(),'Day')]";
// VERIFY: selector của từng option trong dropdown lv-select — đoán theo class
// chuẩn của lv-select. Nếu sai, mở dropdown xem DOM rồi sửa lại ở đây.
const LV_OPTION = ".lv-select-option";
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Màn xác nhận email: dòng "code was sent to <email>" + ô nhập 6 số.
const CODE_TIP = ".lv_sign_in_panel_wide-code-tip";
const OTP_FIRST_BOX = ".verification_code_input-number.verification_code_input-number-focus";

// Sau khi vào app: bỏ qua xác minh, mở màn nâng cấp VIP.
// Nút "Skip" (popup "Which role…") KHÔNG bắt theo class được: class thật dạng
// `skip-mrkR37` có đuôi hash CSS-module tự sinh, đổi mỗi lần CapCut deploy. Và
// popup này nhiều khi nằm trong IFRAME → locator ở main frame không thấy. Nên
// bắt theo CHỮ "Skip" (trang đã ép locale=en) và quét MỌI frame — xem
// findVisibleByText/clickSkip bên dưới.
const BTN_UPGRADE_HEADER = ".LvHeaderUpgradeVipNew";
// Điều kiện: chỉ nâng cấp khi thấy gói dùng thử 7 ngày. Khớp LỎNG — text thật
// có thể là "Free for 7 days", "7-day free trial", "7 days"… nên bắt theo cụm
// "7" + "day" ở bất kỳ phần tử nào, không đòi khớp tuyệt đối một span.
const TRIAL_7DAYS = "//*[contains(translate(., 'D', 'd'), '7 day') or contains(translate(., 'D', 'd'), '7-day')]";
const BTN_PRO_TRIAL_UPGRADE =
  "xpath=(//*[normalize-space()='Pro'])[1]/ancestor::*[.//*[contains(translate(., 'D', 'd'), '7 day') or contains(translate(., 'D', 'd'), '7-day')] and .//button[normalize-space()='Upgrade' or .//*[normalize-space()='Upgrade']]][1]//button[normalize-space()='Upgrade' or .//*[normalize-space()='Upgrade']]";

/** Số nguyên ngẫu nhiên trong [min, max]. */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function exactText(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

/** Tìm phần tử có ĐÚNG chữ `label` đang hiển thị, quét cả main frame LẪN mọi
 *  iframe con. Popup onboarding của CapCut ("Which role…") hay nằm trong iframe,
 *  nên locator ở main frame không thấy — phải duyệt page.frames(). filter visible
 *  loại các bản ẩn (bước 2/3 của popup preload sẵn trong DOM). Trả locator đầu
 *  tiên đang hiển thị, hoặc null. */
async function findVisibleByText(page: Page, label: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const loc = frame.getByText(label, { exact: true }).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function findTrialUpgradeButton(page: Page): Promise<Locator | null> {
  const proTrialUpgrade = page.locator(BTN_PRO_TRIAL_UPGRADE).filter({ visible: true }).first();
  if (await proTrialUpgrade.isVisible().catch(() => false)) return proTrialUpgrade;

  const firstVisibleUpgrade = page.getByRole('button', { name: /^Upgrade$/ }).filter({ visible: true }).first();
  if (await firstVisibleUpgrade.isVisible().catch(() => false)) return firstVisibleUpgrade;

  return null;
}

type FlowLog = { info: (msg: string) => void; warn: (msg: string) => void };

async function domClick(locator: Locator): Promise<void> {
  await locator.evaluate((node: any) => {
    const className = String(node.getAttribute?.('class') ?? '');
    const target = className.includes('lv-select-option')
      ? node
      : node.closest?.('button,[role="button"],a,label,input,textarea,select,[tabindex]') ?? node;
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
    target.click?.();
  });
}

async function clickLocator(locator: Locator, log: FlowLog, label: string, timeout = 3_000): Promise<void> {
  const target = locator.first();
  try {
    await target.click({ timeout });
  } catch (err) {
    log.warn(`${label}: native click lỗi (${(err as Error).message.split('\n')[0]}) — thử force click`);
    try {
      await target.click({ timeout, force: true });
    } catch (forceErr) {
      log.warn(`${label}: force click lỗi (${(forceErr as Error).message.split('\n')[0]}) — thử DOM click`);
      await domClick(target);
    }
  }
}

/**
 * XOÁ THẲNG các lớp popup xếp chồng (What's new, CapCut Ultra is live, promo…)
 * thay vì bấm X từng cái. Lý do: dashboard mới bật 7-8 popup CHỒNG nhau, nút X
 * hay bị lớp trên chắn hoặc bấm không tắt → click trượt. Xoá node ở tầng DOM
 * chắc và nhanh hơn. Quét MỌI frame (popup hay nằm trong iframe). Lặp tới khi
 * hết lớp hoặc chạm trần vòng lặp (React có thể dựng lại → cần quét lại).
 *
 * Hai pass mỗi vòng:
 *   A) Popup CÓ nút Close: neo span[aria-label='Close'] → leo .lv-modal → xoá cả
 *      .lv-modal-wrapper (dạng "CapCut Ultra", "What's new"). CHỈ xoá cụm có nút
 *      Close → không đụng nội dung trang thật.
 *   B) "Xác" chắn click còn trơ lại KHÔNG có Close nên pass A bỏ sót:
 *      - .lv-modal-mask: nền mờ tách rời (aria-hidden, display:block), hay còn lại
 *        chắn click sau khi modal đã đóng. Xoá hết.
 *      - .lv-modal-wrapper RỖNG (không còn .lv-modal bên trong, vd z-index:1101):
 *        lớp bọc trơ chắn click. Xoá.
 *
 * KHÔNG dùng cho popup vai trò "Which role…": nó phải bấm Skip mới cho wizard đi
 * tiếp (xoá cứng có thể làm wizard không chuyển màn). reachDashboard lo cái đó
 * bằng Skip TRƯỚC khi gọi hàm này; đây chỉ dọn các popup promo còn lại. Popup vai
 * trò dùng class `wrapper-*` (KHÔNG phải `.lv-modal-wrapper`) nên pass B không
 * đụng tới; thêm guard theo text cho chắc.
 */
async function sweepPopups(page: Page, log: FlowLog, profileName: string, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    let removed = 0;
    for (const frame of page.frames()) {
      const n = await frame
        .evaluate(() => {
          const doc = (globalThis as any).document;
          if (!doc) return 0;
          let count = 0;
          // Chừa popup vai trò ("Which of the following… best describes you") cho
          // Skip lo — xoá cứng có thể làm wizard không chuyển màn.
          const isRolePopup = (el: any): boolean => {
            const t = String(el.textContent ?? '').toLowerCase();
            return (
              t.includes('which role') ||
              t.includes('which of the following') ||
              t.includes('best describes')
            );
          };
          // --- Pass A: popup CÓ nút Close ---
          const closes = doc.querySelectorAll("span[aria-label='Close']");
          for (const close of Array.from(closes) as any[]) {
            // Popup CapCut là Arco Design (class prefix `lv-`): khung modal thật là
            // .lv-modal, nền mờ .lv-modal-mask, bọc ngoài .lv-modal-wrapper. LEO tới
            // .lv-modal — KHÔNG dùng [class*='modal'] vì chính nút close có class
            // 'lv-modal-close-icon' (chứa 'modal') → closest khớp nhầm CHÍNH NÓ, chỉ
            // xoá mỗi cái X còn popup vẫn nguyên (bug bản trước).
            const modal = close.closest('.lv-modal') ?? close.closest("[role='dialog']");
            if (!modal || isRolePopup(modal)) continue;
            const wrapper = modal.closest('.lv-modal-wrapper') ?? modal;
            wrapper.remove();
            count++;
          }
          // --- Pass B: dọn "xác" chắn click (mask nền + wrapper rỗng) ---
          for (const mask of Array.from(doc.querySelectorAll('.lv-modal-mask')) as any[]) {
            mask.remove();
            count++;
          }
          for (const w of Array.from(doc.querySelectorAll('.lv-modal-wrapper')) as any[]) {
            // Rỗng = không còn .lv-modal bên trong → chỉ là lớp chắn trơ. Wrapper còn
            // chứa modal thật (chưa bị pass A xoá) thì giữ.
            if (isRolePopup(w) || w.querySelector('.lv-modal')) continue;
            w.remove();
            count++;
          }
          return count;
        })
        .catch(() => 0);
      removed += n;
    }
    if (removed === 0) break;
    log.info(`[${profileName}] xoá ${removed} lớp popup (vòng ${i + 1})`);
    await page.waitForTimeout(400);
  }
}

/**
 * Đưa flow từ màn sau-OTP vào tới DASHBOARD. Onboarding của CapCut KHÔNG cố định
 * thứ tự và có thể hiện TRỄ: lúc là wizard "Get started with space" với nút
 * "Open CapCut", lúc là popup vai trò "Which role…" với nút "Skip", lúc vào
 * thẳng app. Nút "Open CapCut" còn hay MỞ APP SANG TAB MỚI. Thay vì các bước
 * cứng theo thứ tự (đã kẹt khi "Open CapCut" hiện sau cửa sổ chờ 8s), poll trong
 * MỘT vòng cho tới khi vào được dashboard:
 *   - Thấy nút Upgrade header (.LvHeaderUpgradeVipNew) → đã vào app, dừng.
 *   - Thấy "Open CapCut" → bấm (bám cả tab mới nếu nó mở tab).
 *   - Thấy "Skip" → bấm (click chuẩn 4s rồi rơi xuống dispatchEvent).
 *   - Chưa thấy gì → chờ chút rồi thử lại.
 * Trả về page đang chứa dashboard (có thể là tab mới do Open CapCut mở).
 */
async function reachDashboard(
  page: Page,
  log: FlowLog,
  profileName: string,
  budgetMs = 90_000,
): Promise<Page> {
  const context = page.context();
  let appPage = page;
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    // App có thể đã nhảy sang tab mới — luôn bám tab còn sống mới nhất, không blank.
    const alive = context.pages().filter((p) => !p.isClosed() && p.url() !== 'about:blank');
    if (alive.length) appPage = alive[alive.length - 1];

    // ƯU TIÊN DẸP ONBOARDING TRƯỚC. Nút Upgrade header hiện ngay cả khi popup vai
    // trò còn ĐÈ lên trên (header nằm phía sau), nên KHÔNG dùng header làm điều
    // kiện dừng khi vẫn còn nút onboarding — trước đây dừng sớm, để popup vai trò
    // còn nguyên rồi kẹt ở bước sau. Thứ tự: Open CapCut → Skip → (mới) header.

    // 1) "Open CapCut" (cuối wizard onboarding). Bấm chuẩn 8s để mở app; nếu bị
    //    chặn thì dispatchEvent. Bắt cả trường hợp nó mở TAB MỚI.
    const openBtn = await findVisibleByText(appPage, 'Open CapCut');
    if (openBtn) {
      log.info(`[${profileName}] thấy "Open CapCut" — bấm`);
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 15_000 }).catch(() => null),
        openBtn.click({ timeout: 8_000 }).catch(() => openBtn.dispatchEvent('click').catch(() => {})),
      ]);
      if (newPage) {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
        appPage = newPage;
        log.info(`[${profileName}] Open CapCut mở tab mới: ${appPage.url()}`);
      }
      await appPage.waitForTimeout(2_000);
      continue;
    }

    // 2) "Skip" (popup vai trò "Which role…"). Đây mới là cách dẹp modal đó — nút
    //    X (Close) bấm KHÔNG tắt. Click chuẩn 4s rồi rơi xuống dispatchEvent (nếu
    //    addLocatorHandler chen vào). Bấm xong chờ modal đóng hẳn trước khi tiếp.
    const skip = await findVisibleByText(appPage, 'Skip');
    if (skip) {
      log.info(`[${profileName}] thấy "Skip" — bấm`);
      try {
        await skip.click({ timeout: 4_000 });
      } catch (err) {
        log.warn(`[${profileName}] click Skip lỗi: ${(err as Error).message} — thử dispatchEvent`);
        await skip.dispatchEvent('click').catch(() => {});
      }
      await appPage.waitForTimeout(2_000);
      continue;
    }

    // 3) Hết Open CapCut & Skip rồi — giờ mới coi header là dấu hiệu đã vào app.
    if (await appPage.locator(BTN_UPGRADE_HEADER).first().isVisible().catch(() => false)) {
      log.info(`[${profileName}] đã vào dashboard (hết popup onboarding)`);
      return appPage;
    }

    // Chưa thấy gì để bấm & chưa thấy header — onboarding đang render/chuyển màn.
    await appPage.waitForTimeout(1_500);
  }

  // Hết budget mà chưa chắc vào dashboard — trả page hiện tại để bước sau chờ
  // header (fail có ảnh) thay vì treo vô hạn.
  log.warn(`[${profileName}] hết ${budgetMs / 1000}s onboarding mà chưa chắc vào dashboard`);
  return appPage;
}

export const capcutSigninFlow: RegisteredFlow = {
  meta: {
    name: 'capcut-signin',
    label: 'CapCut — đăng ký email + tự mua mail + OTP',
    description:
      'Mua mail dongvanfb → đăng ký CapCut → tự lấy OTP từ hòm thư → bỏ qua xác minh → mở màn nâng cấp, bắt popup thanh toán.',
  },
  run: async ({ helper, page, buyMail, getOtpByRegex, report, profile, log }) => {
    // --- Popup "What's new"/promo nhảy ra KHÔNG đoán trước được (sau Skip, sau
    // khi vào app…). Mọi cách "canh thời điểm rồi bấm X" đều trượt vì thời điểm
    // xuất hiện không cố định. addLocatorHandler (Playwright ≥1.42) đăng ký một
    // lần: Playwright tự chạy handler đóng popup NGAY TRƯỚC mỗi thao tác bị nó
    // chắn, bất kể popup hiện lúc nào. Hai selector đúng của nút X:
    //   span[aria-label='Close']
    // Chỉ bắt wrapper role=button, không bắt SVG con để tránh strict-mode match
    // 2 element cùng lúc.
    //
    // noWaitAfter=TRUE — QUAN TRỌNG: mặc định Playwright CHỜ overlay biến mất sau
    // khi chạy handler rồi mới tiếp tục thao tác gốc. Nhưng nút X của popup vai
    // trò ("Which role…") bấm KHÔNG tắt (modal đó phải dẹp bằng Skip), nên kiểu
    // chờ mặc định làm Playwright treo 30s MỌI thao tác (đã dính đúng lỗi này:
    // "waiting for span[aria-label='Close'] to be hidden — 44×"). Đặt noWaitAfter
    // để chạy handler xong là đi tiếp ngay; dẹp popup vai trò để reachDashboard
    // lo riêng bằng Skip. ---
    // Dashboard mới ("Seedance/Ultra") bật NHIỀU popup XẾP CHỒNG cùng lúc
    // ("What's new", "CapCut Ultra is live"…), mỗi popup một nút X cùng selector
    // span[aria-label='Close']. Nếu đăng ký handler bằng locator khớp NHIỀU element,
    // chính việc Playwright dò visible để chạy handler đã ném strict-mode violation
    // ("resolved to 2 elements") và làm hỏng luôn thao tác đang chờ. Nên:
    //   - trigger = .first() (một element → không vi phạm strict), và
    //   - trong handler bấm LẶP nút Close đầu tiên cho tới khi hết (đóng mọi popup
    //     chồng nhau), thay vì chỉ đóng 1.
    const popupClose = page.locator("span[aria-label='Close']").first();
    await page.addLocatorHandler(
      popupClose,
      async () => {
        for (let i = 0; i < 5; i++) {
          const close = page.locator("span[aria-label='Close']").first();
          if (!(await close.isVisible().catch(() => false))) break;
          log.info(`[${profile.name}] popup chắn thao tác — đóng (${i + 1})`);
          await close.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(400);
        }
      },
      { noWaitAfter: true },
    );

    // --- Bước 1: mở trang đăng nhập. `locale=en` ÉP tiếng Anh để các nút bắt
    // theo text (Continue/Sign up/Open CapCut) khớp dù profile chạy proxy nước
    // khác + geoip. Không có nó, proxy vùng khác sẽ render ngôn ngữ khác → gãy. ---
    await helper.goto('https://www.capcut.com/login?locale=en');

    // --- Bước 2: bấm "Continue with email" ---
    await helper.waitFor(BTN_CONTINUE_EMAIL);
    await helper.click(BTN_CONTINUE_EMAIL);
    log.info(`[${profile.name}] bấm "Continue with email"`);

    // --- Bước 3: mua mail riêng cho profile này rồi điền email. Runner tự chụp
    // full mail creds (email|password|refresh_token|client_id) cho dòng sheet,
    // nên ở đây chỉ cần email + password để điền form. ---
    const { email, password } = await buyMail();
    log.info(`[${profile.name}] mua mail: ${email}`);
    await helper.waitFor(INPUT_EMAIL);
    await helper.fill(INPUT_EMAIL, email);

    // --- Bước 4: bấm Continue ---
    await helper.click(BTN_CONTINUE);

    // --- Bước 5: điền mật khẩu (chính là password của mail vừa mua) ---
    if (!password) throw new Error('Mail mua về không kèm password — không thể đặt mật khẩu đăng ký');
    await helper.waitFor(INPUT_PASSWORD);
    await helper.fill(INPUT_PASSWORD, password);

    // --- Bước 6: bấm Sign up ---
    await helper.click(BTN_SIGN_UP);

    // --- Bước 7: ngày sinh ngẫu nhiên (Year input + Month/Day dropdown) ---
    const year = randInt(1990, 2002);
    const month = randInt(1, 12);
    const day = randInt(1, 28); // ≤28 để hợp lệ với mọi tháng
    await helper.waitFor(INPUT_YEAR);
    await helper.fill(INPUT_YEAR, String(year));

    // Month: mở dropdown → chọn option thứ `month`. VERIFY selector LV_OPTION.
    await helper.click(SEL_MONTH_TRIGGER);
    await helper.waitFor(LV_OPTION);
    const monthOpt = page.locator(LV_OPTION).filter({ hasText: exactText(MONTH_NAMES[month - 1]), visible: true });
    await clickLocator(monthOpt, log, `[${profile.name}] chọn tháng ${MONTH_NAMES[month - 1]}`, 8_000);

    // Day: tương tự. Danh sách day có thể cuộn — chọn theo text cho chắc.
    await helper.click(SEL_DAY_TRIGGER);
    await helper.waitFor(LV_OPTION);
    const dayOpt = page.locator(LV_OPTION).filter({ hasText: exactText(String(day)), visible: true });
    await clickLocator(dayOpt, log, `[${profile.name}] chọn ngày ${day}`, 8_000);
    if (await page.locator(LV_OPTION).first().isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
    log.info(`[${profile.name}] ngày sinh: ${day}/${month}/${year}`);

    // Bấm Continue sau ngày sinh.
    await helper.click(BTN_CONTINUE);

    // --- Bước 8: màn xác nhận email — kiểm tra đúng email vừa nhập ---
    await helper.waitFor(CODE_TIP);
    const tip = await helper.text(CODE_TIP);
    if (!tip.toLowerCase().includes(email.toLowerCase())) {
      log.warn(`[${profile.name}] dòng xác nhận ("${tip}") không chứa email ${email} — vẫn thử lấy code`);
    }

    // --- Bước 9: đọc hòm thư lấy code ("verification code is 747139") ---
    const code = await getOtpByRegex(); // mặc định khớp "verification code is <digits>"
    log.info(`[${profile.name}] lấy được code: ${code}`);

    // Nhập code vào ô 6 số: focus ô đầu rồi gõ từng ký tự, focus tự nhảy.
    await helper.waitFor(OTP_FIRST_BOX);
    await helper.click(OTP_FIRST_BOX);
    await helper.typeKeys(code);

    // --- Bước 10-11: VÀO DASHBOARD. Sau OTP, onboarding của CapCut không cố định
    // thứ tự (wizard "Get started with space" với "Open CapCut", popup vai trò
    // "Which role…" với "Skip", hoặc vào thẳng app) và màn có thể hiện TRỄ. Gộp
    // thành một vòng lặp poll thay vì các bước cứng theo thứ tự — trước đây kẹt
    // vì "Open CapCut" hiện sau cửa sổ chờ 8s nên không được bấm. reachDashboard
    // lo cả bấm "Open CapCut" (bám cả tab mới), bấm "Skip", và dừng khi thấy nút
    // Upgrade header. Từ đây dùng appPage (có thể là tab mới do Open CapCut mở). ---
    const appPage = await reachDashboard(page, log, profile.name);
    if (appPage !== page) log.info(`[${profile.name}] dashboard ở tab: ${appPage.url()}`);

    // Xác nhận nút Upgrade header đã hiện trước khi bấm. reachDashboard thường đã
    // dừng đúng lúc thấy header (chờ này trả về ngay); nếu hết budget mà chưa vào
    // được thì chờ tối đa 30s ở đây để fail CÓ ẢNH thay vì bấm nhầm.
    // (Không còn nhảy sang /profile: popup dashboard mới — "What's new", "CapCut
    // Ultra is live" và các "xác" mask/wrapper trơ — được sweepPopups dẹp thẳng
    // tại tab hiện tại ở Bước 12, rồi bấm Upgrade luôn.)
    await appPage.waitForSelector(BTN_UPGRADE_HEADER, { state: 'visible', timeout: 30_000 });

    // --- Bước 12: mở màn nâng cấp VIP. Nút này có thể mở bảng giá NGAY TRÊN
    // tab hiện tại HOẶC bật ra TAB MỚI — nên vừa bấm vừa rình sự kiện 'page'.
    // Nếu có tab mới thì bảng giá nằm ở đó, ngược lại vẫn là tab gốc.
    // (nút Upgrade header đã được chờ hiện sau khi navigate lại ở Bước 11b.) ---
    // Pace TRƯỚC khi vào Promise.all: click ở đây phải chạy ngay để 'page' event
    // (timeout 8s) không hết giờ vì 5-10s pause của click. Nhịp người vẫn giữ.
    //
    // GỠ handler đóng popup TRƯỚC khi mở bảng giá. Modal "Choose your plan" có nút
    // X trùng đúng selector span[aria-label='Close'] mà handler đang canh — nếu
    // không gỡ, handler tự đóng luôn bảng giá ngay khi nó hiện → mất gói 7 ngày.
    await page.removeLocatorHandler(popupClose).catch(() => {});

    // Dọn các lớp popup promo xếp chồng ("What's new", "CapCut Ultra"…) chắn nút
    // Upgrade. Xoá thẳng element (nhanh + chắc hơn click X từng cái); popup vai trò
    // "Which role…" được chừa lại cho Skip (reachDashboard đã lo). Chạy sau khi gỡ
    // handler để không đụng modal bảng giá sắp mở.
    await sweepPopups(appPage, log, profile.name);

    await helper.pace();
    const [maybeNewTab] = await Promise.all([
      appPage.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null),
      clickLocator(appPage.locator(BTN_UPGRADE_HEADER).first(), log, `[${profile.name}] bấm Upgrade header`),
    ]);
    const pricing = maybeNewTab ?? appPage;
    if (maybeNewTab) {
      await maybeNewTab.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      log.info(`[${profile.name}] bảng giá mở ở tab mới: ${pricing.url()}`);
    }

    // --- Bước 13: chờ gói dùng thử 7 ngày render (tối đa 15s) rồi quyết định.
    // Dùng waitForSelector có chờ thay vì exists() tức thời — bảng giá cần thời
    // gian dựng. Luôn chụp lại bảng giá để đối chiếu DOM mà không phải mua thêm. ---
    const trial = await pricing
      .waitForSelector(TRIAL_7DAYS, { state: 'visible', timeout: 15_000 })
      .catch(() => null);
    await snapshotPage(pricing, `capcut-pricing-${profile.name}`);

    if (trial) {
      log.info(`[${profile.name}] có gói dùng thử 7 ngày → bấm Upgrade, bắt popup thanh toán`);
      // Nhịp người trước khi bấm Upgrade (pricing có thể là tab mới không do helper
      // bọc, nên pause trực tiếp trên page đó thay vì helper.pace()).
      await pricing.waitForTimeout(randInt(5_000, 10_000));
      const upgradeButton = await findTrialUpgradeButton(pricing);
      if (!upgradeButton) {
        await snapshotPage(pricing, `capcut-upgrade-not-found-${profile.name}`);
        throw new Error('Không tìm được nút Upgrade của gói Pro 7 ngày trên bảng giá');
      }
      const [checkout] = await Promise.all([
        pricing.context().waitForEvent('page', { timeout: 30_000 }).catch(() => null),
        clickLocator(upgradeButton, log, `[${profile.name}] bấm Upgrade gói Pro`),
      ]);
      if (checkout) {
        // Cổng thanh toán mở tab bằng window.open('') → tab khởi tạo là about:blank
        // rồi JS mới điều hướng sang URL thật (cashier pipopay). Ta CHỈ cần bắt được
        // URL pipopay là đủ để báo Telegram + ghi sheet — KHÔNG chờ trang load hết
        // (cashier nặng, load đủ tốn nhiều giây vô ích). Poll URL nhanh (200ms/lần):
        // hễ thấy 'pipopay' là report NGAY; nếu không kịp thấy pipopay thì fallback
        // lấy URL đầu tiên rời about:blank.
        const deadline = Date.now() + 30_000;
        let checkoutUrl = '';
        while (Date.now() < deadline) {
          const u = checkout.url();
          if (u.includes('pipopay')) { checkoutUrl = u; break; }
          if (!checkoutUrl && u !== 'about:blank' && u !== '') checkoutUrl = u;
          if (checkout.isClosed()) break;
          await checkout.waitForTimeout(200);
        }
        if (!checkoutUrl) checkoutUrl = checkout.url();
        report({ checkoutUrl, status: 'checkout' });
        log.info(`[${profile.name}] popup thanh toán: ${checkoutUrl}`);
        // Chụp lại (không chờ load) để có bằng chứng — bỏ qua nếu tab đã đóng.
        await snapshotPage(checkout, `capcut-checkout-${profile.name}`).catch(() => {});
      } else {
        report({ status: 'signup-ok' });
        log.info(`[${profile.name}] bấm Upgrade nhưng không thấy popup thanh toán mở`);
        await snapshotPage(pricing, `capcut-after-upgrade-${profile.name}`);
      }
    } else {
      report({ status: 'signup-ok' });
      log.info(`[${profile.name}] không thấy gói 7 ngày sau 15s — bỏ qua (xem ảnh capcut-pricing-*)`);
    }
  },
};
