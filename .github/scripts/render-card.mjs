// Рисует картинку для поста канала по заказу Worker (.cache/card.json) и отправляет её обратно (kind: 'card').
// Браузер — Chrome, который уже есть на раннере GitHub (playwright-core только управляет им).
// Локальная проверка: node render-card.mjs --file card.json --out card.jpg (без отправки).

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const card = JSON.parse(readFileSync(opt('--file') ?? '.cache/card.json', 'utf8'));

function loadPlaywright() {
  for (const base of ['/tmp/pw/', process.cwd() + '/']) {
    try { return createRequire(base)('playwright-core'); } catch { /* дальше */ }
    try { return createRequire(base)('playwright'); } catch { /* дальше */ }
  }
  throw new Error('playwright-core не найден');
}

const ACCENT = { ideas: '#3ee08f', trends: '#ffa94d', cases: '#ffd43b', weekly: '#74c0fc', rally: '#3ee08f' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const img = (u, size) => u
  ? `<div class="pic" style="width:${size}px;height:${size}px"><img src="${esc(u)}"></div>`
  : `<div class="pic none" style="width:${size}px;height:${size}px">${CASE_SVG}</div>`;
const CASE_SVG = '<svg viewBox="0 0 64 64" width="55%" height="55%"><rect x="6" y="18" width="52" height="34" rx="6" fill="currentColor" opacity=".9"/><rect x="6" y="14" width="52" height="10" rx="4" fill="currentColor"/><rect x="28" y="20" width="8" height="10" rx="2" fill="#0d1117"/></svg>';

function rows(list, size = 60) {
  return (list ?? []).map((x) => `
    <div class="row">
      ${img(x.img, size)}
      <div class="rn"><div class="nm">${esc(x.name)}</div>${x.price ? `<div class="sub">${esc(x.price)}</div>` : ''}</div>
      <div class="pill" style="color:${x.upward ? '#3ee08f' : '#ff6b6b'};background:${x.upward ? 'rgba(62,224,143,.13)' : 'rgba(255,107,107,.13)'}">${x.upward ? '▲' : '▼'} ${esc(x.pct.replace(/^[+−]/, ''))}</div>
    </div>`).join('');
}

function body(c) {
  if (c.slot === 'rally') {
    return `
      <div class="week">
        <div class="bigbox" style="width:380px;padding-top:10px"><div class="lb">ИТОГ СИМУЛЯЦИИ</div><div class="big" style="color:#3ee08f;font-size:88px;white-space:nowrap">${esc(c.big)}</div><div class="sub" style="font-size:20px">${esc(c.bigLabel)}</div>
          <div class="sub" style="margin-top:18px;font-size:17px">🔒 7 дней блокировки · комиссия Steam учтена</div></div>
        <div class="cols1">${(c.deals ?? []).map((d) => `
          <div class="row">${img(d.img, 64)}<div class="rn"><div class="nm">${esc(d.name)}</div><div class="sub">${esc(d.buyPrice)} → ${esc(d.sellPrice)}</div></div>
          <div class="pill" style="color:#3ee08f;background:rgba(62,224,143,.13)">${esc(d.profit)}</div></div>`).join('')}</div>
      </div>`;
  }
  if (c.slot === 'ideas' && c.deals?.length) {
    const [d, ...rest] = c.deals;
    return `
      <div class="hero">
        <div class="glow">${img(d.img, 300)}</div>
        <div class="hinfo">
          <div class="hname">${esc(d.name)}</div>
          <div class="flow">
            <div class="step"><div class="lb">КУПИТЬ</div><div class="mk">${esc(d.buy)}</div><div class="pr">${esc(d.buyPrice)}</div></div>
            <div class="arrow">→</div>
            <div class="step"><div class="lb">ПРОДАТЬ</div><div class="mk">${esc(d.sell)}</div><div class="pr">${esc(d.sellPrice)}</div></div>
          </div>
          <div class="profit">${esc(d.profit)} <span class="roi">${esc(d.roi)}</span></div>
          <div class="sub">чистыми, после всех комиссий</div>
        </div>
      </div>
      ${rest.length ? `<div class="more">${rest.map((x) => `<div class="chip">${img(x.img, 52)}<div><div class="cn">${esc(x.name)}</div><div class="cp">${esc(x.profit)} · ${esc(x.roi)}</div></div></div>`).join('')}</div>` : ''}`;
  }
  if (c.slot === 'weekly') {
    return `
      <div class="week">
        <div class="bigbox"><div class="big" style="color:${(c.big ?? '').startsWith('−') ? '#ff6b6b' : '#3ee08f'}">${esc(c.big)}</div><div class="sub">${esc(c.bigLabel)}</div></div>
        <div class="cols1">${c.up?.length ? `<div class="h3 g">Выросли</div>${rows(c.up.slice(0, c.down?.length ? 2 : 4), 50)}` : ''}${c.down?.length ? `<div class="h3 r">Упали</div>${rows(c.down.slice(0, 2), 50)}` : ''}</div>
      </div>`;
  }
  if (c.down?.length) {
    return `<div class="cols">
      <div><div class="h3 g">Дорожают</div>${rows(c.up?.slice(0, 3))}</div>
      <div><div class="h3 r">Дешевеют</div>${rows(c.down.slice(0, 3))}</div></div>`;
  }
  return `<div class="list">${rows(c.up?.slice(0, 4))}</div>`;
}

function html(c) {
  const a = ACCENT[c.slot] ?? '#74c0fc';
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body{margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:Inter,'Segoe UI','DejaVu Sans',sans-serif;color:#f1f3f5;
  background:radial-gradient(900px 500px at 92% -10%, ${a}33, transparent 60%),radial-gradient(700px 500px at -10% 110%, ${a}1f, transparent 60%),linear-gradient(160deg,#151b24,#0b0e13);position:relative}
body:before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:40px 40px;mask-image:linear-gradient(180deg,#000,transparent 85%)}
.wrap{position:relative;padding:40px 56px;height:100%;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:2px;font-size:18px;color:${a}}
.brand .dot{width:12px;height:12px;border-radius:50%;background:${a};box-shadow:0 0 18px ${a}}
.date{font-size:20px;color:#adb5bd;font-weight:500}
h1{font-size:54px;line-height:1;margin:14px 0 4px;font-weight:800;letter-spacing:-1.5px}
.subt{font-size:20px;color:#868e96;margin-bottom:14px}
.pic{border-radius:18px;background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center;flex:none;color:${a}}
.pic img{width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))}
.hero{display:flex;gap:40px;align-items:center;flex:1}
.glow{position:relative}.glow:before{content:'';position:absolute;inset:10%;background:${a};filter:blur(70px);opacity:.25;border-radius:50%}
.glow .pic{background:none;position:relative}
.hname{font-size:36px;font-weight:800;line-height:1.1;margin-bottom:22px}
.flow{display:flex;align-items:center;gap:16px;margin-bottom:22px}
.step{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px 20px;min-width:220px}
.lb{font-size:14px;letter-spacing:2px;color:#868e96;font-weight:700}.mk{font-size:20px;font-weight:700;margin:4px 0 2px}.pr{font-size:30px;font-weight:800}
.arrow{font-size:34px;color:#868e96}
.profit{font-size:64px;font-weight:800;color:#3ee08f;line-height:1}.roi{font-size:30px;background:rgba(62,224,143,.14);border-radius:12px;padding:4px 12px;vertical-align:middle}
.sub{font-size:17px;color:#868e96;margin-top:4px}
.more{display:flex;gap:14px;margin-top:8px}
.chip{flex:1;display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);border-radius:14px;padding:8px 12px;min-width:0}
.cn{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}.cp{font-size:16px;color:#3ee08f;font-weight:700}
.list,.cols>div,.cols1{display:flex;flex-direction:column;gap:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.row{display:flex;align-items:center;gap:16px;background:rgba(255,255,255,.045);border-radius:16px;padding:6px 16px 6px 6px}
.list .row{padding:4px 18px 4px 4px}
.rn{flex:1;min-width:0}.nm{font-size:22px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{font-size:24px;font-weight:800;border-radius:12px;padding:6px 14px;white-space:nowrap}
.h3{font-size:18px;letter-spacing:2px;font-weight:800;text-transform:uppercase;margin:2px 0}.h3.g{color:#3ee08f}.h3.r{color:#ff6b6b}
.week{display:flex;gap:40px;align-items:flex-start}.bigbox{width:340px;padding-top:40px}.big{font-size:120px;font-weight:800;letter-spacing:-4px;line-height:1}.cols1{flex:1}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;font-size:18px;color:#adb5bd;padding-top:14px}
.foot b{color:${a}}
</style></head><body><div class="wrap">
<div class="top"><div class="brand"><span class="dot"></span>ЦЕНОЛОВ · CS2</div><div class="date">${esc(c.date)}</div></div>
<h1>${esc(c.title)}</h1>${c.subtitle ? `<div class="subt">${esc(c.subtitle)}</div>` : '<div class="subt">цены в долларах · комиссии учтены</div>'}
${body(c)}
<div class="foot"><span>${esc(c.note ?? '')}</span><span>все рекомендации и уведомления — <b>в боте</b></span></div>
</div></body></html>`;
}

const { chromium } = loadPlaywright();
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
const browser = await chromium.launch(exe && !opt('--out') ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html(card), { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => undefined);
await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => undefined);
const jpg = await page.screenshot({ type: 'jpeg', quality: 88 });
await browser.close();

if (opt('--out')) {
  writeFileSync(opt('--out'), jpg);
  console.log('Сохранено:', opt('--out'), jpg.length, 'байт');
} else {
  const res = await fetch(`${process.env.WORKER_URL}/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': process.env.INGEST_SECRET },
    body: JSON.stringify({ kind: 'card', fetchedAt: Math.floor(Date.now() / 1000), id: card.id, jpg: jpg.toString('base64') }),
  });
  console.log('Картинка поста:', card.id, res.status, await res.text());
}
