# IFC-FINAL-r131: финальная валидация IFC и геопривязки (релиз)

> **Обновление r132:** выявленные здесь ограничения закрыты — кириллица теперь
> экранируется по ISO-10303-21 (`\X2\…\X0\`), для стен/плит/помещений добавлен
> `PSet_BimTwin`, все релизные IFC перегенерированы и проходят
> `validate-ifc.py --deep --require-psets` (0/0/0, кодировка OK, psets > 0).
> Подробности и новые таблицы: **`IFC-FINAL-r132.md`**. Разделы §5–§6 этого отчёта —
> исторические (состояние до r132).

Дата: 2026-11-15. Область: `bim-twin` (только `tools/scan2bim-py/`, IFC-артефакты
`D:\BIM-TWIN-TEST\interior\`). UI/движок/рендеры не изменялись. Не закоммичено.

Инструменты (в зоне задачи):
* `tools/scan2bim-py/validate-ifc.py` — ifcopenshell.validate + проверка арности по схеме
  IFC4 + инвентарь + геопривязка; расширен флагом `--deep`: стили/цвета (первые 5),
  имена `«(достроена)»`, этажи/помещения/плиты, psets, контроль кодировки имён;
* `tools/scan2bim-py/json-to-ifc.js` — экспорт JSON → IFC4 через `renderer/scan2bim.js`
  (toIFC); в r131 добавлен `--georef` (EPSG:25833, sourceTransform zup t=[500000,6000000,120]
  — так же, как `py2-final-v2-georef.ifc`), а также `--crs-wkt`, `--source-t`, `--source-axis`,
  `--project` (по умолчанию поведение не изменилось).

Python: 3.12.14, ifcopenshell 0.9.0.post1.

## 0. Итог

**Все файлы релиза валидны:** у всех 0 ERROR / 0 WARNING / 0 INFO, арность IFC4 OK,
файлы читаются ifcopenshell, инвентарь корректный; геопривязка (`IfcProjectedCRS` EPSG:25833 +
`IfcMapConversion`) есть у georef-версий и отсутствует у обычных — как и задумано.
Перегенерированный финальный IFC `py2-final-v5-r131.ifc` **посимвольно совпадает** с
`py2-final-v5.ifc` (кроме строки FILE_NAME), т.е. артефакт воспроизводим.

## 1. Таблица валидации

| № | файл | schema | inst | ERROR | WARN | INFO | арность | CRS |
|---|---|---|---|---:|---:|---:|---|---|
| 1 | `py2-final-v5.ifc` | IFC4 | 2592 | 0 | 0 | 0 | OK | — |
| 2 | `py2-final-v5-r131.ifc` (новый) | IFC4 | 2592 | 0 | 0 | 0 | OK | — |
| 3 | `py2-final-v5-r131-georef.ifc` (новый) | IFC4 | 2594 | 0 | 0 | 0 | OK | **IfcProjectedCRS EPSG:25833 + IfcMapConversion** |
| 4 | `py2-final-v2.ifc` | IFC4 | 2093 | 0 | 0 | 0 | OK | — |
| 5 | `py2-final-v2-georef.ifc` | IFC4 | 2095 | 0 | 0 | 0 | OK | **IfcProjectedCRS EPSG:25833 + IfcMapConversion** |
| 6 | `py2-facade.ifc` | IFC4 | 1528 | 0 | 0 | 0 | OK | — |
| 7 | `py2-facade-window.ifc` | IFC4 | 1810 | 0 | 0 | 0 | OK | — |
| 8 | `py2-facade-mapcrop.ifc` | IFC4 | 184 | 0 | 0 | 0 | OK | — |
| 9 | `py2-validate.ifc` | IFC4 | 1793 | 0 | 0 | 0 | OK | — |
| 10 | `py2-georef.ifc` | IFC4 | 1795 | 0 | 0 | 0 | OK | **IfcProjectedCRS EPSG:25833 + IfcMapConversion** |
| 11 | `py2-final-v4.ifc` (доп.) | IFC4 | 4333 | 0 | 0 | 0 | OK | — |
| 12 | `py2-final.ifc`, `py2-final-v3.ifc`, `py2-final-georef.ifc` (доп.) | IFC4 | — | 0 | 0 | 0 | OK | у georef — есть |

Примечание к п.4: `py2-final-v2.ifc` содержит модель **57 стен / 23 помещения** и совпадает
с `py2-final-v2.json` (это линия v2/v3). Модель v4 (85 стен) — в `py2-final-v4.ifc`
(доп. строка, тоже 0 ERROR). Если в релиз должен войти именно v4-IFC — брать
`py2-final-v4.ifc`; оба файла валидны.

## 2. Инвентарь

| файл | стены | двери | окна | проёмы | помещения | плиты | стили | styledItem |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| py2-final-v5.ifc / -r131 | 100 | 4 | 1 | 5 | 9 | 2 | 28 | 111 |
| py2-final-v5-r131-georef | 100 | 4 | 1 | 5 | 9 | 2 | 28 | 111 |
| py2-final-v2.ifc / -georef | 57 | 9 | 2 | 11 | 23 | 2 | 44 | 82 |
| py2-facade.ifc | 5 | 0 | 25 | 25 | 0 | 6 | 3 | 11 |
| py2-facade-window.ifc | 5 | 0 | 31 | 31 | 0 | 6 | 3 | 11 |
| py2-facade-mapcrop.ifc | 1 | 1 | 1 | 2 | 0 | 2 | 3 | 3 |
| py2-validate.ifc | 45 | 10 | 1 | 11 | 23 | 2 | 44 | 70 |
| py2-georef.ifc | 45 | 10 | 1 | 11 | 23 | 2 | 44 | 70 |
| py2-final-v4.ifc | 85 | 10 | 2 | 12 | 23 | 2 | 44 | 110 |

## 3. Перегенерация финального IFC (r131) и геопривязка

Команды (воспроизводимо):

```
node tools/scan2bim-py/json-to-ifc.js D:\BIM-TWIN-TEST\interior\py2-final-v5.json \
     D:\BIM-TWIN-TEST\interior\py2-final-v5-r131.ifc --name=py2-final-v5-r131.ifc
node tools/scan2bim-py/json-to-ifc.js D:\BIM-TWIN-TEST\interior\py2-final-v5.json \
     D:\BIM-TWIN-TEST\interior\py2-final-v5-r131-georef.ifc --name=py2-final-v5-r131-georef.ifc --georef
```

* `py2-final-v5-r131.ifc` — 121 481 B, 2592 экземпляра; сравнение с `py2-final-v5.ifc`
  после нормализации FILE_NAME: **идентичны (119 923 символа, 0 различий)**.
* `py2-final-v5-r131-georef.ifc` — 130 226 B, 2594 экземпляра (+`IfcProjectedCRS`,
  +`IfcMapConversion`); CRS: `EPSG:25833` (WKT `PROJCRS["ETRS89 / UTM zone 33N",…,ID["EPSG",25833]]`),
  `IfcMapConversion(SourceCRS=IfcGeometricRepresentationContext, TargetCRS=IfcProjectedCRS,
  Eastings=0, Northings=0, OrthogonalHeight=0, XAxisAbscissa=1, XAxisOrdinate=0, Scale=1)`.
* Сдвиг координат проверен: точка `(0.690335, -7.638154, 0.182)` →
  `(500000.690335, 6000007.638154, 120.182)` (zup: X+=500000, Y+=6000000, Z+=120);
  отметка этажа в georef-версии `Elevation = 120.182` (было 0.182).
* Оба файла валидны: 0 ERROR/WARN/INFO, арность OK (см. таблицу).

## 4. Материалы и стили из облака (интерьер v5)

* `IfcSurfaceStyle` — **28** (ровно 28 уникальных цветов модели из `py2-final-v5.json`);
  `IfcStyledItem` — **111** = 100 стен + 9 помещений + 2 плиты (стиль есть у каждого продукта).
* Цвета IFC = цвета облака × коэффициент яркости **1.22** (в `colorStyle` toIFC: «скан в
  подвале тёмный: слегка поднимаем яркость»); проверка обратным делением: **28/28 точных
  совпадений**. Примеры первых 5:

| # | имя стиля | IFC RGB (0–255) | цвет облака (0–255) | продукт |
|---|---|---|---:|---|
| 1 | Wall concrete | (131, 91, 96) | (108, 74, 78) | стена |
| 2 | Wall brick | (167, 138, 150) | (137, 113, 123) | стены |
| 3 | Wall concrete | (128, 91, 79) | (105, 74, 65) | стены |
| 4 | Wall concrete | (138, 83, 68) | (113, 68, 56) | стена |
| 5 | Wall brick | (167, 123, 117) | (137, 101, 96) | стена |

* Фасадные IFC — фиксированная палитра 3 стиля: `Wall facade` (218,212,199),
  `Slab floor` (224,218,205), `Slab ceiling` (230,224,212); styledItem 11 = 5 стен + 6 плит
  (`py2-facade*`), для mapcrop 3 = 1 стена + 2 плиты.

## 5. Имена элементов, этажи, помещения, property sets

* **Имена inferred-элементов:** в интерьере v5 100 стен, из них **82 с `«(достроена)»`**
  (в `py2-final-v5.json` ровно 82 inferred-стены). Примеры: `Стена 1`, `Стена 83 (достроена)`.
  В v2-IFC: 57 стен, 36 `«(достроена)»` (=36 inferred в JSON).
* **Этажи:** 1 `IfcBuildingStorey` с именем `Storey`, `Elevation=0.182`
  (в georef-версии 120.182). Фасады: 5 этажей (отм. 8.21…23.01).
* **Помещения:** 9 `IfcSpace` с именами `Помещение N — S м²` (30.9, 20.1, 17.7, 13.8, 11.8, …м²),
  все 9 подчинены этажу через `IfcRelAggregates`; плиты: `Пол`, `Потолок`.
* **Property sets:** `IfcPropertySet` = **0** во всех файлах — писатель `toIFC` их не
  формирует (ни `Pset_WallCommon`, ни `Pset_SpaceCommon`, ни `Qto_*`). Для валидации это
  не ошибка (0 ERROR/WARNING), но для обмена с BIM-системами атрибуты (материал, признак
  «достроена», площади, отметки) в psets отсутствуют. Если psets нужны в релизе — это
  отдельная доработка писателя (вне текущей зоны: renderer/scan2bim.js).
* **Ограничение кодировки (найдено, не блокирует валидацию):** не-ASCII имена (кириллица)
  записываются в STEP-строки сырым UTF-8, тогда как ISO-10303-21 требует ASCII с
  `\X2\…\X0\`; ifcopenshell файл читает и валидатор даёт 0 ошибок, но при чтении теряет
  кириллицу (`Name=' 1'` вместо `'Стена 1'`). На геометрию/арность не влияет; все текущие
  артефакты используют ту же конвенцию. Рекомендация на будущее — экранировать не-ASCII
  при выпуске строгого STEP-обмена (менять `stepString` в `renderer/scan2bim.js` — вне зоны r131).

## 6. Что изменено в репозитории (не закоммичено)

* `tools/scan2bim-py/validate-ifc.py` — добавлен `--deep` (стили/цвета, имена, этажи,
  помещения, psets, кодировка) и поля `deep` в `--json`.
* `tools/scan2bim-py/json-to-ifc.js` — добавлена геопривязка `--georef` (и явные
  `--crs-wkt/--source-t/--source-axis/--project`); поведение по умолчанию не изменилось
  (перегенерация plain-IFC посимвольно совпала с существующим `py2-final-v5.ifc`).
* Артефакты: `D:\BIM-TWIN-TEST\interior\py2-final-v5-r131.ifc`,
  `py2-final-v5-r131-georef.ifc`.
* UI/движок/рендеры не трогались; `node --test` не запускался (изменения — только CLI-скрипты
  вне тестового покрытия; затронутый toIFC не менялся).
