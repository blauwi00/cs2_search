// Сопоставление названий предметов с инвентарём пользователя (используется при импорте выставленных на сайте предметов).

/** Ищем среди известных названий (инвентарь, покупки) — сначала точное, потом без учёта регистра, потом без износа (если подходит ровно один). */
export function matchName(cands: string[], known: string[]): string | null {
  for (const c of cands) if (known.includes(c)) return c;
  const low = new Map(known.map((k) => [k.toLowerCase(), k]));
  for (const c of cands) { const k = low.get(c.toLowerCase()); if (k) return k; }
  for (const c of cands) {
    const base = c.replace(/ \([^)]*\)$/, '').toLowerCase();
    const hits = known.filter((k) => k.toLowerCase().replace(/ \([^)]*\)$/, '') === base);
    if (hits.length === 1) return hits[0];
  }
  return null;
}
