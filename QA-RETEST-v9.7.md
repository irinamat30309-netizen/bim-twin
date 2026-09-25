# QA retest v9.7 — наборы сечений и проектный контекст

## Среда

- Linux sandbox, Node.js 24, Chromium/Playwright с SwiftShader.
- UI runner использует реальный renderer BIM TWIN и fake Electron IPC.
- `better-sqlite3` отсутствует, поэтому приложение запущено через JSON-store fallback; SQLite DDL/query contract отдельно проверен `python3`/`sqlite3`.
- Синтетические `room.las` и `room.ply` содержат по 205 526 точек. LAS геопривязан, PLY локальный; наборы не являются пользовательскими контрольными проектами.

## Результаты

| Проверка | Результат | Подтверждено |
|---|---:|---|
| `node --test` | 704: 701 pass / 3 skip / 0 fail | Unit/regression приложения |
| `node db/_test.js` | PASS | JSON-store CRUD, project switching, backup/import |
| Syntax check | 217 файлов / 0 ошибок | JS/MJS/CJS проекта, тестов и E2E |
| Section presets UI · LAS | 11/11 check groups | Save/apply, project persistence after renderer reload, axis/profile, source guard, project isolation |
| Section presets UI · PLY | 11/11 check groups | Те же сценарии и restore в PLY source frame; project persistence after renderer reload |
| SQLite schema smoke | PASS | DDL, Unicode unique key, project isolation, update query |
| Click-smoke ribbon-действий · LAS | 99 действий | 0 зафиксированных JS/page/IPC/no-handler errors, 12 скачиваний; 61 действие дало toast/modal/download/bounds change, 38 не имели такого smoke-сигнала |
| Responsive layout после загрузки · LAS | PASS · 3 размера | 1600×950, 1280×720 и 1024×768: document/body не переполняют viewport, stage остаётся в границах; на 1024 px табы прокручиваются внутри ribbon (17 px, ожидаемо), page errors нет |

UI E2E проверяет сохранение имени, схемы параметров и источника (basename, point count, local bounds, source-axis transform, sample fingerprint), точное восстановление координаты/толщины/ячейки, профильный azimuth/origin/offset, duplicate-name confirmation/update, cross-source warning, delete confirmation, переключение проекта через UI и корректный empty state без помещений. Дополнительно выполняется renderer reload и проверяется сохранность активного проекта и набора через project-scoped API. Повторный импорт облака после reload не входит в этот тест. На каждом формате — 11/11 check groups, 0 page errors.

`clickall.js` — только smoke: у 38/99 действий он не зарегистрировал toast/modal/download или изменение cloud bounds. Это **не доказывает**, что все 38 действий являются сломанными: в наборе есть file-picker labels без выбранного файла, drawing/navigation modes и действия, для которых нужно выбрать объект или повторно проверить состояние. Но они не считаются семантически подтверждёнными. Результаты сохранены в `QA-artifacts/v9.7/clickall-v1229-room.las.json`; отдельный целевой контракт остаётся обязателен для каждого Tier-1 действия.

В тестовом сценарии источник при применении намеренно меняется; действие запрашивает подтверждение, а сохранённые параметры не перестраивают геометрию без команды оператора.

## Воспроизведение

Из корня проекта:

```sh
node --test
node db/_test.js
node QA-artifacts/v9.7/repro/section-presets-e2e-v1229.js QA-artifacts/v9.7/repro/fixtures/room.las
node QA-artifacts/v9.7/repro/section-presets-e2e-v1229.js QA-artifacts/v9.7/repro/fixtures/room.ply
python3 QA-artifacts/v9.7/repro/sqlite-section-presets-smoke.py
node QA-artifacts/v9.7/repro/layout-smoke-v1230.js
```

## Ограничения приёмки

- E2E и database tests не являются проверкой целевой Windows/Electron сборки или production SQLite binding.
- Не запускались AutoCAD/BricsCAD/QGIS/Bonsai/IFC validators; DWG/IFC/CRS-интероперабельность не подтверждена этим прогоном.
- Нет large-cloud stress test, progress/cancel measurement, memory budget, real survey ground truth или user MEP/terrain project.
- 3 пропущенных Node-теста указаны test runner-ом; их нельзя считать пройденными.