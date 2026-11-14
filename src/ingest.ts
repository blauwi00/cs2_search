// Приём цен от внешнего сборщика (GitHub Actions).
// Steam и Skinport блокируют сеть Cloudflare (Steam — 429, Skinport — error 1005), поэтому их опрашивает GitHub,
// а Worker только проверяет ответы теми же разборщиками, что и раньше, сохраняет и считает сигналы.
//   GET  /ingest/items  — список предметов для опроса (в порядке приоритета)
//   POST /ingest        — пачка ответов площадок
// Оба адреса требуют заголовок X-Ingest-Secret = INGEST_SECRET.

import type { Env } from './env.ts';
import * as db from './storage/db.ts';
import { budgetedDb, newBudget, sampleWrites, WRITE_SAMPLE } from './storage/budget.ts';
import { parsePriceOverview } from './api/steam.ts';
import { itemToQuote, parseSalesHistory } from './api/skinport.ts';
import { toKop } from './currency/nbu.ts';
import { safeEqual } from './telegram/webhook.ts';
import { SourceError, type Quote } from './types/market.ts';
import { catalogPartStmts, catalogInfo } from './catalog.ts';
import { parseScan, mergeScan, safeImg } from './core/recs.ts';
import { sanitizeAssets, type AssetDetail } from './core/inspect.ts';
import { ideasToTrack, checkStmts, cleanSnippet, newsImage, CHECK_AFTER, type IdeaRow } from './core/insights.ts';
import { setMetaStmt, getMeta } from './core/channel.ts';
import { parseSteamLive, steamLiveStmts, steamLiveFor } from './core/steamlive.ts';
import { parseCollStats, parseCaseVols, loadCollections, collVolTasks, collCurrencies, loadReq, popReq, STEAM_CURRENCY_ID } from './core/collections.ts';
import { loadScan } from './storage/scan.ts';
import { parseUsdRates } from './currency/display.ts';
import { jobSellAlerts } from './core/sellalerts.ts';
import { jobTradeUnlock } from './core/tradelock.ts';
import { jobPumpAlerts } from './core/pumpalert.ts';
import { backtestItem, RALLY_DEFAULTS, type DayPrice } from './core/rally.ts';
import { goneStmts, invFailure, invSuccessStmts, invCheckStmt } from './core/steaminv.ts';
import { rallyInfo, parseRallyItems, mergeRally, loadRallyScan, afterRallyScan } from './core/rallyjob.ts';

export const MAX_INGEST_BYTES = 1024 * 1024;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

interface SteamEntry { name?: unknown; ok?: unknown; status?: unknown; body?: unknown; error?: unknown }
interface IngestBody { kind?: unknown; fetchedAt?: unknown; items?: unknown; wanted?: unknown; error?: unknown; status?: unknown; rates?: unknown; id?: unknown; jpg?: unknown; done?: unknown }

/** Что может присылать домашний агент (свой ключ, а не общий ключ сборщика): только данные Steam со своего компьютера. */
export const AGENT_KINDS = ['steam', 'steam_inventory', 'steam_avg', 'rally_scan', 'agent_ping', 'steam_live'] as const;

export async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleIngest(req: Request, env: Env, now: number, rawDb?: D1Database): Promise<Response> {
  const given = req.headers.get('X-Ingest-Secret')?.trim();
  const url = new URL(req.url);
  let agentOnly = false;
  if (!env.INGEST_SECRET || !safeEqual(given, env.INGEST_SECRET.trim())) {
    // Ключ домашнего агента: хранится только его хэш (meta agent_key_hash), выдаётся владельцу в приложении.
    const hash = given && given.length >= 32 ? await (rawDb ?? env.DB).prepare(`SELECT value FROM meta WHERE key = 'agent_key_hash'`).first<{ value: string }>() : null;
    if (!hash?.value || !safeEqual(await sha256Hex(given!), hash.value)) {
      // Похоже на ключ агента, но не подошёл — отметим (не чаще раза в 5 минут), чтобы в /stats было видно «ключ не подошёл».
      if (given?.startsWith('ag_')) {
        const DB = rawDb ?? env.DB;
        const last = Number((await DB.prepare(`SELECT value FROM meta WHERE key = 'agent_denied'`).first<{ value: string }>())?.value) || 0;
        if (now - last > 300) await DB.prepare(`INSERT INTO meta (key, value) VALUES ('agent_denied', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(now)).run();
      }
      return json({ ok: false, error: 'forbidden' }, 403);
    }
    agentOnly = true;
    if (!((req.method === 'GET' && (url.pathname === '/ingest/items' || url.pathname === '/ingest/steam_live')) || (req.method === 'POST' && url.pathname === '/ingest'))) return json({ ok: false, error: 'forbidden' }, 403);
  }
  const budget = newBudget();
  const d = budgetedDb(rawDb ?? env.DB, budget);

  // Проверка приёма живых цен: до 40 имён через «|» → что лежит в базе, плюс время последней пачки и последнего полного прохода (дёшево: без COUNT по таблице).
  if (req.method === 'GET' && url.pathname === '/ingest/steam_live') {
    const names = (url.searchParams.get('names') ?? '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 40);
    const [found, at, passAt] = await Promise.all([steamLiveFor(d, names), getMeta(d, 'steam_live_at'), getMeta(d, 'steam_live_pass_at')]);
    return json({ ok: true, at: Number(at) || null, passAt: Number(passAt) || null, items: Object.fromEntries([...found].map(([n, v]) => [n, [v.cents, v.listings, v.at]])) });
  }
  if (req.method === 'GET' && url.pathname === '/ingest/items') {
    const items = await db.itemsDueForSource(d, 'steam', 'median_24h', 300);
    const [cat, fx, noImg, noAvg, avgAt, invQ, track] = await Promise.all([
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
          AND (inv_synced_at IS NULL OR inv_requested_at > inv_synced_at)
          -- После отказа Steam — пауза перед повтором (15 мин → 1 ч → 6 ч), а не каждый запуск сборщика.
          AND NOT EXISTS (SELECT 1 FROM user_settings r WHERE r.telegram_id = users.telegram_id AND r.key = 'inv_retry' AND json_extract(r.value, '$.at') > ?)
        ORDER BY inv_requested_at LIMIT 3`).bind(now).all<{ tid: number; steamId: string | null; vanity: string | null }>(),
      ideasToTrack(d, now),
    ]);
    // Адрес Worker (для кнопок «Открыть приложение» в уведомлениях из Cron, где адреса запроса нет).
    if ((await getMeta(d, 'public_origin')) !== url.origin) await setMetaStmt(d, 'public_origin', url.origin).run();
    // needCatalog: каталог названий старше суток или пуст — сборщик пришлёт его заново.
    // fx: курсы НБУ (грн за 1 USD/EUR) — сборщику, чтобы сравнивать площадки при отборе кандидатов.
    return json({
      ok: true, items: items.map((i) => i.market_hash_name), needCatalog: !cat.updatedAt || now - cat.updatedAt > 86400,
      fx: Object.fromEntries([...fx.values()].map((r) => [r.base, r.rateMicro / 1e6])),
      missingImages: noImg.results.map((r) => r.n),
      needSteamAvg: noAvg.results.map((r) => r.n),
      steamAvgAt: Number(avgAt?.value ?? 0) || 0,
      inventorySync: invQ.results,
      trackNames: track,
      // Картинка для поста канала, которую нужно нарисовать (null — ничего не нужно).
      card: await pendingCard(d),
      // Цены со всех площадок — раз в 6 часов для предметов из списков, инвентарей и идей.
      ...(await (async () => { const r = await sitePriceNames(d, now); return { sitePriceNames: r.names, sitePricePartial: r.partial }; })()),
      // «Разгон баланса»: нужен ли проход по дешёвым предметам Steam и какие проверить первыми.
      rally: await rallyInfo(d),
      // Обновления CS2 за 3 дня, у которых ещё нет краткого содержания на русском.
      // Записи в D1 за сегодня по источникам (выборочный учёт, ≈). Бесплатный лимит — 100 000 строк в сутки.
      writes: Object.fromEntries(Object.entries(await db.counters(d, now)).filter(([k]) => k.startsWith('w:'))),
      collVol: await (async () => { try { const c = await loadCollections(d); const t = collVolTasks(c.stats, c.vols, now, await collCurrencies(d), await loadReq(d)); await popReq(d, t); return t.map((x) => ({ ...x, id: STEAM_CURRENCY_ID[x.code] })); } catch { return []; } })(),
      needCaseEv: await (async () => { try { return now - (JSON.parse((await getMeta(d, 'case_ev')) ?? '{}').at ?? 0) > 20 * 3600; } catch { return true; } })(),
      newsNeedRu: (await d.prepare('SELECT gid FROM news WHERE summary_ru IS NULL AND ru_posted_at IS NULL AND published_at >= ? ORDER BY published_at DESC LIMIT 3').bind(now - 3 * 86400).all<{ gid: string }>()).results.map((r) => r.gid),
      // Пауза для Steam после 429 (сборщик в это время Steam не трогает).
      steamPauseUntil: Number(await getMeta(d, 'steam_pause_until')) || 0,
      // Картинки для всего каталога: с какого места продолжать (раз в неделю — новый проход, чтобы подхватить новые предметы).
      imgCursor: await (async () => {
        const c = Number(await getMeta(d, 'img_cursor')) || 0;
        const pass = Number(await getMeta(d, 'img_pass_at')) || 0;
        return c < 0 && now - pass > 7 * 86400 ? 0 : c;
      })(),
    });
  }
  // Бэктест «Разгона» на собственной истории цен Steam (только для сборщика/владельца по секрету).
  if (req.method === 'GET' && url.pathname === '/ingest/backtest') {
    const maxKop = Math.min(100000, Math.max(100, Number(url.searchParams.get('max')) || 600));
    const rows = (await d.prepare(`SELECT name, day, MIN(mn) AS min, CAST(AVG(av) AS INTEGER) AS avg FROM (
        SELECT name, day, min_kop AS mn, sum_kop / n AS av FROM rally_history
        UNION ALL
        SELECT i.market_hash_name AS name, day, mn, av FROM (
        SELECT item_id, day, min_minor AS mn, avg_minor AS av FROM price_daily WHERE source = 'steam' AND price_type = 'lowest_listing' AND currency = 'UAH' AND min_minor IS NOT NULL
        UNION ALL
        SELECT item_id, date(observed_at, 'unixepoch') AS day, MIN(price_kop) AS mn, AVG(price_kop) AS av FROM price_snapshots
          WHERE source = 'steam' AND price_type = 'lowest_listing' AND price_kop IS NOT NULL GROUP BY item_id, day
      ) x JOIN items i ON i.id = x.item_id) GROUP BY name, day ORDER BY name, day`).all<{ name: string; day: string; min: number; avg: number }>()).results;
    const by = new Map<string, DayPrice[]>();
    for (const r of rows) { const a = by.get(r.name) ?? []; a.push({ day: r.day, min: r.min, avg: r.avg }); by.set(r.name, a); }
    const s = { ...RALLY_DEFAULTS, maxItemKop: maxKop };
    const trades = [...by].flatMap(([n, ser]) => backtestItem(n, ser, s)).sort((a, b) => a.day.localeCompare(b.day));
    const days = [...new Set(rows.map((r) => r.day))].sort();
    const cheap = [...by.values()].filter((ser) => ser.some((x) => x.min <= maxKop)).length;
    return json({ ok: true, items: by.size, itemsUnderMax: cheap, days: days.length, from: days[0] ?? null, to: days[days.length - 1] ?? null, maxKop,
      trades: trades.length, wins: trades.filter((t) => t.win).length, profitKop: trades.reduce((a, t) => a + t.profitKop, 0), sample: trades.slice(0, 20) });
  }
  if (req.method !== 'POST' || url.pathname !== '/ingest') return json({ ok: false, error: 'not_found' }, 404);
  if (Number(req.headers.get('content-length') ?? '0') > MAX_INGEST_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  const text = await req.text();
  if (text.length > MAX_INGEST_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  let body: IngestBody;
  try { body = JSON.parse(text) as IngestBody; } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  if (agentOnly && !(AGENT_KINDS as readonly unknown[]).includes(body.kind)) return json({ ok: false, error: 'forbidden' }, 403);

  // Время наблюдения: время сборщика, но не в будущем и не старше часа.
  const fa = typeof body.fetchedAt === 'number' ? Math.floor(body.fetchedAt) : now;
  if (fa > now + 120 || fa < now - 3600) return json({ ok: false, error: 'bad_time' }, 400);
  const at = Math.min(fa, now);

  // Список наблюдения читаем только когда он нужен и только нужную часть (на 1000 человек это ~10 тыс. строк на каждый приём).
  const watchedAll = async () => new Map((await db.allWatchedNames(d)).map((i) => [i.market_hash_name, i]));
  const watchedByNames = async (names: string[]) => new Map((await db.watchedByNames(d, names)).map((i) => [i.market_hash_name, i]));
  const fx = await db.loadLatestFx(d);
  const result: { ok: boolean; stored: number; unknown: number; errors: number; sellAlerts?: number } = { ok: true, stored: 0, unknown: 0, errors: 0 };

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
      // Ничего не изменилось и записано недавно — ни котировку, ни пересчёт не пишем (главный расход записей D1).
      if (db.quoteUnchanged(p.q, kop, pv)) { result.stored++; continue; }
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
      const watched = await watchedByNames(entries.map((e) => e.name).filter((n): n is string => typeof n === 'string'));
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
      result.sellAlerts = (await jobSellAlerts({ db: d, now })).sent;
      // Закончилась защита обмена Steam у записанных покупок — «🔓 Можно продавать» (сборщик приходит примерно раз в час).
      try { await jobTradeUnlock({ db: d, now }); } catch (e) { await db.log(d, 'warn', 'trade_unlock', 'failed', e instanceof Error ? e.message : String(e), now).catch(() => undefined); }
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
      for (const it of (await watchedAll()).values()) {
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
      const sales = parseSalesHistory(Array.isArray(body.items) ? body.items : [], at);
      const watched = await watchedByNames(sales.map((q) => q.marketHashName));
      for (const q of sales) {
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
      // #8: новые цены Steam — проверяем цели продажи сразу (без отдельной задачи по расписанию).
      result.sellAlerts = (await jobSellAlerts({ db: d, now })).sent;
      // Свежие средние — проверяем, не разгоняют ли цену предметов, которые у людей есть.
      try { await jobPumpAlerts({ db: d, now }); } catch (e) { await db.log(d, 'warn', 'pump_alert', 'failed', e instanceof Error ? e.message : String(e), now).catch(() => undefined); }
    } else if (body.kind === 'steam_inventory') {
      const b = body as { tid?: unknown; steamId?: unknown; vanity?: unknown; status?: unknown; src?: unknown; diag?: unknown };
      const checkOf = (x: typeof b) => ({ src: typeof x.src === 'string' && /^[а-яА-ЯёЁ a-zA-Z]{2,30}$/.test(x.src) ? x.src : 'сборщик', diag: typeof x.diag === 'string' ? x.diag.slice(0, 160) : undefined });
      const tid = Number(b.tid);
      const status = ['ok', 'private', 'not_found', 'blocked', 'rate_limited', 'error'].includes(String(b.status)) ? String(b.status) : 'error';
      const steamId = typeof b.steamId === 'string' && /^7656119\d{10}$/.test(b.steamId) ? b.steamId : null;
      const u = await d.prepare('SELECT steam_id, steam_vanity FROM users WHERE telegram_id = ?').bind(tid).first<{ steam_id: string | null; steam_vanity: string | null }>();
      // Принимаем только для того аккаунта, который сейчас привязан (защита от устаревших/чужих ответов).
      const matches = u && ((u.steam_id && u.steam_id === steamId) || (u.steam_vanity && u.steam_vanity === b.vanity));
      if (!matches) return json({ ok: false, error: 'not_linked' }, 409);
      // Отказ Steam — не стираем сохранённый инвентарь от одной попытки (steaminv.ts: invFailure).
      if (status !== 'ok') {
        if (steamId && !u.steam_id) await d.prepare('UPDATE users SET steam_id = ?, steam_vanity = NULL WHERE telegram_id = ?').bind(steamId, tid).run();
        await invFailure(d, tid, status as 'private', now, checkOf(b));
        return json(result);
      }
      const stmts: D1PreparedStatement[] = [
        d.prepare('UPDATE users SET inv_synced_at = ?, inv_status = ?, steam_id = COALESCE(?, steam_id), steam_vanity = CASE WHEN ? IS NOT NULL THEN NULL ELSE steam_vanity END WHERE telegram_id = ?')
          .bind(now, status, steamId, steamId, tid),
        ...invSuccessStmts(d, tid),
        invCheckStmt(d, tid, { ...checkOf(b), status: 'ok' }, now),
      ];
      {
        const raw = (Array.isArray(body.items) ? body.items : []) as { name?: unknown; qty?: unknown; marketable?: unknown; tradable?: unknown; img?: unknown; assets?: unknown }[];
        const byName = new Map<string, { qty: number; marketable: number; tradable: number; img: string | null; assets: AssetDetail[] }>();
        for (const r of raw) {
          if (typeof r?.name !== 'string' || r.name.length > 200) continue;
          const q = Math.max(1, Math.min(100000, Math.trunc(Number(r.qty) || 1)));
          const prev = byName.get(r.name);
          byName.set(r.name, { qty: (prev?.qty ?? 0) + q, marketable: r.marketable ? 1 : prev?.marketable ?? 0, tradable: r.tradable ? 1 : prev?.tradable ?? 0, img: safeImg(r.img) ?? prev?.img ?? null,
            assets: [...(prev?.assets ?? []), ...sanitizeAssets(r.assets)].slice(0, 20) });
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
        // Что пропало с прошлого раза — бот предложит записать как продажи.
        stmts.push(...await goneStmts(d, tid, new Map([...byName].filter(([n]) => ids.has(n)).map(([n, v]) => [ids.get(n)!, v.qty])), byName.size >= 500, now));
        stmts.push(d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid));
        for (const [n, v] of byName) {
          const id = ids.get(n);
          if (!id) continue;
          stmts.push(d.prepare('INSERT OR REPLACE INTO steam_inventory (telegram_id, item_id, qty, marketable, tradable, details) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(tid, id, v.qty, v.marketable, v.tradable, v.assets.length ? JSON.stringify(v.assets) : null));
          if (v.img) stmts.push(d.prepare('INSERT OR IGNORE INTO item_images (name, url) VALUES (?, ?)').bind(n, v.img));
        }
        result.stored = byName.size;
      }
      for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
    } else if (body.kind === 'images') {
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 1000) as { name?: unknown; url?: unknown }[];
      const stmts: D1PreparedStatement[] = [];
      for (const r of rows) {
        const u = safeImg(r?.url);
        if (typeof r?.name === 'string' && r.name.length <= 200 && u) stmts.push(d.prepare('INSERT INTO item_images (name, url) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET url = excluded.url').bind(r.name, u));
      }
      for (let i = 0; i < stmts.length; i += 100) await d.batch(stmts.slice(i, i + 100));
      result.stored = stmts.length;
      // Проход по всему каталогу: сборщик сообщает, докуда дошёл (-1 — до конца).
      const cur = Number((body as { cursor?: unknown }).cursor);
      if (Number.isSafeInteger(cur) && cur >= -1) {
        await setMetaStmt(d, 'img_cursor', String(cur)).run();
        if (cur === -1) await setMetaStmt(d, 'img_pass_at', String(now)).run();
      }
    } else if (body.kind === 'news_ru') {
      const b = body as { gid?: unknown; titleRu?: unknown; summary?: unknown };
      const str = (x: unknown, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
      const list = (x: unknown, n: number) => (Array.isArray(x) ? x.map((y) => str(y, 400)).filter((y): y is string => !!y).slice(0, n) : []);
      const sm = b.summary && typeof b.summary === 'object' ? b.summary as { market?: unknown; sections?: unknown; more?: unknown } : null;
      const clean = sm ? {
        market: list(sm.market, 4),
        sections: (Array.isArray(sm.sections) ? sm.sections : []).slice(0, 8).map((x: any) => ({ name: str(x?.name, 40), items: list(x?.items, 4) })).filter((x) => x.items.length),
        more: Number.isSafeInteger(sm.more) && (sm.more as number) >= 0 ? sm.more : 0,
        impact: list((sm as { impact?: unknown }).impact, 3),
      } : null;
      if (typeof b.gid !== 'string' || !/^\d{1,25}$/.test(b.gid) || !clean || (!clean.market.length && !clean.sections.length)) return json({ ok: false, error: 'bad_news_ru' }, 400);
      await d.prepare('UPDATE news SET title_ru = ?, summary_ru = ? WHERE gid = ?').bind(str(b.titleRu, 200), JSON.stringify(clean), b.gid).run();
      result.stored = 1;
    } else if (body.kind === 'agent_ping') {
      // Домашний агент (цены Steam с компьютера владельца) жив — показываем в /stats и панели.
      await setMetaStmt(d, 'agent_at', JSON.stringify({ at: now, requests: Number((body as { requests?: unknown }).requests) || 0, limited: (body as { limited?: unknown }).limited === true })).run();
    } else if (body.kind === 'steam_limit') {
      // 429 → пауза 30 мин, при повторах 1 ч, 2 ч, 3 ч; спокойный запуск — сброс.
      const limited = (body as { limited?: unknown }).limited === true;
      const level = Number(await getMeta(d, 'steam_backoff')) || 0;
      const next = limited ? Math.min(level + 1, 4) : 0;
      const pause = [0, 30, 60, 120, 180][next] * 60;
      await d.batch([setMetaStmt(d, 'steam_backoff', String(next)), setMetaStmt(d, 'steam_pause_until', String(limited ? now + pause : 0))]);
      result.stored = next;
    } else if (body.kind === 'rally_scan') {
      const fresh = parseRallyItems(body.items, fx.get('USD') ?? null, at);
      const old = await loadRallyScan(d);
      const merged = mergeRally(old.entries, fresh, now);
      const ids = (Array.isArray((body as { nameids?: unknown }).nameids) ? (body as { nameids: unknown[] }).nameids : []).slice(0, 20) as { name?: unknown; id?: unknown }[];
      await d.batch([
        d.prepare('INSERT INTO rally_scan (id, data, fetched_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at').bind(JSON.stringify(merged), at),
        ...fresh.filter((e) => e.steam?.lowest).map((e) => d.prepare(`INSERT INTO rally_history (name, day, min_kop, sum_kop, n, volume) VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(name, day) DO UPDATE SET min_kop = MIN(min_kop, excluded.min_kop), sum_kop = sum_kop + excluded.sum_kop, n = n + 1, volume = excluded.volume`)
          .bind(e.name, new Date(at * 1000).toISOString().slice(0, 10), e.steam!.lowest, e.steam!.lowest, e.steam!.volume)),
        ...ids.filter((x) => typeof x?.name === 'string' && (x.name as string).length <= 200 && Number.isSafeInteger(x.id) && (x.id as number) > 0)
          .map((x) => d.prepare('INSERT INTO item_nameids (name, nameid, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET nameid = excluded.nameid, at = excluded.at').bind(x.name, x.id, now)),
      ]);
      result.stored = fresh.length;
      const r = await afterRallyScan(d, merged, now, await getMeta(d, 'public_origin'), Number(env.ADMIN_TELEGRAM_ID) || null);
      result.sellAlerts = r.notified;
    } else if (body.kind === 'scan') {
      const fresh = parseScan(body.items, at);
      if (fresh.length === 0) return json({ ok: false, error: 'empty_scan' }, 400);
      const old = await loadScan(d);
      const merged = mergeScan(fresh, old?.entries ?? [], now, at, old?.fetchedAt ?? null);
      await d.prepare(
        `INSERT INTO market_scan (id, data, fetched_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      ).bind(JSON.stringify(merged), at).run();
      result.stored = merged.length;
      // Проверка идей недельной давности (когда купленное уже можно продать) по свежим ценам.
      const pending = (await d.prepare('SELECT * FROM idea_log WHERE checked_at IS NULL AND created_at <= ? ORDER BY created_at LIMIT 20').bind(now - CHECK_AFTER + 4 * 3600).all<IdeaRow>()).results;
      const checks = checkStmts(d, pending, merged, fx, now);
      if (checks.length) await d.batch(checks);
    } else if (body.kind === 'case_ev') {
      // «Окупается ли кейс»: средняя отдача открытия (считает сборщик). Одна запись в сутки.
      const c = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 && x < 1e9 ? x : null);
      const list = (Array.isArray(body.items) ? body.items : []).slice(0, 60).map((r: Record<string, any>) => {
        const best = r?.best && typeof r.best.name === 'string' && r.best.name.length <= 120 && c(r.best.cents) && typeof r.best.p === 'number' ? { name: r.best.name, cents: r.best.cents, p: r.best.p } : null;
        return typeof r?.name === 'string' && r.name.length <= 80 && c(r.caseCents) && c(r.keyCents) && c(r.evCents) && c(r.evNetCents)
          && typeof r.pWin === 'number' && r.pWin >= 0 && r.pWin <= 1 && best
          ? { name: r.name, img: typeof r.img === 'string' && r.img.length < 600 ? r.img : null, caseCents: r.caseCents, keyCents: r.keyCents, evCents: r.evCents, evNetCents: r.evNetCents, pWin: r.pWin, best } : null;
      }).filter(Boolean);
      if (list.length) await setMetaStmt(d, 'case_ev', JSON.stringify({ at: now, items: list })).run();
      result.stored = list.length;
    } else if (body.kind === 'cases_stats') {
      // Средние продажи Steam по всем кейсам (из прайса CSGO Trader) — для «индекса кейсов» и вечернего поста.
      const c = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e6 ? Math.round(x * 100) : null);
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 200) as Record<string, unknown>[];
      const list = rows.filter((r) => typeof r?.name === 'string' && (r.name as string).length <= 120 && / Case$/.test(r.name as string))
        .map((r) => ({ name: r.name as string, d1: c(r.d1), d7: c(r.d7), d30: c(r.d30) }));
      if (list.length) await setMetaStmt(d, 'cases_stats', JSON.stringify(list)).run();
      result.stored = list.length;
    } else if (body.kind === 'steam_live') {
      // Живые цены Steam по всему рынку от домашнего сборщика: пачка до 1000 предметов, пишутся только изменения.
      const rows = parseSteamLive(body.items);
      const at = Math.floor(typeof body.fetchedAt === 'number' ? body.fetchedAt : now); // общая проверка времени выше: не в будущем, не старше часа
      if (rows.length || body.done === true) for (let i = 0, st = steamLiveStmts(d, rows, at, body.done === true); i < st.length; i += 90) await d.batch(st.slice(i, i + 90));
      result.stored = rows.length;
    } else if (body.kind === 'collections_stats') {
      // Динамика цен по коллекциям (считает сборщик из открытых файлов): одна запись в meta, не чаще раза в час.
      const list = parseCollStats(body.items);
      const json = JSON.stringify(list);
      if (list.length && (await getMeta(d, 'collections_stats')) !== json) await d.batch([setMetaStmt(d, 'collections_stats', json), setMetaStmt(d, 'collections_stats_at', String(now))]);
      result.stored = list.length;
    } else if (body.kind === 'collections_vol') {
      // Живые цена и объём Steam по нескольким кейсам: копим по именам, старые записи не теряем.
      const fresh = parseCaseVols(body.items, now);
      if (Object.keys(fresh).length) {
        const cur = await loadCollections(d);
        await setMetaStmt(d, 'collections_vol', JSON.stringify({ ...cur.vols, ...fresh })).run();
      }
      result.stored = Object.keys(fresh).length;
    } else if (body.kind === 'card') {
      // Картинка поста канала (JPEG, base64). Адрес Worker запоминаем: по нему Telegram возьмёт картинку.
      const id = typeof body.id === 'string' && /^(ideas|trends|cases|weekly|rally|caseev|news|story)-\d{4}-\d{2}-\d{2}$/.test(body.id) ? body.id : null;
      const jpg = typeof body.jpg === 'string' && body.jpg.length < 1_500_000 && body.jpg.startsWith('/9j/') ? body.jpg : null;
      if (!id || !jpg) return json({ ok: false, error: 'bad_card' }, 400);
      await d.batch([
        d.prepare('INSERT INTO cards (id, jpg_b64, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET jpg_b64 = excluded.jpg_b64, created_at = excluded.created_at').bind(id, jpg, now),
        d.prepare('DELETE FROM cards WHERE created_at < ?').bind(now - 7 * 86400),
        setMetaStmt(d, 'public_origin', url.origin),
      ]);
      result.stored = 1;
    } else if (body.kind === 'site_prices') {
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 500) as { name?: unknown; p?: unknown }[];
      const stmts: D1PreparedStatement[] = [];
      for (const r of rows) {
        if (typeof r?.name !== 'string' || r.name.length > 200 || !r.p || typeof r.p !== 'object') continue;
        const p: Record<string, number> = {};
        for (const [k, v] of Object.entries(r.p as Record<string, unknown>)) if (SITE_PRICE_KEYS.has(k) && typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 1e8) p[k] = v;
        if (Object.keys(p).length) stmts.push(d.prepare('INSERT INTO site_prices (name, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').bind(r.name, JSON.stringify(p), now));
      }
      // Время версии данных каждой площадки (для честной подписи «обновлено …»).
      const src = (body as { srcAt?: unknown }).srcAt;
      if (src && typeof src === 'object') {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(src as Record<string, unknown>)) if (SITE_PRICE_KEYS.has(k) && typeof v === 'number' && v > 1.6e9 && v <= now + 300) clean[k] = Math.floor(v);
        stmts.push(setMetaStmt(d, 'site_src_at', JSON.stringify(clean)));
      }
      if ((body as { partial?: unknown }).partial === true) stmts.push(setMetaStmt(d, 'site_price_req', '[]')); // вне очереди: общий график (раз в 6 часов) не трогаем
      else if (body.done === true) stmts.push(setMetaStmt(d, 'site_prices_at', String(now)), d.prepare('DELETE FROM site_prices WHERE updated_at < ?').bind(now - 3 * 86400), setMetaStmt(d, 'site_price_req', '[]'));
      for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
      result.stored = stmts.length;
    } else if (body.kind === 'fx_usd') {
      // Курсы к доллару из открытого файла CSGO Trader — для валют, которых нет у НБУ (RUB, BRL, ARS).
      const r = parseUsdRates(body.rates);
      if (Object.keys(r).length >= 5) await setMetaStmt(d, 'fx_usd', JSON.stringify(r)).run();
      result.stored = Object.keys(r).length;
    } else if (body.kind === 'news') {
      // Объявления разработчиков CS2 из Steam. Первый приём — только запоминаем (не публикуем старые новости разом).
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 10) as Record<string, unknown>[];
      const seeded = (await d.prepare('SELECT COUNT(*) AS n FROM news').first<{ n: number }>())?.n ?? 0;
      const stmts: D1PreparedStatement[] = [];
      for (const r of rows) {
        const gid = typeof r?.gid === 'string' && /^\d{1,25}$/.test(r.gid) ? r.gid : null;
        const title = typeof r?.title === 'string' ? r.title.slice(0, 200) : null;
        const url2 = typeof r?.url === 'string' && /^https:\/\/(store\.steampowered\.com|steamcommunity\.com|steamstore-a\.akamaihd\.net|www\.counter-strike\.net)\//.test(r.url) ? r.url : null;
        const date = Number(r?.date);
        if (!gid || !title || !url2 || !Number.isInteger(date) || date > now + 3600) continue;
        const imp = Number.isInteger(r.imp) && Number(r.imp) >= 0 && Number(r.imp) <= 100 ? Number(r.imp) : null;
        const why = typeof r.why === 'string' ? r.why.slice(0, 300) : null;
        stmts.push(d.prepare('INSERT OR IGNORE INTO news (gid, title, url, snippet, published_at, posted_at, image, ru_posted_at, importance, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(gid, title, url2, cleanSnippet(r.contents), date, seeded ? null : now, newsImage(r.contents), seeded ? null : now, imp, why));
      }
      if (stmts.length) await d.batch(stmts);
      result.stored = stmts.length;
    } else if (body.kind === 'extra_news') {
      // Новости не от Valve: Reddit (самое обсуждаемое), файлы игры, киберспорт. Заголовок уже на русском (перевод сборщика).
      // Первый приём по источнику — только запоминаем (не публикуем старое); ссылки — только с адресов своего источника.
      const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 5) as Record<string, unknown>[];
      const stmts: D1PreparedStatement[] = [];
      const seededBy = new Map<string, boolean>();
      for (const r of rows) {
        const src = r?.source === 'reddit' || r?.source === 'datamine' || r?.source === 'esports' ? r.source : null;
        const gid = typeof r?.gid === 'string' && /^[red]_[A-Za-z0-9]{3,40}$/.test(r.gid) ? r.gid : null;
        const title = typeof r?.title === 'string' ? r.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : null;
        const titleRu = typeof r?.titleRu === 'string' ? r.titleRu.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 240) : null;
        const urlOk = typeof r?.url === 'string' && (src === 'reddit' ? /^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments\//.test(r.url)
          : src === 'datamine' ? /^https:\/\/github\.com\/SteamDatabase\/GameTracking-CS2\/commit\/[0-9a-f]{7,40}$/.test(r.url) : /^https:\/\/www\.hltv\.org\/news\/\d+/.test(r.url));
        const date = Number(r?.date);
        if (!src || !gid || !title || !titleRu || !urlOk || !Number.isInteger(date) || date > now + 3600) continue;
        if (!seededBy.has(src)) seededBy.set(src, ((await d.prepare('SELECT COUNT(*) AS n FROM news WHERE source = ?').bind(src).first<{ n: number }>())?.n ?? 0) > 0);
        const seeded = seededBy.get(src)!;
        const score = Number.isInteger(r.score) ? Number(r.score) : null, comments = Number.isInteger(r.comments) ? Number(r.comments) : null;
        const imp = Number.isInteger(r.imp) && Number(r.imp) >= 0 && Number(r.imp) <= 100 ? Number(r.imp) : null;
        const why = typeof r.why === 'string' ? r.why.slice(0, 300) : null;
        stmts.push(d.prepare('INSERT OR IGNORE INTO news (gid, title, url, snippet, published_at, posted_at, image, ru_posted_at, title_ru, source, score, comments, importance, why) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)')
          .bind(gid, title, r.url as string, date, seeded ? null : now, seeded ? null : now, titleRu, src, score, comments, imp, why));
      }
      if (stmts.length) await d.batch(stmts);
      result.stored = stmts.length;
    } else {
      return json({ ok: false, error: 'unknown_kind' }, 400);
    }
    await d.prepare(
      `INSERT INTO source_status (source, status, last_ok_at) VALUES ('collector', 'ok', ?)
       ON CONFLICT(source) DO UPDATE SET status = 'ok', last_ok_at = excluded.last_ok_at, down_since = NULL, alerted_at = NULL`,
    ).bind(now).run();
    // Учёт записей в D1 (выборочно) — видно в /stats и панели владельца, какой приём сколько пишет.
    if (sampleWrites()) await db.counterStmt(d, `w:in:${String(body.kind).slice(0, 20)}`, (budget.written + 1) * WRITE_SAMPLE, now).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.log(d, 'error', 'collector', 'ingest', msg, now);
    return json({ ok: false, error: msg.slice(0, 200) }, e instanceof SourceError ? 422 : 500);
  }
  return json({ ...result, written: budget.written });
}

/** Заказ картинки для поста: есть ожидающий пост, а картинки ещё нет. */
async function pendingCard(d: D1Database): Promise<unknown> {
  const raw = await getMeta(d, 'card_request');
  if (!raw) return null;
  try {
    const card = JSON.parse(raw) as { id: string };
    const have = await d.prepare('SELECT 1 AS x FROM cards WHERE id = ?').bind(card.id).first();
    return have ? null : card;
  } catch { return null; }
}

const SITE_PRICE_KEYS = new Set(['skinport', 'csgomarket', 'waxpeer', 'lisskins', 'buff163', 'youpin898', 'c5game', 'csfloat', 'csmoney']);
export const SITE_PRICES_EVERY_SEC = 6 * 3600;

/** Какие предметы сборщику оценить на всех площадках (пусто — ещё рано). */
/** Предметы, по которым человек открыл карточку, а цен площадок ещё нет: обновляем их вне очереди (≤60 имён). */
export async function requestedSiteNames(d: D1Database): Promise<string[]> {
  try { const a = JSON.parse((await getMeta(d, 'site_price_req')) ?? '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 60) : []; } catch { return []; }
}
async function sitePriceNames(d: D1Database, now: number): Promise<{ names: string[]; partial: boolean }> {
  const at = Number(await getMeta(d, 'site_prices_at')) || 0;
  if (now - at < SITE_PRICES_EVERY_SEC) { const r = await requestedSiteNames(d); return { names: r, partial: r.length > 0 }; }
  const own = (await d.prepare(`SELECT DISTINCT i.market_hash_name AS n FROM items i WHERE
      EXISTS (SELECT 1 FROM watchlist w WHERE w.item_id = i.id AND w.active = 1)
      OR EXISTS (SELECT 1 FROM steam_inventory v WHERE v.item_id = i.id)
      OR EXISTS (SELECT 1 FROM trades t WHERE t.item_id = i.id AND t.status = 'open') LIMIT 1500`).all<{ n: string }>()).results.map((r) => r.n);
  const scan = await loadScan(d);
  return { names: [...new Set([...own, ...(scan?.entries ?? []).map((e) => e.name)])].slice(0, 2000), partial: false };
}
