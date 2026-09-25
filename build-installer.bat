@echo off
REM ============================================================
REM  BIM Twin - сборка Windows-установщика (.exe)
REM  Запустите этот файл двойным кликом на Windows.
REM  Требуется: Node.js LTS (nodejs.org) + интернет.
REM  Результат: dist\BIM Twin Setup 0.9.39.exe  (один файл-установщик).
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js не найден. Установите Node.js LTS с https://nodejs.org и запустите снова.
  pause
  exit /b 1
)

echo === [1/4] Установка зависимостей (npm install) ===
REM Скачает three.js, PlayCanvas, Potree (@pnext/three-loader) и остальное.
call npm install
if errorlevel 1 goto :err

echo === [2/4] Пересборка нативных модулей под Electron (better-sqlite3) ===
REM Не критично: если не соберётся, приложение перейдёт на JSON-хранилище.
call npm run rebuild

echo === [3/4] Сборка встроенных вьюеров и движков (bundles) ===
REM Сжатие PLY -> SOG (~15-20x, «как на superspl.at») включается автоматически:
REM пакет @playcanvas/splat-transform ставится на шаге [1/4] (npm install).
REM ВАЖНО: собирает PlayCanvas (3DGS) и Potree (облака) ДО упаковки,
REM чтобы бандлы попали внутрь установщика. Если какой-то движок не соберётся,
REM приложение автоматически использует встроенные вьюеры (не ломается).
call npm run prestart

echo === [4/4] Сборка установщика NSIS (.exe) ===
call npm run dist:win
if errorlevel 1 goto :err

echo.
echo ============================================================
echo  ГОТОВО! Установщик лежит в папке:  dist\
echo  Файл вида:  BIM Twin Setup 0.9.39.exe
echo.
echo  (ОПЦИОНАЛЬНО) Для облаков «CloudCompare 1‚1» через Potree:
echo   скачайте PotreeConverter (github.com/potree/PotreeConverter)
echo   и положите PotreeConverter.exe в папку:  vendor\potree-converter\
echo   Пересоберите установщик. Без него облака открываются встроенным вьюером.
echo ============================================================
pause
exit /b 0

:err
echo.
echo [!] ОШИБКА сборки. Проверьте интернет и что установлен Node.js LTS.
pause
exit /b 1
