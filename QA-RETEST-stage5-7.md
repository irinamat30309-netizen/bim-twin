# BIM TWIN — повторная проверка этапов 5–7

## Среда и границы

- Рабочая среда: Amazon Linux 2023, Node 24, Python 3.13; это не Windows-машина.
- Повторно проверялась рабочая копия `bim-twin-publish`. 4 GitHub hosted checks (`windows-package` ×2, `windows-test`, `test`) прошли на review-ветке; hosted runner намеренно пропускает self-hosted-only WebGL smoke.
- Приложенный full-regression лог приватного Windows hardware-QA run #9 завершился успешно за 5:36; checkout public commit `0746bf3` из `agent/windows-package-qa`. `[BIMTWIN_GPU_WEBGL]` подтвердил `ANGLE (NVIDIA GeForce RTX 5070, Direct3D11)`, WebGL2, 1 000 000 точек за 10 013 ms/1 606 кадров, 533 200 изменённых пикселей и `nvidiaAdapterDetected=true`; smoke test passed за 11 581 ms.
- UI JSON-отчёта ICP не подтверждался кликом в запущенном Electron UI. Нет независимо измеренного контрольного облака/GCP-набора и внешних CAD/GIS readers для сертификации точности.
- Это reproducible unit/regression verification и ограниченная Windows/GPU rendering проверка, не приёмка профессиональной точности, не крупный VRAM/performance stress-test и не подтверждение «100% функциональности».

## Результаты

| Проверка | Итог |
|---|---|
| Focused Stage 5–7 suite: `node --test test/pointcloud-ply-io-stage7.test.js test/geometry-registration-v1167.test.js test/georef-v1091.test.js test/pcedit-phase123.test.js test/pcedit.test.js test/viewer-edit-attributes-stage7.test.js test/lixel-sprints-ext-v1151.test.js test/format-roundtrip-stage3.test.js test/project-state-bridge-stage2.test.js test/multicloud-classification-restore-stage7.test.js test/webgl-octree-stream.test.js` | **103/103 passed**, 0 failed, 0 skipped; повторно подтверждено перед упаковкой обновления |
| Portable Linux `npm test` без пользовательских fixtures | **883 total / 880 passed / 0 failed / 3 skipped**: две внешние user-fixture проверки и self-hosted GPU smoke, который не запускается на этом Linux runner |
| Portable Linux `npm test` с ранее предоставленным локальным OBJ/STL/PLY набором | **883 total / 882 passed / 0 failed / 1 skipped**: только self-hosted GPU smoke |
| Private Windows hardware-QA run #9 | **883 total / 880 passed / 0 failed / 3 skipped**; GPU smoke прошёл, пропущены две недоступные user fixtures и Linux-only DAC denial test |
| `test/laz-node.test.js` | **5/5 passed**: LAS/LAZ 1.2/1.4 attributes, decimation floor, compactness |
| `npm run check` | passed (`main.js`, `preload.js`, SQLite/JSON stores) |
| `node --check pointcloud-ply-io.js` | passed |
| `node scripts/check-syntax.mjs` | passed для **241 JS/MJS/CJS-файла** |
| `npm run test:store` | passed: `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| `python scripts/check-python-syntax.py` | passed для **28 Python-файлов**; проверяются tracked и новые non-ignored sources без `.pyc` |
| Synthetic ICP без SciPy | `numpy-exact-trimmed-icp`; 250 точек, fitness 1.0, 6 итераций, RMSE `1.30e-15`, translation error `6.34e-17` в заданной метрической synthetic-сцене |
| GitHub-hosted CI | **4/4 passed** на актуальном PR head `0746bf3` (`test`, `windows-test`, два `windows-package`); self-hosted NVIDIA smoke здесь пропускается |
| Приватный Windows hardware-QA run #9 | **RTX 5070 подтверждена**: `[BIMTWIN_GPU_WEBGL]` renderer `ANGLE (NVIDIA GeForce RTX 5070, Direct3D11)`, WebGL2, 1 млн точек/10 013 ms/1 606 кадров, 533 200 изменённых пикселей, `nvidiaAdapterDetected=true`; поле `activeAdapters` пустое |
| Локальный WebGL runtime smoke | **PASS только как software-WebGL draw test:** production `Viewer3DGL` загрузил 4096 точек и RGB/intensity/classification buffers, classification mode нарисовал 114229 изменённых пикселей; `glError=0`, контекст не потерян. Renderer — SwiftShader, не физическая видеокарта |
| Electron/Windows package | private run #9 успешно собрал NSIS installer/ASAR и проверил содержимое ASAR; установка и запуск установленного приложения на чистой Windows-машине отдельно не подтверждались |

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
- `test/webgl-runtime-smoke.test.js` запускает production `Viewer3DGL` только на self-hosted Windows runner: запрашивает high-performance WebGL, загружает и непрерывно рисует 1 000 000 точек 10 секунд, проверяет VBO/attributes, WebGL2, draw/readback, GL errors, context loss, software fallback и NVIDIA renderer/adapter. Hosted CI пропускает этот hardware gate; private run #9 на public commit `0746bf3` подтвердил NVIDIA GeForce RTX 5070 и успешно прошёл smoke. Это именно WebGL rendering, не CUDA compute и не multi-size VRAM benchmark.

### Пропущенные тесты

В portable Linux checkout без `BIM_TWIN_USER_FIXTURES` пропускаются две проверки user-supplied OBJ/STL/large-PLY и self-hosted Windows GPU smoke. В private Windows run #9 GPU smoke выполнился и прошёл; там остаются два user-fixture skips и один Linux-only DAC denial skip. Ранее подключённые локально пользовательские OBJ/STL/PLY проходили 12/12; исходные файлы остаются вне Git. LAZ synthetic suite — 5/5.

## Риски, требующие следующей итерации

1. Добавить global/coarse feature registration и pose-graph/fusion поверх скан-сессий; проверить симметричные и малоперекрывающиеся реальные сканы и независимые контрольные точки.
2. Вынести UI generation/download JSON report в browser/Electron integration test и подтвердить весь flow выбор target → frame confirmation → ICP → reload/export на реальном приложении.
3. Подключить документированную CRS/datum/geoid библиотеку и известные survey control/check данные; заменить 5 cm эвристику параметризованными требованиями точности.
4. Подготовить versioned annotated classification corpus, метрики precision/recall/F1 и human review flow; проверить неизвестные/unsupported LAS extra dimensions.
5. Расширить stream-aware edits для disk-backed источника: ручная разметка сейчас явно запрещена для LOD/прореженного cloud; фильтры и прочие операции полного облака всё ещё требуют отдельного out-of-core workflow.
6. RTX 5070 rendering smoke уже подтверждён run #9. Дополнительно нужны clean-machine install/launch, multi-size VRAM/performance stress с целевыми порогами, независимые GIS/CAD readers и контрольные геодезические данные.

**Итог:** Linux regression и 4 hosted checks на актуальном PR head прошли. Private run #9 на RTX 5070 подтвердил WebGL rendering и Windows package/ASAR content verification. Он не заменяет VRAM/performance stress, clean-machine install/launch, независимую геодезическую точность и внешние CAD/GIS-приёмки. Этапы 5–7 всё ещё **частичные, не приняты и не завершены**.

## Повторный прогон перед публикацией overlay

До private run #9 уже были прогнаны: portable Linux `npm test` без user files — 883/880/0/3, с локальными OBJ/STL/PLY — 883/882/0/1; `npm run check`, JS syntax (241 файлов), `node --check pointcloud-ply-io.js`, Python syntax (28 файлов), `npm run test:store` и LAZ focused suite 5/5 — passed. На актуальном PR head `0746bf3` прошли 4/4 hosted checks. Затем private run #9 на том же commit подтвердил RTX 5070 WebGL smoke и завершил полный suite 883/880/0/3; его три skips — две отсутствующие user fixtures и Linux-only DAC test. Подробный этапный QA находится в `QA-RETEST-stage0-7-current.md`. VRAM stress, clean-machine install/launch, external CAD/GIS и точностные контрольные данные остаются вне этой проверки.
