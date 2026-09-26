# BIM TWIN — повторная проверка этапов 5–7

## Среда и границы

- Рабочая среда: Amazon Linux 2023, Node 24, Python 3.13; это не Windows-машина.
- Повторно проверялась рабочая копия `bim-twin-publish`. Сначала 4 GitHub checks прошли на PR head `124b2d9`; после добавления smoke harness все 4 hosted checks также прошли на новом head `5f6e146` (`windows-package` ×2, `windows-test`, `test`). На hosted runner новый self-hosted-only WebGL smoke намеренно пропускается.
- По присланному пользователем скриншоту приватный ручной Windows hardware-QA run #5 прошёл: зелёные шаги hardware report, checkout, `npm ci`, syntax/store/Python checks, полный regression suite, NSIS/ASAR build, required-file verification и upload артефакта. Точный commit SHA, сведения об адаптере и полный лог в этой сессии недоступны.
- Новый Electron/WebGL runtime smoke добавлен после run #5; его реальный физический GPU результат пока ожидает следующего запуска приватного workflow.
- UI JSON-отчёта ICP не подтверждался кликом в запущенном Electron UI. Нет независимо измеренного контрольного облака/GCP-набора и внешних CAD/GIS readers для сертификации точности.
- Это reproducible unit/regression verification и ограниченная проверка Windows-сборки, не приёмка профессиональной точности, не GPU/VRAM stress-test и не подтверждение «100% функциональности».

## Результаты

| Проверка | Итог |
|---|---|
| Focused Stage 5–7 suite: `node --test test/pointcloud-ply-io-stage7.test.js test/geometry-registration-v1167.test.js test/georef-v1091.test.js test/pcedit-phase123.test.js test/pcedit.test.js test/viewer-edit-attributes-stage7.test.js test/lixel-sprints-ext-v1151.test.js test/format-roundtrip-stage3.test.js test/project-state-bridge-stage2.test.js test/multicloud-classification-restore-stage7.test.js test/webgl-octree-stream.test.js` | **103/103 passed**, 0 failed, 0 skipped; повторно подтверждено перед упаковкой обновления |
| Полный `npm test` после добавления GPU smoke | **882 total / 874 passed / 0 failed / 8 skipped**; 7 пропусков требуют optional decoder/fixtures, ещё 1 — ожидаемый пропуск real-GPU теста вне self-hosted Windows |
| `npm run check` | passed (`main.js`, `preload.js`, SQLite/JSON stores) |
| `node --check pointcloud-ply-io.js` | passed |
| `node scripts/check-syntax.mjs` | passed для **238 JS/MJS/CJS-файлов** |
| `npm run test:store` | passed: `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| `python3 -m py_compile tools/pointcloud_geometry.py` | passed; созданный `__pycache__` удалён |
| Synthetic ICP без SciPy | `numpy-exact-trimmed-icp`; 250 точек, fitness 1.0, 6 итераций, RMSE `1.30e-15`, translation error `6.34e-17` в заданной метрической synthetic-сцене |
| GitHub-hosted Windows CI (PR head `5f6e146`) | **4/4 checks passed:** `test`, `windows-test`, два `windows-package`; hosted runner не заменяет физическую GPU-проверку |
| Приватный Windows package-QA run #5 | по скриншоту пользователя все шаги зелёные, включая NSIS/ASAR build, required-file verification и upload артефакта |
| Локальный WebGL runtime smoke | **PASS только как software-WebGL draw test:** production `Viewer3DGL` загрузил 4096 точек и RGB/intensity/classification buffers, classification mode нарисовал 114229 изменённых пикселей; `glError=0`, контекст не потерян. Renderer — SwiftShader, не физическая видеокарта |
| Electron/Windows package | run #5 собрал installer и проверил обязательные файлы ASAR; установка/запуск установленного приложения на чистой Windows-машине отдельно не подтверждались |

### Что конкретно проверяет focused-suite

- Известная геопривязка регистрации с double-precision CRS координатами и обратное чтение результата.
- Deviation heatmap сохраняет frame/CRS compared облака.
- ICP round-trip сохраняет point-aligned intensity/classification и в registration output, и в deviation output.
- Robust ICP восстанавливает небольшой rigid transform на частичном перекрытии с clutter; проверяются инициализация, остатки, предел итераций.
- Отказ на некорректном trim параметре и near-zero overlap; отказ на несогласованной длине intensity и malformed classification, без частичного результата.
- Shared streaming PLY writer round-trip проверяет RGB/intensity/classification/frame metadata; length/value guards не оставляют temp-файлов; build.files содержит модуль. Редакторные ASCII/binary PLY пути (включая async autosave writer) round-trip сохраняют RGB/intensity/classification; sync и async бинарные данные совпадают byte-for-byte, некорректные длины и LAS class коды отклоняются.
- GCP проверки: weighted Helmert, независимые check-точки, downweight выброса, CSV headers/quotes/weights/roles/decimal separators и отказ на коллинеарной геометрии.
- Point editing: выравнивание всех атрибутов в kept/removed рядах, selection/section, crop/filters, undo, voxel intensity average/class majority и LAS 1.2 class field/refusal. LAS 1.4 format round-trip проверяет intensity/class значения; отдельная source-level regression проверяет, что ground-classification action прокидывает исходный intensity вместе с новыми labels.
- Добавочные Stage 7 regressions: ручной ASPRS class assignment меняет только выделенные точки; Ctrl+Z восстанавливает sparse delta или dense label snapshot и сохраняет восстановленную классификацию; отмена первой ручной разметки очищает текущую project-ссылку, не удаляя content-addressed asset. Range, empty-selection, no-op, LOD/streaming и source-count-mismatch проверки; save/clear bridge сериализует конкурирующие операции; restore point-count mismatch видимо предупреждает; clearing классификации отключает GPU attribute buffer и переключает режим цвета обратно в RGB.
- `test/webgl-runtime-smoke.test.js` запускает production `Viewer3DGL` в Electron только на self-hosted Windows runner: проверяет WebGL2, VBO точек/intensity/classification, реальный draw/readback пикселей, GL errors, context loss и признаки software fallback. Private run #5 был до добавления smoke и его ещё не проверял.

### Пропущенные тесты

Семь ресурсных пропусков текущего полного прогона связаны не с падением тестов, а с отсутствием необязательных ресурсов: три теста требуют optional LAZ decoder, один — внешние LAZ fixtures, два — загруженные полные OBJ/STL пользовательские файлы и внешний большой PLY fixture, один — synthetic room fixtures. Восьмой пропуск — новый real-GPU тест, намеренно не запускаемый в Linux/hosted-среде.

## Риски, требующие следующей итерации

1. Добавить global/coarse feature registration и pose-graph/fusion поверх скан-сессий; проверить симметричные и малоперекрывающиеся реальные сканы и независимые контрольные точки.
2. Вынести UI generation/download JSON report в browser/Electron integration test и подтвердить весь flow выбор target → frame confirmation → ICP → reload/export на реальном приложении.
3. Подключить документированную CRS/datum/geoid библиотеку и известные survey control/check данные; заменить 5 cm эвристику параметризованными требованиями точности.
4. Подготовить versioned annotated classification corpus, метрики precision/recall/F1 и human review flow; проверить неизвестные/unsupported LAS extra dimensions.
5. Расширить stream-aware edits для disk-backed источника: ручная разметка сейчас явно запрещена для LOD/прореженного cloud; фильтры и прочие операции полного облака всё ещё требуют отдельного out-of-core workflow.
6. Повторно запустить приватный Windows workflow после добавления WebGL smoke и проверить аппаратный renderer по логу. Отдельно нужны clean-machine install/launch, реальный dataset/VRAM stress, независимые GIS/CAD readers и точностные контрольные данные.

**Итог:** регрессионная база этапов 5–7 зелёная в Linux; приватный Windows package-QA run #5 прошёл, а hosted Windows checks текущего head `5f6e146` — 4/4 зелёные; новый Electron/WebGL runtime test локально прошёл только на SwiftShader. Физическая GPU-проверка новой ревизии ещё ждёт ручного private run #6. Этапы 5–7 всё ещё **частичные, не приняты и не завершены** из-за перечисленных алгоритмических, геодезических, данных и runtime gates.

## Повторный прогон перед публикацией overlay

После добавления smoke harness повторно прогнаны Linux проверки: `npm test` — 882 total / 874 passed / 0 failed / 8 skipped; `npm run check`, `node scripts/check-syntax.mjs` (238 файлов), `npm run test:store` и `python3 -m py_compile tools/pointcloud_geometry.py` — passed. Локальный Chromium подтвердил WebGL2 draw, но использовал SwiftShader. Hosted CI для commit `5f6e146` повторно прошёл; приватный Windows run #5 был до этого follow-up. Остался один аппаратный шаг: вручную запустить приватный workflow на новой review-ветке, чтобы проверить реальный GPU smoke.
