// «Окупается ли кейс»: сколько в среднем возвращает открытие кейса.
// Состав кейсов и диапазоны float — открытый набор данных ByMykel/CSGO-API (GitHub, MIT).
// Цены — средние продажи Steam за 7 дней (открытый прайс CSGO Trader), в центах USD.
// Шансы — опубликованные Valve: Mil-Spec 79,92%, Restricted 15,98%, Classified 3,2%, Covert 0,64%, редкий предмет 0,26%;
// StatTrak™ — 10% (если у скина он бывает). Float внутри диапазона скина — равномерно.

export const TIER_ODDS = { 'Mil-Spec Grade': 0.7992, 'Restricted': 0.1598, 'Classified': 0.032, 'Covert': 0.0064, rare: 0.0026 };
export const STATTRAK_P = 0.1;
export const KEY_CENTS = 249; // официальная цена ключа в Steam, USD
const WEARS = [['Factory New', 0, 0.07], ['Minimal Wear', 0.07, 0.15], ['Field-Tested', 0.15, 0.38], ['Well-Worn', 0.38, 0.45], ['Battle-Scarred', 0.45, 1]];

/** Вероятности износа при равномерном float в [min, max]. */
export function wearOdds(min, max) {
  if (!(max > min)) return [];
  return WEARS.map(([w, a, b]) => [w, Math.max(0, Math.min(b, max) - Math.max(a, min)) / (max - min)]).filter(([, p]) => p > 0);
}

/** Варианты одного предмета кейса: [market_hash_name, вероятность внутри предмета]. */
export function variants(name, skin) {
  const knife = name.startsWith('★');
  const st = skin ? skin.stattrak !== false : !/Gloves|Wraps/.test(name);
  const stName = (n) => (knife ? n.replace('★ ', '★ StatTrak™ ') : `StatTrak™ ${n}`);
  const base = !skin || skin.min_float == null || !name.includes('|')
    ? [[name, 1]] // «ванильный» нож — без износа
    : wearOdds(Number(skin.min_float), Number(skin.max_float)).map(([w, p]) => [`${name} (${w})`, p]);
  if (!st) return base;
  return [...base.map(([n, p]) => [n, p * (1 - STATTRAK_P)]), ...base.map(([n, p]) => [stName(n), p * STATTRAK_P])];
}

/**
 * Средняя отдача открытия по каждому кейсу. priceOf(name) → центы USD или null.
 * Кейс пропускается, если цен не хватает больше чем на 5% вероятности или нет цены самого кейса.
 */
export function computeCaseEV(crates, skins, priceOf) {
  const skinBy = new Map(skins.map((s) => [s.name, s]));
  const out = [];
  for (const c of crates) {
    if (c?.type !== 'Case' || !Array.isArray(c.contains) || !c.contains.length || !Array.isArray(c.contains_rare) || !c.contains_rare.length) continue;
    const casePrice = priceOf(c.market_hash_name ?? c.name);
    if (!casePrice) continue;
    const tiers = new Map();
    for (const it of c.contains) {
      const t = it?.rarity?.name;
      if (!(t in TIER_ODDS)) continue;
      if (!tiers.has(t)) tiers.set(t, []);
      tiers.get(t).push(it.name);
    }
    tiers.set('rare', [...new Set(c.contains_rare.map((x) => x.name))]); // фазы Doppler на рынке — одно название
    let ev = 0, covered = 0, best = null;
    const dist = []; // [цена, вероятность] — для шанса окупиться
    for (const [tier, names] of tiers) {
      const pt = TIER_ODDS[tier] / names.length;
      for (const n of names) {
        for (const [mh, p] of variants(n, skinBy.get(n))) {
          const v = priceOf(mh);
          if (!v) continue;
          ev += v * pt * p; covered += pt * p;
          dist.push([v, pt * p]);
          if (!best || v > best.cents) best = { name: mh, cents: v, p: pt * p };
        }
      }
    }
    if (covered < 0.95) continue;
    ev /= covered; // недостающие цены — как средние по кейсу
    const cost = casePrice + KEY_CENTS;
    const net = (x) => Math.floor(x / 1.15); // ≈ после комиссии Steam (5% + 10%)
    const pWin = dist.filter(([v]) => net(v) >= cost).reduce((s, [, p]) => s + p, 0) / covered;
    out.push({ name: c.name, img: c.image ?? null, caseCents: casePrice, keyCents: KEY_CENTS, evCents: Math.round(ev), evNetCents: net(Math.round(ev)), pWin: Math.round(pWin * 1e6) / 1e6, best, covered: Math.round(covered * 1000) / 1000 });
  }
  return out.sort((a, b) => b.evNetCents / (b.caseCents + b.keyCents) - a.evNetCents / (a.caseCents + a.keyCents));
}
