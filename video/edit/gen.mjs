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
const ENTER = ['pop', 'slide', 'slam', 'drop', 'type', 'slide', 'drop', 'slam', 'slam', 'pop'];
const UNDER = [4, 5, 6, 9];
const EXIT = ['{ opacity: 0, scale: 1.12 }', '{ opacity: 0, y: -260 }', '{ opacity: 0, y: 320, rotation: 7 }', '{ opacity: 0, scale: 2.2 }', '{ opacity: 0, x: -700 }', '{ opacity: 0, x: 700 }', '{ opacity: 0, y: 300, rotation: -6 }', '{ opacity: 0, scale: 0.5 }', '{ opacity: 0, scale: 1.5 }', '{ opacity: 0, y: -200 }'];
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
      const style = ENTER[pi], lit = `{ color: "${GOLD}", textShadow: "0 0 26px rgba(255,190,60,.95)", duration: 0.05 }`;
      const t0 = r2(Math.max(0, t.s - 0.07));
      if (style === 'pop') js += `  tl.fromTo("#${id}", { opacity: 0, scale: ${acc ? 1.7 : 1.35}, y: ${k % 2 ? -26 : 26} }, { opacity: 1, scale: 1, y: 0, duration: 0.16, ease: "back.out(2.2)" }, ${t0});\n`;
      else if (style === 'slide') js += `  tl.fromTo("#${id}", { opacity: 0, x: ${li % 2 ? 320 : -320}, skewX: ${li % 2 ? -24 : 24} }, { opacity: 1, x: 0, skewX: 0, duration: 0.2, ease: "power4.out" }, ${t0});\n`;
      else if (style === 'drop') js += `  tl.fromTo("#${id}", { opacity: 0, y: -220, rotation: ${k % 2 ? 14 : -14} }, { opacity: 1, y: 0, rotation: 0, duration: 0.34, ease: "bounce.out" }, ${r2(Math.max(0, t.s - 0.12))});\n`;
      else if (style === 'slam') js += `  tl.fromTo("#${id}", { opacity: 0, scale: 3.4 }, { opacity: 1, scale: 1, duration: 0.13, ease: "power4.in" }, ${r2(Math.max(0, t.s - 0.13))});\n`;
      else js += `  tl.set("#${id}", { opacity: 1 }, ${t0});\n`; // type: буквы «печатаются» сами
      letters.forEach((c, i) => {
        const at = r2(t.s + (span * i) / letters.length);
        if (style === 'type') js += `  tl.fromTo("#${id}c${i}", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.06 }, ${at});\n`;
        js += `  tl.to("#${id}c${i}", ${lit}, ${at});\n`;
        if (acc && style !== 'type') js += `  tl.fromTo("#${id}c${i}", { y: 0 }, { y: -14, duration: 0.07, yoyo: true, repeat: 1, ease: "power2.out" }, ${at});\n`;
      });
      // Акцент: золотой маркер под словом — проводится, когда слово договорено.
      if (acc && UNDER.includes(pi)) { line = line.replace(new RegExp(`(<span class="wd ac" id="${id}">)`), '$1' + `<u id="${id}u"></u>`); js += `  tl.fromTo("#${id}u", { scaleX: 0 }, { scaleX: 1, duration: 0.18, ease: "power3.out" }, ${r2(t.s + span * 0.6)});\n`; }
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
  js += `  tl.set("#ph${i}", { opacity: 1 }, ${r2(Math.max(0, t.s - 0.1))});\n  tl.to("#ph${i}", { ...${EXIT[i]}, duration: 0.14, ease: "power3.in" }, ${r2(out - 0.14)});\n  tl.set("#ph${i}", { opacity: 0, visibility: "hidden" }, ${r2(out)});\n`;
});

// ---------- Камера по записи экрана: точка (fx, fy) записи 1080×2338 → в (540, focusY), масштаб s ----------
const cam = (fx, fy, s, fY) => ({ x: Math.round(540 - fx * s), y: Math.round(fY - fy * s), scale: s });
const SHOTS = [
  { id: 'c1', clip: 'gprices', from: 4.25, start: 10.0, dur: 4.14, fY: 1090, cam: [[0, 540, 1230, 1.12], [2.3, 540, 1230, 1.2], [2.6, 540, 1230, 1.5], [4.14, 540, 1230, 1.42]], in: 'Z', out: 14.0 },
  { id: 'c2', clip: 'gideas', from: 1.0, start: 14.12, dur: 3.6, fY: 520, cam: [[0, 540, 640, 1.25], [0.75, 540, 640, 1.3], [1.05, 215, 640, 2.5], [2.0, 215, 640, 2.4], [2.3, 540, 640, 2.5], [3.6, 540, 640, 2.35]], in: 'P' },
  { id: 'c3', clip: 'gideas', from: 3.2, start: 17.72, dur: 2.4, fY: 1010, cam: [[0, 800, 700, 2.0], [2.4, 800, 700, 2.25]], in: 'C' },
  { id: 'c4', clip: 'ghome', from: 1.0, start: 25.45, dur: 3.5, fY: 520, cam: [[0, 540, 1050, 1.02], [3.5, 540, 1080, 1.14]], in: 'I', melt: true },
];
// Входы: Z — пролёт сквозь логотип (из крупного), P — сдвиг справа (старый уезжает влево), C — жёсткая склейка с ударом, I — раскрытие кругом.
const IN = { Z: '{ scale: 1.9, opacity: 0 }', P: '{ x: 1150, opacity: 1 }', C: '{ scale: 1.22, opacity: 1 }', I: '{ opacity: 1 }' };
let shots = '', meltShot = '';
for (const s of SHOTS) {
  const tag = `<div class="scw" style="z-index:${s.id === 'c1' ? 4 : s.id === 'c2' ? 5 : 6}"><div class="persp"${s.in === 'I' ? ' id="iris"' : ''}><div class="cam" id="${s.id}c"><div class="ent" id="${s.id}e"><video class="clip" id="${s.id}" src="assets/${s.clip}.mp4" data-start="${s.start}" data-duration="${s.dur}" data-media-start="${s.from}" data-track-index="1" muted playsinline></video></div></div></div></div>\n`;
  if (s.melt) meltShot = tag; else shots += '  ' + tag;
  const c0 = cam(...s.cam[0].slice(1), s.fY);
  js += `  tl.set("#${s.id}c", { x: ${c0.x}, y: ${c0.y}, scale: ${c0.scale} }, 0);\n`;
  js += `  tl.fromTo("#${s.id}e", ${IN[s.in]}, { x: 0, scale: 1, opacity: 1, duration: ${s.in === 'C' ? 0.22 : 0.34}, ease: "${s.in === 'C' ? 'power3.out' : 'expo.out'}" }, ${s.start});\n`;
  if (s.out) js += `  tl.to("#${s.id}e", { x: -1150, duration: 0.2, ease: "power3.in" }, ${s.out});\n`;
  for (let i = 1; i < s.cam.length; i++) {
    const [t, fx, fy, sc] = s.cam[i], prev = s.cam[i - 1][0], c = cam(fx, fy, sc, s.fY), d = t - prev;
    js += `  tl.to("#${s.id}c", { x: ${c.x}, y: ${c.y}, scale: ${c.scale}, duration: ${r2(d)}, ease: "${d <= 0.5 ? 'power4.inOut' : 'sine.inOut'}" }, ${r2(s.start + prev)});\n`;
  }
}

// ---------- Плавление: экран сам сползает вниз неровными каплями (маска по 9 колонкам), по кромке — золото ----------
const COLS = 9;
const maskCss = (off) => Array.from({ length: COLS }, (_, i) =>
  `radial-gradient(circle at 60px 60px,#000 59.5px,transparent 60px) ${i * 120}px calc(var(--m${i}) - ${off}px) / 120px 120px no-repeat, linear-gradient(#000,#000) ${i * 120}px calc(var(--m${i}) + ${60 - off}px) / 121px 4000px no-repeat`).join(', ');
const meltVars = Array.from({ length: COLS }, (_, i) => `--m${i}:-320px`).join(';');
const melt = (id, at) => {
  const order = [3, 7, 1, 5, 0, 8, 4, 2, 6], speed = [1, 0.78, 1.12, 0.86, 1.2, 0.74, 1.05, 0.92, 0.8];
  // Золотая кромка видна только пока экран плавится.
  js += `  tl.set("#${id} .rim", { opacity: 0 }, 0);\n  tl.set("#${id} .rim", { opacity: 1 }, ${r2(at - 0.02)});\n  tl.set("#${id} .rim", { opacity: 0 }, ${r2(at + 1.1)});\n`;
  order.forEach((col, n) => { js += `  tl.to("#${id}", { "--m${col}": "2100px", duration: ${r2(0.62 * speed[col])}, ease: "power2.in" }, ${r2(at + n * 0.035)});\n`; });
};

// ---------- Искры и кольца-импульсы ----------
let fxHtml = '';
const sparks = (at, x, y, n = 16) => {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (i % 3) * 0.21, d = 260 + ((i * 37) % 5) * 70, id = `sp${fxHtml.length}`;
    fxHtml += `<b class="spk" id="${id}" style="left:${x}px;top:${y}px"></b>`;
    js += `  tl.fromTo("#${id}", { x: 0, y: 0, opacity: 1, scale: 1, rotation: ${Math.round((a * 180) / Math.PI)} }, { x: ${Math.round(Math.cos(a) * d)}, y: ${Math.round(Math.sin(a) * d)}, opacity: 0, scale: 0.3, duration: ${r2(0.5 + (i % 4) * 0.08)}, ease: "power3.out", immediateRender: false }, ${at});\n`;
    js += `  tl.set("#${id}", { opacity: 0 }, 0);\n`;
  }
};
const pulse = (at, x, y) => {
  const id = `pl${fxHtml.length}`;
  fxHtml += `<b class="pls" id="${id}" style="left:${x - 120}px;top:${y - 120}px"></b>`;
  js += `  tl.set("#${id}", { opacity: 0 }, 0);\n  tl.fromTo("#${id}", { scale: 0.3, opacity: 1 }, { scale: 2.6, opacity: 0, duration: 0.5, ease: "power2.out", immediateRender: false }, ${at});\n`;
};
sparks(9.24, 540, 600); sparks(24.72, 540, 1000, 20); sparks(30.36, 540, 1195, 18);
pulse(15.5, 540, 520); pulse(16.75, 540, 520); pulse(17.95, 560, 1010);
melt('mw1', 8.86); melt('mw2', 28.3);

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
  // Пролёт сквозь логотип в интерфейс.
  tl.to("#lg", { scale: 16, opacity: 0, duration: 0.3, ease: "power3.in" }, 9.76);
  // Золотая линия сканирует список цен.
  tl.fromTo("#scan", { y: 0, opacity: 0 }, { y: 760, opacity: 1, duration: 1.1, ease: "power1.inOut" }, 12.55);
  tl.to("#scan", { opacity: 0, duration: 0.15 }, 13.6);
  // Склейка-удар на «Комиссии».
  tl.fromTo("#flash", { opacity: 0.55 }, { opacity: 0, duration: 0.2, immediateRender: false }, 17.72);
  // Сообщение о разгоне: весь экран выезжает снизу.
  tl.fromTo("#pump", { y: 1920 }, { y: 0, duration: 0.3, ease: "expo.out" }, 20.1);
  // Раскрытие кругом из «головы» в главную бота.
  tl.fromTo("#iris", { clipPath: "circle(0% at 50% 52%)" }, { clipPath: "circle(120% at 50% 52%)", duration: 0.5, ease: "power3.out" }, 25.45);
  tl.fromTo("#lgr", { scale: 0.5, opacity: 0.9 }, { scale: 3.2, opacity: 0, duration: 0.8, ease: "power2.out" }, 9.22);
  // «Вбросы видит»: сообщение бота падает сверху.
  tl.fromTo("#pm", { scale: 0.7, rotation: 5 }, { scale: 1, rotation: -2, duration: 0.45, ease: "elastic.out(1, 0.5)" }, 20.25);
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
const sfx = [['whoosh', 8.8, 0.3], ['whoosh', 9.74, 0.28], ['whoosh', 13.97, 0.28], ['whoosh', 20.06, 0.28], ['whoosh', 25.4, 0.28], ['whoosh', 28.24, 0.3], ['pop', 17.73, 0.5],
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
  .persp { position: absolute; inset: 0; overflow: hidden; }
  .scw { position: absolute; inset: 0; }
  #iris { background: #070707; }
  .mw { position: absolute; inset: 0; pointer-events: none; }
  .mk { position: absolute; inset: 0; }
  .rim { position: absolute; inset: 0; background: linear-gradient(90deg, #a8741f, #fbe7a8 20%, #e7b24c 45%, #fff3c9 60%, #b97d22 85%, #e7b24c); }
  #fxl { position: absolute; inset: 0; z-index: 24; pointer-events: none; }
  .spk { position: absolute; width: 46px; height: 10px; margin: -5px 0 0 -23px; border-radius: 6px; background: linear-gradient(90deg, #fff3c9, #e7b24c); box-shadow: 0 0 18px #ffbe3c; opacity: 0; }
  .pls { position: absolute; width: 240px; height: 240px; border-radius: 50%; border: 10px solid #ffd66b; box-shadow: 0 0 40px rgba(255,190,60,.8); opacity: 0; }
  #scan { position: absolute; left: 0; right: 0; top: 640px; height: 10px; background: #ffd66b; box-shadow: 0 0 50px 14px rgba(255,190,60,.75); opacity: 0; }
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
  .wd { position: relative; }
  .wd u { position: absolute; left: -6px; right: -6px; bottom: 2px; height: 16%; background: #ffd66b; box-shadow: 0 0 30px rgba(255,190,60,.9); transform-origin: 0 50%; z-index: -1; border-radius: 6px; }
</style>
</head>
<body>
<!-- Эдит «Это тебе не апгрейдер» (9:16). Сгенерировано video/edit/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="1080" data-height="1920">
 <div id="stage">
  <div class="clip scene gbg" id="end" data-start="28.2" data-duration="${r2(DUR - 28.2)}" data-track-index="2" style="z-index:1">
    <img id="elg" src="assets/logo.png" alt=""><div id="enm">${[...'Ценолов'].map((c) => `<i>${c}</i>`).join('')}</div>
    <div id="etg">@cenolow_bot · Telegram</div><div id="efr">БЕСПЛАТНО</div></div>
  <div class="clip scene gbg" id="logo" data-start="8.8" data-duration="1.4" data-track-index="2" style="z-index:2"><div id="lgr"></div><img id="lg" src="assets/logo.png" alt=""></div>
  <div class="mw" id="mw1" style="z-index:3;${meltVars}"><div class="rim" style="-webkit-mask:${maskCss(30)};mask:${maskCss(30)}"></div><div class="mk" style="-webkit-mask:${maskCss(0)};mask:${maskCss(0)}">
  <div class="clip scene" id="wheel" data-start="0" data-duration="9.7" data-track-index="1">
    <div id="wheelin"><div id="ring"></div><img id="skin" src="assets/ak.png" alt=""><div id="arm"></div>
      <div id="chance">ШАНС 25%</div><div id="loss"><b>−229 ₴</b></div>
      <div class="miss" id="miss1">МИМО</div><div class="miss" id="miss2">МИМО</div></div>
    <div id="x1w"><div class="xb" id="x1"></div></div><div id="x2w"><div class="xb" id="x2"></div></div>
  </div></div></div>
  <div class="clip scene gbg" id="ui" data-start="10.0" data-duration="10.4" data-track-index="3" style="z-index:3"></div>
${shots}  <div class="clip" id="scanw" data-start="12.5" data-duration="1.3" data-track-index="4" style="position:absolute;inset:0;z-index:6"><div id="scan"></div></div>
  <div class="clip scene" id="pump" data-start="20.1" data-duration="1.68" data-track-index="2" style="z-index:7">
    <div id="pm"><h3>Похоже на разгон цены</h3>Цена за сутки на 200% выше, чем за месяц.
      <div class="pm-r">• мало продаж: 6 за сутки</div><div class="pm-r">• на других площадках намного дешевле</div><div class="pm-r">• выросла в 3 раза без спроса</div></div>
  </div>
  <div class="clip scene" id="kin" data-start="21.75" data-duration="4.25" data-track-index="2" style="z-index:8"><div id="kbg"></div><div id="halo"></div>
    <div id="stw1"><div class="strike" id="st1" style="top:${st(8, 1)}px"></div></div><div id="stw2"><div class="strike" id="st2" style="top:${st(8, 3)}px"></div></div></div>
  <div class="mw" id="mw2" style="z-index:9;${meltVars}"><div class="rim" style="-webkit-mask:${maskCss(30)};mask:${maskCss(30)}"></div><div class="mk" style="-webkit-mask:${maskCss(0)};mask:${maskCss(0)}">
    ${meltShot}  </div></div>
  <div id="fxl">${fxHtml}</div>
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
