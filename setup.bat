@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set ALL=0
if /i "%~1"=="all" set ALL=1

echo ============================================
echo   BIM Twin - установка компонентов (Windows)
echo ============================================
echo Совет: запустите "setup.bat all", чтобы установить всё без вопросов.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Установите LTS с https://nodejs.org и запустите снова.
  start https://nodejs.org
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node.js: %%v
for /f "delims=" %%v in ('npm -v') do echo npm:     %%v
echo.

echo [1/6] Базовые зависимости (npm install)...
call npm install
if errorlevel 1 (
  echo [ОШИБКА] npm install не удался. Проверьте интернет/права.
  pause
  exit /b 1
)

call :ask "Установить локальную БД SQLite (better-sqlite3 + пересборка)?" SQLITE
if "!SQLITE!"=="Y" (
  echo [2/6] better-sqlite3 + electron-rebuild...
  echo   Нужен Visual Studio Build Tools "Desktop development with C++" и Python 3.
  call npm install better-sqlite3
  call npm run rebuild
  if errorlevel 1 echo [ПРЕДУПР.] Не удалось собрать SQLite — приложение будет работать на JSON-слое.
)

call :ask "Установить геометрию IFC (web-ifc + draco3d)?" IFC
if "!IFC!"=="Y" (
  echo [3/6] web-ifc + draco3d...
  call npm install web-ifc draco3d
)

where winget >nul 2>&1
if errorlevel 1 (
  echo [ПРОПУСК] winget не найден — Tesseract и Ollama установите вручную.
  echo   Tesseract: https://github.com/UB-Mannheim/tesseract/wiki
  echo   Ollama:    https://ollama.com/download
) else (
  call :ask "Установить Tesseract OCR (rus+ukr+eng)?" TESS
  if "!TESS!"=="Y" (
    echo [4/6] Tesseract OCR...
    winget install -e --id UB-Mannheim.TesseractOCR --accept-source-agreements --accept-package-agreements
    call :tessdata
  )
  call :ask "Установить Ollama (локальный LLM)?" OLLAMA
  if "!OLLAMA!"=="Y" (
    echo [5/6] Ollama...
    winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
    where ollama >nul 2>&1
    if not errorlevel 1 (
      echo Загрузка модели llama3.1...
      ollama pull llama3.1
    ) else (
      echo [ИНФО] Перезапустите терминал и выполните: ollama pull llama3.1
    )
  )
)

echo.
echo [6/6] Готово!
echo   Запуск в dev-режиме:      npm start
echo   Сборка установщика:     npm run dist:win
echo   Где менять язык OCR:    Настройки -^> ИИ -^> Язык OCR (по умолчанию rus+ukr+eng)
echo.
pause
exit /b 0

:tessdata
set "TDIR=%ProgramFiles%\Tesseract-OCR\tessdata"
if not exist "%TDIR%" set "TDIR=%ProgramFiles(x86)%\Tesseract-OCR\tessdata"
if not exist "%TDIR%" (
  echo [ИНФО] Папка tessdata не найдена — добавьте rus/ukr/eng вручную.
  goto :eof
)
where curl >nul 2>&1
if errorlevel 1 ( echo [ИНФО] curl недоступен — скачайте *.traineddata вручную. & goto :eof )
for %%L in (rus ukr eng) do (
  if not exist "%TDIR%\%%L.traineddata" (
    echo Загрузка %%L.traineddata ...
    curl -L -o "%TDIR%\%%L.traineddata" https://github.com/tesseract-ocr/tessdata_fast/raw/main/%%L.traineddata
    if errorlevel 1 echo [ПРЕДУПР.] Не удалось скачать %%L — запустите батник от имени админа.
  )
)
goto :eof

:ask
if "%ALL%"=="1" ( set "%~2=Y" & goto :eof )
set "%~2=N"
set /p _a="%~1 [Y/n] "
if /i "!_a!"==""  set "%~2=Y"
if /i "!_a!"=="y" set "%~2=Y"
if /i "!_a!"=="д" set "%~2=Y"
goto :eof
