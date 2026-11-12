// «Коллекции»: по открытому набору ByMykel/CSGO-API (состав) и прайсу Steam CSGO Trader (средние продажи за 1/7/30/90 дней, USD)
// считаем по каждой коллекции динамику цены. Никаких запросов к Steam: оба файла уже скачиваются сборщиком.
// Цены на выходе — центы USD. Ничего не выдумываем: нет цены — предмета в расчёте нет.

const WEARS = ['Field-Tested', 'Minimal Wear', 'Battle-Scarred', 'Factory New', 'Well-Worn'];
export const UP_RATIO = 1.15;      // «вырос»: средняя за 7 дней выше 30-дневной средней на 15% (мой порог, не из данных)
export const MIN_CENTS = 3;        // дешевле 3 центов не считаем: у копеечных предметов проценты — шум
const RAR = { rarity_ancient_weapon: 5, rarity_legendary_weapon: 4, rarity_mythical_weapon: 3, rarity_rare_weapon: 2, rarity_uncommon_weapon: 1, rarity_common_weapon: 0 };
const WEAPON = /^rarity_(common|uncommon|rare|mythical|legendary|ancient)_weapon$/;

const cents = (usd) => (typeof usd === 'number' && Number.isFinite(usd) && usd > 0 && usd < 1e6 ? Math.round(usd * 100) : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/** Цены одного скина: берём самый ликвидный износ, который есть в прайсе (для сувенирных коллекций — сувенирные названия). */
export function skinPrice(name, avg) {
  for (const prefix of ['', 'Souvenir ']) {
    for (const w of WEARS) {
      const v = avg.get(`${prefix}${name} (${w})`);
      if (v && cents(v.d7 ?? v.d30)) return { key: `${prefix}${name} (${w})`, d1: cents(v.d1), d7: cents(v.d7), d30: cents(v.d30), d90: cents(v.d90) };
    }
  }
  return null;
}

export function buildCollections(collections, avg) {
  const out = [];
  for (const c of Array.isArray(collections) ? collections : []) {
    if (!c || typeof c.name !== 'string' || !Array.isArray(c.contains)) continue;
    const skins = c.contains.filter((s) => s && typeof s.name === 'string' && WEAPON.test(s.rarity?.id ?? ''));
    if (!skins.length) continue; // стикеры, граффити, агенты и т. п.
    const priced = [];
    for (const s of skins) {
      const p = skinPrice(s.name, avg);
      if (p) priced.push({ name: s.name, covert: s.rarity.id === 'rarity_ancient_weapon', rar: RAR[s.rarity.id] ?? 0, ...p });
    }
    const r7 = [], r30 = [], ups = [];
    for (const p of priced) {
      if (!(p.d30 >= MIN_CENTS) || !(p.d7 >= MIN_CENTS)) continue;
      const a = p.d7 / p.d30;
      r7.push(Math.round(a * 100));
      if (p.d90 >= MIN_CENTS) r30.push(Math.round((p.d30 / p.d90) * 100));
      if (a >= UP_RATIO) ups.push({ name: p.name, p7: p.d7, r7: Math.round(a * 100) });
    }
    const cov = priced.filter((p) => p.covert && p.d7).sort((a, b) => a.d7 - b.d7);
    const crates = (Array.isArray(c.crates) ? c.crates : []).filter((x) => x && typeof x.name === 'string').slice(0, 14).map((x) => {
      const v = avg.get(x.name);
      return { name: x.name, d1: cents(v?.last_24h ?? v?.d1), d7: cents(v?.d7), d30: cents(v?.d30), d90: cents(v?.d90) };
    });
    out.push({
      id: String(c.id ?? c.name).slice(0, 80), name: c.name.slice(0, 80), rel: typeof c.release_date === 'string' ? c.release_date.slice(0, 10) : null,
      n: skins.length, k: r7.length, m7: median(r7), m30: median(r30), up: ups.length,
      ups: ups.sort((a, b) => b.r7 - a.r7).slice(0, 6),
      cov: skins.filter((s) => s.rarity.id === 'rarity_ancient_weapon').length,
      cheapCov: cov[0] ? { name: cov[0].name, d7: cov[0].d7 } : null,
      crates: crates.filter((x) => x.d7 || x.d30),
      skins: priced.sort((a, b) => b.rar - a.rar || (b.d7 ?? b.d30) - (a.d7 ?? a.d30)).slice(0, 40).map((p) => ({ n: p.key, rar: p.rar, d7: p.d7, d30: p.d30, d90: p.d90 })),
      crateNames: (Array.isArray(c.crates) ? c.crates : []).map((x) => String(x?.name ?? '').slice(0, 80)).filter(Boolean).slice(0, 14),
    });
  }
  return out;
}
