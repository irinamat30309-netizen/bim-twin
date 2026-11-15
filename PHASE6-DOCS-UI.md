# Блок 3 ROADMAP-DOCS-AI — панель «Документация» в приложении

Дата: 2026-11-15. База: коммит `f3e92a2` (r118), ветка `agent/ui-redesign`.
Работа вошла в коммит Lead `0756cb6` (r119b, «панель „Документация“», 19 тестов) и
`de98be3` (r120); после этого отчёт обновлён по **реальным** отчётам Блока 2 —
`compare.json` (v4: score 92.7/A, 25 строк) и `compare-v5.json` (v5: score 91.7/A,
20 строк, **2 FAIL** по толщинам 380/400 — реальная FAIL-ветка панели). Парсер адаптирован
под фактические поля (`value/pct`, вложенный `tolerance`, дробный `score`, null в
UNVERIFIED, терпимость к legacy-полю `delta`; в сырых файлах v4/v5 только `delta_mp`/`delta_cm`),
+3 теста на реальный формат/файлы.
Сам я ничего не коммитил, чужие файлы не трогал.
Задача — панель «Документация» перед/после построения BIM: загрузка отчёта сравнения
`compare.json` (готовит `docs-compare.py`), таблица «проект ↔ модель ↔ облако»,
скор соответствия 0–100, рекомендации и понятная инструкция, как получить отчёт
без терминала.

Файлы этой задачи:

| Файл | Статус |
|---|---|
| `renderer/lixel-scan2bim-docs.js` | **новый**, ~1350 строк: панель `#lxS2BDocsPanel`, парсер/валидатор (обе схемы + реальные варианты полей), модалка-инструкция, API |
| `renderer/lixel-scan2bim-ui.js` | минимальные правки: кнопка «Документация» + динамическая загрузка модуля (+41/−2) |
| `test/r119-docs-panel.test.js` | **новый**, 22 теста (source-level + Node + jsdom; включая разбор реальных `compare.json` v4 и `compare-v5.json` с FAIL-веткой) |
| `PHASE6-DOCS-UI.md` | этот отчёт |

`index.html`, `renderer/scan2bim.js`, инструменты Python и прочие файлы **не менялись**:
модуль подключается динамически из панели «Скан → BIM» (как редактор и панель качества),
`compare.json`/`compare-v5.json` — результат `tools/scan2bim-py/docs-compare.py`
(Блок 2, phase5-regression).

## Сводка (числа)

| Проверка | До | После |
|---|---|---|
| `node --test` (bim-twin) | 1616 тестов / **1612 pass** / 0 fail / 4 skipped | **1638** / **1634 pass** / **0 fail** / 4 skipped |
| Новые тесты `r119-docs-panel` | — | **22 / 22 pass** (0 fail) |
| Реальный прогон Electron (Chromium) | — | кнопка → модуль → панель → **реальный compare.json v4**: скор **92,7/A**, 25 строк (PASS 18 / WARN 3 / FAIL 0 / — 4), 4 рекомендации, 5 ограничений, 5 непроверенных; **compare-v5.json**: скор **91,7/A**, 20 строк (12/2/**2 FAIL**/4), 5 рекомендаций — **FAIL-ветка подтверждена на реальных данных**; модалка-инструкция: **0 JS-исключений** |
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
  * значения ячеек `project/model/cloud` — число, строка или `{value, unit, source, page}`;
  * **фактический формат docs-compare.py** (проверено на реальном файле): `delta_mp`/`delta_cm` —
    `{value, unit, pct?}` (парсер принимает и `{abs,...}`), `tolerance` — `{value, unit}` или
    `{value:{pass_mm, warn_mm, unit}}` для дверей, высоты — `storey_height_mm`/`height_mm`
    (переводятся в метры), `score` бывает дробным (92.7 → в панели «92,7»), а строки
    `UNVERIFIED` могут иметь `project/model/cloud = null` — в таблице это «—».
* **При ошибке** (`битый JSON`, нет `rows`, строка без названия, score не число,
  recommendations не массив и т.п.) — панель показывает «Импорт отклонён: <причина>»
  и тост, а прежний отчёт, скор и таблица **остаются на месте** (проверено тестом).
* **При успехе** — отчёт нормализуется (статусы PASS/WARN/FAIL/UNVERIFIED,
  Δ в мм/%, рекомендации, ограничения), сохраняется исходный JSON для «Сохранить отчёт».

### 1.3. Отображение

* **Заголовок**: объект и адрес из документации (`docs.object` / `docs.address`),
  файл отчёта, дата генерации, число страниц PDF.
* **Скор соответствия 0–100** с цветом статуса (ok ≥ 85, warn ≥ 55, иначе err),
  дробный score показывается без потери точности («92,7»), оценка **A–E**,
  счётчики `PASS / WARN / FAIL / —`, покрытие проверок
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

Пример из фактического `D:\BIM-TWIN-TEST\docs\compare.json` (MD5 `57C28FCCBFF1C8876BFF565C62EDFC09`,
score 92.7, grade A, coverage 90 %) — поля, которые читает панель:

```json
{
  "schema_version": 1,
  "generated_at": "2026-11-15T…",
  "tool": "docs-compare.py",
  "inputs": {
    "docs":  {"path": "...", "md5": "...", "object": "...", "address": "...", "pages": 245},
    "model": {"path": "...", "md5": "...", "walls": 85, "walls_measured": 23, "rooms": 23,
              "storey_height_mm": 3278, "rooms_area_m2": 122.81},
    "cloud": {"path": "...", "measured": true, "height_mm": 3276, "floor_visible_m2": 128,
              "rooms_perimeter_covered_pct": 98.7, "floor_perimeter_outer_m": 203.8}
  },
  "score": 92.7, "grade": "A", "coverage_pct": 90.0,
  "summary": {"checks": 25, "pass": 18, "warn": 3, "fail": 0, "unverified": 4},
  "rows": [{
    "id": "floor_height", "category": "floors", "label": "Высота этажа (чистая)",
    "project": {"value": 3300, "unit": "mm", "source": "docs.json: floors.clean_height_mm"},
    "model":   {"value": 3278, "unit": "mm", "source": "model: storey.height"},
    "cloud":   {"value": 3276, "unit": "mm", "source": "ruler-v2.py: cloud.height"},
    "delta_mp": {"value": -22, "unit": "mm", "pct": -0.67},
    "delta_cm": {"value": -2, "unit": "mm"},
    "tolerance": {"value": 50, "unit": "mm"},
    "status": "PASS", "note": "…"
  }, {
    "id": "door_model_1993",
    "tolerance": {"value": {"pass_mm": 80, "warn_mm": 180, "unit": "mm"}, "unit": ""},
    "delta_mp": {"value": 93, "unit": "mm"}, "status": "WARN"
  }, {
    "id": "rooms_area_total", "project": {"value": 3600.13, "unit": "m2"},
    "model": {"value": 122.81, "unit": "m2"}, "cloud": {"value": 128, "unit": "m2"},
    "delta_mp": null, "tolerance": null, "status": "UNVERIFIED"
  }],
  "recommendations": [{"severity": "warn", "code": "wall_t_600", "text": "…"}],
  "limitations": ["…"],
  "unverified": [{"id": "rooms_area_match", "label": "…", "reason": "…"}]
}
```

Статусы в отчёте: **PASS | WARN | FAIL | UNVERIFIED**; в UI `UNVERIFIED` показывается
как **«—»**, `WARN` — отдельным янтарным бейджем (честно показываем предупреждение,
а не только PASS/FAIL). Если `status` отсутствует, он выводится из Δ и допуска
(`delta_mp.value`/`abs` против `tolerance.value`/`abs`; по умолчанию ±30 мм) или
`delta_mp.pct` (±2 %). `score` может быть дробным (92.7 → «92,7»), `grade` берётся из
отчёта (иначе выводится из скора), `coverage_pct` и `summary` — из отчёта.

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
  fmtScore(score)             // 92.7 → '92,7'; 87 → '87'
  toleranceText(tolerance)    // 'допуск ±80 мм'
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

`node --test test/r119-docs-panel.test.js` — **22/22 pass**:

* **source-level (5)**: кнопка «Документация» после «Качество модели», динамическая
  загрузка `lixel-scan2bim-docs.js?v=119`, `D.open(state.model)`, `syncDocsModel`,
  `docs: openDocsModel`; `index.html` не правился; панель/API/data-атрибуты; только
  чтение файла (нет `child_process`/`spawn`/`fetch`, нет нативных prompt/confirm/alert);
  палитра на токенах + hex палитры задания, без градиентов/белого; пустое состояние
  1-2-3 и напоминание про `state.model`; инструкция с `docs-extract.py`,
  `docs-compare.py`, путём Python из DSH, `--docs/--model/--cloud/--out`, `PYTHONUTF8`,
  `--strict`.
* **Node, чистые функции (10)**: `parseCompareJson` реальной схемы (скор 87, grade A,
  covered 66 %, 4 строки PASS/WARN/FAIL/—, ячейки «3300 мм», Δ −22 мм/−0,67 %,
  рекомендации, ограничения, непроверенное, входной объект не мутируется); **реальные
  варианты полей docs-compare.py** (`delta_mp.value`, `tolerance.value` простой и
  вложенный `pass_mm/warn_mm` для дверей, `storey_height_mm`/`height_mm`, дробный
  `score 92.7`, `UNVERIFIED` с null-ячейками, Δ в %); **реальный `compare.json` v4**
  (score 92.7/A, 90 % покрытия, 25 строк 18/3/0/4, объект/адрес/245 стр., Δ высоты
  −22 мм/−0,67 %, вложенный допуск дверей, null-ячейки UNVERIFIED); **реальный
  `compare-v5.json`** (score 91.7/A, 20 строк 12/2/2/4, **FAIL-ветка** wall_t_380/400;
  сырые строки — `delta_mp`/`delta_cm`, в нормализованной UI-модели это `row.delta`;
  legacy-поле `delta` тоже поддержано отдельным тестом; 5 рекомендаций с severity fail);
  упрощённой схемы
  (status/score/вывод скора по строкам); 16 кейсов невалидного JSON с понятными
  причинами + пустой `rows` как валидный «пустой отчёт»; `rowToStatus` (явные статусы,
  derive из Δ/допуска — включая `value`/вложенный tolerance, явный статус важнее Δ);
  `scoreOf/gradeOf/statusOfScore/summaryOf` (клампы 0–100, дробный score сохраняется,
  `fmtScore` «92,7», WARN = 0.5, A–E, явная summary); `cellText/modelSummaryOf`;
  `setReport/reportJson/clearReport` (round-trip, ошибка не сбрасывает отчёт).
* **jsdom, реальная панель (7)**: пустое состояние (панель, шаги, input[type=file],
  кнопки, сводка модели приложения, кнопка импорта открывает выбор файла); загрузка
  `compare.json` через настоящий `FileReader` (заголовок/адрес, скор и зелёный
  статус, счётчики, строки с бейджами, ячейки/Δ, рекомендации, ограничения,
  непроверенное, кнопки, статус); невалидный JSON/схема не ломает загруженный отчёт,
  затем валидный обновляет; «Обновить» перечитывает файл, «Сохранить отчёт» скачивает
  исходный JSON (score/rows/recommendations); модалка-инструкция (3 шага, 2 команды,
  путь DSH, копирование в буфер, закрытие кнопкой и Esc); панель без модели;
  интеграция с настоящим `lixel-scan2bim-ui.js` — кнопка грузит модуль, панель
  открывается, закрытие «Скан → BIM» её не закрывает.

Полный прогон приложения (без регрессий, r110/r111/r114 и `ui-dialogs` проходят):

```
$ cd bim-twin; node --test
ℹ tests 1638     ℹ pass 1634     ℹ fail 0     ℹ skipped 4
```

(до задачи было 1616 / 1612 pass / 0 fail / 4 skipped; +22 — новые тесты r119.)

## 5. Реальный прогон в Electron

CDP-стенд по образцу `_scratch/ui-*.js` (после проверки удалён), Electron 31, тёмная тема.
Сначала — синтетический отчёт (пустое состояние/модалка), затем — **реальные отчёты
Блока 2**: `compare.json` v4 (score 92.7, 25 строк, FAIL=0) и `compare-v5.json`
(score 91.7, 20 строк, **2 FAIL** — проверка FAIL-ветки на реальных данных):

| Шаг | Результат |
|---|---|
| «Скан → BIM» → кнопка «Документация» (`#lxScan2BimDocsBtn`) | кнопка есть, подпись «Документация» |
| динамическая загрузка `lixel-scan2bim-docs.js?v=119` | модуль установлен, панель `#lxS2BDocsPanel` открылась (`display:block`, ширина колонки 328 px) |
| пустое состояние (модель 2 стены/1 помещение/79,1 м²/3,28 м) | 3 шага, input[type=file], кнопка-инструкция, сводка модели приложения |
| **реальный compare.json v4** | скор **92,7/A** (зелёный), `PASS 18 / WARN 3 / FAIL 0 / — 4`, «сверено 90 % проверок · проверок 25», заголовок объекта и адрес из docs (245 стр.), таблица **25 строк** с бейджами PASS/WARN/—, Δ −22 мм · −0,67 %, **4 рекомендации**, 5 ограничений, 5 непроверенных; статус «Загружено: compare.json · скор 92,7/100 · строк 25» |
| **реальный compare-v5.json** | скор **91,7/A**, `PASS 12 / WARN 2 / FAIL 2 / — 4`, «проверок 20», таблица **20 строк**: `wall_t_380` — 380/260/270 мм, Δ −120 мм, **FAIL** (красные бейдж и Δ); `wall_t_400` — **FAIL**; **5 рекомендаций** (первые две severity fail), в т.ч. wall_t_600 WARN; статус «Загружено: compare.json · скор 91,7/100 · строк 20» |
| невалидный JSON `{"rows":[{}]}` | `badOk=false`, таблица не изменилась, ошибка в панели/тосте |
| модалка «Как получить отчёт» | 3 шага, 2 команды, кнопки «Копировать»; в команде `docs-compare.py`, реальный путь Python из DSH, `--out`, PYTHONUTF8 |
| JS-исключения | **0** |
| скриншоты (реальные отчёты) | `%TEMP%\bim-docs-real-top.png` / `bim-docs-real-table.png` (v4); `%TEMP%\bim-docs-v5-top.png` / `bim-docs-v5-fail.png` (v5, FAIL-строки); синтетика/модалка: `%TEMP%\bim-docs-panel.png`, `%TEMP%\bim-docs-help.png` |

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

* `compare.json` готовит Python-инструмент Блока 2 (`tools/scan2bim-py/docs-compare.py`,
  `docs-extract.py`); **реальные файлы уже прогнаны**:
  `D:\BIM-TWIN-TEST\docs\compare.json` (24 714 Б, MD5 `57C28FCCBFF1C8876BFF565C62EDFC09`,
  score 92.7/A, 25 строк, FAIL=0) и `D:\BIM-TWIN-TEST\docs\compare-v5.json`
  (20 666 Б, score 91.7/A, 20 строк, **2 FAIL** — реальная FAIL-ветка). Парсер проверен
  на обоих и в тестах (тесты с реальными файлами автоматически скипаются там, где файлов
  нет). Схема заморожена phase5: `value/pct`, вложенный `tolerance`, дробный `score`,
  null в UNVERIFIED; при изменении полей — сообщат заранее.
* `score` в отчёте бывает дробным (92.7) — в панели показывается «92,7», без потери
  точности; целые score отображаются как есть. `WARN` — отдельный янтарный бейдж,
  `UNVERIFIED` — «—» (как договаривались в постановке).
* Путь Python из DSH в инструкции — для этой машины (`C:\Users\bob\.dsh\…`);
  на другой машине его можно заменить в тексте команды или через
  `setPythonPath()/buildCommand({python})`.
* «Обновить» перечитывает **последний выбранный файл**; если `compare.json`
  перегенерирован в другом файле/папке — нажмите «Загрузить другой отчёт».
* Сводка модели у скора берётся из **приложения** (`window.__lxScan2BIM.state.model`
  или редактора); если модель не построена — показывается подсказка, отчёт всё равно
  доступен.
* Панель живёт в правой колонке приложения (328 px) и скроллится вместе с ней; при
  25 строках таблица и рекомендации листаются внутри панели. Таблица компактная
  (Δ под названием параметра), значения при очень длинных подписях сокращаются
  с многоточием (полный текст — в `title`).
* Код панели/тесты (21 тест на момент коммита) вошли в коммиты Lead `0756cb6`/`de98be3`;
  после них добавлен тест на реальный `compare-v5.json` (FAIL-ветка) и обновлён этот
  отчёт (не закоммичено). Чужие файлы не менялись.
