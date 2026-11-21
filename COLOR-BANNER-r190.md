# COLOR-BANNER-r190 — «Облако без цвета»: hasRGB ≠ hasColor

Дата: 2026-11-21. Не коммитил. Скриншоты: `D:\BIM-TWIN-TEST\r55\color-banner-r190\`.

## 1. Причина бага

Серое облако лидара часто имеет **RGB-атрибут**, но все точки R=G=B (серая яркость отражения). В приложении было одно поле `hasRGB`, и:
- панель `colorNote` считала облако серым по собственной выборке и писала «Цвета в файле нет»;
- баннер `#lxNoColorBanner` проверял `info.hasRGB === false`, а атрибут есть → `hasRGB=true` → **баннер не появлялся**. Отсюда расхождение: примечание «цвета нет», а баннера нет.

## 2. Исправление

1. **Разделены флаги** в `getCloudInfo()`/`_cloudRecord`:
   - `hasRGB` — в файле есть RGB-атрибут (raw, из заголовка/парсера);
   - `hasColor` — реальный цвет: выборка до **50 000** точек, цветной считается при `|R−G|+|G−B| > 0.08` или насыщенности `> 0.15`, доля цветных ≥ **2 %**; все R=G=B → `hasColor=false`.
   - raw `hasRGB` протянут через весь конвейер: `cloud-segments`/`las-node` meta → `main cloudPartsOpen` → `app beginCloudStream/loadCloud` → `webgl-viewer._cloudRecord`.
   - `hasColor` сначала берётся из парсера (он уже делает выборку и не путает elevation-рампу с цветом), а если парсер не дал — из выборки `_sampleCloudColor`; для `hasRGB=false` цвет всегда `false`.
2. **Баннер** (`renderer/app.js`) — по `info.hasColor === false`.
3. **Панель** (`renderer/lixel-cloud-ui.js`): `hasRGB=false` → «В исходнике нет RGB…»; `hasRGB=true, hasColor=false` → «Цвета в файле нет: RGB — серая яркость…» + кнопка «Раскрасить по фото камер»; цветное → примечания нет. Кнопка запускает `__bimPhotoColor(path,{auto:true})`.

## 3. E2E (реальный Electron, чистый профиль, 1920/4K)

| файл | hasRGB | hasColor | баннер | панель |
|---|---|---|---|---|
| `test-gray-36m.las` (серый с RGB-атрибутом) | **true** | **false** | **виден** «Облако без цвета (…test-gray-36m.las) — раскрасить по фото камер» + кнопка | **«Цвета в файле нет: RGB — серая яркость…»** |
| `test-gray-36m-color.las` (цветной) | true | true | **display:none** | пусто (не пишет «цвета нет») |
| `interior-ours-full-r132.las` (серое облако с полями RGB) | true | **false** | **виден** | «Цвета в файле нет…» |

Скриншоты:
- `gray-rgb-banner-1920x1080.png` — серое облако, баннер и примечание видны;
- `color-no-banner-1920x1080.png` — цветной файл, баннера/примечания нет, облако цветное;
- `color-no-banner-3840x2160.png` — 4K.
Скриншоты сняты в чистом профиле (`--user-data-dir`), панелей r145 нет; баннер не перекрывает ленту.

## 4. Тесты

- `test/r190-color-flags.test.js` — **2/2**: разделение `hasRGB`/`hasColor` (выборка 50k, пороги, «нет RGB» → цвет false), баннер/панель по `hasColor`;
- `test/r183-color-open.test.js` — 3/3 (обновлён под hasColor);
- Полный `node --test`: **1916 тестов / 1912 pass / 4 skipped / 0 fail**.
