import type { Fetcher } from '../utils/http.ts';

export interface InlineButton { text: string; callback_data?: string; url?: string; web_app?: { url: string } }
export type Keyboard = InlineButton[][];

export class TelegramClient {
  private token: string;
  private fetcher: Fetcher;
  /** Сколько запросов к Telegram сделано за вызов Worker (учитывается в лимите внешних запросов). */
  calls = 0;

  constructor(token: string, fetcher?: Fetcher) {
    this.token = token;
    this.fetcher = fetcher ?? ((i, init) => fetch(i, init));
  }

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    this.calls++;
    const res = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!json?.ok) {
      // Токен никогда не попадает в текст ошибки.
      throw new Error(`Telegram ${method}: ${json?.description ?? 'HTTP ' + res.status}`);
    }
    return json.result as T;
  }

  sendMessage(chatId: number, text: string, keyboard?: Keyboard): Promise<{ message_id: number }> {
    return this.call('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  async editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (e) {
      // "message is not modified" — не ошибка.
      if (!String((e as Error).message).includes('not modified')) throw e;
    }
  }

  /** Кнопка «Приложение» слева от поля ввода в чате с ботом. */
  setMenuButton(chatId: number, url: string): Promise<unknown> {
    return this.call('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'web_app', text: 'Приложение', web_app: { url } } });
  }

  answerCallback(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
