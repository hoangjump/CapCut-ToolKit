import type { Express } from 'express';
import type { Request, Response } from 'express';
import type { ProfileManager } from '../../profileManager.js';
import type { BrowserManager } from '../../browserManager.js';
import type { MailStore } from '../../mailStore.js';
import type { ProjectStore } from '../../projectStore.js';
import type { SettingsStore } from '../../settingsStore.js';
import type { TelegramWorkService } from '../../work/service.js';
import { acquireMailWithFallback } from '../../mailAllocation.js';
import { providerFromEmail } from '../../mailStore.js';
import { runProject } from '../../automation/runner.js';
import type { SheetRow } from '../../automation/types.js';
import { flowMetas } from '../../flows/index.js';
import { profilePresets, projectPresets } from '../../presets.js';
import { buyMail } from '../../mailClient.js';
import * as selltaikhoan from '../../selltaikhoanClient.js';
import * as smsbower from '../../smsbowerClient.js';
import { TelegramClient } from '../../work/telegramClient.js';
import {
  defaultAntiDetect,
  type MailAcquireStrategy, type ProjectRecord, type ProxyPoolFilter,
} from '../../types.js';
import { createLogger } from '../../logger.js';
import { asyncHandler } from '../http.js';

const log = createLogger('server');
const telegramClient = new TelegramClient();

const MAIL_STRATEGIES = new Set<MailAcquireStrategy>(['api-only', 'api-then-stock', 'stock-then-api', 'stock-only']);

function parseMailStrategy(raw: unknown): MailAcquireStrategy | undefined {
  const value = String(raw ?? '') as MailAcquireStrategy;
  return MAIL_STRATEGIES.has(value) ? value : undefined;
}

/** Normalize a project's ephemeral proxy-pool config from the request body.
 *  Accepts { tags?: string[], liveOnly?: boolean }. Returns undefined when the
 *  caller didn't enable a pool (falsey/empty) so ephemeral profiles fall back to
 *  a direct connection. An empty tags array means "any live proxy". */
function parseEphemeralPool(raw: unknown): ProxyPoolFilter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as { tags?: unknown; liveOnly?: unknown };
  const tags = Array.isArray(obj.tags)
    ? obj.tags.map(String).map((t) => t.trim()).filter(Boolean)
    : [];
  const liveOnly = obj.liveOnly === undefined ? true : Boolean(obj.liveOnly);
  return { tags, liveOnly };
}

function parseTelegramDistribution(raw: unknown): ProjectRecord['telegramDistribution'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { enabled?: unknown; allocations?: unknown };
  const allocations = Array.isArray(value.allocations)
    ? value.allocations
        .map((item) => item as { employeeId?: unknown; quantity?: unknown })
        .map((item) => ({ employeeId: String(item.employeeId ?? '').trim(), quantity: Number(item.quantity ?? 0) }))
        .filter((item) => item.employeeId && Number.isSafeInteger(item.quantity) && item.quantity >= 0)
    : [];
  return { enabled: value.enabled === true, allocations };
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}


export interface ProjectRoutesDeps {
  profiles: ProfileManager;
  browsers: BrowserManager;
  mails: MailStore;
  projects: ProjectStore;
  settings: SettingsStore;
  telegramWork: TelegramWorkService;
  storeRoot: string;
  headless: boolean | 'virtual';
}

/** Flow metadata, preset và toàn bộ vòng đời project (tạo, sửa, chạy). */
export function registerProjectRoutes(app: Express, { profiles, browsers, mails, projects, settings, telegramWork, storeRoot, headless }: ProjectRoutesDeps): void {
  // ---- Flows (automation) -------------------------------------------------
  // Flows are TS code in src/flows/; this just exposes their metadata so the
  // Project tab can populate the flow dropdown.
  app.get('/api/flows', (_req: Request, res: Response) => {
    res.json(flowMetas());
  });

  app.get('/api/presets', (_req: Request, res: Response) => {
    res.json({ profilePresets, projectPresets });
  });

  // ---- Projects (automation jobs) -----------------------------------------
  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json(projects.list());
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const project = projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(project);
  });

  app.post('/api/projects', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (!body.name || !String(body.name).trim()) {
        res.status(400).json({ error: 'name là bắt buộc' });
        return;
      }
      if (!body.flowName || !String(body.flowName).trim()) {
        res.status(400).json({ error: 'flowName là bắt buộc' });
        return;
      }
      const created = await projects.create({
        name: String(body.name).trim(),
        flowName: String(body.flowName).trim(),
        profileIds: Array.isArray(body.profileIds) ? body.profileIds.map(String) : [],
        mailId: body.mailId ? String(body.mailId) : undefined,
        concurrency: body.concurrency !== undefined ? Number(body.concurrency) : undefined,
        ephemeralCount: body.ephemeralCount !== undefined ? Number(body.ephemeralCount) : undefined,
        mailProvider: body.mailProvider === 'selltaikhoan' ? 'selltaikhoan' : undefined,
        buyAccountType: body.buyAccountType ? String(body.buyAccountType) : undefined,
        buyQuality: body.buyQuality ? String(body.buyQuality) : undefined,
        buyProductId: body.buyProductId ? String(body.buyProductId) : undefined,
        mailStrategy: parseMailStrategy(body.mailStrategy),
        mailStockTags: Array.isArray(body.mailStockTags)
          ? (body.mailStockTags as unknown[]).map(String).map((tag: string) => tag.trim()).filter(Boolean)
          : undefined,
        smsbowerService: body.smsbowerService ? String(body.smsbowerService) : undefined,
        ephemeralProxyPool: parseEphemeralPool(body.ephemeralProxyPool),
        blockImages: body.blockImages === true ? true : undefined,
        headless: body.headless === true ? true : undefined,
        telegramDistribution: parseTelegramDistribution(body.telegramDistribution),
        note: body.note ? String(body.note) : undefined,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/projects/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!projects.get(id)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const body = req.body ?? {};
      const patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt'>> = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (typeof body.flowName === 'string' && body.flowName.trim()) patch.flowName = body.flowName.trim();
      if (Array.isArray(body.profileIds)) patch.profileIds = body.profileIds.map(String);
      if (body.mailId !== undefined) patch.mailId = body.mailId ? String(body.mailId) : undefined;
      if (body.concurrency !== undefined) patch.concurrency = Number(body.concurrency);
      if (body.ephemeralCount !== undefined) patch.ephemeralCount = Number(body.ephemeralCount);
      if (body.mailProvider !== undefined) patch.mailProvider = body.mailProvider === 'selltaikhoan' ? 'selltaikhoan' : undefined;
      if (body.buyAccountType !== undefined) patch.buyAccountType = body.buyAccountType ? String(body.buyAccountType) : undefined;
      if (body.buyQuality !== undefined) patch.buyQuality = body.buyQuality ? String(body.buyQuality) : undefined;
      if (body.buyProductId !== undefined) patch.buyProductId = body.buyProductId ? String(body.buyProductId) : undefined;
      if (body.mailStrategy !== undefined) patch.mailStrategy = parseMailStrategy(body.mailStrategy);
      if (body.mailStockTags !== undefined) patch.mailStockTags = Array.isArray(body.mailStockTags)
        ? (body.mailStockTags as unknown[]).map(String).map((tag: string) => tag.trim()).filter(Boolean)
        : undefined;
      if (body.smsbowerService !== undefined) patch.smsbowerService = body.smsbowerService ? String(body.smsbowerService) : undefined;
      if (body.ephemeralProxyPool !== undefined) patch.ephemeralProxyPool = parseEphemeralPool(body.ephemeralProxyPool);
      if (body.blockImages !== undefined) patch.blockImages = body.blockImages === true ? true : undefined;
      if (body.headless !== undefined) patch.headless = body.headless === true ? true : undefined;
      if (body.telegramDistribution !== undefined) patch.telegramDistribution = parseTelegramDistribution(body.telegramDistribution);
      if (body.note !== undefined) patch.note = String(body.note);
      const updated = await projects.update(id, patch);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    try {
      await projects.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Run a project's flow across its profiles (headful, low concurrency). Runs
  // synchronously — the batch is small, so we wait and return per-profile results.
  app.post('/api/projects/:id/run', asyncHandler(async (req, res) => {
    const project = projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    // Smart Telegram distribution uses one fresh profile per allocated "con".
    // It intentionally requires ephemeral profiles so every link comes from a
    // clean account and total generated links matches the employee quota exactly.
    const distribution = project.telegramDistribution?.enabled ? project.telegramDistribution : undefined;
    if (distribution && project.flowName !== 'capcut-signin') {
      res.status(400).json({ error: 'Tự phân phối Telegram hiện chỉ áp dụng cho flow CapCut' });
      return;
    }
    if (distribution && project.profileIds.length) {
      res.status(400).json({ error: 'Tự phân phối cần dùng profile tạm; hãy bỏ chọn profile cố định' });
      return;
    }
    const distributionTotal = distribution
      ? distribution.allocations.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0)
      : 0;
    const ephemeralCount = distribution
      ? distributionTotal
      : project.profileIds.length ? 0 : (project.ephemeralCount ?? 0);
    if (!project.profileIds.length && ephemeralCount < 1) {
      res.status(400).json({ error: 'Project chưa chọn profile, cũng chưa đặt số profile tạm để tạo' });
      return;
    }
    // Resolve the bound mailbox (if any) into credentials for OTP steps.
    let mail;
    if (project.mailId) {
      const rec = mails.get(project.mailId);
      if (!rec) {
        res.status(400).json({ error: 'Mail đã gán không còn tồn tại' });
        return;
      }
      if (rec.status === 'reserved' || rec.status === 'failed' || rec.status === 'disabled') {
        res.status(409).json({ error: `Mail đã gán hiện ở trạng thái "${rec.status}", hãy chọn mail khác` });
        return;
      }
      mail = { email: rec.email, password: rec.password, refreshToken: rec.refreshToken, clientId: rec.clientId };
    }
    // Build the buyMail dependency only when an API key is configured. A flow that
    // calls ctx.buyMail() without a key gets a clear error (runner handles absent dep).
    // buyMail dep: chọn nhà cung cấp theo `provider` runner truyền vào (dongvanfb
    // hoặc selltaikhoan). Luôn dựng dep; kiểm tra đúng key của nhà cung cấp bên
    // trong. Cả hai trả cùng định dạng nên lưu MailStore + đọc OTP dùng chung.
    const buyMailDep = async (input: {
      provider: 'dongvanfb' | 'selltaikhoan';
      accountType?: string;
      quality?: string;
      productId?: string;
      strategy: MailAcquireStrategy;
      stockTags?: string[];
      profileId: string;
      profileName: string;
    }) => {
      const acquired = await acquireMailWithFallback(
        mails,
        { profileId: input.profileId, strategy: input.strategy, stockTags: input.stockTags },
        async () => {
          if (input.provider === 'selltaikhoan') {
            const key = settings.getSelltaikhoanKey();
            if (!key) throw new Error('Chưa cấu hình API key selltaikhoan (vào tab Mail)');
            if (!input.productId) throw new Error('Thiếu ID sản phẩm selltaikhoan');
            const result = await selltaikhoan.buyProduct(key, input.productId, 1);
            const first = result.mails[0];
            if (!first) throw new Error('Mua mail thành công nhưng không nhận được dữ liệu mail');
            return {
              ...first,
              provider: providerFromEmail(first.email),
              orderCode: result.transId,
              source: 'selltaikhoan',
              note: `auto-mua cho ${input.profileName}`,
            };
          }
          const key = settings.getApiKey();
          if (!key) throw new Error('Chưa cấu hình API key dongvanfb (vào tab Mail)');
          if (!input.accountType || !input.quality) throw new Error('Thiếu accountType/quality');
          const result = await buyMail(key, { accountType: input.accountType, quality: input.quality });
          const first = result.mails[0];
          if (!first) throw new Error('Mua mail thành công nhưng không nhận được dữ liệu mail');
          return {
            ...first,
            provider: providerFromEmail(first.email),
            orderCode: result.orderCode,
            source: 'dongvanfb',
            note: `auto-mua cho ${input.profileName}`,
          };
        },
      );
      log.info(`[${input.profileName}] cấp mail ${acquired.email} từ ${acquired.source === 'manual' ? 'kho dự phòng' : acquired.source}`);
      return {
        storeId: acquired.id,
        cred: { email: acquired.email, password: acquired.password, refreshToken: acquired.refreshToken, clientId: acquired.clientId },
        email: acquired.email,
        password: acquired.password,
      };
    };
    // rentMail dep: thuê gmail dùng-một-lần từ SmsBower (flow đăng ký ChatGPT…).
    // getActivation lấy mail+mailId; trả mailbox có waitCode (poll getCode) +
    // success/cancel (setStatus 3/2) bám theo mailId + key. Luôn dựng; ném lỗi rõ
    // nếu chưa có key khi flow gọi ctx.rentMail().
    const rentMailDep = async (input: { service: string; profileName: string }) => {
      const key = settings.getSmsbowerKey();
      if (!key) throw new Error('Chưa cấu hình API key SmsBower (vào tab Mail)');
      // Dùng BATCH (count=1) thay vì thuê lẻ: mỗi mail có link getCodeBySignature
      // đọc all_codes NHIỀU LẦN (OpenAI gửi 2-3 mã) → chọn mã mới nhất chưa thử,
      // KHỎI request lại. (getActivation chỉ 1 mã/lần rồi khoá — không hợp.)
      const batch = await smsbower.getBatch(key, { service: input.service, domain: 'gmail.com', count: 1, time: 12 });
      const m = batch.mails[0];
      if (!m) throw new Error('SmsBower getBatch không trả mail nào');
      const tried = new Set<string>();
      // Poll link đọc mã tới khi có mã CHƯA THỬ; ưu tiên mã MỚI NHẤT (cuối mảng
      // all_codes). Dùng chung cho waitCode (mã đầu) lẫn nextCode (mã kế khi sai).
      const fetchNew = async (opts?: { tries?: number; intervalMs?: number }): Promise<string> => {
        const tries = opts?.tries ?? 40;
        const interval = opts?.intervalMs ?? 3_000;
        for (let i = 0; i < tries; i += 1) {
          const { allCodes, raw } = await smsbower.getCodeBySignature(m.url);
          // In MẪU phản hồi thô 1 lần (poll đầu) để lộ đúng cấu trúc JSON — nếu mã
          // về ở trường lạ thì thấy ngay, khỏi đoán.
          if (i === 0) log.info(`[${input.profileName}] SmsBower mẫu phản hồi đọc mã: ${JSON.stringify(raw).slice(0, 300)}`);
          for (let j = allCodes.length - 1; j >= 0; j -= 1) {
            if (!tried.has(allCodes[j])) {
              tried.add(allCodes[j]);
              log.info(`[${input.profileName}] SmsBower: đọc được mã ${allCodes[j]} cho ${m.mail} (poll ${i + 1}/${tries})`);
              return allCodes[j];
            }
          }
          // Log tiến trình (poll đầu + mỗi 5 lần) để KHÔNG im lặng suốt ~3 phút —
          // trước đây không log gì nên user tưởng tool "đứng" ở bước đọc mail.
          if (i === 0 || (i + 1) % 5 === 0) {
            log.info(`[${input.profileName}] SmsBower: chờ mã cho ${m.mail}... (poll ${i + 1}/${tries}, đã thấy ${allCodes.length} mã)`);
          }
          await new Promise((r) => setTimeout(r, interval));
        }
        throw new Error(`SmsBower: không nhận được mã mới cho ${m.mail} sau ${tries} lần đọc (all_codes hết mã chưa thử)`);
      };
      return {
        email: m.mail,
        mailId: `batch:${batch.batchId}`,
        waitCode: (opts?: { tries?: number; intervalMs?: number }) => fetchNew(opts),
        // nextCode: trả mã KHÁC (chưa thử) từ all_codes — không cần re-request.
        nextCode: (opts?: { tries?: number; intervalMs?: number }) => fetchNew(opts),
        success: async () => {}, // batch đã trả tiền, không cần chốt
        cancel: async () => {}, // batch không huỷ/hoàn lẻ được
      };
    };
    // Build the appendSheet dependency only when a Sheet webhook URL is configured.
    // POSTs one JSON row to the Apps Script web app; the runner wraps this so a
    // network hiccup logs + continues rather than failing the registration.
    const sheetUrl = settings.getSheetWebhookUrl();
    const appendSheetDep = sheetUrl
      ? async (row: unknown) => {
          const res = await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(row),
          });
          if (!res.ok) throw new Error(`Sheet webhook HTTP ${res.status}`);
        }
      : undefined;
    // Optional manager notification, separate from employee-topic distribution.
    // Keep it short and HTML-escaped so long checkout URLs/credentials cannot
    // break Telegram entity parsing.
    const tgToken = settings.getTelegramBotToken();
    const tgChatId = settings.getTelegramChatId();
    const notifyDep = tgToken && tgChatId
      ? async (row: SheetRow) => {
          const lines = [
            '✅ <b>CapCut đăng ký thành công</b>',
            row.email ? `📧 <code>${escapeTelegramHtml(row.email)}</code>` : '',
            row.checkoutUrl ? `💳 <a href="${escapeTelegramHtml(row.checkoutUrl)}">Link thanh toán</a>` : '',
          ].filter(Boolean);
          await telegramClient.sendMessage(tgToken, {
            chatId: tgChatId,
            text: lines.join('\n'),
            parseMode: 'HTML',
            disableLinkPreview: true,
          });
        }
      : undefined;
    // Ephemeral profiles: create N throwaway profiles now, run against them, and
    // delete them (with their browser data) in `finally` so nothing is left
    // behind — even if the flow throws. Fixed profiles are left untouched.
    // If the project set an ephemeralProxyPool, each temp profile launches in
    // pool mode: resolveProxy draws a fresh Live proxy (matching the tag filter)
    // per profile at open time — so N temp profiles get N different IPs instead
    // of all leaking the real one.
    const ephemeralPool = project.ephemeralProxyPool;
    const ephemeralIds: string[] = [];
    let distributionRunId: string | undefined;
    try {
      if (distribution) {
        const run = await telegramWork.startDistribution({
          projectId: project.id,
          projectName: project.name,
          allocations: distribution.allocations,
        });
        distributionRunId = run.id;
      }
      for (let i = 0; i < ephemeralCount; i += 1) {
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const created = await profiles.create({
          name: `tmp-${project.name}-${stamp}-${i + 1}`,
          proxyRotation: ephemeralPool
            ? { mode: 'pool', pool: ephemeralPool, rotateOnOpen: true, rotateOnFailure: true }
            : undefined,
          // ChatGPT: TẮT geoip + language 'real' (⇒ KHÔNG set locale gì cả). GỐC RỄ đã
          // probe xác nhận: Camoufox spoof Intl.DisplayNames theo "locale:region", và
          // hễ config CÓ locale:region (do geoip HAY ép locale sinh ra) thì spoof LỖI —
          // .of(bất kỳ mã nước nào) đều trả về CHÍNH nước của region đó. Dropdown quốc
          // gia ChatGPT build bằng Intl.DisplayNames.of(code) nên hiện "cả list 1 nước"
          // (US / NL / Việt Nam) → chọn sai. CHỈ khi config KHÔNG có locale:region
          // (geoip off + language 'real', không ép locale) thì DisplayNames mới đúng →
          // dropdown render đúng tên nước, selectCountry chọn được Netherlands.
          // Đánh đổi: timezone/geolocation không còn khớp IP proxy (chấp nhận cho flow
          // này; UI về mặc định Camoufox = en-US). Các flow khác GIỮ geoip như cũ.
          antiDetect:
            project.flowName === 'chatgpt-signup'
              ? { ...defaultAntiDetect(), geoip: false, language: 'real', blockImages: project.blockImages === true }
              : project.blockImages
                ? { ...defaultAntiDetect(), blockImages: true }
                : undefined,
        });
        ephemeralIds.push(created.id);
      }
      const runIds = project.profileIds.length ? project.profileIds : ephemeralIds;
      // Project chỉ ghi đè khi bật true headless. Khi tắt, giữ mặc định của
      // server: Electron=headful, Docker=virtual display.
      const runHeadless = project.headless === true ? true : headless;
      const results = await runProject(
        browsers,
        {
          profileIds: runIds,
          flowName: project.flowName,
          mail,
          mailProvider: project.mailProvider,
          buyAccountType: project.buyAccountType,
          buyQuality: project.buyQuality,
          buyProductId: project.buyProductId,
          mailStrategy: project.mailStrategy,
          mailStockTags: project.mailStockTags,
          smsbowerService: project.smsbowerService,
        },
        { concurrency: project.concurrency, headless: runHeadless, storeRoot },
        {
          buyMail: buyMailDep,
          settleMail: async (id, outcome) => {
            if (outcome.ok) await mails.markUsed(id);
            else await mails.markFailed(id, outcome.error || 'Flow thất bại sau khi cấp mail');
          },
          rentMail: rentMailDep,
          // Đợt phân phối ghi Sheet tổng + Sheet nhân viên trong cùng queue để
          // retry từng bước mà không tạo dòng trùng.
          appendSheet: distributionRunId ? undefined : appendSheetDep,
          notify: notifyDep,
          onResult: distributionRunId
            ? async (row, source) => {
                await telegramWork.enqueueCapcutResult(distributionRunId!, {
                  profileName: row.profileName,
                  email: row.email,
                  password: row.password,
                  mailLine: row.mailLine,
                  checkoutUrl: row.checkoutUrl!,
                  proxy: source.proxy,
                  proxyRecordId: source.proxyRecordId,
                  capcutCookies: source.capcutCookies,
                });
              }
            : undefined,
        },
      );
      res.json({ results, distributionRunId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    } finally {
      if (distributionRunId) await telegramWork.finishDistribution(distributionRunId).catch(() => {});
      // Tear down throwaway profiles + their userDataDir. Best-effort: a failed
      // delete shouldn't mask the run result.
      for (const id of ephemeralIds) {
        try {
          await browsers.close(id).catch(() => {});
          await profiles.delete(id, { wipeData: true });
        } catch (e) {
          log.warn(`xóa profile tạm ${id} lỗi: ${(e as Error).message}`);
        }
      }
    }
  }));
}
