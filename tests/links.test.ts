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

test('#5: объявление «держится», только если цена в прошлом сканировании была та же (±3%)', async () => {
  const { mergeScan, parseScan } = await import('../src/core/recs.ts');
  const T = 1_000_000;
  const s1 = mergeScan(parseScan([{ name: 'A', offers: { skinport: { p: 10 }, waxpeer: { p: 5 } } }], T), [], T, T, null);
  assert.equal(s1[0].offers[0].since, T);
  const s2 = mergeScan(parseScan([{ name: 'A', offers: { skinport: { p: 10.2 }, waxpeer: { p: 4 } } }], T + 600), s1, T + 600, T + 600, T);
  assert.equal(s2[0].offers.find((o) => o.m === 'skinport')!.since, T, '+2% — та же цена держится');
  assert.equal(s2[0].offers.find((o) => o.m === 'waxpeer')!.since, T + 600, '−20% — новое объявление');
  const s3 = mergeScan(parseScan([{ name: 'A', offers: { skinport: { p: 10.2 } } }], T + 1200), s2, T + 1200, T + 1200, T + 600);
  assert.equal(s3[0].offers[0].since, T);
  assert.equal(s3[0].at, T + 1200);
});

test('#6: честная статистика — плюс/минус через сутки, «нет данных» не входит в процент', async () => {
  const { migratedDb } = await import('./helpers.ts');
  const { recStats } = await import('../src/core/insights.ts');
  const d = migratedDb(); const D = d as unknown as D1Database;
  const T = Date.parse('2026-11-04T12:00:00Z') / 1000;
  const ins = (name: string, profit: number, p24: number | null, outcome: string | null, at: number) => d.db.prepare(
    `INSERT INTO idea_log (day, name, buy_at, sell_at, pay_kop, sell_kop, get_kop, profit_kop, roi_bp, wallet, created_at, checked_at, profit_kop_24, outcome)
     VALUES ('2026-11-03', ?, 'skinport', 'csgomarket', 1000, 1300, 1200, ?, 2000, 'cash', ?, ?, ?, ?)`).run(name, profit, at, outcome ? at + 86400 : null, p24, outcome);
  ins('A', 200, 150, 'plus', T - 3 * 86400); ins('B', 300, -50, 'minus', T - 2 * 86400); ins('C', 100, 20, 'plus', T - 2 * 86400);
  ins('D', 100, null, 'gone', T - 2 * 86400); ins('E', 100, null, null, T - 3600); ins('Old', 100, 100, 'plus', T - 40 * 86400);
  const s = await recStats(D, T, 30);
  assert.deepEqual([s.total, s.plus, s.minus, s.gone, s.pending], [5, 2, 1, 1, 1]);
  assert.equal(s.avgPromisedKop, 200); assert.equal(s.avgActualKop, 40);
  assert.equal(s.recent[0].name, 'E'); assert.equal(s.recent[0].sellAt, 'Market.CSGO');
});

test('картинки для «Поделиться»: только CDN Steam, с заголовком CORS', async () => {
  const { handleImgProxy } = await import('../src/imgproxy.ts');
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const ok = 'https://community.akamai.steamstatic.com/economy/image/abcDEF-12_x/360fx360f';
  let asked = '';
  const f = (async (u: string) => { asked = u; return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }); }) as unknown as typeof fetch;
  const r = await handleImgProxy(new URL('https://w/img?u=' + encodeURIComponent(ok)), ctx, f);
  assert.equal(r.status, 200); assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*'); assert.equal(asked, ok);
  for (const bad of ['https://evil.example/x.png', 'https://raw.githubusercontent.com/a/b.png', 'https://community.akamai.steamstatic.com/../x']) {
    assert.equal((await handleImgProxy(new URL('https://w/img?u=' + encodeURIComponent(bad)), ctx, f)).status, 400, bad);
  }
});

test('#14: калькулятор комиссий — продажа и обратный расчёт сходятся', async () => {
  const { calcFees } = await import('../src/core/calc.ts');
  const sell = calcFees(10000, 'sell', 0);
  const steam = sell.find((x) => x.key === 'steam')!;
  assert.equal(steam.getKop, 8697, 'Steam: из 100 грн придёт 86,97 (8697 + 434 + 869 = 10000)');
  assert.equal(sell.find((x) => x.key === 'csfloat')!.getKop, 9800);
  assert.equal(sell[0].getKop >= sell[sell.length - 1].getKop, true);
  const get = calcFees(9800, 'get', 0);
  assert.equal(get.find((x) => x.key === 'csfloat')!.listKop, 10000);
  assert.equal(calcFees(10000, 'sell', 300).find((x) => x.key === 'csfloat')!.getKop, 9506, '2% площадки + 3% вывода');
  const back = calcFees(steam.getKop, 'get', 0).find((x) => x.key === 'steam')!;
  assert.ok(back.listKop <= 10000 && back.listKop >= 9999);
});
