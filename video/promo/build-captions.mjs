// Субтитры ролика: слова и их время — из распознавания голоса (npx hyperframes transcribe → assets/transcript.json),
// написание — из сценария (если число слов совпало). Нет распознавания — запасные тайминги assets/words-fallback.json.
// Пишет compositions/captions.html (группы по 3 слова, текущее слово — зелёным).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const VOICE_AT = 0.35; // где голос стоит на общей шкале (index.html, #voice data-start)
const script = JSON.parse(readFileSync('assets/words-fallback.json', 'utf8'));
let words = script, source = 'запасные тайминги';
if (existsSync('assets/transcript.json')) {
  const tr = JSON.parse(readFileSync('assets/transcript.json', 'utf8')).filter((w) => w && /[\p{L}\d]/u.test(w.text ?? ''));
  if (tr.length === script.length) { words = tr.map((w, i) => ({ text: script[i].text, start: w.start, end: w.end })); source = 'распознавание + текст сценария'; }
  else if (tr.length > 20) { words = tr.map((w) => ({ text: w.text.trim().replace(/[.,!?…:;«»"]/g, ''), start: w.start, end: w.end })); source = `распознавание (${tr.length} слов, в сценарии ${script.length})`; }
}
console.log('Субтитры:', source);

// Группы: до 3 слов, разрыв на паузе ≥ 0,15 с.
const groups = [];
for (const w of words) {
  const g = groups.at(-1);
  if (!g || g.length >= 3 || w.start - g.at(-1).end >= 0.15) groups.push([w]); else g.push(w);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const t = (x) => (x + VOICE_AT).toFixed(3);
let html = '', js = '';
groups.forEach((g, gi) => {
  html += `    <div class="cap-g" id="cap-g${gi}">${g.map((w, wi) => `<span id="cap-w${gi}-${wi}">${esc(w.text.toUpperCase())}</span>`).join(' ')}</div>\n`;
  const start = g[0].start - 0.05, end = Math.max(g.at(-1).end + 0.25, start + 0.5);
  const next = groups[gi + 1] ? groups[gi + 1][0].start - 0.06 : Infinity;
  const stop = Math.min(end, next);
  js += `    tl.set("#cap-g${gi}", { opacity: 1, visibility: "visible" }, ${t(start)});\n`;
  js += `    tl.fromTo("#cap-g${gi}", { scale: 0.92 }, { scale: 1, duration: 0.12, ease: "power2.out" }, ${t(start)});\n`;
  g.forEach((w, wi) => {
    js += `    tl.set("#cap-w${gi}-${wi}", { color: "#3ee08f" }, ${t(w.start)});\n`;
    if (wi < g.length - 1) js += `    tl.set("#cap-w${gi}-${wi}", { color: "#ffffff" }, ${t(g[wi + 1].start)});\n`;
  });
  js += `    tl.set("#cap-g${gi}", { opacity: 0, visibility: "hidden" }, ${t(stop)});\n`;
});

writeFileSync('compositions/captions.html', `<template>
  <style>
    #root { position: absolute; inset: 0; font-family: Inter, sans-serif; }
    .cap-g { position: absolute; left: 60px; right: 60px; top: 1180px; text-align: center; font-size: 64px; font-weight: 900; line-height: 1.15; color: #fff;
      opacity: 0; visibility: hidden; text-shadow: 0 6px 24px rgba(0,0,0,.9), 0 0 4px #000; overflow: visible; }
    .cap-g span { display: inline-block; margin: 0 8px; padding: 4px 10px; border-radius: 16px; background: rgba(8,10,14,.6); }
  </style>
  <div id="root" data-composition-id="caps" data-width="1080" data-height="1920">
${html}  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${js}    window.__timelines["caps"] = tl;
  </script>
</template>
`);
console.log('Групп:', groups.length, 'слов:', words.length);
