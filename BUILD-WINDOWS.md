# Сборка Windows-пакета BIM Twin

## Что содержит этот архив

Это исходники release candidate `1.2.0-rc.3` — переработанный интерфейс (`RELEASE-1.2.0-rc.3.md`, `UI-DESIGN.md`). В Linux-среде проверяются AppImage/ASAR и production dependency audit. Предыдущий кандидат `1.2.0-rc.2`: GitHub-hosted Windows workflow для коммита `341a8f1` прошёл полный regression suite, собрал NSIS installer и ASAR, сгенерировал SBOM и проверил обязательные ASAR entries. Для `1.2.0-rc.3` установщик собирается тем же workflow (`windows-package-qa`, артефакт с `.exe`, `app.asar` и SBOM), список обязательных ASAR-файлов расширен файлами нового интерфейса (`renderer/ui/*`, `renderer/startup.*`). Установка на чистой Windows-машине, подпись и SmartScreen остаются внешними gates. Подробности, локальные хеши и ограничения: `RELEASE-1.2.0-rc.3.md` и `RELEASE-1.2.0-rc.2.md`.

## Требования

- Windows 10/11 x64.
- Node.js 24 x64; npm поставляется вместе с Node.js.
- Интернет для установки npm-зависимостей и загрузки Electron.
- Если `better-sqlite3` не получает готовый бинарный пакет, потребуется Visual Studio C++ Build Tools. Это optional-зависимость; приложение предусматривает JSON-хранилище как fallback.

## Команды

Откройте PowerShell в распакованном каталоге проекта:

```powershell
npm ci
npm run audit:production
npm run check
node scripts/check-syntax.mjs
npm run qa:final
npm run dist:win
```

`npm run dist:win` запускает electron-builder с настроенной целью Windows NSIS. `npmRebuild` включён в конфигурацию electron-builder; если упаковка отдельно сообщает о несовместимом native ABI, выполните:

```powershell
npm run rebuild
npm run dist:win
```

Установщик появится в каталоге `dist\`; его точное имя формируется из настроек electron-builder и версии приложения. Подпись сертификатом в `package.json` не настроена, поэтому сборка не является подписанным коммерческим релизом и Windows SmartScreen может показывать предупреждение.

## Границы проверки

- Обычный CI запускает тесты на `windows-latest` с `npm ci --ignore-scripts --omit=optional`; отдельный `windows-package-qa` workflow устанавливает optional dependencies, запускает QA, собирает NSIS и проверяет обязательные ASAR entries.
- Перед выпуском проверьте installer на чистой Windows VM: установить, открыть проект, импортировать небольшой синтетический LAS/PLY, сохранить/повторно открыть проект, экспортировать результат и удалить приложение.
- Не используйте пользовательские модели для smoke-теста без их явного выбора; не включайте личные облака/документы в дистрибутив.
- Пределы точек и требования GPU определяются конкретной машиной; этот архив не заявляет гарантированную производительность на RTX или на 100 млн/100 GB данных.
