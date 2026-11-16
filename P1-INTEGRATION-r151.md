# P1-INTEGRATION-r151 — подключение готовых инструментов к UI + «Отчёт о точности» (P2)

Дата: 2026-11-16. База: r150 (`71573d4`). Изменения **не закоммичены**.
В рабочем дереве есть параллельные правки r151 других агентов (startup-sections, xbin-fusion,
perf и т.д.) — их не трогал; мои изменения перечислены ниже.
Задача: включить в интерфейс готовые Python-инструменты (`cloud-register.py`, `cloud-classify.py`,
`quality-compare.py`) и добавить P2 «Отчёт о точности» (RMSE плоскостей/3D-разница + PDF).

## Что сделано

| Файл | Изменение |
|---|---|
| `p1-bridge.js` | **новый** main-процессный мост к Python: 8 IPC-каналов (`bim:p1Status`, `PickClouds`, `PickPairs`, `GrantPaths`, `Register`, `Classify`, `Accuracy`, `Export`, `Cancel`), прогресс `bim:p1Progress`, отмена по jobId, allowlist скриптов, UTF-8 окружение Python, гранты на выходные файлы |
| `main.js` | регистрация моста в `registerIpc()` (одним блоком, без изменения остальных обработчиков) |
| `preload.js` | `bimAPI.p1Status/p1PickClouds/p1PickPairs/p1GrantPaths/p1Register/p1Classify/p1Accuracy/p1Export/p1Cancel/onP1Progress` |
| `renderer/ui/p1-tools.js` | переписан UI-слой: реальные панели «Совместить облака», «Классификация», «Пакетная обработка проекта», «Отчёт о точности»; легаси-путь r149 (без моста) сохранён, лента/шелл не тронуты |
| `tools/scan2bim-py/cloud-diff.py` | **новый** P2-инструмент: 3D-разница облаков (воксельный поиск без scipy), RMSE плоскостей пола/стен, heatmap PNG |
| `tools/scan2bim-py/quality-compare.py` | фикс чтения LAS: RGB-смещение для fmt 2/7/8/10 (было 28 для всех — падало на fmt 2/7/8/10) |
| `test/r151-p1-integration.test.js` | **новый**, 9 тестов (мост, аргументы, валидация, jsdom-панели/очередь/отчёт) |
| `P1-INTEGRATION-r151.md` | этот отчёт |

Ленту (`commands.js`/`ribbon.js`/`chrome.js`/`shell.css`) и правки r150 не трогал; `p1-tools.js` подключается
штатным `ensureP1Tools()` из `app.js` (URL не менял, чтобы не конфликтовать с r150).

## 1) «Совместить облака» — реальный `cloud-register.py`

UI (`window.__lxP1.openMerge()` / кнопка в полосе P1): эталон (ref), исходное (src), режим
(ICP / пары точек / GCP), файл пар, авто-инициализация ICP, строгий порог (5 см для ICP, 15 см для пар/GCP).
Запуск → `bimAPI.p1Register` → `p1-bridge` → `python cloud-register.py` → JSON + пересчитанное облако
(`--out-las`), прогресс/лог в панели, результат **открывается в сцене**. При strict-fail — красная плашка
с RMS и порогом, облако не грузится; при отсутствии Open3D — понятная подсказка.

Проверено E2E (синтетика: комната 6×4×3, src повёрнут на 1.5° и сдвинут):

- режим **manual-points** (5 пар): `строгий порог пройден, RMS 0.0 мм (порог 150 мм)`,
  yaw `-1.500076°`, сдвиг `[-0.344, 0.229, -0.08] м`, результат `src-registered.las` загружен в сцену, JSON рядом;
- режим **ICP**: `ICP требует Open3D в Python-движке. Установите движок (Настройки → Python/Open3D)
  или используйте режимы «Пары точек» / «GCP» — они работают без Open3D.` (в этом окружении Open3D нет —
  честная ошибка вместо молчания);
- валидация: без ref/src/пар — понятные сообщения, исключений нет.

## 2) «Классификация» — реальный `cloud-classify.py`

UI (`openClassify` / кнопка «Классификация»): запуск на текущем облаке, опция «убрать людей»;
результат — таблица классов (точки, доля, полоса), средняя уверенность, превью-карта классов,
кнопки «Подсветить классы цветом» (открывает размеченный LAS и включает `setColorMode('classification')`),
«Оставить выбранные классы» (фильтр по classification в памяти — пол/стены/растительность/…),
«JSON-отчёт». Для PLY доступны проценты/превью, фильтр просит LAS.

E2E на 260 000 точках (за 0.3 с):

| Класс | Точек | Доля |
|---|---:|---:|
| Пол | 64 042 | 24.6 % |
| Стены | 126 792 | 48.8 % |
| Крыша | 62 424 | 24.0 % |
| Растительность | 439 | 0.2 % |
| Люди | 0 | 0 % |
| Мебель | 436 | 0.2 % |
| Прочее | 5 867 | 2.3 % |

Средняя уверенность 91 % (p10 80 %). Подсветка классов в 3D включилась (`colorMode: classification`,
доступные режимы `rgb/elev/intensity/classification`). Фильтр «Пол+Стены+Растительность» оставил
253 697 точек (ASPRS-код 6 общий у «стен» и «крыши», поэтому крыша тоже осталась — см. ограничения).

## 3) «Пакетная обработка проекта» — реальные API

Очередь в UI: `xbinBuildCloud → photoColorCloud → cleanCloud → p1Export` с прогрессом по стадиям,
общим прогресс-баром, логом, отменой (cancelXbinCloud/cancelPhotoColor/cleanAbort/p1Cancel) и результатом.
Порядок «цвет → чистка» осознанный: чистка сохраняет PLY и теряет время точек, без которого цвет по фото
невозможен (в отчёте и подсказке панели это объяснено).

E2E (облако уже открыто, .xbin рядом нет): стадии honest-скипнуты с причинами
(«облако уже открыто — сборка не нужна», «пропущено: Рядом с облаком не найден файл сканера .xbin»),
**чистка выполнена реально** (`bimAPI.cleanCloud` → `classified_clean.ply`), **экспорт выполнен**
(`bimAPI.p1Export` → `batch-…ply`, 5 МБ), статус «Пакетная обработка: готово», лог заполнен.
С `.xbin`/poses (реальный проект) сборка и цвет выполняются теми же вызовами, что и штатные кнопки.

## 4) P2 «Отчёт о точности» — `quality-compare.py` + `cloud-diff.py` + PDF

UI (`openAccuracy` / кнопка «Отчёт о точности»): наше облако (текущее), файл-эталон, чекбокс
интерьерного профиля, запуск «Сверка с эталоном». Мост последовательно запускает:

1. `quality-compare.py` — метрики качества/вердикты (плотность, толщина стен, артефакты пола, цвет и т.п.)
   и свои heatmap-карты;
2. `cloud-diff.py` — **3D-разница** (mean/RMSE/median/p95/max; % в допусках 2/5/10 см),
   **RMSE плоскостей** пола и стен (своя плоскость для каждого облака + Δ) и heatmap PNG.

В панели: числа, таблицы, heatmap-картинки, кнопки «PDF-отчёт» и «JSON». PDF собирается как HTML
(числа, плоскости, вердикты, встроенные heatmap) и сохраняется существующим `bimAPI.saveReportPdf`.

E2E (наше `classified.las` 253 697 т. vs `ref.las` 260 000 т.):

- 3D-разница: **mean 3.3 мм, RMSE 6.9 мм, медиана 0.5 мм, p95 17.5 мм, max 56.5 мм**;
  в допуске 2 см — 96.9 %, 5 см — 100 %, 10 см — 100 %;
- RMSE плоскостей: пол — наше 6.0 мм / эталон 6.1 мм (Δ −0.2 мм); стены — 27.7 / 27.8 мм (Δ −0.1 мм);
- вердикты quality-compare: `blur FAIL`, `floor_artifacts FAIL`, `color_coverage FAIL` (синтетика,
  у нашего облака нет цвета — ожидаемо, отображается честно);
- в панели 3 heatmap-картинки, кнопка PDF присутствует (сам диалог сохранения PDF в e2e не нажимался —
  нативные диалоги не автоматизируются; формирование HTML→PDF проверено unit-тестом с фейковым saveReportPdf).

Скриншоты: `D:\BIM-TWIN-TEST\r55\p1-r151\shots\`
`01-merge-manual.png`, `02-merge-icp-error.png`, `03-classify.png`, `04-classify-colors.png`,
`05-classify-filtered.png`, `06-accuracy.png`, `07-batch.png`.

## Тесты

- Новый `test/r151-p1-integration.test.js` — **9/9 pass**:
  мост зарегистрирован/API в preload; builders аргументов register/classify/quality/diff;
  статус инструментов; валидация ref/src; подсказка ICP без Open3D; jsdom-панели (3 панели + панель P2),
  вызов `p1Register` и вывод RMS/strict; проценты классов и фильтр; реальная очередь build→color→clean→export
  с прогрессом/логом; отчёт о точности (числа, heatmap, PDF-HTML).
- `test/r149-p1-tools.test.js` — **4/4 pass** (легаси-путь без моста не сломан).
- Полный `node --test`: **1772 теста / 1768 pass / 0 fail / 4 skipped** (включая 9 новых r151).

## Ограничения и что дальше

- **ICP требует Open3D** — в этом окружении его нет (Python 3.14/3.12 без Open3D). Мост определяет это
  (`open3d:false` в `p1Status`) и предлагает режимы «Пары точек»/«GCP» (работают на numpy). Для ICP
  пользователю нужен изолированный Python-движок Open3D (Настройки → Python/Open3D).
- **LAS-требования**: без Open3D `cloud-register.py` читает только LAS (PLY → «PLY: нужен open3d»),
  `quality-compare.py` — только LAS. P2 UI прямо просит LAS для обоих облаков; для PLY предлагается
  экспорт в LAS. `cloud-diff.py` читает LAS/PLY/BIN через парсер классификатора.
- **Фильтр классов**: ASPRS-коды «стены» и «крыша» совпадают (6), поэтому фильтр по классам
  «Стены» оставляет и крышу. Для точного фильтра нужен вывод внутренних кодов классификатора
  отдельным атрибутом (follow-up: `--out-bin` уже содержит 0…6, но вьюер не читает наш .bin — можно
  сохранять классификацию отдельным атрибутом/COLORBYTE).
- **Цвет в пакетной очереди** требует `.xbin` + poses рядом с облаком (штатное API `photoColorCloud`);
  без них стадия honest-скипуется с текстом ошибки, а не падает.
- **PDF** сохраняется через штатный диалог (нативный), поэтому e2e его не нажимает; HTML-отчёт
  проверен unit-тестом. Для полностью автоматического сохранения можно добавить `saveReportPdfToPath`.
- `quality-compare.py` исправлен точечно (RGB-смещения LAS); остальные готовые инструменты не менялись.

## Как повторить

```
cd C:\Users\bob\Documents\deepseek-harness\default-workspace
# 1) синтетика для проверки (комната 6×4×3, src повёрнут/сдвинут):
python _scratch\r151-make-clouds.py && python _scratch\r151-make-pairs.py
# 2) реальный Electron: панели, merge/classify/accuracy/batch, 7 скриншотов:
node _scratch\r151-p1-e2e.js
# 3) тесты:
cd bim-twin && node --test test\r151-p1-integration.test.js test\r149-p1-tools.test.js
```

Инструменты напрямую (без UI):

```
python tools\scan2bim-py\cloud-register.py --ref ref.las --src src.las --mode manual-points --pairs pairs.json --strict --out reg.json --out-las src-registered.las
python tools\scan2bim-py\cloud-classify.py cloud.las --out-las classified.las --json classify.json --preview class.png
python tools\scan2bim-py\quality-compare.py --our ours.las --ref ref.las --out quality.json --heatmaps hm
python tools\scan2bim-py\cloud-diff.py --our ours.las --ref ref.las --out diff.json --heatmap diff.png
```
