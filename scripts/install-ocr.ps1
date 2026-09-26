# BIM Twin - OCR installer for Windows: Tesseract (rus+ukr+eng) + Poppler/Ghostscript.
# Run as Administrator (the launcher / app requests elevation automatically).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without a BOM
# using the system ANSI codepage, so non-ASCII text can corrupt parsing.
$ErrorActionPreference = 'Continue'
Write-Host '== BIM Twin: OCR install ==' -ForegroundColor Cyan

# Self-elevate: if not running as admin, relaunch elevated via UAC.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Host 'Administrator rights required - relaunching elevated...' -ForegroundColor Yellow
  try { Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"') } catch { Write-Host $_ -ForegroundColor Red; Read-Host 'Press Enter to exit' }
  exit
}

function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

$haveWinget = Have winget
$haveChoco  = Have choco

if (-not $haveWinget -and -not $haveChoco) {
  Write-Host 'winget and choco not found. Installing Chocolatey...' -ForegroundColor Yellow
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = 3072
  try { Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1')) } catch { Write-Host $_ -ForegroundColor Red }
  $haveChoco = Have choco
}

# --- Tesseract ---
Write-Host 'Installing Tesseract...' -ForegroundColor Cyan
if ($haveWinget) { winget install -e --id UB-Mannheim.TesseractOCR --accept-source-agreements --accept-package-agreements }
elseif ($haveChoco) { choco install tesseract -y }

# --- PDF rasterizer: Poppler + Ghostscript ---
Write-Host 'Installing Poppler / Ghostscript...' -ForegroundColor Cyan
if ($haveChoco) {
  choco install poppler -y
  choco install ghostscript -y
} elseif ($haveWinget) {
  winget install -e --id oschwartz10612.Poppler --accept-source-agreements --accept-package-agreements
  winget install -e --id ArtifexSoftware.GhostScript --accept-source-agreements --accept-package-agreements
}

# --- Language data rus/ukr/eng ---
$tessDir = Join-Path $env:ProgramFiles 'Tesseract-OCR\tessdata'
if (-not (Test-Path $tessDir)) { $tessDir = Join-Path ${env:ProgramFiles(x86)} 'Tesseract-OCR\tessdata' }
if (Test-Path $tessDir) {
  foreach ($lng in @('rus','ukr','eng')) {
    $dst = Join-Path $tessDir ($lng + '.traineddata')
    if (-not (Test-Path $dst)) {
      try {
        Write-Host ('Downloading language pack ' + $lng + '...')
        Invoke-WebRequest -Uri ('https://github.com/tesseract-ocr/tessdata/raw/main/' + $lng + '.traineddata') -OutFile $dst -UseBasicParsing
      } catch { Write-Host ('Failed to download ' + $lng + '.traineddata: ' + $_) -ForegroundColor Yellow }
    }
  }
} else {
  Write-Host 'tessdata folder not found - language packs may have been installed with Tesseract.' -ForegroundColor Yellow
}

Write-Host 'Done. Restart BIM Twin. If tesseract is not visible, sign out/in to refresh PATH.' -ForegroundColor Green
Read-Host 'Press Enter to close'
