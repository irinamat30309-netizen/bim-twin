@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul

set "SRV=%~dp0scan2bim-ai-server"
set "MDL=%SRV%\models"
set "DEST=%MDL%\ptv3_s3dis.pth"
set "CFGDEST=%MDL%\ptv3_s3dis_config.py"
set "URL=https://huggingface.co/Pointcept/PointTransformerV3/resolve/main/s3dis-semseg-pt-v3m1-1-ppt-extreme/model/model_best.pth"
set "CFG=https://huggingface.co/Pointcept/PointTransformerV3/resolve/main/s3dis-semseg-pt-v3m1-1-ppt-extreme/config.py"
set "UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64) scan2bim"

echo ============================================================
echo   Skachivanie vesov neyroseti PTv3 S3DIS ppt-extreme
echo   (odin fayl, neskolko soten MB - podozhdite)
echo ============================================================
echo.

if not exist "%MDL%" mkdir "%MDL%"

if exist "%DEST%" (
  for %%A in ("%DEST%") do set "SZ=%%~zA"
  if !SZ! GTR 1000000 (
    echo [OK] Vesa uzhe na meste: "%DEST%" ^(!SZ! bayt^)
    goto DONE
  )
)

where curl.exe >nul 2>nul
if errorlevel 1 goto USEPS

echo [1/2] config.py ...
curl.exe -L -f -A "%UA%" --create-dirs -o "%CFGDEST%" "%CFG%"
echo [2/2] vesa model_best.pth ...
curl.exe -L -f -A "%UA%" --create-dirs -o "%DEST%" "%URL%"
if errorlevel 1 goto USEPS
goto CHECK

:USEPS
echo [INFO] Probuyu cherez PowerShell ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try{ Invoke-WebRequest -UseBasicParsing -UserAgent 'Mozilla/5.0' -Uri '%CFG%' -OutFile '%CFGDEST%' }catch{}; Invoke-WebRequest -UseBasicParsing -UserAgent 'Mozilla/5.0' -Uri '%URL%' -OutFile '%DEST%'"
if errorlevel 1 goto FAIL

:CHECK
if not exist "%DEST%" goto FAIL
set "SZ=0"
for %%A in ("%DEST%") do set "SZ=%%~zA"
if !SZ! LSS 1000000 (
  echo [ERROR] Fayl slishkom malenkiy ^(!SZ! bayt^) - skachivanie ne udalos.
  del "%DEST%" >nul 2>nul
  goto FAIL
)
echo.
echo [OK] Gotovo! Vesa skachany: "%DEST%" ^(!SZ! bayt^)
goto DONE

:FAIL
echo.
echo ============================================================
echo   Ne udalos skachat avtomaticheski.
echo   Skachayte fayl vruchnuyu v brauzere:
echo     https://huggingface.co/Pointcept/PointTransformerV3/tree/main/s3dis-semseg-pt-v3m1-1-ppt-extreme/model
echo   Fayl model_best.pth polozhite v papku:
echo     "%MDL%"
echo ============================================================

:DONE
echo.
pause
