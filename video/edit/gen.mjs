// Эдит-ролик «Это тебе не апгрейдер» (9:16, 31 с) на HyperFrames.
// Голос ElevenLabs задаёт всё время: слова разбросаны по экрану, каждая буква загорается золотом в момент произнесения.
// Сцены: «рулетка апгрейда» (нарисована, не чей-то сайт) → стоп-кадр → золотые потёки → живой интерфейс бота → слоганы → финал.
// node gen.mjs <папка проекта>   (в ней assets/: voice.mp3, transcript.json, ghome/gideas/gprices.mp4, logo.png, ak.png, deagle.png, sfx/, gsap.min.js)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const DUR = 31.16;
const r2 = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- Время слов: распознавание + правки (склейки разорванных слов, пропущенное «В Телеграм» — по паузам) ----------
const raw = JSON.parse(readFileSync(join(DIR, 'assets/transcript.json'), 'utf8'));
const tw = (raw.words || raw).map((w) => ({ s: w.start, e: w.end }));
const merged = [];
for (let i = 0; i < tw.length; i++) {
  if ([2, 25, 41].includes(i)) { merged.push({ s: tw[i].s, e: tw[i + 1].e }); i++; } else merged.push(tw[i]);
}
merged.splice(52, 2, { s: 28.5, e: 29.0 }, { s: 29.36, e: 29.52 }, { s: 29.52, e: 29.95 }, { s: 30.21, e: 30.9 });

// ---------- Фразы: зона (top/mid/bot), строки — текст, размер, поворот, сдвиг. *слово* — акцент ----------
const P = [
  { zone: 'top', lines: [['Опять слил', 104, -5, -60], ['*скины*', 150, 3, 70], ['на апгрейде?', 96, -2, -20]] },
  { zone: 'top', lines: [['Ну да,', 96, 4, -150], ['в этот раз', 104, -3, 60], ['точно *повезёт!*', 92, 2, -10]] },
  { zone: 'mid', lines: [['*Стоп.*', 230, -4, 0], ['Это тебе не', 96, 2, -40], ['*апгрейдер.*', 124, -2, 30]] },
  { zone: 'low', lines: [['Это', 100, -6, -220], ['*Ценолов!*', 170, -3, 0]] },
  { zone: 'top', lines: [['Он за секунду', 92, -3, -40], ['сравнивает', 104, 2, 60], ['цену скина', 96, -2, -70], ['на *12 площадках*', 88, 3, 20]] },
  { zone: 'bot', lines: [['Показывает,', 84, -3, -90], ['где *купить дешевле*', 82, 2, 10], ['и где *продать дороже*', 78, -2, -10]] },
  { zone: 'top', lines: [['Комиссии', 120, -4, -60], ['уже', 96, 5, 190], ['*посчитаны.*', 124, -2, 0]] },
  { zone: 'bot', lines: [['*Вбросы*', 170, -5, -40], ['видит.', 130, 4, 110]] },
  { zone: 'mid2', lines: [['Никакой', 110, -3, -120], ['*лудки.*', 190, 2, 40], ['Никаких', 104, 3, 110], ['*кручений.*', 138, -2, -20], ['Только', 110, -4, -150], ['*голова.*', 200, 2, 10]] },
  { zone: 'bot', lines: [['Завязывай', 100, -4, -70], ['с *рулеткой* —', 96, 3, 50], ['включай *головушку!*', 80, -2, 0]] },
];
const ZONE = { top: 215, mid: 470, low: 1010, bot: 1000, mid2: 330 };
const GOLD = '#ffd66b', W = 1080;

let wi = 0, css = '', html = '', js = '';
const phraseTimes = [];
P.forEach((p, pi) => {
  let y = ZONE[p.zone], firstS = null, lastE = 0, body = '';
  p.lines.forEach(([text, size0, rot, dx], li) => {
    const words = text.split(' ');
    const chars = text.replace(/\*/g, '').length;
    const size = Math.min(size0, Math.floor(960 / (chars * 0.7)));
    let line = '';
    words.forEach((w, k) => {
      const acc = /\*/.test(w), clean = w.replace(/\*/g, '');
      if (clean === '—') { line += `<span class="wd dash" id="p${pi}l${li}d${k}">—</span> `; js += `  tl.fromTo("#p${pi}l${li}d${k}", { opacity: 0 }, { opacity: 1, duration: 0.1 }, ${r2(lastE)});\n`; return; }
      const t = merged[wi++];
      if (firstS === null) firstS = t.s;
      const letters = [...clean];
      const span = Math.min(t.e - t.s, 0.075 * letters.length + 0.12);
      lastE = Math.max(lastE, t.s + span);
      const id = `p${pi}l${li}w${k}`;
      line += `<span class="wd${acc ? ' ac' : ''}" id="${id}">${letters.map((c, i) => `<i id="${id}c${i}">${esc(c)}</i>`).join('')}</span> `;
      // Слово влетает чуть раньше звука, буквы загораются по очереди.
      js += `  tl.fromTo("#${id}", { opacity: 0, scale: ${acc ? 1.7 : 1.35}, y: ${k % 2 ? -26 : 26} }, { opacity: 1, scale: 1, y: 0, duration: 0.16, ease: "back.out(2.2)" }, ${r2(Math.max(0, t.s - 0.07))});\n`;
      letters.forEach((c, i) => {
        const at = r2(t.s + (span * i) / letters.length);
        js += `  tl.to("#${id}c${i}", { color: "${GOLD}", textShadow: "0 0 26px rgba(255,190,60,.95)", duration: 0.05 }, ${at});\n`;
        if (acc) js += `  tl.fromTo("#${id}c${i}", { y: 0 }, { y: -14, duration: 0.07, yoyo: true, repeat: 1, ease: "power2.out" }, ${at});\n`;
      });
    });
    body += `<div class="ln" style="top:${y}px;font-size:${size}px;transform:translateX(${dx}px) rotate(${rot}deg) skewX(-7deg)">${line.trim()}</div>`;
    y += Math.round(size * 1.16);
  });
  const end = pi + 1 < P.length ? null : lastE + 0.5;
  phraseTimes.push({ s: firstS, e: lastE, y0: ZONE[p.zone], y1: y });
  html += `    <div class="ph" id="ph${pi}"><div class="bk" style="top:${ZONE[p.zone] - 110}px;height:${y - ZONE[p.zone] + 220}px"></div>${body}</div>\n`;
  void end;
});
// Фраза держится до начала следующей (минус 0,06 с), потом вылетает.
phraseTimes.forEach((t, i) => {
  const out = i + 1 < phraseTimes.length ? phraseTimes[i + 1].s - 0.07 : t.e + 0.25;
  js += `  tl.set("#ph${i}", { opacity: 1 }, ${r2(Math.max(0, t.s - 0.1))});\n  tl.to("#ph${i}", { opacity: 0, scale: 1.12, duration: 0.1, ease: "power2.in" }, ${r2(out - 0.1)});\n  tl.set("#ph${i}", { opacity: 0, visibility: "hidden" }, ${r2(out)});\n`;
});

// ---------- Камера по записи экрана: точка (fx, fy) записи 1080×2338 → в (540, focusY), масштаб s ----------
const cam = (fx, fy, s, fY) => ({ x: Math.round(540 - fx * s), y: Math.round(fY - fy * s), scale: s });
const SHOTS = [
  { id: 'c1', clip: 'gprices', from: 4.25, start: 10.05, dur: 4.07, fY: 1090, cam: [[0, 540, 1230, 1.12], [2.3, 540, 1230, 1.2], [2.6, 540, 1230, 1.5], [4.07, 540, 1230, 1.42]], in: 'R' },
  { id: 'c2', clip: 'gideas', from: 1.0, start: 14.12, dur: 3.6, fY: 520, cam: [[0, 540, 640, 1.25], [0.75, 540, 640, 1.3], [1.05, 215, 640, 2.5], [2.0, 215, 640, 2.4], [2.3, 540, 640, 2.5], [3.6, 540, 640, 2.35]], in: 'L' },
  { id: 'c3', clip: 'gideas', from: 3.2, start: 17.72, dur: 2.4, fY: 1010, cam: [[0, 800, 700, 2.0], [2.4, 800, 700, 2.25]], in: 'U' },
  { id: 'c4', clip: 'ghome', from: 1.0, start: 25.45, dur: 3.1, fY: 520, cam: [[0, 540, 1050, 1.02], [3.1, 540, 1080, 1.14]], in: 'R' },
];
const IN = { R: '{ x: 900, rotationY: -38, rotationZ: 6, opacity: 0 }', L: '{ x: -900, rotationY: 38, rotationZ: -6, opacity: 0 }', U: '{ y: 1200, rotationX: 30, opacity: 0 }' };
let shots = '';
for (const s of SHOTS) {
  shots += `  <div class="cam" id="${s.id}c"><div class="ent" id="${s.id}e"><video class="clip" id="${s.id}" src="assets/${s.clip}.mp4" data-start="${s.start}" data-duration="${s.dur}" data-media-start="${s.from}" data-track-index="1" muted playsinline></video></div></div>\n`;
  const c0 = cam(...s.cam[0].slice(1), s.fY);
  js += `  tl.set("#${s.id}c", { x: ${c0.x}, y: ${c0.y}, scale: ${c0.scale} }, 0);\n`;
  js += `  tl.fromTo("#${s.id}e", ${IN[s.in]}, { x: 0, y: 0, rotationX: 0, rotationY: 0, rotationZ: 0, opacity: 1, duration: 0.42, ease: "expo.out" }, ${s.start});\n`;
  for (let i = 1; i < s.cam.length; i++) {
    const [t, fx, fy, sc] = s.cam[i], prev = s.cam[i - 1][0], c = cam(fx, fy, sc, s.fY), d = t - prev;
    js += `  tl.to("#${s.id}c", { x: ${c.x}, y: ${c.y}, scale: ${c.scale}, duration: ${r2(d)}, ease: "${d <= 0.5 ? 'power4.inOut' : 'sine.inOut'}" }, ${r2(s.start + prev)});\n`;
  }
}

// ---------- Золотые потёки (переход): полосы стекают сверху, закрывают кадр и уходят вниз ----------
const drips = (id, at) => {
  const lens = [0.86, 1.1, 0.74, 1.22, 0.95, 1.3, 0.8, 1.15, 0.9];
  let h = `  <div class="clip drip" id="${id}" data-start="${r2(at - 0.3)}" data-duration="0.95" data-track-index="5">`;
  lens.forEach((L, i) => {
    h += `<b id="${id}b${i}" style="left:${i * 120}px;height:${Math.round(1920 * (1.05 + L * 0.35))}px"></b>`;
    const d = ((i * 5) % 9) * 0.022;
    js += `  tl.fromTo("#${id}b${i}", { yPercent: -100 }, { yPercent: 0, duration: 0.3, ease: "power2.in" }, ${r2(at - 0.3 + d)});\n`;
    js += `  tl.to("#${id}b${i}", { yPercent: 100, duration: 0.36, ease: "power2.in" }, ${r2(at + 0.08 + d)});\n`;
  });
  return h + '</div>\n';
};

// ---------- Тряска кадра на ударах ----------
const shake = (at, k = 1) => { js += `  tl.fromTo("#stage", { x: ${-22 * k}, y: ${14 * k} }, { x: 0, y: 0, duration: 0.32, ease: "elastic.out(1.2, 0.25)", immediateRender: false }, ${at});\n`; };
[2.72, 6.3].forEach((t) => shake(t)); shake(6.81, 1.6); [21.77, 22.86, 24.17].forEach((t) => shake(t, 1.2)); shake(28.5, 1.3);

// ---------- Сцены ----------
js += `
  // Рулетка: два «прокрута», оба мимо зелёной зоны.
  tl.fromTo("#arm", { rotation: 0 }, { rotation: 1280, duration: 2.3, ease: "power3.out" }, 0.35);
  tl.to("#arm", { rotation: 2660, duration: 2.9, ease: "power3.out" }, 3.35);
  tl.fromTo("#miss1", { scale: 2.6, opacity: 0, rotation: -24 }, { scale: 1, opacity: 1, rotation: -12, duration: 0.18, ease: "power4.in" }, 2.56);
  tl.to("#miss1", { opacity: 0, duration: 0.15 }, 3.25);
  tl.fromTo("#miss2", { scale: 2.6, opacity: 0, rotation: 20 }, { scale: 1, opacity: 1, rotation: 10, duration: 0.18, ease: "power4.in" }, 6.14);
  tl.fromTo("#loss", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.2 }, 2.75);
  tl.set("#loss b", { textContent: "−458 ₴" }, 6.32);
  tl.fromTo("#loss", { scale: 1.5 }, { scale: 1, duration: 0.25, ease: "back.out(2)", immediateRender: false }, 6.32);
  tl.to("#skin", { filter: "grayscale(1) brightness(.5)", y: 26, rotation: -9, duration: 0.3 }, 2.74);
  tl.to("#skin", { filter: "grayscale(0) brightness(1)", y: 0, rotation: 0, duration: 0.25 }, 3.3);
  tl.to("#skin", { filter: "grayscale(1) brightness(.4)", y: 40, rotation: 12, duration: 0.3 }, 6.32);
  tl.fromTo("#ring", { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.6)" }, 0);
  // «Стоп»: вспышка, стоп-кадр уходит в серое, красный крест.
  tl.fromTo("#flash", { opacity: 0.95 }, { opacity: 0, duration: 0.28, ease: "power2.out", immediateRender: false }, 6.81);
  tl.to("#wheelin", { filter: "grayscale(1) brightness(.32) blur(3px)", scale: 1.16, duration: 0.22, ease: "power3.out" }, 6.81);
  tl.fromTo("#x1", { scaleX: 0 }, { scaleX: 1, duration: 0.16, ease: "power4.out" }, 6.84);
  tl.fromTo("#x2", { scaleX: 0 }, { scaleX: 1, duration: 0.16, ease: "power4.out" }, 6.95);
  // «Это Ценолов!»: логотип с ударом и кольцами.
  tl.fromTo("#lg", { scale: 0.2, rotation: -40, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.45, ease: "back.out(2)" }, 9.1);
  tl.fromTo("#lgr", { scale: 0.5, opacity: 0.9 }, { scale: 3.2, opacity: 0, duration: 0.8, ease: "power2.out" }, 9.22);
  // «Вбросы видит»: сообщение бота падает сверху.
  tl.fromTo("#pm", { y: -700, rotation: -8, opacity: 0 }, { y: 0, rotation: -2, opacity: 1, duration: 0.4, ease: "back.out(1.5)" }, 20.14);
  tl.to(".pm-r", { backgroundColor: "rgba(255,214,107,.26)", duration: 0.2, stagger: 0.14 }, 20.5);
  // Слоганы: зачёркивания.
  tl.fromTo("#st1", { scaleX: 0 }, { scaleX: 1, duration: 0.16, ease: "power4.out" }, 22.62);
  tl.fromTo("#st2", { scaleX: 0 }, { scaleX: 1, duration: 0.16, ease: "power4.out" }, 24.0);
  tl.fromTo("#kbg", { scale: 1.3 }, { scale: 1, duration: 3.7, ease: "none" }, 21.75);
  tl.fromTo("#halo", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power3.out" }, 24.6);
  // Финал.
  tl.fromTo("#elg", { scale: 0.3, rotation: -30, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.4, ease: "back.out(2)" }, 28.5);
  tl.fromTo("#enm i", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.2, stagger: 0.045, ease: "back.out(2)" }, 28.52);
  tl.fromTo("#etg", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.2)" }, 29.34);
  tl.fromTo("#efr", { scale: 2.2, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -5, duration: 0.2, ease: "power4.in" }, 30.16);
  tl.fromTo("#stage", { scale: 1.06 }, { scale: 1, duration: 0.3, ease: "power2.out", immediateRender: false }, 30.36);
`;
const sfx = [['whoosh', 8.72, 0.3], ['whoosh', 10.0, 0.28], ['whoosh', 14.07, 0.28], ['whoosh', 17.67, 0.28], ['whoosh', 20.08, 0.28], ['whoosh', 25.4, 0.28], ['whoosh', 28.1, 0.3],
  ['pop', 2.74, 0.5], ['pop', 6.32, 0.5], ['pop', 6.83, 0.6], ['pop', 9.24, 0.5], ['pop', 21.79, 0.5], ['pop', 22.88, 0.5], ['pop', 24.19, 0.55], ['pop', 30.36, 0.55]]
  .map(([n, at, v], i) => `  <audio id="fx${i}" class="clip" src="assets/sfx/${n}.wav" data-start="${at}" data-duration="${n === 'pop' ? 0.12 : 0.45}" data-track-index="7" data-volume="${v}"></audio>`).join('\n');

const st = (pi, li) => { let y = ZONE[P[pi].zone]; for (let i = 0; i < li; i++) { const [t, s0] = P[pi].lines[i]; y += Math.round(Math.min(s0, Math.floor(960 / (t.replace(/\*/g, '').length * 0.7))) * 1.16); } const [t, s0] = P[pi].lines[li]; const sz = Math.min(s0, Math.floor(960 / (t.replace(/\*/g, '').length * 0.7))); return y + Math.round(sz * 0.62); };

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #050505; }
  #main { font-family: Montserrat, Inter, sans-serif; color: #fff; overflow: hidden; }
  #stage { position: absolute; inset: 0; }
  .scene { position: absolute; inset: 0; overflow: hidden; }
  /* Рулетка */
  #wheel { background: radial-gradient(900px 900px at 50% 52%, #3a0d12, #0b0405 70%); }
  #wheelin { position: absolute; inset: 0; }
  #ring { position: absolute; left: 230px; top: 720px; width: 620px; height: 620px; border-radius: 50%; background: conic-gradient(#35d07f 0 90deg, #7a1420 90deg 360deg); box-shadow: 0 0 120px rgba(255,60,80,.35); }
  #ring:after { content: ""; position: absolute; inset: 46px; border-radius: 50%; background: radial-gradient(circle, #1c0a0d, #0c0506); }
  #arm { position: absolute; left: 532px; top: 720px; width: 16px; height: 310px; transform-origin: 8px 310px; z-index: 2; }
  #arm:before { content: ""; position: absolute; left: -17px; top: -6px; border: 25px solid transparent; border-bottom: 70px solid #fff; border-top: 0; filter: drop-shadow(0 0 14px #fff); }
  #skin { position: absolute; left: 350px; top: 880px; width: 380px; height: 300px; object-fit: contain; z-index: 1; }
  #chance { position: absolute; left: 0; right: 0; top: 1380px; text-align: center; font-size: 40px; font-weight: 800; color: #ff8f9b; letter-spacing: 3px; }
  #loss { position: absolute; left: 0; right: 0; top: 1450px; text-align: center; font-size: 96px; font-weight: 900; color: #ff4257; opacity: 0; }
  .miss { position: absolute; left: 240px; top: 930px; width: 600px; text-align: center; font-size: 128px; font-weight: 900; color: #ff3049; border: 12px solid #ff3049; border-radius: 26px; padding: 6px 0; background: rgba(20,2,5,.72); z-index: 3; opacity: 0; }
  .xb { position: absolute; left: -200px; top: 1010px; width: 1480px; height: 46px; background: #ff2a44; box-shadow: 0 0 60px #ff2a44; z-index: 4; }
  #x1w { position: absolute; inset: 0; transform: rotate(38deg); } #x2w { position: absolute; inset: 0; transform: rotate(-38deg); }
  #flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 30; pointer-events: none; }
  /* Золото */
  .gbg { background: radial-gradient(900px 800px at 50% 40%, rgba(231,178,76,.32), transparent 65%), repeating-linear-gradient(135deg, rgba(231,178,76,.05) 0 2px, transparent 2px 34px), #070707; }
  #lg { position: absolute; left: 340px; top: 400px; width: 400px; height: 400px; border-radius: 26%; }
  #lgr { position: absolute; left: 340px; top: 400px; width: 400px; height: 400px; border-radius: 50%; border: 8px solid #ffd66b; }
  .cam { position: absolute; left: 0; top: 0; width: 1080px; height: 2338px; transform-origin: 0 0; }
  .ent { position: absolute; left: 0; top: 0; width: 1080px; height: 2338px; transform-origin: 50% 30%; }
  .persp { position: absolute; inset: 0; perspective: 1400px; }
  .cam video { position: absolute; left: 0; top: 0; width: 1080px; height: 2338px; }
  .drip { position: absolute; inset: 0; z-index: 20; overflow: hidden; }
  .drip b { position: absolute; top: 0; width: 121px; border-radius: 0 0 60px 60px; background: linear-gradient(180deg, #a8741f, #e7b24c 30%, #fbe7a8 55%, #e7b24c 80%, #b97d22); box-shadow: inset -14px 0 22px rgba(120,76,14,.5), inset 12px 0 18px rgba(255,255,255,.35); }
  /* Сообщение бота */
  #pump { background: #0e1621; }
  #pm { position: absolute; left: 50px; right: 50px; top: 230px; background: #182533; border-radius: 44px 44px 44px 12px; padding: 44px 46px; font-family: Inter, sans-serif; font-size: 47px; line-height: 1.3; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
  #pm h3 { margin: 0 0 14px; font-size: 58px; color: #ffd66b; } #pm .pm-r { border-radius: 12px; padding: 6px 10px; margin: 8px -10px 0; }
  /* Слоганы */
  #kin { background: #050505; } #kbg { position: absolute; inset: -80px; background: radial-gradient(700px 700px at 50% 45%, rgba(231,178,76,.2), transparent 70%); }
  .strike { position: absolute; left: 120px; width: 840px; height: 22px; background: #ff2a44; box-shadow: 0 0 40px #ff2a44; transform-origin: 0 50%; z-index: 12; }
  #stw1 { position: absolute; inset: 0; transform: rotate(-3deg); } #stw2 { position: absolute; inset: 0; transform: rotate(2deg); }
  #halo { position: absolute; left: 140px; top: ${st(8, 5) - 300}px; width: 800px; height: 600px; border-radius: 50%; background: radial-gradient(circle, rgba(255,214,107,.42), transparent 65%); opacity: 0; }
  /* Финал */
  #elg { position: absolute; left: 370px; top: 330px; width: 340px; height: 340px; border-radius: 26%; box-shadow: 0 0 120px rgba(231,178,76,.6); }
  #enm { position: absolute; left: 0; right: 0; top: 720px; text-align: center; font-size: 150px; font-weight: 900; letter-spacing: -3px; text-transform: uppercase; }
  #enm i { display: inline-block; font-style: normal; background: linear-gradient(180deg, #fff3c9, #e7b24c 60%, #a8741f); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #etg { position: absolute; left: 110px; right: 110px; top: 930px; text-align: center; white-space: nowrap; font-size: 54px; font-weight: 900; padding: 26px 0; border-radius: 999px; color: #1a1305; background: linear-gradient(180deg, #fbe7a8, #e7b24c 55%, #b97d22); box-shadow: 0 10px 0 #7a5212, 0 30px 70px rgba(231,178,76,.5); }
  #efr { position: absolute; left: 250px; right: 250px; top: 1150px; text-align: center; font-size: 76px; font-weight: 900; color: #35d07f; border: 9px solid #35d07f; border-radius: 22px; padding: 6px 0; }
  /* Субтитры: слова разбросаны, буквы загораются */
  #caps { position: absolute; inset: 0; z-index: 25; pointer-events: none; }
  .ph { position: absolute; inset: 0; opacity: 0; }
  .bk { position: absolute; left: -80px; right: -80px; background: linear-gradient(180deg, transparent, rgba(5,5,5,.9) 24%, rgba(5,5,5,.9) 76%, transparent); }
  .ln { position: absolute; left: 0; right: 0; text-align: center; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; line-height: 1.1; white-space: nowrap; }
  .wd { display: inline-block; opacity: 0; -webkit-text-stroke: 14px #050505; paint-order: stroke fill; }
  .wd i { display: inline-block; font-style: normal; color: #fff; }
  .wd.dash { color: #fff; }
</style>
</head>
<body>
<!-- Эдит «Это тебе не апгрейдер» (9:16). Сгенерировано video/edit/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div class="clip scene" id="wheel" data-start="0" data-duration="9.12" data-track-index="1">
    <div id="wheelin"><div id="ring"></div><img id="skin" src="assets/ak.png" alt=""><div id="arm"></div>
      <div id="chance">ШАНС 25%</div><div id="loss"><b>−229 ₴</b></div>
      <div class="miss" id="miss1">МИМО</div><div class="miss" id="miss2">МИМО</div></div>
    <div id="x1w"><div class="xb" id="x1"></div></div><div id="x2w"><div class="xb" id="x2"></div></div>
  </div>
  <div class="clip scene gbg" id="logo" data-start="9.05" data-duration="1.1" data-track-index="2"><div id="lgr"></div><img id="lg" src="assets/logo.png" alt=""></div>
  <div class="clip scene gbg" id="ui" data-start="10.05" data-duration="10.07" data-track-index="3"></div>
  <div class="clip scene gbg" id="ui2" data-start="25.45" data-duration="3.2" data-track-index="3"></div>
  <div class="persp">
${shots}  </div>
  <div class="clip scene" id="pump" data-start="20.12" data-duration="1.66" data-track-index="2">
    <div id="pm"><h3>Похоже на разгон цены</h3>Цена за сутки на 200% выше, чем за месяц.
      <div class="pm-r">• мало продаж: 6 за сутки</div><div class="pm-r">• на других площадках намного дешевле</div><div class="pm-r">• выросла в 3 раза без спроса</div></div>
  </div>
  <div class="clip scene" id="kin" data-start="21.75" data-duration="3.72" data-track-index="2"><div id="kbg"></div><div id="halo"></div>
    <div id="stw1"><div class="strike" id="st1" style="top:${st(8, 1)}px"></div></div><div id="stw2"><div class="strike" id="st2" style="top:${st(8, 3)}px"></div></div></div>
  <div class="clip scene gbg" id="end" data-start="28.42" data-duration="${r2(DUR - 28.42)}" data-track-index="2">
    <img id="elg" src="assets/logo.png" alt=""><div id="enm">${[...'Ценолов'].map((c) => `<i>${c}</i>`).join('')}</div>
    <div id="etg">@cenolow_bot · Telegram</div><div id="efr">БЕСПЛАТНО</div></div>
${drips('dr1', 9.05)}${drips('dr2', 28.42)}
  <div id="caps">
${html}  </div>
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
console.log('ok', wi, 'слов из', merged.length);
