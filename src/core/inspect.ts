// Подробности конкретных экземпляров предмета (float, паттерн, фаза Doppler, наклейки, брелки) — проверка и пояснения.

export interface AssetDetail {
  id: string; float: number | null; seed: number | null; phase: string | null; phaseUsd: number | null;
  stickers: { name: string; wear: number; usd: number | null }[];
  charms: { name: string; pattern: number | null; usd: number | null }[];
}

const PHASES = new Set(['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Ruby', 'Sapphire', 'Black Pearl', 'Emerald']);
const num = (x: unknown, min: number, max: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : null);
const str = (x: unknown, max = 200): string | null => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null);

/** Проверка того, что прислал сборщик. */
export function sanitizeAssets(raw: unknown): AssetDetail[] {
  if (!Array.isArray(raw)) return [];
  const out: AssetDetail[] = [];
  for (const a of raw.slice(0, 20) as Record<string, unknown>[]) {
    if (!a || typeof a !== 'object') continue;
    const id = typeof a.id === 'string' && /^\d{1,20}$/.test(a.id) ? a.id : null;
    if (!id) continue;
    const phase = typeof a.phase === 'string' && PHASES.has(a.phase) ? a.phase : null;
    const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, 6) as Record<string, unknown>[] : []);
    out.push({
      id, float: num(a.float, 0, 1), seed: num(a.seed, 0, 100000), phase, phaseUsd: phase ? num(a.phaseUsd, 0.01, 1e6) : null,
      stickers: list(a.stickers).map((s) => ({ name: str(s?.name), wear: num(s?.wear, 0, 1) ?? 0, usd: num(s?.usd, 0, 1e6) })).filter((s): s is AssetDetail['stickers'][number] => !!s.name),
      charms: list(a.charms).slice(0, 2).map((s) => ({ name: str(s?.name), pattern: num(s?.pattern, 0, 1e6), usd: num(s?.usd, 0, 1e6) })).filter((s): s is AssetDetail['charms'][number] => !!s.name),
    });
  }
  return out;
}

const WEAR: [RegExp, number, number][] = [
  [/\(Factory New\)$/, 0, 0.07], [/\(Minimal Wear\)$/, 0.07, 0.15], [/\(Field-Tested\)$/, 0.15, 0.38],
  [/\(Well-Worn\)$/, 0.38, 0.45], [/\(Battle-Scarred\)$/, 0.45, 1],
];

/** Пояснение к float: насколько он хорош внутри своего износа. */
export function floatNote(name: string, f: number | null): string | null {
  if (f === null) return null;
  const w = WEAR.find(([re]) => re.test(name));
  if (!w) return null;
  const pos = (f - w[1]) / (w[2] - w[1]);
  if (name.includes('(Factory New)') && f < 0.01) return 'очень низкий float — некоторые покупатели за такое доплачивают, но подтверждённых продаж для оценки нет: цена считается как обычная';
  if (pos <= 0.1) return 'низкий float для своего износа — наценка возможна, но без подтверждённых продаж бот её не добавляет';
  if (pos >= 0.9 && !name.includes('(Battle-Scarred)')) return 'float почти на границе следующего износа — такие иногда продаются дешевле; цена считается как обычная';
  return null;
}
