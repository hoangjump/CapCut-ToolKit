import type { RegisteredFlow } from '../automation/types.js';
import { snapshotPage } from '../automation/helper.js';
import type { Page, Locator, BrowserContext } from 'playwright-core';

/**
 * ChatGPT (OpenAI) — đăng ký bằng gmail thuê SmsBower + lên Plus qua iDEAL, bắt
 * link thanh toán pay.ideal.nl (giống CapCut bắt link pipopay). Selector bám theo
 * DOM THẬT user cung cấp, ưu tiên thuộc tính ổn định (href / name+value /
 * data-testid / select#billingAddress-countryInput / aria-label) → KHÔNG phụ
 * thuộc ngôn ngữ; chỉ dùng text cho vài nút bất khả kháng.
 *
 * LUỒNG:
 *  A. Đăng ký: chatgpt.com/auth/login_with → auth.openai.com → "Sign up"
 *     (a[href="/create-account"]) → email (gmail thuê) → Continue
 *     (button[name=intent][value=email]) → "Continue with password"
 *     (a[href="/create-account/password"]) → mật khẩu cố định → Continue →
 *     CODE (retry nếu "Incorrect code": đọc mã KẾ qua nextCode) → Full name + Age
 *     random → "Finish creating account" → màn chào "Continue".
 *  B. Lên Plus: mở ...#pricing → đổi quốc gia Netherlands (combobox ảo hoá) →
 *     nút chọn gói Plus (data-testid=select-plan-button-plus-upgrade — dùng chung
 *     cho "Upgrade to Plus"/"Claim free offer").
 *  C. Thanh toán iDEAL (Stripe, thường trong IFRAME): chờ chatgpt.com/checkout →
 *     tab "iDEAL" → billing (tên + địa chỉ Hà Lan randomuser.me, country select
 *     NL) → "Subscribe" (aria-label) → BẮT link pay.ideal.nl → report.
 *
 * MAIL: chỉ flow này dùng SmsBower (ctx.rentMail). Mã service đặt ở Project. Dùng
 * API BATCH (getBatch count=1): mail kèm link getCodeBySignature đọc all_codes
 * NHIỀU LẦN. OpenAI hay gửi 2-3 mã → waitCode lấy mã mới nhất; nếu ChatGPT báo
 * "Incorrect", nextCode thử mã KHÁC trong all_codes (không cần request lại).
 *
 * PROXY & NGÔN NGỮ: giữ proxy của profile (vd VN), nhưng profile tạm của flow này
 * TẮT geoip + language 'real' ⇒ KHÔNG set locale gì cả. Lý do (đã probe): Camoufox
 * spoof Intl.DisplayNames theo "locale:region"; hễ config có locale:region (geoip
 * HAY ép locale sinh ra) thì spoof LỖI — .of(mọi mã nước) đều trả về nước của
 * region đó → dropdown ChatGPT (build bằng Intl.DisplayNames.of) hiện "cả list 1
 * nước" (US / NL / Việt Nam) → chọn sai. Không locale:region thì DisplayNames đúng
 * → dropdown render đúng tên nước; selectCountry chọn đúng Netherlands. Đánh đổi:
 * timezone/geo không khớp IP proxy (chấp nhận); UI về mặc định en-US. Không đổi proxy.
 *
 * ⚠️ CẦN TINH CHỈNH KHI CHẠY THẬT: OpenAI/Stripe đổi DOM + có thể dính Cloudflare/
 * Arkose captcha (flow không tự giải) hoặc hỏi SĐT (ngoài phạm vi mail). Mỗi bước
 * quan trọng đều chụp ảnh chatgpt-* trong profiles-store/shots để đối chiếu.
 */

// --- Selector (bám DOM thật + fallback, ưu tiên thuộc tính ổn định) ---------
export const SEL_EMAIL = ['#email', 'input[name="email"]', 'input[type="email"]', 'input[autocomplete~="email"]', 'input[autocomplete="username"]'];
// Continue sau email: button[name=intent][value=email] — ổn định, không theo text.
export const BTN_EMAIL_CONTINUE = ['button[name="intent"][value="email"]', 'button[type="submit"]'];
// "Continue with password": a[href="/create-account/password"] — ổn định.
export const LINK_CONTINUE_PASSWORD = ['a[href="/create-account/password"]', '//a[contains(normalize-space(),"Continue with password")]'];
export const SEL_PASSWORD = ['input[type="password"]', 'input[name="password"]', '#password', 'input[autocomplete="current-password"]', 'input[autocomplete="new-password"]'];
export const BTN_SUBMIT = ['button[type="submit"]'];
// Continue(validate) sau code: button[name=intent][value=validate] — ổn định.
export const BTN_VALIDATE = ['button[name="intent"][value="validate"]', 'button[type="submit"]'];
export const SEL_CODE = ['input[name="code"]', 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]'];
export const SEL_NAME = ['input[name="name"]', 'input[autocomplete="name"]', '#name'];
export const SEL_AGE = ['input[name="age"]', 'input[inputmode="numeric"]', 'input[type="number"]'];

// Mật khẩu cố định (theo spec user). Đổi ở đây nếu cần.
export const PASSWORD = 'emHoang@2004';

// Tên tiếng Việt random cho "Full name".
const VN_HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương'];
const VN_DEM = ['Văn', 'Thị', 'Hữu', 'Đức', 'Minh', 'Quang', 'Thanh', 'Hồng', 'Ngọc', 'Gia', 'Bảo', 'Anh', 'Tuấn', 'Thu'];
const VN_TEN = ['An', 'Bình', 'Cường', 'Dũng', 'Hà', 'Hải', 'Hùng', 'Khoa', 'Lan', 'Linh', 'Mai', 'Nam', 'Phúc', 'Quân', 'Sơn', 'Tâm', 'Trang', 'Tú', 'Vy', 'Yến'];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}
function randomVietnameseName(): string {
  return `${pick(VN_HO)} ${pick(VN_DEM)} ${pick(VN_TEN)}`;
}

type FlowLog = { info: (msg: string) => void; warn: (msg: string) => void };

interface DutchProfile { full: string; street: string; city: string; postcode: string }

/** Lấy hồ sơ Hà Lan thật (tên/đường/thành phố/mã bưu) từ randomuser.me?nat=nl để
 *  điền billing iDEAL cho khớp. Fetch chạy ở tiến trình Node (không qua proxy
 *  profile — chỉ là dữ liệu giả). Lỗi/timeout → dùng hồ sơ NL mặc định. */
async function fetchDutchProfile(log: FlowLog): Promise<DutchProfile> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch('https://randomuser.me/api/?nat=nl&inc=name,location', { signal: ctrl.signal });
    clearTimeout(timer);
    const j: any = await res.json();
    const u = j?.results?.[0];
    if (u) {
      const first = u.name?.first ?? 'Daan';
      const last = u.name?.last ?? 'de Vries';
      const st = u.location?.street;
      const street = st ? `${st.name} ${st.number}` : 'Kerkstraat 42';
      const city = String(u.location?.city ?? 'Amsterdam');
      const postcode = String(u.location?.postcode ?? '1012 AB');
      return { full: `${first} ${last}`, street, city, postcode };
    }
  } catch (e) {
    log.warn(`randomuser.me lỗi (${(e as Error).message}) — dùng hồ sơ NL mặc định`);
  }
  return { full: 'Daan de Vries', street: 'Kerkstraat 42', city: 'Amsterdam', postcode: '1012 AB' };
}

const asLoc = (sel: string) => (sel.startsWith('//') ? `xpath=${sel}` : sel);

/** Tìm locator hiển thị đầu tiên khớp `selectors` trong MỌI frame (Stripe checkout
 *  nằm trong iframe checkout.stripe.com). Poll tới `timeout`. Trả null nếu hết giờ. */
async function locateInFrames(page: Page, selectors: string[], timeout = 20_000): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        const loc = frame.locator(asLoc(sel)).filter({ visible: true }).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

/** Như locateInFrames nhưng tìm input theo NHÃN (getByLabel/role=textbox) trước,
 *  rồi mới tới fallback CSS — cho các ô "typeable label" (Email/Password/Full name/Age). */
async function locateLabelInFrames(page: Page, labelRe: RegExp, fallback: string[], timeout = 20_000): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      // CHỈ nhận input/textarea/select — getByLabel có thể khớp cả <form> có
      // aria-labelledby (vd form "password") → fill() lỗi "not an <input>".
      const control = frame.locator('input, textarea, select');
      const byLabel = control.and(frame.getByLabel(labelRe)).filter({ visible: true }).first();
      if (await byLabel.isVisible().catch(() => false)) return byLabel;
      const byRole = frame.getByRole('textbox', { name: labelRe }).filter({ visible: true }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;
    }
    const cssHit = await locateInFrames(page, fallback, 1_000);
    if (cssHit) return cssHit;
    await page.waitForTimeout(400);
  }
  return null;
}

async function clickLoc(loc: Locator, log: FlowLog, label: string): Promise<void> {
  try {
    await loc.click({ timeout: 8_000 });
  } catch (err) {
    log.warn(`${label}: click lỗi (${(err as Error).message.split('\n')[0]}) — thử dispatchEvent`);
    await loc.dispatchEvent('click').catch(() => {});
  }
  log.info(`bấm ${label}`);
}

/** Điền first-match trong frames; trả false nếu không tìm thấy (không ném). */
async function fillInFrames(page: Page, selectors: string[], value: string, log: FlowLog, label: string, timeout = 12_000): Promise<boolean> {
  const loc = await locateInFrames(page, selectors, timeout);
  if (!loc) { log.warn(`không thấy ô "${label}" (bỏ qua)`); return false; }
  await loc.fill(value).catch(async () => { await loc.click().catch(() => {}); });
  log.info(`điền ${label}`);
  return true;
}

/** Chờ (mọi tab) một page có URL khớp regex — cho checkout mở tab mới hoặc điều
 *  hướng cùng tab. Trả page khớp, hoặc null nếu hết giờ. */
async function waitPageWithUrl(context: BrowserContext, re: RegExp, timeout = 45_000): Promise<Page | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (!p.isClosed() && re.test(p.url())) return p;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Cuộn listbox quốc gia (radix Select ẢO HOÁ) xuống 1 bước + trả text option
 *  cuối để phát hiện chạm đáy. Scroller là phần tử có scroll BÊN TRONG
 *  [role=listbox] (thực tế div.no-scrollbar). Cuộn container nội bộ này nên popper
 *  KHÔNG đóng. (globalThis as any) vì tsconfig không bật lib DOM. */
async function scrollListboxStep(page: Page): Promise<{ atBottom: boolean; last: string }> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const lb = doc?.querySelector('[role="listbox"]');
    if (!lb) return { atBottom: true, last: '' };
    let sc: any = null;
    for (const e of lb.querySelectorAll('*')) { if (e.scrollHeight > e.clientHeight + 20) { sc = e; break; } }
    if (!sc) return { atBottom: true, last: '' };
    sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(200, Math.floor(sc.clientHeight * 0.8)));
    const opts = doc.querySelectorAll('[role="option"]');
    const last = opts.length ? String(opts[opts.length - 1].textContent || '').trim() : '';
    return { atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2, last };
  });
}
async function resetListboxTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const lb = doc?.querySelector('[role="listbox"]');
    if (!lb) return;
    for (const e of lb.querySelectorAll('*')) { if (e.scrollHeight > e.clientHeight + 20) { e.scrollTop = 0; break; } }
  });
}

/** Chọn quốc gia trong combobox bảng giá ChatGPT (radix Select ảo hoá): option là
 *  div[role=option] chứa <span>Tên</span> trong div.no-scrollbar thuộc [role=listbox].
 *  Mở → cuộn container nội bộ từ đầu, quét tới khi option render ra rồi CLICK NATIVE.
 *  Verify + thử 2 lần. Dropdown CHỈ render đúng khi profile TẮT geoip + language
 *  'real' (không set locale:region — xem header): có locale:region thì Camoufox
 *  spoof Intl.DisplayNames lỗi, mọi option cùng 1 nước. UI khi đó là en-US nên tên
 *  hiện "Netherlands"; vẫn khớp thêm "Hà Lan" cho chắc. */
async function selectCountry(page: Page, target: string, profileName: string, log: FlowLog): Promise<boolean> {
  // Tên nước hiển thị theo ngôn ngữ UI (theo IP) → khớp cả tên Anh lẫn Việt.
  const COUNTRY_ALIASES: Record<string, string[]> = { Netherlands: ['Netherlands', 'Hà Lan'] };
  const names = COUNTRY_ALIASES[target] ?? [target];
  const optSel = [`//*[@role='option'][${names.map((n) => `normalize-space()='${n}'`).join(' or ')}]`];
  const matches = (s: string): boolean => names.some((n) => s.toLowerCase().includes(n.toLowerCase()));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const trigger = await locateInFrames(page, ['button[role="combobox"]'], 10_000);
    if (!trigger) { log.warn(`[${profileName}] không thấy combobox quốc gia`); return false; }
    const cur = (await trigger.innerText().catch(() => '')) || '';
    if (matches(cur)) { log.info(`[${profileName}] quốc gia đã là ${target}`); return true; }

    await clickLoc(trigger, log, 'combobox quốc gia');
    const listOpen = await locateInFrames(page, ['[role="listbox"] [role="option"]', '[role="option"]'], 6_000);
    if (!listOpen) { log.warn(`[${profileName}] dropdown quốc gia không mở`); await page.waitForTimeout(400); continue; }

    await resetListboxTop(page);
    await page.waitForTimeout(150);
    let opt = await locateInFrames(page, optSel, 300);
    let lastMarker = '';
    let stall = 0;
    for (let i = 0; i < 120 && !opt; i += 1) {
      const { atBottom, last } = await scrollListboxStep(page);
      await page.waitForTimeout(80);
      opt = await locateInFrames(page, optSel, 150);
      if (opt) break;
      if (last && last === lastMarker) { stall += 1; if (stall >= 3) break; }
      else { stall = 0; lastMarker = last; }
      if (atBottom) { opt = await locateInFrames(page, optSel, 250); break; }
    }

    if (opt) {
      await clickLoc(opt, log, `quốc gia ${target}`);
    } else {
      log.warn(`[${profileName}] cuộn hết list vẫn không thấy "${target}" (option cuối: "${lastMarker}")`);
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(800);

    const t2 = await locateInFrames(page, ['button[role="combobox"]'], 3_000);
    const txt = t2 ? ((await t2.innerText().catch(() => '')) || '') : '';
    if (matches(txt)) { log.info(`[${profileName}] đã đổi quốc gia → ${target}`); return true; }
    log.warn(`[${profileName}] chưa chọn được ${target} (đang: "${txt.trim()}") — thử lại (${attempt}/2)`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
  await snapshotPage(page, `chatgpt-country-fail-${profileName}`);
  return false;
}

async function warnBlockers(page: Page, log: FlowLog, profileName: string): Promise<void> {
  const html = (await page.content().catch(() => '')).toLowerCase();
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (html.includes('turnstile') || html.includes('challenges.cloudflare.com') || html.includes('funcaptcha') || html.includes('arkoselabs')) {
    log.warn(`[${profileName}] phát hiện captcha (Turnstile/Arkose) — flow không tự giải`);
    await snapshotPage(page, `chatgpt-captcha-${profileName}`);
  }
  if (body.includes('verify your phone') || body.includes('phone number') || body.includes('enter your phone')) {
    log.warn(`[${profileName}] OpenAI hỏi SỐ ĐIỆN THOẠI — ngoài phạm vi API mail SmsBower`);
    await snapshotPage(page, `chatgpt-phone-${profileName}`);
  }
}

export const chatgptSignupFlow: RegisteredFlow = {
  meta: {
    name: 'chatgpt-signup',
    label: 'ChatGPT — đăng ký (gmail SmsBower) + lên Plus qua iDEAL',
    description:
      'auth.openai.com: Sign up → email (gmail thuê) → mật khẩu → code (retry nếu Incorrect) → tên/tuổi → Finish → ' +
      'promo #pricing → Netherlands → chọn gói Plus → iDEAL + billing NL (randomuser) → Subscribe → bắt link pay.ideal.nl.',
  },
  run: async ({ helper, page, rentMail, report, profile, log }) => {
    const context = page.context();

    // === Bước 1: THUÊ gmail SmsBower TRƯỚC (cần địa chỉ để điền form). ===
    const mailbox = await rentMail();
    log.info(`[${profile.name}] gmail thuê: ${mailbox.email} (mailId=${mailbox.mailId})`);

    let finalized = false;
    try {
      // === A. ĐĂNG KÝ ===
      // Bước 1: entry → chờ chuyển sang auth.openai.com.
      await helper.goto('https://chatgpt.com/auth/login_with?callback_path=/');
      await page.waitForURL(/auth\.openai\.com/, { timeout: 30_000 }).catch(() => {});
      await warnBlockers(page, log, profile.name);
      await snapshotPage(page, `chatgpt-01-login-${profile.name}`);

      // Bước 2: "Sign up" (a[href="/create-account"]).
      const signup = await locateInFrames(page, ['a[href="/create-account"]', '//a[normalize-space()="Sign up"]'], 15_000);
      if (signup) await clickLoc(signup, log, 'Sign up');

      // Bước 2b-3: điền email (gmail thuê) → Continue. Bắt input bằng CSS type/id
      // (bulletproof) thay vì getByLabel (tránh khớp nhầm <form>).
      const emailInput = await locateInFrames(page, SEL_EMAIL, 20_000);
      if (!emailInput) { await snapshotPage(page, `chatgpt-no-email-${profile.name}`); throw new Error('Không thấy ô email — xem ảnh chatgpt-no-email'); }
      await emailInput.fill(mailbox.email);
      log.info(`[${profile.name}] điền email`);
      await helper.pace();
      const contEmail = await locateInFrames(page, BTN_EMAIL_CONTINUE, 8_000);
      if (contEmail) await clickLoc(contEmail, log, 'Continue (sau email)');
      await page.waitForTimeout(1_500);
      await warnBlockers(page, log, profile.name);

      // Bước 4: "Continue with password" (màn chọn cách đăng nhập, nếu có).
      const withPass = await locateInFrames(page, LINK_CONTINUE_PASSWORD, 8_000);
      if (withPass) { await clickLoc(withPass, log, 'Continue with password'); await page.waitForTimeout(1_200); }

      // === Bước 5-7: mật khẩu → TREO SmsBower → Continue → bắt mã ===
      // MẤU CHỐT: OpenAI gửi mã xác minh ĐÚNG LÚC bấm "Continue" (sau mật khẩu).
      // Theo cách chạy tay: cho SmsBower "TREO" (bắt đầu poll getCode) NGAY TRƯỚC khi
      // bấm Continue, để poll đang chờ bắt ĐÚNG mã mới đó. Nếu poll SAU khi bấm
      // (như trước) sẽ vớ phải mã lệch (vd 530671) rồi activation 'dr' khoá cứng
      // (available_to_get_next_code=false) → hỏng cả lượt.
      const passInput = await locateInFrames(page, SEL_PASSWORD, 15_000);
      if (!passInput) { await snapshotPage(page, `chatgpt-no-pass-${profile.name}`); throw new Error('Không thấy ô mật khẩu — xem ảnh chatgpt-no-pass'); }
      await passInput.fill(PASSWORD);
      log.info(`[${profile.name}] điền mật khẩu — treo SmsBower rồi bấm Continue`);
      await helper.pace();
      // 1) TREO: bắt đầu poll getCode NGAY (chưa await) — SmsBower "chờ sẵn".
      const codePromise = mailbox.waitCode({ intervalMs: 3_000, tries: 60 });
      // 2) Bấm Continue (submit mật khẩu) → OpenAI gửi mã đúng lúc này → poll bắt được.
      const contPass = await locateInFrames(page, BTN_SUBMIT, 8_000);
      if (contPass) await clickLoc(contPass, log, 'Continue (sau mật khẩu)');
      await warnBlockers(page, log, profile.name);
      // 3) Chờ ô code hiện + lấy mã mà poll (treo) đã bắt.
      const codeReady = await locateInFrames(page, SEL_CODE, 30_000);
      if (!codeReady) { await snapshotPage(page, `chatgpt-no-code-${profile.name}`); throw new Error('Không thấy ô nhập code — xem ảnh chatgpt-no-code'); }
      let code = await codePromise;
      log.info(`[${profile.name}] nhận mã: ${code}`);

      let passed = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const inp = await locateInFrames(page, SEL_CODE, 8_000);
        if (inp) {
          await inp.fill('').catch(() => {});
          try { await inp.fill(code); } catch { await inp.click().catch(() => {}); await helper.typeKeys(code); }
        }
        log.info(`[${profile.name}] nhập code (lần ${attempt}): ${code}`);
        await helper.pace();
        const validate = await locateInFrames(page, BTN_VALIDATE, 6_000);
        if (validate) await clickLoc(validate, log, 'Continue (validate code)');
        await page.waitForTimeout(2_500);
        await warnBlockers(page, log, profile.name);
        // Qua được? → hiện "Full name".
        if (await locateLabelInFrames(page, /full name/i, SEL_NAME, 6_000)) { passed = true; break; }
        if (attempt >= 3) break;
        // Mã sai → nextCode trả MÃ KHÁC chưa thử từ all_codes của mail batch
        // (OpenAI gửi 2-3 mã; đọc lại được, KHÔNG cần request lại). Thử tới khi hết mã.
        const incorrect = await locateInFrames(page, ['input[name="code"][aria-invalid="true"]', "//*[contains(normalize-space(),'Incorrect code')]"], 2_500);
        log.warn(`[${profile.name}] code ${code}${incorrect ? ' bị Incorrect' : ' chưa qua'} — thử mã khác trong hòm`);
        code = await mailbox.nextCode({ tries: 24, intervalMs: 3_000 });
      }
      await snapshotPage(page, `chatgpt-02-after-code-${profile.name}`);
      const nameLoc = await locateLabelInFrames(page, /full name|name/i, SEL_NAME, 15_000);
      if (!passed && !nameLoc) { await snapshotPage(page, `chatgpt-code-stuck-${profile.name}`); throw new Error('Không qua được bước code (sai mã / SĐT / captcha) — xem ảnh'); }
      await mailbox.success();
      finalized = true;

      // === Bước 8: Full name + Age (random) ===
      const fullName = randomVietnameseName();
      if (nameLoc) { await nameLoc.fill(fullName); log.info(`[${profile.name}] Full name: ${fullName}`); }
      await helper.pace();
      const age = randInt(20, 45);
      const ageLoc = await locateLabelInFrames(page, /^age$|age/i, SEL_AGE, 8_000);
      if (ageLoc) { await ageLoc.fill(String(age)); log.info(`[${profile.name}] Age: ${age}`); }
      await helper.pace();

      // Bước 9: "Finish creating account" (nút submit của form tên/tuổi).
      const finish = await locateInFrames(page, ['//button[@type="submit"][contains(.,"Finish")]', 'button[type="submit"]'], 10_000);
      if (finish) await clickLoc(finish, log, 'Finish creating account');
      await page.waitForTimeout(2_500);
      await warnBlockers(page, log, profile.name);

      // Bước 10: chờ về chatgpt.com; sau 2-3s hiện màn chào "Continue" (btn-primary
      // btn-large). Bấm lặp tới khi hết rồi mới sang link khuyến mãi.
      await page.waitForURL(/chatgpt\.com/, { timeout: 30_000 }).catch(() => {});
      let continues = 0;
      for (let i = 0; i < 5; i += 1) {
        const cont = await locateInFrames(
          page,
          ['//button[contains(@class,"btn-primary")][.//div[normalize-space()="Continue"]]', '//button[.//div[normalize-space()="Continue"]]'],
          i === 0 ? 12_000 : 3_500,
        );
        if (!cont) break;
        await clickLoc(cont, log, `Continue (màn chào ${i + 1})`);
        continues += 1;
        await page.waitForTimeout(2_000);
        await warnBlockers(page, log, profile.name);
      }
      log.info(`[${profile.name}] đã qua ${continues} màn "Continue"; tài khoản: ${mailbox.email} | ${PASSWORD}`);
      await snapshotPage(page, `chatgpt-03-account-done-${profile.name}`);

      // === B. LÊN PLUS ===
      // Bước 11: mở link khuyến mãi (#pricing bắt buộc để bung bảng giá).
      await helper.goto('https://chatgpt.com/?promo_campaign=plus-1-month-free#pricing');
      await page.waitForTimeout(2_500);
      await warnBlockers(page, log, profile.name);

      // Bước 12: đổi quốc gia (combobox bảng giá) sang Netherlands cho region EUR/
      // iDEAL. Chạy được là nhờ profile TẮT geoip + language 'real' (không set
      // locale:region — xem header) nên Intl.DisplayNames đúng, dropdown render đúng
      // tên nước; selectCountry cuộn + chọn đúng Netherlands.
      await selectCountry(page, 'Netherlands', profile.name, log);
      await page.waitForTimeout(1_000);
      await snapshotPage(page, `chatgpt-04-plan-${profile.name}`);

      // Bước 13: (log nếu có "LIMITED TIME") → bấm nút chọn gói Plus. data-testid
      // ổn định, dùng chung cho "Upgrade to Plus" và "Claim free offer".
      if (await locateInFrames(page, ["//*[contains(normalize-space(),'LIMITED TIME')]"], 2_500)) {
        log.info(`[${profile.name}] thấy "LIMITED TIME"`);
      }
      const upgrade = await locateInFrames(
        page,
        ['[data-testid="select-plan-button-plus-upgrade"]', "//button[.//div[contains(.,'Claim') or contains(.,'Upgrade')]]"],
        15_000,
      );
      if (!upgrade) { await snapshotPage(page, `chatgpt-no-upgrade-${profile.name}`); throw new Error('Không thấy nút chọn gói Plus — xem ảnh chatgpt-no-upgrade'); }
      await clickLoc(upgrade, log, 'chọn gói Plus');

      // === C. THANH TOÁN iDEAL ===
      // Bước 14: chờ checkout (chatgpt.com/checkout hoặc checkout.stripe.com).
      const checkoutPage = (await waitPageWithUrl(context, /\/checkout\/|checkout\.stripe\.com/, 45_000)) ?? page;
      const checkoutUrl = checkoutPage.url();
      log.info(`[${profile.name}] checkout: ${checkoutUrl}`);
      report({ checkoutUrl, status: 'checkout' });
      await checkoutPage.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
      await checkoutPage.waitForTimeout(2_500);
      await snapshotPage(checkoutPage, `chatgpt-05-checkout-${profile.name}`);

      // Bọc riêng: lỗi phần thanh toán KHÔNG huỷ thành công tạo tài khoản.
      try {
        // Bước 14b: chọn phương thức iDEAL ("iDEAL" là brand, không theo ngôn ngữ).
        // Ưu tiên phần tử BẤM ĐƯỢC (radio/tab/button/label) chứa "iDEAL" — node text
        // chung chỉ là fallback (bấm vào div bọc có khi không đổi tab). Sau khi chọn,
        // panel iDEAL (ô Name + billing) render TRỄ → chờ 2-3s cho nó hiện (user dặn)
        // rồi mới điền, nếu không sẽ không thấy ô Name → Subscribe báo lỗi "Name...".
        const idealTab = await locateInFrames(
          checkoutPage,
          [
            "//*[@role='radio'][contains(normalize-space(),'iDEAL')]",
            "//*[@role='tab'][contains(normalize-space(),'iDEAL')]",
            "//button[contains(normalize-space(),'iDEAL')]",
            "//label[contains(normalize-space(),'iDEAL')]",
            "//*[contains(normalize-space(),'iDEAL')]",
          ],
          15_000,
        );
        if (idealTab) await clickLoc(idealTab, log, 'phương thức iDEAL');
        await checkoutPage.waitForTimeout(randInt(2_500, 3_200));

        // Bước 15-18: billing Hà Lan (randomuser.me).
        const nl = await fetchDutchProfile(log);
        log.info(`[${profile.name}] billing NL: ${nl.full} · ${nl.street} · ${nl.city} ${nl.postcode}`);
        // Ô "Name" của iDEAL (Stripe) validate cần >= 3 ký tự → PHẢI điền tên đầy đủ.
        // Field render TRỄ nên tìm theo NHÃN /name/i (getByLabel, bất kể id) TRƯỚC +
        // nhiều id/name/autocomplete fallback, chờ 12s. nl.full luôn >= 3 ký tự.
        const nameLoc = await locateLabelInFrames(
          checkoutPage,
          /name/i,
          [
            '#payment-nameInput',
            '#billingAddress-nameInput',
            '#billingName',
            'input[autocomplete="name"]',
            'input[autocomplete="cc-name"]',
            'input[name="name"]',
            'input[name="billingName"]',
          ],
          12_000,
        );
        if (nameLoc) {
          await nameLoc.fill(nl.full).catch(() => {});
          await nameLoc.blur().catch(() => {});
          log.info(`[${profile.name}] điền tên iDEAL: ${nl.full}`);
        } else {
          log.warn(`[${profile.name}] KHÔNG thấy ô Name — Subscribe có thể báo "Name must be at least 3 characters"`);
        }
        // Phòng khi có ô billing name RIÊNG (khác ô account name ở trên) — best-effort.
        await fillInFrames(checkoutPage, ['#billingAddress-nameInput', 'input[name="billingName"]'], nl.full, log, 'billing name', 3_000);
        // Quốc gia billing = Netherlands (select native, value="NL").
        const countrySel = await locateInFrames(checkoutPage, ['#billingAddress-countryInput', 'select[name="country"]'], 8_000);
        if (countrySel) { await countrySel.selectOption('NL').catch(() => {}); log.info(`[${profile.name}] billing country=NL`); }
        await checkoutPage.waitForTimeout(800);
        // Địa chỉ/mã bưu/thành phố — best-effort (iDEAL đôi khi không bắt buộc đủ).
        const addr = await locateInFrames(checkoutPage, ['#billingAddress-addressLine1Input', 'input[name="addressLine1"]'], 5_000);
        if (addr) { await addr.fill(nl.street).catch(() => {}); await checkoutPage.keyboard.press('Escape').catch(() => {}); log.info(`[${profile.name}] điền địa chỉ`); }
        await fillInFrames(checkoutPage, ['#billingAddress-postalCodeInput', 'input[name="postalCode"]'], nl.postcode, log, 'postal code');
        await fillInFrames(checkoutPage, ['#billingAddress-localityInput', 'input[name="locality"]'], nl.city, log, 'city');
        await snapshotPage(checkoutPage, `chatgpt-06-billing-${profile.name}`);

        // Bước 18b: "Subscribe" (aria-label ổn định).
        const subscribe = await locateInFrames(
          checkoutPage,
          ['button[aria-label="Subscribe"]', "//button[.//span[normalize-space()='Subscribe']]", "//button[contains(.,'Subscribe')]"],
          10_000,
        );
        if (!subscribe) throw new Error('Không thấy nút "Subscribe" trên checkout');
        await checkoutPage.waitForTimeout(randInt(1_500, 3_000));
        await clickLoc(subscribe, log, 'Subscribe');

        // Bước 19: BẮT link cổng iDEAL. Stripe iDEAL điều hướng qua NHIỀU chặng
        // (checkout.stripe.com → hooks.stripe.com/redirect → trang iDEAL/bank), tab
        // mới HOẶC cùng tab. Regex cũ chỉ khớp pay.ideal.nl|pay.nl nên hay "không ra
        // link". Giờ QUÉT RỘNG + LOG MỌI URL để biết cổng thật, và dò thông báo từ
        // chối/lỗi. Lưu ý: "Due today €0.00" có thể hoàn tất KHÔNG cần redirect iDEAL
        // (không có gì để thu ngay) → khi đó "không ra link" là ĐÚNG, không phải bug.
        // Còn nếu bị chặn (declined/blocked) thì phải đổi IP sạch/fingerprint/giãn
        // thời gian (theo anti-fraud-research: probe tag theo IP, IP "cháy" sau ~4-5 lần).
        const PAY_RE = /pay\.ideal\.nl|pay\.nl\/|\.ideal\.nl|hooks\.stripe\.com\/redirect|idealpayment|ideal-issuer/i;
        // "declined/rejected" = Stripe chặn rủi ro (fraud), KHÔNG phải lỗi form. Text
        // thường nằm TRONG iframe Stripe nên phải quét mọi frame.
        const DECLINE_KEYS = ['declined', 'was declined', 'card was declined', 'payment failed', 'was rejected', 'try a different payment', 'bị từ chối', 'thanh toán thất bại'];
        const seenUrls = new Set<string>();
        let idealUrl = '';
        let declineMsg = '';
        const payDeadline = Date.now() + 45_000;
        let tick = 0;
        while (Date.now() < payDeadline && !idealUrl && !declineMsg) {
          for (const p of context.pages()) {
            if (p.isClosed()) continue;
            const u = p.url();
            if (u && u !== 'about:blank' && !seenUrls.has(u)) {
              seenUrls.add(u);
              log.info(`[${profile.name}] URL sau Subscribe: ${u}`);
            }
            if (u && PAY_RE.test(u)) { idealUrl = u; break; }
          }
          if (idealUrl) break;
          // Dò "declined" trên MỌI frame (~mỗi 2s) để thoát sớm + báo đúng nguyên nhân.
          if (tick % 5 === 0) {
            let txt = '';
            for (const f of checkoutPage.frames()) txt += ' ' + (await f.locator('body').innerText().catch(() => ''));
            txt = txt.toLowerCase();
            declineMsg = DECLINE_KEYS.find((k) => txt.includes(k)) ?? '';
          }
          tick += 1;
          if (!idealUrl && !declineMsg) await new Promise((r) => setTimeout(r, 400));
        }
        const urls = [...seenUrls].join(' | ') || '(URL không đổi)';
        if (idealUrl) {
          report({ checkoutUrl: idealUrl, status: 'ideal-link' });
          log.info(`[${profile.name}] LINK iDEAL: ${idealUrl}`);
          const hit = context.pages().find((p) => !p.isClosed() && p.url() === idealUrl);
          if (hit) await snapshotPage(hit, `chatgpt-07-ideal-${profile.name}`).catch(() => {});
        } else if (declineMsg) {
          // Thanh toán bị từ chối = Stripe chặn RỦI RO, không sửa bằng selector được.
          // Nguyên nhân chính: (1) IP xoay giữa chừng (proxy 1'/lần, flow ~3' → tạo
          // tài khoản 1 IP, trả tiền IP khác → Stripe coi gian lận); (2) IP Việt Nam
          // nhưng iDEAL + billing Hà Lan (lệch vùng). Cần IP ỔN ĐỊNH cả phiên + đúng vùng.
          log.warn(`[${profile.name}] THANH TOÁN BỊ TỪ CHỐI ("${declineMsg}") — Stripe chặn rủi ro/fraud, KHÔNG phải lỗi flow. Cần IP ổn định suốt phiên (sticky, đừng xoay 1'/lần) + đúng vùng iDEAL (NL/EU). URL: ${urls}`);
          report({ status: 'payment-declined' });
          await snapshotPage(checkoutPage, `chatgpt-07-declined-${profile.name}`).catch(() => {});
        } else {
          log.warn(`[${profile.name}] chưa bắt được link cổng iDEAL sau 45s (có thể €0 nên không redirect, hoặc URL cổng khác dự kiến). URL đã thấy: ${urls}`);
          report({ status: 'subscribe-clicked' });
          await snapshotPage(checkoutPage, `chatgpt-07-after-subscribe-${profile.name}`).catch(() => {});
        }
      } catch (payErr) {
        log.warn(`[${profile.name}] phần thanh toán lỗi: ${(payErr as Error).message}`);
        await snapshotPage(checkoutPage, `chatgpt-pay-error-${profile.name}`).catch(() => {});
        report({ status: 'signup-ok-pay-failed' });
      }
    } catch (err) {
      // Chưa chốt SmsBower (chưa dùng được code) → huỷ để hoàn tiền.
      if (!finalized) await mailbox.cancel();
      await helper.screenshot(`chatgpt-error-${profile.name}`).catch(() => {});
      throw err;
    }
  },
};
