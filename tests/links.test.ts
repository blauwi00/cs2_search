// #4: ссылки «Купить» ведут на страницу предмета там, где адрес известен точно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { itemUrl, lisSkinsSlug } from '../src/core/recs.ts';

test('LIS-SKINS: страница для обычного скина, поиск для остального', () => {
  assert.equal(lisSkinsSlug('AK-47 | Redline (Field-Tested)'), 'ak-47-redline-field-tested');
  assert.equal(itemUrl('lisskins', 'AK-47 | Redline (Field-Tested)'), 'https://lis-skins.com/market/csgo/ak-47-redline-field-tested/');
  assert.equal(lisSkinsSlug('M4A1-S | Hot Rod (Factory New)'), 'm4a1-s-hot-rod-factory-new');
  for (const n of ['StatTrak™ AK-47 | Redline (Field-Tested)', '★ Karambit | Doppler (Factory New)', 'Revolution Case', 'Sticker | Natus Vincere | Paris 2023', 'Souvenir AWP | Dragon Lore (Factory New)']) {
    assert.equal(lisSkinsSlug(n), null, n);
    assert.match(itemUrl('lisskins', n), /\?query=/);
  }
});

test('Skinport: адрес из API, если он есть; иначе поиск; чужой адрес не принимается', () => {
  const pages = new Map([['AK-47 | Redline (Field-Tested)', 'https://skinport.com/item/ak-47-redline-field-tested'], ['Bad', 'https://evil.example/x']]);
  assert.equal(itemUrl('skinport', 'AK-47 | Redline (Field-Tested)', pages), 'https://skinport.com/item/ak-47-redline-field-tested');
  assert.match(itemUrl('skinport', 'Bad', pages), /^https:\/\/skinport\.com\/market\?search=/);
  assert.match(itemUrl('skinport', 'Revolution Case'), /^https:\/\/skinport\.com\/market\?search=/);
  assert.match(itemUrl('steam', 'Revolution Case'), /^https:\/\/steamcommunity\.com\/market\/listings\/730\/Revolution%20Case$/);
});
