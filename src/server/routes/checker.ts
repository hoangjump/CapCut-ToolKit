import type { Express, Request, Response } from 'express';
import { CheckerService, loadConfig, saveConfig, type CheckerConfig } from '../../checker/service.js';
import * as dvfb from '../../mailClient.js';
import * as stkClient from '../../selltaikhoanClient.js';

export interface CheckerRoutesDeps {
  storeRoot: string;
}

export function registerCheckerRoutes(app: Express, { storeRoot }: CheckerRoutesDeps): void {
  const checker = new CheckerService(storeRoot);

  // SSE — realtime logs + state
  app.get('/api/checker/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send current state + recent logs
    send(checker.getState());
    for (const entry of checker.getRecentLogs()) send(entry);

    const unsub = checker.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  // Config
  app.get('/api/checker/config', (_req: Request, res: Response) => {
    res.json(loadConfig(storeRoot));
  });

  app.post('/api/checker/config', (req: Request, res: Response) => {
    const updated = saveConfig(storeRoot, req.body as Partial<CheckerConfig>);
    res.json(updated);
  });

  // Run
  app.post('/api/checker/run', (req: Request, res: Response) => {
    if (checker.isRunning) {
      res.status(409).json({ error: 'Đang chạy rồi' });
      return;
    }

    const cfg = loadConfig(storeRoot);
    const { count, accounts } = req.body as { count?: number; accounts?: string };

    checker.run({ count, accounts, config: cfg }).catch(() => {});

    const total = cfg.teams.length
      ? cfg.teams.reduce((n, t) => n + t.count, 0)
      : count || cfg.count || 1;
    res.json({ ok: true, total });
  });

  // Stop
  app.post('/api/checker/stop', (_req: Request, res: Response) => {
    checker.requestStop();
    res.json({ ok: true });
  });

  // Balance
  app.get('/api/checker/balance', async (_req: Request, res: Response) => {
    const cfg = loadConfig(storeRoot);
    try {
      if (cfg.mailProvider === 'dvfb') {
        if (!cfg.dvfbApiKey) throw new Error('Chưa có API key Dongvanfb');
        const balance = await dvfb.getBalance(cfg.dvfbApiKey);
        res.json({ balance });
      } else {
        if (!cfg.stkApiKey) throw new Error('Chưa có API key Selltaikhoan');
        const balance = await stkClient.getBalance(cfg.stkApiKey);
        res.json({ balance });
      }
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Products
  app.get('/api/checker/products', async (req: Request, res: Response) => {
    const cfg = loadConfig(storeRoot);
    const provider = (req.query.provider as string) || cfg.mailProvider;
    try {
      if (provider === 'dvfb') {
        if (!cfg.dvfbApiKey) throw new Error('Chưa có API key Dongvanfb');
        const types = await dvfb.getAccountTypes(cfg.dvfbApiKey);
        res.json({ products: types });
      } else {
        if (!cfg.stkApiKey) throw new Error('Chưa có API key Selltaikhoan');
        const products = await stkClient.listProducts(cfg.stkApiKey);
        res.json({ products });
      }
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
