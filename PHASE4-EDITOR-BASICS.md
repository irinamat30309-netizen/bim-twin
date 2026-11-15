# Фаза 4 ROADMAP-IDEAL (D3) — базовый полноценный редактор BIM-модели: смотреть / удалять / экспорт / импорт

Дата: 2026-11-15. База: коммит `0c24cae` (r111), ветка `agent/ui-redesign`.
Изменения **не закоммичены** (рабочее дерево). Задача — расширить существующий
ручной редактор (`renderer/lixel-scan2bim-editor.js`, v1233 из r110) до базового
полноценного: **СМОТРЕТЬ модель, ЭКСПОРТИРОВАТЬ, УДАЛЯТЬ элементы, загружать JSON**.
Всё по-прежнему работает **в памяти приложения** — без Python, `child_process`, `fetch`
и записи на диск до явного экспорта; подтверждения — встроенный диалог `__lxKit.ask`
(нативные `window.confirm/alert` в renderer запрещены тестом `test/ui-dialogs.test.js`).

Файлы этой задачи:

| Файл | Статус |
|---|---|
| `renderer/lixel-scan2bim-editor.js` | **правка**: +1132/−72 строк (было 1281 → стало 2342), версия `1245` |
| `test/r111-bim-editor-basics.test.js` | **новый**, 23 теста (source-level + Node + jsdom) |
| `PHASE4-EDITOR-BASICS.md` | этот отчёт |

`renderer/lixel-scan2bim-ui.js`, `renderer/scan2bim.js`, `index.html` и прочие файлы
**не трогались**: редактор по-прежнему подключается динамически из панели «Скан → BIM»,
OBJ/DXF/IFC берутся из `window.Scan2BIM` (`toOBJ`/`toDXF`/`toIFC`).

## Сводка (числа)

| Проверка | До | После |
|---|---|---|
| `node --test` (bim-twin) | 1572 теста / **1568 pass** / 0 fail / 4 skipped | **1595** / **1591 pass** / **0 fail** / 4 skipped |
| Новые тесты `r111-bim-editor-basics` | — | **23 / 23 pass** (0 fail) |
| Реальный прогон в Electron (Chromium) | — | панель, режимы, удаление через диалог, импорт, экспорт OBJ/DXF/IFC — **все шаги OK** |
| Бюджет 3D-оверлея | — | **≤ 20000 сегментов** (stress: 3000 стен → ровно 20000, `truncated:true`, выбранная стена видна) |
| Заливка стен | — | треугольники с вырезом проёмов, ≤ 20000 треугольников; только если вьюер умеет меши |
| Импорт: ошибка | — | модель/история **не меняются**, понятное сообщение; успех — замена + сброс истории |

## 1. Что добавлено (по пунктам задания)

### 1.1. СМОТРЕТЬ: режимы «Контур» и «3D-объём»

Новый блок панели `data-lx-edit="view"` сразу под статистикой:

* сегментированный переключатель **«3D-объём» / «Контур»** —
  `data-act="view-mode" data-mode="volume|contour"`, активный режим имеет
  `aria-pressed="true"`; рядом кнопка **«Потолок»** (`data-act="toggle-ceiling"`) и,
  если вьюер поддерживает меши, **«Заливка»** (`data-act="toggle-fill"`);
* строка состояния режима `data-lx-edit="view-status"`: что рисуется, «сегментов N»,
  «упрощено до лимита 20000» при переполнении бюджета;
* **«Контур»** — прежнее поведение r110 (каркас всех стен, выбранная стена акцентом +
  стрелка нормали, проёмы выбранной стены, контур помещения, контур этажа);
* **«3D-объём»** — плотный каркас:
  * стены: 12 рёбер параллелепипеда + промежуточные **вертикали по граням** каждые
    ~0.9 м (до 8 рёбер на стену);
  * проёмы у **всех** стен: рамка в середине стены (4), рамки на обеих гранях (2×4) и
    **откосы** центр→грань (2×4) = **20 сегментов на проём**, у выбранной стены — акцентом;
  * пол: контур + **сетка по помещениям** (шаг 0.6 м, отсечение по чётности пересечений
    рёбер полигона, ≤ 420 сегментов на помещение); выбранное помещение — акцентом
    (контур + сетка);
  * потолок — опционально: контур + сетка по помещениям на `storey.ceilY` (шаг 1.0 м,
    ≤ 180 сегментов на помещение);
  * контур этажа (footprint) — всегда;
* **заливки/меши**: если у вьюера есть `_makeObj` (так у `webgl-viewer.js`) или флаг
  `supportsSolid`/`overlaySolid`, стены дополнительно заливаются `{gkind:'solid', pos, nor}` —
  треугольники с нормалями и **вырезом проёмов** (`wallSolidParts`: до/после проёма и
  над/под ним), сгруппированы по материалу; выбранная стена — фиолетовым акцентом.
  Если мешей нет — **только линии** (как в r110-заглушке вьюера);
* **производительность**: общий бюджет `MAX_OVERLAY_SEGMENTS = 20000` сегментов,
  заливка ≤ `MAX_SOLID_TRIS = 20000` треугольников. Выбранная стена строится первой,
  чтобы не пропасть при упрощении; при переполнении выставляется `truncated` и панель
  честно пишет «упрощено до лимита 20000».

API: `setViewMode(mode)`, `getViewMode()`, `getViewState()`, `setCeiling(on)`,
`setSolid(on)`, `buildOverlay(model, opts)` (чистая функция: `{mode:'contour'|'volume',
ceiling, solid, supportsSolid, wall, opening, room, maxSegments}` →
`{mode, objs, segments, truncated, solid, triangles}`), `overlayColors()`,
`MAX_OVERLAY_SEGMENTS`.

### 1.2. УДАЛЯТЬ: стена, помещение, все проёмы, очистка модели

Чистые функции (модель первым аргументом, работают и в Node без DOM):

| Функция | Действие | Результат |
|---|---|---|
| `deleteWall(model, index)` | удалить стену **вместе с её проёмами** | `{ok, index, openings, remaining}` |
| `deleteRoom(model, index)` | удалить помещение | `{ok, index, area, remaining}` |
| `clearOpenings(model, wallIndex)` | удалить все проёмы стены (стена остаётся) | `{ok, wall, removed}` |
| `clearModel(model)` | очистить стены/проёмы/помещения/плиты/footprint + MEP-кандидатов | `{ok, removed:{walls,openings,rooms,slabs}, remaining}` |

* после каждой операции `refreshStats` пересчитывает `wallCount/openingCount/roomCount/
  roomsArea/totalWallLength/floorArea`; `clearModel` сохраняет `ok:true`, `units`, `storey` —
  пустую модель можно сразу наполнить импортом JSON;
* перед правкой в историю кладётся снимок модели, поэтому **undo/redo покрывает все
  удаления** (в т.ч. очистку модели);
* кнопки в панели: `data-act="delete-wall"` («Удалить стену»),
  `data-act="delete-room"` («Удалить помещение N», включается после выбора строки),
  `data-act="op-clear"` («Удалить все проёмы»),
  `data-act="clear-model"` («Очистить модель»);
* **клавиша Delete** удаляет выбранный элемент: проём (если выбрана строка проёма),
  помещение (если выбрано помещение) или стену; выбор отслеживается в `st.selKind`
  (`getState().selKind`);
* **подтверждение** — встроенный диалог `__lxKit.ask({title, message, okLabel:'Удалить',
  danger:true})` (не нативный `confirm`: в Electron он блокирует окно, а тест
  `ui-dialogs.test.js` такие вызовы запрещает). Отказ → «Удаление … отменено», модель не
  меняется. «Очистить модель» — **без подтверждения** (по заданию), отменяется Ctrl+Z.

### 1.3. ЭКСПОРТ: IFC, JSON (были) + OBJ и DXF (добавлены)

* `data-act="export-obj"` («Экспорт OBJ») → `window.Scan2BIM.toOBJ(model)` +
  download `scan2bim-edited.obj` (MIME `text/plain`);
* `data-act="export-dxf"` («Экспорт DXF») → `window.Scan2BIM.toDXF(model,
  {includeCandidates:false})` + download `scan2bim-edited.dxf` (`application/dxf`,
  слои WALLS/OPENINGS/FOOTPRINT);
* существующие «Сохранить JSON» (`scan2bim-edited.json`) и «Экспорт IFC»
  (`toIFC(model, {name, includeBeams:false, includePipes:false})`) не менялись;
* API: `exportEditedObj(model)`, `exportEditedDxf(model, options)` (строки, как
  `exportEditedIfc`); на модели без `ok` — исключение «модель не построена».

### 1.4. ИМПОРТ: «Загрузить JSON»

* в панели (в т.ч. в состоянии «модель не построена») — кнопка `data-act="import-json"`
  «Загрузить JSON» и скрытый `input type="file" accept=".json,application/json"
  data-lx-edit="import-input"`; кнопка программно открывает выбор файла, `change` ловится
  делегированием на панели, файл читается `FileReader.readAsText`;
* **валидация схемы** (`parseModelJson` — чистая функция):
  * корень — объект модели, `ok !== false`, есть хотя бы один раздел из
    `walls/rooms/slabs/storey`;
  * `walls` — массив; у стены `a` и `b` — пары конечных чисел `[x,z]`, ненулевая длина;
    `thickness > 0` (иначе 0.15), `base`/`height`/`top` выводятся, `openings` — массив:
    `along ≥ 0`, `width > 0`, проём в пределах длины стены (`along+width ≤ L+0.05`),
    `sill/head` клампятся к высоте, `kind` по умолчанию `opening`;
  * `rooms` — полигон ≥ 3 конечных точек `[x,z]`, `area` пересчитывается при отсутствии;
  * `slabs` — полигон, `level` (по умолчанию пол этажа), `thickness > 0`, `type`;
  * `storey` — `floorY/ceilY` числа, `ceilY > floorY`; если этажа нет — выводится из
    стен (мин. base / макс. top), высота = ceil−floor;
  * `footprint` — если есть, полигон ≥ 3 точек; `stats` пересчитываются;
* **при ошибке** модель и история **не меняются**, возвращается `{ok:false, reason}`,
  в панели/тосте — «Импорт отклонён: <причина> — модель не изменена» (ошибки схемы,
  синтаксиса JSON, пустого файла, `ok:false`, неверных полигонов/этажа и т.д.);
* **при успехе** — модель заменяется **на месте** (ссылка `window.__lxScan2BIM.state.model`
  не ломается, синхронизируется и сама ссылка), `initialJson` = импорт («Сбросить»
  вернёт к нему), **история undo/redo очищается**; API `importJson(text|object)`,
  `parseModelJson(text)`.

### 1.5. СТАТУС после любых операций

* постоянная статус-строка `data-lx-edit="statusbar"`:
  **«Стены N · Проёмы K · Помещения M · Площадь A м² · Ctrl+Z — отменить ·
  Delete — удалить выбранное»** (счётчики считаются по модели через `modelCounts`,
  обновляются при каждой правке/удалении/импорте/очистке);
* сообщение операции — `data-lx-edit="status"` (`role="status" aria-live="polite"`):
  «Удаление стены — готово», «Импорт отклонён: …», «Модель загружена из JSON: …»,
  «Стена N: сдвиг 0.05 м по нормали» и т.п.;
* `getState()` расширен: `counts`, `viewMode`, `ceiling`, `solid`, `supportsSolid`,
  `overlaySegments`, `overlayTruncated`, `selKind`, `status`.

### 1.6. Дизайн

* панель — те же `lx-*` классы и токены `tokens.css`: `var(--accent)`/`var(--accent-soft)`/
  `var(--accent-line)`, `var(--bg-2)`, `var(--txt-2)`, `var(--txt-3)`, `var(--warn)`,
  `var(--ok)`, `var(--line)`, `var(--r-1/2)`, `var(--mono)`; фиолетовый акцент
  #b9a2ff (тёмная тема) / #6a52cb (светлая) — через токены, без литералов;
* никаких градиентов/чистого белого/синего: новые CSS-правила только на токенах,
  палитра оверлея — тёплый графит + фиолетовый акцент + янтарные проёмы + зелёное
  помещение; заливка стен — графитовые тона по материалу, выбранная — фиолетовая;
* новые элементы: сегментированный переключатель `.lx-s2be-seg`, тумблеры
  `.lx-s2be-toggle` (`aria-pressed`), статус-строка `.lx-s2be-statusbar`,
  скрытый `input[type=file]` в `.lx-s2be-import`.

## 2. API модуля (добавления к r110)

```js
// просмотр
setViewMode('volume'|'contour')   getViewMode()   getViewState()
setCeiling(on)                    setSolid(on)
buildOverlay(model, opts)         overlayColors()  MAX_OVERLAY_SEGMENTS
// удаление
deleteWall(model, index)          deleteRoom(model, index)
clearOpenings(model, wallIndex)   clearModel(model)
deleteSelected(kind?)             // UI-уровень: встроенный диалог + удаление
// импорт/экспорт
parseModelJson(text)              importJson(text|object)
exportEditedObj(model)            exportEditedDxf(model, options)
modelCounts(model)                statusBarText(model)
// служебное
getState() → { …, counts, viewMode, ceiling, solid, supportsSolid, overlaySegments, selKind }
```

Остальное API r110 (`open/close/attach/setModel/editMoveWall/editThickness/editWallEnd/
editOpeningMove/deleteOpening/addDoor/snapWall/undo/redo/reset/modelJson/saveJson/
exportEditedIfc/refreshStats/refreshOverlay`) сохранено без изменений.

## 3. Data-контракт панели (добавления)

| Атрибут | Значения |
|---|---|
| `data-act` (новое) | `view-mode`, `toggle-ceiling`, `toggle-fill`, `delete-wall`, `delete-room`, `op-clear`, `clear-model`, `import-json`, `export-obj`, `export-dxf` |
| `data-mode` | `volume` / `contour` (у кнопок режима) |
| `data-lx-edit` (новое) | `view`, `view-status`, `statusbar`, `delete-room-row`, `export`, `import`, `import-input`, `danger-actions` |
| `aria-pressed` | активный режим/тумблер; `aria-selected` — выбор стены/проёма/помещения (как раньше) |

Старые `data-*` r110 (`walls/wall-edit/openings/opening-edit/rooms/stats/actions/status/
snap-status`, `data-wall-index/data-room-index/data-opening-index`, deltas) не менялись —
r110-тесты проходят без правок.

## 4. Алгоритм 3D-объёма и бюджет

1. Каркас стены: `boxEdgesXform` (12 рёбер) + `pushWallWireVolume` (вертикали по граням:
   `floor((L−0.2)/0.9)` до 8 рёбер на стену, по 2 сегмента).
2. Проём: `pushOpeningWireVolume` — серединная рамка 4, рамки на двух гранях 2×4,
   откосы центр→грань 2×4 = 20 сегментов; у всех стен в объёме.
3. Пол/потолок: `pushPolygonContour` + `pushPolyGrid` — сканлайн по чётности пересечений
   рёбер полигона, шаг 0.6 м (пол) / 1.0 м (потолок), ≤ 420/180 сегментов на помещение,
   не более 60 линий в каждом направлении (крупные помещения не «съедают» бюджет).
4. Заливка: `wallSolidParts` режет стену на боксы вокруг проёмов; `boxSolidXform` даёт
   12 треугольников и нормали на бокс; `MATERIAL_FILL` — графитовые тона по материалу,
   `COL_SEL_FILL` — фиолетовый для выбранной; `MAX_SOLID_TRIS = 20000`.
5. Сегменты складываются в общий бюджет `MAX_OVERLAY_SEGMENTS = 20000`; выбранная стена
   строится первой; превышение → `truncated:true` + строка «упрощено до лимита 20000».
   Проверено тестом: 3000 стен → ровно 20000 сегментов, `truncated:true`, выбранная
   (последняя) стена всё равно в оверлее.

## 5. Тесты

`node --test test/r111-bim-editor-basics.test.js` — **23/23 pass**:

* **source-level (4)**: кнопки/подписи удаления и встроенный диалог (`__lxKit.ask`,
  без нативных confirm/alert), кнопки/подписи импорта (input[type=file], accept),
  экспорт OBJ/DXF (`toOBJ`/`toDXF`, имена файлов), режимы «3D-объём»/«Контур»/«Потолок»/
  «Заливка»/бюджет 20000, статус-строка счётчиков и подсказок, токены без
  градиентов/белого;
* **Node, чистые функции (11)**: `deleteWall` (со проёмами + stats), `deleteRoom`
  (площадь), `clearOpenings`, `clearModel` (модель остаётся рабочей), undo/redo после
  удалений и очистки; `parseModelJson` — валидный/минимальный JSON + 12 кейсов
  отклонения схемы с понятными причинами; `importJson` — ошибка не меняет модель и
  историю, успех заменяет на месте и сбрасывает undo/redo/initialJson; экспорт
  OBJ/DXF — строки с вершинами/гранями/слоями и ошибки без модели; `buildOverlay` —
  контур только линии, объём плотнее, сетка пола от помещений, потолок, solid только
  при поддержке вьюера (треугольники кратны 9, нормали совпадают), бюджет/упрощение;
  `setViewMode/getViewState/setCeiling/setSolid`;
* **jsdom, настоящая панель (8)**: кнопки/подписи/статус-строка; переключение
  «Контур»↔«3D-объём» меняет оверлей и число сегментов, `aria-pressed`; заливка при
  поддержке мешей и её отключение; удаление стены/помещения/проёмов кнопками с
  подтверждением (успех/отказ/статус/счётчики/undo), клавиша Delete, очистка без
  диалога; импорт: кнопка открывает input, невалидный JSON не меняет модель и панель,
  валидный — через настоящий `FileReader` из `input[type=file]`; экспорт OBJ/DXF
  кнопками не падает; состояние «нет модели» с доступным импортом.

Полный прогон приложения (не сломаны остальные тесты, включая `ui-dialogs` и r110):

```
$ cd bim-twin; node --test
ℹ tests 1595     ℹ pass 1591     ℹ fail 0     ℹ skipped 4
```

(до задачи было 1572 / 1568 pass / 0 fail / 4 skipped; +23 — новые тесты r111.)

Дополнительно — реальный прогон в Electron 31 (`node_modules/electron`, Chromium,
CDP-стенд по образцу `_scratch/ui-*.js`, после проверки удалён):

| Шаг | Результат |
|---|---|
| «Скан → BIM» → «Редактор модели» (динамический `<script>`) | панель открылась, `display:block` |
| панель с демо-моделью 4 стены / 2 проёма / 1 помещение | view-кнопок 2, delete/import/export-кнопки есть, «Заливка» есть (вьюер с мешами) |
| «3D-объём» + «Потолок» | сегментов 63 → **143**, оверлей: 4 solid + 8 line-объектов, статус «3D-объём: каркас стен + рёбра проёмов + сетка потолка · заливка стен · сегментов 143» |
| удаление стены кнопкой | диалог «Удалить стену 1 вместе с проёмами: 1?» → стен 4→3, счётчики и статус-строка обновились, undo=1 |
| импорт невалидного JSON | отказ, стен осталось 3 (модель не изменилась) |
| импорт валидного JSON | стен 4, undo=0 |
| `exportEditedObj/Dxf/Ifc` | OBJ (`# BIM-Twin`), DXF (`ENTITIES`), IFC (`IFCWALLSTANDARDCASE`) — OK |
| скриншот панели | `%TEMP%\bim-editor-r111.png` (тёмная тема, фиолетовый акцент, без синего) |

## 6. Как открыть и пользоваться

1. `cd bim-twin; npm start` (Electron).
2. Открыть облако точек → лента/тулбар **«Скан → BIM»** (`#lxScan2BimBtn`) →
   **«Построить BIM»** (или сразу загрузить JSON — см. п. 6).
3. Нажать **«Редактор модели»** (`#lxScan2BimEditorBtn`) — справа откроется панель
   `#lxS2BEditorPanel` (`fpanel fp-right lx-s2be`).
4. **Смотреть**: «Просмотр» → «3D-объём» (плотный каркас стен + рёбра проёмов + сетка
   пола; «Потолок» — добавить сетку потолка; «Заливка» — залить стены, если вьюер умеет
   меши) или «Контур». Кнопки в 3D-вьюере вращают/масштабируют сцену как обычно.
5. **Удалять**: выбрать строку стены/помещения/проёма → «Удалить …» или клавиша
   **Delete**; подтвердить во встроенном диалоге. «Удалить все проёмы» — для выбранной
   стены, «Очистить модель» — без диалога. **Ctrl+Z / Ctrl+Shift+Z** — отмена/повтор
   (покрывают удаления и очистку).
6. **Экспорт**: «Сохранить JSON» (`scan2bim-edited.json`), «Экспорт IFC»
   (`scan2bim-edited.ifc`), «Экспорт OBJ» (`scan2bim-edited.obj`), «Экспорт DXF»
   (`scan2bim-edited.dxf`).
7. **Импорт**: «Загрузить JSON» → выбрать файл модели (`walls/rooms/slabs/storey`,
   формат «Сохранить JSON»); при ошибке появится причина и модель останется прежней.
8. Из консоли: `window.__lxS2BEditor.open(model)`, `setViewMode('volume')`,
   `deleteWall(model, 0)`, `importJson(text)`, `exportEditedObj()`, `getState()`.

## 7. Ограничения

* Подтверждение удалений — **встроенный диалог** `__lxKit.ask`, а не нативный
  `window.confirm`: так требует `test/ui-dialogs.test.js` (в Electron нативный confirm
  блокирует окно); «Очистить модель» — без подтверждения по заданию (undo её отменяет).
* Заливка стен — только для вьюеров с мешами (`_makeObj`/`supportsSolid`); в остальных
  случаях режим «3D-объём» рисует только линии (это проверено тестом).
* Потолок и сетка пола строятся **по помещениям** (`rooms[].polygon`); если помещений
  нет — остаётся контур этажа (footprint). Сетка — декоративная, не CAD-геометрия.
* Импорт принимает модель с полями `walls/rooms/slabs/storey` (+ `footprint`);
  многоэтажный `storeys: []` как отдельный формат не разбирается — используется
  `storey`/`storeyIndex`, как в модели движка.
* Раскладка «3D-объём / заливка / потолок» — состояние сессии редактора, в JSON модели
  и проект не сохраняется; правки, как и раньше, живут в памяти до экспорта.
* Редактор не коммитил и другие файлы не трогал; `index.html` по-прежнему не требует
  правок (динамическая загрузка из `lixel-scan2bim-ui.js`).
