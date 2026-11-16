# P2P3-INTEGRATION-r155 — CRS/координаты, Mesh-инструменты, Clipping Box

Статус: **интеграция выполнена**, E2E в реальном Electron пройден (все 18 проверок PASS), полный `node --test` — **1788 тестов / 1784 pass / 0 fail / 4 skipped**.
Мои изменения вошли в общий коммит **r156** (делал Lead) и **r157** (фиксы phase1-geometry); сам я ничего не коммитил. Файлы phase1-geometry (`crs-tools*.py`, `mesh-tools*.py`) и editor-basics (`clip-p3.js`, `app.js`, startup) я не изменял.

## 1. Что подключено

### 1.1 «Система координат» (`tools/scan2bim-py/crs-tools.py`, phase1-geometry)
Панель в нижней полосе P1: **«Система координат»** (`window.__lxP23.openCrs()`), реальные вызовы через main-мост:

| Действие | CLI | Что показывает/делает |
|---|---|---|
| Показать EPSG/WKT/углы | `--in CLOUD --json` | source EPSG/WKT, формат/точек, VLR, bbox, 4 угла `corners_wgs84` (E,N,lon,lat) |
| Пересчитать | `--in --epsg --to --out-las --json` | пересчёт UTM↔WGS84↔ETRS89↔локальная; результат автоматически открывается в сцене |
| Запись привязки | `--update-header --out-las --georef-file --json` | VLR EPSG+WKT в LAS и `georef.json` для `json-to-ifc.js` |
| Экспорт координат углов | `--in --json` + CSV | CSV `corner,E,N,lon,lat` + JSON в `%APPDATA%/bim-twin/p2p3-r155/crs-*` |

- Источник EPSG берётся из VLR; если VLR нет — поле «Исходная СК (EPSG)» (пробрасывается `--epsg`).
- `EPSG:` префиксы из UI срезаются, CLI получает `--to 4326|25836|32636|local`.
- Для локальной СК есть поле `--local-params E0,N0,theta_deg,scale`.
- Панель сразу показывает текущее облако/точки/габариты/8 углов bbox из вьюера (даже без Python) — и обновляется по событиям загрузки облака; в потоковом режиме (`getEditedCloud()=null`) данные берутся из `base[0]`/`_cloudRecord`.
- Если CLI нет: кнопки запуска disabled + понятное сообщение «инструмент ещё готовится» (fallback проверен тестом).
- Результат: файлы с грантом доступа, кнопка «Открыть облако в сцене», JSON/WKT в раскрывающемся блоке.

### 1.2 «Mesh-инструменты» (`tools/scan2bim-py/mesh-tools.py`, phase1-geometry)
Кнопка **«Mesh-инструменты»** (`window.__lxP23.openMesh()`), панель с операциями:

- **Заполнить отверстия** `--fill-holes [--max-hole-edges N]`
- **Сгладить (Лаплас)** `--smooth ITER --lambda L`
- **Удалить треугольники по классу/цвету** `--remove-triangles class:R,G,B[,tol] | color:R,G,B[,tol]`
- **Упростить** `--decimate quadric:N | voxel:SIZE_M`

Выбор mesh (PLY/OBJ/STL) через нативный диалог + грант; прогресс/лог в панели; по завершении — JSON `before/after` (вершины/треугольники/граничные рёбра/watertight/объём), операции и их тайминги; результат открывается в сцене через `MeshViewer.loadAsync` (overlay).
**Graceful fallback:** в этом окружении Open3D нет — панель показывает «mesh-tools.py найден, но требует Open3D», кнопка запуска disabled; прямой вызов моста возвращает `{ok:false, needOpen3D:true, error:…}` без падения UI. Как только Open3D появится в Python-движке — операции заработают без изменений кода.

### 1.3 Clipping Box (P3) — разделение зон с editor-basics
По договорённости: **UI — editor-basics** (`renderer/ui/clip-p3.js`: кнопка `#lxClipP3Btn` в `#lxClipP3Bar`, панель `#lxClipP3Panel`, 6 полей min/max + формат), **данные/вьюер/сохранение — мой слой**.

`window.__lxClipBox = { open, close, state, applyAndSave, cancel, setBox, getBox }`:
- `state()` → `{active, box:{min:{x,y,z},max:{x,y,z}, rotation:0}, points, count, format}`;
- `setBox({min,max})` — нормализует, переводит мир→доли габарита, включает секущий бокс вьюера (`setSectionBox`+`setSection(true)`) и считает точки внутри;
- `applyAndSave({format})` — фильтрует текущее облако (pos/col) по боксу, сохраняет фрагмент через `bimAPI.p23SaveFragment` (PLY бинарный с RGB / PCD ASCII / XYZ), открывает фрагмент в сцене, возвращает `{ok,path,count,bbox}`;
- `cancel()` — сброс среза; события `lx-clip-box-changed`/`lx-clip-box-saved`;
- **поворот не поддерживается в phase 1** (шейдер/фильтр axis-aligned) — поле в UI editor-basics disabled, `rotation:0`;
- сохранение — в `%APPDATA%/bim-twin/p2p3-r155/clip-*/clip-fragment.<fmt>` с грантом; LAS/RCP/Protobuf из клип-бокса не пишутся (в рендерере нет LAS-writer) — UI editor-basics честно помечает их как недоступные.

## 2. Архитектура/файлы

- **`p23-bridge.js`** (новый, main): `register(deps)`; IPC `bim:p23Status`, `p23PickMesh`, `p23CrsRun`, `p23MeshRun`, `p23SaveFragment`, `p23Cancel`; прогресс `bim:p23Progress`; Python-детект, `open3d`-детект, UTF-8 окружение, allowlist скриптов, выдача грантов на выходные файлы, запись фрагментов PLY/PCD/XYZ (лимиты 5 млн точек / 300 МБ). Чистые builders `buildCrsArgs`, `buildMeshArgs` экспортируются для тестов.
- **`renderer/ui/p23-tools.js`** (новый): панели CRS/Mesh, `window.__lxClipBox`, `window.__lxP23`; грузится динамически из `p1-tools.js` (`ensureP23`, без правок `app.js`); кнопки добавляются в существующую `#lxP1Bar`, панели — свои контейнеры. `rotation`, `data-p3="open"` (fallback-обработчик), иконки `map`/`triangle` из набора `icons.js`.
- **`main.js`** — один append-only блок `require('./p23-bridge').register(...)` в конце `registerIpc()` (рядом с p1-мостом).
- **`preload.js`** — append-only блок методов `p23*` + `onP23Progress`.
- **`test/r155-p23.test.js`** (новый, 10 тестов): регистрация/преload/загрузка слоя; контракт клип-бокса; реальные CLI-аргументы CRS и Mesh; статус реальных инструментов + graceful fallback (пустой rootDir); сохранение PLY/PCD/XYZ/ошибки; jsdom-панели CRS (СК, fallback, вызов `p23CrsRun`), Mesh (fallback, запуск с параметрами), клип-бокс (setBox/state/applyAndSave с фильтрацией и открытием фрагмента).

## 3. E2E в реальном Electron

Данные: синтетическое облако **272 500 точек**, UTM 36N (`E≈500000, N≈6180000`), LAS 1.2 fmt 3; mesh — куб с отверстием (PLY, 125 вершин/160 треугольников). Скриншоты: `D:\BIM-TWIN-TEST\r55\p2p3-r155\shots\`.

| Проверка | Результат |
|---|---|
| Статус моста | `{ok:true, python:'python3', tools:{crs:true, mesh:true}, open3d:false}` |
| CRS info | EPSG:32636, 272 500 т., bbox `499996.983…500007.1 / 6179997.985…6180004.099 / −0.016…3.5`; углы WGS84 lon `32.9999519…33.0001131`, lat `55.7656538…55.7657087`; 0.27 с; JSON + WKT в панели |
| CRS georef | `--update-header --out-las --georef-file`: VLR 2 записи; `georef-header.las` + `georef.json`; 0.82 с; результат открыт в сцене |
| CRS reproject → 25836 | 0.90 с; `reprojected.las`; `transform.target_epsg=25836`, bbox в метрах |
| CRS reproject → 4326 | 0.78 с; `transform.target_epsg=4326`, `bbox_after` `32.9999519…33.0001131° / 55.7656538…55.7657087°`; файл открыт в сцене |
| CRS reproject → local | `ok:true`, `target_epsg=0`, WKT `LOCAL_CS["USK/local"]`, bbox identity (`499996.983…6179997.985…`) |
| CRS corners | CSV `corner,E,N,lon,lat` + JSON в `%APPDATA%\bim-twin\p2p3-r155\crs-*`; 4 угла в таблице |
| Mesh-панель | панель открывается, операции/параметры на месте; кнопка запуска disabled из-за отсутствия Open3D — понятное сообщение в панели |
| Mesh bridge | прямой вызов: `{ok:false, needOpen3D:true, error:'Mesh-инструменты требуют Open3D…'}` — без падения UI |
| Clipping Box UI (editor-basics) | панель `#lxClipP3Panel` открывается, `__lxClipBox` активен; срез по половине объёма → **31 959 точек**; сохранён `clip-fragment.ply` **479 564 Б**, открыт в сцене; формат PLY |
| Ошибки консоли | **0** |
| Скриншоты | `01-crs-info.png`, `02-crs-corners.png`, `03-crs-georef.png`, `04-crs-reproject.png`, `04b-crs-reproject-4326.png`, `05-mesh-tools.png`, `06-clip-applied.png`, `07-clip-saved.png` |

Примечание: при первом прогоне E2E обнаружились баги `crs-tools.py` (overflow int32 при записи WGS84 LAS; `--to local` → `epsg_info(0)`). Баг-репорт передан phase1-geometry, оба исправлены (коммит r157, `crs-tools-test.py` 19/19 PASS); финальный E2E выше — уже на исправленной версии, пересчёт в 4326 и local проходят.

## 4. Тесты

- `node --test test/r155-p23.test.js` — **10/10 pass**.
- `node --test test/ui-system.test.js test/r149-p1-tools.test.js test/r151-p1-integration.test.js test/r155-p23.test.js` — **37/37 pass** (id панелей/иконки/редизайн не сломаны).
- Полный `node --test` — **1788 тестов / 1784 pass / 0 fail / 4 skipped** (`duration 89 с`).
- Python: `crs-tools-test.py` — **19/19 PASS** (phase1, r157, включая 5 регрессий на исправленные 4326/local/широкий диапазон); `mesh-tools-test.py` — **11/11 PASS** (phase1).

## 5. Известные ограничения

1. **Mesh-инструменты требуют Open3D**, которого нет в текущем Python-окружении: операции недоступны, панель честно сообщает; интеграция/аргументы/JSON/открытие результата готовы и протестированы на уровне моста/юнитов. В окружении phase1 `mesh-tools-test.py` — 11/11 PASS.
2. Клип-бокс: только axis-aligned (поворот — phase 2), форматы фрагмента PLY/PCD/XYZ (LAS/RCP/Protobuf — через экспорт/недоступны).
3. E2E использует синтетические данные; для реального проекта рекомендуется прогон на облаке с VLR EPSG и (для Mesh) с Open3D.
4. Найденные в первом прогоне баги `crs-tools.py` (WGS84-запись и `--to local`) **исправлены phase1-geometry** (коммит r157); в `crs-tools.py` я ничего не менял. `crs-tools.py`/`mesh-tools.py`/`CRS-MESH-r155.md` остаются зоной phase1-geometry.

## 6. Воспроизведение

```powershell
cd bim-twin
node --test test/r155-p23.test.js
node --test test/ui-system.test.js test/r149-p1-tools.test.js test/r151-p1-integration.test.js
# E2E (нужен синтетический ref-utm.las; см. _scratch/r155-make-utm.py):
node ..\_scratch\r155-p23-e2e.js
# в приложении: «Система координат» / «Mesh-инструменты» в нижней полосе,
# Clipping Box — кнопка editor-basics (#lxClipP3Btn)
```
