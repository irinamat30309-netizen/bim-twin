# BIM TWIN — повторная проверка плана этапов 0–7

## База и объём

- QA-правки, synthetic fixtures и запрос high-performance NVIDIA WebGL опубликованы в review-ветке `agent/windows-package-qa`; GPU-код проверен на commit `4c6cddeede0ea05387afdb028341de59f5b46a60`. GitHub Actions на этом head завершились **4/4 passed** (`test`, `windows-test`, два `windows-package`); hosted runners пропускают self-hosted physical-GPU smoke.
- Локальная среда: Linux, Node `v24.14.1`, npm `11.11.0`. Это чистая Git worktree, не Windows installer и не целевой GPU стенд.
- Этот прогон обновляет автоматическую регрессию и её QA-покрытие. Он не является независимой геодезической, CAD/GIS или пользовательской приёмкой.

## Повторные результаты

| Этап/проверка | Результат |
|---|---|
| Stage 0 — `MARKET-FEATURE-MATRIX.md` и критерии готовности | Документы существуют и задают проверяемые статусы; новый программный тест для этого документального этапа не требуется |
| Stage 1 — автономные synthetic fixtures | Room LAS/PLY — **4/4**; 600 000-точечный binary PLY streaming/sampling — **1/1**; временные файлы удаляются после теста |
| Ранее предоставленные OBJ/STL и большой PLY | **12/12 passed** локально с fixture mount; исходные файлы не добавлены в Git |
| LAZ 1.2/1.4 decoder + decimation + compactness | **5/5 passed** на новых synthetic fixtures |
| Stage 2 focused | **31/31 passed** |
| Stage 3 focused | **41/41 passed** |
| Stage 4 focused | **81/81 passed** |
| Stage 5–7 focused | **103/103 passed** |
| Полный `node --test --test-reporter=tap`, без пользовательских fixtures | **883 total / 880 passed / 0 failed / 3 skipped**: две проверки требуют private OBJ/STL/PLY fixtures и одна — self-hosted GPU |
| Полный набор с ранее предоставленным локальным OBJ/STL/PLY mount | **883 total / 882 passed / 0 failed / 1 skipped**: только self-hosted Windows GPU test |
| `npm run check` | passed |
| `node scripts/check-syntax.mjs` | passed, **241 JS/MJS/CJS files** |
| `node --check pointcloud-ply-io.js` | passed |
| `python scripts/check-python-syntax.py` | passed, **28 Python source files** (tracked + new non-ignored files) |
| `npm run test:store` | passed: `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| GitHub Actions на GPU-коде commit `4c6cdde` | **4/4 passed**: `test`, `windows-test`, два `windows-package`; это hosted CI, не physical-GPU acceptance |
| Приватный Windows hardware-QA run #8 | Скриншот показывает `Success`, 5:17, private workflow repo `main` @ `92c0db6`; `source_ref` и `[BIMTWIN_GPU_WEBGL]` renderer/adapter в сводке не видны, поэтому использование RTX 5070 и текущего кода не подтверждено |

## Что исправлено в проверках

1. Windows workflow компилировал `scan2bim-ai-server/app` и отсутствующий каталог `scan2bim-ai-server/tests`, пропуская Python-файлы в `ai/`, `tools/`, `server.py` и `test_*.py`. Теперь `scripts/check-python-syntax.py` разбирает tracked и новые non-ignored Python files без `.pyc`.
2. Scan-to-BIM room regression создаёт временные synthetic LAS/PLY из аналитической комнаты с известной геометрией.
3. Добавлен large-PLY parser regression на 600 000 synthetic points с детерминированной budget sampling.
4. Добавлены компактные synthetic LAZ 1.2/1.4/decimation fixtures с manifest/hash и генератором; LAZ regression test теперь 5/5. Ранее предоставленные OBJ/STL/large PLY прошли локально и остались вне Git.
5. Основные WebGL viewer contexts запрашивают `powerPreference: high-performance`; hardware smoke включает Electron high-performance GPU flags, непрерывно рисует 1 000 000 точек в течение 10 секунд и требует NVIDIA adapter вместо software renderer. Этот аппаратный вариант ждёт повторного запуска на runner пользователя.

## Пропуски полного набора

- В portable full suite без `BIM_TWIN_USER_FIXTURES` пропускаются только две проверки user-supplied OBJ/STL/large-PLY файлов и один NVIDIA hardware smoke (1 млн точек/10 с).
- При локальном подключении ранее предоставленных user fixtures обе dataset-проверки проходят; остаётся только GPU smoke вне приватного Windows runner. Исходные пользовательские файлы не копировались и не коммитились.
- Четыре прежних LAZ skips сняты compact synthetic fixtures; `test/laz-node.test.js` проходит 5/5. Room и large binary PLY regressions тоже запускаются без внешних файлов.

## Статус этапов и незакрытые gates

- **Stage 0:** закрыт по существующей рыночной матрице и определению готовности.
- **Stage 1:** synthetic CI-покрытие улучшено; не закрыт лицензированный эталонный corpus, полный semantic click-smoke и независимые readers/reference data.
- **Stage 2:** повторные тесты проекта/store прошли в заявленной Linux/JSON/SQLite области. Это не проверка аппаратного power-loss, Windows ACL и чистой установки.
- **Stage 3:** остаются COPC, PTX grid/missing-return восстановление на реальном приборном corpus, полные ancillary/extra fields, reprojection/vertical datum и внешняя CAD/BIM/GIS приёмка.
- **Stage 4:** остаются full-cloud/out-of-core операции для остальных форматов, persistent/resumable stores, pressure/cold-repeat tests, большие benchmark и целевые GPU/VRAM.
- **Stage 5:** остаются feature/target/global initialization, pose graph/loop closure/fusion, измеренный mutual overlap и UI JSON-report end-to-end acceptance на независимых check points.
- **Stage 6:** остаются EPSG/vertical-datum/geoid engine, проверенные RTK/PPK/trajectory adapters и независимые control/check координаты с заданными горизонтальными и вертикальными допусками.
- **Stage 7:** остаются versioned annotated corpus, precision/recall/F1, полноценные semantic AI/object removal, stream-aware editing и поддержка произвольных LAS extra bytes.

**Вывод:** повторные программные проверки зелёные; синтетические room/PLY/LAZ gates закрыты, а ранее предоставленные пользовательские OBJ/STL/PLY прошли локально. Этапы 0 и 2 подтверждены в оговорённой области; этапы 1 и 3–7 всё ещё частичные.
