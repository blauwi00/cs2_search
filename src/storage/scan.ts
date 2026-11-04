import type { ScanEntry } from '../core/recs.ts';

export async function loadScan(db: D1Database): Promise<{ entries: ScanEntry[]; fetchedAt: number } | null> {
  const r = await db.prepare('SELECT data, fetched_at FROM market_scan WHERE id = 1').first<{ data: string; fetched_at: number }>();
  if (!r) return null;
  try {
    const entries = JSON.parse(r.data) as ScanEntry[];
    return Array.isArray(entries) ? { entries, fetchedAt: r.fetched_at } : null;
  } catch {
    return null;
  }
}
