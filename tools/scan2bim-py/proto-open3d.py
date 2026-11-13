# -*- coding: utf-8 -*-
"""Прототип нового движка: Manhattan-стены через RANSAC плоскостей Open3D.
   python proto-open3d.py local-rgb.bin out.json out.png
"""
import json, sys, math
import numpy as np
import open3d as o3d
from PIL import Image, ImageDraw

bin_path, out_json, out_png = sys.argv[1], sys.argv[2], sys.argv[3]
P = np.fromfile(bin_path, dtype=np.float32).reshape(-1, 6)
xyz = P[:, :3].astype(np.float64)
rgb = np.clip(P[:, 3:6], 0, 1).astype(np.float64)
print('точек на входе', len(xyz))
pc = o3d.geometry.PointCloud()
pc.points = o3d.utility.Vector3dVector(xyz)
pc.colors = o3d.utility.Vector3dVector(rgb)
pc = pc.voxel_down_sample(0.04)
print('после вокселя 0.04:', len(pc.points))
pc.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.6, max_nn=40))

pts_all = np.asarray(pc.points)
cols_all = np.asarray(pc.colors)
remaining = pc
planes = []
for i in range(60):
    n_rem = len(remaining.points)
    if n_rem < 3000:
        break
    model, inl = remaining.segment_plane(distance_threshold=0.025, ransac_n=3, num_iterations=600)
    ratio = len(inl) / n_rem
    if ratio < 0.01:
        break
    a, b, c, d = model
    n = np.array([a, b, c], float)
    n /= (np.linalg.norm(n) + 1e-12)
    if n[1] < 0:
        n = -n; d = -d
    p_in = np.asarray(remaining.points)[inl]
    c_in = np.asarray(remaining.colors)[inl]
    planes.append({'n': n, 'd': float(d), 'inlier': p_in, 'color': c_in.mean(axis=0).tolist(), 'ratio': float(ratio)})
    remaining = remaining.select_by_index(inl, invert=True)

print('плоскостей найдено:', len(planes))
horiz = [p for p in planes if abs(p['n'][1]) > 0.85]
vert = [p for p in planes if abs(p['n'][1]) < 0.25]
print('горизонтальных (пол/потолок):', len(horiz), '| вертикальных (стены):', len(vert))
if horiz:
    ys = sorted(p['d'] for p in horiz)   # n=(0,±1,0) → d = |y|
    print('уровни горизонтальных плоскостей:', [round(y, 2) for y in ys[:8]])

# --- стены: манхэттенская сетка по медианному углу
def wall_from_plane(p):
    q = p['inlier']
    if len(q) < 300:
        return None
    ang = math.atan2(p['n'][2], p['n'][0])          # нормаль в плане
    ang = (ang + math.pi) % math.pi                  # 0..180°
    # направление стены = нормаль + 90°
    dirang = ang + math.pi / 2
    u = np.array([math.cos(dirang), math.sin(dirang)])   # (x,z)
    nrm = np.array([math.cos(ang), math.sin(ang)])
    su = q[:, 0] * u[0] + q[:, 2] * u[1]
    sn = q[:, 0] * nrm[0] + q[:, 2] * nrm[1]
    s0, s1 = np.percentile(su, 1), np.percentile(su, 99)
    if s1 - s0 < 0.7:
        return None
    # толщина = разброс по нормали (обе грани: 5-95%)
    thk = max(0.06, float(np.percentile(sn, 95) - np.percentile(sn, 5)))
    cen_u = (s0 + s1) / 2
    cen_n = np.median(sn)
    cx = u[0] * cen_u + nrm[0] * cen_n
    cz = u[1] * cen_u + nrm[1] * cen_n
    return {'cx': float(cx), 'cz': float(cz), 'dir': [float(u[0]), float(u[1])],
            'len': float(s1 - s0), 'thk': float(thk), 'angle': float((dirang * 180 / math.pi) % 180),
            'color': p['color'], 'inliers': int(len(q)), 'plane_n': p['n'].tolist(), 'd': p['d']}

cand = [w for w in (wall_from_plane(p) for p in vert) if w]
# манхэттен: сдвигаем углы к общей сетке (медиана по модулю 90°)
if cand:
    base = np.median([w['angle'] % 90 for w in cand]) * math.pi / 180
    for w in cand:
        k = round((w['angle'] * math.pi / 180 - base) / (math.pi / 2))
        ang = base + k * math.pi / 2
        w['dir'] = [math.cos(ang), math.sin(ang)]
        w['angle'] = (math.degrees(ang)) % 180
        w['len'] = max(0.3, w['len'] - 0.02)
# объединяем коллинеарные и близкие по нормали
merged = []
for w in sorted(cand, key=lambda q: -q['len']):
    dup = False
    for m in merged:
        dot = abs(m['dir'][0] * w['dir'][0] + m['dir'][1] * w['dir'][1])
        if dot < 0.98:
            continue
        nx, nz = -m['dir'][1], m['dir'][0]
        dist = abs((w['cx'] - m['cx']) * nx + (w['cz'] - m['cz']) * nz)
        if dist > max(0.10, (m['thk'] + w['thk']) * 0.75):
            continue
        # проверяем перекрытие вдоль стены
        su_m = (m['cx'] * m['dir'][0] + m['cz'] * m['dir'][1])
        su_w = (w['cx'] * w['dir'][0] + w['cz'] * w['dir'][1])
        if abs(su_w - su_m) > (m['len'] + w['len']) * 0.7:
            continue
        dup = True
        break
    if not dup:
        merged.append(w)

print('кандидатов стен:', len(cand), '| после слияния:', len(merged))
tot = sum(w['len'] for w in merged)
print('суммарная длина стен: %.1f м' % tot)
base_deg = math.degrees(base) if cand else 0
print('базовый угол сетки: %.2f°' % base_deg)
for w in sorted(merged, key=lambda q: -q['len'])[:14]:
    print('  L=%.2f м  T=%.2f м  угол %.1f°  цвет %.2f/%.2f/%.2f' % (
        w['len'], w['thk'], w['angle'], *w['color']))

# --- покрытие стен облаком (доля точек в радиусе 0.12 от плоскости стены)
allp = pts_all
cover = np.zeros(len(allp), bool)
for w in merged:
    nx, nz = -w['dir'][1], w['dir'][0]
    dist = np.abs((allp[:, 0] - w['cx']) * nx + (allp[:, 2] - w['cz']) * nz)
    su = (allp[:, 0] - w['cx']) * w['dir'][0] + (allp[:, 2] - w['cz']) * w['dir'][1]
    cover |= (dist < 0.08) & (np.abs(su) < w['len'] / 2 + 0.1) & (allp[:, 1] > 0.25) & (allp[:, 1] < 3.2)
print('доля точек облака в полосе стен: %.1f %%' % (100 * cover.mean()))

# --- план
xs = [w['cx'] - w['len'] / 2 * abs(w['dir'][0]) - w['thk'] for w in merged] + [w['cx'] + w['len'] / 2 * abs(w['dir'][0]) + w['thk'] for w in merged]
zs = [w['cz'] - w['len'] / 2 * abs(w['dir'][1]) - w['thk'] for w in merged] + [w['cz'] + w['len'] / 2 * abs(w['dir'][1]) + w['thk'] for w in merged]
minx, maxx, minz, maxz = min(xs) - 1, max(xs) + 1, min(zs) - 1, max(zs) + 1
W, H = 1200, 900
scale = min((W - 120) / (maxx - minx), (H - 120) / (maxz - minz))
def X(x): return 60 + (x - minx) * scale
def Z(z): return H - 60 - (z - minz) * scale
img = Image.new('RGB', (W, H), (250, 249, 245))
d = ImageDraw.Draw(img)
for w in merged:
    ux, uz = w['dir']
    nx, nz = -uz, ux
    hx, hz = w['len'] / 2, w['thk'] / 2
    corners = [(-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)]
    pts = [(X(w['cx'] + u * ux + n * nx), Z(w['cz'] + u * uz + n * nz)) for u, n in corners]
    col = tuple(int(c * 255) for c in w['color'])
    d.polygon(pts, fill=col, outline=(60, 50, 40))
for x in allp[::7]:
    d.point((X(x[0]), Z(x[2])), fill=(205, 202, 196))
d.text((20, 12), 'Прототип 2: стены через RANSAC-плоскости Open3D (Манхэттен), %d стен' % len(merged), fill=(30, 30, 30))
img.save(out_png)

json.dump({'walls': merged, 'base_deg': base_deg, 'planes': len(planes), 'horiz': len(horiz),
           'vert': len(vert), 'coverage': float(cover.mean()), 'total_len': float(tot)},
          open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('saved', out_png, out_json)
