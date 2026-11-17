import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefs, refsLinks, refsWarning, DEFAULT_REFS_TEXT } from '../src/core/refs.ts';

test('parseRefs: только https, чистит названия и промокоды', () => {
  const c = parseRefs({ links: [
    { name: 'Сайт <b>А</b>', url: 'https://example.com/ref', promo: 'ab c<1>' },
    { name: 'Плохой', url: 'http://evil.example' },
    { name: '', url: 'https://x.example/y' },
    { name: 'Без промо', url: 'https://example.org/z' },
  ], daily: true });
  assert.equal(c.links.length, 2);
  assert.equal(c.links[0]!.name, 'Сайт bА/b');
  assert.equal(c.links[0]!.promo, 'abc1');
  assert.equal(c.links[1]!.promo, null);
  assert.equal(c.daily, true);
  assert.equal(c.text, DEFAULT_REFS_TEXT);
});
test('тексты: предупреждение без ссылок, ссылки — с названием и промокодом', () => {
  const c = parseRefs({ links: [{ name: 'А', url: 'https://a.example/r', promo: 'CODE' }, { name: 'Б', url: 'https://b.example/r' }] });
  assert.ok(!refsWarning(c).includes('https://'));
  const t = refsLinks(c);
  assert.ok(t.includes('https://a.example/r') && t.includes('<code>CODE</code>') && t.includes('https://b.example/r'));
  assert.ok(t.indexOf('https://a.example/r') < t.indexOf('https://b.example/r'));
});
