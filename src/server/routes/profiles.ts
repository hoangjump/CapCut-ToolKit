import type { Express } from 'express';
import type { Request, Response } from 'express';
import type { ProfileManager } from '../../profileManager.js';
import type { BrowserManager } from '../../browserManager.js';
import {
  defaultAntiDetect, defaultBrowserSettings, defaultProxyRotation,
  type AntiDetectConfig, type BrowserSettings, type Profile, type ProxyRotation,
} from '../../types.js';


export interface ProfileRoutesDeps {
  profiles: ProfileManager;
  browsers: BrowserManager;
}

/** Hồ sơ Camoufox: CRUD, mở/đóng cửa sổ, xoay proxy. */
export function registerProfileRoutes(app: Express, { profiles, browsers }: ProfileRoutesDeps): void {
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
        proxyRotation: body.proxyRotation,
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

  // Xóa TẤT CẢ profile. Đóng mọi browser đang mở trước (ProfileManager không sở
  // hữu context) để không rớt lại tiến trình Chromium mồ côi. Phải đăng ký TRƯỚC
  // '/api/profiles/:id' để Express không bắt nhầm chuỗi rỗng thành :id.
  app.delete('/api/profiles', async (req: Request, res: Response) => {
    try {
      const wipeData = String(req.query.wipeData ?? '') === 'true';
      await browsers.closeAll();
      const removed = await profiles.deleteAll({ wipeData });
      res.json({ removed });
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
}
