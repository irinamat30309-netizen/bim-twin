# bench-app-r145.ps1 — обёртка бенчмарка приложения BIM Twin на реальных облаках заказчика (r145).
# Запускает bench-app-r145.js (Electron + CDP) для Lixel map.las и нашего interior-ours-full-r132.las
# и печатает таблицу. Не меняет исходники приложения; HUD/скриншоты — runtime-инъекция.
#
# Запуск:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\bench-app-r145.ps1
#   powershell ... -File ... -OursOnly          # только наш файл (быстрая проверка)
#   powershell ... -File ... -OutDir D:\...     # свой каталог отчётов/скриншотов
param(
  [string]$OutDir = 'D:\BIM-TWIN-TEST\r55\bench-r145',
  [string]$Lixel = 'D:\Skan\port\map.las',
  [string]$Ours = 'D:\BIM-TWIN-TEST\xbin-verify\interior-ours-full-r132.las',
  [int]$RotateSec = 10,
  [int]$LoadTimeoutSec = 900,
  [switch]$OursOnly,
  [int]$Port = 9531
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node -ErrorAction Stop).Source
$js = Join-Path $PSScriptRoot 'bench-app-r145.js'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $OutDir ('bench-app-r145-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$args = @($js, '--out', $OutDir, '--rotate-sec', "$RotateSec", '--load-timeout-sec', "$LoadTimeoutSec", '--port', "$Port")
if (-not $OursOnly) { $args += @('--all', '--lixel', $Lixel, '--ours', $Ours) }
else { $args += @('--file', $Ours, '--label', 'Наш interior-r132') }
Write-Host ("=== bench-app-r145: node " + ($args -join ' '))
& $node @args 2>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE
$json = Join-Path $OutDir 'bench-r145.json'
if (Test-Path $json) {
  $j = Get-Content $json -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ''
  Write-Host '=== файлы отчёта:'
  Write-Host ("  JSON:    " + $json)
  Write-Host ("  скриншоты: " + (($j.rows | ForEach-Object { $_.screenshots.hud }) -join '; '))
  Write-Host ("  лог:     " + $log)
}
exit $code
