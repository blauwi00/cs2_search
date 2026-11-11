// Оценка важности новости по правилам (без нейросети): багфиксы — низко, кейсы/торговля/операции — высоко, датамайн про предметы — высоко.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreNews, IMP_SKIP, IMP_MIN_EXTRA, IMP_TOP } from '../.github/scripts/newsscore.mjs';
import { IMP_SKIP as P_SKIP, IMP_MIN_EXTRA as P_MIN, IMP_TOP as P_TOP } from '../src/core/pipeline.ts';

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => `[*] ${f(i)}`).join('\n');

test('пороги в сборщике и в Worker совпадают', () => {
  assert.deepEqual([IMP_SKIP, IMP_MIN_EXTRA, IMP_TOP], [P_SKIP, P_MIN, P_TOP]);
});

test('Valve: только исправления — ниже порога; новое содержимое — заметно; новый кейс и торговля — на самом верху', () => {
  const bug = scoreNews({ source: 'valve', title: 'Counter-Strike 2 Update', text: '[ MISC ]\n' + lines(30, (i) => `Fixed a crash when loading map number ${i}`) });
  assert.ok(bug.imp < IMP_SKIP, `багфиксы: ${bug.imp}`);
  const chickens = scoreNews({ source: 'valve', title: 'Counter-Strike 2 Update', text: '[ GAMEPLAY ]\n' + lines(45, (i) => `Added new chicken animation and new feature number ${i} for the game`) });
  assert.ok(chickens.imp >= IMP_SKIP && chickens.imp < IMP_TOP, `крупное обновление: ${chickens.imp}`);
  const market = scoreNews({ source: 'valve', title: 'The new Case and Operation are here', text: '[ ITEMS ]\n[*] Added a new case with a new collection to the drop pool\n[*] Changed trade-up contract rules' });
  assert.ok(market.imp >= IMP_TOP, `кейс, коллекция, обмен: ${market.imp}`);
  assert.ok(market.why.length > 1, 'причины перечислены');
});

test('датамайн: предметы и выпадение — высоко, только тексты — ниже; Reddit и киберспорт — по рейтингу и теме', () => {
  const items = scoreNews({ source: 'datamine', title: 'x', files: ['game/csgo/items_game.txt'] });
  const text = scoreNews({ source: 'datamine', title: 'x', files: ['game/csgo/resource/csgo_english.txt'] });
  const noise = scoreNews({ source: 'datamine', title: 'x', files: ['game/csgo/pak01_dir.vpk'] });
  assert.ok(items.imp >= 50 && items.imp > text.imp && text.imp < IMP_MIN_EXTRA && noise.imp === 0);
  assert.ok(scoreNews({ source: 'reddit', title: 'Valve changes trade-up contracts', score: 6000, comments: 900 }).imp >= IMP_TOP);
  assert.ok(scoreNews({ source: 'reddit', title: 'My setup', score: 2500, comments: 300 }).imp < IMP_MIN_EXTRA, 'про железо — не публикуем');
  assert.ok(scoreNews({ source: 'esports', title: 'Major stickers capsule revealed' }).imp >= IMP_MIN_EXTRA);
  assert.ok(scoreNews({ source: 'esports', title: 'Major final preview' }).imp < IMP_TOP);
});
