#!/usr/bin/env node
/**
 * CapCut Auto — Mua mail selltaikhoan → Đăng ký CapCut → Join team → Check info.
 *
 * Usage:
 *   node app.js                       # dùng .env
 *   node app.js --count=5             # tạo 5 account
 *   node app.js --mode=check          # chỉ check (đọc accounts.txt)
 *   node app.js --mode=join           # chỉ join team (đọc accounts.txt)
 *
 * Modes:
 *   register  — mua mail + đăng ký CapCut + join team + check info (mặc định)
 *   check     — chỉ login + check info (đọc accounts.txt)
 *   join      — chỉ login + join team (đọc accounts.txt)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const envFile = resolve(__dir, '.env');
const env = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

const cli = {};
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 2) cli[arg.slice(2, eq).replace(/-/g, '_').toUpperCase()] = arg.slice(eq + 1);
  }
}

function cfg(name, fallback = '') { return cli[name] ?? env[name] ?? fallback; }

const SELLTK_API_KEY   = cfg('SELLTK_API_KEY', '');
const SELLTK_PRODUCT   = cfg('SELLTK_PRODUCT', '');      // product id (vd 6762)
const TEAM_INVITE_LINK = cfg('TEAM_INVITE_LINK', '');
const COUNT            = Number(cfg('COUNT', '1'));
const MODE             = cfg('MODE', 'register');         // register | check | join
const DELAY_MS         = Number(cfg('DELAY_MS', '3000'));

const rawProxyKeys     = cfg('MKT_PROXY_KEYS', '') || cfg('MKT_PROXY_KEY', '');
const MKT_PROXY_KEYS   = rawProxyKeys.split(',').map(k => k.trim()).filter(Boolean);
const ROTATE_EACH      = cfg('ROTATE_EACH', 'true') !== 'false';

const INPUT_FILE  = resolve(__dir, cfg('INPUT_FILE', 'accounts.txt'));
const OUTPUT_FILE = resolve(__dir, cfg('OUTPUT_FILE', 'results.txt'));

// ═══════════════════════════════════════════════════════════════════════════
// SELLTAIKHOAN API
// ═══════════════════════════════════════════════════════════════════════════

const STK_BASE = 'https://www.selltaikhoan.com/api';

async function stkFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok || (body.status && body.status !== 'success')) {
      throw new Error(body.msg || `HTTP ${res.status}`);
    }
    return body;
  } finally { clearTimeout(timer); }
}

async function stkBalance() {
  const body = await stkFetch(`${STK_BASE}/profile.php?api_key=${encodeURIComponent(SELLTK_API_KEY)}`);
  return Number(body?.data?.money ?? 0);
}

async function stkProducts() {
  const body = await stkFetch(`${STK_BASE}/products.php?api_key=${encodeURIComponent(SELLTK_API_KEY)}`);
  const out = [];
  const walk = (cat) => {
    for (const p of cat?.products ?? []) out.push({ id: String(p.id), name: p.name, price: p.price, amount: p.amount });
    for (const sub of cat?.children ?? []) walk(sub);
  };
  (body?.categories ?? []).forEach(walk);
  return out;
}

async function stkBuy(productId) {
  const form = new URLSearchParams({
    action: 'buyProduct', id: productId, amount: '1', api_key: SELLTK_API_KEY,
  });
  const body = await stkFetch(`${STK_BASE}/buy_product`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const rows = Array.isArray(body?.data) ? body.data : [];
  for (const row of rows) {
    const [email, password, refreshToken, clientId] = row.split('|').map(s => s.trim());
    if (email) return { email, password, refreshToken, clientId };
  }
  throw new Error(`Mua mail thất bại — raw: ${JSON.stringify(body).slice(0, 200)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PROXY POOL (round-robin nhiều key mktproxy)
// ═══════════════════════════════════════════════════════════════════════════

class ProxyPool {
  constructor(keys, rotate = true) { this.keys = keys; this.rotate = rotate; this.idx = 0; }
  get size() { return this.keys.length; }
  async next() {
    if (!this.keys.length) return null;
    const key = this.keys[this.idx % this.keys.length];
    const ki = (this.idx % this.keys.length) + 1;
    this.idx++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const path = this.rotate ? '/proxies/rotate-ip' : '/proxies/new';
      const opts = this.rotate
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }), signal: ctrl.signal }
        : { method: 'GET', signal: ctrl.signal };
      const url = this.rotate
        ? `https://api.mktproxy.com/api${path}`
        : `https://api.mktproxy.com/api/proxies/new?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, opts);
      clearTimeout(timer);
      const body = await res.json();
      const d = body?.data ?? {};
      const v = d.value || d.http || d.socks5 || '';
      const parts = v.split(':');
      let pUrl = null;
      if (parts.length >= 4) pUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
      else if (parts.length >= 2 && d.user && d.pass) pUrl = `http://${d.user}:${d.pass}@${parts[0]}:${parts[1]}`;
      return { url: pUrl, keyIndex: ki, ip: d.real_ip || d.ip || v };
    } catch (e) {
      return { url: null, keyIndex: ki, ip: null, error: e.message };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEVICE FINGERPRINT
// ═══════════════════════════════════════════════════════════════════════════

const CHROME_VERS = ['121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0'];
const SCREENS = [[1920,1080],[2560,1440],[1366,768],[1440,900],[1536,864]];
const TZ = ['Asia/Saigon','Asia/Bangkok','Asia/Singapore','Asia/Tokyo','America/New_York'];
const rand = a => a[Math.floor(Math.random() * a.length)];
const randDigits = n => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };
const randHex = n => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };

function newDevice() {
  const cv = rand(CHROME_VERS);
  const [sw, sh] = rand(SCREENS);
  const tz = rand(TZ);
  const os = Math.random() > 0.5 ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7';
  return {
    ua: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cv} Safari/537.36`,
    screenWidth: sw, screenHeight: sh, timezone: tz,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPCUT — mix_mode encoding
// ═══════════════════════════════════════════════════════════════════════════

function encMixMode(s) {
  const bytes = new TextEncoder().encode(String(s));
  let out = '';
  for (const b of bytes) out += ((b ^ 0x05) & 0xff).toString(16).padStart(2, '0');
  return out;
}

function randomPassword() {
  const lo = 'abcdefghijkmnpqrstuvwxyz';
  const di = '23456789';
  const r = (c, n) => Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
  return `${r(lo, 1).toUpperCase()}${r(lo, 6)}${r(di, 4)}`;
}

function randomBirthday() {
  const y = 1995 + Math.floor(Math.random() * 6);
  const m = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const d = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

let browser = null;

async function launchBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
}

async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

function makeContextOpts(device, proxyUrl) {
  const opts = {
    userAgent: device.ua, locale: 'en-US',
    viewport: { width: device.screenWidth, height: device.screenHeight },
    timezoneId: device.timezone, ignoreHTTPSErrors: true,
  };
  if (proxyUrl) {
    const u = new URL(proxyUrl);
    opts.proxy = { server: `${u.protocol}//${u.hostname}:${u.port}` };
    if (u.username) { opts.proxy.username = decodeURIComponent(u.username); opts.proxy.password = decodeURIComponent(u.password); }
  }
  return opts;
}

/** Mở trang login, chờ SDK load → trả page đã sẵn sàng gọi API passport. */
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

/** Đăng ký CapCut qua API passport (3 bước: check → send_code → register). */
async function registerCapcut(page, email, password, log) {
  const encEmail = encMixMode(email);
  const encPass = encMixMode(password);
  const birthday = randomBirthday();

  const passportPost = async (path, body) => page.evaluate(
    ({ host, p, body }) => {
      const g = globalThis; const doc = g.document; const nav = g.navigator; const scr = g.screen;
      const ck = n => { const m = String(doc?.cookie ?? '').match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
      const vfp = ck('s_v_web_id'); const csrf = ck('passport_csrf_token');
      const webid = ck('tt_webid') || ck('tt_webid_v2') || vfp || '';
      const qs = new URLSearchParams({
        aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok', language: 'en', verifyFp: vfp,
        timezone_name: (g.Intl?.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Saigon', webid,
        browser_language: nav.language || 'en-US', browser_name: 'Mozilla',
        browser_platform: nav.platform || 'Win32', browser_version: nav.appVersion || '',
        cookie_enabled: 'true', screen_height: String(scr.height), screen_width: String(scr.width),
      }).toString();
      return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', host + p + '?' + qs, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.setRequestHeader('Accept', 'application/json');
        if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
        xhr.setRequestHeader('appid', '348188');
        if (webid) xhr.setRequestHeader('did', webid);
        xhr.timeout = 25000;
        xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ error: 'parse' }); } };
        xhr.onerror = () => resolve({ error: 'network' });
        xhr.ontimeout = () => resolve({ error: 'timeout' });
        xhr.send(new URLSearchParams(body).toString());
      });
    },
    { host: 'https://login-row.www.capcut.com', p: path, body },
  );

  // B1: check email
  const chk = await passportPost('/passport/web/user/check_email_registered', {
    mix_mode: '1', email: encEmail, fixed_mix_mode: '1',
  });
  if (chk.error) throw new Error(`check_email lỗi: ${chk.error}`);
  if (chk.data?.is_registered === 1) throw new Error('Email đã đăng ký CapCut');

  // B2: send code
  const snd = await passportPost('/passport/web/email/send_code/', {
    mix_mode: '1', email: encEmail, password: encPass, type: '34', fixed_mix_mode: '1',
  });
  if (!snd.data?.email_ticket) {
    throw new Error(`send_code lỗi: ${snd.data?.description || snd.message || JSON.stringify(snd).slice(0, 100)}`);
  }
  log(`  đã gửi OTP tới ${email}`);

  // B3: đọc OTP từ mail selltaikhoan (dùng outlook IMAP)
  // selltaikhoan mail không có API đọc OTP → poll không được
  // → dùng tempmail hoặc flow chỉ dùng selltaikhoan cho account CHECK, không đăng ký
  throw new Error('selltaikhoan mail không hỗ trợ đọc OTP — dùng mode=check hoặc tempmail');
}

/** Login CapCut qua API passport. */
async function loginCapcut(page, email, password) {
  return page.evaluate(
    ({ email, password }) => {
      const enc = s => { const b = new TextEncoder().encode(String(s)); let o = ''; for (const x of b) o += ((x ^ 0x05) & 0xff).toString(16).padStart(2, '0'); return o; };
      const ck = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
      const vfp = ck('s_v_web_id'); const csrf = ck('passport_csrf_token');
      const webid = ck('tt_webid') || ck('tt_webid_v2') || vfp || '';
      const qs = new URLSearchParams({
        aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok',
        language: 'en', verifyFp: vfp, webid,
        browser_language: navigator.language || 'en-US', browser_name: 'Mozilla',
        browser_platform: navigator.platform || '', browser_version: navigator.appVersion || '',
        cookie_enabled: 'true', screen_height: String(screen.height), screen_width: String(screen.width),
      }).toString();
      return new Promise(resolve => {
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
}

/** Join team CapCut qua invite link. */
async function joinTeam(page, inviteLink, log) {
  try {
    await page.goto(inviteLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3_000);

    const url = page.url();
    if (url.includes('/my-cloud/')) {
      log('  ✓ join team OK (auto-redirect)');
      return true;
    }

    // Tìm nút Join/Accept
    for (const label of ['Join', 'Accept', 'Accept invitation']) {
      const btn = page.getByText(label, { exact: true }).filter({ visible: true }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 5_000 }).catch(() => btn.dispatchEvent('click'));
        await page.waitForTimeout(3_000);
        log('  ✓ join team OK (bấm nút)');
        return true;
      }
    }

    log(`  ⚠ join team: không tìm nút Join (${url.slice(0, 60)})`);
    return false;
  } catch (e) {
    log(`  ⚠ join team lỗi: ${e.message.slice(0, 80)}`);
    return false;
  }
}

/** Lấy full info account (VIP, trial, credits, benefits). */
async function getAccountInfo(page) {
  await page.goto('https://www.capcut.com/my-edit?start_tab=video', {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  }).catch(() => {});
  await page.waitForTimeout(2_000);

  return page.evaluate(async () => {
    const ck = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const region = (ck('store-country-code') || 'VN').toUpperCase();

    for (let i = 0; i < 20; i++) { if (ck('sessionid') || ck('sid_guard')) break; await sleep(400); }

    const post = (url, body) => new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true); xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('appid', '348188'); xhr.setRequestHeader('appvr', '12.4.0');
      xhr.setRequestHeader('lan', 'en'); xhr.setRequestHeader('loc', region); xhr.setRequestHeader('pf', '7');
      xhr.timeout = 15000;
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
      xhr.onerror = () => resolve({}); xhr.ontimeout = () => resolve({});
      xhr.send(JSON.stringify(body));
    });

    const passGet = path => new Promise(resolve => {
      const vfp = ck('s_v_web_id'); const csrf = ck('passport_csrf_token'); const wid = ck('tt_webid') || vfp || '';
      const qs = new URLSearchParams({ aid: '348188', account_sdk_source: 'web', sdk_version: '2.1.10-tiktok', language: 'en', verifyFp: vfp, webid: wid }).toString();
      const xhr = new XMLHttpRequest();
      xhr.open('GET', path + '?' + qs, true); xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json'); xhr.setRequestHeader('appid', '348188');
      if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
      xhr.timeout = 15000;
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } };
      xhr.onerror = () => resolve({}); xhr.ontimeout = () => resolve({});
      xhr.send();
    });

    const acct = await passGet('/passport/web/account/info/');
    const uid = String(acct?.data?.user_id_str || acct?.data?.user_id || '');

    const sub = await post('https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info', { aid: '348188', scene: 'vip' });
    const vip = sub?.data?.flag ? 'YES' : 'NO';

    const pr = await post('https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list', { aid: 348188, region, scene: 'vip' });
    const trial = (pr?.data?.all_price_list || []).some(p => p?.can_trial && p?.trial_cycle === 7) ? 'YES' : 'NO';

    const credits = await post('https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit', {});
    const cr = credits?.data?.credit || {};
    const totalCredit = (cr.vip_credit || 0) + (cr.gift_credit || 0) + (cr.purchase_credit || 0);

    const ben = await post('https://commerce-api-sg.capcut.com/commerce/v3/benefits/batch_get_user_benefit', {
      query_list: [
        { resource_id: 'text_to_speech_web_tools', resource_type: 'aigc', benefit_type_list: ['text_to_speech_web_tools'] },
        { resource_id: 'tts_voice_changer_web_tools', resource_type: 'aigc', benefit_type_list: ['tts_voice_changer_web_tools'] },
      ],
    });
    const parts = [];
    for (const a of (ben?.data?.asset_list || [])) {
      for (const b of (a.benefit_list || [])) {
        parts.push(`${a.resource_id}:${b.remaining ?? b.available ?? '?'}/${b.total ?? '?'}`);
      }
    }

    return { uid, vip, trial, credit: totalCredit, benefit: parts.join(', ') || 'none' };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS ONE ACCOUNT (login + join + info)
// ═══════════════════════════════════════════════════════════════════════════

async function processAccount(email, password, device, proxyUrl, { doJoin, doInfo }) {
  const log = (msg) => console.log(msg);
  const context = await browser.newContext(makeContextOpts(device, proxyUrl));
  try {
    const page = await openLoginPage(context);

    // Login
    const loginRes = await loginCapcut(page, email, password);
    if (!loginRes.ok) return { error: `LOGIN:${loginRes.error}` };
    log(`  ✓ login uid=${loginRes.uid}`);

    // Join team
    let joined = '';
    if (doJoin && TEAM_INVITE_LINK) {
      const ok = await joinTeam(page, TEAM_INVITE_LINK, log);
      joined = ok ? 'YES' : 'NO';
    }

    // Info
    let info = {};
    if (doInfo) {
      info = await getAccountInfo(page);
      log(`  ✓ vip=${info.vip} trial=${info.trial} credit=${info.credit}`);
    }

    return {
      uid: info.uid || loginRes.uid,
      vip: info.vip || '',
      trial: info.trial || '',
      credit: info.credit ?? '',
      benefit: info.benefit || '',
      joined,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══ CAPCUT AUTO ═══');
  console.log(`Mode:          ${MODE}`);

  const pool = new ProxyPool(MKT_PROXY_KEYS, ROTATE_EACH);

  if (MODE === 'register') {
    // --- MUA MAIL + ĐĂNG KÝ ---
    if (!SELLTK_API_KEY) { console.error('Thiếu SELLTK_API_KEY trong .env'); process.exit(1); }
    if (!SELLTK_PRODUCT) { console.error('Thiếu SELLTK_PRODUCT trong .env'); process.exit(1); }

    const balance = await stkBalance();
    console.log(`Selltaikhoan:  số dư ${balance}đ`);
    console.log(`Product:       ${SELLTK_PRODUCT}`);
    console.log(`Count:         ${COUNT}`);
    console.log(`Team invite:   ${TEAM_INVITE_LINK || '(không)'}`);
    console.log(`Proxy keys:    ${pool.size || '(direct)'}`);
    console.log(`Output:        ${OUTPUT_FILE}`);
    console.log('');

    if (!existsSync(OUTPUT_FILE)) writeFileSync(OUTPUT_FILE, 'email|pass|uid|vip|trial|credit|benefit|joined\n');

    await launchBrowser();
    let ok = 0, fail = 0;

    for (let i = 0; i < COUNT; i++) {
      console.log(`\n[${i + 1}/${COUNT}] Mua mail...`);

      let mail;
      try {
        mail = await stkBuy(SELLTK_PRODUCT);
        console.log(`  ✓ mail: ${mail.email}`);
      } catch (e) {
        console.log(`  ✗ mua mail lỗi: ${e.message}`);
        fail++;
        continue;
      }

      // Ghi vào accounts.txt để dùng lại
      appendFileSync(INPUT_FILE, `${mail.email}|${mail.password || ''}\n`);

      // Proxy
      let pUrl = null;
      if (pool.size > 0) {
        const p = await pool.next();
        if (p?.error) console.log(`  ⚠ proxy: ${p.error}`);
        else if (p?.url) { pUrl = p.url; console.log(`  proxy #${p.keyIndex}: ${p.ip}`); }
      }

      const device = newDevice();

      try {
        // Selltaikhoan mail không có API đọc OTP nên KHÔNG đăng ký CapCut mới được
        // Chỉ LOGIN bằng email/password đã mua (nếu mail đã có tài khoản CapCut)
        // Hoặc dùng mode=check/join với accounts.txt có email|pass sẵn
        console.log(`  ⚠ selltaikhoan ko hỗ trợ đọc OTP → chỉ login + check`);
        const result = await processAccount(mail.email, mail.password, device, pUrl, {
          doJoin: !!TEAM_INVITE_LINK,
          doInfo: true,
        });

        if (result.error) {
          appendFileSync(OUTPUT_FILE, `${mail.email}|${mail.password}|${result.error}||||||\n`);
          fail++;
          console.log(`  ✗ ${result.error}`);
        } else {
          appendFileSync(OUTPUT_FILE, `${mail.email}|${mail.password}|${result.uid}|${result.vip}|${result.trial}|${result.credit}|${result.benefit}|${result.joined}\n`);
          ok++;
        }
      } catch (e) {
        appendFileSync(OUTPUT_FILE, `${mail.email}|${mail.password}|ERROR:${e.message.slice(0, 80)}||||||\n`);
        fail++;
        console.log(`  ✗ ${e.message.slice(0, 80)}`);
      }

      if (i < COUNT - 1) await sleep(DELAY_MS);
    }

    await closeBrowser();
    console.log(`\n═══ KẾT QUẢ: ${ok} OK / ${fail} lỗi → ${OUTPUT_FILE} ═══`);

  } else {
    // --- CHECK hoặc JOIN (đọc accounts.txt) ---
    if (!existsSync(INPUT_FILE)) { console.error(`Không tìm thấy ${INPUT_FILE}`); process.exit(1); }

    const lines = readFileSync(INPUT_FILE, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!lines.length) { console.log('File accounts.txt trống.'); process.exit(0); }

    const doJoin = MODE === 'join' || MODE === 'register';
    const doInfo = MODE === 'check' || MODE === 'register';

    // Resume: bỏ qua acc đã OK
    const doneSet = new Set();
    if (existsSync(OUTPUT_FILE)) {
      for (const row of readFileSync(OUTPUT_FILE, 'utf-8').split('\n')) {
        const cols = row.split('|');
        if (cols.length >= 4 && cols[0] !== 'email') {
          const hasErr = cols[2]?.startsWith('ERROR') || cols[2]?.startsWith('SKIP') || cols[2]?.includes('timeout') || cols[3] === '';
          if (!hasErr) doneSet.add(cols[0]);
        }
      }
      if (doneSet.size > 0) console.log(`[resume] Bỏ qua ${doneSet.size} acc đã OK`);
    }

    const todo = lines.filter(l => !doneSet.has(l.split('|')[0]?.trim()));

    console.log(`Accounts:      ${lines.length} (chạy ${todo.length}, bỏ qua ${doneSet.size})`);
    console.log(`Team invite:   ${TEAM_INVITE_LINK || '(không)'}`);
    console.log(`Proxy keys:    ${pool.size || '(direct)'}`);
    console.log(`Output:        ${OUTPUT_FILE}`);
    console.log('');

    if (todo.length === 0) { console.log('Tất cả đã chạy OK.'); process.exit(0); }

    if (doneSet.size === 0) writeFileSync(OUTPUT_FILE, 'email|pass|uid|vip|trial|credit|benefit|joined\n');

    await launchBrowser();
    let ok = 0, fail = 0;

    for (let i = 0; i < todo.length; i++) {
      const [email, password] = todo[i].split('|').map(s => s?.trim());
      if (!email || !password) { fail++; continue; }

      console.log(`[${i + 1}/${todo.length}] ${email}`);

      let pUrl = null;
      if (pool.size > 0) {
        const p = await pool.next();
        if (p?.error) console.log(`  ⚠ proxy: ${p.error}`);
        else if (p?.url) { pUrl = p.url; console.log(`  proxy #${p.keyIndex}: ${p.ip}`); }
      }

      try {
        const result = await processAccount(email, password, newDevice(), pUrl, { doJoin, doInfo });
        if (result.error) {
          appendFileSync(OUTPUT_FILE, `${email}|${password}|${result.error}||||||\n`);
          fail++;
          console.log(`  ✗ ${result.error}`);
        } else {
          appendFileSync(OUTPUT_FILE, `${email}|${password}|${result.uid}|${result.vip}|${result.trial}|${result.credit}|${result.benefit}|${result.joined}\n`);
          ok++;
        }
      } catch (e) {
        appendFileSync(OUTPUT_FILE, `${email}|${password}|ERROR:${e.message.slice(0, 80)}||||||\n`);
        fail++;
        console.log(`  ✗ ${e.message.slice(0, 80)}`);
      }

      if (i < todo.length - 1) await sleep(DELAY_MS);
    }

    await closeBrowser();
    console.log(`\n═══ KẾT QUẢ: ${ok} OK / ${fail} lỗi → ${OUTPUT_FILE} ═══`);
  }
}

main().catch(e => { console.error(e); closeBrowser(); process.exit(1); });
