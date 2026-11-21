# STORAGE-PATHS-r184 — результаты инструментов только в папке проекта (моя часть: P1/P2/P3-мосты)

Статус: **исправлено и проверено**. Все выходные файлы инструментов, которые пишут мои мосты
(`p1-bridge.js` — Совмещение облаков/Классификация/Отчёт о точности/Экспорт; `p23-bridge.js` — CRS/GCP,
Mesh-операции, фрагмент Clipping Box), теперь сохраняются **только в папку проекта**:

```
<Project>/output/<операция>-<timestamp>/   — результаты (LAS/PLY/PNG/JSON/PDF)
<Project>/temp/<операция>-<timestamp>-xxxx/ — временные этой операции, удаляются после завершения
```

Если у проекта нет выбранной папки — инструменты спрашивают папку у пользователя (диалог) и привязывают её
к проекту; при отмене — понятная ошибка, **ничего не сохраняется**. В `%APPDATA%\bim-twin` (userData) инструменты
больше не пишут. Старые папки `p1-r151` и `p2p3-r155` не удаляются молча: панель показывает их размер и
предлагает «Удалить» с подтверждением (без confirm удаления нет). Не коммитил.

## 1. Найденные утечки (реальные пути на этой машине)

`C:\Users\bob\AppData\Roaming\bim-twin` — папка приложения, а не проекта:

| Что | Путь | Размер |
|---|---|---|
| Классификация | `p1-r151\classify-20261116-204208-6ajl\classified.las` | 8,43 МБ |
| | `…\classified_clean.ply` | 5,1 МБ |
| | `…\classify-preview.png`, `classify.json` | 0,26 МБ |
| Пакетный экспорт | `p1-r151\export-20261116-204248\batch-20261116-2042.ply` | 5,1 МБ |
| Совмещение | `p1-r151\register-20261116-204207-3ggg\src-registered.las` | 8,43 МБ |
| | `…\register.json` | 3 КБ |
| Отчёт о точности | `p1-r151\accuracy-*\quality.json`, `diff.json`, `diff-heatmap.png`, `heatmaps\*.png` | 0,3 МБ/папка |
| Clipping Box | `p2p3-r155\clip-20261116-233632-ojgb\clip-fragment.ply` | 0,46 МБ |
| Всего старых | `p1-r151` + `p2p3-r155` | **307,8 МБ, 172 файла** |

Причина: в обоих мостах `outRoot()` по умолчанию был `app.getPath('userData')` + `p1-r151`/`p2p3-r155`,
а `jobDir()` создавал там папки операции.

## 2. Что исправлено

### `tool-storage.js` (новый, общий для P1 и P2/P3)
- `resolveProjectRoot(deps, event)`: папка проекта (`projectFolder()` с `own=true`) → иначе диалог
  `chooseProjectFolder(event)` → иначе ошибка `no_project`/`canceled`. **Никакого userData/AppData.**
- `makeJob(projectDir, tool)`: `<Project>/output/<tool>-<YYYYMMDD-HHMMSS>/` + `<Project>/temp/<tool>-…-xxxx>/`;
  имена файлов санитизируются (нельзя выйти из папки); `finalize()` удаляет temp и пустой `<Project>/temp`.
- `describe()` для UI/статуса: выбран ли проект, `projectRoot`, `outputRoot`, `tempRoot`, размеры старых
  папок в userData, подсказка.
- `legacyInfo/legacySummary`: размер/файлы `p1-r151` и `p2p3-r155` без удаления.
- `cleanLegacy(userData, {confirm:true, names?})`: удаляет **только** каталоги с точными именами
  `p1-r151`/`p2p3-r155` и только внутри `userData` (после `path.resolve`), требует `confirm:true`;
  при `confirm:false` возвращает ошибку и ничего не трогает.

### `p1-bridge.js` (Совмещение, Классификация, Отчёт о точности, Экспорт)
- `outRoot()/jobDir()` удалены; каждый обработчик получает job через `toolStorage.beginJob(...)` и в `finally`
  вызывает `job.finalize()` (temp очищается даже при ошибке Python).
- `register` → `output/register-*/src-registered.las` + `register.json`;
  `classify` → `output/classify-*/classified.las|bin`, `classify.json`, `classify-preview.png`;
  `accuracy` → `output/accuracy-*/quality.json`, `diff.json`, `diff-heatmap.png`, `heatmaps/`;
  `export` → `output/export-*/<name>.<ext>`.
- `bim:p1Status` теперь отдаёт `storage` (где будут результаты, старые папки) и `root=outputRoot`.
- Новый IPC `bim:p1Storage`:
  - `info` — пути/выбранность/размеры старых папок;
  - `choose` — диалог выбора папки проекта + привязка к активному проекту;
  - `cleanLegacy` — безопасная очистка только с `confirm:true`;
  - `assignProjectDir` — **только при `BIM_TWIN_E2E=1`** для автотестов (нативный диалог не автоматизируется);
  - `snapshot` — список старых папок (для проверок).

### `p23-bridge.js` (CRS/GCP, Mesh, Clipping Box)
- То же: `beginJob`/`finalize`; `crs` → `output/crs-*/crs-*.json`, `reprojected.las`/`georef-header.las`;
  `mesh` → `output/mesh-*/mesh-*.ply|obj|stl` + JSON; `clip` → `output/clip-*/clip-fragment.ply|pcd|xyz`.
- `bim:p23Status` отдаёт `storage`; новый `bim:p23Storage` (`info`/`choose`/`cleanLegacy`).

### main / preload / UI
- `main.js`: в оба `register({…})` переданы `projectFolder` (папка проекта из настроек; поддержан
  `BIM_PROJECT_DIR` для headless/автотестов), `chooseProjectFolder` (диалог + `assignProjectDir` к проекту),
  `userData` и тестовый `setProjectDirForTests` (только `BIM_TWIN_E2E=1`). Убраны прежние
  `outputRoot: () => projectTempDir()` — мосты больше не пишут в «temp проекта по умолчанию» и не создают
  файлов вне папки проекта.
- `preload.js`: `p1Storage(payload)`, `p23Storage(payload)`.
- `renderer/ui/p1-tools.js`: нижний баннер «Результаты: <папка проекта> → output/» с кнопкой «Папка…»;
  если папка не выбрана — «Выбрать папку»; если в AppData есть старые результаты — предупреждение
  «Старые результаты в AppData: 307,8 МБ [Удалить]» (удаление только после подтверждения, только две старые
  папки). API: `__lxP1.storage/chooseStorage/cleanLegacyStorage`.
- `renderer/ui/p23-tools.js`: в статусе панелей — «Результаты: <проект>/output» либо «Папка проекта не выбрана
  (спросим перед сохранением)».

### Поведение по операциям
| Операция | Куда пишет теперь |
|---|---|
| Классификация | `<Project>/output/classify-*/classified.las`, `classified_clean.ply`, `classify.json`, `classify-preview.png` |
| Совмещение (ICP/пары/GCP) | `<Project>/output/register-*/src-registered.las`, `register.json` |
| Отчёт о точности | `<Project>/output/accuracy-*/quality.json`, `diff.json`, `diff-heatmap.png`, `heatmaps/*` |
| Экспорт/пакетный экспорт | `<Project>/output/export-*/<имя>.ply|las` |
| CRS/GCP | `<Project>/output/crs-*/crs-*.json`, `reprojected.las`, `georef-header.las` |
| Mesh | `<Project>/output/mesh-*/mesh-*.ply|obj|stl` + JSON |
| Clipping Box | `<Project>/output/clip-*/clip-fragment.ply|pcd|xyz` |
| Временные | `<Project>/temp/…` → удаляются после операции (`finally`) |

## 3. Тесты
- `test/r184-storage-paths.test.js` — **8/8**: раскладка output/temp + очистка; выбор папки/отмена/ошибка без
  проекта; безопасная очистка старых папок (без confirm — нельзя, с confirm — только p1-r151/p2p3-r155, чужие
  файлы целы); p1 classify без проекта → `needProjectFolder` и ноль файлов в userData; с проектом → папка в
  `<project>/output`, temp удалён; p23 clip-фрагмент в проект, без проекта — ошибка; `p1Storage` info/clean/assign
  (assign запрещён вне `BIM_TWIN_E2E=1`); статическая проверка main/preload/UI (нет `app.getPath('userData')`
  в путях записи мостов, есть баннер и очистка); jsdom-проверка баннера и клика «Удалить» (confirm:true).
- Регрессии мостов/UI: r149/r151/r155/r159 + r184 — **37/37 pass**.
- Полный `node --test`: **1909 тестов / 1904 pass / 1 fail / 4 skipped** (~245 с). Единственное падение —
  внешний `test/r183-color-dense.test.js` («шум на плотной кирпичной поверхности…»), зона другой задачи:
  в рабочем дереве параллельно изменены `recolor-post.js`, `cloud-segments.js`, `las-core.js` и др.
  (не мои файлы); тест падает и при отдельном запуске, к r184-путям отношения не имеет. Все тесты r184,
  мостов P1/P2/P3 и UI в общем прогоне зелёные.

## 4. E2E (реальный Electron, диск D)

Проект сохранён в **`D:\BIM-TWIN-TEST\proj-test`** (папка проекта привязана через тестовый хук
`p1Storage({action:'assignProjectDir'})`, т.к. нативный диалог в автотесте не автоматизируется;
в обычном приложении это делает диалог «Папка…»). Артефакты: `D:\BIM-TWIN-TEST\r55\paths-r184\`
(`e2e-result.json`, `appdata-before.txt`, `appdata-after.txt`, `project-files-after.txt`, `shots\`).
**36/36 проверок PASS, ошибок консоли 0.**

| Проверка | Результат |
|---|---|
| Папка проекта | `D:\BIM-TWIN-TEST\proj-test`, `outputRoot=…\output`, `tempRoot=…\temp` |
| Баннер UI | «Результаты: proj-test → output/», «Старые результаты в AppData: 307,8 МБ [Удалить]» |
| Классификация | OK: `output\classify-20261121-144233\classified.las` (4,1 МБ), `classified_clean.ply`, `classify.json`, превью |
| Совмещение | OK: `output\register-20261121-144236\src-registered.las` (8,8 МБ) + `register.json` |
| Clipping Box | OK: `output\clip-20261121-144238\clip-fragment.ply`, 1200 точек |
| Экспорт | OK: `output\export-20261121-144238\batch-result.las` |
| CRS info | OK: `output\crs-20261121-144238\crs-info.json` |
| Отчёт о точности | OK: `output\accuracy-20261121-144240\quality.json`, `diff.json`, `diff-heatmap.png`, `heatmaps\*` |
| Все файлы — в проекте | PASS: ни одного файла вне `<project>\output` (кроме метаданных проекта `project.json`) |
| temp после операций | PASS: пусто — временные папки удалены |
| AppData до/после | **240 → 240 файлов, новых 0**, ни одного имени результата инструментов; старые `p1-r151`/`p2p3-r155` не тронуты |
| Очистка старых | PASS: без `confirm` не удаляет (`ok:false`, папки на месте) |
| Консоль | 0 ошибок |

Скриншоты: [01-storage-banner.png](D:\BIM-TWIN-TEST\r55\paths-r184\shots\01-storage-banner.png),
[02-after-operations.png](D:\BIM-TWIN-TEST\r55\paths-r184\shots\02-after-operations.png).

## 5. Ограничения / замечания
1. Папка проекта в E2E назначается тестовым хуком (только при `BIM_TWIN_E2E=1`); в обычном запуске —
   диалог «Папка…» / автоматический запрос при операции без выбранной папки. Поддержан env
   `BIM_PROJECT_DIR` (headless-сценарии).
2. Старые папки в AppData **не удаляются автоматически**: показываются с размером, удаление — по кнопке
   и после подтверждения (безопасно; E2E проверил отказ без confirm). Очистку реальных старых папок этой
   машины оставил пользователю — данные не удалял.
3. В корне папки проекта остаётся служебный `project.json` (метаданные проекта, создаётся при привязке папки);
   все результаты инструментов — строго в `output/`.
4. Попутно E2E выявил **не связанную с путями** ошибку `cloud-classify.py` при `--max-points`: `IndexError`
   в `write_las_filtered` (массив классов меньше числа точек). Классификация без `maxPoints` проходит;
   стоит отдельной задачи (в r184 путь/хранение не менял).
5. `main.js` в рабочем дереве параллельно правят другие агенты (общий r184); мои изменения — только deps
   для мостов, `tool-storage.js`, p1/p23-мосты, preload-методы, UI p1/p23 и тесты; файлы editor-basics/
   phase4 не трогал.

## 6. Файлы (не коммичено)
- Новые: `tool-storage.js`, `test/r184-storage-paths.test.js`, `STORAGE-PATHS-r184.md`;
  `_scratch/r184-paths-e2e.js` (E2E-стенд).
- Изменены: `p1-bridge.js`, `p23-bridge.js`, `main.js` (deps для мостов + тестовый хук), `preload.js`,
  `renderer/ui/p1-tools.js`, `renderer/ui/p23-tools.js`.
- E2E-артефакты: `D:\BIM-TWIN-TEST\r55\paths-r184\`, проект `D:\BIM-TWIN-TEST\proj-test\`,
  скриншоты в `…\paths-r184\shots\`.
