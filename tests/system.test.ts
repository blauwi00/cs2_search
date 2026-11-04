import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, testEnv, mockFetch, json, telegramRoute, fixture, fixtureJson, ADMIN } from './helpers.ts';
import { decideNotify, type NotifyPolicy } from '../src/core/alerts.ts';
import { ensureJobs, tryAcquire, releaseFail, releaseOk, disableStuckJobs, backoffSec, type JobDef } from '../src/core/scheduler.ts';
import { budgetedDb, newBudget, BudgetExceeded } from '../src/storage/budget.ts';
import { runCycle } from '../src/core/runner.ts';
import { handleWebhook, safeEqual } from '../src/telegram/webhook.ts';
import { handleAdmin } from '../src/admin.ts';
import * as db from '../src/storage/db.ts';
import { SourceError } from '../src/types/market.ts';

const NOW = Date.parse('2026-11-04T12:00:00Z') / 1000; // 13:00 по Варшаве — не тихие часы

const policy: NotifyPolicy = { cooldownSec: 6 * 3600, materialChangeBp: 2000, maxPerHour: 6, quietStart: 23, quietEnd: 8, notificationsEnabled: true, kindEnabled: true, minPriority: 'medium' };

// 12. Повторный одинаковый сигнал не отправляется
test('12: одинаковый сигнал не отправляется повторно', () => {
  const prev = { state: 'notified', spreadKop: 15000, buyKop: 40000, notifiedAt: NOW - 8 * 3600, priority: 'high' };
  assert.deepEqual(decideNotify(policy, 'high', { spreadKop: 15000, buyKop: 40000 }, prev, 0, 13, NOW), { send: false, reason: 'duplicate' });
  // Существенное изменение (> 20%) после cooldown — можно.
  assert.deepEqual(decideNotify(policy, 'high', { spreadKop: 25000, buyKop: 40000 }, prev, 0, 13, NOW), { send: true });
});

// 13. Cooldown
test('13: cooldown блокирует повтор даже при изменении', () => {
  const prev = { state: 'notified', spreadKop: 15000, buyKop: 40000, notifiedAt: NOW - 3600, priority: 'high' };
  assert.deepEqual(decideNotify(policy, 'high', { spreadKop: 30000, buyKop: 40000 }, prev, 0, 13, NOW), { send: false, reason: 'cooldown' });
});

test('тихие часы, лимит в час, выключенные уведомления, скрытые сигналы', () => {
  assert.deepEqual(decideNotify(policy, 'high', { spreadKop: 1, buyKop: 1 }, null, 0, 2, NOW), { send: false, reason: 'quiet_hours' });
  assert.deepEqual(decideNotify(policy, 'high', { spreadKop: 1, buyKop: 1 }, null, 6, 13, NOW), { send: false, reason: 'rate_limit' });
  assert.deepEqual(decideNotify({ ...policy, notificationsEnabled: false }, 'high', { spreadKop: 1, buyKop: 1 }, null, 0, 13, NOW), { send: false, reason: 'disabled' });
  assert.deepEqual(decideNotify({ ...policy, kindEnabled: false }, 'high', { spreadKop: 1, buyKop: 1 }, null, 0, 13, NOW), { send: false, reason: 'kind_disabled' });
  assert.deepEqual(decideNotify(policy, 'low', { spreadKop: 1, buyKop: 1 }, null, 0, 13, NOW), { send: false, reason: 'low_priority' });
  assert.deepEqual(decideNotify(policy, 'high', { spreadKop: 1, buyKop: 1 }, { state: 'dismissed', spreadKop: 1, buyKop: 1, notifiedAt: null, priority: 'high' }, 0, 13, NOW), { send: false, reason: 'dismissed' });
});

// 23. Миграции
test('23: миграции применяются и повторное применение безопасно', () => {
  const d = migratedDb();
  const tables = d.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
  for (const t of ['users', 'user_settings', 'items', 'watchlist', 'market_quotes', 'price_snapshots', 'exchange_rates', 'signals', 'source_status', 'scheduler_jobs', 'system_logs']) {
    assert.ok(tables.includes(t), t);
  }
  // CREATE ... IF NOT EXISTS — повторное выполнение не ломает базу.
  d.db.exec(fixture('../migrations/0001_init.sql'));
});

// 26. Нет параллельного выполнения одной задачи
test('26: задачу может захватить только один вызов', async () => {
  const d = migratedDb();
  const defs: JobDef[] = [{ name: 'x', intervalSec: 60, lockSec: 120 }];
  await ensureJobs(d as unknown as D1Database, defs, NOW);
  const a = await tryAcquire(d as unknown as D1Database, 'x', 120, NOW, 't1');
  const b = await tryAcquire(d as unknown as D1Database, 'x', 120, NOW, 't2');
  assert.equal(a, true);
  assert.equal(b, false);
  await releaseOk(d as unknown as D1Database, 'x', 't1', 60, NOW, 0);
  assert.equal(await tryAcquire(d as unknown as D1Database, 'x', 120, NOW + 60, 't3'), true);
});

test('backoff: экспонента, Retry-After, потолок 6 ч; оборванные запуски отключают задачу', async () => {
  assert.equal(backoffSec(60, 1, null, 0), 120);
  assert.equal(backoffSec(60, 3, null, 0), 480);
  assert.equal(backoffSec(60, 1, 900, 0), 900);
  assert.equal(backoffSec(60, 30, null, 0), 6 * 3600);
  const d = migratedDb();
  const D = d as unknown as D1Database;
  await ensureJobs(D, [{ name: 'heavy', intervalSec: 600, lockSec: 60 }], NOW);
  const delay = await (async () => { await tryAcquire(D, 'heavy', 60, NOW, 'a'); return releaseFail(D, 'heavy', 'a', new SourceError('rate_limited', '429', 429, 3000), 600, NOW, 0); })();
  assert.equal(delay, 3000);
  // Три запуска, оборванных платформой (лимит CPU): блокировка истекает, а started_unfinished растёт.
  await d.db.exec(`UPDATE scheduler_jobs SET next_run_at = 0, lock_until = 0 WHERE name='heavy'`);
  for (let i = 0; i < 3; i++) await tryAcquire(D, 'heavy', 60, NOW + i * 100, 'k' + i);
  assert.deepEqual(await disableStuckJobs(D, NOW + 1000), ['heavy']);
});

// 27. Исчерпание лимита
test('27: обёртка D1 останавливает работу при исчерпании лимита вызова', async () => {
  const d = migratedDb();
  const budget = newBudget();
  const D = budgetedDb(d as unknown as D1Database, budget);
  budget.d1 = 2;
  await D.prepare('SELECT 1').first();
  await D.batch([D.prepare('SELECT 1'), D.prepare('SELECT 2')]); // batch = 1 запрос
  assert.equal(budget.d1, 0);
  await assert.rejects(D.prepare('SELECT 1').first(), BudgetExceeded);
});

// 19, 20. Защита webhook и авторизация администратора
test('19: webhook без верного секрета отклоняется', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const upd = JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/start' } });
  const r1 = await handleWebhook(new Request('https://x/telegram', { method: 'POST', body: upd }), env, NOW);
  assert.equal(r1.status, 403);
  const r2 = await handleWebhook(new Request('https://x/telegram', { method: 'POST', body: upd, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret_value_000' } }), env, NOW);
  assert.equal(r2.status, 403);
  const r3 = await handleWebhook(new Request('https://x/telegram', { method: 'GET' }), env, NOW);
  assert.equal(r3.status, 405);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false);
});

test('20: команды принимаются только от администратора в личном чате', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = mockFetch([telegramRoute(sent)]);
  const mk = (from: number, chat: number) => new Request('https://x/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: from }, chat: { id: chat, type: 'private' }, text: '/start' } }),
  });
  assert.equal((await handleWebhook(mk(999, 999), env, NOW, fetcher)).status, 200);
  assert.equal((await handleWebhook(mk(ADMIN, -100500), env, NOW, fetcher)).status, 200); // группа
  assert.equal(sent.length, 0, 'чужим и в группах ничего не отвечаем');
  await handleWebhook(mk(ADMIN, ADMIN), env, NOW, fetcher);
  assert.equal(sent.length, 1);
  assert.ok(String(sent[0].body.text).includes('CS2 Market Bot'));
  assert.equal(sent[0].body.chat_id, ADMIN);
});

// 21. Настройки
test('21: настройки меняются через кнопки и ввод, сохраняются в D1 и проверяются', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = mockFetch([telegramRoute(sent)]);
  const h = { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET };
  const cb = (data: string) => new Request('https://x/telegram', { method: 'POST', headers: h, body: JSON.stringify({ update_id: 2, callback_query: { id: 'c', from: { id: ADMIN }, data, message: { message_id: 5, chat: { id: ADMIN, type: 'private' } } } }) });
  const msg = (text: string) => new Request('https://x/telegram', { method: 'POST', headers: h, body: JSON.stringify({ update_id: 3, message: { message_id: 6, from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text } }) });

  await handleWebhook(cb('s:notify_enabled'), env, NOW, fetcher);
  assert.equal((await db.getSettings(d as unknown as D1Database, ADMIN)).notify_enabled, '0');
  await handleWebhook(cb('s:min_profit_kop'), env, NOW, fetcher);
  await handleWebhook(msg('абв'), env, NOW, fetcher);
  assert.ok(String(sent.at(-1)!.body.text).includes('❌'));
  await handleWebhook(msg('35,5'), env, NOW, fetcher);
  assert.equal((await db.getSettings(d as unknown as D1Database, ADMIN)).min_profit_kop, '3550');
  await handleWebhook(cb('s:min_roi_bp'), env, NOW, fetcher);
  await handleWebhook(msg('12%'), env, NOW, fetcher);
  assert.equal((await db.getSettings(d as unknown as D1Database, ADMIN)).min_roi_bp, '1200');
});

test('админ-адреса закрыты без ключа и ставят webhook с секретом', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  assert.equal((await handleAdmin(new Request('https://bot.example.workers.dev/admin/setup'), env, NOW)).status, 403);
  assert.equal((await handleAdmin(new Request('https://bot.example.workers.dev/admin/setup?key=nope'), env, NOW)).status, 403);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = mockFetch([telegramRoute(sent)]);
  const r = await handleAdmin(new Request(`https://bot.example.workers.dev/admin/setup?key=${env.ADMIN_KEY}`), env, NOW, fetcher);
  assert.equal(r.status, 200);
  const hook = sent.find((s) => s.method === 'setWebhook')!;
  assert.equal(hook.body.url, 'https://bot.example.workers.dev/telegram');
  assert.equal(hook.body.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
  assert.ok(!(await r.text()).includes(env.TELEGRAM_BOT_TOKEN), 'токен не раскрывается');
});

// ---------- Сквозной цикл ----------

function marketRoutes(sent: { method: string; body: Record<string, unknown> }[], steamBody: unknown = fixtureJson('steam_priceoverview_uah.json')) {
  return mockFetch([
    telegramRoute(sent),
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
    { match: (u) => u.includes('/market/priceoverview/'), respond: () => json(steamBody) },
    { match: (u) => u.includes('api.skinport.com/v1/items'), respond: () => new Response(fixture('skinport_items.json')) },
    { match: (u) => u.includes('api.skinport.com/v1/sales/history'), respond: () => json(fixtureJson('skinport_sales.json')) },
  ]);
}

async function seedWatch(d: ReturnType<typeof migratedDb>, name: string) {
  const D = d as unknown as D1Database;
  const it = await db.upsertItem(D, name, NOW);
  await db.addWatch(D, ADMIN, it.id, NOW);
  return it;
}

test('сквозной цикл: курсы → Steam → Skinport → оценка → одно уведомление; повтор Cron не дублирует (12, 25)', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  await seedWatch(d, 'AK-47 | Redline (Field-Tested)');
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = marketRoutes(sent);

  const r1 = await runCycle(env, { now: NOW, fetcher });
  assert.deepEqual(r1.errors, []);
  assert.ok(r1.ran.includes('fx') && r1.ran.includes('steam') && r1.ran.includes('skinport_items'), r1.ran.join());
  // Skinport-оценка выполнится в следующем запуске (задача evaluate), если не успела.
  const r2 = await runCycle(env, { now: NOW + 60, fetcher });
  assert.deepEqual(r2.errors, []);

  const arb = sent.filter((s) => s.method === 'sendMessage' && String(s.body.text).includes('НАЙДЕНА ВОЗМОЖНОСТЬ'));
  assert.equal(arb.length, 1, 'ровно одно уведомление об арбитраже');
  const text = String(arb[0].body.text);
  assert.ok(text.includes('382,50 грн'), 'покупка: 8,50 EUR × 45 = 382,50 грн');
  assert.ok(text.includes('8,50 EUR'));
  assert.ok(text.includes('баланс Steam, не наличные'));
  assert.ok(text.includes('Курс НБУ'));
  assert.ok(!text.includes('PLN') && !text.includes('zł'), 'никаких злотых в сообщении');

  // Повторные вызовы Cron с теми же данными — без новых уведомлений.
  for (let i = 2; i < 6; i++) await runCycle(env, { now: NOW + i * 60, fetcher });
  const arb2 = sent.filter((s) => s.method === 'sendMessage' && String(s.body.text).includes('НАЙДЕНА ВОЗМОЖНОСТЬ'));
  assert.equal(arb2.length, 1);

  const sig = d.db.prepare("SELECT state, priority, spread_kop, buy_kop FROM signals WHERE kind='arbitrage_steam'").get() as Record<string, unknown>;
  assert.equal(sig.state, 'notified');
  assert.equal(sig.buy_kop, 38250);
  // История сигналов (снимок исходных данных) сохраняется для последующей оценки качества.
  const snap = d.db.prepare("SELECT snapshot_json FROM signals").get() as { snapshot_json: string };
  assert.ok(JSON.parse(snap.snapshot_json).buy.price_minor === 850);
});

test('сделка исчезла → сигнал помечается неактуальным правкой сообщения, без нового сообщения', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  await seedWatch(d, 'AK-47 | Redline (Field-Tested)');
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const m = marketRoutes(sent);
  await runCycle(env, { now: NOW, fetcher: m.fetcher });
  await runCycle(env, { now: NOW + 60, fetcher: m.fetcher });
  const before = sent.filter((s) => s.method === 'sendMessage').length;
  // Цена Steam упала — спред стал отрицательным.
  const m2 = marketRoutes(sent, { success: true, lowest_price: '300,00₴', median_price: '300,00₴', volume: '500' });
  await d.db.exec(`UPDATE scheduler_jobs SET next_run_at = 0 WHERE name = 'steam'`);
  await runCycle(env, { now: NOW + 3600, fetcher: m2.fetcher });
  const sig = d.db.prepare("SELECT state FROM signals WHERE kind='arbitrage_steam'").get() as { state: string };
  assert.equal(sig.state, 'expired');
  assert.ok(sent.some((s) => s.method === 'editMessageText' && String(s.body.text).includes('НЕАКТУАЛЬНО')));
  const arbAfter = sent.filter((s) => s.method === 'sendMessage' && String(s.body.text).includes('НАЙДЕНА')).length;
  assert.equal(arbAfter, 1);
  assert.ok(sent.filter((s) => s.method === 'sendMessage').length >= before);
});

test('один источник падает (Steam 500) — остальные продолжают работать', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  await seedWatch(d, 'AK-47 | Redline (Field-Tested)');
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = mockFetch([
    telegramRoute(sent),
    { match: (u) => u.startsWith('https://bank.gov.ua/'), respond: () => json(fixtureJson('nbu.json')) },
    { match: (u) => u.includes('/market/priceoverview/'), respond: () => new Response('', { status: 500 }) },
    { match: (u) => u.includes('api.skinport.com/v1/items'), respond: () => new Response(fixture('skinport_items.json')) },
    { match: (u) => u.includes('api.skinport.com/v1/sales/history'), respond: () => json(fixtureJson('skinport_sales.json')) },
  ]);
  const r = await runCycle(env, { now: NOW, fetcher });
  assert.ok(r.errors.some((e) => e.job === 'steam'));
  assert.ok(r.ran.includes('skinport_items') && r.ran.includes('fx'));
  const st = await db.listSourceStatus(d as unknown as D1Database);
  assert.equal(st.find((s) => s.source === 'steam')!.status, 'degraded');
  assert.equal(st.find((s) => s.source === 'skinport')!.status, 'ok');
  const job = d.db.prepare("SELECT fail_count, next_run_at FROM scheduler_jobs WHERE name='steam'").get() as { fail_count: number; next_run_at: number };
  assert.equal(job.fail_count, 1);
  assert.ok(job.next_run_at >= NOW + 120, 'backoff после ошибки');
});

test('28: нулевой бюджет / лимит покупки — уведомление не отправляется', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  await seedWatch(d, 'AK-47 | Redline (Field-Tested)');
  await db.setSetting(d as unknown as D1Database, ADMIN, 'max_buy_kop', '10000', NOW); // 100 грн < 382,50 грн
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = marketRoutes(sent);
  await runCycle(env, { now: NOW, fetcher });
  await runCycle(env, { now: NOW + 60, fetcher });
  assert.equal(sent.filter((s) => String(s.body.text ?? '').includes('НАЙДЕНА')).length, 0);
});

test('нож Doppler: сигнал создаётся только с низким приоритетом и не отправляется', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  await seedWatch(d, '★ Karambit | Doppler (Factory New)');
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher } = marketRoutes(sent, { success: true, lowest_price: '90 000,00₴', median_price: '95 000,00₴', volume: '40' });
  await runCycle(env, { now: NOW, fetcher });
  await runCycle(env, { now: NOW + 60, fetcher });
  const sig = d.db.prepare("SELECT priority, category FROM signals WHERE kind='arbitrage_steam'").get() as { priority: string; category: string } | undefined;
  assert.ok(sig);
  assert.equal(sig.priority, 'low');
  assert.equal(sig.category, 'anomaly');
  assert.equal(sent.filter((s) => String(s.body.text ?? '').includes('НАЙДЕНА')).length, 0);
});

test('цикл укладывается в лимиты вызова даже при 100 предметах', async () => {
  const d = migratedDb();
  const env = testEnv(d);
  for (let i = 0; i < 100; i++) await seedWatch(d, `Test Item ${i} | Skin (Field-Tested)`);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { fetcher, calls } = marketRoutes(sent);
  for (let i = 0; i < 5; i++) {
    const before = d.execs;
    const callsBefore = calls.length;
    const r = await runCycle(env, { now: NOW + i * 60, fetcher });
    assert.deepEqual(r.errors, []);
    assert.ok(d.execs - before <= 50, `запросов D1 за вызов: ${d.execs - before}`);
    assert.ok(calls.length - callsBefore <= 50, `внешних запросов за вызов: ${calls.length - callsBefore}`);
  }
  // Все 100 предметов получили цену Skinport за один запрос, Steam — порциями.
  const n = d.db.prepare("SELECT COUNT(*) AS n FROM market_quotes WHERE source='skinport' AND price_type='lowest_listing'").get() as { n: number };
  assert.equal(n.n, 100);
});
