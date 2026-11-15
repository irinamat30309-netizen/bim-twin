<#
.SYNOPSIS
  Одна команда: RTK-скан (папка проекта Lixel) -> геопривязка -> IFC с реальным IfcMapConversion -> проверка.
.DESCRIPTION
  Запускает tools\scan2bim-py\georef-rtk.py по папке проекта Lixel (gnss.csv + poses.csv),
  затем json-to-ifc.js с --georef-file и валидацию. Нужны: Python DSH-рантайма, Node, файлы проекта.
.PARAMETER Project
  Папка проекта Lixel (внутри .xbin, project_data\gnss.csv, project_data\poses.csv), например D:\Skan\amosova-rtk
.PARAMETER Model
  JSON-модель для IFC (по умолчанию D:\BIM-TWIN-TEST\interior\py2-final-v5.json)
.PARAMETER OutDir
  Куда складывать результаты (по умолчанию D:\BIM-TWIN-TEST\georef-rtk)
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\scan2bim-py\apply-rtk-georef.ps1 -Project "D:\Skan\amosova-rtk"
#>
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [string]$Model = "D:\BIM-TWIN-TEST\interior\py2-final-v5.json",
  [string]$OutDir = "D:\BIM-TWIN-TEST\georef-rtk",
  [string]$Python = "C:\Users\bob\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe",
  [switch]$LocalPlanXz,
  [string]$LasOrigin = "",
  [switch]$Strict
)
$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"; $env:PYTHONUTF8 = "1"
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$georef = Join-Path $OutDir "georef.json"
$ifcOut = Join-Path $OutDir "model-georef.ifc"
$validOut = Join-Path $OutDir "validate-georef.json"

$argsGeoref = @("tools\scan2bim-py\georef-rtk.py", "--project", $Project, "--out", $georef)
if ($LocalPlanXz) { $argsGeoref += "--local-plan"; $argsGeoref += "xz" }
if ($LasOrigin) { $argsGeoref += "--from-las-origin"; $argsGeoref += $LasOrigin }
if ($Strict) { $argsGeoref += "--strict" }

Write-Host "=== 1/3 Геопривязка по RTK ===" -ForegroundColor Cyan
& $Python @argsGeoref
if ($LASTEXITCODE -ne 0) { Write-Host "ПРИВЯЗКА НЕ ВЫПОЛНЕНА (код $LASTEXITCODE) — см. сообщение выше. IFC не собирался." -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "=== 2/3 IFC с IfcMapConversion ===" -ForegroundColor Cyan
& node (Join-Path $repo "tools\scan2bim-py\json-to-ifc.js") $Model $ifcOut --georef-file $georef
if ($LASTEXITCODE -ne 0) { Write-Host "Ошибка генерации IFC" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "=== 3/3 Валидация IFC ===" -ForegroundColor Cyan
& $Python (Join-Path $repo "tools\scan2bim-py\validate-ifc.py") $ifcOut --json $validOut
$code = $LASTEXITCODE

Write-Host ""
Write-Host "Готово: $georef | $ifcOut | $validOut"
if (Test-Path $georef) {
  $g = Get-Content $georef -Raw | ConvertFrom-Json
  Write-Host ("EPSG: {0}; поворот {1}°; сдвиг E0={2} N0={3} H0={4}; невязка rms={5} max={6} м; точек {7}" -f `
    $g.epsg, $g.rotation_deg, $g.translation.E0, $g.translation.N0, $g.translation.H0, $g.residuals.rms, $g.residuals.max, $g.points)
}
exit $code
