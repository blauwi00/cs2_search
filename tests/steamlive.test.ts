// Приём живых цен Steam от домашнего сборщика: проверка пачки, запись только изменений, ключ агента, свежесть прохода.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';
import { parseSteamLive, steamLiveFor } from '../src/core/steamlive.ts';

const NOW = Date.parse('2026-11-14T12:00:00Z') / 1000;
const SECRET = 'ingest_secret_test_123';

test('пачка: мусор отбрасывается, цена — целые центы ≥1, число объявлений необязательно', () => {
  const r = parseSteamLive({ 'A Case': [13, 5000], 'B': [0, 1], 'C': [1.5, 1], 'D': ['x'], '': [5, 1], 'E': [7], 'F': [9, -3] });
  assert.deepEqual(r.map((x) => x.name), ['A Case', 'E', 'F']);
  assert.deepEqual(r.map((x) => x.listings), [5000, null, null]);
  assert.deepEqual(parseSteamLive([1, 2]), []); assert.deepEqual(parseSteamLive(null), []);
});

test('приём: пишет цены, повтор без изменений не меняет строки, изменение цены обновляет; done ставит время прохода; чужие виды запрещены ключом агента', async () => {
  const d = migratedDb(); const D = d as unknown as D1Database; const env = testEnv(d, { INGEST_SECRET: SECRET, COLLECTOR: 'github' });
  const post = (body: unknown) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, NOW);
  const r1 = await (await post({ kind: 'steam_live', fetchedAt: NOW, items: { 'Kilowatt Case': [13, 65000], 'Gallery Case': [72, 4000] } })).json() as any;
  assert.equal(r1.stored, 2);
  assert.equal((await steamLiveFor(D, ['Kilowatt Case', 'Gallery Case', 'Nope'])).get('Kilowatt Case')?.cents, 13);
  assert.equal((await steamLiveFor(D, ['Nope'])).size, 0);
  const at1 = (d.db.prepare("SELECT at FROM steam_live WHERE name = 'Kilowatt Case'").get() as { at: number }).at;
  await post({ kind: 'steam_live', fetchedAt: NOW + 50, items: { 'Kilowatt Case': [13, 65000] } });
  assert.equal((d.db.prepare("SELECT at FROM steam_live WHERE name = 'Kilowatt Case'").get() as { at: number }).at, at1, 'без изменений строка не перезаписывается');
  await post({ kind: 'steam_live', fetchedAt: NOW + 100, items: { 'Kilowatt Case': [14, 65000] }, done: true });
  assert.equal((await steamLiveFor(D, ['Kilowatt Case'])).get('Kilowatt Case')?.cents, 14, 'цена изменилась — обновлена');
  assert.equal((d.db.prepare("SELECT value FROM meta WHERE key = 'steam_live_pass_at'").get() as { value: string }).value, String(NOW + 100));
  const bad = await post({ kind: 'steam_live', fetchedAt: NOW, items: { 'X': ['не число'] } });
  assert.equal(((await bad.json()) as any).stored, 0);
  assert.equal((await post({ kind: 'steam_live', fetchedAt: NOW + 600, items: { 'Y': [5, 1] } })).status, 400, 'время из будущего отклоняется');
});
