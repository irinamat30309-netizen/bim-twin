# IFC-FINAL-r132: STEP-кодировка кириллицы и PSet_BimTwin (закрытие ограничений r131)

Дата: 2026-11-15. Продолжение `IFC-FINAL-r131.md`. Зона: `bim-twin` (IFC-писатель
`renderer/scan2bim.js`, `tools/scan2bim-py/`, артефакты `D:\BIM-TWIN-TEST\interior\`).
UI/движок/рендеры не трогались. Не закоммичено.

Python: 3.12.14, ifcopenshell 0.9.0.post1. Node: v24.20.0.

## 0. Итог

Оба ограничения IFC, выявленные в r131, **закрыты**:

1. **Кириллица в STEP** теперь пишется по ISO-10303-21: не-ASCII → `\X2\hhhh…\X0\`
   (UTF-16 code units, по 4 hex), апостроф удваивается (`''`), обратный слэш — `\\`.
   `ifcopenshell` читает имена корректно: `'Стена 1'`, `'Стена 83 (достроена)'`,
   `'Помещение 1 — 30.9 м²'`, `'Пол'/'Потолок'`. Валидатор: **0 ERROR / 0 WARNING / 0 INFO**,
   арность IFC4 OK.
2. **Property sets** добавлены для стен/плит/помещений: `IfcPropertySet` c именем
   **`PSet_BimTwin`** + `IfcPropertySingleValue` (типизированные значения) +
   `IfcRelDefinesByProperties`; все значения сверены с JSON-моделью Python-тестом.
   В интерьере v5: **111 наборов / 522 свойства / 111 связей**.

Все артефакты релиза перегенерированы единым писателем и проверены `validate-ifc.py --deep
--require-psets`: **0 ERROR/WARN/INFO, арность OK, кодировка OK, psets на месте** (см. §3).

## 1. STEP-кодировка строк (renderer/scan2bim.js)

Реализация `stepString()` (модульный уровень, экспортируется как `S.stepString`), повторяет
логику `renderer/scan2bim-export.js` `ifcStr()`:

```js
ifcStr("Стена 'А'") === "'\\X2\\042104420435043D0430\\X0\\ ''\\X2\\0410\\X0\\'''"
```

* символы 0x20–0x7E — как есть (апостроф → `''`, `\` → `\\`);
* остальные (кириллица, `—`, `²` и т.п.) — буфером в `\X2\hhhh\X0\` (4 hex на UTF-16 unit);
* переводы строк заменяются пробелом; `null` → `$`.

Экранирование применено ко всем именам: этажи (`Этаж N`), стены (`Стена N (достроена)`),
проёмы/окна/двери, помещения, плиты, балки, колонны, объекты, трубы, имя проекта и FILE_NAME.
Раньше имена вставлялись в STEP сырым UTF-8 — `ifcopenshell` читал файл без ошибок, но терял
кириллицу (`Name=' 1'`).

**До/после (py2-final-v5.ifc → py2-final-v5-utf8.ifc):**

| проверка | до (r131) | после (r132) |
|---|---|---|
| сырые не-ASCII байты в STEP | 100 имён стен + помещения | **0** (весь файл ASCII) |
| `Name` первой стены (ifcopenshell) | `' 1'` (кириллица потеряна) | **`'Стена 1'`** |
| имя первого помещения | `' 1  30.9 '` | **`'Помещение 1 — 30.9 м²'`** |
| `validate-ifc.py --deep` (кодировка) | FAIL (exit 1) | **OK (exit 0)** |
| остальные 57/45/5 стен в других артефактах | потеря кириллицы | читаются корректно |

`validate-ifc.py --deep` теперь сравнивает декодированное STEP-имя с тем, что вернул
ifcopenshell, и **возвращает FAIL/exit 1**, если не-ASCII записан сырым UTF-8 или имя
прочитано иначе (флаг `--require-psets` дополнительно требует наличие `IfcPropertySet`).

## 2. PSet_BimTwin (property sets)

Для каждого элемента создаются:

```
IfcPropertySet(GUID,$,'PSet_BimTwin',$,(props...))
IfcPropertySingleValue('thickness',$,IFCLENGTHMEASURE(0.22),$)
IfcRelDefinesByProperties(GUID,$,$,$,(#element),#pset)
```

| элемент | свойства PSet_BimTwin | тип значения |
|---|---|---|
| стена | `thickness` (м), `length` (м), `height` (м), `material` (brick/concrete/inferred/…), `inferred` (true/false), `coverage` (если модель содержит) | IfcLengthMeasure / IfcLabel / IfcBoolean / IfcRatioMeasure |
| плита | `thickness` (м), `type` (floor/ceiling) | IfcLengthMeasure / IfcLabel |
| помещение | `area` (м²), `height` (м) | IfcAreaMeasure / IfcLengthMeasure |

Примеры (py2-final-v5-utf8.ifc):

```
PSet_BimTwin [стена 1]:  thickness=0.22, length=4.286, height=3.278, material='concrete', inferred=false
PSet_BimTwin [стена 3]:  thickness=0.147, length=10.635, height=3.278, material='brick', inferred=false
PSet_BimTwin [стена 83]: material='inferred', inferred=true  (в имени — 'Стена 83 (достроена)')
PSet_BimTwin [помещение 1]: area=30.895, height=3.278
```

Инвентарь psets по артефактам:

| файл | IfcPropertySet | IfcPropertySingleValue | IfcRelDefinesByProperties |
|---|---:|---:|---:|
| py2-final-v5*.ifc (100 стен + 9 помещ. + 2 плиты) | 111 | 522 | 111 |
| py2-final-v2*.ifc (57 + 23 + 2) | 82 | 335 | 82 |
| py2-final-v4.ifc (85 + 23 + 2) | 110 | 475 | 110 |
| py2-facade.ifc / py2-facade-window.ifc (5 + 6) | 11 | 37 | 11 |
| py2-facade-mapcrop.ifc (1 + 2) | 3 | 9 | 3 |
| py2-validate.ifc / py2-georef.ifc (45 + 23 + 2) | 70 | 275 | 70 |

**Сверка значений с JSON:** `tools/scan2bim-py/test-ifc-r132.py` проходит по всем стенам,
помещениям и плитам, читает psets через ifcopenshell и сравнивает с `py2-final-v5.json`
(thickness/length/height/material/inferred у стен; area/height у помещений;
thickness/type у плит) — расхождений 0, плюс проверка имён и 0/0/0 валидатора.

## 3. Перегенерированные артефакты и валидация

| файл | inst | стены | двери | окна | помещ. | плиты | psets | кодировка | CRS |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| py2-final-v5.ifc (канонический) | 3336 | 100 | 4 | 1 | 9 | 2 | 111/522/111 | OK | — |
| py2-final-v5-utf8.ifc (алиас) | 3336 | 100 | 4 | 1 | 9 | 2 | 111/522/111 | OK | — |
| py2-final-v5-utf8-georef.ifc | 3338 | 100 | 4 | 1 | 9 | 2 | 111/522/111 | OK | **EPSG:25833+IfcMapConversion** |
| py2-final-v5-r131.ifc | 3336 | 100 | 4 | 1 | 9 | 2 | 111/522/111 | OK | — |
| py2-final-v5-r131-georef.ifc | 3338 | 100 | 4 | 1 | 9 | 2 | 111/522/111 | OK | **EPSG:25833+IfcMapConversion** |
| py2-final-v2.ifc | 2592 | 57 | 9 | 2 | 23 | 2 | 82/335/82 | OK | — |
| py2-final-v2-georef.ifc | 2594 | 57 | 9 | 2 | 23 | 2 | 82/335/82 | OK | **EPSG:25833+IfcMapConversion** |
| py2-final-v4.ifc | 5028 | 85 | 10 | 2 | 23 | 2 | 110/475/110 | OK | — |
| py2-facade.ifc | 1587 | 5 | 0 | 25 | 0 | 6 | 11/37/11 | OK | — |
| py2-facade-window.ifc | 1869 | 5 | 0 | 31 | 0 | 6 | 11/37/11 | OK | — |
| py2-facade-mapcrop.ifc | 199 | 1 | 1 | 1 | 0 | 2 | 3/9/3 | OK | — |
| py2-validate.ifc | 2208 | 45 | 10 | 1 | 23 | 2 | 70/275/70 | OK | — |
| py2-georef.ifc | 2210 | 45 | 10 | 1 | 23 | 2 | 70/275/70 | OK | **EPSG:25833+IfcMapConversion** |

* Все 13 файлов: `ifcopenshell` читает; **0 ERROR / 0 WARNING / 0 INFO**; арность IFC4 OK;
  файлы чистые ASCII (кроме только escape-последовательностей).
* Геопривязка georef-версий не изменилась: `IfcProjectedCRS` EPSG:25833 (ETRS89/UTM 33N WKT) +
  `IfcMapConversion` (0/0/0, xAxis=1, scale=1); сдвиг координат тот же:
  `(0.690335,−7.638154,0.182)` → `(500000.690335, 6000007.638154, 120.182)`.
* Артефакты `py2-final.ifc`, `py2-final-v3.ifc`, `py2-final-georef.ifc` — старые
  (superseded, вне релизного набора r131/r132); не перегенерировались.
* Размеры выросли из-за psets и `\X2\`-экранирования: v5 121 476 → 180 651 B,
  v2 99 044 → 139 309 B, facade 70 077 → 75 996 B и т.д.

## 4. Тесты

* **Node** `test/r132-ifc-utf8-psets.test.js` — 4/4 pass:
  1) `stepString` кодирует не-ASCII, `''`, `\\`, `null`, переводы строк;
  2) `toIFC` — только ASCII, имена через `\X2\` (стена/помещение/плита/«достроена»);
  3) `PSet_BimTwin` для стен/плит/помещений: наборы/свойства/связи + типизированные значения
     (`IFCLENGTHMEASURE`, `IFCLABEL('inferred')`, `IFCBOOLEAN(.T./.F.)`, `IFCAREAMEASURE`);
  4) каждая `IfcRelDefinesByProperties` ссылается на существующие элементы.
* **Python** `tools/scan2bim-py/test-ifc-r132.py` — OK: имена читаются, psets совпадают с JSON,
  валидатор 0/0/0 (см. §2).
* Обновлён существующий тест `test/scan2bim-ifc-openings-v1231.test.js`: он искал сырое имя
  «Проём 1 (дверной)» — добавлен `unescapeStep()` (декодирование `\X2\` + `''`), проверки
  геометрии/связей/void'ов не изменены; 3/3 pass.
* Полный `node --test`: **1708 тестов, 1703 pass, 4 skipped**. На момент прогона остаётся
  1 падающий тест `r54: утончение стен не стирает ступень 1,5 см между панелями` — он
  относится к параллельной работе по `scan-refine-core.js`/`thinSurfaces` (файлы
  `scan-refine-core.js`, `test/r54-quality-tools.test.js` изменены другим исполнителем),
  к IFC-коду отношения не имеет. IFC-подмножество (r132, v1231, r74, r110, source-frame,
  detail) — все зелёные.

## 5. Изменённые файлы (не закоммичено)

* `renderer/scan2bim.js` — модульный `stepString()` с `\X2\`-экранированием; все имена
  пропускаются через него; `PSet_BimTwin` (`psetEncode`/`addPset`) для стен/плит/помещений;
  экспорт `S.stepString`.
* `tools/scan2bim-py/validate-ifc.py` — `--deep`: psets (имена/значения/связи) и кодировка;
  **FAIL/exit 1**, если кириллица сырым UTF-8 или имя прочитано неверно; `--require-psets`;
  в инвентарь добавлены `IfcPropertySet`/`IfcPropertySingleValue`/`IfcRelDefinesByProperties`.
* `tools/scan2bim-py/test-ifc-r132.py` — новый Python-тест (имена + psets против JSON).
* `test/r132-ifc-utf8-psets.test.js` — новый Node-тест (4 теста).
* `test/scan2bim-ifc-openings-v1231.test.js` — декодирование `\X2\` в ожиданиях имён.
* `tools/scan2bim-py/json-to-ifc.js` (r131) — `--georef` (EPSG:25833, zup t=[500000,6000000,120]).
* Артефакты: 13 IFC в `D:\BIM-TWIN-TEST\interior\` перегенерированы из исходных JSON
  (`py2-final-v5*.ifc`, `py2-final-v2*.ifc`, `py2-final-v4.ifc`, `py2-facade*.ifc`,
  `py2-validate.ifc`, `py2-georef.ifc`).

## 6. Воспроизведение

```
# обычный и georef-варианты финального интерьера (файлы эквивалентны, отличается FILE_NAME)
node tools/scan2bim-py/json-to-ifc.js D:\BIM-TWIN-TEST\interior\py2-final-v5.json \
     D:\BIM-TWIN-TEST\interior\py2-final-v5-utf8.ifc --name=py2-final-v5-utf8.ifc
node tools/scan2bim-py/json-to-ifc.js D:\BIM-TWIN-TEST\interior\py2-final-v5.json \
     D:\BIM-TWIN-TEST\interior\py2-final-v5-utf8-georef.ifc --name=py2-final-v5-utf8-georef.ifc --georef

# валидация (0/0/0 + psets + кодировка; exit 1 при проблемах)
python tools/scan2bim-py/validate-ifc.py <file.ifc> --deep --require-psets
python tools/scan2bim-py/test-ifc-r132.py     # имена + значения psets против JSON
node --test test/r132-ifc-utf8-psets.test.js  # STEP-кодирование и psets
```
