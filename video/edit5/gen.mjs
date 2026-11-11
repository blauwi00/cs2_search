// Ролик «Куда уходят твои деньги» (9:16, 15 с, без голоса): со 100 ₴ продажи на каждой площадке приходит разная сумма.
// Steam — точно по формуле калькулятора (86,97 ₴); остальные — по обзорам комиссий (≈), на сайте проверяй.
// node gen.mjs <папка проекта>  (assets/: logo.png, sfx/, gsap.min.js)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const DUR = 15;
const r2 = (x) => Math.round(x * 100) / 100;
// [площадка, сколько придёт со 100 ₴, точно?]
const ROWS = [['Steam', 86.97, true], ['Skinport', 92, false], ['Waxpeer', 94, false], ['Market.CSGO', 95, false], ['LIS-SKINS', 95, false], ['CSFloat', 98, false]];
const fmt = (v, exact) => (exact ? v.toFixed(2).replace('.', ',') : String(Math.round(v)));
let js = '';
ROWS.forEach(([nm, v, ex], i) => {
  const t = 1.7 + i * 0.85;
  js += `  tl.fromTo("#r${i}", { opacity: 0, x: -120 }, { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" }, ${r2(t)});\n`;
  js += `  tl.fromTo("#g${i}", { scaleX: 0 }, { scaleX: 1, duration: 0.55, ease: "power2.out" }, ${r2(t + 0.12)});\n`;
  js += `  tl.fromTo("#d${i}", { scaleX: 0 }, { scaleX: 1, duration: 0.25, ease: "power2.out" }, ${r2(t + 0.62)});\n`;
  js += `  tl.fromTo("#l${i}", { opacity: 0 }, { opacity: 1, duration: 0.2 }, ${r2(t + 0.7)});\n`;
  js += `  var o${i} = { v: 0 };\n  tl.to(o${i}, { v: ${v}, duration: 0.6, ease: "power2.out", onUpdate: function () { document.getElementById("v${i}").textContent = ${ex ? `o${i}.v.toFixed(2).replace(".", ",")` : `Math.round(o${i}.v)`} + " ₴"; } }, ${r2(t + 0.1)});\n`;
});
// акценты: Steam красным, CSFloat зелёным, остальные гаснут
js += `  tl.to("#r1, #r2, #r3, #r4", { opacity: 0.12, duration: 0.3 }, 7.5);\n`;
js += `  tl.fromTo("#r0", { scale: 1 }, { scale: 1.05, duration: 0.25, ease: "back.out(2)", immediateRender: false }, 7.5);\n`;
js += `  tl.fromTo("#r5", { scale: 1 }, { scale: 1.05, duration: 0.25, ease: "back.out(2)", immediateRender: false }, 8.05);\n`;
js += `  tl.to("#rows", { opacity: 0, y: -40, duration: 0.25 }, 9.0);\n  tl.to("#top", { opacity: 0, duration: 0.2 }, 9.0);\n`;
// разница на 1000 ₴
js += `  tl.fromTo("#dif", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 9.2);\n`;
js += `  tl.fromTo("#d1", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, 9.3);\n`;
js += `  tl.fromTo("#d2", { opacity: 0, x: -200 }, { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" }, 9.8);\n`;
js += `  tl.fromTo("#d3", { opacity: 0, x: 200 }, { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" }, 10.4);\n`;
js += `  tl.fromTo("#d4", { opacity: 0, scale: 2.6, rotation: -8 }, { opacity: 1, scale: 1, rotation: -3, duration: 0.22, ease: "power4.in" }, 11.2);\n`;
js += `  tl.to("#dif", { opacity: 0, duration: 0.2 }, 12.4);\n`;
// финал
js += `  tl.fromTo("#endw", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 12.4);\n`;
js += `  tl.fromTo("#elg", { scale: 0.3, rotation: -25, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, 12.5);\n`;
js += `  tl.fromTo("#etx", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, 12.8);\n`;
js += `  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, 13.3);\n`;
js += `  tl.fromTo("#efr", { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, 14.1);\n`;
js += `  tl.fromTo("#top", { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" }, 0.1);\n`;
js += `  tl.fromTo("#h100", { scale: 2.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.25, ease: "power4.in" }, 0.5);\n`;

const sfx = [['pop', 0.5, 0.6], ...ROWS.flatMap((_, i) => [['pop', 1.7 + i * 0.85 + 0.12, 0.35], ['tick', 1.7 + i * 0.85 + 0.62, 0.5]]), ['slam', 7.5, 0.5], ['whoosh', 9.0, 0.25], ['pop', 9.3, 0.5], ['whoosh', 9.8, 0.2], ['whoosh', 10.4, 0.2], ['slam', 11.3, 0.7], ['whoosh', 12.4, 0.3], ['pop', 12.55, 0.5], ['chime', 13.3, 0.6], ['slam', 14.2, 0.5]]
  .map(([n, t, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${n}.wav" data-start="${r2(t)}" data-duration="${{ pop: 0.12, whoosh: 0.45, tick: 0.06, thump: 0.4, chime: 1.1, slam: 0.5, click: 0.15 }[n]}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

const rows = ROWS.map(([nm, v, ex], i) => `<div class="row" id="r${i}" style="top:${i * 195}px"><div class="nm">${nm}</div><div class="vl" id="v${i}" style="color:${i === 0 ? '#ff8c99' : '#35d07f'}">0 ₴</div><div class="bar"><div class="gr" id="g${i}" style="width:${(v * 8.8).toFixed(1)}px;background:${i === 0 ? '#e0526a' : '#35d07f'}"></div><div class="rd" id="d${i}" style="width:${((100 - v) * 8.8).toFixed(1)}px"></div></div><div class="ls" id="l${i}">−${(100 - v).toFixed(2).replace('.', ',')} ₴ комиссия${ex ? '' : ' (≈)'}</div></div>`).join('\n      ');
const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #0a0d14; }
  #main { font-family: Montserrat, Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage, #bg { position: absolute; inset: 0; }
  #bg { background: radial-gradient(900px 700px at 50% 22%, rgba(231,178,76,.16), transparent 70%), repeating-linear-gradient(90deg, rgba(255,255,255,.025) 0 2px, transparent 2px 90px), #0a0d14; }
  #top { position: absolute; left: 0; right: 0; top: 150px; text-align: center; opacity: 0; }
  #top .s { font: 700 46px/1 Montserrat, sans-serif; letter-spacing: 6px; color: #aab3c5; }
  #h100 { font: 900 250px/1 Montserrat, sans-serif; color: #ffd66b; text-shadow: 0 0 70px rgba(255,190,60,.45); margin-top: 20px; letter-spacing: -6px; opacity: 0; }
  #top .q { font: 800 56px/1.1 Montserrat, sans-serif; margin-top: 10px; }
  #rows { position: absolute; left: 100px; top: 600px; width: 880px; height: 1200px; }
  .row { position: absolute; left: 0; width: 880px; height: 180px; opacity: 0; }
  .nm { position: absolute; left: 0; top: 0; font: 800 46px/1 Montserrat, sans-serif; }
  .vl { position: absolute; right: 0; top: 0; font: 800 46px/1 "IBM Plex Mono", monospace; }
  .bar { position: absolute; left: 0; top: 66px; width: 880px; height: 58px; border-radius: 14px; background: #181c26; overflow: hidden; }
  .gr { position: absolute; left: 0; top: 0; bottom: 0; transform-origin: 0 50%; border-radius: 14px 0 0 14px; }
  .rd { position: absolute; right: 0; top: 0; bottom: 0; background: #ff4b5c; transform-origin: 100% 50%; }
  .ls { position: absolute; right: 0; top: 138px; font: 500 30px/1 "IBM Plex Mono", monospace; color: #ff7d8c; opacity: 0; }
  #foot { position: absolute; left: 60px; right: 60px; bottom: 120px; text-align: center; font: 500 28px/1.3 Inter, sans-serif; color: #7d869a; }
  #dif { position: absolute; inset: 0; opacity: 0; z-index: 5; }
  #d1 { position: absolute; left: 0; right: 0; top: 330px; text-align: center; font: 800 62px/1.1 Montserrat, sans-serif; color: #aab3c5; opacity: 0; }
  #d2, #d3 { position: absolute; left: 100px; right: 100px; height: 210px; border-radius: 36px; background: #14181f; opacity: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 50px; box-sizing: border-box; font: 800 52px/1 Montserrat, sans-serif; }
  #d2 { top: 520px; border: 4px solid #ff4b5c; } #d3 { top: 770px; border: 4px solid #35d07f; }
  #d2 b { font: 900 80px/1 "IBM Plex Mono", monospace; color: #ff8c99; } #d3 b { font: 900 80px/1 "IBM Plex Mono", monospace; color: #35d07f; }
  #d4 { position: absolute; left: 90px; right: 90px; top: 1100px; text-align: center; font: 900 120px/1.05 Montserrat, sans-serif; color: #ffd66b; text-shadow: 0 0 60px rgba(255,190,60,.5); opacity: 0; }
  #d4 small { display: block; font-size: 50px; color: #fff; text-shadow: none; margin-top: 18px; }
  #endw { position: absolute; inset: 0; opacity: 0; z-index: 9; background: radial-gradient(800px 700px at 50% 34%, rgba(231,178,76,.34), transparent 70%), #060606; }
  #elg { position: absolute; left: 380px; top: 330px; width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.55); }
  #etx { position: absolute; left: 60px; right: 60px; top: 730px; text-align: center; font: 900 92px/1.1 Montserrat, sans-serif; text-transform: uppercase; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 1000px; text-align: center; white-space: nowrap; font-size: 54px; font-weight: 900; padding: 24px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1170px; text-align: center; font-size: 76px; font-weight: 900; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; padding: 6px 0; opacity: 0; }
</style>
</head>
<body>
<!-- «Куда уходят твои деньги» (9:16). Сгенерировано video/edit5/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div id="bg"></div>
  <div id="top"><div class="s">ПРОДАЛ СКИН ЗА</div><div id="h100">100 ₴</div><div class="q">Сколько придёт на руки?</div></div>
  <div id="rows">
      ${rows}
  </div>
  <div id="foot">Steam — точно по формуле. Остальные ≈ по обзорам, проверяй на сайте</div>
  <div id="dif">
    <div id="d1">ЕСЛИ ПРОДАЁШЬ НА 1000 ₴</div>
    <div id="d2"><span>Steam</span><b>869,70 ₴</b></div>
    <div id="d3"><span>CSFloat</span><b>≈980 ₴</b></div>
    <div id="d4">≈110 ₴ разницы<small>из воздуха</small></div>
  </div>
  <div id="endw"><img id="elg" src="assets/logo.png" alt=""><div id="etx">Посчитает за тебя</div><div id="etg">Ценолов · @cenolow_bot</div><div id="efr">БЕСПЛАТНО</div></div>
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
