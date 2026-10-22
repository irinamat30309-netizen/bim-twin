#requires -version 5
<#
  BIM Twin - in-app "Install Open3D" button (Windows).
  Installs a PRIVATE full CPython 3.12 (official installer, per-user, NO admin)
  into %LOCALAPPDATA%\BIMTwin\py312, then pip-installs numpy + scipy + open3d.
  ASCII-only + ErrorActionPreference=Continue (pip stderr must not abort).
#>
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Root  = Join-Path $env:LOCALAPPDATA 'BIMTwin'
$pyDir = Join-Path $Root 'py312'
$pyExe = Join-Path $pyDir 'python.exe'
$PyVer = '3.12.7'
Write-Host "=== BIM Twin: installing Python engine (NumPy + SciPy + Open3D) ==="

function Test-Mods($exe,$mods){ if(-not(Test-Path $exe)){return $false}; & $exe -c "import $mods" 2>$null; return ($LASTEXITCODE -eq 0) }

if (Test-Mods $pyExe 'numpy, open3d') { Write-Host "Already installed. Close this window and return to BIM Twin."; Read-Host "Press Enter"; exit 0 }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path $pyExe)) {
  $exe = Join-Path $env:TEMP "python-$PyVer-amd64.exe"
  Write-Host "Downloading Python $PyVer installer (~25 MB)..."
  try { Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PyVer/python-$PyVer-amd64.exe" -OutFile $exe -UseBasicParsing }
  catch { Write-Host ("Download failed: " + $_.Exception.Message); Read-Host "Press Enter"; exit 1 }
  Write-Host "Installing private Python 3.12 (silent, no admin)..."
  $pyArgs = @('/quiet','InstallAllUsers=0','InstallLauncherAllUsers=0','PrependPath=0','Include_pip=1','Include_test=0','Include_launcher=0','Include_doc=0','AssociateFiles=0','Shortcuts=0',("TargetDir=`"$pyDir`""))
  $proc = Start-Process -FilePath $exe -ArgumentList $pyArgs -Wait -PassThru
  Remove-Item $exe -ErrorAction SilentlyContinue
  if (-not (Test-Path $pyExe)) { Write-Host ("Installer exit code " + $proc.ExitCode + ", python.exe not found."); Read-Host "Press Enter"; exit 1 }
}

& $pyExe -m ensurepip --upgrade 2>$null
& $pyExe -m pip --version 2>$null
if ($LASTEXITCODE -ne 0) {
  $gp = Join-Path $env:TEMP 'get-pip.py'
  Write-Host "Bootstrapping pip..."
  try { Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $gp -UseBasicParsing; & $pyExe $gp --no-warn-script-location } catch { Write-Host ("pip bootstrap failed: " + $_.Exception.Message) }
  Remove-Item $gp -ErrorAction SilentlyContinue
}
Write-Host "Installing numpy scipy open3d (may take a few minutes)..."
& $pyExe -m pip install --upgrade pip --no-warn-script-location
& $pyExe -m pip install numpy scipy open3d --no-warn-script-location
Set-Content -Path (Join-Path $Root 'python-path.txt') -Value $pyExe -Encoding ASCII
if (Test-Mods $pyExe 'numpy, open3d') {
  Set-Content -Path (Join-Path $pyDir 'READY.txt') -Value (Get-Date -Format o) -Encoding ASCII
  Write-Host "Done! Open3D installed. Restart BIM Twin."
} else {
  Write-Host "Open3D could not be installed - NumPy mode will still work without it."
}
Read-Host "Press Enter"
