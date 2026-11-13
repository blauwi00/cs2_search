// JSON API для Telegram Mini App. Каждый запрос подписан Telegram (initData) и принимается только от администратора.

import { peopleList, personCard, saveNameStmts, type PeopleFilter } from './people.ts';
import { weekDelta, parseTop, type HistRow } from '../core/history.ts';
import { spendIdeas, SPEND_MIN_KOP, type SpendIdea } from '../core/spend.ts';
import type { Env } from '../env.ts';
import * as db from '../storage/db.ts';
import * as T from '../storage/trades.ts';
import { budgetedDb, newBudget } from '../storage/budget.ts';
import { verifyInitData } from './auth.ts';
import { searchCatalog, catalogInfo, catalogHas } from '../catalog.ts';
import { parseMarketHashName, CATEGORY_RU } from '../core/normalization.ts';
import { classifyLiquidity, LIQUIDITY_RU } from '../core/liquidity.ts';
import { stats } from '../core/analyzer.ts';
import { valuation, viewLot, realizedStats, PLATFORMS, PLATFORM_RU, BUY_ONLY, walletFor, parseDateInput, openQty } from '../core/portfolio.ts';
import { steamListForNetKop } from '../core/fees.ts';
import { settingsFor, parseSettingInput, displayValue } from '../telegram/settings.ts';
import { listJobs, setJobEnabled } from '../core/scheduler.ts';
import { warsawDate } from '../utils/time.ts';
import { steamListingUrl, safeLink } from '../utils/http.ts';
import { backtest } from '../core/quality.ts';
import { advise, ACTION_RANK, type Advice } from '../core/advice.ts';
import { buildRecs, MARKETS, SKINPORT_MIN_FEE_EUR_CENTS, itemUrl, loadSkinportPages, type Rec, type ItemPages } from '../core/recs.ts';
import { loadScan } from '../storage/scan.ts';
import { WATCH_LIMIT, LOTS_LIMIT } from '../core/audience.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { steamLoginUrl, newNonce, parseSteamProfile } from '../steam_link.ts';
import { floatNote, type AssetDetail } from '../core/inspect.ts';
import { guessCurrency, loadRates, userCur, availableCurrencies, isCurrency, parseNbuDisplay } from '../currency/display.ts';
import { renderMoney } from '../utils/money.ts';
import { PRIVACY_POINTS } from '../core/privacy.ts';
import { steamSellPrice } from '../core/sellprice.ts';
import { unlockAt, TRADE_LOCK_SEC } from '../core/tradelock.ts';
import { TERMS_VERSION, TERMS_SHORT, TERMS_SECTIONS, PRIVACY_SECTIONS } from '../core/terms.ts';
import { sitesFor, loadRefLinks } from '../core/sites.ts';
import { sitePriceList, SITE_PRICE_KIND } from '../core/sites.ts';
import { TelegramClient } from '../telegram/api.ts';
import { sha256Hex, requestedSiteNames } from '../ingest.ts';
import { botUsername, getMeta, setMetaStmt } from '../core/channel.ts';
import { loadCollections, collViews, skinViews, STEAM_CURRENCY_ID } from '../core/collections.ts';
import { submitSuggestion } from '../telegram/suggest.ts';
import { fetchInventory, storeInventory, type InvFetch } from '../core/steaminv.ts';
import { matchName } from '../core/screenread.ts';
import { SKINPORT_LISTED } from './import_skinport.ts';
import { recStats } from '../core/insights.ts';
import { steamEvidence, marketValue, siteMedianKop, AVG_MAX_AGE_SEC, LIVE_MAX_AGE_SEC } from '../core/evidence.ts';
import { steamNetKop } from '../core/fees.ts';
import { MAX_SELL_ALERTS } from '../core/sellalerts.ts';
import { calcFees } from '../core/calc.ts';
import { findCandidates, capital, buyBlockers, checkChain, RALLY_KEYS, RALLY_DEFAULTS, UNLOCK_SEC, type RallyTrade, type RallySettings } from '../core/rally.ts';
import { steamBalanceFor, steamBuyLimit, splitByBalance, type SteamBalance } from '../core/steambalance.ts';
import { loadRallyScan, rallySettingsFor, rallyTrack, botStats, rallyProven, BOT_MIN_CLOSED } from '../core/rallyjob.ts';
import { safeImg } from '../core/recs.ts';
import { submitFeedback, donateInvoiceLink, topDonors, DONATE_AMOUNTS } from '../core/support.ts';

/**
 * Память воркера между запросами (одна копия воркера обслуживает много людей): последний скан рынка и уже посчитанные идеи.
 * Скан меняется раз в ~10 минут — без этого каждый человек при каждом открытии заново разбирал бы весь скан и пересчитывал идеи.
 * Ключ — сама база (в тестах у каждой своя), поэтому данные разных баз не смешиваются.
 */
interface Memo { scan: { v: Awaited<ReturnType<typeof loadScan>>; checked: number } | null; recs: Map<string, ReturnType<typeof buildRecs>>; watched: { n: number; at: number } | null }
const MEMO = new WeakMap<object, Memo>();
function memoFor(k: object): Memo {
  let m = MEMO.get(k);
  if (!m) { m = { scan: null, recs: new Map(), watched: null }; MEMO.set(k, m); }
  return m;
}
/** Скан рынка: раз в минуту лёгкой проверкой «не появился ли новый», сам скан (большой JSON) — только когда он новый. */
async function scanCached(d: D1Database, m: Memo, now: number) {
  if (m.scan && now - m.scan.checked < 60) return m.scan.v;
  const r = await d.prepare('SELECT fetched_at FROM market_scan WHERE id = 1').first<{ fetched_at: number }>();
  if (m.scan && m.scan.v && r?.fetched_at === m.scan.v.fetchedAt) { m.scan.checked = now; return m.scan.v; }
  const v = await loadScan(d);
  m.scan = { v, checked: now };
  m.recs.clear();
  return v;
}
/** Число предметов в наблюдении у всех — в сводке; пересчёт не чаще раза в 5 минут (и сразу после изменения списка). */
async function watchedCountCached(d: D1Database, m: Memo, now: number): Promise<number> {
  if (m.watched && now - m.watched.at < 300) return m.watched.n;
  const n = await db.countActiveWatched(d);
  m.watched = { n, at: now };
  return n;
}

/**
 * Курс валюты (гривен за 1 единицу) на дату покупки — по НБУ за тот день (кэш в meta nbu_day:ГГГГ-ММ-ДД).
 * Сегодня — текущий курс. Нет курса на дату (НБУ не ответил, валюты нет — например, рубль) — сегодняшний, exact=false.
 */
async function rateOn(d: D1Database, code: string, date: string, today: string): Promise<{ per: number; exact: boolean } | null> {
  if (code === 'UAH') return { per: 1, exact: true };
  const nowRates = await loadRates(d);
  const fallback = nowRates[code] ? { per: nowRates[code], exact: date === today } : null;
  if (date === today) return fallback;
  let day: Record<string, number> | null = null;
  try { day = JSON.parse((await getMeta(d, `nbu_day:${date}`)) ?? 'null'); } catch { day = null; }
  if (!day) {
    try {
      const r = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${date.replace(/-/g, '')}&json`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { day = parseNbuDisplay(await r.json()); if (Object.keys(day).length) await setMetaStmt(d, `nbu_day:${date}`, JSON.stringify(day)).run(); }
    } catch { day = null; }
  }
  return day?.[code] ? { per: day[code], exact: true } : fallback;
}

/** «За неделю» по инвентарю: суточные точки из inv_value_daily; пока истории мало — только счётчик дней. Суммы — по средним продажам Steam, в гривне по текущему курсу. */
async function invHistory(d: D1Database, tid: number, usd: FxRate | null) {
  const rows = (await d.prepare('SELECT day, total_usd_c, top FROM inv_value_daily WHERE telegram_id = ? ORDER BY day DESC LIMIT 14').bind(tid)
    .all<{ day: string; total_usd_c: number; top: string | null }>()).results;
  const hist: HistRow[] = rows.map((r) => ({ day: r.day, total: r.total_usd_c, top: parseTop(r.top) }));
  const { delta, days } = weekDelta(hist);
  const k = (c: number) => (usd ? toKop(Math.abs(c), 'USD', usd) : null);
  if (!delta || !usd) return { days, delta: null, lastDay: rows[0]?.day ?? null };
  const ids = delta.movers.map((m) => m.id);
  const names = ids.length ? (await d.prepare(`SELECT id, market_hash_name AS name FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: number; name: string }>()).results : [];
  const sign = (c: number, kop: number | null) => (kop === null ? null : c < 0 ? -kop : kop);
  return { days, lastDay: delta.toDay, delta: {
    kop: sign(delta.deltaUsdC, k(delta.deltaUsdC)), pct: delta.pct, fromDay: delta.fromDay, toDay: delta.toDay,
    movers: delta.movers.map((m) => ({ name: names.find((n) => n.id === m.id)?.name ?? '', kop: sign(m.deltaUsdC, k(m.deltaUsdC)) })).filter((m) => m.name && m.kop !== null),
  } };
}
/** Рекомендации по всему рынку из последнего сканирования сборщика. Старше суток — не показываем. */
/**
 * Идеи по всему рынку для человека. Галочка «Подбирать идеи под баланс Steam» (и вписанный баланс): только идеи,
 * на покупку которых хватает баланса (покупки в Steam — первыми), дороже — в hidden («Ещё N идей дороже твоего баланса — показать»). Как в уведомлениях.
 * bal — уже посчитанный баланс (сводка считает его сама, чтобы не делать запросы дважды).
 */
async function recsFor(d: D1Database, tid: number, now: number, m: Memo, pre?: { st: db.Settings; bal: SteamBalance | null }) {
  const [scan, fx, st] = await Promise.all([scanCached(d, m, now), db.loadLatestFx(d), pre ? pre.st : db.getSettings(d, tid)]);
  const empty = { fetchedAt: scan?.fetchedAt ?? null, scanned: 0, deals: [] as RecDto[], trends: [] as RecDto[], hidden: [] as RecDto[], limitKop: null as number | null, spend: [] as SpendIdea[] };
  if (!scan || now - scan.fetchedAt > 86400) return empty;
  const rs = { minProfitKop: db.num(st.min_profit_kop), minRoiBp: db.num(st.min_roi_bp), depositFeeBp: db.num(st.deposit_fee_bp), withdrawFeeBp: db.num(st.withdraw_fee_bp) };
  // Одинаковые пороги и комиссии у большинства — считаем идеи один раз на скан и курс.
  const key = [scan.fetchedAt, rs.minProfitKop, rs.minRoiBp, rs.depositFeeBp, rs.withdrawFeeBp, fx.get('EUR')?.id ?? 0, fx.get('USD')?.id ?? 0].join('|');
  let r = m.recs.get(key);
  if (!r) { r = buildRecs(scan.entries, fx, rs); if (m.recs.size > 30) m.recs.clear(); m.recs.set(key, r); }
  const bal = pre ? pre.bal : st.recs_by_balance === '1' ? await steamBalanceFor(d, tid, st, now) : null;
  const limitKop = steamBuyLimit(bal, st);
  const split = splitByBalance(r.deals, limitKop), splitT = splitByBalance(r.trends, limitKop);
  const pages = await loadSkinportPages(d, [...r.deals, ...r.trends].filter((x) => x.buyAt === 'skinport' || x.sellAt === 'skinport').map((x) => x.name).slice(0, 200));
  const dto = (x: Rec): RecDto => ({ ...recDto(x, pages), fitsBalance: limitKop !== null && x.payKop <= limitKop });
  // Баланс Steam вписан — подсказываем, куда его потратить (без гарантии прибыли).
  const spend = limitKop !== null && limitKop >= SPEND_MIN_KOP ? spendIdeas(scan.entries, limitKop) : [];
  return { fetchedAt: scan.fetchedAt, scanned: scan.entries.length, stale: now - scan.fetchedAt > 2 * 3600, deals: split.shown.map(dto), trends: splitT.shown.map(dto), hidden: [...split.hidden, ...splitT.hidden].map(dto), limitKop, spend };
}
/** Баланс Steam для приложения (шапка, окно баланса). byBalance — галочка (действует только при вписанном балансе). */
function balanceDto(b: SteamBalance | null, st: db.Settings) {
  return { steamBalance: b ? { kop: b.kop, minor: b.minor, cur: b.cur, at: b.at, sales: b.sales, buys: b.buys, stale: b.stale, mismatch: b.mismatch } : null, byBalance: st.recs_by_balance === '1' };
}
type RecDto = Rec & { buyUrl: string; sellUrl: string; category: string; buyName: string; sellName: string; fitsBalance?: boolean };
function recDto(r: Rec, pages?: ItemPages): RecDto {
  return { ...r, buyUrl: itemUrl(r.buyAt, r.name, pages), sellUrl: itemUrl(r.sellAt, r.name, pages), buyName: MARKETS[r.buyAt].name, sellName: MARKETS[r.sellAt].name,
    category: CATEGORY_RU[parseMarketHashName(r.name).category] ?? '' };
}

/** Подсказки «что делать» для набора предметов: 4 запроса к D1 на весь набор. */
/** Запросы по списку id кусками по 90 (лимит параметров D1 — 100). */
async function quotesChunked(d: D1Database, ids: number[]): Promise<Map<number, db.QuoteRow[]>> {
  const out = new Map<number, db.QuoteRow[]>();
  const parts = [];
  for (let i = 0; i < ids.length; i += 90) parts.push(db.quotesForItems(d, ids.slice(i, i + 90)));
  for (const m of await Promise.all(parts)) for (const [k, v] of m) out.set(k, v);
  return out;
}
async function chunkedAll<T>(ids: number[], q: (part: number[], ph: string) => Promise<T[]>): Promise<T[]> {
  const parts: Promise<T[]>[] = [];
  for (let i = 0; i < ids.length; i += 90) { const p = ids.slice(i, i + 90); parts.push(q(p, p.map(() => '?').join(','))); }
  return (await Promise.all(parts)).flat();
}
/**
 * Типичная цена объявления на сторонних площадках (медиана, в копейках) — для сверки средней цены Steam.
 * Только названия, где свежей цены Steam нет (иначе сверка не нужна) и без «ориентиров» (CS.MONEY). Данные старше 48 ч не берём.
 */
async function siteKopFor(d: D1Database, names: string[], usd: FxRate | null, now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(names)].slice(0, 360);
  if (!uniq.length || !usd) return out;
  let srcAt: Record<string, number> = {};
  try { srcAt = JSON.parse((await getMeta(d, 'site_src_at')) ?? '{}'); } catch { srcAt = {}; }
  const rows = await chunkedNames(uniq, (p, ph) => d.prepare(`SELECT name, json FROM site_prices WHERE name IN (${ph}) AND updated_at >= ?`).bind(...p, now - 48 * 3600).all<{ name: string; json: string }>().then((r) => r.results));
  for (const r of rows) {
    let c: Record<string, unknown> = {};
    try { c = JSON.parse(r.json); } catch { c = {}; }
    const kops: number[] = [];
    for (const [k, v] of Object.entries(c)) {
      if (typeof v !== 'number' || SITE_PRICE_KIND[k] === 'reference' || (srcAt[k] && now - srcAt[k] > 48 * 3600)) continue;
      const kk = toKop(v, 'USD', usd);
      if (kk) kops.push(kk);
    }
    const m = siteMedianKop(kops);
    if (m) out.set(r.name, m);
  }
  return out;
}
async function chunkedNames<T>(names: string[], q: (part: string[], ph: string) => Promise<T[]>): Promise<T[]> {
  const parts: Promise<T[]>[] = [];
  for (let i = 0; i < names.length; i += 90) { const p = names.slice(i, i + 90); parts.push(q(p, p.map(() => '?').join(','))); }
  return (await Promise.all(parts)).flat();
}
/** Записанные покупки под защитой обмена Steam (7 дней): в открытом инвентаре их не видно — показываем отдельно. */
async function lockedLots(d: D1Database, tid: number, now: number): Promise<{ lotId: number; itemId: number; name: string; qty: number; unlockAt: number; img: string | null }[]> {
  const rows = (await d.prepare(`SELECT t.id, t.item_id, t.buy_date, t.created_at, t.quantity - t.sold_quantity AS q, i.market_hash_name AS name FROM trades t JOIN items i ON i.id = t.item_id
    WHERE t.telegram_id = ? AND t.status = 'open' AND t.quantity > t.sold_quantity AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT 100`).bind(tid, now - TRADE_LOCK_SEC - 2 * 86400)
    .all<{ id: number; item_id: number; buy_date: string; created_at: number; q: number; name: string }>()).results
    .map((r) => ({ lotId: r.id, itemId: r.item_id, name: r.name, qty: r.q, unlockAt: unlockAt(r.buy_date, r.created_at) })).filter((r) => r.unlockAt > now);
  if (!rows.length) return [];
  const imgs = await imagesFor(d, rows.map((r) => r.name));
  return rows.map((r) => ({ ...r, img: imgs.get(r.name) ?? null })).sort((a, b) => a.unlockAt - b.unlockAt);
}
/**
 * Открытия кейсов на сайтах — отдельный итог: сколько потрачено на открытия и сколько стоит выпавшее
 * (что ещё лежит — по оценке Steam после комиссии; что продано — по записанным продажам).
 */
function caseOpenStats(allT: T.TradeRow[], allS: { trade_id: number; received_kop: number }[], lots: { platform: string; valueKop: number | null; openQty: number }[]): { count: number; spentKop: number; valueKop: number; soldKop: number; noPrice: number } | null {
  const mine = allT.filter((t) => t.buy_platform === 'caseopen');
  if (!mine.length) return null;
  const ids = new Set(mine.map((t) => t.id));
  const open = lots.filter((l) => l.platform === 'caseopen' && l.openQty > 0);
  return {
    count: mine.reduce((n, t) => n + t.quantity, 0),
    spentKop: mine.reduce((n, t) => n + t.buy_price_kop * t.quantity + t.buy_fee_kop, 0),
    valueKop: open.reduce((n, l) => n + (l.valueKop ?? 0), 0),
    soldKop: allS.filter((x) => ids.has(x.trade_id)).reduce((n, x) => n + x.received_kop, 0),
    noPrice: open.filter((l) => l.valueKop == null).length,
  };
}
/** Последняя проверка инвентаря: владельцу — подробности (кто проверял, что ответил Steam); всем — подтверждён ли «закрыт». */
async function invCheckInfo(d: D1Database, tid: number, isAdmin: boolean): Promise<{ privatePending: boolean; check?: unknown }> {
  const rows = (await d.prepare(`SELECT key, value FROM user_settings WHERE telegram_id = ? AND key IN ('inv_check', 'inv_private_at')`).bind(tid).all<{ key: string; value: string }>()).results;
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let check: unknown = null;
  try { check = kv.inv_check ? JSON.parse(kv.inv_check) : null; } catch { check = null; }
  return { privatePending: !!kv.inv_private_at, ...(isAdmin ? { check } : {}) };
}
/** Картинки предметов по названиям. */
export async function imagesFor(d: D1Database, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(names)].slice(0, 400);
  const parts = [];
  for (let i = 0; i < uniq.length; i += 90) {
    const p = uniq.slice(i, i + 90);
    parts.push(d.prepare(`SELECT name, url FROM item_images WHERE name IN (${p.map(() => '?').join(',')})`).bind(...p).all<{ name: string; url: string }>());
  }
  for (const r of await Promise.all(parts)) for (const x of r.results) out.set(x.name, x.url);
  return out;
}

/**
 * Запасной ориентир для подсказки, пока своя история Steam не накопилась:
 * 1) самое дешёвое на Skinport против медианы реальных продаж Skinport за 30 дней (или 7), если продаж хватает;
 * 2) самое дешёвое в Steam против медианы продаж Steam за сутки, если продаж за сутки от 10.
 */
function altReference(g: (src: string, t: string) => db.QuoteRow | undefined, sa?: SteamAvg | null): { curKop: number; refKop: number; where: string; basis: string; liquid?: boolean } | null {
  // Средние продажи Steam из открытого прайса (одна валюта — курс не искажает сравнение): сутки против месяца.
  // liquid: в прайсе есть продажи за последние сутки — значит, предмет покупают.
  if (sa?.d1 && sa.d30) return { curKop: sa.d1, refKop: sa.d30, where: 'в Steam (продажи за сутки)', basis: 'средней цены продаж в Steam за месяц', liquid: true };
  const spLow = g('skinport', 'lowest_listing');
  const m30 = g('skinport', 'sale_median_30d'), m7 = g('skinport', 'sale_median_7d');
  const ref = m30?.price_kop && (m30.volume ?? 0) >= 10 ? { q: m30, txt: 'средней цены продаж за месяц' }
    : m7?.price_kop && (m7.volume ?? 0) >= 5 ? { q: m7, txt: 'средней цены продаж за неделю' } : null;
  if (spLow?.price_kop && (spLow.quantity ?? 0) > 0 && ref) {
    return { curKop: spLow.price_kop, refKop: ref.q.price_kop!, where: 'на Skinport', basis: `${ref.txt} там (${ref.q.volume} шт.)` };
  }
  const low = g('steam', 'lowest_listing'), med = g('steam', 'median_24h');
  if (low?.price_kop && med?.price_kop && (med.volume ?? 0) >= 10) {
    return { curKop: low.price_kop, refKop: med.price_kop, where: 'в Steam', basis: `средней цены продаж за сутки (${med.volume} шт.)` };
  }
  return null;
}

/** Подсказка для предмета, который уже лежит в инвентаре (цена покупки неизвестна): продать сейчас или подержать. */
function ownedAdvice(sa: SteamAvg | undefined, now?: number): Advice | null {
  if (!sa?.d1 || !sa.d30) return null;
  if (now !== undefined && now - sa.updated_at > AVG_MAX_AGE_SEC) return null; // устаревшие средние — без совета
  const diff = Math.trunc(((sa.d1 - sa.d30) * 10000) / sa.d30);
  const p = `${Math.abs(Math.round(diff / 100))}%`;
  if (diff >= 800) return { action: 'sell', title: 'Хороший момент продать', reason: `За последние сутки в Steam продавали на ${p} дороже, чем в среднем за месяц.`, diffBp: diff };
  if (diff <= -800) return { action: 'hold', title: 'Держать', reason: `За последние сутки в Steam продавали на ${p} дешевле, чем в среднем за месяц — продавать невыгодно.`, diffBp: diff };
  return { action: 'hold', title: 'Обычная цена', reason: `Продажи за сутки — по обычной цене (${diff >= 0 ? '+' : '−'}${p} к средней за месяц). Продавать можно, но без выгоды.`, diffBp: diff };
}

export interface SteamAvg { item_id: number; d1: number | null; d7: number | null; d30: number | null; d90: number | null; updated_at: number }
async function steamAvgFor(d: D1Database, ids: number[]): Promise<Map<number, SteamAvg>> {
  return new Map((await chunkedAll(ids, async (p, ph) => (await d.prepare(`SELECT * FROM steam_avg WHERE item_id IN (${ph})`).bind(...p).all<SteamAvg>()).results)).map((r) => [r.item_id, r]));
}

async function adviceFor(d: D1Database, tid: number, now: number, items: { id: number; name: string }[]): Promise<Map<number, Advice>> {
  const out = new Map<number, Advice>();
  const ids = items.map((x) => x.id).slice(0, 360);
  if (!ids.length) return out;
  const [quotes, aggRows, deals, lots, s, avgs] = await Promise.all([
    quotesChunked(d, ids),
    chunkedAll(ids, async (p, ph) => (await d.prepare(`SELECT item_id, CAST(AVG(price_kop) AS INTEGER) AS avg, MIN(observed_at) AS first FROM price_snapshots
      WHERE source = 'steam' AND price_type = 'lowest_listing' AND price_kop IS NOT NULL AND observed_at >= ? AND item_id IN (${ph}) GROUP BY item_id`)
      .bind(now - 7 * 86400, ...p).all<{ item_id: number; avg: number | null; first: number }>()).results),
    db.activeSignals(d, 'spread', 90, now - 2 * 3600, { tid, minProfitKop: 0, minRoiBp: 0 }),
    T.openTrades(d, tid),
    db.getSettings(d, tid),
    steamAvgFor(d, ids),
  ]);
  const aggBy = new Map(aggRows.map((r) => [r.item_id, r]));
  for (const it of items) {
    // Аудит: совет «купить/продать» — только по свежим котировкам (Steam ≤ 6 ч, остальные ≤ 48 ч); старые не используем.
    const q = (quotes.get(it.id) ?? []).filter((x) => now - x.fetched_at <= (x.source === 'steam' ? LIVE_MAX_AGE_SEC : AVG_MAX_AGE_SEC));
    const g = (src: string, t: string) => q.find((x) => x.source === src && x.price_type === t);
    const a = aggBy.get(it.id);
    const deal = deals.find((x) => x.item_id === it.id && (x.state === 'confirmed' || x.state === 'notified'));
    const myLots = lots.filter((l) => l.item_id === it.id);
    const openQ = myLots.reduce((x, l) => x + openQty(l), 0);
    const cost = myLots.reduce((x, l) => x + viewLot(l, valuation(null, null, null)).openCostKop, 0);
    const p = parseMarketHashName(it.name);
    out.set(it.id, advise({
      steamLowKop: g('steam', 'lowest_listing')?.price_kop ?? null,
      avg7Kop: a?.avg ?? null,
      historyDays: a ? (now - a.first) / 86400 : 0,
      liquidity: classifyLiquidity({ steamSales24h: g('steam', 'median_24h')?.volume ?? null, skinportSales7d: g('skinport', 'sale_median_7d')?.volume ?? null, activeListings: null }).cls,
      uniquePriced: p.uniquePriced,
      deal: deal && deal.spread_kop !== null && deal.buy_kop !== null && deal.proceeds_kop !== null
        ? { spreadKop: deal.spread_kop, buyKop: deal.buy_kop, buySource: deal.buy_source ?? '', proceedsKop: deal.proceeds_kop, priority: deal.priority } : null,
      lot: openQ > 0 ? { openQty: openQ, costPerUnitKop: Math.round(cost / openQ), targetKop: myLots.find((l) => l.target_sell_kop)?.target_sell_kop ?? null } : null,
      minRoiBp: db.num(s.min_roi_bp), minProfitKop: db.num(s.min_profit_kop),
      alt: altReference(g, (() => { const a = avgs.get(it.id); return a && now - a.updated_at <= AVG_MAX_AGE_SEC ? a : undefined; })()),
    }));
  }
  return out;
}

/** Трейд-ссылка Steam: только адрес steamcommunity.com, партнёр и токен — иначе не принимаем. */
export const TRADE_URL_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d{1,12}&token=[A-Za-z0-9_-]{4,16}$/;
const TRADE_URL_HELP = 'https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url';
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const bad = (error: string, status = 400) => json({ ok: false, error }, status);

export async function handleAppApi(req: Request, env: Env, now: number, rawDb?: D1Database): Promise<Response> {
  const user = await verifyInitData(req.headers.get('X-Init-Data') ?? '', env.TELEGRAM_BOT_TOKEN, now);
  // Бот для всех: любой пользователь Telegram с правильной подписью. Владелец бота — ещё и технические экраны.
  if (!user) return bad('forbidden', 403);
  const d0 = budgetedDb(rawDb ?? env.DB, newBudget());
  await db.ensureUser(d0, user.id, user.id === Number(env.ADMIN_TELEGRAM_ID), now, guessCurrency(user.language_code));
  await d0.batch([...db.touchActiveStmts(d0, user.id, now, true), ...saveNameStmts(d0, user.id, user.username, user.first_name, now)]);
  const res = await appApi(req, env, now, user.id, rawDb);
  // Суммы в текстах (метки ⟦копейки⟧) — в валюте человека; саму валюту отдаём приложению в каждом ответе.
  if (!res.headers.get('Content-Type')?.startsWith('application/json')) return res;
  const rates = await loadRates(d0);
  const cur = await userCur(d0, user.id, rates);
  let text = renderMoney(await res.text(), cur);
  const adm = user.id === Number(env.ADMIN_TELEGRAM_ID) ? '"admin":true,' : '';
  // Курсы основных валют (грн за единицу) — чтобы вводить суммы в валюте сайта или кошелька Steam, а не только в валюте бота.
  const fx: Record<string, number> = { UAH: 1 };
  for (const c of ['USD', 'EUR', 'PLN', 'RUB', 'KZT', cur.code]) if (rates[c]) fx[c] = rates[c];
  if (text.startsWith('{')) text = `{"cur":${JSON.stringify(cur)},"fx":${JSON.stringify(fx)},${adm}` + (text.length > 2 ? text.slice(1) : '}');
  return new Response(text, { status: res.status, headers: res.headers });
}

/**
 * Записать продажу (или «выставлено») одного предмета: сначала из записанных покупок по порядку,
 * остальное — новой записью с ценой покупки (0 — выпал). Суммы — за 1 шт., в копейках бота.
 */
async function recordSaleRow(d: D1Database, tid: number, r: { itemId: number; name: string; maxQty: number; qty: unknown; receivedKop: unknown; platform: unknown; buyKop: unknown; pending: boolean; note: string },
  wallet: { per: number }, date: string, now: number): Promise<{ resultKop: number; recorded: boolean; recordedQty: number; error?: string }> {
  const qty = Math.trunc(Number(r.qty));
  const got = Number(r.receivedKop); // получено за 1 шт. (на баланс сайта / кошелька Steam)
  const platform = String(r.platform ?? '');
  if (!(PLATFORMS as readonly string[]).includes(platform) || BUY_ONLY.includes(platform)) return { resultKop: 0, recorded: false, recordedQty: 0, error: `${r.name}: выбери, где продал` };
  if (!Number.isInteger(qty) || qty < 1 || qty > r.maxQty) return { resultKop: 0, recorded: false, recordedQty: 0, error: `${r.name}: количество от 1 до ${r.maxQty}` };
  if (!Number.isSafeInteger(got) || got <= 0) return { resultKop: 0, recorded: false, recordedQty: 0, error: `${r.name}: впиши, сколько получил` };
  const sellPrice = platform === 'steam' ? steamListForNetKop(got, wallet) : got;
  let left = qty, resultKop = 0;
  const sale = (tradeId: number, q: number) => (r.pending
    ? T.addPending(d, tid, { tradeId, quantity: q, sellPriceKop: sellPrice, receivedKop: got * q, platform, now })
    : T.addSale(d, tid, { tradeId, quantity: q, sellPriceKop: sellPrice, receivedKop: got * q, platform, sellDate: date, now }));
  try {
    const pq = await T.pendingByTrade(d, tid);
    for (const l of (await T.openTrades(d, tid)).filter((x) => x.item_id === r.itemId).sort((a, b) => a.id - b.id)) {
      if (!left) break;
      const q = Math.min(left, l.quantity - l.sold_quantity - (pq.get(l.id) ?? 0));
      if (q <= 0) continue;
      resultKop += got * q - (await sale(l.id, q)).costKop;
      left -= q;
    }
    if (left) {
      const buy = Number(r.buyKop);
      if (r.buyKop === null || r.buyKop === undefined || r.buyKop === '' || !Number.isSafeInteger(buy) || buy < 0) {
        return { resultKop, recorded: left < qty, recordedQty: qty - left, error: `${r.name}: впиши, за сколько покупал (0 — если выпал)` };
      }
      const id = await T.addTrade(d, { tid, itemId: r.itemId, signalId: null, quantity: left, buyPriceKop: buy, buyFeeKop: 0, platform: buy === 0 ? 'gift' : 'other', buyDate: date, note: r.note, now });
      resultKop += got * left - (await sale(id, left)).costKop;
    }
  } catch (e) {
    // Часть штук могла уже записаться (по первым лотам) — сообщаем, сколько, чтобы повтор не записал их второй раз.
    return { resultKop, recorded: left < qty, recordedQty: qty - left, error: `${r.name}: ${(e as Error).message}` };
  }
  return { resultKop, recorded: true, recordedQty: qty };
}

async function appApi(req: Request, env: Env, now: number, tid: number, rawDb?: D1Database): Promise<Response> {
  const isAdmin = tid === Number(env.ADMIN_TELEGRAM_ID);
  const userDeals = async (limit: number, order: 'spread' | 'roi' | 'priority' = 'spread') => {
    const s = await db.getSettings(d, tid);
    return db.activeSignals(d, order, limit, now - 2 * 3600, { tid, minProfitKop: db.num(s.min_profit_kop), minRoiBp: db.num(s.min_roi_bp) });
  };
  const budget = newBudget();
  const d = budgetedDb(rawDb ?? env.DB, budget);
  const memo = memoFor((rawDb ?? env.DB) as object);
  // Запас запросов к базе на одну строку продажи (несколько лотов, новая запись покупки) — чтобы не оборваться посередине.
  const ROW_D1 = 20;
  // Валюта кошелька Steam = валюта, выбранная в боте (минимальные комиссии Steam считаются в ней).
  let walletP: Promise<{ per: number; code: string }> | null = null;
  const walletCur = () => (walletP ??= loadRates(d).then((r) => userCur(d, tid, r)));
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/app\/api\//, '');
  const seg = path.split('/');
  const method = req.method;
  let body: Record<string, unknown> = {};
  if (method === 'POST') {
    const t = await req.text();
    if (t.length > 16_000) return bad('too_large', 413);
    try { body = t ? JSON.parse(t) : {}; } catch { return bad('bad_json'); }
  }
  try {
    // «Разгон баланса» — только владельцу, пока симуляция бота не подтвердила схему.
    if (seg[0] === 'rally' && !isAdmin && !(await rallyProven(d))) return bad('«Разгон баланса» пока проверяется ботом — откроется, когда схема подтвердится');
    // Бегущая строка (обновляется раз в 3 минуты, пока приложение открыто) — лёгкая версия сводки: идеи, состояние, топ поддержки.
    if (path === 'ticker' && method === 'GET') {
      const [sources, jobs, recs, donors] = await Promise.all([db.listSourceStatus(d), listJobs(d), recsFor(d, tid, now, memo), topDonors(d, 10)]);
      const lastRun = Math.max(0, ...jobs.map((j) => j.last_run_at ?? 0));
      return json({
        ok: true, cronAlive: lastRun > 0 && now - lastRun < 300, donors,
        sources: sources.map((s) => ({ source: s.source, status: s.status, lastOk: s.last_ok_at, error: null })),
        recs: { fetchedAt: recs.fetchedAt, deals: await (async () => { const top = recs.deals.slice(0, 6); const im = top.length ? await imagesFor(d, top.map((x) => x.name)) : new Map<string, string>(); return top.map((x) => ({ ...x, img: im.get(x.name) ?? null })); })(), trends: [], total: recs.deals.length + recs.trends.length, hidden: recs.hidden.length },
      });
    }
    // ---------- Сводка ----------
    if (path === 'summary' && method === 'GET') {
      const [sources, watched, deals, lots, jobs] = await Promise.all([
        db.listSourceStatus(d), watchedCountCached(d, memo, now), userDeals(5), T.openTrades(d, tid), listJobs(d),
      ]);
      const quotes = await quotesChunked(d, [...new Set(lots.map((l) => l.item_id))].slice(0, 360));
      let cost = 0, value = 0, unknown = 0;
      for (const l of lots) {
        const q = quotes.get(l.item_id) ?? [];
        const g = (s: string, t: string) => q.find((x) => x.source === s && x.price_type === t)?.price_kop ?? null;
        const v = viewLot(l, valuation(g('steam', 'lowest_listing'), g('steam', 'median_24h'), null));
        if (v.steamValueKop === null) unknown++; else { value += v.steamValueKop; cost += v.openCostKop; }
      }
      const trades = await T.allTrades(d, tid);
      const sales = T.salesWithCost(trades, await T.salesFor(d, tid));
      const today = warsawDate(now);
      const todays = sales.filter((s) => s.sell_date === today);
      const lastRun = Math.max(0, ...jobs.map((j) => j.last_run_at ?? 0));
      const wl = await db.listWatch(d, tid);
      const adv = await adviceFor(d, tid, now, wl.map((w) => ({ id: w.item_id, name: w.market_hash_name })));
      const imgs = await imagesFor(d, wl.map((w) => w.market_hash_name));
      const actions = wl.map((w) => ({ itemId: w.item_id, name: w.market_hash_name, category: w.category, advice: adv.get(w.item_id)!, img: imgs.get(w.market_hash_name) ?? null }))
        .filter((x) => x.advice && (x.advice.action === 'buy' || x.advice.action === 'sell'))
        .sort((a, b) => ACTION_RANK[a.advice.action] - ACTION_RANK[b.advice.action]).slice(0, 8);
      const st = await db.getSettings(d, tid);
      const bal = await steamBalanceFor(d, tid, st, now);
      const [recs, su] = await Promise.all([recsFor(d, tid, now, memo, { st, bal }),
        d.prepare('SELECT steam_id, steam_vanity, inv_status FROM users WHERE telegram_id = ?').bind(tid).first<{ steam_id: string | null; steam_vanity: string | null; inv_status: string | null }>()]);
      const myWatch = wl.length;
      return json({
        setup: st.setup_hidden === '1' ? null : {
          currencyOk: st.currency_ok === '1', notify: st.notify_enabled === '1', watched: myWatch,
          steam: su?.steam_id || su?.steam_vanity ? (su.inv_status === 'private' ? 'private' : 'ok') : 'none',
        },
        notify: {
          enabled: st.notify_enabled === '1', maxPerHour: db.num(st.max_per_hour) || 6, quietStart: db.num(st.quiet_start), quietEnd: db.num(st.quiet_end),
          daily: st.daily_report === '1', dailyHour: db.num(st.daily_hour), watched,
        },
        ok: true, now, watched, actions, rallyOk: isAdmin || await rallyProven(d), channelUrl: await getMeta(d, 'channel_url'), botUser: await botUsername(d, new TelegramClient(env.TELEGRAM_BOT_TOKEN)),
        rally: st.rally_on === '1' ? await (async () => {
          const rs = await rallySettingsFor(d, tid);
          const tr = (await d.prepare("SELECT * FROM rally_trades WHERE telegram_id = ? AND mode = 'real'").bind(tid).all<RallyTrade>()).results;
          const c = capital(tr, rs, 'real', now);
          return { balanceKop: c.balanceKop, availableKop: c.availableKop, reserveKop: rs.reserveKop, realizedKop: c.realizedKop, openCount: c.openCount, maxPositions: rs.maxPositions };
        })() : null,
        recs: { fetchedAt: recs.fetchedAt, deals: await (async () => { const top = recs.deals.slice(0, 6); const im = top.length ? await imagesFor(d, top.map((x) => x.name)) : new Map<string, string>(); return top.map((x) => ({ ...x, img: im.get(x.name) ?? null })); })(), trends: recs.trends.slice(0, 2), total: recs.deals.length + recs.trends.length, hidden: recs.hidden.length },
        sites: sitesFor(await loadRefLinks(d)),
        donors: await topDonors(d, 10),
        cronAlive: lastRun > 0 && now - lastRun < 300,
        sources: sources.map((s) => ({ source: s.source, status: s.status, lastOk: s.last_ok_at, error: s.status !== 'ok' ? s.last_error ?? s.disabled_reason : null })),
        deals: deals.map(dealDto),
        inventory: { lots: lots.length, costKop: cost, valueKop: value, unknown },
        ...balanceDto(bal, st), steamLinked: !!(su?.steam_id || su?.steam_vanity),
        today: {
          steamKop: todays.filter((s) => s.wallet === 'steam_wallet').reduce((x, s) => x + s.received_kop - s.costKop, 0),
          cashKop: todays.filter((s) => s.wallet !== 'steam_wallet').reduce((x, s) => x + s.received_kop - s.costKop, 0),
          sales: todays.length,
        },
        lastPriceAt: Math.max(0, ...sources.filter((s) => s.source === 'steam' || s.source === 'skinport').map((s) => s.last_ok_at ?? 0)) || null,
      });
    }

    // Баланс кошелька Steam — вписывается вручную (бот не входит в аккаунт). null/пусто — убрать.
    // Шапка приложения: баланс виден на каждой вкладке.
    if (path === 'steam-balance' && method === 'GET') {
      const st = await db.getSettings(d, tid);
      return json({ ok: true, ...balanceDto(await steamBalanceFor(d, tid, st, now), st) });
    }
    // kop — новая сумма (в копейках бота; хранится в валюте кошелька Steam = валюта бота), null — убрать; byBalance — галочка.
    if (path === 'steam-balance' && method === 'POST') {
      const writes: D1PreparedStatement[] = [];
      if ('kop' in body) {
        const v = body.kop;
        if (v === null || v === '') {
          writes.push(d.prepare(`DELETE FROM user_settings WHERE telegram_id = ? AND key IN ('steam_balance_kop', 'steam_balance_at', 'steam_balance_cur')`).bind(tid));
        } else {
          const k = Number(v);
          if (!Number.isSafeInteger(k) || k < 0 || k > 1e11) return bad('Неверная сумма');
          const w = await walletCur();
          const minor = w.code === 'UAH' ? k : Math.round(k / w.per);
          writes.push(db.setSettingStmt(d, tid, 'steam_balance_kop', String(minor), now), db.setSettingStmt(d, tid, 'steam_balance_at', String(now), now),
            db.setSettingStmt(d, tid, 'steam_balance_cur', w.code, now));
        }
      }
      if (typeof body.byBalance === 'boolean') writes.push(db.setSettingStmt(d, tid, 'recs_by_balance', body.byBalance ? '1' : '0', now));
      if (!writes.length) return bad('Нечего менять');
      await d.batch(writes);
      const st = await db.getSettings(d, tid);
      return json({ ok: true, ...balanceDto(await steamBalanceFor(d, tid, st, now), st) });
    }

    // ---------- Steam: вход (только SteamID) и открытый инвентарь ----------
    if (path === 'steam' && method === 'GET') {
      const u = await d.prepare('SELECT steam_id, steam_vanity, steam_verified, inv_requested_at, inv_synced_at, inv_status FROM users WHERE telegram_id = ?').bind(tid)
        .first<{ steam_id: string | null; steam_vanity: string | null; steam_verified: number; inv_requested_at: number | null; inv_synced_at: number | null; inv_status: string | null }>();
      const linked = !!(u?.steam_id || u?.steam_vanity);
      const rows = linked ? (await d.prepare(`SELECT v.item_id, v.qty, v.marketable, v.tradable, v.details, i.market_hash_name AS name, i.category FROM steam_inventory v JOIN items i ON i.id = v.item_id
        WHERE v.telegram_id = ? LIMIT 500`).bind(tid).all<{ item_id: number; qty: number; marketable: number; tradable: number; details: string | null; name: string; category: string }>()).results : [];
      const ids = rows.map((r) => r.item_id);
      const [avgs, quotes, imgs, fxm, alerts, wallet, costs] = await Promise.all([steamAvgFor(d, ids), quotesChunked(d, ids.slice(0, 360)), imagesFor(d, rows.map((r) => r.name)), db.loadLatestFx(d),
        d.prepare('SELECT item_id, target_kop FROM sell_alerts WHERE telegram_id = ? AND notified_at IS NULL').bind(tid).all<{ item_id: number; target_kop: number }>(),
        walletCur(),
        // Стоимость приобретения (приоритет 5): из записанных покупок, средняя за 1 шт. по открытым позициям.
        d.prepare(`SELECT item_id, SUM((quantity - sold_quantity) * buy_price_kop + buy_fee_kop * (quantity - sold_quantity) / quantity) AS cost, SUM(quantity - sold_quantity) AS q
          FROM trades WHERE telegram_id = ? AND quantity > sold_quantity GROUP BY item_id`).bind(tid).all<{ item_id: number; cost: number; q: number }>()]);
      const targets = new Map(alerts.results.map((a) => [a.item_id, a.target_kop]));
      const unitCost = new Map(costs.results.map((c) => [c.item_id, c.q > 0 ? Math.round(c.cost / c.q) : null]));
      const usd = fxm.get('USD') ?? null;
      let total = 0, totalNet = 0, noData = 0;
      const evs = new Map(rows.map((r) => [r.item_id, steamEvidence(quotes.get(r.item_id) ?? [], avgs.get(r.item_id), usd, now)]));
      const siteKop = await siteKopFor(d, rows.filter((r) => { const e = evs.get(r.item_id)!; return !e.listing && !e.median24h && e.avg; }).map((r) => r.name), usd, now);
      const items = rows.map((r) => {
        const ev = evs.get(r.item_id)!;
        const val = marketValue(ev, siteKop.get(r.name));
        const est = val?.kop ?? null;
        const live = ev.listing;
        const sa = avgs.get(r.item_id);
        const net = est ? steamNetKop(Math.max(3, est), wallet) : null;
        if (est && r.marketable) { total += est * r.qty; totalNet += (net ?? 0) * r.qty; } else if (r.marketable) noData++;
        const cost = unitCost.get(r.item_id) ?? null;
        let assets: AssetDetail[] = [];
        try { assets = r.details ? JSON.parse(r.details) as AssetDetail[] : []; } catch { assets = []; }
        const k = (u: number | null) => (u && usd ? toKop(Math.round(u * 100), 'USD', usd) : null);
        const pattern = parseMarketHashName(r.name).uniquePriced;
        const details = assets.map((a) => ({
          float: a.float, floatNote: floatNote(r.name, a.float), seed: a.seed, phase: a.phase, phaseKop: k(a.phaseUsd),
          stickers: a.stickers.map((s) => ({ name: s.name, wear: s.wear, kop: k(s.usd) })), charms: a.charms.map((s) => ({ name: s.name, pattern: s.pattern, kop: k(s.usd) })),
          stickersKop: a.stickers.reduce((x, s) => x + (k(s.usd) ?? 0), 0) + a.charms.reduce((x, s) => x + (k(s.usd) ?? 0), 0),
        }));
        const flags: string[] = [];
        if (details.some((x) => x.phase)) flags.push('фаза ' + [...new Set(details.map((x) => x.phase).filter(Boolean))].join(', '));
        if (details.some((x) => x.stickers.length || x.charms.length)) flags.push('есть наклейки/брелки');
        if (details.some((x) => x.floatNote && /низкий/.test(x.floatNote))) flags.push('низкий float');
        if (pattern) flags.push('цена зависит от паттерна');
        return {
          details, flags, pattern,
          itemId: r.item_id, name: r.name, category: r.category, categoryRu: CATEGORY_RU[r.category as 'case'] ?? r.category, qty: r.qty, marketable: !!r.marketable,
          img: imgs.get(r.name) ?? null, priceKop: est, live: !!live, basis: val?.basis ?? null, status: ev.status, targetKop: targets.get(r.item_id) ?? null, netKop: net,
          advice: r.marketable ? ownedAdvice(sa, now) : null,
          prices: { listing: ev.listing, buyOrder: ev.buyOrder, median24h: ev.median24h, avg: ev.avg },
          // Приоритет 5: рыночная стоимость / после комиссии / себестоимость / потенциальная (не фактическая) прибыль.
          costKop: cost, potentialKop: cost != null && net != null ? net - cost : null,
        };
      }).sort((a, b) => (b.priceKop ?? 0) * b.qty - (a.priceKop ?? 0) * a.qty);
      return json({
        ok: true, linked, steamLinked: linked, steamId: u?.steam_id ?? null, vanity: u?.steam_vanity ?? null, verified: !!u?.steam_verified,
        status: u?.inv_status ?? null, syncedAt: u?.inv_synced_at ?? null, requestedAt: u?.inv_requested_at ?? null,
        // Steam отказал (не отдаёт / «закрыт» ещё не подтверждён) — не «загружаю», а честный текст статуса.
        pending: !!(linked && u?.inv_requested_at && (!u.inv_synced_at || u.inv_requested_at > u.inv_synced_at) && !['blocked', 'private', 'not_found'].includes(u.inv_status ?? '')),
        goneCount: linked ? ((await d.prepare(`SELECT COUNT(*) AS n FROM inv_gone WHERE telegram_id = ? AND status = 'new'`).bind(tid).first<{ n: number }>())?.n ?? 0) : 0,
        history: linked ? await invHistory(d, tid, usd) : null,
        totalKop: total, totalNetKop: totalNet, noDataCount: noData, items, bot: await getMeta(d, 'bot_username'),
        locked: linked ? await lockedLots(d, tid, now) : [],
        ...(await invCheckInfo(d, tid, isAdmin)),
      });
    }
    if (path === 'steam/login' && method === 'POST') {
      const nonce = newNonce();
      await d.prepare('INSERT INTO steam_login (nonce, telegram_id, created_at) VALUES (?, ?, ?)').bind(nonce, tid, now).run();
      return json({ ok: true, url: steamLoginUrl(url.origin, nonce) });
    }
    if (path === 'steam/profile' && method === 'POST') {
      const p = parseSteamProfile(String(body.text ?? '').slice(0, 200));
      if (!p) return bad('Не понял ссылку. Пример: https://steamcommunity.com/profiles/7656119… или https://steamcommunity.com/id/имя');
      await d.prepare('UPDATE users SET steam_id = ?, steam_vanity = ?, steam_verified = 0, inv_requested_at = ?, inv_synced_at = NULL, inv_status = NULL WHERE telegram_id = ?')
        .bind(p.id ?? null, p.vanity ?? null, now, tid).run();
      return json({ ok: true });
    }
    if (path === 'steam/refresh' && method === 'POST') {
      const u = await d.prepare('SELECT inv_requested_at, inv_synced_at, inv_status FROM users WHERE telegram_id = ?').bind(tid).first<{ inv_requested_at: number | null; inv_synced_at: number | null; inv_status: string | null }>();
      if (body.auto === true) {
        // Сама перепроверка при открытии «Моих скинов», если висит отказ Steam (закрыт / не отдаёт): не чаще раза в 10 минут.
        if (!['private', 'blocked', 'not_found', 'rate_limited'].includes(u?.inv_status ?? '')) return json({ ok: true, updated: false });
        const chk = await d.prepare(`SELECT value FROM user_settings WHERE telegram_id = ? AND key = 'inv_check'`).bind(tid).first<{ value: string }>();
        let at = 0; try { at = Number(JSON.parse(chk?.value ?? '{}').at) || 0; } catch { at = 0; }
        if (now - at < 10 * 60) return json({ ok: true, updated: false });
      } else {
        const last = Math.max(u?.inv_requested_at ?? 0, u?.inv_synced_at ?? 0);
        if (now - last < 15 * 60) return bad(`Обновлять можно раз в 15 минут — попробуй через ${Math.ceil((15 * 60 - (now - last)) / 60)} мин.`);
      }
      await d.prepare('UPDATE users SET inv_requested_at = ? WHERE telegram_id = ?').bind(now, tid).run();
      // Сначала — сами, из Worker (сборщику на GitHub Steam часто отвечает 429). Не вышло — очередь сборщика.
      const su = await d.prepare('SELECT steam_id, steam_vanity FROM users WHERE telegram_id = ?').bind(tid).first<{ steam_id: string | null; steam_vanity: string | null }>();
      if (su?.steam_id || su?.steam_vanity) {
        let res: InvFetch;
        try { res = await fetchInventory(fetch, su.steam_id, su.steam_vanity); } catch { res = { status: 'error', steamId: null }; }
        await db.counterStmt(d, `inv_direct_${res.status}`, 1, now).run().catch(() => undefined);
        if (res.status !== 'rate_limited' && res.status !== 'error') {
          await storeInventory(d, tid, res, now);
          const gone = (await d.prepare(`SELECT COUNT(*) AS n FROM inv_gone WHERE telegram_id = ? AND status = 'new'`).bind(tid).first<{ n: number }>())?.n ?? 0;
          return json({ ok: true, updated: res.status === 'ok', gone, msg: res.status === 'ok' ? `✅ Инвентарь обновлён: ${res.items.length} предм.`
            : res.status === 'blocked' ? '⏳ Steam временно не отдаёт инвентарь серверу бота — твои настройки в порядке. Попробую сам, пока покажу последний сохранённый.'
            : res.status === 'private' ? '🔒 Steam пишет, что инвентарь закрыт. Проверь приватность: «Мой профиль» и «Инвентарь» — «Открытый»; Steam применяет изменения до нескольких минут.'
            : 'Профиль Steam не найден — проверь ссылку.' });
        }
      }
      // Steam ограничил запросы сервера — честно говорим, когда примерно обновится.
      const pause = Number(await getMeta(d, 'steam_pause_until')) || 0;
      const agentRaw = await getMeta(d, 'agent_at');
      const agent = (() => { try { return Number(JSON.parse(agentRaw ?? '{}').at) || 0; } catch { return 0; } })();
      const msg = pause > now && now - agent > 30 * 60
        ? `Steam сейчас ограничил запросы бота — инвентарь обновится примерно через ${Math.max(10, Math.ceil((pause - now) / 60) + 10)} мин.`
        : 'Обновлю в течение ~10 минут';
      return json({ ok: true, msg });
    }
    if (path === 'steam/unlink' && method === 'POST') {
      await d.batch([
        d.prepare('UPDATE users SET steam_id = NULL, steam_vanity = NULL, steam_verified = 0, inv_requested_at = NULL, inv_synced_at = NULL, inv_status = NULL WHERE telegram_id = ?').bind(tid),
        d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid),
      ]);
      return json({ ok: true });
    }

    // ---------- Рекомендации по всему рынку ----------
    if (path === 'recs' && method === 'GET') {
      return json({ ok: true, ...(await recsFor(d, tid, now, memo)) });
    }

    // ---------- Сделки ----------
    if (path === 'deals' && method === 'GET') {
      const order = url.searchParams.get('order') === 'roi' ? 'roi' : url.searchParams.get('order') === 'priority' ? 'priority' : 'spread';
      const rows = await userDeals(60, order);
      return json({ ok: true, deals: rows.map(dealDto) });
    }
    if (seg[0] === 'deals' && seg[2] === 'hide' && method === 'POST') {
      await db.hideSignal(d, tid, Number(seg[1]), now);
      return json({ ok: true });
    }

    // ---------- Поиск и наблюдение ----------
    if (path === 'search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 80);
      const cat = await catalogInfo(d);
      const results = q.length >= 2 ? await searchCatalog(d, q, 20) : [];
      return json({ ok: true, results, images: Object.fromEntries(await imagesFor(d, results)), catalog: cat });
    }
    // Карточка скина из поиска во вкладке «Цены»: id предмета по точному названию из каталога (новый — создаётся, только если он есть в каталоге).
    if (path === 'item-id' && method === 'GET') {
      const name = (url.searchParams.get('name') ?? '').trim().slice(0, 200);
      if (name.length < 3) return bad('Нет названия');
      const known = await d.prepare('SELECT id FROM items WHERE market_hash_name = ?').bind(name).first<{ id: number }>();
      if (known) return json({ ok: true, id: known.id });
      if (!(await catalogHas(d, name))) return bad('Такого предмета нет в каталоге');
      return json({ ok: true, id: (await db.upsertItem(d, name, now)).id });
    }
    if (path === 'watch' && method === 'GET') {
      const w = await db.listWatch(d, tid);
      const ids = w.map((x) => x.item_id).slice(0, 360);
      const [quotes, histAll, adv, imgs] = await Promise.all([
        quotesChunked(d, ids),
        chunkedAll(ids, async (p, ph) => (await d.prepare(
          `SELECT item_id, observed_at, price_minor FROM price_snapshots WHERE source = 'steam' AND price_type = 'lowest_listing'
           AND observed_at BETWEEN ? AND ? AND item_id IN (${ph}) ORDER BY observed_at`,
        ).bind(now - 30 * 3600, now - 20 * 3600, ...p).all<{ item_id: number; observed_at: number; price_minor: number | null }>()).results),
        adviceFor(d, tid, now, w.map((x) => ({ id: x.item_id, name: x.market_hash_name }))),
        imagesFor(d, w.map((x) => x.market_hash_name)),
      ]);
      const [avgsW, fxW] = await Promise.all([steamAvgFor(d, ids), db.loadLatestFx(d)]);
      const usdW = fxW.get('USD') ?? null;
      const histBy = new Map<number, typeof histAll>();
      for (const h of histAll) { const l = histBy.get(h.item_id) ?? []; l.push(h); histBy.set(h.item_id, l); }
      return json({
        ok: true, limit: isAdmin ? null : WATCH_LIMIT, own: w.filter((x) => x.source !== 'inventory').length,
        items: w.map((x) => {
          const q = quotes.get(x.item_id) ?? [];
          const g = (s: string, t: string) => q.find((y) => y.source === s && y.price_type === t);
          const low = g('steam', 'lowest_listing');
          const hist = histBy.get(x.item_id) ?? [];
          const ref = [...hist].reverse().find((hh) => hh.observed_at <= now - 24 * 3600) ?? hist[0];
          const ch = ref?.price_minor && low?.price_minor ? Math.trunc(((low.price_minor - ref.price_minor) * 10000) / ref.price_minor) : null;
          return {
            watchId: x.id, itemId: x.item_id, name: x.market_hash_name, category: x.category, source: x.source, categoryRu: CATEGORY_RU[x.category as 'case'] ?? x.category,
            steamLowKop: low?.price_kop ?? null, steamMedKop: g('steam', 'median_24h')?.price_kop ?? null, sales24h: g('steam', 'median_24h')?.volume ?? null,
            skinportKop: g('skinport', 'lowest_listing')?.price_kop ?? null, skinportQty: g('skinport', 'lowest_listing')?.quantity ?? null,
            change24hBp: ch, targetKop: x.target_buy_kop, updatedAt: low?.fetched_at ?? null, advice: adv.get(x.item_id) ?? null, img: imgs.get(x.market_hash_name) ?? null,
            steamAvgKop: (() => { const a = avgsW.get(x.item_id); const c = a?.d7 ?? a?.d30 ?? null; return c && usdW ? toKop(c, 'USD', usdW) : null; })(),
          };
        }),
      });
    }
    if ((path === 'watch' || path === 'watch/delete' || seg[0] === 'watch') && method !== 'GET') memo.watched = null; // список изменился — счётчик пересчитаем
    if (path === 'watch' && method === 'POST') {
      const names = (Array.isArray(body.names) ? body.names : [body.name]).filter((n): n is string => typeof n === 'string' && n.trim().length >= 3).map((n) => n.trim()).slice(0, 60);
      if (!names.length) return bad('name_required');
      if (!isAdmin) {
        const have = await db.countUserWatch(d, tid);
        if (have + names.length > WATCH_LIMIT) {
          return bad(have >= WATCH_LIMIT
            ? `Лимит — ${WATCH_LIMIT} предметов на человека. Удали ненужные («✏️ Изменить список»), чтобы добавить новые.`
            : `Можно добавить ещё ${WATCH_LIMIT - have} (лимит — ${WATCH_LIMIT} предметов на человека).`);
        }
      }
      const stmts: D1PreparedStatement[] = [];
      for (const n of names) {
        stmts.push(...db.upsertItemStmts(d, n, now));
        stmts.push(d.prepare(`INSERT INTO watchlist (telegram_id, item_id, created_at) SELECT ?, id, ? FROM items WHERE market_hash_name = ?
          ON CONFLICT(telegram_id, item_id) DO UPDATE SET active = 1`).bind(tid, now, parseMarketHashName(n).marketHashName));
      }
      for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
      return json({ ok: true, added: names.length });
    }
    if (path === 'watch/delete' && method === 'POST') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0).slice(0, 400);
      if (!ids.length) return bad('ids_required');
      const stmts: D1PreparedStatement[] = [];
      for (let i = 0; i < ids.length; i += 90) {
        const p = ids.slice(i, i + 90);
        stmts.push(d.prepare(`UPDATE watchlist SET active = 0 WHERE telegram_id = ? AND id IN (${p.map(() => '?').join(',')})`).bind(tid, ...p));
      }
      await d.batch(stmts);
      return json({ ok: true, removed: ids.length });
    }
    if (seg[0] === 'watch' && seg[1] && !seg[2] && method === 'DELETE') {
      await db.removeWatch(d, tid, Number(seg[1]));
      return json({ ok: true });
    }
    if (seg[0] === 'watch' && seg[2] === 'target' && method === 'POST') {
      const kop = body.kop === null ? null : Number(body.kop);
      if (kop !== null && (!Number.isSafeInteger(kop) || kop <= 0)) return bad('bad_price');
      await db.setWatchTarget(d, tid, Number(seg[1]), kop);
      return json({ ok: true });
    }

    // ---------- Карточка предмета ----------
    if (seg[0] === 'item' && seg[1] && method === 'GET') {
      // item/name?n=… — окно любого скина открывается по названию (в рекомендациях, продажах, симуляции id нет).
      const byName = seg[1] === 'name' ? (url.searchParams.get('n') ?? '').slice(0, 200) : null;
      const itemId = byName !== null ? ((await d.prepare('SELECT id FROM items WHERE market_hash_name = ?').bind(byName).first<{ id: number }>())?.id ?? 0) : Number(seg[1]);
      const item = itemId ? await db.getItem(d, itemId) : null;
      if (!item) {
        // Предмет бот ещё не отслеживает — истории нет; честный пустой ответ, а не ошибка.
        if (byName !== null) return json({ ok: true, item: null, series: {}, sitesSince: null, avg7Kop: null, days: 7 });
        return bad('not_found', 404);
      }
      await d.prepare('INSERT INTO item_views (item_id, at) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET at = excluded.at').bind(itemId, now).run();
      const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
      const [quotes, rows, s] = await Promise.all([
        db.getQuotes(d, itemId),
        d.prepare(`SELECT source, price_type, observed_at, price_kop FROM price_snapshots WHERE item_id = ? AND observed_at >= ?
          AND ((source = 'steam' AND price_type IN ('lowest_listing','median_24h')) OR (source = 'skinport' AND price_type = 'lowest_listing'))
          ORDER BY observed_at DESC LIMIT 3000`).bind(itemId, now - days * 86400).all<{ source: string; price_type: string; observed_at: number; price_kop: number | null }>(),
        db.getSettings(d, tid),
      ]);
      const g = (src: string, t: string) => quotes.find((x) => x.source === src && x.price_type === t) ?? null;
      const ser = (src: string, t: string) => rows.results.filter((r) => r.source === src && r.price_type === t).map((r) => ({ t: r.observed_at, v: r.price_kop })).reverse();
      const p = parseMarketHashName(item.market_hash_name);
      const liq = classifyLiquidity({ steamSales24h: g('steam', 'median_24h')?.volume ?? null, skinportSales7d: g('skinport', 'sale_median_7d')?.volume ?? null, activeListings: null });
      const st = stats(ser('steam', 'lowest_listing').map((x) => ({ at: x.t, minor: x.v, currency: 'UAH', volume: null })));
      const watch = (await db.listWatch(d, tid)).find((w) => w.item_id === itemId) ?? null;
      const bt = backtest(ser('skinport', 'lowest_listing'), ser('steam', 'lowest_listing'), ser('steam', 'median_24h'), {
        minProfitKop: db.num(s.min_profit_kop), minRoiBp: db.num(s.min_roi_bp), horizonSec: 86400, maxAgeSec: 2 * 3600, cooldownSec: 6 * 3600,
      });
      const advice = (await adviceFor(d, tid, now, [{ id: item.id, name: item.market_hash_name }])).get(item.id) ?? null;
      const avg7 = (await d.prepare(`SELECT CAST(AVG(price_kop) AS INTEGER) AS a FROM price_snapshots WHERE item_id = ? AND source = 'steam'
        AND price_type = 'lowest_listing' AND price_kop IS NOT NULL AND observed_at >= ?`).bind(itemId, now - 7 * 86400).first<{ a: number | null }>())?.a ?? null;
      const sa = (await steamAvgFor(d, [itemId])).get(itemId) ?? null;
      const usd = (await db.loadLatestFx(d)).get('USD') ?? null;
      const conv = (c: number | null) => (c && usd ? toKop(c, 'USD', usd) : null);
      const steamAvg = sa && (sa.d1 || sa.d7 || sa.d30) ? { d1: conv(sa.d1), d7: conv(sa.d7), d30: conv(sa.d30), d90: conv(sa.d90), at: sa.updated_at } : null;
      // Цены на других площадках — суточные точки с момента, как бот начал их копить (раньше истории нет, не выдумываем).
      const siteRows = (await d.prepare('SELECT day, json FROM site_price_daily WHERE item_id = ? AND day >= ? ORDER BY day LIMIT 100').bind(itemId, new Date((now - days * 86400) * 1000).toISOString().slice(0, 10)).all<{ day: string; json: string }>()).results;
      const siteSeries: Record<string, { t: number; v: number }[]> = {};
      for (const r of siteRows) {
        let o: Record<string, number> = {};
        try { o = JSON.parse(r.json); } catch { continue; }
        for (const key of ['csgomarket', 'waxpeer', 'lisskins', 'csfloat', 'steamavg']) {
          const v = o[key] && usd ? toKop(o[key]!, 'USD', usd) : null;
          if (v) (siteSeries[key] ??= []).push({ t: Math.floor(Date.parse(r.day + 'T12:00:00Z') / 1000), v });
        }
      }
      const sitesSince = siteRows[0]?.day ?? null;
      const q = (r: db.QuoteRow | null) => (r ? { kop: r.price_kop, minor: r.price_minor, currency: r.currency, qty: r.quantity, volume: r.volume, at: r.fetched_at } : null);
      return json({
        ok: true,
        item: { id: item.id, name: item.market_hash_name, img: (await imagesFor(d, [item.market_hash_name])).get(item.market_hash_name) ?? null, category: p.category, categoryRu: CATEGORY_RU[p.category], stattrak: p.stattrak, souvenir: p.souvenir, uniquePriced: p.uniquePriced },
        quotes: { steamLow: q(g('steam', 'lowest_listing')), steamMed: q(g('steam', 'median_24h')), skinport: q(g('skinport', 'lowest_listing')), skinportSales7d: q(g('skinport', 'sale_median_7d')), csfloat: q(g('csfloat', 'listing')) },
        liquidity: { cls: liq.cls, ru: LIQUIDITY_RU[liq.cls], perDay: liq.salesPerDay, basis: liq.basis },
        series: { steamLow: ser('steam', 'lowest_listing'), steamMed: ser('steam', 'median_24h'), skinport: ser('skinport', 'lowest_listing'), ...siteSeries }, sitesSince,
        stats: st, days, watchId: watch?.id ?? null, targetKop: watch?.target_buy_kop ?? null, advice, avg7Kop: avg7, steamAvg,
        backtest: bt, links: { steam: steamListingUrl(item.market_hash_name), skinport: safeLink(g('skinport', 'lowest_listing')?.url) },
      });
    }

    // ---------- Инвентарь и сделки ----------
    if (path === 'inventory' && method === 'GET') {
      // Что «выставлено» (ещё не продано) — уже не в покупках, а во вкладке «Продажи».
      const pend = await T.pendingByTrade(d, tid);
      const lots = (await T.openTrades(d, tid)).map((l) => ({ ...l, sold_quantity: l.sold_quantity + (pend.get(l.id) ?? 0) })).filter((l) => l.quantity > l.sold_quantity);
      const lotIds = [...new Set(lots.map((l) => l.item_id))].slice(0, 360);
      const [quotes, adv, imgs, avgs, fxm, wallet] = await Promise.all([
        quotesChunked(d, lotIds),
        adviceFor(d, tid, now, [...new Map(lots.map((l) => [l.item_id, { id: l.item_id, name: l.market_hash_name }])).values()]),
        imagesFor(d, lots.map((l) => l.market_hash_name)),
        steamAvgFor(d, lotIds), db.loadLatestFx(d), walletCur(),
      ]);
      const usd = fxm.get('USD') ?? null;
      const lotEv = new Map(lots.map((l) => [l.item_id, steamEvidence(quotes.get(l.item_id) ?? [], avgs.get(l.item_id), usd, now)]));
      const lotSite = await siteKopFor(d, lots.filter((l) => { const e = lotEv.get(l.item_id)!; return !e.listing && !e.median24h && e.avg; }).map((l) => l.market_hash_name), usd, now);
      // Фактическая (реализованная) прибыль — только по записанным продажам, той же себестоимостью, что во вкладке «Продажи».
      // Steam Wallet и живые деньги не складываются (portfolio.ts).
      const [allT, allS] = await Promise.all([T.allTrades(d, tid), T.salesFor(d, tid)]);
      const rs = realizedStats(allT, T.salesWithCost(allT, allS));
      const lotsOut = lots.map((l) => {
          const q = quotes.get(l.item_id) ?? [];
          // Только свежие котировки (аудит): старые цены больше не выдаются за текущие.
          const ev = lotEv.get(l.item_id)!;
          const mv = marketValue(ev, lotSite.get(l.market_hash_name));
          const sp = q.find((x) => x.source === 'skinport' && x.price_type === 'lowest_listing' && now - x.fetched_at < LIVE_MAX_AGE_SEC)?.price_kop ?? null;
          const val = { steamProceedsPerUnit: mv ? steamNetKop(Math.max(3, mv.kop), wallet) : null, steamBasis: mv?.basis ?? null, externalPricePerUnit: sp };
          const v = viewLot(l, val);
          return {
            id: l.id, itemId: l.item_id, name: l.market_hash_name, img: imgs.get(l.market_hash_name) ?? null, qty: l.quantity, openQty: v.openQty, buyKop: l.buy_price_kop, feeKop: l.buy_fee_kop,
            platform: l.buy_platform, platformRu: PLATFORM_RU[l.buy_platform] ?? l.buy_platform, date: l.buy_date, targetKop: l.target_sell_kop,
            costKop: v.openCostKop, steamUnitKop: val.steamProceedsPerUnit, basis: val.steamBasis, marketUnitKop: mv?.kop ?? null, status: ev.status, externalUnitKop: val.externalPricePerUnit, valueKop: v.steamValueKop,
            unrealizedKop: v.unrealizedSteamKop, roiBp: v.unrealizedRoiBp, sold: l.sold_quantity, advice: adv.get(l.item_id) ?? null,
            unlockAt: (() => { const u = unlockAt(l.buy_date, l.created_at); return u > now ? u : null; })(),
          };
        });
      return json({
        ok: true, realizedSteamKop: rs.realizedSteamKop, realizedCashKop: rs.realizedCashKop, salesCount: rs.sales,
        platforms: PLATFORMS.map((p) => ({ v: p, t: PLATFORM_RU[p] })),
        lots: lotsOut, caseOpen: caseOpenStats(allT, allS, lotsOut),
      });
    }
    if (path === 'inventory' && method === 'POST') {
      if (!isAdmin && (await T.openTrades(d, tid)).length >= LOTS_LIMIT) return bad(`Лимит — ${LOTS_LIMIT} открытых позиций в инвентаре. Отметь проданные или удали лишние.`);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const qty = Number(body.qty);
      let price = Number(body.priceKop), fee = Number(body.feeKop ?? 0);
      const platform = String(body.platform ?? '');
      const date = parseDateInput(String(body.date ?? 'сегодня'), warsawDate(now));
      // Сумма в валюте, в которой платил (cur + сотые доли): пересчёт по курсу НБУ на дату покупки.
      let rate: { per: number; exact: boolean } | null = null;
      if (body.cur !== undefined && date) {
        if (!isCurrency(body.cur)) return bad('Неизвестная валюта');
        const pm = Number(body.priceMinor), fm = Number(body.feeMinor ?? 0);
        if (!Number.isSafeInteger(pm) || pm < 0 || !Number.isSafeInteger(fm) || fm < 0) return bad('Неверная цена');
        rate = await rateOn(d, body.cur, date, warsawDate(now));
        if (!rate) return bad('Нет курса для этой валюты');
        price = Math.round(pm * rate.per); fee = Math.round(fm * rate.per);
      }
      if (name.length < 3) return bad('Укажи предмет');
      if (!Number.isInteger(qty) || qty < 1 || qty > 10000) return bad('Количество: от 1 до 10000');
      if (!Number.isSafeInteger(price) || price < 0) return bad('Неверная цена');
      if (!Number.isSafeInteger(fee) || fee < 0) return bad('Неверная комиссия');
      if (!(PLATFORMS as readonly string[]).includes(platform)) return bad('Выбери площадку');
      if (!date) return bad('Неверная дата (будущие даты не принимаются)');
      const item = await db.upsertItem(d, name, now);
      const signalId = Number.isSafeInteger(Number(body.signalId)) && Number(body.signalId) > 0 ? Number(body.signalId) : null;
      const id = await T.addTrade(d, { tid, itemId: item.id, signalId, quantity: qty, buyPriceKop: price, buyFeeKop: fee, platform, buyDate: date, note: null, now });
      await T.addWatchFromInventory(d, tid, item.id, now);
      return json({ ok: true, id, rateExact: rate ? rate.exact : true });
    }
    // «Пропало из инвентаря Steam» — предложить записать как продажи.
    if (path === 'inventory/gone' && method === 'GET') {
      const rows = (await d.prepare(`SELECT g.id, g.item_id, g.qty, g.gone_at, i.market_hash_name AS name FROM inv_gone g JOIN items i ON i.id = g.item_id
        WHERE g.telegram_id = ? AND g.status = 'new' ORDER BY g.gone_at DESC, i.market_hash_name LIMIT 100`).bind(tid).all<{ id: number; item_id: number; qty: number; gone_at: number; name: string }>()).results;
      const names = [...new Set(rows.map((r) => r.name))];
      const [imgs, lots, fxm, srcRaw, last] = await Promise.all([
        imagesFor(d, names), T.openTrades(d, tid), db.loadLatestFx(d), getMeta(d, 'site_src_at'),
        d.prepare(`SELECT value FROM user_settings WHERE telegram_id = ? AND key = 'last_sell_site'`).bind(tid).first<{ value: string }>(),
      ]);
      const usd = fxm.get('USD') ?? null;
      let srcAt: Record<string, number> = {};
      try { srcAt = JSON.parse(srcRaw ?? '{}'); } catch { srcAt = {}; }
      const prices = new Map<string, Record<string, number>>();
      for (let i = 0; i < names.length; i += 90) {
        const p = names.slice(i, i + 90);
        for (const r of (await d.prepare(`SELECT name, json FROM site_prices WHERE name IN (${p.map(() => '?').join(',')})`).bind(...p).all<{ name: string; json: string }>()).results) {
          let c: Record<string, number> = {};
          try { c = JSON.parse(r.json); } catch { c = {}; }
          const out: Record<string, number> = {};
          for (const [k, v] of Object.entries(c)) {
            if (typeof v !== 'number' || !usd || (srcAt[k] && now - srcAt[k] > 48 * 3600)) continue;
            const kk = toKop(v, 'USD', usd);
            if (kk) out[k] = kk;
          }
          prices.set(r.name, out);
        }
      }
      return json({
        ok: true, lastSite: last?.value ?? null,
        platforms: PLATFORMS.filter((p) => !BUY_ONLY.includes(p)).map((p) => ({ v: p, t: PLATFORM_RU[p] })),
        items: rows.map((r) => {
          const lot = lots.find((l) => l.item_id === r.item_id && l.quantity > l.sold_quantity);
          return { id: r.id, itemId: r.item_id, name: r.name, qty: r.qty, goneAt: r.gone_at, img: imgs.get(r.name) ?? null,
            buyKop: lot ? lot.buy_price_kop : null, lotQty: lots.filter((l) => l.item_id === r.item_id).reduce((s, l) => s + l.quantity - l.sold_quantity, 0), prices: prices.get(r.name) ?? {} };
        }),
      });
    }
    if (path === 'inventory/gone/save' && method === 'POST') {
      const list = (Array.isArray(body.rows) ? body.rows : []).slice(0, 100) as Record<string, unknown>[];
      if (!list.length) return bad('Нечего записывать');
      const date = warsawDate(now);
      const wallet = await walletCur();
      let sold = 0, skipped = 0, resultKop = 0;
      const errors: string[] = [];
      let lastSite: string | null = null;
      let left = 0;
      for (const [i, r] of list.entries()) {
        // Лимит запросов к базе за один вызов — останавливаемся заранее и честно говорим, сколько осталось (повтор не задвоит).
        if (budget.d1 < ROW_D1) { left = list.length - i; break; }
        const g = await d.prepare(`SELECT g.id, g.item_id, g.qty, i.market_hash_name AS name FROM inv_gone g JOIN items i ON i.id = g.item_id WHERE g.id = ? AND g.telegram_id = ? AND g.status = 'new'`)
          .bind(Number(r.id), tid).first<{ id: number; item_id: number; qty: number; name: string }>();
        if (!g) continue;
        if (r.action === 'skip') {
          await d.prepare(`UPDATE inv_gone SET status = 'skip' WHERE id = ?`).bind(g.id).run();
          skipped++;
          continue;
        }
        const res = await recordSaleRow(d, tid, { itemId: g.item_id, name: g.name, maxQty: g.qty, qty: r.qty ?? g.qty, receivedKop: r.receivedKop, platform: r.platform, buyKop: r.buyKop, pending: r.pending === true, note: 'из «Пропало из инвентаря»' }, wallet, date, now);
        if (res.error) errors.push(res.error);
        if (!res.recordedQty) continue;
        resultKop += res.resultKop;
        const platform = String(r.platform);
        // Записанное — отдельной строкой «sold» с временем записи (gone_at), остаток остаётся в «Пропало» (повтор не задвоит продажу).
        // Время записи нужно сверке инвентаря: эти продажи уже объяснены пропажей и второй раз не вычитаются (steaminv.goneStmts).
        if (res.recordedQty < g.qty) await d.batch([
          d.prepare(`UPDATE inv_gone SET qty = qty - ? WHERE id = ?`).bind(res.recordedQty, g.id),
          d.prepare(`INSERT INTO inv_gone (telegram_id, item_id, qty, gone_at, status) VALUES (?, ?, ?, ?, 'sold')`).bind(tid, g.item_id, res.recordedQty, now),
        ]);
        else await d.prepare(`UPDATE inv_gone SET status = 'sold', gone_at = ? WHERE id = ?`).bind(now, g.id).run();
        sold++;
        lastSite = platform;
      }
      if (lastSite) await d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'last_sell_site', ?, ?) ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tid, lastSite, now).run();
      if (left) errors.push(`Записано ${list.length - left} из ${list.length}. Остальные ${left} — открой «Пропало из инвентаря» и нажми «Сохранить» ещё раз (уже записанные не повторятся).`);
      return json({ ok: true, sold, skipped, resultKop, errors, left });
    }
    if (seg[0] === 'inventory' && seg[2] === 'sell' && method === 'POST') {
      const id = Number(seg[1]);
      const qty = Number(body.qty), price = Number(body.priceKop);
      const platform = String(body.platform ?? '');
      if (!Number.isInteger(qty) || qty < 1) return bad('Количество — целое число от 1');
      const date = parseDateInput(String(body.date ?? 'сегодня'), warsawDate(now));
      if (!(PLATFORMS as readonly string[]).includes(platform) || BUY_ONLY.includes(platform)) return bad('Выбери площадку');
      if (!Number.isSafeInteger(price) || price <= 0) return bad('Неверная цена');
      if (!date) return bad('Неверная дата');
      let received = Number(body.receivedKop);
      if (body.receivedKop === undefined || body.receivedKop === null || body.receivedKop === '') {
        if (platform !== 'steam') return bad('Укажи, сколько фактически получил');
        const net = steamNetKop(price, await walletCur());
        if (net === null) return bad('Цена ниже минимальной в Steam');
        received = net * qty;
      }
      if (!Number.isSafeInteger(received) || received < 0) return bad('Неверная полученная сумма');
      if (body.pending === true) {
        try {
          const r = await T.addPending(d, tid, { tradeId: id, quantity: qty, sellPriceKop: price, receivedKop: received, platform, now });
          return json({ ok: true, pending: true, resultKop: received - r.costKop, costKop: r.costKop, receivedKop: received, wallet: walletFor(platform) });
        } catch (e) { return bad((e as Error).message); }
      }
      try {
        const r = await T.addSale(d, tid, { tradeId: id, quantity: qty, sellPriceKop: price, receivedKop: received, platform, sellDate: date, now });
        return json({ ok: true, resultKop: received - r.costKop, costKop: r.costKop, receivedKop: received, wallet: walletFor(platform), closed: r.closed });
      } catch (e) {
        return bad((e as Error).message);
      }
    }
    // Разовый импорт выставленных на Skinport предметов (со скриншотов владельца, 06.11.2026) — проверка и запись через то же окно.
    if (path === 'import/skinport' && method === 'GET') {
      if (!isAdmin) return bad('forbidden', 403);
      const known = [...new Set([
        ...(await d.prepare('SELECT i.market_hash_name AS n FROM steam_inventory s JOIN items i ON i.id = s.item_id WHERE s.telegram_id = ?').bind(tid).all<{ n: string }>()).results.map((r) => r.n),
        ...(await T.openTrades(d, tid)).map((l) => l.market_hash_name),
      ])];
      return json({
        ok: true, known,
        items: SKINPORT_LISTED.map((x) => ({ text: x.text, name: matchName(x.names, known) ?? x.names[0] ?? null, priceMinor: x.priceMinor, currency: 'PLN', float: x.float })),
        fees: Object.fromEntries(Object.entries(MARKETS).map(([k, m]) => [k, m.sellFeeBp])),
        lots: Object.fromEntries((await T.openTrades(d, tid)).map((l) => [l.market_hash_name, 1])),
        platforms: PLATFORMS.filter((x) => !BUY_ONLY.includes(x)).map((x) => ({ v: x, t: PLATFORM_RU[x] })),
      });
    }
    // Пачка продаж по названиям (импорт). До 5 строк за запрос — лимит запросов к базе.
    if (path === 'sales/batch' && method === 'POST') {
      const list = (Array.isArray(body.rows) ? body.rows : []).slice(0, 5) as Record<string, unknown>[];
      if (!list.length) return bad('Нечего записывать');
      const wallet = await walletCur();
      const date = warsawDate(now);
      let sold = 0, resultKop = 0, done = 0;
      const errors: string[] = [];
      for (const r of list) {
        // Лимит запросов к базе — остальные строки приложение пришлёт следующим запросом (done — сколько обработано по порядку).
        if (budget.d1 < ROW_D1) break;
        done++;
        const name = typeof r.name === 'string' ? r.name.trim().slice(0, 200) : '';
        if (name.length < 3) { errors.push('Не выбран предмет'); continue; }
        const item = await db.upsertItem(d, name, now);
        const res = await recordSaleRow(d, tid, { itemId: item.id, name, maxQty: 1000, qty: r.qty ?? 1, receivedKop: r.receivedKop, platform: r.platform, buyKop: r.buyKop, pending: r.pending === true, note: 'со скриншота сайта' }, wallet, date, now);
        if (res.error) errors.push(res.error);
        if (res.recorded) { sold++; resultKop += res.resultKop; }
      }
      return json({ ok: true, sold, resultKop, errors, done });
    }
    if (seg[0] === 'sales' && seg[1] === 'pending' && seg[3] === 'confirm' && method === 'POST') {
      const rcv = body.receivedKop == null || body.receivedKop === '' ? null : Number(body.receivedKop);
      if (rcv !== null && (!Number.isSafeInteger(rcv) || rcv < 0)) return bad('Неверная сумма');
      try {
        const r = await T.confirmPending(d, tid, Number(seg[2]), rcv, warsawDate(now), now);
        return json({ ok: true, resultKop: r.receivedKop - r.costKop });
      } catch (e) { return bad((e as Error).message); }
    }
    if (seg[0] === 'sales' && seg[1] === 'pending' && seg[3] === 'cancel' && method === 'POST') {
      return json({ ok: await T.cancelPending(d, tid, Number(seg[2])) });
    }
    if (seg[0] === 'sales' && seg[1] && method === 'DELETE') {
      return json({ ok: await T.deleteSale(d, tid, Number(seg[1]), now) });
    }
    if (seg[0] === 'inventory' && seg[1] && method === 'DELETE') {
      return json({ ok: await T.deleteTrade(d, tid, Number(seg[1])) });
    }
    if (seg[0] === 'inventory' && seg[2] === 'platform' && method === 'POST') {
      const platform = String(body.platform ?? '');
      if (!(PLATFORMS as readonly string[]).includes(platform)) return bad('Выбери площадку');
      const r = await d.prepare('UPDATE trades SET buy_platform = ?, updated_at = ? WHERE telegram_id = ? AND id = ?').bind(platform, now, tid, Number(seg[1])).run();
      return json({ ok: (r.meta?.changes ?? 0) > 0 });
    }
    if (seg[0] === 'inventory' && seg[2] === 'target' && method === 'POST') {
      const kop = body.kop === null ? null : Number(body.kop);
      if (kop !== null && (!Number.isSafeInteger(kop) || kop <= 0)) return bad('bad_price');
      await T.setTradeTarget(d, tid, Number(seg[1]), kop, now);
      return json({ ok: true });
    }
    if (path === 'trades' && method === 'GET') {
      const trades = await T.allTrades(d, tid);
      const raw = await T.salesFor(d, tid);
      const sales = T.salesWithCost(trades, raw);
      const st = realizedStats(trades, sales);
      const byId = new Map(trades.map((t) => [t.id, t]));
      const last = sales.slice(-100).reverse();
      const pend = await T.pendingFor(d, tid);
      const imgs = await imagesFor(d, [...new Set([...last.map((s) => byId.get(s.trade_id)?.market_hash_name ?? ''), ...pend.map((p) => p.market_hash_name)])].filter(Boolean));
      return json({
        ok: true, stats: st,
        pending: pend.map((p) => {
          const cost = Math.round((p.buy_price_kop * p.lot_qty + p.buy_fee_kop) * p.quantity / Math.max(1, p.lot_qty));
          return { id: p.id, name: p.market_hash_name, img: imgs.get(p.market_hash_name) ?? null, qty: p.quantity, receivedKop: p.received_kop, costKop: cost, resultKop: p.received_kop - cost,
            platform: PLATFORM_RU[p.platform] ?? p.platform, wallet: walletFor(p.platform), since: p.created_at };
        }),
        sales: last.map((s) => {
          const name = byId.get(s.trade_id)?.market_hash_name ?? '';
          const pl = (s as unknown as { platform?: string }).platform ?? '';
          return { id: (s as unknown as { id: number }).id, name, img: imgs.get(name) ?? null, qty: s.quantity, receivedKop: s.received_kop, costKop: s.costKop,
            resultKop: s.received_kop - s.costKop, wallet: s.wallet, date: s.sell_date, platform: PLATFORM_RU[pl] ?? pl };
        }),
        open: trades.filter((t) => openQty(t) > 0).length,
      });
    }

    // ---------- Настройки и состояние ----------
    if (path === 'settings' && method === 'GET') {
      const [s, rates] = await Promise.all([db.getSettings(d, tid), loadRates(d)]);
      return json({ ok: true, currencies: availableCurrencies(rates), hasBalance: s.steam_balance_kop !== '', settings: settingsFor(isAdmin).map((m) => ({ key: m.key, label: m.label, kind: m.kind, value: s[m.key], display: displayValue(m, s), choices: m.choices ?? null, hint: m.hint ?? null })) });
    }
    if (path === 'settings' && method === 'POST' && body.key === 'currency') {
      const rates = await loadRates(d);
      if (!isCurrency(body.value) || !rates[body.value]) return bad('Нет курса для этой валюты');
      await db.setSetting(d, tid, 'currency', body.value, now);
      await db.setSetting(d, tid, 'currency_ok', '1', now);
      return json({ ok: true, value: body.value });
    }
    if (path === 'setup' && method === 'POST') {
      if (body.what === 'currency') await db.setSetting(d, tid, 'currency_ok', '1', now);
      else if (body.what === 'hide') await db.setSetting(d, tid, 'setup_hidden', '1', now);
      else if (body.what === 'onboarded') await db.setSetting(d, tid, 'onboarded', '1', now);
      else if (body.what === 'notify') await db.setSetting(d, tid, 'notify_enabled', '1', now);
      else return bad('bad_setup');
      return json({ ok: true });
    }
    // Рекомендуемая цена выставления в Steam (с учётом того, растёт цена или падает).
    if (seg[0] === 'sellprice' && method === 'GET' && /^\d+$/.test(seg[1] ?? '')) {
      const id = Number(seg[1]);
      const item = await d.prepare('SELECT market_hash_name AS name FROM items WHERE id = ?').bind(id).first<{ name: string }>();
      if (!item) return bad('not_found', 404);
      const [quotes, avgs, fxm, wallet] = await Promise.all([quotesChunked(d, [id]), steamAvgFor(d, [id]), db.loadLatestFx(d), walletCur()]);
      const usd = fxm.get('USD') ?? null;
      // Только свежие данные: живое объявление (≤ 6 ч) и средние продаж (≤ 48 ч). Нет ни того ни другого — «Нет актуальных данных».
      const ev = steamEvidence(quotes.get(id) ?? [], avgs.get(id), usd, now);
      const cost = Number(url.searchParams.get('cost'));
      // Совет «за сколько выставить» — только по живому объявлению Steam: средняя продаж может сильно отставать от рынка.
      const rec = !ev.listing ? null : steamSellPrice({
        liveLowKop: ev.listing?.kop ?? null, d1Kop: ev.avg?.d1 ?? null, d7Kop: ev.avg?.d7 ?? null, d30Kop: ev.avg?.d30 ?? null,
        costKop: Number.isSafeInteger(cost) && cost > 0 ? cost : null, uniquePriced: parseMarketHashName(item.name).uniquePriced, wallet,
      });
      return json({ ok: true, rec, status: ev.status, stale: ev.stale, liveAt: ev.listing?.at ?? null, avgAt: ev.avg?.at ?? null,
        prices: { listing: ev.listing, buyOrder: ev.buyOrder, median24h: ev.median24h, avg: ev.avg }, pattern: parseMarketHashName(item.name).uniquePriced, url: steamListingUrl(item.name) });
    }
    if (path === 'terms' && method === 'GET') {
      const s = await db.getSettings(d, tid);
      return json({ ok: true, accepted: s.terms_ok === TERMS_VERSION, onboarded: s.onboarded === '1', version: TERMS_VERSION, short: TERMS_SHORT, terms: TERMS_SECTIONS, privacy: PRIVACY_SECTIONS });
    }
    if (path === 'terms' && method === 'POST') {
      await db.setSetting(d, tid, 'terms_ok', TERMS_VERSION, now);
      return json({ ok: true });
    }
    // Цены предмета на всех площадках (+ Steam), для карточки предмета и идеи.
    if (path === 'prices' && method === 'GET') {
      const name = (url.searchParams.get('name') ?? '').slice(0, 200);
      if (!name) return bad('no_name');
      const [row, links, fxm, item] = await Promise.all([
        d.prepare('SELECT json, updated_at FROM site_prices WHERE name = ?').bind(name).first<{ json: string; updated_at: number }>(),
        loadRefLinks(d), db.loadLatestFx(d),
        d.prepare('SELECT id FROM items WHERE market_hash_name = ?').bind(name).first<{ id: number }>(),
      ]);
      const usd = fxm.get('USD') ?? null;
      const toK = (c: number) => (usd ? toKop(c, 'USD', usd) : null);
      let cents: Record<string, number> = {};
      try { cents = row ? JSON.parse(row.json) as Record<string, number> : {}; } catch { cents = {}; }
      // Нет общей таблицы — берём площадки из последней проверки рынка (если предмет там был).
      let at = row?.updated_at ?? null;
      if (!row) {
        const scan = await loadScan(d);
        const e = scan?.entries.find((x) => x.name === name);
        if (e && scan) {
          at = scan.fetchedAt;
          for (const o of e.offers) {
            const r = fxm.get(o.cur) ?? null;
            const k = o.cur === 'USD' ? o.minor : r && usd ? Math.round((o.minor * r.rateMicro) / usd.rateMicro) : null;
            if (k) cents[o.m] = k;
          }
        }
      }
      let srcAt: Record<string, number> = {};
      try { srcAt = row ? JSON.parse((await getMeta(d, 'site_src_at')) ?? '{}') : Object.fromEntries(Object.keys(cents).map((k) => [k, at ?? now])); } catch { srcAt = {}; }
      const list = sitePriceList(name, cents, toK, links, await loadSkinportPages(d, [name]), srcAt, now);
      // Цен площадок нет (предмет не успел попасть в общий проход): ставим в очередь, сборщик обновит его в ближайшие минуты.
      let requested = false;
      if (!list.length) {
        const q = await requestedSiteNames(d);
        if (!q.includes(name)) await setMetaStmt(d, 'site_price_req', JSON.stringify([...q, name].slice(-60))).run();
        requested = true;
      }
      let steam: { kop: number; live: boolean; basis: string; prices: unknown; status: string } | null = null;
      let steamStatus = 'no_data';
      if (item) {
        const [q, sa] = await Promise.all([quotesChunked(d, [item.id]), steamAvgFor(d, [item.id])]);
        const ev = steamEvidence(q.get(item.id) ?? [], sa.get(item.id), usd, now);
        const mv = marketValue(ev, siteMedianKop(list.filter((x) => x.kind === 'listing' && x.group !== 'steam').map((x) => x.kop)));
        steamStatus = ev.status;
        if (mv) steam = { kop: mv.kop, live: mv.basis === 'listing' || mv.basis === 'median24h', basis: mv.basis, status: ev.status, prices: { listing: ev.listing, buyOrder: ev.buyOrder, median24h: ev.median24h, avg: ev.avg } };
      }
      return json({ ok: true, at, requested, sites: list, steamStatus, pattern: parseMarketHashName(name).uniquePriced, steam: steam ? { ...steam, url: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}` } : null });
    }
    // #2: картинка «Мой инвентарь стоит X» — рисует приложение, сервер только хранит (одна на человека, 30 дней).
    if (path === 'sharecard' && method === 'POST') {
      const jpg = typeof body.jpg === 'string' ? body.jpg : '';
      if (!jpg.startsWith('/9j/') || jpg.length > 600_000 || !/^[A-Za-z0-9+/=]+$/.test(jpg)) return bad('bad_image');
      const s = await db.getSettings(d, tid);
      let prev: { id?: string; at?: number } = {};
      try { prev = s.share_card ? JSON.parse(s.share_card) : {}; } catch { prev = {}; }
      if (prev.at && now - prev.at < 15) return bad('Подожди пару секунд');
      const id = 'inv-' + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await d.batch([
        ...(prev.id ? [d.prepare('DELETE FROM cards WHERE id = ?').bind(prev.id)] : []),
        d.prepare("DELETE FROM cards WHERE id LIKE 'inv-%' AND created_at < ?").bind(now - 30 * 86400),
        d.prepare('INSERT INTO cards (id, jpg_b64, created_at) VALUES (?, ?, ?)').bind(id, jpg, now),
        d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'share_card', ?, ?)
          ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tid, JSON.stringify({ id, at: now }), now),
      ]);
      const bot = await botUsername(d, new TelegramClient(env.TELEGRAM_BOT_TOKEN));
      return json({ ok: true, url: `${new URL(req.url).origin}/card/${id}.jpg`, bot: bot ? `https://t.me/${bot}?start=story` : null });
    }
    // #8: цель продажи для предмета инвентаря Steam («скажи, когда станет дороже X»). kop: null — убрать.
    if (path === 'sellalert' && method === 'POST') {
      const itemId = Number(body.itemId);
      const own = Number.isSafeInteger(itemId) ? await d.prepare('SELECT 1 AS x FROM steam_inventory WHERE telegram_id = ? AND item_id = ?').bind(tid, itemId).first() : null;
      if (!own) return bad('Этого предмета нет в твоём инвентаре Steam');
      if (body.kop === null) {
        await d.prepare('DELETE FROM sell_alerts WHERE telegram_id = ? AND item_id = ?').bind(tid, itemId).run();
        return json({ ok: true, targetKop: null });
      }
      const kop = Number(body.kop);
      if (!Number.isSafeInteger(kop) || kop <= 0 || kop > 1e11) return bad('Введи цену, например 120');
      const n = (await d.prepare('SELECT COUNT(*) AS n FROM sell_alerts WHERE telegram_id = ? AND notified_at IS NULL AND item_id != ?').bind(tid, itemId).first<{ n: number }>())?.n ?? 0;
      if (n >= MAX_SELL_ALERTS) return bad(`Не больше ${MAX_SELL_ALERTS} целей продажи`);
      await d.prepare(`INSERT INTO sell_alerts (telegram_id, item_id, target_kop, created_at, notified_at) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(telegram_id, item_id) DO UPDATE SET target_kop = excluded.target_kop, created_at = excluded.created_at, notified_at = NULL`).bind(tid, itemId, kop, now).run();
      return json({ ok: true, targetKop: kop });
    }
    if (path === 'calc' && method === 'GET') {
      const kop = Number(url.searchParams.get('kop'));
      if (!Number.isSafeInteger(kop) || kop < 3 || kop > 1e11) return bad('Введи цену, например 120');
      const mode = url.searchParams.get('mode') === 'get' ? 'get' : 'sell';
      const s = await db.getSettings(d, tid);
      const eur = (await db.loadLatestFx(d)).get('EUR') ?? null;
      const spMin = toKop(SKINPORT_MIN_FEE_EUR_CENTS, 'EUR', eur);
      return json({ ok: true, mode, withdrawBp: db.num(s.withdraw_fee_bp), rows: calcFees(kop, mode, db.num(s.withdraw_fee_bp), spMin ? { skinport: spMin } : {}) });
    }
    // ---------- «Разгон баланса» ----------
    if (path === 'rally' && method === 'GET') {
      await d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'rally_on', '1', ?) ON CONFLICT(telegram_id, key) DO NOTHING`).bind(tid, now).run();
      const [rs, scan, trades, track, wallet] = await Promise.all([rallySettingsFor(d, tid), loadRallyScan(d),
        d.prepare('SELECT * FROM rally_trades WHERE telegram_id = ? ORDER BY id DESC LIMIT 300').bind(tid).all<RallyTrade>(), rallyTrack(d, null), walletCur()]);
      const found = findCandidates(scan.entries, rs, now, track);
      const names = [...new Set([...found.list.map((c) => c.name), ...trades.results.map((t) => t.name)])].slice(0, 90);
      const idRows = names.length ? (await d.prepare(`SELECT id, market_hash_name AS n FROM items WHERE market_hash_name IN (${names.map(() => '?').join(',')})`).bind(...names).all<{ id: number; n: string }>()).results : [];
      const ids = new Map(idRows.map((r) => [r.n, r.id]));
      const t = trades.results;
      const freshCount = scan.entries.filter((e) => e.steam && now - e.steam.at < 3 * 3600).length;
      return json({
        ok: true, settings: rs, walletWarn: wallet.code !== rs.walletCur ? wallet.code : null,
        real: capital(t, rs, 'real', now), sim: capital(t, rs, 'sim', now), track,
        candidates: { ...found, list: found.list.map((c) => ({ ...c, itemId: ids.get(c.name) ?? null })) },
        dataAt: scan.at, checked: freshCount,
        // Симуляция самого бота по той же схеме — для честности: видно, как она работает на живых ценах.
        bot: await (async () => {
          const bt = (await d.prepare("SELECT * FROM rally_trades WHERE telegram_id <= 0 AND telegram_id >= -9 AND mode = 'sim' ORDER BY id DESC LIMIT 200").all<RallyTrade>()).results;
          const st = botStats(bt);
          return { post: (await getMeta(d, 'rally_post')) ?? null, closed: st.closed, wins: st.wins, realizedKop: st.realizedKop, need: BOT_MIN_CLOSED, open: bt.filter((x) => x.status === 'open').slice(0, 10), last: bt.filter((x) => x.status === 'sold').slice(0, 10), since: Number(await getMeta(d, 'rally_bot_started')) || null };
        })(),
        positions: t.filter((x) => x.status === 'open').map((x) => ({ ...x, itemId: ids.get(x.name) ?? null })),
        history: t.filter((x) => x.status !== 'open').slice(0, 60),
        chain: checkChain({ freeKop: Math.max(0, capital(t, rs, 'real', now).balanceKop - rs.reserveKop), steamBuyKop: null, siteSellNetKop: null, siteMinWithdrawKop: null, backItemCostKop: null, backItemSteamTargetKop: null, confirmed: false }),
      });
    }
    if (path === 'rally/settings' && method === 'POST') {
      const v = (body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, unknown>;
      const cur = await rallySettingsFor(d, tid);
      const stmts: D1PreparedStatement[] = [];
      for (const [k, key] of Object.entries(RALLY_KEYS) as [keyof RallySettings, string][]) {
        if (!(k in v)) continue;
        let val: string;
        if (k === 'risk') val = ['low', 'medium', 'high'].includes(String(v[k])) ? String(v[k]) : 'low';
        else if (k === 'notify') val = v[k] ? '1' : '0';
        else if (k === 'walletCur') val = /^[A-Z]{3}$/.test(String(v[k])) ? String(v[k]) : 'UAH';
        else if (k === 'maxPositions' || k === 'minRoiBp') { const n = Number(v[k]); if (!Number.isSafeInteger(n) || n < 0) return bad('Неверное значение'); val = String(n); }
        else { const n = Number(v[k]); if (!Number.isSafeInteger(n) || n < 0 || n > 1e10) return bad('Неверная сумма'); val = String(n); }
        stmts.push(d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tid, key, val, now));
      }
      if (stmts.length) await d.batch(stmts);
      return json({ ok: true, settings: { ...cur, ...(await rallySettingsFor(d, tid)) } });
    }
    if (path === 'rally/buy' && method === 'POST') {
      const mode = body.mode === 'real' ? 'real' : 'sim';
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
      const qty = Number(body.qty ?? 1), price = Number(body.priceKop);
      if (name.length < 3 || !Number.isSafeInteger(qty) || qty < 1 || qty > 100 || !Number.isSafeInteger(price) || price < 3) return bad('Укажи предмет, количество и цену покупки');
      const rs = await rallySettingsFor(d, tid);
      const trades = (await d.prepare('SELECT * FROM rally_trades WHERE telegram_id = ? AND mode = ?').bind(tid, mode).all<RallyTrade>()).results;
      const cap = capital(trades, rs, mode, now);
      const blockers = buyBlockers(cap, rs, price * qty);
      if (blockers.length) return bad(blockers.join('. '));
      const days = Number(body.unlockDays ?? 7);
      const unlock = now + (Number.isFinite(days) && days >= 0 && days <= 30 ? Math.round(days * 86400) : UNLOCK_SEC);
      const target = Number(body.targetKop), pred = Number(body.predictedNetKop);
      await d.prepare(`INSERT INTO rally_trades (telegram_id, mode, name, img, qty, buy_kop, bought_at, unlock_at, target_kop, predicted_net_kop, risk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(tid, mode, name, safeImg(body.img), qty, price, now, unlock, Number.isSafeInteger(target) && target > 0 ? target : null,
          Number.isSafeInteger(pred) && pred > 0 ? pred : null, typeof body.risk === 'string' ? body.risk.slice(0, 10) : null).run();
      await d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'rally_on', '1', ?) ON CONFLICT(telegram_id, key) DO UPDATE SET value = '1'`).bind(tid, now).run();
      // 6) Достигнут лимит: больше покупок по правилам не будет, пока не продашь/отменишь.
      const after = capital([...trades, { mode, status: 'open', qty, buy_kop: price, unlock_at: unlock, predicted_net_kop: null } as RallyTrade], rs, mode, now);
      const limit = after.openCount >= rs.maxPositions ? `открыто ${after.openCount} из ${rs.maxPositions} позиций` : after.balanceKop - rs.reserveKop < 3 ? 'свободные деньги сверх резерва закончились' : null;
      if (limit && mode === 'real') {
        await d.prepare(`INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at) VALUES (?, 'rally', ?, NULL, ?, '[]', NULL, ?, ?)`)
          .bind(tid, `limit:${Math.floor(now / 3600)}`, `🛑 <b>Лимит «Разгона баланса» достигнут</b>\n\n${limit}. Новые покупки по твоим правилам — после продажи или отмены. Резерв ⟦${rs.reserveKop}⟧ не трогаем.`, now, now).run();
      }
      return json({ ok: true, limit });
    }
    if ((path === 'rally/sell' || path === 'rally/cancel' || path === 'rally/edit') && method === 'POST') {
      const id = Number(body.id);
      const t = Number.isSafeInteger(id) ? await d.prepare(`SELECT * FROM rally_trades WHERE id = ? AND telegram_id = ? AND status = 'open'`).bind(id, tid).first<RallyTrade>() : null;
      if (!t) return bad('Сделка не найдена');
      if (path === 'rally/cancel') {
        await d.prepare(`UPDATE rally_trades SET status = 'cancelled', sold_at = ?, sold_note = 'отменено пользователем' WHERE id = ?`).bind(now, id).run();
        return json({ ok: true });
      }
      if (path === 'rally/edit') {
        const target = body.targetKop === null ? null : Number(body.targetKop);
        const days = body.unlockDate ? Date.parse(String(body.unlockDate) + 'T12:00:00Z') / 1000 : NaN;
        await d.prepare('UPDATE rally_trades SET target_kop = ?, unlock_at = ?, n_target = 0, n_unlock = 0 WHERE id = ?')
          .bind(target === null ? null : Number.isSafeInteger(target) && target > 0 ? target : t.target_kop, Number.isFinite(days) && days > now - 30 * 86400 && days < now + 60 * 86400 ? days : t.unlock_at, id).run();
        return json({ ok: true });
      }
      // Продажа (в т.ч. частичная): цена покупателя за 1 шт. → получено по точной комиссии Steam.
      const qty = Number(body.qty ?? t.qty), price = Number(body.priceKop);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > t.qty || !Number.isSafeInteger(price) || price < 3) return bad('Укажи количество и цену продажи');
      const net = Number.isSafeInteger(Number(body.netKop)) && Number(body.netKop) > 0 ? Number(body.netKop) * qty : (steamNetKop(price) ?? 0) * qty;
      if (qty === t.qty) {
        await d.prepare(`UPDATE rally_trades SET status = 'sold', sold_qty = ?, sold_price_kop = ?, sold_net_kop = ?, sold_at = ? WHERE id = ?`).bind(qty, price, net, now, id).run();
      } else {
        await d.batch([
          d.prepare(`INSERT INTO rally_trades (telegram_id, mode, name, img, qty, buy_kop, bought_at, unlock_at, target_kop, predicted_net_kop, risk, status, sold_qty, sold_price_kop, sold_net_kop, sold_at, parent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sold', ?, ?, ?, ?, ?)`).bind(tid, t.mode, t.name, t.img, qty, t.buy_kop, t.bought_at, t.unlock_at, t.target_kop, t.predicted_net_kop, t.risk, qty, price, net, now, id),
          d.prepare('UPDATE rally_trades SET qty = qty - ? WHERE id = ?').bind(qty, id),
        ]);
      }
      return json({ ok: true, netKop: net, profitKop: net - t.buy_kop * qty });
    }
    if (path === 'rally/reset' && method === 'POST') {
      await d.prepare(`DELETE FROM rally_trades WHERE telegram_id = ? AND mode = 'sim'`).bind(tid).run();
      return json({ ok: true });
    }
    if (path === 'recstats' && method === 'GET') return json({ ok: true, ...(await recStats(d, now, 30)) });
    if (path === 'feedback' && method === 'POST') {
      const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
      const err = await submitFeedback(d, tg, Number(env.ADMIN_TELEGRAM_ID), tid, body, now);
      return err ? bad(err) : json({ ok: true });
    }
    if (path === 'suggest' && method === 'POST') {
      const err = await submitSuggestion(d, new TelegramClient(env.TELEGRAM_BOT_TOKEN), Number(env.ADMIN_TELEGRAM_ID), tid, body.text, null, now, tid === Number(env.ADMIN_TELEGRAM_ID));
      return err ? bad(err) : json({ ok: true });
    }
    // Трейд-ссылка владельца для подарков скинами (розыгрыш подписчикам / подарок автору): видят все, меняет только владелец.
    if (path === 'tradeurl' && method === 'GET') return json({ ok: true, url: (await getMeta(d, 'trade_url')) || null, getUrl: TRADE_URL_HELP });
    if (path === 'owner/tradeurl' && method === 'POST') {
      if (!isAdmin) return bad('admin_only', 403);
      const raw = typeof body.url === 'string' ? body.url.trim() : '';
      if (!raw) { await d.prepare("DELETE FROM meta WHERE key = 'trade_url'").run(); return json({ ok: true, url: null }); }
      if (!TRADE_URL_RE.test(raw)) return bad('Это не трейд-ссылка Steam. Она выглядит так: https://steamcommunity.com/tradeoffer/new/?partner=…&token=…');
      await setMetaStmt(d, 'trade_url', raw).run();
      return json({ ok: true, url: raw });
    }
    // «Коллекции»: общий для всех справочный экран (динамика цен, статусы ротаций, выход в плюс после комиссии Steam).
    if (path === 'collections' && method === 'GET') {
      const [c, w] = await Promise.all([loadCollections(d), walletCur()]);
      const code = w.code in STEAM_CURRENCY_ID ? w.code : 'UAH'; // валюта Steam человека; если Steam такой нет — гривна
      return json({ ok: true, at: c.at, cur: code, list: collViews(c.stats, c.vols, code).filter((v) => v.k > 0) });
    }
    const collM = /^collections\/([a-z0-9-]{3,80})$/.exec(path);
    if (collM && method === 'GET') {
      const c = await loadCollections(d);
      const hit = c.stats.find((x) => x.id === collM[1]);
      if (!hit) return bad('Коллекция не найдена', 404);
      return json({ ok: true, id: hit.id, name: hit.name, crateNames: hit.crateNames.filter((n) => !/Souvenir/i.test(n)), skins: skinViews(hit) });
    }
    // «Я отправил обмен»: человек ничего не пишет, одно нажатие. Бот сразу сообщает владельцу, для чего этот трейд.
    if (path === 'tradesent' && method === 'POST') {
      const kind = body.kind === 'gift' ? 'gift' : body.kind === 'raffle' ? 'raffle' : null;
      if (!kind) return bad('bad_kind');
      if (!(await getMeta(d, 'trade_url'))) return bad('Скины сейчас не принимаются');
      const last = Number(await getMeta(d, `tradesent:${tid}`)) || 0;
      if (now - last < 600) return bad('Уже отправлено, подожди несколько минут');
      await setMetaStmt(d, `tradesent:${tid}`, String(now)).run();
      const purpose = kind === 'raffle' ? '🎁 для розыгрыша подписчикам' : '💛 подарок автору';
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(Number(env.ADMIN_TELEGRAM_ID), [
        '📦 <b>Скоро придёт обмен в Steam</b>',
        `Цель: <b>${purpose}</b>`,
        `От: <a href="tg://user?id=${tid}">${tid}</a>`,
        '<i>Человек сам нажал «Я отправил обмен». Проверь предложения обмена в Steam.</i>',
      ].join('\n')).catch(() => undefined);
      return json({ ok: true });
    }
    if (path === 'donate' && method === 'POST') {
      const stars = Number(body.stars);
      if (!DONATE_AMOUNTS.includes(stars)) return bad('bad_amount');
      return json({ ok: true, link: await donateInvoiceLink(new TelegramClient(env.TELEGRAM_BOT_TOKEN), stars), amounts: DONATE_AMOUNTS });
    }
    if (path === 'privacy' && method === 'GET') {
      return json({ ok: true, ...PRIVACY_POINTS });
    }
    if (path === 'settings' && method === 'POST') {
      const m = settingsFor(isAdmin).find((x) => x.key === body.key);
      if (!m) return bad('unknown_setting');
      let value: string;
      if (m.kind === 'toggle') value = body.value === true || body.value === '1' ? '1' : '0';
      else if (m.kind === 'choice') {
        if (!m.choices?.some((c) => c.v === body.value)) return bad('bad_choice');
        value = String(body.value);
      } else {
        const r = parseSettingInput(m, String(body.value ?? ''), await userCur(d, tid, await loadRates(d)));
        if (!r.ok) return bad(r.error);
        value = r.value;
      }
      await db.setSetting(d, tid, m.key, value, now);
      const s = await db.getSettings(d, tid);
      return json({ ok: true, display: displayValue(m, s), value });
    }
    if ((path === 'status' || path === 'jobs/enable' || path.startsWith('owner') || path.startsWith('people')) && !isAdmin) return bad('admin_only', 403);
    // Ключ домашнего агента: новый ключ заменяет старый; в базе — только хэш, сам ключ показывается один раз.
    if (path === 'owner/agent-key' && method === 'POST') {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const key = 'ag_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      await setMetaStmt(d, 'agent_key_hash', await sha256Hex(key)).run();
      return json({ ok: true, key, worker: url.origin });
    }
    // #18: панель владельца — всё о боте в одном месте, с iPhone.
    if (path === 'owner' && method === 'GET') {
      const day = now - 86400, week = now - 7 * 86400;
      const one = <T>(sql: string, ...b: unknown[]) => d.prepare(sql).bind(...b).first<T>();
      const [users, steamN, watchN, rallyN, refs, don, donLast, fb, sources, jobs, errs, metaRows, bot] = await Promise.all([
        one<{ n: number; d1: number | null; d7: number | null }>('SELECT COUNT(*) AS n, SUM(created_at >= ?) AS d1, SUM(created_at >= ?) AS d7 FROM users', day, week),
        one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE steam_id IS NOT NULL OR steam_vanity IS NOT NULL'),
        one<{ u: number; i: number }>('SELECT COUNT(DISTINCT telegram_id) AS u, COUNT(DISTINCT item_id) AS i FROM watchlist WHERE active = 1'),
        one<{ n: number }>("SELECT COUNT(*) AS n FROM user_settings WHERE key = 'rally_on' AND value = '1'"),
        d.prepare(`SELECT COALESCE(s.value, 'без метки') AS ref, COUNT(*) AS n FROM users u LEFT JOIN user_settings s ON s.telegram_id = u.telegram_id AND s.key = 'ref' GROUP BY 1 ORDER BY n DESC LIMIT 6`).all<{ ref: string; n: number }>(),
        one<{ n: number; s: number; s30: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS s, COALESCE(SUM(CASE WHEN created_at >= ? THEN stars END), 0) AS s30 FROM donations', now - 30 * 86400),
        d.prepare('SELECT stars, name, created_at FROM donations ORDER BY id DESC LIMIT 5').all<{ stars: number; name: string | null; created_at: number }>(),
        d.prepare('SELECT telegram_id, item, reason, comment, context, created_at FROM feedback ORDER BY id DESC LIMIT 10').all<Record<string, unknown>>(),
        db.listSourceStatus(d), listJobs(d), db.recentErrors(d, 8),
        d.prepare(`SELECT key, value FROM meta WHERE key IN ('steam_pause_until', 'steam_backoff', 'agent_at', 'rally_bot', 'rally_bot_started', 'rally_post', 'channel_title', 'channel_id', 'channel_pending', 'img_cursor', 'site_prices_at', 'copies')`).all<{ key: string; value: string }>(),
        d.prepare("SELECT * FROM rally_trades WHERE telegram_id <= 0 AND telegram_id >= -9 AND mode = 'sim'").all<RallyTrade>(),
      ]);
      const m = Object.fromEntries(metaRows.results.map((r) => [r.key, r.value]));
      const js = (v: string | undefined) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
      const bs = botStats(bot.results);
      const col = sources.find((x) => x.source === 'collector');
      return json({
        ok: true,
        users: { total: users?.n ?? 0, d1: users?.d1 ?? 0, d7: users?.d7 ?? 0, steam: steamN?.n ?? 0, watchUsers: watchN?.u ?? 0, watchItems: watchN?.i ?? 0, rally: rallyN?.n ?? 0, refs: refs.results },
        steam: { pauseUntil: Number(m.steam_pause_until) || 0, backoff: Number(m.steam_backoff) || 0, agent: js(m.agent_at), collectorOk: col?.last_ok_at ?? null,
          sources: sources.map((x) => ({ source: x.source, status: x.status, lastOk: x.last_ok_at, error: x.status !== 'ok' ? x.last_error : null })) },
        rally: { ...bs, best: undefined, on: m.rally_bot !== 'off', since: Number(m.rally_bot_started) || null, post: m.rally_post ?? null, need: BOT_MIN_CLOSED },
        money: { stars: don?.s ?? 0, count: don?.n ?? 0, stars30: don?.s30 ?? 0, last: donLast.results },
        feedback: fb.results,
        channel: { title: m.channel_title ?? null, connected: !!m.channel_id, pending: !!m.channel_pending },
        jobs: jobs.filter((j) => j.enabled !== 1 || j.fail_count > 0).map((j) => ({ name: j.name, enabled: j.enabled === 1, fails: j.fail_count, error: j.last_error })),
        errors: errs, copies: Object.keys(js(m.copies) ?? {}).length, images: m.img_cursor === '-1' ? 'готово' : m.img_cursor ?? '—',
      });
    }
    // Вкладка «Люди» (только владелец): сводка, список со страницами и карточка человека. Жалобы, пожертвования и «откуда пришли» — на первой странице.
    if (path === 'people' && method === 'GET') {
      const f = (['all', 'new', 'steam', 'list'].includes(url.searchParams.get('f') ?? '') ? url.searchParams.get('f') : 'all') as PeopleFilter;
      const offset = Math.min(5000, Math.max(0, Number(url.searchParams.get('o')) || 0));
      const r = await peopleList(d, now, f, offset);
      if (offset > 0) return json({ ok: true, ...r });
      const [refs, don, donLast, fb] = await Promise.all([
        d.prepare(`SELECT COALESCE(s.value, 'без метки') AS ref, COUNT(*) AS n FROM users u LEFT JOIN user_settings s ON s.telegram_id = u.telegram_id AND s.key = 'ref' WHERE u.is_admin = 0 GROUP BY 1 ORDER BY n DESC LIMIT 6`).all<{ ref: string; n: number }>(),
        d.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS s, COALESCE(SUM(CASE WHEN created_at >= ? THEN stars END), 0) AS s30 FROM donations').bind(now - 30 * 86400).first<{ n: number; s: number; s30: number }>(),
        d.prepare('SELECT stars, name, created_at FROM donations ORDER BY id DESC LIMIT 5').all<{ stars: number; name: string | null; created_at: number }>(),
        d.prepare('SELECT telegram_id, item, reason, comment, context, created_at FROM feedback ORDER BY id DESC LIMIT 10').all<Record<string, unknown>>(),
      ]);
      return json({ ok: true, ...r, refs: refs.results, money: { stars: don?.s ?? 0, count: don?.n ?? 0, stars30: don?.s30 ?? 0, last: donLast.results }, feedback: fb.results });
    }
    if (seg[0] === 'people' && seg[1] && method === 'GET') {
      const usd = (await db.loadLatestFx(d)).get('USD') ?? null;
      const card = await personCard(d, now, Number(seg[1]), usd);
      return card ? json({ ok: true, ...card }) : bad('not_found', 404);
    }
    if (path === 'owner/action' && method === 'POST') {
      const a = String(body.action ?? '');
      if (a === 'steam_unpause') await d.batch([setMetaStmt(d, 'steam_pause_until', '0'), setMetaStmt(d, 'steam_backoff', '0')]);
      else if (a === 'rally_bot_on' || a === 'rally_bot_off') await setMetaStmt(d, 'rally_bot', a === 'rally_bot_on' ? 'on' : 'off').run();
      else return bad('unknown_action');
      return json({ ok: true });
    }
    if (path === 'status' && method === 'GET') {
      const [jobs, sources, c, fx, errs, cat] = await Promise.all([listJobs(d), db.listSourceStatus(d), db.counters(d, now), db.loadLatestFx(d), db.recentErrors(d, 5), catalogInfo(d)]);
      const external = env.COLLECTOR === 'github' ? new Set(['steam', 'skinport_items', 'skinport_sales']) : new Set<string>();
      return json({
        ok: true, collector: env.COLLECTOR === 'github', csfloatKey: !!env.CSFLOAT_API_KEY,
        sources: sources.map((s) => ({ source: s.source, status: s.status, lastOk: s.last_ok_at, lastErrorAt: s.last_error_at, error: s.last_error, disabled: s.disabled_reason, requests: s.requests_today })),
        jobs: jobs.filter((j) => !external.has(j.name)).map((j) => ({ name: j.name, enabled: j.enabled === 1, fails: j.fail_count, next: j.next_run_at, lastOk: j.last_ok_at, error: j.last_error })),
        fx: [...fx.values()].map((r) => ({ base: r.base, rate: r.rateMicro / 1e6, date: r.rateDate })),
        counters: c, errors: errs, catalog: cat,
      });
    }
    if (path === 'jobs/enable' && method === 'POST') {
      for (const j of await listJobs(d)) if (j.enabled !== 1) await setJobEnabled(d, j.name, true, now);
      return json({ ok: true });
    }
    return bad('not_found', 404);
  } catch (e) {
    await db.log(d, 'error', 'webapp', path, (e as Error).message, now);
    return bad('Ошибка сервера: ' + (e as Error).message.slice(0, 150), 500);
  }
}

function dealDto(r: db.SignalRow & { market_hash_name: string }) {
  let snap: { liquidity?: { cls?: string; salesPerDay?: number | null }; arb?: { sellReferenceBasis?: string; downside?: { dropBp: number; spreadKop: number }[]; breakEvenBuyerKop?: number | null }; buy?: { url?: string | null; price_minor?: number | null; currency?: string }; fx?: { rateMicro?: number; rateDate?: string; base?: string } | null; reasons?: string[] } = {};
  try { snap = JSON.parse(r.snapshot_json); } catch { /* старый формат */ }
  return {
    id: r.id, itemId: r.item_id, name: r.market_hash_name, buySource: r.buy_source, buyKop: r.buy_kop, sellKop: r.sell_kop, proceedsKop: r.proceeds_kop,
    spreadKop: r.spread_kop, roiBp: r.roi_bp, priority: r.priority, category: r.category, state: r.state, updatedAt: r.updated_at, detectedAt: r.detected_at,
    liquidity: snap.liquidity?.cls ?? null, salesPerDay: snap.liquidity?.salesPerDay ?? null, basis: snap.arb?.sellReferenceBasis ?? null,
    downside: snap.arb?.downside ?? [], breakEven: snap.arb?.breakEvenBuyerKop ?? null, reasons: snap.reasons ?? [],
    buyUrl: safeLink(snap.buy?.url ?? null), steamUrl: steamListingUrl(r.market_hash_name),
    buyOriginal: snap.buy?.price_minor != null && snap.buy?.currency && snap.buy.currency !== 'UAH' ? { minor: snap.buy.price_minor, currency: snap.buy.currency } : null,
    fx: snap.fx ? { rate: (snap.fx.rateMicro ?? 0) / 1e6, date: snap.fx.rateDate, base: snap.fx.base } : null,
  };
}
