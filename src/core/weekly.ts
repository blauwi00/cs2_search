// #3: по воскресеньям вечером — «твой инвентарь Steam за неделю: +N». Сравниваем со снимком прошлого воскресенья
// (цены — средние продажи Steam за сутки из открытого прайса, в долларах; в сообщении — в валюте человека).
// Первый раз — только текущая оценка и обещание показать изменения через неделю.
import * as db from '../storage/db.ts';
import { loadUserSettings, nextAllowed } from './audience.ts';
import { TERMS_VERSION } from './terms.ts';
import { toKop, type FxRate } from '../currency/nbu.ts';
import { formatUah, formatSignedUah } from '../utils/money.ts';
import { esc, type Keyboard } from '../telegram/api.ts';
import { warsawDate, warsawHour } from '../utils/time.ts';

export const WEEKLY_HOUR = 18;          // воскресенье, после 18:00 по Варшаве
const PER_RUN = 15;
const SNAP_ITEMS = 80;

interface Snap { d: string; t: number; i: Record<string, number> }
interface Ctx { db: D1Database; now: number }

export const isSunday = (t: number) => new Date(`${warsawDate(t)}T12:00:00Z`).getUTCDay() === 0;

export function weeklyText(now: { total: number; items: { id: number; name: string; qty: number; unit: number }[] }, prev: Snap | null, usd: FxRate | null): string | null {
  const k = (c: number) => toKop(c, 'USD', usd);
  const total = k(now.total);
  if (total == null) return null;
  if (!prev) {
    return ['📦 <b>Твой инвентарь Steam</b>', '', `Сейчас стоит ≈ <b>${formatUah(total)}</b> (по средним продажам в Steam за сутки).`, '',
      'Каждое воскресенье вечером буду присылать, как он изменился за неделю.'].join('\n');
  }
  const diffC = now.total - prev.t;
  const diff = k(diffC) ?? 0;
  const pct = prev.t > 0 ? (diffC / prev.t) * 100 : 0;
  const icon = Math.abs(pct) < 0.5 ? '➖' : diff > 0 ? '📈' : '📉';
  // Кто сильнее всего сдвинул стоимость (только предметы, которые были и неделю назад).
  const moves = now.items.filter((x) => prev.i[x.id] != null).map((x) => ({ name: x.name, d: (x.unit - prev.i[x.id]) * x.qty, p: prev.i[x.id] > 0 ? ((x.unit - prev.i[x.id]) / prev.i[x.id]) * 100 : 0 }))
    .filter((x) => Math.abs(x.p) >= 1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
  return [
    `${icon} <b>Твой инвентарь за неделю: ${formatSignedUah(diff)}</b> (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1).replace('.', ',')}%)`, '',
    `Сейчас ≈ <b>${formatUah(total)}</b>`,
    ...(moves.length ? ['', '<b>Сильнее всего изменились:</b>', ...moves.map((m) => `${m.d >= 0 ? '▲' : '▼'} ${esc(m.name)}: ${formatSignedUah(k(m.d) ?? 0)}`)] : []),
    '', '<i>Оценка по средним продажам в Steam, а не прибыль. Сумма — если продать всё в Steam до комиссии.</i>',
  ].join('\n');
}

export function weeklyKeyboard(origin: string | null): Keyboard {
  return [
    ...(origin ? [[{ text: '🎒 Открыть инвентарь', web_app: { url: `${origin}/app#inv` } }]] : []),
    [{ text: '🔕 Не присылать по воскресеньям', callback_data: 'wk:off' }],
  ];
}

/** Недельный отчёт по инвентарю приостановлен 13.11.2026: суммы считались по завышенным средним Steam. Вернуть false после перехода на живые цены. */
export const WEEKLY_PAUSED = true;
export async function jobWeekly(ctx: Ctx): Promise<{ queued: number }> {
  if (WEEKLY_PAUSED || !isSunday(ctx.now) || warsawHour(ctx.now) < WEEKLY_HOUR) return { queued: 0 };
  const d = ctx.db;
  const today = warsawDate(ctx.now);
  const cands = (await d.prepare(`SELECT DISTINCT v.telegram_id AS tid FROM steam_inventory v
    WHERE NOT EXISTS (SELECT 1 FROM user_settings s WHERE s.telegram_id = v.telegram_id AND s.key = 'inv_week' AND s.value LIKE ?)
    ORDER BY v.telegram_id LIMIT ?`).bind(`{"d":"${today}"%`, PER_RUN * 3).all<{ tid: number }>()).results.map((r) => r.tid);
  if (!cands.length) return { queued: 0 };
  const st = await loadUserSettings(d, cands);
  const users = cands.filter((t) => { const s = st.get(t)!; return s.weekly_report === '1' && s.notify_enabled === '1' && s.terms_ok === TERMS_VERSION; }).slice(0, PER_RUN);
  const skip = cands.filter((t) => !users.includes(t));
  const usd = (await db.loadLatestFx(d)).get('USD') ?? null;
  const ph = users.map(() => '?').join(',');
  const rows = users.length ? (await d.prepare(`SELECT v.telegram_id AS tid, v.item_id AS id, i.market_hash_name AS name, v.qty, COALESCE(a.d1, a.d7) AS unit
    FROM steam_inventory v JOIN items i ON i.id = v.item_id JOIN steam_avg a ON a.item_id = v.item_id
    WHERE v.marketable = 1 AND v.telegram_id IN (${ph}) AND COALESCE(a.d1, a.d7) > 0 AND a.updated_at >= ?`).bind(...users, ctx.now - 48 * 3600).all<{ tid: number; id: number; name: string; qty: number; unit: number }>()).results : [];
  const origin = (await d.prepare(`SELECT value FROM meta WHERE key = 'public_origin'`).first<{ value: string }>())?.value ?? null;
  const writes: D1PreparedStatement[] = [];
  const mark = (tid: number, snap: Snap) => d.prepare(`INSERT INTO user_settings (telegram_id, key, value, updated_at) VALUES (?, 'inv_week', ?, ?)
    ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(tid, JSON.stringify(snap), ctx.now);
  let queued = 0;
  for (const tid of users) {
    const items = rows.filter((r) => r.tid === tid);
    const s = st.get(tid)!;
    let prev: Snap | null = null;
    try { prev = s.inv_week ? JSON.parse(s.inv_week) : null; } catch { prev = null; }
    if (prev && prev.d === today) continue;
    const total = items.reduce((a, x) => a + x.unit * x.qty, 0);
    const top = [...items].sort((a, b) => b.unit * b.qty - a.unit * a.qty).slice(0, SNAP_ITEMS);
    const snap: Snap = { d: today, t: total, i: Object.fromEntries(top.map((x) => [x.id, x.unit])) };
    writes.push(mark(tid, snap));
    // Снимок старше 10 дней — сравнивать нечестно (не «за неделю»): начинаем заново.
    const fresh = prev && (Date.parse(today) - Date.parse(prev.d)) / 86400000 <= 10 ? prev : null;
    const text = total > 0 ? weeklyText({ total, items }, fresh, usd) : null;
    if (!text) continue;
    writes.push(d.prepare(`INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
      VALUES (?, 'weekly', ?, NULL, ?, ?, NULL, ?, ?)`).bind(tid, `week:${today}`, text, JSON.stringify(weeklyKeyboard(origin)), nextAllowed(ctx.now, db.num(s.quiet_start), db.num(s.quiet_end)), ctx.now));
    queued++;
  }
  // Тем, кому не шлём (выключено), — только отметка, чтобы не перебирать их снова сегодня.
  for (const tid of skip) writes.push(mark(tid, { d: today, t: 0, i: {} }));
  for (let i = 0; i < writes.length; i += 90) await d.batch(writes.slice(i, i + 90));
  return { queued };
}
