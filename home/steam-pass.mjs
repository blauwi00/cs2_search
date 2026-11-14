// Домашний проход живых цен Steam (план: docs/audit-2026-11-13.md, раздел 5).
// Без входа в Steam, ничего не покупает. Node ≥ 22, без зависимостей.
// Запуск: node home/steam-pass.mjs [--max N]
// Переменные окружения (секреты — только в файле окружения на ноутбуке, не в репозитории):
//   CENOLOV_URL  — адрес Worker (https://…); INGEST_SECRET — ключ приёма.
//   Без них — «сухой» режим: пачки пишутся в STATE_DIR/batches/, на сервер ничего не уходит.
//   STATE_DIR    — папка состояния (по умолчанию ~/.local/state/cenolov).
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.STATE_DIR || join(homedir(), '.local/state/cenolov');
const STATE = join(DIR, 'steam-pass.json');
const LOG = join(DIR, 'steam-pass.log');
const PAGE = 10;               // Steam без входа отдаёт 10 предметов за запрос
const BATCH = 1000;            // предметов в одной отправке
const BASE_DELAY = 5000;       // 5–6 с между запросами
const PAUSE_429 = 10 * 60_000; // пауза после 429
const maxArg = process.argv.indexOf('--max');
const MAX_REQ = maxArg > 0 ? Number(process.argv[maxArg + 1]) : Infinity;
const URL_BASE = process.env.CENOLOV_URL?.replace(/\/+$/, '');
const KEY = process.env.INGEST_SECRET?.trim();
const DRY = !URL_BASE || !KEY;

mkdirSync(join(DIR, 'batches'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const s = `${new Date().toISOString()} ${m}`; console.log(s); appendFileSync(LOG, s + '\n'); };
const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const st = { start: 0, slow: 1, total: null, passStartedAt: null, lastPassDoneAt: null, ...load() };
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2));

let batch = {};
async function flush(final = false) {
  const n = Object.keys(batch).length;
  if (!n) return;
  const body = { kind: 'steam_live', fetchedAt: Math.floor(Date.now() / 1000), items: batch, done: final };
  if (DRY) {
    writeFileSync(join(DIR, 'batches', `${Date.now()}.json`), JSON.stringify(body));
    log(`сухой режим: пачка ${n} предметов сохранена`);
  } else {
    for (let a = 1; a <= 3; a++) {
      try {
        const r = await fetch(`${URL_BASE}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': KEY }, body: JSON.stringify(body) });
        if (r.ok) { log(`отправлено ${n} предметов`); break; }
        log(`отправка: HTTP ${r.status}, попытка ${a}`);
      } catch (e) { log(`отправка: ${e}, попытка ${a}`); }
      await sleep(30_000 * a);
    }
  }
  batch = {};
}

log(`старт: позиция ${st.start}, темп x${st.slow}${DRY ? ', СУХОЙ РЕЖИМ' : ''}`);
st.passStartedAt ??= Math.floor(Date.now() / 1000);
let consec429 = 0, reqs = 0;
while (reqs < MAX_REQ) {
  const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&start=${st.start}&count=${PAGE}&sort_column=name&sort_dir=asc`;
  let status = 0, j = null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', Accept: 'application/json' } });
    status = r.status;
    if (r.ok) j = await r.json();
  } catch (e) { log(`сеть: ${e}`); }
  reqs++;
  if (status === 429) {
    consec429++;
    log(`429 на позиции ${st.start} (подряд: ${consec429})`);
    if (consec429 >= 3) { await flush(); save(); log('три 429 подряд — стоп до следующего окна'); process.exit(0); }
    st.slow = Math.min(st.slow * 2, 8); save();
    await sleep(PAUSE_429);
    continue;
  }
  consec429 = 0;
  if (j?.success && Array.isArray(j.results)) {
    st.total = j.total_count ?? st.total;
    for (const it of j.results) {
      const name = it.hash_name || it.asset_description?.market_hash_name;
      if (name && Number.isFinite(it.sell_price)) batch[name] = [it.sell_price, it.sell_listings ?? 0];
    }
    st.start += PAGE;
    if (Object.keys(batch).length >= BATCH) { await flush(); save(); }
    if (j.results.length === 0 || (st.total && st.start >= st.total)) {
      await flush(true);
      log(`проход завершён: ${st.total} предметов`);
      Object.assign(st, { start: 0, slow: 1, passStartedAt: null, lastPassDoneAt: Math.floor(Date.now() / 1000) });
      save(); process.exit(0);
    }
  } else if (status) log(`HTTP ${status} без данных на позиции ${st.start}`);
  await sleep(BASE_DELAY * st.slow + Math.random() * 1000);
}
await flush(); save();
log(`остановлено по --max на позиции ${st.start}`);
