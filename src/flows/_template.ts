import type { RegisteredFlow } from '../automation/types.js';

/**
 * KHUÔN FLOW — copy file này thành `src/flows/<ten-flow>.ts`, đổi `name`/`label`,
 * điền các bước trong `run`, rồi đăng ký một dòng ở `src/flows/index.ts`.
 *
 * Selector: helper nhận cả CSS lẫn XPath. Bắt đầu bằng `//` hoặc `(//` là XPath,
 * còn lại là CSS. Cứ dán thẳng XPath/CSS bạn lấy được vào — không cần sửa.
 *
 * Bộ động tác của `helper` (mỗi cái có timeout mặc định + tự log):
 *   goto(url)                  — mở trang, chờ DOM sẵn sàng
 *   click(sel)                 — click
 *   clickIfExists(sel)         — click nếu có (banner cookie/consent tùy lúc)
 *   fill(sel, val)             — set giá trị ô input một phát
 *   type(sel, val, delay?)     — gõ từng phím (site nào soi keystroke thật)
 *   press(key)                 — nhấn phím ('Enter', 'Tab', …)
 *   select(sel, val)           — chọn <option> trong <select>
 *   check(sel) / uncheck(sel)  — tick / bỏ tick checkbox
 *   hover(sel)                 — rê chuột (menu/tooltip hiện khi hover)
 *   waitFor(sel, state?)       — chờ element ('visible'|'attached'|'hidden')
 *   waitForText(sel, text)     — chờ element chứa đoạn text
 *   waitForUrl(match)          — chờ URL khớp (chuỗi con hoặc RegExp) sau redirect
 *   exists(sel) -> bool        — có khớp ngay bây giờ không (không chờ)
 *   count(sel) -> number       — đếm số element khớp
 *   text(sel) -> string        — text đã trim của phần tử đầu
 *   attr(sel, name) -> string? — giá trị thuộc tính
 *   sleep(ms)                  — chờ cứng (hạn chế dùng, ưu tiên waitFor*)
 *   screenshot(name?)          — chụp full-page vào profiles-store/shots/
 *
 * Lấy OTP (chỉ khi Project có gán mail): `await getOtp('facebook' | 'google' | …)`.
 * Log ra tiến trình: `log.info('...')`.
 */
export const templateFlow: RegisteredFlow = {
  meta: {
    name: 'template',
    label: 'Khuôn mẫu (copy để làm flow mới)',
    description: 'File mẫu — không chạy thực tế. Copy thành flow riêng rồi điền các bước.',
  },
  run: async ({ helper, getOtp, profile, log }) => {
    // ----- Ví dụ các bước (xóa/sửa theo nhu cầu) -----

    // 1) Mở trang
    // await helper.goto('https://example.com/register');

    // 2) Bỏ qua banner cookie nếu có
    // await helper.clickIfExists('//button[contains(., "Accept")]');

    // 3) Điền form (dán XPath/CSS bạn lấy được)
    // await helper.fill('#email', 'someone@example.com');
    // await helper.type('input[name="password"]', 'secret', 60);
    // await helper.select('#country', 'VN');
    // await helper.check('//input[@id="agree"]');

    // 4) Submit + chờ chuyển trang
    // await helper.click('//button[@type="submit"]');
    // await helper.waitForUrl('/verify');

    // 5) Lấy OTP từ mail đã gán rồi điền vào (cần Project có chọn mail)
    // const code = await getOtp('facebook');
    // await helper.fill('#otp', code);
    // await helper.click('#confirm');

    // 6) Xác nhận thành công + chụp lại
    // await helper.waitForText('.welcome', 'Xin chào');
    // await helper.screenshot(`done-${profile.name}`);

    log.info(`[${profile.name}] template flow — chưa có bước nào, hãy copy file này ra flow riêng.`);
  },
};
