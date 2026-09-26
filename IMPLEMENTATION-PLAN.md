# Долгосрочная дорожная карта BIM TWIN — от текущего состояния до профессионального продукта

**Снимок проекта:** review package 1.1.17; Stage 3 включает multi-scan PTX import/export с per-scan ranges/rigid poses при валидных metadata, CSV round-trip и PCD LZF preview через ограниченное по памяти потоковое декодирование во временный planar-файл с предварительными RAM/disk проверками, но остаётся частичным. Stage 4 включает background parsing/progress/cancel, disk-backed octree LOD с ограниченными RAM/GPU-кешами и bounded-working-set ingest для поддерживаемых ASCII/binary scalar-property PLY point clouds, uncompressed LAS PDRF 0–10 и PCD ASCII/interleaved-binary/LZF. Node format v2 сохраняет optional normalized intensity/classification и WebGL умеет их отображать; произвольные extra dimensions и stream-aware full-cloud tools пока не входят. PCD preview остаётся выборочной in-memory отрисовкой; PLY mesh и другие форматы пока memory-backed. Точное mesh-сечение OBJ/STL/PLY/glTF работает в Worker с отменой и прогрессом. Этапы 5–7 получили локальный код и regression-тесты, но не прошли полную приёмку: ICP остаётся local solver без global initializer/pose graph; CRS/geoid/device adapters отсутствуют; semantic AI и полномасштабные stream-aware editing workflow не готовы. Подробности: `CHANGES-review-stage2.md`, `QA-RETEST-stage2.md`, `CHANGES-review-stage3.md`, `QA-RETEST-stage3.md`, `CHANGES-review-stage4.md`, `QA-RETEST-stage4.md`, `CHANGES-review-stage5-7.md`, `QA-RETEST-stage5-7.md`.
**Рыночная матрица:** `MARKET-FEATURE-MATRIX.md`.  
**Последняя воспроизводимая проверка:** clean worktree review-ветки `agent/windows-package-qa` на базе `b2ea035` плюс новые QA-поправки из `QA-RETEST-stage0-7-current.md`. Linux/Node 24: `npm test` — 883 total / 880 passed / 0 failed / 3 skipped без пользовательских файлов; с ранее предоставленным локальным OBJ/STL/PLY набором — 883 / 882 / 0 / 1 (только physical GPU skip). Focused Stage 2/3/4/5–7 — 31/41/81/103 passed; LAZ suite — 5/5; `npm run check`, JS syntax (241 файлов), Python syntax (28 файлов), PLY syntax и `npm run test:store` — passed. Предшествующий commit `b2ea035` имел 4/4 hosted checks; новые workflow/fixture changes ожидают CI. Подробный статус — в `QA-RETEST-stage0-7-current.md`.

**Статус 15 этапов:** программа ещё не завершена. Этап 0 закрыт; этап 1 частичный; этап 2 выполнен в заявленном JSON/SQLite и Linux test-boundary (см. ограничения); этапы 3–7 продвинуты, но частичные и не приняты; этапы 8–14 остаются в плане.

## Цель и честное определение «идеала»

«Весь функционал, который есть на рынке» не является конечным списком: продукты постоянно добавляют модули, поддерживают разные приборы, отрасли и проприетарные форматы. Поэтому целевой «идеал» здесь — **100% закрытие согласованной матрицы профессиональных workflow**, а не заявление о копировании каждой функции любого продукта.

Эталонная матрица включает рабочие направления LixelStudio, CHCNAV CoProcess/Classic, Leica Cyclone 3DR, Trimble RealWorks, FARO SCENE и Autodesk ReCap. Она разделяет:

1. **Обязательный профессиональный уровень:** надёжные данные/CRS, обработка облаков, регистрация, измерение/QC, сечения/CAD, terrain/volume, BIM-выходы, отчёты, масштаб и обмен.
2. **Отраслевые расширения:** SLAM/PPK конкретных приборов, plant/road workflows, AI-модели, photogrammetry/VR, native DWG/Revit, облачное сотрудничество.
3. **Зависимости от правообладателя/оборудования:** proprietary RCP/сканерные raw-файлы и закрытые SDK. Их можно поддерживать только по лицензии или через официальный обменный интерфейс, не имитировать и не копировать закрытый код.

На каждом шаге результат должен иметь воспроизводимый тест и явный статус: **проверено / частично / не поддержано / требует аппаратного или лицензированного доступа**. Необоснованный показатель «100%» не публикуется.

## Текущая доказательная база

- **v8/v9 проверено:** ортогональные X/Y/Z-сечения, наклонный профиль 45° с экспортом DXF/CSV на `room.las` и `room.ply`; геопривязанные экспорты, LAS/E57/PLY-сценарии и геометрические/терренные regressions отражены в `CHANGES-review.md`.
- **Последняя регрессия v9.4:** 690 тестов — 687 пройдено, 3 пропущено, 0 ошибок; syntax-check 203 JS/MJS/CJS-файлов — 0 ошибок. Mesh-section E2E v9.3 остаётся валидным; новый terrain E2E подтверждает параметризованный шаг, пустой-результат UX и DXF с 40 LINE-сегментами.
- **Широкий click-smoke v1223:** повторён по 99 действиям на каждом LAS/PLY; 0 зарегистрированных JS/page/IPC/no-handler ошибок, 12 файловых выгрузок на формат. После исправления пустых горизонталей один прежний пустой DXF не скачивается. По-прежнему 39 действий на формат без зафиксированного toast/modal/log/state-change; полное семантическое подтверждение не пройдено. Результаты приложены в `QA-artifacts/v9.4/` и описаны в `QA-RETEST-v9.4.md`.
- **Terrain E2E v1223:** на тестовом помещении 0,50 м не даёт пересечений, поэтому UI ничего не скачивает и сообщает причину; шаг 0,05 м создаёт DXF с 3 уровнями / 40 сегментами. Kernel ограничивает чрезмерные level/work/segment requests. Сшивка сегментов в polylines и независимый CAD/terrain oracle ещё отсутствуют.
- **Новый приёмочный пакет v9.5:** для 2D-черчения 25 assertions на LAS и 25 на PLY проверили шесть режимов, доступность закрытия/undo/clear, вершины/объекты и R12 DXF source-frame export→import round-trip. Координаты тестового LAS в DXF совпали с исходным UTM в допуске 1e-6; для PLY проверен локальный source frame. Точки вводились через `__lxDraw.onPick`, не реальным ray-pick. Point-cloud срезы Y/Z/X проверены на 9 assertions: каждый preset оставляет полосу 0,2 м и реальный непустой поднабор из 205 526 точек, сброс возвращает полный диапазон. LOD/изоляция — 9 assertions: LOD честно отключён для облака, работает для синтетического triangle mesh (4→2 triangles и exact restore), изоляция без выбора не прячет облако, выбранный BIM-объект изолируется и состояние снимается. Артефакты и runner находятся в `QA-artifacts/v9.5/`.
- **Новый приёмочный пакет v9.7:** в панели «Контур сечения» добавлены именованные параметры X/Y/Z и наклонного профиля (уровень, азимут/начало/смещение, ширина полосы, ячейка, min-area). Наборы хранятся по активному проекту, до 100 записей, попадают в JSON/SQLite project backup и sync envelope; одинаковые названия обновляются только после подтверждения. При сохранении фиксируются basename источника, количество точек, границы, axis transform/CRS code и контрольная выборка координат; при расхождении источника применение требует явного подтверждения. На LAS и PLY выполнено по 11 E2E check groups: пустое имя, сохранение, точное восстановление plan/profile, update duplicate, cross-source confirmation, delete и project isolation. Unit-тесты подтверждают JSON restart/backup/merge. `better-sqlite3` в среде отсутствует: runtime SQLite-класс не прогонялся; схема/уникальность Unicode проверена встроенным Python SQLite.
- **v9.7 исправление пустого проекта:** переключение на проект без помещений раньше могло вызвать null access к `current.documents`; добавлено безопасное empty-state для документов/свойств, воспроизведено переключением проекта через UI, 0 page errors.
- **Новый приёмочный пакет v9.8 / Scan-to-BIM:** движок v1230 больше не принимает параллельные рёбра подтверждённой балки за трубы; кабель требует непрерывной вертикальной поддержки от потолка и не дублирует уже распознанную колонну. Добавлены аналитические beam+column/actual-cable controls и прогон LAS/PLY. В v1231 IFC4 получил геометрию `IfcOpeningElement` и `IfcRelVoidsElement` для каждого ограниченного валидного проёма; сегментированное тело стены сохранено для совместимости readers, оси/геопривязка экспортируются в том же source frame. На обоих 205 526-точечных файлах через реальный renderer UI: 4 стены, 1 дверь-проём, 1 колонна, 0 pipe/cable/beam; LAS — площадь 24.408 м², высота 2.994 м, средний RMS стены 6.7 мм; PLY — 24.116 м², 2.992 м, 3.1 мм. IFC entity/relationship E2E прошёл; независимый IFC schema/geometry validator и целевой BIM reader в среде отсутствуют. Отдельный export round-trip на LAS/PLY подтверждает E57/LAS/PLY/XYZ/PTS/PCD/OBJ и точность координат; frame после геометрических преобразований требует явного UX/истории. Доказательства и runner находятся в `QA-artifacts/v9.8/`.
- **Новый приёмочный пакет v9.9 / фоновые сечения:** растровые X/Y/Z и наклонный профиль работают в отдельном Web Worker с фазовым прогрессом; отмена поддерживается кнопкой, закрытием панели и событиями смены проекта/облака. Компактный interleaved-буфер уменьшает временные аллокации; входная копия ограничена 128 МиБ, сетка — 4 млн ячеек, очередь не меняет чертёж частичными результатами и проверяет актуальность облака/сессии. На `room.las` и `room.ply` по 205 526 точек выполнено по 8 E2E-групп: отмена всеми четырьмя путями, отказ на искусственном превышении лимита до копирования, идемпотентный повтор, плоскости X/Y/Z и профиль 45° с DXF+CSV и повторным чтением внутренним DXF reader. Каждая ось дала по 2 растровых контура, максимальная ошибка плоскости — 0; профиль — 2 контура (LAS: 7 540 точек/40 строк вершин, PLY: 7 461/35). Worker сообщает завершение, после теста остаётся 0 Worker и нет ошибок страницы/IPC. В этом Chromium-harness наблюдался лишь ориентировочный диапазон 26–40 мс между событиями прогресса Worker; это не benchmark и не показатель для рыночного сравнения. Не выполнены benchmark реальных 1M/10M облаков, out-of-core/streaming и проверка экспорта в стороннем CAD/GIS; отдельное mesh-сечение на момент v9.9 оставалось синхронным; в v10.1 оно вынесено в Worker. Артефакты: `QA-artifacts/v9.9/`.
- **Новый приёмочный пакет v9.6:** кнопка «Сохранить точки полосы · CSV + JSON» извлекает действительные точки выбранного X/Y/Z-среза, сохраняет стабильный нулевой point index, XYZ, RGB и JSON с осью/уровнем/толщиной/source transform/CRS. Source XYZ применяется только если viewer всё ещё имеет валидный transform; иначе результат явно помечается как локальная система вьюера. 15 именованных E2E check groups на каждом LAS и PLY подтвердили геометрию контура на заданной плоскости, отсутствие дублирования при повторном построении, ошибку пустого среза, валидацию толщины и CSV+JSON download; выбранные CSV-точки сверены с исходными LAS/PLY records для всех координат и цветов. Отдельно проверен наклонный профиль 45° с DXF станции/отметки + CSV: 2 контура на каждом файле; 7 540 точек/40 вершин для LAS, 7 461/35 для PLY. В v9.6 fixtures имеют 205 526 точек; независимый внешний CAD не запускался. Результаты и воспроизводимый runner — в `QA-artifacts/v9.6/`.
- **Найдено и исправлено в UI-hardening:** кнопка «Построить BIM 1:1» перемещалась из панели из-за широкого поиска кнопок по тексту; отмена режимов сбрасывала сторонние `.on`-переключатели; начальное состояние «Подсветка НС» не совпадало с viewer. Владение кнопками ограничено их панелями, добавлены стабильные ID и регрессионные тесты.
- **Scan→BIM/IFC:** прежнее исправление стеновых offsets сохраняет 4 стены и 1 проём на LAS/PLY. С v9.8 IFC4 дополнительно содержит `IfcOpeningElement` и связь `IfcRelVoidsElement`; тела стены по-прежнему сегментированы. IFC2X3 остаётся legacy-экспортом стен/колонн без явных проёмов. Положительное распознавание геометрии подтверждено, но схема/геометрия IFC не прошла независимую проверку; автоматические MEP/балки остаются кандидатами для ручной проверки.
- **Экспортная проверка:** предыдущие внутренние проверки E57/LAS/PLY/GeoTIFF остаются в v9.2; в текущем цикле DXF из точного mesh-сечения повторно открыт/разобран тестовым reader: 4 контура, по одной замкнутой полилинии, геопривязанные XY в пределах 1e-6 с учётом округления R12 DXF до 6 знаков.
- **Ограничения текущей проверки:** Electron harness использовал JSON fallback (в окружении нет `better-sqlite3`); Windows installer/ASAR и обмен с целевыми CAD/BIM-программами не проверялись. `pye57` independently read the generated multi-scan E57 from the PTX UI export (2 scan blocks, XYZ/RGB/intensity). An independent LAS reader was unavailable for that historical run, so no claim of external LAS re-read is made here.
- **Оставшиеся подтверждённые пробелы:** точное сечение пока работает по загруженному треугольному PLY/GLB/glTF, не строит TIN автоматически из облака и не заменяет быстрый raster point-cloud section; preview — 2D overlay, не физическое обрезание меша/section cap, не depth-tested и не редактируемый CAD-документ; расчёт ограничен 2 млн треугольников и 128 MiB транзитной копии; DXF R12 не переносит CRS/units. Меш проекта в основном 2.5D heightfield; потоковая обработка, raw SLAM/PPK, multi-scan hybrid registration, полный Scan-to-BIM/Plant, native DWG/Revit и collaboration не закрыты.

- **Актуальный review checkpoint:** после clean retest Stage 2 focused 31/31, Stage 3 focused 41/41, Stage 4 focused 81/81, Stage 5–7 focused 103/103; LAS/LAZ tests 5/5; полный набор 883/880/3 без приватных fixtures и 883/882/1 с ранее предоставленными local OBJ/STL/PLY. Stage 1/3–7 всё ещё partial/not accepted; новые QA details и внешние gates — `QA-RETEST-stage0-7-current.md`.

## Этапы — полный путь, не только ближайшая задача

Порядок учитывает зависимости: сначала надёжная геометрия, формат и тесты, затем масштабирование и сложные отраслевые workflows. Сроки намеренно не выдумываются до benchmark и доступа к реальным наборам.

### Этап 0 — карта рынка и соглашение о готовности (**выполнен на текущем цикле**)

- Составлена `MARKET-FEATURE-MATRIX.md`: сравнение шести профессиональных экосистем и статус BIM TWIN по каждому направлению.
- Проверены публичные руководства поставщиков и открытые проекты; рекламные заявления отделены от независимо измеренных значений.
- Для каждой функции в матрице зафиксировать владеющий модуль, зависимость, user-visible результат, test oracle и ограничения лицензии/оборудования.
- **Выходной критерий:** никакая кнопка/заявление не остаётся без статуса и критерия приёмки. Новые требования добавляются в матрицу, а не теряются в чате.

### Этап 1 — эталонные данные и QA-процесс (**начат частично; приёмка не пройдена**)

- Собрать курируемую fixture-библиотеку: геопривязанный LAS/LAZ, E57 с несколькими сканами/pose, RGB/intensity, PLY cloud и mesh, PCD/PTS/XYZ, indoor room, MEP/plant, фасад, дорога/terrain, stockpile, слабое перекрытие, выбросы/holes.
- В актуальной повторной проверке room LAS/PLY и large-PLY fixtures генерируются детерминированно; три компактных LAZ fixtures теперь проходят LAS/LAZ 1.2/1.4 decoding и decimation tests. Ранее предоставленные OBJ/STL/большой PLY также прошли локально; файлы пользователя остаются вне Git. Всё это не заменяет лицензированный production corpus.
- **v10.0: для локальной проверки применялся дополнительный пользовательский набор BIM/геометрии. Исходные файлы, названия, контрольные суммы и архивные метаданные хранятся вне Git; права на повторное распространение не подтверждены, поэтому набор намеренно не публикуется и не включён в CI.
- **v10.1 exact mesh section:** X/Y/Z контуры на OBJ и STL считаются в отдельном Web Worker с фазовым прогрессом; явная отмена, смена плоскости, выход из viewer и замена сцены завершают Worker, а частичный/устаревший результат не становится превью. На каждом файле три среднеуровневых сечения дали не пустые замкнутые/открытые пути; каждый из шести экспортов R12 разобран тестовым внутренним DXF reader с совпадающими counts и closed-state. Stress harness повторил ссылки на primitive до 1 261 560 triangle instances / около 88,5 MiB для проверки отмены и замены; исходники не менялись. Это UI/kernel regression, не независимая CAD-проверка и не benchmark.
- **v10.0 покрытие форматов:** пользовательский OBJ открыт в UI как 315 390 треугольников / 809 574 render-вершин; STL — 315 495 / 946 485. Оба парсятся в Worker, исходные координаты и отдельный Float64 буфер точного сечения сохранены; Lixel-панель и версия UI остаются видимыми поверх mesh canvas. Контрольный section kernel вернул 488 замкнутых и 135 открытых контуров для каждого меша; открытые контуры отражают реальную незамкнутость исходной геометрии и не считаются watertight solid. Вогнутый n-gon, отрицательные OBJ-индексы, binary STL с `solid` заголовком и некорректные facets имеют unit regressions. PLY прочитан Node-стримером с лимитом 1 млн точек (959 559 после воспроизводимого sampling), но полный 15,35 млн UI/GPU тест не выполнялся. RVT/RFA/SKP не декодируются текущим приложением. DWG sample определён как AC1021; локальная WASM-сборка отсутствует и конвертер не проверен.
- Для каждого файла записать источник/лицензию, ожидаемые point count, bounds, CRS, units, hashes и известные ограничения.
- Для каждого действия интерфейса проверять позитивный сценарий, пустой/невалидный ввод, cancel/undo, warning, видимый результат и round-trip экспорта.
- Сделать единый click-smoke для всех доступных кнопок: запрет молчаливых no-op; если функция не работает в окружении — точное объяснение вместо фальшивого успеха.
- Сравнивать с независимыми readers/reference software; для геометрии публиковать RMSE/95-й процентиль/допуск, а не только факт построения.
- **Наблюдение v9.1:** 97 действий на LAS/PLY дали 0 JS/page errors, но у 39 действий на формат не было зафиксировано toast/modal/log. Семантические проверки закрывают только перечисленные сценарии, не все 97 кнопок. v9.5 добавляет точечные сценарии для drawing history, DXF и сечений, но не закрывает оставшиеся действия без видимого эффекта.
- **Acceptance gap v9.3:** cross-format wall pairing и IFC2X3/плановый export приведены к одному canonical model: на проверенных LAS/PLY каждый сообщает 4 стены и 1 проём. Геометрическая ground truth всё ещё нужна для подтверждения найденных объектов/отверстия; IFC4 делит solid стены, но не создаёт explicit `IfcOpeningElement`/void relationship, и независимый schema/geometry validator ещё не запускался.
- **Приёмка:** каждый Tier-1 элемент матрицы имеет unit + synthetic + fixture + UI/IPC + export/reopen regression; результаты и hashes записываются в QA report.

### Этап 2 — фундамент проекта, сохранность и редактирование данных

- Версионированное состояние проекта: облака, слои, transforms/CRS, классификация, section sets, measurements, чертежи и документы.
- Проверить атомарное сохранение, авто-восстановление после аварии, undo/redo для операций, повторное открытие проекта, пути/Unicode/права.
- Разделить оригинал, производные и изменяемые версии; операции очистки/регистрации не портят источник.
- Добавить операционный журнал: параметры алгоритма, входной hash, время, output, предупреждения и версия приложения.
- **Приёмка:** kill/restart tests, project migration tests, rollback/undo tests, повторная обработка даёт тот же output в заданном допуске.
- **Статус Stage 2:** реализация и проверка сохранности проекта завершены на JSON и SQLite (`better-sqlite3` в отдельном E2E, SQLite migration suite на встроенном `node:sqlite`); текущие результаты — `CHANGES-review-stage2.md` и `QA-RETEST-stage2.md`.
- В состоянии проекта есть восемь версионируемых коллекций; одинаковый нормализованный payload даёт одинаковый SHA-256 и не создаёт лишнюю revision/journal-запись. История ограничена по числу/размеру, undo/redo и ветвление проверяются.
- Облачные автосохранения хранятся как неизменяемые SHA-256-верифицируемые revisions; журнал связывает входной hash, параметры, выход, warnings, timestamp и версию приложения. Исходный путь/transform/CRS сохраняются, история позволяет восстановить более ранний draft.
- Проверены переходы между проектами, миграции/backup, Unicode-пути, восстановление после завершённого сохранения и rollback при ошибках записи. В браузерном harness проверены видимые команды Undo/Redo и восстановление истории.
- **Граница приёмки:** идемпотентность подтверждена для нормализованного состояния проекта и содержимого автосохранений, не для численных результатов каждого геометрического алгоритма. Проверены injected EACCES и реальный Linux DAC denial; Windows ACL, installer, аппаратный power-loss и физический диск не проверялись. Stage 2 закрыт в этом тестовом scope; это не означает приёмку следующих этапов.

### Этап 3 — импорт/экспорт, координаты и интероперабельность ядра

- **Статус Stage 3:** частично реализован, приёмка не пройдена. Подробные матрица, тесты и блокеры находятся в `CHANGES-review-stage3.md` и `QA-RETEST-stage3.md`.
- Матрица форматов/версий/attributes: LAS/LAZ/COPC, E57, PLY cloud/mesh, PTX/PTS, XYZ/CSV/PCD, изображения/trajectory, DXF/DWG, IFC, GeoTIFF и веб-форматы.
- **v10.0:** встроен OBJ/STL → один статический меш для просмотра/сечения; OBJ текстуры/MTL, групповые материалы и units/CRS не загружаются, исходные координаты не переинтерпретируются. Для OBJ ограничение — 2 млн triangles; нулевые коллинеарные углы удаляются и считаются в diagnostics.
- Нормализовать coordinates, axis/up, unit, scale/offset, WKT/EPSG, vertical datum/geoid, color/intensity/class, scan transforms и timestamps.
- Реализовать понятные capability flags: не терять неподдержанные поля молча; preflight перед экспортом.
- Round-trip на больших координатах и mixed-source clouds; недопустимые CRS mixing должны блокироваться или просить явное подтверждение.
- **Приёмка:** независимые readers; контроль headers/count/attributes/CRS, координатные round-trips и ошибки в допустимых пределах; комплект форматов отражён в UI/help.
- **Выполнено в review 1.1.17:** LAS/E57/PLY/PCD/PTX/PTS/XYZ/CSV desktop import/export (CSV с BIM Twin comments и per-point fields); PTX multi-scan import/export сохраняют grouping и rigid poses при валидных ranges, экспортируют 1 строку на scan; LAS 1.4 PDRF 7, binary E57, PCD ASCII/binary/LZF tests; source-frame round-trip и export preflight; optional LAZ import; capability registry отделяет `supported`, `partial` и `unsupported`. В UI default first-open point budget ограничен 3 млн, пользователь может увеличить лимит настройкой. Проверки и численные критерии приведены в Stage 3 QA.
- **Оставшиеся блокеры:** COPC hierarchy/streaming, восстановление исходных PTX scan grids/missing-return cells и реальные приборные PTX corpus, DWG, full IFC/raster/image/trajectory exchange, universal PLY mesh round-trip, E57 classification/timestamps/images and other ancillary fields, LAS extra dimensions/GPS time, CRS reprojection/vertical datum, external CAD/GIS/BIM open and large-production benchmarks. PCD `binary_compressed` preview больше не создаёт contiguous decompressed buffer: LZF потоково пишет полный planar scratch на диск и выдаёт только выборку в пределах preview budget; это не full out-of-core viewer. LAZ тоже не out-of-core. Этап не объявлять завершённым до приёмки остальных требований.

### Этап 4 — движок больших данных и производительность

- **Статус Stage 4:** частичный, приёмка не пройдена. На пользовательском binary PLY проверены bounded-working-set ingest, disk-backed partition/octree, visible-node LOD и cleanup; scalar-property ASCII PLY, uncompressed LAS и PCD ASCII/interleaved-binary/LZF прошли Worker/IPC и viewer LOD/cleanup. Node-record v2 переносит optional normalized intensity/classification; проверены backward compatibility v1, повреждённый index rejection, async fetch/dedup, generation guard для смены облака, bounded retry/backoff и GPU display modes. Headless Chromium/WebGL2 SwiftShader shader/link/upload/render smoke прошёл. PCD LZF preview декодируется ограниченными чанками во временный planar disk store; progress, disk/RAM preflight, refusal и Worker/UI cancellation с cleanup проверены. Это sampled preview, не full out-of-core viewer; PLY mesh и другие форматы memory-backed. Полноценная packaged Windows/ASAR/GPU acceptance и benchmark всё ещё отсутствуют.
- **Граница реализации:** двухпроходная ветка поддерживает ASCII и binary LE/BE PLY с первым непустым `vertex` element и scalar properties, uncompressed LAS PDRF 0–10 и PCD `DATA ascii`/interleaved `DATA binary`/LZF `DATA binary_compressed`; node-record v2 сохраняет XYZ/RGB8 и при наличии исходника optional normalized intensity/classification, legacy v1 читается. Произвольные extra dimensions не сохраняются. Перед node-read main process проверяет version/layout/stride, finite bounds, counts, contiguous offsets, totals, graph и точный размер `nodes.bin`. И preview, и PCD LZF LOD используют временный planar disk store; preview проверяет свободное место на temp-volume где доступна `statfs`, создаёт приватный каталог, декодирует bounded I/O chunks и удаляет его после успеха/ошибки/отмены. Перед выделением typed arrays preview оценивает RAM как 128 bytes/точку + 128 MiB и допускает до 70% доступной памяти; это эвристика, не hard quota. Preview всё ещё возвращает ограниченные выбранные typed arrays в память; это не заменяет out-of-core viewer. Для индекса полный planar size включён в main-process disk preflight. Preview transform передаётся индексу, чтобы LOD оставался зарегистрирован с уже открытой сценой. При построении используются временные partition-файлы; cancel и preflight отказов проверены. Это bounded-working-set путь для перечисленных layouts, не для всех форматов и не обещание 100 GB.
- До приёмки остаются расширение chunked ingest на другие форматы, атрибуты и stream-aware инструменты/export, persistent/resumable stores, pressure/cold-repeat benches, целевые GPU/VRAM и Windows packaged/ASAR проверки. Конкретные тесты и ограничения приведены в `QA-RETEST-stage4.md`.
- Поддержать прогресс, cancel, паузу/возобновление, временные файлы, безопасное удаление и диагностические logs.
- Отдельно измерить CPU/GPU paths и software fallback; не выполнять долгие проходы на renderer thread.
- **Benchmark-корзина:** 1M/10M/50M точек и далее 100GB набор только при наличии подходящего стэнда; записывать железо, RAM/VRAM, wall time, peak RAM, draw latency и точность.
- **Приёмка:** стабильные повторные прогоны в заданных budget; при превышении лимита — понятная рекомендация, не crash/lockup. Ни одна рыночная цифра в UI/продающих материалах не появляется без воспроизводимого benchmark.

### Этап 5 — регистрация, fusion и контроль качества (**частично; приёмка не пройдена**)

- Coarse alignment (features/targets/manual), target-based, cloud-to-cloud, robust multiscale ICP, hybrid registration с survey controls, multi-scan pose graph/loops.
- Диагностика слабой геометрии, частичного overlap, симметрии, плоских/линейных данных; контрольные точки отделять от использованных для оптимизации.
- До/после отчёт: матрица transform, overlap, residual distribution, RMSE, независимая check-point ошибка и предупреждения.
- В текущем локальном инкременте добавлены deterministic trimmed coarse-to-fine point-to-point ICP, centroid initialization, exact NN через SciPy или ограниченный NumPy fallback, минимальный overlap/degeneracy guards, metrics/report JSON и сохранение per-point RGB/intensity/classification при registration/deviation. Это не feature/global initialization, не pose graph/fusion; fitness — directed fraction, не взаимный overlap. См. `CHANGES-review-stage5-7.md` и `QA-RETEST-stage5-7.md`.
- **Приёмка:** известные синтетические rigid transforms + наборы с различным overlap/noise; repeatability и независимая проверка контрольными точками.

### Этап 6 — геодезия, приборные данные и точность (**частично; приёмка не пройдена**)

- Довести GCP/control network: least squares, веса/точности, исключение выбросов, residuals/covariance, локальные и глобальные CRS.
- Ввести библиотеку EPSG/vertical datum/geoid и документированный переход между осями/единицами.
- Отдельно спроектировать adapters для RTK/PPK/trajectory/IMU и оборудования. Без допустимых raw datasets, SDK и ground truth не объявлять SLAM/PPK-совместимость.
- Weighted robust 3D Helmert, роли control/check, независимые residuals, CSV validation и сохранение intensity/class при перепривязке покрыты unit/regression-тестами. Реального geodetic acceptance dataset, EPSG/grid/geoid engine и приборных adapters нет; UI-порог 5 см является только предупреждением-эвристикой, не допуском точности.
- **Приёмка:** контрольные геодезические точки с известной точностью, требования к горизонтальной/вертикальной ошибке, отчёт и конфигурация, повторяемые в Windows-сборке.

### Этап 7 — очистка, классификация и сегментация (**частично; приёмка не пройдена**)

- Чётко разделить reversible noise/outlier filters, downsample/resample, moving-object removal, manual polygon/lasso, ground PMF/CSF, semantic classes и AI inference.
- Классы terrain/ground, building, wall/floor/ceiling, road, vegetation, pole/wire, pipe/MEP и пользовательские labels; сохранять LAS class/extra bytes.
- Human-in-the-loop: показать confidence, класс/правки, diff, undo; не выдавать эвристику за AI.
- Текущий инкремент проверяет выравнивание RGB/intensity/classification в фильтрах, удалённых точках, undo, section clipping и voxel downsample (усреднение интенсивности и mode-класс); LAS/PLY serialization сохраняет атрибуты в поддерживаемых путях. Это не semantic AI, нет versioned annotated corpus/precision-recall-F1, object removal и stream-aware full-cloud editing; arbitrary LAS extra bytes не входят.
- Добавлена ручная ASPRS LAS-разметка выделенных точек (0–255) с memory-aware Ctrl+Z (sparse delta/dense snapshot), сохранением/очисткой project asset metadata и проверкой point-count/LOD ограничений; повторная загрузка с несовпадающим количеством точек предупреждает, а не применяет метки молча. Это human annotation tool, не модель классификации; UI/native prompt и packaged Windows сценарий ещё не прошли runtime acceptance.
- **Приёмка:** versioned annotated reference sets, precision/recall/F1 по классам, перед/после просмотр, корректный class export и обратимость.

### Этап 8 — просмотр, измерения, inspection и QA reports

- Единая проверенная навигация для cloud/mesh/IFC/panorama, переключатели RGB/intensity/elevation/class/depth, clip volumes, selection, section windows и readouts.
- Measurement/inspection: длины/углы/площади/объёмы, cloud-to-cloud/cloud-to-mesh deviation, floor flatness/levelness, clearance, tolerance bands, issue markers.
- v9.5: LOD теперь доступен только при реальной поддержке triangle mesh; для point cloud кнопка отключена и объясняет ограничение. Изоляция без выбранного элемента больше не скрывает всё облако; E2E подтверждает BIM-object isolate/unisolate. Полноценные measurement pick/accuracy и QA-report acceptance всё ещё не закрыты.
- Annotation, screenshots, CSV/PDF quality report с исходной CRS, методом, параметрами, допусками, автором/временем.
- **Приёмка:** геометрический oracle + known offsets, standards-based checks only where spec is licensed/implemented; экспортный report повторно открывается и не теряет provenance.

### Этап 9 — сечения, профили и профессиональный CAD (**частично выполнен; приёмка не пройдена**)

- **Частично реализовано v9.3:** точное пересечение triangles меша PLY/GLB/glTF плоскостями X/Y/Z; панель показывает up-axis, уровень в единицах источника, границы и CRS-ограничение; пользователь видит teal contour overlay и экспортирует R12 DXF. В узле меша добавлены coplanar boundaries, holes/disconnected contours и чистка triangulation midpoints. Ограничения: overlay — только preview, нет TIN-генерации из облака, saved section sets, нескольких плоскостей, depth clipping, progress/cancel и независимой CAD/CRS-проверки.
- v9.5: отдельный E2E проверил raster point-cloud section-box пресеты Y (план), Z (фасад) и X (бок) на 205 526 точках: каждый режет полосу 0,2 м, показывает непустой subset, сброс возвращает полный диапазон. Это проверяет UI и clip state, но не заменяет independent CAD/terrain oracle.
- v9.6: кнопка в панели «Контур сечения» сохраняет фактические точки по X/Y/Z в CSV + JSON sidecar: source XYZ (когда преобразование ещё валидно), иначе viewer-local XYZ; исходный point index, RGB, plane axis/level/thickness и CRS/WKT при наличии. 30 именованных E2E check groups на LAS/PLY проверили 3 оси, замыкание и положение контуров, повторное построение, пустой ввод, source coordinates/RGB по исходным records и profile 45° DXF+CSV. Ограничения: тестовые файлы не содержат CRS WKT; renderer не сохраняет intensity/classification; large-cloud throughput и external CAD пока не проверены.
- v9.7 добавил и проверил **saved named section parameter presets**, scoped к проекту и входящие в backup/sync; геометрия автоматически не перестраивается, каждый набор запоминает только параметры и контроль источника. v9.9 перенёс точечные контуры X/Y/Z и наклонный профиль в Web Worker: UI показывает фазы, поддерживает cancel, проверяет устаревший вход/чертёж и ограничивает копию 128 МиБ; компактный interleaved буфер прошёл сравнение kernel output. На LAS/PLY по 205 526 точек проверены реальные UI-плоскости, закрытые контуры, отсутствие ошибок плоскости, repeat build, отмена без изменения чертежа и наклонный DXF+CSV. Необходимы throughput/RAM benchmark на 1M/10M, streaming для ещё больших облаков, progress/cancel для exact mesh-section, сохранение контурной геометрии/аннотаций, migration/cold-restart в packaged Windows, image export и независимый CAD/GIS round-trip.
- Остаются несколько одновременно видимых плоскостей, изображение/растровый экспорт, annotation, scale/chainage/elevation, богатые LAS intensity/classification атрибуты, curved/unfolded profiles и CAD templates.
- Curved/unfolded profile, plane alignment, polygonal/orthogonal/arc drafting, snaps, dimensioning, building openings, native CAD layer/template workflow.
- Plan–Elevation Sync; world/local section coordinate conventions; CRS metadata only when valid. DWG-native — через лицензированный SDK/bridge либо стандартизованный DXF fallback.
- **Приёмка:** mesh plane intersections на box/cylinder/holes/disconnected components; contour topology; round-trip в CAD; на публичных/реальных фасадах оператор проверяет удобство и пропущенные детали.

### Этап 10 — terrain, TIN, дороги и civil (**частично выполнен; приёмка не пройдена**)

- **Частично реализовано:** PMF-style грунт, DSM/DTM GeoTIFF, сеточные объёмы и контуры с задаваемым шагом; пустой контурный результат не выдаётся как успешный DXF. Текущий DSM и контуры остаются ограниченным 2.5D workflow, contour export состоит из отдельных `LINE`-сегментов.
- Универсальный TIN/mesh, breaklines/boundaries, hole treatment, smoothing/filtering/simplification, DTM/DSM, contours и grid/triangulation volumes.
- Surface difference, stockpiles, cut/fill, phased reports; road alignments/stationing/curves/transitions, cross/longitudinal sections, corridor/bench features.
- Выбор метода (grid vs TIN) виден в UI; учитывать boundary/void/vegetation, вертикальные datums и interpolation.
- **Приёмка:** analytic fixtures, независимая контрольная программа, unit/CRS/area/volume tests, report parameters; 2.5D ограничение больше не маскируется под general mesh.

### Этап 11 — Scan-to-BIM и Plant workflows (**частично выполнен; независимая BIM-приёмка не пройдена**)

- Семантическое распознавание и operator-assisted fitting для стен, плит, потолков, колонн, дверей/окон, лестниц, фасадов, труб, elbows, flanges, tanks.
- Исправлена ошибка парного объединения симметричных стен: Scan→BIM/план/IFC2X3 дают 4 стены и 1 проём на проверенных LAS/PLY; синтетические 4/5-wall fixtures сохраняют количество при 2° наклоне и переводе начала координат. v9.8 добавил подавление ложных beam-edge pipes/column cables и IFC4 `IfcOpeningElement`→`IfcRelVoidsElement`; UI E2E подтверждает 4 стены, 1 opening relation и 1 колонну на обоих форматах. Независимая схема/геометрия IFC, IFC2X3 explicit opening, настоящие `IfcDoor`/`IfcWindow`, ручное подтверждение/редактирование и Plant/BCF остаются незакрытыми.
- Выдавать корректные parametric IFC objects, properties/classifications, units, placement, levels, storeys и stable IDs; BIM verification «as-designed/as-built».
- IFC2x3/IFC4/IFC4.3 и связка Revit/Bonsai/других целевых viewers; BCF issues только по согласованной схеме.
- **Приёмка:** IFC schema validators + геометрическая сверка размеров/отклонений + ручная проверка специалистом; автоматический fit должен показывать уверенность и editable result.

### Этап 12 — mesh, imagery, panorama, photogrammetry и 3DGS

- **v10.1:** mesh plane section запускается в Worker, показывает фазовый прогресс, поддерживает явную отмену, игнорирует stale results и закрывает/сбрасывает панель при смене сцены/выходе. Транзитная копия входных буферов ограничена 128 MiB; вход — 2 млн triangles, а synchronous fallback — только до 20 тыс. triangles при недоступном Worker. DXF R12 не несёт CRS/units.
- **v10.0:** user-supplied OBJ/STL теперь проходят unit + full-file parser + UI/WebGL checks; exact plane-section input использует исходные mesh-координаты. Это импорт/просмотр статического triangle mesh, не полноценное редактирование/реконструкция. OBJ .mtl/materials, true texture binding, units/CRS, axis override, multipart/object hierarchy и внешняя CAD round-trip ещё не принимаются.
- General 3D reconstruction (не только heightfield), watertightness/holes/normal consistency, texture/color, orthophoto/facade unfold и связь image-to-point/trajectory.
- Panorama/RealView, split-screen/pose sync, photo reports, VR/lightweight web viewer, LCC/LCC2 только через разрешённый SDK/официальные форматы.
- Проверить уже существующие защищённые 3DGS/tour/LCC2/cleanup modules без их перезаписи; расширения в этих файлах делать только после проверки прав/границ и отдельной фиксации.
- **Приёмка:** real photo+scan fixtures, точность регистрации images, mesh metrics, offline/online behavior, package/SDK license audit.

### Этап 13 — сотрудничество, автоматизация и интеграция

- Переносимые projects, versioned deliverables, markup/issues, BCF, user/role permissions, review packages, stable links и audit trails.
- Batch processing, task queue, scripting/API/plugin surface, export templates, CLI/automation, reproducible run manifests.
- **Приёмка:** запуск unattended batch и повторный output, error recovery, multiple project handoff, audit log, compatibility with chosen ticket/BIM tools.

### Этап 14 — промышленный релиз, безопасность и поддержка

- Windows installer/ASAR/native dependencies, code signing, upgrades/rollback, clean machine installation, offline mode, GPU fallback, crash recovery.
- SBOM, license notices, file-parser fuzzing, resource limits, safe temp-file handling, backup/restore, CVE/dependency lifecycle.
- DWG build dependency `@mlightcad/libredwg-web` имеет GPL-3.0 по npm metadata; bundle не собран и не добавлен в v10.0 до отдельного решения по лицензированию/распространению.
- Smoke на каждой целевой ОС/версии, importer/exporter matrix, supported GPU/driver matrix, versioned release notes and support diagnostics.
- **Приёмка релиза:** все P0/Tier-1 tests green; known limitations listed; installer passes clean-machine test; real user projects pass acceptance; release artifact hash/QA report archived.

## Сквозной test-gate для каждой функции

Функцию нельзя считать завершённой после одного успешного клика. Для каждого feature ID должны пройти:

1. **Contract:** понятные units/CRS/input/output, unsupported-state и empty/cancel/error UX.
2. **Kernel:** unit/property tests на normal, large coordinates, NaN/Infinity, boundary, degenerate geometry и deterministic result.
3. **Dataset:** synthetic golden fixture + public fixture + пользовательский файл, если есть право на его использование.
4. **UI/IPC:** реальная кнопка, modal, toast/status, отмена, отсутствие JS/IPC errors и silent no-op.
5. **Interchange:** export → независимый reader → reopen/import, point/attribute/CRS counts and coordinate tolerance.
6. **Performance:** time/RAM/VRAM on agreed sizes, progress/cancel and stress/repetition.
7. **Package:** Electron/Windows installer and any native SDK are tested before marking production-ready.
8. **Evidence:** QA record with app version, input/output hashes, settings, environment, metrics and remaining gaps.

## Ближайший исполнительный порядок

1. **Этап 1: закрыть acceptance corpus** — MEP/terrain/road/stockpile и multi-scan fixtures с лицензиями/ground truth; зафиксировать права на пользовательские файлы, известные extents/units/CRS; единый click-smoke для молчаливых действий.
2. **Scan-to-BIM external acceptance** — прогнать IFC4 `IfcOpeningElement`/void и IFC2X3-выход через независимый schema+geometry validator и выбранный BIM reader; проверить исходные координаты/единицы и вручную подтвердить, что IFC4 wall/opening geometry открывается корректно. Текущий UI/STEP entity test не заменяет эту приёмку.
3. **Сечения v9.9+:** raster point-cloud axis/profile теперь исполняются в Web Worker с progress/cancel и compact buffers; следующий test-gate — профили RAM/latency на 1M/10M, источники с Float64/large extents, затем progress/cancel для exact mesh-plane path и его проверки на новых OBJ/STL. Сравнить raster slab с аналитическими TIN/mesh sections и прогнать сохранение результата в выбранном CAD/GIS. Presets хранят параметры, не геометрию/аннотации.
4. **Интероперабельность сечения/CAD:** export image + richer attributes, external DXF/CSV reader, единицы/CRS/WKT, тест открыть/переоткрыть в выбранном CAD/GIS; исследовать TIN из point cloud только с independent oracle.
5. **Этапы 2–3:** проектный журнал, миграции и crash recovery; дальше — point-cloud PLY full UI/GPU budget/telemetry, CRS/up-axis/unit override, OBJ material/texture packaging, независимый DWG reader после решения по GPL/ODA SDK, capability messages для RVT/RFA/SKP и официальные Revit/SketchUp adapters.
6. **Этап 4 и далее:** out-of-core/streaming до обещаний больших облаков, затем ICP/GCP, classification, inspection reports, BIM/Plant и release gates с конкретной Windows-сборкой.

## Критерий завершения программы

Программа достигает заявленного профессионального уровня только тогда, когда каждая функция уровня **Обязательный** из `MARKET-FEATURE-MATRIX.md`:

- имеет рабочий end-to-end интерфейс без ложного успеха;
- сохраняет входные данные, координаты и прослеживаемые параметры;
- проходит указанные QA gates на supported datasets и целевой Windows build;
- имеет независимую проверку результата/точности и documented performance boundary;
- имеет понятные ограничения, поддержку/документацию и пользовательскую приёмку.

Нишевые hardware/proprietary capabilities учитываются отдельными официальными adapters и лицензиями. Если исходных данных, SDK, hardware или legal rights нет, функция остаётся «условной/неподдержанной», а не становится fake implementation.
