import type { Quote, SourceId, Currency } from '../types/market.ts';
import type { FxRate } from '../currency/nbu.ts';
import { parseMarketHashName } from '../core/normalization.ts';
import { utcDay } from '../utils/time.ts';

// ---------- Настройки ----------

export const DEFAULT_SETTINGS = {
  budget_kop: '0',            // 0 = бюджет не задан
  max_buy_kop: '0',           // 0 = без ограничения
  min_profit_kop: '2000',     // 20 грн
  min_roi_bp: '800',          // 8%
  deposit_fee_bp: '0',        // комиссия пополнения/оплаты (зависит от способа оплаты) — вводит пользователь
  withdraw_fee_bp: '0',       // комиссия вывода денег с площадки — вводит пользователь
  min_liquidity: 'medium',    // high | medium | low
  change_threshold_bp: '1500',// 15%
  quiet_start: '23',
  quiet_end: '8',
  notify_enabled: '1',
  max_per_hour: '6',
  min_priority: 'medium',     // минимальный приоритет для уведомлений
  sig_arbitrage: '1',
  sig_change: '1',
  sig_target: '1',
  sig_inventory: '1',
  notify_recs: '1',         // горячие рекомендации по всему рынку
  donor_top: '1',
  weekly_report: '1',
  onboarded: '0',
  rally_on: '0',           // пользуется «Разгоном баланса» (для сборщика и уведомлений)
  rally_notify: '1',
  rally_seen: '',          // служебное: какие возможности уже присылали
  share_card: '',          // служебное: последняя картинка «мой инвентарь» (id и время)          // показали знакомство с ботом (3 экрана) в приложении      // воскресная сводка по инвентарю Steam
  inv_week: '',            // служебное: снимок инвентаря прошлого воскресенья (JSON)          // показывать имя в «Топе поддержки»
  recs_per_day: '3',        // не больше в сутки
  max_stale_min: '30',
  daily_report: '1',
  daily_hour: '20',
  last_daily_report: '',
  src_skinport: '1',
  src_csfloat: '1',
  src_steam: '1',
  deals_src: 'all',          // all | skinport | csfloat
  deals_cat: 'all',          // all | case | capsule | weapon | sticker | knife | gloves | other
  deals_budget: '0',         // 1 = только в пределах бюджета/лимита покупки
  deals_liq: '0',            // 1 = скрыть низкую и неизвестную ликвидность
  currency: '',              // валюта показа (USD, EUR, UAH…); пусто — гривна (так было до выбора валюты)
  currency_ok: '',           // 1 = человек сам выбрал или подтвердил валюту
  setup_hidden: '',          // 1 = скрыл карточку «Настрой бота»
  terms_ok: '',              // версия принятых условий использования (TERMS_VERSION)
} as const;
export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = Record<SettingKey, string>;

export async function getSettings(db: D1Database, tid: number): Promise<Settings> {
  const rows = await db.prepare('SELECT key, value FROM user_settings WHERE telegram_id = ?').bind(tid).all<{ key: string; value: string }>();
  const s = { ...DEFAULT_SETTINGS } as Settings;
  for (const r of rows.results) if (r.key in s) s[r.key as SettingKey] = r.value;
  return s;
}

export async function setSetting(db: D1Database, tid: number, key: SettingKey, value: string, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(tid, key, value, now).run();
}

export const num = (s: string): number => (Number.isFinite(Number(s)) ? Number(s) : 0);

/** Новому человеку сразу ставим валюту по языку Telegram (currency — уже угаданный код). Старым ничего не меняем. */
export async function ensureUser(db: D1Database, tid: number, isAdmin: boolean, now: number, currency?: string): Promise<void> {
  const r = await db.prepare('INSERT OR IGNORE INTO users (telegram_id, is_admin, created_at) VALUES (?, ?, ?)').bind(tid, isAdmin ? 1 : 0, now).run();
  if (currency && (r.meta?.changes ?? 0) > 0) {
    await db.prepare(`INSERT OR IGNORE INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'currency', ?, ?)`).bind(tid, currency, now).run();
  }
}

// ---------- Состояние ввода ----------

export async function setState(db: D1Database, tid: number, awaiting: string, payload: unknown, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO user_state (telegram_id, awaiting, payload, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET awaiting = excluded.awaiting, payload = excluded.payload, expires_at = excluded.expires_at`,
  ).bind(tid, awaiting, JSON.stringify(payload ?? null), now + 900).run();
}

export async function getState(db: D1Database, tid: number, now: number): Promise<{ awaiting: string; payload: unknown } | null> {
  const r = await db.prepare('SELECT awaiting, payload, expires_at FROM user_state WHERE telegram_id = ?').bind(tid).first<{ awaiting: string; payload: string; expires_at: number }>();
  if (!r || r.expires_at < now) return null;
  return { awaiting: r.awaiting, payload: r.payload ? JSON.parse(r.payload) : null };
}

export async function clearState(db: D1Database, tid: number): Promise<void> {
  await db.prepare('DELETE FROM user_state WHERE telegram_id = ?').bind(tid).run();
}

// ---------- Предметы и наблюдение ----------

export interface ItemRow { id: number; market_hash_name: string; category: string; is_unique_priced: number; target_buy_kop?: number | null }

/** Запрос «создать предмет, если его нет» — для пакетной записи. */
export function upsertItemStmts(db: D1Database, name: string, now: number): D1PreparedStatement[] {
  const p = parseMarketHashName(name);
  return [db.prepare(
    `INSERT OR IGNORE INTO items (market_hash_name, weapon, skin, category, wear, stattrak, souvenir, is_unique_priced, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.marketHashName, p.weapon, p.skin, p.category, p.wear, p.stattrak ? 1 : 0, p.souvenir ? 1 : 0, p.uniquePriced ? 1 : 0, now)];
}

export async function upsertItem(db: D1Database, name: string, now: number): Promise<ItemRow> {
  const p = parseMarketHashName(name);
  await db.prepare(
    `INSERT OR IGNORE INTO items (market_hash_name, weapon, skin, category, wear, stattrak, souvenir, is_unique_priced, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.marketHashName, p.weapon, p.skin, p.category, p.wear, p.stattrak ? 1 : 0, p.souvenir ? 1 : 0, p.uniquePriced ? 1 : 0, now).run();
  const row = await db.prepare('SELECT id, market_hash_name, category, is_unique_priced FROM items WHERE market_hash_name = ?').bind(p.marketHashName).first<ItemRow>();
  if (!row) throw new Error('item upsert failed');
  return row;
}

export async function getItem(db: D1Database, id: number): Promise<ItemRow | null> {
  return db.prepare('SELECT id, market_hash_name, category, is_unique_priced FROM items WHERE id = ?').bind(id).first<ItemRow>();
}

export interface WatchRow { id: number; item_id: number; market_hash_name: string; target_buy_kop: number | null; change_pct_bp: number | null; active: number; category: string; source?: string }

export async function addWatch(db: D1Database, tid: number, itemId: number, now: number): Promise<'added' | 'exists'> {
  const r = await db.prepare(
    `INSERT INTO watchlist (telegram_id, item_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, item_id) DO UPDATE SET active = 1`,
  ).bind(tid, itemId, now).run();
  return (r.meta.changes ?? 0) > 0 ? 'added' : 'exists';
}

export async function listWatch(db: D1Database, tid: number): Promise<WatchRow[]> {
  const r = await db.prepare(
    `SELECT w.id, w.item_id, i.market_hash_name, w.target_buy_kop, w.change_pct_bp, w.active, i.category, w.source
     FROM watchlist w JOIN items i ON i.id = w.item_id WHERE w.telegram_id = ? AND w.active = 1 ORDER BY i.market_hash_name`,
  ).bind(tid).all<WatchRow>();
  return r.results;
}

export async function getWatch(db: D1Database, tid: number, id: number): Promise<WatchRow | null> {
  return db.prepare(
    `SELECT w.id, w.item_id, i.market_hash_name, w.target_buy_kop, w.change_pct_bp, w.active, i.category, w.source
     FROM watchlist w JOIN items i ON i.id = w.item_id WHERE w.telegram_id = ? AND w.id = ?`,
  ).bind(tid, id).first<WatchRow>();
}

export async function removeWatch(db: D1Database, tid: number, id: number): Promise<void> {
  await db.prepare('UPDATE watchlist SET active = 0 WHERE telegram_id = ? AND id = ?').bind(tid, id).run();
}

export async function setWatchTarget(db: D1Database, tid: number, id: number, kop: number | null): Promise<void> {
  await db.prepare('UPDATE watchlist SET target_buy_kop = ? WHERE telegram_id = ? AND id = ?').bind(kop, tid, id).run();
}

export async function countActiveWatched(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT COUNT(DISTINCT item_id) AS n FROM watchlist WHERE active = 1').first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Предметы для очередной порции запросов к источнику: сначала с высоким приоритетом и целевой ценой,
 * затем те, что дольше всего не обновлялись этим источником (ротация).
 */
export async function itemsDueForSource(db: D1Database, source: SourceId, priceType: string, limit: number): Promise<ItemRow[]> {
  const r = await db.prepare(
    `SELECT i.id, i.market_hash_name, i.category, i.is_unique_priced,
            MAX(w.priority) AS pr, MAX(CASE WHEN w.target_buy_kop IS NOT NULL THEN 1 ELSE 0 END) AS has_target,
            MIN(w.target_buy_kop) AS target_buy_kop, q.fetched_at AS last
     FROM watchlist w JOIN items i ON i.id = w.item_id
     LEFT JOIN market_quotes q ON q.item_id = i.id AND q.source = ? AND q.price_type = ?
     WHERE w.active = 1
     GROUP BY i.id
     ORDER BY (q.fetched_at IS NOT NULL) ASC,
       (COALESCE(q.fetched_at, 0)
         - (MAX(w.priority) * 300)                                                   -- инвентарь и высокий приоритет
         - (MAX(CASE WHEN w.target_buy_kop IS NOT NULL THEN 1 ELSE 0 END) * 300)      -- есть целевая цена
         - (CASE WHEN COALESCE(i.volatility_bp, 0) >= 2000 THEN 300 ELSE 0 END)        -- волатильный предмет
         - (CASE WHEN EXISTS (SELECT 1 FROM signals s WHERE s.item_id = i.id AND s.kind = 'arbitrage_steam'
                               AND s.state IN ('confirmed','notified','unconfirmed')) THEN 600 ELSE 0 END)  -- недавно найденная сделка
       ) ASC
     LIMIT ?`,
  ).bind(source, priceType, limit).all<ItemRow>();
  return r.results;
}

export async function itemWithTarget(db: D1Database, itemId: number): Promise<ItemRow | null> {
  return db.prepare(
    `SELECT i.id, i.market_hash_name, i.category, i.is_unique_priced,
            (SELECT MIN(target_buy_kop) FROM watchlist w WHERE w.item_id = i.id AND w.active = 1) AS target_buy_kop
     FROM items i WHERE i.id = ?`,
  ).bind(itemId).first<ItemRow>();
}

export async function allWatchedNames(db: D1Database): Promise<ItemRow[]> {
  const r = await db.prepare(
    `SELECT DISTINCT i.id, i.market_hash_name, i.category, i.is_unique_priced FROM watchlist w JOIN items i ON i.id = w.item_id WHERE w.active = 1`,
  ).all<ItemRow>();
  return r.results;
}

// ---------- Котировки и история ----------

export interface QuoteRow {
  source: SourceId; item_id: number; price_type: string; price_minor: number | null; currency: Currency;
  price_kop: number | null; fx_rate_id: number | null; quantity: number | null; volume: number | null;
  volume_period: string | null; listing_id: string | null; url: string | null; fetched_at: number; quality: string;
  snap_at: number | null;
}

export const SNAPSHOT_HEARTBEAT_SEC = 3600;

/**
 * Готовит запросы записи котировки (без выполнения — вызывающий объединяет их в один db.batch()).
 * Снимок истории пишется, только если цена/количество/объём изменились или с прошлого снимка прошёл час.
 */
export function quoteWrites(db: D1Database, itemId: number, q: Quote, priceKop: number | null, fxRateId: number | null, prev: QuoteRow | null):
  { stmts: D1PreparedStatement[]; snapshot: boolean; row: QuoteRow } {
  const changed = !prev || prev.price_minor !== q.priceMinor || prev.quantity !== q.quantity || prev.volume !== q.volume;
  const snapshot = changed || !prev?.snap_at || q.fetchedAt - prev.snap_at >= SNAPSHOT_HEARTBEAT_SEC;
  const snapAt = snapshot ? q.fetchedAt : (prev?.snap_at ?? null);
  const stmts: D1PreparedStatement[] = [db.prepare(
    `INSERT INTO market_quotes (source, item_id, price_type, price_minor, currency, price_kop, fx_rate_id, quantity, volume, volume_period,
                                listing_id, url, fetched_at, source_updated_at, quality, snap_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, item_id, price_type) DO UPDATE SET price_minor = excluded.price_minor, currency = excluded.currency,
       price_kop = excluded.price_kop, fx_rate_id = excluded.fx_rate_id, quantity = excluded.quantity, volume = excluded.volume,
       volume_period = excluded.volume_period, listing_id = excluded.listing_id, url = excluded.url, fetched_at = excluded.fetched_at,
       source_updated_at = excluded.source_updated_at, quality = excluded.quality, snap_at = excluded.snap_at`,
  ).bind(q.source, itemId, q.priceType, q.priceMinor, q.currency, priceKop, fxRateId, q.quantity, q.volume, q.volumePeriod,
    q.listingId, q.url, q.fetchedAt, q.sourceUpdatedAt, q.quality, snapAt)];
  if (snapshot) {
    stmts.push(db.prepare(
      `INSERT INTO price_snapshots (item_id, source, price_type, price_minor, currency, price_kop, fx_rate_id, quantity, volume, observed_at, quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(itemId, q.source, q.priceType, q.priceMinor, q.currency, priceKop, fxRateId, q.quantity, q.volume, q.fetchedAt, q.quality));
  }
  const row: QuoteRow = {
    source: q.source, item_id: itemId, price_type: q.priceType, price_minor: q.priceMinor, currency: q.currency, price_kop: priceKop,
    fx_rate_id: fxRateId, quantity: q.quantity, volume: q.volume, volume_period: q.volumePeriod, listing_id: q.listingId, url: q.url,
    fetched_at: q.fetchedAt, quality: q.quality, snap_at: snapAt,
  };
  return { stmts, snapshot, row };
}

/** 0 — пересчёт не нужен, 1 — пересчитать арбитраж, 2 — ещё и события Steam (резкое изменение, цели, инвентарь). */
export function markEvalStmt(db: D1Database, itemId: number, flag: 0 | 1 | 2): D1PreparedStatement {
  // Флаг не понижается до 1, если уже стоит 2 (события Steam ещё не обработаны); 0 сбрасывает всегда.
  return db.prepare('UPDATE items SET needs_eval = CASE WHEN ? = 0 THEN 0 ELSE MAX(needs_eval, ?) END WHERE id = ?').bind(flag, flag, itemId);
}

export async function getQuotes(db: D1Database, itemId: number): Promise<QuoteRow[]> {
  return (await db.prepare('SELECT * FROM market_quotes WHERE item_id = ?').bind(itemId).all<QuoteRow>()).results;
}

/** Котировки нескольких предметов одним запросом. */
export async function quotesForItems(db: D1Database, ids: number[]): Promise<Map<number, QuoteRow[]>> {
  const m = new Map<number, QuoteRow[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return m;
  const r = await db.prepare(`SELECT * FROM market_quotes WHERE item_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<QuoteRow>();
  for (const q of r.results) m.get(q.item_id)?.push(q);
  return m;
}

/** Все котировки одного источника и типа — одним запросом (для массовых источников). */
export async function quotesBySource(db: D1Database, source: SourceId, priceTypes: string[]): Promise<Map<string, QuoteRow>> {
  const r = await db.prepare(`SELECT * FROM market_quotes WHERE source = ? AND price_type IN (${priceTypes.map(() => '?').join(',')})`)
    .bind(source, ...priceTypes).all<QuoteRow>();
  return new Map(r.results.map((x) => [`${x.item_id}:${x.price_type}`, x]));
}

export interface SnapRow { observed_at: number; price_minor: number | null; currency: string; volume: number | null; price_kop: number | null }

export async function history(db: D1Database, itemId: number, source: SourceId, priceType: string, since: number): Promise<SnapRow[]> {
  const r = await db.prepare(
    `SELECT observed_at, price_minor, currency, volume, price_kop FROM price_snapshots
     WHERE item_id = ? AND source = ? AND price_type = ? AND observed_at >= ? ORDER BY observed_at ASC LIMIT 2000`,
  ).bind(itemId, source, priceType, since).all<SnapRow>();
  return r.results;
}

export async function itemsNeedingEval(db: D1Database, limit: number): Promise<{ id: number; flag: number }[]> {
  return (await db.prepare('SELECT id, needs_eval AS flag FROM items WHERE needs_eval > 0 ORDER BY needs_eval DESC LIMIT ?').bind(limit).all<{ id: number; flag: number }>()).results;
}

// ---------- Курсы ----------

export async function storeFx(db: D1Database, rates: FxRate[], now: number): Promise<void> {
  await db.batch(rates.map((r) => db.prepare(
    `INSERT OR IGNORE INTO exchange_rates (base, quote, rate_micro, rate_date, source, fetched_at) VALUES (?, 'UAH', ?, ?, ?, ?)`,
  ).bind(r.base, r.rateMicro, r.rateDate, r.source, now)));
}

/** Последний курс по каждой валюте — одним запросом. */
export async function loadLatestFx(db: D1Database): Promise<Map<Currency, FxRate>> {
  const r = await db.prepare(
    `SELECT id, base, rate_micro, rate_date, source FROM exchange_rates WHERE quote = 'UAH' ORDER BY rate_date DESC, id DESC LIMIT 60`,
  ).all<{ id: number; base: Currency; rate_micro: number; rate_date: string; source: string }>();
  const m = new Map<Currency, FxRate>();
  for (const x of r.results) if (!m.has(x.base)) m.set(x.base, { id: x.id, base: x.base, rateMicro: x.rate_micro, rateDate: x.rate_date, source: x.source });
  return m;
}

// ---------- Сигналы ----------

export interface SignalRow {
  id: number; dedup_key: string; kind: string; item_id: number; state: string; priority: string; category: string | null;
  buy_source: string | null; sell_source: string | null; buy_kop: number | null; sell_kop: number | null; proceeds_kop: number | null;
  spread_kop: number | null; roi_bp: number | null; reason: string; snapshot_json: string; detected_at: number; updated_at: number;
  notified_at: number | null; telegram_msg_id: number | null;
}

export async function getSignal(db: D1Database, id: number): Promise<SignalRow | null> {
  return db.prepare('SELECT * FROM signals WHERE id = ?').bind(id).first<SignalRow>();
}

export async function signalsForItem(db: D1Database, itemId: number): Promise<Map<string, SignalRow>> {
  const r = await db.prepare('SELECT * FROM signals WHERE item_id = ?').bind(itemId).all<SignalRow>();
  return new Map(r.results.map((s) => [s.dedup_key, s]));
}

export async function signalsForItems(db: D1Database, ids: number[]): Promise<Map<number, Map<string, SignalRow>>> {
  const m = new Map<number, Map<string, SignalRow>>(ids.map((id) => [id, new Map()]));
  if (ids.length === 0) return m;
  const r = await db.prepare(`SELECT * FROM signals WHERE item_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<SignalRow>();
  for (const x of r.results) m.get(x.item_id)?.set(x.dedup_key, x);
  return m;
}

export async function itemsWithTarget(db: D1Database, ids: number[]): Promise<ItemRow[]> {
  if (ids.length === 0) return [];
  return (await db.prepare(
    `SELECT i.id, i.market_hash_name, i.category, i.is_unique_priced,
            (SELECT MIN(target_buy_kop) FROM watchlist w WHERE w.item_id = i.id AND w.active = 1) AS target_buy_kop
     FROM items i WHERE i.id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<ItemRow>()).results;
}

export interface SignalUpsert {
  dedupKey: string; kind: string; itemId: number; state: string; priority: string; category: string | null;
  buySource: string | null; sellSource: string | null; buyKop: number | null; sellKop: number | null; proceedsKop: number | null;
  spreadKop: number | null; roiBp: number | null; reason: string; snapshot: unknown; now: number;
}

/** Создаёт сигнал или обновляет существующий (по dedup_key) одним запросом. Состояние 'dismissed' не перезаписывается. */
export async function upsertSignal(db: D1Database, s: SignalUpsert): Promise<SignalRow> {
  const row = await db.prepare(
    `INSERT INTO signals (dedup_key, kind, item_id, state, priority, category, buy_source, sell_source, buy_kop, sell_kop, proceeds_kop,
                          spread_kop, roi_bp, reason, snapshot_json, detected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO UPDATE SET
       state = CASE WHEN signals.state = 'dismissed' THEN 'dismissed' ELSE excluded.state END,
       priority = excluded.priority, category = excluded.category, buy_kop = excluded.buy_kop, sell_kop = excluded.sell_kop,
       proceeds_kop = excluded.proceeds_kop, spread_kop = excluded.spread_kop, roi_bp = excluded.roi_bp, reason = excluded.reason,
       snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at,
       detected_at = CASE WHEN signals.state = 'expired' THEN excluded.detected_at ELSE signals.detected_at END,
       -- notified_at сохраняется и после «неактуально»: иначе сделка, которая то появляется, то исчезает у порога,
       -- присылалась бы снова и снова. Повтор — по общим правилам (6 часов или заметное изменение).
       notified_at = signals.notified_at,
       telegram_msg_id = CASE WHEN signals.state = 'expired' THEN NULL ELSE signals.telegram_msg_id END
     RETURNING *`,
  ).bind(s.dedupKey, s.kind, s.itemId, s.state, s.priority, s.category, s.buySource, s.sellSource, s.buyKop, s.sellKop, s.proceedsKop,
    s.spreadKop, s.roiBp, s.reason, JSON.stringify(s.snapshot), s.now, s.now).first<SignalRow>();
  if (!row) throw new Error('signal upsert failed');
  return row;
}

/** Скрыть сделку только для себя (у других она остаётся). */
export async function hideSignal(db: D1Database, tid: number, signalId: number, now: number): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO hidden_signals (telegram_id, signal_id, hidden_at) VALUES (?, ?, ?)').bind(tid, signalId, now).run();
}

export function markNotifiedStmt(db: D1Database, id: number, msgId: number | null, now: number): D1PreparedStatement {
  return db.prepare(`UPDATE signals SET state = 'notified', notified_at = ?, telegram_msg_id = COALESCE(?, telegram_msg_id) WHERE id = ?`).bind(now, msgId, id);
}

export function setStateStmt(db: D1Database, id: number, state: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE signals SET state = ?, updated_at = ? WHERE id = ?').bind(state, now, id);
}

export async function setSignalState(db: D1Database, id: number, state: string, now: number): Promise<void> {
  await setStateStmt(db, id, state, now).run();
}

/**
 * Активные сделки. С forUser — только по предметам из ЕГО списка, без скрытых им, не ниже его порогов прибыли.
 */
export async function activeSignals(db: D1Database, order: 'spread' | 'roi' | 'priority', limit: number, since: number,
  forUser?: { tid: number; minProfitKop: number; minRoiBp: number }): Promise<(SignalRow & { market_hash_name: string })[]> {
  const ord = order === 'roi' ? 's.roi_bp DESC' : order === 'priority'
    ? "CASE s.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, s.spread_kop DESC" : 's.spread_kop DESC';
  const u = forUser
    ? `AND EXISTS (SELECT 1 FROM watchlist w WHERE w.item_id = s.item_id AND w.telegram_id = ? AND w.active = 1)
       AND NOT EXISTS (SELECT 1 FROM hidden_signals h WHERE h.signal_id = s.id AND h.telegram_id = ?)
       AND COALESCE(s.spread_kop, 0) >= ? AND COALESCE(s.roi_bp, 0) >= ?` : '';
  const r = await db.prepare(
    `SELECT s.*, i.market_hash_name FROM signals s JOIN items i ON i.id = s.item_id
     WHERE s.state IN ('confirmed', 'notified', 'unconfirmed') AND s.updated_at >= ? AND s.kind = 'arbitrage_steam' ${u}
     ORDER BY ${ord} LIMIT ?`,
  ).bind(since, ...(forUser ? [forUser.tid, forUser.tid, forUser.minProfitKop, forUser.minRoiBp] : []), limit).all<SignalRow & { market_hash_name: string }>();
  return r.results;
}

export async function countUserWatch(db: D1Database, tid: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM watchlist WHERE telegram_id = ? AND active = 1 AND COALESCE(source, 'user') <> 'inventory'").bind(tid).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- Уведомления, источники, счётчики, логи ----------

export async function countNotificationsSince(db: D1Database, tid: number, since: number): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM notification_log WHERE telegram_id = ? AND sent_at >= ?').bind(tid, since).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function logNotification(db: D1Database, tid: number, kind: string, ref: string, now: number): Promise<void> {
  await db.prepare('INSERT INTO notification_log (telegram_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)').bind(tid, kind, ref, now).run();
}

export interface SourceStatusRow {
  source: string; status: string; last_ok_at: number | null; last_error_at: number | null; last_error: string | null;
  disabled_reason: string | null; down_since: number | null; alerted_at: number | null; requests_today: number; requests_day: string | null;
}

export async function sourceOk(db: D1Database, source: string, now: number, requests: number): Promise<void> {
  const day = utcDay(now);
  await db.prepare(
    `INSERT INTO source_status (source, status, last_ok_at, down_since, requests_today, requests_day) VALUES (?, 'ok', ?, NULL, ?, ?)
     ON CONFLICT(source) DO UPDATE SET status = 'ok', last_ok_at = excluded.last_ok_at, down_since = NULL, disabled_reason = NULL,
       requests_today = CASE WHEN source_status.requests_day = excluded.requests_day THEN source_status.requests_today + excluded.requests_today ELSE excluded.requests_today END,
       requests_day = excluded.requests_day`,
  ).bind(source, now, requests, day).run();
}

export async function sourceFail(db: D1Database, source: string, status: string, error: string, now: number, requests: number): Promise<void> {
  const day = utcDay(now);
  await db.prepare(
    `INSERT INTO source_status (source, status, last_error_at, last_error, down_since, requests_today, requests_day) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET status = excluded.status, last_error_at = excluded.last_error_at, last_error = excluded.last_error,
       down_since = COALESCE(source_status.down_since, excluded.down_since),
       requests_today = CASE WHEN source_status.requests_day = excluded.requests_day THEN source_status.requests_today + excluded.requests_today ELSE excluded.requests_today END,
       requests_day = excluded.requests_day`,
  ).bind(source, status, now, error.slice(0, 300), now, requests, day).run();
}

export async function sourceDisabled(db: D1Database, source: string, reason: string): Promise<void> {
  await db.prepare(
    `INSERT INTO source_status (source, status, disabled_reason) VALUES (?, 'disabled', ?)
     ON CONFLICT(source) DO UPDATE SET status = 'disabled', disabled_reason = excluded.disabled_reason, down_since = NULL`,
  ).bind(source, reason).run();
}

export async function listSourceStatus(db: D1Database): Promise<SourceStatusRow[]> {
  return (await db.prepare('SELECT * FROM source_status ORDER BY source').all<SourceStatusRow>()).results;
}

export async function incCounter(db: D1Database, counter: string, by: number, now: number): Promise<void> {
  if (by === 0) return;
  await db.prepare(
    `INSERT INTO usage_counters (day, counter, value) VALUES (?, ?, ?) ON CONFLICT(day, counter) DO UPDATE SET value = value + excluded.value`,
  ).bind(utcDay(now), counter, by).run();
}

export function counterStmt(db: D1Database, counter: string, by: number, now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO usage_counters (day, counter, value) VALUES (?, ?, ?) ON CONFLICT(day, counter) DO UPDATE SET value = value + excluded.value`,
  ).bind(utcDay(now), counter, by);
}

export async function counters(db: D1Database, now: number): Promise<Record<string, number>> {
  const r = await db.prepare('SELECT counter, value FROM usage_counters WHERE day = ?').bind(utcDay(now)).all<{ counter: string; value: number }>();
  return Object.fromEntries(r.results.map((x) => [x.counter, x.value]));
}

export async function log(db: D1Database, level: 'info' | 'warn' | 'error', source: string | null, code: string | null, message: string, now: number): Promise<void> {
  try {
    await db.prepare('INSERT INTO system_logs (at, level, source, code, message) VALUES (?, ?, ?, ?, ?)').bind(now, level, source, code, message.slice(0, 500)).run();
  } catch { /* логирование не должно ронять работу */ }
}

export async function recentErrors(db: D1Database, limit: number): Promise<{ at: number; source: string | null; code: string | null; message: string }[]> {
  return (await db.prepare(`SELECT at, source, code, message FROM system_logs WHERE level != 'info' ORDER BY at DESC LIMIT ?`).bind(limit).all<{ at: number; source: string | null; code: string | null; message: string }>()).results;
}
