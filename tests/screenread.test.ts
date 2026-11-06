// Чтение скриншотов сайтов: разбор ответа нейросети, русские названия → английские, сопоставление с инвентарём, запись пачкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { setMetaStmt } from '../src/core/channel.ts';
import { storeInventory } from '../src/core/steaminv.ts';
import { parseVision, parsePriceMinor, candidates, matchName, type NamesRu } from '../src/core/screenread.ts';

const DICT: NamesRu = {
  w: { 'Автомат «Галиль»': 'Galil AR', 'MP5-SD': 'MP5-SD', 'Tec-9': 'Tec-9' },
  p: { 'Умелые ручки': ['Kitbash'], 'Повстанец': ['Rebel'], 'Безводье': ['Drought'], 'Банановые листья': ['Banana Leaf'] },
  c: { 'Кейс «Грёзы и кошмары»': 'Dreams & Nightmares Case' },
};
const row = (type: string, name: string, wear = '') => ({ type, name, wear, price: '', currency: '', float: '' });

test('разбор ответа нейросети: JSON внутри текста, обрезанный ответ, мусор', () => {
  const r = parseVision('Here you go:\n[{"type":"MP5-SD","name":"Умелые ручки","wear":"После полевых испытаний","price":"1,30","currency":"pln","float":"0.347"}]\nDone');
  assert.equal(r.length, 1);
  assert.equal(r[0].currency, 'PLN');
  assert.equal(parseVision('[{"type":"A","name":"X","price":"1"},{"type":"B","name":"Y","pri').length, 1, 'обрезанный — берём целые');
  assert.deepEqual(parseVision('нет'), []);
  assert.equal(parsePriceMinor('3,47'), 347);
  assert.equal(parsePriceMinor('1 234,50'), 123450);
  assert.equal(parsePriceMinor('0.13'), 13);
  assert.equal(parsePriceMinor('abc'), null);
});

test('русские названия → английские: кейс, оружие, StatTrak™, сувенир, износ; английские остаются', () => {
  assert.deepEqual(candidates(row('Контейнер', 'Кейс «Грёзы и кошмары»'), DICT), ['Dreams & Nightmares Case']);
  assert.deepEqual(candidates(row('MP5-SD', 'Умелые ручки', 'После полевых испытаний Пистолет-пулемёт'), DICT), ['MP5-SD | Kitbash (Field-Tested)']);
  assert.deepEqual(candidates(row('Автомат «Галиль»', 'Destroyer', 'После полевых испытаний'), DICT), ['Galil AR | Destroyer (Field-Tested)']);
  assert.deepEqual(candidates(row('StatTrak™ Tec-9', 'Повстанец', 'После полевых испытаний'), DICT), ['StatTrak™ Tec-9 | Rebel (Field-Tested)']);
  assert.deepEqual(candidates(row('Сувенирный P250', 'Безводье', 'Немного поношенное'), DICT), ['Souvenir P250 | Drought (Minimal Wear)']);
  assert.deepEqual(candidates(row('Tec-9', 'Банановые листья', 'Закалённое в боях'), DICT), ['Tec-9 | Banana Leaf (Battle-Scarred)']);
  assert.equal(matchName(['Tec-9 | Rebel (Field-Tested)'], ['tec-9 | rebel (field-tested)']), 'tec-9 | rebel (field-tested)');
  assert.equal(matchName(['MP5-SD | Kitbash'], ['MP5-SD | Kitbash (Field-Tested)']), 'MP5-SD | Kitbash (Field-Tested)', 'износ не прочитан — единственный подходящий');
  assert.equal(matchName(['X | Y (Field-Tested)'], ['A | B (Field-Tested)']), null, 'не угадываем');
});

test('скриншот → предметы из инвентаря с ценами; запись пачкой «ждёт оплаты»', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const calls: Record<string, unknown>[] = [];
  let agreed = false;
  const AI = { run: async (model: string, input: Record<string, unknown>) => {
    calls.push({ model, ...input });
    if (input.prompt === 'agree') { agreed = true; return { response: 'ok' }; }
    if (!agreed) throw new Error('5016: Prior to using this model, you must submit the prompt \'agree\'');
    return { response: '[{"type":"Контейнер","name":"Кейс «Грёзы и кошмары»","wear":"","price":"3,47","currency":"PLN","float":""},{"type":"MP5-SD","name":"Умелые ручки","wear":"После полевых испытаний","price":"1,30","currency":"PLN","float":"0.347"},{"type":"AK-47","name":"Чужой","wear":"","price":"9","currency":"PLN","float":""}]' };
  } };
  const env = { ...testEnv(d), AI };
  const U = 7201, SID = '76561198000000011', NOW = Date.parse('2026-11-06T02:00:00Z') / 1000;
  d.db.prepare('INSERT INTO users (telegram_id, created_at, steam_id, steam_verified) VALUES (?, ?, ?, 1)').run(U, NOW, SID);
  await setMetaStmt(D, 'names_ru', JSON.stringify(DICT)).run();
  await storeInventory(D, U, { status: 'ok', steamId: SID, items: [{ name: 'Dreams & Nightmares Case', qty: 3, marketable: 1, tradable: 1, img: null }, { name: 'MP5-SD | Kitbash (Field-Tested)', qty: 1, marketable: 1, tradable: 1, img: null }], partial: false }, NOW - 100);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown) => (await handleAppApi(new Request('https://w.dev/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env as any, NOW)).json() as Promise<Record<string, any>>;
  assert.equal((await call('sales/scan', 'POST', { image: 'not an image' })).ok, false);
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(50_000);
  const r = await call('sales/scan', 'POST', { image: img });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(agreed, true, 'лицензия модели принята автоматически');
  assert.equal(calls.at(-1)!.image, img);
  assert.deepEqual(r.items.map((x: any) => [x.name, x.priceMinor, x.currency]), [
    ['Dreams & Nightmares Case', 347, 'PLN'], ['MP5-SD | Kitbash (Field-Tested)', 130, 'PLN'], [null, 900, 'PLN'],
  ]);
  assert.equal(r.fees.skinport, 800);
  const b = await call('sales/batch', 'POST', { rows: [
    { name: 'Dreams & Nightmares Case', qty: 1, receivedKop: 3000, platform: 'skinport', buyKop: 0, pending: true },
    { name: 'MP5-SD | Kitbash (Field-Tested)', qty: 1, receivedKop: 1100, platform: 'skinport', pending: true },
  ] });
  assert.equal(b.sold, 1);
  assert.match(b.errors[0], /Kitbash.*за сколько покупал/);
  const tr = await call('trades');
  assert.equal(tr.pending.length, 1);
  assert.equal(tr.pending[0].receivedKop, 3000);
  assert.equal(tr.pending[0].platform, 'Skinport');
});

test('без подключённой нейросети — понятная ошибка', async () => {
  const d = migratedDb();
  const NOW = Date.parse('2026-11-06T02:00:00Z') / 1000;
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: 5 }) }, 'TEST_TOKEN');
  const r = await (await handleAppApi(new Request('https://w.dev/app/api/sales/scan', { method: 'POST', headers: { 'X-Init-Data': init }, body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' }) }), testEnv(d), NOW)).json() as Record<string, any>;
  assert.match(r.error, /не подключено/);
});
