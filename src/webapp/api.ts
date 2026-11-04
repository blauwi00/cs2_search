// JSON API для Telegram Mini App. Каждый запрос подписан Telegram (initData) и принимается только от администратора.

import type { Env } from '../env.ts';
import * as db from '../storage/db.ts';
import * as T from '../storage/trades.ts';
import { budgetedDb, newBudget } from '../storage/budget.ts';
import { verifyInitData } from './auth.ts';
import { searchCatalog, catalogInfo } from '../catalog.ts';
import { parseMarketHashName, CATEGORY_RU } from '../core/normalization.ts';
import { classifyLiquidity, LIQUIDITY_RU } from '../core/liquidity.ts';
import { stats } from '../core/analyzer.ts';
import { valuation, viewLot, realizedStats, PLATFORMS, PLATFORM_RU, walletFor, parseDateInput, openQty } from '../core/portfolio.ts';
import { steamSellerProceeds } from '../core/fees.ts';
import { SETTINGS_META, parseSettingInput, displayValue } from '../telegram/settings.ts';
import { listJobs, setJobEnabled } from '../core/scheduler.ts';
import { warsawDate } from '../utils/time.ts';
import { steamListingUrl, safeLink } from '../utils/http.ts';
import { backtest } from '../core/quality.ts';
import { advise, ACTION_RANK, type Advice } from '../core/advice.ts';
import { buildRecs, MARKETS, type Rec } from '../core/recs.ts';
import { loadScan } from '../storage/scan.ts';

/** Рекомендации по всему рынку из последнего сканирования сборщика. Старше суток — не показываем. */
async function recsFor(d: D1Database, tid: number, now: number) {
  const [scan, fx, st] = await Promise.all([loadScan(d), db.loadLatestFx(d), db.getSettings(d, tid)]);
  if (!scan || now - scan.fetchedAt > 86400) return { fetchedAt: scan?.fetchedAt ?? null, scanned: 0, deals: [] as RecDto[], trends: [] as RecDto[] };
  const r = buildRecs(scan.entries, fx, {
    minProfitKop: db.num(st.min_profit_kop), minRoiBp: db.num(st.min_roi_bp), depositFeeBp: db.num(st.deposit_fee_bp), withdrawFeeBp: db.num(st.withdraw_fee_bp),
  });
  return { fetchedAt: scan.fetchedAt, scanned: scan.entries.length, stale: now - scan.fetchedAt > 2 * 3600, deals: r.deals.map(recDto), trends: r.trends.map(recDto) };
}
type RecDto = Rec & { buyUrl: string; sellUrl: string; category: string; buyName: string; sellName: string };
function recDto(r: Rec): RecDto {
  return { ...r, buyUrl: MARKETS[r.buyAt].url(r.name), sellUrl: MARKETS[r.sellAt].url(r.name), buyName: MARKETS[r.buyAt].name, sellName: MARKETS[r.sellAt].name,
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

async function adviceFor(d: D1Database, tid: number, now: number, items: { id: number; name: string }[]): Promise<Map<number, Advice>> {
  const out = new Map<number, Advice>();
  const ids = items.map((x) => x.id).slice(0, 360);
  if (!ids.length) return out;
  const [quotes, aggRows, deals, lots, s] = await Promise.all([
    quotesChunked(d, ids),
    chunkedAll(ids, async (p, ph) => (await d.prepare(`SELECT item_id, CAST(AVG(price_kop) AS INTEGER) AS avg, MIN(observed_at) AS first FROM price_snapshots
      WHERE source = 'steam' AND price_type = 'lowest_listing' AND price_kop IS NOT NULL AND observed_at >= ? AND item_id IN (${ph}) GROUP BY item_id`)
      .bind(now - 7 * 86400, ...p).all<{ item_id: number; avg: number | null; first: number }>()).results),
    db.activeSignals(d, 'spread', 90, now - 2 * 3600),
    T.openTrades(d, tid),
    db.getSettings(d, tid),
  ]);
  const aggBy = new Map(aggRows.map((r) => [r.item_id, r]));
  for (const it of items) {
    const q = quotes.get(it.id) ?? [];
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
    }));
  }
  return out;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const bad = (error: string, status = 400) => json({ ok: false, error }, status);

export async function handleAppApi(req: Request, env: Env, now: number, rawDb?: D1Database): Promise<Response> {
  const user = await verifyInitData(req.headers.get('X-Init-Data') ?? '', env.TELEGRAM_BOT_TOKEN, now);
  if (!user || user.id !== Number(env.ADMIN_TELEGRAM_ID)) return bad('forbidden', 403);
  const tid = user.id;
  const d = budgetedDb(rawDb ?? env.DB, newBudget());
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
    // ---------- Сводка ----------
    if (path === 'summary' && method === 'GET') {
      const [sources, watched, deals, lots, jobs] = await Promise.all([
        db.listSourceStatus(d), db.countActiveWatched(d), db.activeSignals(d, 'spread', 5, now - 2 * 3600), T.openTrades(d, tid), listJobs(d),
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
      const [recs, st] = await Promise.all([recsFor(d, tid, now), db.getSettings(d, tid)]);
      return json({
        notify: {
          enabled: st.notify_enabled === '1', maxPerHour: db.num(st.max_per_hour) || 6, quietStart: db.num(st.quiet_start), quietEnd: db.num(st.quiet_end),
          daily: st.daily_report === '1', dailyHour: db.num(st.daily_hour), watched,
        },
        ok: true, now, watched, actions,
        recs: { fetchedAt: recs.fetchedAt, deals: recs.deals.slice(0, 3), trends: recs.trends.slice(0, 2), total: recs.deals.length + recs.trends.length },
        cronAlive: lastRun > 0 && now - lastRun < 300,
        sources: sources.map((s) => ({ source: s.source, status: s.status, lastOk: s.last_ok_at, error: s.status !== 'ok' ? s.last_error ?? s.disabled_reason : null })),
        deals: deals.map(dealDto),
        inventory: { lots: lots.length, costKop: cost, valueKop: value, unknown },
        today: {
          steamKop: todays.filter((s) => s.wallet === 'steam_wallet').reduce((x, s) => x + s.received_kop - s.costKop, 0),
          cashKop: todays.filter((s) => s.wallet !== 'steam_wallet').reduce((x, s) => x + s.received_kop - s.costKop, 0),
          sales: todays.length,
        },
        lastPriceAt: Math.max(0, ...sources.filter((s) => s.source === 'steam' || s.source === 'skinport').map((s) => s.last_ok_at ?? 0)) || null,
      });
    }

    // ---------- Рекомендации по всему рынку ----------
    if (path === 'recs' && method === 'GET') {
      return json({ ok: true, ...(await recsFor(d, tid, now)) });
    }

    // ---------- Сделки ----------
    if (path === 'deals' && method === 'GET') {
      const order = url.searchParams.get('order') === 'roi' ? 'roi' : url.searchParams.get('order') === 'priority' ? 'priority' : 'spread';
      const rows = await db.activeSignals(d, order, 60, now - 2 * 3600);
      return json({ ok: true, deals: rows.map(dealDto) });
    }
    if (seg[0] === 'deals' && seg[2] === 'hide' && method === 'POST') {
      await db.setSignalState(d, Number(seg[1]), 'dismissed', now);
      return json({ ok: true });
    }

    // ---------- Поиск и наблюдение ----------
    if (path === 'search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 80);
      const cat = await catalogInfo(d);
      return json({ ok: true, results: q.length >= 2 ? await searchCatalog(d, q, 20) : [], catalog: cat });
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
      const histBy = new Map<number, typeof histAll>();
      for (const h of histAll) { const l = histBy.get(h.item_id) ?? []; l.push(h); histBy.set(h.item_id, l); }
      return json({
        ok: true,
        items: w.map((x) => {
          const q = quotes.get(x.item_id) ?? [];
          const g = (s: string, t: string) => q.find((y) => y.source === s && y.price_type === t);
          const low = g('steam', 'lowest_listing');
          const hist = histBy.get(x.item_id) ?? [];
          const ref = [...hist].reverse().find((hh) => hh.observed_at <= now - 24 * 3600) ?? hist[0];
          const ch = ref?.price_minor && low?.price_minor ? Math.trunc(((low.price_minor - ref.price_minor) * 10000) / ref.price_minor) : null;
          return {
            watchId: x.id, itemId: x.item_id, name: x.market_hash_name, category: x.category, categoryRu: CATEGORY_RU[x.category as 'case'] ?? x.category,
            steamLowKop: low?.price_kop ?? null, steamMedKop: g('steam', 'median_24h')?.price_kop ?? null, sales24h: g('steam', 'median_24h')?.volume ?? null,
            skinportKop: g('skinport', 'lowest_listing')?.price_kop ?? null, skinportQty: g('skinport', 'lowest_listing')?.quantity ?? null,
            change24hBp: ch, targetKop: x.target_buy_kop, updatedAt: low?.fetched_at ?? null, advice: adv.get(x.item_id) ?? null, img: imgs.get(x.market_hash_name) ?? null,
          };
        }),
      });
    }
    if (path === 'watch' && method === 'POST') {
      const names = (Array.isArray(body.names) ? body.names : [body.name]).filter((n): n is string => typeof n === 'string' && n.trim().length >= 3).map((n) => n.trim()).slice(0, 60);
      if (!names.length) return bad('name_required');
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
      const itemId = Number(seg[1]);
      const item = await db.getItem(d, itemId);
      if (!item) return bad('not_found', 404);
      const days = [7, 30].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
      const [quotes, rows, s] = await Promise.all([
        db.getQuotes(d, itemId),
        d.prepare(`SELECT source, price_type, observed_at, price_kop FROM price_snapshots WHERE item_id = ? AND observed_at >= ?
          AND ((source = 'steam' AND price_type IN ('lowest_listing','median_24h')) OR (source = 'skinport' AND price_type = 'lowest_listing'))
          ORDER BY observed_at LIMIT 3000`).bind(itemId, now - days * 86400).all<{ source: string; price_type: string; observed_at: number; price_kop: number | null }>(),
        db.getSettings(d, tid),
      ]);
      const g = (src: string, t: string) => quotes.find((x) => x.source === src && x.price_type === t) ?? null;
      const ser = (src: string, t: string) => rows.results.filter((r) => r.source === src && r.price_type === t).map((r) => ({ t: r.observed_at, v: r.price_kop }));
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
      const q = (r: db.QuoteRow | null) => (r ? { kop: r.price_kop, minor: r.price_minor, currency: r.currency, qty: r.quantity, volume: r.volume, at: r.fetched_at } : null);
      return json({
        ok: true,
        item: { id: item.id, name: item.market_hash_name, img: (await imagesFor(d, [item.market_hash_name])).get(item.market_hash_name) ?? null, category: p.category, categoryRu: CATEGORY_RU[p.category], stattrak: p.stattrak, souvenir: p.souvenir, uniquePriced: p.uniquePriced },
        quotes: { steamLow: q(g('steam', 'lowest_listing')), steamMed: q(g('steam', 'median_24h')), skinport: q(g('skinport', 'lowest_listing')), skinportSales7d: q(g('skinport', 'sale_median_7d')), csfloat: q(g('csfloat', 'listing')) },
        liquidity: { cls: liq.cls, ru: LIQUIDITY_RU[liq.cls], perDay: liq.salesPerDay, basis: liq.basis },
        series: { steamLow: ser('steam', 'lowest_listing'), steamMed: ser('steam', 'median_24h'), skinport: ser('skinport', 'lowest_listing') },
        stats: st, days, watchId: watch?.id ?? null, targetKop: watch?.target_buy_kop ?? null, advice, avg7Kop: avg7,
        backtest: bt, links: { steam: steamListingUrl(item.market_hash_name), skinport: safeLink(g('skinport', 'lowest_listing')?.url) },
      });
    }

    // ---------- Инвентарь и сделки ----------
    if (path === 'inventory' && method === 'GET') {
      const lots = await T.openTrades(d, tid);
      const [quotes, adv, imgs] = await Promise.all([
        quotesChunked(d, [...new Set(lots.map((l) => l.item_id))].slice(0, 360)),
        adviceFor(d, tid, now, [...new Map(lots.map((l) => [l.item_id, { id: l.item_id, name: l.market_hash_name }])).values()]),
        imagesFor(d, lots.map((l) => l.market_hash_name)),
      ]);
      return json({
        ok: true,
        platforms: PLATFORMS.map((p) => ({ v: p, t: PLATFORM_RU[p] })),
        lots: lots.map((l) => {
          const q = quotes.get(l.item_id) ?? [];
          const g = (s: string, t: string) => q.find((x) => x.source === s && x.price_type === t)?.price_kop ?? null;
          const val = valuation(g('steam', 'lowest_listing'), g('steam', 'median_24h'), g('skinport', 'lowest_listing'));
          const v = viewLot(l, val);
          return {
            id: l.id, itemId: l.item_id, name: l.market_hash_name, img: imgs.get(l.market_hash_name) ?? null, qty: l.quantity, openQty: v.openQty, buyKop: l.buy_price_kop, feeKop: l.buy_fee_kop,
            platform: l.buy_platform, platformRu: PLATFORM_RU[l.buy_platform] ?? l.buy_platform, date: l.buy_date, targetKop: l.target_sell_kop,
            costKop: v.openCostKop, steamUnitKop: val.steamProceedsPerUnit, externalUnitKop: val.externalPricePerUnit, valueKop: v.steamValueKop,
            unrealizedKop: v.unrealizedSteamKop, roiBp: v.unrealizedRoiBp, sold: l.sold_quantity, advice: adv.get(l.item_id) ?? null,
          };
        }),
      });
    }
    if (path === 'inventory' && method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const qty = Number(body.qty), price = Number(body.priceKop), fee = Number(body.feeKop ?? 0);
      const platform = String(body.platform ?? '');
      const date = parseDateInput(String(body.date ?? 'сегодня'), warsawDate(now));
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
      return json({ ok: true, id });
    }
    if (seg[0] === 'inventory' && seg[2] === 'sell' && method === 'POST') {
      const id = Number(seg[1]);
      const qty = Number(body.qty), price = Number(body.priceKop);
      const platform = String(body.platform ?? '');
      const date = parseDateInput(String(body.date ?? 'сегодня'), warsawDate(now));
      if (!(PLATFORMS as readonly string[]).includes(platform) || platform === 'gift') return bad('Выбери площадку');
      if (!Number.isSafeInteger(price) || price <= 0) return bad('Неверная цена');
      if (!date) return bad('Неверная дата');
      let received = Number(body.receivedKop);
      if (body.receivedKop === undefined || body.receivedKop === null || body.receivedKop === '') {
        if (platform !== 'steam') return bad('Укажи, сколько фактически получил');
        const p = steamSellerProceeds(price);
        if (!p) return bad('Цена ниже минимальной в Steam');
        received = p.sellerReceives * qty;
      }
      if (!Number.isSafeInteger(received) || received < 0) return bad('Неверная полученная сумма');
      try {
        const r = await T.addSale(d, tid, { tradeId: id, quantity: qty, sellPriceKop: price, receivedKop: received, platform, sellDate: date, now });
        return json({ ok: true, resultKop: received - r.costKop, costKop: r.costKop, receivedKop: received, wallet: walletFor(platform), closed: r.closed });
      } catch (e) {
        return bad((e as Error).message);
      }
    }
    if (seg[0] === 'inventory' && seg[1] && method === 'DELETE') {
      return json({ ok: await T.deleteTrade(d, tid, Number(seg[1])) });
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
      return json({
        ok: true, stats: st,
        sales: sales.slice(-50).reverse().map((s) => ({
          name: byId.get(s.trade_id)?.market_hash_name ?? '', qty: s.quantity, receivedKop: s.received_kop, costKop: s.costKop,
          resultKop: s.received_kop - s.costKop, wallet: s.wallet, date: s.sell_date,
        })),
        open: trades.filter((t) => openQty(t) > 0).length,
      });
    }

    // ---------- Настройки и состояние ----------
    if (path === 'settings' && method === 'GET') {
      const s = await db.getSettings(d, tid);
      return json({ ok: true, settings: SETTINGS_META.map((m) => ({ key: m.key, label: m.label, kind: m.kind, value: s[m.key], display: displayValue(m, s), choices: m.choices ?? null, hint: m.hint ?? null })) });
    }
    if (path === 'settings' && method === 'POST') {
      const m = SETTINGS_META.find((x) => x.key === body.key);
      if (!m) return bad('unknown_setting');
      let value: string;
      if (m.kind === 'toggle') value = body.value === true || body.value === '1' ? '1' : '0';
      else if (m.kind === 'choice') {
        if (!m.choices?.some((c) => c.v === body.value)) return bad('bad_choice');
        value = String(body.value);
      } else {
        const r = parseSettingInput(m, String(body.value ?? ''));
        if (!r.ok) return bad(r.error);
        value = r.value;
      }
      await db.setSetting(d, tid, m.key, value, now);
      const s = await db.getSettings(d, tid);
      return json({ ok: true, display: displayValue(m, s), value });
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
