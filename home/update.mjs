// Домашний агент «Ценолова»: берёт свежую версию сборщика из GitHub и запускает его в режиме «только Steam».
// Запускается планировщиком Windows раз в 10 минут (см. install.ps1). Ничего не покупает, пароль Steam не нужен.
import { writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
const BASE = 'https://raw.githubusercontent.com/blauwi00/cs2_search/main/.github/scripts/';
for (const f of ['collect.mjs', 'inspect.mjs', 'patchnotes.mjs']) {
  try {
    const r = await fetch(BASE + f, { headers: { 'Cache-Control': 'no-cache' } });
    if (r.ok) { const t = await r.text(); if (t.length > 500) writeFileSync(f, t); }
  } catch { /* нет сети — запускаем прошлую версию */ }
}
// Лог не даём разрастись.
try { if (existsSync('log.txt') && statSync('log.txt').size > 1_000_000) writeFileSync('log.txt', readFileSync('log.txt', 'utf8').slice(-200_000)); } catch { /* не важно */ }
console.log('\n=== ' + new Date().toLocaleString() + ' ===');
if (!existsSync('collect.mjs')) { console.error('Не удалось скачать сборщик'); process.exit(1); }
await import('./collect.mjs');
