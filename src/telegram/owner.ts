import { listCopies } from '../core/origin.ts';
import { SITES, loadRefLinks, checkRefUrl, setRefStmt } from '../core/sites.ts';
// Команды владельца бота: подключение канала для автопостинга, предпросмотр постов, статистика пользователей.

import { esc } from './api.ts';
import { say, type H } from './context.ts';
import { nextAllowed } from '../core/audience.ts';
import { composeChannelPost, botButton, botUsername, getMeta, setMetaStmt, SLOTS, ALL_SLOTS, type Slot } from '../core/channel.ts';

const SLOT_RU: Record<Slot, string> = { ideas: 'Рекомендации дня + итог вчерашних (10:00)', trends: 'Растут в цене (15:00)', cases: 'Кейсы: дорожают/дешевеют (20:00)', weekly: 'Итог недели (вс 19:00)' };

export async function channelCommand(h: H, arg: string): Promise<void> {
  if (!h.isAdmin) return;
  const a = arg.trim();
  if (!a) {
    const id = await getMeta(h.d, 'channel_id');
    const title = await getMeta(h.d, 'channel_title');
    return say(h, [
      '<b>📣 Автопостинг в канал/группу</b>', '',
      id ? `Сейчас: <b>${esc(title ?? id)}</b>` : 'Сейчас: не подключён.', '',
      'Расписание (Варшава): ' + SLOTS.map((s) => SLOT_RU[s.slot]).join(', ') + '. Плюс новости CS2 из Steam — сразу, как выходят.',
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
      '👋 <b>Рынок скинов CS2 — каждый день</b>', '',
      '💡 <b>10:00</b> — рекомендации дня: где купить дешевле и продать дороже',
      '📈 <b>15:00</b> — что растёт в цене',
      '📦 <b>20:00</b> — кейсы Steam: что дорожает и дешевеет',
      '📅 <b>Вс 19:00</b> — итоги недели',
      '🛠 Обновления CS2 — сразу, как выходят', '',
      '<blockquote>Цены — в долларах, комиссии площадок учтены. Каждое утро — честный итог вчерашних рекомендаций: сработали или нет.</blockquote>', '',
      'Личные подсказки, уведомления и твой инвентарь — в боте 👇',
    ].join('\n'), botButton(user, '🤖 Открыть бота'));
    await h.d.batch([setMetaStmt(h.d, 'channel_id', String(chat.id)), setMetaStmt(h.d, 'channel_title', chat.title ?? chat.username ?? String(chat.id))]);
    return say(h, `✅ Подключено: <b>${esc(chat.title ?? String(chat.id))}</b>. Приветственный пост опубликован. Дальше — по расписанию.`);
  } catch (e) {
    return say(h, `❌ Не получилось: ${esc((e as Error).message).slice(0, 200)}\nПроверь имя канала и что бот добавлен в администраторы.`);
  }
}

export async function postPreview(h: H, arg: string): Promise<void> {
  if (!h.isAdmin) return;
  const slot = ALL_SLOTS.find((s) => s === arg.trim()) ?? 'ideas';
  const p = await composeChannelPost(h.d, slot, h.now);
  if (!p) return say(h, `Для «${SLOT_RU[slot]}» сейчас нечего публиковать — нет подходящих данных. Другие: <code>/post ideas</code>, <code>/post trends</code>, <code>/post cases</code>, <code>/post weekly</code>`);
  const channel = await getMeta(h.d, 'channel_id');
  await say(h, '👀 <b>Предпросмотр</b> — так пост будет выглядеть в канале:');
  await h.tg.sendMessage(h.uid, p.text, [...botButton(await botUsername(h.d, h.tg)), ...(channel ? [[{ text: '📣 Опубликовать сейчас', callback_data: `chpost:${slot}` }]] : [])], p.image);
}

export async function publishNow(h: H, slot: string): Promise<void> {
  if (!h.isAdmin) return;
  const channel = await getMeta(h.d, 'channel_id');
  const s = ALL_SLOTS.find((x) => x === slot);
  if (!channel || !s) return say(h, 'Канал не подключён: /channel');
  const p = await composeChannelPost(h.d, s, h.now);
  if (!p) return say(h, 'Сейчас нечего публиковать.');
  try {
    await h.tg.sendMessage(Number(channel), p.text, botButton(await botUsername(h.d, h.tg)), p.image);
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
  const copies = await listCopies(h.d);
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
    '', `<b>🕵️ Копии бота</b> (запущены из твоего кода): ${copies.length ? '' : 'не найдено'}`,
    ...copies.slice(0, 10).map(([host, at]) => `• <code>${esc(host)}</code> — последний раз ${new Date(at * 1000).toISOString().slice(0, 10)}`),
  ].filter((x) => x !== '').join('\n'));
}

/** /ref — партнёрские ссылки площадок: /ref waxpeer https://… · /ref waxpeer off */
export async function refCommand(h: H, arg: string): Promise<void> {
  if (!h.isAdmin) return;
  const [key, url] = arg.trim().split(/\s+/);
  const links = await loadRefLinks(h.d);
  if (key) {
    const site = SITES.find((s) => s.key === key.toLowerCase());
    if (!site) return say(h, `Не знаю площадку «${esc(key)}». Есть: ${SITES.map((s) => s.key).join(', ')}`);
    if (!url || url === 'off') delete links[site.key];
    else {
      const ok = checkRefUrl(site.key, url);
      if (!ok) return say(h, `❌ Ссылка должна быть https и вести на сайт ${esc(site.name)}.`);
      links[site.key] = ok;
    }
    await setRefStmt(h.d, links).run();
  }
  return say(h, [
    '<b>🤝 Партнёрские ссылки</b>', 'Показываются на главной приложения с пометкой «партнёрская ссылка».', '',
    ...SITES.map((s) => `${links[s.key] ? '✅' : '▫️'} <b>${s.name}</b> (<code>${s.key}</code>): ${links[s.key] ? esc(links[s.key]!) : 'обычная ссылка'}`), '',
    'Задать: <code>/ref waxpeer https://waxpeer.com/?ref=…</code>', 'Убрать: <code>/ref waxpeer off</code>',
  ].join('\n'));
}

/** Ссылка на подключённый канал: публичный @username или пригласительная ссылка (бот — админ канала). */
export async function channelLink(h: H): Promise<string | null> {
  const id = await getMeta(h.d, 'channel_id');
  if (!id) return null;
  try {
    const chat = await h.tg.call<{ username?: string; invite_link?: string }>('getChat', { chat_id: Number(id) });
    if (chat.username) return `https://t.me/${chat.username}`;
    if (chat.invite_link) return chat.invite_link;
    return await h.tg.call<string>('exportChatInviteLink', { chat_id: Number(id) });
  } catch { return null; }
}

const BROADCAST_DEFAULT = [
  '📣 <b>У бота появился канал</b>', '',
  'Каждый день: рекомендации дня с честным итогом вчерашних, что растёт в цене, кейсы Steam, итоги недели и обновления CS2.', '',
  'Подписывайся 👇',
].join('\n');

/** /broadcast [текст] — рассылка всем пользователям бота (только владелец, с подтверждением). Без текста — анонс канала. */
export async function broadcastCommand(h: H, arg: string): Promise<void> {
  if (!h.isAdmin) return;
  const text = arg.trim() ? esc(arg.trim()).slice(0, 3500) : BROADCAST_DEFAULT;
  const link = await channelLink(h);
  if (!arg.trim() && !link) return say(h, 'Канал не подключён или бот не может получить на него ссылку. Сначала: /channel @имя_канала');
  const kb = link ? [[{ text: '📣 Перейти в канал', url: link }]] : [];
  const n = (await h.d.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;
  await setMetaStmt(h.d, 'broadcast_draft', JSON.stringify({ text, kb })).run();
  await say(h, '👀 <b>Так увидят все</b> — проверь текст и кнопку:');
  await h.tg.sendMessage(h.uid, text, kb);
  return say(h, `Отправить <b>${n}</b> пользователям? Уйдёт постепенно (~25 сообщений в минуту), ночью — после тихих часов каждого.`, [
    [{ text: `✅ Отправить всем (${n})`, callback_data: 'bc:send' }], [{ text: 'Отмена', callback_data: 'bc:no' }],
  ]);
}

export async function broadcastConfirm(h: H, yes: boolean): Promise<void> {
  if (!h.isAdmin) return;
  const raw = await getMeta(h.d, 'broadcast_draft');
  await h.d.prepare(`DELETE FROM meta WHERE key = 'broadcast_draft'`).run();
  if (!yes || !raw) return say(h, yes ? 'Черновик не найден — начни заново: /broadcast' : 'Рассылка отменена.');
  const { text, kb } = JSON.parse(raw) as { text: string; kb: unknown };
  const users = (await h.d.prepare('SELECT telegram_id FROM users').all<{ telegram_id: number }>()).results.map((r) => r.telegram_id);
  const quiet = new Map<number, { s: number; e: number }>();
  for (const r of (await h.d.prepare(`SELECT telegram_id, key, value FROM user_settings WHERE key IN ('quiet_start', 'quiet_end')`).all<{ telegram_id: number; key: string; value: string }>()).results) {
    const q = quiet.get(r.telegram_id) ?? { s: 23, e: 8 };
    if (r.key === 'quiet_start') q.s = Number(r.value); else q.e = Number(r.value);
    quiet.set(r.telegram_id, q);
  }
  const ref = `bc:${h.now}`;
  const stmts = users.map((tid) => {
    const q = quiet.get(tid) ?? { s: 23, e: 8 };
    return h.d.prepare(`INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at) VALUES (?, 'broadcast', ?, NULL, ?, ?, NULL, ?, ?)`)
      .bind(tid, ref, text, JSON.stringify(kb), nextAllowed(h.now, q.s, q.e), h.now);
  });
  for (let i = 0; i < stmts.length; i += 90) await h.d.batch(stmts.slice(i, i + 90));
  return say(h, `✅ Рассылка поставлена в очередь: <b>${users.length}</b> человек. Кто заблокировал бота — тому не придёт.`);
}
