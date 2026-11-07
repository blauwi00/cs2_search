// Баланс Steam: вписывается вручную, дальше бот учитывает продажи и покупки в Steam; предложения — под баланс.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { pickRec, hotText } from '../src/core/hotrecs.ts';
import type { Rec } from '../src/core/recs.ts';

const NOW = Date.parse('2026-11-07T10:00:00Z') / 1000;
const U = 8801;

test('баланс Steam: вписал → продажа в Steam прибавляет, покупка в Steam вычитает, продажа за деньги не трогает; убрать — пусто', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: U }) }, 'TEST_TOKEN');
  const call = async (path: string, method = 'GET', body?: unknown, at = NOW) => (await handleAppApi(new Request('https://w/app/api/' + path, { method, headers: { 'X-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }), env, at)).json() as Promise<Record<string, any>>;
  const lot = (await call('inventory', 'POST', { name: 'Revolution Case', qty: 3, priceKop: 1000, platform: 'skinport', date: '2026-11-01' })).id;
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1700, platform: 'steam' }, NOW - 60); // до ввода баланса — не считается
  assert.equal((await call('summary')).steamBalance, null);
  assert.equal((await call('steam-balance', 'POST', { kop: 50000 })).ok, true);
  assert.equal((await call('steam-balance', 'POST', { kop: -5 })).ok, false);
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1700, platform: 'steam' }, NOW + 10);
  await call(`inventory/${lot}/sell`, 'POST', { qty: 1, priceKop: 2000, receivedKop: 1900, platform: 'csgomarket' }, NOW + 20);
  await call('inventory', 'POST', { name: 'Fever Case', qty: 2, priceKop: 3000, platform: 'steam', date: '2026-11-07' }, NOW + 30);
  const s = await call('summary', 'GET', undefined, NOW + 40);
  assert.equal(s.steamBalance.kop, 50000 + 1700 - 6000, 'вписано + продажа в Steam − покупка в Steam');
  await call('steam-balance', 'POST', { kop: null });
  assert.equal((await call('summary')).steamBalance, null);
});

test('предложения под баланс: сначала покупка в Steam, которая укладывается; дороже баланса в Steam — не предлагаем', () => {
  const rec = (name: string, buyAt: Rec['buyAt'], payKop: number) => ({ name, buyAt, sellAt: 'skinport', payKop, buyKop: payKop, sellKop: payKop * 2, profitKop: 100, roiBp: 3000, wallet: 'cash' }) as unknown as Rec;
  const list = [rec('A', 'skinport', 500), rec('Big Steam', 'steam', 90000), rec('Small Steam', 'steam', 2000)];
  const all = () => true;
  assert.equal(pickRec(list, null, all)!.name, 'A', 'без баланса — как раньше');
  assert.equal(pickRec(list, 5000, all)!.name, 'Small Steam', 'есть баланс — то, что можно купить на него');
  assert.equal(pickRec([rec('Big Steam', 'steam', 90000), rec('A', 'skinport', 500)], 5000, all)!.name, 'A', 'дороже баланса — пропускаем');
  assert.match(hotText(rec('Small Steam', 'steam', 2000), 5000), /Хватает твоего баланса Steam/);
  assert.doesNotMatch(hotText(rec('A', 'skinport', 500), null), /баланса Steam \(/);
});
