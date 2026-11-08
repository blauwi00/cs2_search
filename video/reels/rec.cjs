// Запись живых клипов приложения (локальная копия бота): CDP screencast в высоком разрешении → mp4 30 к/с.
// Палец — полупрозрачный круг: подъезжает к кнопке, нажимает, нажатие и вызывает следующий экран.
// node rec.cjs <clip> [<clip>…]   клипы: home ideas prices inv locked buys
const { chromium } = require('playwright');
const fs = require('fs');
const { execFileSync } = require('child_process');
const DIR = (process.env.VID_DIR || __dirname + '/work') + '/clips';
fs.mkdirSync(DIR, { recursive: true });
const W = 390, H = 844, DSF = 3;

const FINGER = `(() => {
  const f = document.createElement('div'); f.id = '__f';
  f.style.cssText = 'position:fixed;left:0;top:0;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;background:rgba(255,255,255,.28);border:3px solid rgba(255,255,255,.92);box-shadow:0 6px 24px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;opacity:0;transition:transform .45s cubic-bezier(.22,1,.36,1),opacity .2s;transform:translate(330px,900px)';
  const r = document.createElement('div'); r.id = '__r';
  r.style.cssText = 'position:fixed;left:0;top:0;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;border:3px solid rgba(255,255,255,.9);pointer-events:none;z-index:2147483646;opacity:0';
  const add = () => { document.body.appendChild(r); document.body.appendChild(f); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  window.__fx = 330; window.__fy = 900;
  window.__move = (x, y) => { f.style.opacity = '1'; f.style.transform = 'translate(' + x + 'px,' + y + 'px)'; window.__fx = x; window.__fy = y; };
  window.__press = () => {
    f.style.transition = 'transform .12s ease-out'; f.style.transform = 'translate(' + __fx + 'px,' + __fy + 'px) scale(.78)';
    r.style.transition = 'none'; r.style.opacity = '.9'; r.style.transform = 'translate(' + __fx + 'px,' + __fy + 'px) scale(1)';
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transition = 'transform .45s ease-out,opacity .45s ease-out'; r.style.opacity = '0'; r.style.transform = 'translate(' + __fx + 'px,' + __fy + 'px) scale(2.2)'; }));
    setTimeout(() => { f.style.transform = 'translate(' + __fx + 'px,' + __fy + 'px) scale(1)'; setTimeout(() => { f.style.transition = 'transform .45s cubic-bezier(.22,1,.36,1),opacity .2s'; }, 130); }, 140);
  };
  window.__hide = () => { f.style.opacity = '0'; };
})();`;

async function record(name, steps) {
  const init = await (await fetch('http://localhost:8787/init')).text();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF, colorScheme: 'dark', hasTouch: false });
  await ctx.addInitScript((initData) => { try { localStorage.setItem('theme', 'neon'); } catch (e) {} window.Telegram = { WebApp: { initData, initDataUnsafe: {}, ready() {}, expand() {}, onEvent() {}, offEvent() {}, setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {}, HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} }, BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} }, MainButton: { show() {}, hide() {} }, themeParams: {}, colorScheme: 'dark', platform: 'ios', version: '8.0', isVersionAtLeast() { return true; }, openLink() {}, openTelegramLink() {}, disableVerticalSwipes() {}, requestFullscreen() {}, lockOrientation() {}, showConfirm(m, cb) { cb(true); } } }; }, init);
  await ctx.addInitScript(FINGER);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await p.goto('http://localhost:8787/app');
  await p.waitForTimeout(2200);
  const frames = [];
  const cdp = await ctx.newCDPSession(p);
  cdp.on('Page.screencastFrame', async (f) => { frames.push({ t: f.metadata.timestamp, data: f.data }); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  const t0 = Date.now() / 1000;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 });
  const marks = [];
  const api = {
    p, wait: (ms) => p.waitForTimeout(ms),
    mark: (label) => marks.push({ label, t: Date.now() / 1000 - t0 }),
    async tap(sel, opt = {}) {
      const el = typeof sel === 'string' ? await p.waitForSelector(sel, { timeout: 8000 }) : sel;
      const bx = await el.boundingBox();
      const x = bx.x + (opt.dx ?? bx.width / 2), y = bx.y + (opt.dy ?? bx.height / 2);
      await p.evaluate(([x, y]) => window.__move(x, y), [x, y]); await p.waitForTimeout(opt.travel ?? 520);
      marks.push({ label: 'tap:' + (opt.label || sel), t: Date.now() / 1000 - t0 });
      await p.evaluate(() => window.__press()); await p.waitForTimeout(90);
      await p.mouse.click(x, y); await p.waitForTimeout(220); if (!opt.keep) await p.evaluate(() => window.__hide()); await p.waitForTimeout(Math.max(0, (opt.after ?? 700) - 220));
    },
    async type(text, ms = 110) { for (const ch of text) { await p.keyboard.type(ch); await p.waitForTimeout(ms); } },
    async scroll(dy, ms = 900, sel = null) {
      await p.evaluate(([dy, ms, sel]) => new Promise((res) => {
        const el = sel ? document.querySelector(sel) : (document.scrollingElement || document.documentElement);
        const y0 = el.scrollTop, t0 = performance.now();
        const step = (t) => { const k = Math.min(1, (t - t0) / ms); const e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; el.scrollTop = y0 + dy * e; if (k < 1) requestAnimationFrame(step); else res(); };
        requestAnimationFrame(step);
      }), [dy, ms, sel]);
    },
    hide: () => p.evaluate(() => window.__hide()),
  };
  // Кадр-«пульс»: пока экран не меняется, screencast молчит — держим последний кадр.
  await steps(api);
  await p.waitForTimeout(400);
  await cdp.send('Page.stopScreencast');
  const tEnd = Date.now() / 1000;
  await b.close();
  // Склейка: каждый кадр держится до следующего; первый кадр — с начала записи.
  const fd = DIR + '/' + name; fs.rmSync(fd, { recursive: true, force: true }); fs.mkdirSync(fd);
  const list = [];
  const base = frames.length ? frames[0].t : 0;
  frames.forEach((f, i) => {
    const fn = `${fd}/f${String(i).padStart(5, '0')}.jpg`; fs.writeFileSync(fn, Buffer.from(f.data, 'base64'));
    const next = i + 1 < frames.length ? frames[i + 1].t : base + (tEnd - t0);
    list.push(`file '${fn}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  list.push(`file '${fd}/f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  fs.writeFileSync(fd + '/list.txt', list.join('\n'));
  // Метки — относительно первого кадра.
  const shift = base - (frames.length ? frames[0].t : 0);
  fs.writeFileSync(`${DIR}/${name}.json`, JSON.stringify({ marks: marks.map((m) => ({ ...m, t: +(m.t - shift).toFixed(2) })), frames: frames.length }, null, 1));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', fd + '/list.txt', '-vf', 'scale=1080:-2:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', `${DIR}/${name}.mp4`]);
  fs.rmSync(fd, { recursive: true, force: true });
  console.log(name, 'frames', frames.length, 'marks', JSON.stringify(marks.map((m) => m.label + '@' + m.t.toFixed(2))));
}

const CLIPS = {
  async home(a) { await a.wait(900); await a.tap('.tab[data-t=deals]', { label: 'ideas' }); await a.wait(1500); await a.scroll(260, 1100); await a.wait(900); },
  async ideas(a) {
    await a.p.click('.tab[data-t=deals]'); await a.wait(1400);
    await a.wait(600); await a.scroll(150, 900); await a.wait(1600); await a.scroll(-150, 700); await a.wait(500);
  },
  async prices(a) {
    await a.p.click('.tab[data-t=market]'); await a.wait(1300);
    await a.tap('#pq', { label: 'search' }); await a.type('ak-47 sl', 120); await a.wait(1400);
    await a.tap(await a.p.locator('[data-pick]', { hasText: 'Slate (Field-Tested)' }).filter({ hasNotText: 'StatTrak' }).first().elementHandle(), { label: 'item' }); await a.wait(1600); await a.scroll(520, 1300, '.sheet .body, .sheet'); await a.wait(1800);
  },
  async inv(a) {
    await a.p.click('.tab[data-t=inv]'); await a.wait(1500); await a.wait(700);
    await a.tap('[data-sinv]', { label: 'skin' }); await a.wait(1500); await a.scroll(560, 1300, '.sheet .body, .sheet'); await a.wait(1800);
  },
  async locked(a) {
    await a.p.click('.tab[data-t=inv]'); await a.wait(1500);
    await a.scroll(2000, 1600); await a.wait(1800);
  },
  async buys(a) {
    await a.p.click('.tab[data-t=inv]'); await a.wait(1400);
    await a.tap('#skseg button[data-k=mine]', { label: 'buys' }); await a.wait(2200);
  },
};

(async () => {
  for (const n of process.argv.slice(2)) await record(n, CLIPS[n]);
})();
