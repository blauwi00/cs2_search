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
import { parseScan, mergeScan, safeImg } from './core/recs.ts';
import { loadScan } from './storage/scan.ts';

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
    const [cat, fx, noImg, noAvg, avgAt, invQ] = await Promise.all([
      catalogInfo(d), db.loadLatestFx(d),
      d.prepare(`SELECT DISTINCT i.market_hash_name AS n FROM items i JOIN watchlist w ON w.item_id = i.id AND w.active = 1
        LEFT JOIN item_images m ON m.name = i.market_hash_name WHERE m.name IS NULL LIMIT 400`).all<{ n: string }>(),
      // Средние Steam нужны для предметов из списков наблюдения и из инвентарей Steam.
      d.prepare(`SELECT i.market_hash_name AS n FROM items i LEFT JOIN steam_avg a ON a.item_id = i.id
        WHERE (a.item_id IS NULL OR a.updated_at < ?)
          AND (EXISTS (SELECT 1 FROM watchlist w WHERE w.item_id = i.id AND w.active = 1) OR EXISTS (SELECT 1 FROM steam_inventory v WHERE v.item_id = i.id))
        LIMIT 800`).bind(now - 20 * 3600).all<{ n: string }>(),
      d.prepare(`SELECT value FROM meta WHERE key = 'steam_avg_file_at'`).first<{ value: string }>(),
      // Инвентари Steam, которые попросили обновить (открытые данные Steam; доступа к аккаунту у бота нет).
      d.prepare(`SELECT telegram_id AS tid, steam_id AS steamId, steam_vanity AS vanity FROM users
        WHERE (steam_id IS NOT NULL OR steam_vanity IS NOT NULL) AND inv_requested_at IS NOT NULL
          AND (inv_synced_at IS NULL OR inv_requested_at > inv_synced_at) ORDER BY inv_requested_at LIMIT 3`).all<{ tid: number; steamId: string | null; vanity: string | null }>(),
    ]);
    // needCatalog: каталог названий старше суток или пуст — сборщик пришлёт его заново.
    // fx: курсы НБУ (грн за 1 USD/EUR) — сборщику, чтобы сравнивать площадки при отборе кандидатов.
    return json({
      ok: true, items: items.map((i) => i.market_hash_name), needCatalog: !cat.updatedAt || now - cat.updatedAt > 86400,
      fx: Object.fromEntries([...fx.values()].map((r) => [r.base, r.rateMicro / 1e6])),
      missingImages: noImg.results.map((r) => r.n),
      needSteamAvg: noAvg.results.map((r) => r.n),
      steamAvgAt: Number(avgAt?.value ?? 0) || 0,
      inventorySync: invQ.results,
    });
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
    } else if (body.kind === 'steam_avg') {
      // Средние продажи Steam (USD) из открытого прайса CSGO Trader — только для предметов, которые у нас есть.
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 500) as Record<string, unknown>[];
      const c = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e6 ? Math.round(x * 100) : null);
      const names = rows.map((r) => r?.name).filter((n): n is string => typeof n === 'string' && n.length <= 200);
      const ids = new Map<string, number>();
      for (let i = 0; i < names.length; i += 90) {
        const p = names.slice(i, i + 90);
        for (const r of (await d.prepare(`SELECT id, market_hash_name FROM items WHERE market_hash_name IN (${p.map(() => '?').join(',')})`).bind(...p).all<{ id: number; market_hash_name: string }>()).results) ids.set(r.market_hash_name, r.id);
      }
      const stmts: D1PreparedStatement[] = [];
      for (const r of rows) {
        const id = typeof r?.name === 'string' ? ids.get(r.name) : undefined;
        if (!id) continue;
        stmts.push(d.prepare(`INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET d1 = excluded.d1, d7 = excluded.d7, d30 = excluded.d30, d90 = excluded.d90, updated_at = excluded.updated_at`)
          .bind(id, c(r.d1), c(r.d7), c(r.d30), c(r.d90), now));
      }
      // Время версии прайса (Last-Modified файла) — чтобы новую версию разослать по всем предметам сразу.
      const fileAt = Number((body as { fileAt?: unknown }).fileAt);
      if (Number.isInteger(fileAt) && fileAt > 1.6e9 && fileAt <= now + 300) {
        stmts.push(d.prepare(`INSERT INTO meta (key, value) VALUES ('steam_avg_file_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(fileAt)));
      }
      for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
      result.stored = stmts.length;
    } else if (body.kind === 'steam_inventory') {
      const b = body as { tid?: unknown; steamId?: unknown; vanity?: unknown; status?: unknown };
      const tid = Number(b.tid);
      const status = ['ok', 'private', 'not_found', 'rate_limited', 'error'].includes(String(b.status)) ? String(b.status) : 'error';
      const steamId = typeof b.steamId === 'string' && /^7656119\d{10}$/.test(b.steamId) ? b.steamId : null;
      const u = await d.prepare('SELECT steam_id, steam_vanity FROM users WHERE telegram_id = ?').bind(tid).first<{ steam_id: string | null; steam_vanity: string | null }>();
      // Принимаем только для того аккаунта, который сейчас привязан (защита от устаревших/чужих ответов).
      const matches = u && ((u.steam_id && u.steam_id === steamId) || (u.steam_vanity && u.steam_vanity === b.vanity));
      if (!matches) return json({ ok: false, error: 'not_linked' }, 409);
      if (status === 'rate_limited') {
        await d.prepare('UPDATE users SET inv_status = ? WHERE telegram_id = ?').bind(status, tid).run();
        return json(result);
      }
      const stmts: D1PreparedStatement[] = [
        d.prepare('UPDATE users SET inv_synced_at = ?, inv_status = ?, steam_id = COALESCE(?, steam_id), steam_vanity = CASE WHEN ? IS NOT NULL THEN NULL ELSE steam_vanity END WHERE telegram_id = ?')
          .bind(now, status, steamId, steamId, tid),
      ];
      if (status === 'ok') {
        const raw = (Array.isArray(body.items) ? body.items : []) as { name?: unknown; qty?: unknown; marketable?: unknown; tradable?: unknown; img?: unknown }[];
        const byName = new Map<string, { qty: number; marketable: number; tradable: number; img: string | null }>();
        for (const r of raw) {
          if (typeof r?.name !== 'string' || r.name.length > 200) continue;
          const q = Math.max(1, Math.min(100000, Math.trunc(Number(r.qty) || 1)));
          const prev = byName.get(r.name);
          byName.set(r.name, { qty: (prev?.qty ?? 0) + q, marketable: r.marketable ? 1 : prev?.marketable ?? 0, tradable: r.tradable ? 1 : prev?.tradable ?? 0, img: safeImg(r.img) ?? prev?.img ?? null });
          if (byName.size >= 500) break;
        }
        const names = [...byName.keys()];
        const up: D1PreparedStatement[] = [];
        for (const n of names) up.push(...db.upsertItemStmts(d, n, now));
        for (let i = 0; i < up.length; i += 90) await d.batch(up.slice(i, i + 90));
        const ids = new Map<string, number>();
        for (let i = 0; i < names.length; i += 90) {
          const p = names.slice(i, i + 90);
          for (const r of (await d.prepare(`SELECT id, market_hash_name FROM items WHERE market_hash_name IN (${p.map(() => '?').join(',')})`).bind(...p).all<{ id: number; market_hash_name: string }>()).results) ids.set(r.market_hash_name, r.id);
        }
        stmts.push(d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid));
        for (const [n, v] of byName) {
          const id = ids.get(n);
          if (!id) continue;
          stmts.push(d.prepare('INSERT OR REPLACE INTO steam_inventory (telegram_id, item_id, qty, marketable, tradable) VALUES (?, ?, ?, ?, ?)').bind(tid, id, v.qty, v.marketable, v.tradable));
          if (v.img) stmts.push(d.prepare('INSERT OR IGNORE INTO item_images (name, url) VALUES (?, ?)').bind(n, v.img));
        }
        result.stored = byName.size;
      } else {
        stmts.push(d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid));
      }
      for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
    } else if (body.kind === 'images') {
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 500) as { name?: unknown; url?: unknown }[];
      const stmts: D1PreparedStatement[] = [];
      for (const r of rows) {
        const u = safeImg(r?.url);
        if (typeof r?.name === 'string' && r.name.length <= 200 && u) stmts.push(d.prepare('INSERT INTO item_images (name, url) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET url = excluded.url').bind(r.name, u));
      }
      if (stmts.length) await d.batch(stmts);
      result.stored = stmts.length;
    } else if (body.kind === 'scan') {
      const fresh = parseScan(body.items, at);
      if (fresh.length === 0) return json({ ok: false, error: 'empty_scan' }, 400);
      const old = await loadScan(d);
      const merged = mergeScan(fresh, old?.entries ?? [], now);
      await d.prepare(
        `INSERT INTO market_scan (id, data, fetched_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      ).bind(JSON.stringify(merged), at).run();
      result.stored = merged.length;
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
