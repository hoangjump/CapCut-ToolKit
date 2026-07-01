import { join } from 'node:path';
import type { BrowserManager } from '../browserManager.js';
import type { MailCredentials, MailCodeType, RunResult } from '../types.js';
import { getCode } from '../mailClient.js';
import { getFlow } from '../flows/index.js';
import { PageHelper, setShotsDir } from './helper.js';
import type { FlowContext } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('runner');

export interface RunProjectInput {
  profileIds: string[];
  flowName: string;
  /** Mailbox bound in for getOtp() steps, if the project chose one. */
  mail?: MailCredentials;
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

/** Poll the bound mailbox for a code. Mail often lands a few seconds after the
 *  action that triggers it, so we retry rather than fail on the first empty read. */
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
      const ctx: FlowContext = {
        page,
        helper,
        session,
        profile: session.profile,
        mail: input.mail,
        getOtp: (type: MailCodeType) => {
          if (!input.mail) throw new Error('Project chưa gán mail — không thể lấy OTP');
          return pollOtp(input.mail, type);
        },
        log: flowLog,
      };
      await flow.run(ctx);
    },
    { concurrency, launch: { headless }, autoClose: opts.autoClose ?? true },
  );

  return batch.map((r) => ({
    profileId: r.profileId,
    ok: !r.error,
    error: r.error?.message,
  }));
}
