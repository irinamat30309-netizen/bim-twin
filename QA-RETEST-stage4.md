# BIM TWIN — повторная проверка Stage 4

## Цель и границы

Проверялись background parsing, disk-octree LOD, отмена/очистка и bounded-working-set ветки для **scalar-property ASCII/binary LE/BE PLY, uncompressed LAS PDRF 0–10 и PCD ASCII/interleaved-binary/LZF binary_compressed**. Среда предыдущих локальных E2E — Linux/Node 24 и headless Chromium/SwiftShader с fake-Electron IPC; внешние пользовательские модели и локальные screenshots/evidence не включены в Git. Windows runtime недоступен на локальном host (Amazon Linux 2023 без Wine/PowerShell/cmd.exe). Первый hosted job `windows-test` на `windows-latest` завершился `EPERM` в regression хранилища: Node/Windows не поддержал `fsync` read-only backup descriptor. Исправление перевело backup temp handles на `r+`, добавлена regression; повторный hosted run ещё не завершён. Linux/fake-Electron проверки не выдаются за Windows-приёмку; packaged Windows/ASAR и целевой GPU/VRAM также не сертифицированы.

## Что теперь делает out-of-core ветка

- `las-node.js` распознаёт ASCII PLY и binary little-/big-endian PLY point clouds с первым непустым `vertex` element и scalar vertex properties. ASCII line reader работает кусками, допускает CRLF, произвольные пробелы/табуляции и последний record без завершающего newline; oversized/malformed records отвергаются. Meshes, list properties и неподдерживаемые layout не направляются в эту ветку.
- Uncompressed LAS formats 0–10 индексируются отдельным bounded двухпроходным reader: валидируются версия/format/record length, LAS 1.4 extended count, RGB offsets/depth, WKT VLR, byte extent и fingerprint; сохраняется исходный Z-up preview transform. LASzip/compressed flags отвергаются, усечённые LAS больше не индексируются молча по неполному legacy-count.
- PCD reader поддерживает bounded двухпроходный `DATA ascii`, interleaved `DATA binary` и PCL field-major `DATA binary_compressed`: проверяет header, `POINTS`/grid agreement, `FIELDS/SIZE/TYPE/COUNT`, binary/LZF extent и source fingerprint; packed/separate RGB и Z-/Y-up frame сверяются с обычным parser. И out-of-core LOD reader, и обычный sampled preview LZF-декодируют в временный planar disk store ограниченными чанками; preview проверяет свободное место на temp-volume где доступно, выдаёт progress, загружает только sampling budget в память и очищает scratch после результата/ошибки. LOD disk preflight включает полный uncompressed scratch size.
- Первый проход читает XYZ из исходного файла bounded chunks, считает bounds/axis sample и проверяет конечность координат; второй проход пишет canonical store: viewer-space XYZ float32 + RGB uint8 (15 bytes/point). Избыточные scalar fields допускаются в ASCII, но пока не копируются в LOD-узлы. Transform открытого preview передаётся в индекс, чтобы LOD не смещал уже показанное sampled cloud.
- Дисковый partitioner использует временные файлы partition, reservoir-selected representatives и ограниченный рабочий буфер одного узла; child partitions удаляются по мере рекурсии. После успешной сборки остаются только `index.json` и `nodes.bin`; temporary files не включаются в результат. Строитель сохраняет все валидные выбранные записи и ограничивает размер node.
- Геометрия и RGB идут в LOD. Intensity/classification в streamed nodes пока не входят; приложение должно сообщать об этом и восстанавливает доступные preview-атрибуты при выключении LOD.
- Сейчас out-of-core LOD доступны только поддерживаемые ASCII/binary PLY point-cloud layouts, uncompressed LAS formats 0–10 и PCD ASCII/interleaved-binary/LZF. PLY mesh, compressed LAS/LAZ, E57, PTX, PTS, XYZ/CSV и другие форматы пока используют memory-backed parse/partition. PCD LZF preview ограничен point budget, проходит эвристический RAM preflight до typed-array allocation и disk-space check, но это sampled in-memory view, не full out-of-core viewer.

## Автотесты и статические проверки

| Проверка | Результат |
|---|---|
| Повторный `node --test` на чистой копии (без локальных fixture-файлов и optional LAZ decoder) | 842 теста: 835 passed, 0 failed, 7 skipped; пропущены только сценарии, которым недоступны нужные fixtures/decoder |
| `test/octree-out-of-core-ply-stage4.test.js` | 12/12 passed: LE/BE, Y/Z-up, ASCII/CRLF/mixed whitespace/no final newline, RGB/ramp, sampling, preview transform, invalid/truncated rows, coincident points, count/fingerprint checks |
| `test/octree-out-of-core-las-stage4.test.js` | 4/4 passed: LAS 1.2 fmt 3/RGB16/WKT, LAS 1.4 fmt 7/extended count/modern offsets, no-RGB elevation ramp/sampling, compressed/truncated/stale-file rejection |
| `test/octree-out-of-core-pcd-stage4.test.js` | 7/7 passed: packed RGB binary, ASCII/Y-up >8 MiB CRLF/no-final-newline, deterministic sampling/non-finite XYZ, >8 MiB LZF chunk streaming, disk-space preflight/cleanup, overlapping back-reference, malformed/truncated/stale rejection and scratch cleanup |
| `test/cloud-parse-worker-stage4.test.js` | 6/6 passed: worker progress, PCD LZF progress monotonicity, malformed/scratch cleanup, cancellation after disk scratch creation and parent cleanup after worker termination, отказ RAM preflight до allocation |
| `test/octree-resource-budget-stage4.test.js` | 10/10 passed: in-memory/out-of-core RAM/disk preflight, LZF scratch allowance, sampled preview RAM estimate/thresholds и неизвестная telemetry |
| `test/atomic-file-windows.test.js` | 1/1 passed: backup rotation сохраняет предыдущую revision, а fsync открывает backup temp с `r+` для Windows |
| `test/octree-build-stage4.test.js`, `test/octree-store.test.js`, `test/webgl-octree-stream.test.js` | Вошли в полный успешный прогон: build/read, node ranges, LOD selection/budget, cache eviction, degenerate input |
| `npm run check` | Успешно |
| `npm run test:store` | `ALL PHASE D TESTS PASSED`, `ALL PERSISTENCE TESTS PASSED` |
| Синтаксис | 235 JS/MJS/CJS-файлов прошли `node --check` |
| Focused out-of-core/resource/PTX stream + cloud Worker suite (`octree-out-of-core-las`, `octree-out-of-core-ply`, `octree-out-of-core-pcd`, `octree-build-stage4`, `octree-resource-budget-stage4`, `ptx-stream-export-stage4`, `cloud-parse-worker-stage4`) | 51/51 passed |
| Stage 3 format/PTX regressions | 23/23 форматных+parser/writer tests и 7/7 PTX stream tests прошли; Stage 3 всё ещё частичный, см. `QA-RETEST-stage3.md` |

## Large PLY fixture — локальный smoke, данные не публикуются

В отдельном предыдущем локальном прогоне внешний крупный PLY прошёл bounded out-of-core build: проверялись source transform, индекс/узлы и удаление временного store. Точные имя, число точек, размер, хеш, измерения и сама геометрия не включены в репозиторий; fixture и evidence-артефакты отсутствуют в чистой копии. Зафиксированный RSS — sampled smoke, а не гарантированный peak, воспроизводимый benchmark или packaged Electron measurement.

## Chromium UI / IPC E2E — предыдущие локальные harness-прогоны

Локальные fake-Electron/Chromium harness-прогоны ранее проверяли:

- крупный внешний PLY: preview → out-of-core build/LOD → чтение узлов → восстановление preview и cleanup; пользовательская модель, точные метаданные и screenshots не включены;
- synthetic ASCII PLY: import → IPC build/read → viewer activation → cleanup;
- внешний LAS fixture: main-process preflight/Worker, disk index, viewer stream и cleanup; сам файл и точная метаинформация не включены;
- synthetic PCD `binary_compressed`/LZF: progress, видимая кнопка LOD и cancel, отсутствие частичного импорта, scratch/store cleanup.

Это исторические local-only E2E результаты, не повторяемые GitHub CI тесты: harness-скрипты, файлы, JSON и screenshots не публикуются. Текущая воспроизводимая проверка ветки — unit/regression suite; Windows job, packaged Electron, GPU и внешние CAD/BIM/GIS readers требуют отдельной фактической приёмки.

## Preflight, отмена и cleanup

- Обычные in-memory index форматы сохраняют RAM оценку `80 bytes/point + 256 MiB`; обычный PCD preview до выделения output arrays использует эвристическую оценку `128 bytes/sample + 128 MiB` и 70% доступной RAM; для поддерживаемых ASCII/binary PLY, uncompressed LAS и всех трёх поддерживаемых PCD layouts out-of-core используется отдельная оценка fixed buffers + node working set + index descriptors, затем 70% доступной памяти. PLY/LAS/PCD reader читают authoritative source count/layout вместо renderer `expectedPoints` и передают file size/mtimeNs/device/inode/layout fingerprint в Worker. Worker повторно сверяет fingerprint с открытым source fd; изменившийся файл отклоняется до conversion. Это эвристика, не гарантия peak RAM.
- Disk preflight для in-memory пути оценивает output blob; для PLY/LAS/PCD out-of-core учитывает итоговые nodes и временные canonical/partition данные: `30 bytes/point × 1.05 + 32 MiB metadata + 256 MiB reserve`, плюс полный `pointBytes` для временного planar LZF store compressed PCD.
- В локальном preflight harness намеренно заниженный renderer `expectedPoints` не обходил authoritative header count; отдельные RAM/disk refusal cases завершались до создания worker/store. Точные данные внешнего файла, resource snapshots и логи не публикуются.
- Отдельный stale-source test менял файл после снятия preflight fingerprint; Worker возвращал понятный отказ, незавершённая целевая папка удалялась. Большой PLY UI E2E и conversion-cancel/cleanup были повторены после правки.
- Отдельный локальный PLY cancel harness: отмена в `parse-convert` после создания canonical scratch вернула `cancelled`; временная директория удалена. Harness не включён в репозиторий.
- Synthetic degenerate-input unit/Worker regression подтверждает, что coincident/depth-limited points сохраняются в ограниченных узлах с маркировкой `balanced-overlap-fallback`; spatial culling в этой ветви остаётся грубым. UI harness evidence остаётся локальным.

Оценки RAM/диска снимались по доступной telemetry до старта; свободные ресурсы могут измениться во время расчёта. Это safety guards, не hard quotas.

## Что осталось до приёмки Stage 4

- Out-of-core LOD ограничен ASCII/binary scalar-property PLY, uncompressed LAS formats 0–10 и PCD ASCII/interleaved-binary/LZF. PCD LZF preview больше не ограничен contiguous-buffer cap: decoder использует временный disk store и только sampled typed arrays; это не full disk-backed viewer. PLY mesh, compressed LAS/LAZ, E57, PTX, PTS, XYZ/CSV остаются memory-backed. Не переносить claim bounded-working-set на неподдерживаемые layouts.
- Index не содержит intensity/classification/extra dimensions; streamed tools, filtering, sections, volume/terrain и exporters пока не работают над полным disk-backed source. Сами nodes сейчас несут XYZ/RGB.
- Store временный: persistent cache, source-hash reuse, pause/resume, restart recovery/checkpointing не реализованы.
- Нужны repeatable cold/warm benches на нескольких размерах и машинах, pressure tests с конкурирующим RAM/disk use, target GPU/VRAM/frame-time, Windows packaged/ASAR, 100 GB scale и внешние CAD/BIM/GIS проверки.
- Порог индекса в main сейчас 40M точек; это технический cap, не обещание ёмкости для каждого компьютера. Оценки ресурсов и node fallback не заменяют производственный stress test.

**Вывод:** Stage 4 расширяет bounded-working-set ingest и disk octree для ASCII/binary point-cloud PLY с поддерживаемыми scalar properties, uncompressed LAS formats 0–10 и PCD ASCII/interleaved-binary/LZF; LZF preview использует ограниченный disk scratch и point budget. Текущий clean-checkout regression suite прошёл 835/842 tests, 0 failures, 7 fixture/decoder skips; это не эквивалент Windows UI приёмки. Этап остаётся **частичным, не принят и не завершён**: другие форматы/mesh memory-bound, intensity/classification и дополнительные атрибуты не стримятся, нет resumable stores и stream-aware инструментов; требуются фактический Windows CI, packaged/ASAR и GPU/VRAM проверки, повторяемые benchmarks и CAD/BIM/GIS round-trip.
