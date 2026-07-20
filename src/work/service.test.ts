import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../settingsStore.js';
import { TelegramWorkService, hasHeart } from './service.js';
import { TelegramWorkStore } from './store.js';
import type { TelegramBotApi } from './telegramClient.js';
import type { TelegramUpdate } from './types.js';

class FakeTelegram implements TelegramBotApi {
  private nextMessageId = 100;
  readonly sent: Array<{ chatId: string; threadId?: number; text: string }> = [];
  readonly reactions: Array<{ chatId: string; messageId: number; emoji?: string }> = [];

  async sendMessage(_token: string, input: { chatId: string; threadId?: number; text: string }): Promise<{ message_id: number }> {
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

test('heart detection only accepts the red heart emoji', () => {
  assert.equal(hasHeart([{ type: 'emoji', emoji: '❤️' }]), true);
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
