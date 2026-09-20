#!/usr/bin/env node
/**
 * CapCut Auto — Web UI. Chạy: node server.js → mở http://localhost:3456
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3456);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_FILE = resolve(__dir, 'config.json');
const DEFAULT_CONFIG = {
  stkApiKey: '', stkProduct: '', teamInviteLink: '', proxyKeys: '',
  rotateEach: true, delayMs: 3000, mode: 'check', count: 5,
};

let config = loadConfig();
let running = false;
let shouldStop = false;
let browser = null;
const logs = [];
const sseClients = new Set();
let stats = { ok: 0, fail: 0, total: 0, done: 0 };

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig() {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function log(msg) {
  const entry = { time: new Date().toLocaleTimeString('vi'), msg };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SELLTAIKHOAN
// ═══════════════════════════════════════════════════════════════════════════

async function stkFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.json();
    if (!res.ok || (body.status && body.status !== 'success')) throw new Error(body.msg || `HTTP ${res.status}`);
    return body;
  } finally { clearTimeout(timer); }
}

async function stkBalance(apiKey) {
  const body = await stkFetch(`https://www.selltaikhoan.com/api/profile.php?api_key=${encodeURIComponent(apiKey)}`);
  return Number(body?.data?.money ?? 0);
}

async function stkProducts(apiKey) {
  const body = await stkFetch(`https://www.selltaikhoan.com/api/products.php?api_key=${encodeURIComponent(apiKey)}`);
  const out = [];
  const walk = cat => {
    for (const p of cat?.products ?? []) out.push({ id: String(p.id), name: p.name, price: p.price, amount: p.amount });
    for (const sub of cat?.children ?? []) walk(sub);
  };
  (body?.categories ?? []).forEach(walk);
  return out;
}

async function stkBuy(apiKey, productId) {
  const form = new URLSearchParams({ action: 'buyProduct', id: productId, amount: '1', api_key: apiKey });
  const body = await stkFetch('https://www.selltaikhoan.com/api/buy_product', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  for (const row of (body?.data || [])) {
    const [email, password, refreshToken, clientId] = row.split('|').map(s => s.trim());
    if (email) return { email, password, refreshToken, clientId };
  }
  throw new Error('Mua mail thất bại');
}

// ═══════════════════════════════════════════════════════════════════════════
// PROXY
// ═══════════════════════════════════════════════════════════════════════════

class ProxyPool {
  constructor(keyStr, rotate) {
    this.keys = keyStr.split(',').map(k => k.trim()).filter(Boolean);
    this.rotate = rotate; this.idx = 0;
  }
  get size() { return this.keys.length; }
  async next() {
    if (!this.keys.length) return null;
    const key = this.keys[this.idx % this.keys.length];
    const ki = (this.idx % this.keys.length) + 1;
    this.idx++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let url, opts;
      if (this.rotate) {
        url = 'https://api.mktproxy.com/api/proxies/rotate-ip';
        opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }), signal: ctrl.signal };
      } else {
        url = `https://api.mktproxy.com/api/proxies/new?key=${encodeURIComponent(key)}`;
        opts = { signal: ctrl.signal };
      }
      const res = await fetch(url, opts); clearTimeout(timer);
      const body = await res.json(); const d = body?.data ?? {};
      const v = d.value || d.http || d.socks5 || '';
      const parts = v.split(':');
      let pUrl = null;
      if (parts.length >= 4) pUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
      else if (parts.length >= 2 && d.user && d.pass) pUrl = `http://${d.user}:${d.pass}@${parts[0]}:${parts[1]}`;
      return { url: pUrl, keyIndex: ki, ip: d.real_ip || d.ip || v };
    } catch (e) { return { url: null, keyIndex: ki, error: e.message }; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MICROSOFT GRAPH — đọc OTP từ Outlook inbox
// ═══════════════════════════════════════════════════════════════════════════

async function msGetAccessToken(refreshToken, clientId) {
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });
  const res = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`MS token lỗi: ${body.error_description || body.error || 'unknown'}`);
  return body.access_token;
}

async function msWaitOtp(accessToken, afterIso, maxWaitMs = 90_000) {
  const start = Date.now();
  const filter = encodeURIComponent(`receivedDateTime ge ${afterIso}`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages?$top=5&$orderby=receivedDateTime desc&$filter=${filter}&$select=subject,from,receivedDateTime`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const body = await res.json();
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
// CAPCUT REGISTRATION — 3-step passport API via XHR in browser
// ═══════════════════════════════════════════════════════════════════════════

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
  return page.evaluate(({ host, p, body }) => {
    const getCookie = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
    const vfp = getCookie('s_v_web_id');
    const csrf = getCookie('passport_csrf_token');
    const webid = getCookie('tt_webid') || getCookie('tt_webid_v2') || vfp || '';
    const qs = new URLSearchParams({
      aid:'348188',account_sdk_source:'web',sdk_version:'2.1.10-tiktok',language:'en',verifyFp:vfp,webid,
      browser_language:navigator.language||'en-US',browser_name:'Mozilla',browser_platform:navigator.platform||'',
      browser_version:navigator.appVersion||'',cookie_enabled:'true',screen_height:String(screen.height),screen_width:String(screen.width),
    }).toString();
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', host + p + '?' + qs, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('appid', '348188');
      if (csrf) xhr.setRequestHeader('x-tt-passport-csrf-token', csrf);
      if (webid) xhr.setRequestHeader('did', webid);
      xhr.timeout = 25000;
      xhr.onload = () => { try { const j = JSON.parse(xhr.responseText); resolve({ ok: true, data: j.data, message: j.message }); } catch { resolve({ ok: false, raw: xhr.responseText?.slice(0, 300) }); } };
      xhr.onerror = () => resolve({ ok: false, err: 'network' });
      xhr.ontimeout = () => resolve({ ok: false, err: 'timeout' });
      xhr.send(new URLSearchParams(body).toString());
    });
  }, { host: 'https://login-row.www.capcut.com', p: apiPath, body: bodyObj });
}

function encMixMode(s) {
  const b = new TextEncoder().encode(String(s));
  let o = '';
  for (const x of b) o += ((x ^ 0x05) & 0xff).toString(16).padStart(2, '0');
  return o;
}

async function registerCapcut(page, email, capcutPassword, getCode) {
  const encEmail = encMixMode(email);
  const encPass = encMixMode(capcutPassword);

  const chk = await passportPost(page, '/passport/web/user/check_email_registered', {
    mix_mode: '1', email: encEmail, fixed_mix_mode: '1',
  });
  if (!chk.ok) throw new Error(`check_email lỗi: ${chk.err || chk.raw || 'unknown'}`);
  if (chk.data?.is_registered === 1) throw new Error('Email đã có tài khoản CapCut');

  const snd = await passportPost(page, '/passport/web/email/send_code/', {
    mix_mode: '1', email: encEmail, password: encPass, type: '34', fixed_mix_mode: '1',
  });
  if (!snd.ok || !snd.data?.email_ticket) {
    throw new Error(`send_code lỗi: ${snd.data?.description || snd.message || snd.err || 'unknown'}`);
  }

  const code = await getCode();

  const reg = await passportPost(page, '/passport/web/email/register_verify_login/', {
    mix_mode: '1', email: encEmail, code: encMixMode(String(code)), password: encPass,
    type: '34', birthday: randomBirthday(), force_user_region: 'VN',
    biz_param: JSON.stringify({ invite_code: '' }), fixed_mix_mode: '1',
  });
  if (!reg.ok || !reg.data?.user_id) {
    throw new Error(`register lỗi: ${reg.data?.description || reg.message || reg.err || 'unknown'}`);
  }
  return { userId: String(reg.data.user_id_str || reg.data.user_id) };
}

// ═══════════════════════════════════════════════════════════════════════════
// DEVICE + CAPCUT
// ═══════════════════════════════════════════════════════════════════════════

const CHROME_VERS = ['121.0.0.0','122.0.0.0','123.0.0.0','124.0.0.0','125.0.0.0'];
const SCREENS = [[1920,1080],[2560,1440],[1366,768],[1440,900],[1536,864]];
const TZ = ['Asia/Saigon','Asia/Bangkok','Asia/Singapore','Asia/Tokyo'];
const pick = a => a[Math.floor(Math.random() * a.length)];

function newDevice() {
  const cv = pick(CHROME_VERS); const [sw,sh] = pick(SCREENS); const tz = pick(TZ);
  const os = Math.random()>0.5 ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7';
  return { ua: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cv} Safari/537.36`, screenWidth: sw, screenHeight: sh, timezone: tz };
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

async function loginCapcut(page, email, password) {
  return page.evaluate(({ email, password }) => {
    const enc = s => { const b = new TextEncoder().encode(String(s)); let o = ''; for (const x of b) o += ((x ^ 0x05) & 0xff).toString(16).padStart(2, '0'); return o; };
    const ck = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
    const vfp = ck('s_v_web_id'); const csrf = ck('passport_csrf_token');
    const webid = ck('tt_webid') || ck('tt_webid_v2') || vfp || '';
    const qs = new URLSearchParams({
      aid:'348188',account_sdk_source:'web',sdk_version:'2.1.10-tiktok',language:'en',verifyFp:vfp,webid,
      browser_language:navigator.language||'en-US',browser_name:'Mozilla',browser_platform:navigator.platform||'',
      browser_version:navigator.appVersion||'',cookie_enabled:'true',screen_height:String(screen.height),screen_width:String(screen.width),
    }).toString();
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST','https://login-row.www.capcut.com/passport/web/email/login/?'+qs,true);
      xhr.withCredentials=true;
      xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
      xhr.setRequestHeader('Accept','application/json');
      xhr.setRequestHeader('appid','348188');
      if(csrf)xhr.setRequestHeader('x-tt-passport-csrf-token',csrf);
      if(webid)xhr.setRequestHeader('did',webid);
      xhr.timeout=25000;
      xhr.onload=()=>{try{const j=JSON.parse(xhr.responseText);if(j.data?.user_id||j.data?.session_key)resolve({ok:true,uid:String(j.data.user_id_str||j.data.user_id)});else resolve({ok:false,error:j.data?.description||j.message||'unknown'});}catch{resolve({ok:false,error:'parse'});}};
      xhr.onerror=()=>resolve({ok:false,error:'network'});
      xhr.ontimeout=()=>resolve({ok:false,error:'timeout'});
      xhr.send(new URLSearchParams({mix_mode:'1',email:enc(email),password:enc(password),type:'34',fixed_mix_mode:'1'}).toString());
    });
  }, { email, password });
}

async function joinTeam(page, inviteLink) {
  try {
    // B1: resolve shortlink /sv2/ → /team-invite/<token>
    let teamUrl = inviteLink;
    try {
      const r = await fetch(inviteLink, { redirect: 'follow' });
      if (r.url.includes('/team-invite/')) teamUrl = r.url.split('?')[0];
      log(`  join: resolved → ${teamUrl.slice(0, 100)}`);
    } catch { log(`  join: resolve lỗi — dùng URL gốc`); }

    // B2: thử XHR join từ trang hiện tại (/my-edit) — SDK ký XHR ở đây
    const res = await page.evaluate(async (invUrl) => {
      const sl = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 20; i++) {
        if (/sessionid=/.test(document.cookie)) break;
        await sl(400);
      }
      return new Promise(resolve => {
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', 'https://edit-api-sg.capcut.com/cc/v1/workspace/join_workspace_with_apply', true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.timeout = 20000;
          xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ raw: xhr.responseText.slice(0, 200) }); } };
          xhr.onerror = () => resolve({ __err: 'xhr error' });
          xhr.ontimeout = () => resolve({ __err: 'xhr timeout' });
          xhr.send(JSON.stringify({
            join_workspace_type: 1,
            invite_link_param: { invitation_link: invUrl },
            application_param: {},
          }));
        } catch (e) { resolve({ __err: String(e.message || e) }); }
      });
    }, teamUrl);

    log(`  join: XHR từ /my-edit → ret=${res?.ret} errmsg=${res?.errmsg || ''}`);
    if (res?.__err) { log(`  join: XHR lỗi — ${res.__err}`); }

    // Nếu OK → xong
    if (String(res?.ret) === '0' || /success/i.test(res?.errmsg || '')) {
      log(`  join: OK — đã join workspace`);
      return true;
    }

    // B3: fallback — mở trang invite, bấm Submit (SDK ký khi click)
    log(`  join: XHR lỗi — fallback bấm Submit trên trang invite...`);
    await page.goto(inviteLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(4_000);

    // Bắt response join_workspace
    const respPromise = page.waitForResponse(
      r => r.url().includes('join_workspace_with_apply'), { timeout: 15_000 }
    ).catch(() => null);

    // Tìm + click Submit bằng DOM (bền hơn locator)
    const clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('span, button, div[role="button"]');
      for (const el of all) {
        if (el.textContent.trim() === 'Submit' && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      // Thử thêm: tìm nút có chữ Join/Accept
      for (const el of all) {
        const t = el.textContent.trim();
        if (/^(Join|Accept|Join space)$/.test(t) && el.offsetParent !== null) {
          el.click();
          return t;
        }
      }
      return false;
    });

    if (!clicked) {
      log(`  join: không tìm thấy nút Submit/Join`);
      const btns = await page.locator('button:visible, [role="button"]:visible').allTextContents().catch(() => []);
      if (btns.length) log(`  join: buttons: [${btns.map(t => t.trim().slice(0, 30)).join(', ')}]`);
      return false;
    }

    log(`  join: đã click "${clicked === true ? 'Submit' : clicked}" — chờ response...`);
    const resp = await respPromise;
    if (resp) {
      const body = await resp.json().catch(() => ({}));
      log(`  join: response ret=${body?.ret} errmsg=${body?.errmsg || ''}`);
      return String(body?.ret) === '0' || /success/i.test(body?.errmsg || '');
    }
    log(`  join: click xong nhưng không bắt được API response — coi như OK`);
    return true;
  } catch (e) { log(`  join: lỗi — ${e.message.slice(0, 80)}`); return false; }
}

async function getAccountInfo(page) {
  await page.goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  return page.evaluate(async () => {
    const ck=n=>{const m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):'';};
    const sl=ms=>new Promise(r=>setTimeout(r,ms));
    const region=(ck('store-country-code')||'VN').toUpperCase();
    for(let i=0;i<20;i++){if(ck('sessionid')||ck('sid_guard'))break;await sl(400);}
    const post=(url,body)=>new Promise(resolve=>{
      const xhr=new XMLHttpRequest();xhr.open('POST',url,true);xhr.withCredentials=true;
      xhr.setRequestHeader('Content-Type','application/json');
      xhr.setRequestHeader('appid','348188');xhr.setRequestHeader('appvr','12.4.0');
      xhr.setRequestHeader('lan','en');xhr.setRequestHeader('loc',region);xhr.setRequestHeader('pf','7');
      xhr.timeout=15000;
      xhr.onload=()=>{try{resolve(JSON.parse(xhr.responseText));}catch{resolve({});}};
      xhr.onerror=()=>resolve({});xhr.ontimeout=()=>resolve({});
      xhr.send(JSON.stringify(body));
    });
    const sub=await post('https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info',{aid:'348188',scene:'vip'});
    const vip=sub?.data?.flag?'YES':'NO';
    const pr=await post('https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list',{aid:348188,region,scene:'vip'});
    const trial=(pr?.data?.all_price_list||[]).some(p=>p?.can_trial&&p?.trial_cycle===7)?'YES':'NO';
    const cr=await post('https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit',{});
    const c=cr?.data?.credit||{};
    const credit=(c.vip_credit||0)+(c.gift_credit||0)+(c.purchase_credit||0);
    return{vip,trial,credit};
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

const results = [];

async function processOne(acct, device, proxyUrl, opts) {
  const { email, password, refreshToken, clientId } = acct;
  const context = await browser.newContext({
    userAgent: device.ua, locale: 'en-US',
    viewport: { width: device.screenWidth, height: device.screenHeight },
    timezoneId: device.timezone, ignoreHTTPSErrors: true,
    ...(proxyUrl ? { proxy: (() => { const u = new URL(proxyUrl); const p = { server: `${u.protocol}//${u.hostname}:${u.port}` }; if (u.username) { p.username = decodeURIComponent(u.username); p.password = decodeURIComponent(u.password); } return p; })() } : {}),
  });
  try {
    const page = await openLoginPage(context);
    let uid = '';
    let capcutPassword = password;

    if (opts.doRegister && refreshToken && clientId) {
      capcutPassword = randomCapcutPassword();
      log(`  đăng ký CapCut — pass: ${capcutPassword}`);

      const accessToken = await msGetAccessToken(refreshToken, clientId);
      log(`  MS Graph token OK`);

      const otpSentAt = new Date().toISOString();
      const reg = await registerCapcut(page, email, capcutPassword, async () => {
        log(`  chờ OTP (mail sau ${otpSentAt.slice(11,19)})...`);
        return msWaitOtp(accessToken, otpSentAt);
      });
      uid = reg.userId;
      log(`  đăng ký OK — uid=${uid}`);

      await page.goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
    } else {
      const lr = await loginCapcut(page, email, capcutPassword);
      if (!lr.ok) return { email, password: capcutPassword, error: `LOGIN:${lr.error}` };
      uid = lr.uid;
    }

    let joined = '';
    if (opts.doJoin && config.teamInviteLink) {
      joined = (await joinTeam(page, config.teamInviteLink)) ? 'YES' : 'NO';
    }

    let info = {};
    if (opts.doInfo) info = await getAccountInfo(page);

    return { email, password: capcutPassword, uid, vip: info.vip || '', trial: info.trial || '', credit: info.credit ?? '', joined };
  } finally { await context.close().catch(() => {}); }
}

async function runBatch(accounts, opts) {
  running = true; shouldStop = false;
  stats = { ok: 0, fail: 0, total: accounts.length, done: 0 };
  results.length = 0;
  broadcastState();

  const pool = new ProxyPool(config.proxyKeys, config.rotateEach);
  log(`═══ BẮT ĐẦU: ${accounts.length} account ═══`);

  if (!browser) {
    log('Khởi tạo headless Chromium...');
    browser = await chromium.launch({ headless: true });
    log('Browser OK');
  }

  const outFile = resolve(__dir, 'results.txt');
  writeFileSync(outFile, 'email|pass|uid|vip|trial|credit|joined\n');

  for (let i = 0; i < accounts.length; i++) {
    if (shouldStop) { log('⏹ Đã dừng.'); break; }

    const email = accounts[i].email;
    log(`[${i + 1}/${accounts.length}] ${email}`);

    let pUrl = null;
    if (pool.size > 0) {
      const p = await pool.next();
      if (p?.error) log(`  ⚠ proxy: ${p.error}`);
      else if (p?.url) { pUrl = p.url; log(`  proxy #${p.keyIndex}: ${p.ip}`); }
    }

    try {
      const r = await processOne(accounts[i], newDevice(), pUrl, opts);
      results.push(r);
      if (r.error) {
        stats.fail++; log(`  ✗ ${r.error}`);
        appendFileSync(outFile, `${email}|${r.password || ''}|${r.error}||||\n`);
      } else {
        stats.ok++; log(`  ✓ vip=${r.vip} trial=${r.trial} credit=${r.credit} joined=${r.joined}`);
        appendFileSync(outFile, `${email}|${r.password}|${r.uid}|${r.vip}|${r.trial}|${r.credit}|${r.joined}\n`);
      }
    } catch (e) {
      stats.fail++; log(`  ✗ ${e.message.slice(0, 80)}`);
      results.push({ email, password: accounts[i].password || '', error: e.message.slice(0, 80) });
      appendFileSync(outFile, `${email}||ERROR:${e.message.slice(0, 60)}||||\n`);
    }

    stats.done++;
    broadcastState();
    if (i < accounts.length - 1 && !shouldStop) await sleep(config.delayMs);
  }

  log(`═══ XONG: ${stats.ok} OK / ${stats.fail} lỗi ═══`);
  running = false;
  broadcastState();
}

function broadcastState() {
  const data = JSON.stringify({ type: 'state', running, stats, results: results.slice(-50) });
  for (const res of sseClients) res.write(`data: ${data}\n\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // SSE
    if (path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'state', running, stats, results: results.slice(-50) })}\n\n`);
      for (const l of logs.slice(-30)) res.write(`data: ${JSON.stringify(l)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Config
    if (path === '/api/config' && req.method === 'GET') return json(res, config);
    if (path === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      Object.assign(config, body);
      saveConfig();
      return json(res, { ok: true });
    }

    // Selltaikhoan
    if (path === '/api/stk/balance') {
      if (!config.stkApiKey) return json(res, { error: 'Chưa nhập API key' }, 400);
      const money = await stkBalance(config.stkApiKey);
      return json(res, { money });
    }
    if (path === '/api/stk/products') {
      if (!config.stkApiKey) return json(res, { error: 'Chưa nhập API key' }, 400);
      const products = await stkProducts(config.stkApiKey);
      return json(res, { products });
    }

    // Run
    if (path === '/api/run' && req.method === 'POST') {
      if (running) return json(res, { error: 'Đang chạy' }, 400);
      const body = await parseBody(req);
      const mode = body.mode || config.mode || 'check';
      let accounts = [];

      if (mode === 'register' && body.count > 0) {
        log(`Mua ${body.count} mail từ selltaikhoan (product=${config.stkProduct})...`);
        json(res, { ok: true, msg: 'Đang mua mail...' });
        const bought = [];
        for (let i = 0; i < body.count; i++) {
          if (shouldStop) break;
          try {
            const mail = await stkBuy(config.stkApiKey, config.stkProduct);
            bought.push({ email: mail.email, password: mail.password || '', refreshToken: mail.refreshToken, clientId: mail.clientId });
            log(`  [${i + 1}/${body.count}] ✓ ${mail.email}`);
            const accFile = resolve(__dir, 'accounts.txt');
            appendFileSync(accFile, `${mail.email}|${mail.password || ''}|${mail.refreshToken || ''}|${mail.clientId || ''}\n`);
          } catch (e) { log(`  [${i + 1}/${body.count}] ✗ ${e.message}`); }
        }
        accounts = bought;
      } else {
        const lines = (body.accounts || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (!lines.length) {
          const accFile = resolve(__dir, 'accounts.txt');
          if (existsSync(accFile)) {
            lines.push(...readFileSync(accFile, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
          }
        }
        accounts = lines.map(l => {
          const parts = l.split('|');
          return { email: parts[0]?.trim(), password: parts[1]?.trim(), refreshToken: parts[2]?.trim() || '', clientId: parts[3]?.trim() || '' };
        }).filter(a => a.email);
        json(res, { ok: true, count: accounts.length });
      }

      if (accounts.length > 0) {
        const doRegister = mode === 'register';
        const doJoin = mode === 'register' || mode === 'join' || mode === 'all';
        const doInfo = mode === 'check' || mode === 'all' || mode === 'register';
        runBatch(accounts, { doRegister, doJoin, doInfo }).catch(e => log(`Lỗi: ${e.message}`));
      }
      return;
    }

    if (path === '/api/stop') {
      shouldStop = true;
      return json(res, { ok: true });
    }

    if (path === '/api/results') {
      return json(res, { results, stats });
    }

    // UI
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  CapCut Auto — http://localhost:${PORT}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════
// HTML UI
// ═══════════════════════════════════════════════════════════════════════════

const HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CapCut Auto</title>
<style>
  :root { --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a; --text: #e4e4e7; --muted: #71717a; --accent: #6366f1; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 1100px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  h1 span { background: var(--accent); color: white; font-size: 11px; padding: 2px 8px; border-radius: 4px; }
  .grid { display: grid; grid-template-columns: 340px 1fr; gap: 16px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 12px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input, select, textarea { width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 13px; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  textarea { resize: vertical; min-height: 80px; font-family: monospace; }
  .field { margin-bottom: 10px; }
  .row { display: flex; gap: 8px; }
  .row > * { flex: 1; }
  button { padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
  button:hover { opacity: 0.85; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-danger { background: var(--red); color: white; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .stat { text-align: center; padding: 10px; background: var(--bg); border-radius: 8px; }
  .stat .n { font-size: 24px; font-weight: 700; }
  .stat .l { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .stat.ok .n { color: var(--green); }
  .stat.fail .n { color: var(--red); }
  #log { background: #000; border-radius: 8px; padding: 10px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; height: 320px; overflow-y: auto; line-height: 1.6; }
  #log .time { color: var(--muted); }
  #log .ok { color: var(--green); }
  #log .err { color: var(--red); }
  #log .warn { color: var(--yellow); }
  .results-table { width: 100%; font-size: 12px; border-collapse: collapse; }
  .results-table th, .results-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  .results-table th { color: var(--muted); font-weight: 600; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.yes { background: #16a34a22; color: var(--green); }
  .badge.no { background: #dc262622; color: var(--red); }
  .badge.err { background: #dc262622; color: var(--red); }
  .balance { font-size: 14px; font-weight: 600; color: var(--green); }
  .running-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 1s infinite; margin-left: 4px; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
</head>
<body>
<div class="container">
  <h1>CapCut Auto <span id="status-badge">IDLE</span></h1>
  <div class="grid">
    <div>
      <div class="card" style="margin-bottom: 12px">
        <h2>Cấu hình</h2>
        <div class="field">
          <label>Selltaikhoan API Key</label>
          <div class="row"><input id="stkApiKey" type="password" placeholder="API key"><button class="btn-outline btn-sm" onclick="checkBalance()">Số dư</button></div>
          <div id="balance" style="margin-top:4px"></div>
        </div>
        <div class="field">
          <label>Sản phẩm mail (ID) <button class="btn-outline btn-sm" onclick="loadProducts()" style="margin-left:4px">Xem DS</button></label>
          <input id="stkProduct" placeholder="VD: 6762">
          <div id="products" style="margin-top:4px;font-size:12px;color:var(--muted);max-height:100px;overflow-y:auto"></div>
        </div>
        <div class="field">
          <label>Link mời Team CapCut</label>
          <input id="teamInviteLink" placeholder="https://www.capcut.com/sv2/...">
        </div>
        <div class="field">
          <label>Proxy Keys (phẩy ngăn cách)</label>
          <input id="proxyKeys" placeholder="key1,key2,key3">
        </div>
        <div class="row">
          <div class="field"><label>Delay (ms)</label><input id="delayMs" type="number" value="3000"></div>
          <div class="field"><label>Xoay IP</label><select id="rotateEach"><option value="true">Mỗi acc</option><option value="false">Không</option></select></div>
        </div>
        <button class="btn-outline" style="width:100%;margin-top:4px" onclick="saveConfig()">Lưu cấu hình</button>
      </div>

      <div class="card">
        <h2>Chạy</h2>
        <div class="field">
          <label>Chế độ</label>
          <select id="mode">
            <option value="check">Check info (login + lấy thông tin)</option>
            <option value="join">Join team (login + vào team)</option>
            <option value="all">Check + Join (cả hai)</option>
            <option value="register">Mua mail + Đăng ký CapCut + Join + Check</option>
          </select>
        </div>
        <div class="field" id="countField" style="display:none">
          <label>Số account cần mua</label>
          <input id="count" type="number" value="5" min="1" max="100">
        </div>
        <div class="field" id="accountsField">
          <label>Danh sách (email|password mỗi dòng, hoặc đọc accounts.txt)</label>
          <textarea id="accounts" rows="5" placeholder="email1@mail.com|pass1&#10;email2@mail.com|pass2"></textarea>
        </div>
        <div class="actions">
          <button class="btn-primary" id="btnRun" onclick="startRun()">▶ Chạy</button>
          <button class="btn-danger" id="btnStop" onclick="stopRun()" disabled>⏹ Dừng</button>
        </div>
      </div>
    </div>

    <div>
      <div class="stats">
        <div class="stat"><div class="n" id="s-total">0</div><div class="l">Tổng</div></div>
        <div class="stat"><div class="n" id="s-done">0</div><div class="l">Đã chạy</div></div>
        <div class="stat ok"><div class="n" id="s-ok">0</div><div class="l">OK</div></div>
        <div class="stat fail"><div class="n" id="s-fail">0</div><div class="l">Lỗi</div></div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <h2>Log</h2>
        <div id="log"></div>
      </div>
      <div class="card">
        <h2>Kết quả</h2>
        <div style="overflow-x:auto">
          <table class="results-table">
            <thead><tr><th>Email</th><th>UID</th><th>VIP</th><th>Trial</th><th>Credit</th><th>Joined</th></tr></thead>
            <tbody id="results"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
let isRunning = false;

// Load config
fetch('/api/config').then(r=>r.json()).then(c => {
  $('stkApiKey').value = c.stkApiKey || '';
  $('stkProduct').value = c.stkProduct || '';
  $('teamInviteLink').value = c.teamInviteLink || '';
  $('proxyKeys').value = c.proxyKeys || '';
  $('delayMs').value = c.delayMs || 3000;
  $('rotateEach').value = String(c.rotateEach ?? true);
  $('mode').value = c.mode || 'check';
  $('count').value = c.count || 5;
  toggleMode();
});

$('mode').addEventListener('change', toggleMode);
function toggleMode() {
  const m = $('mode').value;
  $('countField').style.display = m === 'register' ? '' : 'none';
  $('accountsField').style.display = m === 'register' ? 'none' : '';
}

function saveConfig() {
  const body = {
    stkApiKey: $('stkApiKey').value.trim(),
    stkProduct: $('stkProduct').value.trim(),
    teamInviteLink: $('teamInviteLink').value.trim(),
    proxyKeys: $('proxyKeys').value.trim(),
    delayMs: Number($('delayMs').value) || 3000,
    rotateEach: $('rotateEach').value === 'true',
    mode: $('mode').value,
    count: Number($('count').value) || 5,
  };
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(() => addLog('Đã lưu cấu hình', 'ok'));
}

async function checkBalance() {
  saveConfig();
  try {
    const r = await fetch('/api/stk/balance').then(r => r.json());
    if (r.error) { $('balance').innerHTML = '<span style="color:var(--red)">' + r.error + '</span>'; return; }
    $('balance').innerHTML = '<span class="balance">' + r.money.toLocaleString() + 'đ</span>';
  } catch (e) { $('balance').textContent = 'Lỗi: ' + e.message; }
}

async function loadProducts() {
  saveConfig();
  $('products').textContent = 'Đang tải...';
  try {
    const r = await fetch('/api/stk/products').then(r => r.json());
    if (r.error) { $('products').textContent = r.error; return; }
    const filtered = r.products.filter(p => /mail|outlook|hotmail|gmail/i.test(p.name));
    $('products').innerHTML = filtered.map(p =>
      '<div style="cursor:pointer;padding:2px 0" onclick="document.getElementById(\\'stkProduct\\').value=\\'' + p.id + '\\'"><b>' + p.id + '</b> — ' + p.name + ' — ' + p.price + 'đ (kho: ' + (p.amount ?? '?') + ')</div>'
    ).join('') || '<div>Không tìm thấy sản phẩm mail. Tổng: ' + r.products.length + '</div>';
  } catch (e) { $('products').textContent = 'Lỗi: ' + e.message; }
}

function startRun() {
  saveConfig();
  const mode = $('mode').value;
  const body = { mode };
  if (mode === 'register') {
    body.count = Number($('count').value) || 5;
  } else {
    body.accounts = $('accounts').value;
  }
  fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).then(r => { if (r.error) addLog(r.error, 'err'); });
}

function stopRun() {
  fetch('/api/stop').then(() => addLog('Đang dừng...', 'warn'));
}

function addLog(msg, cls = '') {
  const el = document.createElement('div');
  el.className = cls;
  const now = new Date().toLocaleTimeString('vi');
  el.innerHTML = '<span class="time">[' + now + ']</span> ' + msg;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

function badge(val) {
  if (!val) return '';
  const cls = val === 'YES' ? 'yes' : val === 'NO' ? 'no' : 'err';
  return '<span class="badge ' + cls + '">' + val + '</span>';
}

function updateUI(data) {
  if (data.type === 'state') {
    isRunning = data.running;
    $('btnRun').disabled = data.running;
    $('btnStop').disabled = !data.running;
    $('status-badge').textContent = data.running ? 'RUNNING' : 'IDLE';
    $('status-badge').innerHTML = data.running ? 'RUNNING <span class="running-dot"></span>' : 'IDLE';
    $('status-badge').style.background = data.running ? 'var(--green)' : 'var(--accent)';

    const s = data.stats || {};
    $('s-total').textContent = s.total || 0;
    $('s-done').textContent = s.done || 0;
    $('s-ok').textContent = s.ok || 0;
    $('s-fail').textContent = s.fail || 0;

    const tbody = $('results');
    tbody.innerHTML = '';
    for (const r of (data.results || []).slice().reverse()) {
      const tr = document.createElement('tr');
      if (r.error) {
        tr.innerHTML = '<td>' + r.email + '</td><td colspan="5"><span class="badge err">' + r.error + '</span></td>';
      } else {
        tr.innerHTML = '<td>' + r.email + '</td><td>' + (r.uid||'') + '</td><td>' + badge(r.vip) + '</td><td>' + badge(r.trial) + '</td><td>' + (r.credit??'') + '</td><td>' + badge(r.joined) + '</td>';
      }
      tbody.appendChild(tr);
    }
  } else if (data.msg) {
    const cls = data.msg.includes('✓') ? 'ok' : data.msg.includes('✗') ? 'err' : data.msg.includes('⚠') ? 'warn' : '';
    addLog(data.msg, cls);
  }
}

// SSE
const es = new EventSource('/api/events');
es.onmessage = e => { try { updateUI(JSON.parse(e.data)); } catch {} };
es.onerror = () => { setTimeout(() => {}, 3000); };
</script>
</body>
</html>`;
