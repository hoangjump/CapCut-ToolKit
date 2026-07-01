import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ProxyStore,
  parseProxyLine,
  proxyDisplay,
  type ProxyRecord,
  type ProxyType,
} from '../proxyStore.js';
import { checkProxy } from '../proxyChecker.js';
import { ProfileManager } from '../profileManager.js';
import { BrowserManager } from '../browserManager.js';
import { MailStore, parseMailLine, providerFromEmail } from '../mailStore.js';
import { SettingsStore, maskKey } from '../settingsStore.js';
import { getBalance, buyMail, getCode, getMessages } from '../mailClient.js';
import { ProjectStore } from '../projectStore.js';
import { runProject } from '../automation/runner.js';
import { flowMetas } from '../flows/index.js';
import {
  defaultAntiDetect,
  defaultBrowserSettings,
  defaultProxyRotation,
  type AntiDetectConfig,
  type BrowserSettings,
  type MailCodeType,
  type Profile,
  type ProjectRecord,
  type ProxyRotation,
} from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('server');
const PORT = Number(process.env.PORT ?? 3000);
const STORE_ROOT = process.env.STORE_ROOT ?? join(process.cwd(), 'profiles-store');
// Browser display mode. Camoufox (Firefox) is most convincing headful; its true
// headless mode has detectable tells. In a container (no X server) we run it
// headful inside a virtual display (Xvfb) instead of going truly headless.
//   HEADLESS=false   -> headful (a real on-screen window; local dev)
//   HEADLESS=virtual -> headful inside Xvfb (containers; the production default)
//   HEADLESS=true    -> true headless (fastest, but most detectable)
// Default when unset: 'virtual' in production (Docker), headful locally.
function parseHeadless(): boolean | 'virtual' {
  const env = process.env.HEADLESS;
  if (env === undefined) return process.env.NODE_ENV === 'production' ? 'virtual' : false;
  if (env === 'false') return false;
  if (env === 'virtual') return 'virtual';
  return true;
}
const HEADLESS = parseHeadless();

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx) __dirname = src/server; in prod (tsc) = dist/server. UI lives at
// <projectRoot>/public in both cases.
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

const VALID_TYPES: ProxyType[] = ['http', 'https', 'socks5'];

/** Shape returned to the UI — adds derived display string + status label. */
function toDto(p: ProxyRecord) {
  return {
    ...p,
    display: proxyDisplay(p),
    status: p.alive === null ? 'unchecked' : p.alive ? 'live' : 'dead',
  };
}

async function main(): Promise<void> {
  const store = new ProxyStore(STORE_ROOT);
  await store.init();

  const profiles = new ProfileManager(STORE_ROOT);
  await profiles.init();

  const browsers = new BrowserManager(profiles, store, { headless: HEADLESS });

  const mails = new MailStore(STORE_ROOT);
  await mails.init();

  const settings = new SettingsStore(STORE_ROOT);
  await settings.init();

  const projects = new ProjectStore(STORE_ROOT);
  await projects.init();

  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/proxies', (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').toLowerCase().trim();
    let list = store.list();
    if (q) {
      list = list.filter((p) => {
        const hay = `${proxyDisplay(p)} ${p.type} ${p.tags.join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    }
    res.json(list.map(toDto));
  });

  // Create one or many. Accepts {type, host, port, ...} OR {type, lines, tags}
  // where `lines` is a newline/comma separated blob of host:port:user:pass.
  app.post('/api/proxies', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const type: ProxyType = VALID_TYPES.includes(body.type) ? body.type : 'socks5';
      const tags: string[] = Array.isArray(body.tags)
        ? body.tags
        : typeof body.tags === 'string' && body.tags.trim()
          ? body.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
          : [];

      const created: ProxyRecord[] = [];
      if (typeof body.lines === 'string' && body.lines.trim()) {
        const lines = body.lines.split(/[\n,]+/).map((l: string) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const parsed = parseProxyLine(line);
          created.push(await store.create({ type, tags, ...parsed }));
        }
      } else {
        const port = Number(body.port);
        if (!body.host || !Number.isInteger(port)) {
          res.status(400).json({ error: 'host và port là bắt buộc' });
          return;
        }
        created.push(
          await store.create({
            type,
            host: String(body.host),
            port,
            username: body.username || undefined,
            password: body.password || undefined,
            tags,
          }),
        );
      }
      res.status(201).json(created.map(toDto));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/proxies/:id', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const patch: Partial<ProxyRecord> = {};
      if (body.type && VALID_TYPES.includes(body.type)) patch.type = body.type;
      if (body.host) patch.host = String(body.host);
      if (body.port !== undefined) patch.port = Number(body.port);
      if (body.username !== undefined) patch.username = body.username || undefined;
      if (body.password !== undefined) patch.password = body.password || undefined;
      if (body.tags !== undefined) {
        patch.tags = Array.isArray(body.tags)
          ? body.tags
          : String(body.tags).split(',').map((t) => t.trim()).filter(Boolean);
      }
      const updated = await store.update(String(req.params.id), patch);
      res.json(toDto(updated));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/proxies/:id', async (req: Request, res: Response) => {
    try {
      await store.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Check a single proxy and persist the result.
  app.post('/api/proxies/:id/check', async (req: Request, res: Response) => {
    const proxy = store.get(String(req.params.id));
    if (!proxy) {
      res.status(404).json({ error: 'Proxy not found' });
      return;
    }
    const result = await checkProxy(proxy);
    const updated = await store.update(proxy.id, {
      alive: result.alive,
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString(),
    });
    res.json({ ...toDto(updated), checkResult: result });
  });

  // Check every proxy concurrently (bounded) — used by the "Làm mới" button.
  app.post('/api/proxies/check-all', async (_req: Request, res: Response) => {
    const all = store.list();
    const concurrency = 8;
    let i = 0;
    const worker = async () => {
      while (i < all.length) {
        const proxy = all[i++];
        const result = await checkProxy(proxy);
        await store.update(proxy.id, {
          alive: result.alive,
          latencyMs: result.latencyMs,
          checkedAt: new Date().toISOString(),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, worker));
    res.json(store.list().map(toDto));
  });

  // ---- Profiles ----------------------------------------------------------
  app.get('/api/profiles', (_req: Request, res: Response) => {
    res.json(profiles.list());
  });

  // Ids of profiles whose browser context is currently open. Must be registered
  // before '/api/profiles/:id' so "running" isn't captured as an id.
  app.get('/api/profiles/running', (_req: Request, res: Response) => {
    res.json({ running: browsers.openProfileIds() });
  });

  app.get('/api/profiles/:id', (req: Request, res: Response) => {
    const profile = profiles.get(String(req.params.id));
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json(profile);
  });

  app.post('/api/profiles', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (!body.name || !String(body.name).trim()) {
        res.status(400).json({ error: 'name là bắt buộc' });
        return;
      }
      const created = await profiles.create({
        name: String(body.name).trim(),
        group: typeof body.group === 'string' ? body.group.trim() || undefined : undefined,
        taskbarTitle: typeof body.taskbarTitle === 'string' ? body.taskbarTitle.trim() || undefined : undefined,
        proxy: body.proxy,
        antiDetect: body.antiDetect,
        browser: body.browser,
        notes: body.notes,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Merge anti-detect / browser settings so the UI can PATCH a subset.
  app.put('/api/profiles/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const existing = profiles.get(id);
      if (!existing) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }
      const body = req.body ?? {};
      const patch: Partial<Omit<Profile, 'id' | 'createdAt'>> = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (body.group !== undefined) patch.group = String(body.group).trim() || undefined;
      if (body.taskbarTitle !== undefined) patch.taskbarTitle = String(body.taskbarTitle).trim() || undefined;
      if (body.proxy !== undefined) patch.proxy = body.proxy || undefined;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.antiDetect && typeof body.antiDetect === 'object') {
        patch.antiDetect = {
          ...(existing.antiDetect ?? defaultAntiDetect()),
          ...(body.antiDetect as Partial<AntiDetectConfig>),
        };
      }
      if (body.browser && typeof body.browser === 'object') {
        patch.browser = {
          ...(existing.browser ?? defaultBrowserSettings()),
          ...(body.browser as Partial<BrowserSettings>),
        };
      }
      if (body.proxyRotation && typeof body.proxyRotation === 'object') {
        patch.proxyRotation = {
          ...(existing.proxyRotation ?? defaultProxyRotation()),
          ...(body.proxyRotation as Partial<ProxyRotation>),
        };
      }
      const updated = await profiles.update(id, patch);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/profiles/:id', async (req: Request, res: Response) => {
    try {
      const wipeData = String(req.query.wipeData ?? '') === 'true';
      await profiles.delete(String(req.params.id), { wipeData });
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Launch a profile's browser context (idempotent — returns ok if already open).
  app.post('/api/profiles/:id/open', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!profiles.get(id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    try {
      await browsers.open(id);
      res.json({ id, running: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Close a profile's browser context, flushing its session to disk.
  app.post('/api/profiles/:id/close', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      await browsers.close(id);
      res.json({ id, running: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Rotate a profile's proxy (pool: draw fresh; gateway: new session). If open,
  // the profile is closed + reopened so the new IP applies immediately. 400 for
  // 'static' (nothing to rotate) or an exhausted pool.
  app.post('/api/profiles/:id/rotate-proxy', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!profiles.get(id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    try {
      await browsers.rotate(id, 'manual');
      const updated = profiles.get(id);
      const proxy = updated?.proxy ? updated.proxy.server : null;
      res.json({ id, proxy, running: browsers.isOpen(id) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- Settings ----------------------------------------------------------
  // API key bills real money — never return it raw, only a masked preview.
  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json({ hasKey: Boolean(settings.getApiKey()), masked: maskKey(settings.getApiKey()) });
  });

  app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (body.dongvanfbApiKey !== undefined) {
        await settings.setApiKey(String(body.dongvanfbApiKey));
      }
      res.json({ hasKey: Boolean(settings.getApiKey()), masked: maskKey(settings.getApiKey()) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- Mail (dongvanfb) ---------------------------------------------------
  // Read/code endpoints need no API key (email+refresh+client auth); only
  // balance/buy hit api.dongvanfb.net with the stored key.
  function requireApiKey(res: Response): string | null {
    const key = settings.getApiKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key dongvanfb (vào phần Cài đặt).' });
      return null;
    }
    return key;
  }

  app.get('/api/mail/balance', async (_req: Request, res: Response) => {
    const key = requireApiKey(res);
    if (!key) return;
    try {
      res.json({ balance: await getBalance(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mail/buy', async (req: Request, res: Response) => {
    const key = requireApiKey(res);
    if (!key) return;
    const body = req.body ?? {};
    if (!body.accountType || !body.quality) {
      res.status(400).json({ error: 'accountType và quality là bắt buộc' });
      return;
    }
    try {
      const result = await buyMail(key, {
        accountType: String(body.accountType),
        quality: String(body.quality),
      });
      const created = await mails.createMany(
        result.mails.map((m) => ({
          email: m.email,
          password: m.password,
          refreshToken: m.refreshToken,
          clientId: m.clientId,
          provider: providerFromEmail(m.email),
          orderCode: result.orderCode,
        })),
      );
      res.json({
        orderCode: result.orderCode,
        price: result.price,
        balance: result.balance,
        bought: result.mails.length,
        added: created.length,
        mails: created,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mails', (_req: Request, res: Response) => {
    res.json(mails.list());
  });

  app.post('/api/mails', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (typeof body.line === 'string' && body.line.trim()) {
        res.status(201).json(await mails.create(parseMailLine(body.line)));
        return;
      }
      if (!body.email || !body.refreshToken || !body.clientId) {
        res.status(400).json({ error: 'Cần email|password|refresh_token|client_id (hoặc các field email/refreshToken/clientId)' });
        return;
      }
      const created = await mails.create({
        email: String(body.email).trim(),
        password: body.password ? String(body.password) : undefined,
        refreshToken: String(body.refreshToken).trim(),
        clientId: String(body.clientId).trim(),
        note: body.note ? String(body.note) : undefined,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/mails/:id', async (req: Request, res: Response) => {
    try {
      await mails.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mails/:id/code', async (req: Request, res: Response) => {
    const mail = mails.get(String(req.params.id));
    if (!mail) {
      res.status(404).json({ error: 'Mail not found' });
      return;
    }
    const type = (String(req.body?.type ?? 'all')) as MailCodeType;
    try {
      const result = await getCode({
        email: mail.email,
        refreshToken: mail.refreshToken,
        clientId: mail.clientId,
        type,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mails/:id/messages', async (req: Request, res: Response) => {
    const mail = mails.get(String(req.params.id));
    if (!mail) {
      res.status(404).json({ error: 'Mail not found' });
      return;
    }
    try {
      const messages = await getMessages({
        email: mail.email,
        refreshToken: mail.refreshToken,
        clientId: mail.clientId,
      });
      res.json({ messages });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Ad-hoc code fetch for the profile panel — credentials passed inline, no
  // stored mail needed. Still no API key required (tools.* auth).
  app.post('/api/mail/code', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!body.email || !body.refresh_token || !body.client_id) {
      res.status(400).json({ error: 'Cần email, refresh_token, client_id' });
      return;
    }
    try {
      const result = await getCode({
        email: String(body.email).trim(),
        refreshToken: String(body.refresh_token).trim(),
        clientId: String(body.client_id).trim(),
        type: (String(body.type ?? 'all')) as MailCodeType,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- Flows (automation) -------------------------------------------------
  // Flows are TS code in src/flows/; this just exposes their metadata so the
  // Project tab can populate the flow dropdown.
  app.get('/api/flows', (_req: Request, res: Response) => {
    res.json(flowMetas());
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
  app.post('/api/projects/:id/run', async (req: Request, res: Response) => {
    const project = projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!project.profileIds.length) {
      res.status(400).json({ error: 'Project chưa chọn profile nào' });
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
      mail = { email: rec.email, refreshToken: rec.refreshToken, clientId: rec.clientId };
    }
    try {
      const results = await runProject(
        browsers,
        { profileIds: project.profileIds, flowName: project.flowName, mail },
        { concurrency: project.concurrency, headless: false, storeRoot: STORE_ROOT },
      );
      res.json({ results });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.listen(PORT, () => {
    log.info(`proxy manager listening on http://localhost:${PORT}`);
    log.info(`serving UI from ${PUBLIC_DIR}`);
  });
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
