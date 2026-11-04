import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, telegramRoute, fixture, fixtureJson, ADMIN } from './helpers.ts';
import { costOf, saleCost, realizedStats, parseDateInput, roiBucket, viewLot, valuation, walletFor } from '../src/core/portfolio.ts';
import * as T from '../src/storage/trades.ts';
import * as db from '../src/storage/db.ts';
import { handleWebhook } from '../src/telegram/webhook.ts';
import { chartUrl, handleChart, splitOnGaps, renderChart } from '../src/chart.ts';
import { asOf, backtest, outcomeAfter } from '../src/core/quality.ts';
import { steamSellerProceeds } from '../src/core/fees.ts';
import { runCycle } from '../src/core/runner.ts';
import { dealsView, toggleDealFilter } from '../src/telegram/menus.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000;
type Sent = { method: string; body: Record<string, unknown> };

// ---------- Этап 4: учёт ----------

test('себестоимость: комиссия покупки делится по штукам, частичные продажи в сумме дают полную стоимость', () => {
  const lot = { quantity: 3, buy_price_kop: 10000, buy_fee_kop: 100 };
  assert.equal(costOf(lot, 3), 30100);
  const parts = saleCost(lot, 0, 1) + saleCost(lot, 1, 1) + saleCost(lot, 2, 1);
  assert.equal(parts, 30100);
});

test('Steam Wallet и External Cash считаются раздельно; убыточные и прибыльные сделки', () => {
  const lots = [{ id: 1, quantity: 1, sold_quantity: 1, buy_price_kop: 1000, buy_fee_kop: 0, buy_date: '2026-11-01', created_at: 0, status: 'closed' },
    { id: 2, quantity: 1, sold_quantity: 1, buy_price_kop: 1000, buy_fee_kop: 0, buy_date: '2026-11-01', created_at: 0, status: 'closed' }];
  const st = realizedStats(lots, [
    { trade_id: 1, quantity: 1, received_kop: 1500, wallet: 'steam_wallet', sell_date: '2026-11-03', created_at: 1, costKop: 1000, buyDate: '2026-11-01' },
    { trade_id: 2, quantity: 1, received_kop: 800, wallet: 'external_cash', sell_date: '2026-11-04', created_at: 2, costKop: 1000, buyDate: '2026-11-01' },
  ]);
  assert.equal(st.realizedSteamKop, 500);
  assert.equal(st.realizedCashKop, -200);
  assert.equal(st.profitable, 1);
  assert.equal(st.losing, 1);
  assert.equal(st.avgHoldDays, 2.5);
  assert.equal(walletFor('steam'), 'steam_wallet');
  assert.equal(walletFor('skinport'), 'external_cash');
});

test('оценка инвентаря — по комиссии Steam, неизвестная цена остаётся неизвестной', () => {
  const lot = { id: 1, quantity: 2, sold_quantity: 0, buy_price_kop: 30000, buy_fee_kop: 0, buy_date: '2026-11-01', created_at: 0, status: 'open' };
  const v = viewLot(lot, valuation(65000, 64000, null));
  assert.equal(v.steamValueKop, steamSellerProceeds(64000)!.sellerReceives * 2);
  assert.equal(viewLot(lot, valuation(null, null, null)).steamValueKop, null);
  assert.equal(roiBucket(3100, 1500), 2);
  assert.equal(roiBucket(-1600, 1500), -1);
  assert.equal(roiBucket(1000, 1500), 0);
});

test('даты: ГГГГ-ММ-ДД, ДД.ММ.ГГГГ, «сегодня»; будущее и несуществующие даты отклоняются', () => {
  assert.equal(parseDateInput('2026-11-01', '2026-11-04'), '2026-11-01');
  assert.equal(parseDateInput('1.11.2026', '2026-11-04'), '2026-11-01');
  assert.equal(parseDateInput('сегодня', '2026-11-04'), '2026-11-04');
  assert.equal(parseDateInput('2026-11-05', '2026-11-04'), null);
  assert.equal(parseDateInput('2026-02-30', '2026-11-04'), null);
});

// 24. История сделок сохраняется
test('24: продажа записывается, перепродать больше, чем есть, нельзя, лот с продажами не удаляется', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'Revolution Case', NOW);
  const id = await T.addTrade(D, { tid: ADMIN, itemId: it.id, signalId: null, quantity: 3, buyPriceKop: 5000, buyFeeKop: 0, platform: 'skinport', buyDate: '2026-11-01', note: null, now: NOW });
  const r = await T.addSale(D, ADMIN, { tradeId: id, quantity: 2, sellPriceKop: 7000, receivedKop: 12174, platform: 'steam', sellDate: '2026-11-04', now: NOW });
  assert.equal(r.costKop, 10000);
  assert.equal(r.closed, false);
  await assert.rejects(T.addSale(D, ADMIN, { tradeId: id, quantity: 2, sellPriceKop: 7000, receivedKop: 1, platform: 'steam', sellDate: '2026-11-04', now: NOW }));
  assert.equal(await T.deleteTrade(D, ADMIN, id), false);
  const sales = await T.salesFor(D, ADMIN);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].wallet, 'steam_wallet');
  assert.equal(sales[0].fee_kop, 14000 - 12174);
  // чужой пользователь не видит и не продаёт чужие записи
  assert.equal(await T.getTrade(D, 999, id), null);
});

function hooks(env: ReturnType<typeof testEnv>) {
  const h = { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET };
  return {
    cb: (data: string) => new Request('https://bot.example.workers.dev/telegram', { method: 'POST', headers: h, body: JSON.stringify({ update_id: 1, callback_query: { id: 'c', from: { id: ADMIN }, data, message: { message_id: 5, chat: { id: ADMIN, type: 'private' } } } }) }),
    msg: (text: string) => new Request('https://bot.example.workers.dev/telegram', { method: 'POST', headers: h, body: JSON.stringify({ update_id: 2, message: { message_id: 6, from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text } }) }),
  };
}

test('Telegram: добавить покупку в инвентарь и записать продажу в Steam кнопками', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const sent: Sent[] = [];
  const { fetcher } = mockFetch([telegramRoute(sent), { match: (u) => u.includes('/market/search/render/'), respond: () => json(fixtureJson('steam_search.json')) }]);
  const { cb, msg } = hooks(env);
  const run = async (r: Request) => { const res = await handleWebhook(r, env, NOW, fetcher); assert.equal(res.status, 200); };
  await run(cb('ia'));
  await run(msg('redline'));
  await run(cb('ip:0'));
  await run(cb('iq:1'));
  await run(msg('400'));
  await run(cb('ipl:skinport'));
  await run(cb('ifee0'));
  await run(cb('idt'));
  const lots = await T.openTrades(d as unknown as D1Database, ADMIN);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].market_hash_name, 'AK-47 | Redline (Field-Tested)');
  assert.equal(lots[0].buy_price_kop, 40000);
  assert.equal(lots[0].buy_date, '2026-11-04');
  const w = d.db.prepare("SELECT source, priority FROM watchlist").get() as { source: string; priority: number };
  assert.deepEqual({ ...w }, { source: 'inventory', priority: 2 }, 'предмет из инвентаря попадает в мониторинг с повышенным приоритетом');

  await run(cb(`sl:${lots[0].id}`));
  await run(cb('spl:steam'));
  await run(msg('650'));
  await run(cb('srv'));
  await run(cb('sdt'));
  const sales = await T.salesFor(d as unknown as D1Database, ADMIN);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].received_kop, steamSellerProceeds(65000)!.sellerReceives);
  assert.equal(sales[0].wallet, 'steam_wallet');
  const last = String(sent.filter((s) => s.method === 'sendMessage').at(-1)!.body.text);
  assert.ok(last.includes('Steam Wallet (вывести нельзя)'));
  assert.ok(last.includes(`Результат: <b>+`));
  assert.equal((await T.openTrades(d as unknown as D1Database, ADMIN)).length, 0);

  // История сделок показывает раздельный учёт
  await run(cb('m:trades'));
  const hist = sent.filter((s) => s.method === 'editMessageText').at(-1)!;
  assert.ok(String(hist.body.text).includes('Steam Wallet'));
  assert.ok(String(hist.body.text).includes('External Cash'));
});

test('«Купил» из сигнала подставляет предмет, площадку и цену; открытие ссылки покупкой не считается', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'AK-47 | Redline (Field-Tested)', NOW);
  const sig = await db.upsertSignal(D, { dedupKey: 'k', kind: 'arbitrage_steam', itemId: it.id, state: 'notified', priority: 'high', category: 'verified_spread', buySource: 'skinport', sellSource: 'steam', buyKop: 38250, sellKop: 64999, proceedsKop: 56530, spreadKop: 18280, roiBp: 4779, reason: '', snapshot: {}, now: NOW });
  assert.equal((await T.openTrades(D, ADMIN)).length, 0, 'сигнал сам по себе — не покупка');
  const sent: Sent[] = [];
  const { fetcher } = mockFetch([telegramRoute(sent)]);
  const { cb } = hooks(env);
  for (const c of [`bs:${sig.id}`, 'iq:1', 'ipr', 'ifee0', 'idt']) await handleWebhook(cb(c), env, NOW, fetcher);
  const lots = await T.openTrades(D, ADMIN);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].buy_price_kop, 38250);
  assert.equal(lots[0].buy_platform, 'skinport');
  assert.equal(lots[0].signal_id, sig.id);
});

test('уведомление по инвентарю: подорожание присылается один раз на каждый порог', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'Revolution Case', NOW);
  await T.addTrade(D, { tid: ADMIN, itemId: it.id, signalId: null, quantity: 1, buyPriceKop: 3000, buyFeeKop: 0, platform: 'steam', buyDate: '2026-11-01', note: null, now: NOW });
  await T.addWatchFromInventory(D, ADMIN, it.id, NOW);
  const sent: Sent[] = [];
  let price = '40,00₴';
  const { fetcher } = mockFetch([
    telegramRoute(sent),
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
    { match: (u) => u.includes('/market/priceoverview/'), respond: () => json({ success: true, lowest_price: price, median_price: price, volume: '500' }) },
    { match: (u) => u.includes('api.skinport.com'), respond: () => new Response('[]') },
  ]);
  await runCycle(env, { now: NOW, fetcher });
  const n1 = sent.filter((s) => String(s.body.text ?? '').includes('ИНВЕНТАРЬ: ПОДОРОЖАЛ')).length;
  assert.equal(n1, 1);
  price = '40,50₴';
  await d.db.exec(`UPDATE scheduler_jobs SET next_run_at = 0 WHERE name = 'steam'`);
  await runCycle(env, { now: NOW + 600, fetcher });
  assert.equal(sent.filter((s) => String(s.body.text ?? '').includes('ИНВЕНТАРЬ: ПОДОРОЖАЛ')).length, 1, 'тот же порог — без повтора');
});

// ---------- Этап 3: графики, кейсы, фильтры ----------

test('график: подписанная ссылка, отказ без подписи, честная пометка о нехватке данных', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'Revolution Case', NOW);
  const url = await chartUrl('https://bot.example.workers.dev', env.ADMIN_KEY, it.id, 30);
  assert.ok(url.startsWith('https://bot.example.workers.dev/chart?i='));
  assert.equal((await handleChart(new Request(url.replace(/s=[0-9a-f]+/, 's=00')), env, NOW)).status, 403);
  assert.equal((await handleChart(new Request(url.replace('d=30', 'd=31')), env, NOW)).status, 400);
  await D.prepare(`INSERT INTO price_snapshots (item_id, source, price_type, price_minor, currency, price_kop, observed_at, quality) VALUES (?, 'steam', 'lowest_listing', 4000, 'UAH', 4000, ?, 'ok'), (?, 'steam', 'lowest_listing', 4200, 'UAH', 4200, ?, 'ok')`)
    .bind(it.id, NOW - 2 * 86400, it.id, NOW - 86400).run();
  const res = await handleChart(new Request(url), env, NOW);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Revolution Case'));
  assert.ok(html.includes('<polyline') || html.includes('<circle'));
  assert.ok(html.includes('из запрошенных 30'), 'двухдневная история не выдаётся за месячную');
});

test('график: пропуски данных не дорисовываются', () => {
  const segs = splitOnGaps([{ t: 0, v: 1 }, { t: 100, v: 2 }, { t: 100000, v: 3 }, { t: 100100, v: null }, { t: 100200, v: 5 }], 3600);
  assert.equal(segs.length, 3);
  assert.ok(renderChart('X', [], 0, 100, 7).includes('Данных пока мало'));
});

test('фильтры сделок: площадка и категория переключаются и применяются', async () => {
  const d = migratedDb();
  const D = d as unknown as D1Database;
  const a = await db.upsertItem(D, 'Revolution Case', NOW);
  const b = await db.upsertItem(D, 'AK-47 | Redline (Field-Tested)', NOW);
  for (const [it, src] of [[a, 'skinport'], [b, 'csfloat']] as const) {
    await db.upsertSignal(D, { dedupKey: `k${it.id}`, kind: 'arbitrage_steam', itemId: it.id, state: 'confirmed', priority: 'high', category: 'verified_spread', buySource: src, sellSource: 'steam', buyKop: 1000, sellKop: 2000, proceedsKop: 1700, spreadKop: 700, roiBp: 7000, reason: '', snapshot: { liquidity: { cls: 'high' } }, now: NOW });
  }
  assert.ok((await dealsView(D, NOW, 'spread', ADMIN)).text.includes('Revolution Case'));
  await toggleDealFilter(D, ADMIN, 'src', NOW); // → skinport
  let v = await dealsView(D, NOW, 'spread', ADMIN);
  assert.ok(v.text.includes('Revolution Case') && !v.text.includes('Redline'));
  await toggleDealFilter(D, ADMIN, 'cat', NOW); // → case
  v = await dealsView(D, NOW, 'spread', ADMIN);
  assert.ok(v.text.includes('Revolution Case'));
  await toggleDealFilter(D, ADMIN, 'cat', NOW); // → capsule
  v = await dealsView(D, NOW, 'spread', ADMIN);
  assert.ok(!v.text.includes('Revolution Case'));
});

// ---------- Этап 5: качество и backtesting ----------

test('backtesting: в момент решения не используются будущие данные', () => {
  const series = [{ t: 0, v: 100 }, { t: 1000, v: 999999 }];
  assert.equal(asOf(series, 500, 10000), 100);
  assert.equal(asOf(series, 1000, 10000), 999999);
  assert.equal(asOf(series, 5000, 100), null, 'слишком старое значение не используется');
  // До t=10000 Steam дешёвый — сделки нет. В будущем Steam дорожает, но решения в прошлом это не меняет.
  const buy = [{ t: 0, v: 50000 }, { t: 20000, v: 50000 }];
  const low = [{ t: 0, v: 52000 }, { t: 20000, v: 90000 }];
  const med = [{ t: 0, v: 52000 }, { t: 20000, v: 90000 }];
  const r = backtest(buy, low, med, { minProfitKop: 1000, minRoiBp: 500, horizonSec: 86400, maxAgeSec: 30000, cooldownSec: 3600 });
  assert.equal(r.signals, 1, 'сигнал только в момент t=20000, когда цена уже известна');
});

test('итог сигнала через 24 ч: выгода сохранилась / стала убытком / нет данных', () => {
  const cost = 40000;
  assert.equal(outcomeAfter(cost, [{ t: 86400, v: 65000 }], [{ t: 86400, v: 65000 }], 0, 86400).outcome, 'held');
  assert.equal(outcomeAfter(cost, [{ t: 86400, v: 42000 }], [{ t: 86400, v: 42000 }], 0, 86400).outcome, 'reversed');
  assert.equal(outcomeAfter(cost, [], [], 0, 86400).outcome, 'no_data');
});

test('задача quality записывает проверку сигналов через сутки', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, 'Revolution Case', NOW);
  const sig = await db.upsertSignal(D, { dedupKey: 'q', kind: 'arbitrage_steam', itemId: it.id, state: 'notified', priority: 'high', category: 'verified_spread', buySource: 'skinport', sellSource: 'steam', buyKop: 4000, sellKop: 6000, proceedsKop: 5200, spreadKop: 1200, roiBp: 3000, reason: '', snapshot: {}, now: NOW - 30 * 3600 });
  await D.prepare(`INSERT INTO price_snapshots (item_id, source, price_type, price_minor, currency, price_kop, observed_at, quality) VALUES (?, 'steam', 'lowest_listing', 6500, 'UAH', 6500, ?, 'ok'), (?, 'steam', 'median_24h', 6400, 'UAH', 6400, ?, 'ok')`)
    .bind(it.id, NOW - 7 * 3600, it.id, NOW - 7 * 3600).run();
  await d.db.exec(`INSERT INTO scheduler_jobs (name, interval_sec, next_run_at) VALUES ('quality', 1800, 0)`);
  const { fetcher } = mockFetch([telegramRoute([])]);
  await runCycle(env, { now: NOW, fetcher, force: ['quality'] });
  const q = d.db.prepare('SELECT outcome, spread_later_kop FROM signal_quality WHERE signal_id = ?').get(sig.id) as { outcome: string; spread_later_kop: number };
  assert.equal(q.outcome, 'held');
  assert.ok(q.spread_later_kop > 0);
});

test('лимиты вызова соблюдаются и с инвентарём', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const D = d as unknown as D1Database;
  for (let i = 0; i < 60; i++) {
    const it = await db.upsertItem(D, `Item ${i} | S (Field-Tested)`, NOW);
    await db.addWatch(D, ADMIN, it.id, NOW);
    if (i % 3 === 0) await T.addTrade(D, { tid: ADMIN, itemId: it.id, signalId: null, quantity: 1, buyPriceKop: 30000, buyFeeKop: 0, platform: 'steam', buyDate: '2026-11-01', note: null, now: NOW });
  }
  const sent: Sent[] = [];
  const { fetcher, calls } = mockFetch([
    telegramRoute(sent),
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
    { match: (u) => u.includes('/market/priceoverview/'), respond: () => json(fixtureJson('steam_priceoverview_uah.json')) },
    { match: (u) => u.includes('/v1/items'), respond: () => new Response(fixture('skinport_items.json')) },
    { match: (u) => u.includes('/v1/sales/history'), respond: () => json(fixtureJson('skinport_sales.json')) },
  ]);
  for (let i = 0; i < 6; i++) {
    const b = d.execs, c = calls.length;
    const r = await runCycle(env, { now: NOW + i * 60, fetcher });
    assert.deepEqual(r.errors, []);
    assert.ok(d.execs - b <= 50, `D1: ${d.execs - b}`);
    assert.ok(calls.length - c <= 50);
  }
});
