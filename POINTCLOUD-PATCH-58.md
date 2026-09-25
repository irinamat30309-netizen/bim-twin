# POINTCLOUD-PATCH-58 — авто-очистка в один клик + умное ручное удаление (без дыр) + Python-движок

Отвечает на фидбек: «авто-очистка работает, но нужно много раз»; «людей практически невозможно удалить, остаются дыры в стенах/полах»; «добавить Python-движок как в CloudCompare».

## A. Авто-очистка (🧹 «Чистка») — максимум за ОДИН клик
- Новая `PCEdit.cleanAuto(cloud, opts)` — за один вызов гоняет несколько проходов до стабилизации:
  1. **SOR** (k=16, std ↓ с каждым проходом — агрессивнее);
  2. **density** (воксельный фильтр плотности, minPts растёт);
  3. **connected components** (`cleanClusters` — отсоединённые кластеры).
  Остановка, когда за проход удалено < 0.08 %.
- Viewer `cleanAutoInApp()`; кнопка 🧹 теперь зовёт его (один клик = как несколько прежних).
- Desktop Python: `API.cleanCloud` теперь шлёт `ops:[{type:'auto'}]`.

## B. Ручное удаление — «умная чистка» по умолчанию
Прежде: «Только объект» удалял лишь переднюю корку (сзади оставался), «Насквозь» сносил стену за ним → дыры.
- При входе в «Правку» включается `viewer.setSmartClean(true)`:
  - **насквозь** (depth 2) — весь силуэт человека;
  - **защита пола/стен** (RANSAC, до 6 плоскостей) — точки на плоскостях НЕ удаляются;
  - **латание дыр** (`fillPlaneHoles`) — силуэт удалённого объекта на плоскости заполняется точками (цвет от соседей, заливка от края внутрь).
- Итог: лассо вокруг человека → 🗑 → человек уходит целиком, стена/пол остаются, тень залатывается. Undo откатывает и заплатки (`addedFill`).

## C. Python-движок (tools/pointcloud_clean.py) — op `auto`
- **Open3D**: statistical_outlier → radius_outlier → cluster_dbscan (аналог CloudCompare *Label Connected Components*) → финальный SOR.
- **NumPy-fallback**: несколько проходов density.

## Основано на
- Open3D outlier removal (nb_neighbors / std_ratio; radius outlier).
- CloudCompare Noise filter, Label Connected Components.
- PCL StatisticalOutlierRemoval (meanK / stddev).

## Проверка
- `node --check`, `node --test test/` (вкл. `pcedit-clean.test.js`).
- `tools/pointcloud_clean.py` — прогон numpy-пути на синтетическом PLY.
- WebGL/Open3D-обвязка — только синтаксически (нет GPU/Open3D в песочнице).

## Версия
- `index.html`: `?v=1026` → `?v=1028`.
