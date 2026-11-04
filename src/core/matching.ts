import { parseMarketHashName, type ParsedItem } from './normalization.ts';

export type MatchResult =
  | { ok: true; mode: 'exact' }
  | { ok: false; reason: 'different_name' | 'different_wear' | 'stattrak_mismatch' | 'souvenir_mismatch' }
  | { ok: true; mode: 'unique_unreliable' };

/**
 * Можно ли сравнивать цены двух записей как цены одного и того же предмета.
 * Обычные предметы — только точное совпадение market_hash_name (и, как следствие, износа/StatTrak/Souvenir).
 * Для предметов с ценой экземпляра (ножи, перчатки, паттерны, фазы) совпадение имени недостаточно:
 * возвращается unique_unreliable, и сделка не может получить высокий приоритет.
 */
export function compareItems(a: string, b: string): MatchResult {
  const pa = parseMarketHashName(a);
  const pb = parseMarketHashName(b);
  if (pa.stattrak !== pb.stattrak) return { ok: false, reason: 'stattrak_mismatch' };
  if (pa.souvenir !== pb.souvenir) return { ok: false, reason: 'souvenir_mismatch' };
  if (pa.wear !== pb.wear) return { ok: false, reason: 'different_wear' };
  if (pa.marketHashName !== pb.marketHashName) return { ok: false, reason: 'different_name' };
  if (pa.uniquePriced) return { ok: true, mode: 'unique_unreliable' };
  return { ok: true, mode: 'exact' };
}

/** Оценка конкретного экземпляра (CSFloat-объявление с float/паттерном). */
export function instanceReliability(p: ParsedItem, floatValue: number | null, paintSeed: number | null):
  'reliable' | 'unreliable_unknown_pattern' | 'unreliable_unique' {
  if (!p.uniquePriced) return 'reliable';
  if (paintSeed === null || floatValue === null) return 'unreliable_unknown_pattern';
  return 'unreliable_unique'; // модели оценки паттернов нет — честно считаем ненадёжным
}
