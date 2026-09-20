/**
 * F12 Console — Login CapCut + lấy đầy đủ thông tin tài khoản.
 * Mở capcut.com → F12 → Console → sửa EMAIL/PASS → dán → Enter.
 *
 * Endpoint đã xác minh bằng HAR thật (18/09/2026):
 *   - POST login-row.www.capcut.com/passport/web/email/login/
 *   - GET  www.capcut.com/passport/web/account/info/        (same-origin)
 *   - POST commerce-api-sg.capcut.com/commerce/v1/subscription/user_info
 *   - POST commerce-api-sg.capcut.com/commerce/v3/trade/subscription_infos
 *   - POST commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit
 *   - POST commerce-api-sg.capcut.com/commerce/v3/benefits/batch_get_user_benefit
 *   - POST commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list
 *
 * Tất cả commerce qua XHR (SDK webmssdk tự ký header `sign`).
 */

// ============ SỬA Ở ĐÂY ============
const EMAIL = 'email@example.com';
const PASS  = 'Password123';
// ====================================

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

  // --- Passport query string (giống HAR thật) ---
  const passportQs = () => new URLSearchParams({
    aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
    language: 'en', verifyFp: verifyFp(),
    timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Saigon',
    webid: webid(),
    browser_language: navigator.language || 'en-US',
    browser_name: 'Mozilla',
    browser_platform: navigator.platform || '',
    browser_version: navigator.appVersion || '',
    cookie_enabled: 'true',
    screen_height: String(screen.height),
    screen_width: String(screen.width),
  }).toString();

  // --- Passport POST (login-row, XHR) ---
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
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ _raw: xhr.responseText }); } };
    xhr.onerror = () => resolve({ _err: 'network' });
    xhr.ontimeout = () => resolve({ _err: 'timeout' });
    xhr.send(new URLSearchParams(body).toString());
  });

  // --- Passport GET same-origin (www.capcut.com) ---
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
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ _raw: xhr.responseText }); } };
    xhr.onerror = () => resolve({ _err: 'network' });
    xhr.ontimeout = () => resolve({ _err: 'timeout' });
    xhr.send();
  });

  // --- Commerce POST (XHR — SDK tự ký sign) ---
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
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ _raw: xhr.responseText }); } };
    xhr.onerror = () => resolve({ _err: 'network' });
    xhr.ontimeout = () => resolve({ _err: 'timeout' });
    xhr.send(JSON.stringify(body));
  });

  // ═══════════════════════════════════════════
  console.log('%c═══ CAPCUT LOGIN + INFO ═══', 'color:#00bcd4;font-weight:bold;font-size:16px');

  // ====== 1. LOGIN ======
  console.log('%c[1/6] Đăng nhập...', 'color:#2196f3;font-weight:bold');
  const login = await passportPost('https://login-row.www.capcut.com/passport/web/email/login/', {
    mix_mode: '1',
    email: enc(EMAIL),
    password: enc(PASS),
    type: '34',
    fixed_mix_mode: '1',
  });

  if (login.data?.user_id || login.data?.session_key) {
    console.log('%c  ✓ Login thành công', 'color:#4caf50;font-weight:bold');
    console.log('  user_id:', login.data.user_id_str || login.data.user_id);
    console.log('  screen_name:', login.data.screen_name);
  } else {
    console.error('  ✗ Login thất bại:', login.data?.description || login.message || login);
    console.log('%cDừng script. Kiểm tra lại email/password.', 'color:#f44336;font-weight:bold');
    return;
  }

  // Chờ session cookie set
  for (let i = 0; i < 20; i++) {
    if (ck('sessionid') || ck('sid_guard')) break;
    await sleep(500);
  }
  await sleep(1000);

  // ====== 2. ACCOUNT INFO ======
  console.log('%c[2/6] Account info...', 'color:#2196f3;font-weight:bold');
  const acct = await passportGet('/passport/web/account/info/');
  const u = acct.data || {};
  const acctTable = {
    'User ID': u.user_id_str || u.uid_str || u.user_id || u.uid || '-',
    'Tên': u.screen_name || u.name || u.nickname || '(chưa đặt)',
    'Email': u.email || EMAIL,
    'Avatar': u.avatar_url || u.avatar_larger?.url_list?.[0] || '-',
    'Ngày tạo': u.create_time ? new Date(u.create_time * 1000).toLocaleString() : '-',
    'Region': u.region || region(),
  };
  console.log('%c  ── Tài khoản ──', 'color:#ff9800;font-weight:bold');
  console.table(acctTable);

  // ====== 3. SUBSCRIPTION / VIP ======
  console.log('%c[3/6] VIP status...', 'color:#2196f3;font-weight:bold');
  const sub = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info',
    { aid: '348188', scene: 'vip' },
  );
  const sd = sub.data || {};
  const subTable = {
    'Đang VIP': sd.flag ? '✅ CÓ' : '❌ KHÔNG',
    'Bắt đầu': sd.start_time ? new Date(sd.start_time * 1000).toLocaleString() : '-',
    'Hết hạn': sd.end_time ? new Date(sd.end_time * 1000).toLocaleString() : '-',
    'Lần đầu mua': sd.is_first_subscribe ? 'Có' : 'Không',
    'Đã huỷ': sd.is_cancel_subscribe ? 'Có' : 'Không',
  };
  console.log('%c  ── VIP (user_info) ──', 'color:#ff9800;font-weight:bold');
  console.table(subTable);

  // Chi tiết VIP levels
  const subInfos = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v3/trade/subscription_infos',
    { scene: ['vip'], app_id: 348188, vip_levels: ['vip', 'ultra'] },
  );
  const vipInfos = subInfos?.data?.subscription_user_infos?.vip?.vip_infos || [];
  if (vipInfos.length > 0) {
    console.log('%c  ── VIP levels ──', 'color:#ff9800;font-weight:bold');
    vipInfos.forEach((v, i) => {
      console.table({
        'Level': v.vip_type || v.level || `#${i}`,
        'Active': v.is_vip ? '✅' : '❌',
        'Hết hạn': v.vip_end_time ? new Date(v.vip_end_time * 1000).toLocaleString() : '-',
        'Auto-renew': v.is_auto_renew ? 'Có' : 'Không',
        'Trial': v.is_trial ? 'Có' : 'Không',
      });
    });
  }

  // ====== 4. AI CREDITS ======
  console.log('%c[4/6] AI Credits (✦)...', 'color:#2196f3;font-weight:bold');
  const credits = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit',
    {},
  );
  const cr = credits?.data?.credit || {};
  const totalCredits = (cr.vip_credit || 0) + (cr.gift_credit || 0) + (cr.purchase_credit || 0);
  console.log('%c  ── AI Credits ──', 'color:#ff9800;font-weight:bold');
  console.table({
    'VIP credit': cr.vip_credit ?? 0,
    'Gift credit': cr.gift_credit ?? 0,
    'Purchase credit': cr.purchase_credit ?? 0,
    'TỔNG': totalCredits,
  });

  // ====== 5. BENEFITS ======
  console.log('%c[5/6] Benefits...', 'color:#2196f3;font-weight:bold');
  const benefits = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v3/benefits/batch_get_user_benefit',
    { query_list: [
      { resource_id: 'text_to_speech_web_tools', resource_type: 'aigc', benefit_type_list: ['text_to_speech_web_tools'] },
      { resource_id: 'tts_voice_changer_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_changer_web_tools'] },
      { resource_id: 'tts_voice_clone_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_clone_web_tools'] },
    ]},
  );
  const assets = benefits?.data?.asset_list || [];
  if (assets.length > 0) {
    console.log('%c  ── Benefits ──', 'color:#ff9800;font-weight:bold');
    assets.forEach(a => {
      const quotas = a.benefit_list || [];
      quotas.forEach(q => {
        console.table({
          'Resource': a.resource_id,
          'Type': q.benefit_type || '-',
          'Remaining': q.remaining ?? q.available ?? '-',
          'Total': q.total ?? '-',
          'Used': q.used ?? '-',
          'Source': q.source || '-',
        });
      });
    });
  }
  console.log('  [raw]', benefits?.data);

  // ====== 6. BẢNG GIÁ ======
  console.log('%c[6/6] Bảng giá VIP...', 'color:#2196f3;font-weight:bold');
  const pr = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',
    { aid: 348188, region: region(), scene: 'vip' },
  );
  const prices = pr?.data?.all_price_list || [];
  console.log('%c  ── Bảng giá ──', 'color:#ff9800;font-weight:bold');
  prices.forEach(p => {
    console.table({
      'Product': p.product_id || '-',
      'SKU': p.sku_id,
      'Trial': p.can_trial ? `✅ ${p.trial_cycle}d` : '❌',
      'pms_trade': p.pms_trade || '-',
    });
  });
  console.log('  [raw prices]', prices);

  // ═══ TỔNG KẾT ═══
  const vipEnd = sd.end_time ? new Date(sd.end_time * 1000).toLocaleDateString() : 'none';
  const hasTrial = prices.some(p => p.can_trial && p.trial_cycle === 7);
  console.log('%c═══ TỔNG KẾT ═══', 'color:#00bcd4;font-weight:bold;font-size:14px');
  console.table({
    'Email': u.email || EMAIL,
    'User ID': acctTable['User ID'],
    'Tên': acctTable['Tên'],
    'VIP': sd.flag ? '✅' : '❌',
    'VIP hết hạn': vipEnd,
    'AI Credits': `✦ ${totalCredits}`,
    'Trial 7d': hasTrial ? '✅ có' : '❌ không',
  });

  console.log('%c═══ XONG ═══', 'color:lime;font-weight:bold;font-size:14px');
})();
