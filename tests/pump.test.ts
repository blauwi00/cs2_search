// Детектор вбросов и разгонов: правила, идеи без разогнанных предметов, сообщение держателю.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpCheck } from '../src/core/pump.ts';
import { scanPump } from '../src/core/recs.ts';
import { migratedDb } from './helpers.ts';
import * as db from '../src/storage/db.ts';
import { jobPumpAlerts } from '../src/core/pumpalert.ts';
import { TERMS_VERSION } from '../src/core/terms.ts';

test('разгон: рост + признак искусственности; спокойный рост с большим спросом — не разгон', () => {
  assert.equal(pumpCheck({ d1: 110, d30: 100, vol24: 3 }), null, '+10% — не повод');
  const thin = pumpCheck({ d1: 150, d30: 100, vol24: 4 })!;
  assert.equal(thin.riseBp, 5000);
  assert.match(thin.reasons[0], /мало продаж: 4 за сутки/);
  assert.equal(pumpCheck({ d1: 150, d30: 100, vol24: 800 }), null, 'рост на большом спросе — похоже на настоящий');
  assert.ok(pumpCheck({ d1: 150, d30: 100, vol24: 800, s7: 100, s30: 100 })!.reasons.some((x) => /на Skinport — нет/.test(x)));
  assert.ok(pumpCheck({ d1: 150, d30: 100, vol24: 800, siteNow: 80 })!.reasons.some((x) => /на других площадках/.test(x)));
  assert.ok(pumpCheck({ d1: 250, d30: 100, vol24: 120 })!.reasons.some((x) => /в 2,5 раза/.test(x)));
  assert.equal(pumpCheck({ d1: 250, d30: 100, vol24: 500 }), null, 'вдвое, но продаж очень много — не помечаем');
  assert.ok(pumpCheck({ s7: 140, s30: 100, sales7: 5 }), 'по данным Skinport тоже');
  assert.ok(pumpCheck({ d1: 140, d30: 100, vol24: 500, listing: 100, buyOrder: 50 })!.reasons.some((x) => /ордер на 50% ниже/.test(x)));
});

test('идеи: разогнанный предмет не попадает (в т. ч. в «Растёт»)', () => {
  const base = { name: 'X', offers: [{ m: 'skinport' as const, cur: 'EUR' as const, minor: 100, qty: 3 }], s7: { median: 160, volume: 30 }, s30: { median: 100, volume: 90 }, steam: null };
  assert.ok(scanPump(base), '+60% и 3 объявления');
  assert.equal(scanPump({ ...base, offers: [{ ...base.offers[0], qty: 40 }] }), null, 'рост с большим числом продавцов и продаж');
});

test('держателю: «Похоже на разгон» — один раз в неделю', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const NOW = Date.parse('2026-11-08T12:00:00Z') / 1000;
  const it = await db.upsertItem(D, 'Sticker | Pumped', NOW);
  await db.ensureUser(D, 5, false, NOW);
  for (const [k, v] of [['terms_ok', TERMS_VERSION], ['notify_enabled', '1']]) await db.setSetting(D, 5, k, v, NOW);
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-08', source: 'nbu' }], NOW);
  d.db.prepare('INSERT INTO steam_inventory (telegram_id, item_id, qty) VALUES (5, ?, 1)').run(it.id);
  d.db.prepare('INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (?, 300, 200, 100, 100, ?)').run(it.id, NOW - 600);
  assert.equal((await jobPumpAlerts({ db: D, now: NOW })).sent, 1);
  assert.equal((await jobPumpAlerts({ db: D, now: NOW + 3600 })).sent, 0, 'повтор в ту же неделю не шлём');
  const m = d.db.prepare(`SELECT text FROM outbox WHERE kind = 'pump_alert'`).get() as { text: string };
  assert.match(m.text, /Похоже на разгон цены/);
  assert.match(m.text, /на 200% выше/);
  assert.match(m.text, /в 3 раза за месяц/);
});

test('обновления CS2: подсказка, что изменение обычно значит для цен', async () => {
  const { marketImpact } = await import('../.github/scripts/patchnotes.mjs');
  const { newsRuLines } = await import('../src/core/insights.ts');
  const hints = marketImpact('[list][*]The Kilowatt Case has been removed from the active drop pool.[*]Fixed smoke bug[/list]') as string[];
  assert.equal(hints.length, 1);
  assert.match(hints[0], /уходят из выпадения/);
  assert.deepEqual(marketImpact('Fixed a bug with smoke grenades'), []);
  const lines = newsRuLines({ summary_ru: JSON.stringify({ market: ['Кейс убран'], sections: [], more: 0, impact: hints }) } as never)!;
  assert.ok(lines.includes('📈 <b>Что это обычно значит для цен</b>'));
});
