// Бот для всех: кому и когда отправлять уведомление.
// Сигналы считаются один раз на предмет (общие пороги системы), а рассылка идёт каждому, кто следит за предметом,
// с учётом ЕГО настроек: включены ли уведомления, пороги прибыли, минимальный приоритет, тихие часы.
// Сообщения кладутся в очередь outbox, отправляет их отдельная задача (лимит Telegram и Worker на вызов).

import { DEFAULT_SETTINGS, num, type Settings } from '../storage/db.ts';
import type { Keyboard } from '../telegram/api.ts';
import type { Priority } from './scoring.ts';
import { warsawHour, inQuietHours } from '../utils/time.ts';

/** Лимит предметов в списке наблюдения на одного человека (админ — без лимита). */
export const WATCH_LIMIT = 20;
/** Открытых позиций инвентаря на человека (их предметы тоже опрашиваются, поэтому тоже с потолком). */
export const LOTS_LIMIT = 60;

/**
 * Пороги, по которым система находит сигналы. Ниже пользовательских по умолчанию,
 * чтобы человек с более низкими порогами тоже получил сделку; дальше фильтрует каждый сам.
 */
export const SYSTEM_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  min_profit_kop: '500', min_roi_bp: '300', min_priority: 'low',
  notify_enabled: '1', quiet_start: '0', quiet_end: '0', max_per_hour: '1000',
  sig_arbitrage: '1', sig_change: '1', sig_target: '1', sig_inventory: '1',
};

const RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };
export type NotifyKind = 'arbitrage' | 'target' | 'change' | 'inventory';
const KIND_SETTING: Record<NotifyKind, keyof Settings> = { arbitrage: 'sig_arbitrage', target: 'sig_target', change: 'sig_change', inventory: 'sig_inventory' };

export interface Delivery {
  kind: NotifyKind; ref: string; signalId: number | null; priority: Priority;
  spreadKop?: number | null; roiBp?: number | null; buyKop?: number | null;
  text: string; keyboard: Keyboard;
}

/** Подходит ли уведомление человеку по его настройкам. null — не отправлять. Иначе — когда (с учётом тихих часов). */
export function deliverAt(s: Settings, d: Delivery, now: number): number | null {
  if (s.notify_enabled !== '1' || s[KIND_SETTING[d.kind]] !== '1') return null;
  const minP = (['low', 'medium', 'high'].includes(s.min_priority) ? s.min_priority : 'medium') as Priority;
  if (d.kind !== 'target' && d.kind !== 'inventory' && RANK[d.priority] < RANK[minP]) return null;
  if (d.kind === 'arbitrage') {
    if (d.spreadKop == null || d.spreadKop < num(s.min_profit_kop)) return null;
    if (d.roiBp == null || d.roiBp < num(s.min_roi_bp)) return null;
    const maxBuy = num(s.max_buy_kop);
    if (maxBuy > 0 && d.buyKop != null && d.buyKop > maxBuy) return null;
  }
  return nextAllowed(now, num(s.quiet_start), num(s.quiet_end));
}

/** Ближайшее время вне тихих часов (по Варшаве), с точностью до минуты. */
export function nextAllowed(now: number, qs: number, qe: number): number {
  let t = now;
  for (let i = 0; i < 26 && inQuietHours(warsawHour(t), qs, qe); i++) t = (Math.floor(t / 3600) + 1) * 3600;
  return t;
}

export function withDefaults(rows: { key: string; value: string }[]): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in s) (s as Record<string, string>)[r.key] = r.value;
  return s;
}

/** Настройки нескольких людей одним запросом. */
export async function loadUserSettings(d: D1Database, tids: number[]): Promise<Map<number, Settings>> {
  const out = new Map<number, Settings>();
  const uniq = [...new Set(tids)].slice(0, 90);
  if (!uniq.length) return out;
  const rows = (await d.prepare(`SELECT telegram_id, key, value FROM user_settings WHERE telegram_id IN (${uniq.map(() => '?').join(',')})`)
    .bind(...uniq).all<{ telegram_id: number; key: string; value: string }>()).results;
  for (const t of uniq) out.set(t, withDefaults(rows.filter((r) => r.telegram_id === t)));
  return out;
}

export function enqueueStmt(d: D1Database, tid: number, del: Delivery, at: number, now: number): D1PreparedStatement {
  return d.prepare(
    `INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(tid, del.kind, `${del.ref}:${now}`, del.signalId, del.text, JSON.stringify(del.keyboard ?? []), at, now);
}

/** Правка уже отправленных сообщений сигнала (например, «НЕАКТУАЛЬНО») — тоже через очередь. */
export function enqueueEditsStmt(d: D1Database, signalId: number, text: string, now: number): D1PreparedStatement {
  return d.prepare(
    `INSERT OR IGNORE INTO outbox (telegram_id, kind, ref, signal_id, text, keyboard, edit_msg_id, not_before, created_at)
     SELECT telegram_id, 'edit', 'expired:' || ?, NULL, ?, '[]', msg_id, ?, ? FROM outbox
     WHERE signal_id = ? AND state = 'sent' AND msg_id IS NOT NULL AND edit_msg_id IS NULL AND sent_at >= ?`,
  ).bind(signalId, text, now, now, signalId, now - 2 * 86400);
}
