#requires -version 5
<#
  BIM Twin - auto-setup of the point-cloud cleaning Python engine.
  Installs a PRIVATE full CPython 3.12 (official installer, per-user, NO admin)
  into %LOCALAPPDATA%\BIMTwin\py312, then pip-installs numpy + open3d.
  Full CPython is used (not the embeddable build) because Open3D needs the
  complete runtime and reliably installs on a normal interpreter.
  Idempotent: re-running exits fast if Open3D already works.
  Offline: pass -Wheels <folder with *.whl> to install without internet.
  Exit codes: 0 = Open3D ready; 2 = NumPy-only mode; 1 = error.
  ASCII-only on purpose: PowerShell 5.1 reads BOM-less .ps1 as ANSI, so any
  Cyrillic here could be misparsed. Keep this file ASCII.
  ErrorActionPreference is Continue: pip/installers print to stderr, and under
  'Stop' that stderr would abort the whole script (the old bug).
#>
[CmdletBinding()]
param(
  [string]$Root   = (Join-Path $env:LOCALAPPDATA 'BIMTwin'),
  [string]$Wheels = '',
  [string]$PyVer  = '3.12.7'
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Log($m){ Write-Host "[BIMTwin] $m" }

$pyDir    = Join-Path $Root 'py312'
$pyExe    = Join-Path $pyDir 'python.exe'
$ready    = Join-Path $pyDir 'READY.txt'
$pathFile = Join-Path $Root 'python-path.txt'

function Test-Mods($exe, $mods){
  if (-not (Test-Path $exe)) { return $false }
  & $exe -c "import $mods" 2>$null
  return ($LASTEXITCODE -eq 0)
}

# 0) fast exit if open3d already works
if (Test-Mods $pyExe 'numpy, open3d') {
  Log "Already configured (Open3D): $pyExe"
  Set-Content -Path $pathFile -Value $pyExe -Encoding ASCII
  exit 0
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1) install a private full CPython 3.12 (per-user, no admin) if missing
if (-not (Test-Path $pyExe)) {
  $exe = Join-Path $env:TEMP "python-$PyVer-amd64.exe"
  $url = "https://www.python.org/ftp/python/$PyVer/python-$PyVer-amd64.exe"
  Log "Downloading Python $PyVer installer (~25 MB)..."
  try {
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
  } catch {
    Log ("Download failed: " + $_.Exception.Message)
    exit 1
  }
  Log "Installing private Python 3.12 into $pyDir (silent, no admin)..."
  $pyArgs = @(
    '/quiet',
    'InstallAllUsers=0',
    'InstallLauncherAllUsers=0',
    'PrependPath=0',
    'Include_pip=1',
    'Include_test=0',
    'Include_launcher=0',
    'Include_doc=0',
    'AssociateFiles=0',
    'Shortcuts=0',
    ("TargetDir=`"$pyDir`"")
  )
  $proc = Start-Process -FilePath $exe -ArgumentList $pyArgs -Wait -PassThru
  Remove-Item $exe -ErrorAction SilentlyContinue
  if (-not (Test-Path $pyExe)) {
    Log ("Python installer finished with code " + $proc.ExitCode + " but python.exe was not found.")
    exit 1
  }
}

# 2) ensure pip is available
& $pyExe -m ensurepip --upgrade 2>$null
& $pyExe -m pip --version 2>$null
if ($LASTEXITCODE -ne 0) {
  $gp = Join-Path $env:TEMP 'get-pip.py'
  Log "Bootstrapping pip..."
  try {
    Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $gp -UseBasicParsing
    & $pyExe $gp --no-warn-script-location
  } catch {
    Log ("pip bootstrap failed: " + $_.Exception.Message)
  }
  Remove-Item $gp -ErrorAction SilentlyContinue
}

# 3) install numpy + open3d
if ($Wheels -and (Test-Path $Wheels)) {
  Log "Offline install from $Wheels ..."
  & $pyExe -m pip install --no-index --find-links "$Wheels" numpy open3d
} else {
  Log "Installing numpy + open3d (may take a few minutes)..."
  & $pyExe -m pip install --upgrade pip --no-warn-script-location
  & $pyExe -m pip install numpy open3d --no-warn-script-location
}

Set-Content -Path $pathFile -Value $pyExe -Encoding ASCII
if (Test-Mods $pyExe 'numpy, open3d') {
  Set-Content -Path $ready -Value (Get-Date -Format o) -Encoding ASCII
  Log "Done. Python engine with Open3D is configured: $pyExe"
  exit 0
} elseif (Test-Mods $pyExe 'numpy') {
  Log "Open3D did not install, but NumPy mode is available: $pyExe"
  exit 2
} else {
  Log "Failed to configure the Python engine."
  exit 1
}
