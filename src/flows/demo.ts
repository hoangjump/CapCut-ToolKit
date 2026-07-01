import type { RegisteredFlow } from '../automation/types.js';

/**
 * Harmless proof-of-life flow: open a public IP/fingerprint page, wait for it to
 * load, read a value to log, and screenshot. Confirms the automation stack drives
 * the profile's real context (correct proxy IP + fingerprint) end to end without
 * touching any account. Use it to smoke-test the Project tab.
 */
export const demoFlow: RegisteredFlow = {
  meta: {
    name: 'demo',
    label: 'Demo — mở trang IP + chụp màn hình',
    description: 'Mở api.ipify/browserleaks, chờ tải, đọc IP và chụp screenshot. An toàn, không đụng tài khoản.',
  },
  run: async ({ helper, profile, log }) => {
    await helper.goto('https://api.ipify.org/?format=json');
    await helper.waitFor('body');
    const body = await helper.text('body');
    log.info(`[${profile.name}] ipify trả: ${body}`);
    await helper.screenshot(`demo-${profile.name}`);
    // Ghé thêm một trang có UI để cửa sổ hiển thị nội dung dễ nhìn khi headful.
    await helper.goto('https://browserleaks.com/ip');
    await helper.sleep(1500);
    await helper.screenshot(`demo-leaks-${profile.name}`);
  },
};
