# BIM TWIN v9.8 — Scan-to-BIM, IFC4 и export round-trip QA

## Результат

Новые false-positive и IFC-opening проверки прошли на Linux review environment. Полный регрессионный набор — **711 tests: 708 pass / 3 skipped / 0 failed**. Это подтверждает проверенные контракты, но не означает, что всё приложение или все рыночные функции прошли production acceptance.

## Среда и повторяемые входы

- Приложение: `package.json` version `1.1.17`; review engine `renderer/scan2bim.js` v1231.
- Среда: Linux, Node.js, Chromium/Playwright; загружался реальный `renderer/index.html`.
- Electron в harness замокан, сохранение проекта работало через JSON-store fallback: `better-sqlite3` отсутствует.
- LAS fixture: `QA-artifacts/v9.7/repro/fixtures/room.las`, 205 526 points, SHA-256 `086f3892025e7493331c6721555a22befa86bfb04c40c0adbd694ba24cb679db`.
- PLY fixture: `QA-artifacts/v9.7/repro/fixtures/room.ply`, 205 526 points, SHA-256 `b96e747f122109a54c2ddb0382091c7405553d1b5766161b0517dabdf0099d35`.

## Полные и адресные тесты

| Проверка | Результат |
|---|---:|
| `node --test` | 711 всего; 708 pass, 3 skip, 0 fail |
| `node db/_test.js` | phase-D и persistence suites прошли |
| `node --check` по JS/CJS/MJS | 212 файлов; 0 ошибок |
| Полный ribbon click-smoke на LAS | 99 действий; 61 с наблюдаемым сигналом; 12 downloads; 0 action errors / `NOHANDLER` |
| Scan-to-BIM UI E2E `room.las` | 2/2 групп; 0 page errors; 0 fatal harness/IPC errors |
| Scan-to-BIM UI E2E `room.ply` | 2/2 групп; 0 page errors; 0 fatal harness/IPC errors |
| E57/LAS/PLY/XYZ/PTS/PCD/OBJ source-frame round-trip | 7/7 форматов на каждом входе; 205 526 точек на формат |
| IFC4 opening unit tests | 3/3 прошли: wall relation, source frame, containment, multi/invalid/empty openings |
| Ground-truth false-MEP unit tests | 4/4 прошли: аналитическая комната, beam/column suppression, cable positive control, LAS+PLY |

E2E результат записан в:
- `QA-artifacts/v9.8/scan2bim-groundtruth-ui-v1231-room.las.json`
- `QA-artifacts/v9.8/scan2bim-groundtruth-ui-v1231-room.ply.json`
- полный click-smoke и список 38 действий без наблюдаемой реакции: `QA-artifacts/v9.8/clickall-room.las.json`
- многоканальный source-frame round-trip: `QA-artifacts/v9.8/export-source-frame-ui-v1231-room.las.json` и `...room.ply.json`

Воспроизведение команд описано в `QA-artifacts/v9.8/repro/README.md`.

## Измерения UI Scan-to-BIM

| Метрика | LAS | PLY |
|---|---:|---:|
| Входные точки | 205 526 | 205 526 |
| Использованные после обработки | 106 087 | 104 458 |
| Стены | 4 | 4 |
| Дверной проём | 1 (uncertain=0) | 1 (uncertain=0) |
| Колонны | 1 | 1 |
| Автоматические pipes / cables / beams | 0 / 0 / 0 | 0 / 0 / 0 |
| Площадь пола | 24.408 м² | 24.116 м² |
| Высота этажа | 2.994 м | 2.992 м |
| Средний wall-fit RMS | 6.7 мм | 3.1 мм |

Сгенерированный UI IFC4 на каждом входе содержит 4 `IfcWallStandardCase`, 1 `IfcOpeningElement`, 1 `IfcRelVoidsElement`, 1 `IfcColumn`; beam/pipe/cable counts — нулевые. Unit test сверяет концы void relationship с реальными wall/opening entity IDs и проверяет, что opening попал в storey containment.

## Round-trip координат исходного облака

На неизменённом исходном облаке был вызван `getSourceCloud()`. Затем проверен реальный ribbon E57 экспорт и Smart Save LAS/PLY/XYZ/PTS/PCD/OBJ; сериализованные файлы были повторно прочитаны локальными бинарными/text readers. Все форматы сохранили по 205 526 точек и совпадающие min/max XYZ в source frame:

| Вход | Диапазон исходных XYZ (min → max) | Форматы / максимальное отличие границ |
|---|---|---|
| georeferenced LAS | `[499998.015, 5999997.952, 117.969]` → `[500007.977, 6000005.976, 125.164]` | E57 0; LAS 0.00000017 м; PLY/XYZ/PTS/PCD/OBJ 0 |
| local Z-up PLY | `[-1.98484, -1.92821, -1.97298]` → `[7.97716, 5.99929, 4.98241]` | E57 0; LAS 0.000495 м; PLY/XYZ/PTS/PCD/OBJ 0 |

LAS round-trip отличается в пределах масштабного шага LAS; оба результата существенно точнее 1 мм на этом fixture. Проверка использует E57Core и собственные readers заголовка LAS/PLY и строковых данных; это не независимый `laspy`/`pye57` или third-party import test.

## Что именно не считается пройденным

- Независимый IFC4 schema и geometry validator не запускался: `ifcopenshell`/`ifcvalidate` отсутствуют в среде. Не проверены импорт и void behavior в Revit, Bonsai, Solibri или стороннем CAD/BIM reader.
- Проверены IFC STEP entities/relationships и сохранение source frame; корректность всех IFC schema rules, placement inheritance и Boolean реализации сторонним ПО остаётся внешней проверкой.
- Click-smoke — только сигнализация нажатий: 38 из 99 действий не выдали наблюдаемый toast/modal/log/state/download. Они не считаются прошедшими функциональную проверку; нужен отдельный сценарий с нужным контекстом, выбором/геометрией или проверкой состояния.
- После frame-changing alignment/merge/overlay исходный transform сбрасывается, чтобы не выдавать преобразованное облако за исходные UTM координаты. Экспорт тогда отражает новую локальную систему, но пользовательский frame/transform history warning требуется сделать более явным; current round-trip проверял нетронутые входы.
- В модели отсутствуют реальные `IfcDoor`/`IfcWindow` полотна/рамы; автоматически создаётся только opening feature. Legacy IFC2X3 export не генерирует explicit openings.
- E2E проверяет генерацию IFC в памяти, а не file save/reopen round-trip.
- Не прогонялись установленная Windows сборка, packaged SQLite native runtime, облака 1M/10M+, benchmark RAM/VRAM/time, independent `laspy`/`pye57` и целевые CAD/GIS/BIM продукты в этом инкременте.
- Дорожная карта всё ещё частична: этап 1 corpus/validator acceptance не закрыт, этапы 2–14 остаются незавершёнными или требуют отдельных критериев приёмки.

**Статус:** приняты локальные false-positive и IFC4 relationship regressions; выпуск production-ready не заявляется.