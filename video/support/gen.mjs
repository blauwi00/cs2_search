// 3 слайда для карусели ТТ: «Поддержать проект» (1080x1920)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const row=(ic,n,d,hl)=>`<div class="r${hl?' hl':''}"><div class="ic">${ic}</div><div><div class="rn">${n}</div><div class="rd">${d}</div></div></div>`;
const mocks = {
 1: `<div class="ph"><div class="ttl">Что умеет Ценолов</div>
   ${row('🛒','Цены на всех площадках','Где купить дешевле, где продать дороже')}
   ${row('📈','Графики цен и инвентаря','Приближай и двигай пальцем')}
   ${row('🔔','Уведомления о выгодных сделках','Бот сам пишет, когда есть прибыль')}
   ${row('💳','Идеи под твой баланс Steam','Куда потратить, чтобы вернуть больше')}
   <div class="free">Без подписок и рекламы</div></div>`,
 2: `<div class="ph"><div class="ttl">💛 Поддержать Ценолова</div>
   <div class="sub">Бот бесплатный и работает круглосуточно. Всё добровольно.</div>
   <div class="g">${[25,50,100,250,500].map(n=>`<div class="bt">⭐ ${n}</div>`).join('')}</div>
   <div class="sub" style="margin-top:34px">🎁 Скин в подарок: кому пойдёт?</div>
   <div class="seg"><div class="on">Розыгрыш подписчикам</div><div>Подарок автору</div></div>
   <div class="btn2">Открыть трейд-ссылку</div></div>`,
 3: `<div class="ph"><div class="ttl">Ещё</div>
   ${row('🎁','Пригласить друга','Отправь ссылку на бота')}
   ${row('⚙️','Настройки','Валюта, пороги, уведомления')}
   ${row('💳','Баланс Steam','Бот подбирает идеи под него')}
   ${row('✉️','Связь с автором','Канал, предложить пост')}
   ${row('💛','Поддержать проект','Звёздами Telegram или скином в подарок',1)}</div>`,
};
const slides = [
  { n: 1, t: 'Ценолов бесплатный', s: 'И всегда таким останется.<br>Помощь — только по желанию.' },
  { n: 2, t: 'Хочешь помочь — два способа', s: '⭐ Звёзды Telegram<br>🎁 Скин в подарок' },
  { n: 3, t: 'Где это найти', s: 'Бот → Ещё → Поддержать проект.<br>Не хочешь — ничего не теряешь.' },
];
const html = (x) => `<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1920px;background:radial-gradient(900px 700px at 80% 5%,#e0a93a33,transparent),#0f0d09;color:#eef1f6;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;padding:110px 70px;position:relative}
.logo{font-size:44px;font-weight:800;color:#8a93a6;letter-spacing:2px;margin-bottom:70px}
h1{font-size:92px;line-height:1.1;font-weight:800;margin-bottom:36px}
p{font-size:52px;line-height:1.4;color:#c9cfdc}
.xdots{position:absolute;bottom:70px;left:0;right:0;display:flex;gap:18px;justify-content:center}
.dots i{width:22px;height:22px;border-radius:50%;background:#3a3f4d}
.dots i.on{background:#f2a93b;width:70px;border-radius:12px}
.ph{position:absolute;left:70px;right:70px;top:790px;background:#1a160d;border:3px solid #4a3a1a;border-radius:56px;padding:46px 40px;box-shadow:0 30px 90px #0009}
.ttl{font-size:50px;font-weight:800;margin-bottom:26px;color:#f3c35a}
.sub{font-size:34px;color:#8a93a6;line-height:1.35}
.r{display:flex;gap:28px;align-items:center;background:#241d10;border-radius:28px;padding:26px 30px;margin-top:16px}
.r.hl{background:#4a3811;outline:4px solid #f3c35a}
.ic{font-size:60px;width:84px;text-align:center}
.rn{font-size:40px;font-weight:700}.rd{font-size:29px;color:#8a93a6;margin-top:4px}
.free{margin-top:26px;text-align:center;font-size:38px;font-weight:800;color:#f3c35a}
.g{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:30px}
.bt{background:#2e2412;border-radius:26px;padding:30px 0;text-align:center;font-size:42px;font-weight:700}
.seg{display:flex;background:#2e2412;border-radius:26px;padding:8px;margin-top:20px;font-size:32px;font-weight:700;text-align:center}
.seg div{flex:1;padding:24px 10px;border-radius:20px;color:#8a93a6}.seg .on{background:#e0a93a;color:#1a1204}
.btn2{margin-top:26px;background:linear-gradient(180deg,#f3c35a,#d19a2b);color:#1a1204;border-radius:26px;padding:30px;text-align:center;font-size:40px;font-weight:800}
</style><div class=logo>ЦЕНОЛОВ</div><h1>${x.t}</h1><p>${x.s}</p>${mocks[x.n]}
`;
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1080, height: 1920 } });
for (const x of slides) { await pg.setContent(html(x)); await pg.screenshot({ path: `slide${x.n}.png` }); }
await b.close();
