@echo off
title BIM-Twin START
cd /d "%~dp0"
REM ============================================================
REM  BIM-Twin START (v1190) - ASCII only, cannot self-close.
REM  - The app starts the AI server itself (LITE now, GPU later).
REM  - If an NVIDIA GPU is present, this file launches a ONE-CLICK
REM    automatic GPU + neural-net setup in a separate window.
REM    The app keeps working and switches to GPU automatically.
REM ============================================================

echo ==== BIM-Twin START.bat v1202 ====
echo.

REM ---- Automatic GPU + neural-net setup (one click) ----
echo [BIM-Twin] Checking for NVIDIA GPU...
nvidia-smi >nul 2>&1
if errorlevel 1 goto :nogpu
if exist "%~dp0scan2bim-ai-server\.gpusetup.done" goto :gpudone
if exist "%~dp0scan2bim-ai-server\.gpu-installing" goto :gpubusy
if not exist "%~dp0install-ai-gpu.bat" goto :gpuskip
echo [BIM-Twin] NVIDIA GPU found - starting AUTOMATIC GPU + neural-net setup...
echo            (separate window; downloads ~2.5 GB once; the app keeps working)
start "BIM-Twin AI GPU setup" cmd /c ""%~dp0install-ai-gpu.bat""
goto :gpuend
:nogpu
echo [BIM-Twin] No NVIDIA GPU detected - 1:1 works on CPU (offline).
goto :gpuend
:gpudone
echo [BIM-Twin] GPU already installed - the app will use it automatically.
goto :gpuend
:gpubusy
echo [BIM-Twin] GPU setup is already running in another window.
goto :gpuend
:gpuskip
echo [BIM-Twin] install-ai-gpu.bat not found - skipping GPU setup.
:gpuend

echo.
echo [BIM-Twin] Launching the application (it starts the AI server automatically)...
echo.

if exist "dist\win-unpacked\BIM Twin.exe" goto :runexe

where npm >nul 2>&1
if errorlevel 1 goto :nonode
if not exist "node_modules\electron" goto :npminstall

:runnpm
echo [BIM-Twin] Running: npm start   (this window stays open while the app runs)
echo.
call npm start
if errorlevel 1 echo [ERROR] The app exited with an error. See the text above.
goto :done

:npminstall
echo [BIM-Twin] First run: installing dependencies (npm install).
echo            Needs internet, may take several minutes...
echo.
call npm install
if errorlevel 1 goto :installerr
goto :runnpm

:runexe
echo [BIM-Twin] Launching packaged app (dist\win-unpacked\BIM Twin.exe)...
start "" "dist\win-unpacked\BIM Twin.exe"
goto :done

:installerr
echo.
echo [ERROR] npm install failed. Check your internet connection and run START.bat again.
goto :done

:nonode
echo.
echo [INFO] Node.js/npm not found. Install Node.js LTS from https://nodejs.org/
echo        then run START.bat again.
goto :done

:done
echo.
echo ============================================================
echo [BIM-Twin] Done. In the app, open the panel and click "Build BIM 1:1".
echo The panel shows GPU status; it turns to "GPU: yes" automatically when ready.
echo ============================================================
echo.
pause
