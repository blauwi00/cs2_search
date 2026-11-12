// Слайды для ТТ: настоящее приложение (src/webapp/app.html, тема «Золото») 1080x1920 + заголовок поверх.
// API подменён: данных нет, ничего не выдумано.
import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const html = fs.readFileSync(new URL('../../src/webapp/app.html', import.meta.url), 'utf8');
const TRADE = 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=abcd';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 1080 / 390, isMobile: true, hasTouch: true });
const pg = await ctx.newPage();
await ctx.route('https://app.test/**', (r) => {
  const p = new URL(r.request().url()).pathname;
  if (p === '/app') return r.fulfill({ contentType: 'text/html', body: html });
  if (p.endsWith('/tradeurl')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, url: TRADE, getUrl: '' }) });
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
});
await pg.goto('https://app.test/app'); await pg.waitForTimeout(1500);
const head = (t, s) => pg.evaluate(([t, s]) => {
  document.getElementById('hl')?.remove();
  var d = document.createElement('div'); d.id = 'hl';
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:30px 20px 14px;background:linear-gradient(#0b0b0b 85%,rgba(11,11,11,0));height:150px;overflow:hidden;pointer-events:none';
  d.innerHTML = '<div style="font-size:12px;letter-spacing:2px;font-weight:800;color:#e7b24c;margin-bottom:10px">ЦЕНОЛОВ</div><div style="font-size:26px;line-height:1.1;font-weight:800;color:#fff;margin-bottom:8px">' + t + '</div><div style="font-size:14px;line-height:1.35;color:#c9bfa8">' + s + '</div>';
  document.body.appendChild(d);
}, [t, s]);
const shot = (n) => pg.screenshot({ path: `slide${n}.png` });
// 1. меню «Ещё»
await pg.click('.tab[data-t=more]'); await pg.waitForTimeout(800);
await pg.evaluate(() => { document.querySelector('.top').style.visibility = 'hidden'; document.querySelector('#view').style.paddingTop = '160px'; });
await head('Ценолов бесплатный', 'Останется таким всегда. Помощь по желанию: Ещё → Поддержать проект');
await pg.evaluate(() => { var r = document.querySelector('#m-support'); r.style.outline = '2px solid #f6d98a'; r.style.outlineOffset = '-2px'; document.querySelector('#view').style.paddingBottom = '40px'; window.scrollTo(0, 99999); r.scrollIntoView({block:'center'}); });
await shot(1);
// 2. звёзды
await pg.click('#m-support'); await pg.waitForTimeout(1200);
await pg.evaluate(() => { var s = document.querySelector('#sheet'); s.style.maxHeight = 'calc(100vh - 140px)'; s.scrollTop = 0; });
await head('Поддержать звёздами', 'Оплата внутри Telegram. Это просто «спасибо», ничего не открывает');
await shot(2);
// 3. скины
await pg.evaluate(() => { document.querySelector('#sheet').scrollTop = 330; });
await head('Или скином в подарок', 'Нажал «Я отправил обмен» — бот сам сообщит автору, для чего скин. Писать не нужно');
await shot(3);
await b.close();
