@echo off
setlocal
cd /d "%~dp0"
title BIM Twin
chcp 65001 >nul

echo ============================================
echo   BIM Twin - быстрый запуск (без пересборки)
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден!
  echo Скачайте с https://nodejs.org (нужна LTS версия)
  start "" https://nodejs.org
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo Node.js %%v
echo.

if not exist "node_modules\electron" (
  echo [1/2] Первый запуск — устанавливаем зависимости (нужен интернет)...
  call npm install --prefer-offline
  if errorlevel 1 (
    echo.
    echo [ОШИБКА] npm install не удался. Проверьте интернет.
    pause
    exit /b 1
  )
  echo.
) else (
  echo [1/2] Зависимости уже установлены.
)

echo [2/2] Запуск BIM Twin...
echo (Если окно закроется — смотрите ошибку выше)
echo.

set ELECTRON_ENABLE_LOGGING=1
call node_modules\.bin\electron . 2>&1

if errorlevel 1 (
  echo.
  echo [ОШИБКА] Приложение завершилось с ошибкой.
  echo Попробуйте:
  echo   1. Запустить от имени Администратора
  echo   2. Удалить папку node_modules и запустить снова
)

echo.
echo Нажмите любую клавишу для выхода...
pause >nul
exit /b 0
