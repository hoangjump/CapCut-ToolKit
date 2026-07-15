import { Camoufox } from 'camoufox-js';
import type { BrowserContext } from 'playwright-core';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { rm, mkdtemp } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile, LaunchOptions, AntiDetectConfig, ProxyConfig } from './types.js';
import { defaultAntiDetect, defaultBrowserSettings, defaultProxyRotation } from './types.js';
import type { ProfileManager } from './profileManager.js';
import type { ProxyStore, ProxyRecord } from './proxyStore.js';
import { checkProxy } from './proxyChecker.js';
import { resolveProxy, poolMatching, recordToConfig, emptyPoolMessage, type ResolveTrigger } from './proxyResolver.js';
import { languageForCountry } from './antiDetect.js';
import { createLogger, type Logger } from './logger.js';
import { scheduleTile } from './windowTiler.js';

/** True when `err` is camoufox's geoip public-IP lookup failing (all 6 IP
 *  endpoints unreachable through the proxy). Matched by the InvalidIP class name
 *  and its signature message so we needn't import the class from camoufox-js.
 *  Used to decide whether a launch failure is safe to retry with geoip off. */
function isGeoipIpError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'InvalidIP' ||
    err.message.includes('public proxy IP address from any API endpoint')
  );
}

/** True khi đang chạy trên Windows. Dùng để tách tối ưu theo nền tảng: Windows
 *  cần giảm tải render/CPU khi nhiều cửa sổ headful tranh compositor; Mac
 *  compositing bằng phần cứng vốn nhanh nên KHÔNG áp các pref này (sẽ chậm đi). */
const IS_WINDOWS = process.platform === 'win32';

/** Prefs giảm tải CPU/render CHỈ cho Windows. Rỗng trên Mac/Linux. Áp qua
 *  firefox_user_prefs mỗi launch.
 *  - gfx.webrender.software: render bằng CPU thay GPU. Trên máy Win GPU yếu/tích
 *    hợp bị nhiều cửa sổ tranh nhau, đường GPU nghẽn kéo mỗi thao tác dài hàng
 *    chục giây; ép software render đi đường CPU thường nhanh & ổn định hơn.
 *  - fission.autostart=false + dom.ipc.processCount=1: gom nội dung về ít tiến
 *    trình/1 process, cắt overhead khi 5 profile đẻ ra hàng chục tiến trình.
 *  - widget.windows.window_occlusion_tracking.enabled=false: TẮT occlusion
 *    tracking. Firefox/Win đánh dấu cửa sổ BỊ CHE (chồng lên nhau, hoặc minimize)
 *    là "occluded" rồi NGỪNG render + throttle nó → page.mouse.move (Camoufox vẽ
 *    con trỏ thật ở tầng C++, cần cửa sổ đang render) đứng, flow kẹt ở bước click
 *    → timeout → fail. Đây là thủ phạm "mở 10 con chỉ reg ra 2-3": các cửa sổ bị
 *    che không thao tác được. Tắt đi thì cửa sổ LUÔN render như đang hiện dù bị
 *    che/minimize. Kết hợp auto-tile (windowTiler) cho chắc.
 *  - dom.min_background_timeout_value=1000: giữ throttle timer tab nền ở mức mặc
 *    định nhẹ (không tăng), tránh setTimeout của SPA bị kéo giãn khi cửa sổ nền. */
const WIN_PERF_PREFS: Record<string, unknown> = IS_WINDOWS
  ? {
      'gfx.webrender.software': true,
      'fission.autostart': false,
      'dom.ipc.processCount': 1,
      'widget.windows.window_occlusion_tracking.enabled': false,
      'dom.min_background_timeout_value': 1000,
    }
  : {};

export interface Session {
  profile: Profile;
  context: BrowserContext;
  /** Local relay URL (proxy-chain) backing this session's proxy, if any.
   *  Must be closed when the context closes to free the listener. */
  proxyRelayUrl?: string;
  /** ProxyStore id leased for this session (pool mode). Released on close so
   *  another concurrent open can draw it. Absent for static/gateway/no-proxy. */
  leasedProxyId?: string;
}

export type ProfileTask<T> = (session: Session) => Promise<T>;

/**
 * Owns the lifecycle of browser contexts keyed by profile id. Engine is
 * Camoufox (a hardened Firefox build) driven through Playwright: anti-detect
 * lives in the C++ engine, not injected JS, so we no longer ship a spoofing
 * init script. Each profile launches with a persistent `user_data_dir` so
 * cookies/localStorage survive across runs.
 */
export class BrowserManager {
  private readonly log: Logger;
  private readonly sessions = new Map<string, Session>();
  /** ProxyStore ids currently leased by an open (or opening) pool session. A
   *  proxy in here is off-limits to other concurrent draws — so N concurrent
   *  sessions get N distinct IPs. Populated synchronously at draw time (no await
   *  between check and mark) so two racing opens can't both grab the same id. */
  private readonly leasedProxyIds = new Set<string>();
  /** FIFO of opens blocked because every matching proxy was leased. Each waiter's
   *  resolve() is called when a lease is released, waking one to retry its draw. */
  private readonly leaseWaiters: Array<() => void> = [];
  /** One-shot warmup guard: the FIRST Camoufox launch in a process must prime the
   *  engine's mouse subsystem, otherwise every subsequent page.mouse.move throws
   *  "gBrowser ... ownerWindow is undefined" for the whole process and clicks fall
   *  back to synthetic (untrusted) events — a bot tell. A throwaway headless launch
   *  before the first real open() primes it. Shared promise so concurrent opens
   *  warm up exactly once. */
  private warmupPromise?: Promise<void>;

  constructor(
    private readonly profiles: ProfileManager,
    private readonly store?: ProxyStore,
    private readonly defaults: LaunchOptions = {},
    /** Hook resolve proxy dạng API (mktproxy xoay): mỗi lần rút từ pool sẽ gọi
     *  để LẤY IP MỚI (rotate-ip) + whitelist — nhờ vậy mỗi profile tạm/đăng ký
     *  một IP khác. Do createApp cung cấp (nó có key server + client mktproxy). */
    private readonly deps: { resolveApiProxy?: (r: ProxyRecord) => Promise<ProxyConfig | undefined> } = {},
  ) {
    this.log = createLogger('browser');
  }

  /** Wait until a lease is released (or timeout elapses). Used when all matching
   *  proxies are busy so an open blocks instead of doubling up on an IP. */
  private waitForLease(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.leaseWaiters.indexOf(wake);
        if (i >= 0) this.leaseWaiters.splice(i, 1);
        resolve();
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.leaseWaiters.push(wake);
    });
  }

  /** Release a leased proxy id and wake the oldest blocked open, if any. */
  private releaseLease(proxyId: string | undefined): void {
    if (!proxyId) return;
    if (!this.leasedProxyIds.delete(proxyId)) return;
    const wake = this.leaseWaiters.shift();
    if (wake) wake();
  }

  /** Prime the engine's mouse subsystem once per process (see warmupPromise). A
   *  throwaway headless launch — no proxy, temp profile dir — closed immediately.
   *  Best-effort: a warmup failure is logged but must not block real opens.
   *
   *  The mouse.move MUST run on a page navigated to a REAL http URL, not
   *  about:blank or a data: URL — those don't attach an owner window in time, so
   *  the move throws the very "gBrowser ... ownerWindow is undefined" we're
   *  priming past (and primes nothing). Empirically, a real navigation whose
   *  mouse.move SUCCEEDS is what primes the subsystem for the whole process. */
  private warmup(): Promise<void> {
    if (!this.warmupPromise) {
      this.warmupPromise = (async () => {
        const t0 = Date.now();
        const dir = await mkdtemp(join(tmpdir(), 'cf-warmup-'));
        try {
          const ctx = (await Camoufox({ user_data_dir: dir, headless: true, humanize: true })) as BrowserContext;
          const page = ctx.pages()[0] ?? (await ctx.newPage());
          await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          let mv = 'OK';
          await page.mouse.move(40, 40).catch((e: Error) => { mv = e.message.split('\n')[0]; });
          await page.mouse.move(120, 90).catch(() => {});
          this.log.info(`warmup mouse subsystem primed sau ${Date.now() - t0}ms (mouse.move: ${mv})`);
          await ctx.close().catch(() => {});
        } catch (err) {
          this.log.warn(`warmup Camoufox lỗi (bỏ qua): ${(err as Error).message.split('\n')[0]}`);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      })();
    }
    return this.warmupPromise;
  }

  /** Launches (or returns the already-open) context for a profile. */
  async open(profileId: string, opts: LaunchOptions = {}): Promise<Session> {
    const existing = this.sessions.get(profileId);
    if (existing) return existing;

    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    const headless = opts.headless ?? this.defaults.headless ?? false;
    const browser = profile.browser ?? defaultBrowserSettings();
    const userDataDir = this.profiles.userDataDir(profileId);

    if (browser.clearCacheOnStart) {
      await this.clearCache(userDataDir);
    }

    this.log.info(`launching "${profile.name}" (${profileId}) headless=${headless}`);

    // Prime the engine's mouse subsystem once per process. Without this, the very
    // first Camoufox launch that goes straight through open() (persistent dir +
    // proxy) leaves mouse dispatch dead for the whole process — every click then
    // falls back to synthetic (isTrusted:false), a clear bot tell. A minimal
    // headless throwaway launch first primes it; guarded so concurrent opens share
    // one warmup. See warmup().
    await this.warmup();

    const cfg = profile.antiDetect ?? defaultAntiDetect();

    // Acquire a proxy (pool mode leases it so no other concurrent open draws the
    // same IP; blocks if all matching proxies are busy), persist the choice, and
    // refresh our local `profile` handle so the Session/relay below see it.
    const { proxy: resolvedProxy, leasedProxyId } = await this.acquireProxy(
      profile,
      opts.rotateTrigger ?? 'open',
    );
    const launchProfile = this.profiles.get(profileId) ?? profile;

    // From here to a live session, any throw must release the lease — else a
    // failed launch would strand the proxy as permanently "busy".
    let context: BrowserContext;
    let proxyRelayUrl: string | undefined;
    try {
      // SOCKS5-with-auth and credentialed proxies are awkward to pass straight to
      // the browser. Route every proxy through a local no-auth HTTP relay
      // (proxy-chain) that forwards to the real upstream — covers http/https/socks5
      // uniformly and keeps credentials out of the browser process.
      proxyRelayUrl = resolvedProxy ? await this.makeRelay(resolvedProxy) : undefined;

      // geoip: derive timezone + geolocation + locale + WebRTC IP from the proxy's
      // egress IP (MaxMind lookup done through the relay at launch). Only enabled
      // when a proxy is actually in play — a geoip lookup with no proxy would key
      // off the host's real IP, which is the opposite of what we want.
      const wantGeoip = Boolean(cfg.geoip && proxyRelayUrl);
      const buildOpts = (useGeoip: boolean) => ({
        user_data_dir: userDataDir,
        headless,
        // OS the fingerprint should claim. 'auto' lets Camoufox randomize across
        // win/mac/linux; otherwise we pin it so platform/UA/WebGL stay coherent.
        os: cfg.osProfile && cfg.osProfile !== 'auto' ? cfg.osProfile : undefined,
        proxy: proxyRelayUrl ? { server: proxyRelayUrl } : undefined,
        geoip: useGeoip ? true : undefined,
        // Locale driving the Intl API. An explicit cfg.locale (vd 'en-US' cho flow
        // ChatGPT) LUÔN thắng — bất kể geoip/IP. Ngược lại: khi geoip on nó tự set
        // locale IP-coherent (để undefined, nhường geoip); còn lại rơi về map
        // country→locale khi profile chọn 'base-on-ip'.
        locale: cfg.locale ?? (useGeoip ? undefined : this.localeFor(cfg, launchProfile)),
        // WebRTC: 'disabled' turns the stack off so no candidates leak. 'base-on-ip'
        // and 'real' both leave it on — the relay already forces egress through the
        // proxy IP, so discovered candidates match.
        block_webrtc: cfg.webrtc === 'disabled',
        // Chặn tải hình ảnh (block_images) — nhanh hơn + tiết kiệm băng thông proxy
        // tính tiền. Tắt khi flow cần thấy/tương tác với ảnh.
        block_images: cfg.blockImages === true,
        // Mock con trỏ NATIVE của Camoufox: engine tự vẽ chuyển động chuột cong,
        // human-like ở tầng browser (con trỏ di chuyển THẬT, thấy trên cửa sổ) —
        // khác page.mouse.move của Playwright chỉ phát sự kiện chứ không nhấc con
        // trỏ thật. Đây là "mock con trỏ" vốn có; codex bỏ nó nên nhìn như mất.
        //
        // humanize tách theo nền tảng:
        //  - Mac: true — engine tự chọn thời lượng (tới ~1.5s). Compositing phần
        //    cứng của Mac vẽ nhanh nên cú di mượt, KHÔNG bị lê; giữ true cho tự
        //    nhiên nhất.
        //  - Windows: cap 0.5s. Nhiều cửa sổ headful tranh compositor, 1.5s đó bị
        //    kéo thành hàng chục giây ("con trỏ di mãi chưa xong"). Trần 0.5s vẫn
        //    cong + human nhưng không lê khi máy vẽ chậm.
        humanize: IS_WINDOWS ? 0.5 : true,
        // showcursor: highlighter (chấm con trỏ) của Camoufox là 1 lớp overlay vẽ
        // mỗi frame. Trên Win nhiều cửa sổ headful, lớp này tốn render → góp phần
        // khựng. Tắt trên Win (chuyển động chuột humanize VẪN chạy, chỉ ẩn chấm).
        // Mac giữ mặc định (render rẻ, tiện nhìn con trỏ khi theo dõi).
        showcursor: IS_WINDOWS ? false : undefined,
        // Browser geolocation permission. 'prompt' (Firefox default) asks the user,
        // 'allow' grants silently so the position (set by geoip) is served without a
        // dialog, 'disabled' turns the navigator.geolocation API off entirely.
        firefox_user_prefs: this.geoPrefs(cfg),
        // Hide enumerated media devices (cameras/mics/speakers) via Camoufox's
        // config passthrough — mediaDevices.enumerateDevices() then returns empty.
        // Off when the profile needs real video/voice calls.
        config: cfg.maskMediaDevices ? { 'mediaDevices:enabled': false } : undefined,
        // Screen resolution: 'real' lets Camoufox pick one coherent with the OS; a
        // "WIDTHxHEIGHT" string constrains the fingerprint generator to that exact
        // size so screen.width/height AND availWidth/availHeight report it coherently
        // (the `window` option only sizes the window, leaving screen.* at the Xvfb
        // size — a mismatch a fingerprinter would catch).
        screen: this.screenConstraint(cfg),
        // WebGL is left to Camoufox: it samples a plausible vendor/renderer pair
        // for the chosen OS (with variation across profiles, which is what we want
        // for a fleet — pinning one pair makes every profile look identical and is
        // itself a grouping signal). The pairs are Firefox-style strings, not the
        // Chromium/ANGLE strings a Chromium build reports.
        args: [...(browser.chromeParams ?? []), ...(this.defaults.args ?? []), ...(opts.args ?? [])],
      });

      try {
        context = (await Camoufox(buildOpts(wantGeoip))) as BrowserContext;
      } catch (err) {
        // camoufox's geoip does a public-IP lookup THROUGH the proxy (6 endpoints:
        // ipify, amazonaws…). A slow/blocked proxy fails all 6 and throws InvalidIP,
        // which would otherwise kill the whole launch. Degrade gracefully: retry
        // once with geoip off, falling back to the coarse country→locale map, so a
        // flaky IP lookup costs only the fine geo-coherence, not the whole profile.
        if (wantGeoip && isGeoipIpError(err)) {
          this.log.warn(
            `"${profile.name}": geoip public-IP lookup failed through proxy — retrying without geoip`,
          );
          context = (await Camoufox(buildOpts(false))) as BrowserContext;
        } else {
          throw err;
        }
      }

    } catch (err) {
      // Launch failed after the lease was taken — free the proxy (and any relay
      // we already opened) so it isn't stranded as busy, then rethrow.
      this.releaseLease(leasedProxyId);
      if (proxyRelayUrl) void closeAnonymizedProxy(proxyRelayUrl, true);
      throw err;
    }

    // Chặn video (media) ở mọi trang của context: CapCut nhúng clip demo/marketing
    // tự phát → tốn băng thông proxy tính tiền + tải render vô ích cho flow reg.
    // Chặn ở tầng route (resourceType 'media') bắt cả <video>/<audio> lẫn fetch
    // stream, không đụng ảnh/SVG (nút bấm nhiều cái là SVG — chặn sẽ gãy flow).
    await context.route('**/*', (route) => {
      if (route.request().resourceType() === 'media') return route.abort();
      return route.continue();
    });

    const session: Session = { profile: launchProfile, context, proxyRelayUrl, leasedProxyId };
    this.sessions.set(profileId, session);
    // Cửa sổ Camoufox vừa xuất hiện → xếp lại lưới (no-op ngoài Windows).
    scheduleTile();

    context.on('close', () => {
      this.sessions.delete(profileId);
      this.releaseLease(leasedProxyId);
      if (proxyRelayUrl) void closeAnonymizedProxy(proxyRelayUrl, true);
      // Một cửa sổ đóng → dồn các cửa sổ còn lại cho đều.
      scheduleTile();
    });

    // Open startup URLs (reuse the about:blank page the persistent context gives us).
    if (browser.startupUrls?.length) {
      for (let i = 0; i < browser.startupUrls.length; i += 1) {
        const page = i === 0 ? context.pages()[0] ?? (await context.newPage()) : await context.newPage();
        await page.goto(browser.startupUrls[i], { waitUntil: 'domcontentloaded' }).catch((err) => {
          this.log.warn(`startup URL failed ${browser.startupUrls[i]}: ${(err as Error).message}`);
        });
      }
    }

    return session;
  }

  /** Locale for the Intl API: explicit profile locale wins, else derive from the
   *  proxy country when the profile opted into 'base-on-ip', else undefined
   *  (Camoufox picks one consistent with the OS). */
  private localeFor(cfg: AntiDetectConfig, profile: Profile): string | undefined {
    if (cfg.language === 'base-on-ip') return languageForCountry(profile.proxy?.country);
    return undefined;
  }

  /** Firefox prefs cho mỗi launch. Gồm:
   *  1. Prefs giảm tải CPU/render (WIN_PERF_PREFS) — CHỈ áp trên Windows, rỗng
   *     trên Mac/Linux (xem chú thích ở khai báo WIN_PERF_PREFS).
   *  2. Knob geolocation: 'allow' cấp im lặng, 'disabled' tắt API, 'prompt' để
   *     mặc định Firefox (không set gì thêm).
   *  Trả object rỗng {} vẫn hợp lệ với Camoufox (trên Mac khi geolocation ở
   *  'prompt' thì đúng là {}). */
  private geoPrefs(cfg: AntiDetectConfig): Record<string, unknown> {
    const prefs: Record<string, unknown> = { ...WIN_PERF_PREFS };
    if (cfg.geolocation === 'allow') prefs['permissions.default.geo'] = 1;
    else if (cfg.geolocation === 'disabled') prefs['geo.enabled'] = false;
    return prefs;
  }

  /** Screen constraint backing the resolution knob. 'real' (or any unparseable
   *  value) returns undefined so Camoufox picks an OS-coherent resolution; a
   *  "WIDTHxHEIGHT" string pins min=max on both axes so the fingerprint generator
   *  produces that exact resolution with all screen.* props (width/height/avail*)
   *  coherent. Returns the FingerprintGenerator `screen` shape. */
  private screenConstraint(cfg: AntiDetectConfig):
    { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number } | undefined {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec((cfg.screen ?? '').trim());
    if (!m) return undefined;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!(w > 0 && h > 0)) return undefined;
    return { minWidth: w, maxWidth: w, minHeight: h, maxHeight: h };
  }

  /** Builds a local no-auth HTTP relay (proxy-chain) forwarding to the real
   *  upstream proxy. `server` carries the scheme (http/https/socks5); auth is
   *  injected into the upstream URL so credentials never reach the browser.
   *  Returns the relay URL ("http://127.0.0.1:PORT"). */
  private async makeRelay(proxy: ProxyConfig): Promise<string> {
    const upstream = new URL(proxy.server);
    if (proxy.username) upstream.username = encodeURIComponent(proxy.username);
    if (proxy.password) upstream.password = encodeURIComponent(proxy.password);
    return anonymizeProxy(upstream.toString());
  }

  /** How long a blocked open waits for a proxy to free up before giving up. */
  private static readonly LEASE_WAIT_MS = 120_000;

  /**
   * Acquire a proxy for `profile`, leasing it so no other concurrent open draws
   * the same IP. For non-pool modes there's nothing to lease — delegates to
   * resolveAndPersist and returns no lease. For pool mode:
   *   1. pick a matching proxy that ISN'T already leased, and mark it leased —
   *      both steps run synchronously (no await between) so two racing opens
   *      can't grab the same id;
   *   2. if every matching proxy is leased, block until one is released (bounded
   *      by LEASE_WAIT_MS) rather than doubling up on an IP — this is what caps
   *      effective concurrency at the number of live proxies;
   *   3. verify the pick is live (when rotateOnFailure); a dead one is marked and
   *      the lease released, then redraw.
   * Returns the ProxyConfig to launch with plus the leased id (so open() can
   * release it when the context closes). Throws when the pool has no live match
   * or the wait times out — open() then rejects rather than leaking the real IP.
   */
  private async acquireProxy(
    profile: Profile,
    trigger: ResolveTrigger,
  ): Promise<{ proxy: ProxyConfig | undefined; leasedProxyId?: string }> {
    const rotation = profile.proxyRotation ?? defaultProxyRotation();

    if (rotation.mode !== 'pool') {
      // static / gateway / no proxy: nothing to lease.
      return { proxy: await this.resolveAndPersist(profile, trigger) };
    }
    if (!this.store) throw new Error('Pool proxy cần ProxyStore nhưng BrowserManager không có');

    const deadline = Date.now() + BrowserManager.LEASE_WAIT_MS;
    const failedThisOpen = new Set<string>();
    for (;;) {
      const matching = poolMatching(this.store, rotation).filter((p) => !failedThisOpen.has(p.id));
      if (!matching.length) {
        if (failedThisOpen.size) {
          throw new Error(
            `Không còn proxy dùng được sau khi check live (${failedThisOpen.size} proxy vừa fail). Vào Quản lý proxy bấm Check lại hoặc thay proxy mới.`,
          );
        }
        throw new Error(emptyPoolMessage(this.store, rotation));
      }
      const free = matching.filter((p) => !this.leasedProxyIds.has(p.id));

      if (!free.length) {
        // Every matching proxy is in use by another concurrent session. Wait for
        // a release instead of reusing an IP; retry the pick when woken.
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Tất cả ${matching.length} proxy khớp tag đang bận — chờ quá ${BrowserManager.LEASE_WAIT_MS / 1000}s`,
          );
        }
        this.log.info(`chờ proxy rảnh (${matching.length} proxy đều đang bận)`);
        await this.waitForLease(Math.min(5_000, remaining));
        continue;
      }

      // Pick + lease synchronously — no await between these two lines, so a
      // second open running concurrently can never observe this id as free.
      const chosen = free[randomInt(0, free.length)];
      this.leasedProxyIds.add(chosen.id);

      // Proxy dạng API (mktproxy xoay): mỗi lần rút → LẤY IP MỚI qua rotate-ip
      // (resolveApiProxy lo whitelist + rotate + protocol). Nhờ vậy mỗi profile
      // tạm/đăng ký một IP khác — reg xong con này, con sau tự có IP mới. Bỏ qua
      // recheck liveness tĩnh vì rotate vừa trả IP live.
      if (chosen.apiProvider && this.deps.resolveApiProxy) {
        const fresh = await this.deps.resolveApiProxy(chosen).catch((e) => {
          this.log.warn(`resolve proxy API lỗi: ${(e as Error).message}`);
          return undefined;
        });
        const cfg = fresh ?? recordToConfig(chosen);
        this.log.info(`profile "${profile.name}": proxy API xoay → ${cfg.server}`);
        await this.profiles.update(profile.id, { proxy: cfg, assignedProxyId: chosen.id });
        return { proxy: cfg, leasedProxyId: chosen.id };
      }

      // Verify liveness before committing (mirrors resolveAndPersist's
      // rotateOnFailure). Dead → mark it, release the lease, redraw.
      if (rotation.rotateOnFailure) {
        const check = await checkProxy(chosen);
        await this.store.update(chosen.id, {
          alive: check.alive,
          latencyMs: check.latencyMs,
          checkedAt: new Date().toISOString(),
        });
        if (!check.alive) {
          this.log.warn(`proxy ${chosen.host}:${chosen.port} dead, redrawing`);
          failedThisOpen.add(chosen.id);
          this.releaseLease(chosen.id);
          continue;
        }
      }

      const config = recordToConfig(chosen);
      await this.profiles.update(profile.id, { proxy: config, assignedProxyId: chosen.id });
      return { proxy: config, leasedProxyId: chosen.id };
    }
  }

  /**
   * Resolves which proxy to launch `profile` with and persists the choice back
   * onto the profile when it changed. For pool mode with `rotateOnFailure`, the
   * assigned proxy is rechecked live before launch; a dead one is marked and a
   * different candidate drawn, retrying until a live proxy is found or the pool
   * is exhausted (then the caller's open() rejects rather than leaking the real
   * IP via a direct connection). Returns the ProxyConfig to launch with, or
   * undefined for a direct connection (static/gateway with no proxy set).
   *
   * Non-pool path only now (pool draws go through acquireProxy for leasing); kept
   * for static/gateway and for rotate() when the profile is closed.
   */
  private async resolveAndPersist(profile: Profile, trigger: ResolveTrigger): Promise<ProxyConfig | undefined> {
    const rotation = profile.proxyRotation ?? defaultProxyRotation();

    let result = resolveProxy(profile, this.store, { trigger });

    // Pool + rotateOnFailure: verify the drawn proxy is actually live, else mark
    // it dead and redraw. Bounded retries so a fully-dead pool can't loop.
    if (rotation.mode === 'pool' && rotation.rotateOnFailure && this.store) {
      for (let attempt = 0; attempt < 3 && result.assignedProxyId; attempt += 1) {
        const record = this.store.get(result.assignedProxyId);
        if (!record) break;
        const check = await checkProxy(record);
        await this.store.update(record.id, {
          alive: check.alive,
          latencyMs: check.latencyMs,
          checkedAt: new Date().toISOString(),
        });
        if (check.alive) break;
        this.log.warn(`proxy ${record.host}:${record.port} dead, redrawing (attempt ${attempt + 1})`);
        // Redraw excluding the just-failed proxy by persisting it first so the
        // resolver's exclude-current logic skips it.
        await this.profiles.update(profile.id, { assignedProxyId: record.id });
        const next = this.profiles.get(profile.id) ?? profile;
        result = resolveProxy(next, this.store, { trigger: 'failure' });
      }
    }

    if (result.changed || result.assignedProxyId !== profile.assignedProxyId) {
      await this.profiles.update(profile.id, {
        proxy: result.proxy,
        assignedProxyId: result.assignedProxyId,
      });
    }
    return result.proxy;
  }

  /** Wipe Firefox's cache dirs inside the userDataDir without touching cookies
   *  or localStorage (those live elsewhere and must survive). */
  private async clearCache(userDataDir: string): Promise<void> {
    const targets = ['cache2', 'startupCache', 'OfflineCache'];
    await Promise.all(
      targets.map((t) => rm(join(userDataDir, t), { recursive: true, force: true })),
    );
  }

  /** Whether a profile currently has an open context. */
  isOpen(profileId: string): boolean {
    return this.sessions.has(profileId);
  }

  /** Ids of every profile with an open context. */
  openProfileIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Closes a single profile's context, flushing its session to disk. */
  async close(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) return;
    await session.context.close();
    this.sessions.delete(profileId);
    // Nhả proxy đã thuê để profile kế tiếp dùng lại — nếu không, mỗi lần chạy rò
    // rỉ 1 proxy khỏi pool, tới khi cạn thì open kế tiếp đứng chờ LEASE_WAIT_MS
    // rồi mới lỗi (triệu chứng "chạy 10 kẹt ở con gần cuối").
    this.releaseLease(session.leasedProxyId);
    this.log.info(`closed ${profileId}`);
  }

  /**
   * Rotates a profile's proxy. For 'pool' this draws a fresh candidate; for
   * 'gateway' the provider rotates the egress IP on a new session, so we just
   * re-establish it. If the profile is currently open, it is closed and
   * reopened so the new IP takes effect immediately. Throws for 'static' (there
   * is nothing to rotate) or when a pool has no live candidate left.
   */
  async rotate(profileId: string, trigger: 'manual' = 'manual'): Promise<Session | undefined> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    const rotation = profile.proxyRotation ?? defaultProxyRotation();
    if (rotation.mode === 'static') {
      throw new Error('Profile không ở chế độ pool/gateway, không có gì để xoay');
    }

    const wasOpen = this.sessions.has(profileId);
    if (wasOpen) await this.close(profileId);

    if (rotation.mode === 'gateway') {
      // Provider rotates egress per session — just reopen (if it was open) or
      // leave closed; nothing to redraw locally.
      return wasOpen ? this.open(profileId) : undefined;
    }

    // pool: force a fresh draw. When open, reopen carries the draw through the
    // normal launch path. When closed, resolve+persist so the next open uses it.
    if (wasOpen) return this.open(profileId, { rotateTrigger: trigger });
    await this.resolveAndPersist(profile, trigger);
    return undefined;
  }

  /** Closes every open context. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /**
   * Runs `task` against many profiles with bounded concurrency. Each task gets
   * its own freshly-opened session; failures are isolated per profile and
   * reported in the returned results rather than aborting the whole batch.
   */
  async runBatch<T>(
    profileIds: string[],
    task: ProfileTask<T>,
    opts: { concurrency?: number; launch?: LaunchOptions; autoClose?: boolean } = {},
  ): Promise<Array<{ profileId: string; value?: T; error?: Error }>> {
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    const autoClose = opts.autoClose ?? true;
    const results: Array<{ profileId: string; value?: T; error?: Error }> = [];
    const queue = [...profileIds];

    const worker = async (): Promise<void> => {
      for (;;) {
        const profileId = queue.shift();
        if (!profileId) return;
        try {
          // Nhịp 1-3s NGẪU NHIÊN trước mỗi lần mở camoufox. Từ khi mua VIP chạy qua
          // API, mỗi profile xong rất nhanh nên các lần mở dồn sát nhau — giãn ra
          // cho tự nhiên hơn và tránh mở đồng loạt.
          await new Promise((r) => setTimeout(r, 1_000 + Math.floor(Math.random() * 2_000)));
          const session = await this.open(profileId, opts.launch);
          const value = await task(session);
          results.push({ profileId, value });
        } catch (err) {
          this.log.error(`task failed for ${profileId}: ${(err as Error).message}`);
          results.push({ profileId, error: err as Error });
        } finally {
          if (autoClose) await this.close(profileId);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return results;
  }
}
