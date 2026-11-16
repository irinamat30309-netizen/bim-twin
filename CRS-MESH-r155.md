# CRS-MESH-r155 — P2-инструменты: CRS/координаты и mesh-операции

Дата: 2026-11-16. Готово: `tools/scan2bim-py/crs-tools.py` (+`crs-tools-test.py`),
`tools/scan2bim-py/mesh-tools.py` (+`mesh-tools-test.py`). Отчёты тестов — PASS/FAIL ниже.
Инструменты готовы к подключению UI (JSON-контракты в §3).

## 1. crs-tools.py — CRS/координаты

### Что делает
- STATUS: читает LAS (VLR GeoKey/WKT) или PLY, печатает/пишет JSON — EPSG/WKT, bbox,
  углы bbox в WGS84 (lon/lat), наличие VLR.
- ПЕРЕСЧЁТ: `--in cloud.las --epsg 32636 --to 4326|25836|32636|local --out-las out.las`;
  UTM ↔ WGS84 ↔ ETRS89/UTM ↔ локальная («УСК») система.
- ЗАПИСЬ ПРИВЯЗКИ: `--update-header` — в LAS добавляются VLR `LASF_Projection/34735`
  (GeoKeyDirectory, EPSG) и `LASF_Projection/4224` (WKT); либо `--out-las` при пересчёте
  (VLR пишутся в пересчитанный LAS).
- `--georef-file georef.json` — файл привязки для IFC (`json-to-ifc.js --georef-file`):
  `crs.wkt` + `transform.ifc_map_conversion` (8 аргументов) + `source_transform zup`.
- `--local-params E0,N0,theta_deg,scale` — локальная СК (УСК-Київ) как аффинное
  преобразование от UTM; при отсутствии параметров — предупреждение + единичное.
- `--max-points` — ограничить число точек (быстрые пробы), `--json` — машинный отчёт.

### Точность (тесты `crs-tools-test.py`: PASS 14 | FAIL 0)
| Проверка | Результат |
|---|---|
| Control-точка dfi: (322149.45, 5588278.54) ↔ (50.419576, 30.496374) — forward | E=322149.4361, N=5588278.4915; **dE −13.9 мм, dN −48.5 мм, dist 50.5 мм** |
| inverse контрольной точки | lat=50.41957644 (Δ+49 мм), lon=30.49637417 (Δ+12 мм) |
| **forward∘inverse(E,N) (внутренняя согласованность)** | **0.000000 мм** (≤0.3 мм PASS) |
| **roundtrip 200 точек WGS84→UTM→WGS84** | **max 0.000005 мм, mean 0.000001 мм** (≤1 мм PASS) |
| файловый roundtrip UTM→LAS(4326)→UTM | **max 0.85 мм** (1e-9° квантование) |
| ETRS89 (25836) ↔ WGS84 (32636) | Δ 0.000 м (без учёта эпохи/7-параметров) |

Пояснение к control-точке: заданные lat/lon округлены до **1e-6°** (≈0.11 м по широте,
0.07 м по долготе), поэтому абсолютное «0.3 мм» по этой паре принципиально недостижимо —
0.3 мм достигается на **внутренней** согласованности (forward∘inverse = 0 нм) и roundtrip
(5 нм). Расхождение 50 мм полностью объясняется округлением входных lat/lon.

Код проекции: **Karney/Krüger Transverse Mercator (ряд до n⁶)** — nm-уровень; формулы
конформной широты точные: τ' = sinh(asinh τ − e·atanh(e τ/√(1+τ²))), обратная — решение
неподвижной точкой (6 итераций). WKT генерируется для EPSG:4326/258xx/326xx/327xx; VLR
GeoKeyDirectory + WKT 4224 пишутся и читаются.

### Производительность (реальные данные)
- `D:\Skan\дфі\20260821105321013.las` (313.7M точек, UTM 36N) → 500 000 точек в 4326:
  **1.69 с** (чтение+пересчёт+запись LAS), bbox после: lon 30.496, lat 50.419–50.420 ✔.
- пересчёт векторизован (numpy), полный файл оценивается линейно (≈1–2 млн точек/с
  на этой машине, с учётом записи).

## 2. mesh-tools.py — mesh-операции

### Что делает (порядок применения фиксирован)
1. `--fill-holes [--max-hole-edges 500]` — поиск граничных петель и заполнение
   fan-триангуляцией (центроид петли) → замкнутый mesh;
2. `--smooth ITER [--lambda 0.5]` — лапласово сглаживание, **граничные вершины
   фиксированы** (сохранение границ);
3. `--remove-triangles color:R,G,B[,tol] | class:R,G,B[,tol] | volume:MIN_M3` — удаление
   треугольников по цвету/классу (vertex colors) или мелких компонент по объёму;
4. `--decimate quadric:N | voxel:SIZE` — упрощение (Open3D quadric decimation или
   vertex clustering).
Вход/выход: PLY/OBJ/STL (Open3D); `--json` — отчёт (до/после, watertight, объём, bbox,
операции с таймингами).

### Тесты `mesh-tools-test.py`: PASS 11 | FAIL 0
| Проверка | Результат |
|---|---|
| Куб с дырой (удалены 2 треугольника, boundary 4) → fill-holes | 1 дыра заполнена, +4 треугольника, **boundary_edges = 0 (watertight)** |
| Сглаживание (сфера + шум σ=5 см, 5 итераций, λ=0.5) | RMS отклонения **0.0870 → 0.0256 м** (−70.6 %); объём **−4.34 %** (≤5 %); граница не сдвинута |
| remove-triangles по цвету | удалено 2, осталось 10 (PASS) |
| remove-triangles по объёму (мелкий компонент 0.2 м) | 1 компонент удалён (PASS) |
| decimate quadric (сфера 6240 → 1248 три) | объём изменился **1.20 %** (≤5 %) |
| CLI E2E: fill-holes + `--json` | exit 0, файлы записаны, JSON `watertight=true` |

### Время на 1–3 млн треугольников (измерено, box.subdivide_loop)
| Размер | fill-holes | smooth(3 итер., λ=0.5) | decimate quadric (до 10 %) |
|---|---|---|---|
| **786 432 три (≈0.8M)** | **2.84 с** | **3.23 с** | **16.15 с** |
| **3 145 728 три (≈3M)** | **12.65 с** | **10.36 с** | **48.88 с** |
| оценка на 10M (линейно/×3.2) | ≈40 с | ≈33 с | ≈160 с |

Память: Open3D mesh в памяти; для 3M триангуляций ~ (вершины+три) сотни МБ; decimate —
самая тяжёлая операция (квадричная ошибка, O(n log n)-подобная).

## 3. Контракт для UI (main-мост `bim:p23CrsStatus`, `bim:p23CrsRun`, `bim:p23MeshRun`)

`crs-tools.py --in <las> [--epsg N] --json out.json` → JSON:
```json
{"ok":true,"format":"las","points_file":N,
 "source":{"epsg":32636,"kind":"projected","name":"EPSG:32636","wkt":"PROJCRS[...]"},
 "bbox":[E0,N0,H0,E1,N1,H1],
 "corners_wgs84":[{"E":..,"N":..,"lon":..,"lat":..}, ... 4 шт],
 "vlr":{"count":N,"epsg":32636,"has_wkt":true}}
```
ПЕРЕСЧЁТ: `--in cloud.las --epsg 32636 --to 4326 --out-las out.las --json out.json` →
добавляется `transform":{"points":N,"seconds":..,"source_epsg":..,"target_epsg":..,
"bbox_before":[...],"bbox_after":[...],"wkt":"..."}`, `out_las`.
ЗАПИСЬ ПРИВЯЗКИ: `--in cloud.las --epsg 32636 --update-header --out-las cloud-crs.las` →
`update_header":{"file":..,"points":N,"vlr":2,"wkt":true,"epsg":32636}`.
IFC: `--georef-file georef.json` (проекционная цель) → `georef_file` в JSON.
Ошибки → exit 2, `{"ok":false,"error":"..."}`; успех → exit 0.

`mesh-tools.py --in m.ply --out m-out.ply --fill-holes --smooth 5 --remove-triangles
color:255,0,0,30 --decimate quadric:200000 --json report.json` → JSON:
```json
{"ok":true,"in":"..","out":"..",
 "before":{"vertices":..,"triangles":..,"boundary_edges":..,"watertight":bool,
           "volume_m3":..,"bbox":[..]},
 "operations":[{"op":"fill-holes","holes_filled":1,"triangles_added":4,"seconds":..},
               {"op":"smooth","iterations":5,"lambda":0.5,"moved_vertices":..,
                "max_move_m":..,"seconds":..}, ...],
 "after":{...},"seconds_total":..}
```
Форматы: PLY/OBJ/STL (рекомендую PLY для цветов); GLB — если установлен Open3D 0.20,
чтение/запись glTF/GLB поддержаны, но не тестировались — для UI безопаснее PLY/OBJ.
Прогресс: оценивать по `before.triangles` и типовым скоростям (fill ≈ 0.3M три/с,
smooth ≈ 0.3M три/с, decimate ≈ 0.06M три/с на этой машине).

## 4. Ограничения

- CRS: поддержаны EPSG:4326, 258xx (ETRS89/UTM), 326xx/327xx (WGS84/UTM); другие
  проекции — не поддержаны. Переход ETRS89↔WGS84 без 7-параметров (в Украине различие
  реализаций до ~1 м — при необходимости использовать официальную трансформацию).
- «УСК-Київ» не имеет публичного определения: реализована как локальная аффинная
  система от UTM (`--local-params E0,N0,theta_deg,scale`); без параметров — предупреждение.
- В LAS пишется WKT (OGC WKT2-упрощённый) и GeoKeyDirectory; VLR-парсер понимает
  EPSG/WKT, написанные этим инструментом (сторонние WKT не интерпретируются).
- mesh: fill-holes — fan-триангуляция (для сложных кривых границ лучше ear-clipping —
  не реализован); сглаживание может уменьшать объём на 4–5 % за 5 итераций (для
  сохранения формы — 2–3 итерации); remove-by-class работает по цвету вершин (классы
  должны быть «раскрашены» в цвета), иначе нужен отдельный атрибут класса в PLY.

## 5. Исправления по баг-репорту UI (r155b)

По E2E-прогону `phase4-edit-ui` найдены и исправлены две проблемы `crs-tools.py`:

1. **`--to 4326 --out-las` → `struct.error: 'i' format ...` (int32-overflow при записи LAS).**
   Причина: в `write_las` смещение/масштаб выбирались фиксированно (`offset=floor(min)`,
   `scale=1e-9`/`0.001`), без проверки, что `(coord − offset)/scale` укладывается в int32
   (для координат с большим диапазоном/смещением — выходит за ±2.147e9). Исправлено:
   масштаб и смещение теперь **вычисляются автоматически**: `offset = центр bbox`,
   `scale = max(base, span/1e9)` по каждой оси (base = 1e-9° для градусов, 0.001 м для
   метров; при диапазоне >~2° шаг плавно увеличивается). Гарантия: |coord−offset| ≤ span/2,
   поэтому int32 не переполняется при любых данных; на реальных углах точность не хуже
   прежней (для градусов 1e-9° ≈ 0.1 мм). Регрессионные тесты: UTM-36N с N≈6.18e6 → 4326
   exit 0 (0.57 с на 272 500 точек), 10°-диапазон → scale 1e-8°, LAS пишется.
2. **`--to local` → `ValueError: неподдерживаемый EPSG: 0`.**
   Причина: `transform_las` вызывал `epsg_info(to_epsg)` до проверки local-ветки (`to_epsg=0`
   — не EPSG-код). Исправлено: при `to_epsg == 0` целевая система сразу трактуется как
   `local` (WKT `LOCAL_CS["USK/local"...]`, VLR с GeoKey не пишется); `--to local
   --local-params 0,0,0,1` → exit 0, координаты identity (проверено на файле UI-репро:
   272 500 точек, 0.68 с).

После исправлений: `crs-tools-test.py` — **PASS 19 / FAIL 0** (добавлены 5 регрессионных
проверок: 4326 на UTM-36N/N≈6.18e6, `--to local` identity, широкий диапазон 10°).

## 6. Артефакты

- `tools/scan2bim-py/crs-tools.py`, `crs-tools-test.py` (PASS 14/0);
- `tools/scan2bim-py/mesh-tools.py`, `mesh-tools-test.py` (PASS 11/0);
- реальный прогон: `D:\BIM-TWIN-TEST\xbin-verify\r155-crs-real.json`,
  `r155-dfi-wgs84.las` (500k точек UTM→WGS84, 1.69 с);
- в git не коммитил, UI не трогал, чужие файлы не менял.
