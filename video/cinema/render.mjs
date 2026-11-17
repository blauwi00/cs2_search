// Рендер ролика кадр за кадром: GSAP-шкала переключается на время кадра, Chromium делает снимок, ffmpeg собирает видео.
// node render.mjs <папка с assets/> <страница.html> <секунд> <имя>   → <имя>_silent.mp4 (звук — mix.sh)
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const DIR = resolve(process.argv[2]), PAGE = process.argv[3], DUR = +process.argv[4], NAME = process.argv[5], FPS = 30;
const frames = resolve(DIR, 'frames_' + NAME); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.goto('file://' + DIR + '/' + PAGE); await p.waitForTimeout(800);
for (let i = 0; i < FPS * DUR; i++) {
  await p.evaluate((t) => window.frameAt(t), i / FPS);
  await p.screenshot({ path: `${frames}/${String(i).padStart(4, '0')}.png` });
}
await b.close();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', `${frames}/%04d.png`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', `${DIR}/${NAME}_silent.mp4`]);
console.log('кадры собраны', NAME);
