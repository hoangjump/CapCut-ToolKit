import { join } from 'node:path';
import type { BrowserManager } from '../browserManager.js';
import type { MailCredentials, MailCodeType, ProxyConfig, RunResult } from '../types.js';
import { getCode, getMessages } from '../mailClient.js';
import { getFlow } from '../flows/index.js';
import { PageHelper, setShotsDir } from './helper.js';
import type { FlowContext, SheetRow, BoughtMail, RentedMailbox } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('runner');

/** Result of buying one mailbox for a profile — credentials for OTP + display. */
export interface BoughtMailbox {
  cred: MailCredentials;
  email: string;
  password?: string;
}

/** Dependencies injected by the caller (server) so the runner stays decoupled
 *  from the stores/API-key. */
export interface RunProjectDeps {
  /** Buy a fresh mailbox for one profile: hits dongvanfb with the stored API key,
   *  saves it to the mail store, returns credentials. Absent when the project has
   *  no way to buy (no API key) — flows calling ctx.buyMail() then throw. */
  buyMail?: (input: {
    provider: 'dongvanfb' | 'selltaikhoan';
    /** dongvanfb: bắt buộc accountType+quality. */
    accountType?: string;
    quality?: string;
    /** selltaikhoan: bắt buộc productId. */
    productId?: string;
    profileName: string;
  }) => Promise<BoughtMailbox>;
  /** Thuê một gmail dùng-một-lần từ SmsBower cho `service` (đăng ký ChatGPT…).
   *  Trả mailbox có waitCode/success/cancel. Absent khi chưa cấu hình key
   *  SmsBower → ctx.rentMail() ném lỗi rõ. */
  rentMail?: (input: { service: string; profileName: string }) => Promise<RentedMailbox>;
  /** Append one row to the configured Google Sheet (Apps Script web app). Absent
   *  when no webhook URL is set — ctx.appendSheet() then no-ops with a warning. */
  appendSheet?: (row: SheetRow) => Promise<void>;
  /** Push a Telegram message when a profile registers successfully. Absent when
   *  no bot token / chat id is configured. Failures are swallowed by the runner. */
  notify?: (row: SheetRow) => Promise<void>;
  /** Queue a successful flow result for downstream employee distribution. The
   *  runner never lets a queue failure change the profile's flow result. */
  onResult?: (row: SheetRow, source: {
    profileId: string;
    proxy?: ProxyConfig;
    proxyRecordId?: string;
  }) => Promise<void>;
}

export interface RunProjectInput {
  profileIds: string[];
  flowName: string;
  /** Mailbox bound in for getOtp() steps, if the project chose one. A flow that
   *  calls ctx.buyMail() overrides this per profile. */
  mail?: MailCredentials;
  /** Nhà cung cấp mail cho ctx.buyMail() (mặc định 'dongvanfb'). */
  mailProvider?: 'dongvanfb' | 'selltaikhoan';
  /** Defaults for ctx.buyMail() when the flow doesn't pass its own. */
  buyAccountType?: string;
  buyQuality?: string;
  /** ID sản phẩm selltaikhoan khi mailProvider='selltaikhoan'. */
  buyProductId?: string;
  /** Mã service SmsBower mặc định cho ctx.rentMail() (flow thuê gmail nhận OTP). */
  smsbowerService?: string;
}

export interface RunProjectOptions {
  /** Max profiles driven at once. Low by default — runs are headful. */
  concurrency?: number;
  /** Headful by default so the user can watch; runner leaves it to launch opts. */
  headless?: boolean | 'virtual';
  /** Root for screenshots (<root>/shots). Defaults to CWD/profiles-store. */
  storeRoot?: string;
  /** Close each context when its flow finishes (default true). */
  autoClose?: boolean;
}

/** Poll a mailbox for a code. Mail often lands a few seconds after the action
 *  that triggers it, so we retry rather than fail on the first empty read. */
async function pollOtp(
  mail: MailCredentials,
  type: MailCodeType,
  tries = 6,
  intervalMs = 5_000,
): Promise<string> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const r = await getCode({ ...mail, type });
    if (r.code) return r.code;
    if (attempt < tries) await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`Không lấy được code (${type}) sau ${tries} lần thử`);
}

/** Poll the inbox and pull a code out of a message body with a regex — for
 *  senders dongvan's typed getCode doesn't cover (CapCut et al). Scans every
 *  message's subject + body + typed code field, newest first. Retries since the
 *  mail lands a few seconds after the trigger. The pattern's first capture group
 *  holds the code. */
async function pollOtpByRegex(
  mail: MailCredentials,
  pattern: RegExp,
  tries = 8,
  intervalMs = 5_000,
): Promise<string> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const messages = await getMessages(mail);
    for (const m of messages) {
      const hay = `${m.subject ?? ''}\n${m.code ?? ''}\n${m.message ?? ''}`;
      const match = pattern.exec(hay);
      if (match?.[1]) return match[1];
    }
    if (attempt < tries) await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`Không tìm được code khớp ${pattern} sau ${tries} lần đọc hòm thư`);
}

/** Default CapCut-style pattern: "your verification code is 747139". Tolerates
 *  the code being 4-8 digits and any words between "code" and the number. */
const DEFAULT_CODE_RE = /verification code is[^\d]*(\d{4,8})/i;

/**
 * Runs a registered flow across the given profiles with bounded concurrency.
 * Each profile gets a freshly-opened Session (via runBatch) and its own
 * FlowContext; a failure in one profile is isolated and reported, not fatal to
 * the batch. Returns one RunResult per profile.
 */
export async function runProject(
  browsers: BrowserManager,
  input: RunProjectInput,
  opts: RunProjectOptions = {},
  deps: RunProjectDeps = {},
): Promise<RunResult[]> {
  const flow = getFlow(input.flowName);
  if (!flow) throw new Error(`Flow không tồn tại: ${input.flowName}`);

  const storeRoot = opts.storeRoot ?? join(process.cwd(), 'profiles-store');
  setShotsDir(join(storeRoot, 'shots'));

  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const headless = opts.headless ?? false;

  log.info(`chạy flow "${input.flowName}" trên ${input.profileIds.length} profile (concurrency=${concurrency})`);

  const batch = await browsers.runBatch(
    input.profileIds,
    async (session) => {
      const page = session.context.pages()[0] ?? (await session.context.newPage());
      const flowLog = createLogger(`flow:${session.profile.name}`);
      const helper = new PageHelper(page, flowLog);

      // "Current mailbox" for this profile: starts as the project-bound mail (if
      // any); ctx.buyMail() replaces it with a freshly-bought one. getOtp() always
      // reads from whatever is current, so a buy-then-verify flow just works.
      let currentMail = input.mail;

      // Sheet-row accumulators. buyMail() captures the mail creds here so the
      // runner can write them even if the flow later throws; report() fills in
      // checkout URL / status. Exactly ONE row is written per profile in the
      // finally below — success OR failure — so a mid-flow crash still shows up.
      let boughtMail: BoughtMail | undefined;
      let reported: { checkoutUrl?: string; status?: string } = {};

      const ctx: FlowContext = {
        page,
        helper,
        session,
        profile: session.profile,
        mail: currentMail,
        buyMail: async (buyInput) => {
          if (!deps.buyMail) {
            throw new Error('Không thể mua mail — chưa cấu hình nhà cung cấp mail (vào tab Mail)');
          }
          const provider = input.mailProvider ?? 'dongvanfb';
          const profileName = session.profile.name;
          let bought: BoughtMailbox;
          if (provider === 'selltaikhoan') {
            if (!input.buyProductId) {
              throw new Error('buyMail (selltaikhoan): thiếu ID sản phẩm (đặt trong project)');
            }
            bought = await deps.buyMail({ provider, productId: input.buyProductId, profileName });
          } else {
            const accountType = buyInput?.accountType ?? input.buyAccountType;
            const quality = buyInput?.quality ?? input.buyQuality;
            if (!accountType || !quality) {
              throw new Error('buyMail: thiếu accountType/quality (đặt trong project hoặc truyền vào)');
            }
            bought = await deps.buyMail({ provider, accountType, quality, profileName });
          }
          currentMail = bought.cred;
          ctx.mail = bought.cred;
          const full: BoughtMail = {
            email: bought.email,
            password: bought.password,
            refreshToken: bought.cred.refreshToken,
            clientId: bought.cred.clientId,
          };
          boughtMail = full; // captured for the sheet row even if the flow later throws
          flowLog.info(`mua mail: ${bought.email}`);
          return full;
        },
        report: (partial) => {
          reported = { ...reported, ...partial };
        },
        rentMail: async (serviceOverride) => {
          if (!deps.rentMail) {
            throw new Error('Không thể thuê mail — chưa cấu hình API key SmsBower (vào tab Mail)');
          }
          const service = serviceOverride ?? input.smsbowerService;
          if (!service) {
            throw new Error('rentMail: thiếu mã service SmsBower (đặt trong project hoặc truyền vào)');
          }
          const rented = await deps.rentMail({ service, profileName: session.profile.name });
          flowLog.info(`thuê mail SmsBower: ${rented.email} (service=${service})`);
          return rented;
        },
        getOtp: (type: MailCodeType) => {
          if (!currentMail) throw new Error('Chưa có mail — gán mail cho project hoặc gọi buyMail() trước');
          return pollOtp(currentMail, type);
        },
        getOtpByRegex: (pattern = DEFAULT_CODE_RE) => {
          if (!currentMail) throw new Error('Chưa có mail — gán mail cho project hoặc gọi buyMail() trước');
          return pollOtpByRegex(currentMail, pattern);
        },
        log: flowLog,
      };

      // Run the flow, then write exactly one sheet row regardless of outcome. A
      // thrown error is captured for the row and re-thrown so runBatch still
      // records the profile as failed.
      let flowError: Error | undefined;
      try {
        await flow.run(ctx);
      } catch (err) {
        flowError = err as Error;
        // Chụp màn hình NGAY lúc lỗi để xem trang đang hiện gì — quan trọng khi
        // chạy trong Docker (Xvfb ảo, không nhìn được browser trực tiếp). Ảnh vào
        // <root>/shots, bind-mount nên mở được từ máy host.
        await helper.screenshot(`error-${session.profile.name}`).catch(() => {});
        throw err;
      } finally {
        const mailLine = boughtMail
          ? [boughtMail.email, boughtMail.password ?? '', boughtMail.refreshToken, boughtMail.clientId].join('|')
          : '';
        const row: SheetRow = {
          profileName: session.profile.name,
          email: boughtMail?.email ?? '',
          password: boughtMail?.password,
          refreshToken: boughtMail?.refreshToken,
          clientId: boughtMail?.clientId,
          mailLine,
          checkoutUrl: reported.checkoutUrl,
          status: flowError ? 'error' : (reported.status ?? 'ok'),
          errorMessage: flowError?.message,
        };
        if (deps.appendSheet) {
          try {
            await deps.appendSheet(row);
            flowLog.info(`ghi sheet: ${row.email || session.profile.name} (${row.status})`);
          } catch (e) {
            // A sheet hiccup must not change the run outcome.
            flowLog.warn(`ghi sheet lỗi: ${(e as Error).message}`);
          }
        } else {
          flowLog.warn('ghi sheet bỏ qua — chưa cấu hình Google Sheet URL (vào tab Mail)');
        }
        // Telegram chỉ báo khi ĐĂNG KÝ THÀNH CÔNG (không có flowError). Lỗi gửi
        // không được đổi kết quả run — nuốt như appendSheet.
        if (deps.notify && !flowError) {
          try {
            await deps.notify(row);
            flowLog.info(`đã báo Telegram: ${row.email || session.profile.name}`);
          } catch (e) {
            flowLog.warn(`báo Telegram quản lý lỗi: ${(e as Error).message}`);
          }
        }
        if (deps.onResult && !flowError && row.checkoutUrl && row.email) {
          try {
            await deps.onResult(row, {
              profileId: session.profile.id,
              proxy: session.profile.proxy,
              proxyRecordId: session.profile.assignedProxyId,
            });
            flowLog.info(`đã xếp hàng phân phối: ${row.email}`);
          } catch (e) {
            flowLog.warn(`xếp hàng phân phối lỗi: ${(e as Error).message}`);
          }
        }
      }
    },
    { concurrency, launch: { headless }, autoClose: opts.autoClose ?? true },
  );

  return batch.map((r) => ({
    profileId: r.profileId,
    ok: !r.error,
    error: r.error?.message,
  }));
}
