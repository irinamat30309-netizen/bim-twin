# Фаза 4 ROADMAP-IDEAL — ручной редактор BIM-модели в приложении (D3)

Дата: 2026-11-15. База: коммит `8e885a0` (r109), ветка `agent/ui-redesign`.
Изменения **не закоммичены** (рабочее дерево). Отчёт покрывает пункт D3 роадмапа
(«ручная правка стены/проёма с привязкой к облаку — работает, undo/redo») в части UI:
редактор работает **в памяти приложения** — без Python, child_process, сети и записи на диск
до явного «Сохранить JSON» / «Экспорт IFC».

Файлы этой задачи:

| Файл | Статус |
|---|---|
| `renderer/lixel-scan2bim-editor.js` | **новый**, ~1280 строк |
| `renderer/lixel-scan2bim-ui.js` | минимальные правки: кнопка «Редактор модели», загрузчик, `refreshPreview` (+60/−4 строк) |
| `test/r110-scan2bim-editor.test.js` | **новый**, 20 тестов (source-level + Node + jsdom) |
| `PHASE4-EDITOR-UI.md` | этот отчёт |

`index.html` **не менялся**: редактор подключается динамически тем же origin
(`script-src 'self'` это разрешает). Если Lead предпочтёт статическое подключение —
достаточно добавить рядом с `lixel-scan2bim-ui.js` строку
`<script src="lixel-scan2bim-editor.js?v=1233"></script>`; код работает в обоих режимах
(`loadEditor()` сначала ищет `window.__lxS2BEditor`).

## Сводка (числа)

| Проверка | До | После |
|---|---|---|
| `node --test` (bim-twin) | 1552 теста / **1548 pass** / 0 fail / 4 skipped | **1572** / **1568 pass** / **0 fail** / 4 skipped |
| Новые тесты `r110-scan2bim-editor` | — | **20 / 20 pass** (0 fail) |
| Проверка в настоящем Chromium (Electron 20.18.0, `file://` + CSP приложения) | — | кнопка → динамический `<script>` → панель → правка → undo → IFC → reset: **все шаги OK** |
| Правки без Python/сети | — | в модуле нет `child_process`/`spawn`/`fetch` (проверяется тестом) |
| Глубина undo/redo | — | 30 снимков `JSON.stringify(model)` (задание: ≥ 20) |

## 1. Что реализовано (пункты задания 1–6)

### 1.1. Открытие панели

* В панели «Скан → BIM» рядом с «Построить BIM» появилась кнопка **«Редактор модели»**
  (`id="lxScan2BimEditorBtn"`, иконка `pencil-ruler`), см. `lixel-scan2bim-ui.js`.
* По клику `loadEditor()` динамически подключает `lixel-scan2bim-editor.js?v=1233`
  (очередь ожидания — повторные клики не плодят `<script>`), затем вызывается
  `window.__lxS2BEditor.open(window.__lxScan2BIM.state.model)`.
* Если модели нет — панель всё равно открывается и показывает подсказку
  «Модель ещё не построена. Откройте панель «Скан → BIM», нажмите «Построить BIM»…»
  + кнопку перехода к построению.
* После успешной реконструкции модель сразу передаётся в уже открытый редактор
  (`syncEditorModel()` → `setModel(model)`), история правок сбрасывается на новую модель.
* Закрытие панели «Скан → BIM» не закрывает редактор и не гасит его оверлей
  (`refreshPreview()` в UI + `refreshOverlay()` редактора).

### 1.2. Списки стен и помещений, подсветка в 3D

* Список стен: `Стена N — L 3.40 м · T 0.15 м · бетон` (`data-wall-index`, `aria-selected`).
* Список помещений: `Помещение N — 10.2 м²` (`data-room-index`).
* Выбор стены: в 3D-оверлее (`v._setOverlay(objs)` + `v.render()`) рисуются
  - каркас всех стен (линии 12 рёбер каждой грани, тёплый графит);
  - выбранная стена — акцентным фиолетовым (`#b9a2ff`), плюс стрелка нормали
    (показывает, куда двигают ±0.05);
  - проёмы выбранной стены — янтарным (`--warn`), выбранный проём — тоже;
  - выбранное помещение — зелёным контуром на полу и потолке (`--ok`);
  - контур этажа — приглушённым янтарным.
* Смена выбора/правка сразу перерисовывает оверлей.

### 1.3. Правка выбранной стены (data-act)

| Кнопка | data-атрибуты | Шаг |
|---|---|---|
| Сдвиг по нормали | `data-act="wall-move" data-delta="±0.05"` | ±0,05 м, n = (−dz, dx) |
| Толщина | `data-act="wall-thick" data-delta="±0.01"` | ±0,01 м, кламп 0.05…0.60 м |
| Торцы (a −/a +/b −/b +) | `data-act="wall-end" data-side="a|b" data-delta="±0.1"` | ±0,10 м |
| «Привязать к облаку» | `data-act="snap"` | см. §3 |

Дополнительно: удлинение начала стены (`side=a`) пересчитывает `along` проёмов
(`along += delta`), чтобы проём не «уезжал» в мире; укорачивание, выталкивающее проём,
отклоняется без изменения модели. Минимальная длина стены 0.30 м.

### 1.4. Проёмы

* Список проёмов выбранной стены: `along`, ширина × высота, тип (дверь/окно/проход),
  кнопка удаления (`data-act="op-del"`, `data-opening-index`) — удаляется именно та строка,
  у которой нажата корзина (а не просто выбранная).
* Для выбранного проёма: along / ширина / подоконник / верх — кнопки ±0,05 м
  (`data-act="op-move" data-prop="along|width|sill|head"`), значения выведены в `<output>`.
* «Добавить дверь 0.9×2.1» (`data-act="op-add-door"`) — вставляет дверь 0.90 × 2.10 м
  (sill=0) в ближайший к середине свободный интервал стены; если места нет — отказ с причиной.
* Зажимы: along ∈ [0, L−width], width ∈ [0.20, L−along], sill ∈ [0, head−0.30],
  head ∈ [sill+0.30, H стены] — проём не выходит за стену.

### 1.5. Undo / redo / «Сбросить»

* Перед каждой правкой в стек кладётся снимок `JSON.stringify(model)`, глубина **30**
  (задание: ≥ 20); новая правка обнуляет redo.
* `undo()` / `redo()` восстанавливают снимок **в тот же объект модели** (in-place assign),
  поэтому ссылка `window.__lxScan2BIM.state.model` не ломается, а экспорт в других местах
  приложения (smart-save, лента) видит отредактированную модель.
* Кнопки в шапке панели (`data-act="undo"`/`"redo"`) с disabled-состоянием, горячие клавиши:
  **Ctrl+Z**, **Ctrl+Shift+Z** / **Ctrl+Y**.
* «Сбросить» (`data-act="reset"`) возвращает модель, с которой редактор был открыт
  (исходный JSON-снимок); сам сброс тоже отменяем через undo.

### 1.6. Сохранение и IFC

* **«Сохранить JSON»** (`data-act="save-json"`) — `scan2bim-edited.json` (Blob + download,
  как `exportModel` в UI).
* **«Экспорт IFC»** (`data-act="export-ifc"`) — `window.Scan2BIM.toIFC(model, {name,
  includeBeams:false, includePipes:false})` + download `scan2bim-edited.ifc`.
  Экспортируется именно текущая модель редактора.
* После каждой правки пересчитываются `stats`: `wallCount`, `openingCount`, `roomCount`,
  `roomsArea`, `totalWallLength`, `floorArea` (если не задана) — и обновляется панель.

## 2. API модуля и data-контракт

`window.__lxS2BEditor` (и `module.exports` для `node --test`):

```js
{
  version: '1233', historyLimit: 30,
  open(model)  close()  isOpen()  attach(model)  setModel(model)  getModel()  getState(),
  // правки (чистые функции: model первым аргументом; при вложенной модели сами пишут историю)
  editMoveWall(model, index, delta)              // → {ok, shift}
  editThickness(model, index, delta)             // → {ok, thickness}
  editWallEnd(model, index, 'a'|'b', delta)      // → {ok, length, side, delta}
  editOpeningMove(model, wall, opening, prop, delta) // prop: along|width|sill|head
  deleteOpening(model, wall, opening)
  addDoor(model, wall)                           // → {ok, opening, along, width, head}
  snapWall(model, index, cloud)                  // → {ok, shift, thickness, points, bands:{lo,hi}}
  undo()  redo()  reset()  canUndo()  canRedo()
  modelJson(model)  saveJson(model)  exportEditedIfc(model, meta) // meta мержится с {includeBeams:false,...}
  refreshStats(model)  refreshOverlay()
}
```

`snapWall` принимает `Float32Array` c чередующимися xyz (`v.base[0].pos`), массив
`[x,y,z]`-троек или объект `{pos}`; большие облака прореживаются по шагу до ~500 тыс. точек.

Стабильный data-контракт панели (по нему проверяет тест):

| Атрибут | Значения |
|---|---|
| `data-lx-edit` | `panel`, `body`, `walls`, `wall-edit`, `openings`, `opening-edit`, `rooms`, `stats`, `actions`, `status`, `snap-status` |
| `data-act` | `undo`, `redo`, `wall-move`, `wall-thick`, `wall-end`, `snap`, `op-move`, `op-del`, `op-add-door`, `reset`, `save-json`, `export-ifc`, `open-build` |
| выбор элемента | `data-wall-index`, `data-room-index`, `data-opening-index` (выбор строки и кнопки удаления) |
| шаг правки | `data-delta="±0.05" / "±0.01" / "±0.1"`, `data-side="a|b"`, `data-prop="along|width|sill|head"` |

## 3. «Привязать к облаку» — алгоритм и пороги

Для выбранной стены, по точкам `v.base[0].pos` (локальный кадр вьюера, Y вверх, план X–Z):

1. Отбор: `|t| ≤ 0.40` м от оси (t — расстояние по нормали `n=(−dz,dx)`),
   `s ∈ [0.1, L−0.1]` вдоль оси, `y` — в пределах `base+0.15 … base+H−0.15`
   (отсекает пол/потолок и точки за торцами).
2. Две моды (k-means по 1D-значениям t, 12 итераций) → медианы `m_lo`, `m_hi` —
   это две грани стены («как в движке»: грани по обе стороны оси, устойчивые медианы).
3. Новая ось: `shift = (m_lo+m_hi)/2`, новая толщина `t_new = m_hi − m_lo`.
4. Принятие: `t_new ∈ (0.03, 0.70)` м и каждая мода ≥ 24 точек; иначе отказ с причиной.
5. **Смещение применяется только если `|shift| ≤ 0.25` м** — иначе отказ
   (модель остаётся нетронутой); толщина клампится в 0.05…0.60 м.
6. При успехе `a`/`b` сдвигаются на `shift·n`, толщина обновляется, в панели —
   сообщение «Привязано: сдвиг …, толщина …, точек … (грани …/…)».

Проверено тестом на синтетическом облаке: ось 1.0 м + грани 1.0/1.2 → сдвиг +0.10 м,
толщина 0.20 м; грани 1.25/1.35 → отказ «смещение 0.30 м > 0.25 м», координаты не меняются.

## 4. Тесты

`node --test test/r110-scan2bim-editor.test.js` — **20/20 pass**:

* source-level: кнопка рядом с «Построить BIM»; динамическая загрузка без правки
  `index.html`; `E.open(state.model)`; наличие всех data-атрибутов панели; оверлей —
  wire-линии через `_setOverlay`; палитра на токенах без синего/белого/градиентов;
  отсутствие `child_process`/`spawn`/`fetch`.
* Node (чистые функции): сдвиг по нормали `n=(−dz,dx)`; толщина ±0.01 и клампы;
  торцы ±0.1 и пересчёт `along`; проёмы along/width/sill/head и зажимы; addDoor 0.9×2.1
  и deleteOpening + пересчёт stats; `snapWall` по двум модам (массив троек и `Float32Array`)
  и отказ при смещении > 0.25 м; undo/redo на 25 правках (≥ 20 снимков) и reset к исходной;
  `exportEditedIfc()` передаёт именно отредактированную модель.
* jsdom: настоящий модуль в окне — панель `#lxS2BEditorPanel` создаётся, стены/помещения/
  проёмы/кнопки имеют нужные data-атрибуты, `_setOverlay` получает wire-линии, клик +0.05
  двигает стену и кладёт правку в историю, snap по `viewer.base[0].pos` работает,
  кнопка undo отменяет, корзина удаляет именно ту строку проёма, «нет модели» показывает
  подсказку; интеграция настоящего `lixel-scan2bim-ui.js` + динамический `<script>` +
  `setModel()` + закрытие панели «Скан → BIM» не закрывает редактор.
* IFC: `toIFC` на модели с изменённой стеной содержит новые координаты
  (`IFCCARTESIANPOINT((2.,0.05,0.))` вместо `(2.,0.,0.))`) и остаётся валидным STEP
  (`IFCWALLSTANDARDCASE`, `END-ISO-10303-21;`).

Полный прогон приложения (не сломаны остальные тесты):

```
$ cd bim-twin; node --test
ℹ tests 1572     ℹ pass 1568     ℹ fail 0     ℹ skipped 4
```

(до задачи было 1552 / 1548 pass / 0 fail / 4 skipped; +20 — новые тесты r110.)

Дополнительно — проверка в настоящем Chromium (Electron 20.18.0) на `file://`-странице
с CSP приложения (скретч-стенд, после проверки удалён): кнопка «Редактор модели» есть;
клик динамически подключает скрипт (CSP `script-src 'self'` не мешает); панель строится;
`setModel` показывает стену и помещение; `+0.05` двигает стену; undo глубина 1;
`ifcNewCoords=true`; закрытие «Скан → BIM» не закрывает редактор; «Сбросить» вернуло Z=0.

## 5. Как открыть панель

1. Запустить приложение: `cd bim-twin; npm start` (Electron).
2. Открыть облако точек и нажать на ленте/тулбаре **«Скан → BIM»** (`#lxScan2BimBtn`).
3. В панели «Скан → BIM» нажать **«Построить BIM»** (или пропустить — редактор покажет
   подсказку, если модели нет).
4. Нажать **«Редактор модели»** (`#lxScan2BimEditorBtn`) — справа откроется плавающая
   панель `#lxS2BEditorPanel` (класс `fpanel fp-right lx-s2be`, стиль `lx-panel`).
5. Выбрать стену/помещение в списке, править кнопками; Ctrl+Z / Ctrl+Shift+Z —
   отмена/повтор; «Сохранить JSON» / «Экспорт IFC» — файлы на диск.
6. Из консоли: `window.__lxScan2BIM.editor()` или
   `window.__lxS2BEditor.open(window.__lxScan2BIM.state.model)`.

## 6. Ограничения

* Правки живут в памяти и в `window.__lxScan2BIM.state.model`: «Сохранить JSON»/«Экспорт
  IFC» — явные точки сохранения; отдельного «сохранить в проект» в этой зоне нет
  (умная сохранность проекта читает тот же `state.model`, т.е. правки в неё попадают).
* Многоэтажные модели: список/правки работают по всем стенам (`storeyIndex`), подсветка
  помещения рисуется на уровне первого этажа (`model.storey`).
* Привязка проёма к облаку (`snap_opening`) в UI не выведена — в задании UI-зоны её не было;
  в ядре редактора (`tools/scan2bim-py/edit-model.py`, зона phase4-edit-core) она есть.
* Python-движок редактора (`edit-model.py`) автономен; UI↔CLI-моста нет по постановке
  (правки в памяти приложения, без Python).

## 7. Приложение: как повторить проверку

```
cd bim-twin
node --test test/r110-scan2bim-editor.test.js     # 20/20
node --test                                        # 1572 / 1568 pass / 0 fail / 4 skipped
node --check renderer/lixel-scan2bim-editor.js
```

Не коммичено (рабочее дерево): `renderer/lixel-scan2bim-editor.js` (новый),
`renderer/lixel-scan2bim-ui.js` (минимальные правки), `test/r110-scan2bim-editor.test.js` (новый),
`PHASE4-EDITOR-UI.md` (этот отчёт).
