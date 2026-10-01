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
| `panels.js` | сценарии: `base quality edit cleanmenu geommenu section measure measureplane measurelist measurelistfull objinspect objwin objwinmeasure verifyins verify verifyfill verifyfilled verifymanual verifyopen verifytip verifychip verifystack verifyaccept verifyall verifyreqs verifyempty objesc s2b s2bai flooradd convert settings newproject compare drafts memory draw palette console progress ask askdanger askmulti askover toasts more tree docs room roomdocs drawer inspectordrawer` (`verify*` — окно «Сверка с документацией»: статусы, фильтры, раскрытая строка, «Принять», «Свои размеры» и «Сравнить со своим размером» с проверкой результата) |
| `startup.js` | сценарии стартового экрана: `one many pick search nomatch empty error loading settings newdlg opening` |
| `real-load.js` | загрузка реального облака (`LAB_CLOUD`) в приложение: время, число точек в просмотре, снимок |
| `real-snap.js` | точный захват на реальном облаке против эталона (`LAB_GT`): тип привязки, ошибка, покрытие заявленной погрешности ±σ |
| `real-e2e.js` | сквозной прогон на реальном облаке: настоящие движения и клики мыши по холсту (с промахом 3–6 px), подсказка захвата, панель результата, сохранение замера, окно сверки и сравнение со «своим размером» |
| `real-node.js` | то же без браузера (Node): захват и расстояния на выборке просмотра «1 из 6», радиусы захвата `SDS`, промах кликов `OS`, порог окна плоскостей `FLOORSP`; за минуту даёт покрытие ±σ по всем привязкам и парам |
| `gt-eval.js` | эталон пары в местах щелчков (у наклонных откосов расстояние зависит от места): `node gt-eval.js результаты.json gt-targets.json` |
| `ply-bbox.js` | габарит PLY по файлу (общий код `real-*.js`) |

Снимки складываются в `shots/`: `p-<тема>-<ширина>-<сценарий>.png` (рабочая область), `st-<тема>-<ширина>-<сценарий>.png`
(стартовый экран). После каждого сценария печатается результат `audit`.

## Проверка на реальном облаке (`real-*.js`)

Эти скрипты не входят в набор для интерфейса: им нужен собственный скан. Файл и эталон в репозиторий не кладутся (репозиторий
публичный) — пути задаются переменными окружения.

```bash
cd dev/ui-lab
# 1. загрузка: время и число точек в просмотре (приложение оставляет каждую 6-ю точку — джиттер-выборка las-core.keepSampledIndex)
LAB_CLOUD=/путь/скан.ply node real-load.js
# 2. привязки по эталону: тип, ошибка, покрытие ±σ (≈1,5 мин)
LAB_CLOUD=/путь/скан.ply LAB_GT=/путь/gt-targets.json LAB_OUT=/tmp/real-snap.json node real-snap.js
# 3. сквозной прогон: настоящая мышь, подсказка, панель, сохранение, окно сверки (≈3–5 мин на пару × повторы; в SwiftShader выбор точки идёт секундами)
LAB_CLOUD=/путь/скан.ply LAB_GT=/путь/gt-targets.json LAB_OUT=/tmp/real-e2e.json LAB_PAIRS=door2_width_edges,room_height LAB_TRIALS=2 LAB_DEMO=door2_width_planes node real-e2e.js
LAB_CLOUD=/путь/скан.ply LAB_GT=/путь/gt-targets.json SDS=0.02,0.033,0.052,0.07 node real-node.js    # без браузера: привязки и размеры при разных радиусах захвата
node gt-eval.js /tmp/real-e2e.json /путь/gt-targets.json    # ошибка относительно эталона в идеальной точке и в местах щелчков
```

Формат эталона `gt-targets.json` (исходные координаты облака): `snaps{id:{kind:'plane'|'edge'|'corner', ideal:[x,y,z], gt:[x,y,z], n, dir, contour?, gtC?}}`, `pairs[{name,a,b,kind:'planes'|'edges'|'points'|'point-plane',gt,gtC?}]`. Эталон — подгонка плоскостей по
**полным** данным возле нужного места (а не по 1/6, которые видит просмотр), то есть это проверка «просмотр + клик против полного скана», а не
сверка с рулеткой. Ограничения: Chromium со SwiftShader (не Electron и не реальный GPU), документы подставляет заглушка `stub.js`, реальная мышь
промахивается на заданные пиксели, а не на человеческие.

## Аудит раскладки (`audit` в `lab.js`)

Автоматически ищет дефекты, которые трудно заметить глазами при просмотре десятков снимков:

| Код | Что означает |
| --- | --- |
| `MISSING-ICON` | `data-ico` указывает на иконку, которой нет в `renderer/icons.js` |
| `CLIPPED-TEXT` | текст обрезан многоточием, а полной подсказки (`title` / `data-tip`) у элемента нет |
| `CLIPPED-CONTROL` | кнопка или поле выходят за край панели/меню/окна/тоста, где содержимое обрезается |
| `OFFSCREEN` | панель, HUD, меню, окно или подсказка выходят за границы окна |
| `SIDE-OVERFLOW` | содержимое левой или правой колонки (`.sidebar`, `.inspector`) выходит за её край (например, поле поиска шире колонки) |
| `SMALL-TARGET` | интерактивная цель меньше 24×24 px и её круг 24 px задевает соседнюю цель (WCAG 2.2, SC 2.5.8) |
| `OVERLAP` | пересекаются плавающие элементы (панели, HUD, навигация сцены, куб, тосты) — с учётом обрезки прокруткой |
| `DEFAULT-STYLE` | у кнопки или поля осталась системная рамка — стиль дизайн-системы не применился |
| `NO-NAME` | кнопка без подписи, `aria-label`, `title` и `data-tip` |
| `PAGE-SCROLLED` / `PAGE-OVERFLOW` | страница целиком прокручена или шире/выше окна |

Релизный критерий для интерфейса: прогон `panels.js`, `tabs.js` и `startup.js` при 1024×680/1280×720/1440×900/1920×1080 в тёмной и
светлой темах — ноль замечаний аудита и ошибок консоли.

Границы: WebGL отрисовывается программно (SwiftShader), файловые диалоги и IPC main-процесса заменены заглушкой —
проверяются разметка, стили, состояния и сценарии интерфейса, а не работа с реальным GPU и файловой системой.


## Режим Electron-API

По умолчанию `stub.js` повторяет полный список методов `bimAPI` из `preload.js` (через `ownKeys/has/getOwnPropertyDescriptor`), поэтому рабочая область ведёт себя как в Electron: бейдж «JSON», кнопки окна, автосохранение. `LAB_DEMO=1` возвращает демо-режим без `bimAPI` (бейдж «Демо»). Критерий прохождения: все сценарии `ok`, `errors: 0` и ни одного замечания аудита.
