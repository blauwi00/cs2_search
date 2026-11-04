import { inQuietHours } from '../utils/time.ts';
import type { Priority } from './scoring.ts';

export interface PreviousSignal {
  state: string;
  spreadKop: number | null;
  buyKop: number | null;
  notifiedAt: number | null;
  priority: string;
}

export interface NotifyPolicy {
  cooldownSec: number;          // минимальный интервал повтора по одному сигналу
  materialChangeBp: number;     // насколько должна измениться разница/цена для повторного уведомления
  maxPerHour: number;
  quietStart: number;
  quietEnd: number;
  notificationsEnabled: boolean;
  kindEnabled: boolean;
  minPriority: Priority;
}

export type NotifyDecision =
  | { send: true }
  | { send: false; reason: 'disabled' | 'kind_disabled' | 'duplicate' | 'cooldown' | 'quiet_hours' | 'rate_limit' | 'dismissed' | 'low_priority' };

const RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };

function changedMaterially(prev: number | null, cur: number | null, bp: number): boolean {
  if (prev === null || cur === null) return prev !== cur;
  if (prev === 0) return cur !== 0;
  return Math.abs(cur - prev) * 10000 >= Math.abs(prev) * bp;
}

/** Решает, отправлять ли уведомление. Чистая функция — проверяется тестами. */
export function decideNotify(
  p: NotifyPolicy,
  priority: Priority,
  current: { spreadKop: number | null; buyKop: number | null },
  prev: PreviousSignal | null,
  sentLastHour: number,
  warsawHourNow: number,
  now: number,
): NotifyDecision {
  if (!p.notificationsEnabled) return { send: false, reason: 'disabled' };
  if (!p.kindEnabled) return { send: false, reason: 'kind_disabled' };
  if (RANK[priority] < RANK[p.minPriority]) return { send: false, reason: 'low_priority' };
  if (prev?.state === 'dismissed') return { send: false, reason: 'dismissed' };
  if (prev?.notifiedAt) {
    const material = changedMaterially(prev.spreadKop, current.spreadKop, p.materialChangeBp)
      || changedMaterially(prev.buyKop, current.buyKop, p.materialChangeBp)
      || RANK[priority] > RANK[(prev.priority as Priority) ?? 'low'];
    if (!material) return { send: false, reason: 'duplicate' };
    if (now - prev.notifiedAt < p.cooldownSec) return { send: false, reason: 'cooldown' };
  }
  if (inQuietHours(warsawHourNow, p.quietStart, p.quietEnd)) return { send: false, reason: 'quiet_hours' };
  if (sentLastHour >= p.maxPerHour) return { send: false, reason: 'rate_limit' };
  return { send: true };
}

/** Ключ дедупликации: один сигнал на (тип, предмет, площадка покупки). Изменение цены обновляет запись, а не создаёт новую. */
export function dedupKey(kind: string, itemId: number, buySource: string | null, extra = ''): string {
  return `${kind}:${itemId}:${buySource ?? '-'}${extra ? ':' + extra : ''}`;
}
