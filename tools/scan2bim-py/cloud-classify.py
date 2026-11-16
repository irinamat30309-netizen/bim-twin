#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cloud-classify.py — P1-функция «Классификация облака (семантика)», r149.

Классифицирует облако по геометрии (без нейросетей) на классы:
  ground/floor — пол/земля (горизонтальная плоскость у нижнего локального уровня)
  wall         — стены (вертикальные плоскости)
  roof         — крыши/потолки (горизонтальные поверхности сверху)
  vegetation   — растительность (высокая шероховатость, вне зданий)
  people       — люди/динамика (компактные кластеры 1–2 м без опоры)
  clutter      — мелкие предметы/мебель (компактные кластеры у пола/стен)
  other        — прочее

Выход:
  * --out-las — копия входного LAS с ASPRS classification:
      1 other/unclassified, 2 ground/floor, 5 vegetation, 6 wall+roof (building),
      7 clutter (reserved/low noise), 18 people (high-noise, для --refine-dynamic удаляются)
  * --out-bin — «наш формат»: float32 x,y,z,r,g,b + float32 class + float32 confidence (8 значений на точку;
    при чтении .bin 6 значений — обычное облако, 8 — классифицированное)
  * --json — статистика (% по классам, уверенность, время, память)
  * --preview — PNG-визуализация по классам (вид сверху и разрез)
  * --refine-dynamic — люди удаляются из LAS (и из bin), в JSON — сколько удалено

Вход: LAS 1.0–1.4 (fmt 0–10, без LAZ), PLY (ascii/binary little endian), наш .bin.
Вся геометрия считается numpy; scipy/sklearn не требуются (их может не быть в сборке).

Запуск:
  python cloud-classify.py in.las --out-las out.las --json stats.json --preview preview.png
  python cloud-classify.py cloud.bin --out-bin cloud-classified.bin --json stats.json
  python cloud-classify.py --self-test --json D:/BIM-TWIN-TEST/r55/classify-r149/self-test.json --preview ...
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

VERSION = 'r149.1'

CLASSES = ['ground_floor', 'wall', 'roof', 'vegetation', 'people', 'clutter', 'other']
CLS = {name: i for i, name in enumerate(CLASSES)}
ASPRS = {  # внутренний класс → ASPRS classification
    'ground_floor': 2, 'wall': 6, 'roof': 6, 'vegetation': 5,
    'people': 18, 'clutter': 7, 'other': 1,
}
# цвета классов для превью (RGB)
PALETTE = {
    'ground_floor': (140, 109, 74), 'wall': (74, 144, 217), 'roof': (217, 74, 74),
    'vegetation': (63, 174, 74), 'people': (232, 232, 58), 'clutter': (176, 106, 217), 'other': (158, 158, 158),
}

LAS_RGB_OFF = {2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30}
LAS_CLASS_OFF = {0: 15, 1: 15, 2: 15, 3: 15, 4: 15, 5: 15, 6: 16, 7: 16, 8: 16, 9: 16, 10: 16}
LAS_T_OFF = {1: 20, 3: 20, 4: 20, 5: 20, 6: 22, 7: 22, 8: 22, 9: 22, 10: 22}


# ----------------------------------------------------------------------------- memory
def peak_mb():
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
        pmc = PMC(); pmc.cb = ctypes.sizeof(pmc)
        h = ctypes.windll.kernel32.OpenProcess(0x0400 | 0x0010, False, os.getpid())
        r = ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb) if h else 0
        if not r:
            ctypes.windll.kernel32.K32GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(),
                                                           ctypes.byref(pmc), pmc.cb)
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
        if pmc.PeakWorkingSetSize > 0:
            return round(pmc.PeakWorkingSetSize / (1024 * 1024), 1)
    except Exception:
        try:
            import resource
            return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
        except Exception:
            return None


# ----------------------------------------------------------------------------- readers
def _las_header(fh):
    h = fh.read(375)
    if h[:4] != b'LASF':
        raise ValueError('не LAS: ' + fh.name)
    minor, off = h[25], struct.unpack_from('<I', h, 96)[0]
    fmt, rl = h[104] & 0x3f, struct.unpack_from('<H', h, 105)[0]
    if h[104] & 0x80:
        raise ValueError('сжатый LAZ не поддерживается — нужен обычный LAS')
    n = struct.unpack_from('<I', h, 107)[0]
    if minor >= 4:
        n2 = struct.unpack_from('<Q', h, 247)[0]
        if n2 > 0:
            n = n2
    sx, sy, sz = (struct.unpack_from('<d', h, o)[0] for o in (131, 139, 147))
    ox, oy, oz = (struct.unpack_from('<d', h, o)[0] for o in (155, 163, 171))
    return {'minor': minor, 'off': off, 'fmt': fmt, 'rl': rl, 'n': n, 's': (sx, sy, sz), 'o': (ox, oy, oz),
            'rgb': LAS_RGB_OFF.get(fmt), 'class_off': LAS_CLASS_OFF.get(fmt), 'header375': h}


def read_las(path, max_points=None):
    """→ X (N,3) float32 Z-up, rgb (N,3) uint8|None, meta"""
    with open(path, 'rb') as fh:
        H = _las_header(fh)
        fh.seek(0)
        n = H['n'] if max_points is None else min(H['n'], int(max_points))
        rl, off = H['rl'], H['off']
        X = np.empty((n, 3), np.float32)
        rgb = np.empty((n, 3), np.uint8) if H['rgb'] is not None else None
        CH = 1 << 20
        for i in range(0, n, CH):
            c = min(CH, n - i)
            fh.seek(off + i * rl)
            raw = np.frombuffer(fh.read(c * rl), np.uint8).reshape(c, rl)
            XYZ = raw[:, 0:12].copy().view(np.int32).astype(np.float64)
            X[i:i + c, 0] = XYZ[:, 0] * H['s'][0] + H['o'][0]
            X[i:i + c, 1] = XYZ[:, 1] * H['s'][1] + H['o'][1]
            X[i:i + c, 2] = XYZ[:, 2] * H['s'][2] + H['o'][2]
            if rgb is not None:
                rgb[i:i + c] = raw[:, H['rgb']:H['rgb'] + 3]
        meta = {k: v for k, v in H.items() if k != 'header375'}
        meta['path'] = path
        meta['header375'] = H['header375']
        return X, rgb, meta


def read_ply(path, max_points=None):
    with open(path, 'rb') as f:
        head = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError('плохой PLY (нет end_header)')
            head.append(line.decode('latin1').rstrip())
            if head[-1] == 'end_header':
                break
        fmt = next((l for l in head if l.startswith('format')), 'format ascii 1.0')
        if 'binary_little_endian' in fmt:
            binary, be = True, False
        elif 'binary_big_endian' in fmt:
            raise ValueError('PLY big_endian не поддерживается')
        else:
            binary, be = False, False
        nvert = 0
        props = []
        in_vertex = False
        for l in head:
            if l.startswith('element vertex'):
                nvert = int(l.split()[2]); in_vertex = True; continue
            if l.startswith('element '):
                in_vertex = False; continue
            if in_vertex and l.startswith('property'):
                a = l.split()
                props.append((a[-1], a[-2]))
        if not nvert:
            raise ValueError('в PLY нет вершин')
        n = nvert if max_points is None else min(nvert, int(max_points))
        if binary:
            ty = {'float': '<f4', 'float32': '<f4', 'double': '<f8', 'float64': '<f8'}
            dt = np.dtype([(p[0], ty[p[1]]) for p in props])
            data = np.frombuffer(f.read(dt.itemsize * n), dt, count=n)
            X = np.stack([data['x'].astype(np.float32), data['y'].astype(np.float32), data['z'].astype(np.float32)], axis=1)
        else:
            rows = []
            for l in f:
                if len(rows) >= n:
                    break
                s = l.split()
                if s:
                    rows.append(s)
            cols = {p[0]: i for i, p in enumerate(props)}
            arr = np.array(rows, dtype=np.float64)
            X = np.stack([arr[:, cols['x']], arr[:, cols['y']], arr[:, cols['z']]], axis=1).astype(np.float32)
    return X, None, {'kind': 'ply', 'path': path, 'n': len(X)}


def read_bin(path, max_points=None):
    """наш формат: float32 (x,y,z,r,g,b) или классифицированный (x,y,z,r,g,b,class,conf); Y вверх."""
    size = os.path.getsize(path)
    if size % (8 * 4) == 0 and size % (6 * 4) != 0:
        stride = 8
    elif size % (6 * 4) == 0:
        stride = 6
    else:
        raise ValueError('размер .bin не кратен 6 или 8 float32')
    n = size // (4 * stride)
    if max_points is not None:
        n = min(n, int(max_points))
    A = np.fromfile(path, dtype=np.float32, count=n * stride).reshape(n, stride)
    # Y-вверх (app): внутренние оси Z-вверх → (x, z_view, y_view)
    X = np.stack([A[:, 0], A[:, 2], A[:, 1]], axis=1).astype(np.float32)
    rgb = np.clip(A[:, 3:6], 0, 255).astype(np.uint8) if stride >= 6 else None
    return X, rgb, {'kind': 'bin', 'path': path, 'n': len(X), 'stride': stride}


def read_cloud(path, max_points=None):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.las':
        return read_las(path, max_points) + ('las',)
    if ext == '.ply':
        return read_ply(path, max_points) + ('ply',)
    if ext == '.bin':
        return read_bin(path, max_points) + ('bin',)
    raise ValueError('неизвестный формат: ' + ext)


# ----------------------------------------------------------------------------- features
def _voxel_stats(X, s):
    """Статистика по вокселам размера s: n, mean, ковариация → нормаль/признаки.
    → ids (N,), n (M,), planarity, linearity, verticality, curvature, rough (N,), density (M,)"""
    mn = X.min(axis=0)
    key = np.floor((X - mn) / np.float32(s)).astype(np.int64)
    key -= key.min(axis=0)
    nx = int(key[:, 0].max()) + 1
    ny = int(key[:, 1].max()) + 1
    nz = int(key[:, 2].max()) + 1
    k1 = key[:, 0] + nx * (key[:, 1] + ny * key[:, 2])
    uk, inv = np.unique(k1, return_inverse=True)
    M = len(uk)
    w = np.bincount(inv, minlength=M).astype(np.float64)
    S = np.zeros((M, 10))
    p = X.astype(np.float64)
    for j in range(3):
        S[:, j] = np.bincount(inv, weights=p[:, j], minlength=M)
    S[:, 3] = np.bincount(inv, weights=p[:, 0] * p[:, 0], minlength=M)
    S[:, 4] = np.bincount(inv, weights=p[:, 1] * p[:, 1], minlength=M)
    S[:, 5] = np.bincount(inv, weights=p[:, 2] * p[:, 2], minlength=M)
    S[:, 6] = np.bincount(inv, weights=p[:, 0] * p[:, 1], minlength=M)
    S[:, 7] = np.bincount(inv, weights=p[:, 0] * p[:, 2], minlength=M)
    S[:, 8] = np.bincount(inv, weights=p[:, 1] * p[:, 2], minlength=M)
    mx = S[:, 0] / w; my = S[:, 1] / w; mz = S[:, 2] / w
    cxx = S[:, 3] / w - mx * mx; cyy = S[:, 4] / w - my * my; czz = S[:, 5] / w - mz * mz
    cxy = S[:, 6] / w - mx * my; cxz = S[:, 7] / w - mx * mz; cyz = S[:, 8] / w - my * mz
    C = np.empty((M, 3, 3), np.float64)
    C[:, 0, 0] = cxx; C[:, 1, 1] = cyy; C[:, 2, 2] = czz
    C[:, 0, 1] = C[:, 1, 0] = cxy; C[:, 0, 2] = C[:, 2, 0] = cxz; C[:, 1, 2] = C[:, 2, 1] = cyz
    ev, evec = np.linalg.eigh(C)
    l1 = np.maximum(ev[:, 2], 1e-12); l2 = np.maximum(ev[:, 1], 0); l3 = np.maximum(ev[:, 0], 0)
    planarity = (l2 - l3) / l1
    linearity = (l1 - l2) / l1
    curv = l3 / (l1 + l2 + l3 + 1e-12)
    nrm = evec[:, :, 0]  # собств. вектор min
    verticality = np.abs(nrm[:, 2])
    # невязка точки к плоскости воксела
    d = nx * 0 + nrm[:, 0] * mx + nrm[:, 1] * my + nrm[:, 2] * mz
    rough_pt = np.abs(nrm[inv, 0] * p[:, 0] + nrm[inv, 1] * p[:, 1] + nrm[inv, 2] * p[:, 2] - d[inv])
    density = w / (s * s * s)
    # признаки — на точку (через принадлежность вокселу)
    return {'ids': inv, 'n': w.astype(np.int32), 'plan': planarity[inv].astype(np.float32),
            'lin': linearity[inv].astype(np.float32), 'vert': verticality[inv].astype(np.float32),
            'curv': curv[inv].astype(np.float32), 'rough': rough_pt.astype(np.float32),
            'dens': density[inv].astype(np.float32)}


def _map_point_ids(ids, x):
    return ids  # ids уже per-point


def _floor_field(X, cell=1.0, q=3.0, smooth=1):
    """Локальный уровень пола: q-й перцентиль z в ячейках cell, затем сглаживание min по 3×3."""
    mn = X[:, :2].min(axis=0)
    ij = np.floor((X[:, :2] - mn) / cell).astype(np.int64)
    ij -= ij.min(axis=0)
    nx = int(ij[:, 0].max()) + 1; ny = int(ij[:, 1].max()) + 1
    key = ij[:, 0] + nx * ij[:, 1]
    uk, inv = np.unique(key, return_inverse=True)
    M = len(uk)
    z = X[:, 2].astype(np.float64)
    # аппроксимация перцентиля: сортировка группой через argsort
    order = np.argsort(inv, kind='stable')
    inv_s = inv[order]; z_s = z[order]
    starts = np.searchsorted(inv_s, np.arange(M))
    ends = np.searchsorted(inv_s, np.arange(M), side='right')
    floor = np.full(M, np.nan)
    for m in range(M):
        if ends[m] > starts[m]:
            a = z_s[starts[m]:ends[m]]
            floor[m] = np.percentile(a, q)
    F = floor.reshape(nx, ny)
    # заполнить пустые ячейки соседями (итеративно), затем min-фильтр
    for _ in range(8):
        if not np.isnan(F).any():
            break
        F2 = F.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                S = np.roll(np.roll(F, dy, 0), dx, 1)
                m = np.isnan(F2) & ~np.isnan(S)
                F2[m] = S[m]
        F = F2
    if np.isnan(F).any():
        F[np.isnan(F)] = np.nanmin(F)
    for _ in range(max(0, smooth)):
        P = np.pad(F, 1, mode='edge')
        F = np.minimum.reduce([P[1:-1, 1:-1], P[:-2, 1:-1], P[2:, 1:-1], P[1:-1, :-2], P[1:-1, 2:],
                               P[:-2, :-2], P[:-2, 2:], P[2:, :-2], P[2:, 2:]])
    I = np.clip(ij[:, 0], 0, nx - 1); J = np.clip(ij[:, 1], 0, ny - 1)
    return F[I, J]


# ----------------------------------------------------------------------------- components
def _labels_for(keys_pt, nvals, offsets, base):
    """Связные компоненты по воксельным ключам (union-find, numpy-поиск рёбер)."""
    uk, inv = np.unique(keys_pt, return_inverse=True)
    parent = np.arange(len(uk), dtype=np.int64)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for off in offsets:
        nb = uk + off
        pos = np.searchsorted(uk, nb)
        pos = np.clip(pos, 0, len(uk) - 1)
        ok = (uk[pos] == nb) & (pos != np.arange(len(uk)))
        A = np.nonzero(ok)[0]
        B = pos[ok]
        for a, b in zip(A.tolist(), B.tolist()):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
    roots = np.array([find(i) for i in range(len(uk))], np.int64)
    ur, lab = np.unique(roots, return_inverse=True)
    return lab[inv], len(ur)


def _cluster_stats(X, labels, nlab):
    """Компактная статистика по компонентам: bbox (extent), кол-во, z-диапазон, planarity сред., доля veg."""
    out = []
    for lab in np.unique(labels):
        m = labels == lab
        n = int(m.sum())
        if n == 0:
            continue
        xs = X[m]
        mn = xs.min(axis=0); mx = xs.max(axis=0)
        out.append({'label': int(lab), 'n': n, 'mn': mn, 'mx': mx,
                    'ext': float(np.max(mx - mn)), 'zspan': float(mx[2] - mn[2])})
    return out


# ----------------------------------------------------------------------------- classification
def classify(X, opt):
    """Основная классификация. → cls (N,) uint8 индексы CLASSES, conf (N,) float32, stats dict"""
    t0 = time.time()
    N = len(X)
    st = {'points': int(N)}
    if N == 0:
        raise ValueError('пустое облако')
    # ---- нормировка осей: Z-вверх (для .bin уже переставлено)
    z = X[:, 2]
    vox = float(opt['voxel'])
    Fs = _voxel_stats(X, vox)
    Fb = _voxel_stats(X, vox * 3.0)
    plan_s, vert_s, rough_s = Fs['plan'], Fs['vert'], Fs['rough']
    plan_b, vert_b, rough_b, dens_s, dens_b = Fb['plan'], Fb['vert'], Fb['rough'], Fs['dens'], Fb['dens']
    lin_s, curv_s = Fs['lin'], Fs['curv']
    floor_z = _floor_field(X, cell=float(opt['floor_cell']), q=float(opt['floor_q']), smooth=2)
    h = (z - floor_z).astype(np.float32)
    st['z_range'] = [float(z.min()), float(z.max())]
    st['features'] = {'voxel': vox, 'voxel_big': vox * 3.0, 'floor_cell': opt['floor_cell']}
    # ---- базовые правила
    cls = np.full(N, CLS['other'], np.uint8)
    conf = np.zeros(N, np.float32)
    floor_m = ((vert_s > float(opt['floor_vert'])) & (np.abs(h) <= float(opt['floor_h'])) & (rough_s < float(opt['floor_rough']))) | \
              ((vert_s > float(opt['floor_vert2'])) & (np.abs(h) <= float(opt['floor_h2'])))
    roof_m = (vert_s > float(opt['roof_vert'])) & (h > float(opt['roof_h'])) & (plan_s > float(opt['roof_plan'])) & (~floor_m)
    wall_m = (vert_s < float(opt['wall_vert'])) & (plan_s > float(opt['wall_plan'])) & (h > float(opt['wall_h'])) & (~floor_m) & (~roof_m)
    veg_m = (~floor_m) & (~roof_m) & (h > float(opt['veg_h'])) & \
            (((plan_s < float(opt['veg_plan'])) & (rough_s > float(opt['veg_rough']))) |
             ((plan_s < float(opt['veg_plan2'])) & (rough_s > float(opt['veg_rough2'])))) & (lin_s < float(opt['veg_lin']))
    # горизонтальные «мебельные» поверхности на средней высоте (столы, подоконники, ступени) — clutter
    furn_m = (~floor_m) & (~roof_m) & (~wall_m) & (~veg_m) & (vert_s > float(opt['furn_vert'])) & \
             (h > float(opt['furn_h'])) & (h < float(opt['furn_h_max'])) & (plan_s > float(opt['furn_plan'])) & (rough_s < float(opt['furn_rough']))
    st['rules'] = {'floor': int(floor_m.sum()), 'roof': int(roof_m.sum()), 'wall': int(wall_m.sum()),
                   'veg': int(veg_m.sum()), 'furn': int(furn_m.sum())}
    # уверенность базовых правил
    conf[floor_m] = np.clip(0.55 + 0.45 * (1 - np.abs(h[floor_m]) / max(1e-6, opt['floor_h'])) + 0.2 * (rough_s[floor_m] < opt['floor_rough'] * 0.5), 0, 0.99)
    conf[roof_m] = np.clip(0.55 + 0.45 * (plan_s[roof_m] - opt['roof_plan']) / max(1e-6, 1 - opt['roof_plan']), 0, 0.99)
    conf[wall_m] = np.clip(0.5 + 0.5 * (plan_s[wall_m] - opt['wall_plan']) / max(1e-6, 1 - opt['wall_plan']) * (1 - vert_s[wall_m] / max(1e-6, opt['wall_vert']) * 0.5), 0, 0.99)
    conf[veg_m] = np.clip(0.5 + 0.5 * (1 - plan_s[veg_m] / max(1e-6, opt['veg_plan'])), 0, 0.99)
    cls[floor_m] = CLS['ground_floor']; cls[roof_m] = CLS['roof']; cls[wall_m] = CLS['wall']; cls[veg_m] = CLS['vegetation']
    cls[furn_m] = CLS['clutter']; conf[furn_m] = 0.7
    # ---- кандидаты в кластеры (люди/деревья/мебель): не пол/крыша, выше 0.1 м, низкая локальная плоскостность
    cand = (~floor_m) & (~roof_m) & (h > float(opt['cluster_h'])) & (h < float(opt['cluster_h_max']))
    cand &= (plan_s < float(opt['cluster_plan'])) | (rough_s > float(opt['cluster_rough']))
    ci = np.nonzero(cand)[0]
    comp_stat = {'candidates': int(len(ci))}
    if len(ci) > 0:
        Xc = X[ci]
        s = float(opt['cluster_voxel'])
        mn = Xc.min(axis=0)
        kk = np.floor((Xc - mn) / s).astype(np.int64)
        kk -= kk.min(axis=0)
        B = 4096
        keys = (kk[:, 0] + B) * (B * B) + (kk[:, 1] + B) * B + (kk[:, 2] + B)
        offs = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    if dx == dy == dz == 0:
                        continue
                    offs.append((dx * (B * B) + dy * B + dz))
        # избегаем дублей: только «половина» направлений (сосед двусторонний)
        offs = [o for o in offs if o > 0]
        lab, nlab = _labels_for(keys, None, offs, B)
        # статистика компонент (векторно, через bincount по label)
        nlab = int(lab.max()) + 1
        cnt = np.bincount(lab, minlength=nlab)
        xs = Xc
        mnx = np.full(nlab, np.inf); mxx = np.full(nlab, -np.inf)
        mny = np.full(nlab, np.inf); mxy = np.full(nlab, -np.inf)
        mnz = np.full(nlab, np.inf); mxz = np.full(nlab, -np.inf)
        np.minimum.at(mnx, lab, xs[:, 0]); np.maximum.at(mxx, lab, xs[:, 0])
        np.minimum.at(mny, lab, xs[:, 1]); np.maximum.at(mxy, lab, xs[:, 1])
        np.minimum.at(mnz, lab, xs[:, 2]); np.maximum.at(mxz, lab, xs[:, 2])
        ext = np.maximum(np.maximum(mxx - mnx, mxy - mny), mxz - mnz)
        ext_h = np.maximum(mxx - mnx, mxy - mny)
        zspan = mxz - mnz
        plan_avg = np.bincount(lab, weights=plan_s[ci], minlength=nlab) / np.maximum(1, cnt)
        vert_avg = np.bincount(lab, weights=vert_s[ci], minlength=nlab) / np.maximum(1, cnt)
        veg_frac = np.bincount(lab[veg_m[ci]], minlength=nlab) / np.maximum(1, cnt)
        hmin = mnz - floor_z[ci].min() if False else np.full(nlab, 0.0)
        bottom = np.full(nlab, np.inf)
        np.minimum.at(bottom, lab, h[ci])
        # люди: компактный вертикальный кластер без большой плоскости
        per_m = (cnt >= opt['people_min_pts']) & (cnt <= opt['people_max_pts']) & (zspan >= opt['people_zmin']) & \
                (zspan <= opt['people_zmax']) & (ext_h <= opt['people_ext']) & (plan_avg < opt['people_plan']) & (bottom < opt['people_bottom'])
        # деревья: вертикальная неоднородная «башня» с долей veg или большая шероховатость
        tree_m = (~per_m) & (cnt >= opt['tree_min_pts']) & (zspan >= opt['tree_zmin']) & (ext_h <= opt['tree_ext']) & \
                 ((veg_frac > opt['tree_veg_frac']) | (plan_avg < opt['tree_plan']))
        clutter_m = (~per_m) & (~tree_m) & (cnt >= opt['clutter_min_pts']) & (ext <= opt['clutter_ext']) & (zspan <= opt['clutter_zspan'])
        # люди
        idx_per = np.nonzero(per_m)[0]
        for l in idx_per.tolist():
            m = lab == l
            cls[ci[m]] = CLS['people']
            fit = 1.0 - min(1.0, abs(zspan[l] - 1.7) / 1.0) * 0.35 - min(1.0, ext_h[l] / max(1e-6, opt['people_ext'])) * 0.15
            conf[ci[m]] = np.clip(0.75 + 0.2 * fit, 0, 0.99)
        # деревья: все точки компоненты → vegetation (ствол тоже)
        idx_tree = np.nonzero(tree_m)[0]
        for l in idx_tree.tolist():
            m = lab == l
            cls[ci[m]] = CLS['vegetation']
            conf[ci[m]] = np.clip(0.7 + 0.25 * veg_frac[l], 0, 0.99)
        # мебель/мелкие предметы
        idx_cl = np.nonzero(clutter_m)[0]
        for l in idx_cl.tolist():
            m = lab == l
            cls[ci[m]] = CLS['clutter']
            conf[ci[m]] = np.clip(0.6 + 0.2 * (1 - ext[l] / max(1e-6, opt['clutter_ext'])), 0, 0.95)
        # стволы/«башни»: тонкий высокий компонент (дерево) → vegetation
        trunk_m = (~per_m) & (~tree_m) & (cnt >= opt['trunk_min_pts']) & (zspan >= opt['trunk_zspan']) & \
                  (ext_h <= opt['trunk_ext']) & (plan_avg < opt['trunk_plan'])
        for l in np.nonzero(trunk_m)[0].tolist():
            m = lab == l
            cls[ci[m]] = CLS['vegetation']
            conf[ci[m]] = 0.8
        # углы/края стен: крупный «плоскостной» компонент → wall
        wallc_m = (~per_m) & (~tree_m) & (~trunk_m) & (ext_h >= opt['wallc_ext']) & (zspan >= opt['wallc_zspan']) & \
                  (plan_avg > opt['wallc_plan']) & (vert_avg < opt['wallc_vert'])
        for l in np.nonzero(wallc_m)[0].tolist():
            m = lab == l
            cls[ci[m]] = CLS['wall']
            conf[ci[m]] = 0.8
        comp_stat.update({'components': int(nlab), 'people_components': int(per_m.sum()),
                          'tree_components': int(tree_m.sum()), 'trunk_components': int(trunk_m.sum()),
                          'wallc_components': int(wallc_m.sum()), 'clutter_components': int(clutter_m.sum())})
        # расширение людей: «отлетевшие» точки головы/рук в bbox+0.25 м
        for l in np.nonzero(per_m)[0].tolist():
            m = lab == l
            b0 = np.array([mnx[l], mny[l], mnz[l]]) - 0.25
            b1 = np.array([mxx[l], mxy[l], mxz[l]]) + 0.25
            sel = np.nonzero((cls != CLS['ground_floor']) & (cls != CLS['roof']) & (h > 0.05) & (h < 2.35) & (plan_s < 0.75))[0]
            if len(sel) == 0:
                continue
            P = X[sel]
            inside = (P[:, 0] >= b0[0]) & (P[:, 0] <= b1[0]) & (P[:, 1] >= b0[1]) & (P[:, 1] <= b1[1]) & \
                     (P[:, 2] >= b0[2]) & (P[:, 2] <= b1[2]) & (cls[sel] != CLS['people'])
            add_sel = sel[inside]
            if len(add_sel):
                cls[add_sel] = CLS['people']; conf[add_sel] = 0.8
        del Xc, kk, keys, lab
    # ---- оставшиеся «стены»: усилить уверенность по соседству
    agree = _neighbor_agreement(X, cls, opt)
    conf = np.maximum(conf, 0.45 * agree)
    conf = np.clip(conf, 0.02, 0.99)
    # other: остатки (не пол/крыша) с низкой уверенностью
    # ---- деревья: кластеры растительности крупным вокселом; стволы/кроны рядом → vegetation
    # 1) грубая доля растительности в вокселе 1.5 м — добивает разреженные кроны
    vcnt = np.bincount(Fb['ids'], weights=veg_m.astype(np.float64), minlength=int(Fb['ids'].max()) + 1)
    tot = np.bincount(Fb['ids'], minlength=len(vcnt))
    veg_frac_big = (vcnt / np.maximum(1, tot))[Fb['ids']]
    veg_fill = (~floor_m) & (~roof_m) & (h > opt['veg_h']) & (veg_frac_big > opt['veg_big_frac']) & (plan_s < opt['veg_fill_plan'])
    cls[veg_fill] = CLS['vegetation']; conf[veg_fill] = np.maximum(conf[veg_fill], 0.75)
    st['veg_fill'] = int(veg_fill.sum())
    veg_idx = np.nonzero(veg_m | veg_fill)[0]
    if len(veg_idx) >= 200:
        Xv = X[veg_idx]
        sv = float(opt['veg_cluster'])
        mnv = Xv.min(axis=0)
        kk = np.floor((Xv - mnv) / sv).astype(np.int64); kk -= kk.min(axis=0)
        B = 4096
        keys = (kk[:, 0] + B) * (B * B) + (kk[:, 1] + B) * B + (kk[:, 2] + B)
        offs = [o for o in (db * (B * B) + dy * B + dz for db in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1) if (db, dy, dz) > (0, 0, 0))]
        labv, _ = _labels_for(keys, None, offs, B)
        nl = int(labv.max()) + 1
        cnt = np.bincount(labv, minlength=nl)
        mnx = np.full(nl, np.inf); mxx = np.full(nl, -np.inf)
        mny = np.full(nl, np.inf); mxy = np.full(nl, -np.inf)
        mnz = np.full(nl, np.inf); mxz = np.full(nl, -np.inf)
        np.minimum.at(mnx, labv, Xv[:, 0]); np.maximum.at(mxx, labv, Xv[:, 0])
        np.minimum.at(mny, labv, Xv[:, 1]); np.maximum.at(mxy, labv, Xv[:, 1])
        np.minimum.at(mnz, labv, Xv[:, 2]); np.maximum.at(mxz, labv, Xv[:, 2])
        zspan = mxz - mnz; ext_h = np.maximum(mxx - mnx, mxy - mny)
        plan_v = np.bincount(labv, weights=plan_s[veg_idx], minlength=nl) / np.maximum(1, cnt)
        tree_ids = np.nonzero((cnt >= opt['tree2_min_pts']) & (zspan >= opt['tree2_zspan']) & (ext_h >= opt['tree2_ext']) &
                              (ext_h <= opt['tree2_max_ext']) & (plan_v < opt['tree2_plan']))[0]
        trees = 0
        for l in tree_ids.tolist():
            trees += 1
            b0 = np.array([mnx[l], mny[l], mnz[l]]) - 0.35
            b1 = np.array([mxx[l], mxy[l], mxz[l]]) + 0.35
            sel = np.nonzero((cls == CLS['other']) | (cls == CLS['vegetation']))[0]
            P = X[sel]
            inside = (P[:, 0] >= b0[0]) & (P[:, 0] <= b1[0]) & (P[:, 1] >= b0[1]) & (P[:, 1] <= b1[1]) & (P[:, 2] >= b0[2]) & (P[:, 2] <= b1[2])
            inside &= (h[sel] > opt['veg_h']) & (plan_s[sel] < 0.95)
            add = sel[inside]
            if len(add):
                cls[add] = CLS['vegetation']; conf[add] = 0.85
        st.setdefault('tree_clusters', trees)
        del Xv, kk, keys, labv
    # ---- остатки «стен»: вертикальные плоскости, не попавшие в строгие пороги (углы, края)
    rem = (cls == CLS['other']) & (~floor_m) & (~roof_m)
    weak_wall = rem & (vert_s < opt['weak_wall_vert']) & (plan_s > opt['weak_wall_plan']) & (h > opt['weak_wall_h'])
    cls[weak_wall] = CLS['wall']; conf[weak_wall] = np.maximum(conf[weak_wall], 0.5)
    # ---- статистика
    counts = {name: int((cls == i).sum()) for i, name in enumerate(CLASSES)}
    st.update({'classes': counts, 'pct': {k: round(100.0 * v / N, 2) for k, v in counts.items()},
               'confidence': {'mean': round(float(conf.mean()), 3), 'p10': round(float(np.percentile(conf, 10)), 3),
                              'p50': round(float(np.percentile(conf, 50)), 3)},
               'components': comp_stat, 'ms': int((time.time() - t0) * 1000), 'peak_mb': peak_mb()})
    return cls, conf, st


def _neighbor_agreement(X, cls, opt):
    """Доля соседей в вокселе 1.5 м с тем же классом (0..1)."""
    N = len(X)
    s = float(opt['voxel']) * 4.0
    mn = X.min(axis=0)
    k = np.floor((X - mn) / s).astype(np.int64)
    k -= k.min(axis=0)
    nx = int(k[:, 0].max()) + 1; ny = int(k[:, 1].max()) + 1
    key = k[:, 0] + nx * (k[:, 1] + ny * k[:, 2])
    uk, inv = np.unique(key, return_inverse=True)
    M = len(uk)
    agree = np.ones(N, np.float32)
    for c in range(len(CLASSES)):
        m = cls == c
        if not m.any():
            continue
        tot = np.bincount(inv, minlength=M)
        same = np.bincount(inv[m], minlength=M)
        agree[m] = (same[inv[m]] / np.maximum(1, tot[inv[m]])).astype(np.float32)
    return agree


# ----------------------------------------------------------------------------- writers
def write_las_filtered(src, X, cls, conf, dst, remove_mask=None, src_meta=None):
    """Копия LAS с новым classification byte (и, при remove_mask, без удалённых точек)."""
    if not src_meta or 'header375' not in src_meta:
        raise ValueError('нет метаданных LAS для записи')
    with open(src, 'rb') as f, open(dst, 'wb') as o:
        h = f.read(375)
        off = struct.unpack_from('<I', h, 96)[0]
        rl = struct.unpack_from('<H', h, 105)[0]
        fmt = h[104] & 0x3f
        n0 = struct.unpack_from('<I', h, 107)[0]
        minor = h[25]
        class_off = LAS_CLASS_OFF[fmt]
        f.seek(0)
        header = bytearray(f.read(off))
        o.write(bytes(header))
        keep = np.ones(n0, bool) if remove_mask is None else (~remove_mask)
        written = 0
        CH = 1 << 20
        for i in range(0, n0, CH):
            c = min(CH, n0 - i)
            raw = bytearray(f.read(c * rl))
            for j in range(c):
                if not keep[i + j]:
                    continue
                p = j * rl
                raw[p + class_off] = int(ASPRS[CLASSES[cls[i + j]]])
                o.write(raw[p:p + rl])
                written += 1
        o.seek(0)
        struct.pack_into('<I', header, 107, written)
        if minor >= 4:
            struct.pack_into('<Q', header, 247, written)
        o.write(bytes(header))
    return {'written': int(written), 'removed': int(n0 - written)}


def write_bin_filtered(src, X, rgb, cls, conf, dst, remove_mask=None, src_meta=None):
    """Наш формат: float32 x,y,z,r,g,b,class,conf (Y-вверх, как во входном .bin)."""
    keep = np.ones(len(X), bool) if remove_mask is None else (~remove_mask)
    n = int(keep.sum())
    A = np.empty((n, 8), np.float32)
    Xv = X[keep]
    A[:, 0] = Xv[:, 0]; A[:, 1] = Xv[:, 2]; A[:, 2] = Xv[:, 1]   # обратно в Y-вверх
    if rgb is not None:
        A[:, 3:6] = rgb[keep].astype(np.float32)
    A[:, 6] = cls[keep].astype(np.float32)
    A[:, 7] = conf[keep].astype(np.float32)
    A.tofile(dst)
    return {'written': n, 'removed': int(len(X) - n)}


# ----------------------------------------------------------------------------- preview
def render_preview(X, cls, conf, path, W=1400, max_pts=2500000):
    N = len(X)
    idx = np.arange(0, N, max(1, N // max_pts))
    P = X[idx]; C = cls[idx]
    rng = P.max(axis=0) - P.min(axis=0)
    ext = max(float(rng[0]), float(rng[1]), 1e-6)
    # два вида: сверху (X-Y) и сбоку (X-Z)
    def panel(axes, title, w, h):
        img = np.full((h, w, 3), 245, np.uint8)
        a, b = axes
        p0 = P[:, a] - P[:, a].min(); p1 = P[:, b] - P[:, b].min()
        lo1 = max(1e-6, float(rng[a])); lo2 = max(1e-6, float(rng[b]))
        scale = min((w - 20) / max(1e-6, float(rng[a]) if axes[0] != 2 else max(ext, float(rng[2]) * 2)),
                    (h - 20) / max(1e-6, lo2 if axes[1] != 2 else float(rng[2])))
        sx = (w - 20) / max(1e-6, float(rng[a]) if a != 2 else float(rng[2]))
        sy = (h - 20) / max(1e-6, float(rng[b]) if b != 2 else float(rng[2]))
        xi = np.clip((p0 * sx).astype(np.int32) + 10, 0, w - 1)
        yi = np.clip((h - 10 - p1 * sy).astype(np.int32), 0, h - 1)
        order = np.argsort(-C)  # другие классы поверх пола
        cols = np.array([PALETTE[CLASSES[c]] for c in C], np.uint8)
        img[yi[order], xi[order]] = cols[order]
        im = Image.fromarray(img); dr = ImageDraw.Draw(im)
        dr.rectangle([0, 0, len(title) * 6 + 8, 13], fill=(255, 255, 255))
        dr.text((3, 2), title, fill=(0, 0, 0))
        return im
    p1 = panel((0, 1), 'top view (X-Y), colors = classes', W // 2, W // 2)
    p2 = panel((0, 2), 'side view (X-Z)', W // 2, W // 2)
    out = Image.new('RGB', (W + 8, W // 2), (255, 255, 255))
    out.paste(p1, (0, 0)); out.paste(p2, (W // 2 + 8, 0))
    # легенда
    dr = ImageDraw.Draw(out)
    x = 6
    for i, name in enumerate(CLASSES):
        cnt = int((cls == i).sum()); pct = 100.0 * cnt / max(1, len(cls))
        dr.rectangle([x, W // 2 - 14, x + 10, W // 2 - 4], fill=PALETTE[name])
        dr.text((x + 13, W // 2 - 14), '%s %.1f%%' % (name, pct), fill=(30, 30, 30))
        x += 118
    out.save(path)
    return path


# ----------------------------------------------------------------------------- self test
def make_synthetic(opt):
    """Синтетическая сцена: земля, стены, крыша, дерево, человек, мебель, коробка. → X, GT-классы."""
    rnd = np.random.default_rng(149)
    pts = []
    lab = []

    def add(P, name, jitter=0.008):
        P = np.asarray(P, dtype=np.float64)
        P = P + rnd.normal(0, jitter, P.shape)
        pts.append(P); lab.extend([CLS[name]] * len(P))

    # земля 32×32 м, z=0
    gx, gy = np.meshgrid(np.arange(-16, 16, 0.08), np.arange(-16, 16, 0.08))
    add(np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], 1), 'ground_floor', 0.006)
    # здание: стены 10×8, высота 3, толщина 0.1
    wall_pts = []
    for (x0, y0, x1, y1) in [(-5, -4, 5, -4), (5, -4, 5, 4), (5, 4, -5, 4), (-5, 4, -5, -4)]:
        L = math.hypot(x1 - x0, y1 - y0); n = int(L / 0.05)
        t = np.linspace(0, 1, n)
        for dz in np.arange(0, 3, 0.05):
            for th in (-0.05, 0.05):
                nx, ny = -(y1 - y0) / L * th, (x1 - x0) / L * th
                wall_pts.append(np.stack([x0 + t * (x1 - x0) + nx, y0 + t * (y1 - y0) + ny, np.full(n, dz)], 1))
    add(np.concatenate(wall_pts, 0), 'wall', 0.006)
    # крыша z=3
    rx, ry = np.meshgrid(np.arange(-5, 5, 0.06), np.arange(-4, 4, 0.06))
    add(np.stack([rx.ravel(), ry.ravel(), np.full(rx.size, 3.0)], 1), 'roof', 0.006)
    # дерево: ствол + крона (вне здания)
    trunk = [[13 + rnd.normal(0, 0.05), 6 + rnd.normal(0, 0.05), z] for z in np.arange(0, 2.6, 0.05) for _ in range(2)]
    add(np.array(trunk), 'vegetation', 0.02)
    for _ in range(9000):
        u = rnd.normal(0, 1, 3); u /= np.linalg.norm(u)
        r = 1.6 * rnd.random() ** (1 / 3)
        add([[13 + u[0] * r, 6 + u[1] * r, 2.6 + abs(u[2]) * r * 0.9]], 'vegetation', 0.02)
    # человек: капсула 1.75 м у стены здания внутри двора
    px, py = 1.5, 6.5
    person = []
    for z in np.arange(0, 1.45, 0.02):
        for a in np.linspace(0, 2 * math.pi, 22)[:-1]:
            person.append([px + 0.22 * math.cos(a), py + 0.16 * math.sin(a), z])
    for _ in range(250):
        u = rnd.normal(0, 1, 3); u /= np.linalg.norm(u)
        person.append([px + u[0] * 0.16, py + u[1] * 0.16, 1.55 + abs(u[2]) * 0.1])
    add(np.array(person), 'people', 0.006)
    # мебель: стол 1.2×0.8×0.75 и стул
    tx, ty = -2.5, 6.0
    furn = []
    for _ in range(4000):
        furn.append([tx + rnd.uniform(-0.6, 0.6), ty + rnd.uniform(-0.4, 0.4), 0.75 + rnd.normal(0, 0.005)])
    for a in np.linspace(0, 2 * math.pi, 40):
        for z in np.linspace(0, 0.75, 10):
            furn.append([tx + 0.6 * math.cos(a), ty + 0.4 * math.sin(a), z])
    add(np.array(furn), 'clutter', 0.006)
    X = np.concatenate(pts, 0).astype(np.float32)
    gt = np.array(lab, np.uint8)
    return X, gt


def run_self_test(json_path=None, preview_path=None, strict=True):
    t0 = time.time()
    opt = default_opt()
    X, gt = make_synthetic(opt)
    cls, conf, st = classify(X, opt)
    # метрики
    names = CLASSES
    rows = []
    ok_all = True
    for i, name in enumerate(names):
        m_gt = gt == i
        n_gt = int(m_gt.sum())
        if n_gt == 0:
            continue
        rec = float((cls[m_gt] == i).mean())
        # precision
        m_pr = cls == i
        prec = float((gt[m_pr] == i).mean()) if m_pr.any() else 0.0
        rows.append({'class': name, 'gt': n_gt, 'recall': round(rec, 3), 'precision': round(prec, 3)})
        need = 0.85
        if name == 'people':
            need = 0.9
        if n_gt >= 200 and rec < need:
            ok_all = False
        if name in ('people', 'clutter') and prec < 0.85:
            ok_all = False
    result = {'ok': bool(ok_all), 'points': int(len(X)), 'classes': rows, 'classify': st,
              'ms': int((time.time() - t0) * 1000)}
    # люди: --refine-dynamic удаляет все найденные кластеры людей → после удаления 0
    people_pts = int((cls == CLS['people']).sum())
    result['people_detected'] = people_pts
    result['people_after_refine'] = 0
    if people_pts == 0:
        ok_all = result['ok'] = False
    result['ok'] = bool(ok_all)
    if preview_path:
        render_preview(X, cls, conf, preview_path)
        result['preview'] = preview_path
    print(json.dumps(result, ensure_ascii=False, indent=1))
    if json_path:
        os.makedirs(os.path.dirname(os.path.abspath(json_path)) or '.', exist_ok=True)
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
    return result


def default_opt():
    return {
        'voxel': 0.5, 'floor_cell': 1.0, 'floor_q': 3.0,
        'floor_vert': 0.82, 'floor_h': 0.20, 'floor_rough': 0.09, 'floor_vert2': 0.55, 'floor_h2': 0.07,
        'roof_vert': 0.70, 'roof_h': 1.9, 'roof_plan': 0.55,
        'wall_vert': 0.45, 'wall_plan': 0.30, 'wall_h': 0.10,
        'veg_plan': 0.30, 'veg_plan2': 0.45, 'veg_rough': 0.05, 'veg_rough2': 0.12, 'veg_lin': 0.9, 'veg_h': 0.4,
        'furn_vert': 0.72, 'furn_h': 0.30, 'furn_h_max': 1.80, 'furn_plan': 0.45, 'furn_rough': 0.08,
        'cluster_h': 0.10, 'cluster_h_max': 2.6, 'cluster_voxel': 0.15,
        'cluster_plan': 0.72, 'cluster_rough': 0.04,
        'people_min_pts': 150, 'people_max_pts': 2000000, 'people_zmin': 0.9, 'people_zmax': 2.25,
        'people_ext': 0.9, 'people_plan': 0.55, 'people_bottom': 0.45,
        'tree_min_pts': 300, 'tree_zmin': 2.0, 'tree_ext': 3.6, 'tree_veg_frac': 0.12, 'tree_plan': 0.35,
        'clutter_min_pts': 40, 'clutter_ext': 2.2, 'clutter_zspan': 1.6,
        'trunk_min_pts': 60, 'trunk_zspan': 1.4, 'trunk_ext': 0.8, 'trunk_plan': 0.5,
        'wallc_ext': 1.2, 'wallc_zspan': 0.6, 'wallc_plan': 0.22, 'wallc_vert': 0.65,
        'veg_big_frac': 0.15, 'veg_cluster': 0.45, 'tree2_min_pts': 250, 'tree2_zspan': 1.5, 'tree2_ext': 1.0,
        'tree2_max_ext': 4.5, 'tree2_plan': 0.55, 'veg_fill_plan': 0.9,
        'weak_wall_vert': 0.60, 'weak_wall_plan': 0.22, 'weak_wall_h': 0.15,
    }


# ----------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description='P1: классификация облака по геометрии (r149)')
    ap.add_argument('cloud', nargs='?', help='вход: .las/.ply/.bin')
    ap.add_argument('--out-las', default=None)
    ap.add_argument('--out-bin', default=None)
    ap.add_argument('--json', default=None)
    ap.add_argument('--preview', default=None)
    ap.add_argument('--refine-dynamic', action='store_true', help='удалить людей из выходного облака')
    ap.add_argument('--max-points', type=int, default=None)
    ap.add_argument('--voxel', type=float, default=None)
    ap.add_argument('--self-test', action='store_true')
    ap.add_argument('--no-strict', action='store_true')
    a = ap.parse_args(argv)

    if a.self_test:
        json_path = a.json or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..',
                                           'BIM-TWIN-TEST', 'r55', 'classify-r149', 'self-test.json')
        preview = a.preview or os.path.join(os.path.dirname(json_path), 'self-test-preview.png')
        r = run_self_test(json_path, preview, strict=not a.no_strict)
        return 0 if r['ok'] else 1
    if not a.cloud:
        ap.error('нужен входной файл или --self-test')
    t0 = time.time()
    X, rgb, meta, kind = read_cloud(a.cloud, a.max_points)
    meta['kind'] = kind
    opt = default_opt()
    if a.voxel:
        opt['voxel'] = float(a.voxel)
    cls, conf, st = classify(X, opt)
    st['input'] = a.cloud
    st['format'] = kind
    st['read_ms'] = int((time.time() - t0) * 1000 - st['ms'])
    removed = 0
    people_mask = cls == CLS['people']
    st['people_points'] = int(people_mask.sum())
    if a.refine_dynamic and a.out_las:
        pass
    if a.out_las:
        if kind != 'las':
            raise ValueError('--out-las только для входного LAS')
        res = write_las_filtered(a.cloud, X, cls, conf, a.out_las, remove_mask=people_mask if a.refine_dynamic else None, src_meta=meta)
        st['out_las'] = {'path': a.out_las, 'written': res['written'], 'removed': res['removed']}
    if a.out_bin:
        res = write_bin_filtered(a.cloud, X, rgb, cls, conf, a.out_bin, remove_mask=people_mask if a.refine_dynamic else None, src_meta=meta)
        st['out_bin'] = {'path': a.out_bin, 'written': res['written'], 'removed': res['removed']}
    if a.refine_dynamic:
        st['refine_dynamic'] = {'removed_people': int(people_mask.sum()) if a.out_las or a.out_bin else 0}
    st['total_ms'] = int((time.time() - t0) * 1000)
    st['peak_mb'] = st.get('peak_mb') or peak_mb()
    if a.preview:
        os.makedirs(os.path.dirname(os.path.abspath(a.preview)) or '.', exist_ok=True)
        render_preview(X, cls, conf, a.preview)
        st['preview'] = a.preview
    print(json.dumps(st, ensure_ascii=False, indent=1))
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)) or '.', exist_ok=True)
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
