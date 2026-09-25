@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"
REM ============================================================
REM  BIM-Twin - tihiy zapusk AI-servera (Scan2BIM) na 127.0.0.1:8765
REM  Vyzyvaetsya iz START.bat v fone. Vybiraet TOLKO takoy python,
REM  v kotorom realno est uvicorn+fastapi+numpy. Esli ni odin ne gotov -
REM  probuet odin raz sam nastroit .venv (setup-ai-server.ps1), inache
REM  vyhodit i prilozhenie rabotaet oflayn vstroennym dvizhkom.
REM ============================================================
set "SRV=%~dp0scan2bim-ai-server"
if not exist "%SRV%\server.py" (
  echo [AI] Server folder not found - skip.
  exit /b 0
)

REM Uzhe zapushchen? Proveryaem port 8765.
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',8765);exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo [AI] Server already running on 127.0.0.1:8765.
  exit /b 0
)

set "PYEXE="

REM 1) GPU/CPU venv (install_gpu_windows.bat ili setup-ai-server.ps1).
REM    Zapuskaem TOLKO esli v nem realno est web-stack.
if exist "%SRV%\.venv\Scripts\python.exe" (
  "%SRV%\.venv\Scripts\python.exe" -c "import uvicorn,fastapi,numpy" >nul 2>&1
  if not errorlevel 1 set "PYEXE=%SRV%\.venv\Scripts\python.exe"
)

REM 2) CPU python, nastroennyy setup-ai-server.ps1.
if not defined PYEXE if exist "%LOCALAPPDATA%\BIMTwin\ai-server-python.txt" (
  for /f "usebackq delims=" %%p in ("%LOCALAPPDATA%\BIMTwin\ai-server-python.txt") do set "CAND=%%p"
  if exist "!CAND!" (
    "!CAND!" -c "import uvicorn,fastapi,numpy" >nul 2>&1
    if not errorlevel 1 set "PYEXE=!CAND!"
  )
)

REM 3) Privatnyy CPython (setup-python.ps1).
if not defined PYEXE if exist "%LOCALAPPDATA%\BIMTwin\python-path.txt" (
  for /f "usebackq delims=" %%p in ("%LOCALAPPDATA%\BIMTwin\python-path.txt") do set "CAND=%%p"
  if exist "!CAND!" (
    "!CAND!" -c "import uvicorn,fastapi,numpy" >nul 2>&1
    if not errorlevel 1 set "PYEXE=!CAND!"
  )
)

REM 4) Sistemnyy python, u kotorogo uzhe est web-stack.
if not defined PYEXE (
  for %%c in (py python python3) do (
    if not defined PYEXE (
      %%c -c "import uvicorn,fastapi,numpy" >nul 2>&1
      if not errorlevel 1 set "PYEXE=%%c"
    )
  )
)

REM 5) Nichego ne gotovo - probuem odin raz sam sozdat/dolechit .venv.
if not defined PYEXE (
  echo [AI] Pervaya nastroyka AI-servera (mozhet zanyat neskolko minut)...
  set "PS1=%~dp0scripts\setup-ai-server.ps1"
  if not exist "!PS1!" set "PS1=%~dp0resources\setup-ai-server.ps1"
  if exist "!PS1!" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "!PS1!" -ServerDir "%SRV%" > "%SRV%\ai-setup.log" 2>&1
    if exist "%SRV%\.venv\Scripts\python.exe" (
      "%SRV%\.venv\Scripts\python.exe" -c "import uvicorn,fastapi,numpy" >nul 2>&1
      if not errorlevel 1 set "PYEXE=%SRV%\.venv\Scripts\python.exe"
    )
  )
)

REM Esli nashli python s uvicorn - zapuskaem polnyy FastAPI-server.
if defined PYEXE (
  echo [AI] Starting Scan2BIM AI server (uvicorn, 127.0.0.1:8765) in background...
  cd /d "%SRV%"
  set "PORT=8765"
  start "BIM-Twin AI server" /min cmd /c ""!PYEXE!" -m uvicorn server:app --host 127.0.0.1 --port 8765 > "%SRV%\ai-server.log" 2>&1"
  exit /b 0
)

REM 6) uvicorn ne nayden - probuem LITE-server (stdlib http.server + numpy).
REM    Emu nuzhen TOLKO numpy, kotoryy pochti vsegda uzhe est (ego stavit torch).
set "PYLITE="
if exist "%SRV%\.venv\Scripts\python.exe" (
  "%SRV%\.venv\Scripts\python.exe" -c "import numpy" >nul 2>&1
  if not errorlevel 1 set "PYLITE=%SRV%\.venv\Scripts\python.exe"
)
if not defined PYLITE if exist "%LOCALAPPDATA%\BIMTwin\python-path.txt" (
  for /f "usebackq delims=" %%p in ("%LOCALAPPDATA%\BIMTwin\python-path.txt") do set "CAND=%%p"
  if exist "!CAND!" (
    "!CAND!" -c "import numpy" >nul 2>&1
    if not errorlevel 1 set "PYLITE=!CAND!"
  )
)
if not defined PYLITE (
  for %%c in (py python python3) do (
    if not defined PYLITE (
      %%c -c "import numpy" >nul 2>&1
      if not errorlevel 1 set "PYLITE=%%c"
    )
  )
)
if defined PYLITE if exist "%SRV%\server_lite.py" (
  echo [AI] Starting Scan2BIM LITE server (stdlib+numpy, 127.0.0.1:8765) in background...
  cd /d "%SRV%"
  set "PORT=8765"
  set "HOST=127.0.0.1"
  start "BIM-Twin AI server" /min cmd /c ""!PYLITE!" server_lite.py > "%SRV%\ai-server.log" 2>&1"
  exit /b 0
)

echo [AI] Ne nayden Python s numpy - rabotaem oflayn vstroennym dvizhkom 1:1.
echo [AI] Sovet: zapustite run-ai-server.bat odin raz ^(pokazhet podrobnyy log^).
exit /b 0
