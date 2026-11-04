// Автопостинг в Telegram-канал или группу (бот должен быть там администратором с правом публиковать).
// Три поста в день по Варшаве: 10:00 «Идеи дня», 15:00 «Растут в цене», 20:00 «Кейсы: что дорожает и дешевеет».
// Данные — то же сканирование рынка, что и во вкладке «Идеи». Нет содержательных данных — пост пропускается.
// В каждом посте кнопка на бота с меткой ?start=ch — так видно, сколько людей пришло из канала.

import { buildRecs, MARKETS, type ScanEntry } from './recs.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { esc, type Keyboard, type TelegramClient } from '../telegram/api.ts';
import { warsawDate, warsawHour } from '../utils/time.ts';
import type { Currency } from '../types/market.ts';
import { loadScan } from '../storage/scan.ts';
import { loadLatestFx } from '../storage/db.ts';
import { ensureTodayIdeas, ideasPost, weeklyPost, type CaseStat, type IdeaRow } from './insights.ts';

export type Slot = 'ideas' | 'trends' | 'cases' | 'weekly';
/** weekday: 0 = воскресенье (по Варшаве); без него — каждый день. */
export const SLOTS: { slot: Slot; hour: number; weekday?: number }[] = [
  { slot: 'ideas', hour: 10 }, { slot: 'trends', hour: 15 }, { slot: 'weekly', hour: 19, weekday: 0 }, { slot: 'cases', hour: 20 },
];
export const ALL_SLOTS: Slot[] = ['ideas', 'trends', 'cases', 'weekly'];

const fmt = (k: number | null) => (k === null ? '—' : `${(k / 100).toLocaleString('ru-RU', { minimumFractionDigits: k >= 100000 ? 0 : 2, maximumFractionDigits: k >= 100000 ? 0 : 2 })} ₴`);
const pct = (bp: number) => `${bp >= 0 ? '+' : '−'}${Math.abs(Math.round(bp / 100))}%`;

export function botButton(botUsername: string | null, text = '🤖 Все идеи и уведомления — в боте'): Keyboard {
  return botUsername ? [[{ text, url: `https://t.me/${botUsername}?start=ch` }]] : [];
}

/** Текст поста для слота или null, если показать нечего. Чистая функция — проверяется тестами. */
export function buildPost(slot: Slot, entries: ScanEntry[], fx: Map<Currency, FxRate>, now: number): string | null {
  const date = warsawDate(now).split('-').reverse().slice(0, 2).join('.');
  if (slot === 'ideas') {
    const { deals } = buildRecs(entries, fx, { minProfitKop: 2000, minRoiBp: 800, depositFeeBp: 0, withdrawFeeBp: 0 });
    const top = deals.slice(0, 4);
    if (!top.length) return null;
    const lines = [`💡 <b>Идеи дня · ${date}</b>`, ''];
    top.forEach((d, i) => {
      lines.push(`${i + 1}. <b>${esc(d.name)}</b>`);
      lines.push(`Купи на ${MARKETS[d.buyAt].name} за ${fmt(d.payKop)} → продай на ${MARKETS[d.sellAt].name} за ${fmt(d.sellKop)} → получишь <b>${fmt(d.getKop)}</b> (+${fmt(d.profitKop)}, ${pct(d.roiBp ?? 0)})`);
      lines.push(d.wallet === 'cash' ? '💵 деньгами' : '🎮 на баланс Steam (вывести нельзя)');
      lines.push('');
    });
    lines.push('<i>Цены на момент публикации, комиссии площадок учтены. Это не финансовый совет: проверь цену перед покупкой — объявление могут купить раньше.</i>');
    return lines.join('\n');
  }
  if (slot === 'trends') {
    const { trends } = buildRecs(entries, fx, { minProfitKop: 2000, minRoiBp: 800, depositFeeBp: 0, withdrawFeeBp: 0 });
    const top = trends.slice(0, 5);
    if (!top.length) return null;
    const lines = [`📈 <b>Растут в цене · ${date}</b>`, ''];
    for (const t of top) lines.push(`• <b>${esc(t.name)}</b> — ${pct(t.trendBp ?? 0)} за неделю к месяцу${t.sales7 ? ` (${t.sales7} продаж)` : ''}, сейчас от ${fmt(t.payKop)} на ${MARKETS[t.buyAt].name}`);
    lines.push('', '<i>Рост уже случился и может развернуться — это не гарантия. Покупай только то, что готов держать.</i>');
    return lines.join('\n');
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
  const lines = [`📦 <b>Кейсы в Steam · ${date}</b>`, '<i>средняя цена продаж за сутки против средней за месяц</i>', ''];
  if (up.length) { lines.push('🔺 <b>Дорожают</b>'); for (const x of up) lines.push(`• ${esc(x.name)} — ${pct(x.d)}${x.kop ? `, ≈ ${fmt(x.kop)}` : ''}`); lines.push(''); }
  if (down.length) { lines.push('🔻 <b>Дешевеют</b>'); for (const x of down) lines.push(`• ${esc(x.name)} — ${pct(x.d)}${x.kop ? `, ≈ ${fmt(x.kop)}` : ''}`); lines.push(''); }
  lines.push('<i>Цены ≈: из долларов по курсу НБУ. Дешевеющий кейс — не обязательно выгодная покупка.</i>');
  return lines.join('\n');
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

/** Собирает текст поста для слота из базы (общий для расписания, предпросмотра и «Опубликовать сейчас»). */
export async function composePost(d: D1Database, slot: Slot, now: number): Promise<string | null> {
  const [scan, fx] = await Promise.all([loadScan(d), loadLatestFx(d)]);
  const fresh = scan && now - scan.fetchedAt < 6 * 3600 ? scan.entries : null;
  if (slot === 'ideas') {
    const today = await ensureTodayIdeas(d, fresh, fx, now);
    const yesterday = (await d.prepare('SELECT * FROM idea_log WHERE day = ?').bind(warsawDate(now - 86400)).all<IdeaRow>()).results;
    return ideasPost(today, yesterday, now);
  }
  if (slot === 'trends') return fresh ? buildPost('trends', fresh, fx, now) : null;
  const cases = await caseStats(d);
  if (slot === 'cases') {
    const entries: ScanEntry[] = cases.length ? cases.map((c) => ({ name: c.name, offers: [], s7: null, s30: null, steam: null, sa: { d1: c.d1, d7: c.d7, d30: c.d30, d90: null } })) : fresh ?? [];
    return buildPost('cases', entries, fx, now);
  }
  const week = (await d.prepare('SELECT * FROM idea_log WHERE created_at >= ?').bind(now - 7 * 86400).all<IdeaRow>()).results;
  const u = await d.prepare('SELECT COUNT(*) AS n, SUM(created_at >= ?) AS w FROM users').bind(now - 7 * 86400).first<{ n: number; w: number | null }>();
  return weeklyPost(cases, week, { total: u?.n ?? 0, week: u?.w ?? 0 }, now);
}

export async function caseStats(d: D1Database): Promise<CaseStat[]> {
  try { return JSON.parse((await getMeta(d, 'cases_stats')) ?? '[]') as CaseStat[]; } catch { return []; }
}
