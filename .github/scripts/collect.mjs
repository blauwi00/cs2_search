// Сборщик цен для CS2 Market Bot. Запускается GitHub Actions по расписанию.
// Steam и Skinport блокируют сеть Cloudflare, поэтому запросы к ним делаются отсюда,
// а результаты отправляются в Worker (POST /ingest). Обхода защит нет: обычные публичные запросы
// с паузами, при 429 — пауза и остановка.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const WORKER = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET || '';
if (!WORKER || !SECRET) { console.error('Нужны WORKER_URL и секрет INGEST_SECRET'); process.exit(1); }

const UA = 'cs2-market-bot-collector/1.0 (personal price monitor)';
const STEAM_GAP_MS = 3000;          // ~20 запросов в минуту
const TIME_BUDGET_MS = 7 * 60_000;  // укладываемся в 10-минутное расписание
const STEAM_CHUNK = 25;             // предметов в одной отправке в Worker
const SALES_CHUNK = 40;
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function readJson(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const tryParse = (b) => JSON.parse(b.toString('utf8'));
  try { return tryParse(buf); } catch { /* возможно, сжатый ответ */ }
  const enc = res.headers.get('content-encoding') || '';
  if (enc.includes('br')) return tryParse(brotliDecompressSync(buf));
  if (enc.includes('gzip')) return tryParse(gunzipSync(buf));
  throw new Error('ответ не JSON');
}

async function toWorker(path, body) {
  const res = await fetch(WORKER + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Worker ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const { items, needCatalog } = await toWorker('/ingest/items');
console.log(`Предметов в наблюдении: ${items.length}`);
let allItems = [];
let skinportCalls = 0;              // лимит Skinport: 8 запросов за 5 минут — держим не больше 7 за запуск
const SCAN_STEAM = 12;              // сколько кандидатов рекомендаций проверить в Steam за запуск
const UNIQUE = /Doppler|Case Hardened|Fade|Crimson Web|Slaughter|Marble|Lore|Autotronic|Gamma/i;

// 1. Skinport: весь каталог одним запросом (лимит 8 запросов / 5 мин), отправляем только нужные предметы.
try {
  const res = await fetch('https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=0', { headers: { 'Accept-Encoding': 'br', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  skinportCalls++;
  const all = await readJson(res);
  allItems = Array.isArray(all) ? all : [];
  if (needCatalog) {
    // Раз в сутки: все названия CS2 для поиска в боте и приложении.
    const names = [...new Set(all.map((x) => x.market_hash_name).filter(Boolean))].sort();
    const size = 5000;
    const parts = Math.ceil(names.length / size);
    for (let p = 0; p < parts; p++) {
      const r = await toWorker('/ingest', { kind: 'catalog', fetchedAt: now(), part: p, parts, items: names.slice(p * size, (p + 1) * size) });
      console.log(`Каталог названий ${p + 1}/${parts}:`, r);
    }
  }
  const wanted = new Set(items);
  const rows = all.filter((x) => wanted.has(x.market_hash_name));
  const r = rows.length || items.length ? await toWorker('/ingest', { kind: 'skinport_items', fetchedAt: now(), items: rows }) : 'нет предметов';
  console.log(`Skinport каталог: найдено ${rows.length} из ${items.length}`, r);
} catch (e) {
  console.error('Skinport каталог:', e.message);
  await toWorker('/ingest', { kind: 'skinport_items', fetchedAt: now(), error: e.message }).catch(() => {});
}

// 2. Skinport: история продаж (ликвидность) — порциями.
for (let i = 0; i < items.length && i / SALES_CHUNK < 4; i += SALES_CHUNK) {
  const chunk = items.slice(i, i + SALES_CHUNK);
  try {
    const q = new URLSearchParams({ app_id: '730', currency: 'EUR', market_hash_name: chunk.join(',') });
    const res = await fetch(`https://api.skinport.com/v1/sales/history?${q}`, { headers: { 'Accept-Encoding': 'br', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    skinportCalls++;
    const r = await toWorker('/ingest', { kind: 'skinport_sales', fetchedAt: now(), items: await readJson(res) });
    console.log(`Skinport продажи ${i + 1}–${i + chunk.length}:`, r);
  } catch (e) {
    console.error('Skinport продажи:', e.message);
    await toWorker('/ingest', { kind: 'skinport_sales', fetchedAt: now(), error: e.message }).catch(() => {});
    break;
  }
}

// 2б. Рекомендации по всему рынку: кандидаты из каталога Skinport + их реальные продажи за 7/30 дней.
// Кандидаты: (а) самое дешёвое объявление заметно ниже рекомендованной цены Skinport, (б) самые продаваемые недорогие предметы.
let scan = [];
try {
  const base = allItems.filter((x) => x && typeof x.market_hash_name === 'string' && x.min_price >= 0.3 && x.quantity >= 3 && !UNIQUE.test(x.market_hash_name));
  const cheap = base.filter((x) => x.suggested_price > 0 && x.min_price <= x.suggested_price * 0.88)
    .sort((a, b) => a.min_price / a.suggested_price - b.min_price / b.suggested_price).slice(0, 40);
  const picked = new Set(cheap.map((x) => x.market_hash_name));
  const popular = base.filter((x) => !picked.has(x.market_hash_name) && x.min_price <= 300).sort((a, b) => b.quantity - a.quantity).slice(0, 80 - cheap.length);
  const cands = [...cheap, ...popular];
  const byName = new Map(cands.map((x) => [x.market_hash_name, { name: x.market_hash_name, minEur: x.min_price, qty: x.quantity, s7: null, s30: null, steam: null }]));
  for (let i = 0; i < cands.length && skinportCalls < 7; i += SALES_CHUNK) {
    const q = new URLSearchParams({ app_id: '730', currency: 'EUR', market_hash_name: cands.slice(i, i + SALES_CHUNK).map((x) => x.market_hash_name).join(',') });
    const res = await fetch(`https://api.skinport.com/v1/sales/history?${q}`, { headers: { 'Accept-Encoding': 'br', 'User-Agent': UA } });
    skinportCalls++;
    if (!res.ok) throw new Error(`продажи HTTP ${res.status}`);
    for (const h of await readJson(res)) {
      const e = byName.get(h?.market_hash_name);
      if (!e) continue;
      e.s7 = h.last_7_days ? { median: h.last_7_days.median, volume: h.last_7_days.volume } : null;
      e.s30 = h.last_30_days ? { median: h.last_30_days.median, volume: h.last_30_days.volume } : null;
    }
  }
  scan = [...byName.values()].filter((e) => e.s7);
  console.log(`Сканирование рынка: кандидатов ${cands.length}, с историей продаж ${scan.length}`);
} catch (e) {
  console.error('Сканирование рынка:', e.message);
}

// 3. Steam: по одному предмету с паузой; при 429 — минута паузы, при повторе — стоп до следующего запуска.
let batch = [];
let strikes = 0;
const flush = async () => {
  if (!batch.length) return;
  const r = await toWorker('/ingest', { kind: 'steam', fetchedAt: now(), items: batch });
  console.log(`Steam: отправлено ${batch.length}`, r);
  batch = [];
};
for (const name of items) {
  if (Date.now() - started > TIME_BUDGET_MS) { console.log('Время запуска вышло, остальное — в следующий раз'); break; }
  const q = new URLSearchParams({ appid: '730', currency: '18', market_hash_name: name });
  let entry;
  try {
    const res = await fetch(`https://steamcommunity.com/market/priceoverview/?${q}`, { headers: { 'User-Agent': UA } });
    if (res.status === 429) {
      entry = { name, ok: false, status: 429 };
      strikes++;
      console.log(`Steam 429 (${strikes})`);
      if (strikes >= 2) { batch.push(entry); break; }
      await sleep(60_000);
    } else if (!res.ok) {
      entry = { name, ok: false, status: res.status };
    } else {
      entry = { name, ok: true, body: await readJson(res) };
      strikes = 0;
    }
  } catch (e) {
    entry = { name, ok: false, error: e.message };
  }
  batch.push(entry);
  if (batch.length >= STEAM_CHUNK) await flush();
  await sleep(STEAM_GAP_MS);
}
await flush();

// 4. Steam для лучших кандидатов рекомендаций (если Steam не ограничил нас выше). Проверенные раньше Worker помнит 3 часа,
// поэтому за несколько запусков покрываются все кандидаты.
if (scan.length) {
  const rot = Math.floor(Date.now() / 600_000) % 4; // смещение по запускам
  const order = scan.filter((e) => (e.s7?.volume ?? 0) >= 7).sort((a, b) => (b.s7.volume ?? 0) - (a.s7.volume ?? 0));
  const pick = order.slice(rot * SCAN_STEAM, rot * SCAN_STEAM + SCAN_STEAM);
  for (const e of strikes >= 2 ? [] : pick) {
    if (Date.now() - started > TIME_BUDGET_MS + 60_000) break;
    try {
      const q = new URLSearchParams({ appid: '730', currency: '18', market_hash_name: e.name });
      const res = await fetch(`https://steamcommunity.com/market/priceoverview/?${q}`, { headers: { 'User-Agent': UA } });
      if (res.status === 429) { console.log('Steam 429 при проверке рекомендаций — стоп'); break; }
      if (res.ok) { const b = await readJson(res); if (b?.success) e.steam = { lowest_price: b.lowest_price, median_price: b.median_price, volume: b.volume }; }
    } catch { /* пропускаем предмет */ }
    await sleep(STEAM_GAP_MS);
  }
  try {
    console.log('Рекомендации:', await toWorker('/ingest', { kind: 'scan', fetchedAt: now(), items: scan }));
  } catch (e) { console.error('Рекомендации:', e.message); }
}
console.log(`Готово за ${Math.round((Date.now() - started) / 1000)} с`);
