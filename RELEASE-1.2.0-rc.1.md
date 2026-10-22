# BIM Twin 1.2.0-rc.1 — отчёт автономной финализации

Дата: 2026-09-28  
Ветка: `agent/finalization`  
Кодовый baseline: `9a16553`

## Решение

`1.2.0-rc.1` — завершённый автономный release candidate для внутреннего тестирования. Все доступные в текущей Linux-среде кодовые, security, persistence, dependency и packaging gates выполнены без участия пользователя.

RC намеренно не назван финальным публичным production-релизом: clean-machine Windows/NSIS, code signing, RTX hardware QA, реальные пользовательские 100M+ наборы и независимая приёмка в AutoCAD/Civil 3D/Revit/GIS требуют внешних сред, оборудования, данных или лицензий.

## Что вошло

1. Объединены ветки measurement-document comparison и Stage 8 QA.
2. Добавлен централизованный `ToolManager`: один активный инструмент, `AbortController`, единая отмена/деактивация/очистка и защита от late async activation.
3. `.bimsync` переведён на потоковый binary-формат с SHA-256, лимитами, staging, транзакционной установкой и rollback; legacy JSON импортируется с жёсткой валидацией.
4. IPC-файлы защищены sender-scoped grants, canonical paths, containment и лимитами. Пути, внедрённые в backup/project JSON, не дают доступ к файлам вне `uploads`.
5. Загрузка и сохранение документов используют строгий base64, лимиты и атомарную запись.
6. PDAL принимает только подтверждённый `.json`, безопасные stage types и выбранные нативным диалогом input/output paths; скриптовые, сетевые и connection stages запрещены.
7. AI privacy: remote OpenAI/Ollama требуют явного согласия, контекст ограничен; API key не возвращается renderer и не сохраняется открытым текстом при недоступном `safeStorage`.
8. Scan2BIM sidecar использует ephemeral token, bind `127.0.0.1`, ограниченный CORS/body и полную очистку временных/частичных результатов.
9. Runtime security-модули и ToolManager проверяются в packaged ASAR.
10. Удалено неиспользуемое дерево `@univerjs/presets`; текущий встроенный spreadsheet fallback сохранён. SheetJS обновлён с уязвимого `0.18.5` до официального `0.20.3`.
11. CI получил обязательный production dependency audit; добавлены генератор/проверка release manifest и единая команда `npm run qa:final`.

## Итог QA

| Gate | Результат |
|---|---:|
| Node regression suite | 954 total / 951 passed / 0 failed / 3 skipped |
| JavaScript/MJS/CJS syntax | 268 файлов / 0 ошибок |
| Python syntax | 28 файлов / 0 ошибок |
| JSON/SQLite persistence | PASS |
| Production dependency audit | 0 vulnerabilities |
| Stage 9 synthetic, 1M | 1 loop; 10 000 м²; 400 м; 51.54 ms |
| Stage 9 synthetic, 10M | 1 loop; 10 000 м²; 400 м; 344.98 ms |
| Linux Electron package | PASS |
| Required ASAR runtime entries | PASS; 12 123 entries |
| CycloneDX SBOM | 507 components; spec 1.5 |

Время benchmark зависит от текущей машины и не является рыночным показателем. Он проверяет compact section kernel без UI, Worker startup и source I/O.

## Ожидаемые пропуски

1. OBJ/STL user-fixture acceptance — исходные пользовательские fixtures отсутствуют.
2. External large-PLY streaming acceptance — внешний large-PLY fixture отсутствует.
3. Self-hosted Windows GPU smoke — приватный Windows RTX runner недоступен.

Отдельный real-LAS Stage 9 benchmark не запускался: переменная `BIMTWIN_GPU_LAS_PATH` и пользовательский uncompressed LAS не предоставлены. Синтетический 1M/10M gate прошёл.

## Артефакты

| Файл | Размер | SHA-256 |
|---|---:|---|
| `dist/BIM Twin-1.2.0-rc.1.AppImage` | 237 791 452 bytes | `5dec6ed85e92be86df4060cc13afa731bcdd7d7267e622024380335393ba2d29` |
| `dist/linux-unpacked/resources/app.asar` | 391 783 656 bytes | `4e312fdc687dfef93700899d6ddd61dc85d92bc4d06e13fdabb8b4c592cdcc0d` |
| `dist/bim-twin-dependency-sbom.cdx.json` | 469 279 bytes | `ac9e2909ca3300e13925989aea072345780af3dc70bd77151f9172ac9b27a9ac` |
| `dist/npm-audit-production.json` | см. файл | `ef77d1f80bba4060428854520f3df578d4e83277ef7bbe20801e8c6baa4b8541` |

Полный список находится в `dist/SHA256SUMS`. Исходники проверяются через `MANIFEST.sha256`.

## Воспроизведение

```bash
npm ci --no-audit --no-fund
npm run audit:production
npm run manifest:verify
npm run qa:final
npm run dist -- --linux AppImage dir
npm run sbom:release
```

Windows:

```powershell
npm ci
npm run audit:production
npm run qa:final
npm run test:stage9-section
npm run dist:win
```

Для Windows Stage 9 требуется `BIMTWIN_GPU_LAS_PATH`. Для production-релиза также нужны code-signing certificate и clean-machine install/launch/uninstall acceptance.

## Открытые внешние gates

- Windows NSIS на текущем RC, подпись и SmartScreen.
- Чистая Windows VM: install, first launch, import, save/reopen, export, update/rollback, uninstall.
- RTX/WebGL hardware matrix и длительный VRAM/pressure stress.
- Реальные OBJ/STL/large PLY/LAS/E57/PTX datasets и 100M+ out-of-core сценарии.
- CRS/EPSG, vertical datum, GCP и геодезический accuracy oracle.
- Независимое открытие DXF/IFC/GeoTIFF/OBJ в целевых CAD/BIM/GIS.
- Юридический review компонентов, отмеченных SBOM как GPL/AGPL/dual-license: `@mlightcad/libredwg-web`, `superdoc`, `@dxfom/mtext`, `jszip`.

## Release policy

RC подходит для внутренней проверки и продолжения внешней приёмки. Публичное заявление «production-ready замена CAD/BIM/geodesy ПО» и коммерческое распространение до закрытия перечисленных gates не допускаются.