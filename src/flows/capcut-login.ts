import type { RegisteredFlow } from '../automation/types.js';
import { encMixMode } from '../capcutRegApi.js';
import type { Page } from 'playwright-core';
import type { Logger } from '../logger.js';

/**
 * CapCut LOGIN tài khoản có sẵn + lấy thông tin.
 *
 * Flow nhận email+password từ kho mail của project (giống capcut-signin nhận
 * mail mua). Login qua API passport → lấy account info, VIP status, AI credits,
 * bảng giá → báo kết quả ra sheet.
 *
 * Endpoint đã xác minh bằng HAR:
 *   - GET  /passport/web/account/info/        (same-origin www.capcut.com)
 *   - POST /commerce/v1/subscription/user_info (XHR, SDK ký sign)
 *   - POST /commerce/v1/benefits/user_credit   (XHR, SDK ký sign)
 *   - POST /commerce/v3/trade/subscription_infos
 */

interface AccountInfo {
  userId: string;
  screenName: string;
  email: string;
  vip: boolean;
  vipType: string;
  vipEndTime: number;
  creditVip: number;
  creditGift: number;
  creditPurchase: number;
  hasTrial: boolean;
}

async function loginViaApi(page: Page, email: string, password: string, log: Logger): Promise<void> {
  const encEmail = encMixMode(email);
  const encPass = encMixMode(password);

  const res = await page.evaluate(
    ({ encE, encP }) => {
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
      const webid = getCookie('tt_webid') || getCookie('tt_webid_v2') || verifyFp || '';
      const qs = new g.URLSearchParams({
        aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
        language: 'en', verifyFp,
        timezone_name: (g.Intl && g.Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Saigon',
        webid, browser_language: nav.language || 'en-US', browser_name: 'Mozilla',
        browser_platform: nav.platform || 'Win32', browser_version: nav.appVersion || '',
        cookie_enabled: 'true', screen_height: String(scr.height), screen_width: String(scr.width),
      }).toString();

      return new Promise<{ ok: boolean; userId?: string; screenName?: string; err?: string }>((resolve) => {
        const xhr = new g.XMLHttpRequest();
        xhr.open('POST', 'https://login-row.www.capcut.com/passport/web/email/login/?' + qs, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.setRequestHeader('Accept', 'application/json');
        if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
        xhr.setRequestHeader('appid', '348188');
        if (webid) xhr.setRequestHeader('did', webid);
        xhr.timeout = 25000;
        xhr.onload = () => {
          try {
            const j = JSON.parse(xhr.responseText);
            if (j.data?.user_id || j.data?.session_key) {
              resolve({ ok: true, userId: String(j.data.user_id_str || j.data.user_id), screenName: j.data.screen_name });
            } else {
              resolve({ ok: false, err: j.data?.description || j.message || 'unknown' });
            }
          } catch { resolve({ ok: false, err: 'parse error' }); }
        };
        xhr.onerror = () => resolve({ ok: false, err: 'network error' });
        xhr.ontimeout = () => resolve({ ok: false, err: 'timeout' });
        xhr.send(new g.URLSearchParams({
          mix_mode: '1', email: encE, password: encP, type: '34', fixed_mix_mode: '1',
        }).toString());
      });
    },
    { encE: encEmail, encP: encPass },
  );

  if (!res.ok) throw new Error(`Login lỗi: ${res.err}`);
  log.info(`login OK — userId=${res.userId} name=${res.screenName}`);
}

async function getAccountInfo(page: Page): Promise<AccountInfo> {
  return page.evaluate(async () => {
    const g = globalThis as any;
    const doc = g.document;
    const getCookie = (n: string): string => {
      const m = String(doc?.cookie ?? '').match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Chờ session cookie
    for (let i = 0; i < 20; i++) {
      if (getCookie('sessionid') || getCookie('sid_guard')) break;
      await sleep(500);
    }

    const region = (getCookie('store-country-code') || 'VN').toUpperCase();
    const verifyFp = getCookie('s_v_web_id');
    const csrf = getCookie('passport_csrf_token');
    const webid = getCookie('tt_webid') || getCookie('tt_webid_v2') || verifyFp || '';

    // Passport GET same-origin
    const passportGet = (path: string): Promise<any> =>
      new Promise((resolve) => {
        const qs = new g.URLSearchParams({
          aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
          language: 'en', verifyFp, webid,
        }).toString();
        const xhr = new g.XMLHttpRequest();
        xhr.open('GET', path + '?' + qs, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('appid', '348188');
        if (webid) xhr.setRequestHeader('did', webid);
        if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
        xhr.timeout = 15000;
        xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
        xhr.onerror = () => resolve({});
        xhr.ontimeout = () => resolve({});
        xhr.send();
      });

    // Commerce POST qua XHR (SDK tự ký sign)
    const commercePost = (url: string, body: any): Promise<any> =>
      new Promise((resolve) => {
        const xhr = new g.XMLHttpRequest();
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

    const result: any = {
      userId: '', screenName: '', email: '',
      vip: false, vipType: '', vipEndTime: 0,
      creditVip: 0, creditGift: 0, creditPurchase: 0,
      hasTrial: false,
    };

    // 1. Account info
    const acct = await passportGet('/passport/web/account/info/');
    if (acct?.data) {
      result.userId = String(acct.data.user_id_str || acct.data.user_id || '');
      result.screenName = acct.data.screen_name || acct.data.nickname || '';
      result.email = acct.data.email || '';
    }

    // 2. Subscription user_info
    const sub = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info',
      { aid: '348188', scene: 'vip' },
    );
    if (sub?.data) {
      result.vip = !!sub.data.flag;
      result.vipEndTime = Number(sub.data.end_time) || 0;
    }

    // 3. Subscription infos (vip level details)
    const subInfos = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v3/trade/subscription_infos',
      { scene: ['vip'], app_id: 348188, vip_levels: ['vip', 'ultra'] },
    );
    const vipInfos = subInfos?.data?.subscription_user_infos?.vip?.vip_infos || [];
    const activeVip = vipInfos.find((v: any) => v?.is_vip);
    if (activeVip) {
      result.vip = true;
      result.vipType = activeVip.vip_type || activeVip.level || 'vip';
      result.vipEndTime = Number(activeVip.vip_end_time) || result.vipEndTime;
    }

    // 4. AI Credits
    const credits = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit',
      {},
    );
    if (credits?.data?.credit) {
      result.creditVip = Number(credits.data.credit.vip_credit) || 0;
      result.creditGift = Number(credits.data.credit.gift_credit) || 0;
      result.creditPurchase = Number(credits.data.credit.purchase_credit) || 0;
    }

    // 5. Price list — check trial
    const pr = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',
      { aid: 348188, region, scene: 'vip' },
    );
    const prices = pr?.data?.all_price_list || [];
    result.hasTrial = prices.some((p: any) => p?.can_trial && p?.trial_cycle === 7);

    return result as AccountInfo;
  });
}

export const capcutLoginFlow: RegisteredFlow = {
  meta: {
    name: 'capcut-login',
    label: 'CapCut — đăng nhập + lấy thông tin tài khoản',
    description:
      'Login tài khoản CapCut có sẵn (email+pass từ kho mail) → lấy info, VIP, credits, trial → báo sheet.',
  },
  run: async ({ helper, page, mail, report, profile, log }) => {
    if (!mail?.email) throw new Error('Cần mail (email+password) trong kho — không có gì để login');
    const email = mail.email;
    const password = mail.password ?? '';
    if (!password) throw new Error('Mail trong kho không có password — không thể login');

    // Bước 1: mở CapCut (cần load webmssdk để SDK ký request)
    await helper.goto('https://www.capcut.com/login?locale=en');

    // Bước 2: chờ verifyFp
    await page
      .waitForFunction(() => /s_v_web_id=/.test((globalThis as any).document.cookie), null, { timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    // Bước 3: login qua API passport
    await loginViaApi(page, email, password, log);

    // Bước 4: vào app để có đủ session cookie cho commerce API
    await page
      .goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => {});
    await page.waitForTimeout(2_500);

    // Bước 5: lấy thông tin tài khoản
    const info = await getAccountInfo(page);
    const totalCredits = info.creditVip + info.creditGift + info.creditPurchase;
    const vipEnd = info.vipEndTime ? new Date(info.vipEndTime * 1000).toISOString().slice(0, 10) : 'none';

    log.info(`[${profile.name}] user=${info.userId} name=${info.screenName} email=${info.email}`);
    log.info(`[${profile.name}] VIP=${info.vip} type=${info.vipType} end=${vipEnd}`);
    log.info(`[${profile.name}] credits: vip=${info.creditVip} gift=${info.creditGift} purchase=${info.creditPurchase} total=${totalCredits}`);
    log.info(`[${profile.name}] trial available=${info.hasTrial}`);

    // Báo sheet
    report({
      status: [
        info.vip ? `VIP:${info.vipType}→${vipEnd}` : 'no-vip',
        `credits:${totalCredits}`,
        info.hasTrial ? 'trial:yes' : 'trial:no',
      ].join(' | '),
    });
  },
};
