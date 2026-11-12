// 3 слайда для карусели ТТ: «Поддержать проект» (1080x1920)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const slides = [
  { n: 1, ico: '🔓', t: 'Ценолов бесплатный', s: 'И всегда таким останется.<br>Поддержка — только по желанию.', nav: 'листай →' },
  { n: 2, ico: '💛', t: 'Хочешь помочь — два способа', s: '<b>⭐ Звёзды Telegram</b><br>топ поддержки виден в приложении<br><br><b>🎁 Скин в подарок</b><br>в розыгрыш подписчикам или автору', nav: 'листай →' },
  { n: 3, ico: '👆', t: 'Где это найти', s: 'Бот → <b>Ещё</b> →<br><b>💛 Поддержать проект</b><br><br>Не хочешь — ничего не теряешь.<br>Всё работает так же.', nav: 'ссылка на бота в профиле' },
];
const html = (x) => `<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1920px;background:radial-gradient(900px 700px at 80% 10%,#2a2f6b55,transparent),#0f1115;color:#eef1f6;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;padding:120px 80px;position:relative}
.logo{font-size:44px;font-weight:800;color:#8a93a6;letter-spacing:2px}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center}
.ico{font-size:200px;line-height:1;margin-bottom:60px}
h1{font-size:104px;line-height:1.08;font-weight:800;margin-bottom:60px}
p{font-size:56px;line-height:1.4;color:#c9cfdc}
b{color:#fff}
.dots{display:flex;gap:18px;justify-content:center;margin-bottom:40px}
.dots i{width:22px;height:22px;border-radius:50%;background:#3a3f4d}
.dots i.on{background:#f2a93b;width:70px;border-radius:12px}
.nav{text-align:center;font-size:48px;color:#f2a93b;font-weight:700;padding-bottom:60px}
</style><div class=logo>ЦЕНОЛОВ</div><div class=mid><div class=ico>${x.ico}</div><h1>${x.t}</h1><p>${x.s}</p></div>
<div class=dots>${[1,2,3].map(i=>`<i class="${i===x.n?'on':''}"></i>`).join('')}</div><div class=nav>${x.nav}</div>`;
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1080, height: 1920 } });
for (const x of slides) { await pg.setContent(html(x)); await pg.screenshot({ path: `slide${x.n}.png` }); }
await b.close();
