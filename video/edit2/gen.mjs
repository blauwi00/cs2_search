// Ролик «Как тебя разводят на скинах» (9:16, 27 с): обучающая схема разгона цены.
// Стиль — противоположность «Не апгрейдер»: холодная схема на сетке, график рисуется по голосу, субтитры внизу одной полосой
// с подсветкой текущего слова. Цифры на схеме — иллюстрация («СХЕМА» подписано в углу), не данные конкретного скина.
// node gen.mjs <папка проекта>  (assets/: voice.mp3, transcript.json, logo.png, sfx/, gsap.min.js)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const DUR = 27.17;
const r2 = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const raw = JSON.parse(readFileSync(join(DIR, 'assets/transcript.json'), 'utf8'));
const W = (raw.words || raw).map((w) => ({ s: w.start, e: w.end }));
if (W.length !== 57) throw new Error('ожидалось 57 слов, пришло ' + W.length);
const TXT = ['Скин', 'вырос', 'в', 'три', 'раза', 'за', 'неделю?', 'Не', 'спеши', 'покупать.', 'Это', 'схема.', 'Сначала', 'скупают', 'всё', 'дешёвое,', 'потом', 'задирают', 'цену', 'там,', 'где', 'продаж', 'почти', 'нет.', 'Появляются', '«эксперты»:', '«Взлетит!', 'Бери!»', 'Ты', 'берёшь', 'на', 'пике', 'и', 'цена', 'падает', 'обратно.', 'Как', 'отличить?', 'Мало', 'продаж.', 'На', 'других', 'площадках', 'дешевле.', 'Рост', 'без', 'причины.', 'Ценолов', 'проверяет', 'это', 'сам', 'и', 'предупреждает.', 'Ценолов', 'в', 'Телеграм.', 'Бесплатно.'];
const GROUPS = [[0, 4], [5, 6], [7, 9], [10, 11], [12, 15], [16, 18], [19, 23], [24, 25], [26, 27], [28, 31], [32, 35], [36, 37], [38, 39], [40, 43], [44, 46], [47, 50], [51, 52], [53, 56]];

let js = '';
const at = (t) => r2(t);

// ---------- Субтитры: полоса снизу, текущее слово — золотая плашка ----------
let caps = '';
GROUPS.forEach(([a, b], gi) => {
  const start = W[a].s, end = gi + 1 < GROUPS.length ? W[GROUPS[gi + 1][0]].s - 0.03 : DUR;
  caps += `<div class="cg" id="g${gi}">${TXT.slice(a, b + 1).map((t, k) => `<span class="cw" id="w${a + k}">${esc(t)}</span>`).join(' ')}</div>\n    `;
  js += `  tl.fromTo("#g${gi}", { opacity: 0, y: 24, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.12, ease: "power3.out" }, ${at(Math.max(0, start - 0.06))});\n`;
  for (let i = a; i <= b; i++) {
    const nxt = i < b ? W[i + 1].s : Math.min(end, W[i].e + 0.25);
    js += `  tl.to("#w${i}", { backgroundColor: "#ffd66b", color: "#1a1305", duration: 0.05 }, ${at(W[i].s - 0.02)});\n`;
    js += `  tl.to("#w${i}", { backgroundColor: "rgba(255,214,107,0)", color: "#ffffff", duration: 0.08 }, ${at(nxt - 0.04)});\n`;
  }
  js += `  tl.set("#g${gi}", { opacity: 0, visibility: "hidden" }, ${at(end)});\n`;
});

// ---------- График: цена по дням (иллюстрация) ----------
const Y = (p) => Math.round(560 - (p - 90) * 2.0);
const up = [[0, 100], [80, 98], [160, 104], [240, 101], [300, 108], [380, 125], [450, 170], [520, 230], [580, 270], [640, 300], [700, 310]].map(([x, p]) => [x, Y(p)]);
const dn = [[700, Y(310)], [740, Y(296)], [790, Y(230)], [850, Y(170)], [920, Y(130)], [1000, Y(118)]];
const line = (pts) => 'M' + pts.map((p) => p.join(',')).join(' L');
const fill = (pts) => line(pts) + ` L${pts[pts.length - 1][0]},560 L${pts[0][0]},560 Z`;
const BARX = Array.from({ length: 16 }, (_, i) => 30 + i * 60);
const BARH = [70, 62, 80, 74, 66, 78, 84, 72, 11, 8, 6, 5, 4, 70, 84, 92]; // 0–7 обычный спрос, 8–12 «разгон» (почти нет продаж), 13–15 — все продают
const bars = BARX.map((x, i) => `<rect id="bar${i}" x="${x}" y="700" width="40" height="0" rx="6" fill="${i >= 13 ? '#ff5d73' : i >= 8 ? '#c9a24a' : '#4f6a96'}"/>`).join('');

// Точка идёт по ломаной; длительность отрезка пропорциональна его ширине (ровно как открывается линия).
const trace = (clipId, dotColor, pts, t0, t1, from = 0) => {
  const total = pts[pts.length - 1][0] - pts[0][0];
  js += `  tl.fromTo("#${clipId}", { attr: { width: ${from} } }, { attr: { width: ${from + total} }, duration: ${r2(t1 - t0)}, ease: "none" }, ${at(t0)});\n`;
  let t = t0;
  for (let i = 1; i < pts.length; i++) {
    const d = ((pts[i][0] - pts[i - 1][0]) / total) * (t1 - t0);
    js += `  tl.fromTo("#dot", { attr: { cx: ${pts[i - 1][0]}, cy: ${pts[i - 1][1]} } }, { attr: { cx: ${pts[i][0]}, cy: ${pts[i][1]} }, duration: ${r2(d)}, ease: "none", immediateRender: false }, ${at(t)});\n`;
    js += `  tl.fromTo("#dotr", { attr: { cx: ${pts[i - 1][0]}, cy: ${pts[i - 1][1]} } }, { attr: { cx: ${pts[i][0]}, cy: ${pts[i][1]} }, duration: ${r2(d)}, ease: "none", immediateRender: false }, ${at(t)});\n`;
    t += d;
  }
  void dotColor;
};
const tx = (x, t0, t1) => t0 + (x / 700) * (t1 - t0); // время, когда линия дошла до x

// A. 0–3.9: цена втрое за неделю, счётчик «×»
js += `  tl.set("#dot, #dotr", { attr: { cx: 0, cy: ${Y(100)} } }, 0);\n`;
js += `  tl.fromTo("#chartw", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" }, 0);\n`;
js += `  tl.fromTo("#hud", { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.25 }, 0.05);\n`;
trace('cuR', '#3be59a', up, 0.12, 3.62);
for (let t = 0.2; t <= 3.62; t += 0.1) {
  const x = ((t - 0.12) / 3.5) * 700; let p = 100;
  for (let i = 1; i < up.length; i++) if (x <= up[i][0]) { const f = (x - up[i - 1][0]) / (up[i][0] - up[i - 1][0]); const pa = 560 - up[i - 1][1], pb = 560 - up[i][1]; p = 90 + (pa + (pb - pa) * f) / 2.0; break; }
  js += `  tl.set("#mult", { textContent: "×${(Math.min(p, 310) / 100).toFixed(1).replace('.', ',')}" }, ${at(t)});\n`;
}
js += `  tl.fromTo("#mult", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.25, ease: "back.out(2)" }, 0.12);\n`;
js += `  tl.fromTo("#dotr", { attr: { r: 15 }, opacity: 1 }, { attr: { r: 38 }, opacity: 0, duration: 0.6, repeat: 5, ease: "power2.out" }, 0.3);\n`;

// B. 4.04–5.2: «СХЕМА» — график замирает, красный глитч
js += `  tl.to("#redtint", { opacity: 0.22, duration: 0.1 }, 3.98);\n  tl.to("#redtint", { opacity: 0, duration: 0.3 }, 5.0);\n`;
js += `  tl.fromTo("#stamp", { scale: 3, rotation: -18, opacity: 0 }, { scale: 1, rotation: -8, opacity: 1, duration: 0.16, ease: "power4.in" }, 4.38);\n`;
js += `  tl.fromTo("#stamp i", { x: 0 }, { x: 14, duration: 0.05, yoyo: true, repeat: 5, ease: "none", immediateRender: false }, 4.5);\n`;
js += `  tl.fromTo("#stamp b", { x: 0 }, { x: -14, duration: 0.05, yoyo: true, repeat: 5, ease: "none", immediateRender: false }, 4.5);\n`;
js += `  tl.fromTo("#chartw", { x: -16 }, { x: 0, duration: 0.3, ease: "elastic.out(1.2,0.3)", immediateRender: false }, 4.04);\n`;
js += `  tl.to("#stamp", { opacity: 0, scale: 1.3, duration: 0.12 }, 5.18);\n`;

// C. 5.26–10.1: как работает схема — перемотка, шаг 1 «скупают», шаг 2 «задирают», тихий объём
js += `  tl.to("#cuR", { attr: { width: 0 }, duration: 0.12, ease: "power2.in" }, 5.14);\n  tl.to("#mult", { opacity: 0, duration: 0.1 }, 5.14);\n  tl.to("#dot, #dotr", { attr: { cx: 0, cy: ${Y(100)} }, duration: 0.12 }, 5.14);\n`;
trace('cuR', '#3be59a', up, 5.3, 8.9);
js += `  tl.fromTo("#chip1", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.2, ease: "power3.out" }, 5.7);\n`;
js += `  tl.to("#chip1", { opacity: 0, y: -20, duration: 0.15 }, 7.55);\n`;
js += `  tl.fromTo("#chip2", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.2, ease: "power3.out" }, 7.72);\n`;
js += `  tl.to("#chip2", { opacity: 0, duration: 0.15 }, 10.1);\n`;
BARX.slice(0, 13).forEach((x, i) => {
  const t = i < 8 ? tx(x - 20, 5.3, 8.9) : tx(Math.min(x, 700), 5.3, 8.9);
  js += `  tl.fromTo("#bar${i}", { attr: { height: 0, y: 700 } }, { attr: { height: ${BARH[i]}, y: ${700 - BARH[i]} }, duration: 0.22, ease: "back.out(1.6)" }, ${at(Math.max(5.35, t))});\n`;
});
js += `  tl.fromTo("#brk", { opacity: 0, scaleX: 0.3 }, { opacity: 1, scaleX: 1, duration: 0.25, ease: "power3.out" }, 8.78);\n`;
js += `  tl.to("#brk", { opacity: 0, duration: 0.15 }, 10.2);\n`;

// D. 10.26–13.5: «эксперты» — реплики поверх затемнённого графика
js += `  tl.to("#chartw", { opacity: 0.2, filter: "blur(5px)", duration: 0.2 }, 10.22);\n`;
[[11.17, 'b1', -1], [11.96, 'b2', 1], [12.75, 'b3', -1]].forEach(([t, id, side]) => {
  js += `  tl.fromTo("#${id}", { opacity: 0, scale: 0.4, x: ${side * 80}, y: 40 }, { opacity: 1, scale: 1, x: 0, y: 0, duration: 0.34, ease: "elastic.out(1,0.55)" }, ${at(t)});\n`;
});
js += `  tl.to("#b1, #b2, #b3", { opacity: 0, y: -60, duration: 0.18, ease: "power2.in" }, 13.38);\n`;
js += `  tl.to("#chartw", { opacity: 1, filter: "blur(0px)", duration: 0.2 }, 13.4);\n`;

// E. 13.56–16.52: «ты берёшь на пике» — метка, обвал, красная точка
js += `  tl.fromTo("#you", { opacity: 0, scale: 0.4, y: -30 }, { opacity: 1, scale: 1, y: 0, duration: 0.3, ease: "back.out(2.4)" }, 13.8);\n`;
js += `  tl.fromTo("#dotr", { attr: { r: 15 }, opacity: 1 }, { attr: { r: 60 }, opacity: 0, duration: 0.5, ease: "power2.out", immediateRender: false }, 14.35);\n`;
js += `  tl.set("#dot", { attr: { fill: "#ff5d73" } }, 14.9);\n  tl.set("#dotr", { attr: { stroke: "#ff5d73" } }, 14.9);\n`;
trace('cdR', '#ff5d73', dn, 14.9, 16.4, 0);
[13, 14, 15].forEach((i) => { const t = 14.9 + ((BARX[i] - 700) / 300) * 1.5; js += `  tl.fromTo("#bar${i}", { attr: { height: 0, y: 700 } }, { attr: { height: ${BARH[i]}, y: ${700 - BARH[i]} }, duration: 0.22, ease: "back.out(1.6)" }, ${at(t)});\n`; });
js += `  tl.fromTo("#drop", { opacity: 0, scale: 2.2 }, { opacity: 1, scale: 1, duration: 0.16, ease: "power4.in" }, 15.9);\n`;
js += `  tl.fromTo("#chartw", { y: 0 }, { y: 8, duration: 0.06, yoyo: true, repeat: 3, ease: "none", immediateRender: false }, 15.9);\n`;

// F. 16.68–22.0: три красных флага (карточки влетают по словам)
js += `  tl.to("#chartw", { opacity: 0, scale: 0.9, y: -50, duration: 0.25, ease: "power2.in" }, 16.6);\n  tl.to("#hud, #you, #drop", { opacity: 0, duration: 0.2 }, 16.6);\n`;
[[17.62, 'f1'], [18.72, 'f2'], [20.42, 'f3']].forEach(([t, id]) => {
  js += `  tl.fromTo("#${id}", { x: 1100, rotation: 4, opacity: 1 }, { x: 0, rotation: 0, duration: 0.42, ease: "expo.out" }, ${at(t)});\n`;
  js += `  tl.fromTo("#${id} .flag", { rotation: -12 }, { rotation: 10, transformOrigin: "10% 100%", duration: 0.22, yoyo: true, repeat: 7, ease: "sine.inOut" }, ${at(t + 0.3)});\n`;
  js += `  tl.to("#${id}", { x: -1150, duration: 0.3, ease: "power3.in" }, 22.0);\n`;
});
BARH.slice(0, 1); // (мини-графики внутри карточек статичны)
js += `  tl.fromTo("#f1 .mini i", { scaleY: 0 }, { scaleY: 1, duration: 0.2, stagger: 0.03, transformOrigin: "50% 100%" }, 17.9);\n`;
js += `  tl.fromTo("#f2 .mini i", { scaleY: 0 }, { scaleY: 1, duration: 0.3, stagger: 0.12, transformOrigin: "50% 100%", ease: "back.out(1.5)" }, 19.0);\n`;
js += `  tl.fromTo("#f3 .qm", { scale: 0, rotation: -40 }, { scale: 1, rotation: 0, duration: 0.3, ease: "back.out(2.5)" }, 20.9);\n`;

// G. 22.06–24.7: бот предупреждает
js += `  tl.set("#pmw", { opacity: 1 }, 21.95);\n  tl.fromTo("#pmw", { y: 2100, rotation: 3 }, { y: 0, rotation: 0, duration: 0.45, ease: "expo.out" }, 22.0);\n`;
js += `  tl.to(".pm-r", { backgroundColor: "rgba(255,214,107,.28)", duration: 0.2, stagger: 0.38 }, 22.5);\n`;
js += `  tl.fromTo("#pm", { scale: 0.96 }, { scale: 1, duration: 0.5, ease: "elastic.out(1,0.6)", immediateRender: false }, 22.1);\n`;
js += `  tl.to("#pmw", { y: -2100, duration: 0.3, ease: "power3.in" }, 24.55);\n  tl.set("#pmw", { opacity: 0 }, 24.9);\n`;

// H. 24.76–27.17: финал
js += `  tl.fromTo("#endw", { opacity: 0 }, { opacity: 1, duration: 0.15 }, 24.6);\n`;
js += `  tl.fromTo("#elg", { scale: 0.3, rotation: -25, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, 24.74);\n`;
js += `  tl.fromTo("#enm i", { opacity: 0, y: 70 }, { opacity: 1, y: 0, duration: 0.22, stagger: 0.05, ease: "back.out(2)" }, 24.8);\n`;
js += `  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, 25.3);\n`;
js += `  tl.fromTo("#efr", { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, 26.05);\n`;
js += `  tl.fromTo("#endw", { scale: 1.05 }, { scale: 1, duration: 0.35, ease: "power2.out", immediateRender: false }, 26.2);\n`;

const sfx = [['whoosh', 0.0, 0.25], ['pop', 4.38, 0.55], ['whoosh', 5.12, 0.25], ['pop', 5.7, 0.35], ['pop', 7.72, 0.35], ['pop', 8.8, 0.4], ['pop', 11.17, 0.5], ['pop', 11.96, 0.5], ['pop', 12.75, 0.5],
  ['pop', 13.82, 0.5], ['pop', 15.92, 0.6], ['whoosh', 17.6, 0.3], ['whoosh', 18.7, 0.3], ['whoosh', 20.4, 0.3], ['whoosh', 21.98, 0.3], ['pop', 22.5, 0.4], ['whoosh', 24.5, 0.3], ['pop', 26.07, 0.6]]
  .map(([n, t, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${n}.wav" data-start="${t}" data-duration="${n === 'pop' ? 0.12 : 0.45}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

const flag = '<svg class="flagw" viewBox="0 0 80 100" width="86" height="108"><rect x="8" y="6" width="7" height="92" rx="3" fill="#c5cde0"/><g class="flag"><path d="M15 10 L72 24 L15 44 Z" fill="#ff3b55"/></g></svg>';
const card = (id, top, title, sub, mini) => `<div class="fc" id="${id}" style="top:${top}px">${flag}<div class="ft"><b>${title}</b><span>${sub}</span></div><div class="mini">${mini}</div></div>`;
const tiny = Array.from({ length: 7 }, (_, i) => `<i style="height:${[8, 12, 7, 10, 6, 9, 5][i]}px;background:#c9a24a"></i>`).join('');
const two = '<i style="height:120px;background:#ff5d73"></i><i style="height:62px;background:#4f6a96"></i>';
const upq = '<svg viewBox="0 0 120 90" width="130" height="98"><path d="M4 80 L40 74 L70 60 L96 14" stroke="#3be59a" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><b class="qm">?</b>';

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #060a14; }
  #main { font-family: Montserrat, Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage, #bg { position: absolute; inset: 0; }
  #bg { background: radial-gradient(900px 700px at 50% 30%, rgba(60,110,200,.22), transparent 70%), linear-gradient(rgba(120,150,210,.06) 1px, transparent 1px) 0 0 / 60px 60px, linear-gradient(90deg, rgba(120,150,210,.06) 1px, transparent 1px) 0 0 / 60px 60px, #070c18; }
  #redtint { position: absolute; inset: 0; background: #ff2a44; opacity: 0; }
  #hud { position: absolute; left: 60px; top: 196px; font: 600 28px/1 "IBM Plex Mono", monospace; letter-spacing: 2px; color: #8fa3cc; opacity: 0; }
  #hud:before { content: ""; display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: #ff5d73; margin-right: 14px; }
  #chartw { position: absolute; left: 60px; top: 250px; width: 960px; opacity: 0; }
  #chart { display: block; }
  #mult { position: absolute; left: 96px; top: 290px; font-size: 150px; font-weight: 900; letter-spacing: -4px; color: #3be59a; text-shadow: 0 0 50px rgba(59,229,154,.5); opacity: 0; }
  .chip { position: absolute; left: 96px; padding: 14px 26px; border-radius: 16px; font: 600 38px/1 "IBM Plex Mono", monospace; opacity: 0; }
  #chip1 { top: 650px; background: rgba(79,106,150,.35); border: 3px solid #4f6a96; color: #cfe0ff; }
  #chip2 { top: 420px; background: rgba(201,162,74,.22); border: 3px solid #c9a24a; color: #ffd66b; }
  #brk { position: absolute; left: 440px; top: 930px; width: 280px; opacity: 0; transform-origin: 50% 100%; text-align: center; font: 600 32px/1.1 "IBM Plex Mono", monospace; color: #ff8a9b; }
  #brk:after { content: ""; display: block; margin: 10px 0 0; height: 20px; border: 5px solid #ff5d73; border-top: 0; border-radius: 0 0 14px 14px; }
  #stamp { position: absolute; left: 0; right: 0; top: 520px; text-align: center; font-size: 190px; font-weight: 900; letter-spacing: -3px; opacity: 0; pointer-events: none; }
  #stamp span, #stamp i, #stamp b { position: absolute; left: 0; right: 0; font-style: normal; }
  #stamp span { color: #fff; } #stamp i { color: #00e5ff; mix-blend-mode: screen; } #stamp b { color: #ff2a44; mix-blend-mode: screen; }
  .bub { position: absolute; width: 640px; padding: 26px 34px; border-radius: 34px; font: 700 50px/1.15 Inter, sans-serif; opacity: 0; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
  .bub small { display: block; font: 600 26px/1 "IBM Plex Mono", monospace; opacity: .7; margin-bottom: 10px; }
  #b1 { left: 70px; top: 340px; background: #1b2d4d; border-radius: 34px 34px 34px 8px; }
  #b2 { right: 70px; top: 590px; background: #3b2a1d; border-radius: 34px 34px 8px 34px; color: #ffd9a0; }
  #b3 { left: 110px; top: 840px; background: #1b2d4d; border-radius: 34px 34px 34px 8px; }
  #you { position: absolute; left: 560px; top: 246px; padding: 14px 34px; border-radius: 16px; font-size: 56px; font-weight: 900; background: #ffd66b; color: #1a1305; opacity: 0; box-shadow: 0 0 40px rgba(255,214,107,.6); }
  #you:after { content: ""; position: absolute; left: 64%; top: 100%; border: 16px solid transparent; border-top-color: #ffd66b; }
  #drop { position: absolute; right: 70px; top: 700px; font-size: 130px; font-weight: 900; color: #ff5d73; text-shadow: 0 0 40px rgba(255,93,115,.6); opacity: 0; }
  .fc { position: absolute; left: 50px; width: 980px; height: 250px; display: flex; align-items: center; gap: 24px; padding: 0 36px 0 30px; box-sizing: border-box; border-radius: 28px; background: linear-gradient(90deg, #14203a, #0e1730); border: 2px solid rgba(255,93,115,.45); box-shadow: 0 20px 50px rgba(0,0,0,.5); transform: translateX(1100px); }
  .ft b { display: block; font-size: 58px; font-weight: 900; line-height: 1.05; }
  .ft span { display: block; margin-top: 10px; font: 600 28px/1.2 "IBM Plex Mono", monospace; color: #8fa3cc; }
  .mini { margin-left: auto; display: flex; align-items: flex-end; gap: 10px; height: 130px; min-width: 190px; justify-content: flex-end; position: relative; }
  .mini i { display: block; width: 22px; border-radius: 5px; }
  #f2 .mini i { width: 56px; }
  .qm { position: absolute; right: 0; top: -14px; font-size: 80px; color: #ffd66b; }
  #pmw { position: absolute; left: 0; top: 0; right: 0; bottom: 0; transform: translateY(2100px); opacity: 0; }
  #pm { position: absolute; left: 50px; right: 50px; top: 270px; background: #182533; border-radius: 44px 44px 44px 12px; padding: 40px 46px; font: 500 46px/1.3 Inter, sans-serif; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
  #pm .who { display: flex; align-items: center; gap: 18px; font-size: 34px; color: #8fa3cc; margin-bottom: 18px; } #pm .who img { width: 64px; height: 64px; border-radius: 16px; }
  #pm h3 { margin: 0 0 12px; font-size: 58px; color: #ffd66b; } #pm .pm-r { border-radius: 12px; padding: 6px 12px; margin: 8px -12px 0; }
  #endw { position: absolute; inset: 0; opacity: 0; background: radial-gradient(800px 700px at 50% 36%, rgba(231,178,76,.3), transparent 70%); }
  #elg { position: absolute; left: 380px; top: 250px; width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.55); }
  #enm { position: absolute; left: 0; right: 0; top: 630px; text-align: center; font-size: 140px; font-weight: 900; letter-spacing: -3px; text-transform: uppercase; }
  #enm i { display: inline-block; font-style: normal; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 830px; text-align: center; white-space: nowrap; font-size: 54px; font-weight: 900; padding: 24px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1010px; text-align: center; font-size: 76px; font-weight: 900; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; padding: 6px 0; opacity: 0; }
  #caps { position: absolute; left: 0; right: 0; bottom: 560px; height: 0; z-index: 30; }
  .cg { position: absolute; left: 60px; right: 60px; bottom: 0; text-align: center; font-size: 78px; font-weight: 900; line-height: 1.22; opacity: 0; text-shadow: 0 4px 24px rgba(0,0,0,.7); }
  .cw { display: inline-block; padding: 0 14px; border-radius: 16px; background: rgba(255,214,107,0); color: #fff; }
</style>
</head>
<body>
<!-- «Как тебя разводят на скинах» (9:16). Сгенерировано video/edit2/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div id="bg"></div><div id="redtint"></div>
  <div id="hud">СХЕМА · цена скина за 7 дней</div>
  <div id="chartw">
    <svg id="chart" viewBox="0 0 1000 720" width="960" height="691">
      <defs>
        <clipPath id="cu"><rect id="cuR" x="0" y="0" width="0" height="720"/></clipPath>
        <clipPath id="cd"><rect id="cdR" x="700" y="0" width="0" height="720"/></clipPath>
        <linearGradient id="gu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3be59a" stop-opacity=".32"/><stop offset="1" stop-color="#3be59a" stop-opacity="0"/></linearGradient>
        <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5d73" stop-opacity=".3"/><stop offset="1" stop-color="#ff5d73" stop-opacity="0"/></linearGradient>
      </defs>
      <g stroke="rgba(143,163,204,.14)" stroke-width="2">${[100, 220, 340, 460, 560].map((y) => `<line x1="0" x2="1000" y1="${y}" y2="${y}"/>`).join('')}</g>
      <text x="6" y="592" fill="#6f84ad" font-family="IBM Plex Mono, monospace" font-size="24">день 1</text><text x="900" y="592" fill="#6f84ad" font-family="IBM Plex Mono, monospace" font-size="24">день 7</text>
      <g clip-path="url(#cu)"><path d="${fill(up)}" fill="url(#gu)"/><path d="${line(up)}" stroke="#3be59a" stroke-width="10" fill="none" stroke-linejoin="round" stroke-linecap="round"/></g>
      <g clip-path="url(#cd)"><path d="${fill(dn)}" fill="url(#gd)"/><path d="${line(dn)}" stroke="#ff5d73" stroke-width="10" fill="none" stroke-linejoin="round" stroke-linecap="round"/></g>
      <text x="6" y="722" fill="#6f84ad" font-family="IBM Plex Mono, monospace" font-size="22" opacity="0">.</text>
      ${bars}
      <circle id="dotr" r="15" cx="0" cy="${Y(100)}" fill="none" stroke="#3be59a" stroke-width="5"/>
      <circle id="dot" r="15" cx="0" cy="${Y(100)}" fill="#3be59a"/>
    </svg>
  </div>
  <div id="mult">×1,0</div>
  <div class="chip" id="chip1">1 · СКУПАЮТ ДЁШЕВОЕ</div>
  <div class="chip" id="chip2">2 · ЗАДИРАЮТ ЦЕНУ</div>
  <div id="brk">продаж почти нет</div>
  <div id="stamp"><i>СХЕМА</i><b>СХЕМА</b><span>СХЕМА</span></div>
  <div class="bub" id="b1"><small>@crypto_guru</small>ВЗЛЕТИТ!! Бери, пока не поздно</div>
  <div class="bub" id="b2"><small>@skin_king</small>Я уже взял, будет иксов десять</div>
  <div class="bub" id="b3"><small>@trader777</small>Последний шанс, все покупают</div>
  <div id="you">ТЫ ПОКУПАЕШЬ</div><div id="drop">−58%</div>
  ${card('f1', 330, 'Мало продаж', 'цену легко сдвинуть', tiny)}
  ${card('f2', 610, 'На других — дешевле', 'рост не подтвердился', two)}
  ${card('f3', 890, 'Рост без причины', 'ни новостей, ни спроса', upq)}
  <div id="pmw"><div id="pm"><div class="who"><img src="assets/logo.png" alt="">Ценолов</div><h3>Похоже на разгон цены</h3>Средняя цена за сутки на 200% выше, чем за месяц.
    <div class="pm-r">• мало продаж: 6 за сутки в Steam</div><div class="pm-r">• на других площадках намного дешевле</div><div class="pm-r">• выросла в 3 раза без большого спроса</div></div></div>
  <div id="endw"><img id="elg" src="assets/logo.png" alt=""><div id="enm">${[...'Ценолов'].map((c) => `<i>${c}</i>`).join('')}</div><div id="etg">@cenolow_bot · Telegram</div><div id="efr">БЕСПЛАТНО</div></div>
  <div id="caps">
    ${caps}</div>
 </div>
  <audio id="voice" class="clip" src="assets/voice.mp3" data-start="0" data-duration="${DUR}" data-track-index="6" data-volume="1"></audio>
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
console.log('ok', GROUPS.length, 'групп субтитров');
