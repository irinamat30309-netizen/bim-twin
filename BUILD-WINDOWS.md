# Сборка Windows-установщика BIM Twin (с RTX и максимумом точек)

Установщик `.exe` собирается **на Windows** (Electron не умеет собирать Windows-установщик из Linux-песочницы без доп. инструментов).

## Быстрый способ (одна кнопка)

1. Установите **Node.js LTS**: https://nodejs.org
2. Распакуйте архив проекта.
3. Двойной клик по **`build-installer.bat`**.
4. Готовый установщик появится в папке **`dist\`** — файл `BIM Twin Setup 0.9.39.exe`.

## Ручной способ (если хочется контроля)

```bat
npm install
npm run rebuild      :: пересборка better-sqlite3 под Electron (не критично)
npm run dist:win     :: сборка NSIS-установщика
```

## Что внутри установщика

- Electron-runtime + все зависимости (three, pdfjs, xlsx, docx, superdoc, libredwg и т.д.);
- ядро (`main.js`, `preload.js`, `app-config.js`), весь `renderer/**`, `db/**`, `scripts/**`, `ai/**`;
- нативный `better-sqlite3` (распакован из asar). Если не собрался — автофоллбек на JSON-хранилище.

## GPU / точки

- Приложение принудительно запрашивает дискретную GPU (`force_high_performance_gpu`) — будет работать на RTX 5070.
- Бюджет точек по умолчанию: **100 млн**; видимых на экране (LOD): **40 млн**; потолок октодерева: **400 млн**.
- Ползунок «Плотн.» в панели ◐ «Качество облака» тянется до **300 млн** точек.


## Автонастройка Python-движка (Open3D) — v1029

Установщик теперь **сам ставит и настраивает Python-движок** — пользователю ничего делать не нужно.

- Во время установки (NSIS-хук `build/installer.nsh` → `!macro customInstall`) автоматически запускается `scripts/setup-python.ps1`.
- Скрипт без прав админа ставит изолированный Python 3.12 (embeddable) в `%LOCALAPPDATA%\BIMTwin\py` и пакеты `numpy` + `open3d`. Системный Python не требуется и не затрагивается.
- Приложение автоматически находит этот Python (`main.js` → `pythonBin()` проверяет `%LOCALAPPDATA%\BIMTwin\py\python.exe` и `python-path.txt`).
- Идемпотентно: повторная установка/обновление не качает пакеты заново.
- Кнопка «Установить Open3D» в приложении (`scripts/install-pydeps.ps1`) теперь тоже полностью автоматичная (ставит Python при необходимости + numpy/scipy/open3d).

### Требования
- Интернет **во время установки** (скачиваются Python ≈ 11 МБ и колёса open3d/numpy ≈ 300–400 МБ). После установки всё работает офлайн.
- Open3D опирается на Microsoft Visual C++ Redistributable (обычно уже есть в Windows 10/11).

### Офлайн-сборка (без интернета у клиента)
Чтобы установщик ставил Open3D без интернета, положите заранее скачанные `*.whl` (numpy, open3d и их зависимости под cp312 win_amd64) в папку `build/wheels/` и добавьте её в `extraResources`:
```
"extraResources": [
  { "from": "scripts/setup-python.ps1", "to": "setup-python.ps1" },
  { "from": "build/wheels", "to": "wheels" }
]
```
Хук сам обнаружит `resources\wheels` и поставит пакеты офлайн (`pip install --no-index --find-links`).
