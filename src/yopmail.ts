import type { BrowserContext } from 'playwright-core';
import type { Logger } from './logger.js';

/**
 * YOPMAIL — hộp thư dùng-một-lần, KHÔNG cần đăng ký: mọi địa chỉ `<tên>@yopmail.com`
 * tồn tại sẵn, gửi tới là nhận được. CapCut CHẤP NHẬN yopmail cho đăng ký (đã kiểm
 * chứng: check_email is_registered=0, send_code success, OTP về hộp yopmail).
 *
 * Dùng thay nguồn Hotmail+alias (bị Microsoft giới hạn tần suất tạo alias) để tăng
 * tỉ lệ đăng ký. Đọc OTP bằng cách MỞ yopmail.com trong một tab riêng cùng context
 * (cùng proxy) rồi bóc mã trong body mail — vì yopmail không có API/refresh_token.
 *
 * Cảnh báo: hộp yopmail là CÔNG KHAI (ai biết tên cũng đọc được). Ta sinh tên ngẫu
 * nhiên đủ dài để tránh trùng; mã OTP chỉ có giá trị vài phút nên rủi ro thấp, nhưng
 * đây là hộp thư tạm — chỉ dùng để nhận OTP, không phải nơi lưu trữ lâu dài.
 */

const OTP_DEFAULT_RE = /verification code[^\d]{0,20}(\d{4,8})/i;

/** Ký tự cho tên hộp + mật khẩu (bỏ ký tự dễ nhầm để log đọc được). */
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';

function pick(chars: string): string {
  return chars[Math.floor(Math.random() * chars.length)];
}

function randomOf(chars: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += pick(chars);
  return s;
}

export interface YopmailAccount {
  /** Địa chỉ đầy đủ dùng để đăng ký CapCut. */
  email: string;
  /** Phần trước @ — dùng để mở hộp thư trên yopmail.com. */
  login: string;
  /** Mật khẩu mạnh đặt cho tài khoản CapCut (chữ hoa+thường+số). */
  password: string;
}

/** Sinh một tài khoản yopmail ngẫu nhiên + mật khẩu hợp lệ CapCut (>=8 ký tự, có
 *  chữ và số). Thuần tuý (không mạng) → unit-test được. */
export function randomYopmailAccount(prefix = 'cc'): YopmailAccount {
  const login = `${prefix}${randomOf(LOWER, 6)}${randomOf(DIGITS, 4)}`;
  // Mật khẩu: 1 hoa + 6 thường + 4 số → chắc chắn đủ điều kiện của CapCut.
  const password = `${pick(LOWER).toUpperCase()}${randomOf(LOWER, 6)}${randomOf(DIGITS, 4)}`;
  return { email: `${login}@yopmail.com`, login, password };
}

/** Bóc mã OTP từ text body mail bằng regex (nhóm bắt 1 = mã). Tách riêng để test
 *  không cần trình duyệt. */
export function parseYopmailOtp(text: string, pattern: RegExp = OTP_DEFAULT_RE): string | null {
  const m = String(text ?? '').match(pattern);
  return m && m[1] ? m[1] : null;
}

export interface ReadYopmailOptions {
  pattern?: RegExp;
  tries?: number;
  intervalMs?: number;
  log?: Logger;
}

/**
 * Đọc OTP CapCut từ hộp yopmail. Mở tab mới trong `context` (cùng proxy với profile),
 * poll: tải lại inbox → nếu có mail CapCut thì mở ra, bóc mã trong body (#ifmobmail).
 *
 * Cơ chế yopmail (đã kiểm chứng bằng trình duyệt): danh sách inbox nằm trong iframe
 * `#ifinbox`, mỗi mail là `button.lm`; bấm nó chạy hàm cha nạp nội dung vào iframe
 * `#ifmobmail`. Danh sách CHE mã ("verification code is ******"), nên phải mở mail
 * mới lấy được mã thật — ta đọc mọi iframe TRỪ ifinbox và khớp regex có chữ số.
 *
 * Trả mã, hoặc ném nếu hết `tries` lần vẫn chưa thấy.
 */
export async function readYopmailOtp(
  context: BrowserContext,
  login: string,
  opts: ReadYopmailOptions = {},
): Promise<string> {
  const pattern = opts.pattern ?? OTP_DEFAULT_RE;
  const tries = opts.tries ?? 12;
  const intervalMs = opts.intervalMs ?? 5_000;
  const log = opts.log;
  const url = `https://yopmail.com/en/?login=${encodeURIComponent(login)}`;

  const mp = await context.newPage();
  try {
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      await mp.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await mp.waitForTimeout(1_200);

      const code = await mp.evaluate(
        async ({ src }) => {
          const g = globalThis as any;
          const doc = g.document;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const re = new RegExp(src, 'i');
          const ib = doc.getElementById('ifinbox');
          const idoc = ib && ib.contentDocument;
          if (!idoc) return null;
          // Chọn mail CapCut (theo chữ) nếu có, không thì mail đầu.
          const buttons = Array.from(idoc.querySelectorAll('button.lm')) as any[];
          if (!buttons.length) return null; // hộp còn trống — mail chưa về
          const target =
            buttons.find((b) => /capcut|verification/i.test(b.innerText || '')) || buttons[0];
          target.click();
          await sleep(2_000);
          // Body mail nằm ở iframe khác (ifmobmail/ifmail…). Quét mọi iframe TRỪ
          // ifinbox (danh sách che mã) rồi khớp regex có chữ số.
          for (const f of Array.from(doc.querySelectorAll('iframe')) as any[]) {
            if (f.id === 'ifinbox') continue;
            try {
              const t = (f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText) || '';
              const m = t.match(re);
              if (m && m[1]) return m[1];
            } catch {
              /* iframe cross-origin/chưa nạp — bỏ qua */
            }
          }
          return null;
        },
        { src: pattern.source },
      );

      if (code) {
        log?.info(`YOPmail ${login}: nhận OTP ${code}`);
        return code;
      }
      if (attempt < tries) {
        log?.info(`YOPmail ${login}: chưa thấy OTP (thử ${attempt}/${tries})`);
        await mp.waitForTimeout(intervalMs);
      }
    }
    throw new Error(`YOPmail ${login}: không đọc được OTP sau ${tries} lần thử`);
  } finally {
    await mp.close().catch(() => {});
  }
}
