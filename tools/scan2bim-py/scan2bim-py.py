# -*- coding: utf-8 -*-
"""Новый движок scan-to-BIM (ревизия 91): Open3D + Manhattan + Shapely.
   Вход: бинарный файл x,y,z,r,g,b (float32) в кадре приложения (Y вверх).
   Выход: JSON модели в схеме Scan2BIM (его экспортирует наш IFC-писатель со стилями).

   python scan2bim-py.py cloud.bin model.json [--voxel=0.04] [--floor=auto]
"""
import json, math, sys
import numpy as np
import open3d as o3d
from shapely.geometry import box, MultiPolygon, Polygon
from shapely.ops import unary_union

o3d.utility.random.seed(42)
args = dict(a.split('=') for a in sys.argv[3:] if '=' in a)
vox = float(args.get('voxel', '0.04'))
cloud_path, out_json = sys.argv[1], sys.argv[2]

P = np.fromfile(cloud_path, dtype=np.float32).reshape(-1, 6)
xyz = P[:, :3].astype(np.float64)
rgb = np.clip(P[:, 3:6], 0, 1).astype(np.float64)
print('точек:', len(xyz))

pc = o3d.geometry.PointCloud()
pc.points = o3d.utility.Vector3dVector(xyz)
pc.colors = o3d.utility.Vector3dVector(rgb)
pc = pc.voxel_down_sample(vox)
print('воксель %.3f → %d точек' % (vox, len(pc.points)))
pc.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.5, max_nn=30))
PT = np.asarray(pc.points)
CL = np.asarray(pc.colors)

# ---------- 1. плоскости RANSAC ----------
rem = pc
planes = []
for _ in range(90):
    if len(rem.points) < 4000:
        break
    model, inl = rem.segment_plane(0.022, 3, 700)
    if len(inl) / len(rem.points) < 0.012:
        break
    n = np.array(model[:3], float); n /= (np.linalg.norm(n) + 1e-12)
    d = float(model[3])
    if n[1] < 0:
        n, d = -n, -d
    q = np.asarray(rem.points)[inl]
    planes.append({'n': n, 'd': d, 'pts': q, 'color': np.asarray(rem.colors)[inl].mean(axis=0)})
    rem = rem.select_by_index(inl, invert=True)
print('плоскостей:', len(planes))

# высоты пола/потолка: самый сильный горизонтальный слой в нижней и верхней половине
horiz = [p for p in planes if abs(p['n'][1]) > 0.9 and len(p['pts']) > 2000]
floorY, ceilY = 0.0, 3.0
if horiz:
    ys_all = np.array([abs(p['d']) for p in horiz])
    lo, hi = float(np.percentile(ys_all, 2)), float(np.percentile(ys_all, 98))
    mid = (lo + hi) / 2
    lower = [p for p in horiz if abs(p['d']) <= mid]
    upper = [p for p in horiz if abs(p['d']) > mid]
    if lower and upper:
        fl = max(lower, key=lambda p: len(p['pts']))
        ce = max(upper, key=lambda p: len(p['pts']))
        f0, c0 = abs(fl['d']), abs(ce['d'])
        if 1.6 <= c0 - f0 <= 6:
            floorY, ceilY = float(f0), float(c0)
print('пол/потолок: %.2f / %.2f' % (floorY, ceilY))
H = ceilY - floorY
vert = [p for p in planes if abs(p['n'][1]) < 0.2 and len(p['pts']) > 500]

# ---------- 2. грани стен и сетка Манхэттена ----------
faces = []
for p in vert:
    q = p['pts']
    sample = q[::max(1, len(q) // 3000)]
    ang = math.atan2(p['n'][2], p['n'][0]) % math.pi     # нормаль в плане
    u = np.array([math.cos(ang + math.pi / 2), math.sin(ang + math.pi / 2)])   # вдоль стены (x,z)
    nn = np.array([math.cos(ang), math.sin(ang)])
    su = sample[:, 0] * u[0] + sample[:, 2] * u[1]
    sn = sample[:, 0] * nn[0] + sample[:, 2] * nn[1]
    s0, s1 = float(np.percentile(su, 1)), float(np.percentile(su, 99))
    ylo = float(np.percentile(sample[:, 1], 2)); yhi = float(np.percentile(sample[:, 1], 98))
    if s1 - s0 < 0.8 or (yhi - ylo) < 1.2:   # трубы и мелкие детали дают короткие по высоте грани
        continue
    faces.append({'sample': sample, 'angle': float(math.degrees(ang + math.pi / 2) % 180),
                  'length': float(s1 - s0), 'color': p['color']})
if not faces:
    raise SystemExit('ОШИБКА: не найдено вертикальных граней')

long_faces = [f for f in faces if f['length'] > 2.0] or faces
base = float(np.median([f['angle'] % 90 for f in long_faces])) * math.pi / 180
print('сетка Манхэттена: %.2f°' % math.degrees(base))
axes = [(math.cos(base), math.sin(base)), (math.cos(base + math.pi / 2), math.sin(base + math.pi / 2))]
for f in faces:
    sm = f['sample']
    # выбираем ось: нормаль к грани должна быть близка к одной из осей
    best = 0
    bestv = -1
    for k in range(2):
        u = np.array(axes[k], float)
        for sgn in (1, -1):
            nn = np.array([-u[1], u[0]]) * sgn
            # насколько плоскость грани совпадает с этой нормалью: по разбросу проекции
            var = float(np.var(sm[:, 0] * nn[0] + sm[:, 2] * nn[1]))
            if bestv < 0 or var < bestv:
                bestv = var; best = (u, nn)
    u, nn = best
    su = sm[:, 0] * u[0] + sm[:, 2] * u[1]
    sn = sm[:, 0] * nn[0] + sm[:, 2] * nn[1]
    f['u'] = u; f['n'] = nn
    f['s0'] = float(np.percentile(su, 1)); f['s1'] = float(np.percentile(su, 99))
    f['off'] = float(np.median(sn))

# ---------- 3. спаривание граней в стены ----------
used = [False] * len(faces)
walls = []
for i, fi in enumerate(faces):
    if used[i]:
        continue
    best = None
    for j, fj in enumerate(faces):
        if i == j or used[j]:
            continue
        dot = fi['u'][0] * fj['u'][0] + fi['u'][1] * fj['u'][1]
        if dot < 0.985:
            continue
        gap = abs(fi['off'] - fj['off'])
        if gap < 0.05 or gap > 0.7:
            continue
        lo = max(fi['s0'], fj['s0']); hi = min(fi['s1'], fj['s1'])
        if hi - lo < 0.4:
            continue
        score = (hi - lo) / (gap + 0.05)
        if best is None or score > best[0]:
            best = (score, j, lo, hi, gap)
    u = fi['u']
    n = np.array([-u[1], u[0]])
    if best:
        used[i] = used[best[1]] = True
        lo, hi, gap = best[2], best[3], best[4]
        off = (fi['off'] + faces[best[1]]['off']) / 2
        walls.append({'u': u, 'n': n, 'off': off, 's0': lo, 's1': hi, 'thk': gap,
                      'color': (fi['color'] + faces[best[1]]['color']) / 2})
    else:
        used[i] = True
        walls.append({'u': u, 'n': n, 'off': fi['off'], 's0': fi['s0'], 's1': fi['s1'],
                      'thk': 0.12, 'color': fi['color']})
print('стен из граней:', len(walls))

# ---------- 4. слияние коллинеарных стен ----------
def overlap(a0, a1, b0, b1):
    return min(a1, b1) - max(a0, b0)

merged = []
for w in sorted(walls, key=lambda q: -(q['s1'] - q['s0'])):
    placed = False
    for m in merged:
        dot = abs(m['u'][0] * w['u'][0] + m['u'][1] * w['u'][1])
        if dot < 0.995:
            continue
        if abs(m['off'] - w['off']) > 0.10:
            continue
        if overlap(m['s0'], m['s1'], w['s0'], w['s1']) < -1.6:
            continue
        m['s0'] = min(m['s0'], w['s0']); m['s1'] = max(m['s1'], w['s1'])
        m['thk'] = (m['thk'] + w['thk']) / 2
        placed = True
        break
    if not placed:
        merged.append(dict(w))
print('после слияния:', len(merged))

# ---------- 5. профиль вдоль стены: поддержка и проёмы ----------
hbins = 0.10
wall_defs = []
for w in merged:
    u, n, off = w['u'], w['n'], w['off']
    L = w['s1'] - w['s0']
    if L < 0.8:
        continue
    # точки в полосе стены
    du = (PT[:, 0] - 0) * 0 + PT[:, 0]
    su = PT[:, 0] * u[0] + PT[:, 2] * u[1]
    sn = PT[:, 0] * n[0] + PT[:, 2] * n[1]
    mask = (np.abs(sn - off) <= max(0.10, w['thk'] / 2 + 0.06)) & (su >= w['s0'] - 0.05) & (su <= w['s1'] + 0.05) & \
           (PT[:, 1] >= floorY + 0.15) & (PT[:, 1] <= ceilY - 0.15)
    idx = np.where(mask)[0]
    if len(idx) < 400:
        continue
    nb = max(8, int(math.ceil(L / hbins)))
    occ = np.zeros(nb)
    for k in idx:
        b = int((su[k] - w['s0']) / hbins)
        if 0 <= b < nb:
            occ[b] += 1
    med = np.median(occ[occ > 0]) if np.any(occ > 0) else 1
    thr = max(2, med * 0.22)
    filled = occ >= thr
    # обрезаем по поддержке с краёв
    first = int(np.argmax(filled))
    last = nb - 1 - int(np.argmax(filled[::-1]))
    if last - first < 6:
        continue
    # проёмы: разрывы поддержки внутри
    ops = []
    b = first
    while b <= last:
        if not filled[b]:
            b0 = b
            while b <= last and not filled[b]:
                b += 1
            b1 = b
            width = (b1 - b0) * hbins
            if width >= 0.6:
                s_lo = w['s0'] + b0 * hbins; s_hi = w['s0'] + b1 * hbins
                # вертикальные границы: ищем пустой интервал по высоте в этих колонках
                m2 = (np.abs(sn - off) <= max(0.10, w['thk'] / 2 + 0.06)) & (su >= s_lo) & (su <= s_hi) & \
                     (PT[:, 1] >= floorY) & (PT[:, 1] <= ceilY)
                yy = np.sort(PT[m2, 1]) if np.any(m2) else np.array([])
                zs = np.arange(floorY, ceilY + 0.001, 0.05)
                empty = []
                for z in zs:
                    c = int(np.sum((yy >= z - 0.06) & (yy <= z + 0.06)))
                    empty.append(c < 3)
                # максимальный пустой отрезок
                best = (0.0, 0.0, 0.0); cur = None
                for z, e in zip(zs, empty):
                    if e and cur is None:
                        cur = z
                    elif not e and cur is not None:
                        if z - cur > best[0]: best = (z - cur, cur, z)
                        cur = None
                if cur is not None and (ceilY - cur) > best[0]:
                    best = (ceilY - cur, cur, ceilY)
                sill = max(0.0, best[1] - floorY)
                head = min(H, best[2] - floorY)
                if head - sill < 0.9:
                    continue
                is_door = sill <= 0.3
                if is_door and not (0.6 <= width <= 2.2):
                    continue
                if not is_door and not (0.7 <= width <= 3.5):
                    continue
                ops.append({'along': float(s_lo - w['s0']), 'width': float(width),
                            'sill': float(round(sill, 3)), 'head': float(round(head, 3)),
                            'kind': 'door' if is_door else 'window'})
            continue
        b += 1
    s0 = w['s0'] + first * hbins; s1 = w['s0'] + (last + 1) * hbins
    # мировая геометрия стены
    cx = u[0] * (s0 + s1) / 2 + n[0] * off
    cz = u[1] * (s0 + s1) / 2 + n[1] * off
    a = [cx - u[0] * (s1 - s0) / 2, cz - u[1] * (s1 - s0) / 2]
    b = [cx + u[0] * (s1 - s0) / 2, cz + u[1] * (s1 - s0) / 2]
    wall_defs.append({'a': [round(a[0], 4), round(a[1], 4)], 'b': [round(b[0], 4), round(b[1], 4)],
                      'dir': [round(u[0], 5), round(u[1], 5)], 'thickness': round(float(w['thk']), 3),
                      'length': round(float(s1 - s0), 3), 'base': round(floorY, 3),
                      'height': round(float(H), 3), 'openings': ops,
                      'color': [round(float(c), 3) for c in w['color']],
                      'material': 'brick' if w['color'][0] > 0.45 else 'concrete', 'rms': 0.02})
print('стен итог:', len(wall_defs), '| проёмов:', sum(len(w['openings']) for w in wall_defs))

# ---------- 5.2 закрытие углов/примыканий и толщина по двум граням облака ----------
for i, w in enumerate(wall_defs):
    ax, az = w['a']; ux, uz = w['dir']; L = w['length']
    nxv, nzv = -uz, ux
    shiftA = 0.0; extB = 0.0
    for j, v in enumerate(wall_defs):
        if i == j:
            continue
        vx, vz = v['dir']
        det = ux * vz - uz * vx
        if abs(det) < 0.2:                       # параллельны — не примыкание
            continue
        vax, vaz = v['a']
        b1x, b1z = vax - ax, vaz - az
        t = (b1x * vz - b1z * vx) / det          # положение пересечения вдоль нашей стены
        s = (b1x * uz - b1z * ux) / det
        if not (-0.9 <= s <= v['length'] + 0.9):
            continue
        # примыкание должно быть подтверждено облаком у точки пересечения
        px = ax + ux * t; pz = az + uz * t
        dd = (PT[:, 0] - px) ** 2 + (PT[:, 2] - pz) ** 2
        near = dd <= 0.25 ** 2
        if near.sum() < 10:
            continue
        if -0.9 <= t < 0 and -t > shiftA:
            shiftA = -t                          # доводим начало до примыкания
        elif L <= t <= L + 0.9 and (t - L) > extB:
            extB = t - L                         # доводим торец
    if shiftA > 0.02:
        w['a'] = [ax - ux * shiftA, az - uz * shiftA]
        for o in w['openings']:
            o['along'] = float(round(o['along'] + shiftA, 3))
        w['length'] = float(round(L + shiftA, 3))
        L = w['length']
    if extB > 0.02:
        w['length'] = float(round(L + extB, 3))
        L = w['length']
    ax, az = w['a']
    w['b'] = [float(round(ax + ux * L, 4)), float(round(az + uz * L, 4))]
    # толщина и ось — по двум модам облака в полосе стены
    su2 = (PT[:, 0] - ax) * ux + (PT[:, 2] - az) * uz
    sn2 = (PT[:, 0] - ax) * nxv + (PT[:, 2] - az) * nzv
    band2 = (np.abs(sn2) <= 0.55) & (su2 >= 0) & (su2 <= L) & (PT[:, 1] >= floorY + 0.20) & (PT[:, 1] <= ceilY - 0.20)
    if band2.sum() > 400:
        snm2 = sn2[band2]
        hist2, ed2 = np.histogram(snm2, bins=56)
        cen2 = (ed2[:-1] + ed2[1:]) / 2
        idx2 = [k for k in range(1, len(hist2) - 1) if hist2[k] >= hist2[k - 1] and hist2[k] >= hist2[k + 1] and hist2[k] > hist2.max() * 0.22]
        idx2.sort(key=lambda k: -hist2[k])
        if len(idx2) >= 2:
            a2, b2 = sorted(idx2[:2])
            th = abs(cen2[b2] - cen2[a2])
            if 0.08 <= th <= 0.7:
                # ось ставим между гранями
                mid = (cen2[a2] + cen2[b2]) / 2
                dx, dz = nxv * mid, nzv * mid
                w['a'] = [w['a'][0] + dx, w['a'][1] + dz]
                w['b'] = [w['b'][0] + dx, w['b'][1] + dz]
                w['thickness'] = float(round(th, 3))
print('углы закрыты, толщина по граням облака')

# ---------- 5.1 проверка проёмов по плотности облака (как в JS-движке) ----------
def band_mask(w):
    ux, uz = w['dir']; nxv, nzv = -uz, ux
    ax, az = w['a']
    half = max(0.12, w['thickness'] / 2 + 0.06)
    su = (PT[:, 0] - ax) * ux + (PT[:, 2] - az) * uz
    sn = (PT[:, 0] - ax) * nxv + (PT[:, 2] - az) * nzv
    return (np.abs(sn) <= half) & (su >= 0) & (su <= w['length']) & \
           (PT[:, 1] >= floorY + 0.05) & (PT[:, 1] <= ceilY - 0.05), su

removed = 0
for w in wall_defs:
    m, su = band_mask(w)
    if not np.any(m):
        w['openings'] = []
        continue
    wall_dens = m.sum() / max(0.5, w['length'] * H)
    keep = []
    for o in w['openings']:
        s0 = o['along']; s1 = o['along'] + o['width']
        z0 = floorY + o['sill']; z1 = floorY + o['head']
        mo = m & (su >= s0) & (su <= s1) & (PT[:, 1] >= z0) & (PT[:, 1] <= z1)
        area = max(0.25, o['width'] * max(0.3, o['head'] - o['sill']))
        dens = mo.sum() / area
        if dens > wall_dens * 0.22:
            removed += 1
            continue
        keep.append(o)
    w['openings'] = keep
print('проёмов после проверки:', sum(len(w['openings']) for w in wall_defs), '| отброшено:', removed)

# ---------- 6. помещения: сетка 5 см, shapely ----------
bx0 = min(min(w['a'][0], w['b'][0]) for w in wall_defs) - 0.5
bx1 = max(max(w['a'][0], w['b'][0]) for w in wall_defs) + 0.5
bz0 = min(min(w['a'][1], w['b'][1]) for w in wall_defs) - 0.5
bz1 = max(max(w['a'][1], w['b'][1]) for w in wall_defs) + 0.5
cell = 0.05
nx = int((bx1 - bx0) / cell) + 1
nz = int((bz1 - bz0) / cell) + 1
free = np.zeros((nz, nx), bool)
floorPts = PT[(PT[:, 1] > floorY - 0.1) & (PT[:, 1] < floorY + 0.35)]
gx = np.floor((floorPts[:, 0] - bx0) / cell).astype(int)
gz = np.floor((floorPts[:, 2] - bz0) / cell).astype(int)
ok = (gx >= 0) & (gx < nx) & (gz >= 0) & (gz < nz)
free[gz[ok], gx[ok]] = True
# замыкание: узкие щели от труб/мусора не дробят помещение на части
for _ in range(2):
    dil = free.copy()
    for ax in (0, 1):
        dil = dil | np.roll(dil, 1, axis=ax) | np.roll(dil, -1, axis=ax)
    ero = dil.copy()
    for ax in (0, 1):
        ero = ero & np.roll(dil, 1, axis=ax) & np.roll(dil, -1, axis=ax)
    free = ero
blocked = np.zeros((nz, nx), bool)
gxc, gzc = np.meshgrid((np.arange(nx) + 0.5) * cell + bx0, (np.arange(nz) + 0.5) * cell + bz0)
for w in wall_defs:
    ax, az = w['a']; bx, bz = w['b']
    ux, uz = w['dir']; nxv, nzv = -uz, ux
    half = w['thickness'] / 2
    Lw = math.hypot(bx - ax, bz - az)
    su = (gxc - ax) * ux + (gzc - az) * uz
    sn = (gxc - ax) * nxv + (gzc - az) * nzv
    m = (su >= -half) & (su <= Lw + half) & (np.abs(sn) <= half)
    blocked |= m

free = free & ~blocked
# связные области
lab = np.zeros((nz, nx), int)
rooms = []
cid = 0
for gz in range(nz):
    for gx in range(nx):
        if not free[gz, gx] or lab[gz, gx]:
            continue
        cid += 1
        stack = [(gz, gx)]
        lab[gz, gx] = cid
        cells = []
        while stack:
            z0, x0 = stack.pop()
            cells.append((z0, x0))
            for dz, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nz2, nx2 = z0 + dz, x0 + dx
                if 0 <= nz2 < nz and 0 <= nx2 < nx and free[nz2, nx2] and not lab[nz2, nx2]:
                    lab[nz2, nx2] = cid
                    stack.append((nz2, nx2))
        if len(cells) * cell * cell < 2.0:
            continue
        boxes = [box(bx0 + x0 * cell, bz0 + z0 * cell, bx0 + (x0 + 1) * cell, bz0 + (z0 + 1) * cell) for z0, x0 in cells]
        poly = unary_union(boxes).buffer(0.001).simplify(0.05)
        if poly.is_empty:
            continue
        rect = poly.minimum_rotated_rectangle
        if rect.area > 0 and poly.area / rect.area > 0.72:
            poly = rect
        rooms.append({'polygon': [[round(p[0], 3), round(p[1], 3)] for p in list(poly.exterior.coords)[:-1]],
                      'area': round(float(poly.area), 2),
                      'cx': round(float(poly.centroid.x), 2), 'cz': round(float(poly.centroid.y), 2)})
print('помещений:', len(rooms), '| площадь', round(sum(r['area'] for r in rooms), 1))
if rooms:
    fl = unary_union([Polygon(r['polygon']) for r in rooms]).buffer(0.001)
    floorPoly = list(fl.exterior.coords)[:-1] if hasattr(fl, 'exterior') else []
else:
    floorPoly = [[bx0, bz0], [bx1, bz0], [bx1, bz1], [bx0, bz1]]

# ---------- 7. JSON в схеме Scan2BIM ----------
model = {
    'ok': True,
    'storey': {'floorY': round(floorY, 3), 'ceilY': round(ceilY, 3), 'height': round(float(H), 3)},
    'walls': wall_defs,
    'slabs': [
        {'type': 'floor', 'level': round(floorY, 3), 'thickness': 0.10, 'polygon': [[round(p[0], 3), round(p[1], 3)] for p in floorPoly]},
        {'type': 'ceiling', 'level': round(ceilY, 3), 'thickness': 0.10, 'polygon': [[round(p[0], 3), round(p[1], 3)] for p in floorPoly]}
    ],
    'rooms': rooms,
    'pipes': [], 'objects': [], 'beams': [], 'cables': [],
    'stats': {
        'wallCount': len(wall_defs), 'openingCount': sum(len(w['openings']) for w in wall_defs),
        'roomCount': len(rooms), 'floorArea': round(sum(r['area'] for r in rooms), 1),
        'totalWallLength': round(sum(w['length'] for w in wall_defs), 1),
        'meanWallRms': 0.02, 'pointsIn': int(len(xyz)), 'pointsUsed': int(len(PT)),
        'pipeCount': 0, 'beamCount': 0, 'objectCount': 0, 'columnCount': 0, 'cableCount': 0
    }
}
json.dump(model, open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('JSON:', out_json)
