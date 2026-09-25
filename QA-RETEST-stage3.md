# BIM TWIN — повторная проверка Stage 3

## Объём и среда

Проверялись point-cloud I/O, source coordinates/CRS metadata, атрибуты точек, предохранители PCD и поведение renderer на пользовательском большом PLY. UI работал в fake-Electron IPC harness с Chromium/SwiftShader; в этом запуске project store использовал JSON fallback из-за отсутствия `better-sqlite3`. Настоящий Windows runtime недоступен локально: host — Amazon Linux 2023 без Wine/PowerShell/cmd.exe. Первый hosted Windows job текущего PR обнаружил `EPERM` при `fsync` временной резервной копии, открытой только для чтения. Следующий hosted job подтвердил Linux, но обнаружил дополнительные Windows-only проблемы: `fsync` read-only handles в octree/export backup paths, проверку контрольных сумм, чувствительную к CRLF, и POSIX-only SIGKILL assertion. Исправлено: принадлежащие приложению temp/backup файлы перед fsync переводятся в private writable mode и открываются `r+`; integrity test нормализует окончания строк; crash test на Windows прекращает дочерний процесс в точке частичной записи, на POSIX сохраняет SIGKILL. После исправлений hosted GitHub Actions для commit `d6c0215` завершил Linux `test` и Windows `windows-test` со статусом `success` (run `36179707597`). Это подтверждает CI на hosted Windows, но не приёмку собранного Windows-приложения, его ASAR-пути или целевых CAD/BIM/GIS-инструментов.

Для LAS/E57 независимых чтений временно вне проекта использовались `laspy 2.7.0` и `pye57 0.4.19`. LAZ suite запускался с временно подключённым optional `@loaders.gl/las 4.5.2`; зависимость и пользовательские исходники не включены в приложение или архив ревью.

## Автотесты

| Проверка | Результат |
|---|---|
| Повторный `node --test` на чистой копии (без локальных fixture-файлов и optional LAZ decoder) | 842 теста: 835 passed, 0 failed, 7 skipped; пропущены только сценарии, которым недоступны нужные fixtures/decoder |
| Stage 3 форматные round-trip + PTX parser/writer (`test/format-roundtrip-stage3.test.js`, `test/ptx-stage3.test.js`) | 23/23 passed: LAS/PLY/E57/PCD/PTS/XYZ/CSV, multi-scan PTX ranges/poses, RGB/intensity, stale metadata и malformed inputs |
| PTX stream validator (`test/ptx-stream-export-stage4.test.js`) | 7/7 passed: single-/multi-scan grids, произвольные границы чанков, total point-count validation, malformed rows, sentinel, cancellation и IPC commit guards |
| PTX export commit/round-trip (локальный harness, не включён в репозиторий) | 7 assertions passed для single scan: world XYZ/RGB/intensity, backup и отсутствие временных файлов |
| PTX multi-scan UI → PTX → E57 (локальный harness, не включён в репозиторий) | Две тестовые PTX scan-группы импортированы в UI и экспортированы обратно в PTX и бинарный E57; XYZ/RGB/intensity, scan ranges и grouping совпали; PAGEERROR/IPCERR/NOHANDLER — 0. Логи и бинарные evidence-файлы локальны и в Git не включены. |
| Stage 3 E57 / export-hub / E57 stations | 36/36 passed: round-trip, sampling, single/multiple scan groups, poses, safe CDATA, malformed XML rejection, stale ranges, PTX/CSV regressions |
| E57 + WebGL viewer focused regression (`format-roundtrip-stage3`, `e57-stations`, `export-hub`, `webgl-viewer`) | 48/48 passed, including protection of scan-range order when cloud size triggers rendering shuffle |
| LAZ reader (`test/laz-node.test.js`) | 5/5 passed в отдельном запуске с optional decoder; в текущем clean-checkout прогоне LAZ-часть пропущена, так как decoder не установлен |
| Fixture-gated OBJ/STL/PLY tests | В чистой копии пропущены, если внешний fixture mount отсутствует; пользовательские модели и бинарные доказательства не включены в ветку |
| Stage 2 focused regression suite | 30/30 passed; детали в `QA-RETEST-stage2.md` |
| Синтаксис | 232 JavaScript/MJS/CJS-файла прошли `node --check` |
| `npm run test:store` | `ALL PHASE D TESTS PASSED`; `ALL PERSISTENCE TESTS PASSED` |
| Hosted GitHub Actions CI | Linux `test` and Windows `windows-test` passed for commit `d6c0215`; packaged Windows/ASAR remains untested |

В повторном чистом прогоне внешние пользовательские fixtures и optional LAZ decoder не подключались; соответствующие тесты пропущены. Для полной локальной fixture-проверки файлы должны оставаться вне Git, а optional decoder устанавливаться отдельно.

## Последняя UI-перепроверка Stage 3/4

Ранее в локальном Chromium/SwiftShader fake-Electron harness проверялась цепочка Worker progress → cancel → synthetic XYZ/PTX import → CSV export/re-read, а также открытие крупного внешнего PLY и управление point budget. Источник пользовательской геометрии, точные метаданные, скриншоты и логи не включены в репозиторий. Это renderer/IPC smoke, а не проверка пакетированной Windows-сборки или независимая проверка формата в CAD/GIS.

## UI import/export и координатные oracle

Chromium UI получил семь известных тестовых файлов через renderer file input → настоящий main-process parser в harness:

- LAS, PLY, E57, PCD, PTS, XYZ и CSV — 7/7 импортов, по три контрольные точки, проверены world XYZ, доступные CRS/units и соответствующие RGB/intensity/classification; ошибок страницы и IPC не зарегистрировано.
- Контрольные мировые координаты: `(500000.125, 6000000.25, 117.5)`, `(500001.125, 6000001.25, 119)`, `(500000.5, 6000000.875, 118.25)`.
- Из открытого LAS экспортированы новые LAS и E57. `laspy` прочитал LAS 1.4 PDRF 7: три точки, XYZ с точностью до 1 мм, WKT VLR, 16-bit RGB/intensity и классы `[2, 42, 255]`.
- `pye57` прочитал экспортированный бинарный E57: один scan/три точки, точные XYZ, `coordinateMetadata` WKT, RGB, intensity и `cartesianInvalidState`. E57 intensity сравнивалась с допуском `2e-5` из-за представления поля.
- Новый сквозной UI E2E импортировал synthetic E57 с двумя scans через main/renderer и выгрузил через Smart Save. В файле сохранены names и per-scan rigid poses; независимый `pye57/libE57Format 0.4.19` прочитал два scans и подтвердил все world XYZ. Сырой тестовый cloud имел четыре точки; PAGEERROR/IPCERR/NOHANDLER — 0. При намеренно несогласованных scan ranges экспорт выдаёт preflight warning и безопасно объединяет точки, вместо создания ошибочной группировки.
- Отдельный UI/Smart Save проход single-scan E57 сохранил имя, ненулевую pose translation и четыре world-coordinate точки; независимый `pye57` подтвердил один scan и все координаты.
- Дополнительный edge-case E57 с двумя scanner names и coordinate metadata, содержащими `&`, `<`, Unicode и `]]>`, независимо открыт `pye57`: оба имени и все XYZ сохранились точно. Unit regression отклоняет незавершённые CDATA/markup и mismatched tags, корректно декодирует supplementary Unicode numeric references и отвергает запрещённый `&#0;`, не зависая.
- На renderer regression с 2 000 001 точкой подтвердил, что viewer не перемешивает E57-облако при сохранённых scan ranges; обычный cloud без scan metadata всё ещё использует существующую interaction shuffle-оптимизацию.
- E57 packet regression дополнительно проверяет выравнивание DataPacket на 4 байта и 0–3 нулевых байта padding; E57 round-trip unit suite также проверяет внутреннее чтение координат и атрибутов.

Эти проверки валидируют только названные наборы и поля, а не полную совместимость каждого варианта LAS/LAZ/E57 или независимое открытие в CAD/GIS.

## Large PLY и point budget — локальное evidence

В предыдущем локальном прогоне проверялись потоковый Worker parser, воспроизводимая выборка по point budget и preview для крупного внешнего PLY. Точный исходный файл, его имя/хеш/метаданные, временные индексы, скриншоты и harness-логи намеренно не публикуются. Fixture-gated test в чистой копии пропускается без внешнего набора. Зафиксированный ранее parser smoke был warm-cache и не является повторяемым benchmark.

В UI проверялись изменение density, сохранение настройки и доступность RGB; полный GPU upload не заявляется. Peak RAM/VRAM, frame latency, 10M/50M/100GB, Windows GPU, parallel loading и поведение при исчерпании физической памяти не измерялись.

## Покрытие и ограничения форматов

| Формат/сценарий | Текущее состояние по проверке |
|---|---|
| LAS | Импорт LAS 1.0–1.4; экспорт LAS 1.4 PDRF 7. Сохраняются XYZ/RGB/intensity/classification/WKT. LAS extra dimensions, GPS time, scan-source и все multi-return поля не переносятся. |
| LAZ | Только import через optional decoder; 5 suite-тестов прошли с временной внешней зависимостью. Без decoder функция недоступна; путь буферизует файл, capped на 2 GiB, не out-of-core. Экспорт LAZ отсутствует. |
| COPC | Не поддержан: COPC hierarchy/range reads и облачный streaming не реализованы. |
| E57 | Бинарный import/export; reader и writer проверены на multi-scan/pose. Writer сохраняет scan names, порядок точек, translation/rotation и WKT при корректных непрерывных ranges; sampling пересчитывает ranges. Если edits нарушили ranges, preflight предупреждает и экспортирует один merged scan. Classification, timestamps, images и произвольные поля по-прежнему не экспортируются. |
| PLY | Point-cloud import/export и отдельный mesh-import path. Экспорт не является общим PLY mesh round-trip; произвольные элементы/свойства не сохраняются. |
| PCD | ASCII, binary и binary_compressed/LZF import покрыты unit tests; проверены overlap back-reference, mismatch/trailing/truncated payload. Обычный preview `binary_compressed` теперь bounded-декодирует LZF во временный planar disk store и материализует только выборку, ограниченную point budget; видимый progress и cleanup на успехе/ошибке/отмене проверены. Произвольные векторные поля и полная sensor viewpoint-семантика не сохраняются; sampled preview остаётся in-memory, а полный disk-backed viewing — отдельная незавершённая функция. |
| PTS / XYZ / CSV | PTS import/export теряет portable CRS/classification по ограничениям текстового формата; XYZ/CSV round-trip используют BIM Twin named fields и comment metadata. CSV экспорт добавлен, сохраняет XYZ/RGB/intensity/classification, units и WKT в BIM Twin comments; обычные таблицы могут игнорировать comments, а multi-scan layout сплющивается с явным warning. |
| DXF / DWG / IFC / GeoTIFF | DXF и GeoTIFF остаются ограниченными workflow; DWG не заявлен как доступный native формат; IFC поддерживает только частичный Scan-to-BIM output, не универсальный IFC round-trip. Независимые CAD/BIM/GIS readers в этом прогоне не запускались. |
| PTX | Multi-scan text import и writer сохраняют contiguous point ranges, исходные scanner matrices и rigid poses при валидных неизменённых ranges; каждый scan экспортируется как одна строка. Unit/stream tests и UI E2E покрывают row-vector/column-vector, missing returns, RGB/intensity, total count и повторное чтение. Независимый `pye57 0.4.19` подтвердил downstream E57 с 2 scan-группами и координатами/атрибутами. Ограничение: оригинальные grid dimensions и missing-return cells не восстанавливаются; реальный сканерный PTX не тестировался. |
| Imagery / trajectory | Пакетная привязка изображений/траектории как полноценные point-cloud data pipelines не принимается этим этапом. Нет синхронизации capture time, camera pose, imagery и скана. |
| CRS | WKT metadata переносится/проверяется в выбранных сценариях. EPSG reprojection, datum transformation, геоид, валидность CRS и автоматическое смешивание систем не подтверждены; WKT не означает преобразование координат. |

## Критерий Stage 3

**Stage 3 частично реализован, но не принят полностью.** PTX уже сохраняет scan grouping/rigid pose в writer при валидных ranges, однако исходные grid dimensions/missing-return cells не восстанавливаются и реальный device corpus отсутствует. Для приёмки остаются COPC, native DWG, дополнительные E57 fields (classification/timestamps/images), полные LAS attributes, PLY mesh round-trip, IFC/raster/imagery/trajectory exchange, CRS/EPSG/vertical-datum transformations, user-visible handling несовместимых CRS, независимый CAD/BIM/GIS open/reopen и большой production benchmark. Эти пробелы помечены как partial/unsupported в registry и не должны объявляться готовыми функциями.