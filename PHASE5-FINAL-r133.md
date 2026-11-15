# PHASE5-FINAL-r133 — финальный инфраструктурный пункт: CI-гейт (локальный прогон + эмуляция workflow)

Дата: 2026-11-15, 18:50 (Europe/Kiev). База: HEAD **`c2e3da2` (r132)**, ветка `agent/ui-redesign`.
Push в GitHub **не выполнялся**; процедура CI прогнана реально локально + эмуляция шагов YAML.
Отчёты-спутники: `PHASE5-CI-r133.md` (детали CI), `RELEASE-QUALITY-FINAL.md` (раздел r132 + CI r133).

## 0. Итог одной строкой

`ci-quality.ps1` — 4/4 сценария exit 0 (PASS 45 / FAIL 6 — только историческая r107; v5 чист);
`quality.yml` — **PASS 26/26** статических проверок и **9/9** шагов локальной эмуляции;
пакет `bim-twin-r55-full.zip` соответствует HEAD r132 **766/766 tracked-файлов** (0 расхождений
по содержимому), но требует пересборки после обновления отчёта. Не коммитил.

## 1. CI-гейт: реальные прогоны (без push)

Логи: `D:\BIM-TWIN-TEST\quality\ci-quality-r133-{strict,allow,targets,missing}.log`.

| Сценарий | Код | PASS/FAIL/SKIP | REG | Целевых FAIL | Исторических FAIL | Итог |
|---|---|---|---|---|---|---|
| strict (`-Root D:\BIM-TWIN-TEST`) | **0** | 45 / 6 / 0 | 0 | 0 | 6 (r107) | OK |
| `--allow-missing` (данные есть) | **0** | 45 / 6 / 0 | 0 | 0 | 6 | OK |
| `--targets` | **0** | 45 / 6 / 0 | 0 | 0 | 6 | OK* |
| без данных (`--allow-missing`, пустой root) | **0** | 0 / 0 / 2 | 0 | 0 | 0 | OK (SKIP) |

\* `--targets` печатает 6 `[HISTORY]` (A1–A6 модели r107), `koridor/final` (v5) — 0 FAIL;
по дизайну историческая baseline-запись не гейтится даже с `--targets` (только `[TARGET]`-записи).
Ожидание Lead «ругаться на исторические, а не на v5» — подтверждено по содержимому вывода;
если нужно ронять сборку и на исторических FAIL — это отдельное изменение политики гейта.

Разбивка strict: `koridor/baseline-r107` PASS 2 / FAIL 6; `koridor/final` **PASS 8 / FAIL 0**;
`facade/map-120` 16/0, `facade/map-window` 14/0, `facade/map-crop20` 5/0.

## 2. `.github/workflows/quality.yml`: статическая валидация

`_scratch\validate-workflow-r133.js` (js-yaml 4.3.2) → `D:\BIM-TWIN-TEST\quality\workflow-validation-r133.json`
— **PASS 26 / FAIL 0**. Проверено: YAML-парсинг; `workflow_dispatch` (input `enforce_targets`:
boolean/default false), `pull_request`, `push.paths` (5 путей), `schedule` cron `30 2 * * *`;
permissions/concurrency; job `quality` на `windows-latest`, timeout 30; 9 шагов; версии
`actions/checkout@v4`, `actions/setup-python@v5` (3.12), `actions/setup-node@v4` (20),
`actions/upload-artifact@v4`; `pip install ifcopenshell open3d shapely numpy pillow` + import;
data-detect (`BIMTWIN_TEST_ROOT`/`D:\BIM-TWIN-TEST`); strict/no-data ветки; job summary
(`qa\quality-runs\quality-all-report.json` → `GITHUB_STEP_SUMMARY`); upload-artifact пути
(`qa/**`, `**/*RULER*.json`, `**/*ruler*.json`, `RELEASE-QUALITY-FINAL.md`, `if-no-files-found: warn`);
все run-шаги `shell: pwsh`; все ссылки на файлы/данные существуют.

## 3. Локальная эмуляция шагов workflow

`_scratch\emulate-workflow-r133.ps1` (PS 5.1, UTF-8 BOM) → `workflow-emulation-r133.json`,
лог `workflow-emulation-r133.log` — **PASS 9 / FAIL 0**.

| № | Шаг workflow | Локальный результат |
|---|---|---|
| 1 | Checkout | PASS — HEAD `c2e3da2` (в дереве правки параллельных задач; в CI — чистый checkout) |
| 2 | Setup Python 3.12 | PASS — Python 3.12.14 |
| 3 | Setup Node 20 | PASS (адаптация) — локально v24.20.0; CI ставит 20 |
| 4 | Install deps | PASS — pip upgrade/install/import все exit 0 |
| 5 | Locate data | PASS — present=true, root=D:\BIM-TWIN-TEST |
| 6 | Strict quality gate | PASS — exit 0 за 47,7 с; PASS 45 / FAIL 6 / SKIP 0 |
| 7 | No-data gate | PASS — exit 0; SKIP 2 (пустой root как имитация отсутствия данных) |
| 8 | Job summary | PASS — 13 строк Markdown, 5 записей, PASS 45 / FAIL 6 / SKIP 0 |
| 9 | Upload artifacts | PASS — 18 qa-файлов, 9 ruler-json, RELEASE-QUALITY-FINAL.md на месте |

`qa\quality-runs\` после проверки удалён (артефакт прогона). Копии — `D:\BIM-TWIN-TEST\quality\ci-r133\emulated\`.

## 4. Пакет `bim-twin-r55-full.zip` (сверка с tracked HEAD r132)

Файл: 55 597 051 Б (53,0 МБ), 15.11 18:17:27, **1377 записей** (1250 в `bim-twin-r55/` +
screenshots 112, screenshots-docs 13, docs 1, START-HERE-r55.txt). Скрипт:
`_scratch\check-package-r133.py`; JSON: `D:\BIM-TWIN-TEST\quality\package-check-r133.json`.

| Проверка | Результат |
|---|---|
| `git ls-files` HEAD r132 | **766 файлов** |
| Совпадают по размеру+MD5 в пакете | **766 / 766** (0 missing, 0 mismatch) |
| `RELEASE-QUALITY-FINAL.md` в пакете | байт-в-байт = HEAD r132 (69 676 Б) ✓ |
| Новые файлы r131/r132 | `XBIN-CLEAN-VERIFY.md`, `XBIN-FACADE-CLEAN.md`, `IFC-FINAL-r131.md`, `IFC-FINAL-r132.md`, `PHASE4-EDITOR-V5.md`, `PHASE5-FINAL-r131.md`, `PHASE6-DOCS-UI-r131.md`, `QUALITY-SCORECARD-r119.md` и др. — на месте ✓ |
| `START-HERE-r132.txt` | внутри `bim-twin-r55/` (1165 Б, BOM), «релиз r132», тесты **1708/1704**, python-тесты ✓ |
| Git внутри пакета | ветка `agent/ui-redesign`, ref = **`c2e3da2` (r132)** |
| Пакет-специфичные (не tracked) | только `START-HERE-r132.txt` (осознанно, README релиза); `.git/` и `__pycache__/` — служебные |

### Расхождения пакета (перечислить)

1. **Устаревший верхнеуровневый `START-HERE-r55.txt`** в корне архива: «ревизия 55»,
   «коммит 68b9e00 r55», «1532 теста»; при этом актуальный `bim-twin-r55/START-HERE-r132.txt`
   внутри есть. Имя пакета `r55-full` — тоже о старой ревизии.
2. **Пакет собран до обновления r133-отчёта**: `RELEASE-QUALITY-FINAL.md` в пакете = HEAD r132,
   но без новых разделов r132/r133 (после пересборки/замены отчёта станет актуален);
   `PHASE5-CI-r133.md` и `PHASE5-FINAL-r133.md` в пакет не входят.
3. Содержимое tracked-файлов расхождений **не имеет** (766/766) — это главный результат проверки.

## 5. `node --test` r132 (контекст; ресурсный дефицит среды)

Чистый worktree HEAD r132, первый прогон: 1708 тестов / 1703 pass / 1 fail / 4 skipped
(103,1 с). FAIL — `r56-refine-tiles` («потоков: 1»): в момент прогона параллельная задача
держала python-процесс 21,9 ГБ, `os.freemem()` = 0,19 ГБ, и `pickThreads()` по дизайну урезает
потоки по свободной памяти (→ 1) — ресурсная флака среды, не регрессия r132.
**Повторный прогон** после освобождения памяти (freemem 1,56 ГБ): isolated `r56` — PASS (8,1 с),
полный набор — **1708 / 1704 pass / 0 fail / 4 skipped** (94,5 с; `node-test-r132-clean-retry.log`).
Заявленные в r132 **1708/1704/0 подтверждены**. Рекомендация: в CI/приёмке не запускать тяжёлые
импортёры параллельно с `node --test` (или закреплять `threads` в тесте r56).

## 6. Что обновлено

| Файл | Что |
|---|---|
| `RELEASE-QUALITY-FINAL.md` | шапка-указатель на r132 + новый раздел «ОБНОВЛЕНИЕ r132 (xbin-чистка, IFC UTF-8/PSet, snap с поворотом, панели) + CI r133» (сводка r132, CI, расхождения, итог) |
| `PHASE5-CI-r133.md` | новый: CI-прогоны, валидация workflow (26/26), эмуляция шагов (9/9), ограничения |
| `PHASE5-FINAL-r133.md` | этот файл: сводка r133 + пакет + node-тесты + расхождения |
| `qa/quality-runs/**` | создавались прогонами и **удалены** после проверки (артефакты, не коммитятся) |

Новые скрипты (вне git, `_scratch\`): `validate-workflow-r133.js`, `emulate-workflow-r133.ps1`,
`check-package-r133.py`, `release-r132-section.md`, `patch_release_r132.py`.

## 7. Ограничения

* Node 20 локально нет — эмуляция CI на v24.20.0; в workflow ставится Node 20.
* GitHub Actions (`uses: actions/*@v4/v5`) проверены по имени/версии и структуре, но не
  скачивались (нет push в GitHub; сеть для runner не эмулировалась).
* Строгий гейт требует self-hosted runner с `D:\BIM-TWIN-TEST`; на GitHub-hosted пойдёт
  ветка `--allow-missing` (SKIP допустим, проверяется целостность скрипта/эталона).
* Исторические FAIL модели r107 не гейтятся (`[HISTORY]`) — политика прежняя.
* В момент проверки дерево содержало правки параллельных задач r133 (`xbin-lidar.js`,
  `test/r133-*.test.js`, `GEOREF-r133.md`) — на результаты CI/пакета не влияли (пакет сверялся
  с tracked-файлами HEAD; CI запускался на текущем дереве, где все tracked-файлы HEAD целы).
