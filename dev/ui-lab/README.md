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
node panels.js 1440 900 dark          # панели, меню, диалоги, палитра, прогресс (см. panels.js)
python3 sheet.py out.png shots/a.png shots/b.png   # склейка снимков по вертикали
```

Переменные окружения: `PLAYWRIGHT_MODULE` (путь к модулю), `CHROMIUM_PATH` (браузер), `SHOTS` (папка снимков,
по умолчанию `dev/ui-lab/shots`, в git не попадает), `LAB_URL`, `LAB_CLOUD`.

Границы: WebGL отрисовывается программно (SwiftShader), файловые диалоги и IPC main-процесса заменены заглушкой —
проверяются разметка, стили, состояния и сценарии интерфейса, а не работа с реальным GPU и файловой системой.
