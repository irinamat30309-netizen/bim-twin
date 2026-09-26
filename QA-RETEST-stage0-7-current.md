# BIM TWIN — повторная проверка плана этапов 0–7

## База и объём

- Рабочая копия создана из review-ветки `agent/windows-package-qa`, исходный HEAD `2cea8798fcd140c80569891103df08f8a40041d3`; зависимости установлены заново по lock-файлу.
- Локальная среда: Linux, Node `v24.14.1`, npm `11.11.0`. Это чистая Git worktree, не Windows installer и не целевой GPU стенд.
- Этот прогон обновляет автоматическую регрессию и её QA-покрытие. Он не является независимой геодезической, CAD/GIS или пользовательской приёмкой.

## Повторные результаты

| Этап/проверка | Результат |
|---|---|
| Stage 0 — `MARKET-FEATURE-MATRIX.md` и критерии готовности | Документы существуют и задают проверяемые статусы; новый программный тест для этого документального этапа не требуется |
| Stage 1 — новые автономные synthetic fixtures | **16 всего / 14 passed / 0 failed / 2 user-fixture skips**: временные LAS и PLY комнаты проходят round-trip и проверку 4 стен, проёма, площади, высоты и колонны; 600 000-точечный binary PLY проверяет streaming и детерминированную budget sampling |
| Stage 2 focused | **31/31 passed** |
| Stage 3 focused | **41/41 passed** |
| Stage 4 focused | **81/81 passed** |
| Stage 5–7 focused | **103/103 passed** |
| Полный `node --test --test-reporter=tap` | **883 total / 876 passed / 0 failed / 7 skipped** |
| `npm run check` | passed |
| `node scripts/check-syntax.mjs` | passed, **241 JS/MJS/CJS files** |
| `node --check pointcloud-ply-io.js` | passed |
| `python scripts/check-python-syntax.py` | passed, **27 Python source files** |
| `npm run test:store` | passed: `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| Windows Actions на родительском commit `2cea879` до QA-правки | **4/4 passed**: `test`, `windows-test`, два `windows-package`; повторный hosted run после этой QA-правки ожидает push |
| Приватный Windows hardware-QA run #7 | По скриншоту пользователя workflow завершился успешно за 5:09; шаги regression, сборки NSIS/ASAR и проверки ASAR зелёные. Точный адаптер/renderer и VRAM stress по сводному скриншоту не подтверждаются |

## Что исправлено в проверках

1. Windows workflow компилировал `scan2bim-ai-server/app` и отсутствующий каталог `scan2bim-ai-server/tests`, пропуская Python-файлы в `ai/`, `tools/`, `server.py` и `test_*.py`. Вместо этого он запускает `scripts/check-python-syntax.py`, который разбирает все tracked Python sources без создания `.pyc`.
2. Scan-to-BIM room regression больше не зависит от отсутствующих файлов в `QA-artifacts`: LAS и PLY создаются во временной папке из аналитической комнаты с известной геометрией и удаляются после теста.
3. Добавлен автономный large-PLY parser regression на 600 000 синтетических точек: повторный parse даёт одинаковую выборку, количество и атрибуты.

## Пропуски полного набора

Семь пропусков не являются падениями:

- 4 LAZ проверки требуют отсутствующие компактные LAZ fixtures;
- 2 проверки требуют пользовательские OBJ/STL и большой PLY из каталога `BIM_TWIN_USER_FIXTURES`;
- 1 physical-GPU smoke намеренно пропускается вне приватного self-hosted Windows GPU runner. В run #7 этот workflow был запущен на нём, но сводный скриншот не содержит device/renderer log.

## Статус этапов и незакрытые gates

- **Stage 0:** закрыт по существующей рыночной матрице и определению готовности.
- **Stage 1:** synthetic CI-покрытие улучшено; не закрыт лицензированный эталонный corpus, полный semantic click-smoke и независимые readers/reference data.
- **Stage 2:** повторные тесты проекта/store прошли в заявленной Linux/JSON/SQLite области. Это не проверка аппаратного power-loss, Windows ACL и чистой установки.
- **Stage 3:** остаются COPC, PTX grid/missing-return восстановление на реальном приборном corpus, полные ancillary/extra fields, reprojection/vertical datum и внешняя CAD/BIM/GIS приёмка.
- **Stage 4:** остаются full-cloud/out-of-core операции для остальных форматов, persistent/resumable stores, pressure/cold-repeat tests, большие benchmark и целевые GPU/VRAM.
- **Stage 5:** остаются feature/target/global initialization, pose graph/loop closure/fusion, измеренный mutual overlap и UI JSON-report end-to-end acceptance на независимых check points.
- **Stage 6:** остаются EPSG/vertical-datum/geoid engine, проверенные RTK/PPK/trajectory adapters и независимые control/check координаты с заданными горизонтальными и вертикальными допусками.
- **Stage 7:** остаются versioned annotated corpus, precision/recall/F1, полноценные semantic AI/object removal, stream-aware editing и поддержка произвольных LAS extra bytes.

**Вывод:** повторные программные проверки зелёные, а два автономных fixture-пробела закрыты. Этапы 0 и 2 подтверждены в оговорённой области; этапы 1 и 3–7 всё ещё частичные. Переход к следующему этапу нельзя честно объявить завершённым только по synthetic/unit tests: для перечисленных gates нужны соответствующие данные, лицензии, целевой Windows/GPU стенд и внешние контрольные программы.