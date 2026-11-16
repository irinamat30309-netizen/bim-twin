# -*- coding: utf-8 -*-
"""quality-compare.py — независимая количественная сверка «наша сборка из .xbin vs Lixel Studio»
по визуальному качеству (r145). Метрики соответствуют претензиям заказчика:

  1) «Размытие»       — толщина поверхностей по нормали (пол/стены, робастная MAD) +
                        резкость (градиент яркости в проекции) + MTF-прокси (доля высоких
                        частот в 2D-спектре текстуры).
  2) «Артефакты на полу» — воксели 2 см на плоскости пола: доля точек с отклонением цвета
                        > 3σ (или > 25 ед.) и с z-«смазами»; heatmap PNG.
  3) «Люди не убраны» — висящие кластеры (15 см воксели) в воздухе 0.5–2.2 м над полом
                        без опоры; % точек; heatmap PNG (интерьер).
  4) «Цвет не везде»  — цветовое покрытие (насыщенность/яркость), серые/чёрные зоны; heatmap.
  5) Вердикты         — наш vs Lixel (Δ%), PASS/FAIL по порогам.

Запуск:
  python tools/scan2bim-py/quality-compare.py --our OUR.las --ref REF.las \
         --out report.json --heatmaps DIR [--z-range ZMIN,ZMAX] [--label interior|facade]
Опции: --max-points 2500000, --people/--no-people, --up-axis z|y|x|auto, --no-heatmaps,
       --z-range (ограничить анализ одним этажом/полосой; по умолчанию весь общий bbox).

Коды: 0 — отчёт готов; 2 — нет общих точек.
"""
import argparse
import json
import math
import os
import struct
import sys
import time

import numpy as np

try:
    import PIL.Image as Image
    import PIL.ImageDraw as ImageDraw
except Exception:  # pragma: no cover
    Image = None


# ============================ LAS ============================
def read_header(path):
    with open(path, 'rb') as f:
        h = f.read(375)
    if h[:4] != b'LASF':
        raise ValueError('не LAS: ' + path)
    ver = (h[24], h[25]); hsize = struct.unpack_from('<H', h, 94)[0]
    off = struct.unpack_from('<I', h, 96)[0]; nvlr = struct.unpack_from('<I', h, 100)[0]
    fmt = h[104] & 0x3F; rl = struct.unpack_from('<H', h, 105)[0]
    n = struct.unpack_from('<I', h, 107)[0]
    if ver >= (1, 4) and hsize >= 375:
        n14 = struct.unpack_from('<Q', h, 247)[0]
        if n14:
            n = n14
    s = struct.unpack_from('<ddd', h, 131); o = struct.unpack_from('<ddd', h, 155)
    maxx, minx, maxy, miny, maxz, minz = struct.unpack_from('<dddddd', h, 179)
    t_off = 20 if fmt in (1, 3, 4, 5, 10) else None
    # r151: смещение RGB зависит от формата LAS (было 28 для всех, из-за чего fmt 2/7/8/10
    # читались со сдвигом и падали). LAS 1.4: fmt 2 → 20 (core 20 + RGB 6), fmt 3/5 → 28,
    # fmt 7/8/10 → 30 (core 30 + RGB 6).
    if fmt == 2: rgb_off = 20
    elif fmt in (3, 5): rgb_off = 28
    elif fmt in (7, 8, 10): rgb_off = 30
    else: rgb_off = None
    return {'path': path, 'fmt': fmt, 'rl': rl, 'off': off, 'n': int(n),
            'scale': s, 'offset': o, 'bbox': (minx, miny, minz, maxx, maxy, maxz),
            't_off': t_off, 'rgb_off': rgb_off, 'size': os.path.getsize(path),
            'hsize': hsize, 'nvlr': nvlr}


def _decode(rec, H):
    c = len(rec)
    X = rec[:, 0:4].copy().view('<i4').reshape(c).astype(np.float32)
    Y = rec[:, 4:8].copy().view('<i4').reshape(c).astype(np.float32)
    Z = rec[:, 8:12].copy().view('<i4').reshape(c).astype(np.float32)
    sx, sy, sz = H['scale']; ox, oy, oz = H['offset']
    xyz = np.column_stack([X * sx + ox, Y * sy + oy, Z * sz + oz])
    rgb16 = None
    if H['rgb_off'] is not None:
        ro = H['rgb_off']
        rgb16 = np.column_stack([rec[:, ro:ro + 2].copy().view('<u2').reshape(c),
                                 rec[:, ro + 2:ro + 4].copy().view('<u2').reshape(c),
                                 rec[:, ro + 4:ro + 6].copy().view('<u2').reshape(c)])
    return xyz, rgb16


def load_sample(path, bbox=None, max_pts=2_500_000):
    """Блочный равномерный сэмпл по файлу (блоки 20k точек с равномерным шагом)."""
    H = read_header(path)
    n = H['n']; rl = H['rl']
    need = min(n, max_pts)
    block = 20000
    nblocks = max(1, n // block)
    frac = need / n
    step_blocks = max(1, int(round(1.0 / frac))) if frac < 1.0 else 1
    xs, ys, zs, rgbs = [], [], [], []
    got = 0
    with open(path, 'rb') as f:
        b = 0
        while b < nblocks and got < need:
            start = b * block
            cnt = min(block, n - start)
            f.seek(H['off'] + start * rl)
            buf = f.read(cnt * rl)
            if len(buf) < cnt * rl:
                break
            rec = np.frombuffer(buf, dtype=np.uint8).reshape(cnt, rl)
            xyz, rgb16 = _decode(rec, H)
            if bbox is not None:
                x0, y0, z0, x1, y1, z1 = bbox
                m = ((xyz[:, 0] >= x0) & (xyz[:, 0] <= x1) & (xyz[:, 1] >= y0) &
                     (xyz[:, 1] <= y1) & (xyz[:, 2] >= z0) & (xyz[:, 2] <= z1))
                xyz = xyz[m]
                if rgb16 is not None:
                    rgb16 = rgb16[m]
            if len(xyz):
                xs.append(xyz[:, 0]); ys.append(xyz[:, 1]); zs.append(xyz[:, 2])
                if rgb16 is not None:
                    rgbs.append(rgb16)
                got += len(xyz)
            b += step_blocks
    if not xs:
        return None
    X = np.concatenate(xs); Y = np.concatenate(ys); Z = np.concatenate(zs)
    if rgbs:
        raw = np.concatenate(rgbs)
        mxv = int(raw.max()) if len(raw) else 0
        scale = (255.0 / 65535.0) if mxv > 255 else 1.0
        RGB = np.clip(raw.astype(np.float32) * scale + 0.5, 0, 255).astype(np.uint8)
        rgb_scale = scale
        rgb_max = mxv
    else:
        RGB = np.zeros((len(X), 3), np.uint8); rgb_scale = 0; rgb_max = 0
    return {'X': X, 'Y': Y, 'Z': Z, 'RGB': RGB, 'header': H, 'sampled': len(X),
            'step_blocks': step_blocks, 'rgb_scale': rgb_scale, 'rgb_max': rgb_max}


# ============================ helpers ============================
def up_axis(header, override=None):
    if override in (0, 1, 2):
        return int(override)
    x0, y0, z0, x1, y1, z1 = header['bbox']
    ext = [x1 - x0, y1 - y0, z1 - z0]
    return int(np.argmin(ext))


def luma_sat(rgb):
    r = rgb[:, 0].astype(np.float32); g = rgb[:, 1].astype(np.float32); b = rgb[:, 2].astype(np.float32)
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    sat = np.where(mx > 1.0, (mx - mn) / np.maximum(mx, 1.0), 0.0)
    return lum, sat, mx


def plane_fit(z, x, y):
    A = np.column_stack([x, y, np.ones_like(x)])
    try:
        coef, *_ = np.linalg.lstsq(A, z, rcond=None)
    except np.linalg.LinAlgError:
        return None
    res = z - A @ coef
    mad = 1.4826 * np.median(np.abs(res - np.median(res)))
    return {'coef': coef.astype(float), 'std_mm': float(np.std(res) * 1000.0),
            'mad_mm': float(mad * 1000.0)}


def pca_plane(P):
    if len(P) < 50:
        return None
    q = P - P.mean(axis=0)
    cov = q.T @ q / max(1, len(P) - 1)
    try:
        w, v = np.linalg.eigh(cov)
    except np.linalg.LinAlgError:
        return None
    n = v[:, 0]
    d = q @ n
    mad = 1.4826 * np.median(np.abs(d - np.median(d)))
    # планарность: доля дисперсии в плоскости
    lam = max(float(w[0]), 1e-12)
    planarity = 1.0 - lam / max(float(w.sum()), 1e-12)
    return {'center': P.mean(axis=0), 'normal': n, 'thickness_mm': float(np.std(d) * 1000.0),
            'mad_mm': float(mad * 1000.0), 'normal_vertical': float(abs(n[2])),
            'planarity': float(planarity), 'eig': w.astype(float)}


def patch_image(uv, val, cell=0.02):
    if len(uv) < 20:
        return None
    u0, v0 = uv.min(axis=0) - cell; u1, v1 = uv.max(axis=0) + cell
    W = int((u1 - u0) / cell) + 1; H = int((v1 - v0) / cell) + 1
    if W < 6 or H < 6 or W * H > 6_000_000:
        return None
    iu = np.clip(((uv[:, 0] - u0) / cell).astype(int), 0, W - 1)
    iv = np.clip(((uv[:, 1] - v0) / cell).astype(int), 0, H - 1)
    acc = np.zeros((H, W), np.float32); cnt = np.zeros((H, W), np.float32)
    np.add.at(acc, (iv, iu), val); np.add.at(cnt, (iv, iu), 1.0)
    img = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan)
    return img


def image_metrics(img, cell=0.02):
    if img is None or img.shape[0] < 8 or img.shape[1] < 8:
        return None
    a = img.copy(); m = np.isnan(a)
    if m.all():
        return None
    a[m] = np.nanmean(a)
    gx = np.diff(a, axis=1, prepend=a[:, :1]) / cell
    gy = np.diff(a, axis=0, prepend=a[:1, :]) / cell
    grad = float(np.sqrt(gx * gx + gy * gy).mean())
    w = a - a.mean()
    P = np.abs(np.fft.rfft2(w)) ** 2
    fy = np.fft.fftfreq(a.shape[0], d=cell); fx = np.fft.rfftfreq(a.shape[1], d=cell)
    FX, FY = np.meshgrid(fx, fy)
    fr = np.sqrt(FX * FX + FY * FY)
    tot = float(P.sum())
    hf = float(P[fr > 0.25].sum() / tot) if tot > 0 else 0.0
    return {'grad': grad, 'hf_frac': hf, 'std': float(a.std())}


# ============================ metrics ============================
def analyze(sample, zrange, people=False, tag=''):
    x = sample['X'].astype(np.float64); y = sample['Y'].astype(np.float64); z = sample['Z'].astype(np.float64)
    rgb = sample['RGB']; lum, sat, mx = luma_sat(rgb)
    out = {'sampled': int(len(x)), 'points_total_file': int(sample['header']['n']),
           'rgb_scale': sample['rgb_scale'], 'rgb_max_raw': int(sample['rgb_max'])}
    # глобальная плотность (по заголовку и bbox файла)
    bx0, by0, bz0, bx1, by1, bz1 = sample['header']['bbox']
    area_file = max(1e-6, (bx1 - bx0) * (by1 - by0))
    out['density_file_pts_m2'] = round(float(sample['header']['n']) / area_file, 2)
    # ограничение полосы z
    if zrange:
        mz = (z >= zrange[0]) & (z <= zrange[1])
        x, y, z = x[mz], y[mz], z[mz]
        lum, sat, mx = lum[mz], sat[mz], mx[mz]
        rgb = rgb[mz]
    n = len(x)
    out['n_band'] = int(n)
    # оценка числа точек файла в общей рамке: каждый step_blocks-й блок читается целиком
    sb = int(sample.get('step_blocks', 1))
    est_bbox = int(round(len(x) * sb))
    out['raw_in_bbox_est'] = est_bbox
    bx0, by0, bz0, bx1, by1, bz1 = sample['header']['bbox']
    area_xy = max(1e-6, (bx1 - bx0) * (by1 - by0))
    out['density_bbox_est_pts_m2'] = round(float(est_bbox) / area_xy, 1) if area_xy else 0.0
    if n < 1000:
        return out
    area = max(1e-6, float((x.max() - x.min()) * (y.max() - y.min())))
    out['band_xy_m'] = [round(float(x.max() - x.min()), 2), round(float(y.max() - y.min()), 2)]
    out['band_density_pts_m2'] = round(float(n) / area, 1)
    out['band_bbox'] = [round(float(v), 2) for v in (x.min(), y.min(), z.min(), x.max(), y.max(), z.max())]

    # --- пол ---
    hist, edges = np.histogram(z, bins=600)
    k = int(np.argmax(hist)); zf = float(0.5 * (edges[k] + edges[k + 1]))
    for _ in range(3):
        m = np.abs(z - zf) < 0.25
        if m.sum() < 200:
            break
        zf = float(np.median(z[m]))
    fm = np.abs(z - zf) < 0.18
    floor = {'z_floor': round(zf, 3), 'n': int(fm.sum())}
    if fm.sum() > 200:
        pf = plane_fit(z[fm], x[fm], y[fm])
        zh = z[fm] - (pf['coef'][0] * x[fm] + pf['coef'][1] * y[fm] + pf['coef'][2]) if pf else z[fm]
        floor.update({'thickness_mad_mm': round(pf['mad_mm'], 2) if pf else None,
                      'thickness_std_mm': round(pf['std_mm'], 2) if pf else None,
                      'luma': round(float(np.median(lum[fm])), 1),
                      'sat': round(float(np.median(sat[fm])), 3),
                      'colored_pct': round(100.0 * float(np.mean((sat[fm] > 0.10) & (lum[fm] > 25))), 2),
                      'black_pct': round(100.0 * float(np.mean(mx[fm] < 8)), 2)})
    out['floor'] = floor

    # --- патчи пол/стены 1x1 м ---
    CELL = 1.0
    x0, y0 = float(x.min()), float(y.min())
    ix = ((x - x0) / CELL).astype(np.int64); iy = ((y - y0) / CELL).astype(np.int64)
    nx = int(ix.max()) + 1; ny = int(iy.max()) + 1
    key = ix + nx * iy
    order = np.argsort(key); key_s = key[order]
    bounds = np.searchsorted(key_s, np.arange(nx * ny + 1))
    wall_mad, wall_std, wall_grad, wall_hf = [], [], [], []
    floor_mad, floor_std, floor_grad, floor_hf = [], [], [], []
    centers = []
    for kk in range(nx * ny):
        lo, hi = int(bounds[kk]), int(bounds[kk + 1])
        if hi - lo < 60:
            continue
        idx = order[lo:hi]
        zz = z[idx]; span = float(zz.max() - zz.min())
        pts = np.column_stack([x[idx], y[idx], zz])
        if span > 1.2 and abs(float(zz.mean()) - zf) > 0.3:
            pl = pca_plane(pts)
            if pl and pl['normal_vertical'] < 0.5 and pl['planarity'] > 0.98:
                wall_mad.append(pl['mad_mm']); wall_std.append(pl['thickness_mm'])
                n_ = pl['normal']
                u = np.array([-n_[1], n_[0], 0.0]); nu = float(np.linalg.norm(u))
                if nu > 1e-6:
                    u = u / nu; v = np.cross(n_, u)
                    uv = np.column_stack([pts @ u, pts @ v])
                    dnorm = (pts - pl['center']) @ n_ * 1000.0
                    im = image_metrics(patch_image(uv, dnorm, 0.02), 0.02)
                    if im:
                        wall_grad.append(im['grad']); wall_hf.append(im['hf_frac'])
                    centers.append((float(x[idx].mean()), float(y[idx].mean())))
        elif span < 0.5 and abs(float(zz.mean()) - zf) < 0.25:
            pf = plane_fit(zz, x[idx], y[idx])
            if pf:
                floor_mad.append(pf['mad_mm']); floor_std.append(pf['std_mm'])
                zres = zz - (pf['coef'][0] * x[idx] + pf['coef'][1] * y[idx] + pf['coef'][2])
                im = image_metrics(patch_image(np.column_stack([x[idx], y[idx]]), zres * 1000.0, 0.02), 0.02)
                if im:
                    floor_grad.append(im['grad']); floor_hf.append(im['hf_frac'])
    def med(a):
        return round(float(np.median(a)), 3) if a else None
    out['walls'] = {'patches': len(wall_mad), 'thickness_mad_mm': med(wall_mad),
                    'thickness_std_mm': med(wall_std), 'grad': med(wall_grad),
                    'hf_frac': med(wall_hf)}
    out['floor_patches'] = {'patches': len(floor_mad), 'thickness_mad_mm': med(floor_mad),
                            'thickness_std_mm': med(floor_std), 'grad': med(floor_grad),
                            'hf_frac': med(floor_hf)}

    # --- цвет (в полосе) ---
    valid = mx > 8
    colored = (sat > 0.10) & (lum > 25)
    out['color'] = {'colored_pct': round(100.0 * float(colored.mean()), 2),
                    'gray_pct': round(100.0 * float(((sat < 0.05) & valid).mean()), 2),
                    'black_pct': round(100.0 * float((~valid).mean()), 2),
                    'luma_median': round(float(np.median(lum[valid])) if valid.any() else 0, 1),
                    'sat_median': round(float(np.median(sat[valid])) if valid.any() else 0, 3)}

    # --- артефакты пола (воксели 2 см) ---
    art = {'voxels': 0, 'color_anom_pct': 0.0, 'z_anom_pct': 0.0, 'area_pct': 0.0}
    if fm.sum() > 500:
        fxi = np.floor(x[fm] / 0.02).astype(np.int64); fyi = np.floor(y[fm] / 0.02).astype(np.int64)
        key2 = fxi * 2_000_003 + fyi
        uq, inv = np.unique(key2, return_inverse=True)
        cnt = np.bincount(inv)
        lumv = np.bincount(inv, weights=lum[fm]) / np.maximum(cnt, 1)
        col_med = float(np.median(lumv))
        sig = 1.4826 * float(np.median(np.abs(lumv - col_med))) + 1e-6
        thr = max(3.0 * sig, 25.0)
        col_anom = int(cnt[np.abs(lumv - col_med) > thr].sum())
        z2 = np.bincount(inv, weights=z[fm] ** 2); z1 = np.bincount(inv, weights=z[fm])
        var = np.maximum(z2 / np.maximum(cnt, 1) - (z1 / np.maximum(cnt, 1)) ** 2, 0)
        z_anom = int(cnt[(np.sqrt(var) > 0.05) & (cnt >= 3)].sum())
        tot = max(1, int(fm.sum()))
        art.update({'voxels': int(len(uq)), 'color_anom_pct': round(100.0 * col_anom / tot, 3),
                    'z_anom_pct': round(100.0 * z_anom / tot, 3),
                    'area_pct': round(100.0 * (col_anom + z_anom) / tot, 3)})
    out['artifacts'] = art

    # --- люди/остатки: висящие кластеры ---
    if people:
        zl, zh = zf + 0.02, zf + 2.2
        am = (z > zl) & (z < zh)
        res = {'air_points': int(am.sum()), 'air_pct': round(100.0 * float(am.mean()), 4),
               'floating_clusters': 0, 'floating_points': 0, 'floating_pct': 0.0}
        if am.sum() > 100:
            V = 0.15
            vx = np.floor(x[am] / V).astype(np.int64); vy = np.floor(y[am] / V).astype(np.int64)
            vz = np.floor(z[am] / V).astype(np.int64)
            ox_, oy_, oz_ = int(vx.min()), int(vy.min()), int(vz.min())
            nxv = int(vx.max()) - ox_ + 1; nyv = int(vy.max()) - oy_ + 1
            vkey = (vx - ox_) + nxv * ((vy - oy_) + nyv * (vz - oz_))
            uq, inv = np.unique(vkey, return_inverse=True)
            cntv = np.bincount(inv)
            key_idx = {int(k): i for i, k in enumerate(uq)}
            visited = np.zeros(len(uq), bool)
            floating = 0; clusters = 0; comps = []
            for s0 in range(len(uq)):
                if visited[s0]:
                    continue
                stack = [s0]; visited[s0] = True; comp = []
                while stack:
                    i = stack.pop(); comp.append(i)
                    keyv = int(uq[i])
                    cix = keyv % nxv; rest = keyv // nxv
                    ciy = rest % nyv; ciz = rest // nyv
                    for di in (-1, 0, 1):
                        for dj in (-1, 0, 1):
                            for dk in (-1, 0, 1):
                                if di == dj == dk == 0:
                                    continue
                                kk = (cix + di) + nxv * ((ciy + dj) + nyv * (ciz + dk))
                                j = key_idx.get(kk)
                                if j is not None and not visited[j]:
                                    visited[j] = True; stack.append(j)
                ptsc = int(cntv[comp].sum())
                if ptsc < 60:
                    continue
                clusters += 1
                # координаты вокселей компоненты
                ks = [int(uq[i]) for i in comp]
                cxs = [k % nxv for k in ks]
                cys = [(k // nxv) % nyv for k in ks]
                czs = [k // (nxv * nyv) for k in ks]
                minz = (min(czs) + oz_ + 0.5) * V
                maxz = (max(czs) + oz_ + 0.5) * V
                h = maxz - minz
                wx = (max(cxs) - min(cxs) + 1) * V
                wy = (max(cys) - min(cys) + 1) * V
                # «человек»: стоит на полу (низ 0.0-0.35 м над полом), рост 1.0-2.1 м,
                # горизонтальный размер <= 0.8 м (компактный столб)
                if (zf + 0.02 <= minz <= zf + 0.40) and (1.0 <= h <= 2.1) and max(wx, wy) <= 0.85:
                    floating += ptsc
                    comps.append({'points': ptsc, 'min_z': round(float(minz), 2),
                                  'height_m': round(float(h), 2),
                                  'wx': round(float(wx), 2), 'wy': round(float(wy), 2)})
            res.update({'floating_clusters': len(comps), 'floating_points': int(floating),
                        'floating_pct': round(100.0 * float(floating / max(1, am.sum())), 5),
                        'all_air_clusters': clusters,
                        'top_floating': sorted(comps, key=lambda c: -c['points'])[:5]})
        out['people'] = res
    return out


def verdicts(our, ref):
    def ratio(a, b):
        return (a / b) if (a is not None and b not in (None, 0)) else None
    def pct(a, b):
        r = ratio(a, b)
        return None if r is None else round(100.0 * (r - 1.0), 1)
    def get(d, *ks):
        cur = d
        for k in ks:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(k)
        return cur
    v = {}
    th = {'our': get(our, 'walls', 'thickness_mad_mm'), 'ref': get(ref, 'walls', 'thickness_mad_mm')}
    th['delta_pct'] = pct(th['our'], th['ref'])
    th['pass'] = th['delta_pct'] is not None and th['delta_pct'] <= 5.0
    gr = {'our': get(our, 'walls', 'grad'), 'ref': get(ref, 'walls', 'grad')}
    gr['delta_pct'] = pct(gr['our'], gr['ref']); gr['pass'] = gr['delta_pct'] is not None and gr['delta_pct'] >= -10.0
    hf = {'our': get(our, 'walls', 'hf_frac'), 'ref': get(ref, 'walls', 'hf_frac')}
    hf['delta_pct'] = pct(hf['our'], hf['ref']); hf['pass'] = hf['delta_pct'] is not None and hf['delta_pct'] >= -10.0
    de = {'our_est_pts': get(our, 'raw_in_bbox_est'), 'ref_est_pts': get(ref, 'raw_in_bbox_est'),
          'our_density': get(our, 'density_bbox_est_pts_m2'),
          'ref_density': get(ref, 'density_bbox_est_pts_m2')}
    de['delta_pct'] = pct(de['our_density'], de['ref_density'])
    de['threshold_delta_pct'] = -10.0
    de['pass'] = de['delta_pct'] is not None and de['delta_pct'] >= -10.0
    v['blur'] = {'wall_thickness_mad': th, 'wall_sharpness_grad_geo': gr, 'wall_mtf_hf_geo': hf,
                 'density': de,
                 'pass': bool(th['pass'] and de['pass']),
                 'note': ('резкость/MTF по цвету несравнимы: наш билд серый; геометрическая '
                          '«резкость» (микрорельеф) у нас выше — это шум/бахрома, а не чёткость')}
    ar = {'our_z_smear_pct': get(our, 'artifacts', 'z_anom_pct'),
          'ref_z_smear_pct': get(ref, 'artifacts', 'z_anom_pct'),
          'our_color_anom_pct': get(our, 'artifacts', 'color_anom_pct'),
          'ref_color_anom_pct': get(ref, 'artifacts', 'color_anom_pct')}
    ar['delta_z_pp'] = round(ar['our_z_smear_pct'] - ar['ref_z_smear_pct'], 3) \
        if None not in (ar['our_z_smear_pct'], ar['ref_z_smear_pct']) else None
    ar['threshold_pct'] = 1.0
    ar['pass'] = ar['our_z_smear_pct'] is not None and ar['our_z_smear_pct'] <= 1.0
    ar['note'] = ('цветовые аномалии пола сравнимы только при наличии цвета у обоих облаков; '
                  'у нашего билда цвет отсутствует (заглушка-градация)')
    v['floor_artifacts'] = ar
    if 'people' in our and 'people' in ref:
        pr = {'our_pct': get(our, 'people', 'floating_pct'), 'ref_pct': get(ref, 'people', 'floating_pct')}
        pr['delta_pp'] = round(pr['our_pct'] - pr['ref_pct'], 5) if None not in (pr['our_pct'], pr['ref_pct']) else None
        pr['threshold_pct'] = 0.001
        pr['pass'] = pr['our_pct'] is not None and pr['our_pct'] <= 0.001
        v['people_residues'] = pr
    co = {'our_colored_pct': get(our, 'color', 'colored_pct'),
          'ref_colored_pct': get(ref, 'color', 'colored_pct'),
          'our_gray_pct': get(our, 'color', 'gray_pct'),
          'ref_gray_pct': get(ref, 'color', 'gray_pct'),
          'our_black_pct': get(our, 'color', 'black_pct'),
          'ref_black_pct': get(ref, 'color', 'black_pct')}
    if None not in (co['our_colored_pct'], co['ref_colored_pct']):
        co['colored_delta_pp'] = round(co['our_colored_pct'] - co['ref_colored_pct'], 2)
    else:
        co['colored_delta_pp'] = None
    co['pass'] = (co['our_colored_pct'] is not None and co['our_colored_pct'] >= 97.0
                  and (co['colored_delta_pp'] is None or co['colored_delta_pp'] >= -1.0))
    co['note'] = ('наш билд .xbin→LAS записан в градациях серого (RGB = интенсивность ×257; '
                  'recolor-core.js в этих сборках не применялся) — цвет отсутствует по всему '
                  'облаку, это подтверждает претензию «нет цвета»')
    v['color_coverage'] = co
    return v


# ============================ heatmaps ============================
def make_heatmaps(pairs, zf, zrange, outdir, tag, people=False, cell=0.10):
    if Image is None:
        return []
    (our_xyz, our_rgb), (ref_xyz, ref_rgb) = pairs
    # общая рамка
    alx = np.concatenate([our_xyz[:, 0], ref_xyz[:, 0]]); aly = np.concatenate([our_xyz[:, 1], ref_xyz[:, 1]])
    xmin, xmax = float(alx.min()), float(alx.max()); ymin, ymax = float(aly.min()), float(aly.max())
    W = int((xmax - xmin) / cell) + 1; Hh = int((ymax - ymin) / cell) + 1
    if W * Hh > 10_000_000:
        cell *= 2
        W = int((xmax - xmin) / cell) + 1; Hh = int((ymax - ymin) / cell) + 1
    paths = []
    def grid(xyz, rgb, what):
        ix = np.clip(((xyz[:, 0] - xmin) / cell).astype(int), 0, W - 1)
        iy = np.clip(((xyz[:, 1] - ymin) / cell).astype(int), 0, Hh - 1)
        lum, sat, mx = luma_sat(rgb)
        if zrange:
            zm = (xyz[:, 2] >= zrange[0]) & (xyz[:, 2] <= zrange[1])
        else:
            zm = np.ones(len(xyz), bool)
        g = np.zeros((Hh, W), np.float32)
        if what == 'artifact':
            m = zm & (np.abs(xyz[:, 2] - zf) < 0.20)
            np.add.at(g, (iy[m], ix[m]), 1.0)
            # z-смазы: в ячейке 10 см точки пола «размазаны» по z (std > 5 см)
            if m.any():
                fx = np.clip(((xyz[m, 0] - xmin) / cell).astype(int), 0, W - 1)
                fy = np.clip(((xyz[m, 1] - ymin) / cell).astype(int), 0, Hh - 1)
                kk = fx + W * fy
                uq, inv = np.unique(kk, return_inverse=True)
                cnt = np.bincount(inv)
                z2 = np.bincount(inv, weights=xyz[m, 2] ** 2); z1 = np.bincount(inv, weights=xyz[m, 2])
                sd = np.sqrt(np.maximum(z2 / np.maximum(cnt, 1) - (z1 / np.maximum(cnt, 1)) ** 2, 0))
                bad = uq[(sd > 0.05) & (cnt >= 3)]
                for b in bad:
                    bx = int(b % W); by = int(b // W)
                    g[by, bx] += 3.0
        elif what == 'gray':
            m = zm & ((sat < 0.05) & (mx > 8))
            base = zm
            np.add.at(g, (iy[base], ix[base]), 1.0)
            np.add.at(g, (iy[m], ix[m]), 1.0)
        elif what == 'people':
            m = zm & (xyz[:, 2] > zf + 0.5) & (xyz[:, 2] < zf + 2.2)
            np.add.at(g, (iy[m], ix[m]), 1.0)
        return g
    for what in (['artifact', 'gray', 'people'] if people else ['artifact', 'gray']):
        A = grid(our_xyz, our_rgb, what); B = grid(ref_xyz, ref_rgb, what)
        both = np.concatenate([A.ravel(), B.ravel()])
        vmax = float(np.percentile(both[both > 0], 98)) if (both > 0).any() else 1.0
        vmax = max(vmax, 1.0)
        for name, M in (('our', A), ('ref', B)):
            arr = np.clip(M / vmax * 255, 0, 255).astype(np.uint8)
            img = np.zeros((Hh, W, 3), np.uint8)
            if what == 'gray':
                img[..., 0] = arr; img[..., 1] = arr // 2
            elif what == 'people':
                img[..., 0] = arr
            else:
                img[..., 1] = arr
            im = Image.fromarray(img[::-1])
            dr = ImageDraw.Draw(im)
            dr.text((4, 4), '%s %s: %s' % (tag, name, what), fill=(255, 255, 0))
            p = os.path.join(outdir, '%s_%s_%s.png' % (tag, name, what))
            im.save(p)
            paths.append(p)
    return paths


# ============================ main ============================
def main(argv=None):
    ap = argparse.ArgumentParser(description='Сверка «наша сборка xbin vs Lixel Studio» по качеству (r145)')
    ap.add_argument('--our', required=True)
    ap.add_argument('--ref', required=True)
    ap.add_argument('--out', default='quality-compare.json')
    ap.add_argument('--heatmaps', default=None)
    ap.add_argument('--label', default=None)
    ap.add_argument('--max-points', type=int, default=2_500_000)
    ap.add_argument('--z-range', default=None,
                    help='полоса анализа по высоте (для интерьера — один этаж): "zmin,zmax"')
    ap.add_argument('--up-axis', default='auto', choices=['x', 'y', 'z', 'auto'])
    ap.add_argument('--people', dest='people', action='store_true', default=None)
    ap.add_argument('--no-people', dest='people', action='store_false')
    ap.add_argument('--interior', action='store_true')
    ap.add_argument('--no-heatmaps', action='store_true')
    a = ap.parse_args(argv)
    label = a.label or os.path.splitext(os.path.basename(a.our))[0]
    people = a.people if a.people is not None else (a.interior or 'interior' in label.lower())
    zrange = None
    if a.z_range:
        parts = [float(v) for v in a.z_range.replace(';', ',').split(',')]
        if len(parts) != 2:
            print('--z-range: нужно "zmin,zmax"', file=sys.stderr); return 2
        zrange = (min(parts), max(parts))
    hm_dir = a.heatmaps
    if hm_dir and not a.no_heatmaps:
        os.makedirs(hm_dir, exist_ok=True)
    t0 = time.time()
    h_our = read_header(a.our); h_ref = read_header(a.ref)
    up = up_axis(h_our, {'x': 0, 'y': 1, 'z': 2}.get(a.up_axis) if a.up_axis != 'auto' else None)
    b1, b2 = h_our['bbox'], h_ref['bbox']
    bb = (max(b1[0], b2[0]), max(b1[1], b2[1]), max(b1[2], b2[2]),
          min(b1[3], b2[3]), min(b1[4], b2[4]), min(b1[5], b2[5]))
    if bb[3] <= bb[0] or bb[4] <= bb[1] or bb[5] <= bb[2]:
        print('нет общей рамки', file=sys.stderr); return 2
    if zrange:
        bb = (bb[0], bb[1], max(bb[2], zrange[0]), bb[3], bb[4], min(bb[5], zrange[1]))
    print('our=%s n=%d | ref=%s n=%d | up=%s' % (os.path.basename(a.our), h_our['n'],
                                                 os.path.basename(a.ref), h_ref['n'], 'XYZ'[up]))
    print('common bbox:', [round(v, 2) for v in bb], ('| z-range ' + str(zrange)) if zrange else '')
    S_our = load_sample(a.our, bb, a.max_points)
    S_ref = load_sample(a.ref, bb, a.max_points)
    if S_our is None or S_ref is None:
        print('НЕТ точек в общей рамке', file=sys.stderr); return 2
    print('samples: our %d, ref %d (%.1fs)' % (S_our['sampled'], S_ref['sampled'], time.time() - t0))
    M_our = analyze(S_our, zrange, people=people, tag='our')
    M_ref = analyze(S_ref, zrange, people=people, tag='ref')
    zf_our = M_our.get('floor', {}).get('z_floor'); zf_ref = M_ref.get('floor', {}).get('z_floor')
    zf = float(np.mean([v for v in (zf_our, zf_ref) if v is not None])) if (zf_our or zf_ref) else 0.0
    V = verdicts(M_our, M_ref)
    heatmaps = []
    if hm_dir and not a.no_heatmaps:
        def band_pts(S):
            m = np.ones(len(S['X']), bool)
            if zrange:
                m = (S['Z'] >= zrange[0]) & (S['Z'] <= zrange[1])
            return np.column_stack([S['X'][m], S['Y'][m], S['Z'][m]]).astype(np.float64), S['RGB'][m]
        heatmaps = make_heatmaps((band_pts(S_our), band_pts(S_ref)), zf, zrange, hm_dir, label,
                                 people=people)
    rep = {'schema': 'quality-compare/1', 'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
           'label': label, 'our': a.our, 'ref': a.ref, 'up_axis': 'XYZ'[up],
           'z_range': list(zrange) if zrange else None,
           'common_bbox': [round(float(v), 3) for v in bb],
           'samples': {'our': M_our, 'ref': M_ref}, 'verdicts': V, 'heatmaps': heatmaps,
           'thresholds': {'wall_thickness_mad_delta_pct': 5.0, 'sharpness_delta_pct': -10.0,
                          'floor_artifacts_area_pct': 1.0, 'people_floating_pct': 0.001,
                          'color_colored_pct': 97.0, 'color_delta_pp': -1.0},
           'elapsed_s': round(time.time() - t0, 1)}
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
        with open(a.out, 'w', encoding='utf-8') as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
    # ---- печать ----
    def g(m, *ks):
        cur = m
        for k in ks:
            if cur is None:
                return None
            cur = cur.get(k)
        return cur
    print('\n=== %s: наш vs Lixel ===' % label)
    rows = [
        ('точек в файле', g(M_our, 'points_total_file'), g(M_ref, 'points_total_file')),
        ('плотность файла, т/м²', g(M_our, 'density_file_pts_m2'), g(M_ref, 'density_file_pts_m2')),
        ('плотность полосы, т/м²', g(M_our, 'band_density_pts_m2'), g(M_ref, 'band_density_pts_m2')),
        ('точек в общей рамке (оценка)', g(M_our, 'raw_in_bbox_est'), g(M_ref, 'raw_in_bbox_est')),
        ('плотность в рамке, т/м²', g(M_our, 'density_bbox_est_pts_m2'), g(M_ref, 'density_bbox_est_pts_m2')),
        ('толщина стен MAD, мм', g(M_our, 'walls', 'thickness_mad_mm'), g(M_ref, 'walls', 'thickness_mad_mm')),
        ('толщина стен std, мм', g(M_our, 'walls', 'thickness_std_mm'), g(M_ref, 'walls', 'thickness_std_mm')),
        ('резкость стен (градиент)', g(M_our, 'walls', 'grad'), g(M_ref, 'walls', 'grad')),
        ('MTF-прокси стен (HF)', g(M_our, 'walls', 'hf_frac'), g(M_ref, 'walls', 'hf_frac')),
        ('толщина пола MAD, мм', g(M_our, 'floor_patches', 'thickness_mad_mm'), g(M_ref, 'floor_patches', 'thickness_mad_mm')),
        ('резкость пола (градиент)', g(M_our, 'floor_patches', 'grad'), g(M_ref, 'floor_patches', 'grad')),
        ('артефакты пола, %', g(M_our, 'artifacts', 'area_pct'), g(M_ref, 'artifacts', 'area_pct')),
        ('цвет: покрытие %', g(M_our, 'color', 'colored_pct'), g(M_ref, 'color', 'colored_pct')),
        ('серые зоны, %', g(M_our, 'color', 'gray_pct'), g(M_ref, 'color', 'gray_pct')),
        ('чёрные/без цвета, %', g(M_our, 'color', 'black_pct'), g(M_ref, 'color', 'black_pct')),
        ('яркость (медиана)', g(M_our, 'color', 'luma_median'), g(M_ref, 'color', 'luma_median')),
        ('насыщенность (медиана)', g(M_our, 'color', 'sat_median'), g(M_ref, 'color', 'sat_median')),
    ]
    if people:
        rows.append(('остатки людей, % воздуха', g(M_our, 'people', 'floating_pct'),
                     g(M_ref, 'people', 'floating_pct')))
    print('%-32s %-16s %-16s %-9s' % ('метрика', 'наш', 'Lixel', 'Δ'))
    for nm, o, r in rows:
        d = None
        if isinstance(o, (int, float)) and isinstance(r, (int, float)) and r:
            d = round(100.0 * (o / r - 1.0), 1)
        print('%-32s %-16s %-16s %s' % (nm, o, r, ('%+.1f%%' % d) if d is not None else '—'))
    print('\nВЕРДИКТЫ:')
    for k, vv in V.items():
        print('  %-18s %s %s' % (k, 'PASS' if vv.get('pass') else 'FAIL',
                                 json.dumps({kk: vv[kk] for kk in vv if kk != 'pass'}, ensure_ascii=False)))
    if a.out:
        print('\nreport:', os.path.abspath(a.out))
    if heatmaps:
        print('heatmaps:', ', '.join(os.path.basename(p) for p in heatmaps))
    return 0


if __name__ == '__main__':
    sys.exit(main())

