# Установка домашнего агента «Ценолова» (Windows): цены Steam с твоего компьютера, раз в 10 минут, в фоне.
# Запуск: PowerShell → irm https://raw.githubusercontent.com/blauwi00/cs2_search/main/home/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Cenolov'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "`n== Ценолов: домашний агент ==" -ForegroundColor Green

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js не найден — ставлю через winget (LTS)...' -ForegroundColor Yellow
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Write-Host 'Не получилось. Поставь Node.js LTS с https://nodejs.org и запусти установку ещё раз.' -ForegroundColor Red; return }
}
Write-Host ('Node.js: ' + (& node -v))

# 2. Ключ сборщика (INGEST_SECRET) — хранится только у тебя на компьютере.
$secretFile = Join-Path $dir 'secret.txt'
$secret = Read-Host 'Вставь ключ сборщика INGEST_SECRET (или просто Enter — создам новый)'
if ([string]::IsNullOrWhiteSpace($secret)) {
  $bytes = New-Object byte[] 24; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Write-Host "`nНОВЫЙ КЛЮЧ: $secret" -ForegroundColor Cyan
  Write-Host 'Его нужно вставить в ДВА места (иначе бот перестанет принимать цены):' -ForegroundColor Yellow
  Write-Host '  1) Cloudflare → Workers & Pages → cs2-search → Settings → Variables and Secrets → INGEST_SECRET → Edit'
  Write-Host '  2) GitHub → blauwi00/cs2_search → Settings → Secrets and variables → Actions → INGEST_SECRET → Update'
}
Set-Content -Path $secretFile -Value $secret.Trim() -NoNewline -Encoding ascii

# 3. Файлы агента
Invoke-WebRequest 'https://raw.githubusercontent.com/blauwi00/cs2_search/main/home/update.mjs' -OutFile (Join-Path $dir 'update.mjs') -UseBasicParsing
@"
@echo off
cd /d "$dir"
set WORKER_URL=https://cs2-search.blauwi925.workers.dev
set STEAM_ONLY=1
set /p INGEST_SECRET=<secret.txt
node update.mjs >> log.txt 2>&1
"@ | Set-Content -Path (Join-Path $dir 'run.cmd') -Encoding ascii
# Запуск без мигающего окна
"CreateObject(""Wscript.Shell"").Run ""cmd /c """"$dir\run.cmd"""""", 0, False" | Set-Content -Path (Join-Path $dir 'run.vbs') -Encoding ascii

# 4. Планировщик: каждые 10 минут, пока ты в системе
schtasks /Create /F /SC MINUTE /MO 10 /TN 'Cenolov Steam' /TR "wscript.exe `"$dir\run.vbs`"" | Out-Null
Write-Host "`nПроверочный запуск (до 1–2 минут)..." -ForegroundColor Green
& cmd /c "`"$dir\run.cmd`""
Get-Content (Join-Path $dir 'log.txt') -Tail 15
Write-Host "`nГотово. Агент работает каждые 10 минут. Лог: $dir\log.txt" -ForegroundColor Green
Write-Host "Выключить: schtasks /Delete /TN `"Cenolov Steam`" /F"
