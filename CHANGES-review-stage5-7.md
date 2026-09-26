# BIM TWIN — локальный инкремент этапов 5–7

**Статус:** этапы продвинуты, но ни один из трёх не принят и не завершён. Это кодовое продолжение review-пакета 1.1.17, а не обещание полного паритета с LixelStudio/CoProcess. До последнего follow-up hosted Windows jobs и приватный ручной Windows package-QA запуск уже проходили; однако это не было проверкой реального WebGL-рендера на целевой видеокарте, установки на чистой машине или внешних CAD/GIS readers.

- Для закрытия именно пробела GPU-runtime добавлен `test/webgl-runtime-smoke.test.js`: он запускает production `Viewer3DGL` в Electron на self-hosted Windows runner, загружает 4096 синтетических точек с RGB/intensity/classification, переключает окраску по классам, проверяет реальные GPU-буферы, видимые пиксели, WebGL2 errors/context loss и пишет сведения об активном адаптере. Тест автоматически пропускается на Linux и GitHub-hosted runner, но завершится ошибкой при известном software renderer. Локальный Chromium/SwiftShader проверил тестовую страницу, но не засчитывается как физическая GPU-приёмка. Требуется новый запуск приватного workflow после этого изменения.

## Этап 5 — совмещение, регистрация и QC

- Регистрация облаков выполняется deterministic trimmed coarse-to-fine point-to-point ICP: начальная трансляция по центроидам, три distance-gate уровня, trimming correspondence residuals и Huber-веса.
- Для nearest-neighbour применяется exact SciPy `cKDTree`, если установлен SciPy. Иначе используется точный bounded-memory NumPy fallback; для чрезмерного квадратичного объёма он отказывает с actionable error, а не создаёт неограниченную матрицу расстояний.
- Проверяются конечность/форма координат, вырожденные линейные данные, диапазоны параметров и минимальное соответствие/перекрытие. Возвращаются начальные и конечные fitness/RMSE, медиана/P95 остатков, число соответствий/inliers, число итераций, сходимость и warnings.
- Fitness явно определён как доля выбранных source-точек, попавших в заданный distance gate; это directed metric, не взаимная площадь перекрытия и не оценка абсолютной точности.
- В UI после успешного ICP формируется JSON-отчёт с 4×4 transform, source/target, frame/CRS checks, baseline/final metrics и предупреждениями. Отчёт отдельно указывает, что начальная и итоговая RMSE относятся к разным наборам соответствий и внутренний ICP residual не заменяет независимые геодезические checks.
- Потоковый PLY writer вынесен в `pointcloud-ply-io.js`, добавлен в Electron `build.files`; временные PLY-конверсии сохраняют RGB, normalized intensity и classification. Python registration сохраняет атрибуты source по исходному индексу, deviation — атрибуты compared облака. Несовпадающие длины/невалидные классы отклоняются.
- Исправлен второй путь сохранения PLY: `renderer/pointcloud-edit.js` — ASCII, синхронный binary и chunked async binary writer, используемые редактированием/автосохранением, теперь также сохраняют выровненные RGB, intensity и classification. Добавлены проверки размеров массивов, конечности XYZ/intensity и диапазона LAS class 0–255; sync/async binary обязаны выдавать одинаковые байты. Round-trip тесты читают обратно ASCII и binary через внутренний PLY parser.

### Незакрыто по этапу 5

- Нет feature/RANSAC/global initialization, ручных targets, point-to-plane/hybrid registration, multi-scan pose graph, loop closure, одновременной оптимизации сети сканов или полноценного fusion.
- Centroid initialization — локальный старт, поэтому большие повороты, слабая геометрия, повторяющиеся/симметричные фасады и малый overlap всё ещё могут привести к отказу либо неверному локальному минимуму.
- В отчёте нет независимо измеренной check-point ошибки, пока пользователь отдельно не выполнит геодезическую проверку. UI JSON-report не проверялся кликом в Electron/Windows после последней правки.

## Этап 6 — геодезия и координатная точность

- GCP workflow поддерживает 3D Helmert least-squares с относительными весами, robust downweighting контрольных выбросов, раздельные роли `control` и независимые `check`, остатки по точкам и оценку covariance.
- CSV reader принимает quoted/header/semicolon варианты, проверяет конечность координат, weight/role и показывает ошибки по строкам; check-точки не участвуют в подгонке.
- Порог 5 см перед применением преобразования — safety-confirmation эвристика приложения, а не метрологический допуск и не утверждение об установленной точности.
- При геопривязке и round-trip сохраняются optional intensity/classification и координатные metadata. ICP/deviation отказываются автоматически совмещать данные с известным различным CRS; для неизвестных/несовместимых source-frame требуется явное подтверждение.

### Незакрыто по этапу 6

- Нет встроенного EPSG catalogue/PROJ grid engine, datum/epoch transformation, vertical datum/geoid model либо сертифицированного преобразования локальных единиц. WKT metadata можно сохранять, но сама строка WKT не преобразует координаты.
- Нет RTK/PPK/trajectory/IMU adapters и нет аппаратных raw fixtures/ground truth. Нужны реальные независимо измеренные control/check-наборы с заданными горизонтальными и вертикальными допусками, в том числе повторяемая Windows-проверка.

## Этап 7 — очистка, атрибуты и сегментация

- Геометрические filters/downsample/crop/section изменяют point attributes согласованно: RGB, intensity, classification следуют тому же индексу; удалённые точки получают соответствующие arrays; undo восстанавливает исходные tuple.
- Voxel downsampling усредняет непрерывные интенсивность/RGB, а classification агрегирует по наиболее частому коду (при равенстве детерминированно), не усредняя номера классов. Фильтры и изменённый `webgl-viewer` покрыты тестами при активном clip section.
- LAS 1.4 ExportHub path сохраняет стандартные intensity/class поля; legacy LAS 1.2 PDRF2 writer безопасно отклоняет class code выше своего 5-битного поля вместо усечения. Новый PLY writer записывает scalar `float intensity` и `uchar classification`, проверяет их длины/значения и делает temp-write + rename.
- Import-конверсия, auto-clean/CloudCompare input conversion, геометрические входы ICP и deviation передают эти атрибуты там, где их предоставляет parser.
- Добавлена ручная human-in-the-loop разметка выбранных точек кодом ASPRS LAS 0–255 из меню «Чистка». Меняются только выбранные точки; цвета RGB/intensity и геометрия не затрагиваются. Ctrl+Z хранит память-эффективный undo: sparse edit — индексы и старые байтовые классы, dense edit — ссылку на старый неизменяемый label buffer; сохраняет восстановленные метки либо очищает активную project-ссылку на набор меток. Сохранение/очистка классификаций сериализованы через project bridge; content-addressed файлы остаются доступными историческим ревизиям.
- Ручная маркировка запрещена для потокового/LOD/прореженного облака и при known source-count mismatch, чтобы не присваивать sample labels исходному файлу с неизвестным соответствием точек. При загрузке project labels несовпадение point count больше не игнорируется молча: пользователь видит предупреждение, а приложение выдаёт diagnostic event.
- Undo-история редактирования теперь сбрасывается при импорте другого облака/меша/проекта; undo операций над точками не может примениться к новому облаку с совпавшим количеством точек.
- Добавлены regressions для manual assign/undo/clear, очереди project save/clear, mismatch при восстановлении и освобождения WebGL class buffer/сброса режима цвета.

### Незакрыто по этапу 7

- Нет versioned annotated reference corpus или precision/recall/F1 по классам; эвристическая ground/structure классификация не является semantic AI и не даёт confidence-гарантий.
- Не реализованы полноценное удаление движущихся объектов, AI inference для всех перечисленных классов, review/diff UI полного уровня и LAS extra bytes/arbitrary dimensions.
- Операции редактирования и анализа не становятся автоматически out-of-core: disk-backed LOD остаётся ограниченным sampled viewer; full-cloud stream-aware editing/filtering на многомиллионном дисковом источнике всё ещё требует отдельного этапа.

## Основные изменённые зоны

`tools/pointcloud_geometry.py`, `pointcloud-ply-io.js`, `main.js`, `preload.js`, `renderer/app.js`, `renderer/georef.js`, `renderer/lixel-sprints-ext.js`, `renderer/multicloud.js`, `renderer/project-state.js`, `renderer/pointcloud-edit.js`, `renderer/webgl-viewer.js`, `package.json` и focused tests в `test/`.

Количественные результаты, точные команды, пропуски и ограничения повторной проверки — в `QA-RETEST-stage5-7.md`.