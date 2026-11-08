// Локальная копия бота для записи роликов: настоящий app.html и API, тестовая база с реальными ценами Steam (8 нояб. 2026).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { migratedDb, testEnv } from '../../tests/helpers.ts';
import { handleAppApi } from '../../src/webapp/api.ts';
import { signInitData } from '../../src/webapp/auth.ts';
import * as db from '../../src/storage/db.ts';
import * as T from '../../src/storage/trades.ts';
import { catalogLines } from '../../src/catalog.ts';
import { TERMS_VERSION } from '../../src/core/terms.ts';

const DIR = process.env.VID_DIR || new URL('./work', import.meta.url).pathname;
const PORT = 8787, TID = 4242;
const NOW = Math.floor(Date.now() / 1000);
const USD = 41.4, EUR = 48.2;
const d = migratedDb(); const D = d as unknown as D1Database; const env = testEnv(d);
const exec = (sql: string, ...p: unknown[]) => d.db.prepare(sql).run(...(p as (string | number | null)[]));

const prices = readFileSync(DIR + '/prices.tsv', 'utf8').trim().split('\n').map((l) => {
  const [name, j] = l.split('\t'); const o = JSON.parse(j);
  const uah = (s: string) => Math.round(Number(String(s).replace(/[^\d,]/g, '').replace(',', '.')) * 100);
  return { name, low: uah(o.lowest_price), med: uah(o.median_price), vol: Number(String(o.volume).replace(/\D/g, '')) };
});
const file = (n: string) => n.replace(/[^A-Za-z0-9]/g, '_') + '.png';

await db.storeFx(D, [{ base: 'USD', rateMicro: USD * 1e6, rateDate: '2026-11-08', source: 'nbu' }, { base: 'EUR', rateMicro: EUR * 1e6, rateDate: '2026-11-08', source: 'nbu' }], NOW);
const ids = new Map<string, number>();
for (const p of prices) {
  const it = await db.upsertItem(D, p.name, NOW); ids.set(p.name, it.id);
  for (const [type, kop, vol] of [['lowest_listing', p.low, null], ['median_24h', p.med, p.vol]] as const) {
    exec(`INSERT INTO market_quotes (source, item_id, price_type, price_minor, currency, price_kop, quantity, volume, volume_period, fetched_at, quality, snap_at)
      VALUES ('steam', ?, ?, ?, 'UAH', ?, NULL, ?, ?, ?, 'ok', ?)`, it.id, type, kop, kop, vol, vol ? '24h' : null, NOW - 900, NOW - 900);
  }
  // История для графика: плавная кривая за 30 дней, заканчивается на сегодняшней цене (демо — настоящей истории без входа в Steam нет).
  let seed = p.name.length * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let v = p.low * 0.93;
  for (let k = 120; k >= 0; k--) {
    v = k === 0 ? p.low : v * (1 + (rnd() - 0.47) * 0.018) + (p.low - v) * 0.02;
    const kop = Math.round(v);
    exec(`INSERT INTO price_snapshots (item_id, source, price_type, price_minor, currency, price_kop, volume, observed_at, quality) VALUES (?, 'steam', 'lowest_listing', ?, 'UAH', ?, NULL, ?, 'ok')`, it.id, kop, kop, NOW - 900 - k * 6 * 3600);
  }
  const c = Math.round(p.med / USD);
  exec('INSERT INTO steam_avg (item_id, d1, d7, d30, d90, updated_at) VALUES (?, ?, ?, ?, ?, ?)', it.id, c, Math.round(c * 1.01), Math.round(c * 1.04), Math.round(c * 1.08), NOW - 3600);
  exec('INSERT INTO site_prices (name, json, updated_at) VALUES (?, ?, ?)', p.name, JSON.stringify({ skinport: Math.round(c * 0.86), csfloat: Math.round(c * 0.84), csgomarket: Math.round(c * 0.8), lisskins: Math.round(c * 0.81), buff163: Math.round(c * 0.78) }), NOW - 1800);
  if (existsSync(DIR + '/img/' + file(p.name))) exec('INSERT INTO item_images (name, url) VALUES (?, ?)', p.name, `http://localhost:${PORT}/img/${file(p.name)}`);
}
// Сканирование рынка для «Идей»: объявления на площадках и продажи Skinport.
const scan = prices.map((p) => {
  const c = p.med / USD;
  return { name: p.name, at: NOW - 600, img: `http://localhost:${PORT}/img/${file(p.name)}`,
    offers: [{ m: 'csgomarket', cur: 'USD', minor: Math.round(c * 0.74), qty: 40, since: NOW - 7200 }, { m: 'skinport', cur: 'EUR', minor: Math.round((c * 0.86 * USD) / EUR), qty: 120, since: NOW - 7200 }],
    s7: { median: Math.round((c * 0.95 * USD) / EUR), volume: 180 }, s30: { median: Math.round((c * 0.93 * USD) / EUR), volume: 700 },
    sa: { d1: Math.round(c), d7: Math.round(c * 1.01), d30: Math.round(c * 1.04), d90: Math.round(c * 1.08) },
    steam: { lowestKop: p.low, medianKop: p.med, volume24h: p.vol, at: NOW - 900 } };
});
exec('INSERT INTO market_scan (id, data, fetched_at) VALUES (1, ?, ?)', JSON.stringify(scan), NOW - 600);

// Пользователь: Steam подключён, инвентарь, баланс, покупки (одна — под защитой обмена).
await db.ensureUser(D, TID, false, NOW - 20 * 86400);
for (const [k, v] of [['terms_ok', TERMS_VERSION], ['onboarded', '1'], ['currency_ok', '1'], ['setup_hidden', '1'], ['notify_enabled', '1'],
  ['steam_balance_kop', '145000'], ['steam_balance_cur', 'UAH'], ['steam_balance_at', String(NOW - 2 * 86400)], ['recs_by_balance', '1']] as const) await db.setSetting(D, TID, k as never, v, NOW);
exec(`UPDATE users SET steam_id = '76561198000004242', steam_verified = 1, inv_synced_at = ?, inv_requested_at = ?, inv_status = 'ok' WHERE telegram_id = ?`, NOW - 1200, NOW - 1300, TID);
for (const [n, q] of [['Dreams & Nightmares Case', 6], ['Gallery Case', 9], ['Kilowatt Case', 25], ['AK-47 | Slate (Field-Tested)', 1], ['USP-S | Ticket to Hell (Field-Tested)', 1], ['Revolution Case', 14]] as const) {
  exec('INSERT INTO steam_inventory (telegram_id, item_id, qty) VALUES (?, ?, ?)', TID, ids.get(n)!, q);
}
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
await T.addTrade(D, { tid: TID, itemId: ids.get('Dreams & Nightmares Case')!, signalId: null, quantity: 6, buyPriceKop: 4650, buyFeeKop: 0, platform: 'skinport', buyDate: day(NOW - 30 * 86400), note: null, now: NOW - 30 * 86400 });
await T.addTrade(D, { tid: TID, itemId: ids.get('AK-47 | Slate (Field-Tested)')!, signalId: null, quantity: 1, buyPriceKop: 19800, buyFeeKop: 0, platform: 'csfloat', buyDate: day(NOW - 25 * 86400), note: null, now: NOW - 25 * 86400 });
await T.addTrade(D, { tid: TID, itemId: ids.get('AWP | Atheris (Field-Tested)')!, signalId: null, quantity: 1, buyPriceKop: 21900, buyFeeKop: 0, platform: 'steam', buyDate: day(NOW - 2 * 86400), note: null, now: NOW - 2 * 86400 });
await T.addTrade(D, { tid: TID, itemId: ids.get('Gallery Case')!, signalId: null, quantity: 9, buyPriceKop: 3100, buyFeeKop: 0, platform: 'csgomarket', buyDate: day(NOW - 12 * 86400), note: null, now: NOW - 12 * 86400 });
for (const n of ['Kilowatt Case', 'Gallery Case', 'Desert Eagle | Printstream (Field-Tested)', 'AWP | Atheris (Field-Tested)']) await db.addWatch(D, TID, ids.get(n)!, NOW - 5 * 86400);
const extra = ['AK-47 | Slate (Minimal Wear)', 'AK-47 | Slate (Factory New)', 'StatTrak™ AK-47 | Slate (Field-Tested)', 'AK-47 | Redline (Field-Tested)', 'AK-47 | Asiimov (Field-Tested)', 'AK-47 | Bloodsport (Field-Tested)', 'AK-47 | Neon Rider (Field-Tested)', 'AK-47 | Vulcan (Field-Tested)'];
exec('INSERT INTO catalog_chunks (chunk, names, updated_at) VALUES (0, ?, ?)', catalogLines([...prices.map((p) => p.name), ...extra]), NOW);
exec(`INSERT INTO scheduler_jobs (name, interval_sec, next_run_at, last_run_at, last_ok_at) VALUES ('evaluate', 60, 0, ?, ?)`, NOW + 1e6, NOW + 1e6);
await db.sourceOk(D, 'collector', NOW + 1e6, 100);
await db.sourceOk(D, 'skinport', NOW + 1e6, 100);
exec(`INSERT INTO meta (key, value) VALUES ('bot_username', 'cenolow_bot') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

const initData = await signInitData({ auth_date: String(NOW), query_id: 'AAE', user: JSON.stringify({ id: TID, first_name: 'Eldar', language_code: 'ru' }) }, 'TEST_TOKEN');
const html = readFileSync(new URL('../../src/webapp/app.html', import.meta.url), 'utf8');
http.createServer(async (req, res) => {
  const u = new URL(req.url!, `http://localhost:${PORT}`);
  try {
    if (u.pathname === '/app') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    if (u.pathname === '/init') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(initData); }
    if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(readFileSync(DIR + u.pathname)); }
    if (u.pathname.startsWith('/app/api/')) {
      const body = req.method === 'POST' ? await new Promise<string>((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); }) : undefined;
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handleAppApi(new Request(u.toString(), { method: req.method, headers, body }), env, Math.floor(Date.now() / 1000));
      res.writeHead(r.status, { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' }); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    res.writeHead(404); res.end();
  } catch (e) { console.error(u.pathname, e); res.writeHead(500); res.end(String(e)); }
}).listen(PORT, () => console.log('ready', PORT));
