import { createLogger } from './logger.js';

const log = createLogger('selltaikhoan');

const BASE = 'https://www.selltaikhoan.com/api';
const TIMEOUT_MS = 20_000;

/** Một sản phẩm phẳng hoá từ products.php (categories[].products[]). */
export interface SelltaikhoanProduct {
  id: string;
  name: string;
  price: number;
  /** Tồn kho (amount); null nếu API không trả. */
  amount: number | null;
  category: string;
}

/** Một mail mua được — dòng "email|password|refresh_token|client_id". */
export interface SelltaikhoanMail {
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
}

export interface SelltaikhoanBuyResult {
  transId?: string;
  mails: SelltaikhoanMail[];
  raw: any;
}

/** fetch + timeout + parse JSON. Ném Error với message ngắn tiếng Việt khi
 *  network/timeout/non-2xx/status!=success (mirror mailClient/mktproxyClient). */
async function requestJson(url: string, init: RequestInit, what: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${what}: phản hồi không phải JSON (HTTP ${res.status})`);
    }
    if (!res.ok || (body?.status && body.status !== 'success')) {
      throw new Error(`${what}: ${body?.msg || `HTTP ${res.status}`}`);
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

/** Tách 1 dòng "email|password|refresh_token|client_id". Bỏ dòng thiếu email/
 *  refresh/client. password có thể trống. */
function parseMailRow(row: string): SelltaikhoanMail | null {
  const [email, password, refreshToken, clientId] = row.split('|').map((p) => p.trim());
  if (!email || !refreshToken || !clientId) return null;
  return { email, password: password || undefined, refreshToken, clientId };
}

/** GET profile.php — trả số dư tài khoản (data.money). */
export async function getBalance(apiKey: string): Promise<number> {
  const url = `${BASE}/profile.php?api_key=${encodeURIComponent(apiKey)}`;
  const body = await requestJson(url, { method: 'GET' }, 'Xem số dư selltaikhoan');
  return Number(body?.data?.money ?? 0);
}

/** GET products.php — phẳng hoá categories[].products[] thành danh sách sản phẩm.
 *  Bỏ danh mục rỗng; giữ tên danh mục để UI lọc (vd "HOTMAIL - OUTLOOK"). */
export async function listProducts(apiKey: string): Promise<SelltaikhoanProduct[]> {
  const body = await requestJson(
    `${BASE}/products.php?api_key=${encodeURIComponent(apiKey)}`,
    { method: 'GET' },
    'Danh sách sản phẩm selltaikhoan',
  );
  const cats: any[] = Array.isArray(body?.categories) ? body.categories : [];
  const out: SelltaikhoanProduct[] = [];
  const walk = (cat: any) => {
    const catName = String(cat?.name ?? '');
    for (const p of cat?.products ?? []) {
      out.push({
        id: String(p?.id ?? ''),
        name: String(p?.name ?? ''),
        price: Number(p?.price ?? 0),
        amount: p?.amount != null ? Number(p.amount) : null,
        category: catName,
      });
    }
    for (const sub of cat?.children ?? []) walk(sub);
  };
  cats.forEach(walk);
  return out;
}

/** POST buy_product — mua `amount` sản phẩm `productId`. Bills real money.
 *  Trả data[] các dòng mail đã parse. */
export async function buyProduct(
  apiKey: string,
  productId: string,
  amount = 1,
  coupon?: string,
): Promise<SelltaikhoanBuyResult> {
  const form = new URLSearchParams({
    action: 'buyProduct',
    id: productId,
    amount: String(amount),
    api_key: apiKey,
  });
  if (coupon) form.set('coupon', coupon);
  const body = await requestJson(
    `${BASE}/buy_product`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
    'Mua mail selltaikhoan',
  );
  const rows: string[] = Array.isArray(body?.data) ? body.data : [];
  const mails = rows.map(parseMailRow).filter((m): m is SelltaikhoanMail => m !== null);
  if (mails.length === 0) {
    log.warn(`Mua mail: parse được 0 dòng. Raw: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { transId: body?.trans_id, mails, raw: body };
}
