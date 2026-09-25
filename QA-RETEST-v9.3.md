# BIM TWIN — повторный QA v9.3

> Исторический промежуточный отчёт. Завершённый click-smoke и последующие изменения terrain задокументированы в `QA-RETEST-v9.4.md`; этот файл не является текущей приёмкой.

**Дата:** 2026-09-24  
**Итог:** изменения mesh-section подтверждены на synthetic geometry и в app harness; общий продукт и 15-этапная дорожная карта **не завершены**.

## Окружение

- Linux test sandbox, Node.js 24.
- Electron harness с fake Electron main/preload; UI проходит в Chromium/Playwright с SwiftShader.
- SQLite native module `better-sqlite3` в окружении отсутствует; приложение использовало JSON fallback. Сохранение/миграция SQLite и Windows ASAR/native package не принимались.
- Независимый IFCOpenShell/validator и целевые AutoCAD/Revit/BricsCAD в этом прогоне не использовались.

## Результаты

| Проверка | Результат |
|---|---|
| `node --test` | 684 всего; 681 pass, 3 skip, 0 fail |
| Syntax | 202 JS/MJS/CJS файла; 0 ошибок |
| Тесты точного section-kernel и UI | 13/13 pass |
| Mesh browser E2E: Y-up PLY | X, Y, Z плоскости; по 1 замкнутой полилинии в DXF |
| Georeferenced PLY E2E | Double coordinates, Z-up, CRS WKT прочитана; Z-план, 4 вершины DXF, bounds в пределах 1e-6 |
| Preview/input E2E | Preview имеет видимые пиксели; смена уровня инвалидирует старый preview; пустой уровень отклоняется; повторный preview/export проходит |
| Browser errors в Mesh E2E | 0 page/IPC/no-handler ошибок; launcher сообщил штатный SQLite→JSON fallback |
| Scan→BIM plan DXF | `room.las` / `room.ply`: 4 стены, 1 проём, 1 объект; 4 wall lines, 1 opening line; ошибок нет |
| IFC2X3 text inspection | `room.las` / `room.ply`: 4 `IFCWALL`, 1 `IFCCOLUMN`; файл создан |
| IFC4 text inspection | `room.las` / `room.ply`: 4 `IFCWALLSTANDARDCASE`, 1 `IFCCOLUMN`, 2 `IFCSLAB`; автоматические кандидаты балок/кабелей не включены без ручной проверки |
| UI click-all LAS/PLY | Полный повторный sweep v1222 ожидает завершения; числа и список не подтверждённых событий будут внесены после окончания процесса. До него предыдущий v1221 sweep имел по 99 действий/формат, 0 JS/page errors и 39 действий без toast/modal/log-события. |

### Точность и геометрия сечения

- Synthetic Y-up box: X/Y/Z дают по одному замкнутому loop; DXF R12 содержит одну closed `POLYLINE`.
- Georeferenced Z-up double PLY: уровень по умолчанию — середина Z-границ; output XY сохраняет source frame и совпадает с input менее чем на 1e-6 (DXF численно округляет до шести десятичных знаков).
- Дополнительные kernel fixtures проверяют цилиндр с 48 гранями, coplanar patch, отверстие/три disconnected компоненты, открытый треугольник, transform matrix, большие координаты, invalid indices/plane и лимит ресурса.
- Для каждого успешного preview UI сообщает число замкнутых/открытых линий и предупреждает, что меш не обрезается.

## Полный клик-smoke: интерпретация

Автоматический click-all не является доказательством корректности каждой функции: 39 из 99 действий на старом sweep не создавали наблюдаемого toast/modal/log. Это может означать toggle/tool state, file picker или no-op. Для Tier-1 workflow нужны предусловия, проверка изменения состояния/контента, cancel/undo и export/reopen assertion. Текущий клик-smoke дополняется целевыми E2E для mesh section и Scan→BIM; ручная проверка остальных 39 элементов остаётся открытой.

## Ограничения и незакрытые приёмки

1. Точное сечение работает по загруженным triangle meshes PLY/GLB/glTF; point-cloud sections используют существующий slab/raster путь. Нет auto-TIN из облака.
2. Teal preview — экранная overlay-линия, не clipping, не cut cap и не скрытость по depth buffer. Исходная геометрия неизменна.
3. Синхронный лимит kernel — 2 млн треугольников; нет progress/cancel/worker, saved sections, curved sections или многоплоскостного набора.
4. DXF R12 не содержит CRS/WKT/вертикальный datum; проект CAD должен назначить CRS вручную. PLY units без метаданных неизвестны.
5. IFC проверен текстово и геометрическими инвариантами генератора, но не сторонней schema/geometry проверкой. IFC4-проём — разрыв тел стен, без explicit opening entity/void relation.
6. Windows installer, code-signing, ASAR, native SQLite, целевые CAD/BIM программы, production GPU drivers и большие наборы (1M/10M/50M+) не тестировались.
7. Protected cleanup, tour/3DGS и LCC2 modules не изменялись; их полноценная regression-проверка остаётся отдельной задачей.

## Следующие обязательные шаги

1. Дождаться и записать v1222 click-all результатов LAS/PLY; для 39 действий добавить per-control assertions вместо трактовки «без лога = no-op».
2. Провести независимый IFC validator и CAD/BIM reopen; подтвердить door/opening representation и source CRS.
3. Поддержать mesh section, построенный из point cloud/TIN; добавить сохранённые секции и извлечение точек/CSV/image.
4. Перенести тяжёлый section kernel в worker/chunked pipeline с прогрессом и отменой; stress-test на больших мешах.
5. Продолжить Stage 1 corpus, затем проектную сохранность, out-of-core point clouds, registration, классификацию, terrain и целевой Windows release по `IMPLEMENTATION-PLAN.md`.