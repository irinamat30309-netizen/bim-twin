# Повторная приёмка BIM TWIN — v9.9

## Область проверки

Проверен новый путь фонового расчёта точечных сечений и наклонного профиля, его отмена и DXF/CSV экспорт на тестовых `room.las` и `room.ply` (по 205 526 точек). Это целевая регрессия, не полный аудит всех кнопок приложения и не закрытие всех 15 этапов плана.

## Автоматические тесты

| Проверка | Результат |
|---|---:|
| `node --test` | 716 всего: 713 pass, 3 skip, 0 fail |
| Пропущенные тесты | 3 LAZ decode/decimation сценария: optional LAZ bundle/реальный LAZ decoder недоступен в среде |
| `node db/_test.js` | PASS: Phase D и persistence |
| Синтаксис JS/CJS/MJS | 224 файлов, 0 ошибок |
| Хранилище UI/Electron harness | JSON-store fallback; `better-sqlite3` отсутствует |

## UI E2E — LAS и PLY

Воспроизводимый runner: `QA-artifacts/v9.9/repro/section-worker-ui-v1232.js`.

На каждом fixture прошли восемь групп проверок:

1. Загружено настоящее fixture-облако и появились controls Worker.
2. Отмена активного расчёта по прогресс-событию уничтожает worker; чертёж не меняется.
3. Закрытие панели, `bim-project-changed` и `bim-cloud-change` отменяют активную задачу без частичной геометрии.
4. Искусственный дескриптор на 100 млн точек отклонён на pre-allocation memory guard; фактический массив такого размера не выделялся.
5. Повторное построение плана идемпотентно: новые контуры заменяют созданные ранее, а не удваивают их.
6. Ортогональные X/Y/Z-сечения строятся в Worker, доходят до 100% прогресса, имеют точки на требуемой плоскости и возвращают фактические counts.
7. Наклонный профиль 45° выдаёт закрытые DXF polylines и CSV станции/отметки; DXF повторно разобран внутренним parser.
8. После завершения worker закрыт, ошибок page/worker/IPC нет.

| Fixture | Y: points / contours | Z: points / contours | X: points / contours | Profile 45° | E2E events |
|---|---:|---:|---:|---|---:|
| LAS | 6 898 / 2 | 11 421 / 2 | 5 256 / 2 | 7 540 points; 2 DXF contours; 40 CSV vertex rows | 403 |
| PLY | 6 917 / 2 | 11 399 / 2 | 5 248 / 2 | 7 461 points; 2 DXF contours; 35 CSV vertex rows | 403 |

Во всех шести ортогональных сценариях измеренный `planeError` равен 0; сборка передаёт статус результата и прогресс фаз `slice`, `bounds`, `occupancy`, `trace-grid`, `trace-loops`, `complete` (профиль включает фазу `profile`). В конце обоих прогонов `workerCountAfterCompletion = 0`, runtime errors = 0.

Средний интервал между worker progress messages в этих двух локальных Chromium прогонах составлял примерно 32–38 мс; это наблюдение на малом fixture, не воспроизводимый производительный benchmark. Время Playwright locator action может включать ожидание видимости/стабильности и не используется как время вычисления.

## Артефакты

- LAS JSON: `QA-artifacts/v9.9/section-worker-ui-v1232-room.las.json`
- PLY JSON: `QA-artifacts/v9.9/section-worker-ui-v1232-room.ply.json`
- Скриншоты панели: `QA-artifacts/v9.9/section-worker-panel-room.las-v1232.png`, `...room.ply-v1232.png`
- DXF/CSV профильных экспортов: соседние файлы с `room.las-...` и `room.ply-...` в `QA-artifacts/v9.9/`

## Непроверено / следующий этап

- Нет 1M/10M/50M throughput или peak-RAM benchmark; типовая UI-копия ограничена 128 МиБ, сетка — 4 млн ячеек.
- Нет out-of-core/chunked parsing и обработки без полной копии координат.
- Не открывались результаты независимым AutoCAD/BricsCAD/QGIS/GIS reader; DXF R12 не переносит CRS как полноценное CAD coordinate metadata.
- Не проверялись Windows installer/ASAR, реальная SQLite backend, target hardware/GPU и внешние облака.
- Mesh-section остаётся отдельным синхронным путём; curved/unfolded/profile series, несколько видимых плоскостей и сохранённая геометрия сечения остаются будущей работой.
- Три LAZ-теста skipped; bundled LAZ decoder в этой среде недоступен.

Дорожная карта и статус этапов: `IMPLEMENTATION-PLAN.md`. Эта приёмка не означает, что все этапы завершены или что продукт достиг полного рыночного паритета.
