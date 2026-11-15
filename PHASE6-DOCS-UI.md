# Блок 3 ROADMAP-DOCS-AI — панель «Документация» в приложении

Дата: 2026-11-15. База: коммит `f3e92a2` (r118), ветка `agent/ui-redesign`.
Изменения **не закоммичены** (рабочее дерево). Задача — панель «Документация» перед/после
построения BIM: загрузка отчёта сравнения `compare.json` (готовит `docs-compare.py`),
таблица «проект ↔ модель ↔ облако», скор соответствия 0–100, рекомендации и понятная
инструкция, как получить отчёт без терминала.

Файлы этой задачи:

| Файл | Статус |
|---|---|
| `renderer/lixel-scan2bim-docs.js` | **новый**, ~1290 строк: панель `#lxS2BDocsPanel`, парсер/валидатор, модалка-инструкция, API |
| `renderer/lixel-scan2bim-ui.js` | минимальные правки: кнопка «Документация» + динамическая загрузка модуля (+41/−2) |
| `test/r119-docs-panel.test.js` | **новый**, 19 тестов (source-level + Node + jsdom) |
| `PHASE6-DOCS-UI.md` | этот отчёт |

`index.html`, `renderer/scan2bim.js`, инструменты Python и прочие файлы **не менялись**:
модуль подключается динамически из панели «Скан → BIM» (как редактор и панель качества),
`compare.json` — результат `tools/scan2bim-py/docs-compare.py` (Блок 2, phase5-regression).

## Сводка (числа)

| Проверка | До | После |
|---|---|---|
| `node --test` (bim-twin) | 1616 тестов / **1612 pass** / 0 fail / 4 skipped | **1635** / **1631 pass** / **0 fail** / 4 skipped |
| Новые тесты `r119-docs-panel` | — | **19 / 19 pass** (0 fail) |
| Реальный прогон Electron (Chromium) | — | кнопка → модуль → панель → отчёт 87/100 (7 строк, 3 рекомендации) → модалка-инструкция: **все шаги OK, 0 JS-исключений** |
| Схемы `compare.json` | — | поддержаны **обе**: реальная `docs-compare.py` (`schema_version=1`, `inputs/rows/score/grade/coverage_pct/summary/recommendations/limitations/unverified`) и упрощённая из постановки (`docs/model/rows[{name, project, model, cloud, delta_mm, delta_pct, status}]/score/recommendations`) |
| Валидация импорта | — | 16+ кейсов невалидного JSON отклоняются с понятной причиной; уже загруженный отчёт и модель при этом **не меняются** |
| Палитра | — | только токены `tokens.css`: violet `#a78bfa` / `#6a52cb`, graphite `#1c1b1a` / `#232221`; без синего, чистого белого и градиентов |

## 1. Что добавлено

### 1.1. Кнопка «Документация» в панели «Скан → BIM»

* В `renderer/lixel-scan2bim-ui.js` рядом с «Построить BIM» / «Редактор модели» /
  «Качество модели» появилась кнопка **«Документация»** (`id="lxScan2BimDocsBtn"`,
  иконка `file-text`, подсказка «Загрузить отчёт сравнения документации с моделью
  и облаком: скор, таблица, рекомендации»).
* По клику `loadDocs()` динамически подключает `lixel-scan2bim-docs.js?v=119`
  (очередь ожидания — повторные клики не плодят `<script>`), затем вызывает
  `window.__lxS2BDocs.open(window.__lxScan2BIM.state.model)`; после успешного
  «Построить BIM» модель синхронизируется через `syncDocsModel()` (сводка модели
  в панели обновляется без перезагрузки).
* `window.__lxScan2BIM` расширен пунктом `docs`; закрытие «Скан → BIM» панель
  документации не закрывает.

### 1.2. Загрузка отчёта сравнения (input[type=file] + валидация)

* Кнопка **«Загрузить отчёт сравнения»** (`data-act="load-report"`) открывает скрытый
  `input type="file" accept=".json,application/json"` (`data-d-import-input`); файл
  читается `FileReader.readAsText` и разбирается чистой функцией
  `parseCompareJson(text)`.
* **Валидация схемы** (обе версии формата, см. §2):
  * корень — объект; обязателен массив `rows`; каждая строка — объект с `label`/`name`
    (стабильные `id` сохраняются, иначе `row-N`);
  * `docs`/`inputs` — объект с `object`/`address`/`pages` (или `path/primary_pdf`);
  * `model` — объект (путь, стены, помещения, высота; поддержан `model.stats`);
  * `cloud` — объект (путь, `measured`, высота, видимая площадь пола);
  * `score` — число 0–100 (или `{value}`); `coverage_pct` — число; `grade` — A–E;
  * `recommendations` — массив строк или `{severity, code, text}`;
  * `limitations` — массив строк; `unverified` — массив `{id, label, reason}`;
    `schema_version` — число;
  * значения ячеек `project/model/cloud` — число, строка или `{value, unit, source, page}`.
* **При ошибке** (`битый JSON`, нет `rows`, строка без названия, score не число,
  recommendations не массив и т.п.) — панель показывает «Импорт отклонён: <причина>»
  и тост, а прежний отчёт, скор и таблица **остаются на месте** (проверено тестом).
* **При успехе** — отчёт нормализуется (статусы PASS/WARN/FAIL/UNVERIFIED,
  Δ в мм/%, рекомендации, ограничения), сохраняется исходный JSON для «Сохранить отчёт».

### 1.3. Отображение

* **Заголовок**: объект и адрес из документации (`docs.object` / `docs.address`),
  файл отчёта, дата генерации, число страниц PDF.
* **Скор соответствия 0–100** с цветом статуса (ok ≥ 85, warn ≥ 55, иначе err),
  оценка **A–E**, счётчики `PASS / WARN / FAIL / —`, покрытие проверок
  (`coverage_pct`, «сверено 66 % проверок»); рядом — **сводка модели приложения**
  (`window.__lxScan2BIM.state.model` / редактора): стены, помещения, площадь, высота.
* **Таблица «Проект ↔ модель ↔ облако»** (`data-d-table`): строка на проверку —
  параметр (+Δ модель−проект в мм и %), значение проекта, модели, облака (нет данных — «—»),
  бейдж статуса **PASS** / **WARN** / **FAIL** / **—**.
* **Рекомендации** (`data-d-recs`): список с severity (fail/warn/info) и кодом (A1, A3…);
  если рекомендаций нет — «Расхождений вне допуска нет».
* **Ограничения отчёта** (`limitations`) и **«Не проверено»** (`unverified` с причинами).
* **Кнопки**: «Обновить» (перечитать файл), «Сохранить отчёт» (JSON download
  `docs-compare-report.json`), «Загрузить другой отчёт», «Как получить отчёт».
* Строка статуса (`role="status"`, `aria-live`) — «Загружено: compare.json · скор 87/100 ·
  строк 7», «Отчёт сохранён: …», «Импорт отклонён: …».

### 1.4. Пустое состояние (пользователь без терминала)

* Пояснение и **порядок из трёх шагов** (`data-d-step="1|2|3"`):
  **1. Загрузите документацию** (PDF/ZIP → `docs-extract.py` → `docs.json`),
  **2. Сравните с моделью** (`docs-compare.py` → `compare.json` со скором и
  рекомендациями), **3. Исправьте** (редактор модели → повторное сравнение).
* Напоминание, что **облако и модель уже в приложении**:
  модель — `window.__lxScan2BIM.state.model`; сравнение выполняет `docs-compare.py`.
* Сводка загруженной модели рядом со скором (или «модель в приложении не построена —
  отчёт можно смотреть и без неё»).
* Кнопки «Загрузить отчёт сравнения» и «Как получить отчёт» доступны и без модели.

### 1.5. «Как получить отчёт» — модалка с готовыми командами

* Кнопка `data-act="show-help"` (в панели, в шапке и в пустом состоянии) открывает
  модалку в стиле `lx` (`modal lx-s2bd-help`, `data-d-modal="help"`; Esc, крестик,
  клик по фону — закрыть).
* Внутри: 3 шага, две готовые команды PowerShell с кнопками **«Копировать»**:
  * извлечение: `& "<python>" "<tools>\docs-extract.py" --input "<docs>" --out "<docs.json>"`;
  * сравнение: `& "<python>" "<tools>\docs-compare.py" --docs "<docs.json>" --model "<model.json>" --cloud "<cloud.bin>" --out "<compare.json>"`;
  * реальный путь Python из DSH:
    `C:\Users\bob\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`;
  * `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1` в начале команд (кириллица в PDF/JSON);
  * пояснения: `--strict` даёт код 1 при низком скоре (для CI), файл `compare.json`
    появляется в папке `--out` и его нужно загрузить в панель.
* «Копировать команду» — `navigator.clipboard.writeText` с fallback на
  `textarea + document.execCommand('copy')`; в модалке показывается «Команда скопирована
  в буфер обмена» (тест проверяет перехват буфера). Нативных `prompt/confirm/alert`
  в модуле нет (правило `test/ui-dialogs.test.js`).
* Путь к Python и папке инструментов можно переопределить из кода:
  `setPythonPath(p)`, `buildCommand('compare', { python, toolsDir, docsJson, model, cloud, out })`.

### 1.6. Дизайн

* Панель — те же `fpanel`/`lx-*`-классы и токены `tokens.css`; новые CSS-правила только
  на токенах (`--accent`, `--accent-soft`, `--bg-2`, `--txt-2/3`, `--ok`, `--warn`,
  `--err`, `--line`, `--r-1/2/3`, `--mono`); фиолетовый акцент и тёплый графит,
  без синего, чистого белого и градиентов.
* Панель живёт в правой колонке приложения (`#stageSideR`, 328 px) и адаптируется
  к её ширине (`width:100%`), поэтому ничего не обрезается: таблица компактная —
  параметр + проект/модель/облако + статус, а Δ выведена под названием параметра.
* Скор, бейджи PASS/WARN/FAIL/— и рекомендации используют цвета статусов токенов
  (`--ok`/`--warn`/`--err`), ничего не «кричит» чисто-белым/синим.

## 2. Формат `compare.json`, который читает панель

### 2.1. Реальная схема `tools/scan2bim-py/docs-compare.py` (schema_version = 1)

```json
{
  "schema_version": 1,
  "generated_at": "2026-11-15T…",
  "inputs": {
    "docs":  {"path": "...", "primary_pdf": "...", "pages": 245, "object": "...", "address": "..."},
    "model": {"path": "...", "md5": "...", "walls": 85, "rooms": 23, "storey_height_m": 3.278},
    "cloud": {"path": "...", "measured": true, "height_m": 3.276, "floor_visible_m2": 127.9}
  },
  "score": 87, "grade": "A", "coverage_pct": 66,
  "summary": {"checks": 12, "pass": 8, "warn": 3, "fail": 1, "unverified": 0},
  "rows": [{
    "id": "floor_height", "category": "floors", "label": "Высота этажа (чистая)",
    "project": {"value": 3300, "unit": "mm", "source": "docs.json:…", "page": 15},
    "model":   {"value": 3278, "unit": "mm", "source": "…"},
    "cloud":   {"value": 3276, "unit": "mm", "source": "…"},
    "delta_mp": {"abs": -22, "unit": "mm", "pct": -0.67},
    "delta_cm": {"abs": -2,  "unit": "mm", "pct": -0.06},
    "tolerance": {"abs": 50, "unit": "mm"},
    "status": "PASS", "note": "в допуске"
  }],
  "recommendations": [{"severity": "warn", "code": "A3", "text": "…"}],
  "limitations": ["…"],
  "unverified": [{"id": "bbox_x", "label": "Габарит X", "reason": "нет облака"}]
}
```

Статусы в отчёте: **PASS | WARN | FAIL | UNVERIFIED**; в UI `UNVERIFIED` показывается
как **«—»**, `WARN` — отдельным янтарным бейджем (честно показываем предупреждение,
а не только PASS/FAIL). Если `status` отсутствует, он выводится из `delta_mp.abs`
и `tolerance.abs` (по умолчанию ±30 мм) или `delta_mp.pct` (±2 %).

### 2.2. Упрощённая схема из постановки (тоже принимается)

```json
{
  "docs": {"object": "...", "address": "..."},
  "model": {"stats": {"wallCount": 5}},
  "score": 50,
  "rows": [{"name": "A", "project": "100", "model": "90", "cloud": "—",
            "delta_mm": -10, "delta_pct": -10, "status": "FAIL"}],
  "recommendations": ["Исправить A"]
}
```

`score` может отсутствовать — тогда скор считается по строкам
(PASS = 1, WARN = 0.5, FAIL = 0, «—» не учитывается), `docs-compare.py`-поля
`inputs.*` при этом необязательны.

## 3. API модуля

`window.__lxS2BDocs` (и `module.exports` для `node --test`):

```js
{
  version: '119', REPORT_NAME, SCHEMA_VERSION, PYTHON_DEFAULT, TOOLS_DIR_DEFAULT,
  CMD_DEFAULTS, STATUS, STATUS_LABEL, DEFAULT_TOL_MM, DEFAULT_TOL_PCT, GRADE_BANDS,

  // чистые функции (Node, без DOM)
  parseCompareJson(text)      // → {ok, report, raw, reason?}
  normalizeCompare(raw)       // схема → нормализованный отчёт
  scoreOf(input)              // явный score или расчёт по строкам (0–100)
  gradeOf(score)              // A/B/C/D/E
  statusOfScore(score)        // 'ok' | 'warn' | 'err'
  summaryOf(input)            // {checks, pass, warn, fail, unverified}
  rowToStatus(row|status)     // 'pass' | 'warn' | 'fail' | 'na'
  normalizeStatusString(s)  cellText(cell)  statusLabel(s)  deltaText(delta)
  modelSummaryOf(model)       // сводка модели приложения для блока у скора
  instructions()              // шаги + 2 команды + notes
  buildCommand('extract'|'compare', opts)  // готовая PowerShell-команда
  copyText(text)              // clipboard с fallback (Promise<boolean>)

  // панель
  open(model?)  close()  isOpen()  setModel(m)  getModel()  currentModel()
  setReport(input)  getReport()  clearReport()  loadFile(file)  importJson(text)
  refresh()  saveReport()  reportJson()  openFilePicker()
  showHelp()  hideHelp()  isHelpOpen()  copyCommand(id)
  setPythonPath(p)  getPythonPath()  getState()
}
```

Data-контракт панели: `data-d-panel`, `data-d-body`, `data-d-title`, `data-d-object`,
`data-d-address`, `data-d-file`, `data-d-score`/`data-d-score-value`/`data-d-grade`,
`data-d-count="pass|warn|fail|na"`, `data-d-coverage`, `data-d-model-summary`,
`data-d-table`, `data-d-row="<id>"`, `data-d-row-status="pass|warn|fail|na"`,
`data-d-cell="param|project|model|cloud|delta"`, `data-d-delta-abs`/`data-d-delta-pct`,
`data-d-badge`, `data-d-rec`, `data-d-severity`, `data-d-limit`, `data-d-unv`,
`data-d-status`, `data-d-error`, `data-d-import-input`,
`data-d-modal="help"`, `data-d-help-step`, `data-d-cmd="extract|compare"`,
`data-d-help-status`; кнопки — `data-act="load-report|refresh|save-report|show-help|copy-command|close-help"`.

## 4. Тесты

`node --test test/r119-docs-panel.test.js` — **19/19 pass**:

* **source-level (5)**: кнопка «Документация» после «Качество модели», динамическая
  загрузка `lixel-scan2bim-docs.js?v=119`, `D.open(state.model)`, `syncDocsModel`,
  `docs: openDocsModel`; `index.html` не правился; панель/API/data-атрибуты; только
  чтение файла (нет `child_process`/`spawn`/`fetch`, нет нативных prompt/confirm/alert);
  палитра на токенах + hex палитры задания, без градиентов/белого; пустое состояние
  1-2-3 и напоминание про `state.model`; инструкция с `docs-extract.py`,
  `docs-compare.py`, путём Python из DSH, `--docs/--model/--cloud/--out`, `PYTHONUTF8`,
  `--strict`.
* **Node, чистые функции (7)**: `parseCompareJson` реальной схемы (скор 87, grade A,
  covered 66 %, 4 строки PASS/WARN/FAIL/—, ячейки «3300 мм», Δ −22 мм/−0,67 %,
  рекомендации, ограничения, непроверенное, входной объект не мутируется); упрощённой
  схемы (status/score/вывод скора по строкам); 16 кейсов невалидного JSON с понятными
  причинами + пустой `rows` как валидный «пустой отчёт»; `rowToStatus` (явные статусы,
  derive из Δ/допуска, явный статус важнее Δ); `scoreOf/gradeOf/statusOfScore/summaryOf`
  (клампы 0–100, WARN = 0.5, A–E, явная summary); `cellText/modelSummaryOf`;
  `setReport/reportJson/clearReport` (round-trip, ошибка не сбрасывает отчёт).
* **jsdom, реальная панель (7)**: пустое состояние (панель, шаги, input[type=file],
  кнопки, сводка модели приложения, кнопка импорта открывает выбор файла); загрузка
  `compare.json` через настоящий `FileReader` (заголовок/адрес, скор 87/A и зелёный
  статус, счётчики, 4 строки с бейджами, ячейки/Δ, рекомендации, ограничения,
  непроверенное, кнопки, статус); невалидный JSON/схема не ломает загруженный отчёт,
  затем валидный обновляет; «Обновить» перечитывает файл, «Сохранить отчёт» скачивает
  исходный JSON (score/rows/recommendations); модалка-инструкция (3 шага, 2 команды,
  путь DSH, копирование в буфер, закрытие кнопкой и Esc); панель без модели;
  интеграция с настоящим `lixel-scan2bim-ui.js` — кнопка грузит модуль, панель
  открывается, закрытие «Скан → BIM» её не закрывает.

Полный прогон приложения (без регрессий, r110/r111/r114 и `ui-dialogs` проходят):

```
$ cd bim-twin; node --test
ℹ tests 1635     ℹ pass 1631     ℹ fail 0     ℹ skipped 4
```

(до задачи было 1616 / 1612 pass / 0 fail / 4 skipped; +19 — новые тесты r119.)

## 5. Реальный прогон в Electron

CDP-стенд по образцу `_scratch/ui-*.js` (после проверки удалён), Electron 31, тёмная тема:

| Шаг | Результат |
|---|---|
| «Скан → BIM» → кнопка «Документация» (`#lxScan2BimDocsBtn`) | кнопка есть, подпись «Документация» |
| динамическая загрузка `lixel-scan2bim-docs.js?v=119` | модуль установлен, панель `#lxS2BDocsPanel` открылась (`display:block`) |
| пустое состояние (модель 2 стены/1 помещение/79,1 м²/3,28 м) | 3 шага, input[type=file], кнопка-инструкция, сводка «В приложении Стены 2 · Помещения 1 · Площадь 79,1 м² · Высота 3,28 м» |
| загрузка отчёта (7 строк, score 87, grade A, 3 рекомендации) | таблица 7 строк, скор 87/A, PASS 8 / WARN 3 / FAIL 1, рекомендации, статус «Загружено: compare.json · скор 87/100 · строк 7» |
| невалидный JSON `{"rows":[{}]}` | `badOk=false`, таблица не изменилась (0 строк до загрузки), ошибка в панели/тосте |
| модалка «Как получить отчёт» | 3 шага, 2 команды, кнопки «Копировать»; в команде `docs-compare.py`, реальный путь Python из DSH, `--out`, PYTHONUTF8 |
| JS-исключения | **0** |
| скриншоты | `%TEMP%\bim-docs-panel.png`, `%TEMP%\bim-docs-help.png` |

## 6. Как открыть и пользоваться

1. `cd bim-twin; npm start` (Electron).
2. Открыть/построить модель: лента/тулбар **«Скан → BIM»** → «Построить BIM» (модель
   появится в сводке панели документации автоматически).
3. В панели «Скан → BIM» нажать **«Документация»** — справа откроется `#lxS2BDocsPanel`.
4. Получить `compare.json`:
   * нажать **«Как получить отчёт»** → скопировать/выполнить две команды PowerShell
     (python из DSH, `docs-extract.py`, `docs-compare.py`);
   * либо выполнить их в терминале вручную — инструкция в модалке с готовыми путями.
5. В панели **«Загрузить отчёт сравнения»** → выбрать `compare.json` → появятся
   заголовок объекта, скор 0–100 с оценкой A–E, таблица проект↔модель↔облако,
   рекомендации, ограничения и непроверенные пункты.
6. **«Обновить»** — перечитать файл и обновить сводку модели; **«Сохранить отчёт»** —
   скачать исходный JSON (`docs-compare-report.json`).
7. Из консоли: `window.__lxS2BDocs.open(model)`, `.importJson(text)`, `.parseCompareJson(text)`,
   `.showHelp()`, `.getState()`, `.buildCommand('compare')`.

## 7. Ограничения

* `compare.json` готовит Python-инструмент Блока 2 (`tools/scan2bim-py/docs-compare.py`);
  на момент отчёта файлы `docs-extract.py`/`docs-compare.py` ещё пишет phase5-regression —
  парсер зафиксирован по согласованной схеме (schema_version=1) и проверен на её
  репрезентативном примере; когда появится реальный `D:\BIM-TWIN-TEST\docs\compare.json`,
  его достаточно загрузить в панель (кода менять не нужно; при изменении схемы — сообщить).
* В отчёте встречается статус **WARN** (кроме PASS/FAIL) — панель показывает его янтарным
  бейджем; **UNVERIFIED** показывается как «—» (как договаривались в постановке).
* Путь Python из DSH в инструкции — для этой машины (`C:\Users\bob\.dsh\…`);
  на другой машине его можно заменить в тексте команды или через
  `setPythonPath()/buildCommand({python})`.
* «Обновить» перечитывает **последний выбранный файл**; если `compare.json`
  перегенерирован в другом файле/папке — нажмите «Загрузить другой отчёт».
* Сводка модели у скора берётся из **приложения** (`window.__lxScan2BIM.state.model`
  или редактора); если модель не построена — показывается подсказка, отчёт всё равно
  доступен.
* Панель живёт в правой колонке приложения (328 px) и скроллится вместе с ней;
  таблица компактная (Δ под названием параметра), значения при очень длинных подписях
  сокращаются с многоточием (полный текст — в `title`).
* Правки не коммитились; чужие файлы (включая `lixel-scan2bim-ui.js` — только кнопка
  и загрузчик) не менялись.
