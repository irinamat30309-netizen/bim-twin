#!/bin/bash
# BIM Twin - быстрый запуск (macOS). Двойной клик в Finder.
cd "$(dirname "$0")" || exit 1

echo "============================================"
echo "  BIM Twin - быстрый запуск"
echo "============================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ОШИБКА] Node.js не найден. Установите LTS с https://nodejs.org"
  open https://nodejs.org
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[1/2] Первая установка зависимостей (npm install)..."
  npm install || { echo "[ОШИБКА] npm install не удался."; exit 1; }
else
  echo "[1/2] Зависимости уже установлены - пропускаю npm install."
fi

# Проверка OCR (Tesseract + растеризатор PDF); установка при отсутствии.
NEED_OCR=0
command -v tesseract >/dev/null 2>&1 || NEED_OCR=1
if ! command -v pdftoppm >/dev/null 2>&1 && ! command -v pdftocairo >/dev/null 2>&1 && ! command -v gs >/dev/null 2>&1; then NEED_OCR=1; fi
if [ "$NEED_OCR" = "1" ]; then
  echo "[OCR] Компоненты OCR не найдены - запускаю установщик..."
  bash "$(dirname "$0")/scripts/install-ocr.sh" || echo "[OCR] Установщик завершился с ошибкой - см. OCR-SETUP.md"
else
  echo "[OCR] OK - Tesseract и растеризатор PDF найдены."
fi

echo "[2/2] Запуск приложения (npm start)..."
npm start
