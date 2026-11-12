// Карточка предмета без цен площадок: предмет ставится в очередь, сборщик обновляет его вне очереди, общий таймер не сбивается.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { handleAppApi } from '../src/webapp/api.ts';
import { signInitData } from '../src/webapp/auth.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z') / 1000;
const SECRET = 'ingest_secret_test_123';
test('нет цен площадок -> «requested», очередь доходит до сборщика как partial, после приёма очищается и 6-часовой таймер не трогается', async () => {
  const d = migratedDb(); const env = testEnv(d, { INGEST_SECRET: SECRET, COLLECTOR: 'github' });
  const post = (body: unknown) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, NOW);
  const plan = async () => await (await handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': SECRET } }), env, NOW + 60)).json() as any;
  await post({ kind: 'site_prices', fetchedAt: NOW, items: [{ name: 'Other Case', p: { skinport: 100 } }], done: true }); // общий проход только что был
  assert.deepEqual((await plan()).sitePriceNames, []);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'Q', user: JSON.stringify({ id: ADMIN }) }, 'TEST_TOKEN');
  const res = await handleAppApi(new Request('https://w/app/api/prices?name=' + encodeURIComponent('Gallery Case'), { headers: { 'X-Init-Data': init } }), env, NOW + 30);
  const j = await res.json() as any;
  assert.equal(j.requested, true); assert.deepEqual(j.sites, []);
  const p = await plan();
  assert.deepEqual(p.sitePriceNames, ['Gallery Case']); assert.equal(p.sitePricePartial, true);
  await post({ kind: 'site_prices', fetchedAt: NOW + 90, items: [{ name: 'Gallery Case', p: { skinport: 50 } }], done: true, partial: true });
  const p2 = await plan();
  assert.deepEqual(p2.sitePriceNames, [], 'очередь очищена, общий проход не запущен заново');
  const row = await (d as unknown as D1Database).prepare("SELECT name FROM site_prices WHERE name = 'Gallery Case'").first();
  assert.ok(row, 'цены предмета сохранены');
});
