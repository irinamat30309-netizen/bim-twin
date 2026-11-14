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
# площадь пола, доступная помещениям: вычитаем следы стен (половина толщины)
_nx0, _nz0 = gx.min(), gz.min()
_gxc = (_nx0 + np.arange(nx) + 0.5) * cell
_gzc = (_nz0 + np.arange(nz) + 0.5) * cell
_GX, _GZ = np.meshgrid(_gxc, _gzc)
_wallfree = np.ones((nz, nx), bool)
for _w in M['walls']:
    _ax, _az = _w['a']
    _ux, _uz = _w['dir']
    _nxv, _nzv = -_uz, _ux
    _half = float(_w['thickness']) / 2.0 + 0.02
    _Lw = float(_w['length'])
    _suw = (_GX - _ax) * _ux + (_GZ - _az) * _uz
    _snw = (_GX - _ax) * _nxv + (_GZ - _az) * _nzv
    _wallfree &= ~((_suw >= -_half) & (_suw <= _Lw + _half) & (np.abs(_snw) <= _half))
floor_free = free & _wallfree
# свободный пол считаем ВНУТРИ габарита стен (вне контура помещений быть не может)
try:
    from shapely.geometry import MultiPoint as _MP, Polygon as _Poly2
    _pts = []
    for _w in M['walls']:
        _pts.append(tuple(_w['a'])); _pts.append(tuple(_w['b']))
    _env = _MP(_pts).convex_hull.buffer(-0.05)
    _ox = float(np.floor(fp[:, 0].min() / cell)) * cell
    _oz = float(np.floor(fp[:, 2].min() / cell)) * cell
    _inside_env = np.zeros((nz, nx), bool)
    for _zi in range(nz):
        for _xi in range(nx):
            _px = _ox + (_xi + 0.5) * cell
            _pz = _oz + (_zi + 0.5) * cell
            if _env.contains(_Poly2([(_px, _pz), (_px + 0.01, _pz), (_px + 0.01, _pz + 0.01), (_px, _pz + 0.01)]).centroid):
                _inside_env[_zi, _xi] = True
    floor_free = floor_free & _inside_env
except Exception as _e2:
    print('габарит стен: пропущено', _e2)
floor_visible = float(floor_free.sum()) * cell * cell
floor_pts_area = float(free.sum()) * cell * cell
print('облако: точки пола %.1f м², из них без следов стен %.1f м²' % (floor_pts_area, floor_visible))

# ---------- по каждой стене ----------
rows = []
_inferred_cnt = sum(1 for w in M['walls'] if w.get('inferred') or w.get('material') == 'inferred')
print('достроенных стен (без поддержки облаком): %d из %d' % (_inferred_cnt, len(M['walls'])))
for w in M['walls']:
    if w.get('inferred') or w.get('material') == 'inferred':
        continue
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
    # покрытие считаем только по сплошным участкам: проёмы модели исключаем
    _ops = [(float(o.get('along', 0)), float(o.get('along', 0)) + float(o.get('width', 0)))
            for o in w.get('openings', [])]
    steps = np.arange(0.0, L + 1e-6, 0.10)
    hit = 0
    total = 0
    for s in steps:
        if any(s0o - 0.10 <= s <= s1o + 0.10 for (s0o, s1o) in _ops):
            continue
        total += 1
        mm = band & (np.abs(su - s) <= 0.07)
        if mm.sum() >= 2:
            hit += 1
    coverage = hit / max(1, total)
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
    # толщина по облаку — независимо от модели: полоса ±55 см, две самые сильные моды
    band2 = (np.abs(sn) <= 0.55) & (PT[:, 1] >= floorY + 0.20) & (PT[:, 1] <= ceilY - 0.20) & \
            (su >= 0) & (su <= L)
    T_cloud = None
    if band2.sum() > 300:
        snm2 = sn[band2]
        histn, edgesn = np.histogram(snm2, bins=110, range=(-0.55, 0.55))
        cenn = (edgesn[:-1] + edgesn[1:]) / 2
        idx = [k for k in range(1, len(histn) - 1) if histn[k] >= histn[k - 1] and histn[k] >= histn[k + 1] and histn[k] > histn.max() * 0.18]
        idx.sort(key=lambda k: -histn[k])
        if len(idx) >= 2:
            cand = None
            for _ia in range(len(idx)):
                for _ib in range(_ia + 1, len(idx)):
                    _a2, _b2 = sorted((idx[_ia], idx[_ib]))
                    _th = abs(float(cenn[_b2] - cenn[_a2]))
                    if not (0.06 <= _th <= 0.60):
                        continue
                    _mid = (cenn[_a2] + cenn[_b2]) / 2.0
                    _score = abs(_mid) * 6.0 - min(histn[_a2], histn[_b2]) / max(1.0, histn.max())
                    if cand is None or _score < cand[0]:
                        cand = (_score, _th)
            if cand:
                T_cloud = cand[1]
    # проёмы по облаку: пустые интервалы
    nb = max(8, int(math.ceil(L / 0.10)))
    occ, _ = np.histogram(su[m], bins=nb, range=(0, L))
    med = np.median(occ[occ > 0]) if np.any(occ > 0) else 1
    filled = occ >= max(2, med * 0.20)
    gaps = []
    def _push_gap(_b0, _b1):
        wdt = (_b1 - _b0) * L / nb
        _st = _b0 * L / nb
        # разрыв у торца стены — край области скана/стены, а не проём
        if 0.6 <= wdt <= 2.5 and _st >= 0.25 and _st + wdt <= L - 0.25:
            gaps.append({'start': round(_st, 2), 'width': round(wdt, 2)})
    b0 = None
    for bi, f in enumerate(filled):
        if not f and b0 is None:
            b0 = bi
        elif f and b0 is not None:
            _push_gap(b0, bi)
            b0 = None
    if b0 is not None:
        _push_gap(b0, nb)
    rows.append({'wall': len(rows), 'L': round(L, 3), 'T': round(T, 3),
                 'coverage': round(100 * coverage, 0),
                 'T_cloud': None if T_cloud is None else round(T_cloud, 3),
                 'T_err_mm': None if T_cloud is None else round((T - T_cloud) * 1000, 0),
                 'cloud_beyond_start_m': round(miss0, 2), 'cloud_beyond_end_m': round(miss1, 2),
                 'openings_model': [{'start': round(float(o.get('along', 0)), 2), 'width': round(float(o.get('width', 0)), 2)} for o in w.get('openings', [])],
                 'n_openings_model': len(w.get('openings', [])), 'gaps_cloud': gaps})

# --- проёмы: полнота (recall) и точность (precision) ---
def _ov(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))

op_tp = 0
op_fn = 0
op_fp = 0
op_width_err = []
for r in rows:
    mods = r['openings_model']
    gaps = r['gaps_cloud']
    used = [False] * len(mods)
    for g in gaps:
        g0, g1 = g['start'], g['start'] + g['width']
        best = None
        for k, mo in enumerate(mods):
            if used[k]:
                continue
            m0, m1 = mo['start'], mo['start'] + mo['width']
            ov = _ov(g0, g1, m0, m1)
            if ov / max(0.1, min(m1 - m0, g1 - g0)) >= 0.5:
                if best is None or ov > best[0]:
                    best = (ov, k, mo)
        if best:
            used[best[1]] = True
            op_tp += 1
            op_width_err.append(abs(best[2]['width'] - g['width']))
        else:
            op_fn += 1
    op_fp += sum(1 for u in used if not u)
recall = 100.0 * op_tp / max(1, op_tp + op_fn)
precision = 100.0 * op_tp / max(1, op_tp + op_fp)
print('проёмы: облако %d, модель %d | совпало %d | полнота %.0f %% | точность %.0f %% | ширина: медиана ошибки %.0f мм' % (
    op_tp + op_fn, op_tp + op_fp, op_tp, recall, precision,
    1000 * (np.median(op_width_err) if op_width_err else -1)))

# --- помещения: доля площади вне видимого пола и наложения ---
try:
    from shapely.geometry import Polygon as _Poly
    from shapely.ops import unary_union as _union
    _floor_cells = set()
    for _x, _z in fp[:, [0, 2]]:
        _floor_cells.add((int(round(_x / 0.20)), int(round(_z / 0.20))))
    _outside = 0
    _total = 0
    for _rm in M.get('rooms', []):
        _poly = _rm.get('polygon') or []
        if len(_poly) < 3:
            continue
        _P = _Poly(_poly)
        _minx, _minz, _maxx, _maxz = _P.bounds
        _step = 0.4
        _xo = _minx
        while _xo <= _maxx:
            _zo = _minz
            while _zo <= _maxz:
                if _P.contains(_Poly([(_xo, _zo), (_xo + 0.1, _zo), (_xo + 0.1, _zo + 0.1), (_xo, _zo + 0.1)]).centroid):
                    _total += 1
                    _ci = int(round(_xo / 0.20)); _cj = int(round(_zo / 0.20))
                    if not any((_ci + _di, _cj + _dj) in _floor_cells for _di in (-1, 0, 1) for _dj in (-1, 0, 1)):
                        _outside += 1
                _zo += _step
            _xo += _step
    polies = [_Poly(r['polygon']) for r in M.get('rooms', []) if len(r.get('polygon') or []) >= 3]
    _inter = 0.0
    for _i in range(len(polies)):
        for _j in range(_i + 1, len(polies)):
            _inter += polies[_i].intersection(polies[_j]).area
    print('помещения: вне видимого пола %.1f %% | наложение комнат %.1f м²' % (
        100.0 * _outside / max(1, _total), _inter))
except Exception as _e:
    print('помещения: проверка пропущена', _e)

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
print('стен: модель %d (в т.ч. достроенных %d), обмерено облаком %d' % (len(M['walls']), _inferred_cnt, len(rows)))
print('покрытие стен облаком: медиана %.0f %%, минимум %.0f %%' % (np.median(cov), min(cov)))
print('толщина: медиана ошибки %.0f мм, максимум %.0f мм' % (np.median(terr) if terr else -1, max(terr) if terr else -1))
print('высота: модель %.3f, облако %.3f, ошибка %.0f мм' % (H_model, H_cloud, (H_model - H_cloud) * 1000))
print('площадь помещений: модель %.1f м², видимый пол облака %.1f м² (разница %.1f м²)' % (
    model_area, floor_visible, model_area - floor_visible))
print('стены, у которых облако продолжается за торец: %d из %d (медиана %.2f м)' % (
    sum(1 for b in beyond if b > 0.25), len(beyond), np.median(beyond) if beyond else 0))

# ---------- полнота модели: доля периметра помещений, закрытая стенами ----------
def _pt_seg_dist(px, pz, ax, az, bx, bz):
    vx, vz = bx - ax, bz - az
    L2 = vx * vx + vz * vz
    if L2 <= 1e-9:
        return math.hypot(px - ax, pz - az)
    tt = ((px - ax) * vx + (pz - az) * vz) / L2
    tt = max(0.0, min(1.0, tt))
    return math.hypot(px - (ax + vx * tt), pz - (az + vz * tt))

_per_tot = 0.0
_per_hit = 0.0
_walls_ab = [(w['a'][0], w['a'][1], w['b'][0], w['b'][1]) for w in M['walls']]
for rm in M.get('rooms', []):
    poly = rm.get('polygon') or []
    if len(poly) < 3:
        continue
    for i2 in range(len(poly)):
        x0, z0 = poly[i2]
        x1, z1 = poly[(i2 + 1) % len(poly)]
        seg = math.hypot(x1 - x0, z1 - z0)
        if seg < 1e-6:
            continue
        n2 = max(1, int(seg / 0.2))
        for k2 in range(n2):
            f2 = (k2 + 0.5) / n2
            px = x0 + (x1 - x0) * f2
            pz = z0 + (z1 - z0) * f2
            dmin = min(_pt_seg_dist(px, pz, *wa) for wa in _walls_ab) if _walls_ab else 99
            _per_tot += seg / n2
            if dmin <= 0.15:
                _per_hit += seg / n2
perim_cov = 100.0 * _per_hit / max(1e-9, _per_tot)
print('периметр помещений, закрытый стенами: %.0f %% (%.1f из %.1f м)' % (perim_cov, _per_hit, _per_tot))

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
                       'walls_cloud_beyond': int(sum(1 for b in beyond if b > 0.25)),
                       'room_perimeter_covered_pct': round(perim_cov, 1), 'room_perimeter_m': round(_per_tot, 1)}},
          open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('JSON:', out_json)
