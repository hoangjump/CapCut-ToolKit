import type { Express } from 'express';
import type { Request, Response } from 'express';
import { ProxyStore, parseProxyLine, type ProxyRecord, type ProxyType } from '../../proxyStore.js';
import type { SettingsStore } from '../../settingsStore.js';
import * as mktproxy from '../../mktproxyClient.js';
import { createLogger } from '../../logger.js';
import { toDto } from '../dto.js';

const log = createLogger('server');

export interface MktproxyRoutesDeps {
  store: ProxyStore;
  settings: SettingsStore;
  ensureWhitelist: (apiKey: string) => Promise<void>;
}

/** Mua proxy từ mktproxy.com và nạp thẳng vào kho. */
export function registerMktproxyRoutes(app: Express, { store, settings, ensureWhitelist }: MktproxyRoutesDeps): void {
  // ---- mktproxy.com (mua proxy) ------------------------------------------
  // products is public; balance/buy/orders need the stored X-API-Key.
  function requireMktKey(res: Response): string | null {
    const key = settings.getMktproxyKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key mktproxy (vào phần Cài đặt).' });
      return null;
    }
    return key;
  }

  app.get('/api/mktproxy/products', async (_req: Request, res: Response) => {
    try {
      res.json({ products: await mktproxy.listProducts(settings.getMktproxyKey()) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mktproxy/balance', async (_req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    try {
      res.json({ balance: await mktproxy.getBalance(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mktproxy/orders', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      res.json({ orders: await mktproxy.listOrders(key, { status }) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mktproxy/orders/:code', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    try {
      res.json(await mktproxy.getOrder(key, String(req.params.code)));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Import an order's delivered proxies into the ProxyStore library (dùng ngay ở
  // chế độ pool). Idempotent-ish: skips proxies whose host:port already exist.
  // PROXY XOAY: item chỉ có `key` (chưa kèm chuỗi proxy) — đơn xoay trả gateway
  // qua endpoint riêng. Ta gọi /proxies/new (đọc cache); nếu đơn mới chưa kích
  // hoạt (NO_PROXY_DATA) thì gọi /proxies/rotate-ip để lấy proxy lần đầu, rồi
  // chọn biến thể http/socks5 theo `type`.
  async function importProxiesToStore(
    proxies: mktproxy.MktProxyItem[],
    type: ProxyType,
    tags: string[],
  ): Promise<ProxyRecord[]> {
    const existing = new Set(store.list().map((p) => `${p.host}:${p.port}`));
    const created: ProxyRecord[] = [];
    for (const item of proxies) {
      let line = (item.proxy || '').trim();
      let itemType: ProxyType = type;
      // viaApi: đơn xoay giao qua key (không kèm chuỗi sẵn) — resolve IP hiện tại
      // và ĐÁNH DẤU là proxy dạng API (giữ key để Test/xoay lại sau này).
      const viaApi = !line && !!item.key;
      if (viaApi && item.key) {
        await ensureWhitelist(item.key);
        try {
          // rotate-ip để kích hoạt egress (xem ghi chú ở refreshApiProxy).
          let rp = await mktproxy.rotateIp(item.key).catch(() => null);
          if (!rp || !rp.value) rp = await mktproxy.getCurrentProxy(item.key).catch(() => null);
          // Lưu đúng protocol NCC trả (tránh ECONNRESET do sai giao thức).
          itemType = rp?.protocol === 'socks5' ? 'socks5' : rp?.protocol === 'http' ? 'http' : type;
          line = ((itemType === 'socks5' ? rp?.socks5 : rp?.http) || rp?.value || '').trim();
          log.info(`mktproxy: proxy xoay (key ${item.key.slice(0, 6)}…) → ${line || 'chưa lấy được'} [${itemType}]`);
        } catch (e) {
          log.warn(`mktproxy: lấy proxy xoay lỗi (key ${item.key.slice(0, 6)}…): ${(e as Error).message}`);
        }
      }
      if (!line) continue;
      let parsed;
      try {
        parsed = parseProxyLine(line);
      } catch {
        continue; // dòng proxy không parse được thì bỏ qua
      }
      if (existing.has(`${parsed.host}:${parsed.port}`)) continue;
      created.push(await store.create({
        type: itemType, tags, ...parsed,
        ...(viaApi ? { apiProvider: 'mktproxy' as const, apiKey: item.key } : {}),
      }));
      existing.add(`${parsed.host}:${parsed.port}`);
    }
    return created;
  }

  // Buy proxy(s) then poll the order until delivered, importing the resulting
  // proxies into the library. Body: { productCode, quantity?, duration?,
  // protocol?, customFields?, tags?, ipWhitelist? }.
  app.post('/api/mktproxy/buy', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    const body = req.body ?? {};
    if (!body.productCode) {
      res.status(400).json({ error: 'productCode là bắt buộc' });
      return;
    }
    const protocol = body.protocol === 'socks5' ? 'socks5' : body.protocol === 'http' ? 'http' : undefined;
    const importType: ProxyType = protocol === 'socks5' ? 'socks5' : 'http';
    const tags: string[] = Array.isArray(body.tags)
      ? body.tags.map(String).map((t: string) => t.trim()).filter(Boolean)
      : typeof body.tags === 'string' && body.tags.trim()
        ? body.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : ['mktproxy'];
    try {
      const buy = await mktproxy.buyProxy(key, {
        productCode: String(body.productCode),
        quantity: body.quantity !== undefined ? Number(body.quantity) : undefined,
        duration: body.duration !== undefined ? Number(body.duration) : undefined,
        protocol,
        customFields: body.customFields && typeof body.customFields === 'object' ? body.customFields : undefined,
        externalRef: body.externalRef ? String(body.externalRef) : undefined,
        ipWhitelist: Array.isArray(body.ipWhitelist) ? body.ipWhitelist.map(String) : undefined,
      });

      // Collect delivered proxies: from the buy response if present, else poll
      // GET /orders/{code} until in_use (max ~30s) — some products provision async.
      let proxies = buy.proxies;
      let orderStatus = 'delivered';
      if (proxies.length === 0 && buy.orderCode) {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const order = await mktproxy.getOrder(key, buy.orderCode);
          orderStatus = order.status;
          if (order.proxies.length) {
            proxies = order.proxies;
            break;
          }
          if (['failed', 'expired'].includes(order.status)) break;
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }

      const imported = await importProxiesToStore(proxies, importType, tags);
      log.info(`mktproxy buy: đơn ${buy.orderCode || '—'} status=${orderStatus} nhận=${proxies.length} nạp=${imported.length}`);
      if (!imported.length) {
        log.warn(`mktproxy buy: NẠP 0 PROXY. items=${JSON.stringify(proxies)} rawBuy=${JSON.stringify(buy.raw).slice(0, 600)}`);
      }
      res.json({
        orderCode: buy.orderCode,
        orderStatus,
        delivered: proxies.length,
        imported: imported.length,
        proxies: imported.map(toDto),
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Import an already-completed order's proxies (khi mua async chưa kịp giao lúc
  // bấm Mua, dùng nút này để nạp sau). Body: { tags?, protocol? }.
  app.post('/api/mktproxy/orders/:code/import', async (req: Request, res: Response) => {
    const key = requireMktKey(res);
    if (!key) return;
    const body = req.body ?? {};
    const type: ProxyType = body.protocol === 'socks5' ? 'socks5' : 'http';
    const tags: string[] = Array.isArray(body.tags)
      ? body.tags.map(String).map((t: string) => t.trim()).filter(Boolean)
      : ['mktproxy'];
    try {
      const order = await mktproxy.getOrder(key, String(req.params.code));
      const imported = await importProxiesToStore(order.proxies, type, tags);
      res.json({ orderStatus: order.status, delivered: order.proxies.length, imported: imported.length, proxies: imported.map(toDto) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}
