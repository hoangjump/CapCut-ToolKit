import type { Express } from 'express';
import type { Request, Response } from 'express';
import { ProxyStore, parseProxyLine, proxyDisplay, type ProxyRecord, type ProxyType } from '../../proxyStore.js';
import { checkProxy } from '../../proxyChecker.js';
import { toDto } from '../dto.js';
import { asyncHandler } from '../http.js';

const VALID_TYPES: ProxyType[] = ['http', 'https', 'socks5'];

export interface ProxyRoutesDeps {
  store: ProxyStore;
  refreshApiProxy: (proxy: ProxyRecord) => Promise<ProxyRecord>;
}

/** Kho proxy: thêm/sửa/xoá, kiểm tra sống chết, xoay IP proxy dạng API. */
export function registerProxyRoutes(app: Express, { store, refreshApiProxy }: ProxyRoutesDeps): void {
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

      // Proxy dạng API (mktproxy xoay): tạo entry giữ key đơn hàng, rồi resolve
      // IP hiện tại qua /proxies/new để điền host/port + xác thực key. Key sai /
      // chưa có IP → xóa entry và báo lỗi.
      if (body.apiProvider === 'mktproxy' && body.apiKey) {
        const rec = await store.create({
          type, tags, host: '', port: 0,
          apiProvider: 'mktproxy', apiKey: String(body.apiKey).trim(),
        });
        const refreshed = await refreshApiProxy(rec);
        if (!refreshed.host) {
          await store.delete(rec.id);
          res.status(400).json({ error: 'Key proxy API không hợp lệ hoặc chưa có IP (đơn mới thử lại sau vài giây).' });
          return;
        }
        res.status(201).json([toDto(refreshed)]);
        return;
      }

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

  // Xóa hàng loạt: body {ids: string[]} xóa các id đó; không body = xóa SẠCH kho.
  // Đăng ký TRƯỚC '/api/proxies/:id' để "proxies" không bị bắt nhầm thành :id.
  app.delete('/api/proxies', async (req: Request, res: Response) => {
    try {
      const ids = req.body?.ids;
      const removed = Array.isArray(ids) ? await store.deleteMany(ids.map(String)) : await store.clear();
      res.json({ removed });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
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

  // Proxy dạng API (mktproxy xoay): resolve IP hiện tại qua /proxies/new (fallback
  // /rotate-ip) rồi cập nhật ảnh chụp host/port/user/pass trên record để check +
  // để profile dùng bản mới nhất. Proxy tĩnh: trả nguyên record. Lỗi API thì giữ
  // ảnh chụp cũ (vẫn check được gateway).
  // Check a single proxy and persist the result. Proxy API được resolve IP mới trước.
  app.post('/api/proxies/:id/check', asyncHandler(async (req, res) => {
    let proxy = store.get(String(req.params.id));
    if (!proxy) {
      res.status(404).json({ error: 'Proxy not found' });
      return;
    }
    proxy = await refreshApiProxy(proxy);
    const result = await checkProxy(proxy);
    const updated = await store.update(proxy.id, {
      alive: result.alive,
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString(),
    });
    res.json({ ...toDto(updated), checkResult: result });
  }));

  // Check every proxy concurrently (bounded) — used by the "Làm mới" button.
  app.post('/api/proxies/check-all', asyncHandler(async (_req, res) => {
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
  }));
}
