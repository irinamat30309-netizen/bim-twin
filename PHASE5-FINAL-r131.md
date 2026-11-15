# PHASE5-FINAL-r131 — финальная регрессия и релиз-отчёт (r130 HEAD, после UI-правок и coords-hud)

Дата: 2026-11-15, 18:12 (Europe/Kiev). База: HEAD **`abccbfd` (r130)**, ветка `agent/ui-redesign`.
Среда: Python 3.12.14 (DSH-рантайм), Node v24.20.0, ifcopenshell 0.9.0.post1, `pymupdf`, Windows.
Данные: `D:\BIM-TWIN-TEST`; инструменты: `bim-twin\tools\scan2bim-py\`.
Отчёт-спутник: `RELEASE-QUALITY-FINAL.md` (§ «ОБНОВЛЕНИЕ r130 (UI/данные) — финальная регрессия»).

## 0. Метод

Во время прогона рабочее дерево параллельно правилось задачами r131/r132 (M: `renderer/lixel-scan2bim-docs.js`,
`lixel-scan2bim-quality.js`, `scan2bim.js`, `app.js`, `db/ifcImport.js`, `tools/scan2bim-py/{json-to-ifc,edit-model,edit-model-test,validate-ifc}.py`;
новые `test/r131-*`, `test/r132-*`). Поэтому **все авторитетные замеры r130 сняты на чистом срезе HEAD**
в отдельном git-worktree:

```powershell
git worktree add --detach _scratch\r130-clean abccbfd
cmd /c mklink /J _scratch\r130-clean\node_modules <repo>\node_modules
```

Прогоны по грязному дереву сохранены отдельно как наблюдение (§1.2) и в зачёт r130 не идут.

## 1. Проверки — сводная таблица PASS/FAIL

| № | Проверка | Команда (чистый worktree) | Результат | Статус |
|---|---|---|---|---|
| 1 | `node --test`, прогон 1 | `node --test` | 1673 теста / **1669 pass** / 0 fail / 4 skipped, 192,2 с | **PASS** |
| 2 | `node --test`, прогон 2 | `node --test` | 1673 / **1669 pass** / 0 fail / 4 skipped, 77,8 с | **PASS** |
| 3 | docs-extract tests | `python tools\scan2bim-py\docs-extract-test.py` | PASS 21 / FAIL 0, 39,4 с | **PASS** |
| 4 | docs-compare tests | `python tools\scan2bim-py\docs-compare-test.py` | PASS 19 / FAIL 0, 8,5 с | **PASS** |
| 5 | редактор модели | `python tools\scan2bim-py\edit-model-test.py` | PASS 23 / FAIL 0 / SKIP 0, 16,0 с | **PASS** |
| 6 | фасад/окна | `python tools\scan2bim-py\facade-test.py` | кейсы 3/3, проверки 20/20, exit 0, 17 с | **PASS** |
| 7 | A1–A8 (v5) | `python tools\scan2bim-py\run-quality-all.py --save-baseline` | **A1–A8 PASS 8/8** (`koridor/final`) | **PASS** |
| 8 | B2–B4 (фасады) | (в том же прогоне) | map-120 19/19, map-window 17/17, map-crop20 8/8 | **PASS** |
| 9 | Итог качества | (в том же прогоне) | PASS 45 / FAIL 6 / SKIP 0; FAIL — только историческая модель r107 | **PASS** |
| 10 | IFC `py2-final-v5.ifc` | `python tools\scan2bim-py\validate-ifc.py …` | IFC4, 2592 inst, **0 ERROR/0 WARNING/0 INFO**, арность OK | **PASS** |
| 11 | IFC `py2-final-v5-r131-georef.ifc` | то же | IFC4, 2594 inst, 0/0/0, EPSG:25833 + IfcMapConversion | **PASS** |
| 12 | IFC `py2-final-v2-georef.ifc` | то же | IFC4, 2095 inst, 0/0/0, EPSG:25833 | **PASS** |
| 13 | IFC фасады (3 файла) | то же | 1528 / 1810 / 184 inst, все 0/0/0 | **PASS** |
| 14 | Пакет `bim-twin-r55-full.zip` | `_scratch\check-package-r130.py` | все 750 файлов HEAD r130 в пакете, ключевые хэши совпали | **PASS** |
| 15 | xbin-проверка чистки | (параллельная задача) | `XBIN-CLEAN-VERIFY.md`: совпадение с Lixel по геометрии/толщине/шуму; плотность 3,31× ниже (пресет); 4 точечных предложения без правок кода; xbin-тесты 24/24 | **PASS** |

Ожидание Lead: `node --test` 1673/1669/0/4 — **подтверждено дважды на чистом HEAD** (расхождений нет).

## 1.2. Наблюдение: прогоны по грязному дереву (не в зачёт)

| Прогон | tests | pass | fail | Упавший тест | Причина |
|---|---|---|---|---|---|
| dirty run 1 | 1673 | 1668 | 1 | `r74-scan2bim-accuracy.test.js:272` (`opts.levels`, `storeys[0].floorY=3`) | известный r74-флак под нагрузкой |
| dirty run 2 | 1673 | 1668 | 1 | `r119-docs-panel.test.js:414` (`parseCompareJson` принял `docs:"no"`) | в дереве уже была незакоммиченная правка `lixel-scan2bim-docs.js` (mtime 17:46:44), расширившая допуск строкового `docs` |

Логи: `D:\BIM-TWIN-TEST\quality\node-test-r130-run{1,2}.log`. На чистом HEAD оба файла зелёные;
падения не относятся к r130.

## 2. A1–A8 на модели v5 (`py2-final-v5.json`, MD5 E69A4579A5)

| № | Критерий | Цель | Факт | Статус |
|---|---|---|---|---|
| A1 | Высота этажа vs облако | ≤10 мм | +2 мм (3,278/3,276 м) | PASS |
| A2 | Покрытие стен | мед ≥90 %, мин ≥60 % | 94 / 62 % | PASS |
| A3 | Толщина стен | мед ≤20, p90 ≤40 мм | 3 / 16 (макс 30) мм | PASS |
| A4 | Периметр помещений | ≥97 % | 99,8 % (156,2/156,5 м) | PASS |
| A5 | Площадь / видимый пол | 95–102 % | 95,6 % (122,9/128,5 м²) | PASS |
| A6 | Вне пола / наложения | 0 / 0 | 0,0 % / 0,0 м² | PASS |
| A7 | Проёмы | ≥90/90 % | 100/100 % (TP 5, FN 0, FP 0) | PASS |
| A8 | Ширина проёма | мед ≤30 мм | 0 мм | PASS |

Контроль `koridor/baseline-r107`: PASS 2 / FAIL 6 (A1 +20 мм, A2 мин 20 %, A3 p90 93/макс 195 мм,
A4 96,5 %, A5 91,4 %, A6 0,9 %/0,5 м²) — **историческое**, CI-класс `[HISTORY]`, не регрессия.
Фасады: B2 PASS 19 (шаг 3,700 = Δ0,00 мм, окна 25/25, recall 99,94 %, IoU 95,31 %),
B3 PASS 17 (3,690, Δ−10 мм, 31/31, recall 99,39 %, IoU 93,83 %), B4 PASS 8 (кроп 2,1 с, без падений).
**Baseline:** метрики v5 не изменились vs закоммиченный baseline (только `created_at`);
`qa/quality-baseline.json` (CI E2) обновлён **r111 → v5/r130**.

## 3. IFC — инвентарь и валидация

| Файл | Размер, Б | MD5 | instances | ERROR/WARN/INFO | Инвентарь |
|---|---|---|---|---|---|
| `py2-final-v5.ifc` | 121 476 | D09826EA81 | 2592 | **0/0/0** | 1 этаж, 100 стен, 4 двери, 1 окно, 5 проёмов, 2 плиты, 9 помещений |
| `py2-final-v5-r131.ifc` | 121 481 | 2AEC5B0248 | 2592 | 0/0/0 | то же (артефакт параллельной r131-задачи) |
| `py2-final-v5-r131-georef.ifc` | 130 226 | 14B41E0B4F | 2594 | 0/0/0 | то же + IfcProjectedCRS EPSG:25833 + IfcMapConversion (identity) |
| `py2-final-v2-georef.ifc` | 104 612 | C12861210D | 2095 | 0/0/0 | 57 стен, 9 дверей, 2 окна, 23 помещения + EPSG:25833 |
| `py2-facade.ifc` | 70 077 | 4909E38FB2 | 1528 | 0/0/0 | 5 этажей, 5 стен, 25 окон, 6 плит |
| `py2-facade-window.ifc` | 83 664 | 8A0733BA00 | 1810 | 0/0/0 | 5 этажей, 5 стен, 31 окно |
| `py2-facade-mapcrop.ifc` | 8 530 | 17502E4146 | 184 | 0/0/0 | 1 этаж, 1 стена, 1 окно, 1 дверь, 2 плиты |

Все — IFC4, арность OK. JSON валидации: `D:\BIM-TWIN-TEST\quality\validate-*.json`.
Замечание: в HEAD r130 `json-to-ifc.js` без `--georef`; v5-georef получен параллельной r131-задачей,
валиден; регенерация на r130 не выполнялась.

## 4. Пакет `bim-twin-r55-full.zip`

`C:\Users\bob\Downloads\bim-twin-r55-full.zip` — 54 084 709 Б, 16:58:26, 1305 записей
(`bim-twin-r55/` 1181 файл с git-репозиторием, + screenshots 109, screenshots-docs 13, docs 1, START-HERE).
Отчёт проверки: `D:\BIM-TWIN-TEST\quality\package-check-r130.json` (+ скрипт `_scratch\check-package-r130.py`).

| Пункт | Факт |
|---|---|
| `renderer/ui/coords-hud.js` | 24 810 Б, MD5 823E33AF4B → **= HEAD r130** |
| `renderer/ui/short-label.js` | 1806 Б, MD5 0E6AAEBDD5 → **= HEAD r130** |
| `PHASE7-COORDS.md` | 15 878 Б, MD5 4B9ECF25B8 → **= HEAD r130** |
| `PHASE7-UI-SIZES.md` | 16 889 Б, MD5 D5815E815C → **= HEAD r130** |
| Полнота HEAD | 750 tracked-файлов: **0 отсутствуют** (749 совпали по размеру, 1 — `qa/quality-all-report.json`, артефакт регенерирован) |
| Git в пакете | ветка `agent/ui-redesign`, ref = **abccbfd (r130)**; reflog r128→r129→r130 |
| Расхождение | `START-HERE-r55.txt` устарел (r55, «1532 теста»); отчёт внутри пакета — без r130-секции → пакет пересобрать после сдачи |

## 5. Что обновлено в этой ревизии

| Файл | Что |
|---|---|
| `RELEASE-QUALITY-FINAL.md` | шапка-указатель на r130 + новый раздел «ОБНОВЛЕНИЕ r130 (UI/данные) — финальная регрессия» (10 подразделов: сводка, node-тесты, Python, A1–A8, IFC, пакет, UI/данные, xbin, расхождения, итог) |
| `qa/quality-baseline.json` | CI-baseline E2 переснят с r111 на **v5/r130** (метрики из baseline инструмента, без абсолютных путей) |
| `qa/quality-all-report.json` | пересобран на r130 (default `run-quality-all.py --save-baseline`) |
| `tools/scan2bim-py/quality-baseline.json` | переподписан r130-прогоном (метрики v5 те же, обновлён `created_at`) |
| `PHASE5-FINAL-r131.md` | этот файл |

Новые/промежуточные артефакты (не в git): `_scratch\r130-clean` (чистый worktree abccbfd),
`_scratch\check-package-r130.py`, `_scratch\release-r130-section.md`; логи и JSON — в
`D:\BIM-TWIN-TEST\quality\`: `node-test-r130-clean-run{1,2}.log`, `node-test-r130-run{1,2}.log` (грязное),
`r130-clean-*.log`, `run-quality-all-r130.log`, `validate-*.json`, `package-check-r130.json`.

**Коммит не делался** (по заданию). Движок/рендеры в этой задаче не правились.

## 6. Расхождения и открытые пункты

1. **Грязное дерево r131/r132** — в момент прогона изменялись 12 файлов и добавлялись новые
   тесты; r130-замеры сняты на чистом worktree. Это же изменение (`lixel-scan2bim-docs.js`)
   объясняет один из двух единичных dirty-фейлов.
2. **Пакет**: содержимое = r130 (все файлы и хэши), но `START-HERE-r55.txt` и имя `r55-full`
   описывают r55/r1532; `RELEASE-QUALITY-FINAL.md` внутри пакета — 48 661 Б без r130-секции.
   Требуется пересборка пакета (или замена в нём отчёта/START-HERE) после сдачи этого отчёта.
3. **IFC georef для v5**: артефакт `py2-final-v5-r131-georef.ifc` валиден (0 ERROR), но создан
   параллельной задачей r131; в r130-генераторе флага `--georef` нет. Если релиз собирается на
   r131 — использовать его; если строго на r130 — georef для v5 не перегенерируется этим HEAD.
4. **xbin-проверка чистки** — PASS по отчёту `XBIN-CLEAN-VERIFY.md` (21 182 Б, 17:57):
   сборка из `.xbin` геометрически совпала с `map.las` (99,36 % клеток ±5 см, пол −0,218 м),
   толщина/шум в пределах шума, чистка удалила 97 % динамики; плотность ниже в 3,31× из-за
   пресета; 4 точечных предложения (§6 отчёта) — вход в r132; код приложения/UI не менялся.
5. **r74-флак** — только под нагрузкой/при параллельных правках; в чистых прогонах 0 fail
   (2 из 2). Рекомендация: изолировать r74 в финальной приёмке.
