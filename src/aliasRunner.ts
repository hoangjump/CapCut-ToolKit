import type { BrowserManager } from './browserManager.js';
import type { ProfileManager } from './profileManager.js';
import type { MailStore } from './mailStore.js';
import type { ProxyStore } from './proxyStore.js';
import { createAliases } from './aliasFlow.js';
import { rotateIp as mktRotateIp } from './mktproxyClient.js';
import { createLogger } from './logger.js';

const log = createLogger('alias-run');

export interface AliasRunnerDeps {
  profiles: ProfileManager;
  browsers: BrowserManager;
  mails: MailStore;
  store: ProxyStore;
}

export interface RunAliasesInput {
  /** Id của account nguồn trong kho mail (email|password|refresh_token|client_id). */
  mailId: string;
  /** Tổng alias muốn account có sau khi chạy (tối đa 10). Mặc định 10. */
  target?: number;
  prefix?: string;
  /** Bật/tắt xem tận mắt. Mặc định headful (false) để lần đầu quan sát login. */
  headless?: boolean;
  /** Ép chạy qua proxy pool. Mặc định false (direct/IP thật) — login tài khoản
   *  của chính mình không cần proxy, và proxy dân cư hay làm treo trang login. */
  useProxy?: boolean;
}

export interface RunAliasesResult {
  parentEmail: string;
  created: string[]; // "alias@outlook.com"
  existingBefore: number;
  hitLimit: boolean;
  /** MS chặn vì thêm alias quá thường xuyên — thử lại sau. */
  rateLimited: boolean;
  /** Số alias đã thêm vào kho mail (bỏ trùng). */
  storedCount: number;
}

/**
 * Tạo alias cho MỘT account nguồn: mở Camoufox qua proxy (profile tạm), login
 * account.live.com, tạo alias tới trần, rồi lưu mỗi alias vào kho mail dưới dạng
 * dòng TÁI DÙNG credential của account cha — vì alias dùng chung hộp thư cha,
 * OTP của alias đọc bằng refresh_token cha lọc theo recipient (graphMailClient).
 *
 * Profile tạm luôn bị xoá ở cuối (kể cả khi lỗi). KHÔNG ghi sheet ở đây — tầng
 * gọi lo, để hàm này thuần về alias + kho mail.
 */
export async function runAliasesForMail(
  deps: AliasRunnerDeps,
  input: RunAliasesInput,
): Promise<RunAliasesResult> {
  const { profiles, browsers, mails, store } = deps;
  const parent = mails.get(input.mailId);
  if (!parent) throw new Error('Không tìm thấy account nguồn trong kho mail');
  if (!parent.password) throw new Error('Account nguồn thiếu mật khẩu — không đăng nhập được account.live.com');
  if (!parent.refreshToken || !parent.clientId) {
    throw new Error('Account nguồn thiếu refresh_token/client_id — alias sẽ không đọc được OTP');
  }

  // MS chặn thêm alias theo tần suất (một phần theo IP) — cần XOAY IP để tạo tiếp.
  // Dùng proxy pool nếu có proxy Live; không có thì chạy direct (không xoay được,
  // sẽ dừng khi rate-limit). input.useProxy ép bật/tắt.
  const hasLiveProxy = store.list().some((p) => p.alive === true);
  const wantProxy = input.useProxy ?? hasLiveProxy;

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tmp = await profiles.create({
    name: `alias-${parent.email.split('@')[0]}-${stamp}`,
    ...(wantProxy
      ? { proxyRotation: { mode: 'pool' as const, pool: { tags: [] }, rotateOnOpen: true, rotateOnFailure: true } }
      : {}),
  });

  try {
    const session = await browsers.open(tmp.id, { headless: input.headless ?? false });
    try {
      const page = session.context.pages()[0] ?? (await session.context.newPage());

      // Callback xoay IP: chỉ có khi proxy đang thuê là mktproxy API (có key để
      // gọi rotate-ip). Xoay đổi IP egress của gateway, không cần mở lại browser.
      let rotateIp: (() => Promise<void>) | undefined;
      if (session.leasedProxyId) {
        const px = store.get(session.leasedProxyId);
        if (px?.apiProvider === 'mktproxy' && px.apiKey) {
          const key = px.apiKey;
          rotateIp = async () => {
            try {
              const rp = await mktRotateIp(key);
              log.info(`xoay IP mktproxy → ${rp.realIp || rp.ip || '(IP mới)'}`);
            } catch (e) {
              log.warn(`xoay IP lỗi: ${(e as Error).message}`);
            }
            await new Promise((r) => setTimeout(r, 4_000)); // chờ egress đổi
          };
        }
      }
      if (wantProxy && !rotateIp) {
        log.warn('proxy đang dùng KHÔNG phải mktproxy API → không xoay IP được khi rate-limit');
      }

      const result = await createAliases({
        page,
        cred: { email: parent.email, password: parent.password },
        target: input.target,
        prefix: input.prefix,
        log,
        rotateIp,
      });

      // Mỗi alias = một dòng mail mới TÁI DÙNG cred cha. status 'unchecked' để
      // luồng dùng mail sau kiểm tra như mail thường; note trỏ về account cha.
      const stored = await mails.createMany(
        result.created.map((aliasEmail) => ({
          email: aliasEmail,
          password: parent.password,
          refreshToken: parent.refreshToken,
          clientId: parent.clientId,
          provider: 'outlook',
          tags: ['alias'],
          note: `alias của ${parent.email}`,
          source: 'alias',
          parentEmail: parent.email,
          // 'available' để tab Flow (stock allocation) rút reg CapCut được ngay —
          // alias vừa tạo qua chính tài khoản nên biết chắc dùng được.
          status: 'available' as const,
        })),
      );

      // Mail gốc vừa login thành công → cũng đánh 'available' để tab Flow reg
      // CapCut luôn (gốc + alias = 11). Best-effort: bỏ qua nếu đang reserved.
      try {
        if (parent.status !== 'reserved' && parent.status !== 'used') {
          await mails.updateStatus([parent.id], 'available');
        }
      } catch (err) {
        log.warn(`đánh dấu mail gốc available lỗi: ${(err as Error).message}`);
      }

      return {
        parentEmail: parent.email,
        created: result.created,
        existingBefore: result.existingBefore,
        hitLimit: result.hitLimit,
        rateLimited: result.rateLimited,
        storedCount: stored.length,
      };
    } finally {
      await session.context.close().catch(() => {});
    }
  } finally {
    await profiles.delete(tmp.id, { wipeData: true }).catch((err) => {
      log.warn(`xoá profile tạm ${tmp.id} lỗi: ${(err as Error).message}`);
    });
  }
}
