# PHASE5-CI-r133 — CI-гейт качества: реальный локальный прогон и эмуляция workflow

Дата: 2026-11-15, 18:40 (Europe/Kiev). База: HEAD **`c2e3da2` (r132)**, ветка `agent/ui-redesign`.
Задача: закрыть последний инфраструктурный пункт E2 (CI) — **без push в GitHub**, но с реальным
локальным прогоном процедуры и эмуляцией всех шагов workflow.
Среда: Windows, Windows PowerShell 5.1, Python 3.12.14 (DSH-рантайм),
Node v24.20.0 (в CI ставится Node 20), js-yaml 4.3.2, ifcopenshell 0.9.0.post1.
Данные: `D:\BIM-TWIN-TEST` (присутствуют).

Файлы: `tools\scan2bim-py\ci-quality.ps1` (MD5 D26B65A012…), `.github\workflows\quality.yml`
(5 841 симв.; MD5 см. `workflow-validation-r133.json`), `qa\quality-baseline.json` (v5/r130+).

## 1. Реальные прогоны `ci-quality.ps1`

Команда (одинаковая база): `powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 [опции]`.
Логи: `D:\BIM-TWIN-TEST\quality\ci-quality-r133-{strict,allow,targets,missing}.log`.

| Сценарий | Опции | Код выхода | Ключевой вывод | Статус |
|---|---|---|---|---|
| strict | `-Root D:\BIM-TWIN-TEST` | **0** | PASS 45 \| FAIL 6 \| SKIP 0; REG 0; целевых FAIL 0; исторических 6 (`[HISTORY]` r107); `ИТОГ: OK (0)` | PASS |
| allow-missing | `--allow-missing -Root D:\BIM-TWIN-TEST` | **0** | то же (данные есть → полный гейт); `ИТОГ: OK (0)` | PASS |
| targets | `--targets -Root D:\BIM-TWIN-TEST` | **0** | то же + печатает 6 `[HISTORY]` (A1–A6 модели r107); v5 (`koridor/final`) — 0 FAIL; `[TARGET]`/`[REG]` — нет | PASS* |
| без данных | `--allow-missing -Root <пустой каталог>` | **0** | все записи SKIP: проверок PASS 0 \| FAIL 0 \| SKIP 2; `ИТОГ: OK (0)` | PASS |

\* Ожидание Lead «targets должен ругаться на исторические, а не на v5» — подтверждено по выводу:
единственные FAIL — 6 исторических A1–A6 контрольной модели r107, v5 чист. Код 0 — **по дизайну
скрипта**: `--targets` включает гейт абсолютных порогов для релизных записей (`[TARGET]`), а
историческая (role=`baseline`) запись r107 в гейт не входит даже с `--targets` (печатается как
`[HISTORY]`, код 0). Если политика требует ронять сборку и на исторических FAIL — это отдельное
осознанное изменение политики гейта (в код не вносилось).

Детализация strict-прогона: `koridor/baseline-r107` PASS 2/FAIL 6; `koridor/final` (v5) **PASS 8/FAIL 0**;
`facade/map-120` 16/0, `facade/map-window` 14/0, `facade/map-crop20` 5/0. Регрессий (REG) нет.

## 2. Валидация `.github/workflows/quality.yml`

Скрипт: `_scratch\validate-workflow-r133.js` (js-yaml 4.3.2). JSON: `D:\BIM-TWIN-TEST\quality\workflow-validation-r133.json` — **PASS 26 / FAIL 0**.

| Группа проверок | Результат |
|---|---|
| YAML парсится js-yaml без ошибок | PASS |
| triggers: `workflow_dispatch` (input `enforce_targets`: boolean, default false), `pull_request`, `push.paths` (5 путей), `schedule: 30 2 * * *` | PASS |
| `permissions: contents: read`, `concurrency` с cancel-in-progress | PASS |
| job `quality`: `runs-on: windows-latest`, `timeout-minutes: 30`, 9 шагов | PASS |
| actions: `checkout@v4`, `setup-python@v5` (3.12), `setup-node@v4` (20), `upload-artifact@v4` — только известные версии | PASS |
| Install deps: `pip install ifcopenshell open3d shapely numpy pillow` + import-проверка | PASS |
| Locate data: `BIMTWIN_TEST_ROOT` → `D:\BIM-TWIN-TEST`, OUTPUT `present`/`root` | PASS |
| strict-gate: `ci-quality.ps1 -Root`, при `enforce_targets` → `--targets`; условие `steps.data.outputs.present == 'true'` | PASS |
| no-data-gate: `ci-quality.ps1 --allow-missing`; условие `present != 'true'` | PASS |
| Job summary: `always()`, читает `qa\quality-runs\quality-all-report.json`, пишет `GITHUB_STEP_SUMMARY` | PASS |
| Upload artifacts: `qa/**`, `**/*RULER*.json`, `**/*ruler*.json`, `RELEASE-QUALITY-FINAL.md`, `if-no-files-found: warn`, retention 30 | PASS |
| все run-шаги `shell: pwsh`; файлы/данные, на которые ссылается workflow, существуют | PASS |

## 3. Локальная эмуляция шагов workflow (без GitHub runner)

Скрипт: `_scratch\emulate-workflow-r133.ps1` (PS 5.1, UTF-8 BOM); JSON: `D:\BIM-TWIN-TEST\quality\workflow-emulation-r133.json`;
лог: `...\workflow-emulation-r133.log` — **ИТОГ: PASS 9 / FAIL 0**.

| № | Шаг workflow | Локальная эмуляция | Результат |
|---|---|---|---|
| 1 | Checkout | `git rev-parse HEAD` в рабочем дереве | PASS — HEAD `c2e3da2` (r132), дерево содержит правки параллельных задач (в CI — чистый checkout) |
| 2 | Setup Python 3.12 | `python --version` | PASS — Python 3.12.14 (CI ставит 3.12; семейство совпадает) |
| 3 | Setup Node 20 | `node --version` | PASS (адаптация) — локально v24.20.0; Node 20 на машине нет, полный набор тестов на v24 зелёный (см. §4) |
| 4 | Install Python deps | `pip install --upgrade pip`; `pip install ifcopenshell open3d shapely numpy pillow`; import | PASS — все три команды exit 0, `numpy/shapely/ifcopenshell OK` |
| 5 | Locate data | логика из workflow + `GITHUB_OUTPUT` | PASS — `present=true`, `root=D:\BIM-TWIN-TEST` |
| 6 | Quality gate (strict, data present) | `ci-quality.ps1 -Root D:\BIM-TWIN-TEST` | PASS — exit 0 за 47,7 с; PASS 45 / FAIL 6 / SKIP 0; REG 0; исторических 6 |
| 7 | Quality gate (no data: SKIP allowed) | `ci-quality.ps1 --allow-missing -Root <пустой каталог>` | PASS — exit 0; SKIP 2 (адаптация: пустой root вместо отсутствия D:\ — иначе данные находятся) |
| 8 | Job summary | PowerShell-блок из workflow (ConvertFrom-Json → Markdown в `GITHUB_STEP_SUMMARY`) | PASS — summary 13 строк, 5 записей, `PASS 45 / FAIL 6 / SKIP 0` |
| 9 | Upload artifacts | проверка глобов `qa/**`, `**/*[Rr][Uu][Ll][Ee][Rr]*.json`, `RELEASE-QUALITY-FINAL.md` | PASS — qa-файлов 18, ruler-json 9 (в т.ч. `koridor_baseline-r107-ruler.json` и др.), RELEASE на месте |

Артефакты прогона (эмуляция): копия отчёта и `job-summary.md` —
`D:\BIM-TWIN-TEST\quality\ci-r133\emulated\`; каталог `qa\quality-runs\` после проверки удалён
(артефакт прогона, не коммитится).

## 4. `node --test` на чистом HEAD r132 (для контекста приёмки)

Чистый worktree HEAD r132 (`_scratch\r132-clean`, `node_modules` — junction):
`node --test` → **1708 тестов / 1703 pass / 1 fail / 4 skipped**, 103,1 с.
Единственный FAIL — `r56-refine-tiles` («потоков: 1»), **вызван нехваткой RAM в момент прогона**:
параллельная задача держала python-процесс на 21 ГБ, `os.freemem()` = 0,19 ГБ, а `pickThreads()`
по дизайну ограничивает число потоков свободной памятью (`byMem` при 360k/плитку = −5 → 1 поток),
поэтому `assert sa.threads >= 2` не выполнился. Это известное ресурсное поведение, а не регрессия r132.
**Повторный прогон** после освобождения памяти (freemem 1,56 ГБ): isolated `r56` — PASS (8,1 с),
полный набор — **1708 тестов / 1704 pass / 0 fail / 4 skipped** (94,5 с; лог
`node-test-r132-clean-retry.log`). Заявленные в r132 **1708/1704/0 подтверждены**; первый прогон
с 1 fail — ресурсная флака среды (память), не код. Рабочее дерево ранее: 1710/1706/0
(+2 — untracked тест параллельной задачи r133-sky-filter).

**Ограничения/риски CI:** локально нет Node 20 (эмулировано v24); действия GitHub
(`actions/*@v4/v5`) проверены по имени/версии, но не скачивались (нет push в GitHub);
строгий гейт требует self-hosted runner с `D:\BIM-TWIN-TEST` (на GitHub-hosted пойдёт ветка
`--allow-missing`); исторический baseline r107 намеренно не гейтится (HISTORY). Push в GitHub
не выполнялся.
