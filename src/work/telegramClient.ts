import type { TelegramUpdate } from './types.js';

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export interface TelegramBotApi {
  sendMessage(token: string, input: {
    chatId: string;
    threadId?: number;
    text: string;
    replyToMessageId?: number;
    parseMode?: 'HTML';
    disableLinkPreview?: boolean;
  }): Promise<{ message_id: number }>;
  editMessageText(token: string, input: {
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: 'HTML';
    disableLinkPreview?: boolean;
  }): Promise<void>;
  setMessageReaction(token: string, input: { chatId: string; messageId: number; emoji?: string }): Promise<void>;
  createForumTopic(token: string, chatId: string, name: string): Promise<{ message_thread_id: number; name: string }>;
  editForumTopic(token: string, chatId: string, threadId: number, name: string): Promise<void>;
  getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  setWebhook(token: string, url: string, secret: string): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
}

export class TelegramClient implements TelegramBotApi {
  private async call<T>(token: string, method: string, body: unknown, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        const payload = (await response.json().catch(() => ({}))) as TelegramEnvelope<T>;
        if (response.ok && payload.ok && payload.result !== undefined) return payload.result;

        const error = new TelegramApiError(
          payload.description || `Telegram ${method} HTTP ${response.status}`,
          response.status,
          payload.error_code,
          payload.parameters?.retry_after,
        );
        if (response.status === 429 && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(1, error.retryAfter ?? 1) * 1_000));
          continue;
        }
        if (response.status >= 500 && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
          continue;
        }
        throw error;
      } catch (err) {
        lastError = err as Error;
        if (signal?.aborted) throw err;
        if (err instanceof TelegramApiError || attempt >= 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
    throw lastError ?? new Error(`Telegram ${method} thất bại`);
  }

  sendMessage(token: string, input: {
    chatId: string;
    threadId?: number;
    text: string;
    replyToMessageId?: number;
    parseMode?: 'HTML';
    disableLinkPreview?: boolean;
  }): Promise<{ message_id: number }> {
    return this.call(token, 'sendMessage', {
      chat_id: input.chatId,
      message_thread_id: input.threadId,
      text: input.text,
      parse_mode: input.parseMode,
      link_preview_options: input.disableLinkPreview ? { is_disabled: true } : undefined,
      reply_parameters: input.replyToMessageId ? { message_id: input.replyToMessageId } : undefined,
    });
  }

  async editMessageText(token: string, input: {
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: 'HTML';
    disableLinkPreview?: boolean;
  }): Promise<void> {
    await this.call(token, 'editMessageText', {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      parse_mode: input.parseMode,
      link_preview_options: input.disableLinkPreview ? { is_disabled: true } : undefined,
    });
  }

  async setMessageReaction(token: string, input: { chatId: string; messageId: number; emoji?: string }): Promise<void> {
    await this.call(token, 'setMessageReaction', {
      chat_id: input.chatId,
      message_id: input.messageId,
      reaction: input.emoji ? [{ type: 'emoji', emoji: input.emoji }] : [],
    });
  }

  createForumTopic(token: string, chatId: string, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call(token, 'createForumTopic', { chat_id: chatId, name });
  }

  async editForumTopic(token: string, chatId: string, threadId: number, name: string): Promise<void> {
    await this.call(token, 'editForumTopic', { chat_id: chatId, message_thread_id: threadId, name });
  }

  getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(token, 'getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message', 'message_reaction'],
    }, 32_000, signal);
  }

  async setWebhook(token: string, url: string, secret: string): Promise<void> {
    await this.call(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'message_reaction'],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook(token: string): Promise<void> {
    await this.call(token, 'deleteWebhook', { drop_pending_updates: false });
  }
}
