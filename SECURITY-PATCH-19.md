# Patch 19 — производительность БД и защита (v0.9.39)

Продолжение patch 18. Правки затрагивают производительность SQLite-хранилища и
две точки безопасности. Формат данных и публичный API хранилища не менялись —
рендерер трогать не пришлось.

## 1. Устранение N+1 в `SqliteStore.getData()` (`db/sqliteStore.js`)

**Было:** для каждого помещения выполнялись отдельные запросы `elements`,
`documents`, `ai_findings`, а для каждого документа — ещё запрос
`document_versions`. На проекте из N помещений это ~ `1 + 3·N + D` запросов.

**Стало:** пакетная загрузка — по одному запросу на тип сущности
(`elements`, `documents`, `document_versions`, `ai_findings`) через
`WHERE ... IN (...)`, затем группировка в память по внешним ключам
(`Map` по `room_id` / `document_id` / `element_id`). Итог — фиксированные ~6
запросов независимо от размера проекта.

Выходная структура (`{ project, floors, rooms[], users, discussions }`,
вложенные `room.elements/documents/findings`, `document.versions` вида
`{v,date}`, `room.model`, распарсенные `findings.comments`, `review || 'open'`)
полностью сохранена.

## 2. Недостающие индексы (`db/schema.sql`)

Добавлены:
- `idx_docver_doc` на `document_versions(document_id)`
- `idx_floors_project` на `floors(project_id)`

Создаются через `CREATE INDEX IF NOT EXISTS` и, поскольку `schema.sql`
выполняется при каждом старте, применяются и к уже существующим базам.

## 3. Ограничение `bim:readPicked` (`main.js`)

**Было:** обработчик читал файл по любому абсолютному пути и возвращал его
содержимое в base64 — потенциальное чтение произвольных файлов (`.env`,
ключи, `*.db`) скомпрометированным рендерером.

**Стало:** белый список расширений `PICKED_EXT_ALLOW` (3D-модели, облака точек,
IFC и типовые документы). Файлы с другими расширениями отклоняются
(`{ ok:false, error:'ext_not_allowed' }`). Ограничение по размеру намеренно не
вводилось, чтобы не ломать загрузку крупных моделей/облаков.

## 4. LLM-ключ через Electron `safeStorage` (`main.js`)

**Было:** `llmApiKey` хранился в настройках в открытом виде
(SQLite `settings` / JSON).

**Стало:** прозрачное шифрование на уровне IPC:
- `bim:setSettings` → `encryptSettingsPatch()` шифрует ключ через
  `safeStorage.encryptString`, кладёт в `llmApiKeyEnc` (base64) и очищает
  открытый `llmApiKey`; очистка ключа удаляет и `llmApiKeyEnc`.
- `bim:getSettings` и внутренние вызовы (`analyzeRoom`, OCR) идут через
  `readSettings()` → `decryptSettings()`, который восстанавливает `llmApiKey`
  в памяти. На диск открытый ключ больше не пишется.
- Если `safeStorage` недоступен (нет keyring и т.п.) — мягкий откат к прежнему
  поведению, приложение продолжает работать.

Работает для обоих хранилищ (SQLite и JSON), т.к. шифрование выполняется в
слое main над `store`.

## Проверка

- `node --check main.js` — OK
- `node --check db/sqliteStore.js` — OK
- `schema.sql` — 6 индексов

Функциональный прогон `getData()` на живом движке в песборке невозможен
(`better-sqlite3` — нативный модуль, отсутствует), но логика группировки —
чистый JS и повторяет прежний формат вывода.
