# -*- coding: utf-8 -*-
"""scan2bim-facade (ревизия 109, фаза 2 роадмапа): режим вертикального фасада.

Вызывается из scan2bim-v2.py при `--mode=facade` (или `--mode=auto`, когда облако похоже
на фасад: высокое и тонкое в плане):

    python tools/scan2bim-py/scan2bim-v2.py cloud.bin model.json --mode=facade

Идея (та же, что в замерах tools/scan2bim-realmeasure.js, но отдельная реализация на numpy):
  1. главная вертикальная плоскость фасада — PCA в плане (X,Z), плоскость через медиану
     смещений, полоса ±band;
  2. развёртка фасада: u — вдоль стены (по направлению dir), v — высота (Y, м);
  3. окна = пустоты в стене: сетка 5 см по (u,v), расширение занятости на 1 клетку,
     связные пустоты, не касающиеся края, фильтры размеров; склейка «фрамуг» через импосты;
  4. этажи: ряды окон (по низу) → медианный шаг 3.3–4.1 м → робастная подгонка сетки
     «шаг+база» → полы этажей; шаг и полосы перекрытий проверяются по горизонтальным
     полосам плотности облака;
  5. модель JSON в схеме scan2bim-v2: walls — стены-полосы по этажам (base/height этажа),
     openings — окна (along/width/sill/head), slabs — горизонтальные полосы перекрытий
     (прямоугольник вдоль фасада на уровне пола этажа), storeys[] — этажи (для toIFC).

Не ищет пол/потолок помещения и помещения — это интерьерный режим. Если фасадных
признаков нет (кроп произвольного облака), возвращает вырожденную модель без падения.
"""
import json
import math
import os
import sys
import time

import numpy as np

CELL = 0.05          # ячейка развёртки, м
BAND = 0.5           # полуширина полосы фасада, м
PITCH_MIN = 3.30     # допустимый шаг этажей, м
PITCH_MAX = 4.10
SILL_GUESS = 0.90    # подоконник ≈ 0.9 м над полом → пол = низ ряда − 0.9


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- геометрия плоскости
def facade_plane(xyz):
    """Главная вертикальная плоскость по плану (X,Z). Возвращает параметры и маску полосы."""
    x = xyz[:, 0].astype(np.float64)
    z = xyz[:, 2].astype(np.float64)
    sx = float(x.mean())
    sz = float(z.mean())
    dx = x - sx
    dz = z - sz
    sxx = float(np.dot(dx, dx))
    sxz = float(np.dot(dx, dz))
    szz = float(np.dot(dz, dz))
    tr = sxx + szz
    det = sxx * szz - sxz * sxz
    l1 = tr / 2.0 + math.sqrt(max(0.0, tr * tr / 4.0 - det))
    if abs(sxz) > 1e-9:
        dirx, dirz = l1 - szz, sxz
    else:
        dirx, dirz = 1.0, 0.0
    dl = math.hypot(dirx, dirz) or 1.0
    dirx /= dl
    dirz /= dl
    nrmx, nrmz = -dirz, dirx
    offs = dx * nrmx + dz * nrmz
    plane_off = float(np.median(offs))
    d = offs - plane_off
    near = np.abs(d) <= BAND
    rms = float(np.sqrt(np.mean(d[near] ** 2))) if near.any() else 0.0
    return {
        'dir': (dirx, dirz), 'nrm': (nrmx, nrmz), 'sx': sx, 'sz': sz,
        'offset': plane_off, 'rms': rms, 'near': near,
        'angleDeg': float(math.degrees(math.atan2(dirz, dirx))),
    }


def unfold(xyz, pl):
    """u вдоль фасада, v высота, n смещение от плоскости — для всех точек."""
    dirx, dirz = pl['dir']
    nrmx, nrmz = pl['nrm']
    u = (xyz[:, 0] - pl['sx']) * dirx + (xyz[:, 2] - pl['sz']) * dirz
    n = (xyz[:, 0] - pl['sx']) * nrmx + (xyz[:, 2] - pl['sz']) * nrmz - pl['offset']
    return u, n


def _grid_holes(wall_u, wall_v, u_min, u_max, v_min, v_max, cell):
    """Окна-пустоты на развёртке: сетка занятости + расширение + связные пустоты."""
    gw = int(math.ceil((u_max - u_min) / cell)) + 1
    gh = int(math.ceil((v_max - v_min) / cell)) + 1
    iu = np.floor((wall_u - u_min) / cell).astype(np.int64)
    iv = np.floor((wall_v - v_min) / cell).astype(np.int64)
    ok = (iu >= 0) & (iu < gw) & (iv >= 0) & (iv < gh)
    occ = np.zeros((gh, gw), bool)
    occ[iv[ok], iu[ok]] = True
    # расширение занятости на 1 клетку (тонкие линии облака не должны давать щели)
    p = np.pad(occ, 1, mode='constant', constant_values=False)
    occ2 = np.zeros_like(occ)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            occ2 |= p[1 + dy:1 + dy + gh, 1 + dx:1 + dx + gw]
    empty = ~occ2
    visited = np.zeros(gh * gw, np.uint8)
    flat_empty = empty.reshape(-1)
    holes = []
    idxs = np.flatnonzero(flat_empty)
    for s in idxs:
        s = int(s)
        if visited[s]:
            continue
        visited[s] = 1
        stack = [s]
        cells = 0
        touch = False
        x0 = y0 = 1 << 30
        x1 = y1 = -1
        while stack:
            c = stack.pop()
            cells += 1
            x = c % gw
            y = c // gw
            if x == 0 or y == 0 or x == gw - 1 or y == gh - 1:
                touch = True
            if x < x0: x0 = x
            if x > x1: x1 = x
            if y < y0: y0 = y
            if y > y1: y1 = y
            if x > 0:
                nb = c - 1
                if flat_empty[nb] and not visited[nb]:
                    visited[nb] = 1; stack.append(nb)
            if x < gw - 1:
                nb = c + 1
                if flat_empty[nb] and not visited[nb]:
                    visited[nb] = 1; stack.append(nb)
            if y > 0:
                nb = c - gw
                if flat_empty[nb] and not visited[nb]:
                    visited[nb] = 1; stack.append(nb)
            if y < gh - 1:
                nb = c + gw
                if flat_empty[nb] and not visited[nb]:
                    visited[nb] = 1; stack.append(nb)
        if touch or cells < 20:
            continue
        w = (x1 - x0 + 1) * cell
        h = (y1 - y0 + 1) * cell
        if w < 0.35 or h < 0.35 or w > 6.0 or h > 3.5:
            continue
        holes.append({
            'u0': u_min + x0 * cell, 'u1': u_min + (x1 + 1) * cell,
            'v0': v_min + y0 * cell, 'v1': v_min + (y1 + 1) * cell,
            'w': round(w, 3), 'h': round(h, 3), 'area': round(w * h, 4),
            'fill': round(cells * cell * cell / (w * h), 4),
        })
    holes.sort(key=lambda h: (h['v0'], h['u0']))
    return holes, gw, gh, occ2


def _merge_imposts(holes):
    """Склейка «фрамуг», разбитых импостами: соседние пустоты с узким простенком (<0.55 м)."""
    merged = []
    for h in holes:
        target = None
        for m in reversed(merged):
            if abs(m['v0'] - h['v0']) > 0.3 or abs(m['v1'] - h['v1']) > 0.3:
                continue
            if h['u0'] - m['u1'] > 0.55 or m['u0'] - h['u1'] > 0.55:
                continue
            target = m
            break
        if target is not None:
            target['u0'] = min(target['u0'], h['u0'])
            target['u1'] = max(target['u1'], h['u1'])
            target['w'] = round(target['u1'] - target['u0'], 3)
            target['area'] = round(target['w'] * target['h'], 4)
        else:
            merged.append(dict(h))
    out = [m for m in merged if 0.5 <= m['w'] <= 3.6]
    out.sort(key=lambda h: (h['v0'], h['u0']))
    return out


def _rows_of(holes):
    rows = []
    for h in holes:
        row = None
        for r in rows:
            if abs(r['v0'] - h['v0']) < 0.6:
                row = r
                break
        if row is None:
            row = {'v0': float(h['v0']), 'items': []}
            rows.append(row)
        row['items'].append(h)
    rows.sort(key=lambda r: r['v0'])
    for r in rows:
        r['count'] = len(r['items'])
    return rows


def _fit_pitch(rows, v_min, v_max):
    """Робастная подгонка «полы этажей = база + k*шаг» по низам рядов окон (v0 − 0.9).

    Возвращает (pitch, floors[]). Инвариантна к лишним рядам (импосты, витрины):
    подбирается сетка, к которой привязано большинство рядов; выбросы не ломают шаг.
    """
    if len(rows) < 2:
        return None, []
    fg = sorted(float(r['v0'] - SILL_GUESS) for r in rows)
    diffs = np.diff(np.array(fg))
    valid = diffs[(diffs >= PITCH_MIN) & (diffs <= PITCH_MAX)]
    if len(valid) < 1:
        return None, []
    pitch = float(np.median(valid))
    base = fg[0]
    for _ in range(4):
        ks = [int(round((f - base) / pitch)) for f in fg]
        resid = [f - (base + k * pitch) for f, k in zip(fg, ks)]
        # база = сдвиг, дающий максимум точных попаданий, при равенстве — минимум |resid|
        cand = sorted(set(round(base + r, 4) for r in resid))
        best = None
        for b in cand:
            rs = [abs(f - (b + k * pitch)) for f, k in zip(fg, ks)]
            score = (sum(1 for r in rs if r < 0.05), -sum(rs))
            if best is None or score > best[0]:
                best = (score, b)
        base = best[1]
        ks = np.array([int(round((f - base) / pitch)) for f in fg], float)
        good = np.abs(np.array(fg) - (base + ks * pitch)) < 0.5
        if good.sum() >= 2:
            kk = ks[good]
            ff = np.array(fg)[good]
            A = np.vstack([np.ones_like(kk), kk]).T
            sol, *_ = np.linalg.lstsq(A, ff, rcond=None)
            nb, npch = float(sol[0]), float(sol[1])
            if PITCH_MIN <= npch <= PITCH_MAX:
                base, pitch = nb, npch
        base = round(base, 3)
        pitch = round(pitch, 4)
    # этажи: сетка только там, где реально есть ряды окон (нижние витрины/пустой низ не досочиняем,
    # как и замеры scan2bim-realmeasure), но не выше верхнего ряда
    ks = sorted(int(round((f - base) / pitch)) for f in fg)
    floors = [round(base + k * pitch, 3) for k in range(ks[0], ks[-1] + 1)]
    floors = [f for f in floors if f >= v_min + 0.5 and f <= v_max - 0.8]
    return pitch, floors


def _spandrel_bands(rows, floors, wall_u, wall_v, u0, cell):
    """Полосы перекрытий: сплошные горизонтальные полосы между рядами окон.

    Для каждой пары соседних рядов окон берём промежуток «верх нижнего ряда … низ верхнего ряда»,
    меряем покрытие по u (доля 5-см колонок с точками) и проверяем, попадает ли в полосу пол этажа.
    """
    bands = []
    if len(rows) < 2:
        return bands
    for a, b in zip(rows[:-1], rows[1:]):
        lo = max(h['v1'] for h in a['items'])
        hi = min(h['v0'] for h in b['items'])
        if hi - lo < 0.25:
            continue
        m = (wall_v >= lo) & (wall_v <= hi)
        cover = 0.0
        if m.sum() >= 30:
            iu = np.floor((wall_u[m] - u0) / cell).astype(np.int64)
            iu = iu[iu >= 0]
            cover = len(np.unique(iu)) / max(1.0, (wall_u.max() - wall_u.min()) / cell)
        inside = [f for f in floors if lo - 0.05 <= f <= hi + 0.05]
        bands.append({'lo': round(float(lo), 3), 'hi': round(float(hi), 3),
                      'height': round(float(hi - lo), 3), 'coverage': round(float(cover), 3),
                      'floorsInside': [round(float(f), 3) for f in inside]})
    return bands


def _horizontal_bands(wall_u, wall_v, u_min, u_max, v_min, v_max, cell, gw):
    """Горизонтальные плотные полосы на фасаде (перегородки/перекрытия между рядами окон)."""
    if len(wall_v) < 100:
        return []
    gh = int(math.ceil((v_max - v_min) / cell)) + 1
    iu = np.floor((wall_u - u_min) / cell).astype(np.int64)
    iv = np.floor((wall_v - v_min) / cell).astype(np.int64)
    ok = (iu >= 0) & (iu < gw) & (iv >= 0) & (iv < gh)
    key = (iv[ok].astype(np.int64) * gw + iu[ok]).astype(np.int64)
    uniq = np.unique(key)
    row_occ = np.bincount((uniq // gw).astype(np.int64), minlength=gh)
    score = row_occ / float(max(1, gw))
    # сглаживание 0.25 м
    k = np.ones(5, float) / 5.0
    score = np.convolve(score, k, mode='same')
    bands = []
    for y in range(2, gh - 2):
        if score[y] >= 0.45 and score[y] >= score[y - 1] and score[y] >= score[y + 1]:
            v = v_min + y * cell
            if bands and v - bands[-1]['v'] < 1.2:
                if score[y] > bands[-1]['score']:
                    bands[-1] = {'v': round(v, 3), 'score': round(float(score[y]), 3)}
                continue
            bands.append({'v': round(v, 3), 'score': round(float(score[y]), 3)})
    return bands


def _solid_span(wall_u, u_min, u_max, cell):
    """Сплошной участок вдоль u (по 5-см колонкам), где есть точки: (u0,u1)."""
    if len(wall_u) == 0:
        return u_min, u_max
    gw = int(math.ceil((u_max - u_min) / cell)) + 1
    iu = np.floor((wall_u - u_min) / cell).astype(np.int64)
    ok = (iu >= 0) & (iu < gw)
    cols = np.zeros(gw, bool)
    cols[iu[ok]] = True
    idx = np.flatnonzero(cols)
    if len(idx) < 2:
        return u_min, u_max
    return u_min + idx[0] * cell, u_min + (idx[-1] + 1) * cell


# ---------------------------------------------------------------- вырожденный режим
def _degenerate_model(xyz, pl, wall_u, wall_v, u_min, u_max, v_min, v_max, cell, t0, note,
                      holes=None, rows=None, bands=None):
    """Нет регулярных этажей/окон (например, кроп произвольной области): одна полоса-стена.

    Не падаем: по возможности сохраняем найденные пустоты как проёмы (это может быть фасад
    без видимых регулярных этажей), иначе просто отдаём стену по габариту.
    """
    holes = holes or []
    rows = rows or []
    bands = bands or []
    u0, u1 = _solid_span(wall_u, u_min, u_max, cell)
    L = max(0.5, u1 - u0)
    H = max(0.5, v_max - v_min)
    dirx, dirz = pl['dir']
    nrmx, nrmz = pl['nrm']
    off = pl['offset']

    def plan(u, n=0.0):
        return [round(pl['sx'] + dirx * u + nrmx * (off + n), 4),
                round(pl['sz'] + dirz * u + nrmz * (off + n), 4)]
    a = plan(u0)
    b = plan(u1)
    openings = []
    for h in holes:
        a0 = max(0.02, h['u0'] - u0)
        w = min(L - 0.02 - a0, h['w'])
        sill = max(0.0, h['v0'] - v_min)
        head = min(H, h['v1'] - v_min)
        if w < 0.5 or head - sill < 0.4:
            continue
        openings.append({'along': round(float(a0), 3), 'width': round(float(w), 3),
                         'sill': round(float(sill), 3), 'head': round(float(head), 3),
                         'kind': 'window' if sill >= 0.30 else 'door'})
    openings.sort(key=lambda o: o['along'])
    wall = {
        'a': a, 'b': b, 'dir': [round(dirx, 5), round(dirz, 5)],
        'thickness': 0.20, 'length': round(L, 3),
        'base': round(v_min, 3), 'height': round(H, 3),
        'openings': openings, 'passages': [], 'color': [0.7, 0.68, 0.64],
        'material': 'facade', 'inferred': False, 'rms': round(pl['rms'], 3), 'storeyIndex': 0,
    }
    floor_poly = [plan(u0, -3.0), plan(u1, -3.0), plan(u1, 3.0), plan(u0, 3.0)]
    n_win = len(openings)
    model = {
        'ok': True, 'units': 'm', 'mode': 'facade',
        'storey': {'floorY': round(v_min, 3), 'ceilY': round(v_max, 3), 'height': round(H, 3)},
        'storeys': [{'index': 0, 'floorY': round(v_min, 3), 'ceilY': round(v_max, 3),
                     'height': round(H, 3), 'windows': n_win}],
        'walls': [wall],
        'slabs': [{'type': 'floor', 'level': round(v_min, 3), 'thickness': 0.2,
                   'polygon': floor_poly, 'color': [0.72, 0.70, 0.66], 'storeyIndex': 0},
                  {'type': 'ceiling', 'level': round(v_max, 3), 'thickness': 0.2,
                   'polygon': floor_poly, 'color': [0.74, 0.72, 0.68], 'storeyIndex': 0}],
        'rooms': [], 'pipes': [], 'beams': [], 'objects': [], 'cables': [],
        'facade': {
            'ok': False, 'note': note, 'fallback': True,
            'plane': {'angleDeg': round(pl['angleDeg'], 3), 'rms': round(pl['rms'], 4),
                      'band': BAND, 'offset': round(pl['offset'], 4),
                      'dir': [round(dirx, 6), round(dirz, 6)],
                      'nrm': [round(nrmx, 6), round(nrmz, 6)],
                      'sx': round(pl['sx'], 4), 'sz': round(pl['sz'], 4)},
            'bbox': {'uMin': round(u_min, 3), 'uMax': round(u_max, 3),
                     'vMin': round(v_min, 3), 'vMax': round(v_max, 3)},
            'cell': cell,
            'rows': [{'v0': round(r['v0'], 3), 'count': r['count']} for r in rows],
            'holes': [{'u0': round(h['u0'], 3), 'u1': round(h['u1'], 3),
                       'v0': round(h['v0'], 3), 'v1': round(h['v1'], 3),
                       'w': h['w'], 'h': h['h'], 'fill': h['fill']} for h in holes],
            'pitch': None, 'floors': [], 'bands': bands,
            'windowsPerFloor': [n_win], 'windowCount': n_win,
            'spandrelConfirmed': 0, 'spandrelTotal': 0,
        },
        'stats': {'wallCount': 1, 'openingCount': n_win, 'windowCount': n_win, 'passageCount': 0,
                  'roomCount': 0, 'storeyCount': 1, 'floorArea': round(L * 6.0, 1),
                  'totalWallLength': round(L, 1), 'pitch': None,
                  'windowsPerFloor': [n_win], 'spandrelConfirmed': 0, 'spandrelTotal': 0,
                  'pointsIn': int(len(xyz)), 'pointsUsed': int(len(wall_v)),
                  'meanWallRms': round(pl['rms'], 3), 'time_s': round(time.time() - t0, 2)},
    }
    return model


# ---------------------------------------------------------------- основной прогон
def analyse(xyz, cell=CELL, band=BAND, sample=1):
    t0 = time.time()
    if sample and sample > 1:
        xyz = xyz[::sample]
    pl = facade_plane(xyz)
    u, n = unfold(xyz, pl)
    wall_m = pl['near']
    wall_u = u[wall_m]
    wall_v = xyz[wall_m, 1]
    if len(wall_u) < 500:
        # фасад не выделился полосой — берём все точки (кроп может быть узким)
        wall_m = np.ones(len(xyz), bool)
        wall_u, wall_v = u, xyz[:, 1]
    u_min = float(wall_u.min()); u_max = float(wall_u.max())
    v_min = float(wall_v.min()); v_max = float(wall_v.max())
    holes, gw, gh, occ2 = _grid_holes(wall_u, wall_v, u_min, u_max, v_min, v_max, cell)
    holes = _merge_imposts(holes)
    rows = _rows_of(holes)
    bands = _horizontal_bands(wall_u, wall_v, u_min, u_max, v_min, v_max, cell, gw)
    pitch, floors = _fit_pitch(rows, v_min, v_max)
    note = None
    if not floors:
        note = 'ряды окон не дали регулярного шага этажей'
        model = _degenerate_model(xyz, pl, wall_u, wall_v, u_min, u_max, v_min, v_max, cell, t0, note,
                                  holes=holes, rows=rows, bands=bands)
        return model, {'plane': pl, 'u_min': u_min, 'u_max': u_max, 'v_min': v_min, 'v_max': v_max,
                       'cell': cell, 'holes': holes, 'rows': rows, 'pitch': None,
                       'floors': [], 'bands': bands, 'gw': gw, 'gh': gh,
                       'wall_u': wall_u, 'wall_v': wall_v, 't0': t0, 'note': note}
    # этажи: полы + потолок последнего = верх фасада
    storeys = []
    for i, fy in enumerate(floors):
        cy = floors[i + 1] if i + 1 < len(floors) else v_max
        if cy - fy < 1.2:
            continue
        storeys.append({'index': len(storeys), 'floorY': round(float(fy), 3),
                        'ceilY': round(float(cy), 3), 'height': round(float(cy - fy), 3)})
    if not storeys:
        note = 'этажи выродились по высоте'
        model = _degenerate_model(xyz, pl, wall_u, wall_v, u_min, u_max, v_min, v_max, cell, t0, note,
                                  holes=holes, rows=rows, bands=bands)
        return model, {'plane': pl, 'u_min': u_min, 'u_max': u_max, 'v_min': v_min, 'v_max': v_max,
                       'cell': cell, 'holes': holes, 'rows': rows, 'pitch': pitch,
                       'floors': floors, 'bands': bands, 'gw': gw, 'gh': gh,
                       'wall_u': wall_u, 'wall_v': wall_v, 't0': t0, 'note': note}
    # стены-полосы по этажам + окна
    dirx, dirz = pl['dir']
    nrmx, nrmz = pl['nrm']
    off = pl['offset']

    def plan(u, n_off=0.0):
        return [pl['sx'] + dirx * u + nrmx * (off + n_off),
                pl['sz'] + dirz * u + nrmz * (off + n_off)]
    u0, u1 = _solid_span(wall_u, u_min, u_max, cell)
    L = max(0.5, u1 - u0)
    n_all = n
    depth_lo = float(np.percentile(n_all, 1))
    depth_hi = float(np.percentile(n_all, 99))
    depth = max(1.0, depth_hi - depth_lo)
    walls = []
    for st in storeys:
        fy, cy = st['floorY'], st['ceilY']
        H = cy - fy
        io = []
        for h in holes:
            cv = (h['v0'] + h['v1']) / 2.0
            if not (fy <= cv < cy):
                continue
            a0 = max(0.02, h['u0'] - u0)
            w = min(L - 0.02 - a0, h['w'])
            if w < 0.5:
                continue
            sill = max(0.0, h['v0'] - fy)
            head = min(H, h['v1'] - fy)
            if head - sill < 0.4:
                continue
            kind = 'window' if sill >= 0.30 else 'door'
            io.append({'along': round(float(a0), 3), 'width': round(float(w), 3),
                       'sill': round(float(sill), 3), 'head': round(float(head), 3), 'kind': kind})
        io.sort(key=lambda o: o['along'])
        # цвет — медиана RGB точек полосы этажа (если есть)
        wall = {
            'a': [round(v, 4) for v in plan(u0)], 'b': [round(v, 4) for v in plan(u1)],
            'dir': [round(dirx, 5), round(dirz, 5)], 'thickness': 0.24,
            'length': round(L, 3), 'base': round(fy, 3), 'height': round(H, 3),
            'openings': io, 'passages': [], 'color': [0.70, 0.68, 0.64],
            'material': 'facade', 'inferred': False, 'rms': round(pl['rms'], 3),
            'storeyIndex': st['index'],
        }
        walls.append(wall)
        st['windows'] = len(io)
        st['window_u'] = [round((o['along'] + u0), 3) for o in io]
    # полосы перекрытий: горизонтальные плиты на уровне пола каждого этажа (полоса вдоль фасада)
    slabs = []
    for st in storeys:
        fy = st['floorY']
        poly = [plan(u0, depth_lo), plan(u1, depth_lo), plan(u1, depth_hi), plan(u0, depth_hi)]
        slabs.append({'type': 'floor', 'level': round(fy, 3), 'thickness': 0.20,
                      'polygon': [[round(p[0], 4), round(p[1], 4)] for p in poly],
                      'color': [0.72, 0.70, 0.66], 'storeyIndex': st['index'],
                      'band': True, 'bandWidth': round(depth, 2)})
    top = storeys[-1]['ceilY']
    poly = [plan(u0, depth_lo), plan(u1, depth_lo), plan(u1, depth_hi), plan(u0, depth_hi)]
    slabs.append({'type': 'ceiling', 'level': round(top, 3), 'thickness': 0.20,
                  'polygon': [[round(p[0], 4), round(p[1], 4)] for p in poly],
                  'color': [0.74, 0.72, 0.68], 'storeyIndex': storeys[-1]['index']})
    # диагностика полос перекрытий: насколько плотны горизонтальные полосы у полов этажей
    spandrel = _spandrel_bands(rows, floors, wall_u, wall_v, u0, cell)
    n_confirmed = sum(1 for b in spandrel if b['floorsInside'] and b['coverage'] >= 0.85)
    n_win = sum(len(w['openings']) for w in walls)
    wpf = [st.get('windows', 0) for st in storeys]
    model = {
        'ok': True, 'units': 'm', 'mode': 'facade', 'multiStorey': True,
        'storey': {'floorY': storeys[0]['floorY'], 'ceilY': storeys[0]['ceilY'],
                   'height': storeys[0]['height']},
        'storeys': storeys,
        'walls': walls,
        'slabs': slabs,
        'rooms': [], 'pipes': [], 'beams': [], 'objects': [], 'cables': [],
        'footprint': [[round(p[0], 4), round(p[1], 4)] for p in
                      [plan(u0, depth_lo), plan(u1, depth_lo), plan(u1, depth_hi), plan(u0, depth_hi)]],
        'facade': {
            'ok': True,
            'plane': {'angleDeg': round(pl['angleDeg'], 3), 'rms': round(pl['rms'], 4),
                      'band': band, 'offset': round(pl['offset'], 4),
                      'dir': [round(dirx, 6), round(dirz, 6)],
                      'nrm': [round(nrmx, 6), round(nrmz, 6)],
                      'sx': round(pl['sx'], 4), 'sz': round(pl['sz'], 4)},
            'bbox': {'uMin': round(u_min, 3), 'uMax': round(u_max, 3),
                     'vMin': round(v_min, 3), 'vMax': round(v_max, 3)},
            'cell': cell, 'sample': int(sample or 1),
            'rows': [{'v0': round(r['v0'], 3), 'count': r['count']} for r in rows],
            'holes': [{'u0': round(h['u0'], 3), 'u1': round(h['u1'], 3),
                       'v0': round(h['v0'], 3), 'v1': round(h['v1'], 3),
                       'w': h['w'], 'h': h['h'], 'fill': h['fill']} for h in holes],
            'pitch': round(float(pitch), 3), 'floors': [round(f, 3) for f in floors],
            'bands': bands, 'spandrel': spandrel,
            'spandrelConfirmed': int(n_confirmed), 'spandrelTotal': len(spandrel),
            'windowsPerFloor': wpf, 'windowCount': n_win,
        },
        'stats': {
            'wallCount': len(walls), 'openingCount': n_win, 'windowCount': n_win,
            'passageCount': 0, 'roomCount': 0, 'storeyCount': len(storeys),
            'floorArea': round(L * depth, 1), 'totalWallLength': round(L * len(walls), 1),
            'pitch': round(float(pitch), 3), 'windowsPerFloor': wpf,
            'spandrelConfirmed': int(n_confirmed), 'spandrelTotal': len(spandrel),
            'pointsIn': int(len(xyz)), 'pointsUsed': int(len(wall_u)),
            'meanWallRms': round(pl['rms'], 3), 'cell': cell,
            'time_s': round(time.time() - t0, 2),
        },
    }
    info = {'plane': pl, 'u_min': u_min, 'u_max': u_max, 'v_min': v_min, 'v_max': v_max,
            'cell': cell, 'holes': holes, 'rows': rows, 'pitch': pitch, 'floors': floors,
            'bands': bands, 'gw': gw, 'gh': gh, 'wall_u': wall_u, 'wall_v': wall_v,
            't0': t0, 'note': note, 'storeys': storeys}
    return model, info


def print_summary(model, info):
    f = model.get('facade') or {}
    if not f.get('ok'):
        log('фасад: fallback-модель без регулярных этажей (%s): стена %.2f м, проёмов %d' % (
            f.get('note'), model['walls'][0]['length'] if model.get('walls') else 0,
            sum(len(w.get('openings') or []) for w in (model.get('walls') or []))))
        return
    log('плоскость фасада: направление %.2f°, RMS %.1f мм, полоса ±%.2f м' % (
        f['plane']['angleDeg'], f['plane']['rms'] * 1000, f['plane']['band']))
    log('развёртка: u %.2f…%.2f м (%.2f м), высота %.2f…%.2f м' % (
        f['bbox']['uMin'], f['bbox']['uMax'], f['bbox']['uMax'] - f['bbox']['uMin'],
        f['bbox']['vMin'], f['bbox']['vMax']))
    log('окон-пустот: %d, после склейки импостов: %d' % (len(f['holes']), f['windowCount']))
    for i, st in enumerate(model['storeys']):
        log('  этаж %d: пол %.2f, потолок %.2f (H=%.2f), окон %d' % (
            i + 1, st['floorY'], st['ceilY'], st['height'], st.get('windows', 0)))
    log('шаг этажей: %.2f м | этажей: %d' % (f['pitch'], len(model['storeys'])))
    if f.get('bands'):
        log('горизонтальные полосы: ' + ', '.join('%.2f м (%.0f%%)' % (b['v'], b['score'] * 100)
                                                   for b in f['bands']))
    if f.get('spandrel'):
        log('полосы перекрытий между рядами окон: %d/%d подтверждены (%.0f%% ширины)' % (
            f.get('spandrelConfirmed', 0), f.get('spandrelTotal', 0),
            100.0 * min(1.0, np.mean([b['coverage'] for b in f['spandrel']])) if f['spandrel'] else 0))
        for b in f['spandrel']:
            log('  %.2f…%.2f м (%.0f%%), полы в полосе: %s' % (
                b['lo'], b['hi'], b['coverage'] * 100, b['floorsInside'] or '—'))


def run(xyz, out_json, args=None, rgb=None):
    args = args or {}
    try:
        cell = float(args.get('cell', CELL))
    except Exception:
        cell = CELL
    try:
        band = float(args.get('band', BAND))
    except Exception:
        band = BAND
    try:
        sample = int(args.get('sample', args.get('stride', 0)) or 0)
    except Exception:
        sample = 0
    # плотные облака (несколько проходов по одной стене) забивают пустоты окон точками стекла:
    # фасадный анализ идёт по подвыборке ~2.4 млн точек (как в замерах), --sample переопределяет.
    if sample <= 0:
        sample = int(math.ceil(len(xyz) / 2400000.0)) if len(xyz) > 4000000 else 1
    if sample > 1:
        log('фасад: подвыборка каждой %d-й точки (%d из %d)' % (sample, len(xyz[::sample]), len(xyz)))
    t0 = time.time()
    model, info = analyse(xyz, cell=cell, band=band, sample=sample)
    model['mode'] = 'facade'
    model['stats']['runTime_s'] = round(time.time() - t0, 2)
    json.dump(model, open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print_summary(model, info)
    log('JSON:', out_json)
    return model


def looks_like_facade(xyz):
    """Авто-режим: высокое и тонкое в плане облако — фасад (а не помещение)."""
    if len(xyz) < 1000:
        return False
    y = xyz[:, 1]
    h = float(y.max() - y.min())
    wx = float(np.ptp(xyz[:, 0]))
    wz = float(np.ptp(xyz[:, 2]))
    thin = min(wx, wz)
    if h < 6.0:
        return False
    return thin < 0.45 * h and max(wx, wz) > 2.0 * max(0.5, thin)


if __name__ == '__main__':
    # автономный запуск: python scan2bim_facade.py cloud.bin model.json [cell=0.05 sample=1]
    if len(sys.argv) < 3:
        print('нужно: python scan2bim_facade.py cloud.bin model.json [cell=0.05] [band=0.5] [sample=1]')
        sys.exit(2)
    argv = sys.argv[3:]
    opt = {}
    for a in argv:
        if '=' in a:
            k, v = a.split('=', 1)
            opt[k.lstrip('-')] = v
    P = np.fromfile(sys.argv[1], dtype=np.float32).reshape(-1, 6)
    run(P[:, :3].astype(np.float64), sys.argv[2], opt, rgb=P[:, 3:6])
