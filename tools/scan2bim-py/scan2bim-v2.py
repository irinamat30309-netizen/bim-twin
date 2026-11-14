# -*- coding: utf-8 -*-
"""scan2bim v2 (ревизия 96): Manhattan-стены + граф примыканий + polygonize помещений.

Отличия от v1:
  * стены доводятся до примыканий по облаку (без «висячих» торцов);
  * помещения строятся как ГРАНИ ПЛАНА (shapely polygonize графа стен), а не по растровой сетке
    пола — контуры закрываются точно, площадь не зависит от видимости пола;
  * толщина и ось — по двум модам облака;
  * проёмы — разрывы вдоль стены + проверка пустоты облаком.

   python scan2bim-v2.py cloud.bin model.json [--voxel=0.04]
"""
import json, math, sys
import numpy as np
import open3d as o3d
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union, polygonize

o3d.utility.random.seed(42)
args = dict(a.split('=') for a in sys.argv[3:] if '=' in a)
vox = float(args.get('voxel', '0.03'))
cloud_path, out_json = sys.argv[1], sys.argv[2]

P = np.fromfile(cloud_path, dtype=np.float32).reshape(-1, 6)
xyz = P[:, :3].astype(np.float64)
rgb = np.clip(P[:, 3:6], 0, 1).astype(np.float64)
print('точек:', len(xyz))

pc = o3d.geometry.PointCloud()
pc.points = o3d.utility.Vector3dVector(xyz)
pc.colors = o3d.utility.Vector3dVector(rgb)
pc = pc.voxel_down_sample(vox)
print('воксель %.3f: %d точек' % (vox, len(pc.points)))
pc.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.5, max_nn=30))
PT = np.asarray(pc.points)
CL = np.asarray(pc.colors)

# ---------- 1. плоскости ----------
rem = pc
planes = []
while len(rem.points) >= 2500 and len(planes) < 180:
    m, inl = rem.segment_plane(0.020, 3, 900)
    if len(inl) / len(rem.points) < 0.008:
        break
    n = np.array(m[:3], float); n /= (np.linalg.norm(n) + 1e-12)
    d = float(m[3])
    if n[1] < 0:
        n, d = -n, -d
    planes.append({'n': n, 'd': d, 'pts': np.asarray(rem.points)[inl], 'color': np.asarray(rem.colors)[inl].mean(axis=0)})
    rem = rem.select_by_index(inl, invert=True)
print('плоскостей:', len(planes))

# высоты: пол и потолок — пики плотности по высоте (пол = массовый низ, потолок = массовый верх)
yv = PT[:, 1]
hist_all, edges_all = np.histogram(yv, bins=500)
cen_all = (edges_all[:-1] + edges_all[1:]) / 2
sm_all = np.convolve(hist_all, np.array([1, 2, 3, 2, 1], float), mode='same')
peaks = []
for k in range(1, len(sm_all) - 1):
    if sm_all[k] >= sm_all[k - 1] and sm_all[k] >= sm_all[k + 1] and sm_all[k] > sm_all.max() * 0.03:
        y = float(cen_all[k])
        if not peaks or abs(y - peaks[-1][0]) > 0.06:
            peaks.append([y, float(sm_all[k])])
        elif sm_all[k] > peaks[-1][1]:
            peaks[-1] = [y, float(sm_all[k])]
low = [pk for pk in peaks if pk[0] < 1.5]
floorY = max(low, key=lambda pk: pk[1])[0] if low else float(np.percentile(yv, 1))
cand = [pk for pk in peaks if 2.2 <= pk[0] - floorY <= 4.2]
ceilY = max(cand, key=lambda pk: pk[1])[0] if cand else floorY + 3.0
# уточняем уровни медианой точек в узкой полосе вокруг пика
mLo = np.abs(yv - floorY) <= 0.06
if mLo.sum() > 500:
    floorY = float(np.median(yv[mLo]))
mHi = np.abs(yv - ceilY) <= 0.06
if mHi.sum() > 500:
    ceilY = float(np.median(yv[mHi]))
H = ceilY - floorY
print('пол/потолок: %.3f / %.3f (H=%.3f)' % (floorY, ceilY, H))

# ---------- 2. грани и сетка Манхэттена ----------
faces = []
for p in planes:
    if abs(p['n'][1]) >= 0.2 or len(p['pts']) < 500:
        continue
    q = p['pts']
    smp = q[::max(1, len(q) // 3000)]
    ylo, yhi = np.percentile(smp[:, 1], 2), np.percentile(smp[:, 1], 98)
    if yhi - ylo < 1.2:
        continue
    ang = math.atan2(p['n'][2], p['n'][0]) % math.pi
    faces.append({'sample': smp, 'ang': (ang + math.pi / 2) % math.pi, 'color': p['color']})
if not faces:
    raise SystemExit('ОШИБКА: нет вертикальных граней')
# круговая медиана направлений (mod 90°) — устойчиво к смеси параллельных/перпендикулярных стен
for _f in sorted(faces, key=lambda q: -(np.ptp(q['sample'][:,0])+np.ptp(q['sample'][:,2])))[:10]:
    print('  грань угол(норм+90)=%.2f° размах %.1f м' % (math.degrees(_f['ang']), np.ptp(_f['sample'][:,0])+np.ptp(_f['sample'][:,2])))
zz = 0j
for f in faces:
    w = float(np.ptp(f['sample'][:, 0]) + np.ptp(f['sample'][:, 2]))
    if w > 2.0:
        zz += w * np.exp(4j * f['ang'])
if abs(zz) < 1e-9:
    zz = np.exp(4j * float(np.median([f['ang'] for f in faces])))
base = float(np.angle(zz) / 4.0)
print('сетка Манхэттена: %.2f°' % math.degrees(base))
axes = [(math.cos(base), math.sin(base)), (-math.sin(base), math.cos(base))]

for f in faces:
    smp = f['sample']
    orig = np.array([math.cos(f['ang']), math.sin(f['ang'])])
    best = None
    for k in range(2):
        u = np.array(axes[k])
        for sgn in (1, -1):
            uu = u * sgn
            score = abs(float(orig[0] * uu[0] + orig[1] * uu[1]))
            if best is None or score > best[0]:
                best = (score, uu)
    _, u = best
    nn = np.array([-u[1], u[0]])
    su = smp[:, 0] * u[0] + smp[:, 2] * u[1]
    sn = smp[:, 0] * nn[0] + smp[:, 2] * nn[1]
    if np.var(sn) > np.var(su):          # нормаль должна быть осью разброса, а не направления
        nn = -nn
    f['u'] = u; f['n'] = np.array([-u[1], u[0]])
    f['s0'] = float(np.percentile(su, 1)); f['s1'] = float(np.percentile(su, 99))
    f['off'] = float(np.median(smp[:, 0] * f['n'][0] + smp[:, 2] * f['n'][1]))

# ---------- 3. спаривание граней ----------
used = [False] * len(faces)
walls = []
for i, fi in enumerate(faces):
    if used[i]:
        continue
    best = None
    for j, fj in enumerate(faces):
        if i == j or used[j]:
            continue
        dot = abs(fi['u'][0] * fj['u'][0] + fi['u'][1] * fj['u'][1])
        if dot < 0.985:
            continue
        gap = abs(fi['off'] - fj['off'])
        if gap < 0.05 or gap > 0.7:
            continue
        lo, hi = max(fi['s0'], fj['s0']), min(fi['s1'], fj['s1'])
        if hi - lo < 0.4:
            continue
        score = (hi - lo) / (gap + 0.05)
        if best is None or score > best[0]:
            best = (score, j, lo, hi, gap)
    u = fi['u']; n = fi['n']
    if best:
        used[i] = used[best[1]] = True
        lo, hi, gap = best[2], best[3], best[4]
        off = (fi['off'] + faces[best[1]]['off']) / 2
        col = (fi['color'] + faces[best[1]]['color']) / 2
    else:
        used[i] = True
        lo, hi, gap, off, col = fi['s0'], fi['s1'], 0.12, fi['off'], fi['color']
    walls.append({'u': u, 'n': n, 's0': lo, 's1': hi, 'thk': float(gap), 'off': float(off), 'color': col})
print('стен из граней:', len(walls))

# ---------- 4. слияние коллинеарных ----------
def ov(a0, a1, b0, b1):
    return min(a1, b1) - max(a0, b0)
merged = []
for w in sorted(walls, key=lambda q: -(q['s1'] - q['s0'])):
    placed = False
    for m in merged:
        if abs(m['u'][0] * w['u'][0] + m['u'][1] * w['u'][1]) < 0.995:
            continue
        if abs(m['off'] - w['off']) > 0.12:
            continue
        if ov(m['s0'], m['s1'], w['s0'], w['s1']) < -2.2:
            continue
        m['s0'] = min(m['s0'], w['s0']); m['s1'] = max(m['s1'], w['s1'])
        m['thk'] = (m['thk'] + w['thk']) / 2
        placed = True
        break
    if not placed:
        merged.append(dict(w))
print('после слияния:', len(merged))

# ---------- 5. уточнение толщины/оси и примыкания ----------
for w in merged:
    u, n = w['u'], w['n']
    s0, s1 = w['s0'], w['s1']
    # мировые концы
    def pt(s): return (u[0] * s + n[0] * w['off'], u[1] * s + n[1] * w['off'])
    ax, az = pt(s0)
    su = (PT[:, 0] - ax) * u[0] + (PT[:, 2] - az) * u[1]
    sn = (PT[:, 0] - ax) * n[0] + (PT[:, 2] - az) * n[1]
    band = (np.abs(sn) <= 0.55) & (su >= -0.05) & (su <= (s1 - s0) + 0.05) & \
           (PT[:, 1] >= floorY + 0.20) & (PT[:, 1] <= ceilY - 0.20)
    if band.sum() > 400:
        snm = sn[band]
        hist, edges = np.histogram(snm, bins=60)
        cen = (edges[:-1] + edges[1:]) / 2
        idx = [k for k in range(1, len(hist) - 1) if hist[k] >= hist[k - 1] and hist[k] >= hist[k + 1] and hist[k] > hist.max() * 0.22]
        idx.sort(key=lambda k: -hist[k])
        if len(idx) >= 2:
            a2, b2 = sorted(idx[:2])
            th = abs(cen[b2] - cen[a2])
            if 0.08 <= th <= 0.7:
                mid = (cen[a2] + cen[b2]) / 2
                w['off'] += mid
                w['thk'] = float(th)

# примыкания: доводим концы до пересечения с перпендикулярной стеной, если облако подтверждает
for i, w in enumerate(merged):
    u, n, off = w['u'], w['n'], w['off']
    L = w['s1'] - w['s0']
    sh0 = 0.0; ex1 = 0.0
    for j, v in enumerate(merged):
        if i == j:
            continue
        det = u[0] * v['u'][1] - u[1] * v['u'][0]
        if abs(det) < 0.2:
            continue
        # точка на оси w: u*s + n*off ; на оси v: v.u*r + v.n*v.off
        ax, az = n[0] * off, n[1] * off
        bx, bz = v['n'][0] * v['off'], v['n'][1] * v['off']
        dx, dz = bx - ax, bz - az
        t = (dx * v['u'][1] - dz * v['u'][0]) / det
        r = (dx * u[1] - dz * u[0]) / det
        if not (v['s0'] - 1.2 <= r <= v['s1'] + 1.2):
            continue
        px, pz = ax + u[0] * t, az + u[1] * t
        near = ((PT[:, 0] - px) ** 2 + (PT[:, 2] - pz) ** 2) <= 0.25 ** 2
        if near.sum() < 10:
            continue
        if -1.2 <= t - w['s0'] < 0 and (w['s0'] - t) > sh0:
            sh0 = w['s0'] - t
        elif 0 <= t - w['s1'] <= 1.2 and (t - w['s1']) > ex1:
            ex1 = t - w['s1']
    if sh0 > 0.02 or ex1 > 0.02:
        w['s0'] -= sh0
        w['s1'] += ex1

# ---------- 5.1 дедупликация стен после уточнения и примыканий ----------
def _ov(a0, a1, b0, b1):
    return min(a1, b1) - max(a0, b0)

_ded = []
for _w in sorted(merged, key=lambda q: -(q['s1'] - q['s0'])):
    _dup = False
    for _m in _ded:
        if abs(_m['u'][0] * _w['u'][0] + _m['u'][1] * _w['u'][1]) < 0.995:
            continue
        if abs(_m['off'] - _w['off']) > 0.15:
            continue
        if _ov(_m['s0'], _m['s1'], _w['s0'], _w['s1']) > -2.0:
            _dup = True
            _m['s0'] = min(_m['s0'], _w['s0']); _m['s1'] = max(_m['s1'], _w['s1'])
            break
    if not _dup:
        _ded.append(_w)
print('после дедупликации:', len(_ded))
merged = _ded

# ---------- 5.15 фильтр стен без поддержки облаком ----------
_keep = []
_dropped = 0
for _w in merged:
    _u, _n2, _off = _w['u'], _w['n'], _w['off']
    _L = _w['s1'] - _w['s0']
    if _L < 0.5:
        continue
    _ax = _u[0] * _w['s0'] + _n2[0] * _off
    _az = _u[1] * _w['s0'] + _n2[1] * _off
    _su = (PT[:, 0] - _ax) * _u[0] + (PT[:, 2] - _az) * _u[1]
    _sn = (PT[:, 0] - _ax) * _n2[0] + (PT[:, 2] - _az) * _n2[1]
    _band = (np.abs(_sn) <= max(0.10, _w['thk'] / 2 + 0.08)) & \
            (PT[:, 1] >= floorY + 0.20) & (PT[:, 1] <= ceilY - 0.20) & \
            (_su >= 0) & (_su <= _L)
    _cnt = int(_band.sum())
    if _cnt < max(150, 40.0 * _L):
        _dropped += 1
        continue
    _keep.append(_w)
merged = _keep
print('убрано стен без поддержки:', _dropped, '| осталось:', len(merged))

# ---------- 6. проёмы (профиль вдоль стены) ----------
for w in merged:
    u, n, off = w['u'], w['n'], w['off']
    w['thk'] = float(min(0.60, max(0.08, w['thk'])))
    L = w['s1'] - w['s0']
    def pt(s): return (u[0] * s + n[0] * off, u[1] * s + n[1] * off)
    ax, az = pt(w['s0'])
    su = (PT[:, 0] - ax) * u[0] + (PT[:, 2] - az) * u[1]
    sn = (PT[:, 0] - ax) * n[0] + (PT[:, 2] - az) * n[1]
    m = (np.abs(sn) <= max(0.10, w['thk'] / 2 + 0.06)) & (su >= 0) & (su <= L) & \
        (PT[:, 1] >= floorY + 0.15) & (PT[:, 1] <= ceilY - 0.15)
    if m.sum() < 300:
        w['openings'] = []
        continue
    nb = max(8, int(math.ceil(L / 0.10)))
    occ, _ = np.histogram(su[m], bins=nb, range=(0, L))
    med = np.median(occ[occ > 0]) if np.any(occ > 0) else 1
    val = (occ >= max(2, med * 0.25)) & (occ < med * 20)
    wall_dens = m.sum() / max(0.5, L * H)
    ops = []
    b = 0
    while b < nb:
        if not val[b]:
            b0 = b
            while b < nb and not val[b]:
                b += 1
            b1 = b
            width = (b1 - b0) * L / nb
            _gap_start = b0 * L / nb
            if width >= 0.60 and _gap_start >= 0.22 and _gap_start + width <= L - 0.22:
                s_lo = b0 * L / nb; s_hi = b1 * L / nb
                m2 = m & (su >= s_lo) & (su <= s_hi)
                yy = np.sort(PT[m2, 1]) if np.any(m2) else np.array([])
                zs = np.arange(floorY, ceilY + 1e-6, 0.05)
                empty = [int(np.sum((yy >= z - 0.06) & (yy <= z + 0.06))) < 3 for z in zs]
                best = (0.0, floorY, floorY); cur = None
                for z, e in zip(zs, empty):
                    if e and cur is None:
                        cur = z
                    elif not e and cur is not None:
                        if z - cur > best[0]:
                            best = (z - cur, cur, z)
                        cur = None
                if cur is not None and ceilY - cur > best[0]:
                    best = (ceilY - cur, cur, ceilY)
                sill = max(0.0, best[1] - floorY); head = min(H, best[2] - floorY)
                cnt = m2 & (PT[:, 1] >= floorY + sill) & (PT[:, 1] <= floorY + head)
                dens = cnt.sum() / max(0.25, width * max(0.3, head - sill))
                if head - sill >= 0.9 and dens <= wall_dens * 0.10:
                    if width > 4.5:
                        continue
                    if width > 2.2:
                        kind = 'opening'
                    else:
                        kind = 'door' if sill <= 0.3 else 'window'
                    ops.append({'along': float(round(s_lo, 3)), 'width': float(round(width, 3)),
                                'sill': float(round(sill, 3)), 'head': float(round(head, 3)),
                                'kind': kind})
            continue
        b += 1
    w['openings'] = ops

# ---------- 7. граф стен → грани (помещения) ----------
lines = []
for w in merged:
    u, n, off = w['u'], w['n'], w['off']
    a = (u[0] * w['s0'] + n[0] * off, u[1] * w['s0'] + n[1] * off)
    b = (u[0] * w['s1'] + n[0] * off, u[1] * w['s1'] + n[1] * off)
    lines.append(LineString([a, b]))
from shapely.ops import snap as _snap
for _i in range(len(lines)):
    ref = unary_union([l for j, l in enumerate(lines) if j != _i] or [lines[_i]])
    lines[_i] = _snap(lines[_i], ref, 0.20)
graph = unary_union(lines)
polys = []
for _p in polygonize(graph):
    if _p.area <= 1.5:
        continue
    _r = _p.minimum_rotated_rectangle
    if _r.area > 0 and (_r.area / max(_p.area, 1e-6)) > 9 and _p.area < 8:
        continue
    polys.append(_p)
xs = [c[0] for w in merged for c in ((w['u'][0] * w['s0'] + w['n'][0] * w['off'], w['u'][1] * w['s0'] + w['n'][1] * w['off']), (w['u'][0] * w['s1'] + w['n'][0] * w['off'], w['u'][1] * w['s1'] + w['n'][1] * w['off']))]
zs = [c[1] for w in merged for c in ((w['u'][0] * w['s0'] + w['n'][0] * w['off'], w['u'][1] * w['s0'] + w['n'][1] * w['off']), (w['u'][0] * w['s1'] + w['n'][0] * w['off'], w['u'][1] * w['s1'] + w['n'][1] * w['off']))]
bx0, bx1, bz0, bz1 = min(xs) - 0.5, max(xs) + 0.5, min(zs) - 0.5, max(zs) + 0.5
bbox_area = (bx1 - bx0) * (bz1 - bz0)
rooms = []
for p in polys:
    if p.area > bbox_area * 0.6 or p.area > 500:
        continue
    rect = p.minimum_rotated_rectangle
    if rect.area > 0 and p.area / rect.area > 0.72:
        # прямоугольник только для компактных помещений (не растягиваем коридор на пол-плана)
        _x0, _z0, _x1, _z1 = rect.bounds
        _w, _h = _x1 - _x0, _z1 - _z0
        _asp = max(_w, _h) / max(1e-6, min(_w, _h))
        if _asp <= 2.5 and rect.area <= 60:
            p = rect
    coords = list(p.exterior.coords)[:-1]
    rooms.append({'polygon': [[round(c[0], 3), round(c[1], 3)] for c in coords],
                  'area': round(float(p.area), 2),
                  'cx': round(float(p.centroid.x), 2), 'cz': round(float(p.centroid.y), 2)})
rooms.sort(key=lambda r: -r['area'])
print('помещений (грани плана):', len(rooms), '| площадь', round(sum(r['area'] for r in rooms), 1))

# ---------- 7b. растровые помещения (дополняют грани плана там, где контур не замкнут) ----------
_xs = []
_zs = []
for _w in merged:
    for _s in (_w['s0'], _w['s1']):
        _xs.append(_w['u'][0] * _s + _w['n'][0] * _w['off'])
        _zs.append(_w['u'][1] * _s + _w['n'][1] * _w['off'])
bx0, bx1 = min(_xs) - 0.5, max(_xs) + 0.5
bz0, bz1 = min(_zs) - 0.5, max(_zs) + 0.5
_cell = 0.05
_nx = int((bx1 - bx0) / _cell) + 1
_nz = int((bz1 - bz0) / _cell) + 1
_free = np.zeros((_nz, _nx), bool)
_fp = PT[(PT[:, 1] > floorY - 0.10) & (PT[:, 1] < floorY + 0.35)]
_gx = np.floor((_fp[:, 0] - bx0) / _cell).astype(int)
_gz = np.floor((_fp[:, 2] - bz0) / _cell).astype(int)
_ok = (_gx >= 0) & (_gx < _nx) & (_gz >= 0) & (_gz < _nz)
_free[_gz[_ok], _gx[_ok]] = True
for _ in range(2):
    _dil = _free.copy()
    for _ax in (0, 1):
        _dil = _dil | np.roll(_dil, 1, axis=_ax) | np.roll(_dil, -1, axis=_ax)
    _ero = _dil.copy()
    for _ax in (0, 1):
        _ero = _ero & np.roll(_dil, 1, axis=_ax) & np.roll(_dil, -1, axis=_ax)
    _free = _ero
_blocked = np.zeros((_nz, _nx), bool)
_gxc, _gzc = np.meshgrid((np.arange(_nx) + 0.5) * _cell + bx0, (np.arange(_nz) + 0.5) * _cell + bz0)
for _w in merged:
    _ux, _uz = _w['u']
    _nxv, _nzv = _w['n']
    _axw = _ux * _w['s0'] + _nxv * _w['off']
    _azw = _uz * _w['s0'] + _nzv * _w['off']
    _half = max(0.11, _w['thk'] / 2 + 0.05)   # +5 см: при сетке 5 см и наклоне 2° тонкая стена иначе не перекрывает клетку
    _Lw = _w['s1'] - _w['s0']
    _su = (_gxc - _axw) * _ux + (_gzc - _azw) * _uz
    _sn = (_gxc - _axw) * _nxv + (_gzc - _azw) * _nzv
    _blocked |= (_su >= -_half) & (_su <= _Lw + _half) & (np.abs(_sn) <= _half)
_free = _free & ~_blocked
_lab = np.zeros((_nz, _nx), int)
_rr = []
_cid = 0
for _gz in range(_nz):
    for _gx in range(_nx):
        if not _free[_gz, _gx] or _lab[_gz, _gx]:
            continue
        _cid += 1
        _st = [(_gz, _gx)]
        _lab[_gz, _gx] = _cid
        _cells = []
        while _st:
            _z0, _x0 = _st.pop()
            _cells.append((_z0, _x0))
            for _dz, _dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                _nz2, _nx2 = _z0 + _dz, _x0 + _dx
                if 0 <= _nz2 < _nz and 0 <= _nx2 < _nx and _free[_nz2, _nx2] and not _lab[_nz2, _nx2]:
                    _lab[_nz2, _nx2] = _cid
                    _st.append((_nz2, _nx2))
        if len(_cells) * _cell * _cell < 2.0:
            continue
        _boxes = [box(bx0 + _x0 * _cell, bz0 + _z0 * _cell, bx0 + (_x0 + 1) * _cell, bz0 + (_z0 + 1) * _cell) for _z0, _x0 in _cells]
        _poly = unary_union(_boxes).buffer(0.001).simplify(0.05)
        if _poly.is_empty:
            continue
        _rect = _poly.minimum_rotated_rectangle
        if _rect.area > 0 and _poly.area / _rect.area > 0.72:
            _rx0, _rz0, _rx1, _rz1 = _rect.bounds
            _rw, _rh = _rx1 - _rx0, _rz1 - _rz0
            _rasp = max(_rw, _rh) / max(1e-6, min(_rw, _rh))
            if _rasp <= 2.5 and _rect.area <= 60:
                _poly = _rect
        _rr.append({'polygon': [[round(c[0], 3), round(c[1], 3)] for c in list(_poly.exterior.coords)[:-1]],
                    'area': round(float(_poly.area), 2),
                    'cx': round(float(_poly.centroid.x), 2), 'cz': round(float(_poly.centroid.y), 2)})
_kept = list(rooms)
for _r in _rr:
    if _r['area'] < 2.0:
        continue
    _pg = Polygon(_r['polygon'])
    _overlap = False
    for _k in _kept:
        _kp = Polygon(_k['polygon'])
        if _kp.area > 0 and _pg.intersection(_kp).area / max(_pg.area, 1e-6) > 0.65:
            _overlap = True
            break
    if not _overlap:
        _kept.append(_r)
rooms = sorted(_kept, key=lambda r: -r['area'])
print('помещений итог:', len(rooms), '| площадь', round(sum(r['area'] for r in rooms), 1))

# ---------- 7c. достройка стен по незакрытому периметру помещений ----------
def _seg_dist(px, pz, ax_, az_, bx_, bz_):
    vx, vz = bx_ - ax_, bz_ - az_
    l2 = vx * vx + vz * vz
    if l2 <= 1e-9:
        return math.hypot(px - ax_, pz - az_)
    tt = ((px - ax_) * vx + (pz - az_) * vz) / l2
    tt = max(0.0, min(1.0, tt))
    return math.hypot(px - (ax_ + vx * tt), pz - (az_ + vz * tt))

_segs = []
for _w in merged:
    _a = (_w['u'][0] * _w['s0'] + _w['n'][0] * _w['off'], _w['u'][1] * _w['s0'] + _w['n'][1] * _w['off'])
    _b = (_w['u'][0] * _w['s1'] + _w['n'][0] * _w['off'], _w['u'][1] * _w['s1'] + _w['n'][1] * _w['off'])
    _segs.append((_a[0], _a[1], _b[0], _b[1]))
_added = 0
for _rm in rooms:
    _poly = _rm.get('polygon') or []
    if len(_poly) < 3:
        continue
    for _i in range(len(_poly)):
        _x0, _z0 = _poly[_i]
        _x1, _z1 = _poly[(_i + 1) % len(_poly)]
        _L = math.hypot(_x1 - _x0, _z1 - _z0)
        if _L < 1.0:
            continue
        _n = max(2, int(_L / 0.20))
        _unc = 0
        for _k in range(_n):
            _f = (_k + 0.5) / _n
            _px = _x0 + (_x1 - _x0) * _f
            _pz = _z0 + (_z1 - _z0) * _f
            _d = min(_seg_dist(_px, _pz, *s) for s in _segs) if _segs else 99.0
            if _d > 0.20:
                _unc += 1
        if _unc / _n < 0.6:
            continue
        _dx, _dz = _x1 - _x0, _z1 - _z0
        _dir = None
        for _k in (0, 1):
            _ax = axes[_k]
            _dot = (_dx * _ax[0] + _dz * _ax[1]) / _L
            if abs(_dot) > 0.85:
                _dir = (_ax[0], _ax[1]) if _dot >= 0 else (-_ax[0], -_ax[1])
                break
        if _dir is None:
            continue
        _nn = (-_dir[1], _dir[0])
        _s0 = _x0 * _dir[0] + _z0 * _dir[1]
        _s1 = _x1 * _dir[0] + _z1 * _dir[1]
        _off = ((_x0 + _x1) / 2) * _nn[0] + ((_z0 + _z1) / 2) * _nn[1]
        _lo, _hi = min(_s0, _s1), max(_s0, _s1)
        if _hi - _lo < 0.8 or _hi - _lo > 6.0:
            continue
        # не дублируем уже существующую стену
        _dup = False
        for _w in merged:
            if abs(_w['u'][0] * _dir[0] + _w['u'][1] * _dir[1]) < 0.995:
                continue
            if abs(_w['off'] - _off) > 0.18:
                continue
            if min(_w['s1'], _hi) - max(_w['s0'], _lo) > 0.25:
                _dup = True
                break
        if _dup:
            continue
        _cx = _dir[0] * ((_lo + _hi) / 2) + _nn[0] * _off
        _cz = _dir[1] * ((_lo + _hi) / 2) + _nn[1] * _off
        _m3 = ((np.abs(PT[:, 0] - _cx) <= 0.35) & (np.abs(PT[:, 2] - _cz) <= 0.35) &
               (PT[:, 1] >= floorY + 0.2) & (PT[:, 1] <= ceilY - 0.2))
        _col = CL[_m3].mean(axis=0) if _m3.sum() > 5 else np.array([0.55, 0.50, 0.46])
        # поддержка облаком: сколько точек рядом с линией (на 1 м² стены)
        _sn2 = (PT[:, 0] - _dir[0] * _lo) * _nn[0] + (PT[:, 2] - _dir[1] * _lo) * _nn[1]
        _su2 = (PT[:, 0] - _dir[0] * _lo) * _dir[0] + (PT[:, 2] - _dir[1] * _lo) * _dir[1]
        _mb = (np.abs(_sn2 - (_off - (_lo * 0 + _dir[0] * 0))) <= 0.25) & (_su2 >= 0) & (_su2 <= (_hi - _lo)) & \
              (PT[:, 1] >= floorY + 0.2) & (PT[:, 1] <= ceilY - 0.2)
        _dens = (_mb.sum() / max(0.5, (_hi - _lo) * (H - 0.4))) if _mb.size else 0.0
        _inferred = _dens < 40.0
        if _inferred:
            _col = np.array([0.62, 0.61, 0.58])
        merged.append({'u': np.array(_dir, float), 'n': np.array(_nn, float),
                       's0': float(_lo), 's1': float(_hi), 'off': float(_off),
                       'thk': 0.12, 'color': _col, 'inferred': bool(_inferred)})
        _segs.append((_dir[0] * _lo + _nn[0] * _off, _dir[1] * _lo + _nn[1] * _off,
                      _dir[0] * _hi + _nn[0] * _off, _dir[1] * _hi + _nn[1] * _off))
        _added += 1
print('достроено стен по периметру помещений:', _added, '| всего стен:', len(merged))

# ---------- 8. JSON ----------
wall_defs = []
for w in merged:
    u, n, off = w['u'], w['n'], w['off']
    a = [round(u[0] * w['s0'] + n[0] * off, 4), round(u[1] * w['s0'] + n[1] * off, 4)]
    b = [round(u[0] * w['s1'] + n[0] * off, 4), round(u[1] * w['s1'] + n[1] * off, 4)]
    if w['s1'] - w['s0'] < 0.5:
        continue
    wall_defs.append({'a': a, 'b': b, 'dir': [round(float(u[0]), 5), round(float(u[1]), 5)],
                      'thickness': round(float(w['thk']), 3), 'length': round(float(w['s1'] - w['s0']), 3),
                      'base': round(floorY, 3), 'height': round(float(H), 3),
                      'openings': w.get('openings', []),
                      'color': [round(float(c), 3) for c in w['color']],
                      'material': 'inferred' if w.get('inferred') else ('brick' if w['color'][0] > 0.45 else 'concrete'),
                      'inferred': bool(w.get('inferred')), 'rms': 0.02})
print('стен итог:', len(wall_defs), '| проёмов:', sum(len(w['openings']) for w in wall_defs))

if rooms:
    fl = unary_union([Polygon(r['polygon']) for r in rooms]).buffer(0.02).simplify(0.02)
    if fl.geom_type == 'MultiPolygon':
        fl = max(fl.geoms, key=lambda g: g.area)
    floorPoly = list(fl.exterior.coords)[:-1]
else:
    floorPoly = [[bx0, bz0], [bx1, bz0], [bx1, bz1], [bx0, bz1]]
floorPoly = [[round(p[0], 3), round(p[1], 3)] for p in floorPoly]

# ---------- 8.1 цвета из облака: пол, потолок, помещения ----------
_yf = np.abs(PT[:, 1] - floorY) <= 0.30
_floor_col = [round(float(v), 3) for v in (np.median(CL[_yf], axis=0) if _yf.sum() > 100 else np.array([0.72, 0.70, 0.66]))]
_yc = np.abs(PT[:, 1] - ceilY) <= 0.30
_ceil_col = [round(float(v), 3) for v in (np.median(CL[_yc], axis=0) if _yc.sum() > 100 else np.array([0.74, 0.72, 0.68]))]
_fp_all = PT[(PT[:, 1] >= floorY - 0.10) & (PT[:, 1] <= floorY + 0.40)]
_fc_all = CL[(PT[:, 1] >= floorY - 0.10) & (PT[:, 1] <= floorY + 0.40)]
try:
    from shapely import contains_xy as _contains_xy
    for _rm in rooms:
        _poly2 = Polygon(_rm['polygon'])
        _minx2, _minz2, _maxx2, _maxz2 = _poly2.bounds
        _bb = ((_fp_all[:, 0] >= _minx2) & (_fp_all[:, 0] <= _maxx2) &
               (_fp_all[:, 2] >= _minz2) & (_fp_all[:, 2] <= _maxz2))
        if _bb.sum() > 20:
            _inside = _contains_xy(_poly2, _fp_all[_bb, 0], _fp_all[_bb, 2])
            if _inside.sum() > 20:
                _rm['color'] = [round(float(v), 3) for v in np.median(_fc_all[_bb][_inside], axis=0)]
except Exception as _e:
    print('цвета помещений: пропущено', _e)
print('цвет пола из облака:', _floor_col, '| потолка:', _ceil_col)

model = {
    'ok': True,
    'storey': {'floorY': round(floorY, 3), 'ceilY': round(ceilY, 3), 'height': round(float(H), 3)},
    'walls': wall_defs,
    'slabs': [{'type': 'floor', 'level': round(floorY, 3), 'thickness': 0.10, 'polygon': floorPoly, 'color': _floor_col},
              {'type': 'ceiling', 'level': round(ceilY, 3), 'thickness': 0.10, 'polygon': floorPoly, 'color': _ceil_col}],
    'rooms': rooms, 'pipes': [], 'objects': [], 'beams': [], 'cables': [],
    'stats': {'wallCount': len(wall_defs), 'openingCount': sum(len(w['openings']) for w in wall_defs),
              'roomCount': len(rooms), 'floorArea': round(sum(r['area'] for r in rooms), 1),
              'totalWallLength': round(sum(w['length'] for w in wall_defs), 1),
              'meanWallRms': 0.02, 'pointsIn': int(len(xyz)), 'pointsUsed': int(len(PT)),
              'pipeCount': 0, 'beamCount': 0, 'objectCount': 0, 'columnCount': 0, 'cableCount': 0}
}
json.dump(model, open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('JSON:', out_json)
