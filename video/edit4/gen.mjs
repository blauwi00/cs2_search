// Ролик «7 дней трейд-бана» (9:16, 35 с, голос Sofiia): счётчик дней перелистывается под голос, замок трескается на седьмом дне,
// затем сообщение бота «Можно продавать». Субтитры — по одному слову-блоку, с цветом по смыслу.
// Звуки под реплики: сердцебиение, тиканье, щелчок замка, звонок — синтезированы ffmpeg (video/edit4/sfx.sh), голос — ElevenLabs.
// node gen.mjs <папка проекта>  (assets/: voice.mp3, transcript.json, logo.png, skin.png, sfx/, gsap.min.js)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const DUR = 35.4;
const r2 = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const raw = JSON.parse(readFileSync(join(DIR, 'assets/transcript.json'), 'utf8'));
const W = (raw.words || raw).map((w) => ({ s: w.start, e: w.end }));
if (W.length !== 51) throw new Error('ожидалось 51 слово, пришло ' + W.length);
// Концы пауз по анализу тишины голоса: начало фразы «прилипает» к ним (распознавание сдвигает первые слова).
const SIL = [0.82, 2.2, 2.99, 4.47, 6.0, 7.15, 9.95, 11.33, 11.78, 13.14, 14.23, 20.42, 21.62, 22.6, 24.34, 30.19, 32.63, 34.45];
const snap = (t) => { let b = t, d = 0.4; for (const e of SIL) if (Math.abs(e - t) < d) { d = Math.abs(e - t); b = e; } return b; };

const TXT = ['Купил', 'скин,', 'и', 'продать', 'нельзя.', 'Семь', 'дней.', 'День', 'первый,', 'цена', 'держится,', 'всё', 'нормально.', 'День', 'третий,', 'что-то', 'она', 'упала?', 'Спокойно,', 'спокойно,', 'это', 'просто', 'колебание.', 'День', 'пятый,', 'да', 'когда', 'уже?', 'Шестой,', 'последний.', 'Седьмой', 'день,', 'и', 'Ценолов', 'пишет,', 'можно', 'продавать.', 'Показывает,', 'где', 'выгоднее', 'и', 'сколько', 'придёт.', 'Никакой', 'лудки,', 'только', 'голова.', 'Ценолов,', 'в', 'Телеграм,', 'Бесплатно.'];
// [от слова, до слова, цвет]: w белый, g золото, r красный, o зелёный
const CH = [[0, 0, 'w'], [1, 1, 'w'], [2, 3, 'w'], [4, 4, 'r'], [5, 6, 'g'], [7, 8, 'g'], [9, 10, 'w'], [11, 12, 'w'], [13, 14, 'g'], [15, 16, 'w'], [17, 17, 'r'], [18, 18, 'w'], [19, 19, 'w'], [20, 22, 'w'], [23, 24, 'g'], [25, 26, 'w'], [27, 27, 'r'], [28, 28, 'g'], [29, 29, 'g'], [30, 31, 'g'], [32, 34, 'w'], [35, 36, 'o'], [37, 37, 'w'], [38, 39, 'w'], [40, 42, 'w'], [43, 44, 'r'], [45, 46, 'g'], [47, 47, 'g'], [48, 49, 'w']];
const COL = { w: '#ffffff', g: '#ffd66b', r: '#ff5d73', o: '#35d07f' };

let js = '', caps = '';
CH.forEach(([a, b, c], i) => {
  const s0 = snap(W[a].s), nextS = i + 1 < CH.length ? snap(W[CH[i + 1][0]].s) : DUR;
  const e0 = Math.min(nextS - 0.02, W[b].e + 0.2);
  const txt = TXT.slice(a, b + 1).join(' ').toUpperCase();
  const size = txt.length <= 10 ? 132 : txt.length <= 17 ? 108 : 90;
  caps += `<div class="cp" id="c${i}" style="font-size:${size}px;color:${COL[c]}">${esc(txt)}</div>\n    `;
  js += `  tl.fromTo("#c${i}", { opacity: 0, scale: 0.55, y: 22 }, { opacity: 1, scale: 1, y: 0, duration: 0.13, ease: "back.out(2.6)" }, ${r2(Math.max(0, s0 - 0.03))});\n`;
  js += `  tl.set("#c${i}", { opacity: 0, visibility: "hidden" }, ${r2(e0)});\n`;
});

// ---------- Дни ----------
const DAYS = [[5.93, '1', 'осталось 6 дней'], [9.85, '03', 'осталось 4 дня'], [17.09, '05', 'осталось 2 дня'], [20.33, '06', 'остался 1 день'], [22.55, '07', 'защита закончилась']];
js += `  tl.fromTo("#dayui", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" }, 5.8);\n`;
DAYS.forEach(([t, n, sub], i) => {
  if (i > 0) {
    js += `  tl.to("#dn", { rotationX: 90, duration: 0.1, ease: "power2.in" }, ${r2(t - 0.1)});\n`;
    js += `  tl.set("#dn", { textContent: "${n}", rotationX: -90 }, ${r2(t)});\n  tl.set("#dsub", { textContent: "${sub}" }, ${r2(t)});\n`;
    js += `  tl.to("#dn", { rotationX: 0, duration: 0.18, ease: "back.out(2.2)" }, ${r2(t)});\n`;
    js += `  tl.fromTo("#dcard", { scale: 1.06 }, { scale: 1, duration: 0.3, ease: "power2.out", immediateRender: false }, ${r2(t)});\n`;
  }
  const idx = [1, 3, 5, 6, 7][i];
  for (let k = 1; k < idx; k++) js += `  tl.to("#bx${k}", { backgroundColor: "#262a33", color: "#5d6676", duration: 0.2 }, ${r2(t + 0.05 * k)});\n`;
  js += `  tl.to("#bx${idx}", { borderColor: "${idx === 7 ? '#35d07f' : '#ffd66b'}", color: "${idx === 7 ? '#35d07f' : '#ffd66b'}", scale: 1.12, duration: 0.2, ease: "back.out(2)" }, ${r2(t)});\n`;
});

// ---------- Hook: скин, замок, «7 дней» ----------
js += `  tl.fromTo("#skinw", { opacity: 0, scale: 2.2, y: -300 }, { opacity: 1, scale: 2.4, y: -290, x: 320, duration: 0.4, ease: "back.out(1.4)" }, 0.8);\n`;
js += `  tl.fromTo("#lock", { opacity: 0, scale: 3, y: -200 }, { opacity: 1, scale: 1, y: 0, duration: 0.18, ease: "power4.in" }, 3.2);\n`;
js += `  tl.fromTo("#tape", { opacity: 0, scaleX: 0 }, { opacity: 1, scaleX: 1, duration: 0.2, ease: "power4.out" }, 3.4);\n`;
js += `  tl.fromTo("#skinw", { rotation: 0 }, { rotation: 0, x: 320, y: -290, duration: 0.06, immediateRender: false }, 3.2);\n`;
js += `  tl.fromTo("#hookwrap", { x: -18 }, { x: 0, duration: 0.4, ease: "elastic.out(1.3,0.25)", immediateRender: false }, 3.22);\n`;
js += `  tl.fromTo("#seven", { opacity: 0, scale: 2.6, rotation: -8 }, { opacity: 1, scale: 1, rotation: -3, duration: 0.2, ease: "power4.in" }, 4.8);\n`;
js += `  tl.to("#seven", { opacity: 0, scale: 0.8, duration: 0.18 }, 5.78);\n`;
js += `  tl.to("#skinw", { scale: 1, x: 0, y: 0, duration: 0.45, ease: "power3.inOut" }, 5.75);\n`;
// ---------- Sparkline ----------
const P = [[0, 110], [60, 108], [110, 112], [160, 100], [200, 104], [240, 132], [270, 190], [300, 200], [330, 172], [360, 150], [400, 142], [440, 138], [480, 130], [520, 118], [560, 104], [600, 96]];
const AN = [[0, 5.93], [200, 9.85], [270, 12.8], [300, 13.5], [360, 14.9], [440, 17.09], [520, 20.33], [600, 22.5]];
const tOf = (x) => { for (let i = 1; i < AN.length; i++) if (x <= AN[i][0]) { const f = (x - AN[i - 1][0]) / (AN[i][0] - AN[i - 1][0]); return AN[i - 1][1] + f * (AN[i][1] - AN[i - 1][1]); } return AN[AN.length - 1][1]; };
for (let i = 1; i < P.length; i++) {
  const t0 = tOf(P[i - 1][0]), t1 = tOf(P[i][0]);
  js += `  tl.fromTo("#spR", { attr: { width: ${P[i - 1][0]} } }, { attr: { width: ${P[i][0]} }, duration: ${r2(t1 - t0)}, ease: "none", immediateRender: false }, ${r2(t0)});\n`;
  js += `  tl.fromTo("#sdot", { attr: { cx: ${P[i - 1][0]}, cy: ${P[i - 1][1]} } }, { attr: { cx: ${P[i][0]}, cy: ${P[i][1]} }, duration: ${r2(t1 - t0)}, ease: "none", immediateRender: false }, ${r2(t0)});\n`;
}
js += `  tl.set("#sdot", { attr: { fill: "#ff5d73" } }, ${r2(tOf(240))});\n  tl.set("#sdot", { attr: { fill: "#35d07f" } }, ${r2(tOf(360))});\n`;
js += `  tl.set("#sp, #spa", { attr: { stroke: "#ff5d73" } }, ${r2(tOf(240))});\n  tl.set("#sp", { attr: { stroke: "#35d07f" } }, ${r2(tOf(360))});\n`;

// ---------- День 3: сердцебиение, красная виньетка ----------
[11.85, 12.65, 13.45].forEach((t) => {
  js += `  tl.fromTo("#vig", { opacity: 0.55 }, { opacity: 0, duration: 0.45, ease: "power2.out", immediateRender: false }, ${r2(t)});\n  tl.fromTo("#vig", { opacity: 0.4 }, { opacity: 0, duration: 0.35, immediateRender: false }, ${r2(t + 0.2)});\n`;
  js += `  tl.fromTo("#skinw", { rotation: -4 }, { rotation: 0, duration: 0.3, ease: "elastic.out(1.2,0.3)", immediateRender: false }, ${r2(t)});\n`;
});
js += `  tl.set("#vig", { opacity: 0 }, 0);\n`;
// ---------- «Спокойно»: дыхательное кольцо ----------
js += `  tl.fromTo("#breath", { scale: 0.6, opacity: 0 }, { scale: 1.5, opacity: 0.8, duration: 1.1, ease: "sine.inOut" }, 14.1);\n  tl.to("#breath", { scale: 0.7, duration: 1.1, ease: "sine.inOut" }, 15.2);\n  tl.to("#breath", { scale: 1.5, duration: 1.0, ease: "sine.inOut" }, 16.3);\n  tl.to("#breath", { opacity: 0, duration: 0.3 }, 17.0);\n`;
// ---------- День 5: нервная тряска ----------
for (let t = 18.3; t < 20.2; t += 0.22) js += `  tl.fromTo("#stage", { x: ${(Math.round(t * 10) % 2 ? 1 : -1) * 7} }, { x: 0, duration: 0.1, immediateRender: false }, ${r2(t)});\n`;
// ---------- День 6: приглушение ----------
js += `  tl.to("#dim", { opacity: 0.6, duration: 0.4 }, 20.5);\n  tl.to("#dim", { opacity: 0, duration: 0.15 }, 22.45);\n`;
// ---------- День 7: замок открывается ----------
js += `  tl.to("#lockSh", { rotation: -32, y: -16, svgOrigin: "90 60", duration: 0.25, ease: "back.out(2)" }, 22.95);\n`;
js += `  tl.to("#lockBody, #lockSh", { attr: { fill: "#35d07f" }, duration: 0.1 }, 22.95);\n`;
js += `  tl.set("#lockBody", { attr: { fill: "#35d07f" } }, 22.95);\n  tl.set("#lockSh", { attr: { stroke: "#35d07f" } }, 22.95);\n`;
js += `  tl.fromTo("#shock", { scale: 0.2, opacity: 0.9 }, { scale: 4, opacity: 0, duration: 0.7, ease: "power2.out", immediateRender: false }, 22.95);\n  tl.set("#shock", { opacity: 0 }, 0);\n`;
js += `  tl.fromTo("#flash", { opacity: 0.7 }, { opacity: 0, duration: 0.35, immediateRender: false }, 22.55);\n`;
js += `  tl.to("#tape", { opacity: 0, y: 40, duration: 0.2 }, 22.9);\n`;
// ---------- Сообщение бота ----------
js += `  tl.to("#dayui, #skinw", { opacity: 0.1, duration: 0.2 }, 24.1);\n`;
js += `  tl.set("#nt", { opacity: 1 }, 24.1);\n  tl.fromTo("#nt", { y: -900, rotation: -4 }, { y: 0, rotation: 0, duration: 0.45, ease: "expo.out" }, 24.15);\n`;
js += `  tl.fromTo("#nt", { scale: 0.97 }, { scale: 1, duration: 0.5, ease: "elastic.out(1,0.6)", immediateRender: false }, 24.3);\n`;
js += `  tl.to("#nr1", { backgroundColor: "rgba(255,214,107,.3)", duration: 0.2 }, 28.2);\n  tl.to("#nr1", { backgroundColor: "rgba(255,214,107,0)", duration: 0.2 }, 29.2);\n  tl.to("#nr2", { backgroundColor: "rgba(53,208,127,.3)", duration: 0.2 }, 29.4);\n`;
js += `  tl.to("#nt", { scale: 1.06, y: 20, duration: 1.0, ease: "sine.inOut" }, 28.0);\n`;
js += `  tl.to("#nt", { y: -1000, opacity: 0, duration: 0.3, ease: "power3.in" }, 30.0);\n`;
// ---------- «Никакой лудки, только голова» ----------
js += `  tl.fromTo("#l1", { opacity: 0, x: -400, skewX: 20 }, { opacity: 1, x: 0, skewX: 0, duration: 0.2, ease: "power4.out" }, 30.2);\n`;
js += `  tl.fromTo("#strk", { scaleX: 0 }, { scaleX: 1, duration: 0.18, ease: "power4.out" }, 30.75);\n`;
js += `  tl.fromTo("#l2", { opacity: 0, scale: 2.4 }, { opacity: 1, scale: 1, duration: 0.18, ease: "power4.in" }, 31.25);\n`;
js += `  tl.to("#l1, #l2, #strk", { opacity: 0, y: -80, duration: 0.2 }, 32.5);\n`;
// ---------- Финал ----------
js += `  tl.to("#bg", { opacity: 0.3, duration: 0.2 }, 32.5);\n`;
js += `  tl.fromTo("#endw", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 32.5);\n`;
js += `  tl.fromTo("#elg", { scale: 0.3, rotation: -25, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, 32.62);\n`;
js += `  tl.fromTo("#enm i", { opacity: 0, y: 70 }, { opacity: 1, y: 0, duration: 0.22, stagger: 0.05, ease: "back.out(2)" }, 32.7);\n`;
js += `  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, 33.4);\n`;
js += `  tl.fromTo("#efr", { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, 34.72);\n`;
js += `  tl.fromTo("#endw", { scale: 1.04 }, { scale: 1, duration: 0.3, immediateRender: false }, 34.9);\n`;
js += `  tl.fromTo("#head", { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.3 }, 0.2);\n  tl.to("#head", { opacity: 0, duration: 0.2 }, 32.4);\n`;

// ---------- Звуки ----------
js += `  tl.to("#dayui, #skinw, #head", { opacity: 0, duration: 0.2 }, 30.0);\n`;
const sfx = [['click', 3.2, 0.5], ['slam', 3.22, 0.7], ['slam', 4.82, 0.7], ['whoosh', 5.7, 0.25], ['tick', 5.93, 0.6], ['whoosh', 9.75, 0.25], ['tick', 9.85, 0.6],
  ['thump', 11.85, 0.85], ['thump', 12.03, 0.55], ['thump', 12.65, 0.85], ['thump', 12.83, 0.55], ['thump', 13.45, 0.85], ['thump', 13.63, 0.55],
  ['whoosh', 14.1, 0.18], ['whoosh', 15.2, 0.18], ['whoosh', 16.3, 0.18], ['tick', 17.09, 0.6], ['whoosh', 17.0, 0.25],
  ...Array.from({ length: 8 }, (_, i) => ['tick', 18.35 + i * 0.23, 0.45]), ['tick', 20.33, 0.6], ['whoosh', 20.23, 0.2], ['tick', 22.55, 0.7], ['whoosh', 22.45, 0.3],
  ['click', 22.95, 0.7], ['pop', 22.96, 0.4], ['chime', 24.3, 0.7], ['whoosh', 24.15, 0.3], ['whoosh', 30.0, 0.3], ['pop', 30.76, 0.5], ['pop', 31.27, 0.55], ['whoosh', 32.55, 0.3], ['pop', 32.66, 0.5], ['pop', 34.74, 0.6], ['slam', 34.74, 0.45]]
  .map(([n, t, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${n}.wav" data-start="${r2(t)}" data-duration="${{ pop: 0.12, whoosh: 0.45, tick: 0.06, thump: 0.4, chime: 1.1, slam: 0.5, click: 0.15 }[n]}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

const boxes = Array.from({ length: 7 }, (_, i) => `<b class="bx" id="bx${i + 1}">${i + 1}</b>`).join('');
const spPath = 'M' + P.map((p) => p.join(',')).join(' L');
const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #08090c; }
  #main { font-family: Montserrat, Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage, #bg { position: absolute; inset: 0; }
  #bg { background: radial-gradient(900px 800px at 50% 28%, rgba(255,80,90,.14), transparent 70%), repeating-linear-gradient(0deg, rgba(255,255,255,.02) 0 2px, transparent 2px 6px), #090a0e; }
  #vig { position: absolute; inset: 0; background: radial-gradient(closest-side at 50% 45%, transparent 55%, rgba(255,40,60,.75)); opacity: 0; }
  #dim { position: absolute; inset: 0; background: #000; opacity: 0; z-index: 8; }
  #flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 40; }
  #head { position: absolute; left: 0; right: 0; top: 196px; text-align: center; font: 600 30px/1 "IBM Plex Mono", monospace; letter-spacing: 6px; color: #ff6b7a; opacity: 0; }
  /* дни */
  #dayui { position: absolute; inset: 0; opacity: 0; z-index: 3; }
  #dcard { position: absolute; left: 290px; top: 250px; width: 500px; height: 300px; border-radius: 40px; background: linear-gradient(180deg, #181b23, #10131a); border: 3px solid #2b303b; box-shadow: 0 30px 70px rgba(0,0,0,.6); text-align: center; }
  #dl { position: absolute; left: 0; right: 0; top: 22px; font: 600 30px/1 "IBM Plex Mono", monospace; letter-spacing: 8px; color: #8890a0; }
  #dn { position: absolute; left: 0; right: 0; top: 56px; font: 900 190px/1 "IBM Plex Mono", monospace; color: #ffd66b; text-shadow: 0 0 50px rgba(255,190,60,.4); transform-perspective: 700px; }
  #dsub { position: absolute; left: 0; right: 0; bottom: 20px; font: 500 32px/1 "IBM Plex Mono", monospace; color: #8890a0; }
  #boxes { position: absolute; left: 100px; top: 590px; display: flex; gap: 16px; }
  .bx { display: grid; place-items: center; width: 104px; height: 84px; border-radius: 20px; border: 3px solid #2b303b; font: 700 40px/1 "IBM Plex Mono", monospace; color: #6a7384; background: #12151c; }
  #spw { position: absolute; left: 430px; top: 740px; width: 600px; }
  #skinw { position: absolute; left: 70px; top: 730px; width: 300px; height: 240px; z-index: 6; opacity: 0; }
  #skinw img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 18px 24px rgba(0,0,0,.7)); }
  #lock { position: absolute; right: -10px; bottom: -12px; width: 130px; opacity: 0; }
  #tape { position: absolute; left: -40px; right: -40px; top: 92px; height: 56px; background: repeating-linear-gradient(45deg, #ffcf3a 0 26px, #111 26px 52px); transform: rotate(-9deg); opacity: 0; border-radius: 6px; display: grid; place-items: center; transform-origin: 0 50%; box-shadow: 0 10px 30px rgba(0,0,0,.6); }
  #tape span { background: #111; color: #ffcf3a; font: 800 32px/1 Montserrat, sans-serif; padding: 6px 16px; letter-spacing: 3px; }
  #seven { position: absolute; left: 0; right: 0; top: 860px; text-align: center; font: 900 190px/1 Montserrat, sans-serif; color: #ff4b5c; text-shadow: 0 0 60px rgba(255,75,92,.5); opacity: 0; letter-spacing: -4px; z-index: 5; }
  #shock { position: absolute; left: 70px; top: 760px; width: 300px; height: 300px; border-radius: 50%; border: 12px solid #35d07f; opacity: 0; z-index: 7; }
  #breath { position: absolute; left: 100px; top: 740px; width: 240px; height: 240px; border-radius: 50%; border: 8px solid rgba(110,170,255,.8); box-shadow: 0 0 50px rgba(110,170,255,.5); opacity: 0; }
  /* уведомление */
  #nt { position: absolute; left: 50px; right: 50px; top: 270px; z-index: 12; opacity: 0; background: #182533; border-radius: 44px 44px 44px 12px; padding: 40px 46px; font: 500 44px/1.3 Inter, sans-serif; box-shadow: 0 30px 80px rgba(0,0,0,.7); }
  #nt .who { display: flex; align-items: center; gap: 18px; font-size: 34px; color: #8fa3cc; margin-bottom: 14px; } #nt .who img { width: 64px; height: 64px; border-radius: 16px; }
  #nt h3 { margin: 0 0 10px; font-size: 62px; color: #35d07f; } #nt .nr { border-radius: 12px; padding: 6px 12px; margin: 10px -12px 0; background: rgba(255,214,107,0); }
  #nt .btns { display: flex; gap: 14px; margin-top: 18px; } #nt .btns div { flex: 1; text-align: center; border-radius: 18px; padding: 16px 0; background: rgba(36,51,68,.95); font-size: 34px; font-weight: 700; }
  /* лозунги */
  .big { position: absolute; left: 0; right: 0; text-align: center; font: 900 120px/1 Montserrat, sans-serif; text-transform: uppercase; opacity: 0; z-index: 6; letter-spacing: -3px; }
  #l1 { top: 470px; color: #fff; } #l2 { top: 640px; color: #ffd66b; text-shadow: 0 0 50px rgba(255,190,60,.55); font-size: 140px; }
  #strk { position: absolute; left: 90px; right: 90px; top: 520px; height: 18px; background: #ff3b55; box-shadow: 0 0 36px #ff3b55; transform-origin: 0 50%; z-index: 7; transform: rotate(-2deg); }
  /* финал */
  #endw { position: absolute; inset: 0; opacity: 0; z-index: 9; background: radial-gradient(800px 700px at 50% 34%, rgba(231,178,76,.34), transparent 70%), #060606; }
  #elg { position: absolute; left: 380px; top: 270px; width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.55); }
  #enm { position: absolute; left: 0; right: 0; top: 650px; text-align: center; font-size: 140px; font-weight: 900; letter-spacing: -3px; text-transform: uppercase; }
  #enm i { display: inline-block; font-style: normal; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 850px; text-align: center; white-space: nowrap; font-size: 54px; font-weight: 900; padding: 24px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1020px; text-align: center; font-size: 76px; font-weight: 900; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; padding: 6px 0; opacity: 0; }
  /* субтитры: один блок за раз */
  #caps { position: absolute; left: 40px; right: 40px; bottom: 590px; height: 0; z-index: 30; }
  .cp { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; font-weight: 900; line-height: 1.05; opacity: 0; -webkit-text-stroke: 14px #050505; paint-order: stroke fill; letter-spacing: -1px; }
</style>
</head>
<body>
<!-- «7 дней трейд-бана» (9:16). Сгенерировано video/edit4/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div id="bg"></div><div id="vig"></div>
  <div id="head">ТРЕЙД-БАН · 7 ДНЕЙ</div>
  <div id="hookwrap">
    <div id="skinw"><img src="assets/skin.png" alt="">
      <svg id="lock" viewBox="0 0 120 140"><path id="lockSh" d="M30 62 V40 a30 30 0 0 1 60 0 V62" fill="none" stroke="#ff4b5c" stroke-width="14" stroke-linecap="round"/><rect id="lockBody" x="14" y="58" width="92" height="72" rx="14" fill="#ff4b5c"/><circle cx="60" cy="88" r="9" fill="#2a0b10"/><rect x="56" y="92" width="8" height="20" rx="4" fill="#2a0b10"/></svg>
      <div id="tape"><span>ТРЕЙД-БАН</span></div></div>
    <div id="seven">7 ДНЕЙ</div>
  </div>
  <div id="shock"></div><div id="breath"></div>
  <div id="dayui">
    <div id="dcard"><div id="dl">ДЕНЬ</div><div id="dn">1</div><div id="dsub">осталось 6 дней</div></div>
    <div id="boxes">${boxes}</div>
    <div id="spw"><svg viewBox="0 0 600 220" width="600" height="220">
      <defs><clipPath id="spc"><rect id="spR" x="0" y="0" width="0" height="220"/></clipPath></defs>
      <g stroke="rgba(143,163,204,.16)" stroke-width="2"><line x1="0" x2="600" y1="60" y2="60"/><line x1="0" x2="600" y1="110" y2="110"/><line x1="0" x2="600" y1="160" y2="160"/></g>
      <g clip-path="url(#spc)"><path id="sp" d="${spPath}" stroke="#35d07f" stroke-width="9" fill="none" stroke-linejoin="round" stroke-linecap="round"/></g>
      <circle id="sdot" r="13" cx="0" cy="110" fill="#35d07f"/></svg></div>
  </div>
  <div id="dim"></div>
  <div id="nt"><div class="who"><img src="assets/logo.png" alt="">Ценолов</div><h3>Можно продавать</h3><b>Gallery Case</b> ×9<br>Прошло 7 дней защиты обмена Steam — предмет снова можно продать.
    <div class="nr" id="nr1">Steam: 36,00 ₴ → на баланс ≈ <b>31,31 ₴</b></div><div class="nr" id="nr2">Площадки: ≈ 28,13 ₴ → ≈ <b>27,57 ₴</b> живыми</div>
    <div class="btns"><div>Открыть в Steam</div><div>Продал</div></div></div>
  <div class="big" id="l1">Никакой лудки</div><div id="strk"></div><div class="big" id="l2">Только голова</div>
  <div id="endw"><img id="elg" src="assets/logo.png" alt=""><div id="enm">${[...'Ценолов'].map((c) => `<i>${c}</i>`).join('')}</div><div id="etg">@cenolow_bot · Telegram</div><div id="efr">БЕСПЛАТНО</div></div>
  <div id="caps">
    ${caps}</div>
  <div id="flash"></div>
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
console.log('ok', CH.length, 'блоков субтитров');
