import type { Page } from 'playwright-core';
import type { Logger } from './logger.js';

/**
 * ĐĂNG KÝ CAPCUT QUA API (không bấm DOM). Xác minh bằng hook F12 trên request
 * thật: 3 API passport, KHÔNG captcha. Chữ ký/định danh (verifyFp, csrf, webid,
 * msToken cookie) do trang tự có sau khi load capcut.com — nên phải chạy XHR
 * TRONG trang (page.evaluate) chứ không gọi từ Node.
 *
 *   1. /passport/web/user/check_email_registered   → is_registered=0 mới đăng ký
 *   2. /passport/web/email/send_code/              → gửi OTP tới hộp thư
 *   3. /passport/web/email/register_verify_login/  → tạo tài khoản + set session
 *
 * mix_mode=1: email/password/code mã hoá = hex(mỗi byte XOR 0x05). type=34 (email).
 */

const HOST = 'https://login-row.www.capcut.com'; // ROW (gồm VN) — theo request thật

/** Mã hoá mix_mode: mỗi byte (UTF-8) XOR 0x05 rồi hex 2 ký tự. Tách riêng để
 *  unit-test không cần trình duyệt. */
export function encMixMode(s: string): string {
  const bytes = new TextEncoder().encode(String(s));
  let out = '';
  for (const b of bytes) out += ((b ^ 0x05) & 0xff).toString(16).padStart(2, '0');
  return out;
}

/** Ngày sinh ngẫu nhiên tuổi trưởng thành (YYYY-MM-DD). */
function randomBirthday(): string {
  const y = 1995 + Math.floor(Math.random() * 6);
  const m = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const d = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Kết quả một lời gọi passport (parse từ page context). */
interface PassportResult {
  ok: boolean;
  data?: any;
  message?: string;
  raw?: string;
  err?: string;
}

/** Chạy một POST passport TRONG trang (để có cookie/verifyFp/csrf). `bodyObj`
 *  là các cặp key→value đã mã hoá sẵn ở phía Node; query chuẩn + header csrf do
 *  hàm trong trang tự dựng từ cookie. */
async function passportPost(page: Page, path: string, bodyObj: Record<string, string>): Promise<PassportResult> {
  return page.evaluate(
    ({ host, p, body }) => {
      const g = globalThis as any;
      const doc = g.document;
      const nav = g.navigator;
      const scr = g.screen;
      const getCookie = (n: string): string => {
        const m = String(doc?.cookie ?? '').match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
      };
      const verifyFp = getCookie('s_v_web_id');
      const csrf = getCookie('passport_csrf_token');
      const webid =
        getCookie('tt_webid') || getCookie('tt_webid_v2') || getCookie('s_v_web_id') || '';
      const query = new g.URLSearchParams({
        aid: '348188',
        account_sdk_source: 'web',
        sdk_version: '2.1.10-tiktok',
        language: 'en',
        verifyFp,
        timezone_name: (g.Intl && g.Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Saigon',
        webid,
        browser_language: nav.language || 'en-US',
        browser_name: 'Mozilla',
        browser_platform: nav.platform || 'Win32',
        browser_version: nav.appVersion || '',
        cookie_enabled: 'true',
        screen_height: String(scr.height),
        screen_width: String(scr.width),
      }).toString();

      return new Promise((resolve) => {
        try {
          const xhr = new g.XMLHttpRequest();
          xhr.open('POST', host + p + '?' + query, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
          xhr.setRequestHeader('Accept', 'application/json, text/javascript');
          if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
          xhr.setRequestHeader('appid', '348188');
          if (webid) xhr.setRequestHeader('did', webid);
          xhr.timeout = 25000;
          xhr.onload = () => {
            try {
              const j = JSON.parse(xhr.responseText);
              resolve({ ok: true, data: j.data, message: j.message });
            } catch {
              resolve({ ok: false, raw: String(xhr.responseText).slice(0, 300) });
            }
          };
          xhr.onerror = () => resolve({ ok: false, err: 'xhr error/CORS' });
          xhr.ontimeout = () => resolve({ ok: false, err: 'xhr timeout' });
          xhr.send(new g.URLSearchParams(body).toString());
        } catch (e: any) {
          resolve({ ok: false, err: String((e && e.message) || e) });
        }
      }) as Promise<PassportResult>;
    },
    { host: HOST, p: path, body: bodyObj },
  );
}

export interface RegisterViaApiInput {
  email: string;
  password: string;
  /** Poll hộp thư lấy OTP 6 số của CapCut (flow truyền vào — tái dùng getOtp). */
  getCode: () => Promise<string>;
  log: Logger;
  birthday?: string;
}

export interface RegisterViaApiResult {
  userId: string;
  screenName?: string;
}

/**
 * Đăng ký một tài khoản CapCut bằng email qua API. Trang phải đang ở capcut.com
 * (đã load webmssdk + có cookie passport). Ném lỗi nếu email đã tồn tại / gửi mã
 * lỗi / sai mã / server chặn. Khi thành công, session login được set trên trang
 * (register_verify_login trả session) nên purchaseVipViaApi chạy tiếp được.
 */
export async function registerViaApi(page: Page, input: RegisterViaApiInput): Promise<RegisterViaApiResult> {
  const { email, password, getCode, log } = input;
  const birthday = input.birthday ?? randomBirthday();
  const encEmail = encMixMode(email);
  const encPass = encMixMode(password);

  // B1: email đã đăng ký chưa?
  const chk = await passportPost(page, '/passport/web/user/check_email_registered', {
    mix_mode: '1',
    email: encEmail,
    fixed_mix_mode: '1',
  });
  if (!chk.ok) throw new Error(`check_email lỗi: ${chk.err || chk.raw || 'không rõ'}`);
  if (chk.data?.is_registered === 1) throw new Error(`Email ${email} đã đăng ký CapCut rồi`);

  // B2: gửi mã (kèm password vì type=34 đăng ký).
  const snd = await passportPost(page, '/passport/web/email/send_code/', {
    mix_mode: '1',
    email: encEmail,
    password: encPass,
    type: '34',
    fixed_mix_mode: '1',
  });
  if (!snd.ok || !snd.data?.email_ticket) {
    throw new Error(`send_code lỗi: ${snd.data?.description || snd.message || snd.err || snd.raw || 'không rõ'}`);
  }
  log.info(`đã gửi mã đăng ký tới ${snd.data.email || email} — chờ OTP`);

  // B3: đọc OTP từ hộp thư (flow lo) rồi register_verify_login.
  const code = await getCode();
  log.info(`nhận OTP ${code} — đang tạo tài khoản`);
  const reg = await passportPost(page, '/passport/web/email/register_verify_login/', {
    mix_mode: '1',
    email: encEmail,
    code: encMixMode(String(code)),
    password: encPass,
    type: '34',
    birthday,
    force_user_region: 'VN',
    biz_param: JSON.stringify({ invite_code: '' }),
    fixed_mix_mode: '1',
  });
  if (!reg.ok || !reg.data?.user_id) {
    throw new Error(`register lỗi: ${reg.data?.description || reg.message || reg.err || reg.raw || 'không rõ'}`);
  }
  return { userId: String(reg.data.user_id_str || reg.data.user_id), screenName: reg.data.screen_name };
}
