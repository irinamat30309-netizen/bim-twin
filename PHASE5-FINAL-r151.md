# PHASE5-FINAL-r151 — финальный прогон и пакет r151 (фактический HEAD при финише — r153)

Дата: 2026-11-16, 21:00 (Europe/Kiev). База: `bim-twin`, ветка `agent/ui-redesign`.
Во время прогона HEAD последовательно сдвигался: `890fa47` (r151) → `a8527c9` (r152) → **`3ed4279` (r153, финал)**;
изменения r151/r152/r153 (lazy startup + P2 профили/сечения, fusion, P1-интеграция в UI, классификация)
к моменту замеров уже присутствовали в дереве. Итоговые цифры сняты на дереве, соответствующем r153.
Окружение: Windows, Node v24.20.0, Python 3.12.14 (DSH), Electron 31, NVIDIA RTX 5070 12 ГБ.

## 0. Итог одной строкой

`node --test` на финальном дереве — **1772 теста / 1768 pass / 0 fail / 4 skip**; Python-наборы —
cloud-register 17/17, georef-rtk 28/28, georef-control 18/18, edit-model 35/35, docs 21/21+19/19,
facade 20/20; quality-compare на интерьере/фасаде выполнен; A1–A8 на v5 — 8/8; IFC — 0 ERROR;
бенчмарк: первый кадр interior **13,6 с**, map.las **14,0 с** (было 29,7/80,0 в r145);
финальный пакет — **`bim-twin-r55-full.zip` ≈127,5 МБ + дополнения, 1030+ файлов**, положен в Downloads и на Desktop.

## 1. Бенчмарк приложения (Electron+CDP, `tools/scan2bim-py/bench-app-r145.js`)

Скрипт r150: фиксирует прогрессивный первый кадр (`lx-cloud-loaded progressive`), ждёт финального
события для полной загрузки, после загрузки — «успокоение» и 10 с вращения. Логи/JSON/скриншоты:
`D:\BIM-TWIN-TEST\r55\bench-r151\`. HUD: `Lixel_map.las-hud.png`, `_interior-r132-hud.png`.

| Метрика | Lixel map.las | Наш interior-r132 |
|---|---|---|
| Размер файла | 9,23 ГБ | 1,31 ГБ |
| Точек в файле (LAS-заголовок) | 271 540 842 | 38 390 183 |
| Загружено приложением | 119 999 872 (бюджет GPU) | **38 390 183** (все) |
| **Старт приложения** | 6,64 с* | **0,81 с*** |
| Рабочая область | 13,07 с | 12,72 с |
| Начало загрузки облака | 13,35 с | 12,98 с |
| **Первый кадр облака** | **13,96 с** | **13,58 с** |
| **Полная загрузка** | **59,99 с** | **19,79 с** |
| Успокоение | 11,11 с | 4,60 с |
| FPS, вращение 10 с | 4,9** | **53,8** |
| FPS min / p95 кадра | 1,1 / 888,1 мс | 27,9 / 24,1 мс |
| Event-loop max | 6034 мс | 429 мс |
| RSS Electron пик / конец | 5 992 / 5 484 МБ | 3 018 / 2 596 МБ |
| VRAM пик / конец | 9 006 / 8 921 МБ | 7 529 / 7 481 МБ |
| Статус | PASS | PASS |

\* Прямой CDP-замер spawn → стартовая страница после фикса clearCache (STARTUP-SECTIONS-r151):
6,31 с → **0,70 с**; в bench-сэмплере 0,8–7,2 с (вариативность CDP/системы), поэтому «до/после»: 6,3–6,8 → 0,7–0,8 с.
\*\* FPS на map.las низкий из-за рендера 120 млн точек + общего GPU (запущены другие приложения/агенты);
в изолированных прогонах r149/r150 — 5–15 FPS; нашем interior — 53,8 FPS (при свободном GPU до 97,7 в r148/r149).
Сравнение «до/после» первого кадра: interior 29,7 → **13,6 с** (−54 %), map.las 80,0 → **14,0 с** (−82 %).
Полная загрузка map ограничена I/O общего ПК (60–96 с в разных прогонах).

## 2. Регрессия

### 2.1. node --test
| Дерево | tests | pass | fail | skipped | Время |
|---|---|---|---|---|---|
| r150 (71573d4), до r151-правок | 1755 | 1751 | 0 | 4 | 69,5 с |
| r151+r152+r153 (3ed4279), финал | **1772** | **1768** | **0** | 4 | финальный прогон (см. лог `node-test-r153.log`) |

В процессе (пока агенты писали файлы) были промежуточные падения на in-flight состоянии — к финалу 0 fail.

### 2.2. Python-наборы (все PASS)
| Набор | Результат |
|---|---|
| cloud-register-test.py | PASS 17 / FAIL 0 (ICP/пары/GCP; синтетика + реальные кропы) |
| georef-rtk-test.py | PASS 28 / FAIL 0 |
| georef-control-test.py | PASS 18 / FAIL 0 |
| edit-model-test.py | PASS 35 / FAIL 0 |
| docs-extract-test.py / docs-compare-test.py | PASS 21 / 19, FAIL 0 |
| facade-test.py | кейсы 3/3, проверки 20/20 |

Логи: `D:\BIM-TWIN-TEST\r55\bench-r151\regression\*.log`.

### 2.3. quality-compare: интерьер и фасад (инструмент `quality-compare.py`)
Пары: интерьер — `r149-interior-jsfused2.las` vs `lixel-20x20.las`; фасад — `r149-facade-jsfused.las`
vs `r145-facade-lixel-box.las`. JSON: `regression\qc-interior-r151.json`, `qc-facade-r151.json`.

| Вердикт | Интерьер | Фасад |
|---|---|---|
| blur | FAIL: толщина стен MAD 81,4 vs 64,1 мм (+27 %); плотность 125 863 vs 208 368 т/м² (−39,6 %) | FAIL: толщина 81,8 vs 73,8 мм (+10,8 %); плотность **167 370 vs 68 757 (+143,4 %)** — PASS по плотности |
| floor_artifacts | FAIL: z-смазы 1,883 % vs 1,43 % | FAIL: z-смазы 5,147 % vs 5,895 % (лучше Lixel, но >1 %) |
| people_residues | PASS: 0,0 % / 0,0 % | — (нет людей в кадре) |
| color_coverage | FAIL: 0 % цветных vs 85,09 % (наш LAS серый — ограничение сборки) | FAIL: 64,98 % vs 74,69 % |
| Резкость/MTF (геом.) | PASS (+72,9 % градиент) | PASS (+157,9 % градиент) |

Причина цветовых FAIL — наши LAS r149–r151 записаны в градациях серого (RGB-заглушка);
цвет проверялся отдельно на рендерах r147 (яркость +2,4 %, насыщенность +8,1 % в ±10 %).
Fusion-прототип (r152): стены 57,2 мм PASS, артефакты пола 1,42 % PASS, люди 0 — на своей паре/рамке.

### 2.4. A1–A8 (модель v5) и IFC
`run-quality-all.py` на `py2-final-v5.json`: **A1–A8 8/8 PASS** (высота 2 мм; покрытие 94/62 %;
толщина 3/16/30 мм; периметр 99,8 %; площадь 95,6 %; A6 0/0; проёмы 100/100 %; ширина 0 мм);
итого PASS 45 / FAIL 6 (историч. r107), REG 0.
`validate-ifc.py py2-final-v5.ifc`: IFC4, 3336 instances, **0 ERROR/0 WARNING/0 INFO**, арность OK;
100 стен, 4 двери, 1 окно, 5 проёмов, 2 плиты, 9 помещений; PSet_BimTwin 111/522/111.

## 3. Пакет

Пакет `_pkg-r55` приведён к финальному HEAD **3ed4279 (r153)** (robocopy без node_modules/__pycache__/логов)
и упакован: **`C:\Users\bob\Downloads\bim-twin-r55-full.zip` ≈ 127,7 МиБ (133,89 МБ), 1052 записи** (точные size/entries — в `package-r151-summary.json`)
(+ копия на Desktop байт-в-байт). Состав: 193 скриншота, 21 файл deliverables, полный репозиторий r153
с отчётами r145–r153 и `START-HERE-r153.txt` в корне и в `bim-twin-r55/`. Проверка `verify-package-r151.py`:
все ключевые файлы (START-HERE, PHASE5-FINAL-r151.md, p1-bridge.js, sections-p2.js, bencH/IFC/JSON) на месте,
отчёт в zip = репозиторий; `node_modules`/`__pycache__`/логов/`.git` в архиве нет (0).

| Раздел | Содержимое |
|---|---|
| `START-HERE-r153.txt` | корень + `bim-twin-r55/` (финальная инструкция релиза r153) |
| `bim-twin-r55/` | полный исходный код r153, тесты (1772), отчёты r145–r153: P1-INTEGRATION, STARTUP-SECTIONS, PERF-RENDER, CLOUD-REGISTER, CLOUD-CLASSIFY, XBIN-QUALITY, QUALITY-COMPARE, COLOR-QUALITY, BUTTONS-AUDIT, UI-LIXEL-DESIGN, IFC, PHASE1–PHASE5 и др. |
| `deliverables/` | `py2-final-v5.json` (73 176 Б), `py2-final-v5.ifc` (180 651 Б, 0 ERROR, PSet/UTF-8), `py2-final-v5-georef-r134.ifc` (181 271 Б), `py2-final-v5-plan.png`, `py2-final-v5-iso.png`, HUD-скриншоты бенчмарка, `bench-r145.json`/`bench-r151.json`, JSON P1 (accuracy/classify/diff/register/pairs), `qc-interior-r151.json`/`qc-facade-r151.json` |
| `screenshots/` | 179+ файлов: UI-редизайн, панели P1 (7), профили/сечения (3), бенчмарк HUD (r149d/r151c/r151), рендеры, фасады, heatmaps |
| `screenshots-docs/` | инструкция DOCX/PDF и скриншоты интерфейса |
| `docs` | пример отчёта сравнения с документацией |

## 4. Расхождения и ограничения (честно)

1. **Нумерация ревизии**: задача называлась r151, фактический финальный коммит — **r153** (`3ed4279`);
   изменения r151/r152 (lazy startup+P2, fusion, P1-UI) вошли в релиз, поэтому отчёт и пакет
   ориентированы на r153, а имя файла отчёта сохранено как r151 (как просил Lead).
2. **FPS на map.las** в общем ПК 4,9–15 FPS (рендер 120 млн точек + Lixel Studio/агенты на том же GPU;
   VRAM 9,0–11,5 ГБ из 12,2) — для честной цифры нужен изолированный прогон на ПК заказчика.
3. **Цвета в LAS r149–r151 нет** (серые сборки) — метрики color_coverage в quality-compare честно FAIL;
   цвет подтверждён отдельно на рендерах r147 (паритет ±10 %).
4. **Fusion — прототип** (Python/JS opt-in): по своей паре стен 57,2 мм/пол 1,42 % PASS, но в общем
   quality-compare на других парах blur/floor_artifacts местами FAIL — не выдаётся за полный PASS.
5. **ICP требует Open3D** (в поставке Python-движка нет; пары точек/GCP работают на numpy).
6. **Старт ≤10 с суммарно не достигнут**: clearCache-фикс дал 0,7 с прямого старта, но загрузка
   startup.html/переход в рабочую область ~6 с — следующий шаг (ленивые модули index.html).
7. Абсолютная геопривязка — UNVERIFIED по решению заказчика (RTK пропущен); инструменты готовы.
8. Пакет собран из чистого HEAD r153; `PHASE5-FINAL-r151.md` (этот отчёт) добавлен в `bim-twin-r55/`
   после упаковки и включён в финальный zip.

## 5. Артефакты

- Бенчмарк: `D:\BIM-TWIN-TEST\r55\bench-r151\` (`bench-r145.json`, HUD png, `bench-final-r151.log`);
  сравнение «до»: `bench-before-r150.log`; r151c (другой агент): `bench-r151c\`.
- Регрессия: `D:\BIM-TWIN-TEST\r55\bench-r151\regression\` (node/python/quality/IFC логи, qc JSON).
- Пакет: `Downloads\bim-twin-r55-full.zip` и `Desktop\bim-twin-r55-full.zip`; сборочные скрипты —
  `_scratch\build-package-r145.ps1` (адаптирован), `_scratch\build-final-zip-r151.py`,
  `_scratch\verify-package-r151.py`.
