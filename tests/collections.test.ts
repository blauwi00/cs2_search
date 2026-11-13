// «Коллекции»: расчёт в сборщике, приём в Worker, статусы, ликвидность, выход в плюс после комиссии Steam, признак ротации.
// Цены в тестах синтетические (помечены как тестовые): настоящих данных тут нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollections, skinPrice } from '../.github/scripts/collections.mjs';
import { liquidity, rotationHint, parseCollStats, parseCaseVols, collViews, collVolTasks, volKey, COLLECTION_STATUS, type CollStat } from '../src/core/collections.ts';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z') / 1000;
const SECRET = 'ingest_secret_test_123';
const sk = (n: string, r = 'rarity_rare_weapon') => ({ name: n, rarity: { id: r } });
const cols = [
  { id: 'collection-set-x', name: 'The X Collection', release_date: '2024-01-01', crates: [{ name: 'X Case' }], contains: [sk('A | One'), sk('A | Two'), sk('A | Three'), sk('A | Red', 'rarity_ancient_weapon'), sk('Sticker | Not weapon', 'rarity_rare')] },
  { id: 'sticker', name: 'Stickers', contains: [sk('Sticker | Y', 'rarity_rare')] },
];
const px = (d1: number, d7: number, d30: number, d90: number) => ({ d1, d7, d30, d90 });

test('сборщик: считает динамику по коллекции, стикеры и пустые отбрасывает; нет цены — предмета нет в расчёте', () => {
  const avg = new Map<string, any>([
    ['A | One (Field-Tested)', px(1.2, 1.2, 1, 1)], ['A | Two (Minimal Wear)', px(1.3, 1.3, 1, 1)], ['A | Three (Field-Tested)', px(0.9, 1.0, 1, 1)],
    ['A | Red (Battle-Scarred)', px(30, 30, 30, 30)], ['X Case', px(1, 1, 0.9, 0.8)],
  ]);
  const r = buildCollections(cols, avg) as CollStat[];
  assert.equal(r.length, 1);
  const c = r[0];
  assert.equal(c.n, 4); assert.equal(c.k, 4);
  assert.equal(c.up, 2, 'два предмета выросли на ≥15%');
  assert.equal(c.cov, 1); assert.deepEqual(c.cheapCov, { name: 'A | Red', d7: 3000 });
  assert.equal(c.crates[0].d7, 100);
  assert.equal(skinPrice('Nope', avg), null);
});

test('сувенирные коллекции: ищем цену у «Souvenir …»', () => {
  const avg = new Map<string, any>([['Souvenir A | One (Field-Tested)', px(2, 2, 2, 2)]]);
  assert.equal(skinPrice('A | One', avg)?.key, 'Souvenir A | One (Field-Tested)');
});

test('ликвидность и признак ротации: пороги', () => {
  assert.equal(liquidity(null), null); assert.equal(liquidity(4127), 'high'); assert.equal(liquidity(500), 'mid'); assert.equal(liquidity(99), 'low');
  assert.equal(rotationHint({ up: 2, k: 4 }), false, 'меньше 3 предметов — не сигнал');
  assert.equal(rotationHint({ up: 3, k: 20 }), false, 'меньше 30% — не сигнал');
  assert.equal(rotationHint({ up: 3, k: 8 }), true);
});

test('выход в плюс: цена Steam, при которой после комиссии 15% возвращаются потраченные деньги; статусы только из списка', () => {
  const stats: CollStat[] = [{ id: 'collection-set-community-34', name: 'Gallery', rel: null, n: 17, k: 10, m7: 100, m30: 100, up: 0, ups: [], cov: 1, cheapCov: null, crates: [{ name: 'Gallery Case', d1: null, d7: 80, d30: 80, d90: 80 }], crateNames: ['Gallery Case'], skins: [] },
    { id: 'collection-set-unknown', name: 'U', rel: null, n: 5, k: 5, m7: 100, m30: 100, up: 0, ups: [], cov: 0, cheapCov: null, crates: [], crateNames: [], skins: [] }];
  const vols = parseCaseVols([{ name: 'Gallery Case', code: 'UAH', lowest_price: '33₴', median_price: '32,79₴', volume: '4,127' }, { name: 'Gallery Case', code: 'USD', lowest_price: '$1.31', median_price: '$1.30', volume: '4,127' }, { name: 'Gallery Case', code: 'XXX', lowest_price: '5₴' }], NOW);
  assert.equal(vols[volKey('UAH', 'Gallery Case')].vol, 4127);
  assert.equal(vols[volKey('USD', 'Gallery Case')].low, 131, 'доллары — в центах, без пересчёта по курсу');
  assert.equal(Object.keys(vols).length, 2, 'неизвестный код валюты пропускаем, гривной не подменяем');
  const v = collViews(stats, vols, 'UAH');
  const cr = v[0].crates[0];
  assert.match(cr.priceText!, /33,00/); assert.equal(cr.priceUsd, 80); assert.equal(cr.liq, 'high');
  assert.ok(cr.needPct! >= 15 && cr.needPct! <= 20, `нужно ~+17,6%, получилось ${cr.needPct}`);
  assert.match(collViews(stats, vols, 'USD')[0].crates[0].priceText!, /1,31/, 'у человека с долларовым Steam — цена в долларах Steam');
  assert.equal(collViews(stats, vols, 'EUR')[0].crates[0].priceText, null, 'нет живой цены в его валюте — не пересчитываем по курсу');
  assert.equal(collViews(stats, {}, 'UAH')[0].crates[0].needText, null, 'выход в плюс считаем только от живой цены');
  assert.equal(v[1].status, null, 'статус неизвестной коллекции не выдумываем');
  assert.equal(v[0].status?.s, 'removed');
  assert.ok(Object.values(COLLECTION_STATUS).every((s) => s.src.length > 3), 'у каждого статуса указан источник');
});

test('какие кейсы обновить: все кейсы без сувенирных наборов; давние первыми, при равенстве сначала со статусом; не больше 4', () => {
  const mk = (id: string, names: string[]): CollStat => ({ id, name: id, rel: null, n: 1, k: 1, m7: null, m30: null, up: 0, ups: [], cov: 0, cheapCov: null, crates: [], crateNames: names, skins: [] });
  const stats = [mk('collection-set-community-34', ['Gallery Case']), mk('collection-set-dust-2', ['Berlin 2019 Dust II Souvenir Package']), mk('collection-set-unknown', ['Hidden Case'])];
  assert.deepEqual(collVolTasks(stats, {}, NOW, ['UAH']).map((t) => t.name), ['Gallery Case', 'Hidden Case']);
  assert.deepEqual(collVolTasks(stats, { [volKey('UAH', 'Gallery Case')]: { low: 1, med: 1, vol: 1, at: NOW - 3600 } }, NOW, ['UAH']).map((t) => t.name), ['Hidden Case'], 'свежее 6 часов — не трогаем');
  const two = collVolTasks(stats, { [volKey('UAH', 'Gallery Case')]: { low: 1, med: 1, vol: 1, at: NOW - 3600 } }, NOW, ['UAH', 'USD']);
  assert.deepEqual(two.map((t) => `${t.code}:${t.name}`), ['UAH:Hidden Case', 'USD:Gallery Case', 'USD:Hidden Case'], 'каждая валюта кошельков — свои запросы, давние первыми');
});

test('приём и API: сборщик шлёт статистику, приложение её видит; мусор отбрасывается; повтор не пишет заново', async () => {
  const d = migratedDb(); const env = testEnv(d, { INGEST_SECRET: SECRET, COLLECTOR: 'github' });
  const post = (body: unknown) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, NOW);
  const item = { id: 'collection-set-community-34', name: 'The Gallery Collection', rel: '2024-10-02', n: 17, k: 10, m7: 110, m30: 100, up: 3, ups: [{ name: 'A | One', p7: 120, r7: 130 }], cov: 1, cheapCov: { name: 'A | Red', d7: 3000 }, crates: [{ name: 'Gallery Case', d1: null, d7: 80, d30: 70, d90: null }], crateNames: ['Gallery Case'], skins: [{ n: 'A | Red (Field-Tested)', rar: 5, d7: 3000, d30: 2500, d90: 2000 }, { n: 'A | One (Minimal Wear)', rar: 2, d7: 100, d30: 100, d90: null }] };
  const r = await post({ kind: 'collections_stats', fetchedAt: NOW, items: [item, { id: 5 }, null, { id: 'x'.repeat(200), name: 'bad' }] });
  assert.equal((await r.json() as any).stored, 1);
  await post({ kind: 'collections_vol', fetchedAt: NOW, items: [{ name: 'Gallery Case', lowest_price: '33₴', median_price: '32,79₴', volume: '4,127' }] });
  await post({ kind: 'steam_avg', fetchedAt: NOW, items: [] });
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: ADMIN }) }, 'TEST_TOKEN');
  const res = await handleAppApi(new Request('https://w/app/api/collections', { headers: { 'X-Init-Data': init } }), env, NOW);
  const j = await res.json() as any;
  assert.equal(j.ok, true); assert.equal(j.list.length, 1);
  assert.equal(j.list[0].status.s, 'removed'); assert.equal(j.list[0].crates[0].vol, 4127);
  await post({ kind: 'steam_avg', fetchedAt: NOW, items: [] });
  const det = await handleAppApi(new Request('https://w/app/api/collections/collection-set-community-34', { headers: { 'X-Init-Data': init } }), env, NOW);
  const dj = await det.json() as any;
  assert.equal(dj.ok, true); assert.deepEqual(dj.crateNames, ['Gallery Case']); assert.equal(dj.skins.length, 2); assert.equal(dj.skins[0].rar, 5); assert.equal(dj.skins[0].trend7, 20);
  assert.equal((await handleAppApi(new Request('https://w/app/api/collections/nope-nope', { headers: { 'X-Init-Data': init } }), env, NOW)).status, 404);
});
