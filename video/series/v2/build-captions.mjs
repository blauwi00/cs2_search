// Субтитры ролика: слова и их время — из распознавания голоса (npx hyperframes transcribe → assets/transcript.json),
// написание — из сценария (если число слов совпало). Нет распознавания — запасные тайминги assets/words-fallback.json.
// Пишет compositions/captions.html (группы по 3 слова, текущее слово — зелёным).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const VOICE_AT = 0.35; // где голос стоит на общей шкале (index.html, #voice data-start)
const script = JSON.parse(readFileSync('assets/words-fallback.json', 'utf8'));
let words = script, source = 'запасные тайминги';
// Выравнивание распознанных слов со сценарием (как diff): совпавшие и заменённые слова дают время словам сценария,
// лишние распознанные (повторы, «галлюцинации») пропускаются, пропущенные — получают время между соседями.
const norm = (x) => String(x).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d]/gu, '');
const NUM = { 'десять': '10', 'девять': '9', 'девяти': '9', 'девяти': '9' };
const same = (a, b) => { const x = norm(a), y = norm(b); if (!x || !y) return false; if (x === y || NUM[x] === y || NUM[y] === x) return true; const n = Math.min(x.length, y.length, 5); return n >= 3 && x.slice(0, n) === y.slice(0, n); };
if (existsSync('assets/transcript.json')) {
  const tr = JSON.parse(readFileSync('assets/transcript.json', 'utf8')).filter((w) => w && /[\p{L}\d]/u.test(w.text ?? ''));
  if (tr.length > 20) {
    const n = script.length, m = tr.length, D = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j - 1] + (same(script[i - 1].text, tr[j - 1].text) ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
    const map = new Array(n).fill(null);
    for (let i = n, j = m; i > 0 && j > 0;) {
      const sub = D[i - 1][j - 1] + (same(script[i - 1].text, tr[j - 1].text) ? 0 : 1);
      if (D[i][j] === sub) { map[i - 1] = tr[j - 1]; i--; j--; } else if (D[i][j] === D[i - 1][j] + 1) i--; else j--;
    }
    const matched = map.filter(Boolean).length;
    words = script.map((w, i) => (map[i] ? { text: w.text, start: map[i].start, end: map[i].end } : { ...w, miss: true }));
    for (let i = 0; i < words.length; i++) if (words[i].miss) {
      const p = words[i - 1], nx = words.slice(i + 1).find((x) => !x.miss);
      const st = p ? p.end : 0, en = nx ? nx.start : st + 0.4;
      words[i] = { text: words[i].text, start: st, end: Math.max(st + 0.05, Math.min(en, st + 0.45)) };
    }
    source = `распознавание, совпало ${matched} из ${n} слов сценария (распознано ${m})`;
  }
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
  // Только fromTo с явными значениями «до» и «после»: кадр не зависит от порядка перемотки.
  const on = (sel, a, b, at) => `    tl.fromTo("${sel}", ${a}, { ...${b}, duration: 0.001, immediateRender: false }, ${at});\n`;
  js += on(`#cap-g${gi}`, '{ opacity: 0, visibility: "hidden", scale: 0.92 }', '{ opacity: 1, visibility: "visible", scale: 1 }', t(start));
  g.forEach((w, wi) => {
    js += on(`#cap-w${gi}-${wi}`, '{ color: "#ffffff" }', '{ color: "#3ee08f" }', t(w.start));
    if (wi < g.length - 1) js += on(`#cap-w${gi}-${wi}`, '{ color: "#3ee08f" }', '{ color: "#ffffff" }', t(g[wi + 1].start));
  });
  js += on(`#cap-g${gi}`, '{ opacity: 1, visibility: "visible" }', '{ opacity: 0, visibility: "hidden" }', t(stop));
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
