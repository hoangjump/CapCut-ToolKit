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
  /** Scoped to `flow:<profileName>` so batch logs stay readable. */
  log: Logger;
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
