// Русские названия скинов из Steam (l=russian) за один износ: обход рынка и отправка в Worker (kind steam_live, третий элемент — русское имя).
// Цены при этом настоящие (самое дешёвое объявление Steam), поэтому заодно обновляют живые цены. Запуск: WEAR=0..4 node runames.mjs
const WORKER = process.env.WORKER_URL, SECRET = process.env.INGEST_SECRET, WEAR = process.env.WEAR || '0';
if (!WORKER || !SECRET) { console.error('Нужны WORKER_URL и INGEST_SECRET'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
async function page(start) {
  for (let t = 0; t < 6; t++) {
    const u = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&l=russian&start=${start}&sort_column=name&sort_dir=asc&category_730_Exterior%5B%5D=tag_WearCategory${WEAR}`;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.results)) return j; }
      console.log('http', r.status, 'start', start);
    } catch (e) { console.log('err', String(e).slice(0, 80)); }
    await sleep(30000 * (t + 1));
  }
  return null;
}
async function send(items, last) {
  const r = await fetch(`${WORKER}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Ingest-Secret': SECRET },
    body: JSON.stringify({ kind: 'steam_live', fetchedAt: Math.floor(Date.now() / 1000), items, rebuild: last }) });
  console.log('send', Object.keys(items).length, r.status, (await r.text()).slice(0, 100));
}
let start = 0, total = 1, buf = {}, got = 0;
while (start < total) {
  const j = await page(start);
  if (!j) { console.log('сдаюсь на', start); break; }
  total = j.total_count || 0;
  for (const x of j.results) if (x.hash_name && x.sell_price > 0) { buf[x.hash_name] = [x.sell_price, x.sell_listings, x.name]; got++; }
  start += 10;
  if (Object.keys(buf).length >= 400) { await send(buf, false); buf = {}; }
  await sleep(3200);
}
await send(buf, true);
console.log('готово', got, 'из', total);
