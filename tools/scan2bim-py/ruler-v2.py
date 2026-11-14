# -*- coding: utf-8 -*-
"""Обмер облака «линейкой» v2 и честная сверка с BIM-моделью (ревизия 97).

Меряет НЕЗАВИСИМО от модели:
  * высоту этажа (пики плотности по высоте);
  * для каждой стены модели — покрытие облаком (доля длины с точками), выступ облака за торцы,
    толщину по двум модам граней;
  * проёмы по облаку (пустые интервалы) и их ширину;
  * видимую площадь пола по облаку (растр + замыкание) и модель: сумма площадей помещений;
  * габарит пола по осям.

Печатает отчёт и пишет JSON.
   python ruler-v2.py cloud.bin model.json report.json
"""
import json, math, sys
import numpy as np

cloud_path, model_path, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
M = json.load(open(model_path, encoding='utf-8-sig'))
P = np.fromfile(cloud_path, dtype=np.float32).reshape(-1, 6)
PT = P[:, :3].astype(np.float64)[::2]        # прореживаем для скорости
print('точек (прорежено):', len(PT))

# ---------- высота ----------
yv = PT[:, 1]
hist, edges = np.histogram(yv, bins=400)
cen = (edges[:-1] + edges[1:]) / 2
sm = np.convolve(hist, np.array([1, 2, 3, 2, 1], float), mode='same')
peaks = []
for k in range(1, len(sm) - 1):
    if sm[k] >= sm[k - 1] and sm[k] >= sm[k + 1] and sm[k] > sm.max() * 0.04:
        y = float(cen[k])
        if not peaks or abs(y - peaks[-1][0]) > 0.06:
            peaks.append([y, float(sm[k])])
        elif sm[k] > peaks[-1][1]:
            peaks[-1] = [y, float(sm[k])]
low = [p for p in peaks if p[0] < 1.5]
floorY = max(low, key=lambda p: p[1])[0] if low else float(np.percentile(yv, 1))
cand = [p for p in peaks if 2.2 <= p[0] - floorY <= 4.2]
ceilY = max(cand, key=lambda p: p[1])[0] if cand else floorY + 3.0
mLo = np.abs(yv - floorY) <= 0.06
if mLo.sum() > 500:
    floorY = float(np.median(yv[mLo]))
mHi = np.abs(yv - ceilY) <= 0.06
if mHi.sum() > 500:
    ceilY = float(np.median(yv[mHi]))
H_cloud = ceilY - floorY
print('облако: пол %.3f, потолок %.3f, высота %.3f м' % (floorY, ceilY, H_cloud))

# ---------- видимая площадь пола (растр 10 см + замыкание) ----------
fp = PT[(PT[:, 1] > floorY - 0.10) & (PT[:, 1] < floorY + 0.30)]
cell = 0.10
gx = np.floor(fp[:, 0] / cell).astype(int)
gz = np.floor(fp[:, 2] / cell).astype(int)
gx -= gx.min(); gz -= gz.min()
nx, nz = int(gx.max()) + 1, int(gz.max()) + 1
free = np.zeros((nz, nx), bool)
free[gz, gx] = True
for _ in range(2):
    dil = free.copy()
    for ax in (0, 1):
        dil = dil | np.roll(dil, 1, axis=ax) | np.roll(dil, -1, axis=ax)
    ero = dil.copy()
    for ax in (0, 1):
        ero = ero & np.roll(dil, 1, axis=ax) & np.roll(dil, -1, axis=ax)
    free = ero
floor_visible = float(free.sum()) * cell * cell
print('облако: видимая площадь пола %.1f м²' % floor_visible)

# ---------- по каждой стене ----------
rows = []
for w in M['walls']:
    ax, az = w['a']
    ux, uz = w['dir']
    nxv, nzv = -uz, ux
    L = float(w['length'])
    T = float(w['thickness'])
    su = (PT[:, 0] - ax) * ux + (PT[:, 2] - az) * uz
    sn = (PT[:, 0] - ax) * nxv + (PT[:, 2] - az) * nzv
    band = (np.abs(sn) <= max(0.10, T / 2 + 0.10)) & (PT[:, 1] >= floorY + 0.25) & (PT[:, 1] <= ceilY - 0.25)
    m = band & (su >= -0.6) & (su <= L + 0.6)
    # покрытие длины: шаг 0.1 м
    steps = np.arange(0.0, L + 1e-6, 0.10)
    hit = 0
    for s in steps:
        mm = band & (np.abs(su - s) <= 0.07)
        if mm.sum() >= 2:
            hit += 1
    coverage = hit / max(1, len(steps))
    # выступы облака за торцы
    s_sup = su[m]
    if s_sup.size:
        lead = float(np.percentile(s_sup, 1))
        trail = float(np.percentile(s_sup, 99))
        miss0 = max(0.0, -lead)          # облако тянется дальше начала модели
        miss1 = max(0.0, trail - L)      # и дальше торца
    else:
        miss0 = miss1 = 0.0
    # толщина по двум модам
    snm = sn[m]
    T_cloud = None
    if snm.size > 300:
        histn, edgesn = np.histogram(snm, bins=60)
        cenn = (edgesn[:-1] + edgesn[1:]) / 2
        idx = [k for k in range(1, len(histn) - 1) if histn[k] >= histn[k - 1] and histn[k] >= histn[k + 1] and histn[k] > histn.max() * 0.20]
        idx.sort(key=lambda k: -histn[k])
        if len(idx) >= 2:
            a2, b2 = sorted(idx[:2])
            T_cloud = abs(float(cenn[b2] - cenn[a2]))
    # проёмы по облаку: пустые интервалы
    nb = max(8, int(math.ceil(L / 0.10)))
    occ, _ = np.histogram(su[m], bins=nb, range=(0, L))
    med = np.median(occ[occ > 0]) if np.any(occ > 0) else 1
    filled = occ >= max(2, med * 0.20)
    gaps = []
    b0 = None
    for bi, f in enumerate(filled):
        if not f and b0 is None:
            b0 = bi
        elif f and b0 is not None:
            wdt = (bi - b0) * L / nb
            if 0.5 <= wdt <= 3.5:
                gaps.append(round(wdt, 2))
            b0 = None
    rows.append({'wall': len(rows), 'L': round(L, 3), 'T': round(T, 3),
                 'coverage': round(100 * coverage, 0),
                 'T_cloud': None if T_cloud is None else round(T_cloud, 3),
                 'T_err_mm': None if T_cloud is None else round((T - T_cloud) * 1000, 0),
                 'cloud_beyond_start_m': round(miss0, 2), 'cloud_beyond_end_m': round(miss1, 2),
                 'openings_model': len(w.get('openings', [])), 'gaps_cloud': gaps})

cov = [r['coverage'] for r in rows]
terr = [abs(r['T_err_mm']) for r in rows if r['T_err_mm'] is not None]
beyond = [max(r['cloud_beyond_start_m'], r['cloud_beyond_end_m']) for r in rows]
model_area = float(M['stats'].get('floorArea') or 0)
H_model = float(M['storey']['height'])

print('\nстена  L(мод)  T(мод)  покрытие%  T(обл)  T ошибка мм  облако за торцом, м')
for r in rows:
    print('  %2d   %6.2f  %6.3f   %5.0f      %6s   %6s      %.2f' % (
        r['wall'], r['L'], r['T'], r['coverage'],
        ('%.3f' % r['T_cloud']) if r['T_cloud'] else '—',
        ('%.0f' % r['T_err_mm']) if r['T_err_mm'] is not None else '—',
        max(r['cloud_beyond_start_m'], r['cloud_beyond_end_m'])))

print('\n=== СВОДКА ===')
print('стен: модель %d, обмерено %d' % (len(M['walls']), len(rows)))
print('покрытие стен облаком: медиана %.0f %%, минимум %.0f %%' % (np.median(cov), min(cov)))
print('толщина: медиана ошибки %.0f мм, максимум %.0f мм' % (np.median(terr) if terr else -1, max(terr) if terr else -1))
print('высота: модель %.3f, облако %.3f, ошибка %.0f мм' % (H_model, H_cloud, (H_model - H_cloud) * 1000))
print('площадь помещений: модель %.1f м², видимый пол облака %.1f м² (разница %.1f м²)' % (
    model_area, floor_visible, model_area - floor_visible))
print('стены, у которых облако продолжается за торец: %d из %d (медиана %.2f м)' % (
    sum(1 for b in beyond if b > 0.25), len(beyond), np.median(beyond) if beyond else 0))

json.dump({'cloud': {'floorY': round(floorY, 3), 'ceilY': round(ceilY, 3), 'height': round(H_cloud, 3),
                     'floor_visible_m2': round(floor_visible, 1)},
           'model': {'height': round(H_model, 3), 'rooms_area': model_area,
                     'walls': len(M['walls']), 'openings': int(M['stats'].get('openingCount') or 0),
                     'rooms': int(M['stats'].get('roomCount') or 0)},
           'walls': rows,
           'summary': {'median_coverage_pct': float(np.median(cov)) if cov else None,
                       'min_coverage_pct': float(min(cov)) if cov else None,
                       'median_T_err_mm': float(np.median(terr)) if terr else None,
                       'max_T_err_mm': float(max(terr)) if terr else None,
                       'height_err_mm': (H_model - H_cloud) * 1000,
                       'area_diff_m2': model_area - floor_visible,
                       'walls_cloud_beyond': int(sum(1 for b in beyond if b > 0.25))}},
          open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('JSON:', out_json)
