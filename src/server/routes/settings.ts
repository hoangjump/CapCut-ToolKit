import type { Express } from 'express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProxyStore } from '../../proxyStore.js';
import type { ProfileManager } from '../../profileManager.js';
import type { MailStore } from '../../mailStore.js';
import type { ProjectStore } from '../../projectStore.js';
import { SettingsStore, maskKey } from '../../settingsStore.js';
import { tileNow } from '../../windowTiler.js';


export interface SettingsRoutesDeps {
  store: ProxyStore;
  profiles: ProfileManager;
  mails: MailStore;
  projects: ProjectStore;
  settings: SettingsStore;
  storeRoot: string;
}

/** Cài đặt app + xuất/nhập toàn bộ store. */
export function registerSettingsRoutes(app: Express, { store, profiles, mails, projects, settings, storeRoot }: SettingsRoutesDeps): void {
  // ---- Settings ----------------------------------------------------------
  // API key bills real money — never return it raw, only a masked preview.
  function settingsDto() {
    return {
      hasKey: Boolean(settings.getApiKey()),
      masked: maskKey(settings.getApiKey()),
      sheetWebhookUrl: settings.getSheetWebhookUrl() ?? '',
      hasMktproxyKey: Boolean(settings.getMktproxyKey()),
      mktproxyMasked: maskKey(settings.getMktproxyKey()),
      hasSelltaikhoanKey: Boolean(settings.getSelltaikhoanKey()),
      selltaikhoanMasked: maskKey(settings.getSelltaikhoanKey()),
      hasSmsbowerKey: Boolean(settings.getSmsbowerKey()),
      smsbowerMasked: maskKey(settings.getSmsbowerKey()),
      hasTempmailToken: Boolean(settings.getTempmailToken()),
      tempmailMasked: maskKey(settings.getTempmailToken()),
      hasTelegram: Boolean(settings.getTelegramBotToken() && settings.getTelegramChatId()),
      telegramMasked: maskKey(settings.getTelegramBotToken()),
      telegramChatId: settings.getTelegramChatId() ?? '',
    };
  }

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(settingsDto());
  });

  app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (body.dongvanfbApiKey !== undefined) {
        await settings.setApiKey(String(body.dongvanfbApiKey));
      }
      if (body.sheetWebhookUrl !== undefined) {
        await settings.setSheetWebhookUrl(String(body.sheetWebhookUrl));
      }
      if (body.mktproxyApiKey !== undefined) {
        await settings.setMktproxyKey(String(body.mktproxyApiKey));
      }
      if (body.selltaikhoanApiKey !== undefined) {
        await settings.setSelltaikhoanKey(String(body.selltaikhoanApiKey));
      }
      if (body.smsbowerApiKey !== undefined) {
        await settings.setSmsbowerKey(String(body.smsbowerApiKey));
      }
      if (body.tempmailApiToken !== undefined) {
        await settings.setTempmailToken(String(body.tempmailApiToken));
      }
      if (body.telegramBotToken !== undefined) {
        await settings.setTelegramBotToken(String(body.telegramBotToken));
      }
      if (body.telegramChatId !== undefined) {
        await settings.setTelegramChatId(String(body.telegramChatId));
      }
      res.json(settingsDto());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- Export / Import toàn bộ store (5 file JSON) -----------------------
  // Gói: profiles + projects + proxies + mails + settings. KHÔNG gồm thư mục
  // data/ (session từng hồ sơ) và shots/ — chỉ cấu hình, cho nhẹ & dễ chuyển máy.
  // LƯU Ý BẢO MẬT: settings.json chứa API key thật (mktproxy/dongvanfb/telegram)
  // ở dạng thô — file export mang theo secret, giữ kín như mật khẩu.
  const STORE_FILES = ['profiles', 'projects', 'proxies', 'mails', 'settings'] as const;

  app.get('/api/store/export', async (req: Request, res: Response) => {
    try {
      // settings.json chứa API key thô. Mặc định KHÔNG kèm vào file export: gõ
      // nhầm URL hay bookmark cũ không được phép hút secret ra. Chuyển máy thật
      // thì thêm ?secrets=1 — chủ ý rõ ràng, và file tải về phải giữ như mật khẩu.
      const includeSecrets = ['1', 'true', 'yes'].includes(String(req.query.secrets ?? '').toLowerCase());
      const bundle: Record<string, unknown> = {
        _format: 'teamhatde-store',
        _version: 1,
        _exportedAt: new Date().toISOString(),
        _secrets: includeSecrets,
      };
      for (const name of STORE_FILES) {
        if (name === 'settings' && !includeSecrets) {
          bundle[name] = {};
          continue;
        }
        const file = join(storeRoot, `${name}.json`);
        if (existsSync(file)) {
          bundle[name] = JSON.parse(await readFile(file, 'utf8'));
        } else {
          bundle[name] = name === 'settings' ? {} : [];
        }
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="teamhatde-backup-${stamp}.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Gộp theo id, GIỮ bản đang có (imported chỉ thêm id mới). Với settings: giữ
  // key đang có, chỉ thêm key còn thiếu. Ghi file xong nạp lại store để vào RAM.
  app.post('/api/store/import', async (req: Request, res: Response) => {
    try {
      const bundle = req.body ?? {};
      if (bundle._format && bundle._format !== 'teamhatde-store') {
        res.status(400).json({ error: 'File không đúng định dạng backup của app.' });
        return;
      }
      const added: Record<string, number> = {};

      for (const name of ['profiles', 'projects', 'proxies', 'mails'] as const) {
        const incoming = bundle[name];
        if (!Array.isArray(incoming)) continue;
        const file = join(storeRoot, `${name}.json`);
        const current: Array<{ id?: string }> = existsSync(file)
          ? JSON.parse(await readFile(file, 'utf8'))
          : [];
        const seen = new Set(current.map((it) => it.id).filter(Boolean));
        let n = 0;
        for (const item of incoming as Array<{ id?: string }>) {
          if (item && item.id && !seen.has(item.id)) {
            current.push(item);
            seen.add(item.id);
            n += 1;
          }
        }
        added[name] = n;
        await writeFile(file, JSON.stringify(current, null, 2), 'utf8');
      }

      // settings: chỉ thêm key còn thiếu, không đè key đang có.
      if (bundle.settings && typeof bundle.settings === 'object') {
        const file = join(storeRoot, 'settings.json');
        const current: Record<string, unknown> = existsSync(file)
          ? JSON.parse(await readFile(file, 'utf8'))
          : {};
        let n = 0;
        for (const [k, v] of Object.entries(bundle.settings)) {
          if (current[k] === undefined && v !== undefined) {
            current[k] = v;
            n += 1;
          }
        }
        added.settings = n;
        await writeFile(file, JSON.stringify(current, null, 2), 'utf8');
      }

      // Nạp lại tất cả store từ đĩa vào Map trong RAM.
      await Promise.all([
        store.init(),
        profiles.init(),
        projects.init(),
        mails.init(),
        settings.init(),
      ]);

      res.json({ ok: true, added });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Sắp xếp lại cửa sổ Camoufox thành lưới (thủ công). No-op ngoài Windows.
  app.post('/api/windows/tile', async (_req: Request, res: Response) => {
    try {
      await tileNow();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
