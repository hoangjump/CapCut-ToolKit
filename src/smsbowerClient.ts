import { createLogger } from './logger.js';

const log = createLogger('smsbower');

const BASE = 'https://smsbower.online/api';
const TIMEOUT_MS = 20_000;

/**
 * SmsBower "mail" API — thuê 1 địa chỉ (mặc định gmail.com) để NHẬN code xác minh
 * của một service (vd đăng ký ChatGPT). Khác hẳn dongvanfb/selltaikhoan: KHÔNG
 * mua hộp thư có sẵn (không refresh_token/client_id), mà "kích hoạt" một mail
 * dùng-một-lần rồi poll lấy code trong ~3 phút.
 *
 * Vòng đời: getActivation (thuê → mail + mailId) → getCode (poll tới khi có code)
 * → setStatus(3) chốt thành công (trừ tiền) HOẶC setStatus(2) huỷ (hoàn tiền nếu
 * chưa có code). Mã `service` lấy từ smsbower.com/api (vd đăng ký service X).
 */

/** Một dòng tồn kho phẳng hoá từ getPriceRests (service→domain→{price,count}). */
export interface SmsbowerRest {
  service: string;
  domain: string;
  price: number;
  count: number;
}

/** Kết quả thuê một mail: địa chỉ + id kích hoạt để poll code / set status. */
export interface SmsbowerActivation {
  mail: string;
  mailId: string;
}

/** fetch + timeout + parse JSON. Ném Error message ngắn tiếng Việt khi network/
 *  timeout/non-2xx. KHÔNG tự ném khi body.status===0 — nhiều luồng (poll code,
 *  "no mails") coi status 0 là trạng thái hợp lệ nên caller tự xử lý. */
async function requestJson(url: string, what: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${what}: phản hồi không phải JSON (HTTP ${res.status})`);
    }
    if (!res.ok && !body?.error && body?.status === undefined) {
      throw new Error(`${what}: HTTP ${res.status}`);
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

const q = (v: string) => encodeURIComponent(v);

/** GET getPriceRests — giá + số lượng mail còn cho `domain`, phẳng hoá thành
 *  danh sách [{service, domain, price, count}] để UI chọn đúng mã service. */
export async function getPriceRests(apiKey: string, domain = 'gmail.com'): Promise<SmsbowerRest[]> {
  const body = await requestJson(
    `${BASE}/mail/getPriceRests?api_key=${q(apiKey)}&domain=${q(domain)}`,
    'Xem tồn kho SmsBower',
  );
  if (body?.status === 0) throw new Error(`Xem tồn kho SmsBower: ${body?.error || 'lỗi không rõ'}`);
  const data = body?.data ?? {};
  const out: SmsbowerRest[] = [];
  for (const [service, byDomain] of Object.entries<any>(data)) {
    for (const [dom, info] of Object.entries<any>(byDomain ?? {})) {
      out.push({
        service,
        domain: dom,
        price: Number(info?.price ?? 0),
        count: Number(info?.count ?? 0),
      });
    }
  }
  return out;
}

/** GET getActivation — thuê một mail cho `service`. Trả {mail, mailId}. Ném khi
 *  status 0 (hết mail / hết tiền / giá vượt maxPrice…). Bills real money khi
 *  code về (chốt bằng setStatus). */
export async function getActivation(
  apiKey: string,
  opts: { service: string; domain?: string; maxPrice?: number; ref?: string },
): Promise<SmsbowerActivation> {
  const domain = opts.domain ?? 'gmail.com';
  const params = new URLSearchParams({ service: opts.service, api_key: apiKey, domain });
  if (opts.maxPrice != null) params.set('maxPrice', String(opts.maxPrice));
  if (opts.ref) params.set('ref', opts.ref);
  const body = await requestJson(`${BASE}/mail/getActivation?${params.toString()}`, 'Thuê mail SmsBower');
  if (body?.status !== 1 || !body?.mail) {
    const extra = body?.data?.actual_available_price ? ` (giá khả dụng: ${body.data.actual_available_price})` : '';
    // "Pass service code" / lỗi liên quan service = mã service sai/không hỗ trợ.
    const hint = /service/i.test(String(body?.error ?? ''))
      ? ' — mã service sai/không hỗ trợ. Xem tab Mail → "Xem tồn kho gmail" để lấy mã hợp lệ (ChatGPT thường là "dr").'
      : '';
    throw new Error(`Thuê mail SmsBower: ${body?.error || 'không nhận được mail'}${extra}${hint}`);
  }
  return { mail: String(body.mail), mailId: String(body.mailId) };
}

/** GET getCode — đọc code cho `mailId`. Trả code (string) nếu đã về; null nếu
 *  "chưa nhận được" (để poll tiếp). Ném khi lỗi cứng (sai id / đã huỷ). */
export async function getCode(apiKey: string, mailId: string): Promise<string | null> {
  const body = await requestJson(
    `${BASE}/mail/getCode?mailId=${q(mailId)}&api_key=${q(apiKey)}`,
    'Lấy code SmsBower',
  );
  if (body?.status === 1 && body?.code) return String(body.code);
  const err = String(body?.error ?? '').toLowerCase();
  // "chưa nhận được, thử lại sau" → chưa có, poll tiếp (không phải lỗi).
  if (err.includes('not been received') || err.includes('not received') || err.includes('try again')) {
    return null;
  }
  // Lỗi cứng: sai mailId, activation đã huỷ… → ném để dừng poll.
  throw new Error(`Lấy code SmsBower: ${body?.error || 'lỗi không rõ'}`);
}

/** Poll getCode tới khi có code hoặc hết lượt. SmsBower cam kết code về trong
 *  ~3 phút nên mặc định poll ~40 lần × 5s ≈ 200s. */
export async function pollCode(
  apiKey: string,
  mailId: string,
  opts: { tries?: number; intervalMs?: number; exclude?: string } = {},
): Promise<string> {
  const tries = opts.tries ?? 40;
  const intervalMs = opts.intervalMs ?? 5_000;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const code = await getCode(apiKey, mailId);
    // `exclude`: bỏ qua mã cũ để lấy MÃ MỚI khi retry (OpenAI báo "Incorrect code"
    // ở mã đầu — mã thật về trễ hơn hoặc là mã kế sau setStatus(5)).
    if (code && code !== opts.exclude) return code;
    if (attempt < tries) await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(
    `Không nhận được code SmsBower cho mailId=${mailId} sau ${tries} lần đọc${opts.exclude ? ` (cần mã khác "${opts.exclude}")` : ''}`,
  );
}

/** GET setStatus — đặt trạng thái activation. status: 3 = chốt thành công (trừ
 *  tiền), 2 = huỷ (hoàn tiền nếu chưa có code), 5 = chờ code kế. Best-effort:
 *  chỉ log cảnh báo nếu lỗi, không ném (đừng để việc chốt/huỷ làm hỏng flow). */
export async function setStatus(apiKey: string, id: string, status: 2 | 3 | 5): Promise<void> {
  try {
    const body = await requestJson(
      `${BASE}/mail/setStatus?id=${q(id)}&status=${status}&api_key=${q(apiKey)}`,
      'Đặt trạng thái SmsBower',
    );
    if (body?.status !== 1) log.warn(`setStatus(${id}, ${status}) không thành công: ${body?.error || 'lỗi không rõ'}`);
  } catch (err) {
    log.warn(`setStatus(${id}, ${status}) lỗi: ${(err as Error).message}`);
  }
}

// ---- Batch API (mail đọc nhiều mã qua getCodeBySignature) ------------------
// Khác thuê lẻ (getActivation chỉ 1 mã/lần rồi khoá): batch cho mỗi mail 1 link
// getCodeBySignature đọc-lại-được, trả all_codes = TẤT CẢ mã đã nhận. Hợp cho
// OpenAI gửi 2-3 mã → chọn mã mới nhất, khỏi request lại. count=1 hợp lệ.

/** Một mail trong batch: địa chỉ + link đọc mã (getCodeBySignature). */
export interface SmsbowerBatchMail {
  mail: string;
  url: string;
}

/** Bảo đảm URL có scheme — link SmsBower trả về dạng "smsbower.page/api/...". */
function withScheme(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** GET getBatch — mua `count` mail (mỗi mail 1 link đọc mã đọc-lại-được). count=1
 *  hợp lệ (rẻ, vd dr gmail 0.01/mail). Bills real money. Trả {batchId, mails}. */
export async function getBatch(
  apiKey: string,
  opts: { service: string; domain?: string; count?: number; time?: number },
): Promise<{ batchId: string; mails: SmsbowerBatchMail[] }> {
  const params = new URLSearchParams({
    api_key: apiKey,
    service: opts.service,
    domain: opts.domain ?? 'gmail.com',
    count: String(opts.count ?? 1),
    time: String(opts.time ?? 12),
  });
  const body = await requestJson(`${BASE}/mail/getBatch?${params.toString()}`, 'Mua batch mail SmsBower');
  if (body?.status !== 1 || !Array.isArray(body?.mails) || body.mails.length === 0) {
    const hint = /service/i.test(String(body?.error ?? ''))
      ? ' — mã service sai/không hỗ trợ (xem tab Mail → "Xem tồn kho gmail").'
      : '';
    throw new Error(`Mua batch mail SmsBower: ${body?.error || 'không nhận được mail'}${hint}`);
  }
  return {
    batchId: String(body.batch_id ?? ''),
    mails: body.mails.map((m: any) => ({ mail: String(m?.mail ?? ''), url: withScheme(String(m?.url ?? '')) })),
  };
}

/** GET getCodeBySignature — đọc mã của 1 mail batch qua link `url`. Đọc lại được
 *  nhiều lần; trả `allCodes` = TẤT CẢ mã đã nhận (OpenAI gửi 2-3) + `code` tiện
 *  dụng (mã mới nhất) + `raw` (body thô để log chẩn đoán). status 0 / rỗng →
 *  allCodes=[] (poll tiếp).
 *
 *  ROBUST: không chỉ đọc `all_codes` — SmsBower có thể trả mã ở `codes` (mảng)
 *  hoặc `code` (số ít). Gộp hết vào `allCodes` để caller (fetchNew) luôn thấy mã
 *  dù API đổi tên trường (đây là thủ phạm "treo ở đọc mail": mã về ở `code` mà
 *  code cũ chỉ nhìn `all_codes` nên poll hoài không thấy). */
export async function getCodeBySignature(
  url: string,
): Promise<{ code: string | null; allCodes: string[]; raw: unknown }> {
  const body = await requestJson(withScheme(url), 'Đọc code SmsBower (batch)');
  const arr = Array.isArray(body?.all_codes)
    ? body.all_codes
    : Array.isArray(body?.codes)
      ? body.codes
      : [];
  const allCodes: string[] = arr.map((c: any) => String(c)).filter(Boolean);
  // Mã số ít (`code`) — gộp vào cuối (coi là mới nhất) nếu chưa có trong mảng.
  const single = body?.code != null && body.code !== '' ? String(body.code) : null;
  if (single && !allCodes.includes(single)) allCodes.push(single);
  const code = allCodes.length ? allCodes[allCodes.length - 1] : null;
  return { code, allCodes, raw: body };
}
