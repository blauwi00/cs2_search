/**
 * «Дёшево в Steam»: предметы с живой ценой Steam до заданной суммы (центы USD), из таблицы steam_live (домашний сборщик).
 * Цена — самое дешёвое объявление, listings — сколько объявлений сейчас (не продажи в сутки: их у нас нет, поэтому «ликвидность» не заявляем).
 */
import { parseMarketHashName, CATEGORY_RU } from './normalization.ts';
import { getMeta } from './channel.ts';

export const CHEAP_MIN_CENTS = 5;        // дешевле 5 центов — копеечный мусор
export const CHEAP_MIN_LISTINGS = 5;     // меньше 5 объявлений — цена случайна
export const CHEAP_STALE_SEC = 24 * 3600; // данные старше суток помечаем «устарели»
const MEMO_SEC = 600;

export interface CheapRow { name: string; cents: number; listings: number; cat: string }
let memo: { at: number; max: number; rows: CheapRow[] } | null = null;

/** Для тестов: сбросить кэш на 10 минут. */
export const resetCheapMemo = (): void => { memo = null; };
export async function loadCheap(d: D1Database, maxCents: number, now: number): Promise<CheapRow[]> {
  if (memo && memo.max >= maxCents && now - memo.at < MEMO_SEC) return memo.rows.filter((r) => r.cents <= maxCents);
  const res = (await d.prepare(`SELECT name, cents, listings FROM steam_live WHERE cents BETWEEN ? AND ? AND listings >= ?`)
    .bind(CHEAP_MIN_CENTS, Math.max(maxCents, 100), CHEAP_MIN_LISTINGS).all<{ name: string; cents: number; listings: number }>()).results;
  const rows = res.map((r) => ({ name: r.name, cents: r.cents, listings: r.listings, cat: parseMarketHashName(r.name).category as string }));
  memo = { at: now, max: Math.max(maxCents, 100), rows };
  return rows.filter((r) => r.cents <= maxCents);
}

export const CHEAP_CATS: Record<string, string[] | null> = { all: null, case: ['case'], skin: ['weapon', 'knife', 'gloves'], sticker: ['sticker', 'capsule'], other: ['agent', 'patch', 'graffiti', 'music_kit', 'key', 'pin', 'other'] };

export function pickCheap(rows: CheapRow[], cat: string, limit = 60): { total: number; list: (CheapRow & { catRu: string })[] } {
  const want = CHEAP_CATS[cat] ?? null;
  const f = rows.filter((r) => !want || want.includes(r.cat)).sort((a, b) => b.listings - a.listings || b.cents - a.cents || a.name.localeCompare(b.name));
  return { total: f.length, list: f.slice(0, limit).map((r) => ({ ...r, catRu: (CATEGORY_RU as Record<string, string>)[r.cat] ?? '' })) };
}

export async function cheapMeta(d: D1Database): Promise<{ at: number | null; passAt: number | null }> {
  const [a, p] = await Promise.all([getMeta(d, 'steam_live_at'), getMeta(d, 'steam_live_pass_at')]);
  return { at: Number(a) || null, passAt: Number(p) || null };
}
