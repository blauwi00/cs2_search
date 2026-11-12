// Служебный журнал для роликов: реальные цены нескольких предметов на площадках и самые заметные изменения за неделю.
// Только вывод в журнал запуска (ничего не отправляется). Нужен, чтобы в видео были настоящие цифры, а не придуманные.
const PROBE = ['AK-47 | Slate (Field-Tested)', 'AWP | Atheris (Field-Tested)', 'M4A1-S | Electrum (Field-Tested)', 'Desert Eagle | Printstream (Field-Tested)',
  'USP-S | Ticket to Hell (Field-Tested)', 'Gallery Case', 'Kilowatt Case', 'Revolution Case', 'Dreams & Nightmares Case', 'Recoil Case', 'Snakebite Case', 'Fracture Case'];

export function reelLog({ steamAvg, sp, markets, scored, fx }) {
  const f = (v) => (v == null ? '-' : String(v));
  for (const n of PROBE) {
    const a = steamAvg.get(n) ?? {};
    const s = sp.get(n);
    console.log(`REEL цена | ${n} | Steam$ d1=${f(a.d1)} d7=${f(a.d7)} d30=${f(a.d30)} d90=${f(a.d90)} | Skinport€ ${f(s?.min_price)} (${f(s?.quantity)} шт) | Market.CSGO$ ${f(markets.csgomarket.get(n)?.p)} | Waxpeer$ ${f(markets.waxpeer.get(n)?.p)} | LIS$ ${f(markets.lisskins.get(n)?.p)}`);
  }
  // Заметно выросли за неделю к месяцу (ликвидные, не дешёвые): для ролика про пик цены.
  const up = [...steamAvg.entries()].filter(([, v]) => v.d30 >= 3 && v.d7 > 0 && v.d1 > 0 && v.d90 > 0).map(([n, v]) => ({ n, v, g: (v.d7 - v.d30) / v.d30 }))
    .filter((x) => x.g >= 0.3 && x.g <= 3 && !/(\bSticker\b|Capsule|Patch|Graffiti|\| ★)/.test(x.n)).sort((a, b) => b.g - a.g).slice(0, 8);
  for (const x of up) console.log(`REEL рост | ${x.n} | d1=${x.v.d1} d7=${x.v.d7} d30=${x.v.d30} d90=${x.v.d90} | +${Math.round(x.g * 100)}%`);
  for (const x of scored.slice(0, 5)) console.log(`REEL идея | ${x.n} | отдача/покупка = ${x.r.toFixed(3)}`);
  console.log(`REEL курсы | USD=${fx.USD} EUR=${fx.EUR}`);
}
