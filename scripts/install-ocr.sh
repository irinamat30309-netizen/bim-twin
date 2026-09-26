#!/usr/bin/env bash
# BIM Twin — установка OCR: Tesseract (rus+ukr+eng) + Poppler/Ghostscript.
# macOS (Homebrew) и Linux (apt/dnf/yum/pacman/zypper). Полностью оффлайн-дружелюбно:
# просто вызывает системный пакетный менеджер.
set -e
echo "== BIM Twin: установка OCR (Tesseract + Poppler/Ghostscript) =="

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew не найден. Установите его с https://brew.sh и запустите скрипт снова."
    exit 1
  fi
  echo "Установка через Homebrew..."
  brew install tesseract tesseract-lang poppler ghostscript
  echo "Готово. tesseract-lang включает rus/ukr/eng. Перезапустите BIM Twin."
  exit 0
fi

# --- Linux ---
SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi

if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update
  $SUDO apt-get install -y tesseract-ocr tesseract-ocr-rus tesseract-ocr-ukr tesseract-ocr-eng poppler-utils ghostscript
elif command -v dnf >/dev/null 2>&1; then
  $SUDO dnf install -y tesseract tesseract-langpack-rus tesseract-langpack-ukr tesseract-langpack-eng poppler-utils ghostscript
elif command -v yum >/dev/null 2>&1; then
  $SUDO yum install -y tesseract poppler-utils ghostscript
elif command -v pacman >/dev/null 2>&1; then
  $SUDO pacman -Sy --noconfirm tesseract tesseract-data-rus tesseract-data-ukr tesseract-data-eng poppler ghostscript
elif command -v zypper >/dev/null 2>&1; then
  $SUDO zypper install -y tesseract-ocr tesseract-ocr-traineddata-russian tesseract-ocr-traineddata-ukrainian tesseract-ocr-traineddata-english poppler-tools ghostscript
else
  echo "Не удалось определить пакетный менеджер."
  echo "Установите вручную: tesseract (+ rus/ukr/eng) и poppler-utils или ghostscript."
  exit 1
fi

echo "Готово. Перезапустите BIM Twin."
