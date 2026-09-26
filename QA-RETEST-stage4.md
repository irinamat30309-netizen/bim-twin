# BIM TWIN — повторная проверка Stage 4

## Цель и границы

Проверялись background parsing, disk-octree LOD, отмена/очистка и bounded-working-set ветки для **scalar-property ASCII/binary LE/BE PLY, uncompressed LAS PDRF 0–10 и PCD ASCII/interleaved-binary/LZF binary_compressed**. Локальная среда — Linux/Node 24; headless Chromium/SwiftShader проверяет WebGL2, а fake-Electron harness используется для IPC E2E; внешние пользовательские модели и screenshots/evidence не включены в Git. Windows runtime недоступен на локальном host (Amazon Linux 2023 без Wine/PowerShell/cmd.exe). Исторические hosted checks для commit `76173ad` подтверждают только ту версию. На актуальном PR head `0746bf3` все **4/4 hosted checks** прошли. Дополнительно пользовательский private Windows run #9 на том же commit завершился успешно за 5:36: build NSIS/ASAR и проверка содержимого ASAR прошли; WebGL smoke обнаружил RTX 5070 и нарисовал 1 000 000 точек 10 секунд. Это подтверждает package/ASAR contents и базовый rendering smoke, но не clean-machine install/launch, длительный VRAM stress или CAD/BIM/GIS-приёмку.

## Что теперь делает out-of-core ветка

- `las-node.js` распознаёт ASCII PLY и binary little-/big-endian PLY point clouds с первым непустым `vertex` element и scalar vertex properties. ASCII line reader работает кусками, допускает CRLF, произвольные пробелы/табуляции и последний record без завершающего newline; oversized/malformed records отвергаются. Meshes, list properties и неподдерживаемые layout не направляются в эту ветку.
- Uncompressed LAS formats 0–10 индексируются отдельным bounded двухпроходным reader: валидируются версия/format/record length, LAS 1.4 extended count, RGB offsets/depth, WKT VLR, byte extent и fingerprint; сохраняется исходный Z-up preview transform. LASzip/compressed flags отвергаются, усечённые LAS больше не индексируются молча по неполному legacy-count.
- PCD reader поддерживает bounded двухпроходный `DATA ascii`, interleaved `DATA binary` и PCL field-major `DATA binary_compressed`: проверяет header, `POINTS`/grid agreement, `FIELDS/SIZE/TYPE/COUNT`, binary/LZF extent и source fingerprint; packed/separate RGB и Z-/Y-up frame сверяются с обычным parser. И out-of-core LOD reader, и обычный sampled preview LZF-декодируют в временный planar disk store ограниченными чанками; preview проверяет свободное место на temp-volume где доступно, выдаёт progress, загружает только sampling budget в память и очищает scratch после результата/ошибки. LOD disk preflight включает полный uncompressed scratch size.
- Первый проход читает XYZ из исходного файла bounded chunks, считает bounds/axis sample и проверяет конечность координат; второй проход пишет canonical store: viewer-space XYZ float32 + RGB uint8 + optional normalized intensity float32/classification uint8. Избыточные и произвольные scalar fields по-прежнему не копируются в LOD-узлы. Transform открытого preview передаётся индексу, чтобы LOD не смещал уже показанное sampled cloud.
- Дисковый partitioner использует временные файлы partition, reservoir-selected representatives и ограниченный рабочий буфер одного узла; child partitions удаляются по мере рекурсии. После успешной сборки остаются только `index.json` и `nodes.bin`; temporary files не включаются в результат. Строитель сохраняет все валидные выбранные записи и ограничивает размер node.
- Node-record v2 сохраняет intensity/classification, если эти поля есть в поддерживаемом исходнике; v1 XYZ/RGB индексы остаются читаемыми. WebGL viewer выводит intensity в градациях серого и classification детерминированной палитрой; quality-панель обновляет список режимов при включении/выключении LOD.
- Stream generation меняется при очистке/смене облака: завершившийся позже IPC-read от старого источника не может попасть в новый LOD-кеш. Ошибки node-read показываются пользователю; на один узел действует exponential backoff (250 ms → до 30 s), повторные запросы не зацикливаются, таблица отказов ограничена 512 ключами.
- Сейчас out-of-core LOD доступны только поддерживаемые ASCII/binary PLY point-cloud layouts, uncompressed LAS formats 0–10 и PCD ASCII/interleaved-binary/LZF. PLY mesh, compressed LAS/LAZ, E57, PTX, PTS, XYZ/CSV и другие форматы пока используют memory-backed parse/partition. PCD LZF preview ограничен point budget, проходит эвристический RAM preflight до typed-array allocation и disk-space check, но это sampled in-memory view, не full out-of-core viewer.

## Автотесты и статические проверки

| Проверка | Результат |
|---|---|
| Исторический standalone Stage 4 `node --test` на локальном source-tree snapshot (без локальных fixtures и optional LAZ decoder) | 852 теста: 845 passed, 0 failed, 7 skipped; этот ранний Stage 4 snapshot superseded более поздним private run #9 и актуальным полным suite 883/880/0/3 |
| `test/octree-out-of-core-ply-stage4.test.js` | 12/12 passed: LE/BE, Y/Z-up, ASCII/CRLF/mixed whitespace/no final newline, RGB/ramp, sampling, preview transform, invalid/truncated rows, coincident points, count/fingerprint checks |
| `test/octree-out-of-core-las-stage4.test.js` | 4/4 passed: LAS 1.2 fmt 3/RGB16/WKT, LAS 1.4 fmt 7/extended count/modern offsets, no-RGB elevation ramp/sampling, compressed/truncated/stale-file rejection |
| `test/octree-out-of-core-pcd-stage4.test.js` | 7/7 passed: packed RGB binary, ASCII/Y-up >8 MiB CRLF/no-final-newline, deterministic sampling/non-finite XYZ, >8 MiB LZF chunk streaming, disk-space preflight/cleanup, overlapping back-reference, malformed/truncated/stale rejection and scratch cleanup |
| `test/cloud-parse-worker-stage4.test.js` | 6/6 passed: worker progress, PCD LZF progress monotonicity, malformed/scratch cleanup, cancellation after disk scratch creation and parent cleanup after worker termination, отказ RAM preflight до allocation |
| `test/octree-resource-budget-stage4.test.js` | 10/10 passed: in-memory/out-of-core RAM/disk preflight, LZF scratch allowance, sampled preview RAM estimate/thresholds и неизвестная telemetry |
| `test/atomic-file-windows.test.js` | 1/1 passed: backup rotation сохраняет предыдущую revision; temp backup сначала переводится в private writable mode, затем fsync открывает его с `r+` для Windows |
| `test/octree-build-stage4.test.js`, `test/octree-store.test.js`, `test/webgl-octree-stream.test.js` | Вошли в полный успешный прогон: build/read, index corruption/ranges, LOD selection/budget, cache eviction, degenerate input, v2 attr layouts и асинхронная GPU-подгрузка узла |
| `npm run check` | Успешно |
| `npm run test:store` | `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| GitHub-hosted CI на актуальном PR head `0746bf3` | **4/4 passed**: `test`, `windows-test`, два `windows-package`; физический GPU smoke hosted runner не выполняет |
| Private Windows hardware-QA run #9 на `0746bf3` | **Passed**; GPU smoke на RTX 5070, full regression 883/880/0/3, NSIS/ASAR build и проверка содержимого ASAR прошли |
| Синтаксис | 232 JS/MJS/CJS-файла прошли `node --check` в последнем полном source scan |
| Focused out-of-core/resource/PTX stream + cloud Worker suite (`octree-out-of-core-las`, `octree-out-of-core-ply`, `octree-out-of-core-pcd`, `octree-build-stage4`, `octree-resource-budget-stage4`, `ptx-stream-export-stage4`, `cloud-parse-worker-stage4`, `octree-store`, `webgl-octree-stream`) | 79/79 passed in the latest focused run |
| Stage 3 format/PTX regressions | 23/23 форматных+parser/writer tests и 7/7 PTX stream tests прошли; Stage 3 всё ещё частичный, см. `QA-RETEST-stage3.md` |

## Large PLY fixture — локальный smoke, данные не публикуются

В отдельном предыдущем локальном прогоне внешний крупный PLY прошёл bounded out-of-core build: проверялись source transform, индекс/узлы и удаление временного store. Точные имя, число точек, размер, хеш, измерения и сама геометрия не включены в репозиторий; fixture и evidence-артефакты отсутствуют в чистой копии. Зафиксированный RSS — sampled smoke, а не гарантированный peak, воспроизводимый benchmark или packaged Electron measurement.

## Chromium UI / IPC E2E — предыдущие локальные harness-прогоны

Локальные fake-Electron/Chromium harness-прогоны ранее проверяли:

- крупный внешний PLY: preview → out-of-core build/LOD → чтение узлов → восстановление preview и cleanup; пользовательская модель, точные метаданные и screenshots не включены;
- synthetic ASCII PLY: import → IPC build/read → viewer activation → cleanup;
- внешний LAS fixture: main-process preflight/Worker, disk index, viewer stream и cleanup; сам файл и точная метаинформация не включены;
- synthetic PCD `binary_compressed`/LZF: progress, видимая кнопка LOD и cancel, отсутствие частичного импорта, scratch/store cleanup.

Это исторические local-only E2E результаты, не повторяемые GitHub CI тесты: harness-скрипты, файлы, JSON и screenshots не публикуются. Отдельный текущий headless Chromium/WebGL2 SwiftShader smoke описан ниже; он не заменяет packaged Electron, целевой GPU и CAD/BIM/GIS приёмку.
Дополнительная проверка в этой сессии на локальном headless Chromium/WebGL2 SwiftShader прошла: shader link, видимость root-node, ровно один fetch при нескольких кадрах с незавершённым чтением, upload XYZ/intensity/classification в GPU buffers, последующая draw и переключение intensity/classification; `gl.getError()` вернул `NO_ERROR`. Повторяемая Node regression проверяет тот же асинхронный путь через fake GL. Это smoke/renderer-интеграционная проверка, не пользовательский Electron UI и не целевая видеокарта.
Повторный прогон после защиты смены облака подтвердил тот же renderer smoke. Node regressions дополнительно проверяют late-response rejection, exponential backoff, ограничение retry cache и событие ошибки подгрузки; это не packaged Electron UI и не целевой GPU.

## Preflight, отмена и cleanup

- Обычные in-memory index форматы сохраняют RAM оценку `80 bytes/point + 256 MiB`; обычный PCD preview до выделения output arrays использует эвристическую оценку `128 bytes/sample + 128 MiB` и 70% доступной RAM; для поддерживаемых ASCII/binary PLY, uncompressed LAS и всех трёх поддерживаемых PCD layouts out-of-core используется отдельная оценка fixed buffers + node working set + index descriptors, затем 70% доступной памяти. PLY/LAS/PCD reader читают authoritative source count/layout вместо renderer `expectedPoints` и передают file size/mtimeNs/device/inode/layout fingerprint в Worker. Worker повторно сверяет fingerprint с открытым source fd; изменившийся файл отклоняется до conversion. Это эвристика, не гарантия peak RAM.
- Disk preflight для in-memory пути оценивает output blob; для PLY/LAS/PCD out-of-core учитывает итоговые nodes и временные canonical/partition данные: примерно `2 × canonical record stride × pointCount × 1.05 + 32 MiB metadata + 256 MiB reserve`, где stride включает XYZ/RGB и присутствующие intensity/classification; для compressed PCD добавляется полный planar LZF scratch size.
- В локальном preflight harness намеренно заниженный renderer `expectedPoints` не обходил authoritative header count; отдельные RAM/disk refusal cases завершались до создания worker/store. Точные данные внешнего файла, resource snapshots и логи не публикуются.
- Отдельный stale-source test менял файл после снятия preflight fingerprint; Worker возвращал понятный отказ, незавершённая целевая папка удалялась. Большой PLY UI E2E и conversion-cancel/cleanup были повторены после правки.
- Отдельный локальный PLY cancel harness: отмена в `parse-convert` после создания canonical scratch вернула `cancelled`; временная директория удалена. Harness не включён в репозиторий.
- Synthetic degenerate-input unit/Worker regression подтверждает, что coincident/depth-limited points сохраняются в ограниченных узлах с маркировкой `balanced-overlap-fallback`; spatial culling в этой ветви остаётся грубым. UI harness evidence остаётся локальным.

Оценки RAM/диска снимались по доступной telemetry до старта; свободные ресурсы могут измениться во время расчёта. Это safety guards, не hard quotas.

## Что осталось до приёмки Stage 4

- Out-of-core LOD ограничен ASCII/binary scalar-property PLY, uncompressed LAS formats 0–10 и PCD ASCII/interleaved-binary/LZF. PCD LZF preview больше не ограничен contiguous-buffer cap: decoder использует временный disk store и только sampled typed arrays; это не full disk-backed viewer. PLY mesh, compressed LAS/LAZ, E57, PTX, PTS, XYZ/CSV остаются memory-backed. Не переносить claim bounded-working-set на неподдерживаемые layouts.
- Индекс v2 может содержать нормализованные intensity/classification, но не произвольные LAS extra dimensions; full-cloud filtering, editing, sections, volume/terrain и exporters пока не выполняются над всем disk-backed source. Эти инструменты либо требуют in-memory preview, либо ограничены/отключены при активном LOD.
- Store временный: persistent cache, source-hash reuse, pause/resume, restart recovery/checkpointing не реализованы.
- Нужны repeatable cold/warm benches на нескольких размерах и машинах, pressure tests с конкурирующим RAM/disk use, multi-size target-GPU/VRAM/frame-time benchmark, clean-machine Windows install/launch, 100 GB scale и внешние CAD/BIM/GIS проверки. Build/ASAR-content verification и базовый RTX rendering smoke уже прошли в private run #9.
- Порог индекса в main сейчас 40M точек; это технический cap, не обещание ёмкости для каждого компьютера. Оценки ресурсов и node fallback не заменяют производственный stress test.

**Вывод:** Stage 4 расширяет bounded-working-set ingest и disk octree для ASCII/binary point-cloud PLY с поддерживаемыми scalar properties, uncompressed LAS formats 0–10 и PCD ASCII/interleaved-binary/LZF; LZF preview использует ограниченный disk scratch и point budget. Актуальный private run #9 и hosted CI прошли; run #9 подтвердил Windows NSIS/ASAR build+content verification и базовый RTX 5070 WebGL render smoke (1 млн точек/10 секунд). Этап остаётся **частичным, не принят и не завершён**: другие форматы/mesh memory-bound, произвольные/extra dimensions и full-stream инструменты не реализованы, нет resumable stores; не выполнены clean-machine install/launch, multi-size VRAM/performance и 100 GB pressure benchmarks, CAD/BIM/GIS round-trip.
