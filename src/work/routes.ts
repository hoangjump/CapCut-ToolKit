import type { Express, Request, Response } from 'express';
import type { TelegramUpdate } from './types.js';
import type { TelegramWorkService } from './service.js';
import { parsePaymentBrowserInput, type PaymentSessionService } from './paymentSessions.js';
import type { TunnelManager } from '../server/tunnelManager.js';

function error(res: Response, err: unknown, status = 400): void {
  res.status(status).json({ error: (err as Error).message });
}

export function registerTelegramWorkRoutes(
  app: Express,
  service: TelegramWorkService,
  payments?: PaymentSessionService,
  tunnel?: TunnelManager,
): void {
  const config = () => ({ ...service.configDto(), tunnel: tunnel?.status() });
  app.get('/api/work/config', (_req, res) => res.json(config()));
  app.put('/api/work/config', async (req, res) => {
    try { await service.saveConfig(req.body ?? {}); res.json(config()); } catch (err) { error(res, err); }
  });
  app.post('/api/work/config/polling', async (_req, res) => {
    try { await service.enablePolling(); res.json(config()); } catch (err) { error(res, err); }
  });
  app.post('/api/work/config/webhook', async (req, res) => {
    try { await service.configureWebhook(String(req.body?.url ?? '')); res.json(config()); } catch (err) { error(res, err); }
  });
  app.post('/api/work/config/off', async (_req, res) => {
    try { await service.disableTelegram(); res.json(config()); } catch (err) { error(res, err); }
  });

  if (tunnel) {
    app.get('/api/work/tunnel', (_req, res) => res.json(tunnel.status()));
    app.post('/api/work/tunnel/start', async (_req, res) => {
      try { res.json(await tunnel.start(true)); } catch (err) { error(res, err, 503); }
    });
    app.post('/api/work/tunnel/stop', async (_req, res) => {
      try { res.json(await tunnel.stop(true)); } catch (err) { error(res, err, 500); }
    });
  }

  app.post('/api/work/telegram/webhook', async (req: Request, res: Response) => {
    const secret = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!service.isWebhookSecretValid(secret)) {
      res.status(401).json({ error: 'Webhook secret không hợp lệ' });
      return;
    }
    try {
      await service.processUpdate(req.body as TelegramUpdate);
      res.json({ ok: true });
    } catch (err) {
      error(res, err, 500);
    }
  });

  if (payments) {
    app.get('/api/work/payment-control', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(payments.control());
    });
    app.get('/api/work/payment-control/:id/frame', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      try { res.type('image/jpeg').send(await payments.controlFrame(String(req.params.id))); } catch (err) { error(res, err, 409); }
    });
    app.post('/api/work/payment-control/:id/input', async (req, res) => {
      try {
        await payments.controlInput(String(req.params.id), parsePaymentBrowserInput(req.body));
        res.status(204).end();
      } catch (err) { error(res, err, 409); }
    });
    app.delete('/api/work/payment-control/:id', async (req, res) => {
      try { await payments.closeById(String(req.params.id)); res.status(204).end(); } catch (err) { error(res, err, 404); }
    });

    app.get('/api/work/payment-sessions/:token', (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(payments.getByToken(String(req.params.token))); } catch (err) { error(res, err, 404); }
    });
    app.post('/api/work/payment-sessions/:token/claim', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(await payments.claim(String(req.params.token))); } catch (err) { error(res, err); }
    });
    app.get('/api/work/payment-sessions/:token/frame', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      try { res.type('image/jpeg').send(await payments.frame(String(req.params.token))); } catch (err) { error(res, err, 409); }
    });
    app.post('/api/work/payment-sessions/:token/input', async (req, res) => {
      try {
        await payments.input(String(req.params.token), parsePaymentBrowserInput(req.body));
        res.status(204).end();
      } catch (err) { error(res, err, 409); }
    });
    app.delete('/api/work/payment-sessions/:token', async (req, res) => {
      try { await payments.closeByToken(String(req.params.token)); res.status(204).end(); } catch (err) { error(res, err, 404); }
    });
  }

  app.get('/api/work/employees', (_req, res) => res.json(service.listEmployees()));
  app.post('/api/work/employees', async (req, res) => {
    try { res.status(201).json(await service.createEmployee(req.body ?? {})); } catch (err) { error(res, err); }
  });
  app.put('/api/work/employees/:id', async (req, res) => {
    try { res.json(await service.updateEmployee(String(req.params.id), req.body ?? {})); } catch (err) { error(res, err); }
  });
  app.delete('/api/work/employees/:id', async (req, res) => {
    try { await service.archiveEmployee(String(req.params.id)); res.status(204).end(); } catch (err) { error(res, err); }
  });
  app.post('/api/work/employees/:id/regenerate-bind', async (req, res) => {
    try { res.json(await service.regenerateBindCode(String(req.params.id))); } catch (err) { error(res, err); }
  });
  app.post('/api/work/employees/:id/create-topic', async (req, res) => {
    try { res.json(await service.createEmployeeTopic(String(req.params.id))); } catch (err) { error(res, err); }
  });
  app.post('/api/work/employees/:id/test', async (req, res) => {
    try { await service.testEmployeeTopic(String(req.params.id)); res.json({ ok: true }); } catch (err) { error(res, err); }
  });

  app.get('/api/work/tasks', (_req, res) => res.json(service.listTasks()));
  app.post('/api/work/tasks', async (req, res) => {
    try { res.status(201).json(await service.createTask(req.body ?? {})); } catch (err) { error(res, err); }
  });
  app.put('/api/work/tasks/:id', async (req, res) => {
    try { res.json(await service.updateTask(String(req.params.id), req.body ?? {})); } catch (err) { error(res, err); }
  });
  app.post('/api/work/tasks/:id/cancel', async (req, res) => {
    try { res.json(await service.cancelTask(String(req.params.id))); } catch (err) { error(res, err); }
  });
  app.post('/api/work/tasks/:id/retry', async (req, res) => {
    try { res.json(await service.retryTask(String(req.params.id))); } catch (err) { error(res, err); }
  });
  app.post('/api/work/tasks/:id/complete', async (req, res) => {
    try { res.json(await service.setTaskCompletion(String(req.params.id), true)); } catch (err) { error(res, err); }
  });
  app.post('/api/work/tasks/:id/reopen', async (req, res) => {
    try { res.json(await service.setTaskCompletion(String(req.params.id), false)); } catch (err) { error(res, err); }
  });

  app.get('/api/work/payroll', (_req, res) => res.json(service.payroll()));
  app.get('/api/work/distributions', (req, res) => {
    res.json(service.listDistributions(req.query.projectId ? String(req.query.projectId) : undefined));
  });
  app.post('/api/work/distributions/:id/pause', async (req, res) => {
    try { res.json(await service.pauseDistribution(String(req.params.id))); } catch (err) { error(res, err); }
  });
  app.post('/api/work/distributions/:id/resume', async (req, res) => {
    try { res.json(await service.resumeDistribution(String(req.params.id))); } catch (err) { error(res, err); }
  });
  app.delete('/api/work/distributions/:id', async (req, res) => {
    try { await service.clearDistribution(String(req.params.id)); res.status(204).end(); } catch (err) { error(res, err); }
  });
  app.post('/api/work/distribution-items/:id/retry', async (req, res) => {
    try { res.json(await service.retryDistributionItem(String(req.params.id))); } catch (err) { error(res, err); }
  });
}
