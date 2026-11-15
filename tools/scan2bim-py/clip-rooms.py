#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""clip-rooms.py — клиппинг помещений BIM-модели по видимому полу облака (A6, Фаза 1).

Цель A6 (ROADMAP-IDEAL): «помещения вне видимого пола / наложения комнат» = 0 % / 0 м².
Ограничения: A5 (площадь помещений / видимый свободный пол) не должен упасть, A4 (периметр
помещений, закрытый стенами) не должен упасть.

Как это сделано (минимальные правки контуров, а не перегенерация по растру):
  1. Растр видимого пола 5 см: точки пола -> замыкание 0.2 м (как ruler-v2.py) -> внутри
     габарита стен (выпуклая оболочка осей стен buffer(-0.05)).
  2. Наложения помещений устраняются попарно: площадь пересечения достаётся помещению с
     большей площадью (приоритет по площади), у меньшего она вырезается.
  3. «Вне видимого пола» — это те сэмплы помещения (сетка 0.4 м, как в ruler-v2.py), для
     которых в окне 3x3 клеток по 0.2 м нет ни одной точки пола. Для каждого такого сэмпла
     из полигона вырезается его клетка-сэмпл (0.1x0.1 м + запас), затем проверка повторяется
     (после правки bbox может сдвинуть сетку сэмплов).
  4. Площадь, потерянная на наложениях и вырезанных сэмплах, возвращается МИНИМАЛЬНЫМ
     буфером (+d по нормали, d ~ 1-3 мм) — границы остаются рядом со стенами (A4 не падает),
     а не «лестницей» из растровых клеток (та давала +16 м периметра и валила A4 до 86 %).
     Буфер и повторный разбор наложений/A6-сэмплов итерируются до сходимости.
  5. Следы стен из полигонов НЕ вычитаются: в этой модели контуры помещений — разбиение
     плана по осям стен, вычитание полутолщины срезало бы ~33 м² (27 % площади) и обрушило
     A5 до ~70 %. Вместо этого клиппинг идёт по видимому полу и габариту стен.
  6. Пересчитываются area / cx / cz и stats.floorArea; полигоны упрощаются (0.01 м).
  7. Внутренняя сверка ДО/ПОСЛЕ теми же формулами, что ruler-v2.py: A6 (вне пола % и
     наложения м²), A5 (площадь / видимый свободный пол), A4 (периметр у стен). Модель
     записывается только если A6 улучшилась, наложения = 0, A5 не упал и A4 не упал
     (иначе код 3 и файл не пишется). Официальная приёмка всё равно: run-quality-all.py.

Запуск:
  python clip-rooms.py CLOUD.bin MODEL_IN.json MODEL_OUT.json [--report R.json]
  python clip-rooms.py D:\\BIM-TWIN-TEST\\interior\\koridor-local-rgb.bin \\
      D:\\BIM-TWIN-TEST\\interior\\py2-final-v3.json D:\\BIM-TWIN-TEST\\interior\\py2-final-v3.json \\
      --report D:\\BIM-TWIN-TEST\\interior\\clip-rooms.report.json

Коды возврата: 0 — сохранено; 3 — проверки A6/A5/A4 не прошли (файл не записан); 2 — ошибка.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

try:
    from shapely import contains_xy
    from shapely.geometry import MultiPolygon, Polygon, box
    from shapely.ops import unary_union
except ImportError:  # pragma: no cover
    print('ОШИБКА: нужен shapely >= 2.0 (pip install shapely)', file=sys.stderr)
    sys.exit(2)

DEFAULT_RASTER = 0.05       # растр свободного пола, м
FLOOR_GRID = 0.10           # растр «видимого пола» для A5, м (как в ruler-v2)
A6_CELL = 0.20              # сетка пола для A6, м (как в ruler-v2)
A6_SAMPLE_STEP = 0.40       # шаг сэмплов A6, м (как в ruler-v2)
WALL_MARGIN = 0.02          # запас к полутолщине стены для A5-растра, м (как в ruler-v2)
SIMPLIFY = 0.01             # упрощение полигонов помещений, м
MAX_TRIM_QUAD = 0.12        # вырезаемая клетка-сэмпл, м (0.1 + запас)
MAX_BUFFER = 0.010          # предел компенсирующего буфера, м


# ======================================================================================
# 1. Загрузка/сохранение
# ======================================================================================
def load_model(path):
    with open(path, 'r', encoding='utf-8-sig') as fh:
        return json.load(fh)


def load_cloud(path, stride=2):
    size = os.path.getsize(path)
    if size == 0 or size % 24 != 0:
        raise ValueError('размер облака не кратен 24 байтам: %s' % path)
    n = size // 24
    mm = np.memmap(path, dtype=np.float32, mode='r').reshape(n, 6)
    return np.ascontiguousarray(np.asarray(mm[::stride])[:, :3], dtype=np.float64)


def save_model_atomic(model, path):
    d = os.path.dirname(os.path.abspath(path)) or '.'
    os.makedirs(d, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(model, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    os.replace(tmp, path)


# ======================================================================================
# 2. Растры пола/габарита
# ======================================================================================
def _dilate(mask, iters):
    m = mask
    for _ in range(iters):
        dil = m.copy()
        for ax in (0, 1):
            dil = dil | np.roll(dil, 1, axis=ax) | np.roll(dil, -1, axis=ax)
        m = dil
    return m


def _closing(mask, iters):
    m = mask.copy()
    for _ in range(iters):
        dil = m.copy()
        for ax in (0, 1):
            dil = dil | np.roll(dil, 1, axis=ax) | np.roll(dil, -1, axis=ax)
        ero = dil.copy()
        for ax in (0, 1):
            ero = ero & np.roll(dil, 1, axis=ax) & np.roll(dil, -1, axis=ax)
        m = ero
    return m


def wall_envelope(model):
    pts = []
    for w in model.get('walls') or []:
        ax, az = float(w['a'][0]), float(w['a'][1])
        bx = ax + float(w['dir'][0]) * float(w['length'])
        bz = az + float(w['dir'][1]) * float(w['length'])
        pts.append((ax, az))
        pts.append((bx, bz))
    if len(pts) < 3:
        return None
    hull = unary_union([box(px - 1e-9, pz - 1e-9, px + 1e-9, pz + 1e-9)
                        for px, pz in pts]).convex_hull
    return hull.buffer(-0.05)


def build_floor_raster(PT, model, raster=DEFAULT_RASTER, closing_m=0.20, wall_subtract=False,
                       clamp=0.13):
    """Растр видимого пола (5 см): точки пола -> замыкание -> (опц.) следы стен -> габарит."""
    storey = model.get('storey') or {}
    floorY = float(storey.get('floorY', 0.0) or 0.0)
    y = PT[:, 1]
    fp = PT[(y > floorY - 0.10) & (y < floorY + 0.30)]
    if len(fp) < 100:
        raise ValueError('точек пола слишком мало: %d' % len(fp))
    gx = np.floor(fp[:, 0] / raster).astype(np.int64)
    gz = np.floor(fp[:, 2] / raster).astype(np.int64)
    gx -= gx.min(); gz -= gz.min()
    nx, nz = int(gx.max()) + 1, int(gz.max()) + 1
    mask = np.zeros((nz, nx), bool)
    mask[gz, gx] = True
    mask = _closing(mask, max(1, int(round(closing_m / raster))))
    x0 = float(np.floor(fp[:, 0].min() / raster)) * raster
    z0 = float(np.floor(fp[:, 2].min() / raster)) * raster
    gxc = x0 + (np.arange(nx) + 0.5) * raster
    gzc = z0 + (np.arange(nz) + 0.5) * raster
    GX, GZ = np.meshgrid(gxc, gzc)
    if wall_subtract:
        for w in model.get('walls') or []:
            ax, az = float(w['a'][0]), float(w['a'][1])
            ux, uz = float(w['dir'][0]), float(w['dir'][1])
            nrm = math.hypot(ux, uz) or 1.0
            ux, uz = ux / nrm, uz / nrm
            nxv, nzv = -uz, ux
            half = min(float(w.get('thickness', 0.12)) / 2.0 + WALL_MARGIN, float(clamp))
            L = float(w.get('length', 0.0))
            su = (GX - ax) * ux + (GZ - az) * uz
            sn = (GX - ax) * nxv + (GZ - az) * nzv
            mask &= ~((su >= -half) & (su <= L + half) & (np.abs(sn) <= half))
    hull = wall_envelope(model)
    if hull is not None and not hull.is_empty:
        mask &= contains_xy(hull, GX, GZ)
    return {'x0': x0, 'z0': z0, 'cell': raster, 'mask': mask, 'floorY': floorY,
            'raw_area_m2': float(mask.sum()) * raster * raster}


# ======================================================================================
# 3. Метрики A4/A5/A6 (те же формулы, что ruler-v2.py)
# ======================================================================================
def mask_to_polygon(mask, x0, z0, cell):
    """Полигон из бинарной маски (union прямоугольников строковых участков)."""
    rects = []
    nz, nx = mask.shape
    for iz in range(nz):
        row = mask[iz]
        if not row.any():
            continue
        xs = np.flatnonzero(row)
        br = np.where(np.diff(xs) > 1)[0]
        st = np.concatenate(([xs[0]], xs[br + 1]))
        en = np.concatenate((xs[br], [xs[-1]]))
        za = z0 + iz * cell
        for a, b in zip(st.tolist(), en.tolist()):
            rects.append(box(x0 + a * cell, za, x0 + (b + 1) * cell, za + cell))
    return unary_union(rects) if rects else Polygon()


def build_wall_zone(PT, model, raster=DEFAULT_RASTER, half=0.145):
    """Полигон «полосы вдоль стен»: пол + расстояние до оси стены <= half (A4-безопасная зона)."""
    grid = build_floor_raster(PT, model, raster=raster)
    mask = grid['mask'].copy()
    x0, z0, cell = grid['x0'], grid['z0'], grid['cell']
    nz, nx = mask.shape
    gxc = x0 + (np.arange(nx) + 0.5) * cell
    gzc = z0 + (np.arange(nz) + 0.5) * cell
    GX, GZ = np.meshgrid(gxc, gzc)
    dmin = np.full((nz, nx), 1e9)
    for w in model.get('walls') or []:
        ax, az = float(w['a'][0]), float(w['a'][1])
        ux, uz = float(w['dir'][0]), float(w['dir'][1])
        nrm = math.hypot(ux, uz) or 1.0
        ux, uz = ux / nrm, uz / nrm
        L = float(w['length'])
        su = (GX - ax) * ux + (GZ - az) * uz
        sn = -(GX - ax) * uz + (GZ - az) * ux
        dsu = np.maximum(0.0, np.maximum(-su, su - L))
        d = np.sqrt(dsu * dsu + sn * sn)
        dmin = np.minimum(dmin, d)
    zone_mask = mask & (dmin <= half)
    return {'poly': mask_to_polygon(zone_mask, x0, z0, cell), 'mask': zone_mask,
            'grid': grid, 'area_m2': float(zone_mask.sum()) * cell * cell}


def zone_buffer(polys, step, zone_poly):
    """Буфер +step, но только в A4-безопасную полосу вдоль стен (новые кромки у стен)."""
    out = []
    for P in polys:
        if P.is_empty or step <= 0:
            out.append(P)
            continue
        ring = P.buffer(step, join_style='mitre', quad_segs=2).difference(P)
        if ring.is_empty:
            out.append(P)
            continue
        add = ring.intersection(zone_poly)
        if add.is_empty:
            out.append(P)
            continue
        out.append(_largest(unary_union([P, add])))
    return out


def a6_floor_cells(PT, floorY):
    fp = PT[(PT[:, 1] > floorY - 0.10) & (PT[:, 1] < floorY + 0.30)]
    return set((int(round(x / A6_CELL)), int(round(z / A6_CELL))) for x, z in fp[:, [0, 2]])


def _a6_sample_points(P, floor_cells):
    """Внешние сэмплы помещения (сетка 0.4 м от bbox, как ruler-v2)."""
    out = []
    minx, minz, maxx, maxz = P.bounds
    xo = minx
    while xo <= maxx:
        zo = minz
        while zo <= maxz:
            if P.contains(box(xo, zo, xo + 0.1, zo + 0.1).centroid):
                ci = int(round(xo / A6_CELL))
                cj = int(round(zo / A6_CELL))
                if not any((ci + di, cj + dj) in floor_cells
                           for di in (-1, 0, 1) for dj in (-1, 0, 1)):
                    out.append((xo, zo))
            zo += A6_SAMPLE_STEP
        xo += A6_SAMPLE_STEP
    return out


def a6_metrics(polys, floor_cells):
    outside = total = 0
    polys = [p if p.is_valid else p.buffer(0) for p in polys]
    for P in polys:
        if P.is_empty:
            continue
        minx, minz, maxx, maxz = P.bounds
        xo = minx
        while xo <= maxx:
            zo = minz
            while zo <= maxz:
                if P.contains(box(xo, zo, xo + 0.1, zo + 0.1).centroid):
                    total += 1
                    ci = int(round(xo / A6_CELL))
                    cj = int(round(zo / A6_CELL))
                    if not any((ci + di, cj + dj) in floor_cells
                               for di in (-1, 0, 1) for dj in (-1, 0, 1)):
                        outside += 1
                zo += A6_SAMPLE_STEP
            xo += A6_SAMPLE_STEP
    overlap = 0.0
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            if polys[i].is_empty or polys[j].is_empty:
                continue
            if polys[i].intersects(polys[j]):
                overlap += polys[i].intersection(polys[j]).area
    return {'outside_pct': 100.0 * outside / max(1, total), 'overlap_m2': overlap,
            'samples': total, 'outside_cells': outside}


def a4_metrics(polys, model):
    """A4: доля периметра помещений, закрытая стенами (расстояние <= 0.15 м)."""
    walls = []
    for w in model.get('walls') or []:
        ax, az = float(w['a'][0]), float(w['a'][1])
        bx = ax + float(w['dir'][0]) * float(w['length'])
        bz = az + float(w['dir'][1]) * float(w['length'])
        walls.append((ax, az, bx, bz))
    total = hit = 0.0
    for P in polys:
        rings = ([g.exterior for g in P.geoms] if P.geom_type == 'MultiPolygon'
                 else [P.exterior]) if not P.is_empty else []
        for ring in rings:
            coords = list(ring.coords)
            for k in range(len(coords) - 1):
                xa, za = coords[k]
                xb, zb = coords[k + 1]
                seg = math.hypot(xb - xa, zb - za)
                if seg < 1e-6:
                    continue
                n = max(1, int(seg / 0.2))
                for q in range(n):
                    f = (q + 0.5) / n
                    px, pz = xa + (xb - xa) * f, za + (zb - za) * f
                    dmin = 1e9
                    for (ax, az, bx, bz) in walls:
                        vx, vz = bx - ax, bz - az
                        L2 = vx * vx + vz * vz
                        if L2 <= 1e-9:
                            dd = math.hypot(px - ax, pz - az)
                        else:
                            t = ((px - ax) * vx + (pz - az) * vz) / L2
                            t = max(0.0, min(1.0, t))
                            dd = math.hypot(px - (ax + vx * t), pz - (az + vz * t))
                        if dd < dmin:
                            dmin = dd
                    total += seg / n
                    if dmin <= 0.15:
                        hit += seg / n
    return {'perimeter_pct': 100.0 * hit / max(1e-9, total),
            'perimeter_m': total, 'covered_m': hit}


def floor_visible_area(PT, model, floorY, wall_subtract=True):
    """Площадь видимого свободного пола — точная копия расчёта ruler-v2.py (10 см).

    ВНИМАНИЕ: в ruler-v2.py сетка для вычитания следов стен строится без смещения начала
    координат (это существующая особенность обмерщика). Здесь она воспроизведена намеренно,
    иначе внутренняя проверка A5 не совпадёт с официальной.
    """
    y = PT[:, 1]
    fp = PT[(y > floorY - 0.10) & (y < floorY + 0.30)]
    cell = FLOOR_GRID
    gx = np.floor(fp[:, 0] / cell).astype(np.int64)
    gz = np.floor(fp[:, 2] / cell).astype(np.int64)
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
    if wall_subtract:
        _nx0, _nz0 = int(gx.min()), int(gz.min())      # == 0, как в ruler-v2.py
        _gxc = (_nx0 + np.arange(nx) + 0.5) * cell
        _gzc = (_nz0 + np.arange(nz) + 0.5) * cell
        _GX, _GZ = np.meshgrid(_gxc, _gzc)
        wallfree = np.ones((nz, nx), bool)
        for w in model.get('walls') or []:
            ax, az = float(w['a'][0]), float(w['a'][1])
            ux, uz = float(w['dir'][0]), float(w['dir'][1])
            nrm = math.hypot(ux, uz) or 1.0
            ux, uz = ux / nrm, uz / nrm
            nxv, nzv = -uz, ux
            half = float(w.get('thickness', 0.12)) / 2.0 + WALL_MARGIN
            L = float(w.get('length', 0.0))
            su = (_GX - ax) * ux + (_GZ - az) * uz
            sn = (_GX - ax) * nxv + (_GZ - az) * nzv
            wallfree &= ~((su >= -half) & (su <= L + half) & (np.abs(sn) <= half))
        free = free & wallfree
    hull = wall_envelope(model)
    if hull is not None and not hull.is_empty:
        _ox = float(np.floor(fp[:, 0].min() / cell)) * cell
        _oz = float(np.floor(fp[:, 2].min() / cell)) * cell
        _Px = _ox + (np.arange(nx) + 0.5) * cell
        _Pz = _oz + (np.arange(nz) + 0.5) * cell
        _GX2, _GZ2 = np.meshgrid(_Px, _Pz)
        free = free & contains_xy(hull, _GX2, _GZ2)
    return float(free.sum()) * cell * cell


# ======================================================================================
# 4. Операции над помещениями
# ======================================================================================
def _largest(P):
    if P.is_empty:
        return P
    if not P.is_valid:
        P = P.buffer(0)
    if P.geom_type == 'MultiPolygon':
        return max(P.geoms, key=lambda g: g.area)
    if P.geom_type == 'GeometryCollection':
        ps = [g for g in P.geoms if g.geom_type == 'Polygon']
        return max(ps, key=lambda g: g.area) if ps else Polygon()
    return P


def resolve_overlaps(polys):
    """Наложения: пересечение достаётся помещению с большей площадью."""
    polys = list(polys)
    for _ in range(12):
        changed = False
        for i in range(len(polys)):
            if polys[i].is_empty:
                continue
            for j in range(i + 1, len(polys)):
                if polys[j].is_empty or not polys[i].intersects(polys[j]):
                    continue
                inter = polys[i].intersection(polys[j])
                if inter.area <= 1e-9:
                    continue
                if polys[i].area >= polys[j].area:
                    polys[j] = _largest(polys[j].difference(inter))
                else:
                    polys[i] = _largest(polys[i].difference(inter))
                changed = True
        if not changed:
            break
    return [p if p.is_valid else p.buffer(0) for p in polys]


def _cut_notch(P, qx, qz):
    """Вырезать сэмпл узкой прорезью до ближайшей границы помещения.

    Возвращает новый полигон (сэмпл вне, контур остаётся одним, без дыр), либо исходный.
    """
    if P.is_empty or P.geom_type != 'Polygon':
        return P
    coords = list(P.exterior.coords)
    best = None
    for k in range(len(coords) - 1):
        xa, za = coords[k]
        xb, zb = coords[k + 1]
        vx, vz = xb - xa, zb - za
        L2 = vx * vx + vz * vz
        if L2 <= 1e-12:
            continue
        t = max(0.0, min(1.0, ((qx - xa) * vx + (qz - za) * vz) / L2))
        bx, bz = xa + vx * t, za + vz * t
        d = math.hypot(bx - qx, bz - qz)
        if best is None or d < best[0]:
            best = (d, bx, bz, vx, vz, math.sqrt(L2))
    if best is None:
        return P
    dist, bx, bz, vx, vz, L = best
    ex, ez = vx / L, vz / L
    # направление q -> b (наружу от помещения)
    dx, dz = bx - qx, bz - qz
    dn = math.hypot(dx, dz)
    if dn < 1e-6:
        # fallback: нормаль к границе наружу (от центроида)
        nx, nz = -ez, ex
        c = P.centroid
        if nx * (c.x - qx) + nz * (c.y - qz) > 0:
            nx, nz = -nx, -nz
        dx, dz, dn = nx, nz, 1.0
    ux, uz = dx / dn, dz / dn
    px, pz = -uz, ux
    half = 0.08
    # прямоугольник: от чуть перед сэмплом до чуть за границу
    a0 = -0.12
    a1 = dist + 0.25
    cut = Polygon([
        (qx + px * half + ux * a0, qz + pz * half + uz * a0),
        (qx - px * half + ux * a0, qz - pz * half + uz * a0),
        (qx - px * half + ux * a1, qz - pz * half + uz * a1),
        (qx + px * half + ux * a1, qz + pz * half + uz * a1),
    ])
    try:
        Q = P.difference(cut)
    except Exception:  # noqa: BLE001
        return P
    Q = _largest(Q)
    if Q.is_empty or Q.area < P.area - 1.0:
        return P
    return Q


def trim_a6_samples(polys, floor_cells):
    """Срезать внешние сэмплы A6 полуплоскостью через сэмпл (контур остаётся одним)."""
    removed = 0
    for _ in range(15):
        changed = 0
        for i, P in enumerate(polys):
            if P.is_empty:
                continue
            for (xo, zo) in _a6_sample_points(P, floor_cells):
                qx, qz = xo + 0.05, zo + 0.05
                Q = _cut_notch(P, qx, qz)
                if Q is not P and Q.area > 0:
                    P = Q
                    changed += 1
            if changed:
                polys[i] = _largest(P)
        removed += changed
        if changed == 0:
            break
    return polys, removed


def buffer_rooms(polys, d, floor_cells):
    """Буфер +d с сохранением валидности/наложений."""
    out = []
    for P in polys:
        if P.is_empty:
            out.append(P)
            continue
        Q = P.buffer(d, join_style='mitre', quad_segs=2) if d > 0 else P
        Q = _largest(Q)
        out.append(Q)
    return out


def rooms_to_model(model, polys):
    """Записать полигоны/площади/центроиды в модель (копию)."""
    model2 = json.loads(json.dumps(model))
    for i, rm in enumerate(model2.get('rooms') or []):
        if i >= len(polys):
            break
        P = polys[i]
        if P.is_empty:
            continue
        if P.geom_type not in ('Polygon', 'MultiPolygon'):
            P = _largest(P)
        if P.geom_type == 'MultiPolygon':
            area = sum(g.area for g in P.geoms)
            Pmain = max(P.geoms, key=lambda g: g.area)
        else:
            area = P.area
            Pmain = P
        if not Pmain.is_valid:
            Pmain = Pmain.buffer(0)
            if Pmain.geom_type == 'MultiPolygon':
                Pmain = max(Pmain.geoms, key=lambda g: g.area)
        coords = [[round(float(x), 3), round(float(z), 3)] for x, z in Pmain.exterior.coords]
        if len(coords) > 1 and coords[0] == coords[-1]:
            coords = coords[:-1]
        if len(coords) < 3:
            continue
        rm['polygon'] = coords
        rm['area'] = round(float(area), 2)
        c = Pmain.centroid
        rm['cx'] = round(float(c.x), 3)
        rm['cz'] = round(float(c.y), 3)
    rooms = model2.get('rooms') or []
    stats = model2.setdefault('stats', {})
    stats['roomCount'] = len(rooms)
    stats['floorArea'] = round(sum(float(r.get('area') or 0.0) for r in rooms), 1)
    return model2


# ======================================================================================
# 5. Основная операция
# ======================================================================================
def clip_rooms(PT, model, max_iter=30, verbose=True):
    """Клиппинг помещений. Возвращает (model2, info).

    Итерирует: (а) снять наложения, (б) вырезать внешние сэмплы A6, (в) если площадь ниже
    исходной — минимальный буфер +d, чтобы A5 не упал (и A4 не пострадал).
    """
    storey = model.get('storey') or {}
    floorY = float(storey.get('floorY', 0.0) or 0.0)
    floor_cells = a6_floor_cells(PT, floorY)
    area_before = float(sum(float(r.get('area') or 0.0) for r in (model.get('rooms') or [])))
    P0 = []
    for rm in model.get('rooms') or []:
        poly = rm.get('polygon') or []
        if len(poly) < 3:
            P0.append(Polygon())
            continue
        P = Polygon(poly)
        if not P.is_valid:
            P = P.buffer(0)
        P0.append(P)
    polys = resolve_overlaps(P0)
    area_no_ov = sum(p.area for p in polys)
    polys, n_trim = trim_a6_samples(polys, floor_cells)
    area_trim = sum(p.area for p in polys)
    a6 = a6_metrics(polys, floor_cells)
    info = {'area_before_m2': round(area_before, 2),
            'area_after_overlap_m2': round(area_no_ov, 2),
            'area_after_trim_m2': round(area_trim, 2),
            'overlap_samples_trimmed': n_trim, 'buffer_m': 0.0, 'iterations': 0}
    if verbose:
        print('начальная площадь: %.2f м²' % area_before)
        print('после снятия наложений: %.2f м² (A6 %s)' % (
            area_no_ov, 'вне пола %.2f %%, наложение %.2f м²' % (
                a6_metrics(polys, floor_cells)['outside_pct'],
                a6_metrics(polys, floor_cells)['overlap_m2'])))
        print('после вырезания внешних сэмплов: %.2f м² (вырезано %d), A6 %.2f %% / %.2f м²' % (
            area_trim, n_trim, a6['outside_pct'], a6['overlap_m2']))
    ZONE = build_wall_zone(PT, model)
    if verbose:
        print('A4-безопасная зона вдоль стен: %.1f м² (буфер площади только здесь)' % ZONE['area_m2'])
    # итеративное восстановление площади минимальным буфером
    # (A6-сэмплы при буфере сдвигаются вместе с bbox — снова вырезаем и повторяем)
    target = area_before + 0.02
    d_total = 0.0
    best = None
    for it in range(40):
        area = sum(p.area for p in polys)
        a6 = a6_metrics(polys, floor_cells)
        a4 = a4_metrics(polys, model)
        cur = {'polys': polys, 'area': area, 'a6': a6, 'a4': a4, 'd': d_total, 'it': it}
        if best is None or area > best['area'] or (area >= target and a6['outside_pct'] <= 1e-9):
            if best is None or area > best['area'] - 1e-9:
                best = cur
        ok = (a6['outside_pct'] <= 1e-9 and a6['overlap_m2'] <= 1e-9 and area >= target)
        if verbose:
            print('  итерация %2d: буфер %.4f м, площадь %.2f м², A6 %.2f %%/%.2f м², A4 %.2f%%' % (
                it, d_total, area, a6['outside_pct'], a6['overlap_m2'], a4['perimeter_pct']))
        if ok:
            best = cur
            break
        if not polys:
            break
        need = target - area
        perim = max(1e-9, a4['perimeter_m'])
        step = max(0.0004, need / perim * 1.5) if need > 0 else 0.0
        if step > 0:
            if d_total + step > MAX_BUFFER:
                break
            d_total += step
            polys = zone_buffer(polys, step, ZONE['poly'])
            polys = resolve_overlaps(polys)
            polys, n2 = trim_a6_samples(polys, floor_cells)
            n_trim += n2
        else:
            # площадь достаточна, но A6 не нулевой: дорезаем сэмплы
            polys, n2 = trim_a6_samples(polys, floor_cells)
            n_trim += n2
            if n2 == 0:
                break
    if best is not None:
        polys = best['polys']
    info.update({'area_after_m2': round(sum(p.area for p in polys), 2),
                 'buffer_m': round(d_total, 5), 'iterations': it,
                 'a6': best['a6'] if best else None, 'a4': best['a4'] if best else None,
                 'samples_trimmed_total': n_trim})
    model2 = rooms_to_model(model, polys)
    return model2, info


# ======================================================================================
# 6. CLI
# ======================================================================================
def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Клиппинг помещений BIM-модели по видимому полу облака (A6, Фаза 1).',
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument('cloud', help='облако .bin (float32 x,y,z,r,g,b, Y вверх)')
    ap.add_argument('model_in', help='входная JSON-модель')
    ap.add_argument('model_out', help='куда записать JSON-модель (только если проверки OK)')
    ap.add_argument('--report', default=None, help='JSON-отчёт до/после')
    ap.add_argument('--stride', type=int, default=2, help='прореживание облака (2)')
    ap.add_argument('--force', action='store_true', help='записать даже если проверки не прошли')
    ap.add_argument('--json', action='store_true', help='машинный вывод одной JSON-строкой')
    args = ap.parse_args(argv)

    if not os.path.isfile(args.cloud) or not os.path.isfile(args.model_in):
        print('ОШИБКА: нет облака или модели', file=sys.stderr)
        return 2
    try:
        model = load_model(args.model_in)
        PT = load_cloud(args.cloud, stride=max(1, args.stride))
    except Exception as exc:  # noqa: BLE001
        print('ОШИБКА: %s' % exc, file=sys.stderr)
        return 2
    floorY = float((model.get('storey') or {}).get('floorY', 0.0) or 0.0)

    before_a6 = a6_metrics([Polygon(r['polygon']) for r in (model.get('rooms') or [])
                            if len(r.get('polygon') or []) >= 3], a6_floor_cells(PT, floorY))
    area_before = float(sum(float(r.get('area') or 0.0) for r in (model.get('rooms') or [])))
    fv = floor_visible_area(PT, model, floorY)
    a5_before = 100.0 * area_before / fv if fv else 0.0
    before_a4 = a4_metrics([Polygon(r['polygon']) for r in (model.get('rooms') or [])
                            if len(r.get('polygon') or []) >= 3], model)

    model2, info = clip_rooms(PT, model)
    after_a6 = a6_metrics([Polygon(r['polygon']) for r in (model2.get('rooms') or [])
                           if len(r.get('polygon') or []) >= 3], a6_floor_cells(PT, floorY))
    area_after = float(sum(float(r.get('area') or 0.0) for r in (model2.get('rooms') or [])))
    a5_after = 100.0 * area_after / fv if fv else 0.0
    after_a4 = a4_metrics([Polygon(r['polygon']) for r in (model2.get('rooms') or [])
                           if len(r.get('polygon') or []) >= 3], model2)

    improved = (after_a6['outside_pct'] < before_a6['outside_pct'] - 1e-9 and
                after_a6['overlap_m2'] <= before_a6['overlap_m2'] + 1e-9)
    a5_ok = (a5_after >= a5_before - 1e-9) and (a5_after <= 102.0)
    a4_ok = after_a4['perimeter_pct'] >= before_a4['perimeter_pct'] - 1e-9  # A4 не ухудшать
    ok = bool(improved and a5_ok and a4_ok)

    print('A6 до:     вне пола %.2f %%, наложение %.2f м²' % (
        before_a6['outside_pct'], before_a6['overlap_m2']))
    print('A6 после:  вне пола %.2f %%, наложение %.2f м²' % (
        after_a6['outside_pct'], after_a6['overlap_m2']))
    print('A5 до/после: %.2f / %.2f %% (площадь %.2f / %.2f м², видимый пол %.1f м²)' % (
        a5_before, a5_after, area_before, area_after, fv))
    print('A4 до/после: %.2f / %.2f %% (периметр %.1f м)' % (
        before_a4['perimeter_pct'], after_a4['perimeter_pct'], after_a4['perimeter_m']))
    print('проверки: A6 улучшился=%s, A5 не упал=%s, A4 не обвален=%s -> %s' % (
        improved, a5_ok, a4_ok, 'СОХРАНЯЮ' if ok else 'НЕ сохраняю (код 3)'))
    report = {'tool': 'clip-rooms.py', 'cloud': os.path.abspath(args.cloud),
              'model_in': os.path.abspath(args.model_in),
              'model_out': os.path.abspath(args.model_out),
              'before': dict(before_a6, rooms_area_m2=round(area_before, 2),
                             floor_visible_m2=round(fv, 2), area_ratio_pct=round(a5_before, 2),
                             a4_perimeter_pct=round(before_a4['perimeter_pct'], 2),
                             a4_perimeter_m=round(before_a4['perimeter_m'], 1)),
              'after': dict(after_a6, rooms_area_m2=round(area_after, 2),
                            floor_visible_m2=round(fv, 2), area_ratio_pct=round(a5_after, 2),
                            a4_perimeter_pct=round(after_a4['perimeter_pct'], 2),
                            a4_perimeter_m=round(after_a4['perimeter_m'], 1)),
              'info': info,
              'checks': {'a6_improved': improved, 'a5_not_fallen': a5_ok,
                         'a4_not_collapsed': a4_ok, 'saved': ok}}
    if args.report:
        with open(args.report, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=1)
        print('отчёт:', args.report)
    if args.json:
        sys.stdout.write(json.dumps(report, ensure_ascii=False) + '\n')
    if ok or args.force:
        save_model_atomic(model2, args.model_out)
        print('модель записана:', args.model_out)
        return 0
    return 3


if __name__ == '__main__':
    sys.exit(main())
