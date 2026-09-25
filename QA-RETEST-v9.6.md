# QA retest v9.6 — сечения, точки и профили

## Среда

- Linux sandbox, Node.js 24, headless Chromium + SwiftShader, Playwright.
- Electron IPC заменён тестовым adapter из `QA-artifacts/v9.6/repro/fake/electron/`.
- SQLite native binding `better-sqlite3` в среде отсутствует; используется JSON-store fallback.
- Фикстуры `room.las` и `room.ply` — синтетическая комната, по 205 526 точек; WKT/CRS отсутствует.
- E2E runner читает raw LAS/PLY записи напрямую при проверке выгрузки, чтобы сверить point indices, XYZ и RGB, не используя экспортный CSV как собственный oracle.

## Проверки и результат

| Проверка | Результат | Что подтверждено |
|---|---:|---|
| `node --test` | 699: 696 pass / 3 skip / 0 fail | Unit/regression-пакет приложения |
| Syntax check | 213 файлов / 0 ошибок | JS/MJS/CJS приложения, тестов и E2E |
| Section workflows · LAS | 15/15 named checks | X/Y/Z-контуры, точное положение вершин на плоскости, повтор без дубликатов, CSV+JSON, profile DXF+CSV |
| Section workflows · PLY | 15/15 named checks | Те же UI-сценарии и проверки в локальной системе PLY |
| Всего новых addressable E2E | 30 named check groups | Ноль page errors, IPC errors и missing handlers; дополнительно валидируются строки CSV и sample records |

Выбранные фактические точки по осям:

| Фикстура | Y | Z | X | Профиль 45° |
|---|---:|---:|---:|---|
| `room.las` | 6 898 | 11 421 | 5 256 | 7 540 точек, 2 контура, 40 DXF/CSV вершин |
| `room.ply` | 6 917 | 11 399 | 5 248 | 7 461 точка, 2 контура, 35 DXF/CSV вершин |

Для каждого axis-aligned экспорта E2E проверил число строк против отдельной фильтрации позиций, порядок и уникальность point index, три sample XYZ/RGB против исходной записи файла, `coordinate_frame`, параметры сечения и JSON schema. Координатная разница не превышала 1e-6 м. Для всех осей в этой фикстуре построено по два замкнутых контура, с максимальной ошибкой расположения вершин на заданной плоскости 0 м.

Profile-test проверяет station/elevation DXF в плоскости Z=0, 45° азимут, два замкнутых контура и соответствие числа CSV rows числу векторных вершин. Пустой диапазон и нулевая толщина не создают файлы и возвращают объяснение.

## Повторный запуск

Из корня проекта:

```sh
node --test
node QA-artifacts/v9.6/repro/section-workflows-e2e-v1228.js QA-artifacts/v9.6/repro/fixtures/room.las
node QA-artifacts/v9.6/repro/section-workflows-e2e-v1228.js QA-artifacts/v9.6/repro/fixtures/room.ply
```

Тестовый UI runner проверяет обычный application renderer в Chromium, но использует fake Electron; на другой системе пути к Chromium/Playwright могут потребовать настройки. См. `QA-artifacts/v9.6/repro/README.md`.

## Ограничения приёмки

- Это ограниченный acceptance slice, не проверка каждой кнопки проекта и не завершение этапов 1–14.
- Нет Windows installer/ASAR, SQLite/native bindings, GPU-производительности на целевой машине, 10M+ point benchmark и проверки памяти.
- Не проверялись внешние AutoCAD/BricsCAD/QGIS/Bonsai или независимый LAS/PLY vendor application; raw fixtures проверены локальным reader, встроенным в runner.
- В тестовой базе нет CRS WKT, intensity/classification, реального survey ground truth или пользовательского MEP/terrain проекта.
- CSV+JSON export сохраняет доступные renderer position/color, а не недоступные в буфере атрибуты.