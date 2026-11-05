// Предложка: подписчик присылает боту идею, новость или находку (текст и/или картинку),
// владелец получает её с кнопками и решает — опубликовать в канале или нет. Автор узнаёт решение.

import { esc, type TelegramClient } from './api.ts';
import { say, type H } from './context.ts';
import * as db from '../storage/db.ts';
import { botButton, botUsername, getMeta } from '../core/channel.ts';

export const SUGGEST_PER_DAY = 3;
export const SUGGEST_MIN = 10;
export const SUGGEST_MAX = 900; // подпись к фото в канале — до 1024 символов вместе с заголовком

/** Текст подписчика: без служебных символов и маркеров денег бота. */
export function cleanSuggestion(t: unknown): string {
  return typeof t === 'string' ? t.replace(/[\u0000-\u0008\u000b-\u001f​-‏‪-‮⟦⟧]/g, '').replace(/\n{3,}/g, '\n\n').trim() : '';
}

export async function suggestStart(h: H): Promise<void> {
  if ((await db.getSettings(h.d, h.uid)).suggest_ban === '1') return say(h, 'Предложка для тебя закрыта.');
  if (!(await getMeta(h.d, 'channel_id'))) return say(h, 'Канал пока не подключён — предложка заработает чуть позже.');
  await db.setState(h.d, h.uid, 'suggest', null, h.now);
  return say(h, [
    '💡 <b>Предложка канала</b>',
    '',
    'Пришли одним сообщением, что стоит опубликовать: новость, находку на рынке, идею, полезный совет. Можно с картинкой (подпись — в том же сообщении).',
    '',
    'Владелец посмотрит и решит, публиковать ли. Публикуется без твоего имени — «от подписчика». Ссылки на сторонние сайты и реклама не публикуются.',
  ].join('\n'), [[{ text: 'Отмена', callback_data: 'm' }]]);
}

/** Сохранить предложение и отправить владельцу. Возвращает текст ошибки или null. Используется ботом и приложением. */
export async function submitSuggestion(d: D1Database, tg: TelegramClient, adminId: number, uid: number, rawText: unknown, photo: string | null, now: number, isAdmin = false): Promise<string | null> {
  if ((await db.getSettings(d, uid)).suggest_ban === '1') return 'Предложка для тебя закрыта.';
  if (!(await getMeta(d, 'channel_id'))) return 'Канал пока не подключён — предложка заработает чуть позже.';
  const text = cleanSuggestion(rawText);
  if (text.length < SUGGEST_MIN && !photo) return `Слишком коротко — опиши хотя бы парой предложений (от ${SUGGEST_MIN} символов).`;
  if (text.length > SUGGEST_MAX) return `Слишком длинно — до ${SUGGEST_MAX} символов. Сократи и пришли ещё раз.`;
  const n = (await d.prepare('SELECT COUNT(*) AS n FROM suggestions WHERE telegram_id = ? AND created_at >= ?').bind(uid, now - 86400).first<{ n: number }>())?.n ?? 0;
  if (n >= SUGGEST_PER_DAY && !isAdmin) return `Можно не больше ${SUGGEST_PER_DAY} предложений в сутки — попробуй завтра.`;
  const r = await d.prepare('INSERT INTO suggestions (telegram_id, text, photo, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(uid, text || null, photo, now).first<{ id: number }>();
  const id = r!.id;
  const head = `💡 <b>Предложка #${id}</b> от <code>${uid}</code>\n\n`;
  const kb = [[{ text: '✅ В канал', callback_data: `sg:pub:${id}` }, { text: '❌ Отклонить', callback_data: `sg:no:${id}` }], [{ text: '🚫 Закрыть предложку автору', callback_data: `sg:ban:${id}` }]];
  try {
    if (photo) await tg.sendPhoto(adminId, photo, head + esc(text), kb);
    else await tg.sendMessage(adminId, head + esc(text), kb);
  } catch { /* владелец увидит в базе */ }
  return null;
}

export const SUGGEST_THANKS = '✅ Спасибо! Отправил владельцу канала. Если опубликуем — напишу.';

/** Сообщение в режиме предложки. true — обработано. */
export async function suggestReceive(h: H, rawText: string | undefined, photo: string | null): Promise<boolean> {
  const st = await db.getState(h.d, h.uid, h.now);
  if (st?.awaiting !== 'suggest') return false;
  const err = await submitSuggestion(h.d, h.tg, Number(h.env.ADMIN_TELEGRAM_ID), h.uid, rawText, photo, h.now, h.isAdmin);
  // Слишком коротко/длинно — даём поправить, остальное — выходим из режима.
  if (!err || !/^Слишком/.test(err)) await db.clearState(h.d, h.uid);
  await say(h, err ? `❌ ${err}` : SUGGEST_THANKS);
  return true;
}

/** Текст поста в канале по предложке. */
export const suggestionPost = (text: string | null) => `💡 <b>Из предложки</b>${text ? `\n\n${esc(text)}` : ''}\n\n<i>Прислал подписчик. Есть что рассказать? Жми «Предложить пост».</i>`;

export const suggestButton = (user: string | null) => (user ? [[{ text: '💡 Предложить пост', url: `https://t.me/${user}?start=suggest` }]] : []);

/** Кнопки владельца под предложкой. */
export async function suggestDecide(h: H, action: string, id: number): Promise<void> {
  if (!h.isAdmin) return;
  const s = await h.d.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first<{ id: number; telegram_id: number; text: string | null; photo: string | null; status: string }>();
  if (!s) return say(h, 'Предложение не найдено.');
  if (s.status !== 'new' && action !== 'ban') return say(h, `#${id} уже ${s.status === 'posted' ? 'опубликовано' : 'отклонено'}.`);
  const tell = async (t: string) => { try { await h.tg.sendMessage(s.telegram_id, t); } catch { /* автор мог заблокировать бота */ } };
  if (action === 'pub') {
    const chat = Number(await getMeta(h.d, 'channel_id'));
    if (!chat) return say(h, 'Канал не подключён: /channel');
    const user = await botUsername(h.d, h.tg);
    const kb = [...suggestButton(user), ...botButton(user)];
    try {
      if (s.photo) await h.tg.sendPhoto(chat, s.photo, suggestionPost(s.text), kb);
      else await h.tg.sendMessage(chat, suggestionPost(s.text), kb);
    } catch (e) {
      return say(h, `⚠️ Не получилось опубликовать: ${esc((e as Error).message.slice(0, 200))}`);
    }
    await h.d.prepare(`UPDATE suggestions SET status = 'posted', decided_at = ? WHERE id = ?`).bind(h.now, id).run();
    await tell('🎉 Твоё предложение опубликовано в канале. Спасибо!');
    return say(h, `✅ #${id} опубликовано в канале.`);
  }
  if (action === 'no' || action === 'ban') {
    if (s.status === 'new') {
      await h.d.prepare(`UPDATE suggestions SET status = 'rejected', decided_at = ? WHERE id = ?`).bind(h.now, id).run();
      if (action === 'no') await tell('Спасибо за предложение! В этот раз публиковать не будем — присылай ещё.');
    }
    if (action === 'ban') {
      await db.setSetting(h.d, s.telegram_id, 'suggest_ban', '1', h.now);
      return say(h, `🚫 Предложка закрыта для <code>${s.telegram_id}</code>.`);
    }
    return say(h, `❌ #${id} отклонено, автор уведомлён.`);
  }
}
