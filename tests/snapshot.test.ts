// Суточный архив цен: строки, формат файла, запись в репозиторий данных (без сети — GitHub подменён).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { collectRows, buildTsv, gzipB64, putIfMissing, dayPath, COLUMNS } from '../.github/scripts/snapshot.mjs';

const steamAvg = new Map<string, any>([['A Case', { d1: 1.25, d7: 1.3, d30: 1.4, d90: null }], ['B | Skin (Field-Tested)', { d1: 0, d7: null, d30: 2, d90: 2.5 }]]);
const markets = { csgomarket: new Map([['A Case', { p: 0.542 }]]), waxpeer: new Map([['C Skin\twith tab', { p: 3 }]]), lisskins: new Map<string, any>() };

test('строки: центы USD, Skinport из евро по курсу, нулевые и пустые цены не пишем, предметы без цен не попадают', () => {
  const rows = collectRows({ steamAvg, sp: new Map([['A Case', 0.5]]), eurUsd: 1.1, markets, files: { buff163: { 'A Case': { starting_at: { price: 1.5 } }, 'Nope': {} } } });
  assert.deepEqual(rows.get('A Case'), { steam_24h: 125, steam_7d: 130, steam_30d: 140, skinport: 55, csgomarket: 54, buff163: 150 });
  assert.deepEqual(rows.get('B | Skin (Field-Tested)'), { steam_30d: 200, steam_90d: 250 }, 'нулевая цена и null не пишутся');
  assert.equal(rows.has('Nope'), false);
});

test('файл: заголовок, колонки, сортировка по названию, табы в названии не ломают формат, gzip читается обратно', () => {
  const rows = collectRows({ steamAvg, sp: new Map(), eurUsd: null, markets, files: {} });
  const tsv = buildTsv('2026-11-13', rows, { steam: 1 });
  const lines = gunzipSync(Buffer.from(gzipB64(tsv), 'base64')).toString().split('\n').filter(Boolean);
  assert.equal(lines[0], '#date\t2026-11-13'); assert.match(lines[1], /^#src_at\t/); assert.equal(lines[2], '#cols\tname\t' + COLUMNS.join('\t'));
  const names = lines.slice(3).map((l) => l.split('\t')[0]);
  assert.deepEqual(names, [...names].sort());
  for (const l of lines.slice(3)) assert.equal(l.split('\t').length, COLUMNS.length + 1, 'у каждой строки столько же колонок, сколько в шапке');
});

test('запись: нет файла — сохраняем, есть — не трогаем, ошибка GitHub — исключение (основной сбор не падает, лог громкий)', async () => {
  const calls: string[] = [];
  const mk = (getStatus: number, putOk = true) => (async (url: string, init?: any) => { calls.push((init?.method ?? 'GET') + ' ' + url.split('/contents/')[1]); return init?.method === 'PUT' ? new Response('{}', { status: putOk ? 201 : 403 }) : new Response('', { status: getStatus }); }) as any;
  assert.equal(await putIfMissing({ repo: 'o/r', token: 't', path: dayPath('2026-11-13'), contentB64: 'x', message: 'm', fetchImpl: mk(404) }), 'saved');
  assert.deepEqual(calls, ['GET daily/2026/11/2026-11-13.tsv.gz', 'PUT daily/2026/11/2026-11-13.tsv.gz']);
  assert.equal(await putIfMissing({ repo: 'o/r', token: 't', path: 'p', contentB64: 'x', message: 'm', fetchImpl: mk(200) }), 'exists');
  await assert.rejects(putIfMissing({ repo: 'o/r', token: 't', path: 'p', contentB64: 'x', message: 'm', fetchImpl: mk(404, false) }), /PUT 403/);
  await assert.rejects(putIfMissing({ repo: 'o/r', token: 't', path: 'p', contentB64: 'x', message: 'm', fetchImpl: mk(500) }), /GET 500/);
});
