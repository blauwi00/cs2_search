// #8: цель продажи для предметов инвентаря Steam в одно нажатие. Цена — та же, что в «Инвентаре»:
// живой самый дешёвый лот Steam (если свежее 6 ч), иначе средняя продажа за сутки/неделю (меньшая).
// Дошла до цели — одно уведомление, цель помечается выполненной.
import * as db from '../storage/db.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { loadUserSettings, nextAllowed } from './audience.ts';
import { TERMS_VERSION } from './terms.ts';
import { formatUah } from '../utils/money.ts';
import { esc, type Keyboard } from '../telegram/api.ts';
import { steamSellerProceeds } from './fees.ts';
import { LIVE_MAX_AGE_SEC, AVG_MAX_AGE_SEC } from './evidence.ts';

export const MAX_SELL_ALERTS = 50;

export function steamEstKop(live: { price_kop: number | null; fetched_at: number } | null | undefined, sa: { d1: number | null; d7: number | null; updated_at?: number } | null | undefined, usd: FxRate | null, now: number): number | null {
  if (live?.price_kop && now - live.fetched_at < LIVE_MAX_AGE_SEC) return live.price_kop;
  if (sa?.updated_at !== undefined && now - sa.updated_at > AVG_MAX_AGE_SEC) return null; // устаревшие средние — не повод для уведомления
  return sa?.d7 && usd ? toKop(Math.min(sa.d7, sa.d1 ?? sa.d7), 'USD', usd) : null;
}

interface Ctx { db: D1Database; now: number }

export async function jobSellAlerts(ctx: Ctx): Promise<{ sent: number }> {
  const d = ctx.db;
  const rows = (await d.prepare(`SELECT a.telegram_id AS tid, a.item_id AS id, a.target_kop AS target, i.market_hash_name AS name,
      q.price_kop AS live_kop, q.fetched_at AS live_at, s.d1, s.d7, s.updated_at
    FROM sell_alerts a JOIN items i ON i.id = a.item_id
    LEFT JOIN market_quotes q ON q.item_id = a.item_id AND q.source = 'steam' AND q.price_type = 'lowest_listing'
    LEFT JOIN steam_avg s ON s.item_id = a.item_id
    WHERE a.notified_at IS NULL LIMIT 400`).all<{ tid: number; id: number; target: number; name: string; live_kop: number | null; live_at: number | null; d1: number | null; d7: number | null; updated_at: number | null }>()).results;
  if (!rows.length) return { sent: 0 };
  const usd = (await db.loadLatestFx(d)).get('USD') ?? null;
  const hit = rows.map((r) => ({ ...r, now: steamEstKop(r.live_at ? { price_kop: r.live_kop, fetched_at: r.live_at } : null, { d1: r.d1, d7: r.d7, updated_at: r.updated_at ?? 0 }, usd, ctx.now) }))
    .filter((r) => r.now != null && r.now >= r.target).slice(0, 40);
  if (!hit.length) return { sent: 0 };
  const st = await loadUserSettings(d, [...new Set(hit.map((r) => r.tid))]);
  const origin = (await d.prepare(`SELECT value FROM meta WHERE key = 'public_origin'`).first<{ value: string }>())?.value ?? null;
  const writes: D1PreparedStatement[] = [];
  let sent = 0;
  for (const r of hit) {
    writes.push(d.prepare('UPDATE sell_alerts SET notified_at = ? WHERE telegram_id = ? AND item_id = ?').bind(ctx.now, r.tid, r.id));
    const s = st.get(r.tid);
    if (!s || s.notify_enabled !== '1' || s.sig_target !== '1' || s.terms_ok !== TERMS_VERSION) continue;
    const net = steamSellerProceeds(Math.max(3, r.now!))?.sellerReceives ?? null;
    const text = [
      '🎯 <b>Цена дошла до твоей цели</b>', '',
      `<b>${esc(r.name)}</b>`,
      `Сейчас в Steam ≈ <b>${formatUah(r.now)}</b> (цель ${formatUah(r.target)})`,
      net ? `На баланс придёт ≈ ${formatUah(net)} за 1 шт. после 15% Steam` : '',
      '', '<i>Цена может быстро уйти обратно — проверь на странице Steam перед продажей. Цель снята; поставить новую можно в приложении.</i>',
    ].filter((x) => x !== '').join('\n').replace('\n\n<i>', '\n\n<i>');
    const kb: Keyboard = [
      [{ text: '💰 Открыть в Steam', url: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(r.name)}` }],
      ...(origin ? [[{ text: '🎒 Инвентарь в приложении', web_app: { url: `${origin}/app#inv` } }]] : []),
    ];
    writes.push(d.prepare(`INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
      VALUES (?, 'sell_target', ?, NULL, ?, ?, NULL, ?, ?)`).bind(r.tid, `sell:${r.id}:${r.target}`, text, JSON.stringify(kb), nextAllowed(ctx.now, db.num(s.quiet_start), db.num(s.quiet_end)), ctx.now));
    sent++;
  }
  for (let i = 0; i < writes.length; i += 90) await d.batch(writes.slice(i, i + 90));
  return { sent };
}
