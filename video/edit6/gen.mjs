// Ролик «Угадай цену» (9:16, 20 с, без голоса): 4 раунда — скин, три варианта, таймер 3-2-1, настоящая цена Steam.
// Цены — медианы Steam на 11.11 (priceoverview, UAH); перед новой сборкой обновите.
// node gen.mjs <папка проекта>  (assets/: logo.png, sfx/, gsap.min.js, картинки скинов)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const DUR = 20;
const r2 = (x) => Math.round(x * 100) / 100;
// Настоящие записи Mixkit/Kenney (video/sfx-library.md); варианты pop2, pop3… чередуем, чтобы не звучало одинаково
const NV = { whoosh: 3, pop: 3, tick: 2, slam: 2, chime: 2, coin: 2 };
const vn = (n, i) => (NV[n] > 1 && i % NV[n] ? n + (i % NV[n] + 1) : n);
const DURS = { pop: 0.5, whoosh: 0.9, tick: 0.3, thump: 0.6, chime: 1.4, slam: 1, click: 0.4, correct: 1, coin: 1, wrong: 1, scratch: 0.9, lock: 0.6, camera: 0.5, glitch: 0.7 };
// [название, файл, варианты, номер верного, цена]
const Q = [
  ['Gallery Case', 'Gallery_Case.png', ['12 ₴', '33 ₴', '90 ₴'], 1, 33.01],
  ['M4A1-S | Electrum (FT)', 'M4A1_S___Electrum__Field_Tested_.png', ['140 ₴', '25 ₴', '68 ₴'], 2, 68.03],
  ['AK-47 | Slate (FT)', 'AK_47___Slate__Field_Tested_.png', ['520 ₴', '80 ₴', '229 ₴'].reverse(), 0, 229.66],
  ['Desert Eagle | Printstream (FT)', 'Desert_Eagle___Printstream__Field_Tested_.png', ['600 ₴', '1 867 ₴', '4 000 ₴'], 1, 1867.14],
];
const fmt = (v) => v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const LET = ['A', 'B', 'C'];
let js = '', rounds = '', sfxL = [];
Q.forEach(([nm, img, opts, ok, price], r) => {
  const t = 1.2 + r * 4.1;
  js += `  tl.set("#q${r}", { opacity: 1 }, ${r2(t)});\n`;
  js += `  tl.fromTo("#c${r}", { y: -500, scale: 0.7, rotation: -6 }, { y: 0, scale: 1, rotation: 0, duration: 0.4, ease: "back.out(1.6)" }, ${r2(t)});\n`;
  js += `  tl.fromTo("#q${r} .op", { x: 1200 }, { x: 0, duration: 0.3, stagger: 0.1, ease: "power3.out" }, ${r2(t + 0.4)});\n`;
  js += `  tl.fromTo("#t${r}", { scaleX: 1 }, { scaleX: 0, duration: 1.9, ease: "none" }, ${r2(t + 0.9)});\n`;
  ['3', '2', '1'].forEach((d, k) => {
    js += `  tl.set("#n${r}", { textContent: "${d}", opacity: 1, scale: 1.5 }, ${r2(t + 0.9 + k * 0.63)});\n  tl.to("#n${r}", { scale: 1, duration: 0.25, ease: "power2.out" }, ${r2(t + 0.9 + k * 0.63)});\n`;
    sfxL.push(['tick', t + 0.9 + k * 0.63, 0.6]);
  });
  // раскрытие
  const T = t + 2.85;
  js += `  tl.set("#n${r}", { opacity: 0 }, ${r2(T)});\n  tl.set("#t${r}", { opacity: 0 }, ${r2(T)});\n`;
  for (let k = 0; k < 3; k++) {
    if (k === ok) js += `  tl.to("#o${r}_${k}", { backgroundColor: "#35d07f", color: "#06210f", scale: 1.06, duration: 0.2, ease: "back.out(2.4)" }, ${r2(T)});\n`;
    else js += `  tl.to("#o${r}_${k}", { opacity: 0.25, duration: 0.2 }, ${r2(T)});\n`;
  }
  js += `  tl.fromTo("#p${r}", { opacity: 0, scale: 0.6, y: 40 }, { opacity: 1, scale: 1, y: 0, duration: 0.3, ease: "back.out(2.2)" }, ${r2(T + 0.05)});\n`;
  js += `  var o${r} = { v: 0 };\n  tl.to(o${r}, { v: ${price}, duration: 0.7, ease: "power2.out", onUpdate: function () { document.getElementById("pv${r}").textContent = (${fmt.toString()})(o${r}.v) + " ₴"; } }, ${r2(T + 0.05)});\n`;
  js += `  tl.to("#q${r}", { opacity: 0, duration: 0.12 }, ${r2(t + 4.0)});\n`;
  sfxL.push(['whoosh', t, 0.3], ['pop', t + 0.4, 0.35], ['pop', t + 0.5, 0.35], ['pop', t + 0.6, 0.35], ['correct', T, 0.6], ['pop', T + 0.05, 0.4]);
  rounds += `<div class="rnd" id="q${r}">
    <div class="cnt">${r + 1} / ${Q.length}</div>
    <div class="card" id="c${r}"><img src="assets/${img}" alt=""><div class="cn">${nm}</div></div>
    ${opts.map((o, k) => `<div class="op" id="o${r}_${k}" style="top:${900 + k * 150}px"><i>${LET[k]}</i>${o}</div>`).join('\n    ')}
    <div class="n" id="n${r}">3</div><div class="tm"><div class="tb" id="t${r}"></div></div>
    <div class="pr" id="p${r}"><small>НА САМОМ ДЕЛЕ</small><b id="pv${r}">0 ₴</b></div>
  </div>`;
});
// заставка и финал
js += `  tl.fromTo("#intro", { opacity: 0, scale: 2.2 }, { opacity: 1, scale: 1, duration: 0.25, ease: "power4.in" }, 0.05);\n  tl.to("#intro", { opacity: 0, scale: 0.9, duration: 0.15 }, 1.05);\n`;
sfxL.push(['slam', 0.1, 0.7]);
const E = 17.6;
js += `  tl.fromTo("#endw", { opacity: 0 }, { opacity: 1, duration: 0.2 }, ${E});\n`;
js += `  tl.fromTo("#elg", { scale: 0.3, rotation: -25, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, ${E + 0.1});\n`;
js += `  tl.fromTo("#etx", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, ${E + 0.35});\n`;
js += `  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, ${E + 1.0});\n`;
js += `  tl.fromTo("#efr", { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, ${E + 1.8});\n`;
sfxL.push(['whoosh', E, 0.3], ['pop', E + 0.15, 0.5], ['pop', E + 0.4, 0.5], ['chime', E + 1.0, 0.6], ['slam', E + 1.85, 0.5]);
const sfx = sfxL.map(([n, t, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${vn(n, i)}.wav" data-start="${r2(t)}" data-duration="${DURS[n]}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #3b1fd6; }
  #main { font-family: Montserrat, Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage, #bg { position: absolute; inset: 0; }
  #bg { background: radial-gradient(900px 800px at 50% 25%, #7a4bff, transparent 70%), repeating-linear-gradient(45deg, rgba(255,255,255,.05) 0 40px, transparent 40px 80px), #3b1fd6; }
  #intro { position: absolute; left: 0; right: 0; top: 760px; text-align: center; font: 900 170px/1 Montserrat, sans-serif; text-transform: uppercase; opacity: 0; z-index: 4; text-shadow: 0 12px 0 #1d0c78; }
  #intro span { color: #ffd66b; }
  .rnd { position: absolute; inset: 0; opacity: 0; }
  .cnt { position: absolute; left: 0; right: 0; top: 110px; text-align: center; font: 800 48px/1 "IBM Plex Mono", monospace; letter-spacing: 6px; color: #cfc3ff; }
  .card { position: absolute; left: 130px; top: 190px; width: 820px; height: 600px; border-radius: 50px; background: #fff; box-shadow: 0 30px 0 #1d0c78; color: #1a1030; text-align: center; }
  .card img { position: absolute; left: 20px; top: 10px; width: 780px; height: 500px; object-fit: contain; transform: scale(1.35); }
  .cn { position: absolute; left: 0; right: 0; bottom: 40px; font: 800 44px/1 Montserrat, sans-serif; }
  .op { position: absolute; left: 130px; width: 820px; height: 120px; border-radius: 32px; background: #fff; color: #1a1030; font: 900 62px/120px Montserrat, sans-serif; text-align: center; box-shadow: 0 10px 0 #1d0c78; }
  .op i { position: absolute; left: 22px; top: 22px; width: 76px; height: 76px; border-radius: 50%; background: #3b1fd6; color: #fff; font: 800 44px/76px Montserrat, sans-serif; font-style: normal; }
  .n { position: absolute; left: 0; right: 0; top: 1370px; text-align: center; font: 900 210px/1 Montserrat, sans-serif; color: #ffd66b; text-shadow: 0 10px 0 #1d0c78; }
  .tm { position: absolute; left: 130px; width: 820px; top: 1640px; height: 34px; border-radius: 17px; background: rgba(0,0,0,.28); overflow: hidden; }
  .tb { position: absolute; inset: 0; background: #ffd66b; transform-origin: 0 50%; border-radius: 17px; }
  .pr { position: absolute; left: 0; right: 0; top: 1370px; text-align: center; opacity: 0; }
  .pr small { display: block; font: 700 40px/1 "IBM Plex Mono", monospace; letter-spacing: 6px; color: #cfc3ff; }
  .pr b { display: block; margin-top: 14px; font: 900 170px/1 Montserrat, sans-serif; color: #ffd66b; text-shadow: 0 10px 0 #1d0c78; letter-spacing: -3px; }
  #foot { position: absolute; left: 0; right: 0; bottom: 100px; text-align: center; font: 500 28px/1 Inter, sans-serif; color: #cfc3ff; }
  #endw { position: absolute; inset: 0; opacity: 0; z-index: 9; background: radial-gradient(800px 700px at 50% 34%, rgba(231,178,76,.34), transparent 70%), #060606; }
  #elg { position: absolute; left: 380px; top: 300px; width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.55); }
  #etx { position: absolute; left: 60px; right: 60px; top: 700px; text-align: center; font: 900 84px/1.12 Montserrat, sans-serif; text-transform: uppercase; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 1010px; text-align: center; white-space: nowrap; font-size: 54px; font-weight: 900; padding: 24px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1180px; text-align: center; font-size: 76px; font-weight: 900; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; padding: 6px 0; opacity: 0; }
</style>
</head>
<body>
<!-- «Угадай цену» (9:16). Сгенерировано video/edit6/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div id="bg"></div>
  <div id="intro">Угадай<br><span>цену</span></div>
  ${rounds}
  <div id="foot">Цены Steam на 11.11, медиана продаж</div>
  <div id="endw"><img id="elg" src="assets/logo.png" alt=""><div id="etx">А где он дешевле всего — знает Ценолов</div><div id="etg">@cenolow_bot · Telegram</div><div id="efr">БЕСПЛАТНО</div></div>
 </div>
${sfx}
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
console.log('ok');
