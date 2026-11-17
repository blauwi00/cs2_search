// Рендер ролика кадр за кадром: GSAP-шкала переключается на время кадра, Chromium делает снимок, ffmpeg собирает видео со звуками.
// node render.mjs <папка проекта с assets/> <выход.mp4>
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const DIR = resolve(process.argv[2]), OUT = resolve(process.argv[3]), FPS = 30, DUR = 22;
const frames = resolve(DIR, 'frames'); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.goto('file://' + DIR + '/index.html'); await p.waitForTimeout(800);
for (let i = 0; i < FPS * DUR; i++) {
  await p.evaluate((t) => window.frameAt(t), i / FPS);
  await p.screenshot({ path: `${frames}/${String(i).padStart(4, '0')}.png` });
}
await b.close();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}/%04d.png`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', `${DIR}/silent.mp4`]);
console.log('кадры собраны');
