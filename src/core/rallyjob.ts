// «Разгон баланса»: хранение кандидатов от сборщика, автозакрытие сделок симуляции и уведомления.
// Работает при приходе свежих данных (ingest kind 'rally_scan'), а не по расписанию — не тратит лимиты Cron.
import { parseSteamPriceString } from '../utils/money.ts';
import { safeImg } from './recs.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { RALLY_KEYS, RALLY_DEFAULTS, parseRallySettings, findCandidates, simSale, capital, buyBlockers, RISK_RU, type RallyEntry, type RallyTrade, type RallySettings, type Track } from './rally.ts';
import { getMeta, setMetaStmt } from './channel.ts';
import { steamNetKop } from './fees.ts';
import { loadUserSettings, nextAllowed } from './audience.ts';
import { TERMS_VERSION } from './terms.ts';
import * as db from '../storage/db.ts';
import { esc, type Keyboard } from '../telegram/api.ts';

const KEEP_SEC = 24 * 3600;

export async function loadRallyScan(d: D1Database): Promise<{ entries: RallyEntry[]; at: number | null }> {
  const r = await d.prepare('SELECT data, fetched_at FROM rally_scan WHERE id = 1').first<{ data: string; fetched_at: number }>();
  if (!r) return { entries: [], at: null };
  try { const e = JSON.parse(r.data); return { entries: Array.isArray(e) ? e : [], at: r.fetched_at }; } catch { return { entries: [], at: r.fetched_at }; }
}

/** Проверка того, что прислал сборщик: цены Steam — в гривнах (currency=18), средние — USD-центы → копейки по курсу НБУ. */
export function parseRallyItems(items: unknown, usd: FxRate | null, at: number): RallyEntry[] {
  if (!Array.isArray(items)) return [];
  const c = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e5 ? x : null);
  const k = (x: unknown) => { const v = c(x); return v && usd ? toKop(Math.round(v * 100), 'USD', usd) : null; };
  const out: RallyEntry[] = [];
  for (const r of items.slice(0, 60) as Record<string, any>[]) {
    if (!r || typeof r.name !== 'string' || r.name.length > 200) continue;
    const st = r.steam && typeof r.steam === 'object' ? r.steam : null;
    const vol = st && typeof st.volume === 'string' ? Number(st.volume.replace(/[^\d]/g, '')) : null;
    const o = r.orders && typeof r.orders === 'object' ? r.orders : null;
    const intKop = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 && x < 1e9 ? x : null);
    out.push({
      name: r.name, img: safeImg(r.img), cur: 'UAH',
      sa: r.sa && usd ? { d1: k(r.sa.d1), d7: k(r.sa.d7), d30: k(r.sa.d30), d90: k(r.sa.d90) } : null,
      steam: st ? { lowest: parseSteamPriceString(st.lowest_price ?? null), median: parseSteamPriceString(st.median_price ?? null), volume: Number.isFinite(vol) ? vol : null, at } : null,
      orders: o ? { buy: intKop(o.buy), sell: intKop(o.sell), buyCount: null, sellCount: null, at } : null,
    });
  }
  return out;
}

export function mergeRally(old: RallyEntry[], fresh: RallyEntry[], now: number): RallyEntry[] {
  const by = new Map(old.filter((e) => e.steam && now - e.steam.at < KEEP_SEC).map((e) => [e.name, e]));
  for (const e of fresh) {
    const p = by.get(e.name);
    by.set(e.name, { ...e, steam: e.steam ?? p?.steam ?? null, orders: e.orders ?? (p?.orders && now - p.orders.at < 6 * 3600 ? p.orders : null), img: e.img ?? p?.img ?? null });
  }
  return [...by.values()].sort((a, b) => (b.steam?.at ?? 0) - (a.steam?.at ?? 0)).slice(0, 500);
}

/** Для сборщика: нужен ли проход и какие предметы проверить в первую очередь. */
export async function rallyInfo(d: D1Database): Promise<{ active: boolean; names: string[]; nameids: Record<string, number>; maxItemKop: number }> {
  const users = (await d.prepare(`SELECT COUNT(DISTINCT telegram_id) AS n FROM user_settings WHERE key = 'rally_on' AND value = '1'`).first<{ n: number }>())?.n ?? 0;
  const open = (await d.prepare(`SELECT DISTINCT name FROM rally_trades WHERE status = 'open' LIMIT 20`).all<{ name: string }>()).results.map((r) => r.name);
  // Симуляция самого бота (BOT_TID) работает всегда, пока её не выключили: meta rally_bot = off.
  const botOn = (await getMeta(d, 'rally_bot')) !== 'off';
  if (!users && !open.length && !botOn) return { active: false, names: [], nameids: {}, maxItemKop: 600 };
  const max = (await d.prepare(`SELECT MAX(CAST(value AS INTEGER)) AS m FROM user_settings WHERE key = 'rally_max_item'`).first<{ m: number | null }>())?.m ?? 600;
  const ids = (await d.prepare('SELECT name, nameid FROM item_nameids ORDER BY at DESC LIMIT 1500').all<{ name: string; nameid: number }>()).results;
  return { active: true, names: open, nameids: Object.fromEntries(ids.map((r) => [r.name, r.nameid])), maxItemKop: Math.max(600, Math.min(max, 100000)) };
}

export async function rallySettingsFor(d: D1Database, tid: number): Promise<RallySettings> {
  const r = await d.prepare(`SELECT key, value FROM user_settings WHERE telegram_id = ? AND key LIKE 'rally_%'`).bind(tid).all<{ key: string; value: string }>();
  return parseRallySettings(Object.fromEntries(r.results.map((x) => [x.key, x.value])));
}

export async function rallyTrack(d: D1Database, tid: number | null): Promise<Track> {
  const r = await d.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN sold_net_kop >= predicted_net_kop * qty THEN 1 ELSE 0 END) AS hit FROM rally_trades
    WHERE status = 'sold' AND predicted_net_kop IS NOT NULL AND parent_id IS NULL ${tid ? 'AND telegram_id = ?' : ''}`).bind(...(tid ? [tid] : [])).first<{ n: number; hit: number | null }>();
  return { n: r?.n ?? 0, hit: r?.hit ?? 0 };
}

const outboxStmt = (d: D1Database, tid: number, kind: string, ref: string, text: string, kb: Keyboard, at: number, now: number) =>
  d.prepare(`INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?)`)
    .bind(tid, kind, ref, text, JSON.stringify(kb), at, now);

const fmtUah = (k: number, sign = false) => `${sign && k > 0 ? '+' : k < 0 ? '−' : ''}${(Math.abs(k) / 100).toFixed(2).replace('.', ',')} ₴`;

/** Пост о новой функции — ТОЛЬКО если проверка сработала (≥ 10 закрытых сделок, ≥ 5 в плюсе, общий итог в плюсе). */
export function rallyPostText(st: BotStats): string {
  const lines = st.best.map((t) => `• ${esc(t.name)}: ${fmtUah(t.buy_kop * t.qty)} → ${fmtUah(t.sold_price_kop! * t.qty)}, пришло ${fmtUah(t.sold_net_kop!)} (${fmtUah(t.sold_net_kop! - t.buy_kop * t.qty, true)})`);
  return [
    '🚀 <b>Новое в боте: «Разгон баланса» Steam</b>', '',
    `Прежде чем показать вам, бот проверил схему сам: ${st.accounts} виртуальных счетов по ${fmtUah(st.startKop)}, сделки внутри Steam, 7 дней блокировки, продажа по <b>реальным</b> ценам Steam на тот момент и настоящая комиссия.`, '',
    `<b>Результат: в плюсе ${st.wins} из ${st.closed} сделок</b>, общий итог ${fmtUah(st.realizedKop, true)}.`,
    ...(lines.length ? ['Лучшие:', ...lines] : []), '',
    'Что умеет раздел:',
    '• ищет дешёвые ликвидные предметы ниже обычной цены — до 5 кандидатов, только с подтверждёнными данными;',
    '• считает точную комиссию Steam и 7 дней блокировки, показывает риск;',
    '• лимиты: 6 ₴ на покупку, резерв 18 ₴, максимум 2 позиции (всё настраивается);',
    '• симуляция — сначала потренируйся на виртуальных деньгах.', '',
    `<i>Это симуляция, а не обещание заработка: ${st.closed - st.wins} из ${st.closed} сделок не дали прибыли, рынок за 7 дней может измениться. Бот ничего не покупает сам.</i>`,
    'Открыть: приложение бота → «Разгон баланса»',
  ].filter((x) => x !== '').join('\n').replace('\n<i>', '\n\n<i>');
}

/** 10 параллельных виртуальных счетов бота (telegram_id 0, −1 … −9): каждый по 30 ₴ и по тем же правилам,
 *  но берёт РАЗНЫЕ предметы — так 10 независимых сделок закрываются примерно за одну блокировку (7–8 дней), а не за месяц. */
export const BOT_ACCOUNTS = Array.from({ length: 10 }, (_, i) => -i);
export const BOT_MIN_CLOSED = 10;   // вывод о схеме — не раньше 10 закрытых сделок
export const BOT_MIN_WINS = 5;      // «работает» — минимум половина сделок в плюсе и общий итог в плюсе

export interface BotStats { closed: number; wins: number; realizedKop: number; startKop: number; open: number; accounts: number; best: RallyTrade[] }
/** «Разгон» открыт всем, только когда симуляция самого бота подтвердила схему: ≥ 10 закрытых, ≥ 5 в плюсе, итог в плюсе.
 *  До этого — только владельцу (продуктовое решение: не показывать людям непроверенную схему). */
export async function rallyProven(d: D1Database): Promise<boolean> {
  const bt = (await d.prepare("SELECT * FROM rally_trades WHERE telegram_id <= 0 AND telegram_id >= -9 AND mode = 'sim' ORDER BY id DESC LIMIT 200").all<RallyTrade>()).results;
  const st = botStats(bt);
  return st.closed >= BOT_MIN_CLOSED && st.wins >= BOT_MIN_WINS && st.realizedKop > 0;
}

export function botStats(trades: RallyTrade[]): BotStats {
  const sold = trades.filter((t) => t.status === 'sold' && t.parent_id == null);
  const accounts = new Set(trades.map((t) => (t as RallyTrade & { telegram_id?: number }).telegram_id)).size;
  return {
    closed: sold.length, wins: sold.filter((t) => (t.sold_net_kop ?? 0) > t.buy_kop * t.qty).length,
    realizedKop: sold.reduce((a, t) => a + (t.sold_net_kop ?? 0) - t.buy_kop * t.qty, 0), startKop: RALLY_DEFAULTS.simStartKop,
    open: trades.filter((t) => t.status === 'open').length, accounts,
    best: [...sold].sort((a, b) => ((b.sold_net_kop ?? 0) - b.buy_kop * b.qty) - ((a.sold_net_kop ?? 0) - a.buy_kop * a.qty)).slice(0, 3),
  };
}

async function botSim(d: D1Database, entries: RallyEntry[], now: number, adminId: number | null, writes: D1PreparedStatement[]): Promise<void> {
  if ((await getMeta(d, 'rally_bot')) === 'off') return;
  const all = (await d.prepare(`SELECT * FROM rally_trades WHERE telegram_id <= 0 AND telegram_id >= -9 AND mode = 'sim'`).all<RallyTrade & { telegram_id: number }>()).results;
  const s = RALLY_DEFAULTS;
  const startedAt = Number(await getMeta(d, 'rally_bot_started')) || 0;
  if (!startedAt) writes.push(setMetaStmt(d, 'rally_bot_started', String(now)));
  // Покупки: каждому счёту со свободным местом — лучший кандидат с низким риском, которого нет ни у одного счёта бота.
  const { list } = findCandidates(entries, s, now, await rallyTrack(d, null), 50);
  const held = new Set(all.filter((t) => t.status === 'open').map((t) => t.name));
  const bought: string[] = [];
  for (const acc of BOT_ACCOUNTS) {
    const mine = all.filter((t) => t.telegram_id === acc);
    const cap = capital(mine, s, 'sim', now);
    const pick = list.find((c) => !held.has(c.name));
    if (!pick || buyBlockers(cap, s, pick.buyKop).length) continue;
    held.add(pick.name);
    writes.push(d.prepare(`INSERT INTO rally_trades (telegram_id, mode, name, img, qty, buy_kop, bought_at, unlock_at, target_kop, predicted_net_kop, risk) VALUES (?, 'sim', ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .bind(acc, pick.name, pick.img, pick.buyKop, now, pick.unlockAt, pick.targetKop, pick.netKop, pick.risk));
    bought.push(`${esc(pick.name)} за ${fmtUah(pick.buyKop)} → прогноз ${fmtUah(pick.profitKop, true)}`);
  }
  if (bought.length && adminId) writes.push(outboxStmt(d, adminId, 'rally_bot', `buy:${now}`, `🤖 <b>Симуляция бота: виртуальные покупки</b>\n${bought.map((x) => '• ' + x).join('\n')}\nРезультат — после 7 дней блокировки, по фактическим ценам Steam.`, [], now, now));

  // Вывод о схеме: не раньше 10 закрытых сделок. Пост — только если сработала: ≥ 5 из 10 в плюсе и общий итог в плюсе.
  const st = botStats(all);
  const state = await getMeta(d, 'rally_post');
  if (state === 'done' || st.closed < BOT_MIN_CLOSED) {
    if (startedAt && now - startedAt > 3 * 86400 && !all.length && !(await getMeta(d, 'rally_bot_empty')) && adminId) {
      writes.push(setMetaStmt(d, 'rally_bot_empty', String(now)));
      writes.push(outboxStmt(d, adminId, 'rally_bot', 'empty', '🤖 <b>Симуляция бота</b>: за 3 дня безопасных сделок по правилам «Разгона» (6 ₴, резерв 18 ₴, низкий риск) не нашлось. Это честный результат: на дешёвых предметах Steam выгодные расхождения редки.', [], now, now));
    }
    return;
  }
  const works = st.wins >= BOT_MIN_WINS && st.realizedKop > 0;
  if (works && !(await getMeta(d, 'channel_pending')) && (await getMeta(d, 'channel_id'))) {
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    const id = `rally-${day}`;
    const card = { id, slot: 'rally', date: day.split('-').reverse().join('.'), title: 'Разгон баланса', subtitle: 'проверка ботом на реальных ценах Steam',
      big: `${st.wins} из ${st.closed}`, bigLabel: `сделок в плюсе · итог ${fmtUah(st.realizedKop, true)}`,
      deals: st.best.map((t) => ({ name: t.name, img: t.img, buy: 'Steam', buyPrice: fmtUah(t.buy_kop * t.qty), sell: 'Steam', sellPrice: fmtUah(t.sold_price_kop! * t.qty), profit: fmtUah(t.sold_net_kop! - t.buy_kop * t.qty, true), roi: '' })),
      note: 'симуляция, не обещание заработка' };
    writes.push(setMetaStmt(d, 'channel_pending', JSON.stringify({ id, text: rallyPostText(st), image: null, at: now })), setMetaStmt(d, 'card_request', JSON.stringify(card)), setMetaStmt(d, 'rally_post', 'done'));
    if (adminId) writes.push(outboxStmt(d, adminId, 'rally_bot', `post:${day}`, `✅ <b>Схема сработала в симуляции</b>: в плюсе ${st.wins} из ${st.closed} сделок, итог ${fmtUah(st.realizedKop, true)}. Пост о «Разгоне баланса» с картинкой уйдёт в канал в ближайшие ~10–25 минут.`, [], now, now));
  } else if (!works && state !== 'fail' && adminId) {
    writes.push(setMetaStmt(d, 'rally_post', 'fail'));
    writes.push(outboxStmt(d, adminId, 'rally_bot', 'fail', `⚠️ <b>Симуляция бота: схема не сработала</b> — в плюсе ${st.wins} из ${st.closed} сделок, итог ${fmtUah(st.realizedKop, true)}. Пост в канал не публикую. Симуляция продолжается.`, [], now, now));
  }
}

/** После свежих данных: закрыть сделки симуляции, разослать уведомления. */
export async function afterRallyScan(d: D1Database, entries: RallyEntry[], now: number, origin: string | null, adminId: number | null = null): Promise<{ simClosed: number; notified: number }> {
  const by = new Map(entries.map((e) => [e.name, e]));
  const writes: D1PreparedStatement[] = [];
  let simClosed = 0, notified = 0;
  const appKb = (): Keyboard => (origin ? [[{ text: '🚀 Разгон баланса', web_app: { url: `${origin}/app#rally` } }]] : []);

  // 1) Открытые сделки (реальные и симуляция).
  const open = (await d.prepare(`SELECT * FROM rally_trades WHERE status = 'open' LIMIT 500`).all<RallyTrade & { telegram_id: number; n_target: number; n_unlock: number; n_change: number }>()).results;
  const tids = [...new Set([...open.map((t) => t.telegram_id),
    ...(await d.prepare(`SELECT telegram_id FROM user_settings WHERE key = 'rally_on' AND value = '1' LIMIT 500`).all<{ telegram_id: number }>()).results.map((r) => r.telegram_id)])];
  if (!tids.length) { await flushBot(); return { simClosed, notified }; }
  const st = await loadUserSettings(d, tids);
  const canNotify = (tid: number) => { const s = st.get(tid); return !!s && s.notify_enabled === '1' && s.terms_ok === TERMS_VERSION && s.rally_notify !== '0'; };
  const when = (tid: number) => { const s = st.get(tid)!; return nextAllowed(now, db.num(s.quiet_start), db.num(s.quiet_end)); };

  for (const t of open) {
    const e = by.get(t.name);
    if (t.mode === 'sim') {
      const sale = simSale(t, e, now);
      if (sale) {
        writes.push(d.prepare(`UPDATE rally_trades SET status = 'sold', sold_qty = qty, sold_price_kop = ?, sold_net_kop = ?, sold_at = ?, sold_note = ? WHERE id = ? AND status = 'open'`)
          .bind(sale.priceKop, sale.netKop, now, sale.note, t.id));
        simClosed++;
      }
      continue;
    }
    if (!canNotify(t.telegram_id)) continue;
    const cur = e?.steam && now - e.steam.at < 3 * 3600 ? Math.min(...[e.steam.lowest, e.steam.median].filter((x): x is number => typeof x === 'number' && x > 0)) : null;
    // 4) Закончилась блокировка.
    if (!t.n_unlock && t.unlock_at <= now) {
      writes.push(d.prepare('UPDATE rally_trades SET n_unlock = 1 WHERE id = ?').bind(t.id));
      writes.push(outboxStmt(d, t.telegram_id, 'rally', `unlock:${t.id}`, `🔓 <b>Можно продавать</b>\n\n<b>${esc(t.name)}</b> — блокировка после покупки должна была закончиться (проверь в инвентаре Steam).${cur ? `\nСейчас продают примерно за ⟦${cur}⟧.` : ''}\n\nПродай вручную в Steam и отметь продажу в «Мои сделки».`, appKb(), when(t.telegram_id), now));
      notified++;
    }
    if (cur && Number.isFinite(cur)) {
      // 3) Цена дошла до плана.
      if (!t.n_target && t.target_kop && cur >= t.target_kop) {
        writes.push(d.prepare('UPDATE rally_trades SET n_target = 1 WHERE id = ?').bind(t.id));
        writes.push(outboxStmt(d, t.telegram_id, 'rally', `target:${t.id}`, `🎯 <b>Цена дошла до плана</b>\n\n<b>${esc(t.name)}</b>: сейчас ≈ ⟦${cur}⟧ (план ⟦${t.target_kop}⟧)${t.unlock_at > now ? `\n⚠️ Продать можно только после ${new Date(t.unlock_at * 1000).toISOString().slice(0, 10)}.` : ''}`, appKb(), when(t.telegram_id), now));
        notified++;
      }
      // 5) Рынок изменился — прогноз больше неактуален (продажа сейчас дала бы убыток).
      const net = steamNetKop(cur);
      if (!t.n_change && net != null && net < t.buy_kop) {
        writes.push(d.prepare('UPDATE rally_trades SET n_change = 1 WHERE id = ?').bind(t.id));
        writes.push(outboxStmt(d, t.telegram_id, 'rally', `change:${t.id}`, `⚠️ <b>Рынок изменился</b>\n\n<b>${esc(t.name)}</b>: сейчас ≈ ⟦${cur}⟧ — после комиссии придёт ⟦${net}⟧, меньше цены покупки ⟦${t.buy_kop}⟧. Прежняя рекомендация больше не актуальна. Решай сам: ждать или продать.`, appKb(), when(t.telegram_id), now));
        notified++;
      }
    }
  }

  // 2) Новые подходящие возможности — тем, кто включил раздел и уведомления (без повторов: та же сделка — раз в сутки).
  const track = await rallyTrack(d, null);
  for (const tid of tids) {
    const s = st.get(tid);
    if (!s || s.rally_on !== '1' || !canNotify(tid)) continue;
    const rs = await rallySettingsFor(d, tid);
    const mine = open.filter((t) => t.telegram_id === tid);
    const cap = capital(mine, rs, 'real', now);
    if (cap.openCount >= rs.maxPositions) continue;
    const { list } = findCandidates(entries, rs, now, track);
    let seen: Record<string, number> = {};
    try { seen = JSON.parse(s.rally_seen || '{}'); } catch { seen = {}; }
    const fresh = list.filter((c) => !seen[c.name] || now - seen[c.name] > 86400);
    if (!fresh.length) continue;
    const c = fresh[0];
    seen[c.name] = now;
    for (const [k, v] of Object.entries(seen)) if (now - v > 3 * 86400) delete seen[k];
    writes.push(d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'rally_seen', ?, ?)
      ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tid, JSON.stringify(seen), now));
    writes.push(outboxStmt(d, tid, 'rally', `new:${c.name}:${Math.floor(now / 86400)}`,
      `🚀 <b>Разгон баланса: новая возможность</b>\n\n<b>${esc(c.name)}</b>\nКупить ≈ ⟦${c.buyKop}⟧ → через 7 дней продать за ⟦${c.targetKop}⟧ → придёт ⟦${c.netKop}⟧\nЧистыми: +⟦${c.profitKop}⟧ (${Math.round(c.roiBp / 100)}%) · риск: ${RISK_RU[c.risk]}\n\n<i>Это не гарантия: цена за 7 дней блокировки может измениться. Бот ничего не покупает сам.</i>`,
      appKb(), when(tid), now));
    notified++;
  }
  await flushBot();
  return { simClosed, notified };

  async function flushBot() {
    // Сначала закрытия выше, потом — симуляция бота (по обновлённым данным).
    for (let i = 0; i < writes.length; i += 90) await d.batch(writes.slice(i, i + 90));
    const w2: D1PreparedStatement[] = [];
    await botSim(d, entries, now, adminId, w2);
    for (let i = 0; i < w2.length; i += 90) await d.batch(w2.slice(i, i + 90));
  }
}
