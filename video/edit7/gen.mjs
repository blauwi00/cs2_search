// Ролики без голоса на реальных цифрах (цены Steam и площадок, журнал сборщика REEL от 12.11):
//   price5   «Один скин — пять цен» (AK-47 | Slate)      stop     «СТОП» (Five-SeveN | Triumvirate)
//   chat     «Купил кейс на пике» (мем-переписка)         wallet   «Steam дороже? А деньги твои?» (Desert Eagle | Printstream)
//   cases    «Кейсы дешевеют за 3 месяца»
// node gen.mjs <reel> <папка проекта>  (assets/: logo.png, sfx/, gsap.min.js, картинки предметов)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REEL = process.argv[2], DIR = process.argv[3];
const r2 = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (v) => '$' + v.toFixed(2).replace('.', ',');
const DURS = { pop: 0.5, whoosh: 0.9, tick: 0.3, thump: 0.6, chime: 1.4, slam: 1, click: 0.4, correct: 1, coin: 1, wrong: 1, scratch: 0.9, lock: 0.6, camera: 0.5, glitch: 0.7 };
const NV = { whoosh: 3, pop: 3, tick: 2, slam: 2, chime: 2, coin: 2 };
const vn = (n, i) => (NV[n] > 1 && i % NV[n] ? n + (i % NV[n] + 1) : n);
const audio = (list) => list.map(([n, t, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${vn(n, i)}.wav" data-start="${r2(t)}" data-duration="${DURS[n]}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

// Финальная карточка у всех роликов одинаковая.
const END_CSS = `
  #endw { position: absolute; inset: 0; opacity: 0; z-index: 9; background: radial-gradient(800px 700px at 50% 34%, rgba(231,178,76,.34), transparent 70%), #060606; }
  #elg { position: absolute; left: 380px; top: 330px; width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.55); }
  #etx { position: absolute; left: 60px; right: 60px; top: 700px; text-align: center; font: 900 88px/1.1 Montserrat, sans-serif; text-transform: uppercase; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 1010px; text-align: center; white-space: nowrap; font-size: 54px; font-weight: 900; padding: 24px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1180px; text-align: center; font-size: 76px; font-weight: 900; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; padding: 6px 0; opacity: 0; }`;
const endHtml = (txt) => `<div id="endw"><img id="elg" src="assets/logo.png" alt=""><div id="etx">${txt}</div><div id="etg">Ценолов · @cenolow_bot</div><div id="efr">БЕСПЛАТНО</div></div>`;
const endJs = (E) => `  tl.fromTo("#endw", { opacity: 0 }, { opacity: 1, duration: 0.2 }, ${E});
  tl.fromTo("#elg", { scale: 0.3, rotation: -25, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, ${E + 0.1});
  tl.fromTo("#etx", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, ${E + 0.35});
  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, ${E + 0.9});
  tl.fromTo("#efr", { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, ${E + 1.6});
`;
const endSfx = (E) => [['whoosh', E, 0.3], ['pop', E + 0.15, 0.5], ['pop', E + 0.4, 0.5], ['chime', E + 0.9, 0.6], ['slam', E + 1.65, 0.5]];
const counter = (id, v, t, d, fmt) => `  var c_${id} = { v: 0 };\n  tl.to(c_${id}, { v: ${v}, duration: ${d}, ease: "power2.out", onUpdate: function () { document.getElementById("${id}").textContent = (${fmt})(c_${id}.v); } }, ${r2(t)});\n`;
const FMT_USD = `function (v) { return "$" + v.toFixed(2).replace(".", ","); }`;

const BASE_CSS = `
  html, body { margin: 0; background: #0a0d14; }
  #main { font-family: Montserrat, Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage, #bg { position: absolute; inset: 0; }
  .hook { position: absolute; left: 0; right: 0; text-align: center; font: 900 150px/1.02 Montserrat, sans-serif; text-transform: uppercase; opacity: 0; z-index: 6; }
  .cap { position: absolute; left: 60px; right: 60px; text-align: center; font: 800 64px/1.15 Montserrat, sans-serif; opacity: 0; z-index: 5; }
  .sm { position: absolute; left: 60px; right: 60px; text-align: center; font: 500 30px/1.3 Inter, sans-serif; color: #8d97aa; opacity: 0; z-index: 5; }
  .pic { position: absolute; object-fit: contain; filter: drop-shadow(0 24px 34px rgba(0,0,0,.7)); opacity: 0; }` + END_CSS;
const wrap = ({ dur, bg, css = '', body, js, sfx, title, voice }) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>${BASE_CSS}
  #bg { background: ${bg}; }
${css}
</style>
</head>
<body>
<!-- «${title}» (9:16). Сгенерировано video/edit7/gen.mjs — правьте генератор. Цифры — реальные (см. шапку генератора). -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${dur}" data-width="1080" data-height="1920">
 <div id="stage">
  <div id="bg"></div>
${body}
 </div>
${voice ? `  <audio id="voice" class="clip" src="assets/voice.mp3" data-start="0" data-duration="${dur}" data-track-index="6" data-volume="1"></audio>\n` : ''}${audio(sfx)}
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

const REELS = {};

// ---------- 1. Один скин — пять цен ----------
REELS.price5 = () => {
  // $: Steam — средняя продаж за сутки; площадки — самое дешёвое объявление (Skinport 3,26 € × 1,114).
  const rows = [['Steam', 6.10, '#e7b24c'], ['Market.CSGO', 3.981, '#46c2ff'], ['Waxpeer', 3.885, '#46c2ff'], ['LIS-SKINS', 3.70, '#46c2ff'], ['Skinport', 3.63, '#46c2ff']];
  const H = 640;
  let js = `  tl.fromTo("#h1", { opacity: 0, scale: 2.6, rotation: -6 }, { opacity: 1, scale: 1, rotation: -2, duration: 0.22, ease: "power4.in" }, 0.1);\n  tl.to("#h1", { opacity: 0, scale: 0.85, duration: 0.18 }, 1.35);\n`;
  js += `  tl.fromTo("#pic", { opacity: 0, y: -400, scale: 0.7, rotation: -8 }, { opacity: 1, y: 0, scale: 1, rotation: 0, duration: 0.5, ease: "back.out(1.6)" }, 1.5);\n  tl.fromTo("#nm", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.3 }, 1.9);\n`;
  rows.forEach(([nm, v, c], i) => {
    const t = 2.6 + i * 0.75, h = Math.round((v / 6.10) * H);
    js += `  tl.fromTo("#b${i}", { scaleY: 0 }, { scaleY: 1, duration: 0.55, ease: "power3.out" }, ${r2(t)});\n  tl.fromTo("#l${i}", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.25 }, ${r2(t + 0.15)});\n  tl.fromTo("#v${i}", { opacity: 0 }, { opacity: 1, duration: 0.2 }, ${r2(t + 0.3)});\n`;
    js += counter('v' + i, v, t + 0.05, 0.55, FMT_USD);
  });
  js += `  tl.fromTo("#diff", { opacity: 0, scale: 2.4, rotation: -8 }, { opacity: 1, scale: 1, rotation: -3, duration: 0.22, ease: "power4.in" }, 7.1);\n`;
  js += `  tl.to("#b0", { backgroundColor: "#ff4b5c", duration: 0.3 }, 7.1);\n`;
  js += `  tl.to("#diff, #pic, #nm, #chart, #h1", { opacity: 0, duration: 0.25 }, 9.3);\n`;
  js += `  tl.fromTo("#c1", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, 9.5);\n  tl.fromTo("#c2", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.3 }, 10.6);\n  tl.to("#c1, #c2", { opacity: 0, duration: 0.2 }, 12.2);\n`;
  js += endJs(12.4);
  const sfx = [['slam', 0.12, 0.7], ['whoosh', 1.45, 0.3], ['pop', 1.6, 0.5], ...rows.flatMap((_, i) => [['coin', 2.6 + i * 0.75, 0.45]]), ['slam', 7.15, 0.7], ['whoosh', 9.4, 0.25], ['pop', 9.55, 0.5], ['pop', 10.65, 0.4], ...endSfx(12.4)];
  const cols = rows.map(([nm, v, c], i) => `<div class="col" style="left:${70 + i * 188}px"><div class="vl" id="v${i}" style="bottom:${Math.round((v / 6.10) * H) + 16}px">$0,00</div><div class="bar" id="b${i}" style="height:${Math.round((v / 6.10) * H)}px;background:${c}"></div><div class="lb" id="l${i}">${nm}</div></div>`).join('');
  return wrap({ dur: 14.2, title: 'Один скин — пять цен', bg: 'radial-gradient(900px 700px at 50% 30%, rgba(70,194,255,.14), transparent 70%), #0a0d14',
    css: `.col { position: absolute; top: 1500px; width: 160px; height: 0; } .bar { position: absolute; left: 0; right: 0; bottom: 0; transform-origin: 50% 100%; border-radius: 18px 18px 0 0; } .vl { position: absolute; left: -20px; right: -20px; text-align: center; font: 800 34px/1 "IBM Plex Mono", monospace; opacity: 0; } .lb { position: absolute; left: -20px; right: -20px; top: 18px; text-align: center; font: 700 26px/1.1 Montserrat, sans-serif; color: #aab3c5; opacity: 0; }
  #chart { position: absolute; inset: 0; }`,
    body: `  <div class="hook" id="h1" style="top:800px;font-size:90px;color:#ff5d73;text-shadow:0 0 60px rgba(255,93,115,.45)">Переплачиваешь?</div>
  <img class="pic" id="pic" src="assets/AK_47___Slate__Field_Tested_.png" style="left:290px;top:90px;width:500px;height:500px" alt="">
  <div class="cap" id="nm" style="top:560px;font-size:44px;color:#cfd6e4">AK-47 | Slate (FT)</div>
  <div id="chart">${cols}</div>
  <div class="hook" id="diff" style="top:660px;font-size:120px;color:#ff4b5c;text-shadow:0 0 50px rgba(255,75,92,.5)">−40%</div>
  <div class="cap" id="c1" style="top:640px;color:#fff">В Steam дороже на 40%</div>
  <div class="cap" id="c2" style="top:900px;color:#ffd66b;font-size:54px">но деньги из Steam не вывести</div>
  <div class="sm" id="foot" style="bottom:110px;opacity:1">Steam — средняя цена продаж за сутки. Площадки — самое дешёвое объявление. Данные 12.11</div>
  ${endHtml('Бот сравнит за тебя')}`, js, sfx });
};

// ---------- 2. СТОП ----------
REELS.stop = () => {
  let js = `  tl.fromTo("#h1", { opacity: 0, scale: 3, rotation: -8 }, { opacity: 1, scale: 1, rotation: -3, duration: 0.2, ease: "power4.in" }, 0.1);\n  tl.fromTo("#flash", { opacity: 0.8 }, { opacity: 0, duration: 0.3, immediateRender: false }, 0.3);\n  tl.to("#h1", { opacity: 0.0, scale: 0.8, duration: 0.18 }, 1.5);\n`;
  js += `  tl.fromTo("#pic", { opacity: 0, scale: 0.6, y: -300 }, { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: "back.out(1.6)" }, 1.6);\n  tl.fromTo("#nm", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.3 }, 2.0);\n`;
  // линия: 90 дн $38,55 → 30 дн $50,34 → 7 дн $88,61 (средние цены продаж Steam)
  js += `  tl.fromTo("#ln", { strokeDashoffset: 1000 }, { strokeDashoffset: 0, duration: 2.6, ease: "power1.inOut" }, 2.6);\n`;
  [[0, 38.55, 3.0, '90 дней назад'], [1, 50.34, 4.4, '30 дней назад'], [2, 88.61, 5.4, 'сейчас']].forEach(([i, v, t]) => {
    js += `  tl.fromTo("#p${i}", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2.4)" }, ${t});\n  tl.fromTo("#t${i}", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3 }, ${t});\n`;
  });
  js += `  tl.fromTo("#x", { opacity: 0, scale: 2.6, rotation: -10 }, { opacity: 1, scale: 1, rotation: -4, duration: 0.22, ease: "power4.in" }, 6.4);\n`;
  js += `  tl.to("#pic, #nm, #graph, #x", { opacity: 0, duration: 0.25 }, 8.4);\n`;
  js += `  tl.fromTo("#c1", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, 8.7);\n  tl.fromTo("#c2", { opacity: 0, scale: 1.4 }, { opacity: 1, scale: 1, duration: 0.25, ease: "power3.out" }, 10.0);\n  tl.to("#c1, #c2", { opacity: 0, duration: 0.2 }, 11.8);\n`;
  js += endJs(12.0);
  const sfx = [['slam', 0.12, 0.8], ['scratch', 0.3, 0.5], ['whoosh', 1.55, 0.3], ['pop', 1.65, 0.5], ['coin', 3.0, 0.45], ['coin', 4.4, 0.45], ['coin', 5.4, 0.55], ['slam', 6.45, 0.7], ['whoosh', 8.65, 0.25], ['pop', 8.8, 0.5], ['wrong', 10.0, 0.35], ...endSfx(12.0)];
  return wrap({ dur: 13.8, title: 'СТОП', bg: 'radial-gradient(900px 800px at 50% 28%, rgba(255,60,80,.2), transparent 70%), repeating-linear-gradient(0deg, rgba(255,255,255,.02) 0 2px, transparent 2px 6px), #0a0709',
    css: `#flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 30; } #graph { position: absolute; left: 90px; top: 760px; width: 900px; height: 700px; opacity: 1; } .pt { position: absolute; width: 36px; height: 36px; border-radius: 50%; background: #ffd66b; box-shadow: 0 0 30px rgba(255,214,107,.7); opacity: 0; margin: -18px 0 0 -18px; } .tx { position: absolute; width: 300px; margin-left: -150px; text-align: center; font: 800 44px/1.1 "IBM Plex Mono", monospace; opacity: 0; } .tx small { display: block; font: 500 26px/1.2 Inter, sans-serif; color: #8d97aa; }`,
    body: `  <div id="flash"></div>
  <div class="hook" id="h1" style="top:740px;font-size:230px;color:#fff;text-shadow:0 0 70px rgba(255,60,80,.6)">СТОП.</div>
  <img class="pic" id="pic" src="assets/FiveSeven_Triumvirate.png" style="left:340px;top:110px;width:400px;height:400px" alt="">
  <div class="cap" id="nm" style="top:520px;font-size:40px;color:#cfd6e4">Five-SeveN | Triumvirate (FN)</div>
  <div id="graph">
    <svg viewBox="0 0 900 700" width="900" height="700"><polyline id="ln" fill="none" stroke="#ffd66b" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="1000" stroke-dashoffset="1000" points="60,600 450,470 840,90"/></svg>
    <div class="pt" id="p0" style="left:60px;top:600px"></div><div class="pt" id="p1" style="left:450px;top:470px"></div><div class="pt" id="p2" style="left:840px;top:90px"></div>
    <div class="tx" id="t0" style="left:60px;top:640px">$38,55<small>90 дней назад</small></div>
    <div class="tx" id="t1" style="left:450px;top:510px;color:#ffd66b">$50,34<small>30 дней назад</small></div>
    <div class="tx" id="t2" style="left:760px;top:10px;color:#ff5d73">$88,61<small>сейчас</small></div>
  </div>
  <div class="hook" id="x" style="top:1520px;font-size:140px;color:#ff5d73;text-shadow:0 0 50px rgba(255,93,115,.5)">×2,3</div>
  <div class="cap" id="c1" style="top:720px">Цена скина выросла в 2,3 раза за три месяца</div>
  <div class="cap" id="c2" style="top:1060px;color:#ffd66b">Рост уже случился. Ты покупаешь на пике?</div>
  <div class="sm" id="foot" style="bottom:110px;opacity:1">Средняя цена продаж в Steam. Данные 12.11. Рост может развернуться. Не совет покупать или продавать</div>
  ${endHtml('Смотри, прежде чем брать')}`, js, sfx });
};

// ---------- 4. Купил кейс на пике (мем-переписка) ----------
REELS.chat = () => {
  const msgs = [
    [0.0, 'l', 'Друг', 'Ты кейс Dreams &amp; Nightmares по 2,34 $ взял?'],
    [2.0, 'r', 'Я', 'Ну он же дорожал...'],
    [3.9, 'l', 'Друг', 'Три месяца назад. Сейчас он 1,84 $'],
    [6.0, 'r', 'Я', '...'],
    [7.2, 'l', 'Друг', '−21%'],
  ];
  let js = `  tl.fromTo("#h1", { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.3 }, 0.1);\n`;
  const sfx = [['pop', 0.1, 0.4]];
  msgs.forEach(([t, side, , ], i) => {
    const tt = 1.0 + t;
    js += `  tl.fromTo("#m${i}", { opacity: 0, y: 50, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.25, ease: "back.out(2)" }, ${r2(tt)});\n`;
    sfx.push(['pop', tt, 0.5]);
  });
  js += `  tl.fromTo("#cs", { opacity: 0, scale: 0.5, rotation: -12 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2)" }, 2.4);\n`;
  js += `  tl.fromTo("#m4 b", { scale: 1 }, { scale: 1.5, duration: 0.2, ease: "back.out(3)", yoyo: true, repeat: 1 }, 8.35);\n  tl.fromTo("#flash", { opacity: 0.5 }, { opacity: 0, duration: 0.3, immediateRender: false }, 8.25);\n`;
  js += `  tl.fromTo("#bot", { opacity: 0, y: 80 }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, 10.0);\n  tl.to("#msgs, #cs", { opacity: 0.18, duration: 0.3 }, 10.0);\n  tl.to("#bot, #msgs, #cs, #h1", { opacity: 0, duration: 0.25 }, 13.1);\n`;
  js += endJs(13.3);
  sfx.push(['scratch', 6.1, 0.5], ['slam', 8.3, 0.7], ['whoosh', 9.9, 0.3], ['chime', 10.1, 0.6], ...endSfx(13.3));
  const bub = msgs.map(([, s, who, tx], i) => `<div class="m ${s}" id="m${i}" style="top:${i * 190}px"><div class="who">${who}</div><b>${tx}</b></div>`).join('');
  return wrap({ dur: 15.1, title: 'Купил кейс на пике', bg: 'radial-gradient(900px 800px at 50% 20%, rgba(80,120,255,.14), transparent 70%), #0a0d14',
    css: `#flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 30; } #msgs { position: absolute; left: 60px; right: 60px; top: 380px; height: 1000px; } .m { position: absolute; max-width: 700px; padding: 26px 34px; border-radius: 40px; font: 600 44px/1.25 Inter, sans-serif; opacity: 0; } .m b { display: inline-block; font-weight: 700; } .m .who { font: 600 26px/1 Inter, sans-serif; color: #8fa3cc; margin-bottom: 8px; } .m.l { left: 0; background: #1b2433; border-bottom-left-radius: 8px; } .m.r { right: 0; background: #2b5278; border-bottom-right-radius: 8px; text-align: right; }
  #cs { position: absolute; left: 360px; top: 1230px; width: 360px; height: 360px; object-fit: contain; filter: drop-shadow(0 20px 30px rgba(0,0,0,.6)); opacity: 0; }
  #bot { position: absolute; left: 50px; right: 50px; top: 600px; z-index: 12; opacity: 0; background: #182533; border-radius: 44px 44px 44px 12px; padding: 40px 46px; font: 500 40px/1.3 Inter, sans-serif; box-shadow: 0 30px 80px rgba(0,0,0,.7); } #bot .who { display: flex; align-items: center; gap: 18px; font-size: 34px; color: #8fa3cc; margin-bottom: 14px; } #bot .who img { width: 64px; height: 64px; border-radius: 16px; } #bot h3 { margin: 0 0 12px; font-size: 54px; color: #ffd66b; } #bot i { display: block; margin-top: 14px; font-size: 28px; color: #8d97aa; font-style: normal; }`,
    body: `  <div id="flash"></div>
  <div class="hook" id="h1" style="top:130px;font-size:100px;opacity:0">Купил кейс на пике</div>
  <div id="msgs">${bub}</div>
  <img id="cs" src="assets/Dreams___Nightmares_Case.png" alt="">
  <div id="bot"><div class="who"><img src="assets/logo.png" alt="">Ценолов</div><h3>Dreams &amp; Nightmares Case</h3>Сейчас $1,84. Средняя цена продаж за 90 дней — $2,34. Ниже на <b>21%</b>.<i>Дешевле не значит выгодно: рост цены не гарантирован.</i></div>
  ${endHtml('Проверь цену заранее')}`, js, sfx });
};

// ---------- 4б. То же с озвучкой (София — Друг, Евгений — Я и финал): времена по склеенной дорожке voice.mp3 ----------
REELS.chatv = () => {
  const msgs = [
    [0.4, 'l', 'Друг', 'Ты кейс Dreams &amp; Nightmares по 2,34 $ взял?'],
    [2.83, 'r', 'Я', 'Но он же дорожал...'],
    [4.95, 'l', 'Друг', 'Три месяца назад. Сейчас он 1,84 $'],
    [8.3, 'r', 'Я', '...'],
    [9.05, 'l', 'Друг', '−21%'],
  ];
  let js = `  tl.fromTo("#h1", { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.3 }, 0.1);\n`;
  const sfx = [['pop', 0.1, 0.4]];
  msgs.forEach(([t, side, , ], i) => {
    const tt = t;
    js += `  tl.fromTo("#m${i}", { opacity: 0, y: 50, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.25, ease: "back.out(2)" }, ${r2(tt)});\n`;
    sfx.push(['pop', tt, 0.25]);
  });
  js += `  tl.fromTo("#cs", { opacity: 0, scale: 0.5, rotation: -12 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2)" }, 1.4);\n`;
  js += `  tl.fromTo("#m4 b", { scale: 1 }, { scale: 1.5, duration: 0.2, ease: "back.out(3)", yoyo: true, repeat: 1 }, 9.2);\n  tl.fromTo("#flash", { opacity: 0.5 }, { opacity: 0, duration: 0.3, immediateRender: false }, 9.1);\n`;
  js += `  tl.fromTo("#bot", { opacity: 0, y: 80 }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, 10.0);\n  tl.to("#msgs, #cs", { opacity: 0.18, duration: 0.3 }, 10.0);\n  tl.to("#bot, #msgs, #cs, #h1", { opacity: 0, duration: 0.25 }, 13.1);\n`;
  js += endJs(13.3);
  sfx.push(['slam', 9.1, 0.5], ['chime', 10.7, 0.35], ...endSfx(14.85));
  const bub = msgs.map(([, s, who, tx], i) => `<div class="m ${s}" id="m${i}" style="top:${i * 190}px"><div class="who">${who}</div><b>${tx}</b></div>`).join('');
  return wrap({ dur: 16.8, title: 'Купил кейс на пике (озвучка)', bg: 'radial-gradient(900px 800px at 50% 20%, rgba(80,120,255,.14), transparent 70%), #0a0d14',
    css: `#flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 30; } #msgs { position: absolute; left: 60px; right: 60px; top: 380px; height: 1000px; } .m { position: absolute; max-width: 700px; padding: 26px 34px; border-radius: 40px; font: 600 44px/1.25 Inter, sans-serif; opacity: 0; } .m b { display: inline-block; font-weight: 700; } .m .who { font: 600 26px/1 Inter, sans-serif; color: #8fa3cc; margin-bottom: 8px; } .m.l { left: 0; background: #1b2433; border-bottom-left-radius: 8px; } .m.r { right: 0; background: #2b5278; border-bottom-right-radius: 8px; text-align: right; }
  #cs { position: absolute; left: 360px; top: 1230px; width: 360px; height: 360px; object-fit: contain; filter: drop-shadow(0 20px 30px rgba(0,0,0,.6)); opacity: 0; }
  #bot { position: absolute; left: 50px; right: 50px; top: 600px; z-index: 12; opacity: 0; background: #182533; border-radius: 44px 44px 44px 12px; padding: 40px 46px; font: 500 40px/1.3 Inter, sans-serif; box-shadow: 0 30px 80px rgba(0,0,0,.7); } #bot .who { display: flex; align-items: center; gap: 18px; font-size: 34px; color: #8fa3cc; margin-bottom: 14px; } #bot .who img { width: 64px; height: 64px; border-radius: 16px; } #bot h3 { margin: 0 0 12px; font-size: 54px; color: #ffd66b; } #bot i { display: block; margin-top: 14px; font-size: 28px; color: #8d97aa; font-style: normal; }`,
    body: `  <div id="flash"></div>
  <div class="hook" id="h1" style="top:130px;font-size:100px;opacity:0">Купил кейс на пике</div>
  <div id="msgs">${bub}</div>
  <img id="cs" src="assets/Dreams___Nightmares_Case.png" alt="">
  <div id="bot"><div class="who"><img src="assets/logo.png" alt="">Ценолов</div><h3>Dreams &amp; Nightmares Case</h3>Сейчас $1,84. Средняя цена продаж за 90 дней — $2,34. Ниже на <b>21%</b>.<i>Дешевле не значит выгодно: рост цены не гарантирован.</i></div>
  ${endHtml('Проверь цену заранее')}`, js, sfx, voice: true });
};

// ---------- 5. Steam дороже? А деньги твои? ----------
REELS.wallet = () => {
  // Desert Eagle | Printstream (FT): Steam — средняя продаж за сутки; площадки — самое дешёвое объявление ($, Skinport 26,73 € × 1,114).
  let js = `  tl.fromTo("#h1", { opacity: 0, scale: 2.4 }, { opacity: 1, scale: 1, duration: 0.22, ease: "power4.in" }, 0.1);\n  tl.to("#h1", { opacity: 0, duration: 0.18 }, 1.4);\n`;
  js += `  tl.fromTo("#pic", { opacity: 0, scale: 0.6, y: -300 }, { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: "back.out(1.6)" }, 1.5);\n`;
  js += `  tl.fromTo("#top", { opacity: 0, x: -300 }, { opacity: 1, x: 0, duration: 0.35, ease: "power3.out" }, 2.4);\n`;
  js += counter('vs', 52.48, 2.5, 0.8, FMT_USD);
  js += `  tl.fromTo("#bot", { opacity: 0, x: 300 }, { opacity: 1, x: 0, duration: 0.35, ease: "power3.out" }, 4.2);\n`;
  js += counter('vk', 29.78, 4.3, 0.8, FMT_USD);
  js += `  tl.fromTo("#lock", { opacity: 0, scale: 2.4 }, { opacity: 1, scale: 1, duration: 0.2, ease: "power4.in" }, 6.0);\n`;
  js += `  tl.fromTo("#dd", { opacity: 0, scale: 2.4, rotation: -8 }, { opacity: 1, scale: 1, rotation: -3, duration: 0.22, ease: "power4.in" }, 7.2);\n`;
  js += `  tl.to("#top, #bot, #pic, #lock, #dd", { opacity: 0, duration: 0.25 }, 9.3);\n`;
  js += `  tl.fromTo("#c1", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, 9.5);\n  tl.fromTo("#c2", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.3 }, 10.8);\n  tl.to("#c1, #c2", { opacity: 0, duration: 0.2 }, 12.4);\n`;
  js += endJs(12.6);
  const sfx = [['slam', 0.12, 0.7], ['whoosh', 1.45, 0.3], ['pop', 1.6, 0.5], ['whoosh', 2.3, 0.3], ['coin', 2.5, 0.5], ['whoosh', 4.1, 0.3], ['coin', 4.3, 0.5], ['lock', 6.0, 0.6], ['slam', 7.25, 0.7], ['whoosh', 9.4, 0.25], ['pop', 9.55, 0.5], ['pop', 10.85, 0.4], ...endSfx(12.6)];
  return wrap({ dur: 14.4, title: 'Steam дороже? А деньги твои?', bg: 'radial-gradient(900px 700px at 50% 30%, rgba(231,178,76,.16), transparent 70%), #0a0d14',
    css: `.card { position: absolute; left: 90px; right: 90px; height: 330px; border-radius: 40px; background: #141922; opacity: 0; } .card .k { position: absolute; left: 44px; top: 36px; font: 800 40px/1 Montserrat, sans-serif; letter-spacing: 3px; } .card .v { position: absolute; left: 44px; top: 100px; font: 900 130px/1 "IBM Plex Mono", monospace; } .card .s { position: absolute; left: 44px; bottom: 34px; font: 500 32px/1.2 Inter, sans-serif; color: #8d97aa; } #lock { position: absolute; right: 70px; top: 780px; width: 130px; opacity: 0; z-index: 4; }`,
    body: `  <div class="hook" id="h1" style="top:760px;font-size:120px;color:#ffd66b">Steam дороже?</div>
  <img class="pic" id="pic" src="assets/Desert_Eagle___Printstream__Field_Tested_.png" style="left:290px;top:90px;width:500px;height:500px" alt="">
  <div class="card" id="top" style="top:640px;border:4px solid #e7b24c"><div class="k" style="color:#e7b24c">STEAM</div><div class="v" id="vs" style="color:#e7b24c">$0,00</div><div class="s">деньги остаются в кошельке Steam</div></div>
  <svg id="lock" viewBox="0 0 120 140"><path d="M30 62 V40 a30 30 0 0 1 60 0 V62" fill="none" stroke="#ff4b5c" stroke-width="14" stroke-linecap="round"/><rect x="14" y="58" width="92" height="72" rx="14" fill="#ff4b5c"/><circle cx="60" cy="88" r="9" fill="#2a0b10"/></svg>
  <div class="card" id="bot" style="top:1010px;border:4px solid #35d07f"><div class="k" style="color:#35d07f">ДРУГИЕ ПЛОЩАДКИ</div><div class="v" id="vk" style="color:#35d07f">$0,00</div><div class="s">самое дешёвое объявление, можно вывести</div></div>
  <div class="hook" id="dd" style="top:1400px;font-size:120px;color:#ff4b5c;text-shadow:0 0 50px rgba(255,75,92,.5)">−43%</div>
  <div class="cap" id="c1" style="top:640px">Дороже в Steam — не значит выгоднее</div>
  <div class="cap" id="c2" style="top:980px;color:#ffd66b;font-size:54px">считай, сколько реально получишь</div>
  <div class="sm" id="foot" style="bottom:110px;opacity:1">Steam — средняя цена продаж за сутки. Площадки — самое дешёвое объявление. Desert Eagle | Printstream (FT). Данные 12.11</div>
  ${endHtml('Бот посчитает чистыми')}`, js, sfx });
};

// ---------- 6. Кейсы дешевеют ----------
REELS.cases = () => {
  // Средняя продаж Steam: 90 дней → сегодня, $ (журнал сборщика).
  const rows = [['Dreams &amp; Nightmares', 2.34, 1.84, 'Dreams___Nightmares_Case'], ['Snakebite', 0.94, 0.74, 'Snakebite_Case'], ['Fracture', 0.95, 0.78, 'Fracture_Case'], ['Kilowatt', 0.29, 0.24, 'Kilowatt_Case'], ['Recoil', 0.56, 0.47, 'Recoil_Case'], ['Gallery', 1.48, 1.28, 'Gallery_Case'], ['Revolution', 0.43, 0.38, 'Revolution_Case']];
  let js = `  tl.fromTo("#h1", { opacity: 0, scale: 2.4, rotation: -5 }, { opacity: 1, scale: 1, rotation: -2, duration: 0.22, ease: "power4.in" }, 0.1);\n  tl.to("#h1", { y: -560, scale: 0.55, duration: 0.5, ease: "power3.inOut" }, 1.5);\n`;
  const sfx = [['slam', 0.12, 0.7], ['whoosh', 1.45, 0.3]];
  rows.forEach(([nm, a, b], i) => {
    const t = 2.3 + i * 0.85, drop = Math.round((1 - b / a) * 100);
    js += `  tl.fromTo("#r${i}", { opacity: 0, x: -140 }, { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" }, ${r2(t)});\n  tl.fromTo("#o${i}", { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: "power2.out" }, ${r2(t + 0.1)});\n  tl.fromTo("#n${i}", { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: "power2.out" }, ${r2(t + 0.45)});\n  tl.fromTo("#d${i}", { opacity: 0, scale: 2 }, { opacity: 1, scale: 1, duration: 0.2, ease: "power4.in" }, ${r2(t + 0.8)});\n`;
    sfx.push(['pop', t, 0.4], ['tick', t + 0.45, 0.5], ['slam', t + 0.82, 0.35]);
  });
  const E1 = 2.3 + rows.length * 0.85 + 0.6;
  js += `  tl.to("#rows, #h1", { opacity: 0, duration: 0.25 }, ${r2(E1)});\n  tl.fromTo("#c1", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "back.out(2)" }, ${r2(E1 + 0.2)});\n  tl.fromTo("#c2", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.3 }, ${r2(E1 + 1.4)});\n  tl.to("#c1, #c2", { opacity: 0, duration: 0.2 }, ${r2(E1 + 3.0)});\n`;
  sfx.push(['whoosh', E1, 0.25], ['pop', E1 + 0.25, 0.5], ['pop', E1 + 1.45, 0.4]);
  const E = r2(E1 + 3.2);
  js += endJs(E); sfx.push(...endSfx(E));
  const rowHtml = rows.map(([nm, a, b, img], i) => { const w = 560; return `<div class="row" id="r${i}" style="top:${i * 158}px"><img src="assets/${img}.png" alt=""><div class="rn">${nm}</div><div class="bars"><div class="o" id="o${i}" style="width:${w}px"></div><div class="n" id="n${i}" style="width:${Math.round(w * b / a)}px"></div><div class="vals">$${a.toFixed(2).replace('.', ',')} → $${b.toFixed(2).replace('.', ',')}</div></div><div class="dr" id="d${i}">−${Math.round((1 - b / a) * 100)}%</div></div>`; }).join('');
  return wrap({ dur: E + 2.3, title: 'Кейсы дешевеют', bg: 'radial-gradient(900px 700px at 50% 20%, rgba(255,90,100,.15), transparent 70%), #0a0d14',
    css: `#rows { position: absolute; left: 50px; right: 50px; top: 430px; height: 1150px; } .row { position: absolute; left: 0; right: 0; height: 140px; border-radius: 28px; background: #121722; opacity: 0; } .row img { position: absolute; left: 14px; top: 14px; width: 112px; height: 112px; object-fit: contain; } .rn { position: absolute; left: 140px; top: 12px; font: 800 30px/1 Montserrat, sans-serif; } .bars { position: absolute; left: 140px; top: 56px; width: 560px; height: 26px; } .o, .n { position: absolute; left: 0; height: 26px; border-radius: 13px; transform-origin: 0 50%; } .o { background: #3a4150; } .n { top: 0; background: #ff5d73; } .vals { position: absolute; left: 0; top: 40px; font: 500 24px/1 "IBM Plex Mono", monospace; color: #aab3c5; white-space: nowrap; } .dr { position: absolute; right: 24px; top: 36px; font: 900 54px/1 "IBM Plex Mono", monospace; color: #ff5d73; opacity: 0; }`,
    body: `  <div class="hook" id="h1" style="top:760px;font-size:130px;color:#ff5d73;text-shadow:0 0 60px rgba(255,93,115,.45)">Кейсы дешевеют</div>
  <div id="rows">${rowHtml}</div>
  <div class="cap" id="c1" style="top:720px;font-size:70px">Все 7 кейсов дешевле, чем 3 месяца назад</div>
  <div class="cap" id="c2" style="top:1090px;color:#ffd66b">Дешевле — не значит выгодно</div>
  <div class="sm" id="foot" style="bottom:110px;opacity:1">Средняя цена продаж в Steam: 90 дней назад → сегодня. Данные 12.11. Цена может упасть ещё</div>
  ${endHtml('Следи за ценами в боте')}`, js, sfx });
};

if (!REELS[REEL]) throw new Error('reel: ' + Object.keys(REELS).join(', '));
writeFileSync(join(DIR, 'index.html'), REELS[REEL]());
console.log('ok', REEL);
