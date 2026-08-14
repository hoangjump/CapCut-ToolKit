import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../settingsStore.js';
import { TelegramWorkService, hasHeart, type SheetWebhookWriter } from './service.js';
import { TelegramWorkStore } from './store.js';
import type { TelegramBotApi } from './telegramClient.js';
import {
  PaymentSessionService,
  type PaymentBrowser,
  type PaymentBrowserCreateInput,
} from './paymentSessions.js';
import type { TelegramUpdate } from './types.js';

class FakeTelegram implements TelegramBotApi {
  private nextMessageId = 100;
  readonly sent: Array<{
    chatId: string;
    threadId?: number;
    text: string;
    parseMode?: 'HTML';
    disableLinkPreview?: boolean;
  }> = [];
  readonly reactions: Array<{ chatId: string; messageId: number; emoji?: string }> = [];

  async sendMessage(_token: string, input: {
    chatId: string;
    threadId?: number;
    text: string;
    parseMode?: 'HTML';
    disableLinkPreview?: boolean;
  }): Promise<{ message_id: number }> {
    this.sent.push(input);
    return { message_id: this.nextMessageId++ };
  }
  async editMessageText(): Promise<void> {}
  async setMessageReaction(_token: string, input: { chatId: string; messageId: number; emoji?: string }): Promise<void> {
    this.reactions.push(input);
  }
  async createForumTopic(): Promise<{ message_thread_id: number; name: string }> {
    return { message_thread_id: 45, name: 'Topic' };
  }
  async editForumTopic(): Promise<void> {}
  async getUpdates(): Promise<TelegramUpdate[]> { return []; }
  async setWebhook(): Promise<void> {}
  async deleteWebhook(): Promise<void> {}
}

class FlakyCompletionTelegram extends FakeTelegram {
  completionAttempts = 0;

  override async sendMessage(token: string, input: Parameters<FakeTelegram['sendMessage']>[1]): Promise<{ message_id: number }> {
    if (/CapCut đã lên VIP/i.test(input.text)) {
      this.completionAttempts += 1;
      if (this.completionAttempts === 1) throw new Error('Telegram 429 Too Many Requests');
    }
    return super.sendMessage(token, input);
  }
}

class PrewarmBrowser implements PaymentBrowser {
  readonly created: PaymentBrowserCreateInput[] = [];

  async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    this.created.push(input);
    return { sessionId: `browser-${input.id}` };
  }
  async close(): Promise<void> {}
  async closeAll(): Promise<void> {}
}

class FlakySheetWriter {
  readonly attempts: Array<{ webhookUrl: string; payload: Record<string, unknown> }> = [];
  readonly successful: Array<{ webhookUrl: string; payload: Record<string, unknown> }> = [];
  private failedOnce = false;

  readonly write: SheetWebhookWriter = async (webhookUrl, payload) => {
    const entry = { webhookUrl, payload: structuredClone(payload) };
    this.attempts.push(entry);
    if (payload.targetSpreadsheetId && payload.email === 'mail1@example.com' && !this.failedOnce) {
      this.failedOnce = true;
      throw new Error('Sheet tạm thời không ghi được');
    }
    this.successful.push(entry);
  };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('heart detection only accepts the red heart emoji', () => {
  assert.equal(hasHeart([{ type: 'emoji', emoji: '❤️' }]), true);
  assert.equal(hasHeart([{ type: 'emoji', emoji: '❤' }]), true);
  assert.equal(hasHeart([{ type: 'emoji', emoji: '👍' }]), false);
  assert.equal(hasHeart([]), false);
});

test('assigned employee reaction credits once and removing it reverses payroll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-work-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setWorkTelegramBotToken('test-token');
    await settings.setWorkTelegramChatId('-100123');
    const fake = new FakeTelegram();
    const store = new TelegramWorkStore(root);
    const service = new TelegramWorkService(store, settings, fake);
    await service.init();

    const employee = await service.createEmployee({ fullName: 'Duy', defaultUnitRate: 5_000 });
    await service.processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        message_thread_id: 45,
        text: `/bind ${employee.bindCode}`,
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 555 },
      },
    });
    const bound = service.listEmployees()[0];
    assert.equal(bound.status, 'active');
    assert.equal(bound.telegramUserId, '555');

    const task = await service.createTask({
      employeeId: bound.id,
      description: 'Xử lý dữ liệu',
      quantity: 3,
    });
    assert.equal(task.amount, 15_000);
    assert.equal(task.telegramMessageId, 101); // bind acknowledgement used message 100

    const heartUpdate: TelegramUpdate = {
      update_id: 2,
      message_reaction: {
        chat: { id: -100123, type: 'supergroup' },
        message_id: task.telegramMessageId!,
        user: { id: 555 },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '❤️' }],
      },
    };
    await service.processUpdate(heartUpdate);
    await service.processUpdate(heartUpdate); // Telegram retry must be idempotent.
    let payroll = service.payroll()[0].totals;
    assert.equal(payroll.allQuantity, 3);
    assert.equal(payroll.allAmount, 15_000);
    assert.equal(service.listTasks()[0].status, 'completed');

    // A different employee cannot add another credit to the same task.
    await service.processUpdate({
      update_id: 3,
      message_reaction: {
        chat: { id: -100123 },
        message_id: task.telegramMessageId!,
        user: { id: 999 },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '❤️' }],
      },
    });
    payroll = service.payroll()[0].totals;
    assert.equal(payroll.allAmount, 15_000);

    await service.processUpdate({
      update_id: 4,
      message_reaction: {
        chat: { id: -100123 },
        message_id: task.telegramMessageId!,
        user: { id: 555 },
        old_reaction: [{ type: 'emoji', emoji: '❤️' }],
        new_reaction: [],
      },
    });
    payroll = service.payroll()[0].totals;
    assert.equal(payroll.allQuantity, 0);
    assert.equal(payroll.allAmount, 0);
    assert.equal(service.listTasks()[0].status, 'pending');
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed CapCut completion notifications stay pending and retry without double credit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-work-notification-retry-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setWorkTelegramBotToken('test-token');
    await settings.setWorkTelegramChatId('-100123');
    const fake = new FlakyCompletionTelegram();
    const store = new TelegramWorkStore(root);
    const service = new TelegramWorkService(store, settings, fake);
    await service.init();
    const now = new Date().toISOString();
    await store.mutate((state) => {
      state.employees.push({
        id: 'employee-1', fullName: 'Nhân viên 1', defaultUnitRate: 5_000,
        salaryVisibility: 'topic', status: 'active', bindCode: 'BIND-1',
        telegramUserId: '555', telegramChatId: '-100123', telegramTopicId: 45,
        createdAt: now, updatedAt: now,
      });
      state.tasks.push({
        id: 'task-1', employeeId: 'employee-1', description: 'Thanh toán CapCut',
        quantity: 1, unitRate: 5_000, amount: 5_000, status: 'pending', deliveryStatus: 'sent',
        telegramChatId: '-100123', telegramTopicId: 45, telegramMessageId: 999,
        source: 'capcut-distribution',
        capcutCredentials: {
          email: 'worker@example.com', mailLine: 'worker@example.com|pass|refresh|client',
          checkoutUrl: 'https://cashier.example/checkout',
        },
        createdAt: now, updatedAt: now,
      });
    });

    await (service as any).completeCapcutVip('task-1', 1_900_000_000);
    await waitFor(
      () => fake.completionAttempts === 1 && (service as any).queuedNotificationTasks.size === 0,
      'first Telegram completion attempt did not finish',
    );
    assert.equal(store.snapshot().tasks[0].completionNotificationStatus, 'pending');
    assert.equal(store.snapshot().earnings.length, 1);

    (service as any).retryPendingCapcutNotifications();
    await waitFor(
      () => store.snapshot().tasks[0].completionNotificationStatus === 'sent',
      'pending Telegram completion was not retried',
    );
    assert.equal(fake.completionAttempts, 2);
    assert.equal(fake.sent.filter((message) => /CapCut đã lên VIP/i.test(message.text)).length, 1);
    assert.equal(store.snapshot().earnings.length, 1);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CapCut distribution respects quotas and auto-pays only after VIP verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-distribution-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setWorkTelegramBotToken('test-token');
    await settings.setWorkTelegramChatId('-100123');
    await settings.setSheetWebhookUrl('https://sheet.example/exec');
    const fake = new FakeTelegram();
    const store = new TelegramWorkStore(root);
    const paymentBrowser = new PrewarmBrowser();
    const payments = new PaymentSessionService(store, settings, paymentBrowser);
    const sheetWriter = new FlakySheetWriter();
    let sheetVerifyCount = 0;
    const service = new TelegramWorkService(store, settings, fake, payments, sheetWriter.write, async () => {
      sheetVerifyCount += 1;
    });
    await service.init();
    await settings.setWorkTelegramMode('polling');

    const duySheetId = 'duy-sheet-id-12345678901234567890';
    const taiSheetId = 'tai-sheet-id-12345678901234567890';
    const duy = await service.createEmployee({
      fullName: 'Duy', defaultUnitRate: 5_000,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${duySheetId}/edit#gid=0`,
    });
    const tai = await service.createEmployee({ fullName: 'Tài', defaultUnitRate: 7_000, sheetUrl: taiSheetId });
    assert.equal(duy.sheetSpreadsheetId, duySheetId);
    assert.equal(tai.sheetSpreadsheetId, taiSheetId);
    await service.processUpdate({ update_id: 10, message: { message_id: 1, message_thread_id: 45, text: `/bind ${duy.bindCode}`, chat: { id: -100123 }, from: { id: 555 } } });
    await service.processUpdate({ update_id: 11, message: { message_id: 2, message_thread_id: 46, text: `/bind ${tai.bindCode}`, chat: { id: -100123 }, from: { id: 777 } } });

    const run = await service.startDistribution({
      projectId: 'project-1',
      projectName: 'Auto CapCut',
      allocations: [{ employeeId: duy.id, quantity: 2 }, { employeeId: tai.id, quantity: 1 }],
    });
    assert.equal(sheetVerifyCount, 1);
    await service.pauseDistribution(run.id);
    for (let index = 1; index <= 3; index += 1) {
      await service.enqueueCapcutResult(run.id, {
        profileName: `tmp-${index}`,
        email: `mail${index}@example.com`,
        password: `pass${index}`,
        mailLine: `mail${index}@example.com|pass${index}|refresh${index}|client${index}`,
        checkoutUrl: `https://capcut.example/checkout/${index}?token=abc&locale=vi`,
        proxy: { server: `http://proxy${index}.example:8080`, username: 'user', password: 'secret' },
        proxyRecordId: `proxy-record-${index}`,
        capcutCookies: [{
          name: 'sessionid', value: `session-${index}`, domain: '.capcut.com', path: '/', expires: -1,
          httpOnly: true, secure: true, sameSite: 'Lax',
        }],
      });
    }
    let current = service.listDistributions('project-1')[0];
    assert.equal(current.queued, 3);
    assert.equal(current.sent, 0);
    assert.deepEqual(
      [...current.items].sort((a, b) => a.sequence - b.sequence).map((item) => item.employeeId),
      [duy.id, tai.id, duy.id],
    );

    await service.resumeDistribution(run.id);
    await waitFor(() => {
      const status = service.listDistributions('project-1')[0];
      return status?.sent === 2 && status.failed === 1;
    }, 'sheet failure did not stop the affected item');
    const sheetFailed = service.listDistributions('project-1')[0].items.find((item) => item.status === 'failed')!;
    assert.match(sheetFailed.error ?? '', /Sheet tạm thời không ghi được/);
    await service.retryDistributionItem(sheetFailed.id);
    await waitFor(() => service.listDistributions('project-1')[0]?.sent === 3, 'distribution retry did not flush');
    assert.equal(paymentBrowser.created.length, 3);
    assert.equal(sheetWriter.attempts.length, 7);
    assert.equal(sheetWriter.successful.length, 6);
    const totalSheetRows = sheetWriter.successful.filter((entry) => !entry.payload.targetSpreadsheetId);
    const employeeSheetRows = sheetWriter.successful.filter((entry) => entry.payload.targetSpreadsheetId);
    assert.equal(totalSheetRows.length, 3);
    assert.equal(totalSheetRows.every((entry) => String(entry.payload.mailLine).includes('|pass')), true);
    assert.deepEqual(new Set(totalSheetRows.map((entry) => entry.payload.employeeName)), new Set(['Duy', 'Tài']));
    assert.deepEqual(
      employeeSheetRows
        .map((entry) => [entry.payload.email, entry.payload.targetSpreadsheetId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ['mail1@example.com', duySheetId],
        ['mail2@example.com', taiSheetId],
        ['mail3@example.com', duySheetId],
      ],
    );
    assert.equal(employeeSheetRows.every((entry) => entry.payload.mailLine === entry.payload.email), true);
    // Apps Script chống ghi trùng bằng entryId (cột Y). Mọi payload phải mang nó,
    // và nó phải duy nhất cho từng (dòng, sheet đích) — kể cả lần retry.
    const entryIds = sheetWriter.attempts.map((entry) => entry.payload.entryId);
    assert.equal(entryIds.every((id) => typeof id === 'string' && id.length > 0), true);
    assert.equal(new Set(entryIds).size, 6);
    assert.doesNotMatch(JSON.stringify(employeeSheetRows), /pass\d|refresh\d|client\d/);
    assert.equal(store.snapshot().paymentSessions.every((session) => session.status === 'ready'), true);
    await service.finishDistribution(run.id);
    await waitFor(() => service.listDistributions('project-1')[0]?.status === 'finished', 'distribution did not finish');
    current = service.listDistributions('project-1')[0];
    assert.equal(current.items.every((item) => Boolean(item.totalSheetSyncedAt && item.employeeSheetSyncedAt)), true);
    assert.equal(current.completed, 0);
    assert.equal(service.payroll().reduce((sum, row) => sum + row.totals.allAmount, 0), 0);

    const firstItem = current.items.find((item) => item.employeeId === duy.id)!;
    assert.equal(firstItem.proxy, undefined);
    assert.equal(firstItem.proxyRecordId, undefined);
    assert.equal(firstItem.capcutCookies, undefined);
    const task = service.listTasks().find((item) => item.distributionItemId === firstItem.id)!;
    assert.equal(task.capcutCredentials?.proxy, undefined);
    assert.equal(task.capcutCredentials?.proxyRecordId, undefined);
    assert.equal(task.capcutCredentials?.capcutCookies, undefined);
    const storedTask = store.snapshot().tasks.find((item) => item.id === task.id)!;
    const paymentSession = store.snapshot().paymentSessions.find((item) => item.taskId === task.id)!;
    assert.equal(paymentSession.proxy?.password, 'secret');
    assert.equal(paymentSession.proxyRecordId, storedTask.capcutCredentials?.proxyRecordId);
    assert.equal(paymentSession.capcutCookies?.[0].name, 'sessionid');
    assert.equal(task.capcutCredentials?.password, firstItem.password);
    const sentMessage = fake.sent.find((message) => message.text.includes(firstItem.email))!;
    const sentText = sentMessage.text;
    const expiresAt = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(new Date(task.createdAt).getTime() + 15 * 60_000));
    assert.ok(sentText.includes(`<code>${firstItem.email}</code>`));
    assert.equal(sentText.includes(firstItem.password!), false);
    assert.doesNotMatch(sentText, /Mail full:|refresh\d|client\d/);
    // Không còn trang /pay — nhân viên nhận thẳng link checkout CapCut gốc
    // (href bị escape HTML, & → &amp;).
    const escapedCheckout = firstItem.checkoutUrl.replace(/&/g, '&amp;');
    assert.ok(sentText.includes(`<a href="${escapedCheckout}">Link thanh toán</a>`));
    assert.match(sentText, new RegExp(`Hạn: ${expiresAt} \\(15 phút\\)`));
    assert.match(sentText, /hệ thống tự tim tin nhắn và cộng sản lượng/i);
    assert.match(sentText, /Không cần thả tim hoặc bấm kiểm tra lại/);
    assert.doesNotMatch(sentText, /Thả tim xác nhận/);
    assert.equal(sentMessage.parseMode, 'HTML');
    assert.equal(sentMessage.disableLinkPreview, true);
    await assert.rejects(
      service.setTaskCompletion(task.id, true),
      /tự động tính sau khi hệ thống xác minh/,
    );
    assert.equal(service.payroll().find((row) => row.employeeId === duy.id)!.totals.allAmount, 0);
    await service.processUpdate({
      update_id: 12,
      message_reaction: {
        chat: { id: -100123 },
        message_id: task.telegramMessageId!,
        user: { id: 555 },
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '❤' }],
      },
    });
    assert.equal(service.payroll().find((row) => row.employeeId === duy.id)!.totals.allAmount, 0);

    const paymentInput = paymentBrowser.created.find((input) => input.id === paymentSession.id)!;
    await paymentInput.onStatus('verifying');
    assert.equal(store.snapshot().tasks.find((item) => item.id === task.id)!.paymentStatus, 'verifying');
    await paymentInput.onStatus('paid', undefined, { vipEndTime: 1_900_000_000 });
    assert.equal(service.payroll().find((row) => row.employeeId === duy.id)!.totals.allAmount, 5_000);
    assert.equal(service.listDistributions('project-1')[0].completed, 1);
    assert.equal(store.snapshot().tasks.find((item) => item.id === task.id)!.capcutCredentials?.vipEndTime, 1_900_000_000);
    assert.equal(store.snapshot().tasks.find((item) => item.id === task.id)!.capcutCredentials?.capcutCookies, undefined);
    assert.equal(store.snapshot().distributionItems.find((item) => item.id === firstItem.id)!.capcutCookies, undefined);
    assert.equal(fake.reactions.at(-1)?.emoji, '❤');
    assert.match(fake.sent.at(-1)!.text, /\+1 con × 5\.000đ = 5\.000đ/);
    // Lên VIP -> tick DONE ở CẢ Sheet tổng lẫn Sheet riêng, kèm SL trong ngày.
    // Thông báo chạy qua hàng đợi bất đồng bộ nên phải chờ.
    await waitFor(
      () => sheetWriter.attempts.filter((entry) => entry.payload.setDone !== undefined).length >= 2,
      'DONE flag was not pushed to both sheets',
    );
    const doneWrites = sheetWriter.attempts.filter((entry) => entry.payload.setDone !== undefined);
    const totalDone = doneWrites.find((entry) => !entry.payload.targetSpreadsheetId)!;
    const employeeDone = doneWrites.find((entry) => entry.payload.targetSpreadsheetId === duySheetId)!;
    assert.deepEqual(
      { id: totalDone.payload.entryId, done: totalDone.payload.setDone, count: totalDone.payload.doneCount },
      { id: `total:${firstItem.id}`, done: true, count: 1 },
    );
    assert.deepEqual(
      { id: employeeDone.payload.entryId, done: employeeDone.payload.setDone, count: employeeDone.payload.doneCount },
      { id: `employee:${firstItem.id}`, done: true, count: 1 },
    );
    // Payload tick DONE không được mang theo mail full hay mật khẩu.
    assert.doesNotMatch(JSON.stringify(doneWrites), /pass\d|refresh\d|client\d|@example\.com/);

    assert.match(fake.sent.at(-1)!.text, /Bot đã tự tim tin nhắn gốc/);
    assert.match(fake.sent.at(-1)!.text, /Không cần bấm lại hoặc kiểm tra thủ công/);

    const stale = await service.startDistribution({
      projectId: 'project-1',
      projectName: 'Auto CapCut',
      allocations: [{ employeeId: duy.id, quantity: 1 }],
    });
    await service.pauseDistribution(stale.id);
    await service.enqueueCapcutResult(stale.id, {
      profileName: 'stale-profile',
      email: 'stale@example.com',
      password: 'stale-pass',
      mailLine: 'stale@example.com|stale-pass|refresh|client',
      checkoutUrl: 'https://capcut.example/stale',
    });
    await assert.rejects(
      service.startDistribution({
        projectId: 'project-1',
        projectName: 'Auto CapCut',
        allocations: [{ employeeId: duy.id, quantity: 1 }],
      }),
      /đợt phân phối chưa kết thúc/,
    );
    await service.clearDistribution(stale.id);
    assert.equal(service.listDistributions('project-1').some((item) => item.id === stale.id), false);
    assert.equal(service.payroll().find((row) => row.employeeId === duy.id)!.totals.allAmount, 5_000);
    const replacement = await service.startDistribution({
      projectId: 'project-1',
      projectName: 'Auto CapCut',
      allocations: [{ employeeId: duy.id, quantity: 1 }],
    });
    assert.equal(replacement.status, 'running');
    await service.clearDistribution(replacement.id);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sheet probe reports the target tab and refuses an unconfigured employee', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-work-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    const store = new TelegramWorkStore(root);
    const calls: Array<{ webhookUrl: string; spreadsheetId: string }> = [];
    const order: string[] = [];
    const service = new TelegramWorkService(
      store,
      settings,
      new FakeTelegram(),
      undefined,
      async () => {},
      async () => { order.push('verify'); },
      async (webhookUrl, spreadsheetId) => {
        order.push('probe');
        calls.push({ webhookUrl, spreadsheetId });
        return { spreadsheetName: 'Sheet cua Duy', sheetName: 'Trang tinh 1', nextRow: 7 };
      },
    );
    await service.init();

    const duy = await service.createEmployee({ fullName: 'Duy', defaultUnitRate: 5_000 });
    await assert.rejects(service.testEmployeeSheet(duy.id), /chưa cấu hình Google Sheet riêng/);

    const sheetId = 'A'.repeat(30);
    await service.updateEmployee(duy.id, { sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` });
    await assert.rejects(service.testEmployeeSheet(duy.id), /Google Sheet URL tổng/);

    await settings.setSheetWebhookUrl('https://script.google.com/exec');
    const probe = await service.testEmployeeSheet(duy.id);
    assert.deepEqual(probe, { spreadsheetName: 'Sheet cua Duy', sheetName: 'Trang tinh 1', nextRow: 7 });
    assert.deepEqual(calls, [{ webhookUrl: 'https://script.google.com/exec', spreadsheetId: sheetId }]);
    // Script cũ phải bị chặn TRƯỚC khi probe, nếu không lỗi báo ra sẽ khó hiểu.
    assert.deepEqual(order, ['verify', 'probe']);

    await assert.rejects(service.testEmployeeSheet('khong-ton-tai'), /Không tìm thấy nhân viên/);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one Google Sheet cannot be shared by two employees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-work-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    const store = new TelegramWorkStore(root);
    const service = new TelegramWorkService(store, settings, new FakeTelegram());
    await service.init();

    const sheetId = 'B'.repeat(30);
    const duy = await service.createEmployee({ fullName: 'Duy', defaultUnitRate: 5_000, sheetUrl: sheetId });
    await assert.rejects(
      service.createEmployee({ fullName: 'Hoa', defaultUnitRate: 5_000, sheetUrl: sheetId }),
      /đang dùng cho nhân viên Duy/,
    );

    const hoa = await service.createEmployee({ fullName: 'Hoa', defaultUnitRate: 5_000 });
    await assert.rejects(service.updateEmployee(hoa.id, { sheetUrl: sheetId }), /đang dùng cho nhân viên Duy/);

    // Lưu lại chính ID của mình thì không được coi là trùng.
    const again = await service.updateEmployee(duy.id, { sheetUrl: sheetId });
    assert.equal(again.sheetSpreadsheetId, sheetId);

    await service.archiveEmployee(duy.id);
    const reused = await service.updateEmployee(hoa.id, { sheetUrl: sheetId });
    assert.equal(reused.sheetSpreadsheetId, sheetId);
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sheet probe surfaces the reason Apps Script gave instead of a bare HTTP code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-work-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setSheetWebhookUrl('https://script.google.com/exec');
    const store = new TelegramWorkStore(root);
    let body = '';
    let status = 200;
    const service = new TelegramWorkService(
      store, settings, new FakeTelegram(), undefined,
      async () => {}, async () => {},
      // Bản sao logic parse của postSheetProbe, chạy trên response giả.
      async () => {
        let parsed: { ok?: boolean; error?: string; sheetName?: string; nextRow?: number };
        try { parsed = JSON.parse(body) as typeof parsed; }
        catch { throw new Error(`Apps Script không trả lời đúng định dạng (HTTP ${status}). Hãy Deploy → Manage deployments → New version`); }
        if (parsed.error) throw new Error(`Apps Script không mở/ghi được file này: ${parsed.error}`);
        if (!parsed.ok || !parsed.sheetName) throw new Error('Apps Script không xác nhận được quyền ghi vào file này');
        return { sheetName: parsed.sheetName, nextRow: Number(parsed.nextRow) || 3 };
      },
    );
    await service.init();
    const duy = await service.createEmployee({ fullName: 'Duy', defaultUnitRate: 5_000, sheetUrl: 'C'.repeat(30) });

    body = JSON.stringify({ ok: false, error: 'You do not have permission to access the requested document.' });
    await assert.rejects(service.testEmployeeSheet(duy.id), /do not have permission/);

    status = 500;
    body = '<html>Script error</html>';
    await assert.rejects(service.testEmployeeSheet(duy.id), /Manage deployments/);

    status = 200;
    body = JSON.stringify({ ok: true, sheetName: 'Trang tinh 1', nextRow: 3 });
    assert.deepEqual(await service.testEmployeeSheet(duy.id), { sheetName: 'Trang tinh 1', nextRow: 3 });
    await service.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
