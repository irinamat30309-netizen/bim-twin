# DESIGN-ANTISLOP-r192 — графит/фиолетовый, anti-slop ревизия интерфейса

Дата: 2026-11-21. Не коммитил. Direction: `DESIGN.md` (graphite industrial, violet accent). Скриншоты до/после: `D:\BIM-TWIN-TEST\r55\design-r192\{before,after}\`.

## Что изменено (кратко)

1. **`DESIGN.md`** — identity, палитра, шкала, радиусы, elevation, icons, states, dials `ENERGY 1 / RHYTHM 2 / MOTION 1`, причина каждого решения (R-31).
2. **`renderer/ui/tokens.css`**: один акцент `#a78bfa` (dark) / `#6d56d1` (light, темнее для AA), радиусы **4/6/8**, шкала **11/12/13/14/16/20/24**, `--fs-2xs 11`, табличные цифры, подняты `--txt-2/--txt-3` для AA, тени только 1/2/3 для приподнятых слоёв.
3. **`renderer/ui/design-r192.css`** (подключён последним):
   - primary-акцент только `.btn.primary`, primary-иконка ленты (`accent-soft`), активная вкладка (2px underline), focus-ring;
   - второстепенные кнопки нейтральные (`bg-2` + границы), violet только на hover/focus; убраны violet-заливки `.btn.on`/чипов/бейджей/primary-плашек;
   - radius 4/6/8, pill только статус-чипы/переключатели; `.badge` 4px;
   - типографика: без uppercase+широкого трекинга (аудит `upperWideTracking=0`), подписи 11–12 px, табличные цифры в статусе/координатах;
   - тени только у `.fpanel/.hud/.lx-modal/dialog/.lx-toast`, панели/лента — границы;
   - focus-visible 2px accent глобально; hover/active/disabled; `prefers-reduced-motion`;
   - нейтральный баннер «нет цвета», акцент только на его primary-кнопке.
4. **Иконки**: `sparkles` → `brush-cleaning` (Автоочистка), `sparkles` → `scan-search` (Чистка до мелочей), `wand-sparkles` → `layers-2` (PLY→3DGS), `sparkles` → `message-circle` (AI-кнопка); sparkle/star/magic в реестре больше нет.
5. Не тронуты r130 (размеры ленты), r178/r191 (доп. панели скрыты, старый `bim.extraUi` не действует) и 3D-рендер.

## Delivery Gate (применимые пункты) — **PASS**

| правило | статус | доказательство |
|---|---|---|
| R-01 Color & gradients | PASS | Нет градиентов/glow/neon; accent — один solid violet у primary; focus — 2px ring |
| R-04 Icons | PASS | Sparkle/star/magic/wand убраны (`test/r192-design.test.js`); иконки по смыслу, набор icons.js |
| R-06 Typography | PASS | Шкала 11–24 px, sans; E2E-аудит `upperWideTracking: 0`; tabular-nums |
| R-07 Background | PASS | Декоративных сеток/blueprint/точек в UI не добавлено; 3D-сцена — продуктовая |
| R-08 Button arrows | PASS | Стрелки не используются как декор; в ленте/диалогах нет `→`-на-каждой-кнопке |
| R-09 Badges | PASS | Бейджи нейтральные/семантические (ok/warn/err), без капсульных «AI/Beta» |
| R-11 Border radius | PASS | E2E: радиусы кнопок `6px/4px/0`; pill только статус-чипы/переключатели |
| R-12 Shadow | PASS | Тени только у меню/попапов/диалогов/HUD/тостов; панели/лента — border |
| R-13 Glow | PASS | Glow нет; `box-shadow:none` у brand-mark/primary, ring только focus |
| R-15 CTA | PASS | Тексты конкретные («Построить BIM», «Раскрасить по фото камер», «Сохранить»), не Get Started |
| R-16 Copywriting | PASS | Не добавлено AI-маркетинговых штампов; подписи по делу |
| R-19 Animations | PASS | MOTION 1: только hover/focus/переходы 120–180 мс + reduced-motion |
| R-20 Visual identity | PASS | Графит + violet + инженерная плотность; DESIGN.md фиксирует identity |
| R-21 Dark mode | PASS | Тёмная по умолчанию для инженерного инструмента; светлая работает, 3D остаётся тёмным; скриншоты обеих тем |
| R-25 Contrast AA | PASS | `tools/design-contrast-r192.js`: **все 28 пар dark/light ≥4.5 (текст) / ≥3 (ring)**, `CONTRAST PASS` |
| R-29 Palette | PASS | 2 нейтральных core + 1 accent + semantic; без 5+ цветов |
| R-30 Not clone | PASS | Нет копирования Linear/Vercel/Stripe; собственный графит/инженерный стиль |
| R-31 Reason written | PASS | DESIGN.md — однострочные причины для цвета/типографики/радиусов/теней/иконок |
| R-32 Keyboard/focus | PASS | Глобальный `:focus-visible` 2px accent; Tab/Esc; скриншот `06-focus-ring` |
| R-34 Theme toggle | PASS | Обе темы сняты (1920/4K); лента/панели/статус не ломаются, 3D тёмный |
| R-39 Semantics/affordance | PASS | Нативные button/select, cursor pointer/not-allowed, aria-label существующих icon-кнопок, hover/active/disabled, reduced-motion; layout/элементы не ломались |

## Контраст (программная проверка)

`node tools/design-contrast-r192.js` → `CONTRAST PASS: all pairs meet AA`. Примеры: dark txt/bg-1 **13.56**, txt-2/bg-2 **7.46**, txt-3/bg-2 **5.79**, on-accent/accent **6.61**; light txt/bg-1 **16.22**, txt-2/bg-2 **8.01**, txt-3/bg-2 **6.25**, on-accent/accent **5.70**; focus accent/bg-1 dark **5.84**, light **5.25** (≥3). Полная таблица — вывод скрипта.

## E2E (Electron, чистый профиль, 1920/4K, dark/light)

Аудит после правок (`after/audit-design.json`):
- радиусы видимых кнопок: `6px`, `4px`, `0` — «всё pill» нет;
- `upperWideTracking: 0` (нет uppercase с широким трекингом);
- `fontSizes` среди вкладок/статуса/заголовков: `13px, 12px, 11px`;
- `#lxVramHud`: 1 (дублей нет); `extraUi: null`; панели r145 (`lx145Rail/Data/Props/P1Bar/PerfPill`) — **false** (r178/r191 сохранены);
- статус: «Обзор … VRAM ~1.1 / 12 ГБ Готово …» без дублей;
- primary-кнопка — «Сохранить» в настройках; второстепенные нейтральные.

Скриншоты:
- before: `before/01-main-dark-1920x1080.png`, `02-main-light-1920x1080.png`, `03-settings-modal-1920x1080.png`, `04-command-palette-1920x1080.png`, `05-main-dark-3840x2160.png`;
- after: те же + `06-focus-ring-1920x1080.png`, `audit-design.json`.

## Тесты

- новый `test/r192-design.test.js` — **5/5** (DESIGN.md, токены, CSS, контраст-скрипт, иконки);
- обновлены `test/r130-ui-sizes.test.js` (новые accent/11px) и `test/cloud-clean-r7.test.js` (brush-cleaning);
- полный `node --test`: **1924 теста / 1920 pass / 4 skipped / 0 fail**.
