# POINTCLOUD-PATCH-59 — Самонастраивающийся Windows-установщик Python-движка (Open3D)

## Цель
Установщик Windows должен **сам** ставить и настраивать Python-движок очистки (NumPy + Open3D), без ручных шагов пользователя.

## Что сделано
1. **`scripts/setup-python.ps1`** (новый) — без прав админа ставит изолированный Python 3.12 (embeddable) в `%LOCALAPPDATA%\BIMTwin\py` + `numpy`/`open3d`. Идемпотентно, поддерживает офлайн-колёса. Коды: 0=Open3D, 2=только NumPy, 1=ошибка.
2. **`build/installer.nsh`** (новый) — NSIS-хук `customInstall` запускает setup-python.ps1 после копирования файлов (с логом в окне установки), автоопределяет офлайн-папку `resources\wheels`; `customUnInstall` чистит `%LOCALAPPDATA%\BIMTwin`.
3. **`package.json`** — `build.nsis.include = build/installer.nsh`, `perMachine=false`, `extraResources` копирует setup-python.ps1 в `resources\`.
4. **`main.js` → `pythonBin()`** — теперь в первую очередь ищет изолированный Python установщика (`python-path.txt` и `%LOCALAPPDATA%\BIMTwin\py\python.exe`).
5. **`scripts/install-pydeps.ps1`** (переписан) — кнопка «Установить Open3D» в приложении теперь полностью автоматична (ставит Python при необходимости + numpy/scipy/open3d).
6. **`BUILD-WINDOWS.md`** — раздел про автонастройку и офлайн-сборку.

## Связь с движком
После автонастройки десктоп-режим «Чистка» (`API.cleanCloud` → `tools/pointcloud_clean.py`, операция `auto`) использует Open3D-конвейер (SOR + radius outlier + DBSCAN). Без Open3D — numpy-фолбэк по плотности.

## Требования / ограничения
- Интернет во время установки (либо офлайн-`wheels`). После — полностью офлайн.
- Сборка самого `.exe` по-прежнему на Windows (`build-installer.bat`).
