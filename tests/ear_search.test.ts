// Русский поиск «на слух»: слова, которых нет в словаре, сопоставляются со словами каталога по звуковому скелету.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skeleton } from '../src/core/skeleton.ts';
import { skeleton as skeletonMjs, buildTokenIndex } from '../.github/scripts/catalogtokens.mjs';
import { catalogLines, searchByEar, searchSmart, searchCatalog, resetTokensMemo } from '../src/catalog.ts';
import { migratedDb, testEnv, ADMIN } from './helpers.ts';
import { handleIngest } from '../src/ingest.ts';

const NAMES = ['Desert Eagle | Blaze (Factory New)', 'USP-S | Kill Confirmed (Field-Tested)', 'M4A1-S | Hyper Beast (Minimal Wear)', '★ Karambit | Tiger Tooth (Factory New)', 'AK-47 | Asiimov (Well-Worn)',
  'Sticker | Gloves On', '★ Sport Gloves | Vice (Field-Tested)', 'Sticker | Natus Vincere | Rio 2022', 'AWP | Dragon Lore (Factory New)'];
const T = [catalogLines(NAMES)];
const IDX = buildTokenIndex(NAMES);

test('скелет: русский и английский вариант слова совпадают; копия в сборщике даёт то же', () => {
  for (const [ru, en] of [['блейз', 'blaze'], ['конфирмед', 'confirmed'], ['тайгер', 'tiger'], ['хайпер', 'hyper'], ['азимов', 'asiimov'], ['принтстрим', 'printstream'], ['дрэгон', 'dragon']]) {
    assert.equal(skeleton(ru), skeleton(en), `${ru} ~ ${en}`);
    assert.equal(skeleton(ru), skeletonMjs(ru)); assert.equal(skeleton(en), skeletonMjs(en));
  }
  assert.notEqual(skeleton('блейз'), skeleton('кейс'));
});

test('поиск на слух: «дигл блейз», «юсп килл конфирмед», «хайпер бист», «тайгер тус» находят скины без словаря', () => {
  const q = (s: string) => searchByEar(T, s, 5, IDX)[0];
  assert.equal(q('дигл блейз'), 'Desert Eagle | Blaze (Factory New)');
  assert.equal(q('юсп килл конфирмед'), 'USP-S | Kill Confirmed (Field-Tested)');
  assert.equal(q('м4а1с хайпер бист'), 'M4A1-S | Hyper Beast (Minimal Wear)');
  assert.deepEqual(searchByEar(T, 'абракадабра', 5, IDX), [], 'то, чего нет, не выдумываем');
});

test('«перчатки» — сначала перчатки, а не наклейка «Gloves On»', () => {
  assert.equal(searchSmart(T, 'перчатки', 5)[0], '★ Sport Gloves | Vice (Field-Tested)');
});

test('приём индекса слов от сборщика и поиск через базу', async () => {
  resetTokensMemo();
  const d = migratedDb(); const D = d as unknown as D1Database; const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123', COLLECTOR: 'github' });
  const big = Object.fromEntries(Array.from({ length: 120 }, (_, i) => ['k' + 'abcdefghij'[i % 10] + 'abcdefghij'[Math.floor(i / 10) % 10] + 'abcdefghij'[Math.floor(i / 100)], ['word' + 'abcdefghij'[i % 10]]]));
  const post = (b: unknown) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }), env, Date.parse('2026-11-16T12:00:00Z') / 1000);
  assert.equal(((await (await post({ kind: 'catalog_tokens', fetchedAt: Date.parse('2026-11-16T12:00:00Z') / 1000, tokens: { ...big, ...IDX } })).json()) as any).stored >= 120, true);
  await D.prepare('INSERT INTO catalog_chunks (chunk, names, updated_at) VALUES (0, ?, ?)').bind(T[0], 1).run();
  assert.deepEqual(await searchCatalog(D, 'дигл блейз', 3), ['Desert Eagle | Blaze (Factory New)']);
  assert.equal((await post({ kind: 'catalog_tokens', fetchedAt: Date.parse('2026-11-16T12:00:00Z') / 1000, tokens: { 'Bad Key': ['x'] } }).then((r) => r.json()) as any).stored, 0, 'мусор отбрасывается');
  void ADMIN;
});
