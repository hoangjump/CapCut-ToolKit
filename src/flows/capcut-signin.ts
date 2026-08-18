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

// (Nút "Open CapCut" cuối wizard onboarding bắt theo CHỮ trong reachDashboard qua
//  findVisibleByText. Không còn cần selector Skip/Upgrade header: việc mua VIP chạy
//  qua API nên không đụng DOM dashboard.)

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
 * Đưa flow từ màn sau-OTP vào tới trang app CapCut để LẤY SESSION cho việc gọi
 * API thương mại. Vì việc mua VIP giờ chạy hoàn toàn qua API (fetch của chính
 * trang, chỉ cần cookie login đã có sẵn ở context), ta KHÔNG cần dẹp popup vai
 * trò "Which role…"/Skip nữa — bỏ hẳn vòng bấm Skip (trước tốn ~20s vô ích).
 *
 * Chỉ cần một việc: nếu còn màn wizard với nút "Open CapCut" thì bấm để rời
 * /login vào app (nút này hay MỞ TAB MỚI → bám tab đó). Vào được trang capcut.com
 * KHÔNG phải /login là đủ — trả về ngay để gọi API. Nếu OTP xong vào thẳng app
 * (không có Open CapCut) cũng trả ngay.
 */
async function reachDashboard(
  page: Page,
  log: FlowLog,
  profileName: string,
  budgetMs = 60_000,
): Promise<Page> {
  const context = page.context();
  let appPage = page;
  const deadline = Date.now() + budgetMs;

  const onApp = (p: Page): boolean => {
    const u = p.url();
    return u.includes('capcut.com') && !u.includes('/login') && u !== 'about:blank';
  };

  while (Date.now() < deadline) {
    // App có thể đã nhảy sang tab mới — luôn bám tab còn sống mới nhất, không blank.
    const alive = context.pages().filter((p) => !p.isClosed() && p.url() !== 'about:blank');
    if (alive.length) appPage = alive[alive.length - 1];

    // Còn wizard "Open CapCut" → bấm để vào app (bám cả tab mới nếu nó mở tab).
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
      await appPage.waitForTimeout(1_500);
      continue;
    }

    // Đã ở trang app (không phải /login) → session sẵn sàng, trả ngay. KHÔNG bấm
    // Skip: popup vai trò không cản việc gọi API.
    if (onApp(appPage)) {
      log.info(`[${profileName}] đã vào app (${appPage.url()}) — gọi API luôn`);
      return appPage;
    }

    // Chưa thấy Open CapCut & chưa rời /login — đang chuyển màn, chờ chút rồi thử lại.
    await appPage.waitForTimeout(1_000);
  }

  log.warn(`[${profileName}] hết ${budgetMs / 1000}s mà chưa chắc vào app — vẫn thử gọi API`);
  return appPage;
}

export interface VipPurchaseResult {
  region: string;
  alreadyVip: boolean;
  vipEndTime: number;
  cashierUrl: string;
  ret: string;
  errmsg: string;
  step: string;
}

/**
 * MUA VIP KHÔNG QUA UI. Sau khi đã đăng nhập, gọi thẳng 3 API thương mại của
 * CapCut bằng `fetch` CỦA CHÍNH TRANG — nhờ vậy `webmssdk.js` tự chèn chữ ký
 * chống bot (X-Bogus / X-Gnarly / sign / msToken) mà không cách nào sinh lại
 * được ngoài trình duyệt. Thay cả chuỗi bấm Upgrade → chờ bảng giá render → dò
 * tab pipopay: nhanh hơn nhiều và không dính popup che chắn (What's new, CapCut
 * Ultra…), vì hoàn toàn không đụng DOM dashboard.
 *
 * Ba bước, dừng sớm nếu đã có VIP:
 *   1) subscription_infos: đã là VIP còn hạn → trả alreadyVip, KHÔNG mua nữa.
 *   2) cc_price_list: lấy sku_id + pms_trade ĐỘNG cho gói dùng thử 7 ngày. Bắt
 *      buộc lấy động — hardcode sku sẽ lệch theo tài khoản/khu vực → "sku invalid".
 *   3) init_trade: trả cashier_url (link thanh toán pipopay) để báo về.
 *
 * region lấy từ cookie store-country-code (fallback VN) để hợp với proxy vùng khác.
 */
async function purchaseVipViaApi(page: Page): Promise<VipPurchaseResult> {
  return await page.evaluate(async () => {
    const g = globalThis as any;
    const doc = g.document;
    const fetchFn = g.fetch;
    const H = {
      'Content-Type': 'application/json',
      appId: '348188',
      appvr: '12.4.0',
      lan: 'en',
      loc: 'VN',
      pf: '7',
    };
    const cookie = (name: string): string => {
      const m = String(doc?.cookie ?? '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Sau Open CapCut, cookie login (sessionid/sid_guard) có thể chưa set ngay —
    // gọi API sớm sẽ dính "not login". Chờ cookie xuất hiện tối đa ~15s trước khi
    // gọi; hết giờ mà vẫn chưa có thì cứ thử (fetch dùng credentials:include nên
    // vẫn gửi cookie hiện có).
    for (let i = 0; i < 30; i++) {
      if (cookie('sessionid') || cookie('sid_guard')) break;
      await sleep(500);
    }

    const region = (cookie('store-country-code') || 'VN').toUpperCase();
    const result = {
      region,
      alreadyVip: false,
      vipEndTime: 0,
      cashierUrl: '',
      ret: '',
      errmsg: '',
      step: '',
    };

    // --- B1: đã có VIP chưa? ---
    try {
      const sub = await fetchFn(
        'https://commerce-api-sg.capcut.com/commerce/v3/trade/subscription_infos',
        {
          method: 'POST',
          credentials: 'include',
          headers: H,
          body: JSON.stringify({ scene: ['vip', 'workspace'], app_id: 348188, vip_levels: ['vip', 'ultra'] }),
        },
      ).then((r: any) => r.json());
      const vip = sub?.data?.subscription_user_infos?.vip;
      const info = (vip?.vip_infos ?? []).find((v: any) => v?.is_vip);
      if (info) {
        result.alreadyVip = true;
        result.vipEndTime = Number(info.vip_end_time) || 0;
        result.step = 'already-vip';
        return result;
      }
    } catch (e: any) {
      // Lỗi check sub không chặn việc mua — cứ đi tiếp.
    }

    // --- B2: lấy bảng giá, chọn gói dùng thử 7 ngày, lấy sku ĐỘNG ---
    let pick: any = null;
    try {
      const pr = await fetchFn(
        'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',
        {
          method: 'POST',
          credentials: 'include',
          headers: H,
          body: JSON.stringify({ aid: 348188, region, scene: 'vip' }),
        },
      ).then((r: any) => r.json());
      const list = pr?.data?.all_price_list ?? [];
      // CHỈ mua gói dùng thử 7 ngày (can_trial + trial_cycle=7). KHÔNG fallback
      // sang gói mặc định — tránh lỡ init_trade một gói trả tiền ngay.
      pick = list.find((p: any) => p?.can_trial && p?.trial_cycle === 7);
      if (!pick) {
        result.step = 'no-trial';
        result.errmsg = 'không có gói dùng thử 7 ngày';
        return result;
      }
    } catch (e: any) {
      result.step = 'price-list-err';
      result.errmsg = String((e && e.message) || e);
      return result;
    }

    // --- B3: init_trade → cashier_url ---
    try {
      const body = {
        app_id: 348188,
        aid: 348188,
        region,
        scene: 'vip',
        type: 'vip',
        benefit_target: {},
        trade_type: 'subscription',
        sku_id: pick.sku_id,
        product_id: pick.product_id,
        pms_trade: pick.pms_trade,
        pay_channel: 'aggregate',
        pipo_aggregate_info: {
          color_theme: 'light',
          gp_unavailable: true,
          language: 'en',
          request_id: String(Date.now()),
          return_url: 'https://www.capcut.com/commerce/payment-result?closeImmediately=1',
          user_create_time: Math.floor(Date.now() / 1000),
        },
      };
      const res = await fetchFn(
        'https://commerce-api-sg.capcut.com/commerce/v3/trade/init_trade',
        { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(body) },
      ).then((r: any) => r.json());
      result.ret = String(res?.ret ?? '');
      result.errmsg = String(res?.errmsg ?? '');
      result.cashierUrl = res?.data?.pipo_aggregate_pay_info?.cashier_url ?? '';
      result.step = result.cashierUrl ? 'checkout' : 'init-trade-no-url';
    } catch (e: any) {
      result.step = 'init-trade-err';
      result.errmsg = String((e && e.message) || e);
    }
    return result;
  });
}

export const capcutSigninFlow: RegisteredFlow = {
  meta: {
    name: 'capcut-signin',
    label: 'CapCut — đăng ký email + tự mua mail + OTP',
    description:
      'Mua mail dongvanfb → đăng ký CapCut → tự lấy OTP từ hòm thư → bỏ qua xác minh → mở màn nâng cấp, bắt popup thanh toán.',
  },
  run: async ({ helper, page, buyMail, getOtpByRegex, report, profile, log }) => {
    // (KHÔNG còn addLocatorHandler/sweepPopups: từ khi vào dashboard, việc nâng
    // cấp VIP gọi thẳng API thương mại qua purchaseVipViaApi — không đụng DOM nên
    // popup "What's new"/"CapCut Ultra" che chắn không còn ảnh hưởng gì.)

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

    // --- Bước 12: NÂNG CẤP VIP QUA API (không qua UI). Gọi thẳng 3 API thương mại
    // bằng fetch của chính trang (webmssdk tự ký chống bot). Bỏ hẳn chuỗi bấm
    // Upgrade → chờ bảng giá → dò tab pipopay: nhanh hơn và miễn nhiễm popup che.
    //
    // RETRY: cookie login (sessionid/sid_guard) đôi khi chưa set kịp ngay sau khi
    // vào app, hoặc request đầu trúng lúc proxy chập chờn → lỗi TẠM. Các step lỗi
    // tạm (no-cookie/price-list-err/init-trade-err/init-trade-no-url) thì reload
    // trang rồi thử lại, tối đa 3 lượt. Kết quả CHỐT (already-vip/checkout/no-trial)
    // dừng ngay, không reload thừa. ---
    const TERMINAL = new Set(['already-vip', 'checkout', 'no-trial']);
    // Gọi API mua VIP an toàn: `purchaseVipViaApi` chạy async ~15-20s TRONG
    // page.evaluate (chờ cookie + fetch). Nếu trang CapCut tự điều hướng giữa
    // chừng (SPA redirect, hoặc reload lúc retry) thì context bị huỷ và evaluate
    // NÉM "Execution context was destroyed" — trước đây làm CHẾT cả task, mất
    // account đã đăng ký xong. Bọc lại thành kết quả tạm để retry/kết thúc êm.
    const tryPurchase = async (): Promise<VipPurchaseResult> => {
      try {
        return await purchaseVipViaApi(appPage);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        log.warn(`[${profile.name}] purchaseVipViaApi ném lỗi (coi là tạm): ${msg.slice(0, 120)}`);
        return { region: '', alreadyVip: false, vipEndTime: 0, cashierUrl: '', ret: '', errmsg: msg.slice(0, 120), step: 'evaluate-error' };
      }
    };
    // Bị "shark" (chống gian lận CapCut, ret=-6) chặn init-trade KHÔNG phải lỗi
    // tạm — reload cùng IP không giải được, chỉ tổ tốn thời gian + rước thêm rủi
    // ro context-destroyed. Coi như chốt: account đã đăng ký xong, chỉ thiếu VIP.
    const riskBlocked = (v: VipPurchaseResult) => /shark|risk\b|blocked|风控/i.test(v.errmsg || '');
    let vip = await tryPurchase();
    log.info(`[${profile.name}] purchaseVipViaApi: step=${vip.step} region=${vip.region} ret=${vip.ret} ${vip.errmsg}`);
    for (let attempt = 1; attempt <= 2 && !TERMINAL.has(vip.step) && !riskBlocked(vip); attempt++) {
      log.warn(`[${profile.name}] kết quả tạm (${vip.step}) — reload + thử lại (${attempt}/2)`);
      await appPage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      // Chờ trang ổn định (không còn điều hướng) TRƯỚC khi gọi lại evaluate, để
      // không lại dính context-destroyed. networkidle best-effort + nghỉ ngắn.
      await appPage.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await appPage.waitForTimeout(2_000);
      vip = await tryPurchase();
      log.info(`[${profile.name}] purchaseVipViaApi (thử ${attempt + 1}): step=${vip.step} ret=${vip.ret} ${vip.errmsg}`);
    }
    await snapshotPage(appPage, `capcut-dashboard-${profile.name}`).catch(() => {});

    if (vip.alreadyVip) {
      const days = vip.vipEndTime ? Math.round((vip.vipEndTime * 1000 - Date.now()) / 86_400_000) : 0;
      log.info(`[${profile.name}] đã là VIP (còn ~${days} ngày) — bỏ qua mua`);
      report({ status: 'already-vip' });
    } else if (vip.cashierUrl) {
      report({ checkoutUrl: vip.cashierUrl, status: 'checkout' });
      log.info(`[${profile.name}] link thanh toán: ${vip.cashierUrl}`);
    } else if (riskBlocked(vip)) {
      // Account đã tạo OK; VIP bị CapCut chống gian lận chặn. Ghi rõ để lọc.
      report({ status: 'vip-shark-blocked' });
      log.warn(`[${profile.name}] đăng ký OK nhưng VIP bị shark chặn (ret=${vip.ret}, ${vip.errmsg}) — account vẫn lưu`);
    } else {
      report({ status: 'signup-ok' });
      log.warn(`[${profile.name}] không lấy được cashier_url (step=${vip.step}, ret=${vip.ret}, ${vip.errmsg})`);
    }
  },
};
