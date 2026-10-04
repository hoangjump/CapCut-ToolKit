import { chromium, type Browser, type BrowserContext } from 'playwright';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as stk from '../selltaikhoanClient.js';
import * as dvfb from '../mailClient.js';
import { accessTokenFor, findAliasOtp, type GraphCredentials } from '../graphMailClient.js';
import { registerViaApi } from '../capcutRegApi.js';
import { loginViaApi, getAccountInfo, type AccountInfo } from '../flows/capcut-login.js';
import { joinTeamViaLink } from '../flows/capcut-signin.js';
import { createLogger } from '../logger.js';

const log = createLogger('checker');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TeamJob {
  link: string;
  count: number;
}

export interface CheckerConfig {
  mailProvider: 'stk' | 'dvfb';
  stkApiKey: string;
  stkProduct: string;
  dvfbApiKey: string;
  dvfbProduct: string;
  teams: TeamJob[];
  /** Số lần thử tối đa cho mỗi account cần đạt (chặn mua mail vô hạn khi link hỏng). */
  maxTriesPerAccount: number;
  minCredit: number;
  proxyKeys: string;
  rotateEach: boolean;
  delayMs: number;
  count: number;
}

const DEFAULTS: CheckerConfig = {
  mailProvider: 'stk',
  stkApiKey: '',
  stkProduct: '',
  dvfbApiKey: '',
  dvfbProduct: '',
  teams: [],
  maxTriesPerAccount: 3,
  minCredit: 650,
  proxyKeys: '',
  rotateEach: true,
  delayMs: 2000,
  count: 1,
};

function configPath(storeRoot: string): string {
  return join(storeRoot, 'checker-config.json');
}

export function loadConfig(storeRoot: string): CheckerConfig {
  const p = configPath(storeRoot);
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const cfg: CheckerConfig = { ...DEFAULTS, ...raw };
    if ((!Array.isArray(raw.teams) || !raw.teams.length) && typeof raw.teamInviteLink === 'string' && raw.teamInviteLink.trim()) {
      cfg.teams = [{ link: raw.teamInviteLink.trim(), count: Number(raw.count) || 1 }];
    }
    delete (cfg as any).teamInviteLink;
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(storeRoot: string, cfg: Partial<CheckerConfig>): CheckerConfig {
  const current = loadConfig(storeRoot);
  const merged: CheckerConfig = { ...current, ...cfg };
  merged.teams = (Array.isArray(merged.teams) ? merged.teams : [])
    .map((t) => ({ link: String(t?.link ?? '').trim(), count: Math.max(1, Math.floor(Number(t?.count) || 1)) }))
    .filter((t) => t.link);
  merged.maxTriesPerAccount = Math.max(1, Math.floor(Number(merged.maxTriesPerAccount) || 3));
  merged.minCredit = Math.max(0, Number(merged.minCredit) || 0);
  writeFileSync(configPath(storeRoot), JSON.stringify(merged, null, 2));
  return merged;
}

// ---------------------------------------------------------------------------
// Proxy pool (simple MKT round-robin)
// ---------------------------------------------------------------------------

class ProxyPool {
  private keys: string[];
  private rotate: boolean;
  private idx = 0;

  constructor(keysStr: string, rotate: boolean) {
    this.keys = keysStr
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    this.rotate = rotate;
  }

  get hasProxy(): boolean {
    return this.keys.length > 0;
  }

  async next(): Promise<{ url: string | null; ip?: string; error?: string }> {
    if (!this.keys.length) return { url: null };
    const key = this.keys[this.idx % this.keys.length];
    this.idx++;
    try {
      const endpoint = this.rotate
        ? 'https://api.mktproxy.com/api/proxies/rotate-ip'
        : 'https://api.mktproxy.com/api/proxies/new';
      const res = this.rotate
        ? await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          })
        : await fetch(`${endpoint}?key=${key}`);
      const data: any = await res.json().catch(() => ({}));
      const info = data?.data || data;
      if (info?.host && info?.port) {
        const u = info.username
          ? `http://${info.username}:${info.password}@${info.host}:${info.port}`
          : `http://${info.host}:${info.port}`;
        return { url: u, ip: info.ip || info.host };
      }
      return { url: null, error: data?.message || 'no proxy data' };
    } catch (e) {
      return { url: null, error: (e as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------
// SSE / event bus
// ---------------------------------------------------------------------------

export interface CheckerLogEntry {
  type: 'log';
  time: string;
  msg: string;
}

export interface CheckerStateEvent {
  type: 'state';
  running: boolean;
  stats: { total: number; done: number; ok: number; fail: number };
  teams: TeamProgress[];
  results: CheckerResult[];
}

export interface TeamProgress {
  link: string;
  target: number;
  ok: number;
  tries: number;
}

export interface CheckerResult {
  email: string;
  password: string;
  uid: string;
  vip: string;
  trial: string;
  credit: number;
  joined: string;
  team: number;
  ok: boolean;
  error?: string;
}

type SseClient = (data: CheckerLogEntry | CheckerStateEvent) => void;

interface Account {
  email: string;
  password: string;
  refreshToken?: string;
  clientId?: string;
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function randomPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  let pw = upper[Math.floor(Math.random() * 26)];
  for (let i = 0; i < 6; i++) pw += lower[Math.floor(Math.random() * 26)];
  for (let i = 0; i < 4; i++) pw += digits[Math.floor(Math.random() * 10)];
  return pw;
}

function randomDevice() {
  const w = [1280, 1366, 1440, 1536, 1600, 1920][Math.floor(Math.random() * 6)];
  const h = [720, 768, 900, 864, 900, 1080][Math.floor(Math.random() * 6)];
  const chrome = 120 + Math.floor(Math.random() * 10);
  return {
    viewport: { width: w, height: h },
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CheckerService {
  private storeRoot: string;
  private running = false;
  private stopRequested = false;
  private stats = { total: 0, done: 0, ok: 0, fail: 0 };
  private teams: TeamProgress[] = [];
  private results: CheckerResult[] = [];
  private recentLogs: CheckerLogEntry[] = [];
  private clients = new Set<SseClient>();

  constructor(storeRoot: string) {
    this.storeRoot = storeRoot;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getState(): CheckerStateEvent {
    return { type: 'state', running: this.running, stats: { ...this.stats }, teams: this.teams.map((t) => ({ ...t })), results: [...this.results] };
  }

  getRecentLogs(): CheckerLogEntry[] {
    return [...this.recentLogs];
  }

  subscribe(client: SseClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  private emit(data: CheckerLogEntry | CheckerStateEvent): void {
    for (const c of this.clients) {
      try { c(data); } catch { /* ignore */ }
    }
  }

  private log(msg: string): void {
    const entry: CheckerLogEntry = { type: 'log', time: new Date().toISOString(), msg };
    this.recentLogs.push(entry);
    if (this.recentLogs.length > 300) this.recentLogs.shift();
    this.emit(entry);
    log.info(`[checker] ${msg}`);
  }

  private broadcastState(): void {
    this.emit(this.getState());
  }

  requestStop(): void {
    if (this.running) {
      this.stopRequested = true;
      this.log('dừng sau account đang chạy...');
    }
  }

  async run(opts: {
    count?: number;
    accounts?: string;
    config: CheckerConfig;
  }): Promise<void> {
    if (this.running) throw new Error('Đang chạy rồi');

    const cfg = opts.config;
    this.running = true;
    this.stopRequested = false;
    this.stats = { total: 0, done: 0, ok: 0, fail: 0 };
    this.results = [];
    this.recentLogs = [];

    // Có link → mỗi link một mục tiêu riêng. Không link → chạy N account, không join.
    const jobs: TeamJob[] = cfg.teams.length
      ? cfg.teams
      : [{ link: '', count: opts.count || cfg.count || 1 }];
    this.teams = jobs.map((j) => ({ link: j.link, target: j.count, ok: 0, tries: 0 }));
    this.stats.total = jobs.reduce((n, j) => n + j.count, 0);

    // Danh sách dán sẵn được dùng trước, hết thì tự mua mail.
    const queue: Account[] = (opts.accounts ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        return {
          email: parts[0],
          password: parts[1] || '',
          refreshToken: parts[2] || undefined,
          clientId: parts[3] || undefined,
        };
      });

    this.broadcastState();

    let browser: Browser | null = null;
    try {
      const pool = new ProxyPool(cfg.proxyKeys, cfg.rotateEach);
      this.log(
        `khởi động — ${jobs.length} link, cần ${this.stats.total} account đạt, ` +
          `điều kiện: credit ≥ ${cfg.minCredit} hoặc Pro Team, proxy: ${pool.hasProxy ? 'có' : 'direct'}`,
      );

      browser = await chromium.launch({ headless: true });
      const resultsFile = join(this.storeRoot, 'checker-results.txt');
      let outOfMail = false;

      for (let j = 0; j < jobs.length && !outOfMail && !this.stopRequested; j++) {
        const job = jobs[j];
        const prog = this.teams[j];
        const maxTries = job.count * cfg.maxTriesPerAccount;
        if (job.link) this.log(`══ link ${j + 1}/${jobs.length}: cần ${job.count} account ══`);

        while (prog.ok < job.count && !this.stopRequested) {
          if (prog.tries >= maxTries) {
            this.log(`link ${j + 1}: đã thử ${prog.tries} lần, chỉ đạt ${prog.ok}/${job.count} — bỏ qua link này`);
            break;
          }
          prog.tries++;
          this.log(`━━━ link ${j + 1} · đạt ${prog.ok}/${job.count} · lần thử ${prog.tries} ━━━`);

          let acct: Account;
          const queued = queue.shift();
          if (queued) {
            acct = queued;
            this.log(`dùng ${acct.email}`);
          } else {
            try {
              acct = await this.buyMail(cfg);
            } catch (e) {
              this.log(`mua mail thất bại: ${(e as Error).message} — dừng`);
              prog.tries--;
              outOfMail = true;
              break;
            }
          }

          const result = await this.runOne(browser, pool, acct, job.link, j + 1, cfg);
          this.results.push(result);
          this.stats.done++;
          if (result.ok) {
            prog.ok++;
            this.stats.ok++;
          } else {
            this.stats.fail++;
            if (prog.ok < job.count) this.log('account không đạt — mua account khác bù');
          }

          appendFileSync(
            resultsFile,
            `${result.email}|${result.password}|${result.uid}|${result.vip}|${result.trial}|${result.credit}|${result.joined}|${result.ok ? 'OK' : 'FAIL'}|${job.link}\n`,
          );
          this.broadcastState();

          if (!this.stopRequested && cfg.delayMs > 0) {
            await new Promise((r) => setTimeout(r, cfg.delayMs));
          }
        }
      }
      if (this.stopRequested) this.log('đã dừng theo yêu cầu');
    } catch (e) {
      this.log(`lỗi nghiêm trọng: ${(e as Error).message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
      this.running = false;
      this.stopRequested = false;

      this.log(`xong — đạt ${this.stats.ok}/${this.stats.total}, hỏng ${this.stats.fail}`);
      this.teams.forEach((t, i) => {
        if (t.link) this.log(`link ${i + 1}: ${t.ok}/${t.target} (thử ${t.tries})`);
      });
      this.broadcastState();
    }
  }

  private async runOne(
    browser: Browser,
    pool: ProxyPool,
    acct: Account,
    link: string,
    team: number,
    cfg: CheckerConfig,
  ): Promise<CheckerResult> {
    let context: BrowserContext | null = null;
    try {
      let proxyUrl: string | null = null;
      if (pool.hasProxy) {
        const p = await pool.next();
        if (p.url) {
          proxyUrl = p.url;
          this.log(`proxy: ${p.ip || 'OK'}`);
        } else {
          this.log(`proxy lỗi: ${p.error} — chạy direct`);
        }
      }

      const ctxOpts: any = { ...randomDevice(), ignoreHTTPSErrors: true };
      if (proxyUrl) {
        const u = new URL(proxyUrl);
        ctxOpts.proxy = {
          server: `${u.protocol}//${u.hostname}:${u.port}`,
          username: u.username || undefined,
          password: u.password || undefined,
        };
      }
      context = await browser.newContext(ctxOpts);
      await context.route('**/*', (route) => {
        const rt = route.request().resourceType();
        if (['image', 'media', 'font'].includes(rt)) return route.abort();
        if (/analytics|tracking|ads|sentry|hotjar/i.test(route.request().url())) return route.abort();
        return route.continue();
      });

      return await this.processAccount(context, acct, link, team, cfg);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 120);
      this.log(`lỗi: ${msg}`);
      return {
        email: acct.email,
        password: acct.password,
        uid: `ERROR:${msg}`,
        vip: '-',
        trial: '-',
        credit: 0,
        joined: '-',
        team,
        ok: false,
        error: msg,
      };
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  // ---- buy mail ----

  private async buyMail(cfg: CheckerConfig): Promise<{
    email: string;
    password: string;
    refreshToken?: string;
    clientId?: string;
  }> {
    if (cfg.mailProvider === 'dvfb') {
      if (!cfg.dvfbApiKey) throw new Error('Chưa có API key Dongvanfb');
      if (!cfg.dvfbProduct) throw new Error('Chưa có ID sản phẩm Dongvanfb');
      this.log('mua mail Dongvanfb...');
      const result = await dvfb.buyMail(cfg.dvfbApiKey, {
        accountType: cfg.dvfbProduct,
        quality: '1',
      });
      if (!result.mails.length) throw new Error('Dongvanfb trả về 0 mail');
      const m = result.mails[0];
      this.log(`mua OK: ${m.email}`);

      // Save to accounts file
      const acctLine = `${m.email}|${m.password}|${m.refreshToken || ''}|${m.clientId || ''}`;
      appendFileSync(join(this.storeRoot, 'checker-accounts.txt'), acctLine + '\n');

      return {
        email: m.email,
        password: m.password || '',
        refreshToken: m.refreshToken,
        clientId: m.clientId,
      };
    }

    // STK
    if (!cfg.stkApiKey) throw new Error('Chưa có API key Selltaikhoan');
    if (!cfg.stkProduct) throw new Error('Chưa có ID sản phẩm Selltaikhoan');
    this.log('mua mail Selltaikhoan...');
    const result = await stk.buyProduct(cfg.stkApiKey, cfg.stkProduct, 1);
    if (!result.mails.length) throw new Error('Selltaikhoan trả về 0 mail');
    const m = result.mails[0];
    this.log(`mua OK: ${m.email}`);

    const acctLine = `${m.email}|${m.password || ''}|${m.refreshToken || ''}|${m.clientId || ''}`;
    appendFileSync(join(this.storeRoot, 'checker-accounts.txt'), acctLine + '\n');

    return {
      email: m.email,
      password: m.password || '',
      refreshToken: m.refreshToken,
      clientId: m.clientId,
    };
  }

  // ---- process one account ----

  private async processAccount(
    context: BrowserContext,
    acct: Account,
    link: string,
    team: number,
    cfg: CheckerConfig,
  ): Promise<CheckerResult> {
    const page = await context.newPage();
    const capcutPassword = randomPassword();

    // Open capcut login page, wait for cookies
    this.log('mở trang CapCut...');
    await page.goto('https://www.capcut.com/login?locale=en', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page
      .waitForFunction(() => /s_v_web_id=/.test((globalThis as any).document.cookie), null, { timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // Register or login
    if (acct.refreshToken && acct.clientId) {
      // New account: register
      this.log(`đăng ký CapCut cho ${acct.email}...`);

      const cred: GraphCredentials = {
        email: acct.email,
        refreshToken: acct.refreshToken,
        clientId: acct.clientId,
      };

      // Kiểm tra refresh token còn sống trước khi gửi OTP, để mail chết lỗi sớm.
      await accessTokenFor(cred);

      const getCode = async (): Promise<string> => {
        this.log('chờ OTP...');
        const deadline = Date.now() + 90_000;
        const seenIds = new Set<string>();
        while (Date.now() < deadline) {
          const result = await findAliasOtp(cred, {
            windowMinutes: 10,
            seenIds,
            codePattern: /\b(\d{6})\b/,
          });
          if (result?.code) return result.code;
          await new Promise((r) => setTimeout(r, 5_000));
        }
        throw new Error('Không nhận được OTP sau 90s');
      };

      const regResult = await registerViaApi(page, {
        email: acct.email,
        password: capcutPassword,
        getCode,
        log,
      });
      this.log(`đăng ký OK — uid=${regResult.userId}`);
    } else {
      // Existing account: login
      this.log(`login ${acct.email}...`);
      await loginViaApi(page, acct.email, acct.password, log);
    }

    // Navigate to app for session cookies
    await page
      .goto('https://www.capcut.com/my-edit?start_tab=video', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      .catch(() => {});
    await page.waitForTimeout(2500);

    // Join team
    let joined = 'SKIP';
    if (link) {
      this.log('join team...');
      const ok = await joinTeamViaLink(page, link, {
        info: (m) => this.log(m),
        warn: (m) => this.log(`⚠ ${m}`),
      }, `link ${team}`);
      joined = ok ? 'YES' : 'NO';
      this.log(`join (theo trang): ${joined}`);
    }

    // Credit/Pro Team của team có thể cập nhật chậm sau khi join → check lại vài lần.
    const checks = link ? 3 : 1;
    let info!: AccountInfo;
    let credit = 0;
    let pro = false;
    for (let i = 0; i < checks; i++) {
      await page
        .goto('https://www.capcut.com/my-edit?start_tab=video', { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .catch(() => {});
      await page.waitForTimeout(i === 0 ? 2500 : 5000);
      this.log(i === 0 ? 'check thông tin...' : `check lại lần ${i + 1}...`);
      info = await getAccountInfo(page);
      credit = info.creditVip + info.creditGift + info.creditPurchase;
      pro = info.vip;
      if (credit >= cfg.minCredit || pro) break;
    }

    // Join chỉ tính thành công khi đủ credit hoặc có Pro Team; không có link thì
    // account tạo/login xong là đạt.
    const ok = link ? credit >= cfg.minCredit || pro : true;
    if (link) joined = ok ? 'YES' : 'NO';
    const pw = acct.refreshToken ? capcutPassword : acct.password;

    const result: CheckerResult = {
      email: acct.email,
      password: pw,
      uid: info.userId || '?',
      vip: pro ? `PRO${info.vipType ? `:${info.vipType}` : ''}` : 'NO',
      trial: info.hasTrial ? 'YES' : 'NO',
      credit,
      joined,
      team,
      ok,
    };

    this.log(`${ok ? '✓ ĐẠT' : '✗ KHÔNG ĐẠT'} — pro=${result.vip} credit=${credit} trial=${result.trial}`);
    return result;
  }
}
