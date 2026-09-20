import type { Page } from 'playwright-core';
import type { Session } from '../browserManager.js';
import type { Profile, MailCredentials, MailCodeType } from '../types.js';
import type { Logger } from '../logger.js';
import type { PageHelper } from './helper.js';

/** Everything a flow gets to drive one profile. Built fresh per profile by the
 *  runner (see runner.ts) on top of the freshly-opened Session. */
export interface FlowContext {
  /** The first page of the profile's context — where the flow acts. */
  page: Page;
  /** Thin wrapper over `page` with timeouts + logging (goto/click/fill/…). */
  helper: PageHelper;
  /** The open browser session (context + profile + proxy relay). */
  session: Session;
  profile: Profile;
  /** Mailbox bound to the project, if any — credentials for OTP steps. Note:
   *  buyMail() replaces this with the freshly-bought mailbox for this profile. */
  mail?: MailCredentials;
  /** Buy a fresh mailbox from dongvanfb for THIS profile, save it to the store,
   *  and make it the current mailbox so getOtp() afterwards reads codes from it.
   *  Each profile in a batch buys its own — needed for registration flows where
   *  every profile needs a distinct email. Throws if no API key is configured.
   *  Returns the full mail credentials (email|password|refresh_token|client_id)
   *  so a flow can log them to a sheet. */
  buyMail: (input?: { accountType?: string; quality?: string }) => Promise<BoughtMail>;
  /** Thuê một địa chỉ gmail dùng-một-lần từ SmsBower để nhận code xác minh của
   *  `service` (mặc định lấy từ project.smsbowerService). Dùng cho flow đăng ký
   *  bằng email tạm (vd ChatGPT): KHÁC buyMail (không lưu hộp thư, chỉ nhận OTP
   *  qua getCode). Trả mailbox có waitCode()/success()/cancel(). Ném nếu chưa
   *  cấu hình API key SmsBower. */
  rentMail: (service?: string) => Promise<RentedMailbox>;
  /** Tạo một hộp thư TẠM từ tempmail.id.vn (API HTTP) để nhận OTP CapCut. Khác
   *  buyMail (không lưu kho, không refresh_token) và khác rentMail (đọc THẲNG qua
   *  HTTP, không dính captcha). Trả hộp có waitOtp() poll mã. Ném nếu chưa cấu
   *  hình API token tempmail. */
  tempMail: (opts?: { domain?: string }) => Promise<TempMailbox>;
  /** Poll the current mailbox (bound project mail, or the one buyMail() bought)
   *  for a confirmation code. Throws if no mailbox is available. */
  getOtp: (type: MailCodeType) => Promise<string>;
  /** Poll the current mailbox's inbox and pull a code out of the message body
   *  with a regex — for senders dongvan's typed getCode doesn't cover (e.g.
   *  CapCut: "your verification code is 747139"). The regex must have one capture
   *  group holding the code. Default matches "verification code is <digits>".
   *  Throws if no mailbox is available or no match after retries. */
  getOtpByRegex: (pattern?: RegExp) => Promise<string>;
  /** Record fields for the end-of-run sheet row as the flow discovers them. The
   *  runner writes exactly ONE row per profile (success OR failure) AFTER the
   *  flow ends — so a profile that throws mid-flow still shows up, with its
   *  error in the fail column. Mail creds are captured automatically by
   *  buyMail(); the flow only needs to report the checkout URL / status. */
  report: (partial: { checkoutUrl?: string; status?: string }) => void;
  /** Ghi thông tin mailbox cho dòng sheet khi flow TỰ quản mail (không qua
   *  buyMail) — ví dụ yopmail: sinh địa chỉ tại chỗ, không mua từ nhà cung cấp.
   *  refresh_token/client_id để trống (yopmail không có). Dòng sheet vẫn có
   *  email+password để tái nhập/đăng nhập CapCut. */
  reportMail: (email: string, password?: string) => void;
  /** Link mời vào team CapCut — flow join sau đăng ký. Absent = không join. */
  teamInviteLink?: string;
  /** Scoped to `flow:<profileName>` so batch logs stay readable. */
  log: Logger;
}

/** Một mailbox THUÊ từ SmsBower (ctx.rentMail): địa chỉ gmail dùng-một-lần +
 *  hàm chờ code + chốt/huỷ. Không có password/refresh/client (khác BoughtMail)
 *  vì SmsBower chỉ chuyển tiếp OTP, không giao quyền truy cập hộp thư. */
export interface RentedMailbox {
  email: string;
  /** Id kích hoạt để poll code / set status. */
  mailId: string;
  /** Poll SmsBower tới khi có code (mặc định ~200s). Ném nếu hết giờ. */
  waitCode: (opts?: { tries?: number; intervalMs?: number }) => Promise<string>;
  /** Chờ MÃ KẾ (khác mã trước) — dùng khi OpenAI báo "Incorrect code" ở mã đầu:
   *  đặt setStatus(5) rồi poll tới khi có code mới. */
  nextCode: (opts?: { tries?: number; intervalMs?: number }) => Promise<string>;
  /** Chốt thành công (trừ tiền). Best-effort, không ném. */
  success: () => Promise<void>;
  /** Huỷ (hoàn tiền nếu chưa có code). Best-effort, không ném. */
  cancel: () => Promise<void>;
}

/** Một hộp thư TẠM từ tempmail.id.vn (ctx.tempMail): địa chỉ dùng-một-lần + hàm
 *  poll OTP đọc qua API HTTP. Không có password/refresh (flow tự đặt mật khẩu
 *  CapCut khi đăng ký). */
export interface TempMailbox {
  email: string;
  /** Id hộp thư trên tempmail — dùng để poll message. */
  mailId: string;
  /** Poll hộp thư tới khi có OTP khớp `pattern` (mặc định mẫu mã CapCut). */
  waitOtp: (opts?: { pattern?: RegExp; tries?: number; intervalMs?: number }) => Promise<string>;
}

/** Full mailbox credentials returned by ctx.buyMail() — everything needed to
 *  reconstruct the "email|password|refresh_token|client_id" line for a sheet. */
export interface BoughtMail {
  email: string;
  password?: string;
  refreshToken: string;
  clientId: string;
}

/** One row pushed to the Google Sheet. Fields the flow has at hand; the Apps
 *  Script side maps these to columns. `mailLine` is the full pipe-joined
 *  credential string, `checkoutUrl` the payment link (empty if none). */
export interface SheetRow {
  profileName: string;
  email: string;
  password?: string;
  refreshToken?: string;
  clientId?: string;
  /** "email|password|refresh_token|client_id" — the full line for re-import. */
  mailLine: string;
  checkoutUrl?: string;
  status?: string;
  /** Failure reason when the flow threw — written to the fail column (M). Empty
   *  on success. Lets every profile show up in the sheet, pass or fail. */
  errorMessage?: string;
}

/** A flow is just an async function driving one profile via its context. Add a
 *  new automation = write one of these + register it in flows/index.ts. */
export type Flow = (ctx: FlowContext) => Promise<void>;

/** UI-facing metadata for a flow — what the Project tab's dropdown shows. */
export interface FlowMeta {
  /** Registry key (stable id used by ProjectRecord.flowName). */
  name: string;
  /** Human label for the dropdown. */
  label: string;
  description?: string;
}

/** A registered flow: its metadata + the function to run. */
export interface RegisteredFlow {
  meta: FlowMeta;
  run: Flow;
}
