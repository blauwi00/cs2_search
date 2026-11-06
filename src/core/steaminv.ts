// Инвентарь Steam прямо из Worker — по кнопке «Обновить» (сборщику на GitHub Steam отвечает 429).
// Один-два запроса к публичной странице инвентаря, без входа в аккаунт. Не вышло — остаётся обычная очередь сборщика.
// Подробности предметов (float, наклейки) сборщик собирает полнее — здесь их не трогаем, только состав и количество.

import * as db from '../storage/db.ts';
import { safeImg } from './recs.ts';

export type InvFetch =
  | { status: 'ok'; steamId: string; items: { name: string; qty: number; marketable: number; tradable: number; img: string | null }[]; partial: boolean }
  | { status: 'private' | 'not_found' | 'rate_limited' | 'error'; steamId: string | null };

const UA = 'Mozilla/5.0 (compatible; CenolovBot/1.0; +https://t.me/cenolow_bot)';

export async function fetchInventory(fetcher: typeof fetch, steamId: string | null, vanity: string | null): Promise<InvFetch> {
  let id = steamId;
  if (!id && vanity) {
    const r = await fetcher(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`, { headers: { 'User-Agent': UA } });
    if (r.status === 429) return { status: 'rate_limited', steamId: null };
    const m = (await r.text()).match(/<steamID64>(7656119\d{10})<\/steamID64>/);
    if (!m) return { status: 'not_found', steamId: null };
    id = m[1];
  }
  if (!id) return { status: 'not_found', steamId: null };
  const r = await fetcher(`https://steamcommunity.com/inventory/${id}/730/2?l=english&count=1000`, { headers: { 'User-Agent': UA } });
  if (r.status === 429) return { status: 'rate_limited', steamId: id };
  if (r.status === 401 || r.status === 403) return { status: 'private', steamId: id };
  if (!r.ok) return { status: r.status === 404 ? 'not_found' : 'error', steamId: id };
  const j = await r.json().catch(() => null) as { success?: unknown; assets?: { classid: string; instanceid: string; amount?: string }[]; descriptions?: { classid: string; instanceid: string; market_hash_name?: string; marketable?: number; tradable?: number; icon_url?: string }[]; more_items?: unknown } | null;
  if (!j || j.success === false) return { status: 'private', steamId: id };
  const desc = new Map((j.descriptions ?? []).map((x) => [`${x.classid}_${x.instanceid}`, x]));
  const by = new Map<string, { name: string; qty: number; marketable: number; tradable: number; img: string | null }>();
  for (const a of j.assets ?? []) {
    const x = desc.get(`${a.classid}_${a.instanceid}`);
    const n = x?.market_hash_name;
    if (typeof n !== 'string' || n.length > 200) continue;
    const c = by.get(n) ?? { name: n, qty: 0, marketable: x!.marketable ? 1 : 0, tradable: x!.tradable ? 1 : 0, img: x!.icon_url ? safeImg(`https://community.akamai.steamstatic.com/economy/image/${x!.icon_url}`) : null };
    c.qty += Math.max(1, Math.min(100000, Math.trunc(Number(a.amount) || 1)));
    if (x!.marketable) c.marketable = 1;
    if (x!.tradable) c.tradable = 1;
    by.set(n, c);
    if (by.size >= 500) break;
  }
  return { status: 'ok', steamId: id, items: [...by.values()], partial: !!j.more_items || by.size >= 500 };
}

/**
 * Сохранить результат. Состав и количество обновляем, подробности (float, наклейки) сохраняем от сборщика.
 * Если инвентарь отдался не целиком — ничего не удаляем.
 */
export async function storeInventory(d: D1Database, tid: number, res: InvFetch, now: number): Promise<void> {
  if (res.status !== 'ok') {
    // 429 и сбои — не наша новость о пользователе: пусть дальше пробует сборщик, статус не трогаем.
    if (res.status === 'private' || res.status === 'not_found') {
      await d.batch([
        d.prepare('UPDATE users SET inv_synced_at = ?, inv_status = ? WHERE telegram_id = ?').bind(now, res.status, tid),
        d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid),
      ]);
    }
    return;
  }
  const names = res.items.map((x) => x.name);
  const up: D1PreparedStatement[] = [];
  for (const n of names) up.push(...db.upsertItemStmts(d, n, now));
  for (let i = 0; i < up.length; i += 90) await d.batch(up.slice(i, i + 90));
  const ids = new Map<string, number>();
  for (let i = 0; i < names.length; i += 90) {
    const p = names.slice(i, i + 90);
    for (const r of (await d.prepare(`SELECT id, market_hash_name FROM items WHERE market_hash_name IN (${p.map(() => '?').join(',')})`).bind(...p).all<{ id: number; market_hash_name: string }>()).results) ids.set(r.market_hash_name, r.id);
  }
  const stmts: D1PreparedStatement[] = [
    d.prepare('UPDATE users SET inv_synced_at = ?, inv_status = ?, steam_id = ?, steam_vanity = NULL WHERE telegram_id = ?').bind(now, 'ok', res.steamId, tid),
  ];
  const keep = [...ids.values()];
  const fresh = new Map(res.items.filter((x) => ids.has(x.name)).map((x) => [ids.get(x.name)!, x.qty]));
  stmts.push(...await goneStmts(d, tid, fresh, res.partial, now));
  if (!res.partial) {
    stmts.push(keep.length
      ? d.prepare(`DELETE FROM steam_inventory WHERE telegram_id = ? AND item_id NOT IN (SELECT value FROM json_each(?))`).bind(tid, JSON.stringify(keep))
      : d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid));
  }
  for (const x of res.items) {
    const id = ids.get(x.name);
    if (!id) continue;
    // Без изменений — без записи (бесплатный лимит записей в базу).
    stmts.push(d.prepare(`INSERT INTO steam_inventory (telegram_id, item_id, qty, marketable, tradable) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id, item_id) DO UPDATE SET qty = excluded.qty, marketable = excluded.marketable, tradable = excluded.tradable
      WHERE steam_inventory.qty != excluded.qty OR steam_inventory.marketable != excluded.marketable OR steam_inventory.tradable != excluded.tradable`)
      .bind(tid, id, x.qty, x.marketable, x.tradable));
    if (x.img) stmts.push(d.prepare('INSERT OR IGNORE INTO item_images (name, url) VALUES (?, ?)').bind(x.name, x.img));
  }
  for (let i = 0; i < stmts.length; i += 90) await d.batch(stmts.slice(i, i + 90));
}

/** Что пропало из инвентаря по сравнению с прошлым разом (только если прошлый раз был). Неполный ответ — только уменьшения. */
export async function goneStmts(d: D1Database, tid: number, fresh: Map<number, number>, partial: boolean, now: number): Promise<D1PreparedStatement[]> {
  // Минус то, что уже записано как продажа после прошлого обновления (кнопка «Я продал» до «Обновить»).
  const old = (await d.prepare(`SELECT s.item_id, s.qty, COALESCE((SELECT SUM(ts.quantity) FROM trade_sales ts JOIN trades t ON t.id = ts.trade_id
      WHERE t.telegram_id = s.telegram_id AND t.item_id = s.item_id AND ts.created_at >= COALESCE(u.inv_synced_at, 0)), 0)
      + COALESCE((SELECT SUM(p.quantity) FROM pending_sales p JOIN trades t ON t.id = p.trade_id
      WHERE p.telegram_id = s.telegram_id AND t.item_id = s.item_id AND p.created_at >= COALESCE(u.inv_synced_at, 0)), 0) AS sold
    FROM steam_inventory s JOIN users u ON u.telegram_id = s.telegram_id WHERE s.telegram_id = ?`).bind(tid).all<{ item_id: number; qty: number; sold: number }>()).results;
  const out: D1PreparedStatement[] = [];
  for (const o of old) {
    const n = fresh.get(o.item_id);
    if (n === undefined && partial) continue;
    const diff = o.qty - (n ?? 0) - o.sold;
    if (diff > 0) out.push(d.prepare('INSERT INTO inv_gone (telegram_id, item_id, qty, gone_at) VALUES (?, ?, ?, ?)').bind(tid, o.item_id, diff, now));
    if (out.length >= 200) break;
  }
  return out;
}
