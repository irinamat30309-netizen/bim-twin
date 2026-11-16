# P2P3-INTEGRATION-r155 — CRS/координаты, Mesh-инструменты, Clipping Box

Статус: **интеграция выполнена**, E2E-приёмка r159 в реальном Electron — **35/35 проверок PASS**, полный `node --test` — **1794 теста / 1790 pass / 0 fail / 4 skipped**.
Мои изменения вошли в общий коммит **r156** (делал Lead) и **r157** (фиксы phase1-geometry); в r159 доделаны Mesh-операции (поиск Python с Open3D, результат в сцену), программный выбор mesh/гранты, прогресс и исправление stale `--epsg`. В r159 ничего не коммитил. Файлы phase1-geometry (`crs-tools*.py`, `mesh-tools*.py`) и editor-basics (`clip-p3.js`, `app.js`, startup) я не изменял.

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

Выбор mesh (PLY/OBJ/STL) через нативный диалог (или программно `__lxP23.setMeshFile` для скриптов/E2E, с грантом `p23GrantMesh`); во время операции — таймер прогресса, лог и «Отмена»; по завершении — JSON `before/after` (вершины/треугольники/граничные рёбра/watertight/объём), операции и их тайминги; результат **открывается в сцене** через `MeshViewer` (overlay, чтение выходного файла по гранту `lcc2ReadFile`).
**Open3D:** мост сам ищет Python-движок с Open3D (`findOpen3dPython`: кандидаты из настроек/`%LOCALAPPDATA%\Programs\Python\Python311|312|313`, затем системные) и запускает `mesh-tools.py` именно им; обычный Python используется для CRS. В этом окружении Open3D 0.20.0 установлен в Python 3.11.9 — все 4 операции реально работают. Если Open3D нет — панель показывает «требует Open3D», кнопка disabled, мост отвечает `{ok:false, needOpen3D:true, error:…}` без падения UI (fallback сохранён и покрыт тестом).

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

- **`p23-bridge.js`** (main): `register(deps)`; IPC `bim:p23Status`, `p23PickMesh`, `p23GrantMesh`, `p23CrsRun`, `p23MeshRun`, `p23SaveFragment`, `p23Cancel`; прогресс `bim:p23Progress`; Python-детект и отдельный поиск Python с Open3D (`findPython`/`findOpen3dPython`, экспортированы для тестов), UTF-8 окружение, allowlist скриптов, выдача грантов на выходные файлы, запись фрагментов PLY/PCD/XYZ (лимиты 5 млн точек / 300 МБ). Чистые builders `buildCrsArgs`, `buildMeshArgs` экспортируются для тестов.
- **`renderer/ui/p23-tools.js`**: панели CRS/Mesh, `window.__lxClipBox`, `window.__lxP23`; грузится динамически из `p1-tools.js` (`ensureP23`, без правок `app.js`); кнопки добавляются в существующую `#lxP1Bar`, панели — свои контейнеры. `data-p3="open"` (fallback-обработчик), иконки `map`/`triangle` из набора `icons.js`; `setMeshFile` + таймер прогресса + чтение mesh-результата по гранту (`lcc2ReadFile`), исходная СК в форме обновляется после пересчёта (иначе следующий `--to` получал устаревший `--epsg`).
- **`main.js`** — один append-only блок `require('./p23-bridge').register(...)` в конце `registerIpc()` (рядом с p1-мостом); **`preload.js`** — append-only блок методов `p23*` + `onP23Progress` + `p23GrantMesh`.
- **`test/r155-p23.test.js`** (10 тестов): регистрация/преload/загрузка слоя; контракт клип-бокса; реальные CLI-аргументы CRS и Mesh; статус инструментов + graceful fallback (пустой rootDir); сохранение PLY/PCD/XYZ/ошибки; jsdom-панели CRS/Mesh; клип-бокс (setBox/state/applyAndSave).
- **`test/r159-p23-e2e.test.js`** (6 тестов): поиск Python с Open3D, `status.open3d`, mesh без ложного `needOpen3D` при найденном Open3D; fallback без Open3D; контракт clip-p3.js (PLY/PCD/XYZ, .xcord CSV/XML, download); jsdom — Open3D включает кнопку Mesh, программный выбор файла, таймер прогресса; без Open3D — disabled + сообщение.

## 3. E2E-приёмка (r159): функция → результат → ошибка → исправлено

Стенд: реальный Electron 20/CDP, облако **272 500 точек** UTM 36N (`E≈500000, N≈6180000`, LAS 1.2 fmt 3); mesh — PLY-куб с дырой (125 вершин/160 треугольников) и цветной вариант для удаления; Open3D **0.20.0** в Python **3.11.9** (найден мостом автоматически). Скриншоты: `D:\BIM-TWIN-TEST\r55\p23-r159\shots\`; машинный результат: `D:\BIM-TWIN-TEST\r55\p23-r159\e2e-result.json`. Итог: **35/35 проверок PASS, ошибок консоли 0**.

| Функция | Результат | Ошибка (найдено в r159) | Исправлено |
|---|---|---|---|
| Панель «Система координат» | статус: `crs-tools.py: есть · mesh-tools.py: есть · Open3D: есть · Python: …Python311\python.exe`; панель открывается (`01-crs-panel.png`) | — | — |
| CRS info: EPSG/WKT | `EPSG:32636`, 272 500 т., bbox `499996.983…500007.1 / 6179997.985…6180004.099 / −0.016…3.5`, WKT в раскрывающемся блоке, 0.23 с (`02-crs-info.png`) | — | — |
| CRS углы WGS84 | 4 угла: lon `32.99995191…33.00011315`, lat `55.76565376…55.76570870`; CSV/JSON в `%APPDATA%\bim-twin\p2p3-r155\crs-*` | — | — |
| Запись привязки в LAS | `--update-header --out-las`: VLR 2 записи, `georef-header.las`, результат открыт в сцене (`03-crs-georef.png`) | без явного `--out-las` путь был непредсказуем `<in>-crs.las` | мост передаёт детерминированный `--out-las` и возвращает его в UI |
| VLR после привязки | повторный info по открытому `georef-header.las` показывает `VLR: WKT` (`04-crs-vlr.png`) | — | — |
| Пересчёт UTM→WGS84 | `target_epsg=4326`, bbox `32.9999519…33.0001131° / 55.7656538…55.7657087°`, файл открыт (`05-crs-utm-wgs84.png`) | — | — |
| Пересчёт WGS84→UTM (обратно) | `target_epsg=32636`, bbox в метрах `499996.98…500007.10 / 6179997.99…6180004.10`, файл открыт (`06-crs-wgs84-utm.png`) | после пересчёта поле «Исходная СК» оставалось со старым EPSG → следующий `--to` мог получить неверный `--epsg` | обновление поля до `transform.target_epsg`; `runCrs` всегда пересобирает актуальное облако/путь |
| `--to local` + `--local-params` | `target_epsg=0`, WKT `LOCAL_CS["USK/local"]`, bbox identity, файл открыт (`07-crs-local.png`) | — | — |
| `--georef-file` для IFC | `json-to-ifc.js --georef-file` → IFC 8 151 Б: `IFCPROJECTEDCRS` + `IFCMAPCONVERSION(...,0.0,0.0,0.0,1.0,0.0,1.0)` (crs WKT EPSG:32636) | — | — |
| Mesh fill-holes (PLY с дырой) | 160 → 240 треугольников, `holes_filled:5`, watertight=true, **открыт в сцене** (`MeshViewer.isOpen()=true`, `09-mesh-fill-holes.png`) | mesh-операции всегда `needOpen3D`: мост искал Open3D только у основного Python (3.14), а он установлен в Python 3.11 | `findOpen3dPython()` — отдельный поиск Python с Open3D; `runTool` получает этого Python; статус `open3d:true` |
| Mesh smooth (Лаплас) | 2 итерации, λ=0.2, `moved_vertices:130`, max_move 0.141 м, результат в сцене (`10-mesh-smooth.png`) | результат mesh не открывался: тост «Mesh: не удалось прочитать результат» | `bim:readFile` ограничен uploads-каталогом; теперь чтение по гранту `lcc2ReadFile` + универсальный `toMeshBuffer`; проверено сценой для всех 4 операций |
| Mesh remove (по цвету) | удалено 32/160 треугольников по `color:255,0,0,30`, осталось 128; результат в сцене (`11-mesh-remove.png`) | — | — |
| Mesh decimate | 240 → 120 треугольников (`quadric:120`), результат в сцене (`12-mesh-decimate.png`) | — | — |
| Clipping Box: применить | active=true, бокс = половина объёма, внутри **31 945 точек** (`13-clip-applied.png`) | — | — |
| Сохранить фрагмент PLY | `clip-fragment.ply` **479 354 Б**, 31 945 вершин, открыт в сцене (`14-clip-ply.png`) | — | — |
| Сохранить фрагмент PCD | `clip-fragment.pcd` **148 654 Б** (ASCII, `# .PCD v0.7`) (`15-clip-pcd.png`) | — | — |
| Сохранить фрагмент XYZ | `clip-fragment.xyz` **31 870 Б** (`16-clip-xyz.png`) | — | — |
| `.xcord` CSV/XML | CSV **392 Б**, XML **673 Б**, по 8 углов + min/max (`17-clip-xcord.png`, download) | E2E-проверка сначала не распознавала валидный CSV (эвристика), файлы были корректны | проверка усилена: 8 строк `0..7,` для CSV / 8 `<corner>` и `<min>/<max>` для XML (файлы те же) |
| Прогресс/ошибки mesh | таймер «Выполняется … N с» + лог/«Отмена»; при отсутствии Open3D — disabled-кнопка и текст | долгие операции не показывали прогресс | таймер прогресса в панелях CRS/Mesh, очищается на успех/ошибку (jsdom-тест) |
| Ошибки консоли | **0** | — | — |

Базовый прогон r155 (18 проверок, скриншоты `p2p3-r155/shots`) закрыл CRS/Clipping; Mesh тогда был graceful fallback (Open3D не было). В r159 Open3D установлен в изолированный Python 3.11, мост научился его находить — Mesh-операции выполнены реально и приняты.

## 4. Тесты

- `node --test test/r155-p23.test.js` — **10/10 pass**; `node --test test/r159-p23-e2e.test.js` — **6/6 pass**.
- `node --test test/ui-system.test.js test/r149-p1-tools.test.js test/r151-p1-integration.test.js test/r155-p23.test.js test/r159-p23-e2e.test.js` — **43/43 pass** (id панелей/иконки/редизайн не сломаны).
- Полный `node --test` — **1794 теста / 1790 pass / 0 fail / 4 skipped** (`duration 84 с`).
- Python: `crs-tools-test.py` — **19/19 PASS** (phase1, r157, включая регрессии на 4326/local); `mesh-tools-test.py` — **11/11 PASS** (phase1, Open3D 0.20/Python 3.11).

## 5. Известные ограничения

1. **Mesh-инструменты требуют Open3D.** В приёмке r159 Open3D 0.20.0 установлен в отдельный Python 3.11.9, мост автоматически находит такой интерпретатор (`findOpen3dPython`) и запускает `mesh-tools.py` им, не меняя основной Python для CRS. На системе без Open3D панель честно сообщает и блокирует запуск (`needOpen3D`), без падения UI; для работы mesh на другой машине нужен Python-движок с Open3D.
2. Клип-бокс: только axis-aligned (поворот — phase 2), форматы фрагмента PLY/PCD/XYZ (LAS/RCP/Protobuf — через экспорт/недоступны).
3. E2E использует синтетические данные; для реального проекта рекомендуется прогон на облаке с VLR EPSG и реальном mesh.
4. Найденные в первом прогоне баги `crs-tools.py` (WGS84-запись и `--to local`) **исправлены phase1-geometry** (коммит r157); в `crs-tools.py` я ничего не менял. `crs-tools.py`/`mesh-tools.py`/`CRS-MESH-r155.md` остаются зоной phase1-geometry.

## 6. Воспроизведение

```powershell
cd bim-twin
node --test test/r155-p23.test.js test/r159-p23-e2e.test.js
node --test test/ui-system.test.js test/r149-p1-tools.test.js test/r151-p1-integration.test.js
# Mesh: нужен Python с Open3D (в r159 — C:\Users\bob\AppData\Local\Programs\Python\Python311\python.exe,
# Open3D 0.20.0); мост находит его сам через findOpen3dPython.
# E2E-приёмка r159 (синтетический ref-utm.las + PLY-куб с дырой):
node ..\_scratch\r159-e2e.js
# результат: D:\BIM-TWIN-TEST\r55\p23-r159\e2e-result.json, скриншоты ...\p23-r159\shots\
# в приложении: «Система координат» / «Mesh-инструменты» в нижней полосе,
# Clipping Box — кнопка editor-basics (#lxClipP3Btn)
```
