/**
 * «Коллекции»: динамика цены коллекций скинов и кейсов, статус «в дропе / убрана», выход в плюс после комиссии Steam.
 * Цены — из открытого прайса Steam (CSGO Trader) и живого priceoverview по нескольким кейсам; состав — открытый набор ByMykel/CSGO-API.
 * Статусы ротаций вручную: Valve их не публикует, источник — обзоры и трекеры (помечено). Это не совет покупать.
 */
import { steamBuyerPriceForReceived } from './fees.ts';
import { parseSteamPriceString } from '../utils/money.ts';
import { getMeta } from './channel.ts';

export interface CollStat {
  id: string; name: string; rel: string | null;
  n: number; k: number; m7: number | null; m30: number | null; up: number;
  ups: { name: string; p7: number; r7: number }[];
  cov: number; cheapCov: { name: string; d7: number } | null;
  crates: { name: string; d1: number | null; d7: number | null; d30: number | null; d90: number | null }[];
  crateNames: string[];
}
export interface CaseVol { low: number | null; med: number | null; vol: number | null; at: number }

/** Статусы, найденные вручную (обзоры, трекеры): «date» — как в источнике, может быть неполной. */
export interface CollStatus { s: 'active' | 'removed'; date: string | null; src: string }
const REV = 'обзоры и трекеры, не Valve';
export const COLLECTION_STATUS: Record<string, CollStatus> = {
  'collection-set-timed-drops-cool': { s: 'active', date: null, src: REV },       // Ascent
  'collection-set-timed-drops-neutral': { s: 'active', date: null, src: REV },    // Boreal
  'collection-set-timed-drops-warm': { s: 'active', date: null, src: REV },       // Radiant
  'collection-set-timed-drops-exuberant': { s: 'active', date: '2026-01-21', src: REV }, // Harlequin
  'collection-set-timed-drops-achroma': { s: 'active', date: '2026-01-21', src: REV },
  'collection-set-community-30': { s: 'active', date: null, src: REV },           // Dreams & Nightmares
  'collection-set-community-32': { s: 'active', date: null, src: REV },           // Revolution
  'collection-set-community-33': { s: 'active', date: null, src: REV },           // Kilowatt
  'collection-set-community-36': { s: 'active', date: '2025-09', src: REV },      // Genesis
  'collection-set-community-37': { s: 'active', date: '2026-03', src: REV },      // Dead Hand
  'collection-set-bank': { s: 'removed', date: '2025-03-31', src: REV },
  'collection-set-italy': { s: 'removed', date: '2025-03-31', src: REV },
  'collection-set-lake': { s: 'removed', date: '2025-03-31', src: REV },
  'collection-set-train': { s: 'removed', date: '2025-03-31', src: REV },
  'collection-set-dust-2': { s: 'removed', date: '2026-01-21', src: REV },
  'collection-set-inferno-2': { s: 'removed', date: '2026-01-21', src: REV },
  'collection-set-nuke-2': { s: 'removed', date: '2026-01-21', src: REV },
  'collection-set-safehouse': { s: 'removed', date: '2026-01-21', src: REV },
  'collection-set-community-31': { s: 'removed', date: '2026-03', src: REV },     // Recoil (заменён Dead Hand)
  'collection-set-community-26': { s: 'removed', date: '2025-09', src: 'один трекер, не проверено' }, // Fracture
  'collection-set-community-34': { s: 'removed', date: null, src: 'один обзор, не проверено' },     // Gallery
};

/** Ликвидность по продажам Steam за сутки. Пороги мои, не из данных. */
export const LIQ_HIGH = 1000, LIQ_MID = 100;
export const liquidity = (vol: number | null): 'high' | 'mid' | 'low' | null => (vol === null ? null : vol >= LIQ_HIGH ? 'high' : vol >= LIQ_MID ? 'mid' : 'low');

/** Возможная ротация: заметная доля предметов коллекции одновременно подорожала (гипотеза, не факт). */
export const ROT_MIN_ITEMS = 3, ROT_MIN_SHARE = 0.3;
export const rotationHint = (c: Pick<CollStat, 'up' | 'k'>): boolean => c.up >= ROT_MIN_ITEMS && c.k > 0 && c.up / c.k >= ROT_MIN_SHARE;

const int = (x: unknown, max = 1e9): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < max ? Math.round(x) : null);
const str = (x: unknown, n: number): string | null => (typeof x === 'string' && x.length > 0 && x.length <= n ? x : null);

export function parseCollStats(items: unknown): CollStat[] {
  const out: CollStat[] = [];
  for (const r of (Array.isArray(items) ? items : []).slice(0, 200) as Record<string, any>[]) {
    const id = str(r?.id, 80), name = str(r?.name, 80);
    if (!id || !name) continue;
    out.push({
      id, name, rel: typeof r.rel === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.rel) ? r.rel : null,
      n: int(r.n, 1000) ?? 0, k: int(r.k, 1000) ?? 0, m7: int(r.m7, 1e5), m30: int(r.m30, 1e5), up: int(r.up, 1000) ?? 0,
      ups: (Array.isArray(r.ups) ? r.ups : []).slice(0, 6).flatMap((u: any) => { const nm = str(u?.name, 120), p = int(u?.p7), q = int(u?.r7, 1e5); return nm && p && q ? [{ name: nm, p7: p, r7: q }] : []; }),
      cov: int(r.cov, 100) ?? 0,
      cheapCov: r.cheapCov && str(r.cheapCov.name, 120) && int(r.cheapCov.d7) ? { name: r.cheapCov.name, d7: int(r.cheapCov.d7)! } : null,
      crates: (Array.isArray(r.crates) ? r.crates : []).slice(0, 14).flatMap((x: any) => { const nm = str(x?.name, 120); return nm ? [{ name: nm, d1: int(x.d1), d7: int(x.d7), d30: int(x.d30), d90: int(x.d90) }] : []; }),
      crateNames: (Array.isArray(r.crateNames) ? r.crateNames : []).slice(0, 14).flatMap((x: unknown) => { const nm = str(x, 120); return nm ? [nm] : []; }),
    });
  }
  return out;
}

/** Живой priceoverview Steam по кейсам (валюта запроса — гривна): строки как у Steam → копейки. */
export function parseCaseVols(items: unknown, now: number): Record<string, CaseVol> {
  const out: Record<string, CaseVol> = {};
  for (const r of (Array.isArray(items) ? items : []).slice(0, 12) as Record<string, any>[]) {
    const name = str(r?.name, 120); if (!name) continue;
    const vol = typeof r.volume === 'string' && r.volume.replace(/[^\d]/g, '') ? Number(r.volume.replace(/[^\d]/g, '')) : null;
    const low = parseSteamPriceString(typeof r.lowest_price === 'string' ? r.lowest_price : null);
    if (low === null && vol === null) continue;
    out[name] = { low, med: parseSteamPriceString(typeof r.median_price === 'string' ? r.median_price : null), vol, at: now };
  }
  return out;
}

export interface CollView {
  id: string; name: string; rel: string | null; status: CollStatus | null;
  n: number; k: number; m7: number | null; m30: number | null; up: number; rotation: boolean;
  ups: { name: string; priceKop: number | null; r7: number }[];
  cov: number; fuelKop: number | null; fuelName: string | null;
  crates: { name: string; priceKop: number | null; trend7: number | null; vol: number | null; liq: 'high' | 'mid' | 'low' | null; needKop: number | null; needPct: number | null; at: number | null }[];
}
/** kop: цены прайса (центы USD) → копейки. Выход в плюс — цена Steam, при которой после комиссии вернутся потраченные деньги. */
export function collViews(stats: CollStat[], vols: Record<string, CaseVol>, kop: (usdCents: number) => number | null): CollView[] {
  return stats.map((c) => {
    const crates = c.crates.map((x) => {
      const v = vols[x.name];
      const priceKop = v?.low ?? (x.d7 ? kop(x.d7) : null);
      const need = priceKop ? steamBuyerPriceForReceived(priceKop).buyerPays : null;
      const trend7 = x.d7 && x.d30 ? Math.round(((x.d7 - x.d30) * 100) / x.d30) : null;
      return { name: x.name, priceKop, trend7, vol: v?.vol ?? null, liq: liquidity(v?.vol ?? null), needKop: need, needPct: need && priceKop ? Math.round(((need - priceKop) * 100) / priceKop) : null, at: v?.at ?? null };
    });
    return {
      id: c.id, name: c.name, rel: c.rel, status: COLLECTION_STATUS[c.id] ?? null, n: c.n, k: c.k,
      m7: c.m7 === null ? null : c.m7 - 100, m30: c.m30 === null ? null : c.m30 - 100, up: c.up, rotation: rotationHint(c),
      ups: c.ups.map((u) => ({ name: u.name, priceKop: kop(u.p7), r7: u.r7 - 100 })),
      cov: c.cov, fuelKop: c.cheapCov ? kop(c.cheapCov.d7 * 5) : null, fuelName: c.cheapCov?.name ?? null, crates,
    };
  });
}

export const COLL_VOL_EVERY = 6 * 3600;   // живую цену и объём кейса обновляем раз в 6 часов
export const COLL_VOL_PER_RUN = 4;        // не больше 4 запросов к Steam за запуск сборщика
/** Какие кейсы пора обновить в Steam: только у коллекций с известным статусом (сувенирные наборы пропускаем), самые давние первыми. */
export function collVolNames(stats: CollStat[], vols: Record<string, CaseVol>, now: number): string[] {
  const names = new Set<string>();
  for (const c of stats) if (COLLECTION_STATUS[c.id]) for (const n of c.crateNames) if (!/Souvenir/i.test(n)) names.add(n);
  return [...names].filter((n) => now - (vols[n]?.at ?? 0) > COLL_VOL_EVERY).sort((a, b) => (vols[a]?.at ?? 0) - (vols[b]?.at ?? 0)).slice(0, COLL_VOL_PER_RUN);
}
export async function loadCollections(d: D1Database): Promise<{ stats: CollStat[]; vols: Record<string, CaseVol>; at: number }> {
  const [s, v, at] = await Promise.all([getMeta(d, 'collections_stats'), getMeta(d, 'collections_vol'), getMeta(d, 'collections_stats_at')]);
  let stats: CollStat[] = [], vols: Record<string, CaseVol> = {};
  try { stats = parseCollStats(JSON.parse(s ?? '[]')); } catch { /* пусто */ }
  try { vols = JSON.parse(v ?? '{}'); } catch { /* пусто */ }
  return { stats, vols, at: Number(at) || 0 };
}
