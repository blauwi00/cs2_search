// Кадры ролика в PNG: node shot.cjs <страница.html[?…]> <папка> <t…>  (как render.mjs: frameAt(t) и снимок)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const [,, page, out, ...ts] = process.argv; fs.mkdirSync(out, { recursive: true });
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  p.on('pageerror', (e) => { console.log('ERR', e.message); process.exitCode = 1; });
  const [f, q] = page.split('?'); await p.goto('file://' + path.resolve(f) + (q ? '?' + q : '')); await p.waitForTimeout(800);
  for (const t of ts) { await p.evaluate((x) => window.frameAt(x), +t); await p.screenshot({ path: `${out}/t${t}.png` }); }
  await b.close(); })();
