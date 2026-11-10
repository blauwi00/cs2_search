import type { Lot, SaleWithCost } from '../core/portfolio.ts';
import { saleCost, walletFor } from '../core/portfolio.ts';

export interface TradeRow extends Lot {
  telegram_id: number; item_id: number; signal_id: number | null; buy_platform: string;
  target_sell_kop: number | null; note: string | null; updated_at: number; market_hash_name: string; category: string;
}

export interface NewTrade {
  tid: number; itemId: number; signalId: number | null; quantity: number; buyPriceKop: number; buyFeeKop: number;
  platform: string; buyDate: string; note: string | null; now: number;
}

export async function addTrade(db: D1Database, t: NewTrade): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO trades (telegram_id, item_id, signal_id, quantity, buy_price_kop, buy_fee_kop, buy_platform, buy_date, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(t.tid, t.itemId, t.signalId, t.quantity, t.buyPriceKop, t.buyFeeKop, t.platform, t.buyDate, t.note, t.now, t.now).first<{ id: number }>();
  if (!r) throw new Error('trade insert failed');
  return r.id;
}

export async function getTrade(db: D1Database, tid: number, id: number): Promise<TradeRow | null> {
  return db.prepare(
    `SELECT t.*, i.market_hash_name, i.category FROM trades t JOIN items i ON i.id = t.item_id WHERE t.telegram_id = ? AND t.id = ?`,
  ).bind(tid, id).first<TradeRow>();
}

export async function openTrades(db: D1Database, tid: number): Promise<TradeRow[]> {
  return (await db.prepare(
    `SELECT t.*, i.market_hash_name, i.category FROM trades t JOIN items i ON i.id = t.item_id
     WHERE t.telegram_id = ? AND t.status = 'open' ORDER BY t.created_at DESC LIMIT 60`,
  ).bind(tid).all<TradeRow>()).results;
}

export async function openTradesForItem(db: D1Database, itemId: number): Promise<TradeRow[]> {
  return (await db.prepare(
    `SELECT t.*, i.market_hash_name, i.category FROM trades t JOIN items i ON i.id = t.item_id WHERE t.item_id = ? AND t.status = 'open'`,
  ).bind(itemId).all<TradeRow>()).results;
}

export async function allTrades(db: D1Database, tid: number): Promise<TradeRow[]> {
  return (await db.prepare(
    `SELECT t.*, i.market_hash_name, i.category FROM trades t JOIN items i ON i.id = t.item_id WHERE t.telegram_id = ? ORDER BY t.created_at DESC LIMIT 500`,
  ).bind(tid).all<TradeRow>()).results;
}

export interface SaleRow { id: number; trade_id: number; quantity: number; sell_price_kop: number; received_kop: number; fee_kop: number; platform: string; wallet: string; sell_date: string; created_at: number }

export async function salesFor(db: D1Database, tid: number): Promise<(SaleRow & { market_hash_name: string })[]> {
  return (await db.prepare(
    `SELECT s.*, i.market_hash_name FROM trade_sales s JOIN trades t ON t.id = s.trade_id JOIN items i ON i.id = t.item_id
     WHERE t.telegram_id = ? ORDER BY s.created_at DESC LIMIT 500`,
  ).bind(tid).all<SaleRow & { market_hash_name: string }>()).results;
}

/** Себестоимость каждой продажи — по порядку продаж внутри лота. */
export function salesWithCost(trades: TradeRow[], sales: SaleRow[]): SaleWithCost[] {
  const byId = new Map(trades.map((t) => [t.id, t]));
  const soldSoFar = new Map<number, number>();
  const out: SaleWithCost[] = [];
  for (const s of [...sales].sort((a, b) => a.created_at - b.created_at || a.id - b.id)) {
    const t = byId.get(s.trade_id);
    if (!t) continue;
    const before = soldSoFar.get(t.id) ?? 0;
    out.push({ ...s, costKop: saleCost(t, before, s.quantity), buyDate: t.buy_date });
    soldSoFar.set(t.id, before + s.quantity);
  }
  return out;
}

export interface NewSale { tradeId: number; quantity: number; sellPriceKop: number; receivedKop: number; platform: string; sellDate: string; now: number }

/** Записывает продажу и обновляет лот одним batch (одна транзакция D1). Возвращает себестоимость проданного.
 *  Защита от двойного нажатия: обе записи выполняются, только если лот не изменился с момента чтения
 *  (sold_quantity тот же) и штук хватает с учётом «ждут оплаты». Иначе — ничего не записано и ошибка.
 *  pendingId — подтверждение ожидающей продажи: она удаляется в той же транзакции и должна ещё существовать. */
export async function addSale(db: D1Database, tid: number, s: NewSale, pendingId: number | null = null): Promise<{ costKop: number; closed: boolean }> {
  const t = await getTrade(db, tid, s.tradeId);
  if (!t) throw new Error('Лот не найден');
  const fromPending = pendingId !== null;
  // Штуки, которые «ждут оплаты», второй раз продать нельзя (кроме подтверждения самой ожидающей продажи).
  const left = t.quantity - t.sold_quantity - (fromPending ? 0 : ((await pendingByTrade(db, tid)).get(t.id) ?? 0));
  if (!Number.isInteger(s.quantity) || s.quantity < 1 || s.quantity > left) throw new Error(`Можно продать от 1 до ${left} шт.`);
  const cost = saleCost(t, t.sold_quantity, s.quantity);
  const gross = s.sellPriceKop * s.quantity;
  const fee = Math.max(0, gross - s.receivedKop);
  const closed = t.sold_quantity + s.quantity >= t.quantity;
  // Условие «лот не изменился и штук хватает» — одно и то же для вставки и обновления.
  const guard = fromPending
    ? `id = ? AND telegram_id = ? AND sold_quantity = ? AND sold_quantity + ? <= quantity
       AND EXISTS (SELECT 1 FROM pending_sales WHERE id = ? AND telegram_id = ? AND trade_id = ?)`
    : `id = ? AND telegram_id = ? AND sold_quantity = ?
       AND sold_quantity + ? + COALESCE((SELECT SUM(quantity) FROM pending_sales WHERE trade_id = ?), 0) <= quantity`;
  const gArgs = fromPending
    ? [s.tradeId, tid, t.sold_quantity, s.quantity, pendingId, tid, s.tradeId]
    : [s.tradeId, tid, t.sold_quantity, s.quantity, s.tradeId];
  const stmts = [
    db.prepare(
      `INSERT INTO trade_sales (trade_id, quantity, sell_price_kop, received_kop, fee_kop, platform, wallet, sell_date, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM trades WHERE ${guard}`,
    ).bind(s.tradeId, s.quantity, s.sellPriceKop, s.receivedKop, fee, s.platform, walletFor(s.platform), s.sellDate, s.now, ...gArgs),
    db.prepare(`UPDATE trades SET sold_quantity = sold_quantity + ?, status = ?, updated_at = ? WHERE ${guard}`)
      .bind(s.quantity, closed ? 'closed' : 'open', s.now, ...gArgs),
  ];
  // Удаляем ожидающую продажу, только если продажа действительно записана (лот вырос ровно на эти штуки).
  if (fromPending) stmts.push(db.prepare('DELETE FROM pending_sales WHERE id = ? AND telegram_id = ? AND (SELECT sold_quantity FROM trades WHERE id = ?) = ?')
    .bind(pendingId, tid, s.tradeId, t.sold_quantity + s.quantity));
  const res = await db.batch(stmts);
  if (!(res[0]?.meta?.changes ?? 0)) throw new Error(fromPending ? 'Эта продажа уже подтверждена' : 'Лот изменился — обнови и попробуй ещё раз');
  return { costKop: cost, closed };
}

export async function setTradeTarget(db: D1Database, tid: number, id: number, kop: number | null, now: number): Promise<void> {
  await db.prepare('UPDATE trades SET target_sell_kop = ?, updated_at = ? WHERE telegram_id = ? AND id = ?').bind(kop, now, tid, id).run();
}

/** Удаление ошибочной записи — только если по лоту ещё нет продаж (историю продаж не теряем). */
export async function deleteTrade(db: D1Database, tid: number, id: number): Promise<boolean> {
  const r = await db.prepare(
    `DELETE FROM trades WHERE telegram_id = ? AND id = ? AND sold_quantity = 0 AND NOT EXISTS (SELECT 1 FROM trade_sales WHERE trade_id = ?) AND NOT EXISTS (SELECT 1 FROM pending_sales WHERE trade_id = ?)`,
  ).bind(tid, id, id, id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function addWatchFromInventory(db: D1Database, tid: number, itemId: number, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO watchlist (telegram_id, item_id, created_at, source, priority) VALUES (?, ?, ?, 'inventory', 2)
     ON CONFLICT(telegram_id, item_id) DO UPDATE SET active = 1, priority = MAX(watchlist.priority, 2)`,
  ).bind(tid, itemId, now).run();
}

// ---------- Продажи «в ожидании оплаты» ----------

export interface PendingRow { id: number; trade_id: number; quantity: number; sell_price_kop: number; received_kop: number; platform: string; created_at: number }

/** Сколько штук лота уже «на продаже» (ждут оплаты). */
export async function pendingByTrade(db: D1Database, tid: number): Promise<Map<number, number>> {
  const r = (await db.prepare('SELECT trade_id, SUM(quantity) AS q FROM pending_sales WHERE telegram_id = ? GROUP BY trade_id').bind(tid).all<{ trade_id: number; q: number }>()).results;
  return new Map(r.map((x) => [x.trade_id, x.q]));
}

export async function addPending(db: D1Database, tid: number, s: Omit<NewSale, 'sellDate'>): Promise<{ costKop: number }> {
  const t = await getTrade(db, tid, s.tradeId);
  if (!t) throw new Error('Лот не найден');
  const left = t.quantity - t.sold_quantity - ((await pendingByTrade(db, tid)).get(t.id) ?? 0);
  if (!Number.isInteger(s.quantity) || s.quantity < 1 || s.quantity > left) throw new Error(left ? `Можно отметить от 1 до ${left} шт.` : 'Всё уже отмечено как проданное или выставленное');
  // Вставка с той же проверкой в SQL — два одновременных нажатия не отметят больше, чем есть.
  const r = await db.prepare(`INSERT INTO pending_sales (telegram_id, trade_id, quantity, sell_price_kop, received_kop, platform, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ? FROM trades WHERE id = ? AND telegram_id = ?
      AND sold_quantity + ? + COALESCE((SELECT SUM(quantity) FROM pending_sales WHERE trade_id = ?), 0) <= quantity`)
    .bind(tid, s.tradeId, s.quantity, s.sellPriceKop, s.receivedKop, s.platform, s.now, s.tradeId, tid, s.quantity, s.tradeId).run();
  if (!(r.meta.changes ?? 0)) throw new Error('Лот изменился — обнови и попробуй ещё раз');
  return { costKop: saleCost(t, t.sold_quantity, s.quantity) };
}

export async function pendingFor(db: D1Database, tid: number): Promise<(PendingRow & { market_hash_name: string; buy_price_kop: number; buy_fee_kop: number; lot_qty: number })[]> {
  return (await db.prepare(`SELECT p.*, i.market_hash_name, t.buy_price_kop, t.buy_fee_kop, t.quantity AS lot_qty FROM pending_sales p JOIN trades t ON t.id = p.trade_id JOIN items i ON i.id = t.item_id
    WHERE p.telegram_id = ? ORDER BY p.created_at DESC LIMIT 200`).bind(tid).all<PendingRow & { market_hash_name: string; buy_price_kop: number; buy_fee_kop: number; lot_qty: number }>()).results;
}

/** Деньги пришли → обычная продажа (сумму можно поправить). */
export async function confirmPending(db: D1Database, tid: number, id: number, receivedKop: number | null, date: string, now: number): Promise<{ costKop: number; receivedKop: number }> {
  const p = await db.prepare('SELECT * FROM pending_sales WHERE id = ? AND telegram_id = ?').bind(id, tid).first<PendingRow>();
  if (!p) throw new Error('Не найдено');
  const got = receivedKop ?? p.received_kop;
  const r = await addSale(db, tid, { tradeId: p.trade_id, quantity: p.quantity, sellPriceKop: p.sell_price_kop, receivedKop: got, platform: p.platform, sellDate: date, now }, p.id);
  return { costKop: r.costKop, receivedKop: got };
}

export async function cancelPending(db: D1Database, tid: number, id: number): Promise<boolean> {
  const r = await db.prepare('DELETE FROM pending_sales WHERE id = ? AND telegram_id = ?').bind(id, tid).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Удалить ошибочную запись о продаже: штуки возвращаются в лот. */
export async function deleteSale(db: D1Database, tid: number, saleId: number, now: number): Promise<boolean> {
  const s = await db.prepare('SELECT s.id, s.trade_id, s.quantity FROM trade_sales s JOIN trades t ON t.id = s.trade_id WHERE s.id = ? AND t.telegram_id = ?')
    .bind(saleId, tid).first<{ id: number; trade_id: number; quantity: number }>();
  if (!s) return false;
  await db.batch([
    db.prepare('DELETE FROM trade_sales WHERE id = ?').bind(s.id),
    db.prepare(`UPDATE trades SET sold_quantity = MAX(0, sold_quantity - ?), status = 'open', updated_at = ? WHERE id = ? AND telegram_id = ?`).bind(s.quantity, now, s.trade_id, tid),
  ]);
  return true;
}
