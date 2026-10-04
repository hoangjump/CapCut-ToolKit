#!/usr/bin/env node
/**
 * CapCut Auto — CLI: (mua mail →) đăng ký / login → join team → check VIP/trial/credit.
 * Chạy `node index.js --help` để xem cách dùng.
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HELP = `
CapCut Auto — mua mail → đăng ký CapCut → join team → check VIP/trial/credit

  node index.js [N]              Mua N mail rồi chạy cả quy trình (mặc định: "count" trong config.json)
  node index.js --file=list.txt  Chạy từ file có sẵn, mỗi dòng:
                                   email|pass                          → login → join → check
                                   email|pass|refresh_token|client_id  → đăng ký → join → check
  node index.js --balance        Xem số dư nguồn mail
  node index.js --products       Liệt kê sản phẩm mail (lấy ID điền vào config.json)

Tuỳ chọn:
  --provider=stk|dvfb   Nguồn mua mail: stk = Selltaikhoan, dvfb = Dongvanfb
  --no-join             Bỏ bước join team
  --help                Hiện hướng dẫn này

Cấu hình (API key, link team, proxy…): config.json — mẫu ở config.example.json
`;

// ═══════════════════════════════════════════════════════════════════════════
// ARGS + CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const args = { _: [] };
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, ...v] = a.slice(2).split('=');
    args[k] = v.length ? v.join('=') : true;
  } else args._.push(a);
}

const CONFIG_FILE = resolve(__dir, 'config.json');
const DEFAULT_CONFIG = {
  mailProvider: 'stk', stkApiKey: '', stkProduct: '', dvfbApiKey: '', dvfbProduct: '',
  teamInviteLink: '', proxyKeys: '', rotateEach: true, delayMs: 3000, count: 1,
};

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch (e) {
    console.error(`config.json lỗi cú pháp: ${e.message}`);
    process.exit(1);
  }
}

const config = loadConfig();
if (typeof args.provider === 'string') config.mailProvider = args.provider;
if (args['no-join']) config.teamInviteLink = '';

const RESULTS_FILE = resolve(__dir, 'results.txt');
const MAILS_FILE = resolve(__dir, 'accounts.txt');

// ═══════════════════════════════════════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════════════════════════════════════

const tty = process.stdout.isTTY;
const color = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
function log(msg) {
  const t = color(90, `[${new Date().toLocaleTimeString('vi')}]`);
  const m = msg.includes('✓') ? color(32, msg) : msg.includes('✗') ? color(31, msg) : msg.includes('⚠') ? color(33, msg) : msg;
  console.log(`${t} ${m}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIL PROVIDERS — Selltaikhoan / Dongvanfb
// ═══════════════════════════════════════════════════════════════════════════

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, body: await res.json() };
  } finally { clearTimeout(timer); }
}

function parseMailRow(row) {
  const [email, password, refreshToken, clientId] = String(row).split('|').map(s => s.trim());
  return email ? { email, password, refreshToken, clientId } : null;
}

async function stkFetch(url, init) {
  const { res, body } = await fetchJson(url, init);
  if (!res.ok || (body.status && body.status !== 'success')) throw new Error(body.msg || `HTTP ${res.status}`);
  return body;
}

async function dvfbFetch(url) {
  const { res, body } = await fetchJson(url);
  if (!res.ok || body.status === false || (body.error_code && body.error_code !== 200)) {
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return body;
}

const MAIL_PROVIDERS = {
  stk: {
    name: 'Selltaikhoan',
    apiKey: c => c.stkApiKey,
    productId: c => c.stkProduct,
    async balance(key) {
      const body = await stkFetch(`https://www.selltaikhoan.com/api/profile.php?api_key=${encodeURIComponent(key)}`);
      return Number(body?.data?.money ?? 0);
    },
    async products(key) {
      const body = await stkFetch(`https://www.selltaikhoan.com/api/products.php?api_key=${encodeURIComponent(key)}`);
      const out = [];
      const walk = cat => {
        for (const p of cat?.products ?? []) out.push({ id: String(p.id), name: p.name, price: p.price, stock: p.amount });
        for (const sub of cat?.children ?? []) walk(sub);
      };
      (body?.categories ?? []).forEach(walk);
      return out;
    },
    async buy(key, productId) {
      const form = new URLSearchParams({ action: 'buyProduct', id: productId, amount: '1', api_key: key });
      const body = await stkFetch('https://www.selltaikhoan.com/api/buy_product', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      });
      for (const row of body?.data || []) { const m = parseMailRow(row); if (m) return m; }
      throw new Error('Mua mail thất bại');
    },
  },
  dvfb: {
    name: 'Dongvanfb',
    apiKey: c => c.dvfbApiKey,
    productId: c => c.dvfbProduct,
    async balance(key) {
      const body = await dvfbFetch(`https://api.dongvanfb.net/user/balance?apikey=${encodeURIComponent(key)}`);
      return Number(body?.balance ?? 0);
    },
    async products(key) {
      const body = await dvfbFetch(`https://api.dongvanfb.net/user/account_type?apikey=${encodeURIComponent(key)}`);
      return (body?.data ?? []).map(p => ({ id: String(p.id), name: p.name, price: p.price, stock: p.quality }));
    },
    async buy(key, productId) {
      const q = new URLSearchParams({ apikey: key, account_type: productId, quality: '1', type: 'full' });
      const body = await dvfbFetch(`https://api.dongvanfb.net/user/buy?${q}`);
      for (const row of body?.data?.list_data || []) { const m = parseMailRow(row); if (m) return m; }
      throw new Error('Mua mail thất bại');
    },
  },
};

function mailProvider() {
  const p = MAIL_PROVIDERS[config.mailProvider];
  if (!p) throw new Error(`Nguồn mail không hợp lệ: "${config.mailProvider}" (dùng stk hoặc dvfb)`);
  const key = p.apiKey(config);
  if (!key) throw new Error(`Chưa có API key ${p.name} trong config.json`);
  return { ...p, key, product: p.productId(config) };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROXY — mktproxy, round-robin nhiều key
// ═══════════════════════════════════════════════════════════════════════════

class ProxyPool {
  constructor(keyStr, rotate) {
    this.keys = String(keyStr || '').split(',').map(k => k.trim()).filter(Boolean);
    this.rotate = rotate;
    this.idx = 0;
  }
  get size() { return this.keys.length; }
  async next() {
    const ki = this.idx % this.keys.length;
    const key = this.keys[ki];
    this.idx++;
    try {
      const { body } = this.rotate
        ? await fetchJson('https://api.mktproxy.com/api/proxies/rotate-ip', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
        })
        : await fetchJson(`https://api.mktproxy.com/api/proxies/new?key=${encodeURIComponent(key)}`);
      const d = body?.data ?? {};
      const v = d.value || d.http || d.socks5 || '';
      const parts = v.split(':');
      let url = null;
      if (parts.length >= 4) url = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
      else if (parts.length >= 2 && d.user && d.pass) url = `http://${d.user}:${d.pass}@${parts[0]}:${parts[1]}`;
      return { url, keyIndex: ki + 1, ip: d.real_ip || d.ip || v };
    } catch (e) { return { url: null, keyIndex: ki + 1, error: e.message }; }
  }
}

function toPlaywrightProxy(proxyUrl) {
  const u = new URL(proxyUrl);
  const p = { server: `${u.protocol}//${u.hostname}:${u.port}` };
  if (u.username) { p.username = decodeURIComponent(u.username); p.password = decodeURIComponent(u.password); }
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════
// MICROSOFT GRAPH — đọc OTP CapCut từ hộp thư Outlook/Hotmail
// ═══════════════════════════════════════════════════════════════════════════

async function msGetAccessToken(refreshToken, clientId) {
  const form = new URLSearchParams({
    client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });
  const { body } = await fetchJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  if (!body.access_token) throw new Error(`MS token lỗi: ${body.error_description || body.error || 'unknown'}`);
  return body.access_token;
}

async function msWaitOtp(accessToken, afterIso, maxWaitMs = 90_000) {
  const start = Date.now();
  const filter = encodeURIComponent(`receivedDateTime ge ${afterIso}`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const { body } = await fetchJson(
        `https://graph.microsoft.com/v1.0/me/messages?$top=5&$orderby=receivedDateTime desc&$filter=${filter}&$select=subject,from,receivedDateTime`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      for (const msg of body?.value || []) {
        const subj = msg.subject || '';
        const from = msg.from?.emailAddress?.address || '';
        if (!/capcut|bytedance|lark/i.test(from) && !/verification|code/i.test(subj)) continue;
        const match = subj.match(/\b(\d{6})\b/);
        if (match) return match[1];
      }
    } catch {}
    await sleep(5_000);
  }
  throw new Error('Không nhận được OTP sau 90s');
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPCUT — passport (đăng ký / login) qua XHR trong trang, join team, lấy info
// ═══════════════════════════════════════════════════════════════════════════

function encMixMode(s) {
  let o = '';
  for (const x of new TextEncoder().encode(String(s))) o += ((x ^ 0x05) & 0xff).toString(16).padStart(2, '0');
  return o;
}

function randomCapcutPassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const r = (chars, n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${r(lower, 1).toUpperCase()}${r(lower, 6)}${r(digits, 4)}`;
}

function randomBirthday() {
  const y = 1995 + Math.floor(Math.random() * 6);
  const m = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const d = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function passportPost(page, apiPath, bodyObj) {
  return page.evaluate(({ p, body }) => {
    const ck = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
    const vfp = ck('s_v_web_id');
    const csrf = ck('passport_csrf_token');
    const webid = ck('tt_webid') || ck('tt_webid_v2') || vfp || '';
    const qs = new URLSearchParams({
      aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok', language: 'en', verifyFp: vfp, webid,
      browser_language: navigator.language || 'en-US', browser_name: 'Mozilla', browser_platform: navigator.platform || '',
      browser_version: navigator.appVersion || '', cookie_enabled: 'true',
      screen_height: String(screen.height), screen_width: String(screen.width),
    }).toString();
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://login-row.www.capcut.com' + p + '?' + qs, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('appid', '348188');
      if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
      if (webid) xhr.setRequestHeader('did', webid);
      xhr.timeout = 25000;
      xhr.onload = () => {
        try { const j = JSON.parse(xhr.responseText); resolve({ ok: true, data: j.data, message: j.message }); }
        catch { resolve({ ok: false, err: String(xhr.responseText || '').slice(0, 300) }); }
      };
      xhr.onerror = () => resolve({ ok: false, err: 'network' });
      xhr.ontimeout = () => resolve({ ok: false, err: 'timeout' });
      xhr.send(new URLSearchParams(body).toString());
    });
  }, { p: apiPath, body: bodyObj });
}

const passportError = r => r.data?.description || r.message || r.err || 'unknown';

async function registerCapcut(page, email, capcutPassword, getCode) {
  const encEmail = encMixMode(email);
  const encPass = encMixMode(capcutPassword);

  const chk = await passportPost(page, '/passport/web/user/check_email_registered', {
    mix_mode: '1', email: encEmail, fixed_mix_mode: '1',
  });
  if (!chk.ok) throw new Error(`check_email lỗi: ${passportError(chk)}`);
  if (chk.data?.is_registered === 1) throw new Error('Email đã có tài khoản CapCut');

  const snd = await passportPost(page, '/passport/web/email/send_code/', {
    mix_mode: '1', email: encEmail, password: encPass, type: '34', fixed_mix_mode: '1',
  });
  if (!snd.ok || !snd.data?.email_ticket) throw new Error(`send_code lỗi: ${passportError(snd)}`);

  const code = await getCode();

  const reg = await passportPost(page, '/passport/web/email/register_verify_login/', {
    mix_mode: '1', email: encEmail, code: encMixMode(code), password: encPass,
    type: '34', birthday: randomBirthday(), force_user_region: 'VN',
    biz_param: JSON.stringify({ invite_code: '' }), fixed_mix_mode: '1',
  });
  if (!reg.ok || !reg.data?.user_id) throw new Error(`register lỗi: ${passportError(reg)}`);
  return String(reg.data.user_id_str || reg.data.user_id);
}

async function loginCapcut(page, email, password) {
  const r = await passportPost(page, '/passport/web/email/login/', {
    mix_mode: '1', email: encMixMode(email), password: encMixMode(password), type: '34', fixed_mix_mode: '1',
  });
  if (r.ok && (r.data?.user_id || r.data?.session_key)) return String(r.data.user_id_str || r.data.user_id);
  throw new Error(`LOGIN: ${passportError(r)}`);
}

async function openLoginPage(context) {
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,webm}', r => r.abort());
  await page.route('**/monitor_browser/**', r => r.abort());
  await page.route('**/mcs-normal**', r => r.abort());
  await page.goto('https://www.capcut.com/login?locale=en', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => /s_v_web_id=/.test(document.cookie), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return page;
}

async function joinTeam(page, inviteLink) {
  const JOINED_MARKERS = ['already a member', 'joined', 'thành viên', 'đã tham gia', 'success'];
  const JOIN_LABELS = ['Submit', 'Join space', 'Join', 'Accept', 'Tham gia', 'Chấp nhận'];
  const pageSaysJoined = async () => {
    const text = (await page.innerText('body').catch(() => '')).toLowerCase();
    return JOINED_MARKERS.some(m => text.includes(m));
  };

  try {
    await page.goto(inviteLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(4_000);
    if (await pageSaysJoined()) { log('  join: đã là thành viên'); return true; }

    const respPromise = page.waitForResponse(r => r.url().includes('join_workspace_with_apply'), { timeout: 20_000 }).catch(() => null);

    let target = null;
    for (const label of JOIN_LABELS) {
      const loc = page.locator(`button:has-text("${label}"), div[role="button"]:has-text("${label}")`).last();
      if (await loc.isVisible({ timeout: 2_000 }).catch(() => false)) { target = loc; log(`  join: bấm "${label}"`); break; }
    }
    if (!target) {
      const byRole = page.getByRole('button', { name: /submit|join|accept/i }).last();
      if (await byRole.isVisible({ timeout: 2_000 }).catch(() => false)) { target = byRole; log('  join: bấm button (role)'); }
    }
    if (!target) {
      const btns = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(() => []);
      const seen = [...new Set(btns.map(t => t.trim()).filter(t => t && t.length < 30))];
      log(`  ⚠ join: không thấy nút Join${seen.length ? ` — nút đang có: [${seen.slice(0, 15).join(', ')}]` : ''}`);
      return false;
    }
    await target.click({ timeout: 5_000 }).catch(() => target.click({ force: true, timeout: 5_000 }).catch(() => {}));

    const resp = await respPromise;
    if (resp) {
      const body = await resp.json().catch(() => ({}));
      log(`  join: ret=${body?.ret} ${body?.errmsg || ''}`);
      return String(body?.ret) === '0' || /success/i.test(body?.errmsg || '');
    }
    await page.waitForTimeout(3_000);
    if (await pageSaysJoined()) return true;
    log('  ⚠ join: đã bấm nhưng không bắt được phản hồi — coi như OK');
    return true;
  } catch (e) {
    log(`  ⚠ join lỗi: ${e.message.slice(0, 80)}`);
    return false;
  }
}

async function getAccountInfo(page) {
  await page.goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  return page.evaluate(async () => {
    const ck = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
    const sl = ms => new Promise(r => setTimeout(r, ms));
    const region = (ck('store-country-code') || 'VN').toUpperCase();
    for (let i = 0; i < 20; i++) { if (ck('sessionid') || ck('sid_guard')) break; await sl(400); }
    const post = (url, body) => new Promise(resolve => {
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
    const sub = await post('https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info', { aid: '348188', scene: 'vip' });
    const vip = sub?.data?.flag ? 'YES' : 'NO';
    const pr = await post('https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list', { aid: 348188, region, scene: 'vip' });
    const trial = (pr?.data?.all_price_list || []).some(p => p?.can_trial && p?.trial_cycle === 7) ? 'YES' : 'NO';
    const cr = await post('https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit', {});
    const c = cr?.data?.credit || {};
    const credit = (c.vip_credit || 0) + (c.gift_credit || 0) + (c.purchase_credit || 0);
    return { vip, trial, credit };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE — 1 account: đăng ký hoặc login → join → check
// ═══════════════════════════════════════════════════════════════════════════

const CHROME_VERS = ['121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0'];
const SCREENS = [[1920, 1080], [2560, 1440], [1366, 768], [1440, 900], [1536, 864]];
const TZ = ['Asia/Saigon', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo'];
const pick = a => a[Math.floor(Math.random() * a.length)];

function newDevice() {
  const [w, h] = pick(SCREENS);
  const os = Math.random() > 0.5 ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7';
  return {
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${pick(CHROME_VERS)} Safari/537.36`,
    viewport: { width: w, height: h },
    timezoneId: pick(TZ),
  };
}

async function processAccount(browser, acct, proxyUrl) {
  const context = await browser.newContext({
    ...newDevice(), locale: 'en-US', ignoreHTTPSErrors: true,
    ...(proxyUrl ? { proxy: toPlaywrightProxy(proxyUrl) } : {}),
  });
  try {
    const page = await openLoginPage(context);
    let uid;
    let password = acct.password;

    if (acct.refreshToken && acct.clientId) {
      password = randomCapcutPassword();
      log(`  đăng ký CapCut (pass ${password})`);
      const token = await msGetAccessToken(acct.refreshToken, acct.clientId);
      const sentAt = new Date().toISOString();
      uid = await registerCapcut(page, acct.email, password, () => {
        log('  chờ OTP...');
        return msWaitOtp(token, sentAt);
      });
      log(`  đăng ký OK — uid=${uid}`);
    } else {
      uid = await loginCapcut(page, acct.email, password);
      log(`  login OK — uid=${uid}`);
    }

    let joined = '-';
    if (config.teamInviteLink) joined = (await joinTeam(page, config.teamInviteLink)) ? 'YES' : 'NO';

    const info = await getAccountInfo(page);
    return { email: acct.email, password, uid, ...info, joined };
  } finally {
    await context.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

function readAccountFile(file) {
  if (!existsSync(file)) throw new Error(`Không tìm thấy file ${file}`);
  return readFileSync(file, 'utf-8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(parseMailRow).filter(a => a && a.password);
}

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  log('⚠ Ctrl+C — dừng sau account hiện tại (bấm lần nữa để thoát ngay)');
});

async function run(total, nextAccount) {
  const pool = new ProxyPool(config.proxyKeys, config.rotateEach);
  log(`═══ ${total} account | team: ${config.teamInviteLink ? 'có' : 'không join'} | proxy: ${pool.size ? `${pool.size} key` : 'direct'} ═══`);

  if (!existsSync(RESULTS_FILE)) appendFileSync(RESULTS_FILE, 'email|pass|uid|vip|trial|credit|joined\n');
  const browser = await chromium.launch({ headless: true });
  const ok = [];
  let fail = 0;

  try {
    for (let i = 0; i < total && !stopRequested; i++) {
      let acct;
      try { acct = await nextAccount(i); } catch (e) { log(`✗ ${e.message} — dừng`); break; }
      log(`[${i + 1}/${total}] ${acct.email}`);

      let proxyUrl = null;
      if (pool.size) {
        const p = await pool.next();
        if (p.url) { proxyUrl = p.url; log(`  proxy #${p.keyIndex}: ${p.ip}`); }
        else log(`  ⚠ proxy #${p.keyIndex} lỗi${p.error ? `: ${p.error}` : ''} — chạy direct`);
      }

      try {
        const r = await processAccount(browser, acct, proxyUrl);
        ok.push(r);
        appendFileSync(RESULTS_FILE, `${r.email}|${r.password}|${r.uid}|${r.vip}|${r.trial}|${r.credit}|${r.joined}\n`);
        log(`  ✓ vip=${r.vip} trial=${r.trial} credit=${r.credit} joined=${r.joined}`);
      } catch (e) {
        fail++;
        const msg = e.message.split('\n')[0].slice(0, 120);
        appendFileSync(RESULTS_FILE, `${acct.email}|${acct.password}|ERROR:${msg}||||\n`);
        log(`  ✗ ${msg}`);
      }

      if (i < total - 1 && !stopRequested) await sleep(config.delayMs);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n═══ XONG: ${ok.length} OK, ${fail} lỗi — chi tiết trong results.txt ═══`);
  if (ok.length) {
    console.log('\nemail|pass:');
    for (const r of ok) console.log(`${r.email}|${r.password}`);
  }
}

async function main() {
  if (args.help) { console.log(HELP); return; }

  if (args.balance) {
    const p = mailProvider();
    console.log(`${p.name}: ${(await p.balance(p.key)).toLocaleString('vi')}đ`);
    return;
  }

  if (args.products) {
    const p = mailProvider();
    const list = (await p.products(p.key)).filter(x => /mail|outlook|hotmail/i.test(x.name));
    console.log(`${p.name} — sản phẩm mail (ID | giá | kho | tên):`);
    for (const x of list) console.log(`  ${x.id.padEnd(6)} ${String(x.price).padStart(6)}đ  ${String(x.stock ?? '-').padStart(5)}  ${x.name}`);
    return;
  }

  if (typeof args.file === 'string') {
    const accounts = readAccountFile(resolve(process.cwd(), args.file));
    if (!accounts.length) throw new Error(`File ${args.file} không có dòng email|pass nào`);
    await run(accounts.length, i => accounts[i]);
    return;
  }

  const count = Number(args._[0] ?? config.count);
  if (!Number.isInteger(count) || count < 1) throw new Error(`Số lượng không hợp lệ: ${args._[0] ?? config.count}`);
  const p = mailProvider();
  if (!p.product) throw new Error(`Chưa có ID sản phẩm mail ${p.name} trong config.json — chạy --products để xem`);
  log(`Mua mail từ ${p.name} (sản phẩm ${p.product})`);

  await run(count, async () => {
    const mail = await p.buy(p.key, p.product);
    appendFileSync(MAILS_FILE, `${mail.email}|${mail.password || ''}|${mail.refreshToken || ''}|${mail.clientId || ''}\n`);
    if (!mail.refreshToken || !mail.clientId) throw new Error(`Mail ${mail.email} không có refresh_token/client_id — chọn sản phẩm OAuth2`);
    return mail;
  });
}

main().catch(e => { console.error(color(31, `✗ ${e.message}`)); process.exit(1); });
