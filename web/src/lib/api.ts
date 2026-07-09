// Lớp gọi REST API của backend (giữ nguyên các endpoint /api/* hiện có).

async function parse<T>(r: Response): Promise<T> {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any)?.error || `HTTP ${r.status}`);
  return data as T;
}
const jsonHeaders = { 'Content-Type': 'application/json' };
const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: jsonHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
const put = (url: string, body: unknown) =>
  fetch(url, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) });

// ---- Types ----
export type ProxyType = 'http' | 'https' | 'socks5';
export interface ProxyDto {
  id: string;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tags: string[];
  alive: boolean | null;
  latencyMs?: number;
  checkedAt?: string;
  createdAt: string;
  display: string;
  status: 'unchecked' | 'live' | 'dead';
  isApi?: boolean;
  apiProvider?: 'mktproxy';
}

export interface AntiDetectConfig {
  osProfile: 'auto' | 'windows' | 'macos' | 'linux';
  language: 'real' | 'base-on-ip';
  webrtc: 'base-on-ip' | 'real' | 'disabled';
  geoip: boolean;
  geolocation: 'prompt' | 'allow' | 'disabled';
  maskMediaDevices: boolean;
  blockImages: boolean;
  screen: string;
}
export interface BrowserSettings {
  clearCacheOnStart: boolean;
  limitWindowToViewport: boolean;
  restorePreviousSession: boolean;
  startupUrls: string[];
  chromeParams: string[];
  bookmarks: Array<{ name: string; url: string }>;
  noProxyExtensions?: string[];
}
export interface ProxyRotation {
  mode: 'static' | 'pool' | 'gateway';
  pool?: { tags?: string[]; liveOnly?: boolean };
  rotateOnOpen?: boolean;
  rotateOnFailure?: boolean;
}
export interface Profile {
  id: string;
  name: string;
  proxy?: { server: string; username?: string; password?: string; country?: string };
  proxyRotation?: ProxyRotation;
  antiDetect?: AntiDetectConfig;
  browser?: BrowserSettings;
  createdAt: string;
  notes?: string;
}
export interface MailRecord {
  id: string;
  email: string;
  password?: string;
  provider?: string;
  tags: string[];
  boughtAt: string;
}
export interface AccountType { id: number; name: string; quality: number; price: number }
export interface CodeResult { status: boolean; code: string; content: string; date: string; source: string }
export interface MailMessage {
  subject?: string;
  date?: string;
  code?: string;
  message?: string;
  from?: Array<{ name?: string; address?: string }>;
}
export interface FlowMeta { name: string; label: string; description?: string }
export interface ProjectRecord {
  id: string;
  name: string;
  flowName: string;
  profileIds: string[];
  ephemeralCount?: number;
  mailId?: string;
  buyAccountType?: string;
  buyQuality?: string;
  ephemeralProxyPool?: { tags?: string[]; liveOnly?: boolean } | null;
  concurrency?: number;
  blockImages?: boolean;
  note?: string;
  createdAt: string;
}
export interface RunResult { profileId: string; ok: boolean; error?: string }
export interface Settings {
  hasKey: boolean;
  masked: string | null;
  sheetWebhookUrl: string;
  hasMktproxyKey: boolean;
  mktproxyMasked: string | null;
  hasTelegram: boolean;
  telegramMasked: string | null;
  telegramChatId: string;
}
export interface MktProduct {
  id: number;
  code: string;
  name: string;
  country?: string;
  proxyType?: string;
  protocols: string[];
  authType?: string;
  minQuantity: number;
  maxQuantity: number;
  note?: string;
  tag?: string;
  priceByDuration: Array<{ days: number; price: number }>;
  customFields: Array<Record<string, any>>;
}
export interface LogEntry { ts: string; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; msg: string }

// ---- Proxy ----
export const proxyApi = {
  list: (q = '') => fetch('/api/proxies?q=' + encodeURIComponent(q)).then((r) => parse<ProxyDto[]>(r)),
  create: (body: any) => post('/api/proxies', body).then((r) => parse<ProxyDto[]>(r)),
  update: (id: string, body: any) => put('/api/proxies/' + id, body).then((r) => parse<ProxyDto>(r)),
  remove: (id: string) => fetch('/api/proxies/' + id, { method: 'DELETE' }),
  check: (id: string) => post(`/api/proxies/${id}/check`).then((r) => parse<any>(r)),
  checkAll: () => post('/api/proxies/check-all').then((r) => parse<ProxyDto[]>(r)),
};

// ---- Profiles ----
export const profileApi = {
  list: () => fetch('/api/profiles').then((r) => parse<Profile[]>(r)),
  get: (id: string) => fetch('/api/profiles/' + id).then((r) => parse<Profile>(r)),
  create: (body: any) => post('/api/profiles', body).then((r) => parse<Profile>(r)),
  update: (id: string, body: any) => put('/api/profiles/' + id, body).then((r) => parse<Profile>(r)),
  remove: (id: string) => fetch('/api/profiles/' + id, { method: 'DELETE' }),
  removeAll: () => fetch('/api/profiles', { method: 'DELETE', headers: jsonHeaders }).then((r) => parse<{ removed: number }>(r)),
  open: (id: string) => post(`/api/profiles/${id}/open`).then((r) => parse<any>(r)),
  close: (id: string) => post(`/api/profiles/${id}/close`).then((r) => parse<any>(r)),
  rotateProxy: (id: string) => post(`/api/profiles/${id}/rotate-proxy`).then((r) => parse<any>(r)),
  running: () => fetch('/api/profiles/running').then((r) => parse<{ running: string[] }>(r)),
};

// ---- Settings / Mail ----
export const settingsApi = {
  get: () => fetch('/api/settings').then((r) => parse<Settings>(r)),
  save: (body: Partial<{ dongvanfbApiKey: string; sheetWebhookUrl: string; mktproxyApiKey: string; telegramBotToken: string; telegramChatId: string }>) =>
    put('/api/settings', body).then((r) => parse<Settings>(r)),
};
export const mailApi = {
  balance: () => fetch('/api/mail/balance').then((r) => parse<{ balance: number }>(r)),
  accountTypes: () => fetch('/api/mail/account-types').then((r) => parse<{ accountTypes: AccountType[] }>(r)),
  buy: (body: any) => post('/api/mail/buy', body).then((r) => parse<any>(r)),
  list: () => fetch('/api/mails').then((r) => parse<MailRecord[]>(r)),
  add: (body: any) => post('/api/mails', body).then((r) => parse<MailRecord>(r)),
  remove: (id: string) => fetch('/api/mails/' + id, { method: 'DELETE' }),
  // Xóa hàng loạt: truyền ids để xóa các mail đó; bỏ trống = xóa sạch kho.
  removeMany: (ids?: string[]) =>
    fetch('/api/mails', { method: 'DELETE', headers: jsonHeaders, body: JSON.stringify(ids ? { ids } : {}) }).then((r) => parse<{ removed: number }>(r)),
  code: (id: string, type: string) => post(`/api/mails/${id}/code`, { type }).then((r) => parse<CodeResult>(r)),
  messages: (id: string) => post(`/api/mails/${id}/messages`, {}).then((r) => parse<{ messages: MailMessage[] }>(r)),
};

// ---- mktproxy ----
export const mktApi = {
  balance: () => fetch('/api/mktproxy/balance').then((r) => parse<{ balance: number }>(r)),
  products: () => fetch('/api/mktproxy/products').then((r) => parse<{ products: MktProduct[] }>(r)),
  buy: (body: any) => post('/api/mktproxy/buy', body).then((r) => parse<any>(r)),
};

// ---- Projects / flows ----
export const projectApi = {
  flows: () => fetch('/api/flows').then((r) => parse<FlowMeta[]>(r)),
  list: () => fetch('/api/projects').then((r) => parse<ProjectRecord[]>(r)),
  create: (body: any) => post('/api/projects', body).then((r) => parse<ProjectRecord>(r)),
  update: (id: string, body: any) => put('/api/projects/' + id, body).then((r) => parse<ProjectRecord>(r)),
  remove: (id: string) => fetch('/api/projects/' + id, { method: 'DELETE' }),
  run: (id: string) => post(`/api/projects/${id}/run`).then((r) => parse<{ results: RunResult[] }>(r)),
};

export const CODE_TYPES = ['all', 'facebook', 'google', 'instagram', 'tiktok', 'twitter', 'apple', 'amazon', 'lazada', 'shopee', 'telegram', 'wechat'];
