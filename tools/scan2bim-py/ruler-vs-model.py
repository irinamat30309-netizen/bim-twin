# -*- coding: utf-8 -*-
"""Обмер облака «линейкой» и сверка с BIM-моделью.
   Для каждой стены модели: независимо меряем по облаку длину, толщину, проёмы; высоту этажа;
   габарит помещения по min-area rectangle. Печатает ошибку модели в мм.

   python ruler-vs-model.py cloud.bin model.json report.json
"""
import json, math, sys
import numpy as np
import open3d as o3d

cloud_path, model_path, out_report = sys.argv[1], sys.argv[2], sys.argv[3]
M = json.load(open(model_path, encoding='utf-8-sig'))
P = np.fromfile(cloud_path, dtype=np.float32).reshape(-1, 6)
xyz = P[:, :3].astype(np.float64)

pc = o3d.geometry.PointCloud()
pc.points = o3d.utility.Vector3dVector(xyz)
pc = pc.voxel_down_sample(0.03)
PT = np.asarray(pc.points)
print('точек облака:', len(PT))

# ---------- высота: пол и потолок по резким горизонтальным слоям ----------
ys = PT[:, 1]
hist, edges = np.histogram(ys, bins=300)
centers = (edges[:-1] + edges[1:]) / 2
sm = np.convolve(hist, np.array([1, 2, 3, 2, 1], float), mode='same')
peaks = []
for k in range(1, len(sm) - 1):
    if sm[k] >= sm[k - 1] and sm[k] >= sm[k + 1] and sm[k] > sm.max() * 0.05:
        y = float(centers[k])
        if not peaks or abs(y - peaks[-1][0]) > 0.10:
            peaks.append((y, float(sm[k])))
        elif sm[k] > peaks[-1][1]:
            peaks[-1] = (y, float(sm[k]))
best = None
for i in range(len(peaks)):
    for j in range(i + 1, len(peaks)):
        gap = peaks[j][0] - peaks[i][0]
        if not (2.2 <= gap <= 4.0):
            continue
        score = min(peaks[i][1], peaks[j][1])
        if best is None or score > best[0]:
            best = (score, peaks[i][0], peaks[j][0])
floorY, ceilY = (best[1], best[2]) if best else (float(np.percentile(ys, 1)), float(np.percentile(ys, 99)))
H_cloud = ceilY - floorY
print('облако: пол %.3f, потолок %.3f, высота %.3f м' % (floorY, ceilY, H_cloud))

# ---------- комнатный габарит: min-area rectangle пола ----------
mask_floor = (PT[:, 1] > floorY - 0.12) & (PT[:, 1] < floorY + 0.30)
FP = PT[mask_floor][:, [0, 2]]
if len(FP) > 500:
    pass
rect_w = rect_d = None
try:
    import cv2  # noqa
except Exception:
    cv2 = None
# без cv2: грубый габарит по осям облака
rx = np.percentile(FP[:, 0], [0.5, 99.5]) if len(FP) else [0, 0]
rz = np.percentile(FP[:, 1], [0.5, 99.5]) if len(FP) else [0, 0]
rect_w = float(rx[1] - rx[0]); rect_d = float(rz[1] - rz[0])
print('облако: габарит пола (по осям) %.2f × %.2f м' % (rect_w, rect_d))

# ---------- обмер каждой стены по облаку ----------
rows = []
for w in M['walls']:
    ax, az = w['a']; bx, bz = w['b']
    L_model = float(w['length']); T_model = float(w['thickness'])
    ux, uz = w['dir']
    nx, nz = -uz, ux
    su = (PT[:, 0] - ax) * ux + (PT[:, 2] - az) * uz
    sn = (PT[:, 0] - ax) * nx + (PT[:, 2] - az) * nz
    band = np.abs(sn) <= max(0.10, T_model / 2 + 0.12)
    hgt = (PT[:, 1] >= floorY + 0.15) & (PT[:, 1] <= ceilY - 0.15)
    m = band & hgt & (su > -0.3) & (su < L_model + 0.3)
    if m.sum() < 200:
        continue
    # длина по облаку: 1-99 перцентили проекции
    # длина по облаку: плотностной профиль, обрезаем по поддержке (5 см бин)
    m_su = su[m]
    nb0 = max(20, int(math.ceil((m_su.max() - m_su.min()) / 0.05)))
    occ0, edges0 = np.histogram(m_su, bins=nb0)
    med0 = np.median(occ0[occ0 > 0]) if np.any(occ0 > 0) else 1
    good = occ0 >= max(2, med0 * 0.25)
    if good.sum() < 4:
        continue
    first = int(np.argmax(good)); last = nb0 - 1 - int(np.argmax(good[::-1]))
    L_cloud = float((last - first + 1) * (m_su.max() - m_su.min()) / nb0)
    s_lo = float(edges0[first]); s_hi = float(edges0[last + 1])
    # толщина: две грани — кластеры sn около ±T/2
    snm = sn[m]
    med = np.median(snm)
    # толщина: две моды гистограммы по нормали (грани стены)
    histn, edgesn = np.histogram(snm, bins=40)
    cen = (edgesn[:-1] + edgesn[1:]) / 2
    strong = [i for i in range(1, len(histn) - 1) if histn[i] >= histn[i - 1] and histn[i] >= histn[i + 1] and histn[i] > histn.max() * 0.25]
    if len(strong) >= 2:
        strong.sort(key=lambda i: -histn[i])
        a0, b0 = sorted(strong[:2])
        T_cloud = float(abs(cen[b0] - cen[a0]))
    else:
        T_cloud = 0.0
    # проёмы: пустые интервалы вдоль стены
    nb = max(8, int(math.ceil((L_cloud + 0.4) / 0.10)))
    occ, _ = np.histogram(su[m], bins=nb, range=(s_lo - 0.05, s_hi + 0.05))
    med_occ = np.median(occ[occ > 0]) if np.any(occ > 0) else 1
    filled = occ >= max(2, med_occ * 0.20)
    gaps = []
    b0 = None
    for bi, f in enumerate(filled):
        if not f and b0 is None:
            b0 = bi
        elif f and b0 is not None:
            width = (bi - b0) * (L_cloud + 0.1) / nb
            if 0.5 <= width <= 3.5:
                gaps.append(width)
            b0 = None
    rows.append({'wall': i, 'L_model': round(L_model, 3), 'L_cloud': round(L_cloud, 3),
                 'L_err_mm': round((L_model - L_cloud) * 1000, 0),
                 'T_model': round(T_model, 3), 'T_cloud': round(T_cloud, 3),
                 'T_err_mm': round((T_model - T_cloud) * 1000, 0) if T_cloud else None,
                 'openings_cloud': len(gaps), 'gaps': [round(g, 2) for g in gaps]})

# ---------- модель: высота и помещения ----------
H_model = float(M['storey']['height'])
rooms = M.get('rooms', [])
room_w = room_d = None
if rooms:
    rmax = max(rooms, key=lambda r: r['area'])
    poly = np.array(rmax['polygon'], float)
    # размеры по осям контура
    room_w = float(poly[:, 0].max() - poly[:, 0].min())
    room_d = float(poly[:, 1].max() - poly[:, 1].min())
print('\nстена  модель L   облако L   Δ мм | модель T  облако T  Δ мм | проёмы(облако)')
for r in rows:
    print('  %2d   %7.3f  %8.3f  %6s | %7.3f  %8.3f  %6s | %d %s' % (
        r['wall'], r['L_model'], r['L_cloud'], r['L_err_mm'],
        r['T_model'], r['T_cloud'], r['T_err_mm'], r['openings_cloud'], r['gaps']))

Lerrs = [abs(r['L_err_mm']) for r in rows]
Terrs = [abs(r['T_err_mm']) for r in rows if r['T_err_mm'] is not None]
print('\nИТОГ: стен в модели %d, обмерено облаком %d' % (len(M['walls']), len(rows)))
print('длина стены: медиана ошибки %.0f мм, максимум %.0f мм' % (np.median(Lerrs) if Lerrs else -1, max(Lerrs) if Lerrs else -1))
print('толщина:     медиана ошибки %.0f мм, максимум %.0f мм' % (np.median(Terrs) if Terrs else -1, max(Terrs) if Terrs else -1))
print('высота:      модель %.3f м, облако %.3f м, Δ %.0f мм' % (H_model, H_cloud, (H_model - H_cloud) * 1000))
if room_w is not None:
    print('габарит помещения: модель %.2f × %.2f м, облако %.2f × %.2f м' % (room_w, room_d, rect_w, rect_d))

json.dump({'cloud': {'floorY': floorY, 'ceilY': ceilY, 'height': H_cloud, 'footprint': [rect_w, rect_d]},
           'model': {'height': H_model, 'room_max': [room_w, room_d]},
           'walls': rows,
           'summary': {'walls_model': len(M['walls']), 'walls_measured': len(rows),
                       'median_L_err_mm': float(np.median(Lerrs)) if Lerrs else None,
                       'max_L_err_mm': float(max(Lerrs)) if Lerrs else None,
                       'median_T_err_mm': float(np.median(Terrs)) if Terrs else None,
                       'max_T_err_mm': float(max(Terrs)) if Terrs else None,
                       'height_err_mm': (H_model - H_cloud) * 1000}},
          open(out_report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('JSON:', out_report)
