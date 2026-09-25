# QA retest v9.5

## Среда и воспроизводимость

- Linux automation sandbox; Node.js, Playwright, headless Chromium со SwiftShader.
- Electron заменён тестовым IPC adapter из `QA-artifacts/v9.5/repro/fake/electron/`.
- Тестовые данные: синтетические `room.las` и `room.ply`, 205 526 точек каждый.
- JSON store fallback: `better-sqlite3` не установлен в стенде. Проверка не включает настоящую SQLite/native-сборку.
- Запускать команды из корня распакованного проекта; скрипты и фикстуры находятся в `QA-artifacts/v9.5/repro/`.

```sh
node --test
node QA-artifacts/v9.5/repro/draw-tools-e2e-v1226.js QA-artifacts/v9.5/repro/fixtures/room.las
node QA-artifacts/v9.5/repro/draw-tools-e2e-v1226.js QA-artifacts/v9.5/repro/fixtures/room.ply
node QA-artifacts/v9.5/repro/section-box-e2e-v1226.js
node QA-artifacts/v9.5/repro/viewer-controls-e2e-v1227.js QA-artifacts/v9.5/repro/fixtures/room.las
```

## Результаты

| Проверка | Итог | Что именно подтверждено |
|---|---:|---|
| `node --test` | 697: 694 pass, 3 skip, 0 fail | Unit/regression-пакет приложения |
| Syntax check | 209 файлов, 0 fail | JS/MJS/CJS включая QA runner |
| Draw tools + LAS | 25/25 pass | 6 режимов, history actions, полилиния, DXF source-frame round-trip |
| Draw tools + PLY | 25/25 pass | То же на втором пути импорта, локальный source frame |
| Point-cloud section box | 9/9 pass | Горизонталь Y, фасад Z, бок X, непустой subset, ordering range handles, reset, выключение |
| LOD/isolate | 9/9 pass | LOD unavailable для point cloud, отказ изоляции без выбора, выбранная BIM-модель, mesh LOD 4→2→4 |

Во всех новых E2E результатах — ноль page errors, IPC exceptions и missing handlers. В источнике LAS viewer использует Z-up transform; координаты source-frame DXF сохранены с допуском 1e-6. На PLY проверен source transform для его локальной системы.

## Ограничения и дальнейшие gates

- DXF структурно разобран внутренним `dxfparse.js`; внешнее CAD-приложение/независимый DXF reader в этом цикле не запускались.
- Для чертежа `__lxDraw.onPick` подал синтетические мировые координаты; ручной pointer ray-pick и snap-точность не подтверждены этим тестом.
- `section-box` валидирует viewer clip-state и реально проверяет точки через `_pointInClip`, но не является survey/terrain ground-truth oracle.
- Point cloud LOD не реализован; функциональность честно отключена, а не заменена недоказанным downsampling.
- Не тестировались Windows package/installer, ASAR, настоящие Electron native modules, SQLite, крупные облака или внешние BIM/CAD-программы.
- Широкий click-smoke v1223 содержал 39 действий на формат без зафиксированного toast/modal/log/state-change. Новые E2E глубоко покрывают только перечисленные сценарии; все 99 действий на каждом формате не получили нового семантического acceptance.

## Артефакты

- `node-test-full-v1227.log`, `syntax-check-v1227.txt`.
- `draw-tools-e2e-v1226-room-las.json`, `draw-tools-e2e-v1226-room-ply.json`.
- `section-box-e2e-v1226.json`, `viewer-controls-e2e-v1227.json`.
- Скриншоты: `draw-toolbar-polyline-room-las-v1226.png`, `section-box-horizontal-y-v1226.png`, `lod-synthetic-mesh-v1227.png`.
- Экспортированные файлы: `drawing-source-room-las-v1226.dxf`, `drawing-source-room-ply-v1226.dxf`.
- Runner, fake Electron bridge и fixtures: `repro/`.
