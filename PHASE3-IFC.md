# Фаза 3 ROADMAP-IDEAL — валидный IFC и интеграция Python-движка

Дата: 2026-11-14. База: коммит `9a2b2be` (r107), ветка `agent/ui-redesign`.
Изменения **не закоммичены** (рабочее дерево). Отчёт покрывает пункты 1–3 фазы 3:
IFC-валидация, геопривязка, CLI-обёртка Python-движка для приложения.

## Сводка (числа)

| Проверка | До | После |
|---|---|---|
| `ifcopenshell.validate`, `py2-model.json` → IFC | **44 ERROR**, 0 WARNING, 0 INFO | **0 ERROR**, 0 WARNING, 0 INFO |
| Сверка числа аргументов со схемой IFC4 | 45 расхождений (44 `IfcSurfaceStyleRendering`, 1 `IfcWindow`) | 0 |
| IFC с геопривязкой (`sourceTransform` + `crsWkt`) | **не парсился вообще** (`Syntax error during parse`, `##6`) | 1795 instance, 0 ERROR, 0 WARNING, 0 INFO |
| `node --test` (bim-twin) | 1552 тестов / 1548 pass / 0 fail / 4 skipped | 1552 / 1548 / 0 / 4 |
| Полный цикл CLI на `koridor-local-rgb.bin` | — | 46,6 с: JSON + IFC (0 ERROR) + PNG 1600×1000 |

Финальные артефакты (валидные):

* `D:\BIM-TWIN-TEST\interior\py2-validate.ifc` — IFC4, **1793** instance, **84 864** байта, 0 ERROR;
* `D:\BIM-TWIN-TEST\interior\py2-georef.ifc` — IFC4, **1795** instance, **89 205** байт, 0 ERROR,
  `IfcProjectedCRS` + `IfcMapConversion`;
* `D:\BIM-TWIN-TEST\interior\engine-out\koridor-engine.{json,ifc,png}` — результат одной команды CLI.

## 1. IFC-валидация

### 1.1. Как проверялось

Генерация (как в задании, Node):

```
node -e "const fs=require('fs'); const S=require('./renderer/scan2bim.js');
  const m=JSON.parse(fs.readFileSync('D:/BIM-TWIN-TEST/interior/py2-model.json','utf8'));
  fs.writeFileSync('D:/BIM-TWIN-TEST/interior/py2-validate.ifc', S.toIFC(m,{name:'py2-validate.ifc'}));"
```

Валидация — `ifcopenshell 0.9.0.post1` (Python 3.12 из DSH-рантайма):

```
$env:PYTHONIOENCODING="utf-8"; $env:PYTHONUTF8="1"
python bim-twin\tools\scan2bim-py\validate-ifc.py D:\BIM-TWIN-TEST\interior\py2-validate.ifc
```

Важно: в ifcopenshell 0.9 `ifcopenshell.validate.validate(f)` возвращает `None`, а замечания
пишет в logger — поэтому сниппет `for e in validate(f): print(e)` из задания в этой версии
ничего не печатает. Валидатор запускается через `json_logger()` (структурные `{level, type,
attribute, instance, message}`), уровни: `ERROR` — блокирующий, `WARNING`/`INFO` — допустимы.

Дополнительно `validate-ifc.py` сверяет **число аргументов каждого экземпляра с EXPRESS-схемой
IFC4**. Это необходимо: штатный валидатор 0.9 пропускает лишний аргумент (старый `IFCWINDOW`
с 14 аргументами он «съел» молча, хотя по схеме аргументов 13 — такой файл не соответствует
IFC4, и часть сторонних читателей может его отвергнуть). Инструмент печатает инвентарь
сущностей и геопривязку, пишет `--json`-отчёт, код возврата 0 только при `ERROR=0` **и**
арности OK.

### 1.2. До/после

| Файл | Сценарий | Instances | ERROR | WARNING | INFO | Арность |
|---|---|---|---|---|---|---|
| `py2-model.ifc` — старый, до правок | `toIFC(model)` | 1793 | **44** | 0 | 0 | **45 расхождений** |
| `py2-validate.ifc` — после правок | `toIFC(model)` | 1793 | **0** | 0 | 0 | OK |
| `py2-georef.ifc` — до правок | `toIFC(model, meta)` | — | файл не читался (`Syntax error during parse`) | — | — | — |
| `py2-georef.ifc` — после правок | `toIFC(model, meta)` | 1795 | **0** | 0 | 0 | OK |

Содержание 44 ошибок «до» — все одного типа:
`[ERROR] IfcSurfaceStyleRendering.ReflectanceMethod | Attribute not optional` (по одной на
каждую из 44 поверхностей-стилей).

`info/warning` в финальных файлах: **нет ни одного** (0 INFO, 0 WARNING). Перечислять, таким
образом, нечего. Проверка EXPRESS WHERE-правил (`validate(..., express_rules=True)`) в рантайме
недоступна: ifcopenshell 0.9 тянет `_pytest.assertion.rewrite` (`ModuleNotFoundError: No module
named '_pytest'`, pytest не установлен). Ограничение зафиксировано, базовая схема-валидация
(критерий задания) пройдена.

### 1.3. Что исправлено в `renderer/scan2bim.js` (v1267)

1. **44 ERROR: `IFCSURFACESTYLERENDERING`** (строка ~2303). У `IfcSurfaceStyleRendering` в IFC4
   девять атрибутов; между `Transparency` и `.NOTDEFINED.` должно быть **шесть** `$`, а было
   пять → `ReflectanceMethod` съезжал на необязательный `SpecularHighlight` и валидатор
   сообщал «Attribute not optional». Добавлен пропущенный `$`:
   `IFCSURFACESTYLERENDERING(#col,0.2,$,$,$,$,$,$,.NOTDEFINED.)`.
2. **`IFCWINDOW` — 14 аргументов вместо 13** (строка ~2382). Убран лишний завершающий `$`
   (эту структурную ошибку `ifcopenshell.validate` 0.9 не поймал — нашлась сверкой арности).
   В текущей модели 1 окно, но баг воспроизводился на любой модели с окнами.
3. **`IFCPROJECT`/`FILE_NAME`: STEP-экранирование** (строки ~2258, ~2495). Имя проекта и имя
   файла теперь проходят через `stepString()`: апостроф (`O'Brien`) раньше делал файл
   невалидным (в STEP одиночная кавычка экранируется удвоением).
4. Пункты геопривязки 1–4 — см. раздел 2.

### 1.4. Покрытие других веток экспорта (синтетика)

Чтобы правки не «чинили» только интерьерный файл, экспорт прогнан на синтетических моделях,
покрывающих все ветки `toIFC`:

| Файл | Что покрывает | Instances | ERROR | Арность |
|---|---|---|---|---|
| `_scratch/synth-all.ifc` | стены, проёмы всех видов (дверь/окно/проход), перекрытия, помещение, труба, балка, колонна, proxy-объект | 381 | 0 | OK |
| `_scratch/synth-multi.ifc` | 2 этажа (`storeys[]`): 2×`IfcBuildingStorey`, окна/двери на каждом | 599 | 0 | OK |
| `_scratch/edge/edge-*.ifc` (6 файлов) | апострофы в имени/проекте, CRS без sourceTransform, sourceTransform без CRS, `LOCAL_CS` без EPSG, пустая meta, неизвестная ось | 1793–1795 | 0 во всех | OK |

## 2. Геопривязка (IfcMapConversion + IfcProjectedCRS)

`toIFC(model, meta)` уже принимал `meta.sourceTransform` / `meta.crsWkt`, но с meta файл
**не открывался вообще** — это была не косметика, а блокер пункта 2. Исправлено:

1. **`##6` вместо `#6`** (строка ~2253). `uLen` уже содержит `#`, к нему добавлялся ещё один `#`;
   `IFCPROJECTEDCRS(...,##6)` — синтаксическая ошибка STEP, `Syntax error during parse`.
2. **EPSG-код брался первый попавшийся** (строки ~2250–2252). В полном WKT
   `PROJCRS[...CONVERSION[...,ID["EPSG",9807]]...ID["EPSG",25833]]` первым идёт код метода
   проекции (9807), из-за чего CRS назывался `EPSG:9807`. Теперь берётся **последнее**
   вхождение `ID["EPSG",n]` (глобальный код CRS): `EPSG:25833`.
3. **CRS экспортируется и без `sourceTransform`** — раньше условие требовало оба поля, и
   известная система координат молча терялась.
4. Имя проекта/файла экранируется (см. 1.3.3).

Что эмитится при `meta.crsWkt` (пример из `py2-georef.ifc`):

```
#10=IFCPROJECTEDCRS('EPSG:25833','PROJCRS["ETRS89 / UTM zone 33N",...ID["EPSG",25833]]',$,$,$,$,#6);
#11=IFCMAPCONVERSION(#5,#10,0.,0.,0.,1.,0.,1.);
```

* `IfcProjectedCRS.Name` — `EPSG:<код>`; `Description` — исходный WKT (в IFC4 у CRS нет
  отдельного WKT-атрибута, поэтому WKT хранится в описании); `MapUnit` — `IfcSIUnit` метр.
* `IfcMapConversion`: SourceCRS = геометрический контекст модели (`IfcGeometricRepresentationContext`),
  TargetCRS = `IfcProjectedCRS`, Eastings/Northings/OrthogonalHeight = 0, XAxisAbscissa/Ordinate = 1/0,
  Scale = 1 — карта координат тождественная, потому что геометрия уже эмитится в координатах
  исходного кадра (`sourceTransform`: `planPoint`/`vertical` добавляют смещение).
* Readback через ifcopenshell: Name=`EPSG:25833`, MapUnit=`IfcSIUnit`, source=`IfcGeometric-
  RepresentationContext`, target=`IfcProjectedCRS`, E/N/H=0/0/0, XAxis=1/0, Scale=1 — совпадает.

Проверка «с meta не падает»: экспорт с полной meta выполняется без исключений, файл читается
`ifcopenshell.open` и валидируется с 0 ERROR (см. 1.2). Формат meta:

```json
{ "sourceTransform": { "axis": "zup", "t": [500000, 6000000, 120] },
  "crsWkt": "PROJCRS[...]", "project": "Название проекта",
  "includeRooms": true, "includePipes": true, "includeBeams": true }
```

## 3. Интеграция Python-движка в приложение (CLI)

`bim-twin\tools\scan2bim-py\python-engine.js` — одна команда для приложения:

```
node tools/scan2bim-py/python-engine.js --cloud <облако> --out <каталог> [опции]
```

Шаги: облако (.bin как есть; LAS/LAZ/PLY/E57/PCD/PTX/XYZ — импорт через `las-node.js` с бюджетом
`--max-points` и выгрузкой в raw float32 XYZRGB) → `python scan2bim-v2.py` → JSON модели →
IFC через `renderer/scan2bim.js` `toIFC` (плюс опционально OBJ/DXF) → PNG через
`render-textured3.py`. Прогресс — в stderr, последняя строка stdout — JSON-результат
`{ok, outputs, stats, timings, python, georef, validation}`, код возврата 0/1/2. Есть кеш-режим
`--model=<json>` (пропустить движок, сразу экспорт/рендер) и `--validate` (прогнать
`validate-ifc.py` по готовому IFC).

### 3.1. Проверка на `koridor-local-rgb.bin` (bin → всё одной командой)

```
node tools/scan2bim-py/python-engine.js `
  --cloud D:\BIM-TWIN-TEST\interior\koridor-local-rgb.bin `
  --out   D:\BIM-TWIN-TEST\interior\engine-out `
  --name  koridor-engine `
  --python C:\Users\bob\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe `
  --view=iso
```

Результат `ok:true`, 46,6 с всего:

| Шаг | Время | Результат |
|---|---|---|
| движок `scan2bim-v2.py` | 10,4 с | 3 125 000 точек → 610 551 в модели, 45 стен, 23 помещения, 11 проёмов, 117,5 м² |
| экспорт IFC | 5 мс | `koridor-engine.ifc` 84 866 Б, validate: 0 ERROR, арность OK |
| PNG-рендер 1600×1000 | 36,2 с | `koridor-engine.png` 293 739 Б (текстурные грани, кирпич, пол) |

Детерминизм: `koridor-engine.json` MD5 `19096393CA30D0D820015E0C7631A0AC` — совпадает с
эталонным `py2-model.json` (движок детерминирован, CLI не искажает данные).

### 3.2. Проверка LAS-входа и `--validate`

```
node tools/scan2bim-py/python-engine.js --cloud D:\BIM-TWIN-TEST\r55\crop-B.las `
  --out _scratch\las-engine-test --max-points=800000 --view=iso --validate --python <python.exe>
```

`ok:true` за 15,2 с: импорт LAS 800 000 точек — 0,63 с (создан `cropb.cloud.bin`, 19,2 МБ),
движок — 4,2 с (3 стены, фрагмент фасада), IFC 114 instance — 0 ERROR, `--validate` = OK,
PNG 177 889 Б — 7,8 с. Геопривязка подхватилась автоматически из LAS:
`sourceTransform {axis:'zup', t:[-7.015,-12.8495,0.5]}` (CRS в этом LAS нет — `IfcProjectedCRS`
не эмитится, что корректно).

### 3.3. Проверка видов камеры и форматов

* `--view=iso` (авто-камера по bbox): `eye=16.891,14.52,16.907 target=-0.024,1.833,-0.008 fov=50`
  — соответствует принятому пресету r105 (16,13,17 → 0,1.4,0); PNG 293 739 Б,
  `D:\BIM-TWIN-TEST\interior\engine-out\koridor-engine.png` (изометрия с текстурами).
* `--view=plan` (авто: `up=z, proj=ortho`): `eye=-0.024,32.564,-0.008 target=-0.024,-0.015,-0.008`;
  PNG 227 286 Б (`_scratch\view-test\plan-view.png`) визуально идентичен эталонному
  `py2-tex3-plan.png` r105.
* `--view=inside` требует явных `--eye/--target` (камера внутри сцены); проверено с пресетом
  r105 (`eye=-5.8,1.65,-8.8 target=-1.5,1.35,-1.0 fov=76`) — PNG 281 197 Б
  (`_scratch\view-test\inside-view.png`), побайтово совпадает с эталонным
  `py2-tex3-inside.png` r105; `--view=none` — без рендера.
* `--formats=ifc,obj,dxf` проверено: `allformats.obj` 26 719 Б, `allformats.dxf` 4 376 Б.
* `--model=<json>` (кеш приложения): экспорт IFC и PNG-рендер без повторного прогона движка
  (использовано для plan/inside-проверок).

### 3.4. Ключевые опции

| Опция | Назначение |
|---|---|
| `--cloud` | .bin (float32 XYZRGB, 24 Б/точка) или .las/.laz/.ply/.e57/.pcd/.ptx/.xyz |
| `--model` | готовый JSON движка — пропустить шаг 2 (кеш) |
| `--out`, `--name` | каталог/база имён результатов |
| `--python` | интерпретатор (иначе `BIMTWIN_PYTHON` / `%LOCALAPPDATA%\BIMTwin\python-path.txt` / `PYTHON` / `python`) |
| `--voxel`, `--max-points` | прореживание движка / бюджет точек при импорте LAS |
| `--formats=ifc,png,obj,dxf`, `--validate` | что выгружать / проверка IFC |
| `--meta`, `--crs-wkt`, `--source-t`, `--source-axis`, `--project` | meta для `toIFC` (геопривязка) |
| `--view=iso\|plan\|inside\|none`, `--eye/--target/--fov/--size/--proj/--up`, `--render-arg=k=v` | камера/рендер |
| `--timeout` | таймаут шага (по умолчанию 30 мин) |

## 4. Файлы

Рабочее дерево (не закоммичено):

* `renderer/scan2bim.js` — **изменён** (v1267: стили, окно, геопривязка, STEP-экранирование;
  тесты 1552/1548/0 сохранены);
* `tools/scan2bim-py/python-engine.js` — **новый** (CLI-обёртка, 566 строк, без внешних зависимостей);
* `tools/scan2bim-py/validate-ifc.py` — **новый** (ifcopenshell.validate + арность по схеме IFC4 +
  инвентарь + геопривязка; `--json`, код возврата);
* `PHASE3-IFC.md` — этот отчёт.

Внешние артефакты: `D:\BIM-TWIN-TEST\interior\py2-validate.ifc`, `py2-georef.ifc`,
`engine-out\koridor-engine.{json,ifc,png,report.json}`; рабочие файлы проверки — в
`default-workspace\_scratch\` (`gen-ifc.js`, `synth-all.js`, `validate_ifc.py`,
`synth-*.ifc`, `edge\`, `las-engine-test\`, `cli-*.log`).

## 5. Ограничения

* Штатный `ifcopenshell.validate` 0.9 не ловит расхождение числа аргументов — поэтому в
  `validate-ifc.py` добавлена собственная сверка арности; для полной проверки WHERE-правил нужен
  pytest (в рантайме отсутствует).
* Геопривязка «минимально достаточная»: WKT хранится в `Description`, домены
  `GeodeticDatum`/`MapProjection`/`MapZone` не разбираются; карта координат тождественная, т.к.
  геометрия уже в исходных координатах. Для обмена с ГИС этого достаточно, для строгого
  IFC-геореференсинга (Bonsai/IfcOpenShell geolocation) при необходимости добавить разбор WKT.
* Пункты 4 (панель качества в UI) и D-критерии редактора — вне этой задачи; здесь проверены
  только C1 (валидный IFC) и C2 (геопривязка), плюс CLI-запуск движка для будущей кнопки в UI.
