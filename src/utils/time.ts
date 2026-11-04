export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Час (0–23) по Варшаве для момента t (Unix-секунды). */
export function warsawHour(t: number): number {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hour12: false })
    .format(new Date(t * 1000));
  return Number(s) % 24;
}

/** Дата YYYY-MM-DD по Варшаве. */
export function warsawDate(t: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(t * 1000));
  return p;
}

export function utcDay(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/** Попадает ли час в тихие часы [start, end). Поддерживает переход через полночь (23 → 8). */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** "2 мин назад", "3 ч назад", "5 дн назад". */
export function ago(t: number | null | undefined, now: number): string {
  if (!t) return 'никогда';
  const d = Math.max(0, now - t);
  if (d < 60) return 'только что';
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return `${Math.floor(d / 86400)} дн назад`;
}
