// Автопостинг в Telegram-канал или группу (бот должен быть там администратором с правом публиковать).
// Посты по Варшаве: 10:00 «Рекомендации дня», 13:00 рубрика (см. rubrics.ts), 15:00 «Растут в цене», 20:00 «Кейсы», вс 19:00 итог недели.
// Данные — то же сканирование рынка, что и во вкладке «Идеи». Нет содержательных данных — пост пропускается.
// В каждом посте кнопка на бота с меткой ?start=ch — так видно, сколько людей пришло из канала.

import { buildRecs, HELD_SEC, MARKETS, safeImg, type ScanEntry } from './recs.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { esc, type Keyboard, type TelegramClient } from '../telegram/api.ts';
import { warsawDate, warsawHour } from '../utils/time.ts';
import type { Currency } from '../types/market.ts';
import { loadScan } from '../storage/scan.ts';
import { loadLatestFx } from '../storage/db.ts';
import { CHECK_AFTER, ensureTodayIdeas, ideasPost, weeklyPost, type CaseStat, type IdeaRow } from './insights.ts';
import { formatUah, formatSignedUah, renderMoney } from '../utils/money.ts';
import { loadRates, curFor } from '../currency/display.ts';
import { rubricFor, pickCaseEV, caseEvPost, trackedPost, storyPost, TRACKED_MIN_USERS, type RubricKind, type CaseEV } from './rubrics.ts';
import { header, dealBlock, moveLine, FOOT_DEALS, pct, ruDate } from './postfmt.ts';

export type Slot = 'ideas' | 'rubric' | 'trends' | 'cases' | 'weekly';
/** weekday: 0 = воскресенье (по Варшаве); без него — каждый день. */
export const SLOTS: { slot: Slot; hour: number; weekday?: number }[] = [
  { slot: 'ideas', hour: 10 }, { slot: 'rubric', hour: 13 }, { slot: 'trends', hour: 15 }, { slot: 'weekly', hour: 19, weekday: 0 }, { slot: 'cases', hour: 20 },
];
export const ALL_SLOTS: Slot[] = ['ideas', 'rubric', 'trends', 'cases', 'weekly'];

const fmt = (k: number | null) => formatUah(k);

/** Публичная ссылка на канал: t.me/имя или пригласительная ссылка (для закрытого канала, если бот — админ). */
export function channelUrlOf(chat: { username?: string; invite_link?: string }): string | null {
  if (chat.username && /^[A-Za-z0-9_]{4,32}$/.test(chat.username)) return `https://t.me/${chat.username}`;
  if (chat.invite_link && /^https:\/\/t\.me\/\S+$/.test(chat.invite_link)) return chat.invite_link;
  return null;
}

/** Кнопка «📣 Канал» — ссылка из meta (без запроса к Telegram). Нет канала или ссылки — пусто. */
export async function channelButton(d: D1Database): Promise<Keyboard> {
  const url = await getMeta(d, 'channel_url');
  return url ? [[{ text: '📣 Канал', url }]] : [];
}

export function botButton(botUsername: string | null, text = '🤖 Все рекомендации и уведомления — в боте'): Keyboard {
  return botUsername ? [[{ text, url: `https://t.me/${botUsername}?start=ch` }]] : [];
}

/** Текст поста для слота или null, если показать нечего. Чистая функция — проверяется тестами. */
export function buildPost(slot: Slot, entries: ScanEntry[], fx: Map<Currency, FxRate>, now: number): string | null {
  return buildPostLead(slot, entries, fx, now)?.text ?? null;
}

/** То же + lead: главный предмет поста (его картинка пойдёт превью над текстом). */
/** Строка карточки: название, изменение в б.п., цена в копейках (для картинки поста). */
export interface CardRow { name: string; bp: number; kop: number | null }
export function buildPostLead(slot: Slot, entries: ScanEntry[], fx: Map<Currency, FxRate>, now: number): { text: string; lead: string | null; up?: CardRow[]; down?: CardRow[] } | null {
  if (slot === 'ideas') {
    const { deals } = buildRecs(entries, fx, { minProfitKop: 2000, minRoiBp: 800, depositFeeBp: 0, withdrawFeeBp: 0, minHeldSec: HELD_SEC });
    const top = deals.slice(0, 4);
    if (!top.length) return null;
    const lines = [header('💡', 'Рекомендации дня', now), ''];
    top.forEach((d, i) => lines.push(...dealBlock(i + 1, { name: d.name, buyName: MARKETS[d.buyAt].name, sellName: MARKETS[d.sellAt].name, payKop: d.payKop, sellKop: d.sellKop, getKop: d.getKop!, profitKop: d.profitKop!, roiBp: d.roiBp ?? 0, cash: d.wallet === 'cash' }), ''));
    lines.push(FOOT_DEALS);
    return { text: lines.join('\n'), lead: top[0].name };
  }
  if (slot === 'trends') {
    const { trends } = buildRecs(entries, fx, { minProfitKop: 2000, minRoiBp: 800, depositFeeBp: 0, withdrawFeeBp: 0 });
    const top = trends.slice(0, 5);
    if (!top.length) return null;
    const lines = [header('📈', 'Растут в цене', now), '<i>неделя к месяцу</i>', ''];
    for (const t of top) {
      lines.push(`${moveLine(t.name, t.trendBp ?? 0, null)} · от ${fmt(t.payKop)} на ${MARKETS[t.buyAt].name}`);
    }
    lines.push('', '<i>Рост уже случился и может развернуться. Покупай только то, что готов держать.</i>');
    return { text: lines.join('\n'), lead: top[0].name, up: top.map((t) => ({ name: t.name, bp: t.trendBp ?? 0, kop: t.payKop })) };
  }
  // cases: средние продажи Steam за сутки против месяца (прайс Steam), только кейсы с продажами.
  const usd = fx.get('USD') ?? null;
  const rows = entries
    .filter((e) => / Case$/.test(e.name) && e.sa?.d1 && e.sa.d30)
    .map((e) => ({ name: e.name, d: Math.trunc(((e.sa!.d1! - e.sa!.d30!) * 10000) / e.sa!.d30!), kop: usd ? toKop(e.sa!.d1!, 'USD', usd) : null }));
  if (rows.length < 3) return null;
  const up = [...rows].sort((a, b) => b.d - a.d).filter((x) => x.d > 200).slice(0, 3);
  const down = [...rows].sort((a, b) => a.d - b.d).filter((x) => x.d < -200).slice(0, 3);
  if (!up.length && !down.length) return null;
  const lines = [header('📦', 'Кейсы Steam', now), '<i>цена продаж за сутки к средней за месяц</i>', ''];
  if (up.length) lines.push('📈 <b>Дорожают</b>', ...up.map((x) => moveLine(x.name, x.d, x.kop)), '');
  if (down.length) lines.push('📉 <b>Дешевеют</b>', ...down.map((x) => moveLine(x.name, x.d, x.kop)), '');
  lines.push('<i>Дешевеющий кейс — не обязательно выгодная покупка.</i>');
  return { text: lines.join('\n'), lead: (up[0] ?? down[0]).name, up: up.map((x) => ({ name: x.name, bp: x.d, kop: x.kop })), down: down.map((x) => ({ name: x.name, bp: x.d, kop: x.kop })) };
}

export async function getMeta(d: D1Database, key: string): Promise<string | null> {
  return (await d.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
}
export function setMetaStmt(d: D1Database, key: string, value: string): D1PreparedStatement {
  return d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
}

export async function botUsername(d: D1Database, tg: TelegramClient): Promise<string | null> {
  const cached = await getMeta(d, 'bot_username');
  if (cached) return cached;
  try {
    const me = await tg.call<{ username?: string }>('getMe', {});
    if (me.username) { await setMetaStmt(d, 'bot_username', me.username).run(); return me.username; }
  } catch { /* не критично */ }
  return null;
}

/** Какой слот пора публиковать (сейчас или пропущенный сегодня), если ещё не публиковали. */
export function warsawWeekday(t: number): number {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Warsaw', weekday: 'short' }).format(new Date(t * 1000)));
}

export function dueSlot(now: number, done: Partial<Record<Slot, string | null>>): Slot | null {
  const h = warsawHour(now), today = warsawDate(now), wd = warsawWeekday(now);
  for (const s of [...SLOTS].reverse()) {
    if (s.weekday !== undefined && s.weekday !== wd) continue;
    if (h >= s.hour && h < s.hour + 3 && done[s.slot] !== today) return s.slot;
  }
  return null;
}

/** meta — что записать в базу после публикации (очередь рубрик). */
export interface ChannelPost { text: string; image: string | null; card: PostCard | null; meta?: [string, string][] }


/** Собирает текст поста для слота из базы (общий для расписания, предпросмотра и «Опубликовать сейчас»). */
export async function composePost(d: D1Database, slot: Slot, now: number): Promise<string | null> {
  return (await composeChannelPost(d, slot, now))?.text ?? null;
}

/** Пост + картинка главного предмета (превью над текстом). Нет картинки — пост выходит обычным текстом. */
export async function composeChannelPost(d: D1Database, slot: Slot, now: number): Promise<ChannelPost | null> {
  const [scan, fx] = await Promise.all([loadScan(d), loadLatestFx(d)]);
  const fresh = scan && now - scan.fetchedAt < 6 * 3600 ? scan.entries : null;
  // Картинка-карточка (рисует сборщик): суммы в долларах, картинки предметов — из каталога.
  const finish = async (text: string | null, lead: string | null, card: Omit<PostCard, 'id' | 'slot' | 'date'> | null): Promise<ChannelPost | null> => {
    if (!text) return null;
    const image = lead ? await itemImage(d, lead, fresh) : null;
    let full: PostCard | null = null;
    if (card) {
      const names = [...(card.deals ?? []).map((x) => x.name), ...(card.up ?? []).map((x) => x.name), ...(card.down ?? []).map((x) => x.name)];
      const imgs = await imagesByName(d, names, fresh);
      const withImg = <T extends { name: string }>(xs?: T[]) => xs?.map((x) => ({ ...x, img: imgs.get(x.name) ?? null }));
      const usd = curFor('USD', await loadRates(d));
      full = JSON.parse(renderMoney(JSON.stringify({ ...card, id: `${slot}-${warsawDate(now)}`, slot, date: ruDate(now), deals: withImg(card.deals), up: withImg(card.up), down: withImg(card.down) }), usd)) as PostCard;
    }
    return { text, image, card: full };
  };
  if (slot === 'rubric') return composeRubric(d, rubricFor(warsawWeekday(now)), fresh, fx, now);
  const row = (r: CardRow) => ({ name: r.name, pct: pct(r.bp), upward: r.bp >= 0, price: r.kop ? formatUah(r.kop) : null });
  if (slot === 'ideas') {
    const today = await ensureTodayIdeas(d, fresh, fx, now);
    // Итог — по идеям недельной давности: раньше купленное не продать (блокировка 7 дней).
    // Старые итоги «через сутки» (до перехода на 7 дней) не показываем как недельные.
    const yesterday = (await d.prepare('SELECT * FROM idea_log WHERE day = ? AND (checked_at IS NULL OR checked_at >= created_at + ?)').bind(warsawDate(now - 7 * 86400), CHECK_AFTER - 4 * 3600).all<IdeaRow>()).results;
    const checked = yesterday.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
    const bestY = [...checked].sort((a, b) => (b.profit_kop_24 ?? 0) - (a.profit_kop_24 ?? 0))[0];
    const card = today.length ? {
      title: 'Рекомендации дня',
      deals: today.slice(0, 4).map((r) => ({ name: r.name, buy: MARKETS[r.buy_at].name, buyPrice: formatUah(r.pay_kop), sell: MARKETS[r.sell_at].name, sellPrice: formatUah(r.sell_kop), profit: formatSignedUah(r.profit_kop), roi: pct(r.roi_bp) })),
      note: checked.length ? `Неделю назад: ${checked.filter((r) => r.outcome === 'plus').length} из ${checked.length} рекомендаций в плюсе` : null,
    } : null;
    return finish(ideasPost(today, yesterday, now), today[0]?.name ?? bestY?.name ?? null, card);
  }
  if (slot === 'trends') {
    const p = fresh ? buildPostLead('trends', fresh, fx, now) : null;
    return finish(p?.text ?? null, p?.lead ?? null, p ? { title: 'Растут в цене', subtitle: 'неделя к месяцу', up: p.up?.map(row) } : null);
  }
  const cases = await caseStats(d);
  if (slot === 'cases') {
    const entries: ScanEntry[] = cases.length ? cases.map((c) => ({ name: c.name, offers: [], s7: null, s30: null, steam: null, sa: { d1: c.d1, d7: c.d7, d30: c.d30, d90: null } })) : fresh ?? [];
    const p = buildPostLead('cases', entries, fx, now);
    return finish(p?.text ?? null, p?.lead ?? null, p ? { title: 'Кейсы Steam', subtitle: 'сутки к месяцу', up: p.up?.map(row), down: p.down?.map(row) } : null);
  }
  // Итоги недели: идеи, которые проверены за эту неделю (им как раз исполнилось 7 дней).
  const week = (await d.prepare('SELECT * FROM idea_log WHERE checked_at >= ? AND checked_at >= created_at + ?').bind(now - 7 * 86400, CHECK_AFTER - 4 * 3600).all<IdeaRow>()).results;
  const u = await d.prepare('SELECT COUNT(*) AS n, SUM(created_at >= ?) AS w FROM users').bind(now - 7 * 86400).first<{ n: number; w: number | null }>();
  const ch = cases.filter((c) => c.d7 && c.d30).map((c) => ({ name: c.name, bp: Math.trunc(((c.d7! - c.d30!) * 10000) / c.d30!), kop: null }));
  const leader = [...ch].sort((a, b) => b.bp - a.bp)[0];
  const checked = week.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
  const card = ch.length >= 5 ? {
    title: 'Итоги недели', subtitle: 'неделя к месяцу',
    big: pct(Math.round(ch.reduce((s, x) => s + x.bp, 0) / ch.length)), bigLabel: 'индекс кейсов Steam',
    up: [...ch].sort((a, b) => b.bp - a.bp).filter((x) => x.bp > 0).slice(0, 3).map(row),
    down: [...ch].sort((a, b) => a.bp - b.bp).filter((x) => x.bp < 0).slice(0, 3).map(row),
    note: checked.length ? `Рекомендации бота: ${checked.filter((r) => r.outcome === 'plus').length} из ${checked.length} в плюсе через 7 дней` : null,
  } : null;
  return finish(weeklyPost(cases, week, { total: u?.n ?? 0, week: u?.w ?? 0 }, now), leader?.name ?? null, card);
}

/** Данные для картинки поста (рисует сборщик). Все суммы уже строками в долларах. */
export interface PostCard {
  id: string; slot: Slot; date: string; title: string; subtitle?: string; note?: string | null; big?: string; bigLabel?: string;
  deals?: { name: string; img?: string | null; buy: string; buyPrice: string; sell: string; sellPrice: string; profit: string; roi: string }[];
  up?: { name: string; img?: string | null; pct: string; upward: boolean; price: string | null }[];
  down?: { name: string; img?: string | null; pct: string; upward: boolean; price: string | null }[];
}

async function imagesByName(d: D1Database, names: string[], entries: ScanEntry[] | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const n of names) { const u = safeImg(entries?.find((e) => e.name === n)?.img); if (u) out.set(n, u); }
  const rest = [...new Set(names.filter((n) => !out.has(n)))].slice(0, 40);
  if (rest.length) {
    for (const r of (await d.prepare(`SELECT name, url FROM item_images WHERE name IN (${rest.map(() => '?').join(',')})`).bind(...rest).all<{ name: string; url: string }>()).results) {
      const u = safeImg(r.url); if (u) out.set(r.name, u);
    }
  }
  return out;
}

/** Картинка предмета: из сканирования, иначе из каталога картинок. Только проверенные адреса Steam CDN. */
export async function itemImage(d: D1Database, name: string, entries: ScanEntry[] | null): Promise<string | null> {
  const fromScan = safeImg(entries?.find((e) => e.name === name)?.img);
  if (fromScan) return fromScan;
  const r = await d.prepare('SELECT url FROM item_images WHERE name = ?').bind(name).first<{ url: string }>();
  return safeImg(r?.url);
}

export async function caseStats(d: D1Database): Promise<CaseStat[]> {
  try { return JSON.parse((await getMeta(d, 'cases_stats')) ?? '[]') as CaseStat[]; } catch { return []; }
}

const jsonList = (v: string | null): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []; } catch { return []; } };

/** Рубрика дня (13:00). Нет данных для рубрики — выходит история, чтобы день не пустовал. */
export async function composeRubric(d: D1Database, kind: RubricKind, fresh: ScanEntry[] | null, fx: Map<Currency, FxRate>, now: number): Promise<ChannelPost | null> {
  if (kind === 'caseev') {
    let ev: { at?: number; items?: CaseEV[] } = {};
    try { ev = JSON.parse((await getMeta(d, 'case_ev')) ?? '{}'); } catch { ev = {}; }
    const recent = jsonList(await getMeta(d, 'caseev_recent'));
    const c = ev.at && now - ev.at < 2 * 86400 && Array.isArray(ev.items) ? pickCaseEV(ev.items, recent) : null;
    if (c) return { text: caseEvPost(c, fx, now), image: safeImg(c.img) ?? await itemImage(d, c.name, fresh), card: null, meta: [['caseev_recent', JSON.stringify([c.name, ...recent].slice(0, 30))]] };
  }
  if (kind === 'tracked') {
    const rows = (await d.prepare(`SELECT i.name AS name, COUNT(DISTINCT w.telegram_id) AS n FROM watchlist w JOIN items i ON i.id = w.item_id
      WHERE w.active = 1 GROUP BY w.item_id HAVING n >= ? ORDER BY n DESC, i.name LIMIT 7`).bind(TRACKED_MIN_USERS).all<{ name: string; n: number }>()).results;
    const total = (await d.prepare('SELECT COUNT(DISTINCT telegram_id) AS n FROM watchlist WHERE active = 1').first<{ n: number }>())?.n ?? 0;
    const text = trackedPost(rows, total, now);
    if (text) return { text, image: rows[0] ? await itemImage(d, rows[0].name, fresh) : null, card: null };
  }
  const idx = Number(await getMeta(d, 'story_idx')) || 0;
  return { text: storyPost(idx, now), image: null, card: null, meta: [['story_idx', String(idx + 1)]] };
}
