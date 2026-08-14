import { createLogger } from './logger.js';

const log = createLogger('mktproxy');

const BASE = 'https://api.mktproxy.com/api';
const TIMEOUT_MS = 20_000;

// ============================================================================
// HAI LOẠI KEY — KHÁC NHAU, ĐỪNG NHẦM:
//
//  1) KEY SERVER (tài khoản), dạng "mkt_..." — gửi qua header X-API-Key.
//     Dùng cho: GET /balance, POST /buy-proxy, GET /orders, và
//     POST /update-ip-whitelist (header). Lấy ở mktproxy.com → Profile.
//
//  2) KEY PROXY (theo đơn), dạng hex 24 ký tự "6a4a..." — gửi qua query/body `key`,
//     KHÔNG cần header. Dùng cho: GET /proxies/new, GET /proxies/current,
//     POST /proxies/rotate-ip, và là `key` trong BODY của /update-ip-whitelist.
//     Mỗi đơn proxy xoay có key riêng; đây chính là "proxy" để gen IP.
//
// FLOW proxy xoay auth_type=ip_whitelist (đã xác minh bằng gọi API thật):
//   a) whitelist IP máy: POST /update-ip-whitelist
//        header X-API-Key = KEY SERVER ; body { key: KEY PROXY, ip_whitelist:[ip] }
//   b) KÍCH HOẠT egress: POST /proxies/rotate-ip { key: KEY PROXY }
//        (proxies/new chỉ đọc cache → đơn chưa live sẽ connect bị ECONNRESET)
//   c) connect gateway host:port (protocol theo field `protocol`, thường HTTP,
//        KHÔNG có user/pass) TỪ IP đã whitelist.
// ============================================================================

/** One purchasable product from GET /products. Kept loose — the API returns many
 *  extra fields; we type the ones the UI/buy flow actually reads. */
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
  /** [{ days, price(VNĐ) }] — key in the API is the number of days. */
  priceByDuration: Array<{ days: number; price: number }>;
  /** Per-product extra inputs (e.g. isp_code, location). Passed back in buy's
   *  custom_fields. Kept as raw objects so the UI can render selects. */
  customFields: Array<Record<string, unknown>>;
}

export interface MktBuyInput {
  productCode: string;
  quantity?: number;
  duration?: number;
  protocol?: 'http' | 'socks5';
  customFields?: Record<string, unknown>;
  /** Idempotency ref so a retried buy doesn't create a duplicate order. */
  externalRef?: string;
  ipWhitelist?: string[];
}

/** A delivered proxy line from an order (GET /orders/{code}.proxies[]). */
export interface MktProxyItem {
  /** Per-proxy internal key (for rotate/whitelist). API calls it api_key or key. */
  key?: string;
  /** "host:port:user:pass" (or "host:port"). */
  proxy: string;
  expiredAt?: string;
  status?: string;
}

export interface MktBuyResult {
  orderCode?: string;
  proxies: MktProxyItem[];
  raw: any;
}

export interface MktOrderDetail {
  orderCode: string;
  /** String status from /orders/{code}: pending|processing|in_use|expired|failed. */
  status: string;
  quantity?: number;
  deliveredQuantity?: number;
  proxies: MktProxyItem[];
  raw: any;
}

export interface MktOrderSummary {
  orderCode: string;
  status: string | number;
  quantity?: number;
  totalAmount?: number;
  createdAt?: string;
}

/** Current/rotated proxy from /proxies/new|current|rotate-ip. */
export interface MktRotatingProxy {
  value: string;
  protocol?: string;
  ip?: string;
  port?: string;
  user?: string;
  pass?: string;
  http?: string;
  socks5?: string;
  realIp?: string;
  rotatedAt?: string;
  /** Seconds until the next rotation is allowed (cooldown / auto cadence). */
  second?: number;
  /** Khu vực NCC báo (tên nhiều field khả dĩ). */
  region?: string;
  /** Mốc ISO hết hạn nếu NCC báo (expired_at / expire_time). */
  expiredAt?: string;
}

/** fetch + timeout + JSON parse. Adds X-API-Key when `apiKey` is given. Throws an
 *  Error with a short Vietnamese message on network/timeout/non-2xx so callers
 *  can surface it (mirrors mailClient.requestJson). */
async function requestJson(
  path: string,
  init: RequestInit,
  what: string,
  apiKey?: string,
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, signal: ctrl.signal });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${what}: phản hồi không phải JSON (HTTP ${res.status})`);
    }
    if (!res.ok || body?.success === false) {
      const msg = body?.message || `HTTP ${res.status}`;
      throw new Error(`${what}: ${msg}`);
    }
    return body;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`${what}: quá thời gian chờ (${TIMEOUT_MS / 1000}s)`);
    }
    throw err instanceof Error ? err : new Error(`${what}: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Pull "host:port:user:pass" out of a proxy item regardless of exact shape. */
function pickProxyString(o: any): string | null {
  if (!o) return null;
  if (typeof o === 'string') return o;
  const s = o.proxy ?? o.value ?? o.http ?? o.socks5;
  return typeof s === 'string' && s ? s : null;
}

/** Normalize an array of order proxy items from various field names. GIỮ item
 *  chỉ có key (proxy xoay chưa kèm chuỗy) — server sẽ gọi rotate-ip/proxies-new
 *  bằng key đó để lấy proxy. Chỉ bỏ item rỗng hoàn toàn (không proxy, không key). */
function parseProxyItems(raw: any): MktProxyItem[] {
  const arr: any[] = Array.isArray(raw) ? raw : [];
  const items: MktProxyItem[] = [];
  for (const it of arr) {
    const proxy = pickProxyString(it);
    const key = it?.api_key ?? it?.key ?? undefined;
    if (!proxy && !key) continue;
    items.push({
      key,
      proxy: proxy ?? '',
      expiredAt: it?.expired_at ?? undefined,
      status: it?.status ?? undefined,
    });
  }
  return items;
}

/** GET /products — public list of purchasable products with pricing. */
export async function listProducts(apiKey?: string): Promise<MktProduct[]> {
  const body = await requestJson('/products', { method: 'GET' }, 'Danh sách sản phẩm', apiKey);
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: Number(r?.id),
    code: String(r?.code ?? ''),
    name: String(r?.name ?? ''),
    country: r?.country ? String(r.country) : undefined,
    proxyType: r?.proxy_type ? String(r.proxy_type) : undefined,
    protocols: Array.isArray(r?.protocols) ? r.protocols.map(String) : [],
    authType: r?.auth_type ? String(r.auth_type) : undefined,
    minQuantity: Number(r?.min_quantity ?? 1),
    maxQuantity: Number(r?.max_quantity ?? 100),
    note: r?.note ? String(r.note) : undefined,
    tag: r?.tag ? String(r.tag) : undefined,
    priceByDuration: (Array.isArray(r?.price_by_duration) ? r.price_by_duration : [])
      .map((p: any) => ({ days: Number(p?.key), price: Number(p?.value) }))
      .filter((p: { days: number; price: number }) => Number.isFinite(p.days)),
    customFields: Array.isArray(r?.custom_fields) ? r.custom_fields : [],
  }));
}

/** GET /balance — account credit (VNĐ). Requires the API key. */
export async function getBalance(apiKey: string): Promise<number> {
  const body = await requestJson('/balance', { method: 'GET' }, 'Xem số dư mktproxy', apiKey);
  return Number(body?.data?.balance ?? 0);
}

/** POST /buy-proxy — creates an order (bills real money). Returns the order_code
 *  plus any proxies already delivered in the buy response (some products deliver
 *  immediately; others need polling GET /orders/{code}). */
export async function buyProxy(apiKey: string, input: MktBuyInput): Promise<MktBuyResult> {
  const payload: Record<string, unknown> = { product_code: input.productCode };
  if (input.quantity !== undefined) payload.quantity = input.quantity;
  if (input.duration !== undefined) payload.duration = input.duration;
  if (input.protocol) payload.protocol = input.protocol;
  if (input.customFields && Object.keys(input.customFields).length) payload.custom_fields = input.customFields;
  if (input.externalRef) payload.external_ref = input.externalRef;
  if (input.ipWhitelist?.length) payload.ip_whitelist = input.ipWhitelist;

  const body = await requestJson(
    '/buy-proxy',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) },
    'Mua proxy',
    apiKey,
  );
  const data = body?.data ?? {};
  const orderCode = data.order_code ?? data.code ?? data.order?.order_code ?? body?.order_code;
  // Delivered proxies may arrive under data.proxies or data.items.
  const proxies = parseProxyItems(data.proxies ?? data.items);
  if (!orderCode && proxies.length === 0) {
    log.warn(`Mua proxy: không thấy order_code lẫn proxy. Raw: ${JSON.stringify(body)}`);
  }
  return { orderCode: orderCode ? String(orderCode) : undefined, proxies, raw: body };
}

/** GET /orders/{order_code} — order detail; includes proxies[] when in_use. */
export async function getOrder(apiKey: string, orderCode: string): Promise<MktOrderDetail> {
  const body = await requestJson(
    `/orders/${encodeURIComponent(orderCode)}`,
    { method: 'GET' },
    'Chi tiết đơn hàng',
    apiKey,
  );
  const data = body?.data ?? {};
  return {
    orderCode: String(data.order_code ?? orderCode),
    status: String(data.status ?? ''),
    quantity: data.quantity !== undefined ? Number(data.quantity) : undefined,
    deliveredQuantity: data.delivered_quantity !== undefined ? Number(data.delivered_quantity) : undefined,
    proxies: parseProxyItems(data.proxies),
    raw: body,
  };
}

/** GET /orders — paginated order list. */
export async function listOrders(
  apiKey: string,
  opts: { status?: string; page?: number; perPage?: number } = {},
): Promise<MktOrderSummary[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('per_page', String(opts.perPage));
  const qs = params.toString();
  const body = await requestJson(`/orders${qs ? `?${qs}` : ''}`, { method: 'GET' }, 'Danh sách đơn hàng', apiKey);
  const rows: any[] = Array.isArray(body?.data?.data) ? body.data.data : Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    orderCode: String(r?.order_code ?? ''),
    status: r?.status,
    quantity: r?.quantity !== undefined ? Number(r.quantity) : undefined,
    totalAmount: r?.total_amount !== undefined ? Number(r.total_amount) : undefined,
    createdAt: r?.created_at ? String(r.created_at) : undefined,
  }));
}

/** Parse the rotating-proxy payload shared by /proxies/new|current|rotate-ip. */
function parseRotating(body: any): MktRotatingProxy {
  const d = body?.data ?? {};
  return {
    value: String(d.value ?? d.http ?? d.socks5 ?? ''),
    protocol: d.protocol ? String(d.protocol) : undefined,
    ip: d.ip ? String(d.ip) : undefined,
    port: d.port ? String(d.port) : undefined,
    user: d.user ? String(d.user) : undefined,
    pass: d.pass ? String(d.pass) : undefined,
    http: d.http ? String(d.http) : undefined,
    socks5: d.socks5 ? String(d.socks5) : undefined,
    realIp: d.real_ip ? String(d.real_ip) : undefined,
    rotatedAt: d.rotated_at ? String(d.rotated_at) : undefined,
    second: body?.second !== undefined ? Number(body.second)
      : d.second !== undefined ? Number(d.second)
      : d.next_rotation !== undefined ? Number(d.next_rotation) : undefined,
    // Khu vực + hết hạn: NCC dùng tên field khác nhau tuỳ endpoint — thử vài tên.
    region: firstStr(d.location, d.region, d.geo, d.province, d.city),
    expiredAt: firstStr(d.expired_at, d.expire_time, d.expiredAt, d.expire_at),
  };
}

/** Chuỗi không rỗng đầu tiên trong các ứng viên (bỏ qua undefined/null/rỗng). */
function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

/** GET /proxies/new?key= — current rotating proxy (read-only, from cache).
 *  `orderKey` is the per-order rotating key (NOT the account API key). */
export async function getCurrentProxy(orderKey: string): Promise<MktRotatingProxy> {
  const body = await requestJson(
    `/proxies/new?key=${encodeURIComponent(orderKey)}`,
    { method: 'GET' },
    'Lấy proxy xoay',
  );
  return parseRotating(body);
}

/** POST /proxies/rotate-ip — force a new IP now (has a per-product cooldown;
 *  within cooldown returns the current proxy + remaining seconds). */
export async function rotateIp(orderKey: string): Promise<MktRotatingProxy> {
  const body = await requestJson(
    '/proxies/rotate-ip',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ key: orderKey }) },
    'Xoay IP proxy',
  );
  return parseRotating(body);
}

/** POST /update-ip-whitelist — set allowed IPs for an ip_whitelist proxy item.
 *  CẦN header X-API-Key = key TÀI KHOẢN (`accountKey`), còn `itemKey` (key đơn
 *  proxy) đi trong body. Hai key này KHÁC nhau. */
export async function updateIpWhitelist(accountKey: string, itemKey: string, ips: string[]): Promise<string[]> {
  const body = await requestJson(
    '/update-ip-whitelist',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ key: itemKey, ip_whitelist: ips }) },
    'Cập nhật IP whitelist',
    accountKey,
  );
  const list = body?.data?.ip_whitelist;
  return Array.isArray(list) ? list.map(String) : ips;
}
