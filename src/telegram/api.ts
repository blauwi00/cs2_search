import type { Fetcher } from '../utils/http.ts';
import { renderMoney, UAH_CUR, type Cur } from '../utils/money.ts';

export interface InlineButton { text: string; callback_data?: string; url?: string; web_app?: { url: string } }
export type Keyboard = InlineButton[][];

export class TelegramClient {
  private token: string;
  private fetcher: Fetcher;
  /** Сколько запросов к Telegram сделано за вызов Worker (учитывается в лимите внешних запросов). */
  calls = 0;
  /** Валюта получателя: суммы-метки ⟦копейки⟧ в тексте переводятся в неё перед отправкой. Без резолвера — гривна. */
  money: ((chatId: number) => Promise<Cur>) | null = null;

  constructor(token: string, fetcher?: Fetcher) {
    this.token = token;
    this.fetcher = fetcher ?? ((i, init) => fetch(i, init));
  }

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    this.calls++;
    for (const k of ['text', 'caption'] as const) {
      const v = body[k];
      if (typeof v === 'string' && v.includes('⟦')) {
        const chat = Number(body.chat_id);
        const cur = this.money && Number.isSafeInteger(chat) ? await this.money(chat).catch(() => UAH_CUR) : UAH_CUR;
        body = { ...body, [k]: renderMoney(v, cur) };
      }
    }
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

  /** image — адрес картинки: Telegram покажет её большим превью над текстом (лимит текста остаётся 4096, а не 1024 как у фото). */
  sendMessage(chatId: number, text: string, keyboard?: Keyboard, image?: string | null): Promise<{ message_id: number }> {
    return this.call('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML',
      link_preview_options: image ? { url: image, prefer_large_media: true, show_above_text: true } : { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /**
   * Пост канала: настоящая картинка (фото), а не ссылка с превью. Подпись у фото — до 1024 символов; если текст длиннее,
   * сначала уходит фото, затем текст с кнопками отдельным сообщением. Не получилось скачать картинку по адресу — старый вариант (превью ссылки).
   */
  async sendPost(chatId: number, text: string, keyboard: Keyboard | undefined, image: string | null): Promise<{ message_id: number }> {
    if (!image) return this.sendMessage(chatId, text, keyboard, null);
    try {
      if (text.length <= 1024) return await this.sendPhoto(chatId, image, text, keyboard);
      await this.call('sendPhoto', { chat_id: chatId, photo: image });
      return await this.sendMessage(chatId, text, keyboard, null);
    } catch (e) {
      if (/Forbidden|not enough rights|chat not found|kicked/i.test((e as Error).message)) throw e;
      return this.sendMessage(chatId, text, keyboard, image);
    }
  }

  /** Фото по file_id (уже лежит в Telegram) с подписью до 1024 символов. */
  sendPhoto(chatId: number, photo: string, caption: string, keyboard?: Keyboard): Promise<{ message_id: number }> {
    return this.call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  }

  async editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard, image?: string | null): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
        ...(image ? { link_preview_options: { url: image, prefer_large_media: true, show_above_text: true } } : { disable_web_page_preview: true }),
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (e) {
      const m = String((e as Error).message);
      // Пост-фото: у него не текст, а подпись.
      if (m.includes('no text in the message')) {
        try { await this.call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) }); return; }
        catch (e2) { if (String((e2 as Error).message).includes('not modified')) return; throw e2; }
      }
      // "message is not modified" — не ошибка.
      if (!m.includes('not modified')) throw e;
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
