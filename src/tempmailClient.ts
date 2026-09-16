/**
 * TEMPMAIL.ID.VN — dịch vụ mail tạm CÓ API HTTP đầy đủ (tạo hộp, liệt kê message,
 * đọc nội dung). Hơn hẳn yopmail ở chỗ đọc OTP THẲNG từ Node qua HTTP — không cần
 * mở tab trình duyệt, không phụ thuộc proxy của profile.
 *
 * Xác thực: header `Authorization: Bearer <token>` (token tạo ở trang cá nhân
 * tempmail.id.vn, chỉ hiện MỘT lần khi tạo). Endpoint:
 *   GET  /api/domain              → danh sách domain khả dụng
 *   POST /api/email/create        → tạo hộp {user?, domain?} (bỏ trống = ngẫu nhiên)
 *   GET  /api/email/{mailId}      → danh sách message của hộp (data.items[])
 *   GET  /api/message/{messageId} → nội dung 1 message (subject + body HTML)
 *
 * Đã kiểm chứng: CapCut CHẤP NHẬN domain của dịch vụ này (vd hathitrannhien.edu.vn):
 * check_email is_registered=0, send_code success, OTP về + đọc được (mã nằm luôn
 * trong subject: "Welcome to CapCut and your verification code is 239865").
 */

const BASE_URL = 'https://tempmail.id.vn/api';

/** Mã OTP CapCut: "verification code is 239865". 4-8 số, chịu được vài chữ chèn. */
const OTP_DEFAULT_RE = /verification code[^\d]{0,20}(\d{4,8})/i;

/** Domain "lộ liễu" là mail tạm → CapCut/dịch vụ dễ chặn. Tránh khi tự chọn. */
const OBVIOUS_TEMP = /temp\s*-?\s*mail|tmail|trash|disposable|10minute|guerrilla|mailinator|yopmail/i;

export interface TempmailConfig {
  token: string;
  /** Override base URL (mặc định tempmail.id.vn) — để test tiêm fetch giả. */
  baseUrl?: string;
  /** Tiêm fetch (test). Mặc định global fetch. */
  fetchImpl?: typeof fetch;
}

async function api(cfg: TempmailConfig, method: string, path: string, body?: unknown): Promise<any> {
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${cfg.baseUrl ?? BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${cfg.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* body không phải JSON */
  }
  if (!res.ok || !json?.success) {
    throw new Error(`tempmail ${path} lỗi: ${json?.message || `HTTP ${res.status}`}`);
  }
  return json.data;
}

export interface TempmailUser {
  id: number;
  email: string;
  name?: string;
}

/** Thông tin tài khoản gắn với token — dùng để KIỂM TRA token hợp lệ. */
export async function tokenInfo(cfg: TempmailConfig): Promise<TempmailUser> {
  const data = await api(cfg, 'GET', '/user');
  return { id: data.id, email: data.email, name: data.name };
}

/** Danh sách tên domain khả dụng. */
export async function listDomains(cfg: TempmailConfig): Promise<string[]> {
  const data = await api(cfg, 'GET', '/domain');
  return (Array.isArray(data) ? data : []).map((d: any) => String(d.name)).filter(Boolean);
}

/** Chọn một domain ÍT lộ liễu (giảm rủi ro bị CapCut chặn). Ưu tiên domain không
 *  khớp OBVIOUS_TEMP; nếu tất cả đều lộ thì lấy bừa. Thuần → test được. */
export function pickTempmailDomain(domains: string[], rnd = Math.random): string | undefined {
  if (!domains.length) return undefined;
  const safe = domains.filter((d) => !OBVIOUS_TEMP.test(d));
  const pool = safe.length ? safe : domains;
  return pool[Math.floor(rnd() * pool.length)];
}

export interface CreatedEmail {
  id: string;
  email: string;
}

/** Tạo một hộp thư mới. Bỏ trống user/domain = server sinh ngẫu nhiên. */
export async function createEmail(cfg: TempmailConfig, opts: { user?: string; domain?: string } = {}): Promise<CreatedEmail> {
  const body: Record<string, string> = {};
  if (opts.user) body.user = opts.user;
  if (opts.domain) body.domain = opts.domain;
  const data = await api(cfg, 'POST', '/email/create', body);
  return { id: String(data.id), email: String(data.email) };
}

export interface TempmailMessageMeta {
  id: string;
  subject: string;
  from: string;
}

/** Danh sách message của một hộp (mới nhất trước — theo API). */
export async function listMessages(cfg: TempmailConfig, mailId: string): Promise<TempmailMessageMeta[]> {
  const data = await api(cfg, 'GET', `/email/${mailId}`);
  const items = data?.items ?? [];
  return (Array.isArray(items) ? items : []).map((m: any) => ({
    id: String(m.id),
    subject: String(m.subject ?? ''),
    from: String(m.from ?? ''),
  }));
}

/** Nội dung đầy đủ một message (subject + body, body có thể là HTML). */
export async function readMessage(cfg: TempmailConfig, messageId: string): Promise<{ subject: string; body: string }> {
  const data = await api(cfg, 'GET', `/message/${messageId}`);
  return { subject: String(data?.subject ?? ''), body: String(data?.body ?? '') };
}

/** Bỏ thẻ HTML → text thô để dò regex trong body. Thuần → test được. */
export function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bóc mã OTP từ text bằng regex (nhóm bắt 1 = mã). Thuần → test được. */
export function extractOtp(text: string, pattern: RegExp = OTP_DEFAULT_RE): string | null {
  const m = String(text ?? '').match(pattern);
  return m && m[1] ? m[1] : null;
}

export interface PollOtpOptions {
  pattern?: RegExp;
  tries?: number;
  intervalMs?: number;
  /** Log tiến trình (tuỳ chọn). */
  log?: { info: (m: string) => void };
}

/**
 * Poll hộp thư lấy OTP CapCut. Mỗi vòng: liệt kê message → ưu tiên message của
 * CapCut (from/subject) → thử subject trước (mã CapCut nằm sẵn ở subject) → nếu
 * subject không khớp thì đọc body. Lặp tới khi có mã hoặc hết `tries`.
 */
export async function pollTempmailOtp(cfg: TempmailConfig, mailId: string, opts: PollOtpOptions = {}): Promise<string> {
  const pattern = opts.pattern ?? OTP_DEFAULT_RE;
  const tries = opts.tries ?? 20;
  const intervalMs = opts.intervalMs ?? 4_000;
  const isCapcut = (m: TempmailMessageMeta) => /capcut|verification/i.test(`${m.from} ${m.subject}`);

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let messages: TempmailMessageMeta[] = [];
    try {
      messages = await listMessages(cfg, mailId);
    } catch (e) {
      opts.log?.info(`tempmail poll lỗi (thử ${attempt}/${tries}): ${(e as Error).message}`);
    }
    // Ứng viên: mail CapCut trước, không có thì mọi mail (mới nhất trước).
    const candidates = messages.filter(isCapcut).length ? messages.filter(isCapcut) : messages;
    // 1) Subject thường đã chứa mã → nhanh, khỏi đọc body.
    for (const m of candidates) {
      const hit = extractOtp(m.subject, pattern);
      if (hit) {
        opts.log?.info(`tempmail: OTP ${hit} (từ subject "${m.subject.slice(0, 60)}")`);
        return hit;
      }
    }
    // 2) Chưa thấy ở subject → đọc body từng ứng viên.
    for (const m of candidates) {
      try {
        const { subject, body } = await readMessage(cfg, m.id);
        const hit = extractOtp(`${subject}\n${stripHtml(body)}`, pattern);
        if (hit) {
          opts.log?.info(`tempmail: OTP ${hit} (từ body message ${m.id})`);
          return hit;
        }
      } catch {
        /* đọc lỗi 1 message — bỏ qua, thử tiếp */
      }
    }
    if (attempt < tries) {
      if (attempt === 1 || attempt % 5 === 0) opts.log?.info(`tempmail: chưa thấy OTP (thử ${attempt}/${tries}, ${messages.length} mail)`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`tempmail: không đọc được OTP sau ${tries} lần (hộp ${mailId})`);
}
