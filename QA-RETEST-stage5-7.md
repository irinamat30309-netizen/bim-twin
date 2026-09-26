# BIM TWIN — повторная проверка этапов 5–7

## Среда и границы

- Рабочая среда: Amazon Linux 2023, Node 24, Python 3.13; это не Windows-машина.
- Повторно проверялась рабочая копия `bim-twin-publish`. 4 GitHub hosted checks (`windows-package` ×2, `windows-test`, `test`) прошли на review-ветке; hosted runner намеренно пропускает self-hosted-only WebGL smoke.
- По скриншоту пользователя приватный Windows hardware-QA run #8 завершился успешно за 5:17; виден private workflow repo `main` @ `92c0db6`. Сводка не показывает выбранный публичный `source_ref` и строку `[BIMTWIN_GPU_WEBGL]`, поэтому нельзя подтвердить, что проверялась текущая review-ветка или RTX 5070.
- UI JSON-отчёта ICP не подтверждался кликом в запущенном Electron UI. Нет независимо измеренного контрольного облака/GCP-набора и внешних CAD/GIS readers для сертификации точности.
- Это reproducible unit/regression verification и ограниченная проверка Windows-сборки, не приёмка профессиональной точности, не GPU/VRAM stress-test и не подтверждение «100% функциональности».

## Результаты

| Проверка | Итог |
|---|---|
| Focused Stage 5–7 suite: `node --test test/pointcloud-ply-io-stage7.test.js test/geometry-registration-v1167.test.js test/georef-v1091.test.js test/pcedit-phase123.test.js test/pcedit.test.js test/viewer-edit-attributes-stage7.test.js test/lixel-sprints-ext-v1151.test.js test/format-roundtrip-stage3.test.js test/project-state-bridge-stage2.test.js test/multicloud-classification-restore-stage7.test.js test/webgl-octree-stream.test.js` | **103/103 passed**, 0 failed, 0 skipped; повторно подтверждено перед упаковкой обновления |
| Полный `npm test` без пользовательских fixtures | **883 total / 880 passed / 0 failed / 3 skipped**: две внешние user-fixture проверки и один GPU smoke |
| Полный `npm test` с ранее предоставленным локальным OBJ/STL/PLY набором | **883 total / 882 passed / 0 failed / 1 skipped**: только GPU smoke |
| `test/laz-node.test.js` | **5/5 passed**: LAS/LAZ 1.2/1.4 attributes, decimation floor, compactness |
| `npm run check` | passed (`main.js`, `preload.js`, SQLite/JSON stores) |
| `node --check pointcloud-ply-io.js` | passed |
| `node scripts/check-syntax.mjs` | passed для **241 JS/MJS/CJS-файла** |
| `npm run test:store` | passed: `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| `python scripts/check-python-syntax.py` | passed для **28 Python-файлов**; проверяются tracked и новые non-ignored sources без `.pyc` |
| Synthetic ICP без SciPy | `numpy-exact-trimmed-icp`; 250 точек, fitness 1.0, 6 итераций, RMSE `1.30e-15`, translation error `6.34e-17` в заданной метрической synthetic-сцене |
| GitHub-hosted Windows CI | **4/4 passed** на GPU-коде commit `4c6cdde`: `test`, `windows-test`, два `windows-package`; self-hosted NVIDIA smoke здесь пропускается |
| Приватный Windows hardware-QA run #8 | по сводному скриншоту Success за 5:17; выбранный public `source_ref` и GPU renderer/adapter не показаны |
| Локальный WebGL runtime smoke | **PASS только как software-WebGL draw test:** production `Viewer3DGL` загрузил 4096 точек и RGB/intensity/classification buffers, classification mode нарисовал 114229 изменённых пикселей; `glError=0`, контекст не потерян. Renderer — SwiftShader, не физическая видеокарта |
| Electron/Windows package | run #7 собрал installer и проверил обязательные файлы ASAR; установка/запуск установленного приложения на чистой Windows-машине отдельно не подтверждались |

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
- `test/webgl-runtime-smoke.test.js` запускает production `Viewer3DGL` только на self-hosted Windows runner: запрашивает high-performance WebGL, загружает и непрерывно рисует 1 000 000 точек 10 секунд, проверяет VBO/attributes, WebGL2, draw/readback, GL errors, context loss, software fallback и NVIDIA vendor/adapter. Hosted CI пропускает этот hardware gate; latest private run #8 screenshot не показывает renderer, поэтому текущий RTX smoke требует повторного запуска с `BIMTWIN_GPU_SMOKE=1` и `source_ref=agent/windows-package-qa`.

### Пропущенные тесты

В portable clean checkout без `BIM_TWIN_USER_FIXTURES` остаются три skips: два требуют внешний user-supplied OBJ/STL/large-PLY набор и один требует self-hosted Windows GPU runner. При локальном mount ранее предоставленных пользовательских файлов оба dataset tests проходят; сами данные остаются вне Git. LAZ skips сняты тремя compact synthetic fixtures (5/5 passed), а synthetic room/large-PLY tests теперь запускаются без внешних файлов.

## Риски, требующие следующей итерации

1. Добавить global/coarse feature registration и pose-graph/fusion поверх скан-сессий; проверить симметричные и малоперекрывающиеся реальные сканы и независимые контрольные точки.
2. Вынести UI generation/download JSON report в browser/Electron integration test и подтвердить весь flow выбор target → frame confirmation → ICP → reload/export на реальном приложении.
3. Подключить документированную CRS/datum/geoid библиотеку и известные survey control/check данные; заменить 5 cm эвристику параметризованными требованиями точности.
4. Подготовить versioned annotated classification corpus, метрики precision/recall/F1 и human review flow; проверить неизвестные/unsupported LAS extra dimensions.
5. Расширить stream-aware edits для disk-backed источника: ручная разметка сейчас явно запрещена для LOD/прореженного cloud; фильтры и прочие операции полного облака всё ещё требуют отдельного out-of-core workflow.
6. Нужен hardware rerun latest code на self-hosted Windows runner; run #8 summary не показывает активный адаптер. Дополнительно нужны clean-machine install/launch, отдельный VRAM/performance stress, независимые GIS/CAD readers и точностные контрольные данные.

**Итог:** Linux regression и 4 hosted checks прошли. Скриншот приватного run #8 показывает успешное завершение workflow, но не подтверждает проверку текущей ветки или RTX 5070; расширенный NVIDIA smoke ждёт hardware rerun. Это не заменяет отдельный VRAM/performance stress, clean-machine install/launch, независимую геодезическую точность и внешние CAD/GIS-приёмки. Этапы 5–7 всё ещё **частичные, не приняты и не завершены**.

## Повторный прогон перед публикацией overlay

После добавления smoke harness, room/large-PLY и LAZ synthetic fixtures повторно прогнаны проверки: без user files `npm test` — 883 total / 880 passed / 0 failed / 3 skipped; с ранее предоставленным локальным OBJ/STL/PLY набором — 883 / 882 / 0 / 1. `npm run check`, `node scripts/check-syntax.mjs` (241 файлов), `node --check pointcloud-ply-io.js`, `python scripts/check-python-syntax.py` (28 Python files) и `npm run test:store` — passed; LAZ focused suite — 5/5. Latest GPU-selection code commit `4c6cdde` прошёл 4/4 hosted checks. Stage-by-stage QA находится в `QA-RETEST-stage0-7-current.md`. Private run #8 screenshot не раскрывает source ref/renderer; расширенный RTX smoke ещё нужно выполнить на self-hosted Windows. VRAM stress, external CAD/GIS и clean-machine install остаются вне этой проверки.
