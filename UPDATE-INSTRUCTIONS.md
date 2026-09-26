# Обновление BIM Twin — этапы 5–7 и Windows CI

Это **overlay**, а не полный архив репозитория. Он подготовлен относительно опубликованной ветки `agent/stage3-4-ci-sync`. Ветка `agent/windows-package-qa` была сверена с ней: она содержит ту же базу плюс Windows workflow, поэтому overlay можно безопасно применить к этой ветке.

## Состав

- 26 файлов проекта обновляются поверх существующих.
- 6 новых файлов: общие PLY I/O, три regression-теста Stage 7 и отчёты изменений/QA.
- `.github/workflows/windows-package-qa.yml` обновляет Windows CI: `push` на `agent/windows-package-qa`, базовую ветку и `main`/`master`, а также `pull_request` к базовой ветке и `main`/`master`. CI запускает тесты и сборку NSIS на `windows-2022`, затем проверяет наличие новых PLY/geometry-модулей в `app.asar`. Артефакты хранятся 7 дней.
- Файлы, которые есть только в GitHub (52 файла), архив не удаляет и не заменяет. Один локальный `.txt` с искажённым именем исключён: это дубликат инструкций модели; оставьте существующий файл из репозитория.

Полный перечень и SHA-256 приведены в `MANIFEST.sha256`.

## Применить через GitHub Desktop

1. Откройте локальный клон `irinamat30309-netizen/bim-twin`, нажмите **Fetch origin**. Создайте/переключитесь на ветку `agent/windows-package-qa` (remote branch уже существует; если Desktop спросит, создайте локальную tracking-ветку). Не работайте прямо в `main`.
2. Сделайте commit или отдельную резервную копию текущих незакоммиченных изменений.
3. Распакуйте этот ZIP **в корень репозитория**, разрешив перезаписать совпадающие файлы. Не удаляйте остальные файлы репозитория. В частности, сохраните `.github` и все 52 удалённо-существующих файла.
4. В GitHub Desktop проверьте список Changes. Он должен показывать обновления файлов из архива, а не удаление посторонних файлов. Commit, например: `Stage 5-7 point-cloud QA and Windows packaging`; затем **Push origin**.
5. На ветке `agent/windows-package-qa` push запускает GitHub Actions **Windows package QA**. Откройте вкладку **Actions**, дождитесь завершения job и проверьте, что зелёные шаги включают полный `npm test`, `npm run dist:win` и проверку ASAR. При ошибке скачайте логи job; при успехе загрузите artifact `windows-package-qa` (инсталлятор/ASAR, хранение 7 дней).
6. Обновите существующий PR #2 этой веткой. Для попадания в `main` сначала требуется интегрировать базовый PR #1, затем PR #2; просмотрите diff и результаты CI перед merge.

Не вставляйте в чат PAT, runner registration token или секреты GitHub. После push пришлите ссылку на commit/Actions run — тогда можно проверить именно опубликованную версию.

## Что проверено локально перед упаковкой

Актуальный clean Linux/Node 24 retest на review-ветке: `npm test` — 883 total / 876 passed / 0 failed / 7 skipped; Stage 2/3/4/5–7 focused suites — 31/41/81/103 passed соответственно; `npm run check`, JS syntax (241 файлов), `node --check pointcloud-ply-io.js`, Python syntax (27 файлов) и `npm run test:store` — passed. Два synthetic fixture gaps закрыты генераторами LAS/PLY room и 600k-point PLY; оставшиеся skips перечислены в `QA-RETEST-stage0-7-current.md`.

**Важно:** это не доказывает, что архив уже прошёл Windows сборку. Workflow специально обновлён для запуска после вашего push. Ранее прошедший GitHub Actions run собирал предыдущее состояние исходников. GitHub-hosted `windows-2022` проверит Windows/Electron/ASAR, но не физический GPU/драйвер и не внешние CAD/GIS-приложения. Для аппаратной проверки нужен отдельный безопасно настроенный Windows runner; для публичного репозитория self-hosted runner напрямую не подключайте.
