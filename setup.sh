#!/usr/bin/env bash
# BIM Twin — установка компонентов (macOS / Linux)
# Использование: ./setup.sh        (интерактивно)
#               ./setup.sh all    (установить всё без вопросов)
cd "$(dirname "$0")" || exit 1
ALL=0
[ "$1" = "all" ] && ALL=1

ask() {
  # $1 = вопрос; возвращает 0 (да) / 1 (нет)
  if [ "$ALL" = "1" ]; then return 0; fi
  printf '%s [Y/n] ' "$1"
  read -r a
  case "$a" in [nN]*) return 1 ;; *) return 0 ;; esac
}

echo "============================================"
echo "  BIM Twin — установка компонентов (Unix)"
echo "============================================"
echo "Совет: './setup.sh all' установит всё без вопросов."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ОШИБКА] Node.js не найден. Установите LTS с https://nodejs.org"
  exit 1
fi
echo "Node.js: $(node -v)   npm: $(npm -v)"
echo

echo "[1] Базовые зависимости (npm install)..."
if ! npm install; then
  echo "[ОШИБКА] npm install не удался. Проверьте интернет/права."
  exit 1
fi

if ask "Установить локальную БД SQLite (better-sqlite3 + пересборка)?"; then
  echo "[2] better-sqlite3 + electron-rebuild..."
  echo "    macOS: нужен Xcode CLT (xcode-select --install); Linux: build-essential python3."
  npm install better-sqlite3 && npm run rebuild \
    || echo "[ПРЕДУПР.] SQLite не собрался — приложение будет работать на JSON-слое."
fi

if ask "Установить геометрию IFC (web-ifc + draco3d)?"; then
  echo "[3] web-ifc + draco3d..."
  npm install web-ifc draco3d || echo "[ПРЕДУПР.] Не удалось установить IFC-модули."
fi

if [ "$(uname)" = "Darwin" ]; then
  if command -v brew >/dev/null 2>&1; then
    if ask "Установить Tesseract OCR (rus+ukr+eng)?"; then
      echo "[4] Tesseract..."; brew install tesseract tesseract-lang || echo "[ПРЕДУПР.] Tesseract не установлен."
      echo "    (tesseract-lang включает русский и украинский языки)"
    fi
    if ask "Установить Ollama (локальный LLM)?"; then
      echo "[5] Ollama..."; brew install ollama && (ollama pull llama3.1 || echo "Позже: ollama serve && ollama pull llama3.1")
    fi
  else
    echo "[ПРОПУСК] Homebrew не найден. Установите с https://brew.sh, затем Tesseract/Ollama."
  fi
elif command -v apt-get >/dev/null 2>&1; then
  if ask "Установить Tesseract OCR (rus+ukr+eng)?"; then
    echo "[4] Tesseract..."; sudo apt-get update && sudo apt-get install -y tesseract-ocr tesseract-ocr-rus tesseract-ocr-ukr tesseract-ocr-eng || echo "[ПРЕДУПР.] Tesseract не установлен."
  fi
  if ask "Установить Ollama (локальный LLM)?"; then
    echo "[5] Ollama..."; curl -fsSL https://ollama.com/install.sh | sh && (ollama pull llama3.1 || echo "Позже: ollama pull llama3.1")
  fi
else
  echo "[ПРОПУСК] Пакетный менеджер не распознан. Установите Tesseract (языки rus/ukr/eng) и Ollama вручную."
fi

echo
echo "[6] Готово!"
echo "    Запуск в dev-режиме:   npm start"
echo "    Сборка установщика:    npm run dist   (или dist:win / dist:mac)"
echo "    Язык OCR по умолчанию: rus+ukr+eng (меняется в Настройках → ИИ)"
