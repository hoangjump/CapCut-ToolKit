import type {
  BuyMailInput,
  GetCodeInput,
  MailCredentials,
} from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('mail');

const API_HOST = 'https://api.dongvanfb.net';
const TOOLS_HOST = 'https://tools.dongvanfb.net';
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
  /** Which endpoint answered — oauth2 is tried first, graph is the fallback. */
  source: 'oauth2' | 'graph';
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

function credBody(c: MailCredentials, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: c.email,
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    ...extra,
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Fetch an OTP/confirmation code. Tries get_code_oauth2 first; on failure or a
 *  falsey status, falls back to graph_code. Neither needs the API key. */
export async function getCode(input: GetCodeInput): Promise<CodeResult> {
  const payload = credBody(input, { type: input.type });
  try {
    const body = await requestJson(
      `${TOOLS_HOST}/api/get_code_oauth2`,
      { method: 'POST', headers: JSON_HEADERS, body: payload },
      'Lấy code (OAuth2)',
    );
    if (body?.status && body?.code) {
      return {
        status: true,
        code: String(body.code),
        content: String(body.content ?? ''),
        date: String(body.date ?? ''),
        source: 'oauth2',
      };
    }
    log.info(`oauth2 code rỗng cho ${input.email}, thử graph`);
  } catch (err) {
    log.info(`oauth2 lỗi (${(err as Error).message}), thử graph`);
  }

  const body = await requestJson(
    `${TOOLS_HOST}/api/graph_code`,
    { method: 'POST', headers: JSON_HEADERS, body: payload },
    'Lấy code (Graph)',
  );
  return {
    status: Boolean(body?.status),
    code: String(body?.code ?? ''),
    content: String(body?.content ?? ''),
    date: String(body?.date ?? ''),
    source: 'graph',
  };
}

/** POST /api/get_messages_oauth2 — the mailbox inbox (list of messages). */
export async function getMessages(cred: MailCredentials): Promise<MailMessage[]> {
  const body = await requestJson(
    `${TOOLS_HOST}/api/get_messages_oauth2`,
    { method: 'POST', headers: JSON_HEADERS, body: credBody(cred, { list_mail: 'all' }) },
    'Xem hộp thư',
  );
  return Array.isArray(body?.messages) ? body.messages : [];
}
