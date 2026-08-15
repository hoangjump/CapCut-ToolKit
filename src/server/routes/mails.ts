import type { Express } from 'express';
import type { Request, Response } from 'express';
import { MailStore, parseMailLine, providerFromEmail } from '../../mailStore.js';
import type { SettingsStore } from '../../settingsStore.js';
import type { ProfileManager } from '../../profileManager.js';
import type { BrowserManager } from '../../browserManager.js';
import { runAliasesForMail } from '../../aliasRunner.js';
import { findAliasOtp } from '../../graphMailClient.js';
import { createLogger } from '../../logger.js';

const aliasLog = createLogger('alias');
/** mailId đang chạy tạo alias — chặn double-click sinh hai phiên Camoufox. */
const aliasRunning = new Set<string>();
import { getBalance, getAccountTypes, buyMail, getCode, getMessages } from '../../mailClient.js';
import * as selltaikhoan from '../../selltaikhoanClient.js';
import * as smsbower from '../../smsbowerClient.js';
import type { MailCodeType, MailRecord } from '../../types.js';


/** Bỏ password/refreshToken/clientId trước khi trả về UI — kho mail chỉ được
 *  lộ những gì màn hình cần. */
function mailDto(mail: ReturnType<MailStore['list']>[number]) {
  const { password, refreshToken, clientId, ...safe } = mail;
  void password;
  void refreshToken;
  void clientId;
  return safe;
}


export interface MailRoutesDeps {
  mails: MailStore;
  settings: SettingsStore;
  profiles: ProfileManager;
  browsers: BrowserManager;
}

/** Kho mail + ba nhà cung cấp: dongvanfb, selltaikhoan, SmsBower. */
export function registerMailRoutes(app: Express, { mails, settings, profiles, browsers }: MailRoutesDeps): void {
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

  app.get('/api/mail/account-types', async (_req: Request, res: Response) => {
    const key = requireApiKey(res);
    if (!key) return;
    try {
      res.json({ accountTypes: await getAccountTypes(key) });
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
          status: 'available',
          source: 'dongvanfb',
        })),
      );
      res.json({
        orderCode: result.orderCode,
        price: result.price,
        balance: result.balance,
        bought: result.mails.length,
        added: created.length,
        mails: created.map(mailDto),
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- selltaikhoan.com (nhà cung cấp mail thứ 2, Outlook OAuth2 rẻ hơn) ---
  // Mail trả về cùng định dạng email|password|refresh_token|client_id nên nạp
  // thẳng vào MailStore; đọc OTP dùng chung tools như dongvanfb.
  function requireSelltaikhoanKey(res: Response): string | null {
    const key = settings.getSelltaikhoanKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key selltaikhoan (vào tab Mail).' });
      return null;
    }
    return key;
  }

  app.get('/api/selltaikhoan/balance', async (_req: Request, res: Response) => {
    const key = requireSelltaikhoanKey(res);
    if (!key) return;
    try {
      res.json({ balance: await selltaikhoan.getBalance(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/selltaikhoan/products', async (_req: Request, res: Response) => {
    const key = requireSelltaikhoanKey(res);
    if (!key) return;
    try {
      res.json({ products: await selltaikhoan.listProducts(key) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/selltaikhoan/buy', async (req: Request, res: Response) => {
    const key = requireSelltaikhoanKey(res);
    if (!key) return;
    const body = req.body ?? {};
    if (!body.productId) {
      res.status(400).json({ error: 'productId là bắt buộc' });
      return;
    }
    try {
      const amount = Math.max(1, Number(body.amount) || 1);
      const result = await selltaikhoan.buyProduct(key, String(body.productId), amount);
      const created = await mails.createMany(
        result.mails.map((m) => ({
          email: m.email,
          password: m.password,
          refreshToken: m.refreshToken,
          clientId: m.clientId,
          provider: providerFromEmail(m.email),
          orderCode: result.transId,
          status: 'available',
          source: 'selltaikhoan',
        })),
      );
      res.json({ transId: result.transId, bought: result.mails.length, added: created.length, mails: created.map(mailDto) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // ---- SmsBower (thuê gmail nhận OTP theo service, vd đăng ký ChatGPT) -------
  // Chỉ expose "rests" (tồn kho + giá + mã service) để chọn đúng service. Việc
  // thuê/đọc code/chốt do rentMailDep lo trong lúc chạy flow (tránh tốn tiền khi
  // bấm lung tung ở UI).
  app.get('/api/smsbower/rests', async (req: Request, res: Response) => {
    const key = settings.getSmsbowerKey();
    if (!key) {
      res.status(400).json({ error: 'Chưa cấu hình API key SmsBower (vào tab Mail).' });
      return;
    }
    try {
      const domain = req.query.domain ? String(req.query.domain) : 'gmail.com';
      res.json({ rests: await smsbower.getPriceRests(key, domain) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/mails', (_req: Request, res: Response) => {
    res.json(mails.list().map(mailDto));
  });

  app.post('/api/mails/import', async (req: Request, res: Response) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.map(String) : [];
    const tags: string[] = Array.isArray(req.body?.tags)
      ? (req.body.tags as unknown[]).map(String).map((tag: string) => tag.trim()).filter(Boolean)
      : [];
    if (!lines.length) {
      res.status(400).json({ error: 'Danh sách import đang trống' });
      return;
    }
    const valid = [];
    const invalid: Array<{ line: number; error: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const normalizedLine = line.includes('|') ? line : line.split(',').map((part: string) => part.trim()).join('|');
        valid.push({ ...parseMailLine(normalizedLine), tags, status: 'unchecked' as const, source: 'manual' as const });
      } catch (error) {
        invalid.push({ line: index + 1, error: (error as Error).message });
      }
    }
    const created = await mails.createMany(valid);
    res.json({
      total: lines.filter((line: string) => line.trim()).length,
      added: created.length,
      duplicates: valid.length - created.length,
      invalid,
      mails: created.map(mailDto),
    });
  });

  app.put('/api/mails/status', async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const status = String(req.body?.status ?? '');
    if (!ids.length) {
      res.status(400).json({ error: 'Chưa chọn mail' });
      return;
    }
    if (!['unchecked', 'available', 'used', 'failed', 'disabled'].includes(status)) {
      res.status(400).json({ error: 'Trạng thái mail không hợp lệ' });
      return;
    }
    try {
      const updated = await mails.updateStatus(ids, status as 'unchecked' | 'available' | 'used' | 'failed' | 'disabled');
      res.json({ updated });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mails/check', async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? [...new Set((req.body.ids as unknown[]).map(String))] : [];
    const targets = ids.map((id) => mails.get(id)).filter((mail): mail is MailRecord => Boolean(mail));
    if (!targets.length) {
      res.status(400).json({ error: 'Không tìm thấy mail cần kiểm tra' });
      return;
    }
    const reserved = targets.find((mail) => mail.status === 'reserved');
    if (reserved) {
      res.status(409).json({ error: `Mail ${reserved.email} đang được giữ bởi một profile, chưa thể kiểm tra` });
      return;
    }
    const results: Array<{ id: string; error?: string }> = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const mail = targets[index];
        if (!mail) return;
        try {
          await getMessages({
            email: mail.email,
            password: mail.password,
            refreshToken: mail.refreshToken,
            clientId: mail.clientId,
          });
          results.push({ id: mail.id });
        } catch (error) {
          results.push({ id: mail.id, error: (error as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
    await mails.markCheckResults(results);
    res.json({
      checked: results.length,
      available: results.filter((result) => !result.error).length,
      failed: results.filter((result) => result.error).length,
      results,
    });
  });

  app.post('/api/mails', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (typeof body.line === 'string' && body.line.trim()) {
        res.status(201).json(mailDto(await mails.create({ ...parseMailLine(body.line), status: 'unchecked', source: 'manual' })));
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
        status: 'unchecked',
        source: 'manual',
      });
      res.status(201).json(mailDto(created));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Xóa hàng loạt: body {ids: string[]} xóa các id đó; không body = xóa SẠCH kho.
  // Đăng ký TRƯỚC '/api/mails/:id' để "mails" không bị bắt nhầm thành :id.
  app.delete('/api/mails', async (req: Request, res: Response) => {
    try {
      const ids = req.body?.ids;
      const removed = Array.isArray(ids) ? await mails.deleteMany(ids.map(String)) : await mails.clear();
      res.json({ removed });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/mails/:id', async (req: Request, res: Response) => {
    try {
      await mails.delete(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.includes('đang được giữ') ? 409 : 404).json({ error: message });
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
      // Alias dùng CHUNG hộp thư account cha (cred lưu trên chính bản ghi alias):
      // smail1s trả cả hộp thư nên sẽ lẫn OTP của cha/alias khác. Đọc thẳng Graph,
      // LỌC theo recipient = địa chỉ alias, quét cả Junk.
      if (mail.source === 'alias') {
        const hit = await findAliasOtp(
          { email: mail.email, refreshToken: mail.refreshToken, clientId: mail.clientId },
          { alias: mail.email },
        );
        res.json({
          status: !!hit,
          code: hit?.code ?? '',
          content: hit?.message.subject ?? '',
          date: hit?.message.receivedDateTime ?? '',
          source: 'graph-alias',
        });
        return;
      }
      const result = await getCode({
        email: mail.email,
        password: mail.password,
        refreshToken: mail.refreshToken,
        clientId: mail.clientId,
        type,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Tạo alias cho account nguồn: mở Camoufox, login account.live.com, tạo tới
  // `target` alias (trần 10), lưu mỗi alias vào kho mail (tái dùng cred cha).
  //
  // Chạy NỀN (fire-and-forget): flow login + tạo 10 alias mất vài phút, giữ mở
  // một request HTTP lâu vậy sẽ bị Node đóng socket (~5 phút) → UI báo "Failed
  // to fetch". Nên trả 202 ngay; tiến trình xem ở khung log, alias hiện dần
  // trong kho (UI tự refresh 5s). Chặn chạy trùng trên cùng một mail.
  app.post('/api/mails/:id/aliases', (req: Request, res: Response) => {
    const mail = mails.get(String(req.params.id));
    if (!mail) {
      res.status(404).json({ error: 'Mail not found' });
      return;
    }
    if (aliasRunning.has(mail.id)) {
      res.status(409).json({ error: 'Mail này đang chạy tạo alias — chờ xong đã' });
      return;
    }
    aliasRunning.add(mail.id);
    aliasLog.info(`bắt đầu tạo alias cho ${mail.email} (mở Camoufox, login, tạo alias)…`);
    runAliasesForMail(
      { mails, profiles, browsers },
      {
        mailId: mail.id,
        target: req.body?.target !== undefined ? Number(req.body.target) : undefined,
        prefix: req.body?.prefix ? String(req.body.prefix) : undefined,
        headless: req.body?.headless === true,
      },
    )
      .then((result) => {
        aliasLog.info(
          `xong ${mail.email}: tạo ${result.created.length} alias, lưu ${result.storedCount} (đã có ${result.existingBefore})` +
            (result.hitLimit ? ' — đã chạm trần 10' : '') +
            (result.rateLimited ? ' — MS chặn thêm quá thường xuyên, thử lại sau' : ''),
        );
      })
      .catch((err) => {
        aliasLog.warn(`tạo alias ${mail.email} lỗi: ${(err as Error).message}`);
      })
      .finally(() => {
        aliasRunning.delete(mail.id);
      });
    res.status(202).json({ started: true, email: mail.email });
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
        password: mail.password,
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
}
