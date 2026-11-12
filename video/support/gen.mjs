// Слайды для ТТ: дизайн вокруг настоящего экрана приложения (src/webapp/app.html, тема «Золото»).
// API подменён пустыми ответами: данных нет, ничего не выдумано.
import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const html = fs.readFileSync(new URL('../../src/webapp/app.html', import.meta.url), 'utf8');
const TRADE = 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=abcd';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const pg = await ctx.newPage();
await ctx.route('https://app.test/**', (r) => {
  const p = new URL(r.request().url()).pathname;
  if (p === '/app') return r.fulfill({ contentType: 'text/html', body: html });
  if (p.endsWith('/tradeurl')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, url: TRADE, getUrl: '' }) });
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
});
await pg.goto('https://app.test/app'); await pg.waitForTimeout(1500);
const raw = {};
const grab = async (k) => { raw[k] = 'data:image/png;base64,' + (await pg.screenshot()).toString('base64'); };
await pg.click('.tab[data-t=more]'); await pg.waitForTimeout(700);
await pg.evaluate(() => { var r = document.querySelector('#m-support'); r.style.outline = '2px solid #f6d98a'; r.style.outlineOffset = '-2px'; });
await grab('menu');
await pg.click('#m-support'); await pg.waitForTimeout(1200);
await pg.evaluate(() => { var s = document.querySelector('#sheet'); s.style.maxHeight = '100vh'; s.scrollTop = 0; });
await pg.evaluate(() => { document.querySelector('#sheet').scrollTop = 150; }); await pg.waitForTimeout(300);
await grab('stars');
await pg.evaluate(() => { document.querySelector('#sheet').scrollTop = 99999; }); await pg.waitForTimeout(300);
await grab('skin');

const slides = [
  { img: 'menu', kick: 'ЦЕНОЛОВ', h: 'Поддержи<br><span>Ценолов</span>', p: 'Бот бесплатный и таким останется. Поддержка автора только по желанию.', chips: [['top:625px;right:70px', 'Ещё → Поддержать проект ↓']] },
  { img: 'stars', kick: 'СПОСОБ 1', h: 'Отправь<br><span>звёзды</span>', p: 'Звёзды Telegram автору. Один тап, оплата внутри Telegram.', shift: 250, chips: [['top:625px;left:70px', 'добровольно']] },
  { img: 'skin', kick: 'СПОСОБ 2', h: 'Подари<br><span>скин</span>', p: 'Автору или в розыгрыш подписчикам. Писать ничего не нужно.', shift: 330, chips: [['top:610px;left:70px;font-size:30px;padding:18px 28px', '1 · выбери цель'], ['top:610px;left:372px;font-size:30px;padding:18px 28px', '2 · отправь обмен'], ['top:610px;left:700px;font-size:30px;padding:18px 28px', '3 · «Я отправил»']] },
];
const page = (x) => `<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1920px;overflow:hidden;position:relative;background:#0b0b0b;color:#fff;font-family:-apple-system,"Inter","Helvetica Neue",Arial,sans-serif}
.bg{position:absolute;inset:0;background:radial-gradient(900px 800px at 85% 18%,rgba(231,178,76,.28),transparent 70%),radial-gradient(700px 600px at 0% 100%,rgba(231,178,76,.16),transparent 70%),repeating-linear-gradient(115deg,rgba(231,178,76,.035) 0 2px,transparent 2px 46px)}
.k{position:absolute;left:70px;top:90px;font-size:34px;letter-spacing:7px;font-weight:800;color:#e7b24c}
h1{position:absolute;left:70px;top:150px;font-size:130px;line-height:1.02;font-weight:900;letter-spacing:-2px}
h1 span{background:linear-gradient(135deg,#f6d98a,#e7b24c 50%,#a8741f);-webkit-background-clip:text;color:transparent}
.p{position:absolute;left:70px;top:455px;width:900px;font-size:44px;line-height:1.35;color:#d8cfb8}
.ph{position:absolute;left:150px;top:720px;overflow:hidden;width:780px;height:1500px;border-radius:84px 84px 0 0;border:5px solid #6e5a2c;border-bottom:none;padding:14px 14px 0;background:#000;box-shadow:0 0 140px rgba(231,178,76,.35),0 40px 120px #000}
.ph img{width:100%;border-radius:70px 70px 0 0;display:block}
.chip{position:absolute;padding:24px 38px;border-radius:999px;font-size:40px;font-weight:800;color:#1a1305;background:linear-gradient(135deg,#f6d98a,#e7b24c 45%,#a8741f);box-shadow:0 14px 40px rgba(0,0,0,.6),0 0 40px rgba(231,178,76,.4)}
</style><div class=bg></div><div class=k>${x.kick}</div><h1>${x.h}</h1><div class=p>${x.p}</div>
<div class=ph><img style="margin-top:-${x.shift||0}px" src="${raw[x.img]}"></div>${x.chips.map(([pos, t]) => `<div class=chip style="${pos}">${t}</div>`).join('')}`;
const ctx2 = await b.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 }); const out = await ctx2.newPage();
let n = 1;
for (const x of slides) { await out.setContent(page(x)); await out.waitForTimeout(300); await out.screenshot({ path: `slide${n++}.png` }); }
await b.close();
