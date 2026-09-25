#requires -Version 5
# BIM Twin — установка компонентов (Windows PowerShell)
# Запуск:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
#         powershell -ExecutionPolicy Bypass -File .\setup.ps1 -All
param([switch]$All)
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

function Ask($q) {
  if ($All) { return $true }
  $a = Read-Host "$q [Y/n]"
  return ($a -eq '' -or $a -match '^[YyДд]')
}

Write-Host '============================================'
Write-Host '  BIM Twin - установка компонентов (PowerShell)' -ForegroundColor Cyan
Write-Host '============================================'
Write-Host 'Совет: -All установит всё без вопросов.'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[ОШИБКА] Node.js не найден. Установите LTS с https://nodejs.org' -ForegroundColor Red
  Start-Process 'https://nodejs.org'
  exit 1
}
Write-Host ("Node.js: {0}   npm: {1}" -f (node -v), (npm -v))

Write-Host '[1/6] Базовые зависимости (npm install)...' -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { Write-Host '[ОШИБКА] npm install не удался.' -ForegroundColor Red; exit 1 }

if (Ask 'Установить локальную БД SQLite (better-sqlite3 + пересборка)?') {
  Write-Host '[2/6] better-sqlite3 + electron-rebuild...' -ForegroundColor Yellow
  Write-Host '   Нужен Visual Studio Build Tools "Desktop development with C++" и Python 3.'
  npm install better-sqlite3
  npm run rebuild
  if ($LASTEXITCODE -ne 0) { Write-Host '[ПРЕДУПР.] SQLite не собран — будет использован JSON-слой.' -ForegroundColor DarkYellow }
}

if (Ask 'Установить геометрию IFC (web-ifc + draco3d)?') {
  Write-Host '[3/6] web-ifc + draco3d...' -ForegroundColor Yellow
  npm install web-ifc draco3d
}

if (Get-Command winget -ErrorAction SilentlyContinue) {
  if (Ask 'Установить Tesseract OCR (rus+ukr+eng)?') {
    Write-Host '[4/6] Tesseract OCR...' -ForegroundColor Yellow
    winget install -e --id UB-Mannheim.TesseractOCR --accept-source-agreements --accept-package-agreements
    $tdir = Join-Path $env:ProgramFiles 'Tesseract-OCR\tessdata'
    if (-not (Test-Path $tdir)) { $tdir = Join-Path ${env:ProgramFiles(x86)} 'Tesseract-OCR\tessdata' }
    if (Test-Path $tdir) {
      foreach ($l in @('rus','ukr','eng')) {
        $dst = Join-Path $tdir "$l.traineddata"
        if (-not (Test-Path $dst)) {
          Write-Host "Загрузка $l.traineddata ..."
          try { Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/tesseract-ocr/tessdata_fast/raw/main/$l.traineddata" -OutFile $dst }
          catch { Write-Host "[ПРЕДУПР.] Не удалось скачать $l — запустите PowerShell от имени админа." -ForegroundColor DarkYellow }
        }
      }
    } else { Write-Host '[ИНФО] Папка tessdata не найдена — добавьте языки вручную.' }
  }
  if (Ask 'Установить Ollama (локальный LLM)?') {
    Write-Host '[5/6] Ollama...' -ForegroundColor Yellow
    winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
    if (Get-Command ollama -ErrorAction SilentlyContinue) { ollama pull llama3.1 }
    else { Write-Host '[ИНФО] Перезапустите терминал и выполните: ollama pull llama3.1' }
  }
} else {
  Write-Host '[ПРОПУСК] winget не найден — Tesseract и Ollama установите вручную.' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host '[6/6] Готово!' -ForegroundColor Green
Write-Host '   Запуск в dev-режиме:   npm start'
Write-Host '   Сборка установщика:    npm run dist:win'
Write-Host '   Язык OCR по умолчанию: rus+ukr+eng (Настройки → ИИ)'
