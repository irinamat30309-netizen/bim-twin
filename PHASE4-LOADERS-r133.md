# Фаза 4 — проверка загрузчиков реальных проектов со сканера (r133)

Дата: 2026-11-15. База: коммит `abccbfd` (r130). Изменения **не закоммичены**.
Задача: заказчик разрешил использовать данные сканера с диска — проверить в реальном
Electron загрузку двух найденных проектов и зафиксировать результат.

Файлы:

| Файл | Статус |
|---|---|
| `renderer/potree-loader.js` | **исправлен баг**: шаг точки берётся из `metadata.attributes` (16/17/… байт), безопасное декодирование коротких узлов |
| `test/r133-potree-stride.test.js` | **новый**, 3 теста (17-байтный XGrids-формат, legacy 16 байт, короткий буфер) |
| `PHASE4-LOADERS-r133.md` | этот отчёт |
| `_scratch/r133-loaders-e2e.js` | e2e-стенд (CDP/Electron, вне репозитория) |

## Сводка

| # | Проект | Формат | Результат |
|---|---|---|---|
| 1 | `D:\Skan\llcc\lcc2-result` | XGrids LCC2 (3DGS): `bgf.lcc2` (88 240 Б) + `data/3dgs/*.sog` (16 файлов, 96 683 805 Б) + mesh/poses | **ЗАГРУЗИЛСЯ** (PASS): 4 059 851 сплэт, 3DGS-сцена открылась, ошибок в консоли 0, скриншот |
| 2 | `D:\Skan\gg\123` | XGrids Lixel Studio: `123.lspro` + `projectTmp/baseFilter/removeNoise_…_potree/` (`octree.bin` 1 744 910 090 Б, `hierarchy.bin` 247 346 Б, `metadata.oct` 2 951 Б) | **НЕ ОТКРЫВАЕТСЯ через UI** (FAIL as-is): нет импортёра `.lspro`/`metadata.oct`; Potree 2.0-импорт ждёт `metadata.json` и `file://`-fetch, который в Electron запрещён. Формат технически Potree-2.0-совместим — проверено через HTTP после переименования, см. §2 |

Полный `node --test`: **1720 тестов / 1716 pass / 0 fail / 4 skipped** (включая 3 новых
теста на фикс загрузчика; базовый прогон до задачи — 1673/1669/0).

## 1. LCC2-проект — загрузился

Путь в UI (фактический): вкладка **«3D-тур» → группа «Сцены» → кнопка «LCC2»**
(в задании указан «Импорт», но кнопка LCC2 живёт в 3D-туре; в «Импорте» — Potree 2.0).
У кнопки скрытый `input#lcc2FolderInput` с `webkitdirectory`; в десктопе открывается
системный выбор папки, а `lcc2-loader.js` вызывает `lcc2FolderInput.change` →
`loadFromFiles` → `window.lcc2Loader.load(files)` → `_bimOpenSplat(buffer)`.

Как проверялось: собственный CDP-стенд. Системный диалог выбора папки автоматизировать
нельзя, а CDP `DOM.setFileInputFiles` не заполняет `webkitdirectory`-input (проверено:
`files.length = 0`). Поэтому байты 17 файлов проекта отданы по локальному HTTP
(`http://127.0.0.1:8765/lcc2/…`, порт разрешён CSP), в странице созданы `File`-объекты,
положены в `#lcc2FolderInput` через `DataTransfer` и отправлено `change` — дальше работал
**штатный** обработчик и загрузчик `lcc2-loader.js` (без правок).

Результат (Electron 20.18.0, на машине заказчика):

| Метрика | Значение |
|---|---|
| Файлов подано | 17 (`bgf.lcc2` + 16 `.sog`), 96 683 805 Б |
| Метаданные | XGrids Lcc2 Splats, `totalSplats` **7 862 382** (все LOD), `root.splatFiles` 16 |
| Листовые тайлы | 24 тайла в 7 паках; ожидаемое число сплэтов **4 059 851** (совпало с `info/report.json.pointCloudQuantity` 4 059 852 ±1) |
| Декодировано загрузчиком | **4 059 851** сплэт; буфер **129 915 232 Б** (32 Б/сплэт) |
| 3DGS-вьюер | `SplatViewer` открыт, canvas виден; HUD «4 059 849 сплэтов» (2 отбракованы как выбросы) |
| Время | от `change` до открытой сцены **≈2,56 с**: декод ~1,8 с + `SplatViewer.load` **0,77 с** |
| Память | JS heap `performance.memory` 342 МБ до/после (типизированные буферы учитываются слабо); файлы 92 МБ + буфер 124 МБ |
| Ошибки консоли | **0** (17 сообщений `[LCC2]` — прогресс/диагностика) |
| BBox (LCC2 native, Z-up) | min [-39.447, -32.782, -2.329], max [70.818, 16.730, 9.450]; загрузчик переводит в Y-up вьюера: y=z → [-2.33, 9.45], z=−y → [-16.73, 32.78] |
| Отчёт сканера | L2 Pro, `pointCloudQuantity` 4 059 852, build 01:52:15, `modelSize` 102 893 309 Б |

Скриншоты:
* `D:\BIM-TWIN-TEST\r55\lcc2-r133\lcc2-r133-01-tab-lcc2.png` — вкладка 3D-тур с кнопкой LCC2;
* `D:\BIM-TWIN-TEST\r55\lcc2-r133\lcc2-r133-02-loaded-3dgs.png` — **3DGS-сцена LCC2**
  (2048-ширина, реальные стены/кирпич/окно), HUD «4 059 849 сплэтов», тосты
  «LCC2: Декодировано: 4059851 сплэтов», «3DGS загружен: 4 059 849 сплэтов»;
* `lcc2-r133-03-back-to-workspace.png` — возврат в рабочую область.

Ограничения: `totalSplats` в `bgf.lcc2` (7,86 млн) — это все LOD-уровни; приложение грузит
только листовые тайлы (4,06 млн) — ожидаемо для этого загрузчика. HUD и буфер отличаются
на 2 сплэта (отбраковка выбросов в `SplatViewer`).

## 2. Lixel Studio octree — через UI не открывается (формат совместим, но нужна доработка)

Структура проекта:

```
D:\Skan\gg\123\123.lspro                  — JSON проекта XGrids Lixel Studio 4.0.1.6
D:\Skan\gg\123\Default\dataIndex.json     — ссылки на metadata.oct (устаревшие абсолютные пути)
D:\Skan\gg\123\projectTmp\baseFilter\removeNoise_20260903182121_potree\
    octree.bin      1 744 910 090 Б  (1,62 ГиБ)
    hierarchy.bin         247 346 Б
    metadata.oct            2 951 Б  (JSON, Potree-подобный, version 2.1)
D:\Skan\gg\123\cover.png                  4 972 446 Б
```

`metadata.oct`: 102 641 770 точек, bounds [0..226], `scale [1e-4]`, offset
[-113.3416, -0.0002, -100.3901], attributes: position:12, intensity:1, rgb:3,
**classification:1** → **17 байт на точку**.

### Почему UI не открывает

1. **Нет импортёра `.lspro`**: в коде приложения нет ни обработчика `.lspro`, ни чтения
   `engineerings[].path`/`Default/dataIndex.json`; в DOM нет элементов/обработчиков `.lspro`.
   `123.lspro` — обычный JSON, но приложение его нигде не распознаёт.
2. **«Импорт» → «Potree 2.0»** (`lixel-sprints-ext.js opPotree`) открывает системный выбор
   файла с фильтром `*.json` и ждёт **`metadata.json`** рядом с `hierarchy.bin`/`octree.bin`,
   а затем делает `PotreeLoader.open('file://' + папка)`. В проекте же:
   * файл называется `metadata.oct` (не `.json`) → в диалоге не выбрать;
   * нужные файлы лежат не в корне, а в `projectTmp/baseFilter/removeNoise_…_potree`;
   * `PotreeLoader.open` → `fetch(file://…)` в Electron-renderer **запрещён** (CSP/схема):
     фактическая ошибка — **`Failed to fetch`**, пользователю показывается тост
     «Potree 2.0: не удалось открыть офлайн (Failed to fetch). Нужен HTTP-доступ к
     metadata.json/hierarchy.bin/octree.bin.» (скриншот `lcc2-r133-05-potree-offline-error.png`).
3. **Пути в проекте устаревшие/абсолютные**: `123.lspro` → `D:/gg/123/Default`,
   `dataIndex.json` → `C:/Users/bob/Desktop/1787509819058_…/metadata.oct` и
   `D:/gg/123/projectTmp/…/metadata.oct`; на диске сейчас `D:\Skan\gg\123\…`
   (путей `D:\gg\123` и `C:\Users\bob\Desktop\…` нет). Даже с импортёром потребуется
   резолв относительно корня проекта/поиск `metadata.oct` рекурсивно.
4. Пункт `opPotree` после успешного `open` показывает только **сводку** (тост «N точек,
   M узлов»), потоковый 3D-рендер Potree-набора не подключается (нет `attachGL`/кадра
   в основном вьюере) — для полноценного просмотра нужен отдельный слой рендера.

### Проверка совместимости формата (что нужно для поддержки)

Чтобы отделить «формат не читается» от «UI не умеет», проверено напрямую в реальном
приложении через тот же `PotreeLoader`:

* скопированы `metadata.oct → metadata.json` и `hierarchy.bin`, `octree.bin` отдан
  локальным HTTP-сервером на `127.0.0.1:8765` (единственный внешний origin, разрешённый CSP);
* **`PotreeLoader.open('http://127.0.0.1:8765')` — успешно**: `metadata.version 2.1`,
  `nodes=11 243`, `points=102 641 770`, attributes = position:12/intensity:1/rgb:3/classification:1,
  stride = **17**;
* загружены 4 узла через HTTP Range (`octree.bin`: `Range: bytes=1744816250-1744910089` и др.);
  декодированные позиции попали **точно в диапазон** attribute position
  (decoded BBox min [-113.341, 0, -100.39], max [112.488, 58.762, 97.743] при
  meta min [-113.3415, -0.0001, -100.39], max [112.7364, 59.0059, 97.9319]).

Вывод: **формат Potree 2.0-совместим**; для открытия в приложении нужно: (а) импортёр
`.lspro`/`metadata.oct` с резолвом путей, (б) доступ к байтам не через `file://`, а через
preload-fs или локальный HTTP, (в) для 102 млн точек — LOD-обход и бюджет рендера,
(г) подключение Potree-рендера к вьюеру (сейчас `opPotree` даёт только сводку).

## 3. Найден и исправлен баг загрузчика Potree

При проверке совместимости выяснилось: `renderer/potree-loader.js` жёстко считал
**16 байт на точку** (position 12 + intensity 1 + rgb 3). В проекте XGrids/Lixel в точке
**17 байт** (добавлен `classification`), поэтому со второй точки позиции/цвета «съезжали»
(в hierarchy.bin `byteSize/numPoints = 17.000`).

Исправление (минимальное):
* `pointLayout(meta)` — шаг и смещения `position`/`intensity`/`rgb` считаются из
  `metadata.attributes` (сумма `size` в порядке массива); без `attributes` — прежние
  16 байт (обратная совместимость);
* `decodeChunk` читает по смещениям и безопасно ограничивает число точек длиной буфера
  (`min(numPoints, floor(byteLength/stride))`), иначе короткий узел читался за границей;
* `_loadNode` передаёт `attributes` в декодер.

Тесты: `test/r133-potree-stride.test.js` — **3/3 pass** (17-байтный XGrids-формат без
сдвига, legacy 16 байт, короткий буфер); старый `test/potree-loader-v1091.test.js` — тоже
зелёный. Полный `node --test` — 1720/1716 pass/0 fail/4 skipped.

До фикса: при 17-байтном наборе узлы декодировались бы с мусорными координатами
(проверено расчётом: старый код брал `i*16`; `byteSize/numPoints` реального проекта = 17).
После фикса — позиции совпадают с диапазоном метаданных (см. §2).

## 4. Как повторить

```
cd C:\Users\bob\Documents\deepseek-harness\default-workspace
# стенд: сам поднимает HTTP 127.0.0.1:8765 (LCC2-файлы + Potree-набор),
# запускает Electron, гоняет LCC2 и PotreeLoader, пишет скриншоты и RESULT JSON
node _scratch\r133-loaders-e2e.js

cd bim-twin
node --test test/r133-potree-stride.test.js   # 3/3
node --test                                    # 1720/1716 pass/0 fail
```

Стенд пишет результат и скриншоты в `D:\BIM-TWIN-TEST\r55\lcc2-r133\`;
`lcc2-r133-06-potree-http-check.png` — состояние после HTTP-проверки Potree-набора.

## 5. Итог по заданию

* **LCC2-проект загружается** (PASS): 4 059 851 сплэт, 3DGS-сцена, 0 ошибок консоли,
  ~2,6 с, скриншот. Кнопка — в «3D-тур» (не в «Импорт»).
* **Lixel Studio octree через UI не открывается** (FAIL as-is): нет `.lspro`-импортёра,
  Potree 2.0-импорт ждёт `metadata.json` и не умеет `file://`-fetch;
  тексты: `Failed to fetch` и тост «Potree 2.0: не удалось открыть офлайн (Failed to fetch).
  Нужен HTTP-доступ к metadata.json/hierarchy.bin/octree.bin.» (тост воспроизведён в UI —
  скриншот). Формат при этом совместим: после переименования в `metadata.json` и раздачи
  по HTTP загрузчик читает 11 243 узла и 4 узла декодирует корректно (после фикса stride).
  Для полной поддержки: импортёр `.lspro`/`metadata.oct`, доступ к байтам через preload-fs
  или локальный HTTP, LOD-обход для 102,6 млн точек, рендер Potree в вьюере.
* **Баг загрузчика исправлен** (16→17 байт/точка из `metadata.attributes`) + 3 теста;
  остальные загрузчики не менялись.
