/**
 * F12 Console — Lấy thông tin tài khoản CapCut đang đăng nhập.
 * Mở capcut.com (đã login) → F12 → Console → dán → Enter.
 *
 * Dùng XHR cho commerce (SDK tự ký header `sign`).
 * Dùng fetch same-origin cho passport/account/info.
 */
(async () => {
  const cookie = (n) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const region = (cookie('store-country-code') || 'VN').toUpperCase();
  const webid = cookie('tt_webid') || cookie('tt_webid_v2') || cookie('s_v_web_id') || '';

  // Commerce POST qua XHR (SDK tự thêm sign/device-time/web_id)
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
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ _raw: xhr.responseText }); } };
    xhr.onerror = () => resolve({ _err: 'network' });
    xhr.ontimeout = () => resolve({ _err: 'timeout' });
    xhr.send(JSON.stringify(body));
  });

  // Passport GET same-origin (www.capcut.com)
  const passportGet = (path) => new Promise((resolve) => {
    const verifyFp = cookie('s_v_web_id');
    const csrf = cookie('passport_csrf_token');
    const qs = new URLSearchParams({
      aid: '348188',
      account_sdk_source: 'web',
      sdk_version: '2.1.10-tiktok',
      language: 'en',
      verifyFp,
      webid,
    }).toString();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path + '?' + qs, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('appid', '348188');
    if (webid) xhr.setRequestHeader('did', webid);
    if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
    xhr.timeout = 15000;
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ _raw: xhr.responseText }); } };
    xhr.onerror = () => resolve({ _err: 'network' });
    xhr.ontimeout = () => resolve({ _err: 'timeout' });
    xhr.send();
  });

  console.log('%c═══ CAPCUT ACCOUNT INFO ═══', 'color:#00bcd4;font-weight:bold;font-size:14px');

  // 1. Account info (GET same-origin)
  const acct = await passportGet('/passport/web/account/info/');
  console.log('%c── 1. Account Info ──', 'color:#ff9800;font-weight:bold');
  console.log(acct);
  if (acct.data) console.log('%c→ data:', 'color:#4caf50', acct.data);

  // 2. Subscription / VIP
  const sub = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info',
    { aid: '348188', scene: 'vip' },
  );
  console.log('%c── 2. Subscription / VIP ──', 'color:#ff9800;font-weight:bold');
  console.log(sub);
  if (sub.data) console.log('%c→ data:', 'color:#4caf50', sub.data);

  // 3. Subscription infos (vip levels)
  const subInfos = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v3/trade/subscription_infos',
    { scene: ['vip'], app_id: 348188, vip_levels: ['vip', 'ultra'] },
  );
  console.log('%c── 3. Subscription Infos ──', 'color:#ff9800;font-weight:bold');
  console.log(subInfos);
  if (subInfos.data) console.log('%c→ data:', 'color:#4caf50', subInfos.data);

  // 4. AI Credits (✦ points)
  const credits = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit',
    {},
  );
  console.log('%c── 4. AI Credits (✦) ──', 'color:#ff9800;font-weight:bold');
  console.log(credits);
  if (credits.data) console.log('%c→ data:', 'color:#4caf50', credits.data);

  // 5. Benefits
  const benefits = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v3/benefits/batch_get_user_benefit',
    { query_list: [
        { resource_id: 'text_to_speech_web_tools', resource_type: 'aigc', benefit_type_list: ['text_to_speech_web_tools'] },
        { resource_id: 'tts_voice_changer_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_changer_web_tools'] },
      ]
    },
  );
  console.log('%c── 5. Benefits ──', 'color:#ff9800;font-weight:bold');
  console.log(benefits);
  if (benefits.data) console.log('%c→ data:', 'color:#4caf50', benefits.data);

  // 6. Benefit metadata
  const meta = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v3/resource/benefit_metadata',
    {},
  );
  console.log('%c── 6. Benefit Metadata ──', 'color:#ff9800;font-weight:bold');
  console.log(meta);
  if (meta.data) console.log('%c→ data:', 'color:#4caf50', meta.data);

  // 7. Price list
  const prices = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',
    { aid: 348188, region, scene: 'vip' },
  );
  console.log('%c── 7. Price List ──', 'color:#ff9800;font-weight:bold');
  console.log(prices);
  if (prices.data) console.log('%c→ data:', 'color:#4caf50', prices.data);

  // 8. Workspace space
  const space = await commercePost(
    'https://commerce-api-sg.capcut.com/commerce/v1/subscription/workspace/space_list',
    {},
  );
  console.log('%c── 8. Workspace Space ──', 'color:#ff9800;font-weight:bold');
  console.log(space);
  if (space.data) console.log('%c→ data:', 'color:#4caf50', space.data);

  console.log('%c═══ XONG — mở từng mục ▸ ở trên để xem chi tiết ═══', 'color:lime;font-weight:bold;font-size:14px');
})();
