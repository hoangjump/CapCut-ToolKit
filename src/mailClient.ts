import type {
  BuyMailInput,
  GetCodeInput,
  MailCredentials,
} from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('mail');

const API_HOST = 'https://api.dongvanfb.net';
const SMAIL_HOST = 'https://smail1s.com';
const TIMEOUT_MS = 15_000;

/** A single parsed row from /user/buy's list_data. */
export interface BoughtMail {
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
}

export interface BuyResult {
  orderCode?: string;
  price?: number;
  balance?: number;
  mails: BoughtMail[];
}

/** One row from /user/account_type — a purchasable mail product. */
export interface AccountType {
  id: number;
  name: string;
  quality: number;
  price: number;
}

export interface CodeResult {
  status: boolean;
  code: string;
  content: string;
  date: string;
  /** Which endpoint answered — oauth is tried first, graph is the fallback. */
  source: 'oauth' | 'graph';
}

export interface MailMessage {
  uid?: number;
  date?: string;
  from?: Array<{ name?: string; address?: string }>;
  subject?: string;
  code?: string;
  message?: string;
}

/** fetch with an AbortController timeout + JSON parse. Throws Error with a short
 *  Vietnamese message on network/timeout/non-2xx so callers can surface it. */
async function requestJson(
  url: string,
  init: RequestInit,
  what: string,
): Promise<any> {
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
    if (!res.ok) {
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

/** Split one "email|password|refresh_token|client_id" row into a BoughtMail. */
function parseListDataRow(row: string): BoughtMail | null {
  const parts = row.split('|').map((p) => p.trim());
  const [email, password, refreshToken, clientId] = parts;
  if (!email || !refreshToken || !clientId) return null;
  return { email, password: password || undefined, refreshToken, clientId };
}

/** GET /user/balance — returns the account credit for the given API key. */
export async function getBalance(apikey: string): Promise<number> {
  const url = `${API_HOST}/user/balance?apikey=${encodeURIComponent(apikey)}`;
  const body = await requestJson(url, { method: 'GET' }, 'Xem số dư');
  return Number(body?.balance ?? 0);
}

/** GET /user/account_type — lists purchasable mail products (id, name,
 *  quality, price). buy() needs id→account_type and its paired quality. */
export async function getAccountTypes(apikey: string): Promise<AccountType[]> {
  const url = `${API_HOST}/user/account_type?apikey=${encodeURIComponent(apikey)}`;
  const body = await requestJson(url, { method: 'GET' }, 'Danh sách loại mail');
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows.map((r) => ({
    id: Number(r?.id),
    name: String(r?.name ?? ''),
    quality: Number(r?.quality ?? 0),
    price: Number(r?.price ?? 0),
  }));
}

/** GET /user/buy — purchases mail(s). Bills real money. Parses list_data rows. */
export async function buyMail(apikey: string, input: BuyMailInput): Promise<BuyResult> {
  const params = new URLSearchParams({
    apikey,
    account_type: input.accountType,
    quality: input.quality,
    quantity: String(input.count ?? 1),
    type: 'full',
  });
  const url = `${API_HOST}/user/buy?${params.toString()}`;
  const body = await requestJson(url, { method: 'GET' }, 'Mua mail');
  const data = body?.data ?? {};
  // list_data may live under data.* or at the root, depending on the endpoint.
  const rawRows = data.list_data ?? body?.list_data ?? data.mails ?? body?.mails;
  const rows: string[] = Array.isArray(rawRows) ? rawRows : [];
  const mails = rows.map(parseListDataRow).filter((m): m is BoughtMail => m !== null);
  if (mails.length === 0) {
    // Bought but parsed nothing — dump the raw payload so we can see its real shape.
    log.warn(`Mua mail: parse được 0 mail. Raw response: ${JSON.stringify(body)}`);
  }
  return {
    orderCode: data.order_code ?? body?.order_code,
    price: typeof data.price === 'number' ? data.price : undefined,
    balance: typeof data.balance === 'number' ? data.balance : undefined,
    mails,
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Gọi POST /get_messages trên smail1s.com với mode cho trước.
 *  Trả mảng messages của account đầu tiên trong response, hoặc ném Error.
 *  data format: "email|refresh_token|client_id" (client_secret tuỳ chọn nếu có). */
async function fetchSmail1s(
  cred: MailCredentials,
  mode: 'oauth' | 'graph',
): Promise<MailMessage[]> {
  // smail1s chấp nhận format dongvan: email|password|refresh_token|client_id
  // password để trống chuỗi nếu không có (vẫn giữ đúng số trường)
  const parts = [cred.email, cred.password ?? '', cred.refreshToken, cred.clientId];
  const body = await requestJson(
    `${SMAIL_HOST}/get_messages`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode, data: parts.join('|') }),
    },
    `Đọc mail smail1s (${mode})`,
  );
  // Response: { data: [{ email, messages: [], error? }] }
  const entry = Array.isArray(body?.data) ? body.data[0] : null;
  if (!entry) throw new Error(`smail1s (${mode}): không có dữ liệu trả về`);
  if (entry?.error) throw new Error(`smail1s (${mode}): ${entry.error}`);
  return Array.isArray(entry?.messages) ? entry.messages : [];
}

/** Đọc inbox qua smail1s. Thử oauth trước, nếu lỗi fallback sang graph. */
export async function getMessages(cred: MailCredentials): Promise<MailMessage[]> {
  try {
    return await fetchSmail1s(cred, 'oauth');
  } catch (err) {
    log.info(`smail1s oauth lỗi (${(err as Error).message}), thử graph`);
  }
  return fetchSmail1s(cred, 'graph');
}

/** Lấy OTP/code xác nhận qua smail1s. Thử oauth trước, fallback graph.
 *  smail1s đã extract sẵn field `code` trong mỗi message — lấy message
 *  mới nhất có code. `type` giữ để tương thích interface nhưng không filter
 *  phía server (smail1s trả tất cả mail, dùng pollOtpByRegex để filter cụ thể). */
export async function getCode(input: GetCodeInput): Promise<CodeResult> {
  let messages: MailMessage[] = [];
  let source: 'oauth' | 'graph' = 'oauth';
  try {
    messages = await fetchSmail1s(input, 'oauth');
    source = 'oauth';
  } catch (err) {
    log.info(`smail1s oauth lỗi (${(err as Error).message}), thử graph`);
    messages = await fetchSmail1s(input, 'graph');
    source = 'graph';
  }
  // Lấy message đầu tiên (mới nhất) đã có code extract sẵn
  const hit = messages.find((m) => m.code && m.code.trim());
  if (hit) {
    return {
      status: true,
      code: String(hit.code),
      content: String(hit.message ?? hit.subject ?? ''),
      date: String(hit.date ?? ''),
      source,
    };
  }
  return { status: false, code: '', content: '', date: '', source };
}
