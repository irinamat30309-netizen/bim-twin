# CLOUD-REGISTER-r149 — P1 «Совмещение облаков / ICP / GCP»: инструмент, тесты, реальные данные

Дата: 2026-11-16. Задача: инструмент для приложения — регистрация облака по ICP / ручным
парам / GCP, с матрицей 4×4, RMS, inlier-ratio и пересчётом src в координаты ref.

## 1. Что готово

- `tools/scan2bim-py/cloud-register.py` — CLI-инструмент (готов к встраиванию в приложение):
  - вход: LAS/PLY (и LAS-чанк `.bin` с сигнатурой LASF); `--ref`, один или несколько `--src`;
  - `--mode icp` — многомасштабный **point-to-plane ICP** (Open3D): пирамида вокселей
    [1.0, 0.5, 0.25, 0.10] м (адаптируется к габариту), нормали, критерий сходимости;
    инициализация: identity (по умолчанию), `--init-matrix` (JSON/CSV 16 чисел) или
    `--auto-init` — **FPFH + RANSAC** глобальная инициализация;
  - `--mode manual-points` — 3+ пары точек (JSON/CSV) → жёсткая трансформация Kabsch (МНК, SVD);
  - `--mode gcp` — CSV контрольных точек (id, X,Y,Z источника, X,Y,Z проекта; если ref задан
    как lon,lat,alt — конвертация в UTM через `--epsg` формулами из `georef-rtk.py`);
  - `--crop xmin,ymin,zmin,xmax,ymax,zmax` — общий кроп (для больших сканов);
  - `--max-points` — блочный равномерный сэмпл (по умолчанию 1.5e6; для ICP хватает 0.5–0.8e6);
  - **выход JSON** (`--out`): `matrix` 4×4, `transform` (yaw/pitch/roll, сдвиг, масштаб),
    `rms` (rms_m, rms_inlier_m, median, inlier_ratio), `iterations`, `scales`, `history`,
    `shape` (ref/src точек), `strict_threshold_m`, `strict_pass`;
  - `--out-las` — пересчитанное (зарегистрированное) облако src в координатах ref (LAS 1.2
    fmt 3, RGB сохраняется; для `.ply` — PLY через Open3D);
  - `--strict`: exit 1 при RMS > порога (**ICP: 0.05 м; GCP/manual-points: 0.15 м**),
    exit 2 при <3 парах или ошибке входа.
- `tools/scan2bim-py/cloud-register-test.py` — тест на синтетике и реальных данных
  (сводка: `D:\BIM-TWIN-TEST\xbin-verify\r149-cloud-register-test.json`).

## 2. Синтетика (два облака, известный сдвиг+поворот, шум 1–2 см)

Сцена: асимметричная «комната» 10×8 м — пол, 3 стены под разными углами, 4 столба
(150 000 точек). Тест: src = известная трансформация (**yaw 4.0°, сдвиг [0.8, −0.5, 0.15] м**)
+ гауссов шум σ = 1.2 см; проверяется восстановление ICP (auto-init).

| Метрика | Ожидание | Получено | Итог |
|---|---|---|---|
| Δ поворота (yaw) | ≤0.05° | **0.0056°** | PASS |
| Δ сдвига | ≤2 см | **2.2 мм** | PASS |
| RMS (inlier) | ≤2 см | **16.7 мм** (inlier 100 %) | PASS |
| Время ICP (400k точек, auto-init) | — | **2.0–2.2 с** | — |

**manual-points** (20 пар, шум 1 см, сцена ×2 = база ~16 м): Δyaw **0.0295°** (≤0.05° PASS),
Δсдвига **3.2 мм** (≤2 см PASS), RMS **14.7 мм** (≤2 см PASS). Отказ при **<3 парах → exit 2**
(сообщение «пар N < 3»); выброс 0.5 м: без `--strict` exit 0 RMS 210 мм, с `--strict` **exit 1**.
**GCP** (CSV, 20 точек, шум 1 см): Δyaw **0.0281°**, Δсдвига **3.6 мм**, RMS **14.9 мм ≤0.15 м** →
strict PASS. Итог автотеста: **PASS 17 | FAIL 0 | SKIP 0**.

## 3. Реальные данные (кроп 20×20 м)

Пары подготовлены в одних и тех же локальных рамках (кроп 20×20 м):

| Набор | ref | src |
|---|---|---|
| Интерьер | `xbin-verify\lixel-20x20.las` (120.5M точек) | `xbin-verify\r145-interior-full-20x20.las` (276.5M) |
| Фасад | `xbin-verify\r145-facade-lixel-box.las` (27.7M) | `xbin-verify\r145-facade-ours-box.las` (66.8M) |

ICP (identity init, 4 масштаба, 600k точек в сэмпле, max 240 итераций):

| Набор | RMS (inlier) | RMS (все точки) | inlier @10 см | Δyaw | Δсдвиг | Время | Память (peak RSS) | strict 0.05 м |
|---|---|---|---|---|---|---|---|---|
| Интерьер | **51.5 мм** | 1062 мм | 7 % | 0.0042° | [5.7, 3.8, 15.6] мм | **9.3 с** | ~171 МБ | FAIL (51.5 > 50) |
| Фасад | **48.5 мм** | 499 мм | 26 % | 0.0025° | [−3.9, 15.5, 23.6] мм | **10.5 с** | ~174 МБ | **PASS** (48.5 ≤ 50) |

Пояснения к цифрам:
- **RMS(inlier)** — RMS расстояний пересчитанного src до ближайших точек ref для точек
  ближе 10 см; **RMS(все точки)** выше, т.к. часть облаков не перекрывается (кропы 20×20 м
  из разных проходов/обработок, разная плотность и шум) — это нормальный индикатор степени
  перекрытия, а не «плохой ICP».
- Сдвиги ~1.5–2.4 см по Z — систематическая разница между нашей сборкой и map Lixel на том
  же участке (наша поверхность смещена/шумит); поворот ~0.003° — база совпадает.
- ICP сходится за 4 масштаба (240 итераций в отчёте — суммарный лимит), время 9–10 с
  включает чтение и сэмплирование файлов (4.1 ГБ и 9.4 ГБ) + ICP; память ~170 МБ.

Дополнительно (полные map-файлы + числовой кроп по нашей рамке):
- интерьер `ln_amosova…\map.las` (175.6M) + `interior-ours-full.las` (52.8M) →
  RMS(inlier) **54.2 мм**, inlier 7 %, 3.9 с;
- фасад `D:\Skan\port\map.las` (271.5M) + `r146-facade-clean-dense.las` (66.3M) →
  RMS(inlier) **54.6 мм**, inlier 6 %, 4.3 с.
Причина низкого inlier — облака в разных локальных рамках/разной предобработке на одинаковых
числовых координатах; для приложения это означает, что нужен либо общий проектный фрейм,
либо авто-инициализация FPFH (включена в инструменте) и достаточное перекрытие.
*Примечание:* файла «наш фасад 589.9M» (589.9 МБ/точек) в доступных путях не найдено —
использованы подготовленный кроп `r145-facade-ours-box.las` (66.8M точек) и
`r146-facade-clean-dense.las`; при появлении файла прогон повторяется той же командой.

## 4. Ограничения

- ICP — локальный метод: без `--auto-init` (FPFH+RANSAC) надёжен при начальном рассогласовании
  примерно до 10–20 % габарита и перекрытии ≥40 %; при меньшем перекрытии RMS(inlier) растёт,
  inlier падает (см. §3).
- auto-init FPFH+RANSAC чувствителен к различной плотности/шуму облаков; для «наша сборка vs
  Lixel» на 20×20 кропе даёт fitness 0.94 до ICP, но итоговый inlier ограничен шумом нашей
  поверхности (толщина стен +59 % по r145).
- manual-points/GCP точность ограничена шумом пар и их базой: при 20 точках/1 см/базе 16 м
  погрешность поворота ~0.03° (синтетика подтверждает).
- GCP подпись координат: если ref дан как lon,lat,alt — нужен `--epsg` (поддержаны UTM
  258xx/326xx); при локальных X/Y — `--epsg` не нужен (значения используются как есть).
- `--out-las` пишет LAS 1.2 fmt 3 (RGB 16-бит); PLY — через Open3D.

## 5. CLI-примеры

```powershell
# ICP: авто-инициализация FPFH+RANSAC, многомасштабный point-to-plane, строгий порог 0.05 м
python tools/scan2bim-py/cloud-register.py --ref ref.las --src src.las --mode icp `
       --auto-init --out reg.json --out-las src-registered.las --strict

# ICP по подготовленным кропам 20×20 м (быстрый вариант)
python tools/scan2bim-py/cloud-register.py --ref lixel-20x20.las --src ours-20x20.las `
       --mode icp --max-points 600000 --out reg.json

# Ручные пары (JSON/CSV): 3+ пары, жёсткая трансформация Kabsch, strict-порог 0.15 м
python tools/scan2bim-py/cloud-register.py --ref ref.las --src src.las `
       --mode manual-points --pairs pairs.csv --out reg.json --strict

# GCP: CSV id,x_src,y_src,z_src,X_ref,Y_ref,Z_ref (или lon,lat,alt + --epsg 32636)
python tools/scan2bim-py/cloud-register.py --ref ref.las --src src.las `
       --mode gcp --pairs gcp.csv --epsg 32636 --out reg.json --strict

# Тест (синтетика + реальные кропы), сводка в JSON
python tools/scan2bim-py/cloud-register-test.py --json r149-cloud-register-test.json
```

## 6. Артефакты

- инструмент: `tools/scan2bim-py/cloud-register.py`;
- тест: `tools/scan2bim-py/cloud-register-test.py`;
- сводка теста: `D:\BIM-TWIN-TEST\xbin-verify\r149-cloud-register-test.json`
  (PASS 17 / FAIL 0 / SKIP 0; реальные результаты внутри поля `real`);
- JSON реальных прогонов: `D:\BIM-TWIN-TEST\xbin-verify\r149-real-facade-box.json`,
  `r149-real-interior-box.json`, `r149-real-facade-box-auto.json`,
  `r149-real-interior.json` (полные map + кроп);
- в git не коммитил, UI не трогал, чужие файлы не менял.
