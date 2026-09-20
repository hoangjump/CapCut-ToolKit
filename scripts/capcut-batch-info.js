/**
 * F12 Console — Login hàng loạt CapCut, xuất thông tin.
 * Mở capcut.com → F12 → Console → dán danh sách ACCOUNTS → dán script → Enter.
 *
 * Kết quả: email|pass|uid|vip|trial|credit|benefit
 */

// ============ DÁN DANH SÁCH email|password VÀO ĐÂY ============
const ACCOUNTS = `
email1@example.com|Password123
email2@example.com|Password456
`.trim().split('\n').map(l => l.trim()).filter(Boolean);
// ================================================================

(async () => {
  const enc = (s) => {
    const bytes = new TextEncoder().encode(String(s));
    let out = '';
    for (const b of bytes) out += ((b ^ 0x05) & 0xff).toString(16).padStart(2, '0');
    return out;
  };
  const ck = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const verifyFp = () => ck('s_v_web_id');
  const csrf = () => ck('passport_csrf_token');
  const webid = () => ck('tt_webid') || ck('tt_webid_v2') || verifyFp() || '';
  const region = () => (ck('store-country-code') || 'VN').toUpperCase();

  const passportQs = () => new URLSearchParams({
    aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
    language: 'en', verifyFp: verifyFp(), webid: webid(),
    browser_language: navigator.language || 'en-US', browser_name: 'Mozilla',
    browser_platform: navigator.platform || '', browser_version: navigator.appVersion || '',
    cookie_enabled: 'true', screen_height: String(screen.height), screen_width: String(screen.width),
  }).toString();

  const passportPost = (url, body) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url + '?' + passportQs(), true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('appid', '348188');
    const c = csrf(); if (c) xhr.setRequestHeader('x-tt-passport-csrf-token', c);
    const w = webid(); if (w) xhr.setRequestHeader('did', w);
    xhr.timeout = 25000;
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
    xhr.onerror = () => resolve({ _err: 'network' });
    xhr.ontimeout = () => resolve({ _err: 'timeout' });
    xhr.send(new URLSearchParams(body).toString());
  });

  const passportGet = (path) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path + '?' + passportQs(), true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('appid', '348188');
    const c = csrf(); if (c) xhr.setRequestHeader('x-tt-passport-csrf-token', c);
    const w = webid(); if (w) xhr.setRequestHeader('did', w);
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
    xhr.setRequestHeader('loc', region());
    xhr.setRequestHeader('pf', '7');
    xhr.timeout = 15000;
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
    xhr.onerror = () => resolve({});
    xhr.ontimeout = () => resolve({});
    xhr.send(JSON.stringify(body));
  });

  // === Process one account ===
  async function processAccount(email, password) {
    // Login
    const login = await passportPost('https://login-row.www.capcut.com/passport/web/email/login/', {
      mix_mode: '1', email: enc(email), password: enc(password),
      type: '34', fixed_mix_mode: '1',
    });
    if (!login.data?.user_id && !login.data?.session_key) {
      return `${email}|${password}|LOGIN_FAIL: ${login.data?.description || login.message || 'unknown'}||||`;
    }

    // Wait session
    for (let i = 0; i < 15; i++) {
      if (ck('sessionid') || ck('sid_guard')) break;
      await sleep(400);
    }
    await sleep(500);

    // Account info
    const acct = await passportGet('/passport/web/account/info/');
    const uid = acct.data?.user_id_str || acct.data?.user_id || login.data?.user_id_str || login.data?.user_id || '';

    // VIP
    const sub = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info',
      { aid: '348188', scene: 'vip' },
    );
    const isVip = sub.data?.flag ? 'YES' : 'NO';

    // Trial
    const pr = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',
      { aid: 348188, region: region(), scene: 'vip' },
    );
    const prices = pr?.data?.all_price_list || [];
    const hasTrial = prices.some(p => p?.can_trial && p?.trial_cycle === 7) ? 'YES' : 'NO';

    // Credits
    const credits = await commercePost(
      'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit',
      {},
    );
    const cr = credits?.data?.credit || {};
    const totalCredits = (cr.vip_credit || 0) + (cr.gift_credit || 0) + (cr.purchase_credit || 0);

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
    assets.forEach(a => {
      (a.benefit_list || []).forEach(b => {
        const rem = b.remaining ?? b.available ?? '?';
        const tot = b.total ?? '?';
        benefitParts.push(`${a.resource_id}:${rem}/${tot}`);
      });
    });
    const benefitStr = benefitParts.join(', ') || 'none';

    return `${email}|${password}|${uid}|${isVip}|${hasTrial}|${totalCredits}|${benefitStr}`;
  }

  // === Run all ===
  console.log('%c═══ CAPCUT BATCH LOGIN ═══', 'color:#00bcd4;font-weight:bold;font-size:16px');
  console.log(`Tổng: ${ACCOUNTS.length} tài khoản`);
  console.log('%cemail|pass|uid|vip|trial|credit|benefit', 'color:#888');
  console.log('');

  const results = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const [email, password] = ACCOUNTS[i].split('|');
    if (!email || !password) {
      results.push(`${ACCOUNTS[i]}|SKIP: thiếu email hoặc pass||||`);
      continue;
    }
    console.log(`%c[${i + 1}/${ACCOUNTS.length}] ${email}...`, 'color:#2196f3');
    try {
      const line = await processAccount(email.trim(), password.trim());
      results.push(line);
      console.log(`%c  ✓ ${line}`, 'color:#4caf50');
    } catch (e) {
      const line = `${email}|${password}|ERROR: ${e.message}||||`;
      results.push(line);
      console.log(`%c  ✗ ${line}`, 'color:#f44336');
    }
    // Nghỉ giữa các account tránh rate limit
    if (i < ACCOUNTS.length - 1) await sleep(2000);
  }

  // === Output ===
  const output = results.join('\n');
  console.log('');
  console.log('%c═══ KẾT QUẢ (copy bên dưới) ═══', 'color:lime;font-weight:bold;font-size:14px');
  console.log(output);

  // Copy to clipboard
  try {
    await navigator.clipboard.writeText(output);
    console.log('%c📋 Đã copy vào clipboard!', 'color:lime;font-weight:bold');
  } catch {
    console.log('%c⚠ Không copy được clipboard — hãy chọn text ở trên rồi copy tay.', 'color:orange');
  }

  console.log('%c═══ XONG ═══', 'color:lime;font-weight:bold;font-size:14px');
})();
