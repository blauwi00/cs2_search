/**
 * «Коллекции»: динамика цены коллекций скинов и кейсов, статус «в дропе / убрана», выход в плюс после комиссии Steam.
 * Цены — из открытого прайса Steam (CSGO Trader) и живого priceoverview по нескольким кейсам; состав — открытый набор ByMykel/CSGO-API.
 * Статусы ротаций вручную: Valve их не публикует, источник — обзоры и трекеры (помечено). Это не совет покупать.
 */
import { steamBuyerPriceForReceived } from './fees.ts';
import { parseSteamPriceString } from '../utils/money.ts';
import { getMeta, setMetaStmt } from './channel.ts';

export interface CollStat {
  id: string; name: string; rel: string | null;
  n: number; k: number; m7: number | null; m30: number | null; up: number;
  ups: { name: string; p7: number; r7: number }[];
  cov: number; cheapCov: { name: string; d7: number } | null;
  crates: { name: string; d1: number | null; d7: number | null; d30: number | null; d90: number | null }[];
  crateNames: string[];
  skins: { n: string; rar: number; d7: number | null; d30: number | null; d90: number | null }[];
}
/** Валюты кошелька Steam (ECurrencyCode), у которых цена в двух знаках после запятой: для них разбор строки Steam надёжен. */
export const STEAM_CURRENCY_ID: Record<string, number> = { USD: 1, GBP: 2, EUR: 3, CHF: 4, RUB: 5, PLN: 6, BRL: 7, NOK: 9, MYR: 11, PHP: 12, SGD: 13, THB: 14, TRY: 17, UAH: 18, MXN: 19, CAD: 20, AUD: 21, NZD: 22, CNY: 23, INR: 24, ZAR: 28, HKD: 29, SAR: 31, AED: 32, ILS: 35, KZT: 37 };
/** Живая цена и объём Steam по кейсу в валюте кошелька (low/med — в минимальных единицах этой валюты). Ключ: «КОД|название». */
export interface CaseVol { low: number | null; med: number | null; vol: number | null; at: number }
export const volKey = (code: string, name: string): string => `${code}|${name}`;
export function fmtMinor(minor: number, code: string): string {
  try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: code }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${code}`; }
}

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
      skins: (Array.isArray(r.skins) ? r.skins : []).slice(0, 40).flatMap((x: any) => { const nm = str(x?.n, 160); return nm ? [{ n: nm, rar: int(x.rar, 10) ?? 0, d7: int(x.d7), d30: int(x.d30), d90: int(x.d90) }] : []; }),
      crateNames: (Array.isArray(r.crateNames) ? r.crateNames : []).slice(0, 14).flatMap((x: unknown) => { const nm = str(x, 120); return nm ? [nm] : []; }),
    });
  }
  return out;
}

/** Живой priceoverview Steam по кейсам в валюте кошелька: строки как у Steam → минимальные единицы этой валюты. */
export function parseCaseVols(items: unknown, now: number): Record<string, CaseVol> {
  const out: Record<string, CaseVol> = {};
  for (const r of (Array.isArray(items) ? items : []).slice(0, 12) as Record<string, any>[]) {
    const name = str(r?.name, 120); if (!name) continue;
    const code = r.code === undefined ? 'UAH' : typeof r.code === 'string' && r.code in STEAM_CURRENCY_ID ? r.code : null; // без кода — старый формат сборщика (гривна)
    if (!code) continue;
    const vol = typeof r.volume === 'string' && r.volume.replace(/[^\d]/g, '') ? Number(r.volume.replace(/[^\d]/g, '')) : null;
    const low = parseSteamPriceString(typeof r.lowest_price === 'string' ? r.lowest_price : null);
    if (low === null && vol === null) continue;
    out[volKey(code, name)] = { low, med: parseSteamPriceString(typeof r.median_price === 'string' ? r.median_price : null), vol, at: now };
  }
  return out;
}

export interface CollView {
  id: string; name: string; rel: string | null; status: CollStatus | null;
  n: number; k: number; m7: number | null; m30: number | null; up: number; rotation: boolean;
  ups: { name: string; priceUsd: number; r7: number }[];
  cov: number; fuelUsd: number | null; fuelName: string | null;
  crates: { name: string; priceText: string | null; priceUsd: number | null; trend7: number | null; trend90: number | null; spark: number[]; vol: number | null; liq: 'high' | 'mid' | 'low' | null; needText: string | null; needPct: number | null; at: number | null }[];
}
/**
 * Цена кейса — живая цена Steam в ВАЛЮТЕ КОШЕЛЬКА ЧЕЛОВЕКА (code), никакого пересчёта по курсу: у Steam в каждой валюте свои цены.
 * Если живой цены в этой валюте пока нет, остаётся только цена из долларового прайса (priceUsd, центы), она подписывается в приложении.
 * Выход в плюс после комиссии Steam считаем только от живой цены в валюте кошелька.
 */
export function collViews(stats: CollStat[], vols: Record<string, CaseVol>, code: string): CollView[] {
  return stats.map((c) => {
    const crates = c.crates.map((x) => {
      const v = vols[volKey(code, x.name)];
      const low = v?.low ?? null;
      const need = low ? steamBuyerPriceForReceived(low).buyerPays : null;
      const trend7 = x.d7 && x.d30 ? Math.round(((x.d7 - x.d30) * 100) / x.d30) : null;
      const trend90 = x.d7 && x.d90 ? Math.round(((x.d7 - x.d90) * 100) / x.d90) : null;
      const spark = [x.d90, x.d30, x.d7, x.d1].filter((q): q is number => !!q);
      return { name: x.name, priceText: low ? fmtMinor(low, code) : null, priceUsd: x.d7 ?? x.d30, trend7, trend90, spark, vol: v?.vol ?? null, liq: liquidity(v?.vol ?? null), needText: need ? fmtMinor(need, code) : null, needPct: need && low ? Math.round(((need - low) * 100) / low) : null, at: v?.at ?? null };
    });
    return {
      id: c.id, name: c.name, rel: c.rel, status: COLLECTION_STATUS[c.id] ?? null, n: c.n, k: c.k,
      m7: c.m7 === null ? null : c.m7 - 100, m30: c.m30 === null ? null : c.m30 - 100, up: c.up, rotation: rotationHint(c),
      ups: c.ups.map((u) => ({ name: u.name, priceUsd: u.p7, r7: u.r7 - 100 })),
      cov: c.cov, fuelUsd: c.cheapCov ? c.cheapCov.d7 * 5 : null, fuelName: c.cheapCov?.name ?? null, crates,
    };
  });
}

export const COLL_VOL_EVERY = 6 * 3600;   // живую цену и объём кейса обновляем раз в 6 часов
export const COLL_VOL_PER_RUN = 6;        // не больше 6 запросов к Steam за запуск сборщика
export interface VolTask { name: string; code: string }
/**
 * Какие пары «предмет + валюта» пора обновить. Сначала то, что человек открыл в «Составе» (живые цены скинов в валюте его Steam),
 * потом все кейсы коллекций (без сувенирных наборов) во всех валютах, что нужны людям: давние первыми, затем по порядку валют, затем со статусом.
 */
export function collVolTasks(stats: CollStat[], vols: Record<string, CaseVol>, now: number, codes: string[], req: VolTask[] = []): VolTask[] {
  const asked = req.filter((t) => t.code in STEAM_CURRENCY_ID && now - (vols[volKey(t.code, t.name)]?.at ?? 0) > SKIN_FRESH_SEC).slice(0, COLL_VOL_PER_RUN);
  if (asked.length >= COLL_VOL_PER_RUN) return asked;
  const known = new Set(stats.filter((c) => COLLECTION_STATUS[c.id]).flatMap((c) => c.crateNames));
  const names = new Set<string>();
  for (const c of stats) for (const n of c.crateNames) if (!/Souvenir/i.test(n)) names.add(n);
  const out: VolTask[] = [];
  for (const code of codes) for (const name of names) if (now - (vols[volKey(code, name)]?.at ?? 0) > COLL_VOL_EVERY) out.push({ name, code });
  out.sort((a, b) => (vols[volKey(a.code, a.name)]?.at ?? 0) - (vols[volKey(b.code, b.name)]?.at ?? 0)
    || codes.indexOf(a.code) - codes.indexOf(b.code) || Number(known.has(b.name)) - Number(known.has(a.name)) || a.name.localeCompare(b.name));
  return [...asked, ...out].slice(0, COLL_VOL_PER_RUN);
}
/** Валюты кошельков, которыми реально пользуются люди (до 4 самых частых, только те, что Steam поддерживает; гривна всегда). */
export async function collCurrencies(d: D1Database): Promise<string[]> {
  const rows = (await d.prepare("SELECT value AS v, COUNT(*) AS n FROM user_settings WHERE key = 'currency' AND value != '' GROUP BY value ORDER BY n DESC LIMIT 8").all<{ v: string; n: number }>()).results;
  const codes = ['UAH', ...rows.map((r) => r.v).filter((v) => v !== 'UAH' && v in STEAM_CURRENCY_ID)];
  return codes.slice(0, 4);
}
/** Очередь «живые цены скинов открытой коллекции» (кому что нужно): мета 'coll_req', до 80 пар. */
export async function loadReq(d: D1Database): Promise<VolTask[]> {
  try {
    const a = JSON.parse((await getMeta(d, 'coll_req')) ?? '[]');
    return (Array.isArray(a) ? a : []).filter((t: any) => t && typeof t.name === 'string' && typeof t.code === 'string' && t.code in STEAM_CURRENCY_ID).slice(0, 80);
  } catch { return []; }
}
export async function addReq(d: D1Database, add: VolTask[]): Promise<void> {
  if (!add.length) return;
  const cur = await loadReq(d);
  const have = new Set(cur.map((t) => volKey(t.code, t.name)));
  const fresh = add.filter((t) => !have.has(volKey(t.code, t.name)));
  if (fresh.length) await setMetaStmt(d, 'coll_req', JSON.stringify([...cur, ...fresh].slice(-80))).run();
}
export async function loadCollections(d: D1Database): Promise<{ stats: CollStat[]; vols: Record<string, CaseVol>; at: number }> {
  const [s, v, at] = await Promise.all([getMeta(d, 'collections_stats'), getMeta(d, 'collections_vol'), getMeta(d, 'collections_stats_at')]);
  let stats: CollStat[] = [], vols: Record<string, CaseVol> = {};
  try { stats = parseCollStats(JSON.parse(s ?? '[]')); } catch { /* пусто */ }
  try {
    const raw = JSON.parse(v ?? '{}') as Record<string, CaseVol>;
    for (const [k, val] of Object.entries(raw)) vols[k.includes('|') ? k : volKey('UAH', k)] = val; // старые записи были в гривнах
  } catch { /* пусто */ }
  return { stats, vols, at: Number(at) || 0 };
}

export const SKIN_FRESH_SEC = 24 * 3600;  // живая цена скина считается свежей сутки
export interface SkinView { name: string; rar: number; priceText: string | null; priceUsd: number | null; trend7: number | null; trend90: number | null }
/**
 * Скины одной коллекции. Цена — живая цена Steam в валюте кошелька человека (если сборщик уже получил её, не старше суток);
 * иначе остаётся долларовая цена из открытого прайса (priceUsd), она подписывается в приложении. Пересчёта по курсу нет.
 */
export function skinViews(c: CollStat, vols: Record<string, CaseVol>, code: string, now: number): SkinView[] {
  return c.skins.map((x) => {
    const v = vols[volKey(code, x.n)];
    const live = v?.low && now - v.at < SKIN_FRESH_SEC ? v.low : null;
    return { name: x.n, rar: x.rar, priceText: live ? fmtMinor(live, code) : null, priceUsd: x.d7 ?? x.d30, trend7: x.d7 && x.d30 ? Math.round(((x.d7 - x.d30) * 100) / x.d30) : null, trend90: x.d7 && x.d90 ? Math.round(((x.d7 - x.d90) * 100) / x.d90) : null };
  });
}
/** Пять самых дешёвых красных для контракта: берём живую цену самого дешёвого красного × 5 (нижняя оценка), если она есть. */
export function fuelText(c: CollStat, vols: Record<string, CaseVol>, code: string, now: number): { name: string; text: string } | null {
  let best: { name: string; low: number } | null = null;
  for (const x of c.skins) {
    if (x.rar !== 5) continue;
    const v = vols[volKey(code, x.n)];
    if (v?.low && now - v.at < SKIN_FRESH_SEC && (!best || v.low < best.low)) best = { name: x.n, low: v.low };
  }
  return best ? { name: best.name, text: fmtMinor(best.low * 5, code) } : null;
}
/** Выданные сборщику задачи убираем из очереди: одна попытка на запрос (повторно поставит следующее открытие «Состава»). */
export async function popReq(d: D1Database, given: VolTask[]): Promise<void> {
  const cur = await loadReq(d);
  const gone = new Set(given.map((t) => volKey(t.code, t.name)));
  const next = cur.filter((t) => !gone.has(volKey(t.code, t.name)));
  if (next.length !== cur.length) await setMetaStmt(d, 'coll_req', JSON.stringify(next)).run();
}
