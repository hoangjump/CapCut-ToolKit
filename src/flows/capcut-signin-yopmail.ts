import type { RegisteredFlow } from '../automation/types.js';
import { registerViaApi } from '../capcutRegApi.js';
import { purchaseVipAndReport, joinTeamViaLink } from './capcut-signin.js';
import { randomYopmailAccount, readYopmailOtp } from '../yopmail.js';
import type { Page } from 'playwright-core';

/**
 * CapCut đăng ký bằng YOPMAIL (hộp thư dùng-một-lần, miễn phí) thay cho nguồn
 * Hotmail+alias bị Microsoft giới hạn tần suất. Cùng cơ chế với capcut-signin
 * (đăng ký + mua VIP đều qua API, mở Camoufox bình thường), chỉ KHÁC nguồn mail:
 *
 *   1. Sinh <tên ngẫu nhiên>@yopmail.com tại chỗ (không mua, không đăng ký hộp).
 *   2. registerViaApi: 3 API passport, OTP đọc từ yopmail.com (tab riêng cùng proxy).
 *   3. purchaseVipAndReport: mua VIP qua API + báo link/sheet — dùng chung.
 *
 * Đã kiểm chứng: CapCut chấp nhận yopmail (check_email is_registered=0, send_code
 * success, OTP về + đọc được). Không cần csrf (passport_csrf_token) — send_code /
 * register chạy được khi chưa có cookie này, chỉ cần verifyFp (s_v_web_id).
 */
export const capcutSigninYopmailFlow: RegisteredFlow = {
  meta: {
    name: 'capcut-signin-yopmail',
    label: 'CapCut — đăng ký bằng YOPmail (mail tạm)',
    description:
      'Sinh mail yopmail → đăng ký CapCut qua API → đọc OTP trên yopmail.com → mua VIP qua API. Không cần mua mail, không dính giới hạn alias Microsoft.',
  },
  run: async ({ helper, page, session, reportMail, report, profile, log, teamInviteLink }) => {
    // --- Bước 1: mở trang đăng nhập (ép tiếng Anh cho các bước dự phòng theo text). ---
    await helper.goto('https://www.capcut.com/login?locale=en');

    // --- Bước 2: sinh mail yopmail + mật khẩu. Báo ngay cho runner để dòng sheet
    // có email/password kể cả khi bước sau lỗi. ---
    const acct = randomYopmailAccount();
    reportMail(acct.email, acct.password);
    log.info(`[${profile.name}] yopmail: ${acct.email}`);

    // --- Bước 3: chờ verifyFp (s_v_web_id) do webmssdk set sau khi trang load —
    // đây là định danh BẮT BUỘC cho API passport (csrf thì không cần). ---
    await page
      .waitForFunction(() => /s_v_web_id=/.test((globalThis as any).document.cookie), null, { timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    // --- Bước 4: ĐĂNG KÝ QUA API. OTP đọc từ yopmail (mở tab riêng cùng context/proxy). ---
    const reg = await registerViaApi(page, {
      email: acct.email,
      password: acct.password,
      getCode: () => readYopmailOtp(session.context, acct.login, { log }),
      log,
    });
    log.info(`[${profile.name}] đăng ký qua API OK — user_id=${reg.userId}`);

    // --- Bước 5: vào app để có context đăng nhập cho việc mua VIP. ---
    const appPage: Page = page;
    await page
      .goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => {});
    await page.waitForTimeout(2_500);

    // --- Bước 6: join team nếu có invite link ---
    if (teamInviteLink) {
      await joinTeamViaLink(appPage, teamInviteLink, log, profile.name);
      await page.goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
    }

    // --- Bước 7: mua VIP qua API + báo kết quả (dùng chung với capcut-signin). ---
    await purchaseVipAndReport(appPage, { log, report, profileName: profile.name });
  },
};
