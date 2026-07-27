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
const noContent = async (response: Response): Promise<void> => {
  if (!response.ok) await parse(response);
};

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
  mailProvider?: 'dongvanfb' | 'selltaikhoan';
  buyAccountType?: string;
  buyQuality?: string;
  buyProductId?: string;
  smsbowerService?: string;
  ephemeralProxyPool?: { tags?: string[]; liveOnly?: boolean } | null;
  concurrency?: number;
  blockImages?: boolean;
  headless?: boolean;
  telegramDistribution?: {
    enabled: boolean;
    allocations: Array<{ employeeId: string; quantity: number }>;
  };
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
  hasSelltaikhoanKey: boolean;
  selltaikhoanMasked: string | null;
  hasSmsbowerKey: boolean;
  smsbowerMasked: string | null;
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
export interface SellProduct { id: string; name: string; price: number; amount: number | null; category: string }
export interface SmsbowerRest { service: string; domain: string; price: number; count: number }
export type WorkEmployeeStatus = 'unbound' | 'active' | 'inactive' | 'archived';
export type SalaryVisibility = 'topic' | 'private' | 'admin-only';
export interface EmployeeTotals {
  pendingTasks: number;
  todayQuantity: number;
  todayAmount: number;
  monthQuantity: number;
  monthAmount: number;
  allQuantity: number;
  allAmount: number;
}
export interface WorkEmployee {
  id: string;
  fullName: string;
  defaultUnitRate: number;
  salaryVisibility: SalaryVisibility;
  status: WorkEmployeeStatus;
  bindCode: string;
  telegramUserId?: string;
  telegramChatId?: string;
  telegramTopicId?: number;
  createdAt: string;
  updatedAt: string;
  totals: EmployeeTotals;
}
export interface WorkTask {
  id: string;
  employeeId: string;
  description: string;
  deadline?: string;
  quantity: number;
  unitRate: number;
  amount: number;
  status: 'queued' | 'pending' | 'completed' | 'cancelled' | 'failed';
  deliveryStatus: 'queued' | 'sent' | 'failed';
  deliveryError?: string;
  telegramChatId?: string;
  telegramTopicId?: number;
  telegramMessageId?: number;
  completedAt?: string;
  completedByUserId?: string;
  source?: 'manual' | 'capcut-distribution';
  distributionRunId?: string;
  distributionItemId?: string;
  paymentSessionId?: string;
  paymentStatus?: PaymentSessionStatus;
  paidAt?: string;
  capcutCredentials?: { email: string; password?: string; mailLine: string; checkoutUrl: string };
  createdAt: string;
  updatedAt: string;
}
export interface PayrollRow {
  employeeId: string;
  fullName: string;
  defaultUnitRate: number;
  totals: EmployeeTotals;
}
export interface WorkTelegramConfig {
  hasToken: boolean;
  tokenMasked: string | null;
  chatId: string;
  mode: 'off' | 'polling' | 'webhook';
  webhookUrl: string;
  pollingActive: boolean;
  paymentPublicUrl: string;
  paymentBrowserEnabled: boolean;
  paymentTunnelHasToken: boolean;
  paymentTunnelTokenMasked: string | null;
  paymentTunnelDomain: string;
  tunnel?: TunnelStatus;
}
export interface TunnelStatus {
  state: 'off' | 'starting' | 'online' | 'error';
  mode: 'quick' | 'named';
  originUrl: string;
  publicUrl: string;
  autoStart: boolean;
  error?: string;
}
export type PaymentSessionStatus = 'pending' | 'starting' | 'ready' | 'verifying' | 'paid' | 'verification_failed' | 'expired' | 'failed' | 'closed';
export interface PaymentSession {
  status: PaymentSessionStatus;
  email: string;
  expiresAt: string;
  error?: string;
}
export interface PaymentAdminSession {
  id: string;
  taskId: string;
  employeeId: string;
  employeeName: string;
  email: string;
  status: PaymentSessionStatus;
  viewable: boolean;
  proxyServer?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  error?: string;
}
export interface PaymentControl {
  maxSessions: number | null;
  running: number;
  sessions: PaymentAdminSession[];
}
export type PaymentBrowserInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
  | { type: 'text'; text: string };
export interface DistributionItem {
  id: string;
  sequence: number;
  runId: string;
  employeeId: string;
  profileName: string;
  email: string;
  password?: string;
  mailLine: string;
  checkoutUrl: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  taskId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface DistributionRun {
  id: string;
  projectId: string;
  projectName: string;
  status: 'running' | 'paused' | 'finished';
  generated: number;
  queued: number;
  sent: number;
  failed: number;
  completed: number;
  target: number;
  createdAt: string;
  updatedAt: string;
  allocationStats: Array<{
    employeeId: string;
    quantity: number;
    assigned: number;
    fullName: string;
    sent: number;
    completed: number;
  }>;
  items: DistributionItem[];
}

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
  // wipeData=true: xóa luôn userDataDir trên đĩa (cache/session Chromium — phần
  // ngốn dung lượng), không chỉ metadata. Giải phóng ổ đĩa khi xóa hồ sơ.
  remove: (id: string) => fetch('/api/profiles/' + id + '?wipeData=true', { method: 'DELETE' }),
  removeAll: () => fetch('/api/profiles?wipeData=true', { method: 'DELETE', headers: jsonHeaders }).then((r) => parse<{ removed: number }>(r)),
  open: (id: string) => post(`/api/profiles/${id}/open`).then((r) => parse<any>(r)),
  close: (id: string) => post(`/api/profiles/${id}/close`).then((r) => parse<any>(r)),
  rotateProxy: (id: string) => post(`/api/profiles/${id}/rotate-proxy`).then((r) => parse<any>(r)),
  running: () => fetch('/api/profiles/running').then((r) => parse<{ running: string[] }>(r)),
};

// ---- Settings / Mail ----
export const settingsApi = {
  get: () => fetch('/api/settings').then((r) => parse<Settings>(r)),
  save: (body: Partial<{ dongvanfbApiKey: string; sheetWebhookUrl: string; mktproxyApiKey: string; selltaikhoanApiKey: string; smsbowerApiKey: string; telegramBotToken: string; telegramChatId: string }>) =>
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

// ---- selltaikhoan (nhà cung cấp mail thứ 2) ----
export const sellApi = {
  balance: () => fetch('/api/selltaikhoan/balance').then((r) => parse<{ balance: number }>(r)),
  products: () => fetch('/api/selltaikhoan/products').then((r) => parse<{ products: SellProduct[] }>(r)),
  buy: (body: { productId: string; amount?: number }) => post('/api/selltaikhoan/buy', body).then((r) => parse<any>(r)),
};

// ---- smsbower (thuê gmail nhận OTP theo service, cho flow chatgpt) ----
export const smsbowerApi = {
  rests: (domain = 'gmail.com') =>
    fetch('/api/smsbower/rests?domain=' + encodeURIComponent(domain)).then((r) => parse<{ rests: SmsbowerRest[] }>(r)),
};

// ---- Projects / flows ----
export const projectApi = {
  flows: () => fetch('/api/flows').then((r) => parse<FlowMeta[]>(r)),
  list: () => fetch('/api/projects').then((r) => parse<ProjectRecord[]>(r)),
  create: (body: any) => post('/api/projects', body).then((r) => parse<ProjectRecord>(r)),
  update: (id: string, body: any) => put('/api/projects/' + id, body).then((r) => parse<ProjectRecord>(r)),
  remove: (id: string) => fetch('/api/projects/' + id, { method: 'DELETE' }),
  run: (id: string) => post(`/api/projects/${id}/run`).then((r) => parse<{ results: RunResult[]; distributionRunId?: string }>(r)),
};

// ---- Telegram employee tasks / payroll ----
export const workApi = {
  config: () => fetch('/api/work/config').then((r) => parse<WorkTelegramConfig>(r)),
  saveConfig: (body: {
    botToken?: string;
    chatId?: string;
    paymentPublicUrl?: string;
    paymentTunnelToken?: string;
    clearPaymentTunnelToken?: boolean;
    paymentTunnelDomain?: string;
  }) =>
    put('/api/work/config', body).then((r) => parse<WorkTelegramConfig>(r)),
  enablePolling: () => post('/api/work/config/polling').then((r) => parse<WorkTelegramConfig>(r)),
  configureWebhook: (url: string) => post('/api/work/config/webhook', { url }).then((r) => parse<WorkTelegramConfig>(r)),
  disable: () => post('/api/work/config/off').then((r) => parse<WorkTelegramConfig>(r)),
  tunnel: () => fetch('/api/work/tunnel').then((r) => parse<TunnelStatus>(r)),
  startTunnel: () => post('/api/work/tunnel/start').then((r) => parse<TunnelStatus>(r)),
  stopTunnel: () => post('/api/work/tunnel/stop').then((r) => parse<TunnelStatus>(r)),
  employees: () => fetch('/api/work/employees').then((r) => parse<WorkEmployee[]>(r)),
  createEmployee: (body: { fullName: string; defaultUnitRate: number; salaryVisibility: SalaryVisibility }) =>
    post('/api/work/employees', body).then((r) => parse<WorkEmployee>(r)),
  updateEmployee: (id: string, body: Partial<Pick<WorkEmployee, 'fullName' | 'defaultUnitRate' | 'salaryVisibility' | 'status'>>) =>
    put(`/api/work/employees/${id}`, body).then((r) => parse<WorkEmployee>(r)),
  archiveEmployee: (id: string) => fetch(`/api/work/employees/${id}`, { method: 'DELETE' }).then(noContent),
  regenerateBind: (id: string) => post(`/api/work/employees/${id}/regenerate-bind`).then((r) => parse<WorkEmployee>(r)),
  createTopic: (id: string) => post(`/api/work/employees/${id}/create-topic`).then((r) => parse<WorkEmployee>(r)),
  testTopic: (id: string) => post(`/api/work/employees/${id}/test`).then((r) => parse<{ ok: boolean }>(r)),
  tasks: () => fetch('/api/work/tasks').then((r) => parse<WorkTask[]>(r)),
  createTask: (body: { employeeId: string; description: string; deadline?: string; quantity: number; unitRate?: number }) =>
    post('/api/work/tasks', body).then((r) => parse<WorkTask>(r)),
  updateTask: (id: string, body: Partial<Pick<WorkTask, 'description' | 'deadline' | 'quantity' | 'unitRate'>>) =>
    put(`/api/work/tasks/${id}`, body).then((r) => parse<WorkTask>(r)),
  cancelTask: (id: string) => post(`/api/work/tasks/${id}/cancel`).then((r) => parse<WorkTask>(r)),
  retryTask: (id: string) => post(`/api/work/tasks/${id}/retry`).then((r) => parse<WorkTask>(r)),
  completeTask: (id: string) => post(`/api/work/tasks/${id}/complete`).then((r) => parse<WorkTask>(r)),
  reopenTask: (id: string) => post(`/api/work/tasks/${id}/reopen`).then((r) => parse<WorkTask>(r)),
  payroll: () => fetch('/api/work/payroll').then((r) => parse<PayrollRow[]>(r)),
  distributions: (projectId?: string) => fetch('/api/work/distributions' + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : '')).then((r) => parse<DistributionRun[]>(r)),
  pauseDistribution: (id: string) => post(`/api/work/distributions/${id}/pause`).then((r) => parse<DistributionRun>(r)),
  resumeDistribution: (id: string) => post(`/api/work/distributions/${id}/resume`).then((r) => parse<DistributionRun>(r)),
  clearDistribution: (id: string) => fetch(`/api/work/distributions/${id}`, { method: 'DELETE' }).then(noContent),
  retryDistributionItem: (id: string) => post(`/api/work/distribution-items/${id}/retry`).then((r) => parse<DistributionRun>(r)),
  paymentSession: (token: string) => fetch(`/api/work/payment-sessions/${encodeURIComponent(token)}`).then((r) => parse<PaymentSession>(r)),
  claimPaymentSession: (token: string) => post(`/api/work/payment-sessions/${encodeURIComponent(token)}/claim`).then((r) => parse<PaymentSession>(r)),
  paymentFrameUrl: (token: string) => `/api/work/payment-sessions/${encodeURIComponent(token)}/frame`,
  paymentStreamUrl: (token: string) => `/api/work/payment-sessions/${encodeURIComponent(token)}/stream`,
  sendPaymentInput: (token: string, input: PaymentBrowserInput) =>
    post(`/api/work/payment-sessions/${encodeURIComponent(token)}/input`, input).then(noContent),
  closePaymentSession: (token: string) => fetch(`/api/work/payment-sessions/${encodeURIComponent(token)}`, { method: 'DELETE' }).then(noContent),
  paymentControl: () => fetch('/api/work/payment-control').then((r) => parse<PaymentControl>(r)),
  paymentControlFrameUrl: (id: string) => `/api/work/payment-control/${encodeURIComponent(id)}/frame`,
  paymentControlStreamUrl: (id: string) => `/api/work/payment-control/${encodeURIComponent(id)}/stream`,
  sendPaymentControlInput: (id: string, input: PaymentBrowserInput) =>
    post(`/api/work/payment-control/${encodeURIComponent(id)}/input`, input).then(noContent),
  closePaymentControlSession: (id: string) =>
    fetch(`/api/work/payment-control/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(noContent),
};

export const CODE_TYPES = ['all', 'facebook', 'google', 'instagram', 'tiktok', 'twitter', 'apple', 'amazon', 'lazada', 'shopee', 'telegram', 'wechat'];
