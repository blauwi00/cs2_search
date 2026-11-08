// Защита обмена Steam («трейд-бан»): купленное нельзя продать или передать 7 дней.
// Такие предметы Steam не показывает в открытом инвентаре (их видит только владелец после входа),
// поэтому бот узнаёт о них из записанных покупок: показывает с замком и пишет, когда продажа станет возможной.
import * as db from '../storage/db.ts';
import { loadUserSettings, nextAllowed } from './audience.ts';
import { TERMS_VERSION } from './terms.ts';
import { steamEstKop } from './sellalerts.ts';
import { steamSellerProceeds } from './fees.ts';
import { CALC_SITES } from './calc.ts';
import { siteMedianKop, AVG_DOUBT_RATIO } from './evidence.ts';
import { SITE_PRICE_KIND } from './sites.ts';
import { toKop } from '../currency/nbu.ts';
import { formatUah } from '../utils/money.ts';
import { warsawDate } from '../utils/time.ts';
import { esc, type Keyboard } from '../telegram/api.ts';

export const TRADE_LOCK_SEC = 7 * 86400;
/** Напоминание шлём в течение 2 суток после окончания защиты (позже — уже неактуально). */
const NOTIFY_WINDOW_SEC = 2 * 86400;

/**
 * Когда закончится защита обмена. Записали в день покупки — от момента записи (точнее не знаем).
 * Дата покупки раньше — от конца того дня (лучше напомнить чуть позже, чем раньше времени).
 */
export function unlockAt(buyDate: string, createdAt: number): number {
  if (warsawDate(createdAt) === buyDate) return createdAt + TRADE_LOCK_SEC;
  const end = Date.parse(`${buyDate}T23:59:59Z`) / 1000;
  return (Number.isFinite(end) ? Math.min(end, createdAt) : createdAt) + TRADE_LOCK_SEC;
}

/** Самая низкая комиссия продавца среди площадок с выводом денег — для «живыми деньгами придёт ≈». */
const BEST_CASH = CALC_SITES.reduce((a, b) => (b.feeBp < a.feeBp ? b : a));

interface Row {
  id: number; tid: number; item_id: number; buy_date: string; created_at: number; q: number; quantity: number; buy_price_kop: number; buy_fee_kop: number;
  name: string; live_kop: number | null; live_at: number | null; d1: number | null; d7: number | null; updated_at: number | null; site_json: string | null;
}

export async function jobTradeUnlock(ctx: { db: D1Database; now: number }): Promise<{ sent: number }> {
  const d = ctx.db, now = ctx.now;
  const rows = (await d.prepare(`SELECT t.id, t.telegram_id AS tid, t.item_id, t.buy_date, t.created_at, t.quantity - t.sold_quantity AS q, t.quantity, t.buy_price_kop, t.buy_fee_kop,
      i.market_hash_name AS name, ql.price_kop AS live_kop, ql.fetched_at AS live_at, s.d1, s.d7, s.updated_at, sp.json AS site_json
    FROM trades t JOIN items i ON i.id = t.item_id
    LEFT JOIN market_quotes ql ON ql.item_id = t.item_id AND ql.source = 'steam' AND ql.price_type = 'lowest_listing'
    LEFT JOIN steam_avg s ON s.item_id = t.item_id
    LEFT JOIN site_prices sp ON sp.name = i.market_hash_name AND sp.updated_at >= ?
    WHERE t.status = 'open' AND t.quantity > t.sold_quantity AND t.created_at >= ? AND t.created_at <= ? LIMIT 300`)
    .bind(now - 2 * 86400, now - TRADE_LOCK_SEC - NOTIFY_WINDOW_SEC - 2 * 86400, now - TRADE_LOCK_SEC).all<Row>()).results
    .filter((r) => { const u = unlockAt(r.buy_date, r.created_at); return u <= now && now - u < NOTIFY_WINDOW_SEC; });
  if (!rows.length) return { sent: 0 };
  const refs = rows.map((r) => `unlock:${r.id}`);
  const done = new Set((await d.prepare(`SELECT ref FROM outbox WHERE kind = 'trade_unlock' AND ref IN (${refs.map(() => '?').join(',')})`).bind(...refs).all<{ ref: string }>()).results.map((x) => x.ref));
  const todo = rows.filter((r) => !done.has(`unlock:${r.id}`)).slice(0, 40);
  if (!todo.length) return { sent: 0 };
  const [st, fx, originRow] = await Promise.all([
    loadUserSettings(d, [...new Set(todo.map((r) => r.tid))]), db.loadLatestFx(d),
    d.prepare(`SELECT value FROM meta WHERE key = 'public_origin'`).first<{ value: string }>(),
  ]);
  const usd = fx.get('USD') ?? null, origin = originRow?.value ?? null;
  const writes: D1PreparedStatement[] = [];
  for (const r of todo) {
    const s = st.get(r.tid);
    if (!s || s.notify_enabled !== '1' || s.sig_inventory !== '1' || s.terms_ok !== TERMS_VERSION) continue;
    const text = unlockText(r, usd, now);
    const kb: Keyboard = [
      [{ text: '💰 Открыть в Steam', url: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(r.name)}` }],
      ...(origin ? [[{ text: '🎒 Цены на площадках', web_app: { url: `${origin}/app#inv` } }]] : []),
      [{ text: '💸 Продал', callback_data: `sl:${r.id}` }],
    ];
    writes.push(d.prepare(`INSERT INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
      VALUES (?, 'trade_unlock', ?, NULL, ?, ?, NULL, ?, ?)`).bind(r.tid, `unlock:${r.id}`, text, JSON.stringify(kb), nextAllowed(now, db.num(s.quiet_start), db.num(s.quiet_end)), now));
  }
  for (let i = 0; i < writes.length; i += 90) await d.batch(writes.slice(i, i + 90));
  return { sent: writes.length };
}

export function unlockText(r: Pick<Row, 'name' | 'q' | 'quantity' | 'buy_price_kop' | 'buy_fee_kop' | 'live_kop' | 'live_at' | 'd1' | 'd7' | 'updated_at' | 'site_json'>,
  usd: Parameters<typeof toKop>[2] | null, now: number): string {
  const cost = r.buy_price_kop + Math.round(r.buy_fee_kop / Math.max(1, r.quantity));
  let site: number | null = null;
  try {
    const c = r.site_json ? JSON.parse(r.site_json) as Record<string, unknown> : {};
    site = usd ? siteMedianKop(Object.entries(c).filter(([k, v]) => typeof v === 'number' && SITE_PRICE_KIND[k] !== 'reference').map(([, v]) => toKop(v as number, 'USD', usd) ?? 0)) : null;
  } catch { site = null; }
  const live = r.live_at && now - r.live_at < 6 * 3600 && r.live_kop ? r.live_kop : null;
  let steam = steamEstKop(r.live_at ? { price_kop: r.live_kop, fetched_at: r.live_at } : null, { d1: r.d1, d7: r.d7, updated_at: r.updated_at ?? 0 }, usd, now);
  if (!live && steam && site && site * AVG_DOUBT_RATIO < steam) steam = null; // средняя Steam устарела — не выдаём её за цену
  const diff = (get: number) => { const p = get - cost; return ` (${p >= 0 ? '+' : '−'}${formatUah(Math.abs(p))} к покупке)`; };
  const lines = [
    '🔓 <b>Можно продавать</b>', '',
    `<b>${esc(r.name)}</b>${r.q > 1 ? ` ×${r.q}` : ''}`,
    'Прошло 7 дней защиты обмена Steam — предмет снова можно продать.',
    `Куплено за ${formatUah(cost)} за 1 шт.`, '',
  ];
  const net = steam ? steamSellerProceeds(Math.max(3, steam))?.sellerReceives ?? null : null;
  if (steam && net) lines.push(`🎮 Steam: ${live ? '' : '≈ '}${formatUah(steam)} → на баланс Steam ≈ <b>${formatUah(net)}</b>${diff(net)}`);
  else lines.push('🎮 Steam: свежей цены нет — посмотри самое дешёвое объявление на странице Steam.');
  if (site) {
    const get = Math.floor((site * (10000 - BEST_CASH.feeBp)) / 10000);
    lines.push(`💵 Площадки: ≈ ${formatUah(site)} → после ${(BEST_CASH.feeBp / 100).toString().replace('.', ',')}% ${esc(BEST_CASH.name)} ≈ <b>${formatUah(get)}</b> живыми деньгами${diff(get)}`);
  }
  lines.push('', '<i>Цены меняются — сверь перед продажей. Решение за тобой: бот ничего не продаёт сам.</i>');
  return lines.join('\n');
}
