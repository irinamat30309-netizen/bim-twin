# BIM TWIN — QA-RETEST v9.4 / renderer v1223

**Итог:** точное mesh-сечение из v9.3 сохранено и повторно подтверждено; в этом цикле доработаны генерация горизонталей и UX пустого результата. Основная 15-этапная программа ещё не завершена; перечисленные ниже smoke/round-trip проверки не заменяют приёмку в целевых Windows/CAD/BIM-средах.

## Среда и границы проверки

- Linux, Node.js 24; Electron main/preload запускаются через локальный fake-Electron harness, UI — Chromium/Playwright с SwiftShader.
- Данные: `room.las` и `room.ply`, по 205 526 точек.
- `better-sqlite3` отсутствует: тесты работают через JSON fallback. Не проверялись Windows installer/ASAR/native module, production GPU, AutoCAD/Revit/BricsCAD и независимый IFC validator.
- Экспортные облака повторно прочитаны **внутренними парсерами BIM TWIN**. Это проверяет self-round-trip, но не является независимой проверкой форматов. Тестовые LAS/PLY не содержат CRS WKT; наличие геопривязанных числовых координат не доказывает передачу CRS-метаданных.

## Результаты

| Проверка | Результат |
|---|---|
| `node --test` | 690 тестов: 687 пройдено, 3 пропущено, 0 ошибок |
| Syntax-check | 203 JS/MJS/CJS-файла, 0 синтаксических ошибок |
| Точный mesh-section UI/E2E | X/Y/Z на Y-up PLY и Z-план на georeferenced Z-up double PLY; 4 DXF с закрытыми контурами |
| Mesh-section preview | Видимые пиксели; старый preview сбрасывается при изменении уровня; пустой уровень отклоняется; координаты геопривязанного теста в допуске <1e-6 |
| Terrain contour kernel | 5 новых regression tests: валидные сегменты, невалидный шаг, предел расчёта, пустая/плоская поверхность, invalid raster cells |
| Terrain UI, шаг 0,50 м | Для тестового помещения реального пересечения уровней нет; теперь выдаётся объяснение, **пустой DXF не сохраняется** |
| Terrain UI, шаг 0,05 м | E2E создал DXF: 3 уровня, 40 сегментов, 4 195 байт, корректный `EOF`; видимый toast и 0 browser/IPC errors |
| Полный UI click-smoke v1223 | На каждом из `room.las` и `room.ply`: 99 действий / 7 вкладок, 0 JS/page/IPC/no-handler errors, 12 загрузок файлов |
| Неоднозначные действия click-smoke | По-прежнему 39 из 99 на формат без наблюдаемого toast/modal/log/state change; их поведение не объявляется проверенным только по факту клика |
| Экспортные файлы | В smoke проверялись E57, PLY, OBJ, план DXF, DSM/DTM GeoTIFF, классифицированный LAS, IFC2X3/IFC4 и CSV-шаблон GCP |
| Scan→BIM/IFC | Повторно видны 4 стены, 1 проём и 1 объект в плане; IFC2X3 — 4 стены/1 колонна; IFC4 — 4 `IFCWALLSTANDARDCASE`, 1 колонна, 2 плиты. Явные IFC opening/void entities отсутствуют |

Сохранённые скриншоты, DXF, click-smoke результаты и `cloud-roundtrip-summary.json` находятся в `QA-artifacts/v9.4/` и включены в архив.

## Round-trip облаков — внутренние парсеры

- Из `room.las` E57, PLY и классифицированный LAS повторно открылись по **205 526 точек**; числовые source bounds соответствуют исходному облаку. Pointwise max absolute difference: E57↔PLY **4,60e-7 м**, E57↔classified LAS **8,57e-8 м** в проверенном внутреннем представлении.
- Из `room.ply` E57 и PLY совпали pointwise при обратном преобразовании source frame; PLY↔E57 max absolute difference **0 м**. LAS quantization дал max difference **0,000501 м**.
- Эти значения измерены на синтетических `room.*`, не включают оценку реального survey accuracy, вертикального datum или сохранения исходной WKT. Нужны независимые readers и fixtures с CRS/units metadata.

## Изменение горизонталей

До исправления flat-room fixture закономерно давал ноль уровней при шаге 0,50 м, но UI всё равно сохранял 35-байтовый пустой DXF и сообщал об успехе. Теперь шаг запрашивается у пользователя, поддерживается десятичная запятая, пустой/нечисловой/неположительный ввод отклоняется, а отсутствие пересечений отображается явно без скачивания пустого файла. Расчёт ограничен по числу уровней, объёму ячеек×уровней и числу сегментов; чрезмерно тяжёлый запрос завершается сообщением об увеличении шага/ячейки, а не неограниченным проходом по UI-потоку.

Изолинии пока экспортируются в DXF как отдельные `LINE`-сегменты — их сшивка в непрерывные polylines, smoothing/generalization, major/minor contours и независимое CAD reopening остаются незакрытыми.

## Интерпретация полного клика

Click-smoke подтверждает, что кнопки можно нажать на двух загруженных форматах без зарегистрированных ошибок. Это **не** означает, что все 99 команд имеют профессиональную семантическую приёмку: у некоторых ожидается выбор файла/объекта, у некоторых — режимный toggle; 39 результатов всё ещё требуют индивидуального предусловия и проверки ожидаемого state/content. Protected cleanup, 3DGS/tour и LCC2 не переписывались и нуждаются в отдельной безопасной проверке.

## Открытые ограничения

1. Точный mesh-section работает на уже импортированном triangle mesh PLY/GLB/glTF; автоматически строить TIN из point cloud пока нельзя.
2. Mesh preview — экранная overlay-линия, не clipping/boolean cut, не section cap и не depth-tested.
3. Mesh kernel синхронный, лимит 2 млн треугольников; нет worker/progress/cancel, сохранённых section sets или набора параллельных сечений.
4. Terrain остаётся ограниченным 2.5D grid workflow: нет полноценного TIN/breaklines, robust boundary/void handling, сшитых контуров, road alignment/stationing и независимого сравнения объёмов.
5. DXF R12 не переносит CRS/WKT/вертикальный datum; тестовые входы сами не содержали CRS WKT.
6. IFC проверен текстово и по генераторным инвариантам, не сторонним schema/geometry validator; IFC4 door opening не связан отдельным `IfcOpeningElement`/`IfcRelVoidsElement`.
7. Не тестировались Windows/native SQLite/installer, целевые CAD/BIM приложения, большие промышленные файлы и production GPU drivers.

## Следующие обязательные шаги

1. Для каждого из 39 неоднозначных действий добавить targeted UI/E2E assertion: prerequisites, видимый эффект, cancel/undo и export/reopen.
2. Включить в corpus открытый рельефный fixture с ground truth; сравнить DSM/DTM/contours и объёмы с независимым GIS/CAD reader.
3. Построить point-cloud→TIN/mesh с boundary/void-aware validation и сопоставить его с текущими raster sections.
4. Сшивать contour segments в open/closed polylines; проверить топологию saddle cells и численную точность DXF coordinates.
5. Продолжить этапы 2–14 по `IMPLEMENTATION-PLAN.md`; не объявлять программу завершённой до целевого Windows package + независимых interoperability/accuracy gates.