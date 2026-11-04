import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceOverview, parseSearch, fetchSteamPriceOverview, priceOverviewUrl } from '../src/api/steam.ts';
import { scanSkinportItems, parseSalesHistory, fetchSkinportItems } from '../src/api/skinport.ts';
import { parseListings } from '../src/api/csfloat.ts';
import { fetchNbuRates } from '../src/currency/nbu.ts';
import { SourceError } from '../src/types/market.ts';
import { parseRetryAfter, safeLink } from '../src/utils/http.ts';
import { fixture, fixtureJson, mockFetch, json } from './helpers.ts';

const NOW = 1_800_000_000;

test('Steam priceoverview: цены в UAH (currency=18), объём — продажи за 24 ч', () => {
  const q = parsePriceOverview(fixtureJson('steam_priceoverview_uah.json'), 'AK-47 | Redline (Field-Tested)', NOW);
  assert.equal(q[0].priceType, 'lowest_listing');
  assert.equal(q[0].priceMinor, 65000);
  assert.equal(q[0].currency, 'UAH');
  assert.equal(q[1].priceMinor, 64050);
  assert.equal(q[1].volume, 1234);
  assert.equal(q[1].volumePeriod, '24h');
  assert.ok(priceOverviewUrl('X').includes('currency=18'));
});

test('Steam: нет поля цены → null, а не ноль', () => {
  const q = parsePriceOverview({ success: true, volume: '3' }, 'X', NOW);
  assert.equal(q[0].priceMinor, null);
  assert.equal(q[0].quality, 'partial');
});

test('Steam поиск возвращает точные market_hash_name', () => {
  const hits = parseSearch(fixtureJson('steam_search.json'));
  assert.equal(hits.length, 2);
  assert.equal(hits[1].marketHashName, 'StatTrak™ AK-47 | Redline (Field-Tested)');
});

// 14. HTTP 429
test('14: HTTP 429 превращается в rate_limited с Retry-After', async () => {
  const { fetcher } = mockFetch([{ match: () => true, respond: () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }) }]);
  await assert.rejects(fetchSteamPriceOverview('X', NOW, fetcher), (e: unknown) =>
    e instanceof SourceError && e.kind === 'rate_limited' && e.retryAfterSec === 120);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')), 60);
});

// 15. HTTP 500
test('15: HTTP 500 превращается в server error', async () => {
  const { fetcher } = mockFetch([{ match: () => true, respond: () => new Response('oops', { status: 502 }) }]);
  await assert.rejects(fetchNbuRates(fetcher), (e: unknown) => e instanceof SourceError && e.kind === 'server' && e.status === 502);
});

// 18. Ошибки JSON
test('18: некорректный JSON и неожиданная схема распознаются', async () => {
  const { fetcher } = mockFetch([{ match: () => true, respond: () => new Response('<html>не JSON</html>') }]);
  await assert.rejects(fetchSteamPriceOverview('X', NOW, fetcher), (e: unknown) => e instanceof SourceError && e.kind === 'bad_json');
  assert.throws(() => parseSalesHistory({ items: [] }, NOW), (e: unknown) => e instanceof SourceError && e.kind === 'schema');
  assert.throws(() => parsePriceOverview({ success: false }, 'X', NOW), (e: unknown) => e instanceof SourceError && e.kind === 'not_found');
});

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

test('Skinport: потоковый разбор каталога находит нужные предметы при любом разбиении на куски', async () => {
  const text = fixture('skinport_items.json');
  for (const size of [7, 13, 64, 100000]) {
    const found = await scanSkinportItems(streamOf(text, size),
      new Set(['AK-47 | Redline (Field-Tested)', '★ Karambit | Doppler (Factory New)', '★ M9 Bayonet | Fade (Factory New)']), NOW);
    assert.equal(found.size, 3, `chunk ${size}`);
    assert.equal(found.get('AK-47 | Redline (Field-Tested)')!.priceMinor, 850);
    assert.equal(found.get('AK-47 | Redline (Field-Tested)')!.quantity, 40);
    // ★ в JSON корректно сопоставляется со «★».
    assert.equal(found.get('★ Karambit | Doppler (Factory New)')!.priceMinor, 70000);
    // quantity 0 → цены нет (null), а не 0.
    assert.equal(found.get('★ M9 Bayonet | Fade (Factory New)')!.priceMinor, null);
  }
});

test('Skinport: требуется Accept-Encoding: br, валюта EUR', async () => {
  const { fetcher, calls } = mockFetch([{ match: (u) => u.includes('/v1/items'), respond: () => new Response(fixture('skinport_items.json')) }]);
  const r = await fetchSkinportItems(new Set(['AK-47 | Redline (Field-Tested)']), NOW, fetcher);
  assert.equal(r.size, 1);
  assert.equal((calls[0].init?.headers as Record<string, string>)['Accept-Encoding'], 'br');
  assert.ok(calls[0].url.includes('currency=EUR'));
});

test('Skinport: неожиданная валюта — ошибка, а не тихая подмена', async () => {
  const bad = JSON.stringify([{ market_hash_name: 'A', currency: 'PLN', min_price: 1, quantity: 1 }]);
  await assert.rejects(scanSkinportItems(streamOf(bad, 10), new Set(['A']), NOW), (e: unknown) => e instanceof SourceError && e.kind === 'schema');
});

test('Skinport sales history: медианы и объёмы продаж 7/30 дней', () => {
  const q = parseSalesHistory(fixtureJson('skinport_sales.json'), NOW);
  const d7 = q.find((x) => x.priceType === 'sale_median_7d')!;
  assert.equal(d7.priceMinor, 1050);
  assert.equal(d7.volume, 210);
});

test('CSFloat: формат {data}, фильтр по точному имени, сортировка по цене, цены в центах USD', () => {
  const q = parseListings(fixtureJson('csfloat_listings.json'), 'AK-47 | Redline (Field-Tested)', NOW);
  assert.equal(q.length, 2);
  assert.equal(q[0].priceMinor, 1290);
  assert.equal(q[0].currency, 'USD');
  assert.equal(q[0].paintSeed, 77);
  assert.equal(q[0].url, 'https://csfloat.com/item/900000000000000001');
  // формат массивом тоже поддерживается
  assert.equal(parseListings((fixtureJson('csfloat_listings.json') as { data: unknown[] }).data, 'AK-47 | Redline (Field-Tested)', NOW).length, 2);
});

// 22. Ссылки
test('22: ссылки разрешены только на проверенные домены по https', () => {
  assert.equal(safeLink('https://skinport.com/item/x'), 'https://skinport.com/item/x');
  assert.equal(safeLink('http://skinport.com/item/x'), null);
  assert.equal(safeLink('https://skinport.com.evil.example/x'), null);
  assert.equal(safeLink('https://steamcommunity.co/market'), null);
  assert.equal(safeLink('javascript:alert(1)'), null);
});

test('НБУ: отсутствие валют в ответе — ошибка схемы', async () => {
  const { fetcher } = mockFetch([{ match: () => true, respond: () => json([{ cc: 'AUD', rate: 27, exchangedate: '04.11.2026' }]) }]);
  await assert.rejects(fetchNbuRates(fetcher), (e: unknown) => e instanceof SourceError && e.kind === 'schema');
});
