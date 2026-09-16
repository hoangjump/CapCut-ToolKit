import type { RegisteredFlow } from '../automation/types.js';
import { registerViaApi } from '../capcutRegApi.js';
import { purchaseVipAndReport } from './capcut-signin.js';
import type { Page } from 'playwright-core';

/**
 * CapCut đăng ký bằng MAIL TẠM tempmail.id.vn (API HTTP). Giống capcut-signin và
 * bản yopmail (đăng ký + mua VIP đều qua API, mở Camoufox bình thường), chỉ KHÁC
 * nguồn OTP: đọc THẲNG qua HTTP nên KHÔNG cần mở tab đọc mail như yopmail →
 * nhanh + bền hơn, không phụ thuộc proxy của profile để đọc mail.
 *
 *   1. ctx.tempMail(): tạo hộp thư tạm (domain ít lộ liễu) qua API.
 *   2. registerViaApi: 3 API passport, OTP đọc qua tempmail API (mailbox.waitOtp).
 *   3. purchaseVipAndReport: mua VIP qua API + báo link/sheet — dùng chung.
 *
 * Đã kiểm chứng: CapCut chấp nhận domain của dịch vụ (vd hathitrannhien.edu.vn),
 * OTP nằm luôn trong subject và đọc được qua API.
 */

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
function randomPassword(): string {
  const r = (chars: string, n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  // 1 hoa + 6 thường + 4 số → đủ điều kiện mật khẩu CapCut.
  return `${r(LOWER, 1).toUpperCase()}${r(LOWER, 6)}${r(DIGITS, 4)}`;
}

export const capcutSigninTempmailFlow: RegisteredFlow = {
  meta: {
    name: 'capcut-signin-tempmail',
    label: 'CapCut — đăng ký bằng mail tạm (tempmail API)',
    description:
      'Tạo mail tạm qua API tempmail.id.vn → đăng ký CapCut qua API → đọc OTP thẳng qua API (không mở tab) → mua VIP. Cần API token tempmail ở tab Mail.',
  },
  run: async ({ helper, page, tempMail, reportMail, report, profile, log }) => {
    // --- Bước 1: mở trang đăng nhập (ép tiếng Anh cho các bước dự phòng theo text). ---
    await helper.goto('https://www.capcut.com/login?locale=en');

    // --- Bước 2: tạo hộp thư tạm + đặt mật khẩu. Báo ngay cho runner để dòng sheet
    // có email/password kể cả khi bước sau lỗi. ---
    const mailbox = await tempMail();
    const password = randomPassword();
    reportMail(mailbox.email, password);
    log.info(`[${profile.name}] mail tạm: ${mailbox.email}`);

    // --- Bước 3: chờ verifyFp (s_v_web_id) do webmssdk set — định danh bắt buộc
    // cho API passport (csrf không cần). ---
    await page
      .waitForFunction(() => /s_v_web_id=/.test((globalThis as any).document.cookie), null, { timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    // --- Bước 4: ĐĂNG KÝ QUA API. OTP đọc qua tempmail API (mailbox.waitOtp). ---
    const reg = await registerViaApi(page, {
      email: mailbox.email,
      password,
      getCode: () => mailbox.waitOtp(),
      log,
    });
    log.info(`[${profile.name}] đăng ký qua API OK — user_id=${reg.userId}`);

    // --- Bước 5: vào app để có context đăng nhập cho việc mua VIP. ---
    const appPage: Page = page;
    await page
      .goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => {});
    await page.waitForTimeout(2_500);

    // --- Bước 6: mua VIP qua API + báo kết quả (dùng chung với capcut-signin). ---
    await purchaseVipAndReport(appPage, { log, report, profileName: profile.name });
  },
};
