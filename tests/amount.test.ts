// Ввод сумм в приложении: разделители тысяч и дробной части (функция parseAmt из app.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/webapp/app.html', import.meta.url), 'utf8');
const src = /function parseAmt\(v\) \{[\s\S]*?\n\}/.exec(html)![0];
const parseAmt = new Function(src + '; return parseAmt;')() as (v: unknown) => number | null;

test('суммы: «1.200», «1 234,56», «1.234,56», «1,234.56» читаются правильно', () => {
  const cases: [string, number | null][] = [
    ['1.200', 1200], ['1,200', 1200], ['1 234,56', 1234.56], ['1 234', 1234], ['1.234,56', 1234.56], ['1,234.56', 1234.56],
    ['12 345 678,9', 12345678.9], ['12,5', 12.5], ['12.50', 12.5], ['120', 120], ['0,99', 0.99], ['12,', 12], ['1 200 ₴', 1200], ['', null],
  ];
  for (const [v, want] of cases) assert.equal(parseAmt(v), want, v);
  assert.ok(Number.isNaN(parseAmt(',')));
});
