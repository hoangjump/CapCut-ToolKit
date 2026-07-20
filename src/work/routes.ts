import type { Express, Request, Response } from 'express';
import type { TelegramUpdate } from './types.js';
import type { TelegramWorkService } from './service.js';

function error(res: Response, err: unknown, status = 400): void {
  res.status(status).json({ error: (err as Error).message });
}

export function registerTelegramWorkRoutes(app: Express, service: TelegramWorkService): void {
  app.get('/api/work/config', (_req, res) => res.json(service.configDto()));
  app.put('/api/work/config', async (req, res) => {
    try { res.json(await service.saveConfig(req.body ?? {})); } catch (err) { error(res, err); }
  });
  app.post('/api/work/config/polling', async (_req, res) => {
    try { res.json(await service.enablePolling()); } catch (err) { error(res, err); }
  });
  app.post('/api/work/config/webhook', async (req, res) => {
    try { res.json(await service.configureWebhook(String(req.body?.url ?? ''))); } catch (err) { error(res, err); }
  });
  app.post('/api/work/config/off', async (_req, res) => {
    try { res.json(await service.disableTelegram()); } catch (err) { error(res, err); }
  });

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
}
