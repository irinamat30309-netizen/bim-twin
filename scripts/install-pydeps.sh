#!/usr/bin/env bash
set +e
echo "=== Установка Python-зависимостей для BIM Twin: NumPy, SciPy, Open3D ==="
PY=""
for c in python3 python; do if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi; done
if [ -z "$PY" ]; then echo "Python 3 не найден. Установите Python 3.9-3.12 с https://python.org и повторите."; read -p "Нажмите Enter…" _; exit 1; fi
echo "Использую: $($PY --version 2>&1)"
"$PY" -m pip install --upgrade pip
echo "Устанавливаю numpy scipy open3d (может занять несколько минут)…"
if "$PY" -m pip install --user numpy scipy open3d; then
  echo ""; echo "Готово! Закройте окно и вернитесь в приложение."
else
  echo ""; echo "Не удалось установить open3d (возможно, версия Python не поддерживается — нужен Python 3.9-3.12)."
  echo "NumPy/SciPy-режим отклонений и совмещения будет работать и без open3d."
fi
read -p "Нажмите Enter…" _
