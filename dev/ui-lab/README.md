# Стенд интерфейса (dev/ui-lab)

Вспомогательный набор скриптов для проверки интерфейса без Electron: статический сервер, заглушка `window.bimAPI`,
Playwright + Chromium. Это инструмент разработки — он не входит в установщик (папка `dev/` не перечислена в `build.files`).

## Быстрый старт

```bash
npm i --no-save playwright           # один раз; нужен Chromium (playwright install chromium) либо CHROMIUM_PATH
node dev/ui-lab/mkcloud.js            # создаёт dev/ui-lab/room.ply — синтетическое облако «комната» (≈300 тыс. точек)
node dev/ui-lab/server.js &           # http://127.0.0.1:8123 (корень — репозиторий)
cd dev/ui-lab
node n1.js smoke 1440 900 dark        # снимок + число ошибок консоли (должно быть 0)
node tabs.js 1440 900 dark cloud      # обход всех вкладок ленты с открытым облаком, снимки полосы ленты
node panels.js 1440 900 dark          # панели, меню, диалоги, палитра, прогресс — все сценарии подряд
node panels.js 1440 900 dark ask,askmulti,toasts   # только перечисленные сценарии
node startup.js 1440 900 dark         # стартовый экран: карточки, поиск, пустое состояние, ошибка, настройки, диалог
python3 sheet.py out.png shots/a.png shots/b.png   # склейка снимков по вертикали
```

Переменные окружения: `PLAYWRIGHT_MODULE` (путь к модулю), `CHROMIUM_PATH` (браузер), `SHOTS` (папка снимков,
по умолчанию `dev/ui-lab/shots`, в git не попадает), `LAB_URL`, `LAB_CLOUD`.

## Что делает каждый скрипт

| Скрипт | Назначение |
| --- | --- |
| `server.js` | статический сервер репозитория на `127.0.0.1:8123` (в стиле `file://`, без внешних запросов) |
| `stub.js` | заглушка `bimAPI` (проекты, файлы, настройки, версия) — приложение считает, что оно в Electron |
| `lab.js` | общие функции: запуск браузера, `openCloud`, снимок, **`audit`** (см. ниже) |
| `n1.js` | быстрый дымовой прогон: рабочая область, ошибки консоли |
| `tabs.js` | обход вкладок ленты: прокрутка ленты (`can-prev/can-next`), отсутствующие иконки, ошибки |
| `panels.js` | сценарии: `base quality edit cleanmenu geommenu section measure measureplane measurelist measurelistfull objinspect objwin objwinmeasure objesc s2b s2bai flooradd convert settings newproject compare drafts memory draw palette console progress ask askdanger askmulti askover toasts more tree docs room roomdocs drawer inspectordrawer` |
| `startup.js` | сценарии стартового экрана: `one many pick search nomatch empty error loading settings newdlg opening` |

Снимки складываются в `shots/`: `p-<тема>-<ширина>-<сценарий>.png` (рабочая область), `st-<тема>-<ширина>-<сценарий>.png`
(стартовый экран). После каждого сценария печатается результат `audit`.

## Аудит раскладки (`audit` в `lab.js`)

Автоматически ищет дефекты, которые трудно заметить глазами при просмотре десятков снимков:

| Код | Что означает |
| --- | --- |
| `MISSING-ICON` | `data-ico` указывает на иконку, которой нет в `renderer/icons.js` |
| `CLIPPED-TEXT` | текст обрезан многоточием, а полной подсказки (`title` / `data-tip`) у элемента нет |
| `CLIPPED-CONTROL` | кнопка или поле выходят за край панели/меню/окна/тоста, где содержимое обрезается |
| `OFFSCREEN` | панель, HUD, меню, окно или подсказка выходят за границы окна |
| `SIDE-OVERFLOW` | содержимое левой или правой колонки (`.sidebar`, `.inspector`) выходит за её край (например, поле поиска шире колонки) |
| `OVERLAP` | пересекаются плавающие элементы (панели, HUD, навигация сцены, куб, тосты) — с учётом обрезки прокруткой |
| `DEFAULT-STYLE` | у кнопки или поля осталась системная рамка — стиль дизайн-системы не применился |
| `NO-NAME` | кнопка без подписи, `aria-label`, `title` и `data-tip` |
| `PAGE-SCROLLED` / `PAGE-OVERFLOW` | страница целиком прокручена или шире/выше окна |

Релизный критерий для интерфейса: прогон `panels.js`, `tabs.js` и `startup.js` при 1024×680/1280×720/1440×900/1920×1080 в тёмной и
светлой темах — ноль замечаний аудита и ошибок консоли.

Границы: WebGL отрисовывается программно (SwiftShader), файловые диалоги и IPC main-процесса заменены заглушкой —
проверяются разметка, стили, состояния и сценарии интерфейса, а не работа с реальным GPU и файловой системой.
