# Фаза 7 — координаты точки под курсором в статус-баре (UI r130, часть 2)

Дата: 2026-11-15. База: коммит `c3f3f89` (r129). Изменения **не закоммичены**.
Задача: при наведении мыши на облако точек показывать координаты точки в правом нижнем
углу статус-бара, формат `X: 12.346  Y: 3.210  Z: -8.120 м`; нет точки рядом/курсор вне
вьюера — прочерк «—»; троттлинг, отключаемость, скриншот из реального Electron.

Файлы этой задачи:

| Файл | Статус |
|---|---|
| `renderer/ui/coords-hud.js` | **новый**, 538 строк |
| `renderer/index.html` | одна строка `<script src="ui/coords-hud.js?v=130">` **до** `ui/chrome.js` |
| `test/r130-coords-hud.test.js` | **новый**, 16 тестов (source-level + Node + jsdom) |
| `PHASE7-COORDS.md` | этот отчёт |

`renderer/ui/shell.css`, `tokens.css`, `ribbon.js`, `chrome.js`, `modes.js` **не трогал**
(их параллельно правит editor-basics). `potree-loader.js` / `viewer*.js` трогать не
понадобилось: в основном вьюере уже есть готовый picking (см. §1).

## Сводка (числа)

| Проверка | До | После |
|---|---|---|
| `node --test` (bim-twin) | 1646 тестов / 1642 pass / 0 fail / 4 skipped | **1673** / **1669 pass** / **0 fail** / **4 skipped** |
| Новые тесты `r130-coords-hud` | — | **16 / 16 pass** |
| Electron 20.18.0, тестовое облако 50 854 точки | — | hover → `X: -1.812  Y: -1.500  Z: 1.813 м` (источник `gpu`); вне вьюера → `X: —  Y: —  Z: — м`; отключение по клику (`localStorage=0`), возврат через API |
| Время обработки pointermove | — | **0,012 мс** на событие (ранний выход по троттлингу); сам пик после прогрева: **0,25 мс** GPU / **0,75 мс** CPU |
| Скриншоты | — | `D:\BIM-TWIN-TEST\r55\coords-hud\coords-hover.png`, `coords-no-hover.png`, `coords-enabled.png` |

(+27 тестов относительно 1646: мои 16 и 11 из параллельной `test/r130-ui-sizes.test.js`;
полный прогон — 0 fail.)

## 1. Как загружается облако и какой picking есть (найдено в коде)

* Облако читается `renderer/pointcloud.js` (LAS/LAZ/E57/PLY/PTX/PCD…) → `viewer.loadCloud()`
  в основном WebGL-вьюере `renderer/webgl-viewer.js`; вьюер доступен как
  `window.__pcTools.viewer()` / `window.__viewer` (и `window.__lxViewer`).
* В вьюере уже есть три пути выбора точки (писать свой raycast не пришлось):
  1. **GPU-pick** `v._pickGPU(sx, sy, radiusPx)` — рендер `gl_VertexID` точек в
     `R32UI`-буфер с тестом глубины (WYSIWYG: реальная видимая точка, с окклюзией и
     клип-боксом), затем `readPixels` окна вокруг курсора. Это самый точный путь.
  2. **CPU-сэмплинг** `v._pickPoint(sx, sy)` — ближайшая точка облака в радиусе ~22 px,
     для облаков >300 тыс. точек — подвыборка (тот же путь, что у измерений и снапа).
  3. `v._pick(sx, sy)` — общий пикинг (меши + облако + GPU + CPU-фолбэк).
* Potree 2.0 в приложении — конвертер/отдельный просмотрщик, основной сцены не обслуживает;
  на случай `viewer.pick(x, y)` (potree/three) оставлен фолбэк, плюс собственный сэмплинг
  по проекции `base[0].pos` — если у вьюера вообще нет своих методов выбора.

Порядок в `pickPointAt()`: **GPU-pick → CPU `_pickPoint` → `viewer.pick` → свой сэмплинг
по проекции**. Облако скрыто (`cloudVisible=false`/`opacity=0`) или точки рядом нет → прочерк.

## 2. Что и как показывается

* Элемент `#lxCoordsHud` (`div.lx-coords-hud`, `role=status`) вставляется в существующий
  нижний статус-бар `#lxStatus` **перед** `#lxSaveState`, то есть в правой группе после
  «СК: локальная · ед.: м» и **до** кнопок «Готово/Консоль» — ничего не перекрывает.
* Формат ровно по заданию: `X: 12.346  Y: 3.210  Z: -8.120 м` (два пробела между осями,
  единица «м» в конце). Метры — 3 знака, миллиметры — значения ×1000, 1 знак
  (`X: 12345.6  Y: 3209.8  Z: -8120.4 мм`). Округление устойчиво к `-0` (`-0.0004 → 0.000`),
  нет точки — каждая ось «—».
* Hover: `pointermove` на `document` (один обработчик, работает и после перезагрузки облака /
  смены канвы), проверка попадания в прямоугольник канвы вьюера, троттлинг **80 мс**
  (диапазон задания 60–100), trailing-обновление последней позиции; во время орбиты/панорамы
  (`v._interacting`) пик пропускается, чтобы не ронять FPS.
* Уход курсора с канвы (`pointerleave`/`pointerout`, capture) и выход за её пределы —
  прочерки; `window.blur` — прочерки; `lx-viewer-ready` — перерисовать в «—».
* Отключение: клик по координатам скрывает их и пишет `localStorage['lxCoordsHud']='0'`;
  вернуть — `window.__lxCoordsHud.setEnabled(true)` (или `toggle()`, или событие
  `lx-coords-hud-toggle` на window — для будущего пункта меню «Отображение»).
  Единицы: `window.__lxCoordsHud.setUnits('m'|'mm')`, флаг `localStorage['lxCoordsHudUnits']`.
* Публичное API (для меню/тестов): `window.__lxCoordsHud = { mount, dispose, refresh,
  setEnabled, isEnabled, toggle, setUnits, getUnits, setThrottle, getThrottle, updateAt,
  current, formatPoint, formatText, formatCoordValue, roundCoord, pickPointAt,
  pickByProjection, getViewer, STORAGE_KEY, UNITS_KEY, DEFAULT_THROTTLE_MS, PICK_RADIUS_PX,
  version }`; для `node --test` — `module.exports`.
* Стили — только токены `tokens.css` (`var(--txt)`, `var(--txt-3)`, `var(--mono)`, …),
  инжектятся модулем (общие CSS-файлы не правятся), без синего/чистого белого/градиентов.

## 3. Оси координат (важно)

Вьюер BIM Twin — **Y-up**: yaw вращает вокруг Y, панорама вверх/вниз идёт по Y, облако и
BIM-модель движка тоже Y-up (план X–Z, высота Y). Поэтому статус показывает **X / Y / Z
внутреннего (локального) кадра проекта**: X — вправо, Y — вверх, Z — вперёд/глубина,
единицы — метры. Это те же координаты, что показывает инструмент «Измерения → Точка»
(`mmPoint`) и старые `#lxX/#lxY/#lxZ` в статус-баре, поэтому расхождений в приложении нет.

Исходная геодезическая система (CRS/смещение скана) к отображаемым числам **не применяется**:
вьюер хранит её отдельно (`v._srcXform`, `__pcTools.getSourceTransform()`,
`__pcTools.getSourceCrs()`) и использует при экспорте IFC (IfcMapConversion) — это отдельный
кадр «источника», для HUD под курсором он не нужен.

## 4. Тесты

`node --test test/r130-coords-hud.test.js` — **16/16 pass**:

* source-level: подключение `ui/coords-hud.js?v=130` в `index.html` до `chrome.js`;
  наличие API/функций, `_pickGPU`, `_pickPoint`, собственного сэмплинга, `pointermove`,
  `pointerleave/out`, ключей localStorage, `setTimeout`-троттлинга, data-атрибутов
  (`data-coords="x|y|z"`, `data-coords-unit`, `data-coords-ok`), палитры токенов,
  отсутствия градиентов/`#fff`.
* Node (чистые функции): формат «X: 12.346  Y: 3.210  Z: -8.120 м»; мм (×1000, 1 знак);
  округление, `-0 → 0.000`, `NaN → «—»`, короткий массив → прочерки; `pickPointAt`
  (GPU первый, фолбэк CPU, нет точки/облако скрыто → прочерк); собственный сэмплинг
  по проекции (identity-матрица: NDC→экран, радиус 20 px, точка находится).
* jsdom: элемент вставлен в `#lxStatus` после `#lxInfo` и **до** кнопок; hover даёт
  координаты и `data-coords-source="gpu"`; нет точки рядом/`pointerout`/курсор вне
  прямоугольника → «—»; троттлинг (за окно 500 мс ровно один пик); отключение по клику
  и `localStorage`, `refresh()` перечитывает флаг; единицы мм и немедленный `updateAt`;
  авто-монтирование после `DOMContentLoaded`, `role="status"`, троттлинг 80 мс в диапазоне.

## 5. Проверка в реальном Electron + скриншоты

Стенд (лежит в `_scratch`, не в репозитории):

```
# 1) синтетическое облако «комната» 10×3×6 м (PLY ASCII, Y-up, 50 854 точки)
node _scratch/make-coords-cloud.js "D:/BIM-TWIN-TEST/r55/coords-hud"

# 2) запуск приложения с облаком, программный hover по спроецированной точке облака,
#    скриншоты и замеры (CDP, тот же приём, что у ui-tabs-shot.js)
node _scratch/r130-coords-shot.js "D:/BIM-TWIN-TEST/r55/coords-hud" \
     "D:/BIM-TWIN-TEST/r55/coords-hud/coords-room.ply"

# 3) штатный стенд вкладок (проверка, что статус-бар/лента не разъехались)
node _scratch/ui-tabs-shot.js "D:/BIM-TWIN-TEST/r55/coords-hud/tabs"
```

Результат (`RESULT` стенда, Electron 20.18.0):

```json
{
  "cloudReady": { "points": 50854, "canvas": true, "hud": true },
  "hudMounted": true,
  "hudParent": "lxStatus",
  "hudText": "X: -1.812 Y: -1.500 Z: 1.813 м",
  "hudAttrs": { "ok": "1", "source": "gpu", "ms": "14", "units": "m", "enabled": "1", "hidden": false },
  "pickTiming": { "_pickGPU": 0.25, "_pickPoint": 0.75, "handlerAvgMs": 0.012 },
  "hudNoHover": "X: — Y: — Z: — м",
  "disable": { "hiddenAfterClick": true, "storage": "0", "enabledAfterRestore": true, "storageAfterRestore": "1" },
  "ok": true
}
```

Скриншоты:

* `D:\BIM-TWIN-TEST\r55\coords-hud\coords-hover.png` — курсор над облаком, справа снизу
  в статус-баре `СК: локальная · ед.: м   X: -1.812  Y: -1.500  Z: 1.813 м   Готово  Консоль`;
* `D:\BIM-TWIN-TEST\r55\coords-hud\coords-no-hover.png` — курсор вне вьюера,
  `X: —  Y: —  Z: — м`;
* `D:\BIM-TWIN-TEST\r55\coords-hud\coords-enabled.png` — после отключения/возврата;
* `D:\BIM-TWIN-TEST\r55\coords-hud\tabs\*.png` — 16 вкладок ленты + палитра команд
  (штатный стенд отработал без ошибок, лента/ статус-бар целы).

Проверка «после chrome.js скриптов нет» (`test/ui-system.test.js`) сохранена: новый скрипт
подключён **до** `ui/chrome.js`; полный прогон — 0 fail.

## 6. Производительность

* Обработчик `pointermove` — ранний выход, если с момента прошлого пика <80 мс:
  измерено **0,012 мс** на событие (100 событий подряд на реальном приложении).
* Пик выполняется не чаще ~12 раз/с. После прогрева (шейдеры pick-прохода и FBO
  инициализируются на первом hover): **0,25 мс** `_pickGPU`, **0,75 мс** `_pickPoint`;
  первый пик после смены камеры может стоить ~14 мс (ленивый pick-проход + readPixels) —
  это разовая цена, дальнейшие hover в статичной камере идут из кэша pick-прохода.
* Во время орбиты/панорамы (`v._interacting`) пик пропускается; троттлинг 80 мс.
* Для больших облаков `_pickGPU`/`_pickPoint` уже используют подвыборку/чанки; наш
  собственный фолбэк тоже прореживает `pos` до ~300 тыс. точек.

## 7. Ограничения

* Показывается **локальный кадр проекта** (Y-up), а не геодезические координаты CRS —
  см. §3; для геопривязки есть IFC-экспорт и `__pcTools.getSourceTransform/Crs`.
* Для облаков в режиме octree-стриминга, где у вьюера нет CPU-копии позиций (и `_pickGPU`
  отказывается из-за отсутствия `_pb`), возможен прочерк; на обычных облаках (в т.ч.
  50 тыс. точек в стенде) используется GPU-pick. На 20-млн облаке отдельно не замерял.
* Отключение — клик по координатам + `localStorage`, отдельного пункта в меню
  «Отображение» нет (ribbon.js/menu — зона параллельного агента; API и событие
  `lx-coords-hud-toggle` для этого готовы).
* HUD не перекрывает существующие элементы: это flex-элемент статус-бара перед
  кнопками; при экстремально узком окне он не скрывается (может поджать `#lxInfo`).
* Hover не работает, если курсор над другим 3D-просмотрщиком (splat/potree/realview) —
  модуль читает точку только из основного вьюера облака `__pcTools.viewer()`.

## 8. Приложение: как повторить

```
cd bim-twin
node --test test/r130-coords-hud.test.js     # 16/16
node --test                                   # 1673 / 1669 pass / 0 fail / 4 skipped
node --check renderer/ui/coords-hud.js
```

Не коммичено (рабочее дерево): `renderer/ui/coords-hud.js` (новый), строка в
`renderer/index.html`, `test/r130-coords-hud.test.js` (новый), этот отчёт.
