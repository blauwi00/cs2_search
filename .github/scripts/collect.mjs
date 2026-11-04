// Сборщик цен для CS2 Market Bot. Запускается GitHub Actions по расписанию.
// Steam и Skinport блокируют сеть Cloudflare, поэтому запросы к ним делаются отсюда,
// а результаты отправляются в Worker (POST /ingest). Обхода защит нет: обычные публичные запросы
// с паузами, при 429 — пауза и остановка.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeCertificate } from './inspect.mjs';

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

const { items, needCatalog, fx = {}, missingImages = [], needSteamAvg = [], steamAvgAt = 0, inventorySync = [], trackNames = [] } = await toWorker('/ingest/items');
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

// 2б. Каталог предметов: открытый ByMykel/CSGO-API (картинки на Steam CDN, номера наклеек/брелков, фазы Doppler).
// Раз в сутки, дальше — кэш GitHub.
let images = new Map();
const stickerNames = new Map(), charmNames = new Map(), phases = new Map();
try {
  const file = '.cache/catalog2.json';
  let cat;
  if (existsSync(file)) cat = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const res = await fetch('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/all.json', { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    cat = { images: {}, stickers: {}, charms: {}, phases: {} };
    for (const x of Object.values(all)) {
      if (!x || typeof x !== 'object') continue;
      const mhn = typeof x.market_hash_name === 'string' ? x.market_hash_name : null;
      if (mhn && typeof x.image === 'string') cat.images[mhn] = x.image;
      const id = typeof x.id === 'string' ? x.id : '';
      const num = (x.def_index ?? id.match(/^(?:sticker|keychain)-(\d+)$/)?.[1]) ?? null;
      if (id.startsWith('sticker-') && num != null) cat.stickers[String(num)] = mhn || x.name;
      if (id.startsWith('keychain-') && num != null) cat.charms[String(num)] = mhn || x.name;
      if (x.phase && x.paint_index != null && x.weapon?.weapon_id != null) cat.phases[`${x.weapon.weapon_id}_${x.paint_index}`] = x.phase;
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(file, JSON.stringify(cat));
  }
  images = new Map(Object.entries(cat.images));
  for (const [k, v] of Object.entries(cat.stickers)) stickerNames.set(k, v);
  for (const [k, v] of Object.entries(cat.charms)) charmNames.set(k, v);
  for (const [k, v] of Object.entries(cat.phases)) phases.set(k, v);
  console.log(`Каталог: картинок ${images.size}, наклеек ${stickerNames.size}, брелков ${charmNames.size}, фаз Doppler ${phases.size}`);
  const send = missingImages.filter((n) => images.has(n)).map((n) => ({ name: n, url: images.get(n) }));
  if (send.length) console.log('Картинки для наблюдения:', await toWorker('/ingest', { kind: 'images', fetchedAt: now(), items: send.slice(0, 500) }));
} catch (e) {
  console.error('Каталог:', e.message);
}

// 2б-2. Средние продажи Steam на весь рынок: открытый прайс CSGO Trader (~34 тыс. предметов, ~4 МБ).
// Качаем при каждом запуске (это дёшево), Steam при этом не опрашивается. Новую версию файла (по Last-Modified)
// сразу рассылаем по всем предметам наблюдения; иначе — только по новым предметам. Цены в USD, Worker переводит по НБУ.
let steamAvg = new Map();
try {
  const res = await fetch('https://prices.csgotrader.app/latest/steam.json', { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lm = Date.parse(res.headers.get('last-modified') || '');
  const fileAt = Number.isFinite(lm) ? Math.floor(lm / 1000) : 0;
  const raw = await res.json();
  for (const [n, v] of Object.entries(raw ?? {})) if (v && typeof v === 'object') steamAvg.set(n, { d1: v.last_24h ?? null, d7: v.last_7d ?? null, d30: v.last_30d ?? null, d90: v.last_90d ?? null });
  const fresh = fileAt > steamAvgAt;
  console.log(`Прайс Steam (CSGO Trader): ${steamAvg.size} предметов, версия ${fileAt ? new Date(fileAt * 1000).toISOString() : '?'}${fresh ? ' — новая' : ''}`);
  const names = fresh ? [...new Set([...items, ...needSteamAvg])] : needSteamAvg;
  // Предметы, которых нет в прайсе, тоже отправляем (пустыми) — чтобы Worker не спрашивал их снова до завтра.
  const send = names.map((n) => ({ name: n, ...(steamAvg.get(n) ?? { d1: null, d7: null, d30: null, d90: null }) }));
  for (let i = 0; i < send.length; i += 400) {
    console.log('Средние Steam для наблюдения:', await toWorker('/ingest', { kind: 'steam_avg', fetchedAt: now(), fileAt: fresh && i + 400 >= send.length ? fileAt : undefined, items: send.slice(i, i + 400) }));
  }
  if (fresh && !send.length && fileAt) await toWorker('/ingest', { kind: 'steam_avg', fetchedAt: now(), fileAt, items: [] });
  // Все кейсы — для «индекса кейсов» и вечернего поста в канале.
  const cases = [...steamAvg.entries()].filter(([n]) => / Case$/.test(n)).map(([name, v]) => ({ name, ...v }));
  if (cases.length) console.log('Кейсы для канала:', await toWorker('/ingest', { kind: 'cases_stats', fetchedAt: now(), items: cases.slice(0, 200) }));
} catch (e) {
  console.error('Прайс Steam:', e.message);
}

// 2б-3. Открытые инвентари Steam тех, кто привязал Steam в приложении (только чтение публичных данных, без входа в аккаунт).
// До 3 инвентарей за запуск, с паузами. Закрытый инвентарь → просим пользователя открыть его в настройках приватности Steam.
let dopplerPrices = null;
for (const s of inventorySync) {
  if (Date.now() - started > 2 * 60_000) break;
  const base = { kind: 'steam_inventory', fetchedAt: now(), tid: s.tid, steamId: s.steamId, vanity: s.vanity };
  try {
    let id = s.steamId;
    if (!id && s.vanity) {
      const r = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(s.vanity)}/?xml=1`, { headers: { 'User-Agent': UA } });
      if (r.status === 429) { await toWorker('/ingest', { ...base, status: 'rate_limited' }); break; }
      const m = (await r.text()).match(/<steamID64>(7656119\d{10})<\/steamID64>/);
      if (!m) { console.log('Инвентарь: профиль не найден', s.vanity); await toWorker('/ingest', { ...base, status: 'not_found' }); continue; }
      id = m[1];
      await sleep(STEAM_GAP_MS);
    }
    const counts = new Map();
    let start = '', pages = 0, status = 'ok';
    do {
      const q = new URLSearchParams({ l: 'english', count: '2000' });
      if (start) q.set('start_assetid', start);
      const r = await fetch(`https://steamcommunity.com/inventory/${id}/730/2?${q}`, { headers: { 'User-Agent': UA } });
      if (r.status === 429) { status = 'rate_limited'; break; }
      if (r.status === 403 || r.status === 401) { status = 'private'; break; }
      if (!r.ok) { status = r.status === 404 ? 'not_found' : 'error'; break; }
      const j = await r.json().catch(() => null);
      if (!j || j.success === false) { status = 'private'; break; }
      const desc = new Map((j.descriptions ?? []).map((d) => [`${d.classid}_${d.instanceid}`, d]));
      // Float, паттерн и сертификат каждого предмета (Steam отдаёт их в asset_properties).
      const props = new Map((j.asset_properties ?? []).map((p) => [String(p.assetid), p.asset_properties ?? []]));
      for (const a of j.assets ?? []) {
        const d = desc.get(`${a.classid}_${a.instanceid}`);
        if (!d?.market_hash_name) continue;
        const c = counts.get(d.market_hash_name) ?? { name: d.market_hash_name, qty: 0, marketable: !!d.marketable, tradable: !!d.tradable, img: d.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${d.icon_url}` : null, assets: [] };
        c.qty += Number(a.amount) || 1;
        const pr = props.get(String(a.assetid));
        if (pr && c.assets.length < 20) {
          const g = (id) => pr.find((x) => x.propertyid === id);
          const cert = decodeCertificate(g(6)?.string_value);
          const fl = g(2)?.float_value != null ? Number(g(2).float_value) : cert?.float ?? null;
          const phase = cert?.defindex != null && cert?.paintindex != null ? phases.get(`${cert.defindex}_${cert.paintindex}`) ?? null : null;
          const named = (list, names) => list.map((x) => ({ name: names.get(String(x.id)) ?? null, wear: x.wear, pattern: x.pattern })).filter((x) => x.name);
          const st = cert ? named(cert.stickers, stickerNames) : [];
          const ch = cert ? named(cert.charms, charmNames) : [];
          const usd = (n) => { const v = steamAvg.get(n); return v ? (v.d7 ?? v.d30 ?? v.d1 ?? null) : null; };
          c.assets.push({
            id: String(a.assetid), float: Number.isFinite(fl) ? fl : null, seed: g(1)?.int_value != null ? Number(g(1).int_value) : cert?.seed ?? null,
            phase, stickers: st.map((x) => ({ name: x.name, wear: x.wear ?? 0, usd: usd(x.name) })), charms: ch.map((x) => ({ name: x.name, pattern: x.pattern ?? null, usd: usd(x.name) })),
          });
        }
        counts.set(d.market_hash_name, c);
      }
      start = j.more_items ? String(j.last_assetid || '') : '';
      pages++;
      if (start) await sleep(STEAM_GAP_MS);
    } while (start && pages < 3);
    const list = [...counts.values()].slice(0, 500);
    // Цены Doppler по фазам (Ruby, Sapphire, Phase 2…) — открытый прайс CSFloat от CSGO Trader, только если есть фазы.
    if (list.some((x) => x.assets?.some((y) => y.phase))) {
      try {
        dopplerPrices ??= await (await fetch('https://prices.csgotrader.app/latest/csfloat.json', { headers: { 'User-Agent': UA } })).json();
        for (const x of list) for (const y of x.assets ?? []) {
          if (!y.phase) continue;
          const e = dopplerPrices?.[x.name];
          const v = e?.starting_at?.doppler?.[y.phase] ?? e?.doppler?.[y.phase] ?? null;
          y.phaseUsd = typeof v === 'number' && v > 0 ? v : null;
        }
      } catch (e) { console.error('Цены фаз Doppler:', e.message); }
    }
    console.log(`Инвентарь Steam ${s.tid}: ${status}, предметов ${list.length}`);
    console.log('  →', await toWorker('/ingest', { ...base, steamId: id, status, items: status === 'ok' ? list : [] }));
    if (status === 'rate_limited') break;
    // Средние цены Steam для предметов инвентаря — сразу, из уже скачанного прайса.
    if (status === 'ok' && steamAvg.size) {
      const send = list.map((x) => ({ name: x.name, ...(steamAvg.get(x.name) ?? { d1: null, d7: null, d30: null, d90: null }) }));
      for (let i = 0; i < send.length; i += 400) await toWorker('/ingest', { kind: 'steam_avg', fetchedAt: now(), items: send.slice(i, i + 400) });
    }
  } catch (e) {
    console.error('Инвентарь Steam:', e.message);
    await toWorker('/ingest', { ...base, status: 'error' }).catch(() => {});
  }
  await sleep(STEAM_GAP_MS);
}

// 2в. Другие площадки: полные прайс-листы одним запросом (публичные, без ключа).
const markets = { csgomarket: new Map(), waxpeer: new Map(), lisskins: new Map() };
const getJson = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, br' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readJson(res);
};
await Promise.all([
  getJson('https://market.csgo.com/api/v2/prices/USD.json').then((j) => {
    for (const x of j.items ?? []) if (x.market_hash_name && Number(x.price) > 0) markets.csgomarket.set(x.market_hash_name, { p: Number(x.price), q: Number(x.volume) || 0 });
  }).catch((e) => console.error('Market.CSGO:', e.message)),
  getJson('https://api.waxpeer.com/v1/prices?game=csgo&minified=1').then((j) => {
    for (const x of j.items ?? []) if (x.name && x.min > 0) markets.waxpeer.set(x.name, { p: x.min / 1000, q: x.count || 0 });
  }).catch((e) => console.error('Waxpeer:', e.message)),
  getJson('https://lis-skins.com/market_export_json/csgo.json').then((j) => {
    // unlocked_price — цена предмета без блокировки обмена (можно сразу перепродать).
    for (const x of Array.isArray(j) ? j : []) { const p = Number(x.unlocked_price ?? x.price); if (x.name && p > 0) markets.lisskins.set(x.name, { p, q: x.count || 0 }); }
  }).catch((e) => console.error('LIS-SKINS:', e.message)),
]);
console.log(`Площадки: Market.CSGO ${markets.csgomarket.size}, Waxpeer ${markets.waxpeer.size}, LIS-SKINS ${markets.lisskins.size}`);

// 2г. Рекомендации по всему рынку. Кандидаты (грубый отбор в гривнах по курсу НБУ, точный расчёт делает Worker):
// (а) где купить дешевле, чем продать на другой площадке после её комиссии; (б) Skinport ниже своей рекомендованной цены;
// (в) самые популярные — для тренда и проверки Steam. Потом — реальные продажи Skinport за 7/30 дней.
const FEE = { skinport: 0.08, csgomarket: 0.05, waxpeer: 0.05, lisskins: 0.05, steamavg: 0.15 };
const RATE = { skinport: fx.EUR || 0, csgomarket: fx.USD || 0, waxpeer: fx.USD || 0, lisskins: fx.USD || 0, steamavg: fx.USD || 0 };
let scan = [];
try {
  const sp = new Map(allItems.filter((x) => x && typeof x.market_hash_name === 'string' && x.min_price > 0).map((x) => [x.market_hash_name, x]));
  const names = new Set([...sp.keys(), ...markets.csgomarket.keys(), ...markets.waxpeer.keys(), ...markets.lisskins.keys()]);
  const offersOf = (n) => {
    const o = {};
    // Steam как площадка продажи — по средней цене продаж за неделю (если вчера были продажи).
    const sa = steamAvg.get(n);
    if (sa?.d7 > 0 && sa?.d1 > 0) o.steamavg = { p: sa.d7, q: 99 };
    const s = sp.get(n);
    if (s) o.skinport = { p: s.min_price, q: s.quantity };
    for (const m of ['csgomarket', 'waxpeer', 'lisskins']) { const v = markets[m].get(n); if (v) o[m] = v; }
    return o;
  };
  const scored = [];
  for (const n of names) {
    if (UNIQUE.test(n)) continue;
    const o = offersOf(n);
    const list = Object.entries(o).filter(([m]) => RATE[m]).map(([m, v]) => ({ m, uah: v.p * RATE[m], q: v.q }));
    if (list.length < 2) continue;
    const buyable = list.filter((x) => x.m !== 'steamavg');
    if (!buyable.length) continue;
    const buy = buyable.reduce((a, b) => (b.uah < a.uah ? b : a));
    if (buy.uah < 15) continue; // дешевле 15 грн — комиссии съедают всё
    const typical = list.map((x) => x.uah).sort((a, b) => a - b)[Math.floor(list.length / 2)];
    let bestNet = 0;
    for (const s of list) if (s.m !== buy.m && s.q >= 5 && s.uah <= typical * 1.3) bestNet = Math.max(bestNet, s.uah * 0.99 * (1 - FEE[s.m]));
    // Отсекаем заведомо нереальное: разница > 60% почти всегда ошибка/неликвид; на Skinport должно быть хотя бы 10 объявлений.
    if (bestNet > buy.uah * 1.04 && bestNet < buy.uah * 1.6 && (sp.get(n)?.quantity ?? 0) >= 10) scored.push({ n, r: bestNet / buy.uah });
  }
  scored.sort((a, b) => b.r - a.r);
  // Вчерашние идеи бота — всегда в сканировании: по ним считается честный итог «сработало / нет».
  const picked = new Set([...trackNames.filter((n) => typeof n === 'string'), ...scored.slice(0, 50).map((x) => x.n)]);
  const base = [...sp.values()].filter((x) => x.min_price >= 0.3 && x.quantity >= 3 && !UNIQUE.test(x.market_hash_name));
  for (const x of base.filter((x) => x.suggested_price > 0 && x.min_price <= x.suggested_price * 0.88)
    .sort((a, b) => a.min_price / a.suggested_price - b.min_price / b.suggested_price)) { if (picked.size >= 65) break; picked.add(x.market_hash_name); }
  for (const x of base.filter((x) => x.min_price <= 300).sort((a, b) => b.quantity - a.quantity)) { if (picked.size >= 80) break; picked.add(x.market_hash_name); }
  const byName = new Map([...picked].map((n) => {
    const { steamavg, ...offers } = offersOf(n);
    return [n, { name: n, img: images.get(n) ?? null, offers, sa: steamAvg.get(n) ?? null, s7: null, s30: null, steam: null }];
  }));
  const cands = [...picked];
  for (let i = 0; i < cands.length && skinportCalls < 7; i += SALES_CHUNK) {
    const q = new URLSearchParams({ app_id: '730', currency: 'EUR', market_hash_name: cands.slice(i, i + SALES_CHUNK).join(',') });
    const res = await fetch(`https://api.skinport.com/v1/sales/history?${q}`, { headers: { 'Accept-Encoding': 'br', 'User-Agent': UA } });
    skinportCalls++;
    if (!res.ok) { console.error(`Сканирование: продажи Skinport HTTP ${res.status}`); break; }
    for (const h of await readJson(res)) {
      const e = byName.get(h?.market_hash_name);
      if (!e) continue;
      e.s7 = h.last_7_days ? { median: h.last_7_days.median, volume: h.last_7_days.volume } : null;
      e.s30 = h.last_30_days ? { median: h.last_30_days.median, volume: h.last_30_days.volume } : null;
    }
  }
  scan = [...byName.values()];
  console.log(`Сканирование рынка: межплощадочных кандидатов ${scored.length}, отобрано ${scan.length}, с историей Skinport ${scan.filter((e) => e.s7).length}`);
} catch (e) {
  console.error('Сканирование рынка:', e.message);
}

// 2д. Новости CS2: объявления разработчиков из Steam (открытый API новостей, к рынку Steam не относится).
try {
  const r = await fetch('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=5&maxlength=600&feeds=steam_community_announcements', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const news = (j?.appnews?.newsitems ?? []).map((n) => ({ gid: String(n.gid), title: n.title, url: n.url, date: n.date, contents: n.contents }));
  if (news.length) console.log('Новости CS2:', await toWorker('/ingest', { kind: 'news', fetchedAt: now(), items: news }));
} catch (e) {
  console.error('Новости CS2:', e.message);
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
  const act = (e) => Math.max(e.s7?.volume ?? 0, ...Object.values(e.offers).map((o) => o.q || 0));
  const order = scan.filter((e) => act(e) >= 7).sort((a, b) => act(b) - act(a));
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
