// Проверка «текст влезает в плашку»: на кадрах каждые 0,2 с ищет видимые плашки, у которых содержимое шире/выше самой плашки.
// node fitcheck.cjs <страница.html> <секунд>
const { chromium } = require('playwright'); const path = require('path');
const [,, page, dur] = process.argv;
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(page)); await p.waitForTimeout(600);
  const bad = new Map();
  for (let t = 0; t <= +dur; t += 0.2) {
    const r = await p.evaluate(async (t) => { await window.frameAt(t);
      const vis = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < .2) return false; } return true; };
      // Сравниваем прямоугольники самого текста (без блика .sh) с плашкой; учитываем скругления — запас 6 px.
      const out = [];
      [...document.querySelectorAll('.gl3,.pop,.mb,.hook,.tc,.card,#plate')].filter(vis).forEach((e) => {
        const pr = e.getBoundingClientRect(); const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n);
          for (const q of rg.getClientRects()) if (q.width && (q.left < pr.left + 4 || q.right > pr.right - 4 || q.top < pr.top + 2 || q.bottom > pr.bottom - 2)) {
            out.push((e.id || e.className) + ' «' + n.textContent.trim().slice(0, 40) + '»'); break; } }
      });
      return out;
}, +t.toFixed(2));
    r.forEach((x) => bad.set(x.replace(/ \d+\/\d+ × \d+\/\d+$/, ''), (bad.get(x) || x) ));
  }
  console.log(bad.size ? [...bad.values()].join('\n') : 'всё влезает'); await b.close(); })();
