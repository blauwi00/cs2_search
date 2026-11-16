// «Дёшево в Steam»: выборка из живых цен домашнего сборщика (тестовые цены синтетические).
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';
import { pickCheap, resetCheapMemo, type CheapRow } from '../src/core/cheap.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z') / 1000;
const row = (name: string, cents: number, listings: number, cat: string): CheapRow => ({ name, cents, listings, cat });

test('отбор: по категории, по числу объявлений (больше — выше), счётчик всего', () => {
  const rows = [row('A Case', 13, 65000, 'case'), row('S | One', 20, 300, 'sticker'), row('AK | X (Field-Tested)', 90, 800, 'weapon'), row('B Case', 40, 1000, 'case')];
  assert.deepEqual(pickCheap(rows, 'all').list.map((x) => x.name), ['A Case', 'B Case', 'AK | X (Field-Tested)', 'S | One']);
  const c = pickCheap(rows, 'case'); assert.equal(c.total, 2); assert.equal(c.list[0].catRu, 'Кейс');
  assert.deepEqual(pickCheap(rows, 'skin').list.map((x) => x.name), ['AK | X (Field-Tested)']);
});

test('API: до $1 только живые цены, мусор отсекается (дешевле 5 центов, меньше 5 объявлений, дороже порога), без данных — пустой ответ', async () => {
  const d = migratedDb(); const env = testEnv(d);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: ADMIN }) }, 'TEST_TOKEN');
  const call = async (q: string) => await (await handleAppApi(new Request('https://w/app/api/cheap' + q, { headers: { 'X-Init-Data': init } }), env, NOW)).json() as any;
  assert.equal((await call('')).at, null); assert.equal((await call('')).list.length, 0);
  d.db.exec(`INSERT INTO steam_live (name, cents, listings, at) VALUES ('Kilowatt Case', 13, 65000, ${NOW}), ('Gallery Case', 72, 4000, ${NOW}), ('Pricey Case', 150, 900, ${NOW}),
    ('Junk Case', 2, 9000, ${NOW}), ('Rare Case', 30, 2, ${NOW}), ('Mid Case', 40, 500, ${NOW})`);
  d.db.exec(`INSERT INTO meta (key, value) VALUES ('steam_live_at', '${NOW}'), ('steam_live_pass_at', '${NOW}')`);
  resetCheapMemo();
  const r = await call('?max=100');
  assert.deepEqual(r.list.map((x: any) => x.name), ['Kilowatt Case', 'Gallery Case', 'Mid Case'].sort((a, b) => ({ 'Kilowatt Case': 65000, 'Gallery Case': 4000, 'Mid Case': 500 } as any)[b] - ({ 'Kilowatt Case': 65000, 'Gallery Case': 4000, 'Mid Case': 500 } as any)[a]));
  assert.equal(r.passAt, NOW);
  assert.deepEqual((await call('?max=50')).list.map((x: any) => x.name), ['Kilowatt Case', 'Mid Case'], 'до $0,50');
  assert.equal((await call('?max=777')).max, 100, 'неизвестный порог — $1');
});
