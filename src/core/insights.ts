// Контент, которого нет на сайтах с ценами: честная история идей бота, итог недели и обновления CS2.

import { buildRecs, marketSides, MARKETS, type Market, type ScanEntry } from './recs.ts';
import type { FxRate } from '../currency/nbu.ts';
import type { Currency } from '../types/market.ts';
import { warsawDate } from '../utils/time.ts';
import { formatUah, formatSignedUah } from '../utils/money.ts';

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
  const top = buildRecs(entries, fx, IDEA_SETTINGS).deals.slice(0, IDEAS_PER_DAY);
  if (!top.length) return [];
  await d.batch(top.map((r) => d.prepare(
    `INSERT INTO idea_log (day, name, buy_at, sell_at, pay_kop, sell_kop, get_kop, profit_kop, roi_bp, wallet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(day, r.name, r.buyAt, r.sellAt, r.payKop, r.sellKop, r.getKop!, r.profitKop!, r.roiBp!, r.wallet ?? 'cash', now)));
  return (await d.prepare('SELECT * FROM idea_log WHERE day = ? ORDER BY profit_kop DESC').bind(day).all<IdeaRow>()).results;
}

/** Названия идей, которые пора проверить (сборщик обязательно включит их в следующее сканирование). */
export async function ideasToTrack(d: D1Database, now: number): Promise<string[]> {
  return (await d.prepare(`SELECT DISTINCT name FROM idea_log WHERE checked_at IS NULL AND created_at >= ? LIMIT 20`).bind(now - 40 * 3600)
    .all<{ name: string }>()).results.map((r) => r.name);
}

/**
 * Проверка через сутки: если бы купил по цене идеи и продал там же, где советовал бот, по сегодняшней цене —
 * остался бы в плюсе? Данных о предмете нет больше 36 ч — «gone» (честно: проверить не удалось).
 */
export function checkStmts(d: D1Database, pending: IdeaRow[], entries: ScanEntry[], fx: Map<Currency, FxRate>, now: number): D1PreparedStatement[] {
  const by = new Map(entries.map((e) => [e.name, e]));
  const out: D1PreparedStatement[] = [];
  for (const r of pending) {
    if (now - r.created_at < 20 * 3600) continue;
    const e = by.get(r.name);
    const sell = e ? marketSides(e, fx, IDEA_SETTINGS).sells.find((s) => s.m === r.sell_at) : undefined;
    if (!sell) {
      if (now - r.created_at > 36 * 3600) out.push(d.prepare(`UPDATE idea_log SET checked_at = ?, outcome = 'gone' WHERE id = ?`).bind(now, r.id));
      continue;
    }
    const p24 = sell.netKop - r.pay_kop;
    out.push(d.prepare('UPDATE idea_log SET checked_at = ?, get_kop_24 = ?, profit_kop_24 = ?, outcome = ? WHERE id = ?')
      .bind(now, sell.netKop, p24, p24 > 0 ? 'plus' : 'minus', r.id));
  }
  return out;
}

const fmt = (k: number | null) => formatUah(k);
const sign = (k: number) => (k > 0 ? formatSignedUah(k) : formatUah(k));
const pct = (bp: number) => `${bp >= 0 ? '+' : '−'}${Math.abs(Math.round(bp / 100))}%`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Строка «как сработали вчерашние идеи» для поста «Идеи дня». */
export function yesterdayLine(rows: IdeaRow[]): string | null {
  const checked = rows.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
  if (!checked.length) return null;
  const plus = checked.filter((r) => r.outcome === 'plus');
  const best = [...checked].sort((a, b) => (b.profit_kop_24 ?? 0) - (a.profit_kop_24 ?? 0))[0];
  return `📊 <b>Вчерашние идеи через сутки:</b> ${plus.length} из ${checked.length} всё ещё в плюсе. Лучшая — ${esc(best.name)}: ${sign(best.profit_kop_24 ?? 0)} (обещали ${sign(best.profit_kop)}).`;
}

/** Пост «Идеи дня» из записанных идей. */
export function ideasPost(rows: IdeaRow[], yesterday: IdeaRow[], now: number): string | null {
  const y = yesterdayLine(yesterday);
  if (!rows.length && !y) return null;
  const date = warsawDate(now).split('-').reverse().slice(0, 2).join('.');
  const lines = [`💡 <b>Идеи дня · ${date}</b>`, ''];
  if (y) lines.push(y, '');
  if (!rows.length) {
    lines.push(`Сегодня сделок, где после всех комиссий остаётся хотя бы ${fmt(IDEA_SETTINGS.minProfitKop)} и ${IDEA_SETTINGS.minRoiBp / 100}%, нет — бот ничего не придумывает, когда выгоды нет.`);
    return lines.join('\n');
  }
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. <b>${esc(r.name)}</b>`);
    lines.push(`Купи на ${MARKETS[r.buy_at].name} за ${fmt(r.pay_kop)} → продай на ${MARKETS[r.sell_at].name} за ${fmt(r.sell_kop)} → получишь <b>${fmt(r.get_kop)}</b> (${sign(r.profit_kop)}, ${pct(r.roi_bp)})`);
    lines.push(r.wallet === 'cash' ? '💵 деньгами' : '🎮 на баланс Steam (вывести нельзя)');
    lines.push('');
  });
  lines.push('<i>Цены на момент публикации, комиссии площадок учтены. Это не финансовый совет: проверь цену перед покупкой. Завтра здесь будет честный итог — сработали эти идеи или нет.</i>');
  return lines.join('\n');
}

export interface CaseStat { name: string; d1: number | null; d7: number | null; d30: number | null }

/** Воскресный итог недели: индекс кейсов, лидеры роста и падения, как сработали идеи, сколько нас. */
export function weeklyPost(cases: CaseStat[], week: IdeaRow[], users: { total: number; week: number }, now: number): string | null {
  const date = warsawDate(now).split('-').reverse().slice(0, 2).join('.');
  const ch = cases.filter((c) => c.d7 && c.d30).map((c) => ({ name: c.name, bp: Math.trunc(((c.d7! - c.d30!) * 10000) / c.d30!) }));
  const checked = week.filter((r) => r.outcome === 'plus' || r.outcome === 'minus');
  if (ch.length < 5 && !checked.length) return null;
  const lines = [`📅 <b>Итог недели · ${date}</b>`, ''];
  if (ch.length >= 5) {
    const avg = Math.round(ch.reduce((s, x) => s + x.bp, 0) / ch.length);
    lines.push(`📦 <b>Индекс кейсов Steam:</b> ${pct(avg)} — так в среднем изменились ${ch.length} кейсов (средняя цена продаж за неделю против месяца).`, '');
    const up = [...ch].sort((a, b) => b.bp - a.bp).filter((x) => x.bp > 0).slice(0, 3);
    const down = [...ch].sort((a, b) => a.bp - b.bp).filter((x) => x.bp < 0).slice(0, 3);
    if (up.length) { lines.push('🔺 <b>Сильнее всех выросли</b>'); for (const x of up) lines.push(`• ${esc(x.name)} — ${pct(x.bp)}`); lines.push(''); }
    if (down.length) { lines.push('🔻 <b>Сильнее всех упали</b>'); for (const x of down) lines.push(`• ${esc(x.name)} — ${pct(x.bp)}`); lines.push(''); }
  }
  if (checked.length) {
    const plus = checked.filter((r) => r.outcome === 'plus');
    const best = [...checked].sort((a, b) => (b.profit_kop_24 ?? 0) - (a.profit_kop_24 ?? 0))[0];
    const avgReal = Math.round(checked.reduce((s, r) => s + (r.profit_kop_24 ?? 0), 0) / checked.length);
    lines.push(`💡 <b>Идеи бота за неделю:</b> ${checked.length} проверено, ${plus.length} через сутки были в плюсе (${Math.round((plus.length / checked.length) * 100)}%). В среднем ${sign(avgReal)} на сделку.`);
    lines.push(`Лучшая: ${esc(best.name)} — ${sign(best.profit_kop_24 ?? 0)}.`, '');
  }
  if (users.total >= 20) lines.push(`👥 Ботом пользуются ${users.total} человек${users.week ? `, за неделю +${users.week}` : ''}.`, '');
  lines.push('<i>Это статистика прошлого, а не прогноз. Рост и падение могут развернуться.</i>');
  return lines.join('\n');
}

export interface NewsItem { gid: string; title: string; url: string; snippet: string | null; published_at: number; image?: string | null }

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

export function newsPost(n: NewsItem): string {
  const date = warsawDate(n.published_at).split('-').reverse().join('.');
  return [
    `🛠 <b>Обновление CS2</b> · ${date}`, '',
    `<b>${esc(n.title)}</b>`,
    ...(n.snippet ? ['', `<i>${esc(n.snippet)}</i>`] : []),
    '', 'После обновлений цены кейсов и скинов часто двигаются — как отреагировал рынок, смотри в вечернем посте «Кейсы в Steam».',
  ].join('\n');
}
