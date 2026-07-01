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
  /** Mailbox bound to the project, if any — credentials for OTP steps. */
  mail?: MailCredentials;
  /** Poll the bound mailbox for a confirmation code. Throws if no mail bound. */
  getOtp: (type: MailCodeType) => Promise<string>;
  /** Scoped to `flow:<profileName>` so batch logs stay readable. */
  log: Logger;
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
