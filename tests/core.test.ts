import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarketHashName } from '../src/core/normalization.ts';
import { compareItems, instanceReliability } from '../src/core/matching.ts';
import { parseNbu, toKop, fxAgeDays } from '../src/currency/nbu.ts';
import { steamSellerProceeds, steamBuyerPriceForReceived } from '../src/core/fees.ts';
import { computeSteamArbitrage, breakEvenBuyerPrice, steamSellReference } from '../src/core/arbitrage.ts';
import { classifyLiquidity } from '../src/core/liquidity.ts';
import { scoreArbitrage, type ScoringContext } from '../src/core/scoring.ts';
import { detectChanges } from '../src/core/analyzer.ts';
import { formatUah, parseUahInput, parseSteamPriceString, decimalToMinor } from '../src/utils/money.ts';
import { fixtureJson } from './helpers.ts';

// 1. Корректное сопоставление предметов
test('1: одинаковые market_hash_name сопоставляются, разные — нет', () => {
  assert.deepEqual(compareItems('AK-47 | Redline (Field-Tested)', 'AK-47 | Redline (Field-Tested)'), { ok: true, mode: 'exact' });
  assert.equal(compareItems('AK-47 | Redline (Field-Tested)', 'AK-47 | Asiimov (Field-Tested)').ok, false);
});

// 2. StatTrak и обычные
test('2: StatTrak не сопоставляется с обычным вариантом', () => {
  const r = compareItems('StatTrak™ AK-47 | Redline (Field-Tested)', 'AK-47 | Redline (Field-Tested)');
  assert.deepEqual(r, { ok: false, reason: 'stattrak_mismatch' });
  assert.equal(parseMarketHashName('★ StatTrak™ Karambit | Fade (Factory New)').stattrak, true);
  assert.equal(parseMarketHashName('Souvenir AWP | Dragon Lore (Factory New)').souvenir, true);
});

// 3. Износ
test('3: разные состояния износа не сопоставляются', () => {
  assert.deepEqual(compareItems('AK-47 | Redline (Field-Tested)', 'AK-47 | Redline (Minimal Wear)'), { ok: false, reason: 'different_wear' });
  assert.equal(parseMarketHashName('AWP | Asiimov (Battle-Scarred)').wear, 'BS');
});

// 4. Уникальные паттерны
test('4: Case Hardened, Doppler, ножи и перчатки помечаются как зависящие от экземпляра', () => {
  assert.equal(parseMarketHashName('AK-47 | Case Hardened (Field-Tested)').uniquePriced, true);
  assert.equal(parseMarketHashName('★ Karambit | Doppler (Factory New)').uniquePriced, true);
  assert.equal(parseMarketHashName('★ Sport Gloves | Vice (Field-Tested)').category, 'gloves');
  assert.equal(parseMarketHashName('AK-47 | Redline (Field-Tested)').uniquePriced, false);
  assert.deepEqual(compareItems('AK-47 | Case Hardened (Field-Tested)', 'AK-47 | Case Hardened (Field-Tested)'), { ok: true, mode: 'unique_unreliable' });
});

test('категории: кейсы, капсулы, наклейки, агенты', () => {
  assert.equal(parseMarketHashName('Revolution Case').category, 'case');
  assert.equal(parseMarketHashName('Paris 2023 Legends Sticker Capsule').category, 'capsule');
  assert.equal(parseMarketHashName('Sticker | Natus Vincere | Paris 2023').category, 'sticker');
  assert.equal(parseMarketHashName("Sir Bloody Miami Darryl | The Professionals").category, 'agent');
});

// 5. Конвертация USD/EUR → UAH
test('5: курсы НБУ разбираются и конвертируют в копейки', () => {
  const rates = parseNbu(fixtureJson('nbu.json'));
  assert.deepEqual(rates.map((r) => r.base).sort(), ['EUR', 'PLN', 'USD']);
  const eur = rates.find((r) => r.base === 'EUR')!;
  assert.equal(eur.rateDate, '2026-11-04');
  assert.equal(toKop(850, 'EUR', eur), 38250); // 8,50 € × 45 = 382,50 грн
  const usd = rates.find((r) => r.base === 'USD')!;
  assert.equal(toKop(1290, 'USD', usd), 53535); // 12,90 $ × 41,5 = 535,35 грн
  assert.equal(toKop(5000, 'UAH', null), 5000);
});

// 6. Комиссии Steam
test('6: комиссия Steam (5% + 10%) с округлением как у Steam', () => {
  // Покупатель платит 100,00 → продавец получает 86,97 (широко известный пример для USD).
  assert.equal(steamSellerProceeds(10000)!.sellerReceives, 8697);
  assert.equal(steamBuyerPriceForReceived(8697).buyerPays, 10000);
  // Минимальная цена: 0,03 → продавцу 0,01.
  assert.equal(steamSellerProceeds(3)!.sellerReceives, 1);
  assert.equal(steamSellerProceeds(2), null);
  // Обратимость: для каждого received цена покупателя даёт тот же received.
  for (const r of [1, 7, 99, 1234, 55250, 999999]) {
    const b = steamBuyerPriceForReceived(r).buyerPays;
    assert.equal(steamSellerProceeds(b)!.sellerReceives, r);
  }
});

// 7. Комиссии сторонних площадок — неизвестные не выдумываются
test('7: неизвестные комиссии площадок не подставляются', async () => {
  const { FEE_REGISTRY } = await import('../src/core/fees.ts');
  assert.equal(FEE_REGISTRY.skinport.buyerFeeBp, null);
  assert.equal(FEE_REGISTRY.csfloat.sellerFeeBp, null);
  assert.equal(FEE_REGISTRY.steam.sellerFeeBp, 1500);
});

const steam = (lowestKop: number | null, medianKop: number | null) => ({ lowestKop, medianKop, fetchedAt: 0 });

// 8. Положительный спред
test('8: положительный спред считается после комиссий', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 40000, fetchedAt: 0 }, steam(65000, 66000))!;
  assert.equal(a.sellReferenceKop, 64999); // ниже самого дешёвого объявления на 1 коп.
  assert.equal(a.expectedProceedsKop, steamSellerProceeds(64999)!.sellerReceives);
  assert.ok(a.netSpreadKop > 0);
  assert.equal(a.netSpreadKop, a.expectedProceedsKop - 40000);
  assert.equal(a.returnOnCostBp, Math.trunc((a.netSpreadKop * 10000) / 40000));
  assert.equal(a.downside.length, 2);
});

// 9. Отрицательный спред
test('9: отрицательный спред не даёт сигнала', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 60000, fetchedAt: 0 }, steam(65000, 64000))!;
  assert.ok(a.netSpreadKop < 0);
  const s = scoreArbitrage(ctx(a));
  assert.equal(s.priority, null);
});

// 10. Округление
test('10: суммы форматируются и разбираются в копейках без ошибок float', () => {
  assert.equal(formatUah(155250), '1 552,50 грн');
  assert.equal(formatUah(-5), '−0,05 грн');
  assert.equal(parseUahInput('1 500,5'), 150050);
  assert.equal(parseUahInput('abc'), null);
  assert.equal(parseSteamPriceString('1 234,56₴'), 123456);
  assert.equal(parseSteamPriceString('$0.03'), 3);
  assert.equal(decimalToMinor(0.1 + 0.2), 30);
  assert.equal(decimalToMinor(-1), null);
  assert.equal(breakEvenBuyerPrice(8697), 10000);
});

// 11. Нет ложного арбитража при разных валютах
test('11: без курса цена в UAH неизвестна — арбитраж не считается', () => {
  assert.equal(toKop(850, 'EUR', null), null);
  const usd = parseNbu(fixtureJson('nbu.json')).find((r) => r.base === 'USD')!;
  assert.equal(toKop(850, 'EUR', usd), null); // курс другой валюты не применяется
});

// 29. Убыточная сделка, выглядящая выгодной до комиссий
test('29: разница цен +10%, но после комиссии 15% — убыток', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 59000, fetchedAt: 0 }, steam(65001, 65001))!;
  assert.ok(65000 > 59000);          // «на глаз» выгодно
  assert.ok(a.netSpreadKop < 0);     // после комиссий — нет
  assert.equal(scoreArbitrage(ctx(a)).priority, null);
});

// 30. Дорогой экземпляр с неизвестным паттерном
test('30: нож с неизвестным паттерном не может быть высокого приоритета', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 3_000_000, fetchedAt: 0 }, steam(5_000_000, 5_000_000))!;
  const s = scoreArbitrage(ctx(a, { uniquePriced: true }));
  assert.notEqual(s.priority, 'high');
  assert.equal(s.category, 'anomaly');
  assert.ok(s.reasons.some((r) => r.includes('экземпляра')));
  const p = parseMarketHashName('★ Karambit | Doppler (Factory New)');
  assert.equal(instanceReliability(p, null, null), 'unreliable_unknown_pattern');
});

// 31. Изменение курса без изменения цены в USD — не рыночный сигнал
test('31: колебание курса не создаёт сигнал изменения цены', () => {
  // История и текущее значение в исходной валюте (EUR) одинаковы, хотя в UAH они бы отличались.
  const ev = detectChanges({ at: 100_000, minor: 850, currency: 'EUR', volume: 50 },
    [{ at: 100_000 - 86400 - 100, minor: 850, currency: 'EUR', volume: 50 }], 100_000, 500);
  assert.equal(ev.length, 0);
  // Реальное падение в исходной валюте — сигнал есть.
  const ev2 = detectChanges({ at: 100_000, minor: 600, currency: 'EUR', volume: 50 },
    [{ at: 100_000 - 86400 - 100, minor: 850, currency: 'EUR', volume: 50 }], 100_000, 500);
  assert.equal(ev2[0].kind, 'price_drop');
});

// 32. Устаревший курс блокирует высокий приоритет
test('32: устаревший или отсутствующий курс UAH не даёт высокий приоритет', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 30000, fetchedAt: 0 }, steam(65000, 64000))!;
  assert.equal(scoreArbitrage(ctx(a)).priority, 'high');
  assert.notEqual(scoreArbitrage(ctx(a, { fxAgeDays: 10 })).priority, 'high');
  assert.notEqual(scoreArbitrage(ctx(a, { fxAvailable: false, fxAgeDays: 999 })).priority, 'high');
  assert.ok(fxAgeDays('2026-11-01', Date.parse('2026-11-04T12:00:00Z') / 1000) === 3);
});

test('16: устаревшие цены не дают высокий приоритет', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 30000, fetchedAt: 0 }, steam(65000, 64000))!;
  const s = scoreArbitrage(ctx(a, { buyAgeSec: 4 * 3600 }));
  assert.notEqual(s.priority, 'high');
  assert.ok(s.reasons.some((r) => r.includes('устарели')));
});

test('17: отсутствующие данные — неизвестность, а не ноль', () => {
  assert.equal(steamSellReference(steam(null, null)), null);
  assert.equal(computeSteamArbitrage({ source: 'skinport', costKop: 100, fetchedAt: 0 }, steam(null, null)), null);
  const liq = classifyLiquidity({ steamSales24h: null, skinportSales7d: null, activeListings: 500 });
  assert.equal(liq.cls, 'unknown'); // много объявлений ≠ продажи
});

test('ликвидность считается только по продажам', () => {
  assert.equal(classifyLiquidity({ steamSales24h: 120, skinportSales7d: null, activeListings: null }).cls, 'high');
  assert.equal(classifyLiquidity({ steamSales24h: 3, skinportSales7d: null, activeListings: 1000 }).cls, 'low');
  assert.equal(classifyLiquidity({ steamSales24h: null, skinportSales7d: 140, activeListings: null }).cls, 'medium');
});

test('28: при нулевом бюджете сделка не считается доступной', () => {
  const a = computeSteamArbitrage({ source: 'skinport', costKop: 30000, fetchedAt: 0 }, steam(65000, 64000))!;
  const s = scoreArbitrage(ctx(a, { budgetKop: 1 }));
  assert.equal(s.affordable, false);
  assert.notEqual(s.priority, 'high');
});

function ctx(arb: NonNullable<ReturnType<typeof computeSteamArbitrage>>, o: Partial<ScoringContext> & { budgetKop?: number } = {}): ScoringContext {
  return {
    arb, liquidity: classifyLiquidity({ steamSales24h: 200, skinportSales7d: null, activeListings: null }),
    uniquePriced: false, buyQuantity: 10, buyAgeSec: 60, sellAgeSec: 60, fxAgeDays: 0, fxAvailable: true,
    ...o,
    settings: { minProfitKop: 1000, minRoiBp: 500, maxBuyKop: 0, budgetKop: o.budgetKop ?? 0, maxStaleSec: 1800, fxMaxAgeDays: 4, requireLiquidity: 'medium' },
  };
}
