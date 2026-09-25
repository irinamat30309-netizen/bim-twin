#requires -version 5
<#
  BIM Twin - auto-download + install of CloudCompare (ready-made point-cloud editor).
  Downloads the official installer (Inno Setup) and installs it silently, per-user, into a
  private folder (default: %LOCALAPPDATA%\BIMTwin\cloudcompare) so the app can launch
  CloudCompare.exe directly. No admin required.
  Idempotent: exits fast if CloudCompare.exe already exists.
  Exit codes: 0 = installed/ready; 1 = error.
  ASCII-only on purpose: PowerShell 5.1 reads BOM-less .ps1 as ANSI, so any
  non-ASCII here could be misparsed. Keep this file ASCII.
#>
[CmdletBinding()]
param(
  [string]$Dest   = (Join-Path (Join-Path $env:LOCALAPPDATA 'BIMTwin') 'cloudcompare'),
  [string]$Url    = 'https://www.cloudcompare.org/release/CloudCompare_v2.13.2_setup_x64.exe',
  [string]$Sha256 = '2384FAAABDC10BA11D64652B324724481CBA6E2634CE5D1D95B2F9AC457DC163'
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Log($m){ Write-Host "[BIMTwin-CC] $m" }

$ccExe = Join-Path $Dest 'CloudCompare.exe'
if (Test-Path $ccExe) { Log "Already installed: $ccExe"; exit 0 }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$setup = Join-Path $env:TEMP 'CloudCompare_setup_x64.exe'
Log "Downloading CloudCompare installer (~100 MB). Please wait..."
try {
  Invoke-WebRequest -Uri $Url -OutFile $setup -UseBasicParsing
} catch {
  Log ("Download failed: " + $_.Exception.Message)
  exit 1
}
if (-not (Test-Path $setup)) { Log "Installer not found after download."; exit 1 }

if ($Sha256 -and $Sha256.Length -eq 64) {
  try {
    $h = (Get-FileHash -Path $setup -Algorithm SHA256).Hash
    if ($h -ne $Sha256.ToUpper()) {
      Log ("Checksum mismatch. Expected " + $Sha256.ToUpper() + " got " + $h)
      Remove-Item $setup -ErrorAction SilentlyContinue
      exit 1
    }
    Log "Checksum OK."
  } catch { Log ("Checksum check skipped: " + $_.Exception.Message) }
}

Log "Installing CloudCompare (silent) into $Dest ..."
# The CloudCompare Windows installer is an Inno Setup package (NOT NSIS), so the
# correct silent switches are /SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL
# and the target dir is passed via /DIR="...". /VERYSILENT shows no window at all,
# which also prevents the extra CloudCompare and FARO LS setup wizards from popping up.
# Pass the argument list as ONE string; Inno accepts the quoted /DIR path.
$argLine = '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /DIR="' + $Dest + '"'
$proc = Start-Process -FilePath $setup -ArgumentList $argLine -Wait -PassThru
Remove-Item $setup -ErrorAction SilentlyContinue

if (Test-Path $ccExe) {
  Log "Done. CloudCompare installed: $ccExe"
  exit 0
}
Log ("CloudCompare installer finished with code " + $proc.ExitCode + " but CloudCompare.exe was not found in $Dest.")
exit 1
