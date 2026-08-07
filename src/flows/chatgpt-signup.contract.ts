/**
 * ĐẶC TẢ BẰNG CODE — flow `chatgpt-signup`.
 *
 * File này là bản mô tả máy đọc được của trình tự đăng ký ChatGPT + lên Plus qua
 * iDEAL, dùng để bàn giao cho người implement lại ở stack khác. Bản văn xuôi kèm
 * sơ đồ nằm ở `docs/flow-chatgpt-signup.md`.
 *
 * VÌ SAO LÀ CODE CHỨ KHÔNG PHẢI TÀI LIỆU:
 * selector và mật khẩu ở đây được `import` THẲNG từ flow đang chạy, không chép
 * lại. Đổi selector trong flow là đặc tả đổi theo — không có chuyện tài liệu nói
 * một đằng code chạy một nẻo. `chatgpt-signup.contract.test.ts` khoá thêm các
 * ràng buộc còn lại (thứ tự bước, trạng thái báo về, bất biến).
 *
 * File này KHÔNG chạy gì cả — chỉ là dữ liệu.
 */

import {
  SEL_EMAIL,
  BTN_EMAIL_CONTINUE,
  LINK_CONTINUE_PASSWORD,
  SEL_PASSWORD,
  BTN_SUBMIT,
  BTN_VALIDATE,
  SEL_CODE,
  SEL_NAME,
  SEL_AGE,
  PASSWORD,
} from './chatgpt-signup.js';

// ---------------------------------------------------------------------------
// Kiểu
// ---------------------------------------------------------------------------

/** Giai đoạn. Lỗi ở `payment` KHÔNG huỷ kết quả của `signup`. */
export type Phase = 'signup' | 'upgrade' | 'payment';

/** Khi không tìm thấy phần tử thì làm gì.
 *  - `throw`: dừng lượt, chụp ảnh, hoàn tiền số nếu chưa chốt.
 *  - `skip` : đi tiếp — màn đó không phải lúc nào cũng xuất hiện. */
export type OnMissing = 'throw' | 'skip';

export type Action =
  | { kind: 'goto'; url: string }
  | { kind: 'waitUrl'; pattern: string }
  | { kind: 'click'; selectors: readonly string[] }
  | { kind: 'fill'; selectors: readonly string[]; value: string }
  | { kind: 'selectCountry'; value: string }
  | { kind: 'custom'; describe: string };

export interface Step {
  /** Định danh ổn định, dùng để tham chiếu trong `ORDERING`. */
  id: string;
  phase: Phase;
  /** Mô tả cho người đọc. */
  title: string;
  action: Action;
  /** Trần chờ phần tử, ms. */
  timeoutMs: number;
  onMissing: OnMissing;
  /** Ảnh chụp khi bước này hỏng — tên file trong `<STORE_ROOT>/shots/`. */
  shotOnFail?: string;
  /** Số lần thử tối đa (mặc định 1). */
  maxAttempts?: number;
  notes?: string;
}

/** Ràng buộc thứ tự KHÔNG suy ra được từ danh sách bước. Sai là hỏng lượt. */
export interface Ordering {
  before: string;
  after: string;
  /** Vì sao bắt buộc đúng thứ tự này. */
  why: string;
}

export interface ReportStatus {
  status: string;
  phase: Phase;
  terminal: boolean;
  meaning: string;
  /** `true` = kết quả chấp nhận được, không phải lỗi cần sửa. */
  acceptable: boolean;
}

// ---------------------------------------------------------------------------
// Hằng số
// ---------------------------------------------------------------------------

export const ENTRY_URL = 'https://chatgpt.com/auth/login_with?callback_path=/';
export const PROMO_URL = 'https://chatgpt.com/?promo_campaign=plus-1-month-free#pricing';

/** `#pricing` BẮT BUỘC — thiếu thì bảng giá không bung, không có nút chọn gói. */
export const PROMO_REQUIRES_PRICING_HASH = true;

export const BILLING_COUNTRY = 'Netherlands';
export const BILLING_COUNTRY_CODE = 'NL';
export const BILLING_SOURCE = 'https://randomuser.me/api/?nat=nl';

/** Ô "Name" của Stripe validate độ dài tối thiểu — điền tên đầy đủ, không phải tên lót. */
export const IDEAL_NAME_MIN_LENGTH = 3;

export const AGE_RANGE = { min: 20, max: 45 } as const;

/** Mật khẩu cố định cho mọi tài khoản. Lấy từ flow, không chép lại. */
export const ACCOUNT_PASSWORD = PASSWORD;

export const TIMING = {
  /** Poll SmsBower lấy mã đầu tiên. */
  waitCode: { tries: 60, intervalMs: 3_000 },
  /** Poll lấy mã kế tiếp khi mã trước bị Incorrect. */
  nextCode: { tries: 24, intervalMs: 3_000 },
  /** Số lần nhập lại mã OTP. */
  codeAttempts: 3,
  /** Số màn chào "Continue" bấm tối đa sau khi tạo xong tài khoản. */
  welcomeContinues: 5,
  /** Chờ tab checkout xuất hiện. */
  checkoutWaitMs: 45_000,
  /** Panel iDEAL render TRỄ sau khi chọn phương thức — chờ trước khi điền. */
  idealPanelDelayMs: { min: 2_500, max: 3_200 },
  /** Quét mọi tab tìm link cổng iDEAL sau khi bấm Subscribe. */
  idealLinkScanMs: 45_000,
} as const;

/** Anti-detect RIÊNG cho flow này, khác mặc định của mọi flow khác. */
export const ANTI_DETECT_OVERRIDE = {
  geoip: false,
  language: 'real',
  why:
    'Bảng giá ChatGPT render tên quốc gia bằng Intl.DisplayNames. Ép locale theo IP '
    + 'proxy làm tên nước hiển thị sai → không chọn được Netherlands. Đánh đổi: '
    + 'timezone/geolocation không còn khớp IP proxy.',
} as const;

/** Điều kiện hạ tầng. Không thoả thì flow chạy nhưng thất bại ở bước thanh toán. */
export const PRECONDITIONS = [
  {
    id: 'sticky-proxy',
    requirement: 'Proxy giữ NGUYÊN IP suốt phiên (~3 phút), không xoay giữa chừng',
    why:
      'Tạo tài khoản một IP rồi trả tiền IP khác → Stripe coi là gian lận và từ chối. '
      + 'Proxy xoay 1 phút/lần chắc chắn dính.',
    violationSymptom: 'payment-declined',
  },
  {
    id: 'eu-region-ip',
    requirement: 'IP thuộc vùng NL/EU',
    why: 'IP Việt Nam nhưng iDEAL + billing Hà Lan là lệch vùng, Stripe chặn.',
    violationSymptom: 'payment-declined',
  },
  {
    id: 'smsbower-key',
    requirement: 'API key SmsBower + mã service (mặc định "dr" = OpenAI/ChatGPT)',
    why: 'Không thuê được gmail thì flow chết ngay bước 0.',
    violationSymptom: 'throw trước khi tốn tiền',
  },
] as const;

// ---------------------------------------------------------------------------
// Trình tự
// ---------------------------------------------------------------------------

export const STEPS: readonly Step[] = [
  // --- A. Đăng ký ---------------------------------------------------------
  {
    id: 'rent-mail',
    phase: 'signup',
    title: 'Thuê gmail SmsBower',
    action: { kind: 'custom', describe: 'rentMail() → { email, mailId, waitCode, nextCode, success, cancel }' },
    timeoutMs: 0,
    onMissing: 'throw',
    notes: 'Phải làm TRƯỚC vì cần địa chỉ để điền form. Hỏng ở đây chưa tốn tiền.',
  },
  {
    id: 'open-entry',
    phase: 'signup',
    title: 'Mở trang đăng nhập',
    action: { kind: 'goto', url: ENTRY_URL },
    timeoutMs: 30_000,
    onMissing: 'skip',
    notes: 'Sau đó chờ URL chuyển sang auth.openai.com; hết giờ vẫn đi tiếp.',
  },
  {
    id: 'click-signup',
    phase: 'signup',
    title: 'Bấm "Sign up"',
    action: { kind: 'click', selectors: ['a[href="/create-account"]', '//a[normalize-space()="Sign up"]'] },
    timeoutMs: 15_000,
    onMissing: 'skip',
  },
  {
    id: 'fill-email',
    phase: 'signup',
    title: 'Điền email đã thuê',
    action: { kind: 'fill', selectors: SEL_EMAIL, value: '<mailbox.email>' },
    timeoutMs: 20_000,
    onMissing: 'throw',
    shotOnFail: 'chatgpt-no-email',
  },
  {
    id: 'submit-email',
    phase: 'signup',
    title: 'Continue sau email',
    action: { kind: 'click', selectors: BTN_EMAIL_CONTINUE },
    timeoutMs: 8_000,
    onMissing: 'skip',
  },
  {
    id: 'choose-password-method',
    phase: 'signup',
    title: 'Bấm "Continue with password"',
    action: { kind: 'click', selectors: LINK_CONTINUE_PASSWORD },
    timeoutMs: 8_000,
    onMissing: 'skip',
    notes: 'Màn chọn cách đăng nhập không phải lúc nào cũng hiện.',
  },
  {
    id: 'fill-password',
    phase: 'signup',
    title: 'Điền mật khẩu',
    action: { kind: 'fill', selectors: SEL_PASSWORD, value: ACCOUNT_PASSWORD },
    timeoutMs: 15_000,
    onMissing: 'throw',
    shotOnFail: 'chatgpt-no-pass',
  },
  {
    id: 'arm-code-poll',
    phase: 'signup',
    title: 'TREO poll SmsBower (chưa await)',
    action: { kind: 'custom', describe: 'const codePromise = mailbox.waitCode(TIMING.waitCode)  // KHÔNG await' },
    timeoutMs: 0,
    onMissing: 'throw',
    notes: 'Xem ORDERING: bắt buộc chạy TRƯỚC submit-password.',
  },
  {
    id: 'submit-password',
    phase: 'signup',
    title: 'Continue sau mật khẩu → OpenAI gửi mã lúc này',
    action: { kind: 'click', selectors: BTN_SUBMIT },
    timeoutMs: 8_000,
    onMissing: 'skip',
  },
  {
    id: 'await-code-input',
    phase: 'signup',
    title: 'Chờ ô nhập mã hiện ra',
    action: { kind: 'custom', describe: 'chờ SEL_CODE rồi await codePromise' },
    timeoutMs: 30_000,
    onMissing: 'throw',
    shotOnFail: 'chatgpt-no-code',
  },
  {
    id: 'enter-code',
    phase: 'signup',
    title: 'Nhập mã OTP rồi validate',
    action: { kind: 'fill', selectors: SEL_CODE, value: '<code>' },
    timeoutMs: 8_000,
    onMissing: 'throw',
    maxAttempts: TIMING.codeAttempts,
    shotOnFail: 'chatgpt-code-stuck',
    notes:
      'Sai thì gọi nextCode() lấy mã KHÁC trong all_codes của cùng lượt thuê — OpenAI '
      + 'gửi 2-3 mã, đọc lại được, không tốn thêm request.',
  },
  {
    id: 'submit-code',
    phase: 'signup',
    title: 'Validate mã',
    action: { kind: 'click', selectors: BTN_VALIDATE },
    timeoutMs: 6_000,
    onMissing: 'skip',
    maxAttempts: TIMING.codeAttempts,
    notes:
      'Cùng vòng lặp với enter-code. Coi là QUA khi ô "Full name" xuất hiện; '
      + 'thấy aria-invalid="true" hoặc chữ "Incorrect code" thì lấy mã kế tiếp.',
  },
  {
    id: 'finalize-mail',
    phase: 'signup',
    title: 'mailbox.success() — chốt lượt thuê',
    action: { kind: 'custom', describe: 'mailbox.success(); finalized = true' },
    timeoutMs: 0,
    onMissing: 'throw',
    notes: 'Từ đây trở đi lỗi KHÔNG hoàn tiền số nữa. Xem MAIL_LIFECYCLE.',
  },
  {
    id: 'fill-name',
    phase: 'signup',
    title: 'Full name (tên Việt ngẫu nhiên)',
    action: { kind: 'fill', selectors: SEL_NAME, value: '<họ đệm tên ngẫu nhiên>' },
    timeoutMs: 15_000,
    onMissing: 'skip',
  },
  {
    id: 'fill-age',
    phase: 'signup',
    title: `Age (${AGE_RANGE.min}–${AGE_RANGE.max})`,
    action: { kind: 'fill', selectors: SEL_AGE, value: '<ngẫu nhiên>' },
    timeoutMs: 8_000,
    onMissing: 'skip',
  },
  {
    id: 'finish-account',
    phase: 'signup',
    title: 'Bấm "Finish creating account"',
    action: { kind: 'click', selectors: ['//button[@type="submit"][contains(.,"Finish")]', 'button[type="submit"]'] },
    timeoutMs: 10_000,
    onMissing: 'skip',
  },

  // --- B. Lên Plus --------------------------------------------------------
  {
    id: 'dismiss-welcome',
    phase: 'upgrade',
    title: 'Bấm hết các màn chào "Continue"',
    action: {
      kind: 'click',
      selectors: [
        '//button[contains(@class,"btn-primary")][.//div[normalize-space()="Continue"]]',
        '//button[.//div[normalize-space()="Continue"]]',
      ],
    },
    timeoutMs: 12_000,
    onMissing: 'skip',
    maxAttempts: TIMING.welcomeContinues,
    notes: 'Không bấm hết thì bảng giá bị che.',
  },
  {
    id: 'open-promo',
    phase: 'upgrade',
    title: 'Mở link khuyến mãi',
    action: { kind: 'goto', url: PROMO_URL },
    timeoutMs: 30_000,
    onMissing: 'skip',
  },
  {
    id: 'select-country',
    phase: 'upgrade',
    title: `Đổi quốc gia bảng giá → ${BILLING_COUNTRY}`,
    action: { kind: 'selectCountry', value: BILLING_COUNTRY },
    timeoutMs: 15_000,
    onMissing: 'skip',
    maxAttempts: 2,
    shotOnFail: 'chatgpt-country-fail',
    notes: 'Cần cuộn dropdown. Chỉ chạy được nhờ ANTI_DETECT_OVERRIDE.',
  },
  {
    id: 'select-plan',
    phase: 'upgrade',
    title: 'Chọn gói Plus',
    action: {
      kind: 'click',
      selectors: [
        '[data-testid="select-plan-button-plus-upgrade"]',
        "//button[.//div[contains(.,'Claim') or contains(.,'Upgrade')]]",
      ],
    },
    timeoutMs: 15_000,
    onMissing: 'throw',
    shotOnFail: 'chatgpt-no-upgrade',
    notes: 'data-testid dùng chung cho "Upgrade to Plus" lẫn "Claim free offer".',
  },

  // --- C. Thanh toán ------------------------------------------------------
  {
    id: 'await-checkout',
    phase: 'payment',
    title: 'Chờ tab checkout',
    action: { kind: 'waitUrl', pattern: '/checkout/|checkout\\.stripe\\.com' },
    timeoutMs: TIMING.checkoutWaitMs,
    onMissing: 'skip',
    notes:
      'Hết giờ thì lùi về DÙNG CHÍNH TAB HIỆN TẠI (`?? page`), không ném lỗi — '
      + 'Stripe đôi khi render checkout ngay trong tab cũ. '
      + 'Báo report({ checkoutUrl, status: "checkout" }) ngay khi có URL.',
  },
  {
    id: 'choose-ideal',
    phase: 'payment',
    title: 'Chọn phương thức iDEAL',
    action: {
      kind: 'click',
      selectors: [
        "//*[@role='radio'][contains(normalize-space(),'iDEAL')]",
        "//*[@role='tab'][contains(normalize-space(),'iDEAL')]",
        "//button[contains(normalize-space(),'iDEAL')]",
        "//label[contains(normalize-space(),'iDEAL')]",
        "//*[contains(normalize-space(),'iDEAL')]",
      ],
    },
    timeoutMs: 15_000,
    onMissing: 'skip',
    notes:
      'Ưu tiên phần tử BẤM ĐƯỢC; node text chung chỉ là fallback vì bấm div bọc '
      + 'nhiều khi không đổi tab. "iDEAL" là tên thương hiệu nên không đổi theo ngôn ngữ.',
  },
  {
    id: 'fill-ideal-name',
    phase: 'payment',
    title: 'Điền tên chủ tài khoản iDEAL',
    action: {
      kind: 'fill',
      selectors: [
        '#payment-nameInput',
        '#billingAddress-nameInput',
        '#billingName',
        'input[autocomplete="name"]',
        'input[autocomplete="cc-name"]',
        'input[name="name"]',
        'input[name="billingName"]',
      ],
      value: '<randomuser.me nat=nl, tên đầy đủ>',
    },
    timeoutMs: 12_000,
    onMissing: 'skip',
    notes:
      `Cần ≥ ${IDEAL_NAME_MIN_LENGTH} ký tự nếu không Subscribe báo "Name must be at least 3 characters". `
      + 'Ô render TRỄ → tìm theo NHÃN /name/i trước, id chỉ là fallback.',
  },
  {
    id: 'fill-billing',
    phase: 'payment',
    title: 'Điền địa chỉ Hà Lan',
    action: { kind: 'custom', describe: `country=${BILLING_COUNTRY_CODE}, addressLine1, postalCode, locality` },
    timeoutMs: 8_000,
    onMissing: 'skip',
    notes: 'Best-effort — iDEAL đôi khi không bắt buộc đủ trường.',
  },
  {
    id: 'subscribe',
    phase: 'payment',
    title: 'Bấm "Subscribe"',
    action: {
      kind: 'click',
      selectors: [
        'button[aria-label="Subscribe"]',
        "//button[.//span[normalize-space()='Subscribe']]",
        "//button[contains(.,'Subscribe')]",
      ],
    },
    timeoutMs: 10_000,
    onMissing: 'throw',
    shotOnFail: 'chatgpt-pay-error',
    notes: 'Ảnh do catch bao quanh cả phase payment chụp, không phải tại chỗ ném.',
  },
  {
    id: 'capture-ideal-link',
    phase: 'payment',
    title: 'Bắt link cổng iDEAL',
    action: {
      kind: 'custom',
      describe:
        'Quét URL của MỌI tab trong context, khớp '
        + '/pay\\.ideal\\.nl|pay\\.nl\\/|\\.ideal\\.nl|hooks\\.stripe\\.com\\/redirect|idealpayment|ideal-issuer/i',
    },
    timeoutMs: TIMING.idealLinkScanMs,
    onMissing: 'skip',
    notes:
      'Song song dò chữ "declined/rejected" trên MỌI frame để thoát sớm. '
      + 'Không ra link mà cũng không declined thì có thể do "Due today €0.00" — '
      + 'không có gì để thu nên Stripe không redirect. Đó KHÔNG phải lỗi.',
  },
] as const;

/** Ràng buộc thứ tự không suy ra được từ mảng STEPS. */
export const ORDERING: readonly Ordering[] = [
  {
    before: 'arm-code-poll',
    after: 'submit-password',
    why:
      'OpenAI gửi mã xác minh ĐÚNG LÚC bấm Continue. Poll SAU cú click sẽ vớ phải mã '
      + 'cũ còn sót trong hòm; dùng sai mã khiến activation "dr" khoá cứng '
      + '(available_to_get_next_code=false) và hỏng cả lượt thuê.',
  },
  {
    before: 'enter-code',
    after: 'submit-code',
    why: 'Điền mã rồi mới bấm validate — hiển nhiên, nhưng khai để test khoá lại thứ tự.',
  },
  {
    before: 'submit-code',
    after: 'finalize-mail',
    why: 'Chỉ chốt (tính tiền) sau khi mã đã dùng được. Hỏng trước đó thì cancel() để hoàn tiền.',
  },
  {
    before: 'dismiss-welcome',
    after: 'open-promo',
    why: 'Còn màn chào đè lên thì bảng giá không bấm được.',
  },
  {
    before: 'choose-ideal',
    after: 'fill-ideal-name',
    why:
      `Panel iDEAL render trễ ${TIMING.idealPanelDelayMs.min}-${TIMING.idealPanelDelayMs.max}ms. `
      + 'Điền ngay thì chưa có ô Name → Subscribe báo lỗi thiếu tên.',
  },
] as const;

/** Vòng đời tiền của một lượt thuê số. */
export const MAIL_LIFECYCLE = {
  states: ['rented', 'finalized', 'cancelled'] as const,
  transitions: [
    { from: 'rented', to: 'finalized', call: 'mailbox.success()', billing: 'TÍNH TIỀN' },
    { from: 'rented', to: 'cancelled', call: 'mailbox.cancel()', billing: 'HOÀN TIỀN' },
  ],
  invariant:
    'Cờ `finalized` quyết định: catch ở ngoài cùng chỉ gọi cancel() khi finalized === false.',
} as const;

/** Mọi giá trị flow có thể báo về qua report({ status }). */
export const REPORT_STATUSES: readonly ReportStatus[] = [
  { status: 'checkout', phase: 'payment', terminal: false, acceptable: true, meaning: 'Đã tới trang thanh toán, kèm checkoutUrl' },
  { status: 'ideal-link', phase: 'payment', terminal: true, acceptable: true, meaning: 'Bắt được link cổng iDEAL — kết quả mong muốn' },
  { status: 'subscribe-clicked', phase: 'payment', terminal: true, acceptable: true, meaning: 'Đã Subscribe nhưng không có redirect; thường do "Due today €0.00"' },
  { status: 'payment-declined', phase: 'payment', terminal: true, acceptable: false, meaning: 'Stripe chặn rủi ro — vi phạm PRECONDITIONS, không phải lỗi selector' },
  { status: 'signup-ok-pay-failed', phase: 'payment', terminal: true, acceptable: false, meaning: 'Tài khoản tạo xong, phần thanh toán ném lỗi' },
] as const;

/** Hai thứ flow KHÔNG xử lý — chỉ cảnh báo và chụp ảnh. */
export const OUT_OF_SCOPE = [
  { id: 'captcha', detect: ['turnstile', 'challenges.cloudflare.com', 'funcaptcha', 'arkoselabs'], shot: 'chatgpt-captcha' },
  { id: 'phone-verification', detect: ['verify your phone', 'phone number', 'enter your phone'], shot: 'chatgpt-phone' },
] as const;
