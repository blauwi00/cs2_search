// Аудит оценки: достоверность цен (п.1), точная комиссия Steam по валютам (п.2), площадки (п.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { steamNetKop, steamListForNetKop, steamSellerProceeds } from '../src/core/fees.ts';
import { steamEvidence, marketValue } from '../src/core/evidence.ts';
import { sitePriceList } from '../src/core/sites.ts';
import { steamSellPrice } from '../src/core/sellprice.ts';

const NOW = 1_793_800_000;
const USD = { id: 1, base: 'USD' as const, rateMicro: 41_500_000, rateDate: '2026-11-04', source: 'nbu' };

test('комиссия Steam: дешёвые предметы — минимум 1 коп. на каждую из двух комиссий, не «× 0,85»', () => {
  assert.equal(steamNetKop(2), null, 'ниже минимальной цены выставления (3 коп.)');
  assert.equal(steamNetKop(3), 1);    // 1 + 1 + 1
  assert.equal(steamNetKop(4), 2);
  assert.equal(steamNetKop(10), 8);   // 0,85 × 10 = 8,5 — но Steam берёт 1 + 1
  assert.equal(steamNetKop(20), 18);
  assert.equal(steamNetKop(30), 27);  // 27 + 1 + 2 = 30
  assert.equal(steamNetKop(100), 88); // «× 0,85» дало бы 85
  assert.equal(steamNetKop(700), 609);
  assert.equal(steamNetKop(1000), 870);
  for (const k of [3, 7, 19, 33, 101, 449, 600, 1234, 99999]) {
    const p = steamSellerProceeds(k)!;
    assert.equal(p.sellerReceives + p.steamFee + p.publisherFee, k, `сумма частей = цена покупателя (${k})`);
    assert.ok(p.steamFee >= 1 && p.publisherFee >= 1);
  }
  assert.equal(steamListForNetKop(609), 699, 'чтобы получить 6,09 ₴ — выставить за 6,99 ₴');
});

test('комиссия Steam в другой валюте кошелька: минимум — 1 цент, а не 1 копейка', () => {
  const usd = { per: 41.5 };              // 1 $ = 41,5 ₴
  assert.equal(steamNetKop(125, usd), 41); // 0,03 $ → придёт 0,01 $ (≈ 0,41 ₴), а не 1,09 ₴ по гривневой формуле
  assert.equal(steamNetKop(125), 109);
  assert.equal(steamNetKop(415, usd), 332); // 0,10 $ → 0,08 $
  assert.equal(steamNetKop(80, usd), null, 'меньше 0,03 $ выставить нельзя');
});

test('доказательства цены: объявление, медиана, ордер и средние — раздельно; устаревшее не используется', () => {
  const q = (t: string, kop: number, age: number, volume: number | null = null) => ({ source: 'steam', price_type: t, price_kop: kop, volume, fetched_at: NOW - age });
  const avg = { d1: 10, d7: 11, d30: 12, d90: 13, updated_at: NOW - 3600 };
  const e = steamEvidence([q('lowest_listing', 450, 600), q('median_24h', 430, 600, 900), q('buy_order', 400, 600)], avg, USD, NOW);
  assert.equal(e.status, 'live');
  assert.deepEqual([e.listing?.kop, e.median24h?.kop, e.median24h?.volume, e.buyOrder?.kop], [450, 430, 900, 400]);
  assert.equal(e.avg?.d7, 457); // 0,11 $ × 41,5
  assert.deepEqual(marketValue(e), { kop: 450, basis: 'listing' });
  // Объявление 7 ч назад — уже не «сейчас»: остаются только средние продаж (история, не предложение).
  const e2 = steamEvidence([q('lowest_listing', 450, 7 * 3600)], avg, USD, NOW);
  assert.equal(e2.status, 'history'); assert.equal(e2.listing, null); assert.deepEqual(e2.stale, ['lowest_listing']);
  assert.equal(marketValue(e2), null, 'средние прайса как сумму не используем (завышены относительно живого Steam)');
  assert.deepEqual(marketValue(e2, 300), { kop: 300, basis: 'site' }, 'нет живой цены — цена других площадок');
  // Средние старше 48 ч и нет живых данных — «Нет актуальных данных».
  const e3 = steamEvidence([q('lowest_listing', 450, 9 * 3600)], { ...avg, updated_at: NOW - 3 * 86400 }, USD, NOW);
  assert.equal(e3.status, 'no_data'); assert.equal(marketValue(e3), null);
  // Нет курса доллара — средние не пересчитываем наугад.
  assert.equal(steamEvidence([], avg, null, NOW).status, 'no_data');
});

test('рекомендация продажи: без цены — нет рекомендации; комиссия по валюте кошелька', () => {
  assert.equal(steamSellPrice({ liveLowKop: null, d1Kop: null, d7Kop: null, d30Kop: null }), null);
  const r = steamSellPrice({ liveLowKop: 125, d1Kop: 125, d7Kop: 125, d30Kop: 125, wallet: { per: 41.5 } })!;
  assert.equal(r.receiveKop, 41);
});

test('площадки: устаревшие данные не показываются, CS.MONEY — ориентир, а не объявление', () => {
  const toK = (c: number) => Math.round(c * 41.5);
  const list = sitePriceList('AK-47 | Redline (Field-Tested)', { skinport: 1000, csmoney: 900, buff163: 950 }, toK, {}, null,
    { skinport: NOW - 600, csmoney: NOW - 3600, buff163: NOW - 5 * 86400 }, NOW);
  assert.deepEqual(list.map((x) => [x.key, x.kind]), [['skinport', 'listing'], ['csmoney', 'reference']], 'BUFF старше 48 ч — убран; ориентир — после объявлений');
  assert.equal(list[0].cur, 'EUR'); assert.equal(list[0].at, NOW - 600);
});


test('главная: Waxpeer виден (с низкой оценкой — для осторожности), его цены в карточке предмета остаются', async () => {
  const { sitesFor } = await import('../src/core/sites.ts');
  const home = sitesFor({});
  const wp = home.find((x) => x.key === 'waxpeer');
  assert.ok(wp && wp.rating !== null && wp.rating < 3.5);
  assert.equal(home.length, 12);
  const list = sitePriceList('AK-47 | Redline (Field-Tested)', { waxpeer: 1000 }, (c) => c * 41, {}, null, { waxpeer: NOW }, NOW);
  assert.equal(list[0].key, 'waxpeer');
});
