# PHASE5-FINAL-r189 — аудит «до идеала», найденные баги и финальный пакет

Дата: 2026-11-21, 19:20 (Europe/Kiev). База: `bim-twin`, ветка `agent/ui-redesign`, HEAD **`decaa0d` r188**
+ рабочие правки аудита r189 (не коммичены). Окружение: Windows, Node v24.20.0, Python 3.12.14 (DSH),
Electron 31, RTX 5070 12 ГБ.

## 0. Итог

- **Найден и исправлен баг**: `cloud-classify.py --max-points` → `IndexError` в `write_las_filtered`
  (проверено на реальном LAS: 200k и 1M точек, в т.ч. `--refine-dynamic` и `--out-bin`).
  Добавлен тест-файл `cloud-classify-test.py` — **6/6 PASS** (включая реальное облако).
- **Полная регрессия**: `node --test` **1914 тестов / 1910 pass / 0 fail / 4 skip**; Python — все
  наборы PASS (188 проверок + classify 6/6 + self-test); IFC v5 — **0 ERROR/WARNING/INFO**;
  quality v5 — **A1–A8 8/8 PASS**.
- **E2E**: пути/хранилище r184 — **36/36 checks, ok=true**, 0 ошибок консоли, AppData не засорён;
  цвет r183 — проверка отдельным запуском (см. §3, найдено расхождение с ожиданием r183 — зафиксировано).
- **Пакет проверен и пересобран**: актуальный `START-HERE-r189.txt`, отчёты до r189 включительно,
  deliverables и 350+ скриншотов, финальный zip в Downloads + Desktop.

## 1. Найденные баги и исправления

### BUG-1 (исправлен): `cloud-classify.py --max-points` → IndexError

Воспроизведение (реальное облако `D:\BIM-TWIN-TEST\xbin-verify\facade-sky-on.las`):

```
python tools/scan2bim-py/cloud-classify.py <las> --max-points 200000 --out-las out.las --json out.json
→ File "cloud-classify.py", line 661, in write_las_filtered
  raw[p + class_off] = int(ASPRS[CLASSES[cls[i + j]]])
  IndexError: index 200000 is out of bounds for axis 0 with size 200000
```

**Причина.** `read_las()` при `--max-points` читает только первые N точек (`min(H['n'], max_points)`),
а `write_las_filtered()` открывал исходный файл и шёл циклом по `n0` из заголовка (полное число точек),
индексируя `cls[i+j]` — массив усечён. Для `.bin`-входа бага не было (writer работает по `len(X)`),
поэтому «классификация без maxPoints проходит».

**Исправление** (`tools/scan2bim-py/cloud-classify.py`):
`n_src = min(n0, len(cls))`; цикл и `remove_mask` работают по `n_src` (маска срезается до той же длины);
в заголовок пишется фактическое `written`; JSON `out_las.{written,removed}` считается от `n_src`.
Проверено: 200k → заголовок 200000, 1M+refine-dynamic → 1000000, `--out-bin` 5000×32 Б, реальное облако 50k.

**Тесты** (`tools/scan2bim-py/cloud-classify-test.py`, новый):
1. `--max-points 5000`: LAS-заголовок/JSON ровно 5000 (регрессия IndexError);
2. без `--max-points`: полный файл (12000);
3. `--max-points 7000 --refine-dynamic`: written+removed=7000, заголовок=written;
4. `--max-points 5000 --out-bin`: 5000×32 Б;
5. unit: `write_las_filtered` с усечённым cls (3000 из 12000);
6. реальное облако `_frame-test.las` --max-points 50000.
Итог: **PASS 6 / FAIL 0** (`D:\BIM-TWIN-TEST\r55\classify-r189\regression\cloud-classify-test.py.log`).
Classify self-test (синтетика): люди 1735 найдено → после refine-dynamic 0 — PASS.

### Наблюдение BUG-2 (не исправлял, зафиксировано): баннер «Облако без цвета» на сером облаке

Стенд r183 (`COLOR-OPEN-r183.md`) ожидал: серый `.las` (RGB = яркость лидара, насыщенность 0) →
`hasRGB=false` + баннер «Облако без цвета». В текущей сборке r188 при запуске с
`D:\Skan\port\fasadamosova\test-gray-36m.las`:
`getCloudInfo().hasRGB = true` (RGB-атрибут присутствует, но цвет серый), баннер скрыт (`display:none`),
при этом панель честно пишет «Цвета в файле нет: RGB — серая яркость отражения лидара…». Для цветного
файла всё корректно: `hasRGB=true`, баннер скрыт, colorNote пуст.
→ Т.е. после r183–r185 детектор различает «есть RGB-атрибут» и «цвет реальный», но баннер завязан на
`hasRGB===false`; для серых lidar-облаков с RGB-атрибутом баннер больше не появляется (в r183 появлялся).
Это не ломает цвет и не влияет на классификацию, но UX-расхождение с приёмкой r183 — требуется решение
владельца зоны цвета (r185 менял 16-бит RGB/детектор). В рамках r189 не правил, чтобы не менять
логику цвета без согласования; скриншоты/JSON приложены.

### Наблюдения по пакету (исправлены при пересборке)

| Находка | Исправление |
|---|---|
| В root-пакете r188 лежали устаревшие `START-HERE-r172.txt` и `START-HERE-r182.txt` | корень обновлён на `START-HERE-r189.txt`, старые остаются только в истории репозитория |
| Копия на Desktop отсутствовала (был только Downloads) | финальный zip записан и в Downloads, и на Desktop (байт-в-байт) |
| `DPI-CRS-r189.md` (анализ стороннего LAS/EPSG:32636) не попадал в пакет | включён: `bim-twin-r55/DPI-CRS-r189.md` |
| В пакете не было артефактов аудита r189 (classify self-test/max-points, color-check, paths E2E) | добавлены в `deliverables/` |

## 2. Регрессия (HEAD r188 + правки r189)

| Проверка | Результат | Статус |
|---|---|---|
| `node --test` | **1914 тестов / 1910 pass / 0 fail / 4 skip** (167 с) | PASS |
| crs-tools-test.py | PASS 19 / FAIL 0 | PASS |
| mesh-tools-test.py | PASS 11 / FAIL 0 | PASS |
| cloud-register-test.py | PASS 17 / FAIL 0 | PASS |
| georef-rtk-test.py | PASS 26 / FAIL 0 / SKIP 1 | PASS |
| georef-control-test.py | PASS 18 / FAIL 0 | PASS |
| edit-model-test.py | PASS 35 / FAIL 0 | PASS |
| docs-extract-test.py + docs-compare-test.py | PASS 21 + 19 / FAIL 0 | PASS |
| facade-test.py | кейсы 3/3, проверки 20/20 | PASS |
| cloud-classify-test.py (новый) | PASS 6 / FAIL 0 | PASS |
| cloud-classify.py --self-test | ok=true, люди 1735 → после refine 0 | PASS |
| `run-quality-all.py` v5 | **A1–A8 8/8 PASS** (2 мм; 94/62 %; 3/16/30; 99,8 %; 95,6 %; 0/0; 100/100 %; 0 мм); итого PASS 45 / FAIL 6 (историч. r107) | PASS |
| `validate-ifc.py py2-final-v5.ifc` | IFC4, 3336 instances, **0 ERROR/0 WARNING/0 INFO**, арность OK | PASS |

## 3. E2E-сценарии

| Стенд | Результат | Детали |
|---|---|---|
| **r184-paths-e2e.js** (хранилище/пути) | **PASS** | `ok=true`, **36/36 checks**, 0 ошибок консоли, 0 новых файлов в AppData/appData, все выходы инструментов внутри проекта (`output/classify-…`, `register-…`, `clip-…`, export); баннер «Старые результаты в AppData: 307,8 МБ» с кнопкой удаления |
| **r183-color-e2e.js** (цвет/баннер) | частично | повторное открытие в уже запущенном приложении стенд делает без ожидания загрузки нового файла — результат цвета недостоверен; отдельная проверка запуском с файлом в argv (r189-color-check.js): цветной файл — `hasRGB=true`, баннер скрыт, colorNote пуст (PASS); серый файл — баннер скрыт (расхождение с r183, см. BUG-2), colorNote «Цвета в файле нет…» |
| Инспектор/кнопки/ИИ | по отчётам приёмки | E2E-приёмка инспектора/ИИ выполнена в r169/r171 (6/6 и 7/7 PASS), стенды остались; текущие правки r172–r189 их не затрагивают (UI-флаги r178 скрывают панели по умолчанию, опция `__bimEnableExtraUi`) |

Артефакты: `D:\BIM-TWIN-TEST\r55\classify-r189\` (логи, JSON, color-check скриншоты),
`D:\BIM-TWIN-TEST\r55\paths-r184\` (e2e-result.json 36 checks).

## 4. Пакет

`bim-twin-r55-full.zip` пересобран из текущего дерева (r188 + правки r189):
**C:\Users\bob\Downloads\bim-twin-r55-full.zip = см. `package-r189-summary.json`** (≈372 МиБ, 1320+ записей,
350+ скриншотов), копия на **Desktop** байт-в-байт. Состав:

| Раздел | Содержимое |
|---|---|
| `START-HERE-r189.txt` | корень — актуальная инструкция r189 (без устаревших root-файлов) |
| `bim-twin-r55/` | полный репозиторий r188 + исправленный `cloud-classify.py`, новый `cloud-classify-test.py`, `START-HERE-r189.txt`, `PHASE5-FINAL-r189.md`, `DPI-CRS-r189.md`, все отчёты r145–r189 (CLOSING-r182, COLOR-DENSE/OPEN-r183, VRAM-LOAD-r183, FUSION2-r183, STORAGE-PATHS-r184, COLOR-REPAIR/UI-REPAIR-r181, IMU-EXTRACT-r187, LIO-FEASIBILITY-r186, LIO-FULL-r188 и др.) |
| `deliverables/` | модель v5 (json 73 176 Б, IFC 180 651 Б, 0 ERROR), georef-z-r167.json, georef-IFC, план/изометрия, classify-self-test-r189.json, classify-max-points-200k.json, color-check-r189.json, paths-e2e-r184.json, quality-all-r189.json, validate-ifc, рендер/цвет/VRAM-метрики r172–r183 |
| `screenshots/` | 350+ (в т.ч. новые r189: серый/цветной открытый файл, classify self-test preview; r183 color ours-vs-lixel; ранее — render/UI/detail/bench) |
| `screenshots-docs/`, `docs` | инструкция DOCX/PDF и пример отчёта сверки |

Проверка `verify-package-r189.py`: START-HERE/отчёты/deliverables/screenshots на месте, отчёт в zip = репо,
`node_modules`/`.git`/`__pycache__`/логи исключены.

## 5. Ограничения (унаследованные, честно)

1. Абсолютная геопривязка X/Y — UNVERIFIED (RTK/контрольные точки не предоставлены); Z привязан:
   пол подвала 182,33 м (Балтийская 1977). `DPI-CRS-r189.md` анализирует сторонний LAS EPSG:32636 —
   потенциальная внешняя привязка, но не применена к нашему проекту.
2. Толщина стен на плотных сборках 72–84 мм (Lixel 64–74) — fusion/ICP-этап; агрессивные режимы ломают геометрию.
3. Полная загрузка 590M ~80–100 с (I/O); «Все точки» ~8,8 ГБ VRAM.
4. Денойз цвета на плотных облаках по умолчанию выключен (опция; полный скан ~23 мин).
5. LIO (IMU/SLAM) — исследование, в продукт не включён (данные/дрейф).
6. ICP требует Open3D; «Пары точек»/GCP работают на numpy.
7. BUG-2 (баннер цвета) — зафиксирован, не исправлен без согласования зоны цвета.
