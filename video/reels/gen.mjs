// Ролики для TikTok (9:16, 1080×1920) на HyperFrames — живой интерфейс приложения вместо статичных картинок.
// Клипы — запись экрана настоящего приложения (локальная копия бота, реальные цены Steam), палец показывает касания.
// Камера наезжает на то, о чём говорится (×1,4–2), субтитры — крупно, по словам, в безопасной зоне TikTok (168–1330 px).
// Запуск: node gen.mjs <папка-сборки> [voice]   → <папка>/<ролик>/index.html; клипы и звуки — в <папка>/<ролик>/assets/.
// voice: вариант под озвучку — фразы и тайминги берутся из <ролик>.timing.json (после распознавания голоса), иначе — из сценария.
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(HERE, 'build');
const CLIPS = process.env.CLIPS || join(OUT, '..', 'clips');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- Камера: фокус (fx, fy в пикселях записи 1080×2338) → в точку (540, FOCUS_Y) кадра, масштаб s ----------
const FOCUS_Y = 690;
const cam = (fx, fy, s) => ({ x: Math.round(540 - fx * s), y: Math.round(FOCUS_Y - fy * s), scale: s });

// ---------- Сообщения бота (тексты — как их формирует код бота: tradelock.ts, pumpalert.ts) ----------
const MSG = {
  unlock: {
    lines: [
      '<b>🔓 Можно продавать</b>', '',
      '<b>Gallery Case</b> ×9',
      'Прошло 7 дней защиты обмена Steam — предмет снова можно продать.',
      'Куплено за 29,00 ₴ за 1 шт.', '',
      '<span class="hl">🎮 Steam: 36,00 ₴ → на баланс Steam ≈ <b>31,31 ₴</b> (+2,31 ₴ к покупке)</span>',
      '<span class="hl">💵 Площадки: ≈ 28,13 ₴ → после 2% CSFloat ≈ <b>27,57 ₴</b> живыми деньгами (−0,43 ₴ к покупке)</span>', '',
      '<i>Цены меняются — сверь перед продажей. Решение за тобой: бот ничего не продаёт сам.</i>',
    ],
    buttons: [['💰 Открыть в Steam'], ['🎒 Цены на площадках'], ['💸 Продал']],
  },
  pump: {
    lines: [
      '<b>⚠️ Похоже на разгон цены</b>', '',
      '<b>Наклейка из капсулы (пример)</b> — есть у тебя',
      'Средняя цена продаж в Steam за сутки ≈ 412,00 ₴ — на 200% выше, чем за месяц (≈ 137,00 ₴).', '',
      'Почему похоже на разгон:',
      '<span class="hl r1">• мало продаж: 6 за сутки в Steam — цену легко сдвинуть</span>',
      '<span class="hl r2">• на других площадках предмет намного дешевле — там рост не подтвердился</span>',
      '<span class="hl r3">• цена выросла в 3 раза за месяц без большого спроса</span>', '',
      '<span class="hl r4">Разгоны обычно сдуваются: цену поднимают, чтобы продать на пике. Если думал продавать — сейчас может быть хороший момент.</span>',
    ],
    buttons: [['💰 Открыть в Steam']],
  },
};

// ---------- Сценарии. Субтитр: «текст с *акцентом*», [начало, конец] в секундах ролика ----------
// Клип: src, from (секунда записи), start/dur (секунды ролика), cam — ключевые кадры камеры [t от начала клипа, fx, fy, s].
const FILMS = {
  reklama: {
    title: 'Реклама бота',
    dur: 17.25,
    shots: [
      { clip: 'prices', from: 9.6, start: 0, dur: 2.5, cam: [[0, 540, 1170, 1.16], [2.5, 540, 1170, 1.08]] },
      { clip: 'prices', from: 2.6, start: 2.5, dur: 3.0, cam: [[0, 540, 560, 1.22], [3.0, 540, 600, 1.15]] },
      { clip: 'ideas', from: 0.9, start: 5.5, dur: 3.6, cam: [[0, 540, 900, 1.0], [0.9, 540, 900, 1.0], [1.5, 872, 654, 1.95], [3.6, 872, 654, 1.85]] },
      { clip: 'ideas', from: 4.4, start: 9.1, dur: 2.4, cam: [[0, 300, 800, 2.1], [2.4, 300, 800, 1.95]] },
      { clip: 'inv', from: 0.2, start: 11.5, dur: 2.05, cam: [[0, 540, 760, 1.0], [0.7, 540, 656, 1.12], [2.05, 540, 656, 1.08]] },
      { end: true, start: 13.55, dur: 3.7 },
    ],
    caps: [
      ['Один скин — *6 разных* цен', 0.15, 2.45],
      ['Бот сравнивает *все площадки* сразу', 2.6, 5.4],
      ['и находит, где *купить дешевле*', 5.6, 7.3],
      ['а *продать дороже*', 7.3, 9.0],
      ['Комиссии *уже посчитаны*', 9.2, 11.4],
      ['Сколько стоит *твой инвентарь*', 11.6, 13.5],
    ],
    voice: 'Один скин — шесть разных цен. Бот сравнивает все площадки сразу и находит, где купить дешевле, а продать дороже. Комиссии уже посчитаны. И покажет, сколько стоит твой инвентарь. Ищи в Телеграм: Ценолов, бесплатно.',
  },
  tradeban: {
    title: 'Трейд-бан: когда можно продавать',
    dur: 15.0,
    shots: [
      { clip: 'buys', from: 2.55, start: 0, dur: 2.7, cam: [[0, 560, 1060, 1.28], [2.7, 560, 1060, 1.2]] },
      { clip: 'locked', from: 1.5, start: 2.7, dur: 3.6, cam: [[0, 540, 1000, 1.0], [1.7, 540, 1000, 1.0], [2.3, 560, 1890, 1.22], [3.6, 560, 1890, 1.18]] },
      { msg: 'unlock', start: 6.3, dur: 5.2, hl: [[1.4, 6], [2.6, 7]], cz: [[0, 540, 690, 1], [1.2, 540, 690, 1], [1.7, 520, 860, 1.14], [5.2, 520, 880, 1.1]] },
      { end: true, start: 11.5, dur: 3.5 },
    ],
    caps: [
      ['Купил скин — а продать *нельзя 7 дней*', 0.15, 2.65],
      ['Бот помнит каждую покупку', 2.8, 4.5],
      ['и считает, *когда можно продавать*', 4.5, 6.25],
      ['Через 7 дней — *сообщение*', 6.4, 8.3],
      ['и где продать *выгоднее*', 8.3, 11.4],
    ],
    voice: 'Купил скин, а продать нельзя семь дней? Бот помнит каждую покупку и считает, когда можно продавать. Через семь дней пришлёт сообщение — и подскажет, где продать выгоднее. Ценолов в Телеграм.',
  },
  vbros: {
    title: 'Вбросы и разгоны',
    dur: 18.4,
    shots: [
      { msg: 'pump', start: 0, dur: 10.4, hl: [[3.0, 6], [3.0, 7], [3.0, 8], [8.5, 10]], cz: [[0, 540, 690, 1], [2.9, 540, 690, 1], [3.4, 520, 800, 1.15], [8.0, 520, 810, 1.13], [8.5, 520, 960, 1.15], [10.4, 520, 970, 1.12]] },
      { clip: 'ideas', from: 0.9, start: 10.4, dur: 4.4, cam: [[0, 540, 760, 1.32], [4.4, 540, 760, 1.22]] },
      { end: true, start: 14.8, dur: 3.6 },
    ],
    caps: [
      ['Скин вырос *в 3 раза*? 🚩', 0.15, 2.9],
      ['Часто это *вброс*: цену разгоняют', 3.0, 4.9],
      ['чтобы продать тебе *на пике*', 4.9, 6.7],
      ['Бот видит признаки разгона', 6.8, 8.5],
      ['и подскажет *продать, пока дорого*', 8.5, 10.35],
      ['А в идеи такие скины *не попадают*', 10.5, 14.7],
    ],
    voice: 'Скин вырос в три раза? Часто это вброс: цену разгоняют, чтобы продать тебе на пике. Бот видит признаки разгона и подскажет продать, пока дорого. А в идеи такие скины не попадают. Ценолов в Телеграм.',
  },
};

// ---------- Сборка одного ролика ----------
function build(key, f, variant) {
  const dir = join(OUT, `${key}${variant === 'voice' ? '-voice' : ''}`);
  mkdirSync(join(dir, 'assets', 'sfx'), { recursive: true });
  for (const fn of ['gsap.min.js']) copyFileSync(join(HERE, '..', 'features', 'assets', fn), join(dir, 'assets', fn));
  for (const fn of ['whoosh.wav', 'pop.wav']) copyFileSync(join(HERE, '..', 'promo', 'assets', 'sfx', fn), join(dir, 'assets', 'sfx', fn));
  copyFileSync(join(CLIPS, 'logo.png'), join(dir, 'assets', 'logo.png'));
  let caps = f.caps;
  const tfile = join(HERE, `${key}.timing.json`);
  if (variant === 'voice' && existsSync(tfile)) caps = JSON.parse(readFileSync(tfile, 'utf8')).caps;

  const parts = [], css = [], js = [], audio = [];
  let n = 0;
  // Кадры записи.
  for (const s of f.shots) {
    const id = `s${n++}`;
    if (s.clip) {
      copyFileSync(join(CLIPS, `${s.clip}.mp4`), join(dir, 'assets', `${s.clip}.mp4`));
      const c0 = cam(...s.cam[0].slice(1));
      parts.push(`  <div class="cam" id="${id}c" style="z-index:2"><div class="ent" id="${id}e"><video class="clip" id="${id}" src="assets/${s.clip}.mp4" data-start="${s.start}" data-duration="${s.dur}" data-media-start="${s.from}" data-track-index="1" muted playsinline></video></div></div>`);
      js.push(`  tl.set("#${id}c", { x: ${c0.x}, y: ${c0.y}, scale: ${c0.scale} }, 0);`);
      // Вход: «рывок» снизу с размытием движения, 0,32 с.
      js.push(`  tl.fromTo("#${id}e", { y: 160 }, { y: 0, duration: 0.32, ease: "expo.out" }, ${s.start});`);
      for (let i = 1; i < s.cam.length; i++) {
        const [t, fx, fy, sc] = s.cam[i], prev = s.cam[i - 1][0];
        const c = cam(fx, fy, sc), d = t - prev;
        const fast = d <= 0.8;
        js.push(`  tl.to("#${id}c", { x: ${c.x}, y: ${c.y}, scale: ${c.scale}, duration: ${r2(d)}, ease: "${fast ? 'power3.inOut' : 'sine.inOut'}" }, ${r2(s.start + prev)});`);
      }
      if (n > 1) audio.push(sfx('whoosh', s.start - 0.06, 0.22));
    } else if (s.msg) {
      const m = MSG[s.msg];
      parts.push(`  <div class="clip chat" id="${id}" data-start="${s.start}" data-duration="${s.dur}" data-track-index="1" style="z-index:2"><div class="cz" id="${id}z">
    <div class="chead"><img src="assets/logo.png" alt=""><div><b>Ценолов</b><span>бот</span></div></div>
    <div class="msg" id="${id}m"><div class="bub">${m.lines.map((l, i) => l ? `<div class="ln" id="${id}l${i}">${l}</div>` : `<div class="gap"></div>`).join('')}<div class="tm">10:00</div></div>
</div>
  </div></div>`);
      if (s.cz) {
        const z0 = cam(...s.cz[0].slice(1));
        js.push(`  tl.set("#${id}z", { x: ${z0.x}, y: ${z0.y}, scale: ${z0.scale} }, 0);`);
        for (let i = 1; i < s.cz.length; i++) {
          const [t, fx, fy, sc] = s.cz[i], prev = s.cz[i - 1][0], c = cam(fx, fy, sc), d = t - prev;
          js.push(`  tl.to("#${id}z", { x: ${c.x}, y: ${c.y}, scale: ${c.scale}, duration: ${r2(d)}, ease: "${d <= 0.8 ? 'power3.inOut' : 'sine.inOut'}" }, ${r2(s.start + prev)});`);
        }
      }
      js.push(`  tl.fromTo("#${id}m", { y: 220, scale: 0.92, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.5, ease: "expo.out" }, ${r2(s.start + 0.25)});`);
      audio.push(sfx('pop', s.start + 0.27, 0.5));
      for (const [t, li] of s.hl || []) js.push(`  tl.to("#${id}l${li} .hl", { backgroundColor: "rgba(196,155,255,.30)", boxShadow: "0 0 0 6px rgba(196,155,255,.30)", duration: 0.25, ease: "power2.out" }, ${r2(s.start + t)});`);
    } else if (s.end) {
      parts.push(`  <div class="clip endc" id="${id}" data-start="${s.start}" data-duration="${s.dur}" data-track-index="1" style="z-index:5">
    <div class="glow"></div>
    <img class="lg" id="${id}lg" src="assets/logo.png" alt="">
    <div class="nm" id="${id}nm">Ценолов</div>
    <div class="sub" id="${id}sb">карманный трейдер для скинов CS2</div>
    <div class="pill" id="${id}pl">@cenolow_bot</div>
    <div class="free" id="${id}fr">бесплатно · без пароля Steam</div>
  </div>`);
      const t = s.start;
      js.push(`  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0.18 }, ${t});`);
      js.push(`  tl.fromTo("#${id}lg", { scale: 0.4, rotation: -14, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.6, ease: "back.out(1.6)" }, ${r2(t + 0.1)});`);
      js.push(`  tl.fromTo("#${id}nm", { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.2 }, ${r2(t + 0.45)});`);
      js.push(`  tl.fromTo("#${id}sb", { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.2 }, ${r2(t + 0.6)});`);
      js.push(`  tl.fromTo("#${id}pl", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(2)" }, ${r2(t + 0.85)});`);
      js.push(`  tl.fromTo("#${id}fr", { opacity: 0 }, { opacity: 1, duration: 0.25 }, ${r2(t + 1.15)});`);
      audio.push(sfx('whoosh', t - 0.05, 0.25), sfx('pop', t + 0.9, 0.45));
    }
  }
  // Субтитры: по словам (размытие → резкость, 0,07 с между словами), группа держится до своего конца.
  const capHtml = caps.map(([text, a, b], i) => {
    const words = text.split(' ').map((w, k) => {
      const acc = /^\*.*\*[.,!?]?$/.test(w) || /^\*/.test(w) || /\*[.,!?]?$/.test(w);
      return `<span class="w${acc ? ' a' : ''}" id="c${i}w${k}">${esc(w.replace(/\*/g, ''))}</span>`;
    });
    // Акцент на фразе из нескольких слов: *купить дешевле* — красим все слова между звёздочками.
    let on = false; const ws = text.split(' ');
    const html = ws.map((w, k) => { const st = w.startsWith('*'); if (st) on = true; const cls = on ? ' a' : ''; const end = /\*[.,!?:]?$/.test(w); const out = `<span class="w${cls}" id="c${i}w${k}">${esc(w.replace(/\*/g, ''))}</span>`; if (end) on = false; return out; }).join(' ');
    void words;
    js.push(`  tl.set("#c${i}", { opacity: 1 }, ${a});`);
    ws.forEach((_, k) => js.push(`  tl.fromTo("#c${i}w${k}", { opacity: 0, filter: "blur(6px)", y: 10 }, { opacity: 1, filter: "blur(0px)", y: 0, duration: 0.14, ease: "power2.out" }, ${r2(a + k * 0.07)});`));
    js.push(`  tl.to("#c${i}", { opacity: 0, duration: 0.12, ease: "power2.in" }, ${r2(b - 0.12)});`);
    js.push(`  tl.set("#c${i}", { opacity: 0, visibility: "hidden" }, ${b});`);
    return `    <div class="cap" id="c${i}">${html}</div>`;
  }).join('\n');

  if (variant === 'voice') audio.push(`  <audio id="voice" class="clip" src="assets/voice.mp3" data-start="0" data-track-index="3" data-volume="1"></audio>`);

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<script src="assets/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #08061a; }
  #main { font-family: Inter, sans-serif; color: #fff; overflow: hidden; }
  #bg { position: absolute; inset: 0; z-index: 0; background: radial-gradient(900px 800px at 80% 10%, rgba(176,123,255,.30), transparent 65%), radial-gradient(800px 700px at 10% 95%, rgba(255,92,180,.18), transparent 65%), #08061a; }
  .cam { position: absolute; left: 0; top: 0; width: 1080px; height: 2338px; transform-origin: 0 0; }
  .ent { position: absolute; left: 0; top: 0; width: 1080px; height: 2338px; }
  .cam video { position: absolute; left: 0; top: 0; width: 1080px; height: 2338px; }
  #shade { position: absolute; left: 0; right: 0; top: 1020px; height: 900px; z-index: 4; background: linear-gradient(180deg, rgba(8,6,26,0) 0%, rgba(8,6,26,.82) 28%, rgba(8,6,26,.96) 55%); }
  #caps { position: absolute; left: 0; right: 0; top: 1150px; height: 200px; z-index: 6; }
  .cap { position: absolute; left: 70px; right: 70px; top: 0; text-align: center; font-size: 74px; line-height: 1.08; font-weight: 900; letter-spacing: -1.5px; opacity: 0; text-shadow: 0 4px 24px rgba(0,0,0,.6); }
  .cap .w { display: inline-block; }
  .cap .a { color: #c49bff; }
  .chat { position: absolute; inset: 0; background: #0e1621; overflow: hidden; }
  .cz { position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; transform-origin: 0 0; }
  .chead { position: absolute; left: 0; right: 0; top: 0; height: 250px; background: #17212b; display: flex; align-items: flex-end; gap: 26px; padding: 0 50px 34px; box-sizing: border-box; }
  .chead img { width: 104px; height: 104px; border-radius: 50%; }
  .chead b { display: block; font-size: 46px; } .chead span { font-size: 34px; color: #7d8b99; }
  .msg { position: absolute; left: 36px; right: 100px; top: 285px; transform-origin: 0 100%; }
  .bub { background: #182533; border-radius: 34px 34px 34px 10px; padding: 30px 36px 50px; font-size: 34px; line-height: 1.28; position: relative; }
  .bub .gap { height: 16px; } .bub i { color: #a9b6c3; font-size: 33px; }
  .bub .hl { border-radius: 10px; }
  .bub .tm { position: absolute; right: 26px; bottom: 12px; font-size: 30px; color: #6d7f8f; }
  .kb { margin-top: 10px; } .kr { display: flex; gap: 10px; margin-top: 10px; }
  .kbtn { flex: 1; text-align: center; background: rgba(36,51,68,.92); border-radius: 18px; padding: 22px 10px; font-size: 34px; font-weight: 700; }
  .endc { position: absolute; inset: 0; background: #08061a; }
  .endc .glow { position: absolute; left: 190px; top: 260px; width: 700px; height: 700px; border-radius: 50%; background: radial-gradient(circle, rgba(196,155,255,.55), transparent 65%); }
  .endc .lg { position: absolute; left: 340px; top: 360px; width: 400px; height: 400px; border-radius: 26%; clip-path: inset(6px round 24%); }
  .endc .nm { position: absolute; left: 0; right: 0; top: 820px; text-align: center; font-size: 130px; font-weight: 900; letter-spacing: -4px; }
  .endc .sub { position: absolute; left: 60px; right: 60px; top: 980px; text-align: center; font-size: 48px; font-weight: 700; color: #b9b0d9; }
  .endc .pill { position: absolute; left: 190px; right: 190px; top: 1090px; text-align: center; font-size: 66px; font-weight: 900; padding: 22px 0; border-radius: 999px; background: linear-gradient(135deg, #ff5ca8, #8b5cff); box-shadow: 0 18px 50px rgba(139,92,255,.45); }
  .endc .free { position: absolute; left: 0; right: 0; top: 1250px; text-align: center; font-size: 42px; font-weight: 700; color: #d6cff0; }
</style>
</head>
<body>
<!-- ${esc(f.title)} (9:16, ${f.dur} с). Сгенерировано video/reels/gen.mjs — правьте генератор, а не этот файл. -->
<div id="main" data-composition-id="main" data-start="0" data-duration="${f.dur}" data-width="1080" data-height="1920" data-motion-blur="on">
  <div id="bg"></div>
${parts.join('\n')}
  <div id="shade"></div>
  <div id="caps">
${capHtml}
  </div>
${audio.join('\n')}
</div>
<script>
  window.__timelines = window.__timelines || {};
  var tl = gsap.timeline({ paused: true });
${js.join('\n')}
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  writeFileSync(join(dir, 'index.html'), html);
  return dir;
}
let sfxN = 0;
const SFX_LEN = { whoosh: 0.45, pop: 0.12 };
function sfx(name, at, vol) { return `  <audio id="fx${sfxN++}" class="clip" src="assets/sfx/${name}.wav" data-start="${r2(Math.max(0, at))}" data-duration="${SFX_LEN[name]}" data-track-index="4" data-volume="${vol}"></audio>`; }

const variant = process.argv[3] === 'voice' ? 'voice' : 'silent';
for (const [k, f] of Object.entries(FILMS)) console.log(build(k, f, variant));
if (process.argv[4] === 'scripts') for (const [k, f] of Object.entries(FILMS)) console.log(`\n${k}: ${f.voice}`);
export { FILMS };
