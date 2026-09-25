#requires -version 5
<#
  BIM Twin - auto-setup of the Scan2BIM AI server (CPU engine).
  Creates the server-side .venv and installs the CRITICAL web stack
  (fastapi + uvicorn + python-multipart + numpy) that the server needs to BOOT,
  then best-effort quality packages (scipy/scikit-image/shapely) and optional
  heavy ones (open3d/ifcopenshell/pyransac3d). A failing optional wheel can
  NEVER block the server from starting - only the critical four must import.

  scan2bim-server.js auto-start looks for <serverDir>\.venv first, so we build
  the venv exactly there. Base interpreter: the private CPython created by
  setup-python.ps1 (%LOCALAPPDATA%\BIMTwin\py312), else system Python 3.10-3.12.
  Idempotent + tolerant: a partial failure never blocks install; the app then
  falls back to the built-in offline engine.
  ASCII-only on purpose (PowerShell 5.1 reads BOM-less .ps1 as ANSI).
  Exit codes: 0 = server venv ready; 2 = base Python missing; 1 = other error.
#>
[CmdletBinding()]
param(
  [string]$Root      = (Join-Path $env:LOCALAPPDATA 'BIMTwin'),
  [string]$ServerDir = ''
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Log($m){ Write-Host "[BIMTwin-AI] $m" }

# --- Locate the server folder ------------------------------------------------
# Ships inside the app under resources\app.asar.unpacked\scan2bim-ai-server.
if (-not $ServerDir -or -not (Test-Path $ServerDir)) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $cands = @(
    (Join-Path $here 'app.asar.unpacked\scan2bim-ai-server'),
    (Join-Path $here 'resources\app.asar.unpacked\scan2bim-ai-server'),
    (Join-Path $here 'scan2bim-ai-server'),
    (Join-Path (Split-Path -Parent $here) 'scan2bim-ai-server'),
    (Join-Path $here '..\app.asar.unpacked\scan2bim-ai-server')
  )
  foreach ($c in $cands) { if (Test-Path (Join-Path $c 'server.py')) { $ServerDir = (Resolve-Path $c).Path; break } }
}
if (-not $ServerDir -or -not (Test-Path (Join-Path $ServerDir 'server.py'))) {
  Log 'Server folder not found; skipping AI-server setup.'
  exit 1
}
Log "Server folder: $ServerDir"

# --- Pick a base interpreter (3.10-3.12) -------------------------------------
function Test-PyVer($cmd, $pre){
  try { & $cmd @pre -c "import sys;sys.exit(0 if (3,10)<=sys.version_info[:2]<=(3,12) else 1)" 2>$null } catch { return $false }
  return ($LASTEXITCODE -eq 0)
}
$baseCmd = ''; $basePre = @()
$pathFile = Join-Path $Root 'python-path.txt'
if (Test-Path $pathFile) {
  $p = (Get-Content $pathFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($p -and (Test-Path $p) -and (Test-PyVer $p @())) { $baseCmd = $p; $basePre = @() }
}
if (-not $baseCmd) {
  foreach ($pair in @(@('py',@('-3.12')),@('py',@('-3.11')),@('py',@('-3.10')),@('python',@()),@('python3',@()))) {
    if (Test-PyVer $pair[0] $pair[1]) { $baseCmd = $pair[0]; $basePre = $pair[1]; break }
  }
}
if (-not $baseCmd) {
  Log 'No compatible Python 3.10-3.12 found. setup-python.ps1 should provide one; skipping AI-server venv.'
  exit 2
}
Log "Base Python: $baseCmd $($basePre -join ' ')"

# --- Create / reuse the server .venv -----------------------------------------
$venv = Join-Path $ServerDir '.venv'
$vpy  = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $vpy)) {
  Log 'Creating server .venv ...'
  & $baseCmd @basePre -m venv $venv 2>$null
}
if (-not (Test-Path $vpy)) { Log 'venv creation failed; skipping.'; exit 1 }

# Fast exit only if the CRITICAL server stack already imports.
& $vpy -c "import numpy, fastapi, uvicorn, multipart" 2>$null
if ($LASTEXITCODE -eq 0) { Log 'AI-server web stack already installed.'; exit 0 }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
& $vpy -m pip install --upgrade pip 2>$null

# 1) CRITICAL: the server cannot boot without these four. Install them first and
#    on their own so a heavy optional wheel can never take them down.
Log 'Installing CRITICAL AI-server web stack (fastapi, uvicorn, python-multipart, numpy)...'
& $vpy -m pip install fastapi "uvicorn[standard]" python-multipart numpy

# 2) QUALITY (best-effort): scipy / scikit-image / shapely improve walls,
#    openings and pipes but the engine degrades gracefully without them.
$req = Join-Path $ServerDir 'requirements-cpu.txt'
Log 'Installing quality packages (scipy, scikit-image, shapely) - best effort...'
if (Test-Path $req) { & $vpy -m pip install -r $req }
else { & $vpy -m pip install scipy scikit-image shapely }

# 3) OPTIONAL heavy (best-effort): not imported by the server; used only by
#    richer exporters/segmenters when present. Never block on these.
Log 'Installing optional packages (ifcopenshell, pyransac3d, open3d) - best effort...'
& $vpy -m pip install ifcopenshell pyransac3d open3d 2>$null

# Verify ONLY the critical four - that is enough for the server to run.
& $vpy -c "import numpy, fastapi, uvicorn, multipart" 2>$null
if ($LASTEXITCODE -eq 0) { Log 'AI-server ready (CPU geometric engine).'; exit 0 }
Log 'AI-server web stack did not install; the app will use the built-in offline engine.'
exit 1
