// #13: поиск по-русски и сленгом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogLines, searchSmart } from '../src/catalog.ts';
import { translateQuery } from '../src/core/ruslang.ts';

const NAMES = ['AK-47 | Asiimov (Field-Tested)', 'AK-47 | Asiimov (Factory New)', 'StatTrak™ AK-47 | Redline (Field-Tested)', 'AK-47 | Redline (Field-Tested)',
  'AWP | Asiimov (Battle-Scarred)', '★ Karambit | Doppler (Factory New)', '★ Karambit | Fade (Factory New)', 'Revolution Case', 'Kilowatt Case',
  'M4A1-S | Hyper Beast (Minimal Wear)', 'Desert Eagle | Blaze (Factory New)', '★ Butterfly Knife | Crimson Web (Field-Tested)', 'Sticker | Natus Vincere | Paris 2023'];
const T = [catalogLines(NAMES)];
const s = (q: string) => searchSmart(T, q, 5);

test('перевод запроса', () => {
  assert.equal(translateQuery('Калаш азимов ФТ').query, 'ak 47 asiimov field tested');
  assert.equal(translateQuery('кейс революция').query, 'case revolution');
  assert.deepEqual(translateQuery('слон абракадабра').unknown, ['абракадабра']);
});

test('поиск: русский, сленг, сокращения износа', () => {
  assert.equal(s('калаш азимов фт')[0], 'AK-47 | Asiimov (Field-Tested)');
  assert.equal(s('ак-47 красная линия')[0], 'AK-47 | Redline (Field-Tested)');
  assert.equal(s('стат ак редлайн')[0], 'StatTrak™ AK-47 | Redline (Field-Tested)');
  assert.equal(s('слон азимов')[0], 'AWP | Asiimov (Battle-Scarred)');
  assert.equal(s('нож керамбит допплер')[0], '★ Karambit | Doppler (Factory New)');
  assert.equal(s('керамбит градиент')[0], '★ Karambit | Fade (Factory New)');
  assert.equal(s('кейс революция')[0], 'Revolution Case');
  assert.equal(s('эмка гипербист')[0], 'M4A1-S | Hyper Beast (Minimal Wear)');
  assert.equal(s('дигл')[0], 'Desert Eagle | Blaze (Factory New)');
  assert.equal(s('бабочка кровавая паутина')[0], '★ Butterfly Knife | Crimson Web (Field-Tested)');
  assert.equal(s('наклейка нави')[0], 'Sticker | Natus Vincere | Paris 2023');
  assert.equal(s('азимов фигня')[0]?.includes('Asiimov'), true, 'незнакомое слово — ищем без него');
  assert.equal(s('Kilowatt')[0], 'Kilowatt Case', 'английский — как раньше');
});
