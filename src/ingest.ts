// Приём цен от внешнего сборщика (GitHub Actions).
// Steam и Skinport блокируют сеть Cloudflare (Steam — 429, Skinport — error 1005), поэтому их опрашивает GitHub,
// а Worker только проверяет ответы теми же разборщиками, что и раньше, сохраняет и считает сигналы.
//   GET  /ingest/items  — список предметов для опроса (в порядке приоритета)
//   POST /ingest        — пачка ответов площадок
// Оба адреса требуют заголовок X-Ingest-Secret = INGEST_SECRET.

import type { Env } from './env.ts';
import * as db from './storage/db.ts';
import { budgetedDb, newBudget } from './storage/budget.ts';
import { parsePriceOverview } from './api/steam.ts';
import { itemToQuote, parseSalesHistory } from './api/skinport.ts';
import { toKop } from './currency/nbu.ts';
import { safeEqual } from './telegram/webhook.ts';
import { SourceError, type Quote } from './types/market.ts';
import { catalogPartStmts, catalogInfo } from './catalog.ts';

export const MAX_INGEST_BYTES = 1024 * 1024;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

interface SteamEntry { name?: unknown; ok?: unknown; status?: unknown; body?: unknown; error?: unknown }
interface IngestBody { kind?: unknown; fetchedAt?: unknown; items?: unknown; wanted?: unknown; error?: unknown; status?: unknown }

export async function handleIngest(req: Request, env: Env, now: number, rawDb?: D1Database): Promise<Response> {
  if (!env.INGEST_SECRET || !safeEqual(req.headers.get('X-Ingest-Secret')?.trim(), env.INGEST_SECRET.trim())) return json({ ok: false, error: 'forbidden' }, 403);
  const budget = newBudget();
  const d = budgetedDb(rawDb ?? env.DB, budget);
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/ingest/items') {
    const items = await db.itemsDueForSource(d, 'steam', 'median_24h', 300);
    const cat = await catalogInfo(d);
    // needCatalog: каталог названий старше суток или пуст — сборщик пришлёт его заново.
    return json({ ok: true, items: items.map((i) => i.market_hash_name), needCatalog: !cat.updatedAt || now - cat.updatedAt > 86400 });
  }
  if (req.method !== 'POST' || url.pathname !== '/ingest') return json({ ok: false, error: 'not_found' }, 404);
  if (Number(req.headers.get('content-length') ?? '0') > MAX_INGEST_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  const text = await req.text();
  if (text.length > MAX_INGEST_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  let body: IngestBody;
  try { body = JSON.parse(text) as IngestBody; } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  // Время наблюдения: время сборщика, но не в будущем и не старше часа.
  const fa = typeof body.fetchedAt === 'number' ? Math.floor(body.fetchedAt) : now;
  if (fa > now + 120 || fa < now - 3600) return json({ ok: false, error: 'bad_time' }, 400);
  const at = Math.min(fa, now);

  const watched = new Map((await db.allWatchedNames(d)).map((i) => [i.market_hash_name, i]));
  const fx = await db.loadLatestFx(d);
  const result = { ok: true, stored: 0, unknown: 0, errors: 0 };

  const writeQuotes = async (source: 'steam' | 'skinport', pairs: { itemId: number; q: Quote; eval: 0 | 1 | 2 }[]) => {
    if (pairs.length === 0) return;
    const ids = [...new Set(pairs.map((p) => p.itemId))];
    const prev = new Map<string, db.QuoteRow>();
    for (let i = 0; i < ids.length; i += 90) {
      for (const [, list] of await db.quotesForItems(d, ids.slice(i, i + 90))) for (const r of list) prev.set(`${r.item_id}:${r.source}:${r.price_type}`, r);
    }
    const stmts: D1PreparedStatement[] = [];
    let snaps = 0;
    for (const p of pairs) {
      const rate = p.q.currency === 'UAH' ? null : fx.get(p.q.currency) ?? null;
      const kop = p.q.priceMinor === null ? null : toKop(p.q.priceMinor, p.q.currency, rate);
      const pv = prev.get(`${p.itemId}:${p.q.source}:${p.q.priceType}`) ?? null;
      const w = db.quoteWrites(d, p.itemId, p.q, kop, rate?.id ?? null, pv);
      stmts.push(...w.stmts);
      if (w.snapshot) snaps++;
      // События Steam (резкое изменение, цели, инвентарь) проверяем, только если цена объявления изменилась.
      const flag = p.eval === 2 && p.q.priceType === 'lowest_listing' && pv?.price_minor !== p.q.priceMinor ? 2 : p.eval === 0 ? 0 : 1;
      if (flag) stmts.push(db.markEvalStmt(d, p.itemId, flag as 1 | 2));
      result.stored++;
    }
    for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
    await d.batch([db.counterStmt(d, 'snapshots', snaps, now), db.counterStmt(d, 'ext_requests', 0, now)]);
  };

  try {
    if (body.kind === 'steam') {
      const entries = Array.isArray(body.items) ? (body.items as SteamEntry[]).slice(0, 60) : [];
      const pairs: { itemId: number; q: Quote; eval: 0 | 1 | 2 }[] = [];
      let rateLimited = 0, okCount = 0;
      for (const e of entries) {
        const it = typeof e.name === 'string' ? watched.get(e.name) : undefined;
        if (!it) { result.unknown++; continue; }
        if (e.ok !== true) {
          result.errors++;
          if (e.status === 429) rateLimited++;
          continue;
        }
        try {
          for (const q of parsePriceOverview(e.body, it.market_hash_name, at)) pairs.push({ itemId: it.id, q, eval: 2 });
          okCount++;
        } catch (err) {
          result.errors++;
          if (err instanceof SourceError && err.kind === 'not_found') await db.log(d, 'warn', 'steam', 'not_found', `Нет данных Steam: ${it.market_hash_name}`, now);
        }
      }
      await writeQuotes('steam', pairs);
      if (okCount > 0) await db.sourceOk(d, 'steam', now, entries.length);
      else if (entries.length > 0) await db.sourceFail(d, 'steam', rateLimited ? 'rate_limited' : 'degraded', rateLimited ? 'HTTP 429 у сборщика GitHub' : 'сборщик не получил данных', now, entries.length);
    } else if (body.kind === 'skinport_items') {
      if (body.error) {
        await db.sourceFail(d, 'skinport', 'degraded', `сборщик: ${String(body.error).slice(0, 200)}`, now, 1);
        return json(result);
      }
      const rows = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
      const found = new Map<string, Quote>();
      for (const r of rows) {
        const q = itemToQuote(r, at);
        if (q) found.set(q.marketHashName, q);
      }
      const pairs: { itemId: number; q: Quote; eval: 0 | 1 | 2 }[] = [];
      for (const it of watched.values()) {
        // Нет в каталоге Skinport → предложений нет (quantity 0), а не «цена 0».
        const q: Quote = found.get(it.market_hash_name) ?? {
          source: 'skinport', marketHashName: it.market_hash_name, priceType: 'lowest_listing', priceMinor: null, currency: 'EUR',
          quantity: 0, volume: null, volumePeriod: null, listingId: null, floatValue: null, paintSeed: null, url: null,
          fetchedAt: at, sourceUpdatedAt: null, tradable: null, quality: 'ok',
        };
        pairs.push({ itemId: it.id, q, eval: 1 });
      }
      await writeQuotes('skinport', pairs);
      await db.sourceOk(d, 'skinport', now, 1);
    } else if (body.kind === 'skinport_sales') {
      if (body.error) {
        await db.sourceFail(d, 'skinport', 'degraded', `сборщик: ${String(body.error).slice(0, 200)}`, now, 1);
        return json(result);
      }
      const pairs: { itemId: number; q: Quote; eval: 0 | 1 | 2 }[] = [];
      for (const q of parseSalesHistory(Array.isArray(body.items) ? body.items : [], at)) {
        const it = watched.get(q.marketHashName);
        if (it) pairs.push({ itemId: it.id, q, eval: 0 });
      }
      await writeQuotes('skinport', pairs);
      await db.sourceOk(d, 'skinport', now, 1);
    } else if (body.kind === 'catalog') {
      const names = Array.isArray(body.items) ? (body.items as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 6000) : [];
      const b = body as { part?: unknown; parts?: unknown };
      const part = Number(b.part), parts = Number(b.parts);
      if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 20 || part < 0 || part >= parts) return json({ ok: false, error: 'bad_part' }, 400);
      if (names.length < 10) return json({ ok: false, error: 'catalog_too_small' }, 400); // защита от пустого/битого ответа
      await d.batch(catalogPartStmts(d, part, parts, names, now));
      result.stored = names.length;
    } else {
      return json({ ok: false, error: 'unknown_kind' }, 400);
    }
    await d.prepare(
      `INSERT INTO source_status (source, status, last_ok_at) VALUES ('collector', 'ok', ?)
       ON CONFLICT(source) DO UPDATE SET status = 'ok', last_ok_at = excluded.last_ok_at, down_since = NULL, alerted_at = NULL`,
    ).bind(now).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.log(d, 'error', 'collector', 'ingest', msg, now);
    return json({ ok: false, error: msg.slice(0, 200) }, e instanceof SourceError ? 422 : 500);
  }
  return json(result);
}
