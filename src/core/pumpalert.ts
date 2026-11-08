// «Похоже на разгон» для предметов, которые у человека есть (инвентарь Steam или записанные покупки).
// Разгоны обычно сдуваются — держателю это повод подумать о продаже, пока цена высокая.
// Запускается после свежих средних цен Steam (прайс обновляется раз в несколько часов); одно сообщение на предмет в неделю.
import * as db from '../storage/db.ts';
import { loadUserSettings, nextAllowed } from './audience.ts';
import { TERMS_VERSION } from './terms.ts';
import { pumpCheck, PUMP_RISE } from './pump.ts';
import { siteMedianKop } from './evidence.ts';
import { SITE_PRICE_KIND } from './sites.ts';
import { toKop } from '../currency/nbu.ts';
import { formatUah } from '../utils/money.ts';
import { esc, type Keyboard } from '../telegram/api.ts';

const WEEK = 7 * 86400;

interface Row { tid: number; item_id: number; name: string; d1: number; d30: number; vol: number | null; site_json: string | null }

export async function jobPumpAlerts(ctx: { db: D1Database; now: number }): Promise<{ sent: number }> {
  const d = ctx.db, now = ctx.now;
  // Владельцы: открытый инвентарь Steam + записанные непроданные покупки. Средние — свежие (≤ 48 ч), рост за месяц от 30%.
  const rows = (await d.prepare(`SELECT o.tid, o.item_id, i.market_hash_name AS name, sa.d1, sa.d30, q.volume AS vol, sp.json AS site_json FROM (
      SELECT telegram_id AS tid, item_id FROM steam_inventory WHERE marketable = 1
      UNION SELECT telegram_id AS tid, item_id FROM trades WHERE status = 'open' AND quantity > sold_quantity
    ) o JOIN items i ON i.id = o.item_id JOIN steam_avg sa ON sa.item_id = o.item_id
    LEFT JOIN market_quotes q ON q.item_id = o.item_id AND q.source = 'steam' AND q.price_type = 'median_24h' AND q.fetched_at >= ?
    LEFT JOIN site_prices sp ON sp.name = i.market_hash_name AND sp.updated_at >= ?
    WHERE sa.updated_at >= ? AND sa.d1 IS NOT NULL AND sa.d30 IS NOT NULL AND sa.d1 >= sa.d30 * ? LIMIT 300`)
    .bind(now - 6 * 3600, now - 48 * 3600, now - 48 * 3600, PUMP_RISE).all<Row>()).results;
  if (!rows.length) return { sent: 0 };
  const week = Math.floor(now / WEEK);
  const hits = rows.map((r) => {
    let site: number | null = null;
    try {
      const c = r.site_json ? JSON.parse(r.site_json) as Record<string, unknown> : {};
      site = siteMedianKop(Object.entries(c).filter(([k, v]) => typeof v === 'number' && SITE_PRICE_KIND[k] !== 'reference').map(([, v]) => v as number));
    } catch { site = null; }
    return { r, pump: pumpCheck({ d1: r.d1, d30: r.d30, vol24: r.vol, siteNow: site }) };
  }).filter((x) => x.pump);
  if (!hits.length) return { sent: 0 };
  const refs = [...new Set(hits.map((x) => `pump:${x.r.item_id}:${week}`))];
  const done = new Set<string>();
  for (let i = 0; i < refs.length; i += 90) {
    const p = refs.slice(i, i + 90);
    for (const x of (await d.prepare(`SELECT telegram_id AS tid, ref FROM outbox WHERE kind = 'pump_alert' AND ref IN (${p.map(() => '?').join(',')})`).bind(...p).all<{ tid: number; ref: string }>()).results) done.add(`${x.tid}|${x.ref}`);
  }
  const todo = hits.filter((x) => !done.has(`${x.r.tid}|pump:${x.r.item_id}:${week}`)).slice(0, 40);
  if (!todo.length) return { sent: 0 };
  const [st, fx] = await Promise.all([loadUserSettings(d, [...new Set(todo.map((x) => x.r.tid))]), db.loadLatestFx(d)]);
  const usd = fx.get('USD') ?? null;
  const writes: D1PreparedStatement[] = [];
  for (const { r, pump } of todo) {
    const s = st.get(r.tid);
    if (!s || s.notify_enabled !== '1' || s.sig_inventory !== '1' || s.terms_ok !== TERMS_VERSION) continue;
    const k = (c: number) => (usd ? toKop(c, 'USD', usd) : null);
    const now1 = k(r.d1), m30 = k(r.d30);
    const text = [
      '⚠️ <b>Похоже на разгон цены</b>', '',
      `<b>${esc(r.name)}</b> — есть у тебя`,
      `Средняя цена продаж в Steam за сутки${now1 ? ` ≈ ${formatUah(now1)}` : ''} — на ${Math.round(pump!.riseBp / 100)}% выше, чем за месяц${m30 ? ` (≈ ${formatUah(m30)})` : ''}.`, '',
      'Почему похоже на разгон:', ...pump!.reasons.map((x) => `• ${esc(x)}`), '',
      'Разгоны обычно сдуваются: цену поднимают, чтобы продать на пике. Если думал продавать — сейчас может быть хороший момент. Докупать на пике — рискованно.',
      '<i>Это средние продажи (история) — проверь текущие объявления в Steam перед продажей. Решение за тобой.</i>',
    ].join('\n');
    const kb: Keyboard = [[{ text: '💰 Открыть в Steam', url: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(r.name)}` }]];
    writes.push(d.prepare(`INSERT INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
      VALUES (?, 'pump_alert', ?, NULL, ?, ?, NULL, ?, ?)`).bind(r.tid, `pump:${r.item_id}:${week}`, text, JSON.stringify(kb), nextAllowed(now, db.num(s.quiet_start), db.num(s.quiet_end)), now));
  }
  for (let i = 0; i < writes.length; i += 90) await d.batch(writes.slice(i, i + 90));
  return { sent: writes.length };
}
