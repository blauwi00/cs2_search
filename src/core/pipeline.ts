// Конвейер: Fetch → Validate → Normalize → Store → Analyze → Score → Confirm → Notify.
// Учитывает лимиты бесплатного Worker: ≤ 50 запросов к D1 и ≤ 50 внешних запросов за вызов.
// Запись идёт пачками (db.batch() = 1 запрос), курсы и счётчики кешируются в пределах вызова.

import type { Env } from '../env.ts';
import { SourceError, type Quote, type Currency } from '../types/market.ts';
import * as db from '../storage/db.ts';
import { D1_RESERVE, type Budget } from '../storage/budget.ts';
import { fetchSteamPriceOverview } from '../api/steam.ts';
import { fetchSkinportItems, fetchSkinportSales } from '../api/skinport.ts';
import { fetchCsfloatListings } from '../api/csfloat.ts';
import { fetchNbuRaw, parseNbu, toKop, fxAgeDays, FX_MAX_AGE_DAYS_HIGH, type FxRate } from '../currency/nbu.ts';
import { computeSteamArbitrage } from './arbitrage.ts';
import { classifyLiquidity } from './liquidity.ts';
import { scoreArbitrage, type Priority } from './scoring.ts';
import { detectChanges, type PricePoint } from './analyzer.ts';
import { decideNotify, dedupKey, type NotifyPolicy } from './alerts.ts';
import { TelegramClient, esc, type Keyboard } from '../telegram/api.ts';
import { arbitrageMessage, changeMessage, targetMessage } from '../telegram/messages.ts';
import { formatUah, formatBp } from '../utils/money.ts';
import * as T from '../storage/trades.ts';
import { portfolioSummary } from '../telegram/inventory.ts';
import { valuation, viewLot, roiBucket } from './portfolio.ts';
import { outcomeAfter } from './quality.ts';
import { warsawHour, warsawDate, utcDay } from '../utils/time.ts';
import { steamListingUrl, type Fetcher } from '../utils/http.ts';
import { deliverAt, enqueueStmt, enqueueEditsStmt, loadUserSettings, withDefaults, type Delivery } from './audience.ts';
import { composeChannelPost, dueSlot, getMeta, setMetaStmt, botUsername, botButton, ALL_SLOTS, type Slot } from './channel.ts';
import { ensureTodayIdeas, newsPost, newsRuLines, type NewsItem } from './insights.ts';
import { loadScan } from '../storage/scan.ts';
import { parseNbuDisplay } from '../currency/display.ts';

export interface Ctx {
  env: Env;
  db: D1Database;          // обёрнут budgetedDb
  tg: TelegramClient;
  adminId: number;
  now: number;
  fetcher?: Fetcher;
  budget: Budget;
  settings: db.Settings;
  cache: {
    fx?: Map<Currency, FxRate>; sentLastHour?: number; counters: Map<string, number>;
    users?: Map<number, db.Settings>; watchers?: Map<number, { tid: number; target: number | null }[]>;
  };
  /** Сколько запросов D1 текущая задача обязана оставить следующим задачам этого вызова. */
  reserveD1: number;
}

export const STEAM_PER_RUN = 6;
export const CSFLOAT_PER_RUN = 3;
export const EVAL_PER_RUN = 20;
export const SKINPORT_SALES_CHUNK = 40;
/** Примерная стоимость обработки одного предмета в запросах D1. */
const D1_PER_ITEM = 6;

export function canD1(ctx: Ctx, n: number): boolean { return ctx.budget.d1 - D1_RESERVE - ctx.reserveD1 >= n; }

function spendExternal(ctx: Ctx, n = 1): boolean {
  if (ctx.budget.external < n) return false;
  ctx.budget.external -= n;
  return true;
}

export function bump(ctx: Ctx, counter: string, by = 1): void {
  ctx.cache.counters.set(counter, (ctx.cache.counters.get(counter) ?? 0) + by);
}

export async function flushCounters(ctx: Ctx): Promise<void> {
  const stmts = [...ctx.cache.counters.entries()].filter(([, v]) => v !== 0).map(([k, v]) => db.counterStmt(ctx.db, k, v, ctx.now));
  ctx.cache.counters.clear();
  if (stmts.length) await ctx.db.batch(stmts);
}

async function fxMap(ctx: Ctx): Promise<Map<Currency, FxRate>> {
  if (!ctx.cache.fx) ctx.cache.fx = await db.loadLatestFx(ctx.db);
  return ctx.cache.fx;
}

/** Общее решение «новость ли это» не зависит от счётчика одного человека: лимиты в час проверяет очередь для каждого. */
async function sentLastHour(_ctx: Ctx): Promise<number> { return 0; }

async function watchersOf(ctx: Ctx, itemId: number): Promise<{ tid: number; target: number | null }[]> {
  ctx.cache.watchers ??= new Map();
  let w = ctx.cache.watchers.get(itemId);
  if (!w) {
    w = (await ctx.db.prepare('SELECT telegram_id AS tid, target_buy_kop AS target FROM watchlist WHERE item_id = ? AND active = 1 LIMIT 500')
      .bind(itemId).all<{ tid: number; target: number | null }>()).results;
    ctx.cache.watchers.set(itemId, w);
  }
  return w;
}

/**
 * Рассылка: каждому получателю — по его настройкам; сообщение ставится в очередь outbox.
 * recipients не задан → все, кто следит за предметом. Возвращает true, если хоть кому-то поставлено.
 */
async function fanout(ctx: Ctx, itemId: number, del: Delivery, pending: D1PreparedStatement[], recipients?: number[]): Promise<boolean> {
  const tids = recipients ?? (await watchersOf(ctx, itemId)).map((w) => w.tid);
  if (!tids.length) return false;
  ctx.cache.users ??= new Map();
  const missing = tids.filter((t) => !ctx.cache.users!.has(t));
  for (let i = 0; i < missing.length; i += 90) {
    for (const [t, st] of await loadUserSettings(ctx.db, missing.slice(i, i + 90))) ctx.cache.users.set(t, st);
  }
  let n = 0;
  for (const t of tids) {
    const at = deliverAt(ctx.cache.users.get(t) ?? withDefaults([]), del, ctx.now);
    if (at === null) continue;
    pending.push(enqueueStmt(ctx.db, t, del, at, ctx.now));
    n++;
  }
  if (n === 0) return false;
  if (del.signalId !== null) pending.push(db.markNotifiedStmt(ctx.db, del.signalId, null, ctx.now));
  bump(ctx, 'notifications', n);
  return true;
}

/** Пересчёт в UAH. Без курса цена в UAH остаётся неизвестной (null) — ничего не выдумываем. */
async function convert(ctx: Ctx, q: Quote): Promise<{ kop: number | null; fxId: number | null }> {
  if (q.priceMinor === null) return { kop: null, fxId: null };
  if (q.currency === 'UAH') return { kop: q.priceMinor, fxId: null };
  const fx = (await fxMap(ctx)).get(q.currency) ?? null;
  return { kop: toKop(q.priceMinor, q.currency, fx), fxId: fx?.id ?? null };
}

function statusFor(e: unknown): string {
  if (e instanceof SourceError && e.kind === 'rate_limited') return 'rate_limited';
  if (e instanceof SourceError && (e.kind === 'forbidden' || e.kind === 'auth')) return 'down';
  return 'degraded';
}

async function chunkedBatch(ctx: Ctx, stmts: D1PreparedStatement[], size = 90): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await ctx.db.batch(stmts.slice(i, i + size));
}

// ---------- Задачи сбора ----------

export async function jobFx(ctx: Ctx): Promise<void> {
  if (!spendExternal(ctx)) return;
  bump(ctx, 'ext_requests');
  try {
    const raw = await fetchNbuRaw(ctx.fetcher);
    const rates = parseNbu(raw);
    await db.storeFx(ctx.db, rates, ctx.now);
    // Курсы всех валют показа (человек выбирает свою валюту).
    const display = parseNbuDisplay(raw);
    if (Object.keys(display).length) await setMetaStmt(ctx.db, 'fx_display', JSON.stringify(display)).run();
    ctx.cache.fx = undefined;
    await db.sourceOk(ctx.db, 'nbu', ctx.now, 1);
  } catch (e) {
    await db.sourceFail(ctx.db, 'nbu', statusFor(e), (e as Error).message, ctx.now, 1);
    throw e;
  }
}

/** Обработка котировок одного предмета: запись пачкой + пересчёт сигналов. Предыдущие данные загружены заранее. */
async function storeAndEvaluate(ctx: Ctx, item: db.ItemRow, fresh: Quote[], steamUpdated: boolean,
  prevList: db.QuoteRow[], signals: Map<string, db.SignalRow>): Promise<void> {
  const byKey = new Map(prevList.map((r) => [`${r.source}:${r.price_type}`, r]));
  const prevSteamLow = byKey.get('steam:lowest_listing')?.price_minor;
  const stmts: D1PreparedStatement[] = [];
  for (const q of fresh) {
    const { kop, fxId } = await convert(ctx, q);
    const w = db.quoteWrites(ctx.db, item.id, q, kop, fxId, byKey.get(`${q.source}:${q.priceType}`) ?? null);
    stmts.push(...w.stmts);
    if (w.snapshot) bump(ctx, 'snapshots');
    byKey.set(`${q.source}:${q.priceType}`, w.row);
  }
  stmts.push(db.markEvalStmt(ctx.db, item.id, 0));
  await ctx.db.batch(stmts);
  // Проверка резких изменений нужна, только если цена Steam действительно изменилась
  // (неизменная цена уже была проверена в прошлый раз) — экономия запроса истории.
  const steamChanged = steamUpdated && byKey.get('steam:lowest_listing')?.price_minor !== prevSteamLow;
  await evaluateLoaded(ctx, item, [...byKey.values()], steamChanged, [], signals);
}

export async function jobSteam(ctx: Ctx): Promise<void> {
  if (ctx.settings.src_steam !== '1') { await db.sourceDisabled(ctx.db, 'steam', 'выключено в настройках'); return; }
  const items = await db.itemsDueForSource(ctx.db, 'steam', 'median_24h', STEAM_PER_RUN);
  if (items.length === 0) return;
  const ids = items.map((i) => i.id);
  const prevQuotes = await db.quotesForItems(ctx.db, ids);
  const prevSignals = await db.signalsForItems(ctx.db, ids);
  let requests = 0;
  try {
    for (const it of items) {
      if (!canD1(ctx, D1_PER_ITEM) || ctx.budget.external < 3 || !spendExternal(ctx)) break;
      requests++;
      bump(ctx, 'ext_requests');
      let quotes: Quote[];
      try {
        quotes = await fetchSteamPriceOverview(it.market_hash_name, ctx.now, ctx.fetcher);
      } catch (e) {
        if (e instanceof SourceError && e.kind === 'not_found') {
          await db.log(ctx.db, 'warn', 'steam', 'not_found', `Нет данных Steam: ${it.market_hash_name}`, ctx.now);
          continue;
        }
        throw e;
      }
      await storeAndEvaluate(ctx, it, quotes, true, prevQuotes.get(it.id) ?? [], prevSignals.get(it.id) ?? new Map());
    }
  } catch (e) {
    await db.sourceFail(ctx.db, 'steam', statusFor(e), (e as Error).message, ctx.now, requests);
    throw e; // 429/5xx → планировщик делает backoff по Retry-After
  }
  if (requests > 0) await db.sourceOk(ctx.db, 'steam', ctx.now, requests);
}

export async function jobCsfloat(ctx: Ctx): Promise<void> {
  const key = ctx.env.CSFLOAT_API_KEY;
  if (!key) { await db.sourceDisabled(ctx.db, 'csfloat', 'требуется API-ключ (секрет CSFLOAT_API_KEY)'); return; }
  if (ctx.settings.src_csfloat !== '1') { await db.sourceDisabled(ctx.db, 'csfloat', 'выключено в настройках'); return; }
  const items = await db.itemsDueForSource(ctx.db, 'csfloat', 'listing', CSFLOAT_PER_RUN);
  if (items.length === 0) return;
  const ids = items.map((i) => i.id);
  const prevQuotes = await db.quotesForItems(ctx.db, ids);
  const prevSignals = await db.signalsForItems(ctx.db, ids);
  let requests = 0;
  try {
    for (const it of items) {
      if (!canD1(ctx, D1_PER_ITEM) || ctx.budget.external < 3 || !spendExternal(ctx)) break;
      requests++;
      bump(ctx, 'ext_requests');
      const listings = await fetchCsfloatListings(it.market_hash_name, key, ctx.now, ctx.fetcher);
      const best: Quote = listings[0] ?? {
        source: 'csfloat', marketHashName: it.market_hash_name, priceType: 'listing', priceMinor: null, currency: 'USD', quantity: 0,
        volume: null, volumePeriod: null, listingId: null, floatValue: null, paintSeed: null, url: null, fetchedAt: ctx.now,
        sourceUpdatedAt: null, tradable: null, quality: 'ok',
      };
      await storeAndEvaluate(ctx, it, [best], false, prevQuotes.get(it.id) ?? [], prevSignals.get(it.id) ?? new Map());
    }
  } catch (e) {
    await db.sourceFail(ctx.db, 'csfloat', statusFor(e), (e as Error).message, ctx.now, requests);
    throw e;
  }
  if (requests > 0) await db.sourceOk(ctx.db, 'csfloat', ctx.now, requests);
}

/** Skinport /v1/items: один запрос на весь список наблюдения. Пересчёт сигналов — отдельной задачей eval. */
export async function jobSkinportItems(ctx: Ctx): Promise<void> {
  if (ctx.settings.src_skinport !== '1') { await db.sourceDisabled(ctx.db, 'skinport', 'выключено в настройках'); return; }
  const items = await db.allWatchedNames(ctx.db);
  if (items.length === 0 || !spendExternal(ctx)) return;
  bump(ctx, 'ext_requests');
  try {
    const found = await fetchSkinportItems(new Set(items.map((i) => i.market_hash_name)), ctx.now, ctx.fetcher);
    const prev = await db.quotesBySource(ctx.db, 'skinport', ['lowest_listing']);
    const stmts: D1PreparedStatement[] = [];
    for (const it of items) {
      // Нет в каталоге → предложений нет (quantity 0), а не «цена 0».
      const q: Quote = found.get(it.market_hash_name) ?? {
        source: 'skinport', marketHashName: it.market_hash_name, priceType: 'lowest_listing', priceMinor: null, currency: 'EUR',
        quantity: 0, volume: null, volumePeriod: null, listingId: null, floatValue: null, paintSeed: null, url: null,
        fetchedAt: ctx.now, sourceUpdatedAt: null, tradable: null, quality: 'ok',
      };
      const { kop, fxId } = await convert(ctx, q);
      const w = db.quoteWrites(ctx.db, it.id, q, kop, fxId, prev.get(`${it.id}:lowest_listing`) ?? null);
      stmts.push(...w.stmts, db.markEvalStmt(ctx.db, it.id, 1));
      if (w.snapshot) bump(ctx, 'snapshots');
    }
    await chunkedBatch(ctx, stmts);
    await db.sourceOk(ctx.db, 'skinport', ctx.now, 1);
  } catch (e) {
    await db.sourceFail(ctx.db, 'skinport', statusFor(e), (e as Error).message, ctx.now, 1);
    throw e;
  }
}

/** Skinport /v1/sales/history: продажи за 7/30 дней — данные о ликвидности. Порциями по курсору. */
export async function jobSkinportSales(ctx: Ctx, cursor: string | null): Promise<string | null> {
  if (ctx.settings.src_skinport !== '1') return cursor;
  const items = (await db.allWatchedNames(ctx.db)).sort((a, b) => a.id - b.id);
  if (items.length === 0 || !spendExternal(ctx)) return cursor;
  bump(ctx, 'ext_requests');
  const after = cursor ? Number(cursor) : 0;
  let chunk = items.filter((i) => i.id > after).slice(0, SKINPORT_SALES_CHUNK);
  if (chunk.length === 0) chunk = items.slice(0, SKINPORT_SALES_CHUNK);
  const byName = new Map(chunk.map((i) => [i.market_hash_name, i]));
  try {
    const quotes = await fetchSkinportSales([...byName.keys()], ctx.now, ctx.fetcher);
    const prev = await db.quotesBySource(ctx.db, 'skinport', ['sale_median_7d', 'sale_median_30d']);
    const stmts: D1PreparedStatement[] = [];
    for (const q of quotes) {
      const it = byName.get(q.marketHashName);
      if (!it) continue;
      const { kop, fxId } = await convert(ctx, q);
      const w = db.quoteWrites(ctx.db, it.id, q, kop, fxId, prev.get(`${it.id}:${q.priceType}`) ?? null);
      stmts.push(...w.stmts);
      if (w.snapshot) bump(ctx, 'snapshots');
    }
    await chunkedBatch(ctx, stmts);
    await db.sourceOk(ctx.db, 'skinport', ctx.now, 1);
  } catch (e) {
    await db.sourceFail(ctx.db, 'skinport', statusFor(e), (e as Error).message, ctx.now, 1);
    throw e;
  }
  return String(chunk[chunk.length - 1].id);
}

/** Пересчёт сигналов для предметов, у которых обновились котировки массовых источников. */
export async function jobEvaluate(ctx: Ctx): Promise<void> {
  const due = await db.itemsNeedingEval(ctx.db, EVAL_PER_RUN);
  if (due.length === 0) return;
  const ids = due.map((x) => x.id);
  const flags = new Map(due.map((x) => [x.id, x.flag]));
  const items = await db.itemsWithTarget(ctx.db, ids);
  const quotes = await db.quotesForItems(ctx.db, ids);
  const signals = await db.signalsForItems(ctx.db, ids);
  for (const item of items) {
    if (!canD1(ctx, flags.get(item.id) === 2 ? 6 : 3)) break;
    await evaluateLoaded(ctx, item, quotes.get(item.id) ?? [], flags.get(item.id) === 2, [db.markEvalStmt(ctx.db, item.id, 0)], signals.get(item.id) ?? new Map());
  }
}

// ---------- Оценка предмета ----------

export interface EvalSettings {
  minProfitKop: number; minRoiBp: number; maxBuyKop: number; budgetKop: number; maxStaleSec: number;
  requireLiquidity: 'high' | 'medium' | 'low'; changeThresholdBp: number;
}

export function evalSettings(s: db.Settings): EvalSettings {
  const liq = s.min_liquidity === 'high' || s.min_liquidity === 'low' ? s.min_liquidity : 'medium';
  return {
    minProfitKop: db.num(s.min_profit_kop), minRoiBp: db.num(s.min_roi_bp), maxBuyKop: db.num(s.max_buy_kop),
    budgetKop: db.num(s.budget_kop), maxStaleSec: (db.num(s.max_stale_min) || 30) * 60, requireLiquidity: liq,
    changeThresholdBp: db.num(s.change_threshold_bp) || 1500,
  };
}

export function notifyPolicy(s: db.Settings, kindEnabled: boolean): NotifyPolicy {
  const mp = s.min_priority as Priority;
  return {
    cooldownSec: 6 * 3600, materialChangeBp: 2000, maxPerHour: db.num(s.max_per_hour) || 6,
    quietStart: db.num(s.quiet_start), quietEnd: db.num(s.quiet_end), notificationsEnabled: s.notify_enabled === '1',
    kindEnabled, minPriority: mp === 'high' || mp === 'medium' || mp === 'low' ? mp : 'medium',
  };
}

const prevForDecision = (p: db.SignalRow | undefined) =>
  p && (p.state !== 'expired' || p.notified_at) ? { state: p.state, spreadKop: p.spread_kop, buyKop: p.buy_kop, notifiedAt: p.notified_at, priority: p.priority } : null;

/**
 * Пересчитывает все сигналы предмета по уже загруженным котировкам.
 * Все изменения состояний копятся в pending и записываются одним batch в конце.
 */
export async function evaluateLoaded(ctx: Ctx, item: db.ItemRow, quotes: db.QuoteRow[], steamUpdated: boolean,
  pending: D1PreparedStatement[] = [], preSignals?: Map<string, db.SignalRow>): Promise<void> {
  const q = (source: string, type: string) => quotes.find((x) => x.source === source && x.price_type === type) ?? null;
  const steamLow = q('steam', 'lowest_listing');
  const steamMed = q('steam', 'median_24h');
  const es = evalSettings(ctx.settings);
  const signals = preSignals ?? await db.signalsForItem(ctx.db, item.id);

  if (steamUpdated && steamLow) await checkSteamEvents(ctx, item, steamLow, steamMed, es, signals, pending);

  if (steamLow || steamMed) {
    const steamSide = {
      lowestKop: steamLow?.price_kop ?? null, medianKop: steamMed?.price_kop ?? null,
      fetchedAt: Math.min(steamLow?.fetched_at ?? Number.MAX_SAFE_INTEGER, steamMed?.fetched_at ?? Number.MAX_SAFE_INTEGER),
    };
    const liquidity = classifyLiquidity({
      steamSales24h: steamMed?.volume ?? null, skinportSales7d: q('skinport', 'sale_median_7d')?.volume ?? null, activeListings: null,
    });
    const fx = await fxMap(ctx);
    for (const buyRow of [q('skinport', 'lowest_listing'), q('csfloat', 'listing')]) {
      if (!buyRow) continue;
      const key = dedupKey('arbitrage_steam', item.id, buyRow.source);
      const prev = signals.get(key);
      const rate = buyRow.currency === 'UAH' ? null : fx.get(buyRow.currency) ?? null;
      const arb = buyRow.price_kop !== null && (buyRow.quantity ?? 1) > 0
        ? computeSteamArbitrage({ source: buyRow.source, costKop: buyRow.price_kop, fetchedAt: buyRow.fetched_at }, steamSide) : null;
      const score = arb ? scoreArbitrage({
        arb, liquidity, uniquePriced: item.is_unique_priced === 1, buyQuantity: buyRow.quantity,
        buyAgeSec: ctx.now - buyRow.fetched_at, sellAgeSec: ctx.now - steamSide.fetchedAt,
        fxAgeDays: buyRow.currency === 'UAH' ? null : rate ? fxAgeDays(rate.rateDate, ctx.now) : 999,
        fxAvailable: buyRow.currency === 'UAH' || rate !== null,
        settings: { ...es, fxMaxAgeDays: FX_MAX_AGE_DAYS_HIGH },
      }) : null;
      if (!arb || !score || score.priority === null) { await expire(ctx, prev, pending, item.market_hash_name); continue; }

      const fresh = ctx.now - buyRow.fetched_at <= es.maxStaleSec && ctx.now - steamSide.fetchedAt <= es.maxStaleSec;
      if (!canD1(ctx, 2)) break;
      const sig = await db.upsertSignal(ctx.db, {
        dedupKey: key, kind: 'arbitrage_steam', itemId: item.id,
        state: prev?.state === 'notified' && fresh ? 'notified' : fresh ? 'confirmed' : 'unconfirmed',
        priority: score.priority, category: score.category, buySource: buyRow.source, sellSource: 'steam',
        buyKop: arb.purchaseCostKop, sellKop: arb.sellReferenceKop, proceedsKop: arb.expectedProceedsKop,
        spreadKop: arb.netSpreadKop, roiBp: arb.returnOnCostBp, reason: score.reasons.join('; '),
        snapshot: { buy: buyRow, steamLow, steamMed, fx: rate, arb, liquidity, reasons: score.reasons, at: ctx.now }, now: ctx.now,
      });
      if (!prev || prev.state === 'expired') bump(ctx, 'signals_new');
      // Уведомляем только о подтверждённых (свежие данные с обеих сторон) и доступных по бюджету.
      if (sig.state === 'dismissed' || !fresh || !score.affordable) continue;
      const d = decideNotify(notifyPolicy(ctx.settings, ctx.settings.sig_arbitrage === '1'), score.priority,
        { spreadKop: arb.netSpreadKop, buyKop: arb.purchaseCostKop }, prevForDecision(prev), await sentLastHour(ctx), warsawHour(ctx.now), ctx.now);
      if (!d.send) continue;
      const view = arbitrageMessage({
        signalId: sig.id, name: item.market_hash_name, buySource: buyRow.source, buyUrl: buyRow.url,
        buyOriginal: buyRow.price_minor !== null && buyRow.currency !== 'UAH' ? `${(buyRow.price_minor / 100).toFixed(2).replace('.', ',')} ${buyRow.currency}` : null,
        fxNote: rate ? `Курс НБУ: ${(rate.rateMicro / 1e6).toFixed(4).replace('.', ',')} грн за 1 ${rate.base}, дата курса ${rate.rateDate}` : null,
        arb, score, liquidity, dataAt: Math.min(buyRow.fetched_at, steamSide.fetchedAt), now: ctx.now,
      });
      await fanout(ctx, item.id, { kind: 'arbitrage', ref: String(sig.id), signalId: sig.id, priority: score.priority,
        spreadKop: arb.netSpreadKop, roiBp: arb.returnOnCostBp, buyKop: arb.purchaseCostKop, text: view.text, keyboard: view.keyboard }, pending);
    }
  }
  if (pending.length) await ctx.db.batch(pending);
}

async function expire(ctx: Ctx, prev: db.SignalRow | undefined, pending: D1PreparedStatement[], name = ''): Promise<void> {
  if (!prev || !['confirmed', 'notified', 'unconfirmed'].includes(prev.state)) return;
  pending.push(db.setStateStmt(ctx.db, prev.id, 'expired', ctx.now));
  bump(ctx, 'signals_expired');
  // Отправленное сообщение помечаем правкой, а не новым сообщением — без спама.
  if (prev.state === 'notified' || prev.notified_at) {
    pending.push(enqueueEditsStmt(ctx.db, prev.id,
      `⚫ <b>НЕАКТУАЛЬНО${name ? ` · ${esc(name)}` : ''}</b>\nЭта сделка больше не выгодна: цены изменились (проверка ${warsawDate(ctx.now).split('-').reverse().join('.')} в ${String(warsawHour(ctx.now)).padStart(2, '0')}:${new Date(ctx.now * 1000).toISOString().slice(14, 16)} по Варшаве).\nЕсли выгода вернётся — бот напишет снова, но не чаще раза в 6 часов.`, ctx.now));
  }
}

/** Прямая отправка администратору (технические предупреждения). */
async function sendAdmin(ctx: Ctx, kind: string, ref: string, text: string, keyboard: Keyboard, signalId: number | null, pending: D1PreparedStatement[]): Promise<boolean> {
  if (!spendExternal(ctx)) return false;
  try {
    const m = await ctx.tg.sendMessage(ctx.adminId, text, keyboard);
    pending.push(ctx.db.prepare('INSERT INTO notification_log (telegram_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)').bind(ctx.adminId, kind, ref, ctx.now));
    if (signalId !== null) pending.push(db.markNotifiedStmt(ctx.db, signalId, m.message_id, ctx.now));
    ctx.cache.sentLastHour = (ctx.cache.sentLastHour ?? 0) + 1;
    bump(ctx, 'notifications');
    return true;
  } catch (e) {
    await db.log(ctx.db, 'error', 'telegram', 'send', (e as Error).message, ctx.now);
    return false;
  }
}

async function checkSteamEvents(ctx: Ctx, item: db.ItemRow, low: db.QuoteRow, med: db.QuoteRow | null, es: EvalSettings,
  signals: Map<string, db.SignalRow>, pending: D1PreparedStatement[]): Promise<void> {
  const url = steamListingUrl(item.market_hash_name);

  // Целевые цены из списков наблюдения: у каждого своя. Сигнал — на каждое значение цели, получатели — у кого она такая.
  const anyTarget = item.target_buy_kop ?? null;
  const targets = anyTarget && low.price_kop !== null && low.price_kop <= anyTarget && canD1(ctx, 4)
    ? [...new Set((await watchersOf(ctx, item.id)).filter((w) => w.target !== null && low.price_kop! <= w.target).map((w) => w.target!))].slice(0, 5) : [];
  for (const target of targets) {
    if (!canD1(ctx, 3) || low.price_kop === null) break;
    const key = dedupKey('target_price', item.id, 'steam', String(target));
    const prev = signals.get(key);
    const sig = await db.upsertSignal(ctx.db, {
      dedupKey: key, kind: 'target_price', itemId: item.id, state: prev?.state === 'notified' ? 'notified' : 'confirmed', priority: 'high',
      category: null, buySource: 'steam', sellSource: null, buyKop: low.price_kop, sellKop: null, proceedsKop: null, spreadKop: null,
      roiBp: null, reason: 'цена ниже целевой', snapshot: { low, at: ctx.now }, now: ctx.now,
    });
    const d = decideNotify(notifyPolicy(ctx.settings, ctx.settings.sig_target === '1'), 'high', { spreadKop: null, buyKop: low.price_kop },
      prevForDecision(prev), await sentLastHour(ctx), warsawHour(ctx.now), ctx.now);
    if (d.send && sig.state !== 'dismissed') {
      const m = targetMessage(item.market_hash_name, low.price_kop, target, url);
      const who = (await watchersOf(ctx, item.id)).filter((w) => w.target === target).map((w) => w.tid);
      await fanout(ctx, item.id, { kind: 'target', ref: String(sig.id), signalId: sig.id, priority: 'high', text: m.text, keyboard: m.keyboard }, pending, who);
    }
  }

  await checkInventory(ctx, item, low, med, es, signals, pending);

  // Резкое изменение самого дешёвого объявления Steam. Steam отдаёт цену сразу в UAH — курс не участвует.
  if (!canD1(ctx, 3)) return;
  const hist = await db.history(ctx.db, item.id, 'steam', 'lowest_listing', ctx.now - 8 * 86400);
  const points: PricePoint[] = hist.filter((h) => h.observed_at < low.fetched_at)
    .map((h) => ({ at: h.observed_at, minor: h.price_minor, currency: h.currency, volume: h.volume }));
  const ev = detectChanges({ at: low.fetched_at, minor: low.price_minor, currency: low.currency, volume: med?.volume ?? null }, points, ctx.now, es.changeThresholdBp)[0];
  if (!ev) return;
  const key = dedupKey(ev.kind, item.id, 'steam', ev.period);
  const prev = signals.get(key);
  // Скачки у малоликвидных предметов — низкий приоритет (по умолчанию без уведомления).
  const priority: Priority = (med?.volume ?? 0) >= 10 ? 'medium' : 'low';
  const sig = await db.upsertSignal(ctx.db, {
    dedupKey: key, kind: ev.kind, itemId: item.id, state: prev?.state === 'notified' ? 'notified' : 'confirmed', priority,
    category: 'anomaly', buySource: 'steam', sellSource: null, buyKop: low.price_kop, sellKop: null, proceedsKop: null,
    spreadKop: null, roiBp: ev.changeBp, reason: `изменение ${(ev.changeBp / 100).toFixed(1)}% за ${ev.period}`, snapshot: { ev, low, med, at: ctx.now }, now: ctx.now,
  });
  const d = decideNotify(notifyPolicy(ctx.settings, ctx.settings.sig_change === '1'), priority, { spreadKop: null, buyKop: low.price_kop },
    prevForDecision(prev), await sentLastHour(ctx), warsawHour(ctx.now), ctx.now);
  if (d.send && sig.state !== 'dismissed') {
    const m = changeMessage(item.market_hash_name, ev, ev.fromMinor, ev.toMinor, 'самое дешёвое объявление', med?.volume ?? null, url);
    await fanout(ctx, item.id, { kind: 'change', ref: String(sig.id), signalId: sig.id, priority, text: m.text, keyboard: m.keyboard }, pending);
  }
}

/** Уведомления по инвентарю: изменение оценки относительно цены покупки и достижение цели продажи. */
async function checkInventory(ctx: Ctx, item: db.ItemRow, low: db.QuoteRow, med: db.QuoteRow | null, es: EvalSettings,
  signals: Map<string, db.SignalRow>, pending: D1PreparedStatement[]): Promise<void> {
  if (!canD1(ctx, 4)) return;
  const lots = await T.openTradesForItem(ctx.db, item.id);
  if (lots.length === 0) return;
  const v = valuation(low.price_kop, med?.price_kop ?? null, null);
  for (const lot of lots) {
    const lv = viewLot(lot, v);
    if (lv.unrealizedRoiBp === null || lv.openQty === 0 || !canD1(ctx, 3)) continue;
    const url = steamListingUrl(item.market_hash_name);
    // Цель продажи: самое дешёвое объявление Steam достигло цели (цена покупателя).
    if (lot.target_sell_kop && low.price_kop !== null && low.price_kop >= lot.target_sell_kop) {
      const key = dedupKey('inventory_target', item.id, 'steam', `${lot.id}:${lot.target_sell_kop}`);
      const prev = signals.get(key);
      const sig = await db.upsertSignal(ctx.db, {
        dedupKey: key, kind: 'inventory_target', itemId: item.id, state: prev?.state === 'notified' ? 'notified' : 'confirmed', priority: 'high',
        category: null, buySource: null, sellSource: 'steam', buyKop: null, sellKop: low.price_kop, proceedsKop: v.steamProceedsPerUnit,
        spreadKop: lv.unrealizedSteamKop, roiBp: lv.unrealizedRoiBp, reason: 'цель продажи достигнута', snapshot: { lot: lot.id, low, at: ctx.now }, now: ctx.now,
      });
      const d = decideNotify(notifyPolicy(ctx.settings, ctx.settings.sig_inventory === '1'), 'high', { spreadKop: null, buyKop: low.price_kop },
        prevForDecision(prev), await sentLastHour(ctx), warsawHour(ctx.now), ctx.now);
      if (d.send && sig.state !== 'dismissed') {
        await fanout(ctx, item.id, { kind: 'inventory', ref: String(sig.id), signalId: sig.id, priority: 'high', keyboard: [[{ text: 'Открыть Steam Market', url }], [{ text: '💸 Продал', callback_data: `sl:${lot.id}` }]], text:
          `🎯 <b>ЦЕЛЬ ПРОДАЖИ ДОСТИГНУТА</b>\n\n<b>${esc(item.market_hash_name)}</b>\nСамое дешёвое объявление Steam: ${formatUah(low.price_kop)} (цель ${formatUah(lot.target_sell_kop)})\nОценка на баланс после комиссий: ${formatUah(v.steamProceedsPerUnit)}/шт.\nОценочная разница по позиции: ${formatUah(lv.unrealizedSteamKop)} — это ещё не прибыль, пока не продано.` }, pending, [lot.telegram_id]);
      }
    }
    // Изменение оценки относительно покупки: уведомление при переходе в новую «корзину» порога (по умолчанию каждые 15%).
    const bucket = roiBucket(lv.unrealizedRoiBp, es.changeThresholdBp);
    if (bucket === 0) continue;
    const key = dedupKey('inventory_change', item.id, 'steam', `${lot.id}:${bucket}`);
    const prev = signals.get(key);
    if (prev) continue; // эта корзина уже была
    const sig = await db.upsertSignal(ctx.db, {
      dedupKey: key, kind: 'inventory_change', itemId: item.id, state: 'confirmed', priority: 'medium', category: null,
      buySource: null, sellSource: 'steam', buyKop: lot.buy_price_kop, sellKop: low.price_kop, proceedsKop: v.steamProceedsPerUnit,
      spreadKop: lv.unrealizedSteamKop, roiBp: lv.unrealizedRoiBp, reason: `оценка ${(lv.unrealizedRoiBp / 100).toFixed(1)}% к покупке`, snapshot: { lot: lot.id, low, at: ctx.now }, now: ctx.now,
    });
    const d = decideNotify(notifyPolicy(ctx.settings, ctx.settings.sig_inventory === '1'), 'medium', { spreadKop: lv.unrealizedSteamKop, buyKop: null },
      null, await sentLastHour(ctx), warsawHour(ctx.now), ctx.now);
    if (d.send) {
      const up = lv.unrealizedRoiBp > 0;
      await fanout(ctx, item.id, { kind: 'inventory', ref: String(sig.id), signalId: sig.id, priority: 'medium', keyboard: [[{ text: 'Открыть Steam Market', url }], [{ text: 'Позиция', callback_data: `iv:${lot.id}` }]], text:
        `${up ? '📈' : '📉'} <b>ИНВЕНТАРЬ: ${up ? 'ПОДОРОЖАЛ' : 'ПОДЕШЕВЕЛ'}</b>\n\n<b>${esc(item.market_hash_name)}</b> ×${lv.openQty}\nОценка к цене покупки: ${formatBp(lv.unrealizedRoiBp)}\nСебестоимость: ${formatUah(lv.openCostKop)} → оценка в Steam: ${formatUah(lv.steamValueKop)} (на баланс, после комиссий)\n<i>Это оценка, а не прибыль.</i>` }, pending, [lot.telegram_id]);
    }
  }
}

/** Этап 5: через 24 ч проверяем, сохранилась бы выгода у отправленного/подтверждённого сигнала. */
export async function jobQuality(ctx: Ctx): Promise<void> {
  const horizon = 24 * 3600;
  const due = (await ctx.db.prepare(
    `SELECT s.id, s.item_id, s.buy_kop, s.spread_kop, s.detected_at FROM signals s
     WHERE s.kind = 'arbitrage_steam' AND s.state IN ('notified','confirmed','expired','unconfirmed') AND s.buy_kop IS NOT NULL
       AND s.detected_at <= ? AND s.detected_at >= ? AND NOT EXISTS (SELECT 1 FROM signal_quality q WHERE q.signal_id = s.id)
     ORDER BY s.detected_at LIMIT 8`,
  ).bind(ctx.now - horizon, ctx.now - 7 * 86400).all<{ id: number; item_id: number; buy_kop: number; spread_kop: number | null; detected_at: number }>()).results;
  const writes: D1PreparedStatement[] = [];
  for (const sg of due) {
    if (!canD1(ctx, 3)) break;
    const t = sg.detected_at + horizon;
    const rows = (await ctx.db.prepare(
      `SELECT price_type, observed_at, price_kop FROM price_snapshots WHERE item_id = ? AND source = 'steam'
       AND price_type IN ('lowest_listing','median_24h') AND observed_at BETWEEN ? AND ? ORDER BY observed_at`,
    ).bind(sg.item_id, t - 6 * 3600, t).all<{ price_type: string; observed_at: number; price_kop: number | null }>()).results;
    const low = rows.filter((r) => r.price_type === 'lowest_listing').map((r) => ({ t: r.observed_at, v: r.price_kop }));
    const med = rows.filter((r) => r.price_type === 'median_24h').map((r) => ({ t: r.observed_at, v: r.price_kop }));
    const o = outcomeAfter(sg.buy_kop, low, med, sg.detected_at, horizon);
    writes.push(ctx.db.prepare(
      `INSERT OR IGNORE INTO signal_quality (signal_id, checked_at, horizon_sec, spread_then_kop, spread_later_kop, outcome) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(sg.id, ctx.now, horizon, sg.spread_kop, o.spreadKop, o.outcome));
  }
  if (writes.length) await ctx.db.batch(writes);
}

// ---------- Обслуживание ----------

export async function jobCleanup(ctx: Ctx): Promise<void> {
  const cutoff = ctx.now - 30 * 86400;
  // Перед удалением старых снимков — дневные агрегаты (минимум/максимум/среднее/последнее).
  await ctx.db.batch([
    ctx.db.prepare(
      `INSERT OR REPLACE INTO price_daily (item_id, source, price_type, day, currency, min_minor, max_minor, avg_minor, last_minor, samples)
       SELECT item_id, source, price_type, strftime('%Y-%m-%d', observed_at, 'unixepoch') AS day, currency,
              MIN(price_minor), MAX(price_minor), CAST(AVG(price_minor) AS INTEGER),
              (SELECT p2.price_minor FROM price_snapshots p2 WHERE p2.item_id = p.item_id AND p2.source = p.source AND p2.price_type = p.price_type
                 AND strftime('%Y-%m-%d', p2.observed_at, 'unixepoch') = strftime('%Y-%m-%d', p.observed_at, 'unixepoch')
               ORDER BY p2.observed_at DESC LIMIT 1),
              COUNT(*)
       FROM price_snapshots p WHERE observed_at < ? GROUP BY item_id, source, price_type, day, currency`,
    ).bind(cutoff),
    ctx.db.prepare('DELETE FROM price_snapshots WHERE observed_at < ?').bind(cutoff),
    ctx.db.prepare('DELETE FROM system_logs WHERE at < ?').bind(ctx.now - 14 * 86400),
    ctx.db.prepare('DELETE FROM notification_log WHERE sent_at < ?').bind(ctx.now - 30 * 86400),
    ctx.db.prepare('DELETE FROM user_state WHERE expires_at < ?').bind(ctx.now),
    ctx.db.prepare("UPDATE signals SET state = 'expired' WHERE state IN ('confirmed','unconfirmed') AND updated_at < ?").bind(ctx.now - 6 * 3600),
    ctx.db.prepare('DELETE FROM usage_counters WHERE day < ?').bind(utcDay(ctx.now - 60 * 86400)),
    // Волатильность за 7 дней для приоритизации опроса.
    ctx.db.prepare(
      `UPDATE items SET volatility_bp = (
         SELECT CASE WHEN AVG(price_minor) > 0 THEN CAST((MAX(price_minor) - MIN(price_minor)) * 10000.0 / AVG(price_minor) AS INTEGER) END
         FROM price_snapshots p WHERE p.item_id = items.id AND p.source = 'steam' AND p.price_type = 'lowest_listing' AND p.observed_at >= ?)
       WHERE id IN (SELECT item_id FROM watchlist WHERE active = 1)`,
    ).bind(ctx.now - 7 * 86400),
  ]);
}

/** Технические предупреждения: источник недоступен дольше 30 минут — одно сообщение на эпизод. */
export async function jobHealth(ctx: Ctx): Promise<void> {
  const rows = await db.listSourceStatus(ctx.db);
  const pending: D1PreparedStatement[] = [];
  // Внешний сборщик молчит дольше 45 минут — одно предупреждение на эпизод.
  if (ctx.env.COLLECTOR === 'github') {
    const c = rows.find((r) => r.source === 'collector');
    const last = c?.last_ok_at ?? null;
    if ((!last || ctx.now - last > 45 * 60) && !(c?.alerted_at && (!last || c.alerted_at > last))) {
      const sent = await sendAdmin(ctx, 'tech', 'collector',
        `⚠️ <b>Сборщик цен (GitHub Actions) не присылает данные</b> ${last ? `уже ${Math.floor((ctx.now - last) / 60)} мин` : 'ни разу'}.\nПроверь вкладку Actions в репозитории: включены ли workflows и нет ли ошибок. Цены Steam и Skinport сейчас не обновляются.`,
        [], null, pending);
      if (sent) pending.push(ctx.db.prepare(
        `INSERT INTO source_status (source, status, alerted_at) VALUES ('collector', 'down', ?)
         ON CONFLICT(source) DO UPDATE SET status = 'down', alerted_at = excluded.alerted_at`,
      ).bind(ctx.now));
    }
  }
  for (const r of rows) {
    if (r.source === 'collector') continue;
    if (!r.down_since || r.status === 'disabled' || r.status === 'ok') continue;
    // Ограничение Steam (429) у сборщика GitHub — обычное дело и проходит само; подсказки тем временем берут цены
    // из суточного прайса Steam. Предупреждаем только если это тянется дольше 3 часов.
    const soft = r.source === 'steam' && r.status === 'rate_limited';
    if (ctx.now - r.down_since < (soft ? 3 * 3600 : 1800)) continue;
    if (r.alerted_at && r.alerted_at >= r.down_since) continue;
    const mins = Math.floor((ctx.now - r.down_since) / 60);
    const name = r.source === 'nbu' ? 'Курсы НБУ' : r.source;
    const sent = await sendAdmin(ctx, 'tech', r.source,
      soft
        ? `⚠️ <b>Steam</b> ограничивает запросы уже ${Math.floor(mins / 60)} ч (ответ 429 серверам GitHub).\nЖивые цены Steam не обновляются, подсказки и рекомендации пока считаются по суточному прайсу Steam. Ничего делать не нужно — бот продолжает пробовать каждые 10 минут.`
        : `⚠️ <b>${name}</b> недоступен ${mins} мин.\nПоследняя ошибка: ${r.last_error ?? '—'}\nСравнения с этим источником временно не обновляются. Остальные источники продолжают работать.`,
      [], null, pending);
    if (sent) pending.push(ctx.db.prepare('UPDATE source_status SET alerted_at = ? WHERE source = ?').bind(ctx.now, r.source));
  }
  if (pending.length) await ctx.db.batch(pending);
}

/** Ежедневная сводка — каждому, у кого она включена и наступил его час. До 4 человек за запуск (лимиты вызова). */
export async function jobDailyReport(ctx: Ctx): Promise<void> {
  const today = warsawDate(ctx.now);
  const hour = warsawHour(ctx.now);
  // Кому ещё не отправляли сегодня: пользователи без отметки last_daily_report = сегодня.
  const cands = (await ctx.db.prepare(
    `SELECT u.telegram_id AS tid FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_settings s WHERE s.telegram_id = u.telegram_id AND s.key = 'last_daily_report' AND s.value = ?)
       AND (EXISTS (SELECT 1 FROM watchlist w WHERE w.telegram_id = u.telegram_id AND w.active = 1)
            OR EXISTS (SELECT 1 FROM trades t WHERE t.telegram_id = u.telegram_id))
     ORDER BY u.telegram_id LIMIT 40`,
  ).bind(today).all<{ tid: number }>()).results.map((r) => r.tid);
  if (!cands.length) return;
  const st = await loadUserSettings(ctx.db, cands);
  const due = cands.filter((t) => { const s = st.get(t)!; return s.daily_report === '1' && hour >= (db.num(s.daily_hour) || 20); }).slice(0, 4);
  const pending: D1PreparedStatement[] = [];
  for (const tid of due) {
    if (!canD1(ctx, 6)) break;
    const pf = await portfolioSummary(ctx.db, tid, today);
    const top = (await ctx.db.prepare(
      `SELECT i.market_hash_name AS name, s.spread_kop FROM signals s JOIN items i ON i.id = s.item_id
       JOIN watchlist w ON w.item_id = s.item_id AND w.telegram_id = ? AND w.active = 1
       WHERE s.kind = 'arbitrage_steam' AND s.state IN ('confirmed','notified') AND s.updated_at >= ?
         AND NOT EXISTS (SELECT 1 FROM hidden_signals h WHERE h.telegram_id = ? AND h.signal_id = s.id)
       ORDER BY s.spread_kop DESC LIMIT 3`,
    ).bind(tid, ctx.now - 86400, tid).all<{ name: string; spread_kop: number | null }>()).results;
    const lines = [
      `📊 <b>Сводка за ${today}</b>`, '',
      '<b>Твои сделки за день</b>',
      `• на баланс Steam: ${formatUah(pf.realizedSteamToday)}`,
      `• деньгами: ${formatUah(pf.realizedCashToday)}`,
      `• продаж: ${pf.salesToday}`,
      '<b>Инвентарь (оценка, не прибыль)</b>',
      pf.openLots ? `• позиций: ${pf.openLots}; куплено за ${formatUah(pf.inventoryCost)} → оценка в Steam ${formatUah(pf.inventoryValue)}${pf.inventoryUnknown ? ` (+${pf.inventoryUnknown} без цены)` : ''}` : '• пусто',
      '<b>Возможности по твоему списку</b> (это ещё не доход):',
      ...(top.length ? top.map((x) => `• ${esc(x.name)}: ${formatUah(x.spread_kop)}`) : ['• сейчас нет']),
      '', 'Рекомендации по всему рынку — в приложении, вкладка «Рекомендации».',
    ];
    pending.push(enqueueStmt(ctx.db, tid, { kind: 'inventory', ref: `daily:${today}`, signalId: null, priority: 'low', text: lines.join('\n'), keyboard: [] }, ctx.now, ctx.now));
    pending.push(ctx.db.prepare(
      `INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'last_daily_report', ?, ?)
       ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(tid, today, ctx.now));
  }
  // Сегодня не нужно (выключено или час не наступил) — проверим в следующий раз; выключенным ставим отметку, чтобы не перебирать.
  for (const t of cands) if (st.get(t)!.daily_report !== '1') pending.push(ctx.db.prepare(
    `INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'last_daily_report', ?, ?)
     ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(t, today, ctx.now));
  if (pending.length) await ctx.db.batch(pending);
}

/**
 * Отправка очереди уведомлений. Лимиты: внешние запросы вызова, лимит «в час» у каждого человека.
 * Неактуальные к моменту отправки сделки не отправляются. Заблокировавшим бота — больше не пишем.
 */
export const OUTBOX_PER_RUN = 25;
export async function jobOutbox(ctx: Ctx): Promise<void> {
  const rows = (await ctx.db.prepare(
    `SELECT id, telegram_id, kind, signal_id, text, keyboard, edit_msg_id, created_at FROM outbox
     WHERE state = 'pending' AND not_before <= ? ORDER BY edit_msg_id IS NULL, not_before LIMIT ?`,
  ).bind(ctx.now, OUTBOX_PER_RUN).all<{ id: number; telegram_id: number; kind: string; signal_id: number | null; text: string; keyboard: string | null; edit_msg_id: number | null; created_at: number }>()).results;
  if (!rows.length) return;
  const tids = [...new Set(rows.map((r) => r.telegram_id))];
  const sigIds = [...new Set(rows.map((r) => r.signal_id).filter((x): x is number => x !== null))];
  const [st, sent, sigs] = await Promise.all([
    loadUserSettings(ctx.db, tids),
    ctx.db.prepare(`SELECT telegram_id, COUNT(*) AS n FROM outbox WHERE state = 'sent' AND edit_msg_id IS NULL AND sent_at >= ? AND telegram_id IN (${tids.map(() => '?').join(',')}) GROUP BY telegram_id`)
      .bind(ctx.now - 3600, ...tids).all<{ telegram_id: number; n: number }>(),
    sigIds.length ? ctx.db.prepare(`SELECT id, state FROM signals WHERE id IN (${sigIds.map(() => '?').join(',')})`).bind(...sigIds).all<{ id: number; state: string }>() : Promise.resolve({ results: [] as { id: number; state: string }[] }),
  ]);
  const count = new Map(sent.results.map((r) => [r.telegram_id, r.n]));
  const sigState = new Map(sigs.results.map((r) => [r.id, r.state]));
  const upd: D1PreparedStatement[] = [];
  const drop = (id: number) => upd.push(ctx.db.prepare(`UPDATE outbox SET state = 'dropped' WHERE id = ?`).bind(id));
  const blocked = new Set<number>();
  for (const r of rows) {
    if (blocked.has(r.telegram_id)) { drop(r.id); continue; }
    if (r.signal_id !== null && !['confirmed', 'notified'].includes(sigState.get(r.signal_id) ?? '')) { drop(r.id); continue; }
    if (r.edit_msg_id === null) {
      if (ctx.now - r.created_at > 12 * 3600) { drop(r.id); continue; } // устарело (например, долго ждало конца тихих часов)
      const limit = db.num(st.get(r.telegram_id)?.max_per_hour ?? '6') || 6;
      if ((count.get(r.telegram_id) ?? 0) >= limit) {
        upd.push(ctx.db.prepare('UPDATE outbox SET not_before = ? WHERE id = ?').bind(ctx.now + 600, r.id));
        continue;
      }
    }
    if (!spendExternal(ctx)) break;
    try {
      if (r.edit_msg_id !== null) {
        await ctx.tg.editMessage(r.telegram_id, r.edit_msg_id, r.text);
        upd.push(ctx.db.prepare(`UPDATE outbox SET state = 'sent', sent_at = ? WHERE id = ?`).bind(ctx.now, r.id));
      } else {
        const m = await ctx.tg.sendMessage(r.telegram_id, r.text, r.keyboard ? JSON.parse(r.keyboard) as Keyboard : undefined);
        upd.push(ctx.db.prepare(`UPDATE outbox SET state = 'sent', sent_at = ?, msg_id = ? WHERE id = ?`).bind(ctx.now, m.message_id, r.id));
        upd.push(ctx.db.prepare('INSERT INTO notification_log (telegram_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)').bind(r.telegram_id, r.kind, String(r.id), ctx.now));
        count.set(r.telegram_id, (count.get(r.telegram_id) ?? 0) + 1);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // 403: человек заблокировал бота / удалил чат — выключаем ему уведомления, чтобы не тратить лимиты.
      if (/\b403\b|Forbidden|blocked|deactivated|chat not found/i.test(msg)) {
        blocked.add(r.telegram_id);
        upd.push(ctx.db.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'notify_enabled', '0', ?)
          ON CONFLICT(telegram_id, key) DO UPDATE SET value = '0', updated_at = excluded.updated_at`).bind(r.telegram_id, ctx.now));
      } else if (r.edit_msg_id === null && !/\b429\b|Too Many Requests/i.test(msg)) {
        await db.log(ctx.db, 'warn', 'telegram', 'send', msg.slice(0, 300), ctx.now);
      }
      if (r.edit_msg_id !== null || blocked.has(r.telegram_id)) drop(r.id);
      if (/\b429\b|Too Many Requests/i.test(msg)) break;
    }
  }
  for (let i = 0; i < upd.length; i += 90) await ctx.db.batch(upd.slice(i, i + 90));
}

/**
 * Запуск сборщика цен на GitHub (workflow_dispatch). Расписание GitHub Actions срабатывает ненадёжно
 * (бывает, что не запускается часами), поэтому Worker «нажимает Run workflow» сам каждые 10 минут.
 * Без токена GH_DISPATCH_TOKEN ничего не делает. Если сборщик присылал данные меньше 6 минут назад — не трогаем.
 */
export async function jobKickCollector(ctx: Ctx): Promise<void> {
  const token = ctx.env.GH_DISPATCH_TOKEN?.trim();
  const repo = ctx.env.GH_REPO?.trim();
  if (ctx.env.COLLECTOR !== 'github' || !token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return;
  const st = (await db.listSourceStatus(ctx.db)).find((r) => r.source === 'collector');
  if (st?.last_ok_at && ctx.now - st.last_ok_at < 6 * 60) return;
  if (!spendExternal(ctx)) return;
  bump(ctx, 'ext_requests');
  const f = ctx.fetcher ?? fetch;
  const res = await f(`https://api.github.com/repos/${repo}/actions/workflows/collect.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cs2-market-bot', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) {
    const t = (await res.text()).slice(0, 200);
    await db.log(ctx.db, 'warn', 'collector', 'dispatch', `GitHub ответил ${res.status}: ${t}`, ctx.now);
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      await db.sourceFail(ctx.db, 'collector', 'down', `не получилось запустить сборщик: GitHub ${res.status} (проверь токен GH_DISPATCH_TOKEN)`, ctx.now, 1);
    }
  }
}

/** Автопостинг в канал/группу (если владелец привязал его командой /channel): сначала свежие обновления CS2, потом посты по расписанию. */
/** Сколько ждать картинку поста от сборщика (он запускается раз в ~10 минут, иногда с опозданием). */
export const CARD_WAIT_SEC = 25 * 60;

export async function jobChannel(ctx: Ctx): Promise<void> {
  const chat = await getMeta(ctx.db, 'channel_id');
  if (!chat) return;
  const writes: D1PreparedStatement[] = [];
  const user = await botUsername(ctx.db, ctx.tg);
  const post = async (text: string, kb: Keyboard, image: string | null): Promise<boolean> => {
    if (!spendExternal(ctx)) return false;
    try {
      await ctx.tg.sendMessage(Number(chat), text, kb, image);
      bump(ctx, 'channel_posts');
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      await db.log(ctx.db, 'warn', 'channel', 'post', msg.slice(0, 300), ctx.now);
      if (/Forbidden|not enough rights|chat not found|kicked/i.test(msg)) {
        writes.push(ctx.db.prepare(`DELETE FROM meta WHERE key = 'channel_id'`));
        await sendAdmin(ctx, 'tech', 'channel', `⚠️ Не получилось опубликовать пост в канал: ${esc(msg.slice(0, 200))}\nАвтопостинг выключен. Проверь, что бот — администратор с правом публиковать, и подключи снова: /channel`, [], null, writes);
      }
      return false;
    }
  };
  // 0. Пост, который ждёт свою картинку от сборщика (не дольше CARD_WAIT_SEC, потом — без неё).
  const pendRaw = await getMeta(ctx.db, 'channel_pending');
  if (pendRaw) {
    let pend: { id: string; text: string; image: string | null; at: number } | null = null;
    try { pend = JSON.parse(pendRaw); } catch { pend = null; }
    const card = pend ? await ctx.db.prepare('SELECT created_at FROM cards WHERE id = ?').bind(pend.id).first<{ created_at: number }>() : null;
    const origin = await getMeta(ctx.db, 'public_origin');
    if (!pend || (card && origin) || ctx.now - pend.at > CARD_WAIT_SEC) {
      writes.push(ctx.db.prepare(`DELETE FROM meta WHERE key IN ('channel_pending', 'card_request')`));
      if (pend) await post(pend.text, botButton(user), card && origin ? `${origin}/card/${pend.id}.jpg?v=${card.created_at}` : pend.image);
    }
    if (writes.length) await ctx.db.batch(writes);
    return;
  }
  // 1. Обновление CS2 — не старше 3 суток, по одному за запуск.
  // Ждём краткое содержание на русском до 45 минут после выхода обновления; дольше — публикуем как есть.
  const n = await ctx.db.prepare('SELECT * FROM news WHERE posted_at IS NULL AND published_at >= ? AND (summary_ru IS NOT NULL OR published_at < ?) ORDER BY published_at LIMIT 1')
    .bind(ctx.now - 3 * 86400, ctx.now - 45 * 60).first<NewsItem>();
  // Обновление уже вышло без перевода (по-английски), а перевод пришёл позже — отдельным постом «кратко на русском», один раз.
  const late = n ? null : await ctx.db.prepare('SELECT * FROM news WHERE posted_at IS NOT NULL AND posted_at >= ? AND summary_ru IS NOT NULL AND ru_posted_at IS NULL AND published_at >= ? ORDER BY published_at DESC LIMIT 1')
    .bind(ctx.now - 2 * 86400, ctx.now - 2 * 86400).first<NewsItem & { posted_at: number }>();
  if (late && newsRuLines(late)) {
    writes.push(ctx.db.prepare('UPDATE news SET ru_posted_at = ? WHERE gid = ?').bind(ctx.now, late.gid));
    await post(newsPost(late).replace('Обновление CS2', 'Обновление CS2 — кратко на русском'), [[{ text: '📰 Полный список в Steam', url: late.url }], ...botButton(user)], late.image ?? null);
  } else if (n) {
    if (newsRuLines(n)) writes.push(ctx.db.prepare('UPDATE news SET ru_posted_at = ? WHERE gid = ?').bind(ctx.now, n.gid));
    writes.push(ctx.db.prepare('UPDATE news SET posted_at = ? WHERE gid = ?').bind(ctx.now, n.gid));
    await post(newsPost(n), [[{ text: newsRuLines(n) ? '📰 Полный список в Steam' : '📰 Читать в Steam', url: n.url }], ...botButton(user)], n.image ?? null);
  } else {
    // 2. Посты по расписанию.
    const doneRows = (await ctx.db.prepare(`SELECT key, value FROM meta WHERE key LIKE 'channel_done_%'`).all<{ key: string; value: string }>()).results;
    const done = Object.fromEntries(ALL_SLOTS.map((k) => [k, doneRows.find((r) => r.key === `channel_done_${k}`)?.value ?? null])) as Record<Slot, string | null>;
    const slot = dueSlot(ctx.now, done);
    if (slot) {
      writes.push(setMetaStmt(ctx.db, `channel_done_${slot}`, warsawDate(ctx.now)));
      const p = await composeChannelPost(ctx.db, slot, ctx.now);
      if (p?.card) {
        // Сначала — картинка: сборщик нарисует её за ~10 минут, тогда и опубликуем.
        writes.push(setMetaStmt(ctx.db, 'channel_pending', JSON.stringify({ id: p.card.id, text: p.text, image: p.image, at: ctx.now })));
        writes.push(setMetaStmt(ctx.db, 'card_request', JSON.stringify(p.card)));
      } else if (p) await post(p.text, botButton(user), p.image);
    }
  }
  if (writes.length) await ctx.db.batch(writes);
}

/** Идеи дня записываются каждый день с 10:00, даже без канала: из них потом честная статистика «сработало / нет». */
export async function jobIdeas(ctx: Ctx): Promise<void> {
  if (warsawHour(ctx.now) < 10) return;
  const [scan, fx] = await Promise.all([loadScan(ctx.db), db.loadLatestFx(ctx.db)]);
  await ensureTodayIdeas(ctx.db, scan && ctx.now - scan.fetchedAt < 6 * 3600 ? scan.entries : null, fx, ctx.now);
}
