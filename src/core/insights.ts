// Контент, которого нет на сайтах с ценами: честная история идей бота, итог недели и обновления CS2.

import { buildRecs, HELD_SEC, marketSides, MARKETS, type Market, type ScanEntry } from './recs.ts';
import type { FxRate } from '../currency/nbu.ts';
import type { Currency } from '../types/market.ts';
import { warsawDate } from '../utils/time.ts';
import { formatUah, formatSignedUah } from '../utils/money.ts';
import { header, dealBlock, moveLine, pct, esc } from './postfmt.ts';

export const IDEA_SETTINGS = { minProfitKop: 2000, minRoiBp: 800, depositFeeBp: 0, withdrawFeeBp: 0 };
export const IDEAS_PER_DAY = 4;

export interface IdeaRow {
  id: number; day: string; name: string; buy_at: Market; sell_at: Market; pay_kop: number; sell_kop: number | null; get_kop: number;
  profit_kop: number; roi_bp: number; wallet: string; created_at: number; checked_at: number | null;
  get_kop_24: number | null; profit_kop_24: number | null; outcome: string | null;
}

/** Идеи дня: если сегодня ещё не записаны — берём лучшие из текущего сканирования и записываем (одни и те же для поста и проверки). */
export async function ensureTodayIdeas(d: D1Database, entries: ScanEntry[] | null, fx: Map<Currency, FxRate>, now: number): Promise<IdeaRow[]> {
  const day = warsawDate(now);
  const have = (await d.prepare('SELECT * FROM idea_log WHERE day = ? ORDER BY profit_kop DESC').bind(day).all<IdeaRow>()).results;
  if (have.length || !entries?.length) return have;
  const top = buildRecs(entries, fx, { ...IDEA_SETTINGS, minHeldSec: HELD_SEC }).deals.slice(0, IDEAS_PER_DAY);
  if (!top.length) return [];
  await d.batch(top.map((r) => d.prepare(
    `INSERT INTO idea_log (day, name, buy_at, sell_at, pay_kop, sell_kop, get_kop, profit_kop, roi_bp, wallet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(day, r.name, r.buyAt, r.sellAt, r.payKop, r.sellKop, r.getKop!, r.profitKop!, r.roiBp!, r.wallet ?? 'cash', now)));
  return (await d.prepare('SELECT * FROM idea_log WHERE day = ? ORDER BY profit_kop DESC').bind(day).all<IdeaRow>()).results;
}

/**
 * Итог идеи — через 7 дней: купленное в Steam (и на большинстве сайтов) нельзя продать раньше, чем через неделю,
 * так что «через сутки» был нечестный итог. CHECK_AFTER — когда проверять, CHECK_GIVE_UP — после этого «проверить не удалось».
 */
export const CHECK_AFTER = 7 * 86400;
const CHECK_GIVE_UP = CHECK_AFTER + 36 * 3600;

/** Названия идей, которые скоро пора проверить (сборщик обязательно включит их в сканирование): за сутки до срока и до отказа. */
export async function ideasToTrack(d: D1Database, now: number): Promise<string[]> {
  return (await d.prepare(`SELECT DISTINCT name FROM idea_log WHERE checked_at IS NULL AND created_at BETWEEN ? AND ? LIMIT 20`)
    .bind(now - CHECK_GIVE_UP, now - CHECK_AFTER + 86400).all<{ name: string }>()).results.map((r) => r.name);
}

/**
 * Проверка через 7 дней (когда купленное можно продать): если бы купил по цене идеи и продал там же, где советовал бот,
 * по цене на этот день — остался бы в плюсе? Данных нет ещё 36 ч после срока — «gone» (честно: проверить не удалось).
 * Колонки *_24 исторические: в них итог на день проверки.
 */
export function checkStmts(d: D1Database, pending: IdeaRow[], entries: ScanEntry[], fx: Map<Currency, FxRate>, now: number): D1PreparedStatement[] {
  const by = new Map(entries.map((e) => [e.name, e]));
  const out: D1PreparedStatement[] = [];
  for (const r of pending) {
    if (now - r.created_at < CHECK_AFTER - 4 * 3600) continue;
    const e = by.get(r.name);
    const sell = e ? marketSides(e, fx, IDEA_SETTINGS).sells.find((s) => s.m === r.sell_at) : undefined;
    if (!sell) {
      if (now - r.created_at > CHECK_GIVE_UP) out.push(d.prepare(`UPDATE idea_log SET checked_at = ?, outcome = 'gone' WHERE id = ?`).bind(now, r.id));
      continue;
    }
    const p24 = sell.netKop - r.pay_kop;
    out.push(d.prepare('UPDATE idea_log SET checked_at = ?, get_kop_24 = ?, profit_kop_24 = ?, outcome = ? WHERE id = ?')
      .bind(now, sell.netKop, p24, p24 > 0 ? 'plus' : 'minus', r.id));
  }
  return out;
}

/** #6: честная статистика «Рекомендаций дня» — сколько через 7 дней (когда можно продать) остались в плюсе. */
export interface RecStats { days: number; total: number; plus: number; minus: number; gone: number; pending: number; avgPromisedKop: number | null; avgActualKop: number | null;
  recent: { day: string; name: string; buyAt: string; sellAt: string; profitKop: number; profit24Kop: number | null; outcome: string | null }[] }
export async function recStats(d: D1Database, now: number, days = 30): Promise<RecStats> {
  // Итоги «через сутки» (до перехода на 7 дней) в статистику не берём — они про другое.
  const rows = (await d.prepare('SELECT * FROM idea_log WHERE created_at >= ? AND (checked_at IS NULL OR checked_at >= created_at + ?) ORDER BY created_at DESC LIMIT 400')
    .bind(now - days * 86400, CHECK_AFTER - 4 * 3600).all<IdeaRow>()).results;
  const checked = rows.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    days, total: rows.length, plus: checked.filter((r) => r.outcome === 'plus').length, minus: checked.filter((r) => r.outcome === 'minus').length,
    gone: rows.filter((r) => r.outcome === 'gone').length, pending: rows.filter((r) => !r.checked_at).length,
    avgPromisedKop: avg(checked.map((r) => r.profit_kop)), avgActualKop: avg(checked.map((r) => r.profit_kop_24 ?? 0)),
    recent: rows.slice(0, 30).map((r) => ({ day: r.day, name: r.name, buyAt: MARKETS[r.buy_at as Market]?.name ?? r.buy_at, sellAt: MARKETS[r.sell_at as Market]?.name ?? r.sell_at,
      profitKop: r.profit_kop, profit24Kop: r.profit_kop_24, outcome: r.outcome })),
  };
}

const fmt = (k: number | null) => formatUah(k);
const sign = (k: number) => (k > 0 ? formatSignedUah(k) : formatUah(k));

/** Строка «как сработали вчерашние идеи» для поста «Идеи дня». */
export function yesterdayLine(rows: IdeaRow[]): string | null {
  const checked = rows.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
  if (!checked.length) return null;
  const plusN = checked.filter((r) => r.outcome === 'plus').length;
  const best = [...checked].sort((a, b) => (b.profit_kop_24 ?? 0) - (a.profit_kop_24 ?? 0))[0];
  return `📊 <b>Рекомендации недельной давности — когда их уже можно продать: ${plusN} из ${checked.length} в плюсе</b>\nЛучшая — ${esc(best.name)}: ${sign(best.profit_kop_24 ?? 0)} (обещали ${sign(best.profit_kop)})`;
}

/** Пост «Идеи дня» из записанных идей. */
export function ideasPost(rows: IdeaRow[], yesterday: IdeaRow[], now: number): string | null {
  const y = yesterdayLine(yesterday);
  if (!rows.length && !y) return null;
  const lines = [header('💡', 'Рекомендации дня', now), ''];
  if (!rows.length) {
    lines.push(`Сегодня выгодных сделок нет: нигде после всех комиссий не остаётся хотя бы ${fmt(IDEA_SETTINGS.minProfitKop)} и ${IDEA_SETTINGS.minRoiBp / 100}%. Бот ничего не придумывает, когда выгоды нет.`, '');
  }
  rows.forEach((r, i) => {
    lines.push(...dealBlock(i + 1, { name: r.name, buyName: MARKETS[r.buy_at].name, sellName: MARKETS[r.sell_at].name, payKop: r.pay_kop, sellKop: r.sell_kop, getKop: r.get_kop, profitKop: r.profit_kop, roiBp: r.roi_bp, cash: r.wallet === 'cash' }), '');
  });
  if (y) lines.push(`<blockquote>${y}</blockquote>`, '');
  lines.push(rows.length ? '<i>Цены на момент публикации, комиссии учтены. Не финансовый совет. Купленное нельзя продать 7 дней — через неделю, когда продажа станет возможной, покажем честный итог этих рекомендаций.</i>' : '<i>Завтра — снова проверка рынка.</i>');
  return lines.join('\n');
}

export interface CaseStat { name: string; d1: number | null; d7: number | null; d30: number | null }

/** Воскресный итог недели: индекс кейсов, лидеры роста и падения, как сработали идеи, сколько нас. */
export function weeklyPost(cases: CaseStat[], week: IdeaRow[], users: { total: number; week: number }, now: number): string | null {
  const ch = cases.filter((c) => c.d7 && c.d30).map((c) => ({ name: c.name, bp: Math.trunc(((c.d7! - c.d30!) * 10000) / c.d30!) }));
  const checked = week.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
  if (ch.length < 5 && !checked.length) return null;
  const lines = [header('📅', 'Итоги недели', now), ''];
  if (ch.length >= 5) {
    const avg = Math.round(ch.reduce((s, x) => s + x.bp, 0) / ch.length);
    lines.push(`📦 Индекс кейсов Steam: <b>${pct(avg)}</b>`, `<i>в среднем по ${ch.length} кейсам, неделя к месяцу</i>`, '');
    const up = [...ch].sort((a, b) => b.bp - a.bp).filter((x) => x.bp > 0).slice(0, 3);
    const down = [...ch].sort((a, b) => a.bp - b.bp).filter((x) => x.bp < 0).slice(0, 3);
    if (up.length) { lines.push('📈 <b>Выросли сильнее всех</b>', ...up.map((x) => moveLine(x.name, x.bp, null)), ''); }
    if (down.length) { lines.push('📉 <b>Упали сильнее всех</b>', ...down.map((x) => moveLine(x.name, x.bp, null)), ''); }
  }
  if (checked.length) {
    const plusN = checked.filter((r) => r.outcome === 'plus').length;
    const best = [...checked].sort((a, b) => (b.profit_kop_24 ?? 0) - (a.profit_kop_24 ?? 0))[0];
    const avgReal = Math.round(checked.reduce((s, r) => s + (r.profit_kop_24 ?? 0), 0) / checked.length);
    lines.push(`💡 <b>Рекомендации бота: ${plusN} из ${checked.length} в плюсе</b> (${Math.round((plusN / checked.length) * 100)}%)`,
      `В среднем ${sign(avgReal)} на сделку · лучшая — ${esc(best.name)} ${sign(best.profit_kop_24 ?? 0)}`, '');
  }
  if (users.total >= 20) lines.push(`👥 В боте ${users.total} человек${users.week ? ` (+${users.week} за неделю)` : ''}`, '');
  lines.push('<i>Это статистика прошлого, а не прогноз.</i>');
  return lines.join('\n');
}

export interface NewsItem { gid: string; title: string; url: string; snippet: string | null; published_at: number; image?: string | null; title_ru?: string | null; summary_ru?: string | null }

const NEWS_IMG_OK = /^https:\/\/[a-z0-9.-]*steamstatic\.com\/[^\s"'\]\[<>]{1,400}\.(png|jpe?g|gif|webp)$/i;
/** Первая картинка из текста новости Steam ({STEAM_CLAN_IMAGE}/… или прямая ссылка на steamstatic). */
export function newsImage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  for (const m of raw.matchAll(/\{STEAM_CLAN_IMAGE\}(\/[^\s"'\]\[<>]+)|(https:\/\/[a-z0-9.-]*steamstatic\.com\/[^\s"'\]\[<>]+)/gi)) {
    const u = m[1] ? `https://clan.akamai.steamstatic.com/images${m[1]}` : m[2];
    if (NEWS_IMG_OK.test(u)) return u;
  }
  return null;
}

/** Текст новости Steam: убираем разметку Steam ([b], [img], {STEAM_CLAN_IMAGE}…) и HTML. */
export function cleanSnippet(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\{STEAM_CLAN_IMAGE\}[^\s]*/g, ' ').replace(/\[\/?[^\]]{1,40}\]/g, ' ').replace(/<[^>]{0,200}>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > 300 ? t.slice(0, 297).replace(/\s+\S*$/, '') + '…' : t;
}

/** Краткое содержание на русском (если сборщик уже перевёл): важное для рынка — первым, затем по разделам. */
export function newsRuLines(n: NewsItem): string[] | null {
  let s: { market?: string[]; sections?: { name: string | null; items: string[] }[]; more?: number } | null = null;
  try { s = n.summary_ru ? JSON.parse(n.summary_ru) : null; } catch { s = null; }
  if (!s || (!s.market?.length && !s.sections?.length)) return null;
  const out: string[] = [];
  if (s.market?.length) out.push('💰 <b>Важно для рынка</b>', ...s.market.map((x) => `• ${esc(x)}`), '');
  for (const sec of s.sections ?? []) out.push(...(sec.name ? [`<b>${esc(sec.name)}</b>`] : []), ...sec.items.map((x) => `• ${esc(x)}`), '');
  if (s.more) out.push(`<i>…и ещё ${s.more} изменений — полный список по кнопке ниже.</i>`);
  return out;
}

export function newsPost(n: NewsItem): string {
  const ru = newsRuLines(n);
  if (ru) return [
    header('🛠', 'Обновление CS2', n.published_at), '',
    `<b>${esc(n.title_ru || n.title)}</b>`, '',
    ...ru, '',
    '<i>Кратко и в переводе. После обновлений цены кейсов и скинов часто двигаются — реакцию рынка смотри вечером в посте «Кейсы Steam».</i>',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
  return [
    header('🛠', 'Обновление CS2', n.published_at), '',
    `<b>${esc(n.title)}</b>`,
    ...(n.snippet ? [`<blockquote>${esc(n.snippet)}</blockquote>`] : []),
    '', '<i>После обновлений цены кейсов и скинов часто двигаются — реакцию рынка смотри вечером в посте «Кейсы Steam».</i>',
  ].join('\n');
}
