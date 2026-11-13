// Сборщик цен для CS2 Market Bot. Запускается GitHub Actions по расписанию.
// Steam и Skinport блокируют сеть Cloudflare, поэтому запросы к ним делаются отсюда,
// а результаты отправляются в Worker (POST /ingest). Обхода защит нет: обычные публичные запросы
// с паузами, при 429 — пауза и остановка.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeCertificate } from './inspect.mjs';
import { russianSummary } from './patchnotes.mjs';
import { collectExtraNews } from './extranews.mjs';
import { scoreNews } from './newsscore.mjs';
import { reelLog } from './reellog.mjs';
// caseev.mjs подключается только там, где нужен (не в домашнем агенте: у него этого файла может не быть).

const WORKER = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET || '';
if (!WORKER || !SECRET) { console.error('Нужны WORKER_URL и секрет INGEST_SECRET'); process.exit(1); }

const UA = 'cs2-market-bot-collector/1.0 (personal price monitor)';
// Пауза между запросами к Steam. Дома — реже: Steam ограничивает адрес, если за пару минут сделать 20–40 запросов подряд.
const STEAM_GAP_MS = process.env.STEAM_ONLY === '1' ? 7000 : 3000;
const TIME_BUDGET_MS = 7 * 60_000;  // укладываемся в 10-минутное расписание
const STEAM_CHUNK = 25;             // предметов в одной отправке в Worker
const SALES_CHUNK = 40;
const started = Date.now();
// Режим «домашний агент» (STEAM_ONLY=1): запускается на компьютере владельца и делает только то, что требует Steam
// (цены Steam, инвентари, «Разгон»). Всё остальное (площадки, картинки, курсы, новости) собирает GitHub.
const HOME = process.env.STEAM_ONLY === '1';
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

const { items, needCatalog, fx = {}, imgCursor = 0, rally = null, steamPauseUntil = 0, newsNeedRu = [], missingImages = [], needSteamAvg = [], steamAvgAt = 0, inventorySync = [], trackNames = [], card = null, sitePriceNames = [], needCaseEv = false, collVol = [], sitePricePartial = false } = await toWorker('/ingest/items');

// Бережём Steam: не больше STEAM_MAX_REQ запросов за запуск (раньше было до ~140 — Steam отвечал 429 почти каждый запуск).
// После 429 — сразу стоп и пауза на несколько запусков (её держит Worker: steamPauseUntil, растёт 30 мин → 3 ч).
const STEAM_MAX_REQ = HOME ? 15 : 24;  // дома: 15 запросов раз в 10 минут, без рывков — так Steam не ограничивает
let homePause = 0;
if (HOME) { try { homePause = JSON.parse(readFileSync('.cache/steam_pause.json', 'utf8')).until || 0; } catch { homePause = 0; } }
const steamPaused = HOME ? homePause > now() : steamPauseUntil > now();
let steamReq = 0, steamLimited = false;
const steamCan = (reserve = 0) => !steamPaused && !steamLimited && steamReq + reserve < STEAM_MAX_REQ;
if (steamPaused) console.log(`Steam: пауза после ограничений до ${new Date(steamPauseUntil * 1000).toISOString()} — запросов к Steam не делаем`);
// Картинку поста рисует отдельный шаг (render-card.mjs) — здесь только сохраняем заказ.
if (card && card.id && !HOME) {
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/card.json', JSON.stringify(card));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'card=1\n');
  console.log('Нужна картинка для поста:', card.id);
}
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
  if (HOME) throw null; // дома Skinport нужен только для ранжирования «Разгона» — в Worker не отправляем
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
  if (e !== null) {
    console.error('Skinport каталог:', e.message);
    if (!HOME) await toWorker('/ingest', { kind: 'skinport_items', fetchedAt: now(), error: e.message }).catch(() => {});
  }
}

// 2. Skinport: история продаж (ликвидность) — порциями.
for (let i = 0; !HOME && i < items.length && i / SALES_CHUNK < 4; i += SALES_CHUNK) {
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
  const send = HOME ? [] : missingImages.filter((n) => images.has(n)).map((n) => ({ name: n, url: images.get(n) }));
  if (send.length) console.log('Картинки для наблюдения:', await toWorker('/ingest', { kind: 'images', fetchedAt: now(), items: send.slice(0, 500) }));
  // Картинки для ВСЕХ предметов (поиск, ножи, перчатки, кейсы…): по 1000 за запрос (лимит CPU Worker), до 6000 за запуск.
  // Докуда дошли, помнит Worker (imgCursor; -1 — весь каталог отправлен, раз в неделю проход повторяется).
  const all = [...images].filter(([n]) => n.length <= 200).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let at = HOME ? -1 : imgCursor ?? 0, pushed = 0;
  while (at >= 0 && at < all.length && pushed < 6000) {
    const part = all.slice(at, at + 1000);
    const next = at + part.length >= all.length ? -1 : at + part.length;
    const r = await toWorker('/ingest', { kind: 'images', fetchedAt: now(), cursor: next, items: part.map(([name, url]) => ({ name, url })) });
    if (!r?.ok) break;
    pushed += part.length; at = next;
  }
  console.log(`Картинки каталога: отправлено ${pushed}, ${at < 0 ? 'весь каталог готов' : `дальше с ${at} из ${all.length}`}`);
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
  if (cases.length && !HOME) console.log('Кейсы для канала:', await toWorker('/ingest', { kind: 'cases_stats', fetchedAt: now(), items: cases.slice(0, 200) }));
  // «Коллекции»: динамика цен по каждой коллекции из тех же двух файлов (Steam-прайс + состав ByMykel), без запросов к Steam.
  if (!HOME && steamAvg.size) {
    try {
      const r = await fetch('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/collections.json', { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`collections.json: HTTP ${r.status}`);
      const { buildCollections } = await import('./collections.mjs');
      const list = buildCollections(await r.json(), steamAvg);
      console.log('Коллекции:', list.length, await toWorker('/ingest', { kind: 'collections_stats', fetchedAt: now(), items: list }));
      // Для анализа: сводка по коллекциям с ценами (m7 — неделя к месяцу, m30 — месяц к трём, в % от 100), без секретов и личных данных.
      for (const c of list.filter((x) => x.k >= 5).sort((x, y) => (y.m30 ?? 0) - (x.m30 ?? 0))) console.log(`REEL коллекция | ${c.name} | выход ${c.rel ?? '?'} | скинов ${c.n}, с ценой ${c.k} | m7=${c.m7} m30=${c.m30} up=${c.up} | кейсы: ${c.crates.map((x) => `${x.name} d1=${x.d1} d7=${x.d7} d30=${x.d30} d90=${x.d90}`).join('; ') || '-'}`);
    } catch (e) {
      console.error('Коллекции:', e.message);
    }
  }
  // Живые цена и объём Steam по кейсам в валюте кошелька людей (Worker выбирает самые давние пары «кейс + валюта», не больше 6 за запуск; сначала то, что человек открыл в «Составе»).
  if (!HOME && collVol.length) {
    const got = [];
    for (const t of collVol.slice(0, 6)) {
      if (!steamCan(12)) break;
      try {
        const q = new URLSearchParams({ appid: '730', currency: String(t.id), market_hash_name: t.name });
        const res = await fetch(`https://steamcommunity.com/market/priceoverview/?${q}`, { headers: { 'User-Agent': UA } });
        steamReq++;
        if (res.status === 429) { steamLimited = true; console.log('Steam 429 при ценах кейсов — стоп'); break; }
        if (res.ok) { const b = await readJson(res); if (b?.success) got.push({ name: t.name, code: t.code, lowest_price: b.lowest_price, median_price: b.median_price, volume: b.volume }); }
      } catch { /* пропускаем кейс */ }
      await sleep(STEAM_GAP_MS);
    }
    if (got.length) console.log('Кейсы коллекций:', await toWorker('/ingest', { kind: 'collections_vol', fetchedAt: now(), items: got }));
  }
  // «Окупается ли кейс» — раз в сутки (по запросу Worker): состав кейсов из открытого набора ByMykel/CSGO-API.
  if (needCaseEv && !HOME) {
    try {
      const base = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
      const [crates, skins] = await Promise.all(['crates.json', 'skins.json'].map(async (f) => {
        const r = await fetch(base + f, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      }));
      const price = (n) => { const v = steamAvg.get(n); const usd = v?.d7 ?? v?.d30 ?? null; return usd && usd > 0 ? Math.round(usd * 100) : null; };
      const { computeCaseEV } = await import('./caseev.mjs');
      const ev = computeCaseEV(crates, skins, price);
      console.log('Окупаемость кейсов:', ev.length, await toWorker('/ingest', { kind: 'case_ev', fetchedAt: now(), items: ev.slice(0, 60) }));
    } catch (e) {
      console.error('Окупаемость кейсов:', e.message);
    }
  }
} catch (e) {
  console.error('Прайс Steam:', e.message);
}

// 2б-3. Открытые инвентари Steam тех, кто привязал Steam в приложении (только чтение публичных данных, без входа в аккаунт).
// До 3 инвентарей за запуск, с паузами. Закрытый инвентарь → просим пользователя открыть его в настройках приватности Steam.
let dopplerPrices = null;
/** Публичная страница инвентаря: вкладка «Counter-Strike 2» есть → открыт, Steam просто не отдал JSON (blocked); текст о приватности → private. */
let invDiag = '';
async function recheckInventoryPage(id, json) {
  const done = (st, page) => { invDiag = `JSON: ${json} · страница: ${page}`; return st; };
  try {
    await sleep(STEAM_GAP_MS);
    const r = await fetch(`https://steamcommunity.com/profiles/${id}/inventory/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    steamReq++;
    if (r.status === 429) { steamLimited = true; return done('rate_limited', 'HTTP 429'); }
    if (!r.ok) return done('error', `HTTP ${r.status}`);
    const html = await r.text();
    // Вкладка CS2 видна — открыт, что бы ещё ни было на странице.
    if (/games_list_tab_name">\s*Counter-Strike 2\s*</.test(html) || /Counter-Strike 2 \(\d+\)/.test(html)) return done('blocked', 'открыт');
    if (/inventory is currently private|profile_private_info|This profile is private|private_profile/i.test(html)) return done('private', 'закрыт');
    return done('error', 'не понять');
  } catch (e) { return done('error', 'сбой: ' + String(e.message).slice(0, 60)); }
}
for (const s of inventorySync) {
  if (Date.now() - started > 2 * 60_000 || !steamCan(14)) break;
  invDiag = '';
  const base = { kind: 'steam_inventory', fetchedAt: now(), tid: s.tid, steamId: s.steamId, vanity: s.vanity, src: HOME ? 'домашний агент' : 'сборщик GitHub' };
  try {
    let id = s.steamId;
    if (!id && s.vanity) {
      const r = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(s.vanity)}/?xml=1`, { headers: { 'User-Agent': UA } });
      steamReq++;
      if (r.status === 429) { steamLimited = true; await toWorker('/ingest', { ...base, status: 'rate_limited' }); break; }
      const m = (await r.text()).match(/<steamID64>(7656119\d{10})<\/steamID64>/);
      if (!m) { console.log('Инвентарь: профиль не найден', s.vanity); await toWorker('/ingest', { ...base, status: 'not_found' }); continue; }
      id = m[1];
      await sleep(STEAM_GAP_MS);
    }
    const counts = new Map();
    let start = '', pages = 0, status = 'ok';
    do {
      const q = new URLSearchParams({ l: 'english', count: '500' });
      if (start) q.set('start_assetid', start);
      const r = await fetch(`https://steamcommunity.com/inventory/${id}/730/2?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://steamcommunity.com/profiles/${id}/inventory/` } });
      steamReq++;
      if (r.status === 429) { status = 'rate_limited'; steamLimited = true; break; }
      // 403 / success:false серверам дата-центров бывает и у открытых инвентарей — «закрыт» решаем по публичной странице.
      if (r.status === 403 || r.status === 401) { status = await recheckInventoryPage(id, `HTTP ${r.status}`); break; }
      if (!r.ok) { status = r.status === 404 ? 'not_found' : 'error'; break; }
      const j = await r.json().catch(() => null);
      if (!j || j.success === false) { status = await recheckInventoryPage(id, j ? 'success:false' : 'пустой ответ'); break; }
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
    } while (start && pages < 8);
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
    console.log('  →', status, invDiag, await toWorker('/ingest', { ...base, steamId: id, status, diag: status === 'ok' ? `получено ${list.length} предм.` : invDiag, items: status === 'ok' ? list : [] }));
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
if (!HOME) await Promise.all([
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
const FEE = { skinport: 0.08, csgomarket: 0.05, waxpeer: 0.06, lisskins: 0.05, steamavg: 0.15 };
const RATE = { skinport: fx.EUR || 0, csgomarket: fx.USD || 0, waxpeer: fx.USD || 0, lisskins: fx.USD || 0, steamavg: fx.USD || 0 };
let scan = [];
if (!HOME) try {
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
  try { reelLog({ steamAvg, sp, markets, scored, fx }); } catch (e) { console.error('REEL:', e.message); }
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

// 2ж. Цены со всех площадок для карточек предметов (раз в несколько часов, когда Worker попросит).
// Прямые прайсы (Skinport, Market.CSGO, Waxpeer, LIS-SKINS) уже загружены выше; BUFF163, YouPin, C5GAME, CSFloat, CS.MONEY —
// из открытых файлов CSGO Trader (lowest listing). Всё в центах USD; Skinport переводим из евро по НБУ.
if (sitePriceNames.length && !HOME) {
  try {
    const extra = { buff163: 'starting_at', youpin898: 'starting_at', c5game: 'starting_at', csfloat: 'starting_at', csmoney: null };
    const files = {};
    const srcAt = { skinport: now(), csgomarket: now(), waxpeer: now(), lisskins: now() }; // прямые прайсы — загружены в этом запуске
    for (const [prov] of Object.entries(extra)) {
      try {
        const res = await fetch(`https://prices.csgotrader.app/latest/${prov}.json`, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, br' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const lm = Date.parse(res.headers.get('last-modified') || '');
        if (Number.isFinite(lm)) srcAt[prov] = Math.floor(lm / 1000); // время версии файла, а не время скачивания
        files[prov] = await readJson(res);
      } catch (e) { console.error(`CSGO Trader ${prov}:`, e.message); }
    }
    const sp = new Map(allItems.filter((x) => x && x.min_price > 0).map((x) => [x.market_hash_name, x.min_price]));
    const eurUsd = fx.EUR && fx.USD ? fx.EUR / fx.USD : null;
    const cents = (v) => (typeof v === 'number' && v > 0 && v < 1e6 ? Math.round(v * 100) : null);
    const out = [];
    for (const n of sitePriceNames.slice(0, 2000)) {
      const p = {};
      if (sp.has(n) && eurUsd) p.skinport = cents(sp.get(n) * eurUsd);
      for (const m of ['csgomarket', 'waxpeer', 'lisskins']) { const v = markets[m].get(n); if (v) p[m] = cents(v.p); }
      for (const [prov, mode] of Object.entries(extra)) {
        const x = files[prov]?.[n];
        const v = mode ? x?.[mode]?.price : x?.price;
        if (v) p[prov] = cents(Number(v));
      }
      for (const k of Object.keys(p)) if (!p[k]) delete p[k];
      if (Object.keys(p).length) out.push({ name: n, p });
    }
    for (let i = 0; i < out.length; i += 400) {
      const r = await toWorker('/ingest', { kind: 'site_prices', fetchedAt: now(), srcAt, items: out.slice(i, i + 400), done: i + 400 >= out.length, partial: sitePricePartial });
      console.log(`Цены всех площадок: ${Math.min(i + 400, out.length)}/${out.length}`, r);
    }
    if (!out.length) await toWorker('/ingest', { kind: 'site_prices', fetchedAt: now(), items: [], done: true, partial: sitePricePartial });
  } catch (e) {
    console.error('Цены всех площадок:', e.message);
  }
}

// 2е. Курсы валют к доллару (открытый файл CSGO Trader) — для валют, которых нет у НБУ (RUB, BRL, ARS).
if (!HOME) try {
  const r = await fetch('https://prices.csgotrader.app/latest/exchange_rates.json', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  console.log('Курсы к доллару:', await toWorker('/ingest', { kind: 'fx_usd', fetchedAt: now(), rates: await r.json() }));
} catch (e) {
  console.error('Курсы к доллару:', e.message);
}

// 2д. Новости CS2: объявления разработчиков из Steam (открытый API новостей, к рынку Steam не относится).
if (!HOME) try {
  const r = await fetch('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=5&maxlength=0&feeds=steam_community_announcements', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  // Важность — по полному тексту (багфиксы отсекаются, кейсы/коллекции/торговля поднимаются); в Worker уходит начало текста и оценка с причинами.
  const news = (j?.appnews?.newsitems ?? []).map((n) => {
    const sc = scoreNews({ source: 'valve', title: n.title, text: n.contents });
    console.log(`Новость Valve [${sc.imp}] ${String(n.title).slice(0, 70)} (${sc.why.join('; ')})`);
    return { gid: String(n.gid), title: n.title, url: n.url, date: n.date, contents: String(n.contents ?? '').slice(0, 4000), imp: sc.imp, why: sc.why.join('; ') };
  });
  if (news.length) console.log('Новости CS2:', await toWorker('/ingest', { kind: 'news', fetchedAt: now(), items: news }));
  // Краткое содержание на русском — для новых обновлений, которых ещё нет на русском (Worker говорит, каких именно).
  if (newsNeedRu.length) {
    const full = await fetch('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=5&maxlength=0&feeds=steam_community_announcements', { headers: { 'User-Agent': UA } });
    const fj = full.ok ? await full.json() : null;
    for (const n of (fj?.appnews?.newsitems ?? []).filter((x) => newsNeedRu.includes(String(x.gid))).slice(0, 2)) {
      try {
        const r = await russianSummary({ title: n.title, contents: n.contents }, sleep);
        console.log('Новость на русском:', n.title, await toWorker('/ingest', { kind: 'news_ru', fetchedAt: now(), gid: String(n.gid), titleRu: r.titleRu, summary: r.summary }));
      } catch (e) { console.error('Перевод новости:', e.message); }
    }
  }
} catch (e) {
  console.error('Новости CS2:', e.message);
}

// 2е. Дополнительные новости (Reddit, киберспорт, файлы игры). Пробный режим: только журнал; публикация — по переменной EXTRA_NEWS.
if (!HOME) try {
  await collectExtraNews({ UA, toWorker, now, sleep, enabled: process.env.EXTRA_NEWS });
} catch (e) {
  console.error('Доп. новости:', e.message);
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
  if (!steamCan(10)) break; // ~10 запросов оставляем «Разгону» и проверке рекомендаций
  const q = new URLSearchParams({ appid: '730', currency: '18', market_hash_name: name });
  let entry;
  try {
    const res = await fetch(`https://steamcommunity.com/market/priceoverview/?${q}`, { headers: { 'User-Agent': UA } });
    steamReq++;
    if (res.status === 429) {
      // Не долбим Steam повторно: стоп до следующего запуска, дальше — пауза (её назначит Worker).
      entry = { name, ok: false, status: 429 };
      strikes = 2; steamLimited = true;
      console.log('Steam 429 — стоп, пауза');
      batch.push(entry); break;
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
    if (Date.now() - started > TIME_BUDGET_MS + 60_000 || !steamCan(6)) break;
    try {
      const q = new URLSearchParams({ appid: '730', currency: '18', market_hash_name: e.name });
      const res = await fetch(`https://steamcommunity.com/market/priceoverview/?${q}`, { headers: { 'User-Agent': UA } });
      steamReq++;
      if (res.status === 429) { steamLimited = true; console.log('Steam 429 при проверке рекомендаций — стоп'); break; }
      if (res.ok) { const b = await readJson(res); if (b?.success) e.steam = { lowest_price: b.lowest_price, median_price: b.median_price, volume: b.volume }; }
    } catch { /* пропускаем предмет */ }
    await sleep(STEAM_GAP_MS);
  }
  try {
    console.log('Рекомендации:', await toWorker('/ingest', { kind: 'scan', fetchedAt: now(), items: scan }));
  } catch (e) { console.error('Рекомендации:', e.message); }
}
// 2з. «Разгон баланса»: дешёвые ликвидные предметы для покупки внутри Steam (только если разделом кто-то пользуется).
// Кандидаты — из открытого прайса средних продаж (без запросов к Steam), затем по ~10 за запуск — живая цена Steam
// (priceoverview: самое дешёвое объявление, медиана и число продаж за сутки) и для самых перспективных — ордер покупателя
// (itemordershistogram). Паузы между запросами; при 429 — остановка до следующего запуска. Ничего не покупается.
// Идёт ПОСЛЕ основного опроса Steam (списки наблюдения важнее) и только если Steam нас ещё не ограничил.
let steamBlocked = strikes >= 2 || !steamCan();
if (rally?.active && steamAvg.size && fx.USD && !steamBlocked && Date.now() - started < TIME_BUDGET_MS + 60_000) {
  try {
    const maxCents = Math.ceil(((rally.maxItemKop ?? 600) / 100 / fx.USD) * 100 * 1.15);
    const pop = new Map(allItems.filter((x) => x && x.market_hash_name).map((x) => [x.market_hash_name, Number(x.quantity) || 0]));
    const unique = /★|Doppler|Fade|Marble|Case Hardened|Crimson Web|Slaughter|Heat Treated|Phase/;
    const pool = [...steamAvg.entries()].filter(([n, v]) => {
      if (unique.test(n) || !(v.d1 > 0 && v.d7 > 0 && v.d30 > 0 && v.d90 > 0)) return false;
      const c = v.d7 * 100;
      return c >= 2 && c <= maxCents && Math.abs(v.d1 / v.d7 - 1) <= 0.15 && Math.abs(v.d7 / v.d30 - 1) <= 0.2;
    }).sort((a, b) => (pop.get(b[0]) ?? 0) - (pop.get(a[0]) ?? 0)).slice(0, 400).map(([n]) => n);
    const blocks = Math.max(1, Math.ceil(pool.length / 10));
    const rot = Math.floor(Date.now() / 600_000) % blocks;
    const pick = [...new Set([...(rally.names ?? []).slice(0, 6), ...pool.slice(rot * 10, rot * 10 + 10)])];
    const nameids = rally.nameids ?? {};
    const out = [], newIds = [];
    let orderCalls = 0;
    const steamGet = async (url, json = true) => {
      if (!steamCan()) { steamBlocked = true; throw new Error('лимит запросов за запуск'); }
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      steamReq++;
      if (res.status === 429) { steamBlocked = true; steamLimited = true; throw new Error('429'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? readJson(res) : res.text();
    };
    const kop = (s) => { if (typeof s !== 'string') return null; const v = Number(s.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null; };
    for (const name of pick) {
      if (steamBlocked) break;
      const sa = steamAvg.get(name) ?? null;
      const e = { name, img: images.get(name) ?? null, sa, steam: null, orders: null };
      try {
        const q = new URLSearchParams({ appid: '730', currency: '18', market_hash_name: name });
        const b = await steamGet(`https://steamcommunity.com/market/priceoverview/?${q}`);
        if (b?.success) e.steam = { lowest_price: b.lowest_price ?? null, median_price: b.median_price ?? null, volume: b.volume ?? null };
      } catch (err) { console.log('Разгон: Steam', name, err.message); }
      await sleep(STEAM_GAP_MS);
      // Ордер покупателя — только если сделка в принципе проходит по прибыли (экономим запросы к Steam).
      const low = kop(e.steam?.lowest_price), med = kop(e.steam?.median_price);
      const refs = [med, sa ? Math.round(sa.d7 * fx.USD * 100) : null, sa ? Math.round(sa.d30 * fx.USD * 100) : null].filter((x) => x > 0);
      const promising = low && refs.length >= 2 && Math.min(...refs) * 0.8 - low >= 50;
      if (promising && orderCalls < 3 && !steamBlocked) {
        try {
          let id = nameids[name];
          if (!id) {
            const html = await steamGet(`https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`, false);
            id = Number(html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/)?.[1]) || null;
            if (id) newIds.push({ name, id });
            await sleep(STEAM_GAP_MS);
          }
          if (id) {
            const h = await steamGet(`https://steamcommunity.com/market/itemordershistogram?country=UA&language=english&currency=18&item_nameid=${id}&two_factor=0`);
            if (h?.success) e.orders = { buy: Number(h.highest_buy_order) || null, sell: Number(h.lowest_sell_order) || null };
            orderCalls++;
            await sleep(STEAM_GAP_MS);
          }
        } catch (err) { console.log('Разгон: ордера', name, err.message); }
      }
      out.push(e);
    }
    console.log(`Разгон баланса: пул ${pool.length}, проверено ${out.length}, с ордерами ${out.filter((x) => x.orders).length}${steamBlocked ? ', Steam ограничил (429)' : ''}`);
    if (out.length) console.log('Разгон:', await toWorker('/ingest', { kind: 'rally_scan', fetchedAt: now(), items: out, nameids: newIds }));
  } catch (e) {
    console.error('Разгон баланса:', e.message);
  }
}

// Отчёт о Steam: Worker назначит паузу, если был 429, и снимет её после спокойного запуска.
if (HOME) {
  // Дома паузу помним сами (в файле), чтобы ограничение у GitHub не останавливало домашний агент и наоборот.
  const prev = (() => { try { return JSON.parse(readFileSync('.cache/steam_pause.json', 'utf8')); } catch { return { level: 0 }; } })();
  const level = steamLimited ? Math.min((prev.level || 0) + 1, 4) : steamPaused ? prev.level || 0 : 0;
  const until = steamLimited ? now() + [0, 30, 60, 120, 180][level] * 60 : steamPaused ? prev.until : 0;
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/steam_pause.json', JSON.stringify({ level, until }));
  console.log(`Steam (дом): запросов ${steamReq}${steamLimited ? `, получили 429 — пауза до ${new Date(until * 1000).toLocaleTimeString()}` : ''}`);
  try { await toWorker('/ingest', { kind: 'agent_ping', fetchedAt: now(), requests: steamReq, limited: steamLimited }); } catch { /* не критично */ }
} else if (!steamPaused) {
  try { console.log(`Steam: запросов ${steamReq}${steamLimited ? ', получили 429' : ''}`, await toWorker('/ingest', { kind: 'steam_limit', fetchedAt: now(), limited: steamLimited, requests: steamReq })); } catch (e) { console.error('Steam-отчёт:', e.message); }
}
console.log(`Готово за ${Math.round((Date.now() - started) / 1000)} с`);
