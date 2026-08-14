import { createLogger } from './logger.js';

const log = createLogger('graph-mail');

// Endpoint cho tài khoản Microsoft CÁ NHÂN (outlook.com/hotmail). Tài khoản
// công việc/trường học (Azure AD) dùng tenant riêng — không phủ ở đây.
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';
const TIMEOUT_MS = 20_000;

// Chỉ đọc — KHÔNG BAO GIỜ log access token, refresh token hay body mail.

export interface GraphCredentials {
  email: string;
  refreshToken: string;
  clientId: string;
}

export interface GraphMessage {
  id: string;
  subject: string;
  receivedDateTime: string;
  from: string;
  toRecipients: string[];
  ccRecipients: string[];
  bodyPreview: string;
  /** Chỉ có khi đã tải body lẻ (fetchBody). */
  body?: string;
}

/** OTP 4–8 chữ số, tránh dính số điện thoại/năm dài hơn. */
const OTP_RE = /(?<![.\d])(\d{4,8})(?![.\d])/;

function normalizeAddr(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function recipientsOf(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .map((r: any) => normalizeAddr(r?.emailAddress?.address))
    .filter(Boolean);
}

async function graphFetch(url: string, accessToken: string, what: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
      signal: ctrl.signal,
    });
    // 429: Graph bảo chờ. Ném kèm retryAfter để lớp poll nghỉ đúng khoảng.
    if (res.status === 429) {
      const retry = Number(res.headers.get('Retry-After')) || 30;
      const err = new Error(`${what}: rate limit (429)`);
      (err as any).retryAfterMs = retry * 1_000;
      throw err;
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${body?.error?.message || ''}`.trim());
    return body;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`${what}: quá thời gian chờ`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Access token sống ~60 phút — cache theo refresh token để không đổi mỗi lần
 *  poll (trước đây mỗi lần scan là một round-trip login thừa). */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function accessTokenFor(cred: GraphCredentials): Promise<string> {
  const cached = tokenCache.get(cred.refreshToken);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cred.clientId,
        grant_type: 'refresh_token',
        refresh_token: cred.refreshToken,
        scope: SCOPE,
      }),
      signal: ctrl.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // KHÔNG log token; chỉ mã lỗi ngắn của Microsoft.
      throw new Error(`Lấy access token lỗi: ${data.error || `HTTP ${res.status}`}`);
    }
    const token = String(data.access_token);
    tokenCache.set(cred.refreshToken, { token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1_000 });
    return token;
  } finally {
    clearTimeout(timer);
  }
}

/** Danh sách mail NHẸ (không tải body) trong một folder, chỉ mail mới hơn `since`.
 *  Alias dùng CHUNG mailbox chính — không phải hộp thư riêng — nên lọc theo
 *  recipient ở client, không dùng $filter/$search recipient (Graph không đảm bảo
 *  hỗ trợ ổn định trên collection messages). $filter theo THỜI GIAN thì được. */
async function listFolder(
  accessToken: string,
  folder: 'inbox' | 'junkemail',
  sinceIso: string,
  top: number,
): Promise<GraphMessage[]> {
  const url = new URL(`${GRAPH}/me/mailFolders/${folder}/messages`);
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$filter', `receivedDateTime ge ${sinceIso}`);
  url.searchParams.set('$select', 'id,subject,receivedDateTime,from,toRecipients,ccRecipients,bodyPreview');
  const body = await graphFetch(url.toString(), accessToken, `Đọc ${folder}`);
  return (Array.isArray(body?.value) ? body.value : []).map((m: any): GraphMessage => ({
    id: String(m.id || ''),
    subject: String(m.subject || ''),
    receivedDateTime: String(m.receivedDateTime || ''),
    from: normalizeAddr(m.from?.emailAddress?.address),
    toRecipients: recipientsOf(m.toRecipients),
    ccRecipients: recipientsOf(m.ccRecipients),
    bodyPreview: String(m.bodyPreview || ''),
  }));
}

/** Tải body của ĐÚNG MỘT mail — chỉ khi bodyPreview không đủ để bắt OTP. */
async function fetchBody(accessToken: string, id: string): Promise<string> {
  const url = `${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=body`;
  const body = await graphFetch(url, accessToken, 'Tải body mail');
  return String(body?.body?.content || '');
}

export interface FetchAliasOptions {
  /** Chỉ nhận mail gửi tới địa chỉ này (alias hoặc chính main). Bỏ trống = mọi mail. */
  alias?: string;
  /** Chỉ xét mail trong bao nhiêu phút gần đây. Mặc định 10. */
  windowMinutes?: number;
  /** Bỏ qua các message id đã đọc lần trước (chống đọc lại). */
  seenIds?: Set<string>;
  /** Regex OTP tuỳ biến. */
  codePattern?: RegExp;
  /** Quét cả Junk (mail xác minh hay rơi vào đây). Mặc định true. */
  includeJunk?: boolean;
}

export interface AliasOtpResult {
  code: string;
  message: GraphMessage;
}

/**
 * Tìm OTP mới nhất gửi tới `alias`, quét Inbox + Junk, ưu tiên mail mới nhất.
 *
 * Trình tự tối ưu (xem docs): query nhẹ không body + lọc thời gian → lọc alias
 * ở client trên toRecipients/ccRecipients → OTP thường nằm sẵn trong bodyPreview
 * (0 request thêm) → chỉ khi thiếu mới tải body ĐÚNG mail đó.
 *
 * Trả về OTP đầu tiên tìm thấy (mail mới nhất trước), hoặc null nếu chưa có.
 * KHÔNG tự lặp/chờ — lớp poll bên ngoài lo nhịp.
 */
export async function findAliasOtp(
  cred: GraphCredentials,
  opts: FetchAliasOptions = {},
): Promise<AliasOtpResult | null> {
  const alias = opts.alias ? normalizeAddr(opts.alias) : '';
  const windowMinutes = opts.windowMinutes ?? 10;
  const pattern = opts.codePattern ?? OTP_RE;
  const seen = opts.seenIds;
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

  const accessToken = await accessTokenFor(cred);
  const folders: Array<'inbox' | 'junkemail'> = opts.includeJunk === false ? ['inbox'] : ['inbox', 'junkemail'];

  // Gộp mail hai folder, sắp mới nhất trước.
  const all: GraphMessage[] = [];
  for (const folder of folders) {
    all.push(...await listFolder(accessToken, folder, sinceIso, 15));
  }
  all.sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));

  for (const msg of all) {
    if (seen?.has(msg.id)) continue;
    // Alias và main dùng CHUNG mailbox — phân biệt bằng recipient của từng mail.
    if (alias) {
      const to = [...msg.toRecipients, ...msg.ccRecipients];
      if (!to.includes(alias)) continue;
    }
    // Thử bắt OTP trong preview trước (đa số mail xác minh có sẵn).
    const preview = `${msg.subject}\n${msg.bodyPreview}`;
    let m = pattern.exec(preview);
    if (!m) {
      // Preview không đủ (bị nhồi ký tự / OTP nằm sâu trong body) → tải body lẻ.
      try {
        const body = await fetchBody(accessToken, msg.id);
        msg.body = body;
        m = pattern.exec(`${preview}\n${stripHtml(body)}`);
      } catch (err) {
        log.warn(`tải body mail lỗi: ${(err as Error).message}`);
      }
    }
    seen?.add(msg.id);
    if (m) return { code: m[1] ?? m[0], message: msg };
  }
  return null;
}

/** Bỏ thẻ HTML + địa chỉ email (tránh bắt nhầm số trong email) trước khi dò OTP. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ');
}
