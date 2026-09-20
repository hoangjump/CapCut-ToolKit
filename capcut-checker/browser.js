/**
 * Headless browser — mở 1 tab capcut.com, SDK webmssdk tự ký sign header.
 * Mỗi account tạo context riêng (proxy riêng) → login → lấy info → đóng.
 */

import { chromium } from 'playwright';

let browser = null;

/** Khởi tạo browser headless (chỉ gọi 1 lần). */
export async function launchBrowser(headless = true) {
  if (browser) return;
  browser = await chromium.launch({ headless });
}

export async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

/**
 * Check 1 account: tạo context mới (có proxy) → login → lấy full info → đóng.
 * Trả object { uid, vip, trial, credit, benefit } hoặc { error }.
 */
export async function checkAccount(email, password, device, proxyUrl) {
  const contextOpts = {
    userAgent: device.ua,
    locale: 'en-US',
    viewport: { width: device.screenWidth, height: device.screenHeight },
    timezoneId: device.timezone,
    ignoreHTTPSErrors: true,
  };
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    contextOpts.proxy = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
    };
    if (url.username) {
      contextOpts.proxy.username = decodeURIComponent(url.username);
      contextOpts.proxy.password = decodeURIComponent(url.password);
    }
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  try {
    // Block images/fonts/media → nhanh hơn
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,webm}', r => r.abort());
    await page.route('**/monitor_browser/**', r => r.abort());
    await page.route('**/mcs-normal**', r => r.abort());

    // Mở login page → SDK webmssdk load + set cookie s_v_web_id
    await page.goto('https://www.capcut.com/login?locale=en', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Chờ s_v_web_id
    await page.waitForFunction(
      () => /s_v_web_id=/.test(document.cookie),
      null,
      { timeout: 15_000 },
    ).catch(() => {});
    await page.waitForTimeout(800);

    // Login qua API passport (XHR trong trang)
    const loginRes = await page.evaluate(
      ({ email, password }) => {
        const g = globalThis;
        const enc = (s) => {
          const bytes = new TextEncoder().encode(String(s));
          let out = '';
          for (const b of bytes) out += ((b ^ 0x05) & 0xff).toString(16).padStart(2, '0');
          return out;
        };
        const ck = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
        const verifyFp = ck('s_v_web_id');
        const csrf = ck('passport_csrf_token');
        const webid = ck('tt_webid') || ck('tt_webid_v2') || verifyFp || '';
        const qs = new URLSearchParams({
          aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
          language: 'en', verifyFp, webid,
          browser_language: navigator.language || 'en-US', browser_name: 'Mozilla',
          browser_platform: navigator.platform || '', browser_version: navigator.appVersion || '',
          cookie_enabled: 'true', screen_height: String(screen.height), screen_width: String(screen.width),
        }).toString();

        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', 'https://login-row.www.capcut.com/passport/web/email/login/?' + qs, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.setRequestHeader('appid', '348188');
          if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
          if (webid) xhr.setRequestHeader('did', webid);
          xhr.timeout = 25000;
          xhr.onload = () => {
            try {
              const j = JSON.parse(xhr.responseText);
              if (j.data?.user_id || j.data?.session_key)
                resolve({ ok: true, uid: String(j.data.user_id_str || j.data.user_id) });
              else resolve({ ok: false, error: j.data?.description || j.message || 'unknown' });
            } catch { resolve({ ok: false, error: 'parse' }); }
          };
          xhr.onerror = () => resolve({ ok: false, error: 'network' });
          xhr.ontimeout = () => resolve({ ok: false, error: 'timeout' });
          xhr.send(new URLSearchParams({
            mix_mode: '1', email: enc(email), password: enc(password), type: '34', fixed_mix_mode: '1',
          }).toString());
        });
      },
      { email, password },
    );

    if (!loginRes.ok) {
      return { error: `LOGIN_FAIL:${loginRes.error}` };
    }

    // Vào app → session cookie đầy đủ cho commerce
    await page.goto('https://www.capcut.com/my-edit?start_tab=video', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {});
    await page.waitForTimeout(2000);

    // Lấy full info qua page.evaluate (SDK tự ký sign)
    const info = await page.evaluate(async () => {
      const g = globalThis;
      const ck = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const region = (ck('store-country-code') || 'VN').toUpperCase();
      const verifyFp = ck('s_v_web_id');
      const csrf = ck('passport_csrf_token');
      const webid = ck('tt_webid') || ck('tt_webid_v2') || verifyFp || '';

      // Chờ session cookie
      for (let i = 0; i < 20; i++) {
        if (ck('sessionid') || ck('sid_guard')) break;
        await sleep(400);
      }

      const passportGet = (path) => new Promise((resolve) => {
        const qs = new URLSearchParams({
          aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
          language: 'en', verifyFp, webid,
        }).toString();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', path + '?' + qs, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('appid', '348188');
        if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
        if (webid) xhr.setRequestHeader('did', webid);
        xhr.timeout = 15000;
        xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
        xhr.onerror = () => resolve({});
        xhr.ontimeout = () => resolve({});
        xhr.send();
      });

      const commercePost = (url, body) => new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('appid', '348188');
        xhr.setRequestHeader('appvr', '12.4.0');
        xhr.setRequestHeader('lan', 'en');
        xhr.setRequestHeader('loc', region);
        xhr.setRequestHeader('pf', '7');
        xhr.timeout = 15000;
        xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
        xhr.onerror = () => resolve({});
        xhr.ontimeout = () => resolve({});
        xhr.send(JSON.stringify(body));
      });

      // Account info
      const acct = await passportGet('/passport/web/account/info/');
      const uid = String(acct?.data?.user_id_str || acct?.data?.user_id || '');

      // VIP
      const sub = await commercePost(
        'https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info',
        { aid: '348188', scene: 'vip' },
      );
      const vip = sub?.data?.flag ? 'YES' : 'NO';

      // Trial
      const pr = await commercePost(
        'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',
        { aid: 348188, region, scene: 'vip' },
      );
      const prices = pr?.data?.all_price_list || [];
      const trial = prices.some(p => p?.can_trial && p?.trial_cycle === 7) ? 'YES' : 'NO';

      // Credits
      const credits = await commercePost(
        'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit',
        {},
      );
      const cr = credits?.data?.credit || {};
      const totalCredit = (cr.vip_credit || 0) + (cr.gift_credit || 0) + (cr.purchase_credit || 0);

      // Benefits
      const benefits = await commercePost(
        'https://commerce-api-sg.capcut.com/commerce/v3/benefits/batch_get_user_benefit',
        { query_list: [
          { resource_id: 'text_to_speech_web_tools', resource_type: 'aigc', benefit_type_list: ['text_to_speech_web_tools'] },
          { resource_id: 'tts_voice_changer_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_changer_web_tools'] },
          { resource_id: 'tts_voice_clone_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_clone_web_tools'] },
        ]},
      );
      const assets = benefits?.data?.asset_list || [];
      const benefitParts = [];
      for (const a of assets) {
        for (const b of (a.benefit_list || [])) {
          benefitParts.push(`${a.resource_id}:${b.remaining ?? b.available ?? '?'}/${b.total ?? '?'}`);
        }
      }

      return { uid, vip, trial, credit: totalCredit, benefit: benefitParts.join(', ') || 'none' };
    });

    return info;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
