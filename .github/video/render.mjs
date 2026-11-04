// Монтаж ролика: озвучка (timing.json + mp3/wav сегментов) → кадры из promo.html (Playwright) → mp4 (ffmpeg).
// Запуск: node render.mjs <папка с озвучкой и картинками> <out.mp4>
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [dir, out] = process.argv.slice(2);
const FPS = 30, LEAD = 0.35, GAP = 0.18, TAIL = 0.9;
const T = JSON.parse(readFileSync(join(dir, 'timing.json'), 'utf8'));
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// Таймлайн: сцена = сегмент озвучки.
let t = LEAD;
const scenes = [], words = [], audio = [];
let group = 0;
const punct = (toks, text, k) => (toks[k] && toks[k].replace(/[.,!?…:;«»"]/g, '').toLowerCase() === text.toLowerCase() ? toks[k] : text);
if (T.single) {
  // Одна дорожка на весь текст: слова делим по сегментам по количеству слов.
  const f = join(dir, T.single); const d = dur(f);
  audio.push({ f, at: LEAD });
  const W = T.words; const need = T.segments.reduce((a, x) => a + x.nwords, 0);
  let wi = 0;
  T.segments.forEach((sg, si) => {
    const n = W.length === need ? sg.nwords : Math.round((sg.nwords / need) * W.length);
    const mine = W.slice(wi, si === T.segments.length - 1 ? W.length : wi + n); wi += mine.length;
    const toks = sg.text.split(/\s+/);
    mine.forEach((w, i) => { if (i % 3 === 0) group++; words.push({ t: LEAD + w.start, end: LEAD + w.start + w.dur, text: punct(toks, w.text, i).toUpperCase(), group }); });
    group++;
    const st = si === 0 ? 0 : LEAD + mine[0].start - 0.12;
    if (scenes.length) scenes[scenes.length - 1].end = st;
    scenes.push({ id: sg.id, start: st, end: LEAD + d });
  });
  t = LEAD + d + GAP;
} else for (const s of T.segments) {
  const f = ['mp3', 'wav'].map((e) => join(dir, `${s.id}.${e}`)).find(existsSync);
  const d = dur(f);
  audio.push({ f, at: t });
  scenes.push({ id: s.id, start: t - (scenes.length ? GAP / 2 : LEAD), end: t + d + GAP / 2 });
  let ws = (s.words ?? []).filter((w) => w.type === 'WordBoundary');
  if (!ws.length) {
    const toks = s.text.split(/\s+/); const total = toks.reduce((a, x) => a + x.length + 1, 0); let acc = 0;
    ws = toks.map((x) => { const st = (acc / total) * d; acc += x.length + 1; return { text: x, start: st, dur: ((x.length + 1) / total) * d }; });
  }
  const toks = s.text.split(/\s+/);
  ws.forEach((w, i) => { if (i % 3 === 0) group++; words.push({ t: t + w.start, end: t + w.start + w.dur, text: punct(toks, w.text, i).toUpperCase(), group }); });
  group++;
  t += d + GAP;
}
const total = t - GAP + TAIL;
scenes[scenes.length - 1].end = total;
console.log('Длительность:', total.toFixed(2), 'с');

// Аудио: сегменты на свои места.
const wav = join(dir, 'voice_full.wav');
const inputs = audio.flatMap((a) => ['-i', a.f]);
const filt = audio.map((a, i) => `[${i}:a]adelay=${Math.round(a.at * 1000)}|${Math.round(a.at * 1000)},aresample=44100[a${i}]`).join(';') +
  ';' + audio.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${audio.length}:normalize=0,apad=whole_dur=${total.toFixed(2)},loudnorm=I=-14:TP=-1.5[out]`;
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filt, '-map', '[out]', '-t', total.toFixed(2), wav]);

// Кадры.
for (const f of ['promo.html']) copyFileSync(join(here, f), join(dir, f));
const req = createRequire(import.meta.url);
let pw; try { pw = req('playwright'); } catch { pw = req('playwright-core'); }
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto('file://' + join(dir, 'promo.html'));
await page.evaluate(([s, w]) => { window.SCENES = s; window.WORDS = w; }, [scenes, words]);
await page.waitForTimeout(500);
const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', wav,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.ceil(total * FPS);
for (let i = 0; i < frames; i++) {
  await page.evaluate((x) => window.render(x), i / FPS);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 150 === 0) console.log(`кадр ${i}/${frames}`);
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
writeFileSync(join(dir, 'timeline.json'), JSON.stringify({ scenes, words }, null, 1));
console.log('Готово:', out);
