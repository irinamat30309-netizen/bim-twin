# PHASE5-E2 — регрессия качества scan-to-BIM в CI (E2, Фаза 5 ROADMAP-IDEAL)

Дата: 2026-11-15, 13:41 (Europe/Kiev). База: HEAD **`f67920b` (r113)**, ветка
`agent/ui-redesign`; изменения этой задачи **не закоммичены**.
Среда локальной проверки: Windows PowerShell **5.1.19041.6456**, Python **3.12.14**
(DSH-рантайм), Node v24.20.0 локально (в workflow — Node 20), `ifcopenshell 0.9.0.post1`.
Данные: `D:\BIM-TWIN-TEST` (в репозиторий не входят).

Новые файлы задачи:

| Файл | Размер | MD5 | Назначение |
|---|---|---|---|
| `tools\scan2bim-py\ci-quality.ps1` | 15 674 Б | `D26B65A012F63DFB65E66496C8071D55` | гейт: `run-quality-all.py` + baseline + политика exit code |
| `.github\workflows\quality.yml` | 6 596 Б | `57948EC0A715828CE4ED31C25D55BA1D` | CI-workflow (Windows runner, Python 3.12, Node 20) |
| `qa\quality-baseline.json` | 2 932 Б | `C1332668D3BB370E1EF669D2C5A5D7AD` | эталон регрессии для CI (метрики r111, без абсолютных путей) |
| `PHASE5-E2.md` | — | — | этот отчёт |

## 1. Как устроен гейт `ci-quality.ps1`

`ci-quality.ps1` запускает `tools/scan2bim-py/run-quality-all.py` с эталоном
`qa\quality-baseline.json` (ключ `--baseline`, **без** `--save-baseline` — CI никогда не
меняет эталон), печатает таблицу, которую строит сканер, затем разбирает JSON-отчёт и
применяет политику.

Ключи (принимаются и `--opt value`, и `-Opt value`, и `--opt=value`; формат совместим
с `powershell -File`):

| Ключ | По умолчанию | Что делает |
|---|---|---|
| `--python PATH` | `BIMTWIN_PYTHON` → DSH-рантайм → `python` из PATH | интерпретатор Python |
| `--root PATH` | `BIMTWIN_TEST_ROOT` → `D:\BIM-TWIN-TEST` | корень данных (облака/модели/метрики) |
| `--baseline PATH` | `qa\quality-baseline.json` | эталон регрессии |
| `--report PATH` | `qa\quality-runs\quality-all-report.json` | JSON-отчёт прогона |
| `--workdir PATH` | `qa\quality-runs` | JSON-обмеры `ruler-v2.py` и логи |
| `--targets` | выкл. | дополнительно гейтить **абсолютные пороги ROADMAP** (A1–A8) |
| `--allow-missing` | выкл. | отсутствующие облака/модели/метрики → SKIP, не падать |
| `--help` | — | справка |

Политика exit code:

| Код | Когда |
|---|---|
| **0** | регрессий нет (и, в строгом режиме, нет SKIP). Известные целевые FAIL A2/A3/A6 печатаются, но **не** гейтятся (E2 = падение при ухудшении метрик) |
| **1** | есть `REG`-провал относительно baseline; **или** `--targets` и есть целевой FAIL; **или** без `--allow-missing` есть SKIP (нет облаков/моделей/метрик); **или** `run-quality-all.py` не выполнил пороги-цели при `--targets` |
| **2** | ошибка окружения: нет Python/ruler-v2.py/baseline, JSON-отчёт не создан/не разобран |

Детали политики:

* **Что такое REG** — метрика ухудшилась относительно `qa\quality-baseline.json` больше
  допуска: покрытие/периметр/полнота/точность (падение), толщина/высота/наложения
  (рост), площадь/пол (уход от коридора 95–102 %), см. `REGRESSION_METRICS` в
  `run-quality-all.py`.
* **Целевые FAIL** (`A1–A8`, фасад `B2–B4`) по умолчанию только отображаются в таблице —
  иначе гейт был бы постоянно красным из-за ещё не закрытых A2/A3/A6 и перестал бы
  сигналить о регрессиях. Для релизной приёмки включается `--targets`.
* **Историческая модель** `koridor/baseline-r107` — контрольная точка обмера: её целевые
  FAIL помечаются `[HISTORY]` и **никогда не гейтятся**; REG по ней гейтится (это дрейф
  данных/обмерщика).
* Строгий режим по умолчанию: если данные доступны, каждый пункт манифеста должен быть
  реально измерен (SKIP = FAIL) — иначе «зелёный» CI без данных маскировал бы отсутствие
  проверки. `--allow-missing` — для PR/fork-ов без данных.
* Артефакты прогона: отчёт `qa\quality-runs\quality-all-report.json`, лог
  `qa\quality-runs\ci-quality.log`, JSON-обмеры `qa\quality-runs\*-ruler.json`.

## 2. Workflow `.github/workflows/quality.yml`

Триггеры:

| Триггер | Параметры | Поведение |
|---|---|---|
| `workflow_dispatch` | input `enforce_targets` (bool, по умолчанию `false`) | ручной прогон; `true` → `--targets` (релизный гейт) |
| `pull_request` | — | гейт регрессии; без данных — `--allow-missing` (зелёный) |
| `push` | paths: `tools/scan2bim-py/**`, `renderer/scan2bim.js`, `test/**`, `qa/**`, `.github/workflows/quality.yml` | гейт на изменениях качества/движка/тестов/эталона |
| `schedule` | cron `30 2 * * *` (nightly) | строгий режим, **если** на runner есть данные; иначе `--allow-missing` + warning |

Job `quality` (`runs-on: windows-latest`, `timeout-minutes: 30`, `permissions: contents: read`,
concurrency `quality-<workflow>-<ref>` с отменой устаревших):

1. `actions/checkout@v4`;
2. `actions/setup-python@v5` — Python **3.12**;
3. `actions/setup-node@v4` — Node **20** (по требованию; текущий гейт Python-only, Node
   нужен для будущих JS-проверок);
4. `pip install --upgrade pip` → `pip install ifcopenshell open3d shapely numpy pillow`
   (гейту из этого нужны `numpy`/`shapely` для `ruler-v2.py` и `ifcopenshell` для
   валидации IFC; `open3d`/`pillow` — из требования, для движка/рендера в будущем);
5. **Locate BIM-TWIN-TEST data**: ищет `BIMTWIN_TEST_ROOT` или `D:\BIM-TWIN-TEST` с
   подпапкой `interior`; выставляет `present/root` в `$GITHUB_OUTPUT`; если данных нет —
   `::warning::` (гейт без метрик);
6. **Quality regression gate (strict, data present)** — `ci-quality.ps1 -Root <root>`
   (+`--targets` при `enforce_targets=true`); любой ненулевой код валит job;
7. **Quality regression gate (no data: SKIP allowed)** — `ci-quality.ps1 --allow-missing`;
8. **Job summary (quality table)** — `$GITHUB_STEP_SUMMARY`: created_at, root, summary
   PASS/FAIL/SKIP, таблица по проверкам (всегда, `if: always()`);
9. **Upload quality artifacts** — `actions/upload-artifact@v4`, `qa/**`,
   `**/*RULER*.json`, `**/*ruler*.json`, `RELEASE-QUALITY-FINAL.md`, `retention-days: 30`.

Workflow провалидирован синтаксически (`node -e "require('js-yaml').load(...)"` — parse OK,
9 шагов, 4 триггера). Реальный прогон GitHub Actions из этой среды не выполнялся.

## 3. Эталон `qa/quality-baseline.json`

* Содержимое: записи манифеста `koridor/baseline-r107` и `koridor/final` с метриками r111
  (модель `py2-final-v2.json`, MD5 `A62BE6D51464`): покрытие 94/25 %, толщина 10/p90 61 мм,
  высота 2 мм, периметр 97,7 %, площадь 95,9 %, проёмы 92/100 %, наложения 0,4 м².
* **Без абсолютных путей** к облакам/моделям (в отличие от
  `tools/scan2bim-py/quality-baseline.json`) — можно запускать на любом runner.
* Обновление — осознанное, вручную (CI пишет `--save-baseline` запрещено):
  1. локально прогнать `python tools\scan2bim-py\run-quality-all.py --save-baseline`
     (обновит `tools\scan2bim-py\quality-baseline.json`);
  2. перенести `entries["koridor/baseline-r107"].metrics` и `entries["koridor/final"].metrics`
     в `qa\quality-baseline.json` (без полей `model`/`cloud`), обновить `_meta.revision`;
  3. закоммитить baseline вместе с релизом — иначе следующий CI-прогон сравнит с устаревшим
     эталоном (сам гейт об этом не предупредит).

## 4. Локальная проверка (Windows PowerShell 5.1)

Все прогоны — команда из задания:
`powershell -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 [ключи]`.
Полные логи (не коммитятся): `D:\BIM-TWIN-TEST\quality\ci-quality-*.log`.

| # | Сценарий | Ключи | Exit | Итог |
|---|---|---|---|---|
| A | Строгий, данные есть | — | **0** | REG 0; PASS 22 / FAIL 9 (из них целевых 3: A2/A3/A6; исторических 6 — модель r107) |
| B | `--allow-missing`, данные есть | `--allow-missing` | **0** | то же (allow-missing влияет только на SKIP) |
| C | Нет данных, строгий | `--root D:\...\__no_data__` | **1** | `строгий режим: 2 SKIP` |
| D | Нет данных, allow-missing | `--allow-missing --root ...` | **0** | `ИТОГ: OK (0)` |
| E | Абсолютные пороги | `--targets` | **1** | `целевые пороги ROADMAP не выполнены: 3` (A2/A3/A6) |
| F | Негативный тест baseline (искусственный эталон) | `--baseline <bad>` | **1** | 2 REG: покрытие 99,00→94,00 %; толщина p90 30,00→60,80 мм |
| G | Справка | `--help` | **0** | usage/16 строк |

Ключевые фрагменты вывода.

A. Строгий прогон с данными (шапка и сводка):

```
 ci-quality.ps1 — quality regression gate (Phase 5 / E2, ROADMAP-IDEAL)
 repo:        C:\Users\bob\Documents\deepseek-harness\default-workspace\bim-twin
 python:      C:\Users\bob\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
 data root:   D:\BIM-TWIN-TEST
 baseline:    ...\bim-twin\qa\quality-baseline.json
 mode:        regression only (targets shown, not gated); missing data: STRICT (SKIP = FAIL)
 ...
 проверок: PASS 22 | FAIL 9 | SKIP 0
 регрессии (REG): 0 | целевые FAIL: 3 | исторические FAIL: 6 | ошибок прогона: 0
  [TARGET] koridor/final :: Покрытие стен облаком [A2] — медиана 94 %, мин 25 % (<60)
  [TARGET] koridor/final :: Толщина стен vs облако [A3] — медиана 10 мм, p90 61 мм (>40), макс 121 мм
  [TARGET] koridor/final :: Помещения вне пола / наложения [A6] — вне пола 0.9 %, наложение 0.4 м²
 ИТОГ: OK (0) — регрессий нет; известных целевых FAIL 3 (гейт отслеживает регресс, не абсолютные пороги)
```

C. Нет данных, строгий режим → честный FAIL:

```
 проверок: PASS 0 | FAIL 0 | SKIP 2
 ИТОГ: FAIL (1) — строгий режим: 2 SKIP — отсутствуют облака/модели/метрики;
       используйте --allow-missing для PR без данных
```

D. Нет данных, `--allow-missing` → зелёный:

```
 проверок: PASS 0 | FAIL 0 | SKIP 2
 ИТОГ: OK (0)
```

F. Негативный тест (искусственно завышенный эталон) — гейт ловит ухудшение:

```
 [REG] koridor/final :: покрытие, медиана, % [REG] — 99.00 → 94.00 (Δ -5.00, допуск 0.50)
 [REG] koridor/final :: толщина, p90 ошибки, мм [REG] — 30.00 → 60.80 (Δ +30.80, допуск 2.00)
 ИТОГ: FAIL (1) — регрессия относительно baseline: 2
```

## 5. Ограничения и что осталось

1. **Данные облаков не в репозитории.** GitHub-hosted `windows-latest` не имеет
   `D:\BIM-TWIN-TEST`, поэтому штатный PR-прогон идёт с `--allow-missing`: он проверяет
   целостность гейта/эталона/манифеста и печатает SKIP-таблицу, но **не измеряет метрики**.
   Настоящий строгий гейт возможен только на self-hosted Windows runner с этими данными
   (или с `BIMTWIN_TEST_ROOT`): заменить `runs-on: windows-latest` на метку self-hosted
   runner-а. Это единственное, что осталось для «настоящего» E2 в CI.
2. **Nightly** на hosted runner тоже уйдёт в `--allow-missing` (зелёный + warning).
   На self-hosted с данными nightly будет строгим автоматически (детект данных в шаге 5).
3. **Абсолютные пороги A2/A3/A6 ещё не закрыты**, поэтому `--targets` (релизный гейт)
   красный: A2 мин 25 %, A3 p90 61 мм, A6 0,9 %/0,4 м². Это ожидаемо и отражено в
   `RELEASE-QUALITY-FINAL.md`; E2-гейт регрессии при этом зелёный.
4. **open3d в `pip install`** гейту не нужен (только numpy/shapely/ifcopenshell/pillow);
   оставлен по требованию задания. Если wheel под Python 3.12 на runner-е окажется
   недоступен — можно убрать `open3d` из шага, гейт не сломается.
5. **Первый прогон в GitHub Actions** из этой среды невозможен (нет доступа к CI);
   workflow проверен синтаксически и по шагам, гейт — локально в обоих режимах.
   После push нужно посмотреть логи первого run и, при необходимости, включить
   `enforce_targets` вручную для релизного прогона.
6. **Локальный прогон создаёт `qa\quality-runs\**`** (отчёт, логи, ruler-JSON) — это
   артефакты, их не коммитим; в CI они уезжают в upload-artifact. Эталон
   `qa\quality-baseline.json` — наоборот, коммитится.
7. **Node 20** в workflow установлен по требованию, но текущие шаги его не используют
   (гейт Python-only); добавлен на будущее (JS-проверки `node --test` и т.п.).
8. **Изменение статуса E2 в итоговом отчёте** (`E2: PARTIAL → PASS`) — по указанию Lead
   в финале, `RELEASE-QUALITY-FINAL.md` сейчас не трогался.

## 6. Воспроизведение

```powershell
$py = "C:\Users\bob\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
Set-Location bim-twin

# A) строгий гейт (данные есть): ожидается exit 0 при отсутствии регрессий
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1

# B) PR/fork без данных
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 --allow-missing

# C/D) имитация отсутствия данных
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 --root D:\BIM-TWIN-TEST\__no_data__
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 --allow-missing --root D:\BIM-TWIN-TEST\__no_data__

# E) релизный гейт с абсолютными порогами ROADMAP
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 --targets

# F) негативный тест гейта: искусственный «плохой» baseline
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 `
  --baseline C:\Users\bob\Documents\deepseek-harness\default-workspace\_scratch\ci-baseline-bad.json

# Синтаксическая проверка workflow (js-yaml из node_modules)
node -e "const y=require('js-yaml'),f=require('fs');const d=y.load(f.readFileSync('.github/workflows/quality.yml','utf8'));console.log('YAML OK:',Object.keys(d.on),d.jobs.quality.steps.length+' steps')"
```

## 7. Итог

Инструмент E2 готов и проверен локально в обе стороны: **зелёный** при отсутствии
регрессий (и при отсутствии данных с `--allow-missing`), **красный** при регрессии
(негативный baseline), при строгом отсутствии данных и при `--targets` с незакрытыми
A2/A3/A6. Workflow `quality.yml` подключает это к PR/push/nightly/manual на Windows,
устанавливает зависимости, публикует таблицу в job summary и загружает артефакты.
Для «настоящего» CI-гейта осталось только прогнать его в GitHub Actions на runner-е
с данными BIM-TWIN-TEST (self-hosted) — кодом это уже поддержано (`BIMTWIN_TEST_ROOT`
или `D:\BIM-TWIN-TEST` + автодетект).
