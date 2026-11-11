// «Куда потратить баланс Steam»: только ликвидное, растущее, не разгон и по карману.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spendIdeas } from '../src/core/spend.ts';
import type { ScanEntry } from '../src/core/recs.ts';

const e = (o: Partial<ScanEntry> & { name: string }): ScanEntry => ({
  offers: [], s7: null, s30: null, sa: { d1: 110, d7: 108, d30: 100, d90: 100 },
  steam: { lowestKop: 1500, medianKop: 1500, volume24h: 80, at: 1 }, ...o,
});

test('показывает растущий ликвидный предмет по карману и считает безубыточную цену', () => {
  const r = spendIdeas([e({ name: 'Revolution Case' })], 3222);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.trendBp, 800);
  assert.ok(r[0]!.breakevenKop > r[0]!.priceKop, 'вернуть потраченное можно только дороже цены покупки');
});

test('дороже баланса, неликвидное, слабый рост, резкий рост и падение сегодня — не показывает', () => {
  const list = [
    e({ name: 'A Case', steam: { lowestKop: 5000, medianKop: 5000, volume24h: 80, at: 1 } }),
    e({ name: 'B Case', steam: { lowestKop: 1500, medianKop: 1500, volume24h: 5, at: 1 } }),
    e({ name: 'C Case', sa: { d1: 100, d7: 101, d30: 100, d90: 100 } }),
    e({ name: 'D Case', sa: { d1: 300, d7: 250, d30: 100, d90: 100 } }),
    e({ name: 'E Case', sa: { d1: 90, d7: 108, d30: 100, d90: 100 } }),
  ];
  assert.deepEqual(spendIdeas(list, 3222), []);
});
