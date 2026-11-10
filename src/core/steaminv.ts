// Инвентарь Steam прямо из Worker — по кнопке «Обновить» (сборщику на GitHub Steam отвечает 429).
// Один-два запроса к публичной странице инвентаря, без входа в аккаунт. Не вышло — остаётся обычная очередь сборщика.
// Подробности предметов (float, наклейки) сборщик собирает полнее — здесь их не трогаем, только состав и количество.

import * as db from '../storage/db.ts';
import { safeImg } from './recs.ts';

export type InvFetch =
  | { status: 'ok'; steamId: string; items: { name: string; qty: number; marketable: number; tradable: number; img: string | null }[]; partial: boolean }
  | { status: 'private' | 'not_found' | 'blocked' | 'rate_limited' | 'error'; steamId: string | null; diag?: string };

const UA = 'Mozilla/5.0 (compatible; CenolovBot/1.0; +https://t.me/cenolow_bot)';

/**
 * Публичная страница инвентаря: открыт ли он на самом деле. Steam часто отвечает 403 / success:false на JSON
 * серверам дата-центров (Cloudflare, GitHub), хотя инвентарь открыт, — поэтому «закрыт» говорим только по странице.
 * open — есть вкладка «Counter-Strike 2»; private — Steam пишет, что профиль или инвентарь закрыт; unknown — не понять.
 */
export function classifyInventoryPage(html: string): 'open' | 'private' | 'unknown' {
  // Вкладка CS2 видна — инвентарь открыт, что бы ещё ни было на странице (сначала её, потом слова о приватности).
  if (/games_list_tab_name">\s*Counter-Strike 2\s*</.test(html) || /Counter-Strike 2 \(\d+\)/.test(html)) return 'open';
  if (/inventory is currently private|profile_private_info|This profile is private|private_profile/i.test(html)) return 'private';
  return 'unknown';
}

/** JSON не отдали (403 / success:false) — смотрим публичную страницу: blocked (открыт, Steam не отдал) / private / error. */
export async function recheckByPage(fetcher: typeof fetch, id: string): Promise<{ status: 'blocked' | 'private' | 'rate_limited' | 'error'; page: string }> {
  try {
    const r = await fetcher(`https://steamcommunity.com/profiles/${id}/inventory/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (r.status === 429) return { status: 'rate_limited', page: 'HTTP 429' };
    if (!r.ok) return { status: 'error', page: `HTTP ${r.status}` };
    const c = classifyInventoryPage(await r.text());
    return { status: c === 'open' ? 'blocked' : c === 'private' ? 'private' : 'error', page: c === 'open' ? 'открыт' : c === 'private' ? 'закрыт' : 'не понять' };
  } catch (e) { return { status: 'error', page: 'сбой: ' + String(e instanceof Error ? e.message : e).slice(0, 60) }; }
}
const viaPage = async (fetcher: typeof fetch, id: string, json: string): Promise<InvFetch> => {
  const p = await recheckByPage(fetcher, id);
  return { status: p.status, steamId: id, diag: `JSON: ${json} · страница: ${p.page}` };
};

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
  const r = await fetcher(`https://steamcommunity.com/inventory/${id}/730/2?l=english&count=500`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://steamcommunity.com/profiles/${id}/inventory/` },
  });
  if (r.status === 429) return { status: 'rate_limited', steamId: id };
  if (r.status === 401 || r.status === 403) return viaPage(fetcher, id, `HTTP ${r.status}`);
  if (!r.ok) return { status: r.status === 404 ? 'not_found' : 'error', steamId: id, diag: `JSON: HTTP ${r.status}` };
  const j = await r.json().catch(() => null) as { success?: unknown; assets?: { classid: string; instanceid: string; amount?: string }[]; descriptions?: { classid: string; instanceid: string; market_hash_name?: string; marketable?: number; tradable?: number; icon_url?: string }[]; more_items?: unknown } | null;
  if (!j || j.success === false) return viaPage(fetcher, id, j ? 'success:false' : 'пустой ответ');
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
  // 429 — не новость о пользователе: статус не трогаем, повторит сборщик.
  if (res.status === 'rate_limited') return;
  if (res.status !== 'ok') return invFailure(d, tid, res.status, now, { src: 'сервер бота', diag: res.diag });
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
    ...invSuccessStmts(d, tid),
    invCheckStmt(d, tid, { src: 'сервер бота', status: 'ok', diag: `получено ${res.items.length} предм.` }, now),
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

// ---------- Неудачи: не стираем инвентарь от одного отказа Steam ----------
/** Повторы после отказа: 15 мин → 1 ч → 6 ч (дальше — раз в 6 ч). */
export const INV_RETRY_SEC = [15 * 60, 3600, 6 * 3600];
/** «Закрыт» подтверждаем двумя проверками с разницей не меньше 6 часов — только тогда удаляем сохранённый инвентарь. */
export const INV_CONFIRM_SEC = 6 * 3600;

const setKey = (d: D1Database, tid: number, key: string, value: string, now: number) =>
  d.prepare('INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(tid, key, value, now);

/** Последняя проверка инвентаря (кто проверял, что ответил Steam) — владелец видит её под статусом, чтобы разбираться с отказами Steam. */
export function invCheckStmt(d: D1Database, tid: number, c: { src: string; status: string; diag?: string }, now: number): D1PreparedStatement {
  return setKey(d, tid, 'inv_check', JSON.stringify({ at: now, src: c.src, status: c.status, diag: (c.diag ?? '').slice(0, 160) }), now);
}

/** Удачное обновление — сбрасываем счётчик повторов и неподтверждённое «закрыт». */
export function invSuccessStmts(d: D1Database, tid: number): D1PreparedStatement[] {
  return [d.prepare(`DELETE FROM user_settings WHERE telegram_id = ? AND key IN ('inv_retry', 'inv_private_at')`).bind(tid)];
}

/**
 * Отказ Steam. Сохранённый инвентарь и время последнего удачного обновления не трогаем (покажем «обновлён N назад»).
 * blocked — открыт, но Steam не отдал серверу: статус для честного текста + повтор с паузой.
 * private / not_found — первая проверка только запоминается; удаляем, если через ≥ 6 ч снова так же.
 * error — ничего не меняем, только пауза перед повтором. rate_limited — как раньше: статус, повторит сборщик.
 */
export async function invFailure(d: D1Database, tid: number, status: Exclude<InvFetch['status'], 'ok'>, now: number, check: { src: string; diag?: string } = { src: 'сборщик' }): Promise<void> {
  if (status === 'rate_limited') { await d.batch([d.prepare('UPDATE users SET inv_status = ? WHERE telegram_id = ?').bind(status, tid), invCheckStmt(d, tid, { ...check, status }, now)]); return; }
  await invCheckStmt(d, tid, { ...check, status }, now).run();
  const rows = (await d.prepare(`SELECT key, value FROM user_settings WHERE telegram_id = ? AND key IN ('inv_retry', 'inv_private_at')`).bind(tid).all<{ key: string; value: string }>()).results;
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let retry = { n: 0, at: 0 };
  try { retry = { ...retry, ...JSON.parse(kv.inv_retry ?? '{}') }; } catch { /* битое значение — начнём сначала */ }
  const n = retry.n + 1;
  const next = setKey(d, tid, 'inv_retry', JSON.stringify({ n, at: now + INV_RETRY_SEC[Math.min(n, INV_RETRY_SEC.length) - 1] }), now);
  if (status === 'private' || status === 'not_found') {
    const first = Number(kv.inv_private_at) || 0;
    if (first && now - first >= INV_CONFIRM_SEC) {
      // Подтверждено дважды — теперь и правда закрыт: убираем сохранённый состав, из очереди выходим.
      await d.batch([
        d.prepare('UPDATE users SET inv_synced_at = ?, inv_status = ? WHERE telegram_id = ?').bind(now, status, tid),
        d.prepare('DELETE FROM steam_inventory WHERE telegram_id = ?').bind(tid),
        ...invSuccessStmts(d, tid),
      ]);
      return;
    }
    await d.batch([
      d.prepare('UPDATE users SET inv_status = ? WHERE telegram_id = ?').bind(status, tid),
      ...(first ? [] : [setKey(d, tid, 'inv_private_at', String(now), now)]),
      next,
    ]);
    return;
  }
  await d.batch([...(status === 'blocked' ? [d.prepare('UPDATE users SET inv_status = ? WHERE telegram_id = ?').bind('blocked', tid)] : []), next]);
}

/** Что пропало из инвентаря по сравнению с прошлым разом (только если прошлый раз был). Неполный ответ — только уменьшения. */
export async function goneStmts(d: D1Database, tid: number, fresh: Map<number, number>, partial: boolean, now: number): Promise<D1PreparedStatement[]> {
  // Минус то, что уже записано как продажа после прошлого обновления (кнопка «Я продал» до «Обновить»).
  const old = (await d.prepare(`SELECT s.item_id, s.qty, COALESCE((SELECT SUM(ts.quantity) FROM trade_sales ts JOIN trades t ON t.id = ts.trade_id
      WHERE t.telegram_id = s.telegram_id AND t.item_id = s.item_id AND ts.created_at >= COALESCE(u.inv_synced_at, 0)), 0)
      + COALESCE((SELECT SUM(p.quantity) FROM pending_sales p JOIN trades t ON t.id = p.trade_id
      WHERE p.telegram_id = s.telegram_id AND t.item_id = s.item_id AND p.created_at >= COALESCE(u.inv_synced_at, 0)), 0)
      -- …но не то, что записано через само «Пропало»: эта пропажа уже учтена прошлым обновлением (иначе вычли бы дважды).
      - COALESCE((SELECT SUM(g.qty) FROM inv_gone g WHERE g.telegram_id = s.telegram_id AND g.item_id = s.item_id AND g.status = 'sold'
      AND g.gone_at >= COALESCE(u.inv_synced_at, 0)), 0) AS sold
    FROM steam_inventory s JOIN users u ON u.telegram_id = s.telegram_id WHERE s.telegram_id = ?`).bind(tid).all<{ item_id: number; qty: number; sold: number }>()).results;
  const out: D1PreparedStatement[] = [];
  for (const o of old) {
    const n = fresh.get(o.item_id);
    if (n === undefined && partial) continue;
    const diff = o.qty - (n ?? 0) - Math.max(0, o.sold);
    if (diff > 0) out.push(d.prepare('INSERT INTO inv_gone (telegram_id, item_id, qty, gone_at) VALUES (?, ?, ?, ?)').bind(tid, o.item_id, diff, now));
    if (out.length >= 200) break;
  }
  return out;
}
