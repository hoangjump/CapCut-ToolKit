export interface ProxyConfig {
  server: string; // e.g. "http://host:port" or "socks5://host:port"
  username?: string;
  password?: string;
  /** ISO country code from IP geo, used by language: 'base-on-ip'. */
  country?: string;
}

export interface BrowserCookieSnapshot {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** How a profile sources its proxy at launch time. */
export type ProxyMode = 'static' | 'pool' | 'gateway';

export interface ProxyPoolFilter {
  /** Only draw proxies carrying all of these tags (empty = any proxy). */
  tags?: string[];
  /** Only draw proxies with alive===true (default true). */
  liveOnly?: boolean;
}

/**
 * Proxy rotation config. 'static' pins profile.proxy (legacy behavior).
 * 'pool' draws from the ProxyStore library at launch. 'gateway' keeps a fixed
 * rotating-endpoint proxy where the provider rotates the egress IP per session.
 */
export interface ProxyRotation {
  mode: ProxyMode;
  pool?: ProxyPoolFilter;
  /** pool: draw a fresh proxy on every open (default false → keep assigned one). */
  rotateOnOpen?: boolean;
  /** pool: recheck the assigned proxy before launch; if dead, draw another. */
  rotateOnFailure?: boolean;
}

export function defaultProxyRotation(): ProxyRotation {
  return { mode: 'static' };
}

/**
 * Anti-detect knobs. The engine is Camoufox (a hardened Firefox build) which
 * handles canvas/webgl/audio/font/screen/cpu/memory/mediaDevices spoofing in
 * its C++ engine — those no longer need per-field knobs here, and the WebGL
 * vendor/renderer is sampled by Camoufox per-OS (forcing one pair makes every
 * profile look identical, which is itself a tell). What remains are the few
 * launch-time choices we still pass to Camoufox: OS to claim, WebRTC handling,
 * and locale source.
 */
export interface AntiDetectConfig {
  /**
   * OS the fingerprint should claim. Camoufox generates a fully coherent
   * platform/UA/WebGL/font set for the chosen OS. 'auto' lets it randomize
   * across windows/macos/linux per launch.
   */
  osProfile: 'auto' | 'windows' | 'macos' | 'linux';
  /** Locale source: keep Camoufox's OS-coherent default ('real') or derive from
   *  the proxy IP geo ('base-on-ip'). */
  language: 'real' | 'base-on-ip';
  /** WebRTC handling: 'disabled' turns the stack off so no candidates leak;
   *  'base-on-ip' and 'real' leave it on (the proxy relay forces egress so
   *  discovered candidates match the proxy IP). */
  webrtc: 'base-on-ip' | 'real' | 'disabled';
  /** Derive timezone + geolocation (lat/long) + locale + WebRTC IP from the
   *  proxy's egress IP via Camoufox's geoip (a MaxMind lookup done through the
   *  proxy at launch). When on it supersedes the coarse `language` map with a
   *  full IP-coherent set. Off keeps the OS-coherent defaults. */
  geoip: boolean;
  /** Browser geolocation permission (navigator.geolocation): 'prompt' asks,
   *  'allow' grants silently (position comes from geoip when enabled),
   *  'disabled' turns the API off. */
  geolocation: 'prompt' | 'allow' | 'disabled';
  /** Hide enumerated media devices (cameras/mics/speakers). Sets Camoufox's
   *  `mediaDevices:enabled=false` so navigator.mediaDevices.enumerateDevices()
   *  returns nothing. Turn off if the profile needs real video/voice calls. */
  maskMediaDevices: boolean;
  /** Block image loading via Camoufox's `block_images`. Speeds up runs and cuts
   *  bandwidth (handy on metered proxies); leave off when a flow needs to see or
   *  interact with images. */
  blockImages: boolean;
  /** Screen resolution to claim. 'real' lets Camoufox pick one coherent with the
   *  OS; a "WIDTHxHEIGHT" string (e.g. "1920x1080") pins a fixed window size via
   *  Camoufox's `window` option so screen/window dims report that resolution. */
  screen: string;
  /** Ép locale BCP-47 cụ thể (vd 'en-US') ở tầng engine — thắng cả map theo
   *  country. Dùng khi cần UI một ngôn ngữ cố định bất kể IP proxy (vd flow
   *  ChatGPT chạy proxy VN nhưng cần giao diện tiếng Anh để bắt nút theo text).
   *  Absent = theo geoip/language như cũ. Nên tắt geoip khi đặt cái này để IP
   *  không kéo locale về ngôn ngữ khác. */
  locale?: string;
}

export function defaultAntiDetect(): AntiDetectConfig {
  return {
    osProfile: 'auto',
    language: 'base-on-ip',
    webrtc: 'base-on-ip',
    geoip: true,
    geolocation: 'prompt',
    maskMediaDevices: true,
    blockImages: false,
    screen: 'real',
  };
}

/** Browser-trigger + startup behavior, mirroring the left column of the panel. */
export interface BrowserSettings {
  /** "Xóa Cache tự động" — wipe Cache/Code Cache dirs before launch. */
  clearCacheOnStart: boolean;
  /** "Giới hạn kích thước trình duyệt theo cài đặt" — force window to viewport. */
  limitWindowToViewport: boolean;
  /** "Khôi phục phiên làm việc trước" — reopen last session's tabs. */
  restorePreviousSession: boolean;
  /** "URL khởi động" — opened in order on launch. */
  startupUrls: string[];
  /** "Chrome start parameters" — extra raw Chromium flags. */
  chromeParams: string[];
  /** "Bookmarks" — seeded into the profile. */
  bookmarks: Array<{ name: string; url: string }>;
  /** File extensions ("Cho phép request file tĩnh không qua proxy") bypassing
   *  the proxy, e.g. ['.css', '.png', '.jpg']. Empty = route everything. */
  noProxyExtensions: string[];
}

export function defaultBrowserSettings(): BrowserSettings {
  return {
    clearCacheOnStart: true,
    limitWindowToViewport: true,
    restorePreviousSession: false,
    startupUrls: [],
    chromeParams: [],
    bookmarks: [],
    noProxyExtensions: [],
  };
}

export interface Profile {
  id: string;
  name: string;
  /** Organizational group, e.g. "Default group". */
  group?: string;
  /** Window/taskbar title override; falls back to the profile name when empty. */
  taskbarTitle?: string;
  /** Current proxy. For 'static'/'gateway' this is the pinned proxy; for 'pool'
   *  it's the currently-assigned draw (updated on each rotation, so the UI can
   *  show it and it survives restarts). */
  proxy?: ProxyConfig;
  /** How the proxy is sourced at launch. Absent = treated as 'static'. */
  proxyRotation?: ProxyRotation;
  /** ProxyStore record id backing `proxy` when mode='pool' — lets us avoid
   *  re-drawing the same one and update its liveness. */
  assignedProxyId?: string;
  antiDetect?: AntiDetectConfig;
  browser?: BrowserSettings;
  /** Stable per-profile seed, retained for backwards compatibility with
   *  existing stored profiles. */
  seed?: number;
  createdAt: string;
  notes?: string;
}

export interface LaunchOptions {
  /** `false` = real headed window (local). `'virtual'` = headful inside an Xvfb
   *  virtual display (containers): Camoufox runs the real engine so headless
   *  tells don't leak, but no physical screen is needed. `true` = true headless
   *  (lightest, but Firefox headless is itself a weak detection signal). */
  headless?: boolean | 'virtual';
  /** Extra args passed to the browser process. */
  args?: string[];
  /** Slow down operations by N ms — useful while debugging. */
  slowMo?: number;
  /** What kicked off this launch — controls whether a pool profile re-draws its
   *  proxy. 'open' respects rotateOnOpen; 'manual'/'failure' force a re-draw. */
  rotateTrigger?: 'open' | 'manual' | 'failure';
}

/** The credential triple dongvanfb's tools.* endpoints authenticate with — no
 *  API key needed to read mail / fetch OTP, just this per-mailbox set. */
export interface MailCredentials {
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
}

/** A mailbox in the local library — either bought via /user/buy or added by
 *  hand. `refreshToken` + `clientId` are secrets: never log or expose raw. */
export interface MailRecord {
  id: string;
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
  /** Mail host, e.g. "hotmail"/"outlook" — derived from the address domain. */
  provider?: string;
  tags: string[];
  note?: string;
  /** Order id from the buy response, when this mail came from a purchase. */
  orderCode?: string;
  boughtAt: string;
}

/** Params for a /user/buy call. `count` maps to how many rows we expect back. */
export interface BuyMailInput {
  accountType: string;
  quality: string;
  count?: number;
}

/** Service whose confirmation code we want to pull from a mailbox. */
export type MailCodeType =
  | 'all' | 'facebook' | 'instagram' | 'twitter' | 'apple' | 'tiktok'
  | 'amazon' | 'lazada' | 'google' | 'shopee' | 'telegram' | 'wechat';

export interface GetCodeInput extends MailCredentials {
  type: MailCodeType;
}

/** Persisted app-level settings. `dongvanfbApiKey` bills real money — stored
 *  locally, only ever returned to the UI masked. */
export interface AppSettings {
  dongvanfbApiKey?: string;
  /** Apps Script Web App URL. When set, each registered account (mail full +
   *  checkout link) is POSTed here to append a row to the bound Google Sheet. */
  sheetWebhookUrl?: string;
  /** mktproxy.com API key (billed real money). Stored locally, only ever
   *  returned to the UI masked. Used to buy proxies + query balance/orders. */
  mktproxyApiKey?: string;
  /** selltaikhoan.com API key (bills real money) — nhà cung cấp mail thứ 2
   *  (Outlook OAuth2 rẻ hơn, cùng định dạng email|password|refresh|client nên
   *  đọc OTP tái dùng chung). Lưu local, chỉ trả UI dạng masked. */
  selltaikhoanApiKey?: string;
  /** smsbower.online API key (bills real money) — dịch vụ THUÊ địa chỉ gmail để
   *  nhận code xác minh theo service (vd đăng ký ChatGPT). Không phải hộp thư có
   *  sẵn nên đi đường riêng (ctx.rentMail), không qua buyMail/getOtp. Lưu local,
   *  chỉ trả UI dạng masked. */
  smsbowerApiKey?: string;
  /** Telegram bot token (from @BotFather). When set together with a chat id,
   *  each successfully registered account is posted to that chat. */
  telegramBotToken?: string;
  /** Telegram chat id the bot posts success notifications to (a user, group, or
   *  channel id — group/channel ids are negative). */
  telegramChatId?: string;
  /** Bot riêng cho module giao việc; tách khỏi bot báo kết quả automation. */
  workTelegramBotToken?: string;
  /** Supergroup forum nhận công việc, dạng -100... */
  workTelegramChatId?: string;
  workTelegramMode?: 'off' | 'polling' | 'webhook';
  workTelegramWebhookUrl?: string;
  workTelegramWebhookSecret?: string;
  /** URL công khai của app, dùng tạo link /pay/:token gửi cho nhân viên. */
  paymentPublicUrl?: string;
  /** Tự bật Cloudflare Tunnel khi app desktop khởi động. */
  paymentTunnelAutoStart?: boolean;
  /** Token của named Cloudflare Tunnel, lấy từ lệnh cài connector. */
  paymentTunnelToken?: string;
  /** Domain HTTPS đã gắn Public Hostname vào named tunnel. */
  paymentTunnelDomain?: string;
}

/** A saved automation job: run a named flow across a set of profiles, optionally
 *  with a mailbox bound in for OTP steps. Flows themselves are TS code in
 *  `flows/`; this record just names which flow + which profiles to drive. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** Key into the flow registry (flows/index.ts). */
  flowName: string;
  /** Profiles this project drives when run. */
  profileIds: string[];
  /** "Dùng một lần": nếu >0 và không chọn profile sẵn, mỗi lần Chạy sẽ tự tạo
   *  bấy nhiêu profile tạm, chạy flow xong thì xóa sạch (kèm wipe data). Dùng cho
   *  flow đăng ký — mỗi tài khoản một profile sạch, không để lại rác. */
  ephemeralCount?: number;
  /** Optional mailbox (MailRecord id) bound in for getOtp() steps. */
  mailId?: string;
  /** Nhà cung cấp mail cho ctx.buyMail() khi flow tự mua. 'dongvanfb' (mặc định)
   *  dùng buyAccountType+buyQuality; 'selltaikhoan' dùng buyProductId. */
  mailProvider?: 'dongvanfb' | 'selltaikhoan';
  /** Defaults for flows that call ctx.buyMail() (buy a fresh mailbox per profile
   *  from dongvanfb). Needed by registration flows where each profile wants its
   *  own email. Requires the API key configured in the Mail tab. */
  buyAccountType?: string;
  buyQuality?: string;
  /** ID sản phẩm selltaikhoan khi mailProvider='selltaikhoan' (vd 6762 = Outlook
   *  OAuth2 80đ). ctx.buyMail() mua 1 con từ sản phẩm này cho mỗi profile. */
  buyProductId?: string;
  /** Mã service SmsBower cho flow thuê gmail nhận OTP (vd flow chatgpt-signup).
   *  Lấy từ smsbower.com/api. Absent = flow dùng mặc định của nó. */
  smsbowerService?: string;
  /** Khi tạo profile tạm (ephemeral), rút proxy từ pool theo bộ lọc này thay vì
   *  chạy IP thật. Mỗi profile tạm là profile mới nên tự động rút một proxy Live
   *  riêng từ kho. Absent = profile tạm chạy không proxy (IP thật). */
  ephemeralProxyPool?: ProxyPoolFilter;
  /** Chặn tải hình ảnh cho profile tạm khi chạy (Camoufox block_images): chạy
   *  nhanh hơn, tiết kiệm băng thông proxy. Chỉ áp cho profile tạm — profile lưu
   *  sẵn dùng cấu hình antiDetect riêng của nó. Absent/false = tải ảnh bình thường. */
  blockImages?: boolean;
  /** Ép project chạy bằng true headless. Absent/false = kế thừa chế độ mặc định
   *  của app/server (Electron hiện cửa sổ; Docker giữ virtual display). */
  headless?: boolean;
  /** Tự phân phối kết quả flow CapCut vào Telegram topic theo quota. Tổng quota
   *  là số profile tạm sẽ chạy; mỗi checkout link thành một task 1 con. */
  telegramDistribution?: {
    enabled: boolean;
    allocations: Array<{ employeeId: string; quantity: number }>;
  };
  /** Max profiles driven at once. Kept low (default 2) since runs are headful. */
  concurrency?: number;
  note?: string;
  createdAt: string;
}

/** Per-profile outcome of a project run — one entry per driven profile. */
export interface RunResult {
  profileId: string;
  ok: boolean;
  error?: string;
}
