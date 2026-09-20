/**
 * CapCut API client — HTTP thuần, không cần browser.
 *
 * Passport API: không cần sign, chỉ cần query params + cookies.
 * Commerce API: cần sign header do webmssdk ký — nhưng từ Node ta KHÔNG có SDK.
 *   → Giải pháp: sau khi login, dùng cookie sessionid gọi THẲNG commerce.
 *     Nếu bị shark (ret=-6), ghi 'no-sign' vào field đó.
 */

const PASSPORT_HOST = 'https://login-row.www.capcut.com';
const CAPCUT_HOST = 'https://www.capcut.com';
const COMMERCE_HOST = 'https://commerce-api-sg.capcut.com';

/** Mã hoá mix_mode: mỗi byte XOR 0x05 rồi hex */
export function encMixMode(s) {
  const bytes = new TextEncoder().encode(String(s));
  let out = '';
  for (const b of bytes) out += ((b ^ 0x05) & 0xff).toString(16).padStart(2, '0');
  return out;
}

/** Cookie jar đơn giản: parse Set-Cookie headers, gửi lại Cookie header. */
export class CookieJar {
  constructor() { this.cookies = new Map(); }

  /** Parse Set-Cookie headers từ response */
  capture(response) {
    const raw = response.headers.getSetCookie?.() || [];
    for (const line of raw) {
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const name = line.slice(0, eq).trim();
      const rest = line.slice(eq + 1);
      const val = rest.split(';')[0].trim();
      this.cookies.set(name, val);
    }
  }

  get(name) { return this.cookies.get(name) || ''; }

  /** Cookie header string */
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Tạo CapCut API client cho 1 account (1 device + 1 cookie jar). */
export function createClient(device, fetchFn = fetch) {
  const jar = new CookieJar();

  const passportQs = () => new URLSearchParams({
    aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
    language: 'en', verifyFp: device.verifyFp,
    timezone_name: device.timezone,
    webid: device.webId,
    browser_language: device.lang,
    browser_name: 'Mozilla',
    browser_platform: device.platform,
    browser_version: device.ua.split('Chrome/')[1]?.split(' ')[0] || '',
    cookie_enabled: 'true',
    screen_height: String(device.screenHeight),
    screen_width: String(device.screenWidth),
  }).toString();

  // Gọi trang chính để lấy cookie ban đầu (csrf, s_v_web_id, msToken...)
  async function init() {
    try {
      const res = await fetchFn(`${CAPCUT_HOST}/login?locale=en`, {
        method: 'GET',
        headers: { 'User-Agent': device.ua, Accept: 'text/html' },
        redirect: 'follow',
      });
      jar.capture(res);
      await res.text(); // consume body
    } catch {}
    // Set fake s_v_web_id nếu server không trả
    if (!jar.get('s_v_web_id')) {
      jar.cookies.set('s_v_web_id', device.verifyFp);
    }
  }

  // Passport POST
  async function passportPost(path, body) {
    const url = `${PASSPORT_HOST}${path}?${passportQs()}`;
    const csrf = jar.get('passport_csrf_token');
    const headers = {
      'User-Agent': device.ua,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      appid: '348188',
      Cookie: jar.header(),
    };
    if (csrf) headers['x-tt-passport-csrf-token'] = csrf;
    if (device.webId) headers['did'] = device.webId;

    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
      redirect: 'follow',
    });
    jar.capture(res);
    return res.json();
  }

  // Passport GET (same-origin path on www.capcut.com)
  async function passportGet(path) {
    const url = `${CAPCUT_HOST}${path}?${passportQs()}`;
    const csrf = jar.get('passport_csrf_token');
    const headers = {
      'User-Agent': device.ua,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      appid: '348188',
      Cookie: jar.header(),
    };
    if (csrf) headers['x-tt-passport-csrf-token'] = csrf;
    if (device.webId) headers['did'] = device.webId;

    const res = await fetchFn(url, { method: 'GET', headers, redirect: 'follow' });
    jar.capture(res);
    return res.json();
  }

  // Commerce POST
  async function commercePost(path, body) {
    const region = (jar.get('store-country-code') || 'VN').toUpperCase();
    const url = `${COMMERCE_HOST}${path}`;
    const headers = {
      'User-Agent': device.ua,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      appid: '348188',
      appvr: '12.4.0',
      lan: 'en',
      loc: region,
      pf: '7',
      Cookie: jar.header(),
    };
    if (device.webId) {
      headers['did'] = device.webId;
      headers['web_id'] = device.webId;
    }

    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    jar.capture(res);
    return res.json();
  }

  // ===== Public methods =====

  async function login(email, password) {
    const res = await passportPost('/passport/web/email/login/', {
      mix_mode: '1',
      email: encMixMode(email),
      password: encMixMode(password),
      type: '34',
      fixed_mix_mode: '1',
    });
    if (res.data?.user_id || res.data?.session_key) {
      return { ok: true, userId: String(res.data.user_id_str || res.data.user_id), screenName: res.data.screen_name };
    }
    return { ok: false, error: res.data?.description || res.message || 'unknown' };
  }

  async function getAccountInfo() {
    const res = await passportGet('/passport/web/account/info/');
    const d = res?.data || {};
    return {
      userId: String(d.user_id_str || d.uid_str || d.user_id || d.uid || ''),
      screenName: d.screen_name || d.nickname || '',
      email: d.email || '',
    };
  }

  async function getVipInfo() {
    try {
      const sub = await commercePost('/commerce/v1/subscription/user_info', { aid: '348188', scene: 'vip' });
      if (sub?.ret === '-6' || sub?.errmsg?.includes?.('shark')) return { vip: 'no-sign', endTime: 0 };
      return {
        vip: sub?.data?.flag ? 'YES' : 'NO',
        endTime: Number(sub?.data?.end_time) || 0,
        isFirstSubscribe: sub?.data?.is_first_subscribe,
      };
    } catch { return { vip: 'error', endTime: 0 }; }
  }

  async function getSubscriptionInfos() {
    try {
      const res = await commercePost('/commerce/v3/trade/subscription_infos', {
        scene: ['vip'], app_id: 348188, vip_levels: ['vip', 'ultra'],
      });
      if (res?.ret === '-6') return { vipInfos: [], shark: true };
      const infos = res?.data?.subscription_user_infos?.vip?.vip_infos || [];
      return { vipInfos: infos, shark: false };
    } catch { return { vipInfos: [], shark: false }; }
  }

  async function getCredits() {
    try {
      const res = await commercePost('/commerce/v1/benefits/user_credit', {});
      if (res?.ret === '-6') return { total: 'no-sign', vip: 0, gift: 0, purchase: 0 };
      const cr = res?.data?.credit || {};
      const vip = Number(cr.vip_credit) || 0;
      const gift = Number(cr.gift_credit) || 0;
      const purchase = Number(cr.purchase_credit) || 0;
      return { total: vip + gift + purchase, vip, gift, purchase };
    } catch { return { total: 'error', vip: 0, gift: 0, purchase: 0 }; }
  }

  async function hasTrial() {
    try {
      const region = (jar.get('store-country-code') || 'VN').toUpperCase();
      const res = await commercePost('/commerce/v1/subscription/cc_price_list', {
        aid: 348188, region, scene: 'vip',
      });
      if (res?.ret === '-6') return 'no-sign';
      const prices = res?.data?.all_price_list || [];
      return prices.some(p => p?.can_trial && p?.trial_cycle === 7) ? 'YES' : 'NO';
    } catch { return 'error'; }
  }

  async function getBenefits() {
    try {
      const res = await commercePost('/commerce/v3/benefits/batch_get_user_benefit', {
        query_list: [
          { resource_id: 'text_to_speech_web_tools', resource_type: 'aigc', benefit_type_list: ['text_to_speech_web_tools'] },
          { resource_id: 'tts_voice_changer_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_changer_web_tools'] },
          { resource_id: 'tts_voice_clone_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_clone_web_tools'] },
        ],
      });
      if (res?.ret === '-6') return 'no-sign';
      const assets = res?.data?.asset_list || [];
      const parts = [];
      for (const a of assets) {
        for (const b of (a.benefit_list || [])) {
          parts.push(`${a.resource_id}:${b.remaining ?? b.available ?? '?'}/${b.total ?? '?'}`);
        }
      }
      return parts.join(', ') || 'none';
    } catch { return 'error'; }
  }

  return { init, login, getAccountInfo, getVipInfo, getSubscriptionInfos, getCredits, hasTrial, getBenefits, jar };
}
