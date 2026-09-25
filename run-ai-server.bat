@echo off
setlocal enabledelayedexpansion
title BIM-Twin AI server (foreground)
cd /d "%~dp0"
set "SRV=%~dp0scan2bim-ai-server"
set "VPY=%SRV%\.venv\Scripts\python.exe"

echo ============================================================
echo   BIM-Twin AI server - setup and run (verbose) v1189
echo   This window STAYS OPEN. Copy ALL text here and send it to me.
echo ============================================================
echo.
if not exist "%SRV%\server.py" (
  echo [ERROR] server.py not found in "%SRV%".
  goto :end
)
echo Server folder: %SRV%
echo.

echo --- Detected Python interpreters ---
py -0p 2>nul
where python 2>nul
if exist "%VPY%" (
  echo .venv python:
  "%VPY%" --version 2>&1
)
echo.

REM ---- 1) Create .venv if missing ----
if not exist "%VPY%" (
  echo [SETUP] Creating virtual environment .venv ...
  set "BASE="
  for %%V in (3.11 3.12 3.10) do (
    if not defined BASE (
      py -%%V -c "import sys" >nul 2>&1 && set "BASE=py -%%V"
    )
  )
  if not defined BASE (
    python -c "import sys" >nul 2>&1 && set "BASE=python"
  )
  if not defined BASE (
    echo [ERROR] Python not found. Install Python 3.11 from https://www.python.org/downloads/ and re-run.
    goto :end
  )
  echo [SETUP] Base interpreter: !BASE!
  !BASE! -m venv "%SRV%\.venv"
)

if not exist "%VPY%" (
  echo [ERROR] Failed to create .venv. See messages above.
  goto :end
)

REM ---- 2) Ensure numpy (hard requirement for the LITE server) ----
echo.
echo [SETUP] Checking numpy ...
"%VPY%" -c "import numpy" >nul 2>&1
if errorlevel 1 (
  echo [SETUP] Installing numpy ...
  "%VPY%" -m pip install --upgrade pip
  "%VPY%" -m pip install numpy
)
"%VPY%" -c "import numpy, sys; print('[OK] numpy', numpy.__version__, 'on', sys.version)" 2>&1
if errorlevel 1 (
  echo [ERROR] numpy could not be installed. Check the pip output above.
  goto :end
)

REM ---- 2b) Optional quality + web stack (best effort, ok if it fails) ----
echo [SETUP] Installing optional quality deps (best effort): scipy scikit-image shapely ...
"%VPY%" -m pip install scipy scikit-image shapely >nul 2>&1
echo [SETUP] Trying full web stack (best effort): fastapi uvicorn python-multipart ...
"%VPY%" -m pip install fastapi "uvicorn[standard]" python-multipart >nul 2>&1

REM ---- 3) Verify server_lite imports (this catches real errors) ----
cd /d "%SRV%"
echo.
echo [CHECK] Importing server_lite ...
"%VPY%" -c "import server_lite" 2>&1
if errorlevel 1 (
  echo [ERROR] server_lite.py failed to import (traceback above). Send it to me.
  goto :end
)
echo [OK] server_lite imports fine.
echo.

REM ---- 4) Choose engine: uvicorn if available, else LITE (stdlib) ----
set "USEUVICORN=0"
"%VPY%" -c "import uvicorn, fastapi" >nul 2>&1
if not errorlevel 1 set "USEUVICORN=1"

echo ============================================================
echo [RUN] Starting server on http://127.0.0.1:8765
echo       Leave THIS window OPEN. Then open the app and click "Build BIM 1:1".
echo       Quick test: open http://127.0.0.1:8765/health in your browser.
echo       Press Ctrl+C here to stop the server.
echo ============================================================
set "PORT=8765"
set "HOST=127.0.0.1"
if "%USEUVICORN%"=="1" (
  echo [RUN] Engine: FastAPI/uvicorn
  "%VPY%" -m uvicorn server:app --host 127.0.0.1 --port 8765
) else (
  echo [RUN] Engine: LITE (Python stdlib + numpy, no fastapi/uvicorn needed)
  "%VPY%" server_lite.py
)
echo.
echo [INFO] Server process ended (exit code %errorlevel%).

:end
echo.
echo ------------------------------------------------------------
echo If anything failed above, copy ALL the text and send it to me.
echo ------------------------------------------------------------
pause
endlocal
