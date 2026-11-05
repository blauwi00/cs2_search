// «Разгон баланса»: расчёты, лимиты, риск, симуляция, цепочка B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, findCandidates, capital, buyBlockers, simSale, checkChain, RALLY_DEFAULTS, NO_DEALS_TEXT, UNLOCK_SEC, type RallyEntry, type RallyTrade } from '../src/core/rally.ts';
import { steamNetKop } from '../src/core/fees.ts';

const NOW = 1_793_800_000;
const S = { ...RALLY_DEFAULTS };
const entry = (o: Partial<RallyEntry> = {}, steam: Partial<NonNullable<RallyEntry['steam']>> = {}): RallyEntry => ({
  name: 'Revolution Case', img: null, cur: 'UAH',
  sa: { d1: 700, d7: 705, d30: 710, d90: 700 },
  steam: { lowest: 450, median: 700, volume: 900, at: NOW - 600, ...steam },
  orders: null, ...o,
});
const trade = (o: Partial<RallyTrade>): RallyTrade => ({ id: 1, mode: 'sim', name: 'X', img: null, qty: 1, buy_kop: 450, bought_at: NOW - 8 * 86400, unlock_at: NOW - 86400,
  target_kop: 699, predicted_net_kop: 609, risk: 'low', status: 'open', sold_qty: 0, sold_price_kop: null, sold_net_kop: null, sold_at: null, parent_id: null, ...o });

test('1. прибыль считается по точной комиссии Steam с округлением, не «× 0,85»', () => {
  const c = evaluate(entry(), S, NOW).c!;
  assert.equal(c.targetKop, 699);                 // min(медиана 700, 7д 705, 30д 710) − 1 коп.
  assert.equal(c.netKop, steamNetKop(699));       // 609 (а не 594 = 699 × 0,85)
  assert.equal(c.netKop, 609);
  assert.equal(c.profitKop, 159); assert.equal(c.roiBp, 3533);
  assert.equal(c.risk, 'low', c.riskWhy.join('; '));
  assert.equal(c.unlockAt, NOW + UNLOCK_SEC);
});

test('2–4. отказ: не хватает денег, нарушен резерв 18 ₴, больше двух позиций, дороже лимита', () => {
  const capOf = (trades: RallyTrade[], start = 3000) => capital(trades, { ...S, simStartKop: start }, 'sim', NOW);
  assert.deepEqual(buyBlockers(capOf([]), S, 450), [], 'с 30 ₴ покупка 4,50 ₴ разрешена');
  assert.match(buyBlockers(capOf([], 1500), S, 450).join(), /Не хватает|резерва/);
  assert.match(buyBlockers(capOf([], 2200), S, 450).join(), /меньше резерва/, '22 − 4,5 = 17,5 < 18');
  assert.match(buyBlockers(capOf([]), S, 650).join(), /больше лимита/);
  const two = [trade({ id: 1, unlock_at: NOW + 86400 }), trade({ id: 2, unlock_at: NOW + 86400 })];
  assert.match(buyBlockers(capOf(two), S, 300).join(), /2 из 2 позиций/);
});

test('5. учёт блокировки: до разблокировки симуляция не продаёт; капитал считает заблокированное', () => {
  const t = trade({ unlock_at: NOW + 3 * 86400 });
  assert.equal(simSale(t, entry(), NOW), null);
  const cap = capital([t], S, 'sim', NOW);
  assert.equal(cap.lockedCount, 1); assert.equal(cap.balanceKop, 2550); assert.equal(cap.inItemsKop, 450);
  assert.equal(cap.expectedProfitKop, 159); assert.equal(cap.realizedKop, 0, 'ожидаемая прибыль — не заработанная');
});

test('6. устаревшие цены отклоняются', () => {
  const r = evaluate(entry({}, { at: NOW - 4 * 3600 }), S, NOW);
  assert.equal(r.c, null); assert.equal(r.reject, 'нет свежей цены Steam');
});

test('7. нет ложной прибыли: разница двух объявлений без истории продаж — не сделка; маленькая разница — не проходит порог', () => {
  assert.equal(evaluate(entry({ sa: null }), S, NOW).c, null);
  assert.equal(evaluate(entry({}, { lowest: 590 }), S, NOW).reject, 'прибыль после комиссии ниже порога'); // 609 − 590 = 19 коп.
  assert.equal(evaluate(entry({}, { lowest: 520 }), S, NOW).reject, 'прибыль после комиссии ниже порога'); // +89 коп. < 1 ₴
});

test('8. валюты: котировки в другой валюте не смешиваются; минимальная комиссия зависит от валюты', () => {
  assert.match(evaluate(entry({ cur: 'USD' }), S, NOW).reject!, /кошел/);
  assert.notEqual(steamNetKop(125, { per: 41.5 }), steamNetKop(125));
});

test('риск: падающий рынок, скачок, низкая ликвидность — не «низкий»; без объёма — «недостаточно данных»', () => {
  assert.equal(evaluate(entry({ sa: { d1: 600, d7: 705, d30: 710, d90: 700 } }), S, NOW).c?.risk, 'high', 'за сутки −15% к неделе — падающий рынок');
  assert.equal(evaluate(entry({ sa: { d1: 860, d7: 705, d30: 710, d90: 700 } }), S, NOW).c?.risk, 'high');
  assert.equal(evaluate(entry({}, { volume: 50 }), S, NOW).c?.risk, 'medium');
  assert.equal(evaluate(entry({}, { volume: 10 }), S, NOW).c?.risk, 'high');
  assert.equal(evaluate(entry({}, { volume: null }), S, NOW).reject, 'недостаточно данных для оценки риска');
  assert.equal(evaluate(entry({ name: '★ Karambit | Doppler (Factory New)' }), S, NOW).c, null);
});

test('9. симуляция: продажа после разблокировки по фактической цене, с комиссией', () => {
  const t = trade({ unlock_at: NOW - 3600 });
  assert.equal(simSale(t, entry({}, { at: NOW - 2 * 3600 }), NOW), null, 'данные старше разблокировки не используем');
  const r = simSale(t, entry({}, { lowest: 690, median: 680, at: NOW - 60 }), NOW)!;
  assert.equal(r.priceKop, 680); assert.equal(r.netKop, steamNetKop(680));
  assert.equal(simSale(t, entry({}, { volume: 0, at: NOW - 60 }), NOW), null, 'нет продаж — не продали бы');
  const cap = capital([trade({ status: 'sold', sold_price_kop: 680, sold_net_kop: r.netKop, sold_qty: 1 })], S, 'sim', NOW);
  assert.equal(cap.realizedKop, r.netKop - 450); assert.equal(cap.feesKop, 680 - r.netKop); assert.equal(cap.balanceKop, 3000 - 450 + r.netKop);
});

test('10. нет подходящих — честное сообщение, без выдуманных кандидатов', () => {
  const r = findCandidates([entry({}, { lowest: 690 }), entry({ name: 'B', sa: null })], S, NOW);
  assert.equal(r.list.length, 0); assert.equal(r.message, NO_DEALS_TEXT);
  const ok = findCandidates([entry(), entry({ name: 'Fever Case' }, { volume: 50 })], S, NOW);
  assert.deepEqual(ok.list.map((c) => c.name), ['Revolution Case']); assert.equal(ok.hidden, 1, 'средний риск скрыт в режиме «минимальный риск»');
  assert.ok(findCandidates(Array.from({ length: 9 }, (_, i) => entry({ name: 'C' + i })), S, NOW).list.length <= 5);
});

test('11. цепочка Steam → площадка → Steam: без доп. денег или подтверждённых цен — невыполнима', () => {
  const base = { freeKop: 1200, steamBuyKop: 600, siteSellNetKop: 560, siteMinWithdrawKop: null, backItemCostKop: 550, backItemSteamTargetKop: 800, confirmed: true };
  const ok = checkChain(base);
  assert.equal(ok.feasible, true); assert.equal(ok.profitKop, steamNetKop(800)! - 600); assert.ok(ok.days >= 14);
  assert.equal(checkChain({ ...base, steamBuyKop: 1300 }).feasible, false);
  assert.match(checkChain({ ...base, backItemCostKop: 700 }).reasons.join(), /доплата/);
  assert.match(checkChain({ ...base, siteMinWithdrawKop: 1000 }).reasons.join(), /минимальной/);
  assert.equal(checkChain({ ...base, siteSellNetKop: null }).feasible, false);
  assert.equal(checkChain({ ...base, backItemSteamTargetKop: 650 }).feasible, false, '650 → придёт 566 < 600');
});

test('разгон: сборщик → кандидаты в приложении → покупка с лимитами → частичная продажа → симуляция закрывается по факту → уведомления', async () => {
  const { migratedDb, testEnv } = await import('./helpers.ts');
  const { handleIngest } = await import('../src/ingest.ts');
  const { handleAppApi } = await import('../src/webapp/api.ts');
  const { signInitData } = await import('../src/webapp/auth.ts');
  const db = await import('../src/storage/db.ts');
  const d = migratedDb(); const D = d as unknown as D1Database;
  const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
  await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
  const init = await signInitData({ auth_date: String(NOW), query_id: 'A', user: JSON.stringify({ id: 77, first_name: 'E' }) }, 'TEST_TOKEN');
  const api = async (path: string, body?: object, at = NOW) => (await handleAppApi(new Request('https://w/app/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'X-Init-Data': init, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, at)).json() as Promise<Record<string, any>>;
  const ingest = (body: object, at: number) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ fetchedAt: at, ...body }) }), env, at);
  const items = (at: number) => handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' } }), env, at).then((r) => r.json() as Promise<Record<string, any>>);

  d.db.exec(`INSERT INTO meta (key, value) VALUES ('rally_bot', 'off')`); // симуляция бота выключена — проверяем только пользователя
  assert.equal((await items(NOW)).rally.active, false, 'никто не пользуется — сборщик не тратит запросы к Steam');
  const empty = await api('rally');
  assert.equal(empty.candidates.message, NO_DEALS_TEXT);
  assert.equal(empty.sim.balanceKop, 3000); assert.equal(empty.real.availableKop, 1200, '30 ₴ − резерв 18 ₴');
  assert.equal((await items(NOW)).rally.active, true);

  const sa = { d1: 0.1755, d7: 0.1765, d30: 0.1775, d90: 0.175 }; // ≈ 7,02–7,10 ₴ при 40 ₴/$
  await ingest({ kind: 'rally_scan', items: [{ name: 'Revolution Case', sa, steam: { lowest_price: '4,50₴', median_price: '7,00₴', volume: '1,234' }, orders: { buy: 430 } }], nameids: [{ name: 'Revolution Case', id: 176321 }] }, NOW);
  const r = await api('rally');
  assert.equal(r.candidates.list.length, 1);
  const c = r.candidates.list[0];
  assert.equal(c.buyKop, 450); assert.equal(c.targetKop, 699); assert.equal(c.netKop, 609); assert.equal(c.risk, 'low');
  assert.equal((await items(NOW)).rally.nameids['Revolution Case'], 176321);

  // Реальная покупка 2 × 4,50 = 9 ₴ > лимита 6 ₴ — отказ; 1 шт. — можно.
  assert.match((await api('rally/buy', { mode: 'real', name: c.name, qty: 2, priceKop: 450 })).error, /лимита/);
  assert.equal((await api('rally/buy', { mode: 'real', name: c.name, qty: 1, priceKop: 450, targetKop: 699, predictedNetKop: 609 })).ok, true);
  assert.equal((await api('rally/buy', { mode: 'real', name: 'Fever Case', qty: 1, priceKop: 500 })).ok, true);
  assert.match((await api('rally/buy', { mode: 'real', name: 'Kilowatt Case', qty: 1, priceKop: 100 })).error, /2 из 2/);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'rally' AND text LIKE '%Лимит%'").get().n, 1);

  // Симуляция: 3 шт. по 1,50 ₴, частичная продажа 1 шт. вручную, остальное — автоматически после разблокировки по факту.
  assert.equal((await api('rally/buy', { mode: 'sim', name: 'Revolution Case', qty: 3, priceKop: 150, predictedNetKop: 200 })).ok, true);
  const sim = (await api('rally')).positions.find((p: any) => p.mode === 'sim');
  assert.match((await api('rally/sell', { id: sim.id, qty: 1, priceKop: 250 })).profitKop.toString(), /^\d+$/);
  const after = await api('rally');
  assert.equal(after.positions.find((p: any) => p.id === sim.id).qty, 2);
  assert.equal(after.sim.realizedKop, steamNetKop(250)! - 150);
  const T2 = NOW + 8 * 86400;
  await ingest({ kind: 'rally_scan', items: [{ name: 'Revolution Case', sa, steam: { lowest_price: '6,90₴', median_price: '6,80₴', volume: '900' } }] }, T2);
  const closed = d.db.prepare("SELECT * FROM rally_trades WHERE id = ?").get(sim.id) as any;
  assert.equal(closed.status, 'sold'); assert.equal(closed.sold_price_kop, 680); assert.equal(closed.sold_net_kop, steamNetKop(680)! * 2);
  // Реальная позиция: разблокировка и план → уведомления, без повторов.
  const n1 = d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'rally'").get().n;
  await ingest({ kind: 'rally_scan', items: [{ name: 'Revolution Case', sa, steam: { lowest_price: '6,90₴', median_price: '6,80₴', volume: '900' } }] }, T2 + 600);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'rally'").get().n, n1, 'повторов нет');
  const texts = (d.db.prepare("SELECT text FROM outbox WHERE kind = 'rally'").all() as { text: string }[]).map((x) => x.text).join('\n');
  assert.match(texts, /Можно продавать/); assert.match(texts, /новая возможность/);
});

test('симуляция бота: покупает сам по правилам, продаёт по факту; пост в канал — только если итог в плюсе', async () => {
  const { migratedDb, testEnv, ADMIN } = await import('./helpers.ts');
  const { handleIngest } = await import('../src/ingest.ts');
  const db = await import('../src/storage/db.ts');
  const run = async (sellMedian: string) => {
    const d = migratedDb(); const D = d as unknown as D1Database;
    const env = testEnv(d, { INGEST_SECRET: 'ingest_secret_test_123' });
    await db.storeFx(D, [{ base: 'USD', rateMicro: 40_000_000, rateDate: '2026-11-04', source: 'nbu' }], NOW);
    d.db.exec(`INSERT INTO meta (key, value) VALUES ('channel_id', '-1001'), ('bot_username', 'cenolow_bot')`);
    const ingest = (items: object[], at: number) => handleIngest(new Request('https://w/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' }, body: JSON.stringify({ kind: 'rally_scan', fetchedAt: at, items }) }), env, at);
    const sa = { d1: 0.1755, d7: 0.1765, d30: 0.1775, d90: 0.175 };
    const it = (name: string, low: string, med: string) => ({ name, sa, steam: { lowest_price: low, median_price: med, volume: '1,234' } });
    assert.equal((await (await handleIngest(new Request('https://w/ingest/items', { headers: { 'X-Ingest-Secret': 'ingest_secret_test_123' } }), env, NOW)).json() as any).rally.active, true, 'симуляция бота включает сбор данных');
    await ingest([it('Revolution Case', '4,50₴', '7,00₴'), it('Fever Case', '4,40₴', '7,00₴')], NOW);
    await ingest([it('Revolution Case', '4,50₴', '7,00₴'), it('Fever Case', '4,40₴', '7,00₴')], NOW + 600);
    const bought = d.db.prepare("SELECT name, buy_kop FROM rally_trades WHERE telegram_id = 0 ORDER BY id").all() as any[];
    assert.deepEqual(bought.map((x) => x.name).sort(), ['Fever Case', 'Revolution Case']);
    await ingest([it('Revolution Case', sellMedian, sellMedian), it('Fever Case', sellMedian, sellMedian)], NOW + 8 * 86400);
    return d;
  };
  const good = await run('6,90₴');
  assert.equal(good.db.prepare("SELECT COUNT(*) AS n FROM rally_trades WHERE telegram_id = 0 AND status = 'sold'").get().n, 2);
  const pend = JSON.parse((good.db.prepare("SELECT value FROM meta WHERE key = 'channel_pending'").get() as any).value);
  assert.match(pend.text, /Разгон баланса/); assert.match(pend.text, /симуляци/); assert.match(pend.text, /не обещание заработка/);
  assert.equal(JSON.parse((good.db.prepare("SELECT value FROM meta WHERE key = 'card_request'").get() as any).value).slot, 'rally');
  assert.match((good.db.prepare("SELECT text FROM outbox WHERE telegram_id = ? AND ref LIKE 'post:%'").get(ADMIN) as any).text, /сработала/);
  const bad = await run('4,60₴'); // продали дешевле — после комиссии убыток
  assert.equal(bad.db.prepare("SELECT value FROM meta WHERE key = 'channel_pending'").get(), undefined, 'убыток — поста нет');
  assert.match((bad.db.prepare("SELECT text FROM outbox WHERE telegram_id = ? AND ref = 'fail'").get(ADMIN) as any).text, /не сработала/);
});

test('бэктест на истории: сигнал только по прошлым данным, результат — через 7 дней; без данных о продаже сделка не считается', async () => {
  const { backtestItem } = await import('../src/core/rally.ts');
  const day = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
  const flat = Array.from({ length: 20 }, (_, i) => ({ day: day(i), min: 690, avg: 700 }));
  assert.equal(backtestItem('A', flat).length, 0, 'нет дешёвого объявления — нет сделки');
  const dip = flat.map((x, i) => (i === 10 ? { ...x, min: 450 } : x));
  const t = backtestItem('A', dip);
  assert.equal(t.length, 1); assert.equal(t[0].day, day(10)); assert.equal(t[0].sellDay, day(17));
  assert.equal(t[0].sellKop, 699); assert.equal(t[0].netKop, 609); assert.equal(t[0].win, true);
  const crash = dip.map((x, i) => (i >= 11 ? { ...x, min: 400, avg: 480 } : x));
  assert.equal(backtestItem('A', crash)[0].win, false, 'через 7 дней цена упала — убыток');
  assert.equal(backtestItem('A', dip.slice(0, 15)).length, 0, 'нет данных через 7 дней — не считаем');
});
