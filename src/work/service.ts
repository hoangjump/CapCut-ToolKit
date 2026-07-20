import { randomBytes, randomUUID } from 'node:crypto';
import type { SettingsStore } from '../settingsStore.js';
import { createLogger } from '../logger.js';
import type { TelegramBotApi } from './telegramClient.js';
import { TelegramWorkStore } from './store.js';
import type {
  EmployeeTotals,
  PayrollRow,
  SalaryVisibility,
  TelegramReaction,
  TelegramUpdate,
  TelegramWorkState,
  WorkEmployee,
  WorkEmployeeDto,
  WorkTask,
} from './types.js';

const log = createLogger('telegram-work');
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MAX_PROCESSED_UPDATES = 5_000;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function dateKey(iso: string): string {
  const parts = dayFormatter.formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function money(value: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(value)}đ`;
}

function positiveInteger(value: unknown, field: string, min = 1): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${field} phải là số nguyên từ ${min}`);
  return parsed;
}

function unitRate(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Đơn giá phải là số nguyên không âm');
  return parsed;
}

function makeBindCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

function recordProcessed(state: TelegramWorkState, updateId: number, outcome: string): void {
  state.processedUpdates.push({ updateId, outcome, processedAt: new Date().toISOString() });
  if (state.processedUpdates.length > MAX_PROCESSED_UPDATES) {
    state.processedUpdates.splice(0, state.processedUpdates.length - MAX_PROCESSED_UPDATES);
  }
}

export function hasHeart(reactions: TelegramReaction[] | undefined): boolean {
  return Boolean(reactions?.some((reaction) => reaction.type === 'emoji' && reaction.emoji === '❤️'));
}

export function employeeTotals(
  state: TelegramWorkState,
  employeeId: string,
  now = new Date(),
): EmployeeTotals {
  const today = dateKey(now.toISOString());
  const month = today.slice(0, 7);
  const active = state.earnings.filter((entry) => entry.employeeId === employeeId && entry.status === 'active');
  const todayEntries = active.filter((entry) => dateKey(entry.createdAt) === today);
  const monthEntries = active.filter((entry) => dateKey(entry.createdAt).startsWith(month));
  const sum = (entries: typeof active, key: 'quantity' | 'amount') => entries.reduce((total, entry) => total + entry[key], 0);
  return {
    pendingTasks: state.tasks.filter((task) => task.employeeId === employeeId && task.status === 'pending').length,
    todayQuantity: sum(todayEntries, 'quantity'),
    todayAmount: sum(todayEntries, 'amount'),
    monthQuantity: sum(monthEntries, 'quantity'),
    monthAmount: sum(monthEntries, 'amount'),
    allQuantity: sum(active, 'quantity'),
    allAmount: sum(active, 'amount'),
  };
}

function taskMessage(task: WorkTask, employee: WorkEmployee, cancelled = false): string {
  const lines = [
    cancelled ? '❌ CÔNG VIỆC ĐÃ HỦY' : '📌 CÔNG VIỆC MỚI',
    '',
    `Nhân viên: ${employee.fullName}`,
    `Nội dung: ${task.description}`,
    `Số lượng: ${task.quantity} con`,
  ];
  if (employee.salaryVisibility === 'topic') {
    lines.push(`Đơn giá: ${money(task.unitRate)}/con`, `Tiền công: ${money(task.amount)}`);
  }
  if (task.deadline) lines.push(`Deadline: ${new Date(task.deadline).toLocaleString('vi-VN', { timeZone: TIME_ZONE })}`);
  if (!cancelled) lines.push('', '👉 Thả tim (❤️) vào tin nhắn này để xác nhận hoàn thành.');
  lines.push(`Mã: ${task.id.slice(0, 8)}`);
  return lines.join('\n');
}

interface ReactionAction {
  kind: 'completed' | 'reopened' | 'ignored' | 'duplicate';
  task?: WorkTask;
  employee?: WorkEmployee;
  totals?: EmployeeTotals;
  reason?: string;
}

export class TelegramWorkService {
  private pollGeneration = 0;
  private pollingActive = false;
  private pollAbort?: AbortController;

  constructor(
    private readonly store: TelegramWorkStore,
    private readonly settings: SettingsStore,
    private readonly telegram: TelegramBotApi,
  ) {}

  async init(): Promise<void> {
    await this.store.init();
    await this.refreshPolling();
  }

  async close(): Promise<void> {
    this.pollGeneration += 1;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    this.pollingActive = false;
  }

  configDto() {
    const token = this.settings.getWorkTelegramBotToken();
    return {
      hasToken: Boolean(token),
      tokenMasked: token ? `${token.slice(0, 5)}…${token.slice(-4)}` : null,
      chatId: this.settings.getWorkTelegramChatId() ?? '',
      mode: this.settings.getWorkTelegramMode(),
      webhookUrl: this.settings.getWorkTelegramWebhookUrl() ?? '',
      pollingActive: this.pollingActive,
    };
  }

  async saveConfig(input: { botToken?: string; chatId?: string }): Promise<ReturnType<TelegramWorkService['configDto']>> {
    if (input.botToken !== undefined) await this.settings.setWorkTelegramBotToken(input.botToken);
    if (input.chatId !== undefined) await this.settings.setWorkTelegramChatId(input.chatId);
    await this.refreshPolling();
    return this.configDto();
  }

  async enablePolling(): Promise<ReturnType<TelegramWorkService['configDto']>> {
    const token = this.requireToken();
    this.requireChatId();
    await this.telegram.deleteWebhook(token);
    await this.settings.setWorkTelegramMode('polling');
    await this.refreshPolling();
    return this.configDto();
  }

  async configureWebhook(rawUrl: string): Promise<ReturnType<TelegramWorkService['configDto']>> {
    const token = this.requireToken();
    this.requireChatId();
    const trimmed = rawUrl.trim().replace(/\/+$/, '');
    if (!trimmed.startsWith('https://')) throw new Error('Webhook URL phải bắt đầu bằng https://');
    const url = trimmed.endsWith('/api/work/telegram/webhook')
      ? trimmed
      : `${trimmed}/api/work/telegram/webhook`;
    const secret = this.settings.getWorkTelegramWebhookSecret() ?? randomBytes(24).toString('base64url');
    await this.telegram.setWebhook(token, url, secret);
    await this.settings.setWorkTelegramWebhookUrl(url);
    await this.settings.setWorkTelegramWebhookSecret(secret);
    await this.settings.setWorkTelegramMode('webhook');
    await this.refreshPolling();
    return this.configDto();
  }

  async disableTelegram(): Promise<ReturnType<TelegramWorkService['configDto']>> {
    const token = this.settings.getWorkTelegramBotToken();
    if (token && this.settings.getWorkTelegramMode() === 'webhook') {
      await this.telegram.deleteWebhook(token);
    }
    await this.settings.setWorkTelegramMode('off');
    await this.refreshPolling();
    return this.configDto();
  }

  listEmployees(): WorkEmployeeDto[] {
    const state = this.store.snapshot();
    return state.employees
      .map((employee) => ({ ...employee, totals: employeeTotals(state, employee.id) }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
  }

  listTasks(): WorkTask[] {
    return this.store.snapshot().tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  payroll(): PayrollRow[] {
    const state = this.store.snapshot();
    return state.employees
      .filter((employee) => employee.status !== 'archived')
      .map((employee) => ({
        employeeId: employee.id,
        fullName: employee.fullName,
        defaultUnitRate: employee.defaultUnitRate,
        totals: employeeTotals(state, employee.id),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
  }

  async createEmployee(input: {
    fullName: string;
    defaultUnitRate: number;
    salaryVisibility?: SalaryVisibility;
  }): Promise<WorkEmployeeDto> {
    const fullName = input.fullName.trim();
    if (!fullName) throw new Error('Tên nhân viên là bắt buộc');
    const now = new Date().toISOString();
    const employee = await this.store.mutate((state) => {
      const created: WorkEmployee = {
        id: randomUUID(),
        fullName,
        defaultUnitRate: unitRate(input.defaultUnitRate),
        salaryVisibility: input.salaryVisibility ?? 'topic',
        status: 'unbound',
        bindCode: makeBindCode(),
        createdAt: now,
        updatedAt: now,
      };
      state.employees.push(created);
      return created;
    });
    return { ...employee, totals: employeeTotals(this.store.snapshot(), employee.id) };
  }

  async updateEmployee(id: string, input: {
    fullName?: string;
    defaultUnitRate?: number;
    salaryVisibility?: SalaryVisibility;
    status?: 'active' | 'inactive';
  }): Promise<WorkEmployeeDto> {
    const before = this.store.snapshot().employees.find((item) => item.id === id);
    if (!before) throw new Error('Không tìm thấy nhân viên');
    const updated = await this.store.mutate((state) => {
      const employee = state.employees.find((item) => item.id === id);
      if (!employee) throw new Error('Không tìm thấy nhân viên');
      if (input.fullName !== undefined) {
        const name = input.fullName.trim();
        if (!name) throw new Error('Tên nhân viên không được trống');
        employee.fullName = name;
      }
      if (input.defaultUnitRate !== undefined) employee.defaultUnitRate = unitRate(input.defaultUnitRate);
      if (input.salaryVisibility !== undefined) employee.salaryVisibility = input.salaryVisibility;
      if (input.status !== undefined) {
        if (input.status === 'active' && (!employee.telegramUserId || !employee.telegramChatId || !employee.telegramTopicId)) {
          throw new Error('Chưa thể bật hoạt động: nhân viên chưa bind đủ Telegram user/topic');
        }
        employee.status = input.status;
      }
      employee.updatedAt = new Date().toISOString();
      return structuredClone(employee);
    });

    if (before.fullName !== updated.fullName && updated.telegramChatId && updated.telegramTopicId) {
      const token = this.settings.getWorkTelegramBotToken();
      if (token) {
        await this.telegram.editForumTopic(token, updated.telegramChatId, updated.telegramTopicId, updated.fullName)
          .catch((err) => log.warn(`đổi tên topic lỗi: ${(err as Error).message}`));
      }
    }
    return { ...updated, totals: employeeTotals(this.store.snapshot(), updated.id) };
  }

  async archiveEmployee(id: string): Promise<void> {
    await this.store.mutate((state) => {
      const employee = state.employees.find((item) => item.id === id);
      if (!employee) throw new Error('Không tìm thấy nhân viên');
      employee.status = 'archived';
      employee.updatedAt = new Date().toISOString();
    });
  }

  async regenerateBindCode(id: string): Promise<WorkEmployeeDto> {
    const employee = await this.store.mutate((state) => {
      const found = state.employees.find((item) => item.id === id);
      if (!found) throw new Error('Không tìm thấy nhân viên');
      found.bindCode = makeBindCode();
      found.telegramUserId = undefined;
      found.status = 'unbound';
      found.updatedAt = new Date().toISOString();
      return structuredClone(found);
    });
    return { ...employee, totals: employeeTotals(this.store.snapshot(), employee.id) };
  }

  async createEmployeeTopic(id: string): Promise<WorkEmployeeDto> {
    const token = this.requireToken();
    const chatId = this.requireChatId();
    const employee = this.store.snapshot().employees.find((item) => item.id === id);
    if (!employee) throw new Error('Không tìm thấy nhân viên');
    if (employee.telegramTopicId) throw new Error('Nhân viên đã có topic');
    const topic = await this.telegram.createForumTopic(token, chatId, employee.fullName);
    const updated = await this.store.mutate((state) => {
      const found = state.employees.find((item) => item.id === id);
      if (!found) throw new Error('Không tìm thấy nhân viên');
      found.telegramChatId = chatId;
      found.telegramTopicId = topic.message_thread_id;
      found.status = found.telegramUserId ? 'active' : 'unbound';
      found.updatedAt = new Date().toISOString();
      return structuredClone(found);
    });
    return { ...updated, totals: employeeTotals(this.store.snapshot(), updated.id) };
  }

  async testEmployeeTopic(id: string): Promise<void> {
    const token = this.requireToken();
    const employee = this.store.snapshot().employees.find((item) => item.id === id);
    if (!employee?.telegramChatId || !employee.telegramTopicId) throw new Error('Nhân viên chưa liên kết topic');
    await this.telegram.sendMessage(token, {
      chatId: employee.telegramChatId,
      threadId: employee.telegramTopicId,
      text: `✅ Kết nối thành công với ${employee.fullName}.\nMã bind hiện tại: /bind ${employee.bindCode}`,
    });
  }

  async createTask(input: {
    employeeId: string;
    description: string;
    deadline?: string;
    quantity?: number;
    unitRate?: number;
  }): Promise<WorkTask> {
    const token = this.requireToken();
    const state = this.store.snapshot();
    const employee = state.employees.find((item) => item.id === input.employeeId);
    if (!employee || employee.status !== 'active') throw new Error('Nhân viên chưa hoạt động hoặc chưa bind');
    if (!employee.telegramChatId || !employee.telegramTopicId || !employee.telegramUserId) {
      throw new Error('Nhân viên chưa liên kết đầy đủ Telegram user/topic');
    }
    const description = input.description.trim();
    if (!description) throw new Error('Nội dung công việc là bắt buộc');
    const quantity = positiveInteger(input.quantity ?? 1, 'Số lượng');
    const rate = input.unitRate === undefined ? employee.defaultUnitRate : unitRate(input.unitRate);
    const now = new Date().toISOString();
    const task = await this.store.mutate((draft) => {
      const created: WorkTask = {
        id: randomUUID(),
        employeeId: employee.id,
        description,
        deadline: input.deadline || undefined,
        quantity,
        unitRate: rate,
        amount: quantity * rate,
        status: 'queued',
        deliveryStatus: 'queued',
        createdAt: now,
        updatedAt: now,
      };
      draft.tasks.push(created);
      return created;
    });

    try {
      const sent = await this.telegram.sendMessage(token, {
        chatId: employee.telegramChatId,
        threadId: employee.telegramTopicId,
        text: taskMessage(task, employee),
      });
      return await this.store.mutate((draft) => {
        const saved = draft.tasks.find((item) => item.id === task.id)!;
        saved.status = 'pending';
        saved.deliveryStatus = 'sent';
        saved.telegramChatId = employee.telegramChatId;
        saved.telegramTopicId = employee.telegramTopicId;
        saved.telegramMessageId = sent.message_id;
        saved.updatedAt = new Date().toISOString();
        return structuredClone(saved);
      });
    } catch (err) {
      await this.store.mutate((draft) => {
        const saved = draft.tasks.find((item) => item.id === task.id)!;
        saved.status = 'failed';
        saved.deliveryStatus = 'failed';
        saved.deliveryError = (err as Error).message;
        saved.updatedAt = new Date().toISOString();
      });
      throw err;
    }
  }

  async updateTask(id: string, input: {
    description?: string;
    deadline?: string | null;
    quantity?: number;
    unitRate?: number;
  }): Promise<WorkTask> {
    const token = this.requireToken();
    const state = this.store.snapshot();
    const current = state.tasks.find((item) => item.id === id);
    if (!current) throw new Error('Không tìm thấy công việc');
    if (current.status !== 'pending') throw new Error('Chỉ sửa được công việc đang chờ');
    const employee = state.employees.find((item) => item.id === current.employeeId)!;
    const next: WorkTask = {
      ...current,
      description: input.description === undefined ? current.description : input.description.trim(),
      deadline: input.deadline === undefined ? current.deadline : input.deadline || undefined,
      quantity: input.quantity === undefined ? current.quantity : positiveInteger(input.quantity, 'Số lượng'),
      unitRate: input.unitRate === undefined ? current.unitRate : unitRate(input.unitRate),
      updatedAt: new Date().toISOString(),
    };
    if (!next.description) throw new Error('Nội dung công việc không được trống');
    next.amount = next.quantity * next.unitRate;
    if (next.telegramChatId && next.telegramMessageId) {
      await this.telegram.editMessageText(token, {
        chatId: next.telegramChatId,
        messageId: next.telegramMessageId,
        text: taskMessage(next, employee),
      });
    }
    return this.store.mutate((draft) => {
      const index = draft.tasks.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('Không tìm thấy công việc');
      draft.tasks[index] = next;
      return structuredClone(next);
    });
  }

  async retryTask(id: string): Promise<WorkTask> {
    const token = this.requireToken();
    const state = this.store.snapshot();
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new Error('Không tìm thấy công việc');
    if (task.status !== 'failed') throw new Error('Chỉ gửi lại được công việc đang lỗi');
    const employee = state.employees.find((item) => item.id === task.employeeId);
    if (!employee || employee.status !== 'active' || !employee.telegramChatId || !employee.telegramTopicId) {
      throw new Error('Nhân viên không hoạt động hoặc chưa có topic');
    }
    const sent = await this.telegram.sendMessage(token, {
      chatId: employee.telegramChatId,
      threadId: employee.telegramTopicId,
      text: taskMessage(task, employee),
    });
    return this.store.mutate((draft) => {
      const saved = draft.tasks.find((item) => item.id === id)!;
      saved.status = 'pending';
      saved.deliveryStatus = 'sent';
      saved.deliveryError = undefined;
      saved.telegramChatId = employee.telegramChatId;
      saved.telegramTopicId = employee.telegramTopicId;
      saved.telegramMessageId = sent.message_id;
      saved.updatedAt = new Date().toISOString();
      return structuredClone(saved);
    });
  }

  async cancelTask(id: string): Promise<WorkTask> {
    const state = this.store.snapshot();
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new Error('Không tìm thấy công việc');
    if (!['pending', 'failed', 'queued'].includes(task.status)) throw new Error('Công việc không thể hủy ở trạng thái hiện tại');
    const employee = state.employees.find((item) => item.id === task.employeeId)!;
    if (task.telegramChatId && task.telegramMessageId) {
      await this.telegram.editMessageText(this.requireToken(), {
        chatId: task.telegramChatId,
        messageId: task.telegramMessageId,
        text: taskMessage(task, employee, true),
      });
    }
    return this.store.mutate((draft) => {
      const saved = draft.tasks.find((item) => item.id === id)!;
      saved.status = 'cancelled';
      saved.updatedAt = new Date().toISOString();
      return structuredClone(saved);
    });
  }

  async setTaskCompletion(id: string, completed: boolean): Promise<WorkTask> {
    const action = await this.store.mutate((state): ReactionAction => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Không tìm thấy công việc');
      const employee = state.employees.find((item) => item.id === task.employeeId)!;
      if (completed) {
        if (task.status !== 'pending') throw new Error('Chỉ hoàn thành được công việc đang chờ');
        this.completeTaskInState(state, task, 'manual');
        return { kind: 'completed', task: structuredClone(task), employee: structuredClone(employee), totals: employeeTotals(state, employee.id) };
      }
      if (task.status !== 'completed') throw new Error('Công việc chưa hoàn thành');
      this.reopenTaskInState(state, task);
      return { kind: 'reopened', task: structuredClone(task), employee: structuredClone(employee), totals: employeeTotals(state, employee.id) };
    });
    await this.notifyReaction(action);
    return action.task!;
  }

  async processWebhook(secret: string | undefined, update: TelegramUpdate): Promise<void> {
    if (!this.isWebhookSecretValid(secret)) throw new Error('Webhook secret không hợp lệ');
    await this.processUpdate(update);
  }

  isWebhookSecretValid(secret: string | undefined): boolean {
    const expected = this.settings.getWorkTelegramWebhookSecret();
    return this.settings.getWorkTelegramMode() === 'webhook' && Boolean(expected && secret === expected);
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    if (this.store.snapshot().processedUpdates.some((item) => item.updateId === update.update_id)) return;
    if (update.message?.text && /^\/bind(?:@\w+)?\s+/i.test(update.message.text)) {
      await this.processBind(update);
      return;
    }
    if (update.message_reaction) {
      const action = await this.processReaction(update);
      await this.notifyReaction(action);
    }
  }

  private async processBind(update: TelegramUpdate): Promise<void> {
    const message = update.message!;
    const match = /^\/bind(?:@\w+)?\s+([A-Z0-9-]+)\s*$/i.exec(message.text ?? '');
    if (!match || !message.from) return;
    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    const topicId = message.message_thread_id;
    const configuredChat = this.settings.getWorkTelegramChatId();
    const result = await this.store.mutate((state) => {
      if (state.processedUpdates.some((item) => item.updateId === update.update_id)) return { duplicate: true };
      let text = '';
      if (!configuredChat) {
        text = '❌ App chưa cấu hình Supergroup chat ID.';
      } else if (configuredChat !== chatId) {
        text = '❌ Lệnh bind được gửi sai Supergroup.';
      } else if (!topicId) {
        text = '❌ Hãy gửi lệnh /bind bên trong topic của nhân viên.';
      } else {
        const employee = state.employees.find((item) => item.bindCode.toUpperCase() === match[1].toUpperCase());
        const topicOwner = state.employees.find((item) => item.id !== employee?.id && item.telegramChatId === chatId && item.telegramTopicId === topicId);
        const userOwner = state.employees.find((item) => item.id !== employee?.id && item.telegramUserId === userId && item.status !== 'archived');
        if (!employee || employee.status === 'archived') text = '❌ Mã bind không hợp lệ hoặc đã hết hạn.';
        else if (employee.telegramTopicId && employee.telegramTopicId !== topicId) text = '❌ Mã này phải được gửi trong topic đã gán cho nhân viên.';
        else if (topicOwner) text = `❌ Topic này đã thuộc về ${topicOwner.fullName}.`;
        else if (userOwner) text = `❌ Tài khoản Telegram này đã liên kết với ${userOwner.fullName}.`;
        else {
          employee.telegramUserId = userId;
          employee.telegramChatId = chatId;
          employee.telegramTopicId = topicId;
          employee.status = 'active';
          employee.bindCode = makeBindCode();
          employee.updatedAt = new Date().toISOString();
          text = `✅ Đã liên kết ${employee.fullName} với topic này.`;
        }
      }
      recordProcessed(state, update.update_id, text);
      return { duplicate: false, text };
    });
    if (!result.duplicate) {
      await this.telegram.sendMessage(this.requireToken(), { chatId, threadId: topicId, text: result.text! })
        .catch((err) => log.warn(`phản hồi bind lỗi: ${(err as Error).message}`));
    }
  }

  private async processReaction(update: TelegramUpdate): Promise<ReactionAction> {
    const reaction = update.message_reaction!;
    return this.store.mutate((state): ReactionAction => {
      if (state.processedUpdates.some((item) => item.updateId === update.update_id)) return { kind: 'duplicate' };
      const chatId = String(reaction.chat.id);
      const task = state.tasks.find((item) => item.telegramChatId === chatId && item.telegramMessageId === reaction.message_id);
      if (!task) {
        recordProcessed(state, update.update_id, 'ignored: unknown task message');
        return { kind: 'ignored', reason: 'unknown-task' };
      }
      const employee = state.employees.find((item) => item.id === task.employeeId);
      const userId = reaction.user ? String(reaction.user.id) : undefined;
      if (!employee || !userId || employee.telegramUserId !== userId) {
        recordProcessed(state, update.update_id, 'ignored: wrong user or anonymous actor');
        return { kind: 'ignored', reason: 'wrong-user' };
      }

      const oldHeart = hasHeart(reaction.old_reaction);
      const newHeart = hasHeart(reaction.new_reaction);
      if (!oldHeart && newHeart && task.status === 'pending') {
        this.completeTaskInState(state, task, userId);
        const totals = employeeTotals(state, employee.id);
        recordProcessed(state, update.update_id, `completed:${task.id}`);
        return { kind: 'completed', task: structuredClone(task), employee: structuredClone(employee), totals };
      }
      if (oldHeart && !newHeart && task.status === 'completed' && task.completedByUserId === userId) {
        this.reopenTaskInState(state, task);
        const totals = employeeTotals(state, employee.id);
        recordProcessed(state, update.update_id, `reopened:${task.id}`);
        return { kind: 'reopened', task: structuredClone(task), employee: structuredClone(employee), totals };
      }
      recordProcessed(state, update.update_id, 'ignored: no state transition');
      return { kind: 'ignored', reason: 'no-transition' };
    });
  }

  private completeTaskInState(state: TelegramWorkState, task: WorkTask, userId: string): void {
    const now = new Date().toISOString();
    task.status = 'completed';
    task.completedAt = now;
    task.completedByUserId = userId;
    task.updatedAt = now;
    const active = state.earnings.find((entry) => entry.taskId === task.id && entry.status === 'active');
    if (!active) {
      state.earnings.push({
        id: randomUUID(),
        taskId: task.id,
        employeeId: task.employeeId,
        quantity: task.quantity,
        unitRate: task.unitRate,
        amount: task.amount,
        status: 'active',
        createdAt: now,
      });
    }
  }

  private reopenTaskInState(state: TelegramWorkState, task: WorkTask): void {
    const now = new Date().toISOString();
    task.status = 'pending';
    task.completedAt = undefined;
    task.completedByUserId = undefined;
    task.updatedAt = now;
    for (const entry of state.earnings) {
      if (entry.taskId === task.id && entry.status === 'active') {
        entry.status = 'void';
        entry.voidedAt = now;
      }
    }
  }

  private async notifyReaction(action: ReactionAction): Promise<void> {
    if (!action.task || !action.employee || !action.totals || !['completed', 'reopened'].includes(action.kind)) return;
    const token = this.settings.getWorkTelegramBotToken();
    const task = action.task;
    if (!token || !task.telegramChatId || !task.telegramMessageId) return;

    const completed = action.kind === 'completed';
    await this.telegram.setMessageReaction(token, {
      chatId: task.telegramChatId,
      messageId: task.telegramMessageId,
      emoji: completed ? '❤️' : undefined,
    }).catch((err) => log.warn(`bot thả reaction lỗi: ${(err as Error).message}`));

    const fullText = completed
      ? [
          `✅ Đã ghi nhận ${action.employee.fullName}`,
          `+${task.quantity} con × ${money(task.unitRate)} = ${money(task.amount)}`,
          `Hôm nay: ${action.totals.todayQuantity} con — ${money(action.totals.todayAmount)}`,
          `Tháng này: ${action.totals.monthQuantity} con — ${money(action.totals.monthAmount)}`,
        ].join('\n')
      : [
          `↩️ Đã gỡ hoàn thành của ${action.employee.fullName}`,
          `-${task.quantity} con — ${money(task.amount)}`,
          `Hôm nay còn: ${action.totals.todayQuantity} con — ${money(action.totals.todayAmount)}`,
        ].join('\n');
    const shortText = completed
      ? `✅ Đã cộng ${task.quantity} con cho ${action.employee.fullName}.`
      : `↩️ Đã trừ lại ${task.quantity} con của ${action.employee.fullName}.`;
    const topicText = action.employee.salaryVisibility === 'topic' ? fullText : shortText;
    await this.telegram.sendMessage(token, {
      chatId: task.telegramChatId,
      threadId: task.telegramTopicId,
      replyToMessageId: task.telegramMessageId,
      text: topicText,
    }).catch((err) => log.warn(`gửi kết quả reaction lỗi: ${(err as Error).message}`));

    if (action.employee.salaryVisibility === 'private' && action.employee.telegramUserId) {
      await this.telegram.sendMessage(token, { chatId: action.employee.telegramUserId, text: fullText })
        .catch((err) => log.warn(`gửi lương riêng lỗi (nhân viên cần /start bot): ${(err as Error).message}`));
    }
  }

  private requireToken(): string {
    const token = this.settings.getWorkTelegramBotToken();
    if (!token) throw new Error('Chưa cấu hình bot token cho module Công việc');
    return token;
  }

  private requireChatId(): string {
    const chatId = this.settings.getWorkTelegramChatId();
    if (!chatId) throw new Error('Chưa cấu hình Supergroup chat ID');
    return chatId;
  }

  private async refreshPolling(): Promise<void> {
    const generation = ++this.pollGeneration;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    this.pollingActive = false;
    const token = this.settings.getWorkTelegramBotToken();
    if (!token || this.settings.getWorkTelegramMode() !== 'polling') return;
    const controller = new AbortController();
    this.pollAbort = controller;
    this.pollingActive = true;
    void this.pollLoop(generation, token, controller.signal);
  }

  private async pollLoop(generation: number, token: string, signal: AbortSignal): Promise<void> {
    log.info('Telegram polling đã bật');
    while (generation === this.pollGeneration && this.settings.getWorkTelegramMode() === 'polling') {
      const offset = this.store.snapshot().pollingOffset;
      try {
        const updates = await this.telegram.getUpdates(token, offset, signal);
        if (generation !== this.pollGeneration) break;
        for (const update of updates) {
          try {
            await this.processUpdate(update);
          } catch (err) {
            log.error(`xử lý update ${update.update_id} lỗi: ${(err as Error).message}`);
          } finally {
            await this.store.mutate((state) => {
              state.pollingOffset = Math.max(state.pollingOffset, update.update_id + 1);
            });
          }
        }
      } catch (err) {
        if (generation !== this.pollGeneration) break;
        log.warn(`Telegram polling lỗi: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    if (generation === this.pollGeneration) this.pollingActive = false;
  }
}
