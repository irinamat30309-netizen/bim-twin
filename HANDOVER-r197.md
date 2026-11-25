# HANDOVER — передача проекта в новый чат

Дата: 2026-11-25. Ветка: `agent/ui-redesign`, `main` — fast-forward на тот же коммит.
Репозиторий: https://github.com/irinamat30309-netizen/bim-twin (push разрешён заказчиком).
Текущее состояние: **всё запушено**, но у заказчика остаётся жалоба на «зернистость/пересвет/нечёткость» картинки в приложении — это последняя незакрытая задача (см. §5).

## 1. Что это за проект

`bim-twin` — Electron-приложение (offline) для BIM-обработки облаков точек:
- сборка облака из сырого сканера `.xbin` (Lixel L2 Pro), уточнение траектории, чистка, цвет по фото;
- viewer облаков (WebGL) с LOD/VRAM-бюджетом, инспектор/измерения, ИИ-ассистент;
- scan-to-BIM движок (Python) + IFC4-экспорт/импорт;
- инструменты: геопривязка (RTK/контрольные точки/CRS), классификация, mesh, клипинг, отчёты точности.

Корень репозитория: `C:\Users\bob\Documents\deepseek-harness\default-workspace\bim-twin`
(далее `<repo>`). Python-движок: `<repo>\tools\scan2bim-py\`. Тесты: `node --test` (корень), Python-наборы в `tools/scan2bim-py/*-test.py`.

## 2. Как запустить / собрать / проверить / задеплоить

```powershell
cd <repo>
npm install          # один раз
npm start            # запуск приложения
node --test          # полный JS-прогон (сейчас ~1938 тестов, ожидается 0 fail / 4 skip)
```
Python (используется встроенный рантайм DSH):
```powershell
$py="$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py tools\scan2bim-py\validate-ifc.py D:\BIM-TWIN-TEST\interior\py2-final-v5.ifc
& $py tools\scan2bim-py\cloud-register-test.py     # пример набора
```
GitHub (remote уже настроен, credentials закешированы):
```powershell
git push origin agent/ui-redesign
git push origin HEAD:main        # main fast-forward
```
Пакет для заказчика (zip ~ снимок репо без node_modules/.git):
```powershell
# сборка пакета: _pkg-r55 + robocopy, zip → C:\Users\bob\Downloads\bim-twin-r55-full.zip
# Desktop-копия: C:\Users\bob\Desktop\bim-twin-r55-gotovyi
```
Полные команды сборки пакета см. в конце последнего сообщения агента в чате или в `PHASE5-FINAL-r189.md`.

## 3. Ключевые файлы

| Что | Где |
|---|---|
| Главный процесс (IPC, сборка облака, мосты инструментов) | `main.js`, `preload.js` |
| Renderer: UI, загрузка облаков, инспектор | `renderer/app.js` |
| WebGL-вьюер (рендер точек, LOD, VRAM-бюджет) | `renderer/webgl-viewer.js` |
| Поточное чтение LAS/PLY/E57 большими частями | `cloud-segments.js`, `las-node.js`, `las-core.js` |
| Сборка из `.xbin` | `xbin-core.js`, `xbin-lidar.js`, `xbin-lidar-worker.js`, `xbin-refine*.js`, `xbin-fusion.js` |
| Чистка/цвет | `scan-refine-core.js`, `scan-refine-parallel.js`, `scan-refine-tile-worker.js`, `recolor-core.js`, `recolor-parallel.js`, `recolor-post.js`, `dynamic-clean-core.js` |
| scan-to-BIM Python | `tools/scan2bim-py/scan2bim-v2.py`, `ruler-v2.py`, `json-to-ifc.js`, `validate-ifc.py` |
| Инструменты Python | `cloud-register.py`, `cloud-classify.py`, `crs-tools.py`, `mesh-tools.py`, `quality-compare.py`, `georef-rtk.py`, `georef-control.py` |
| Дизайн | `DESIGN.md`, `renderer/tokens.css`, `renderer/design-r192.css` |
| Пакет/приёмка/отчёты | корень репо: `PHASE5-FINAL-r189.md`, `CLOSING-r182.md`, `RENDER-*-r19x.md`, `CLEAN-SPEED*-r19x.md`, `VRAM-FIX-r196.md` |

## 4. Данные (на диске заказчика)

- Сканы xbin: `D:\Skan\port\fasadamosova\2026-09-03-110319.xbin` (22 ГБ), `D:\Skan\port\ln_amosova_2026-09-03-114323.xbin` (11 ГБ).
- Собранные/тестовые облака: `D:\BIM-TWIN-TEST\proj-test\2026-09-03-110319-lidar.las` (637.3M), `D:\BIM-TWIN-TEST\r55\*` (кропы/эталоны), `D:\BIM-TWIN-TEST\v5...`.
- Внешний скан другого сканера (замкнутый маршрут, UTM36N): `D:\Skan\дфі\20260821105321013.las` (313.7M) — исследование в `DPI-SCAN-r189.md`.
- Модель/IFC: `D:\BIM-TWIN-TEST\interior\py2-final-v5.json/.ifc` (A 8/8, IFC 0 ERROR).
- Документация объекта: `D:\BIM-TWIN-TEST\docs` (42 PDF).
- Скриншоты этапов: `D:\BIM-TWIN-TEST\r55\*` (render/color/design/bench/...).

## 5. ГЛАВНАЯ ОТКРЫТАЯ ЗАДАЧА: качество картинки у заказчика

Жалоба: «облако ярче/зернисто/не чётко» по сравнению с прежними версиями и Lixel Studio. Уже найдено и исправлено (коммиты r195–r196):
- пересвет/мягкие сплаты: default — hard-точки 2.8 px, brightness 1.0, миграция `rev195` сбрасывает старые пресеты;
- VRAM-бюджет считался по 16 Б/точку → 530M > 12 ГБ → context lost: теперь 24 Б/точку + резерв, для 12 ГБ = 372M (8.3 ГБ), авто-recovery.

Осталось (задача r197, выполняется агентом `ba258694-59dd-4fb5-a700-739d633be0fc`):
1. **Perspective size attenuation** (точка растёт при приближении, clamp 1.5–6 px) — при близком зуме поверхность сейчас «дырчатая» (крошка);
2. проверить, не «шумит» ли цвет от 16-бит LAS (colDiv/normalize);
3. режимы «Плотность: Точно/Сбалансировано/Быстро»;
4. E2E на 637M цветном облаке (крупный план фасада), скриншоты до/после в `D:\BIM-TWIN-TEST\r55\render-r197\`.
Если не поможет — вариант «откат»: известные хорошие рендер-дефолты до мягких сплатов — коммиты до r172 (`git log --oneline | grep -i "r172\|r177"`), файл `renderer/webgl-viewer.js`; сравнить скриншоты на одном облаке/ракурсе.

## 6. Что уже сделано и НЕ надо переделывать

- Модель v5 **A 8/8**, IFC 0 ERROR; сверка с документацией.
- Скорость «из .xbin»: build ~22 мин, цвет ~21 мин (5.3×), чистовая ~14–19 мин (после r193/r194; причина 80 мин — пул потоков схлопывался в 1 при малой памяти, исправлено).
- Colour: покрытие 95–99 %, std RGB ~7–8 (лучше Lixel 8.69), re-color автооткрывается.
- Рендер: FPS 95–170, первый кадр 3–4 с, старт 1.2 с, LOD 300M.
- UI: по умолчанию только рабочая область (панели r145 скрыты, «false» исправлен), дизайн по anti-slop (`DESIGN.md`), AA-контраст 28/28.
- Пути: все результаты инструментов — только в папку проекта (`<Проект>/output|temp`), AppData не засоряется.
- Геопривязка: Z — 182.33 м Балтийская (georef-z-r167); X/Y — UNVERIFIED (нужны 3 контрольные точки/RTK); попытки по OSM/dfi-скану — отрицательные, честно в отчётах `GEOREF-*.md`.
- Толщина стен: безопасный предел 72–75 мм (Lixel 64–74); LIO/loop closure исследован (`LIO-FULL-r188.md`, `DPI-SCAN-r189.md`).

## 7. Правила работы в этом проекте

- Не пушить без явной просьбы? **Заказчик разрешил push** (r196: «загружай все в гитхаб») — remote настроен.
- Любые правки движка — с тестами (`node --test` 0 fail; Python-наборы) и откатом при ухудшении метрик.
- Отчёты — с честными числами и SKIP/UNVERIFIED, без фиктивных координат.
- Палитра: graphite + один violet-акцент (`DESIGN.md`), без синего/градиентов/glow.
- Кириллица в PowerShell: патчи писать через файлы (write/edit), не через `python -c`/`node -e` в shell.

## 8. Обновление r197 (последнее на момент передачи)

- Эталон качества заказчика: D:\Skan\До\После\ — 7 PNG («Общее», «Двор», «еще двор», «Окна», «Балки», «Провода», «Мелкие обекты») — к этой плотности/чистоте/детализации стремимся.
- Рендер r197: **pointSize 1.0** по умолчанию, **аттенюация включена** (floor 2.2 px, cap 4.0 / 4.5 / 3.0 px для Сбалансировано/Точно/Быстро), autoBase 2.3 px, клэмп 1.5–4 px; плотность: select «Плотность» (Сбалансировано ≈238M / Точно ≈382M / Быстро ≈181M), default Сбалансировано.
- E2E 637M крупным планом: FPS 67 (было 44), спекл −9 %, яркость −8 %, клиппинг ~0.0012, context lost нет.
- Ограничение: остаточный хроматический шум colorized LAS (соседние точки различаются по цвету — свойство перекраса, не битовый баг). Следующий шаг при жалобах: опциональный цветовой сглаживающий фильтр на экране или повторный recolor с текущим денойзом.
- Тесты: node --test 1942 / 1938 pass / 0 fail / 4 skip.

## 9. GitHub (деплой)

Remote: https://github.com/irinamat30309-netizen/bim-twin (настроен, push работает).
Пуш: git push origin agent/ui-redesign и git push origin HEAD:main (main fast-forward).
Последний запушенный коммит на момент передачи — см. git log --oneline -1.
