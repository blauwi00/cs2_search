// Скетч «Переписка» (9:16, без голоса): чат Telegram, друг слил на апгрейде, второй нашёл скин дешевле.
// Входящие — «печатает…» в шапке и появление пузыря; свои — набираются по буквам в строке ввода и «отправляются».
// Диалог вымышленный, без эмодзи и без обещаний дохода (18% — разница цен между площадками, как в демо-идее).
// node gen.mjs <папка проекта>  (assets/: logo.png, sfx/, gsap.min.js)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const r2 = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const M = [
  ['L', 'опять слил на апгрейде. минус 458 грн'],
  ['L', 'а ведь в этот раз точно должно было повезти'],
  ['R', 'бро, стоп'],
  ['R', 'я вчера за вечер нашёл скин дешевле на 18%'],
  ['L', 'лудка?'],
  ['R', 'нет. бот сравнивает 12 площадок и считает комиссии'],
  ['L', 'ссылку'],
  ['R', '@cenolow_bot'],
  ['L', 'и сколько стоит'],
  ['R', 'бесплатно'],
  ['L', 'ну всё. я в деле'],
];
const T0 = 1.1, TOP = 390, BOTTOM = 1160, GAP = 20;
const CH = 24.5; // ширина символа при шрифте 46px (оценка для раскладки)
let t = T0, y = 0, js = '', msgs = '', typed = '', sfx = [];
const lay = [];
M.forEach(([who, text], i) => {
  const w = Math.min(730, 70 + Math.round(text.length * CH));
  const lines = Math.max(1, Math.ceil((text.length * CH) / (w - 70)));
  const h = 24 + lines * 58 + 40; // время — отдельной строкой снизу, не налезает на текст
  const id = `m${i}`;
  const x = who === 'L' ? 50 : 1080 - 50 - w;
  msgs += `<div class="bb ${who}" id="${id}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"><span>${esc(text)}</span><em>02:${14 + Math.floor(i / 4)}${who === 'R' ? ' ✓✓' : ''}</em></div>\n`;
  let appear;
  if (who === 'L') {
    // «печатает…» в шапке 0.5 с, затем пузырь.
    js += `  tl.set("#st", { textContent: "печатает…" }, ${r2(t)});\n  tl.set("#st", { textContent: "в сети" }, ${r2(t + 0.5)});\n`;
    appear = t + 0.5; t = appear + 0.7;
    sfx.push(['pop', appear, 0.35]);
    js += `  tl.fromTo("#${id}", { opacity: 0, scale: 0.6, x: -60, y: 30 }, { opacity: 1, scale: 1, x: 0, y: 0, duration: 0.28, ease: "back.out(1.9)" }, ${r2(appear)});\n`;
  } else {
    // набор по буквам в строке ввода, затем «отправка» — пузырь вылетает снизу.
    const typeDur = 0.3 + text.length * 0.02;
    typed += `<div class="ty" id="ty${i}">${[...text].map((c, k) => `<i id="ty${i}c${k}">${esc(c)}</i>`).join('')}</div>`;
    js += `  tl.set("#ty${i}", { opacity: 1 }, ${r2(t)});\n  tl.set("#ph", { opacity: 0 }, ${r2(t)});\n  tl.set("#ph", { opacity: 1 }, ${r2(t + typeDur + 0.12)});\n`;
    [...text].forEach((_, k) => { js += `  tl.fromTo("#ty${i}c${k}", { opacity: 0 }, { opacity: 1, duration: 0.03 }, ${r2(t + 0.15 + (typeDur - 0.15) * (k / text.length))});\n`; });
    appear = t + typeDur + 0.1; t = appear + 0.55;
    js += `  tl.set("#ty${i}", { opacity: 0 }, ${r2(appear)});\n`;
    js += `  tl.fromTo("#send", { scale: 1 }, { scale: 1.3, duration: 0.08, yoyo: true, repeat: 1 }, ${r2(appear - 0.08)});\n`;
    js += `  tl.fromTo("#${id}", { opacity: 0, scale: 0.5, y: ${BOTTOM - TOP - y + 60}, x: 40 }, { opacity: 1, scale: 1, y: 0, x: 0, duration: 0.3, ease: "expo.out" }, ${r2(appear)});\n`;
    sfx.push(['whoosh', appear, 0.22]);
  }
  // Лента «прокручивается»: низ нового сообщения не ниже линии BOTTOM.
  const bottomNow = y + h;
  lay.push({ appear, bottom: bottomNow });
  y += h + GAP;
});
lay.forEach((l) => {
  const shift = Math.max(0, l.bottom - (BOTTOM - TOP));
  js += `  tl.to("#feed", { y: ${-shift}, duration: 0.28, ease: "power3.out" }, ${r2(l.appear)});\n`;
});
const tEnd = r2(t + 0.5), DUR = r2(tEnd + 2.7);

// Вход и выход
js += `  tl.fromTo("#chat", { opacity: 0, y: 80 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, 0);\n`;
js += `  tl.fromTo("#day", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.25, ease: "back.out(2)" }, 0.5);\n`;
js += `  tl.fromTo("#bg2", { scale: 1.02 }, { scale: 1.08, duration: ${DUR}, ease: "none" }, 0);\n`;
js += `  tl.fromTo("#stage", { x: 0 }, { x: -12, duration: 0.07, yoyo: true, repeat: 3, ease: "none", immediateRender: false }, ${r2(lay[10].appear)});\n`;
// Концовка: чат уезжает, золотой финал
js += `  tl.to("#chat", { x: -1200, opacity: 1, rotation: -3, duration: 0.4, ease: "power3.in" }, ${tEnd});\n`;
js += `  tl.fromTo("#endw", { opacity: 0 }, { opacity: 1, duration: 0.1 }, ${r2(tEnd + 0.12)});\n`;
js += `  tl.fromTo("#elg", { scale: 0.3, rotation: -25, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, ${r2(tEnd + 0.2)});\n`;
js += `  tl.fromTo("#enm i", { opacity: 0, y: 70 }, { opacity: 1, y: 0, duration: 0.22, stagger: 0.05, ease: "back.out(2)" }, ${r2(tEnd + 0.28)});\n`;
js += `  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, ${r2(tEnd + 0.7)});\n`;
js += `  tl.fromTo("#efr", { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, ${r2(tEnd + 1.1)});\n`;
sfx.push(['whoosh', tEnd, 0.3], ['pop', tEnd + 0.22, 0.45], ['pop', tEnd + 1.12, 0.55]);
const sfxHtml = sfx.map(([n, at, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${n}.wav" data-start="${r2(at)}" data-duration="${n === 'pop' ? 0.12 : 0.45}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #0b141d; }
  #main { font-family: Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage, #bg2 { position: absolute; inset: 0; }
  #bg2 { background: radial-gradient(900px 800px at 50% 30%, rgba(60,110,170,.22), transparent 70%), repeating-linear-gradient(60deg, rgba(255,255,255,.025) 0 2px, transparent 2px 36px), #0b141d; }
  #chat { position: absolute; inset: 0; }
  #hdr { position: absolute; left: 0; right: 0; top: 190px; height: 120px; background: #17212b; border-bottom: 1px solid rgba(255,255,255,.06); }
  #av { position: absolute; left: 36px; top: 20px; width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #f6d98a, #a8741f); font-size: 40px; font-weight: 800; color: #1a1305; display: grid; place-items: center; }
  #nm { position: absolute; left: 140px; top: 22px; font-size: 40px; font-weight: 700; }
  #st { position: absolute; left: 140px; top: 70px; font-size: 28px; color: #6ab3f3; }
  #day { position: absolute; left: 0; right: 0; top: 330px; margin: auto; width: 200px; text-align: center; font-size: 26px; font-weight: 600; color: #aab6c3; background: rgba(23,33,43,.8); border-radius: 999px; padding: 8px 0; opacity: 0; z-index: 3; }
  #view { position: absolute; left: 0; right: 0; top: ${TOP}px; height: ${BOTTOM - TOP}px; overflow: hidden; -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 40px); mask-image: linear-gradient(180deg, transparent 0, #000 40px); }
  #feed { position: absolute; left: 0; top: 0; width: 1080px; }
  .bb { position: absolute; box-sizing: border-box; padding: 14px 28px 0; border-radius: 34px; font-size: 46px; line-height: 58px; opacity: 0; }
  .bb.L { background: #182533; border-bottom-left-radius: 10px; }
  .bb.R { background: linear-gradient(180deg, #f6d98a, #dcab48); color: #1a1305; border-bottom-right-radius: 10px; }
  .bb em { position: absolute; right: 26px; bottom: 10px; font-style: normal; font-size: 22px; opacity: .6; }
  #inp { position: absolute; left: 30px; right: 30px; top: ${BOTTOM + 40}px; height: 100px; border-radius: 50px; background: #17212b; }
  #ph { position: absolute; left: 40px; top: 0; line-height: 100px; font-size: 42px; color: #6c7a89; }
  .ty { position: absolute; left: 40px; right: 130px; top: 0; line-height: 100px; font-size: 44px; white-space: nowrap; overflow: hidden; opacity: 0; }
  .ty i { font-style: normal; }
  #send { position: absolute; right: 14px; top: 12px; width: 76px; height: 76px; border-radius: 50%; background: linear-gradient(180deg, #f6d98a, #c88e2c); display: grid; place-items: center; }
  #send svg { width: 38px; height: 38px; }
  #endw { position: absolute; inset: 0; opacity: 0; background: radial-gradient(800px 700px at 50% 36%, rgba(231,178,76,.34), transparent 70%), #060606; }
  #elg { position: absolute; left: 380px; top: 280px; width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.55); }
  #enm { position: absolute; left: 0; right: 0; top: 660px; text-align: center; font: 900 140px/1 Montserrat, sans-serif; letter-spacing: -3px; text-transform: uppercase; }
  #enm i { display: inline-block; font-style: normal; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 860px; text-align: center; white-space: nowrap; font: 900 54px/1 Montserrat, sans-serif; padding: 24px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1040px; text-align: center; font: 900 76px/1.2 Montserrat, sans-serif; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; opacity: 0; }
</style>
</head>
<body>
<!-- Скетч «Переписка» (9:16). Сгенерировано video/edit3/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div id="bg2"></div>
  <div id="chat">
    <div id="hdr"><div id="av">Б</div><div id="nm">Бро</div><div id="st">в сети</div></div>
    <div id="day">Сегодня</div>
    <div id="view"><div id="feed">
${msgs}    </div></div>
    <div id="inp"><div id="ph">Сообщение</div>${typed}<div id="send"><svg viewBox="0 0 24 24" fill="none" stroke="#1a1305" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></div></div>
  </div>
  <div id="endw"><img id="elg" src="assets/logo.png" alt=""><div id="enm">${[...'Ценолов'].map((c) => `<i>${c}</i>`).join('')}</div><div id="etg">@cenolow_bot · Telegram</div><div id="efr">БЕСПЛАТНО</div></div>
 </div>
${sfxHtml}
</div>
<script>
  window.__timelines = window.__timelines || {};
  var tl = gsap.timeline({ paused: true });
${js}
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
writeFileSync(join(DIR, 'index.html'), page);
console.log('ok, длительность', DUR, 'с');
