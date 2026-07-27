import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../settingsStore.js';
import { TelegramWorkService, hasHeart } from './service.js';
import { TelegramWorkStore } from './store.js';
import type { TelegramBotApi } from './telegramClient.js';
import {
  PaymentSessionService,
  type PaymentBrowser,
  type PaymentBrowserCreateInput,
  type PaymentBrowserInput,
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

class PrewarmBrowser implements PaymentBrowser {
  readonly created: PaymentBrowserCreateInput[] = [];

  async create(input: PaymentBrowserCreateInput): Promise<{ sessionId: string }> {
    this.created.push(input);
    return { sessionId: `browser-${input.id}` };
  }
  async close(): Promise<void> {}
  async closeAll(): Promise<void> {}
  async frame(): Promise<Buffer> { return Buffer.alloc(0); }
  async input(_sessionId: string, _input: PaymentBrowserInput): Promise<void> {}
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

test('CapCut distribution respects round-robin quotas and only pays after heart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-distribution-test-'));
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    await settings.setWorkTelegramBotToken('test-token');
    await settings.setWorkTelegramChatId('-100123');
    await settings.setPaymentPublicUrl('https://app.example');
    const fake = new FakeTelegram();
    const store = new TelegramWorkStore(root);
    const paymentBrowser = new PrewarmBrowser();
    const payments = new PaymentSessionService(store, settings, paymentBrowser);
    const service = new TelegramWorkService(store, settings, fake, payments);
    await service.init();
    await settings.setWorkTelegramMode('polling');

    const duy = await service.createEmployee({ fullName: 'Duy', defaultUnitRate: 5_000 });
    const tai = await service.createEmployee({ fullName: 'Tài', defaultUnitRate: 7_000 });
    await service.processUpdate({ update_id: 10, message: { message_id: 1, message_thread_id: 45, text: `/bind ${duy.bindCode}`, chat: { id: -100123 }, from: { id: 555 } } });
    await service.processUpdate({ update_id: 11, message: { message_id: 2, message_thread_id: 46, text: `/bind ${tai.bindCode}`, chat: { id: -100123 }, from: { id: 777 } } });

    settings.setRuntimePaymentPublicUrl(null);
    await assert.rejects(
      service.startDistribution({
        projectId: 'project-1',
        projectName: 'Auto CapCut',
        allocations: [{ employeeId: duy.id, quantity: 1 }],
      }),
      /Cloudflare Tunnel chưa sẵn sàng/,
    );
    settings.setRuntimePaymentPublicUrl('https://app.example');

    const run = await service.startDistribution({
      projectId: 'project-1',
      projectName: 'Auto CapCut',
      allocations: [{ employeeId: duy.id, quantity: 2 }, { employeeId: tai.id, quantity: 1 }],
    });
    await service.pauseDistribution(run.id);
    for (let index = 1; index <= 3; index += 1) {
      await service.enqueueCapcutResult(run.id, {
        profileName: `tmp-${index}`,
        email: `mail${index}@example.com`,
        password: `pass${index}`,
        mailLine: `mail${index}@example.com|pass${index}|refresh${index}|client${index}`,
        checkoutUrl: `https://capcut.example/checkout/${index}?token=abc&locale=vi`,
        proxy: { server: `http://proxy${index}.example:8080`, username: 'user', password: 'secret' },
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
    await waitFor(() => service.listDistributions('project-1')[0]?.sent === 3, 'distribution did not flush');
    assert.equal(paymentBrowser.created.length, 3);
    assert.equal(store.snapshot().paymentSessions.every((session) => session.status === 'ready'), true);
    await service.finishDistribution(run.id);
    await waitFor(() => service.listDistributions('project-1')[0]?.status === 'finished', 'distribution did not finish');
    current = service.listDistributions('project-1')[0];
    assert.equal(current.completed, 0);
    assert.equal(service.payroll().reduce((sum, row) => sum + row.totals.allAmount, 0), 0);

    const firstItem = current.items.find((item) => item.employeeId === duy.id)!;
    assert.equal(firstItem.proxy, undefined);
    const task = service.listTasks().find((item) => item.distributionItemId === firstItem.id)!;
    assert.equal(task.capcutCredentials?.proxy, undefined);
    assert.equal(store.snapshot().paymentSessions[0].proxy?.password, 'secret');
    assert.equal(task.capcutCredentials?.password, firstItem.password);
    const sentMessage = fake.sent.find((message) => message.text.includes(firstItem.email))!;
    const sentText = sentMessage.text;
    const expiresAt = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(new Date(task.createdAt).getTime() + 15 * 60_000));
    assert.ok(sentText.includes(`<code>${firstItem.email} | ${firstItem.password}</code>`));
    assert.doesNotMatch(sentText, /Mail full:|refresh\d|client\d/);
    assert.match(sentText, /<a href="https:\/\/app\.example\/pay\/[^"]+">Link thanh toán<\/a>/);
    assert.equal(sentText.includes(firstItem.checkoutUrl), false);
    assert.match(sentText, new RegExp(`Hạn: ${expiresAt} \\(15 phút\\)`));
    assert.equal(sentMessage.parseMode, 'HTML');
    assert.equal(sentMessage.disableLinkPreview, true);
    await assert.rejects(
      service.setTaskCompletion(task.id, true),
      /chỉ được tính hoặc trừ khi nhân viên thả\/gỡ reaction/,
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
    assert.equal(service.payroll().find((row) => row.employeeId === duy.id)!.totals.allAmount, 5_000);
    assert.equal(service.listDistributions('project-1')[0].completed, 1);
    assert.equal(fake.reactions.at(-1)?.emoji, '❤');
    assert.match(fake.sent.at(-1)!.text, /\+1 con × 5\.000đ = 5\.000đ/);

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
