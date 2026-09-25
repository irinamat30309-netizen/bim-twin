# BIM TWIN — повторная проверка Stage 3

## Объём и среда

Проверялись point-cloud I/O, source coordinates/CRS metadata, атрибуты точек, предохранители PCD и поведение renderer на пользовательском большом PLY. UI работал в fake-Electron IPC harness с Chromium/SwiftShader; в этом запуске project store использовал JSON fallback из-за отсутствия `better-sqlite3`. Это не packaged Windows build и не тест на целевой CAD/BIM/GIS.

Для LAS/E57 независимых чтений временно вне проекта использовались `laspy 2.7.0` и `pye57 0.4.19`. LAZ suite запускался с временно подключённым optional `@loaders.gl/las 4.5.2`; зависимость и пользовательские исходники не включены в приложение или архив ревью.

## Автотесты

| Проверка | Результат |
|---|---|
| Полный `node --test` с `BIM_TWIN_USER_FIXTURES` | 773 теста: 770 passed, 0 failed, 3 skipped; пропуски — три LAZ-сценария без optional decoder |
| Stage 3 форматные round-trip / preflight (`test/format-roundtrip-stage3.test.js`) | 12/12 passed, включая CSV writer/importer и multi-scan flatten warning |
| PTX parser (`test/ptx-stage3.test.js`) | 3/3 passed; multi-scan pose, missing returns, RGB/intensity, malformed/truncated grids |
| Совместный фокусный запуск Stage 3/4 и smart-save | 29/29 passed; в том числе Worker, PTX, CSV round-trip и export preflight |
| LAZ reader (`test/laz-node.test.js`) с optional decoder | 5/5 passed в предыдущем отдельном запуске с decoder; в текущем полном прогоне decoder не установлен и три LAZ-теста skipped |
| Загруженные пользовательские OBJ/STL/PLY fixtures | 2/2 passed: большой OBJ/STL и PLY на 15 352 950 точек; пользовательские файлы были восстановлены во временный fixture mount, не включённый в архив |
| Stage 2 focused regression suite | 30/30 passed; детали в `QA-RETEST-stage2.md` |
| Синтаксис | 233 JavaScript/MJS/CJS-файла вне `node_modules`, `vendor` и `dist` прошли `node --check` |
| `npm run test:store` | `ALL PHASE D TESTS PASSED`; `ALL PERSISTENCE TESTS PASSED` |

В полном прогоне пользовательские геометрические fixtures подключены; оставшиеся три пропуска относятся только к LAZ-тестам, для которых в текущем окружении нет optional decoder.

## Последняя UI-перепроверка Stage 3/4

В Chromium/SwiftShader fake-Electron harness повторно проверена цепочка с новым Worker API: видимая панель прогресса → отмена с toast «Импорт отменён» → импорт синтетического XYZ (3 точки) → импорт синтетического PTX (2 точки) → CSV export и повторное чтение CSV (2 точки). Отдельно в UI открыт пользовательский 230-МБ PLY с 15 352 950 исходными точками: виден progress panel, загружено 2 558 825 точек в пределах first-open budget 3 млн; PAGEERROR/IPCERR/NOHANDLER — 0. Это подтверждает renderer/IPC smoke, а не пакетированную Windows-сборку или независимую проверку формата внешним CAD/GIS.

## UI import/export и координатные oracle

Chromium UI получил семь известных тестовых файлов через renderer file input → настоящий main-process parser в harness:

- LAS, PLY, E57, PCD, PTS, XYZ и CSV — 7/7 импортов, по три контрольные точки, проверены world XYZ, доступные CRS/units и соответствующие RGB/intensity/classification; ошибок страницы и IPC не зарегистрировано.
- Контрольные мировые координаты: `(500000.125, 6000000.25, 117.5)`, `(500001.125, 6000001.25, 119)`, `(500000.5, 6000000.875, 118.25)`.
- Из открытого LAS экспортированы новые LAS и E57. `laspy` прочитал LAS 1.4 PDRF 7: три точки, XYZ с точностью до 1 мм, WKT VLR, 16-bit RGB/intensity и классы `[2, 42, 255]`.
- `pye57` прочитал экспортированный бинарный E57: один scan/три точки, точные XYZ, `coordinateMetadata` WKT, RGB, intensity и `cartesianInvalidState`. E57 intensity сравнивалась с допуском `2e-5` из-за представления поля.
- E57 packet regression дополнительно проверяет выравнивание DataPacket на 4 байта и 0–3 нулевых байта padding; E57 round-trip unit suite также проверяет внутреннее чтение координат и атрибутов.

Эти проверки валидируют только названные наборы и поля, а не полную совместимость каждого варианта LAS/LAZ/E57 или независимое открытие в CAD/GIS.

## Пользовательский PLY и point budget

- Повторно извлечённый из пользовательского `ply.zip` PLY имеет размер 230 294 477 байт и 15 352 950 точек. Асинхронный Worker parser с budget 1 млн сохранил 959 559 точек; fixture test прошёл.
- Отдельное измерение сразу после fixture test: 862 ms и sampled process RSS 143.5 MiB при 56 замерах через 15 ms. Файл уже был в OS page cache; это parser-only warm-cache smoke, не независимый benchmark.
- В renderer при первом открытии default budget 3 000 000 дал 2 558 825 загруженных точек (stride-выборка); выбор 1 000 000 повторно прочитал тот же источник и дал 959 559 точек. Настройка 1 млн сохранилась, RGB присутствовал, выборочные координаты были конечными.
- На всех трёх UI-запусках (`7-format import`, большой PLY, изменение density) не было PAGEERROR/IPCERR; при отсутствии native SQLite UI использовал JSON fallback.
- Полный исходник не был загружен целиком в GPU. Пики RAM/VRAM, frame latency, 10M/50M/100GB, Windows GPU, parallel loading и поведение при исчерпании физической памяти не измерялись.

## Покрытие и ограничения форматов

| Формат/сценарий | Текущее состояние по проверке |
|---|---|
| LAS | Импорт LAS 1.0–1.4; экспорт LAS 1.4 PDRF 7. Сохраняются XYZ/RGB/intensity/classification/WKT. LAS extra dimensions, GPS time, scan-source и все multi-return поля не переносятся. |
| LAZ | Только import через optional decoder; 5 suite-тестов прошли с временной внешней зависимостью. Без decoder функция недоступна; путь буферизует файл, capped на 2 GiB, не out-of-core. Экспорт LAZ отсутствует. |
| COPC | Не поддержан: COPC hierarchy/range reads и облачный streaming не реализованы. |
| E57 | Бинарный import/export; reader поддерживает multi-scan/pose; writer сводит набор в один scan. Classification, timestamps, images и per-scan organization не экспортируются. |
| PLY | Point-cloud import/export и отдельный mesh-import path. Экспорт не является общим PLY mesh round-trip; произвольные элементы/свойства не сохраняются. |
| PCD | ASCII, binary и binary_compressed/LZF import покрыты unit tests; проверены overlap back-reference, over-limit, trailing/truncated payload. Compressed buffer целиком находится в памяти, limit 512 MiB; произвольные векторные поля и полная sensor viewpoint-семантика не сохраняются. |
| PTS / XYZ / CSV | PTS import/export теряет portable CRS/classification по ограничениям текстового формата; XYZ/CSV round-trip используют BIM Twin named fields и comment metadata. CSV экспорт добавлен, сохраняет XYZ/RGB/intensity/classification, units и WKT в BIM Twin comments; обычные таблицы могут игнорировать comments, а multi-scan layout сплющивается с явным warning. |
| DXF / DWG / IFC / GeoTIFF | DXF и GeoTIFF остаются ограниченными workflow; DWG не заявлен как доступный native формат; IFC поддерживает только частичный Scan-to-BIM output, не универсальный IFC round-trip. Независимые CAD/BIM/GIS readers в этом прогоне не запускались. |
| PTX | PTX multi-scan text import поддержан и покрыт synthetic unit/worker/UI regressions: декодируются grid dimensions, scanner matrix, missing 0/0/0 returns, XYZ/RGB/intensity и per-scan matrix metadata. Сканы для просмотра сливаются; scan-grid reconstruction и PTX writer отсутствуют. Реальный образец с прибора не был получен. |
| Imagery / trajectory | Пакетная привязка изображений/траектории как полноценные point-cloud data pipelines не принимается этим этапом. Нет синхронизации capture time, camera pose, imagery и скана. |
| CRS | WKT metadata переносится/проверяется в выбранных сценариях. EPSG reprojection, datum transformation, геоид, валидность CRS и автоматическое смешивание систем не подтверждены; WKT не означает преобразование координат. |

## Критерий Stage 3

**Stage 3 частично реализован, но не принят полностью.** Для приёмки остаются COPC, PTX writer/scan-grid round-trip, native DWG, полный E57 scan-preserving writer, полные LAS attributes, PLY mesh round-trip, IFC/raster/imagery/trajectory exchange, CRS/EPSG/vertical-datum transformations, user-visible handling несовместимых CRS, независимый CAD/BIM/GIS open/reopen и большой production benchmark. Эти пробелы помечены как partial/unsupported в registry и не должны объявляться готовыми функциями.