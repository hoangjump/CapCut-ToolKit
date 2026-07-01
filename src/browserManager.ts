import { Camoufox } from 'camoufox-js';
import type { BrowserContext } from 'playwright-core';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile, LaunchOptions, AntiDetectConfig, ProxyConfig } from './types.js';
import { defaultAntiDetect, defaultBrowserSettings, defaultProxyRotation } from './types.js';
import type { ProfileManager } from './profileManager.js';
import type { ProxyStore } from './proxyStore.js';
import { checkProxy } from './proxyChecker.js';
import { resolveProxy, type ResolveTrigger } from './proxyResolver.js';
import { languageForCountry } from './antiDetect.js';
import { createLogger, type Logger } from './logger.js';

export interface Session {
  profile: Profile;
  context: BrowserContext;
  /** Local relay URL (proxy-chain) backing this session's proxy, if any.
   *  Must be closed when the context closes to free the listener. */
  proxyRelayUrl?: string;
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

  constructor(
    private readonly profiles: ProfileManager,
    private readonly store?: ProxyStore,
    private readonly defaults: LaunchOptions = {},
  ) {
    this.log = createLogger('browser');
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

    const cfg = profile.antiDetect ?? defaultAntiDetect();

    // Resolve which proxy to launch with (may draw a fresh one from the pool),
    // persist the choice back onto the profile, and refresh our local `profile`
    // handle so the Session/relay below see the resolved proxy.
    const resolvedProxy = await this.resolveAndPersist(profile, opts.rotateTrigger ?? 'open');
    const launchProfile = this.profiles.get(profileId) ?? profile;

    // SOCKS5-with-auth and credentialed proxies are awkward to pass straight to
    // the browser. Route every proxy through a local no-auth HTTP relay
    // (proxy-chain) that forwards to the real upstream — covers http/https/socks5
    // uniformly and keeps credentials out of the browser process.
    const proxyRelayUrl = resolvedProxy ? await this.makeRelay(resolvedProxy) : undefined;

    const context = (await Camoufox({
      user_data_dir: userDataDir,
      headless,
      // OS the fingerprint should claim. 'auto' lets Camoufox randomize across
      // win/mac/linux; otherwise we pin it so platform/UA/WebGL stay coherent.
      os: cfg.osProfile && cfg.osProfile !== 'auto' ? cfg.osProfile : undefined,
      proxy: proxyRelayUrl ? { server: proxyRelayUrl } : undefined,
      // geoip: derive timezone + geolocation + locale + WebRTC IP from the proxy's
      // egress IP (MaxMind lookup done through the relay at launch). Only enabled
      // when a proxy is actually in play — a geoip lookup with no proxy would key
      // off the host's real IP, which is the opposite of what we want.
      geoip: cfg.geoip && proxyRelayUrl ? true : undefined,
      // Locale driving the Intl API. When geoip is on it sets a fully IP-coherent
      // locale itself, so we leave this undefined and defer to it; otherwise fall
      // back to the coarse country→locale map when the profile opted into it.
      locale: cfg.geoip && proxyRelayUrl ? undefined : this.localeFor(cfg, launchProfile),
      // WebRTC: 'disabled' turns the stack off so no candidates leak. 'base-on-ip'
      // and 'real' both leave it on — the relay already forces egress through the
      // proxy IP, so discovered candidates match.
      block_webrtc: cfg.webrtc === 'disabled',
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
    })) as BrowserContext;

    const session: Session = { profile: launchProfile, context, proxyRelayUrl };
    this.sessions.set(profileId, session);

    context.on('close', () => {
      this.sessions.delete(profileId);
      if (proxyRelayUrl) void closeAnonymizedProxy(proxyRelayUrl, true);
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

  /** Firefox prefs backing the geolocation-permission knob. 'prompt' is Firefox's
   *  own default so we set nothing; 'allow' grants silently (position served from
   *  geoip when on); 'disabled' turns the navigator.geolocation API off. Returns
   *  undefined for 'prompt' so Camoufox's defaults stand. */
  private geoPrefs(cfg: AntiDetectConfig): Record<string, unknown> | undefined {
    if (cfg.geolocation === 'allow') return { 'permissions.default.geo': 1 };
    if (cfg.geolocation === 'disabled') return { 'geo.enabled': false };
    return undefined;
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

  /**
   * Resolves which proxy to launch `profile` with and persists the choice back
   * onto the profile when it changed. For pool mode with `rotateOnFailure`, the
   * assigned proxy is rechecked live before launch; a dead one is marked and a
   * different candidate drawn, retrying until a live proxy is found or the pool
   * is exhausted (then the caller's open() rejects rather than leaking the real
   * IP via a direct connection). Returns the ProxyConfig to launch with, or
   * undefined for a direct connection (static/gateway with no proxy set).
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
