// Команды владельца бота: подключение канала для автопостинга, предпросмотр постов, статистика пользователей.

import { esc } from './api.ts';
import { say, type H } from './context.ts';
import { buildPost, botButton, botUsername, getMeta, setMetaStmt, SLOTS, type Slot } from '../core/channel.ts';
import { loadScan } from '../storage/scan.ts';
import * as db from '../storage/db.ts';

const SLOT_RU: Record<Slot, string> = { ideas: 'Идеи дня (10:00)', trends: 'Растут в цене (15:00)', cases: 'Кейсы: дорожают/дешевеют (20:00)' };

export async function channelCommand(h: H, arg: string): Promise<void> {
  if (!h.isAdmin) return;
  const a = arg.trim();
  if (!a) {
    const id = await getMeta(h.d, 'channel_id');
    const title = await getMeta(h.d, 'channel_title');
    return say(h, [
      '<b>📣 Автопостинг в канал/группу</b>', '',
      id ? `Сейчас: <b>${esc(title ?? id)}</b>` : 'Сейчас: не подключён.', '',
      'Расписание (Варшава): ' + SLOTS.map((s) => SLOT_RU[s.slot]).join(', ') + '.',
      'Если показать нечего (нет выгодных сделок) — пост пропускается.', '',
      'Как подключить:',
      '1. Создай канал или группу в Telegram.',
      '2. Добавь бота в администраторы с правом «Публикация сообщений».',
      '3. Пришли сюда: <code>/channel @имя_канала</code> (для закрытой группы — её ID, например <code>/channel -1001234567890</code>).', '',
      'Выключить: <code>/channel off</code> · Посмотреть пост заранее: <code>/post</code>',
    ].join('\n'));
  }
  if (a === 'off') {
    await h.d.prepare(`DELETE FROM meta WHERE key IN ('channel_id','channel_title')`).run();
    return say(h, 'Автопостинг выключен.');
  }
  const target = /^@[A-Za-z0-9_]{4,64}$/.test(a) ? a : /^-?\d{5,20}$/.test(a) ? Number(a) : null;
  if (target === null) return say(h, 'Не понял. Пример: <code>/channel @skinradar_ua</code> или <code>/channel -1001234567890</code>');
  try {
    const chat = await h.tg.call<{ id: number; title?: string; type: string; username?: string }>('getChat', { chat_id: target });
    const me = await h.tg.call<{ id: number; username?: string }>('getMe', {});
    const m = await h.tg.call<{ status: string; can_post_messages?: boolean }>('getChatMember', { chat_id: chat.id, user_id: me.id });
    const ok = m.status === 'administrator' && (chat.type !== 'channel' || m.can_post_messages !== false);
    if (!ok) return say(h, `❌ Бот не администратор в «${esc(chat.title ?? String(chat.id))}» или у него нет права публиковать. Дай права и повтори.`);
    const user = me.username ?? (await botUsername(h.d, h.tg));
    await h.tg.sendMessage(chat.id, [
      '👋 <b>Здесь каждый день — идеи по рынку скинов CS2</b>', '',
      '• 10:00 — где купить дешевле и где продать дороже (с учётом комиссий)',
      '• 15:00 — что растёт в цене',
      '• 20:00 — какие кейсы дорожают и дешевеют', '',
      'Цены в гривнах. Личные подсказки «купить / продать / держать», свой инвентарь Steam и уведомления — в боте 👇',
    ].join('\n'), botButton(user, '🤖 Открыть бота'));
    await h.d.batch([setMetaStmt(h.d, 'channel_id', String(chat.id)), setMetaStmt(h.d, 'channel_title', chat.title ?? chat.username ?? String(chat.id))]);
    return say(h, `✅ Подключено: <b>${esc(chat.title ?? String(chat.id))}</b>. Приветственный пост опубликован. Дальше — по расписанию.`);
  } catch (e) {
    return say(h, `❌ Не получилось: ${esc((e as Error).message).slice(0, 200)}\nПроверь имя канала и что бот добавлен в администраторы.`);
  }
}

export async function postPreview(h: H, arg: string): Promise<void> {
  if (!h.isAdmin) return;
  const slot = (['ideas', 'trends', 'cases'] as Slot[]).find((s) => s === arg.trim()) ?? 'ideas';
  const scan = await loadScan(h.d);
  const text = scan ? buildPost(slot, scan.entries, await db.loadLatestFx(h.d), h.now) : null;
  if (!text) return say(h, `Для «${SLOT_RU[slot]}» сейчас нечего публиковать — нет подходящих данных. Другие: <code>/post ideas</code>, <code>/post trends</code>, <code>/post cases</code>`);
  const channel = await getMeta(h.d, 'channel_id');
  await say(h, '👀 <b>Предпросмотр</b> — так пост будет выглядеть в канале:');
  await say(h, text, [...botButton(await botUsername(h.d, h.tg)), ...(channel ? [[{ text: '📣 Опубликовать сейчас', callback_data: `chpost:${slot}` }]] : [])]);
}

export async function publishNow(h: H, slot: string): Promise<void> {
  if (!h.isAdmin) return;
  const channel = await getMeta(h.d, 'channel_id');
  const s = (['ideas', 'trends', 'cases'] as Slot[]).find((x) => x === slot);
  if (!channel || !s) return say(h, 'Канал не подключён: /channel');
  const scan = await loadScan(h.d);
  const text = scan ? buildPost(s, scan.entries, await db.loadLatestFx(h.d), h.now) : null;
  if (!text) return say(h, 'Сейчас нечего публиковать.');
  try {
    await h.tg.sendMessage(Number(channel), text, botButton(await botUsername(h.d, h.tg)));
    return say(h, '✅ Опубликовано.');
  } catch (e) {
    return say(h, `❌ ${esc((e as Error).message).slice(0, 200)}`);
  }
}

/** Откуда приходят люди: /start <метка> (ch — канал, tt — TikTok и т.д.). Сохраняется первая метка. */
export function refStmt(d: D1Database, tid: number, ref: string, now: number): D1PreparedStatement | null {
  if (!/^[A-Za-z0-9_]{1,32}$/.test(ref)) return null;
  return d.prepare(`INSERT OR IGNORE INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'ref', ?, ?)`).bind(tid, ref.toLowerCase(), now);
}

export async function statsCommand(h: H): Promise<void> {
  if (!h.isAdmin) return;
  const day = h.now - 86400, week = h.now - 7 * 86400;
  const [tot, refs, steam, watch, ch] = await Promise.all([
    h.d.prepare('SELECT COUNT(*) AS n, SUM(created_at >= ?) AS d1, SUM(created_at >= ?) AS d7 FROM users').bind(day, week).first<{ n: number; d1: number | null; d7: number | null }>(),
    h.d.prepare(`SELECT COALESCE(s.value, 'без метки') AS ref, COUNT(*) AS n, SUM(u.created_at >= ?) AS d7 FROM users u
      LEFT JOIN user_settings s ON s.telegram_id = u.telegram_id AND s.key = 'ref' GROUP BY 1 ORDER BY n DESC LIMIT 10`).bind(week).all<{ ref: string; n: number; d7: number | null }>(),
    h.d.prepare('SELECT COUNT(*) AS n FROM users WHERE steam_id IS NOT NULL OR steam_vanity IS NOT NULL').first<{ n: number }>(),
    h.d.prepare('SELECT COUNT(DISTINCT telegram_id) AS u, COUNT(DISTINCT item_id) AS i FROM watchlist WHERE active = 1').first<{ u: number; i: number }>(),
    getMeta(h.d, 'channel_title'),
  ]);
  const user = await botUsername(h.d, h.tg);
  return say(h, [
    '<b>📊 Статистика бота</b>', '',
    `Пользователей: <b>${tot?.n ?? 0}</b> (за сутки +${tot?.d1 ?? 0}, за неделю +${tot?.d7 ?? 0})`,
    `Подключили Steam: ${steam?.n ?? 0}`,
    `Со списком наблюдения: ${watch?.u ?? 0}, разных предметов: ${watch?.i ?? 0}`,
    `Канал: ${ch ? esc(ch) : 'не подключён'}`, '',
    '<b>Откуда пришли</b> (всего / за неделю):',
    ...refs.results.map((r) => `• ${esc(r.ref)}: ${r.n} / ${r.d7 ?? 0}`), '',
    'Ссылки с меткой для рекламы:',
    user ? `• TikTok: <code>https://t.me/${user}?start=tt</code>` : '',
    user ? `• канал: <code>https://t.me/${user}?start=ch</code>` : '',
    user ? '• любая своя метка: <code>?start=имя</code> (латиница, цифры, _)' : '',
  ].filter((x) => x !== '').join('\n'));
}
