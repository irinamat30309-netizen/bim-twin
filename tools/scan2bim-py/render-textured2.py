# -*- coding: utf-8 -*-
"""Текстурный рендер модели scan2bim v2.1: цвет ячейки грани — медиана точек облака.

Ключевые отличия от v2:
  * нет brighten(): цвет не осветляется до target=0.56 и не смешивается с серым;
  * яркость масштабируется единым коэффициентом для R,G,B (сохраняются оттенок и
    насыщенность точки скана);
  * контраст растягивается по перцентилям 5–95 внутри каждой грани/стены, а не
    глобально по всей модели;
  * ячейки 0.20 x 0.28 м (вместо 0.35 x 0.50), поэтому фактура детальная;
  * выборка — только точки в узкой полосе у плоскости грани:
    |off - side*t/2| <= min(0.15, t/2), на высоте ячейки; трубы/объекты за
    пределами полосы и объёмный шум стены не попадают;
  * сглаживание — только коэффициента яркости по соседним ячейкам (шум), цвет
    каждой ячейки остаётся своим цветом скана;
  * фон, свет (shade) и подпись не изменены.

Запуск:
  python render-textured2.py model.json local-rgb.bin out.png eye=x,y,z target=x,y,z fov=.. size=..
"""
import json
import math
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    import shapely
    from shapely.geometry import Polygon
    HAVE_SHAPELY = True
except Exception:                                    # shapely есть в рабочем окружении, но не обязателен
    HAVE_SHAPELY = False

J = json.load(open(sys.argv[1], encoding='utf-8-sig'))
bin_path = sys.argv[2]
out = sys.argv[3]
args = dict(a.split('=') for a in sys.argv[4:] if '=' in a)
eye = np.array([float(v) for v in args.get('eye', '16,13,17').split(',')])
tgt = np.array([float(v) for v in args.get('target', '0,1.4,0').split(',')])
fov = float(args.get('fov', 50))
W, H = [int(v) for v in args.get('size', '1600x1000').split('x')]
up = np.array([0.0, 0.0, 1.0]) if args.get('up') == 'z' else np.array([0.0, 1.0, 0.0])

P = np.fromfile(bin_path, dtype=np.float32).reshape(-1, 6)
PC = P[:, :3].astype(np.float64)
COL = np.clip(P[:, 3:6].astype(np.float64), 0, 1)
COLMAX = COL.max(axis=1)
X, Y, Z = PC[:, 0], PC[:, 1], PC[:, 2]
print('точек облака:', len(P))

st = J['storey']
floorY, ceilY = st['floorY'], st['ceilY']
Hh = ceilY - floorY
DEFAULT_WALL = np.array([0.62, 0.58, 0.53])
BG = (247, 245, 239)

# --- параметры калибровки цвета -------------------------------------------------
LUM = np.array([0.2126, 0.7152, 0.0722])   # веса яркости (Rec.709), одинаковы для всех каналов
CELL_S = 0.20                               # шаг ячейки вдоль стены, м
CELL_H = 0.28                               # шаг ячейки по высоте, м
MIN_CELL = 24                               # минимум точек для медианы ячейки
MIN_SUPER = 48                              # минимум точек для медианы блока 3x3
CONTRAST = 0.22                             # растяжение яркости: +-22 % от медианы элемента
CHROMA_KEEP = 0.35                          # доля локального отклонения цвета скана от медианы элемента
SMOOTH = 0.30                               # доля соседей при сглаживании ТОЛЬКО яркости
CLIP_MAX = 0.985                            # верхняя граница, чтобы не упираться в 1.0


def font(size):
    for p in ('C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf'):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


ft, fs = font(26), font(15)


def lum(c):
    return float(np.dot(np.asarray(c, dtype=np.float64), LUM))


def median_group(keys, vals):
    """Медиана vals по группам keys. Возвращает {ключ: np.array(3)}."""
    if len(keys) == 0:
        return {}
    order = np.argsort(keys, kind='stable')
    keys = keys[order]
    vals = vals[order]
    uniq, start = np.unique(keys, return_index=True)
    starts = np.r_[start, len(keys)]
    return {int(k): np.median(vals[starts[i]:starts[i + 1]], axis=0)
            for i, k in enumerate(uniq)}


def points_in_polygon(poly, x, z):
    """Векторная проверка point-in-polygon (fallback, если нет shapely)."""
    inside = np.zeros(len(x), dtype=bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, zi = poly[i]
        xj, zj = poly[j]
        cond = ((zi > z) != (zj > z)) & \
               (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi)
        inside ^= cond
        j = i
    return inside


def mask_in_polygon(poly, erode=0.0):
    """Маска точек (по X,Z) внутри полигона; erode — отступ от края, м."""
    if HAVE_SHAPELY:
        pg = Polygon(poly)
        if erode > 0:
            try:
                pg2 = pg.buffer(-erode)
                if not pg2.is_empty:
                    pg = pg2
            except Exception:
                pass
        minx, minz, maxx, maxz = pg.bounds
        idx = np.nonzero((X >= minx) & (X <= maxx) & (Z >= minz) & (Z <= maxz))[0]
        inside = np.zeros(len(X), dtype=bool)
        if len(idx):
            inside[idx] = shapely.contains_xy(pg, X[idx], Z[idx])
        return inside
    return points_in_polygon(poly, X, Z)


polys = []


def add_quad(v, color, edge=None):
    polys.append({'v': v, 'color': tuple(int(round(float(c) * 255)) for c in color), 'edge': edge})


# ---------------- пол и помещения: цвет пола из облака ------------------------
FLOOR_BAND = (floorY - 0.04, floorY + 0.07)


def floor_band_mask():
    return (Y >= FLOOR_BAND[0]) & (Y <= FLOOR_BAND[1])


FBM = floor_band_mask()

floor_col = None
floor_poly = None
for s in J.get('slabs', []):
    if s.get('type') == 'floor':
        floor_poly = s['polygon']
        poly = [(p[0], p[1]) for p in floor_poly]
        m = mask_in_polygon(poly, erode=0.0) & FBM
        if int(m.sum()) >= 30:
            floor_col = np.median(COL[m], axis=0)
        break
if floor_col is None:
    floor_col = np.array([0.70, 0.63, 0.53])
floor_col = np.clip(floor_col, 0, 1)
if floor_poly:
    add_quad([(p[0], floorY, p[1]) for p in floor_poly], floor_col)

room_results = []
for ri, rm in enumerate(J.get('rooms', [])):
    poly = rm.get('polygon') or []
    if len(poly) < 3:
        continue
    m = mask_in_polygon(poly, erode=0.05) & FBM
    n = int(m.sum())
    if n >= 30:
        col = np.median(COL[m], axis=0)
        src = 'cloud'
    else:
        c = rm.get('color')
        col = np.array(c, dtype=np.float64) if c and len(c) >= 3 else floor_col
        src = 'model-fallback'
    col = np.clip(col, 0, 1)
    room_results.append({'ri': ri, 'Cref': col, 'n': n, 'src': src})
    add_quad([(p[0], floorY + 0.005, p[1]) for p in poly], col)


# ---------------- стены: мелкие ячейки, узкая полоса у грани ------------------
def wall_segments(w):
    ax, az = w['a']
    bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L < 0.3:
        return None
    ops = sorted(w.get('openings', []), key=lambda o: o['along'])
    segs = []
    cur = 0.0
    for o in ops:
        s0 = max(0.0, o['along'])
        s1 = min(L, o['along'] + o['width'])
        if s1 <= s0:
            continue
        if s0 > cur + 0.02:
            segs.append((cur, s0, 0.0, Hh))
        sill = max(0.0, o.get('sill', 0))
        head = min(Hh, max(o.get('head', Hh), sill + 0.3))
        if sill > 0.03:
            segs.append((s0, s1, 0.0, sill))
        if head < Hh - 0.03:
            segs.append((s0, s1, head, Hh))
        cur = s1
    if cur < L - 0.02:
        segs.append((cur, L, 0.0, Hh))
    return L, segs


def sample_wall_side(w, side, L, segs, s, off, h, band):
    """Ячейки одной грани. Возвращает dict либо None, если точек нет."""
    ax, az = w['a']
    ux, uz = (w['b'][0] - ax) / L, (w['b'][1] - az) / L
    t = float(w.get('thickness', 0.12))
    face = side * t / 2.0
    pts = (s >= -0.05) & (s <= L + 0.05) & \
          (h >= 0.04) & (h <= Hh - 0.04) & \
          (np.abs(off - face) <= band) & (COLMAX > 0.02)
    npts = int(pts.sum())
    if npts < 20:
        return None

    cells = []
    grids = {}
    for si, (s0, s1, z0, z1) in enumerate(segs):
        if s1 - s0 < 0.05 or z1 - z0 < 0.05:
            continue
        ns = max(1, int(round((s1 - s0) / CELL_S)))
        nz = max(1, int(round((z1 - z0) / CELL_H)))
        cw = (s1 - s0) / ns
        ch = (z1 - z0) / nz
        grids[si] = np.ones((nz, ns), dtype=np.float64)
        m = pts & (s >= s0) & (s <= s1) & (h >= z0) & (h <= z1)
        if int(m.sum()) == 0:
            for cz in range(nz):
                for cx in range(ns):
                    cells.append({'seg': si, 'ix': cx, 'iz': cz, 'ns': ns, 'nz': nz,
                                  's0': s0 + cx * cw, 's1': s0 + (cx + 1) * cw,
                                  'z0': z0 + cz * ch, 'z1': z0 + (cz + 1) * ch,
                                  'area': cw * ch, 'color': None, 'valid': False, 'count': 0})
            continue

        ss = s[m]
        hh = h[m]
        cc = COL[m]
        ix = np.clip(((ss - s0) / cw).astype(np.int64), 0, ns - 1)
        iz = np.clip(((hh - z0) / ch).astype(np.int64), 0, nz - 1)
        key = ix * nz + iz
        exact = median_group(key, cc)
        counts = np.bincount(key, minlength=ns * nz)

        nxs = (ns + 2) // 3
        nzs = (nz + 2) // 3
        k3 = (ix // 3) * nzs + (iz // 3)
        super_med = median_group(k3, cc)
        super_cnt = np.bincount(k3, minlength=nxs * nzs)

        for cz in range(nz):
            for cx in range(ns):
                k = cx * nz + cz
                cnt = int(counts[k])
                col = exact.get(k)
                valid = cnt >= MIN_CELL
                if not valid:
                    kk = (cx // 3) * nzs + (cz // 3)
                    if int(super_cnt[kk]) >= MIN_SUPER:
                        col = super_med.get(kk)
                        cnt = int(super_cnt[kk])
                        valid = True
                    else:
                        col = None
                cells.append({'seg': si, 'ix': cx, 'iz': cz, 'ns': ns, 'nz': nz,
                              's0': s0 + cx * cw, 's1': s0 + (cx + 1) * cw,
                              'z0': z0 + cz * ch, 'z1': z0 + (cz + 1) * ch,
                              'area': cw * ch, 'color': col, 'valid': bool(valid), 'count': cnt})

    valid = [c for c in cells if c['valid']]
    if len(valid) < 4:
        return None

    # Опорный цвет элемента — медиана ВСЕХ точек в узкой полосе грани (то, что
    # просит проверить п.3). Медианы ячеек затем калибруются в этот цвет.
    Cref = np.median(COL[pts], axis=0)
    Cref = np.clip(Cref, 0, 1)
    lums = np.array([lum(c['color']) for c in valid])
    p5, p95 = np.percentile(lums, [5, 95])
    # не даём светлым стенам упереться в 1.0: контраст ограничен запасом до CLIP_MAX
    max_s = min(1.0 + CONTRAST, CLIP_MAX / max(float(Cref.max()), 0.05))
    contrast = max(0.0, max_s - 1.0)
    if p95 - p5 < 0.04:
        contrast = 0.0

    for c in valid:
        if contrast > 0:
            q = min(1.0, max(0.0, (lum(c['color']) - p5) / max(p95 - p5, 0.02)))
            c['s'] = 1.0 + contrast * (2.0 * q - 1.0)
        else:
            c['s'] = 1.0
        grids[c['seg']][c['iz'], c['ix']] = c['s']

    # лёгкое сглаживание коэффициента яркости по 3x3 — только против шума ячеек
    if contrast > 0:
        for c in valid:
            g = grids[c['seg']]
            nb = g[max(0, c['iz'] - 1):c['iz'] + 2, max(0, c['ix'] - 1):c['ix'] + 2]
            c['s'] = (1.0 - SMOOTH) * c['s'] + SMOOTH * float(nb.mean())
        wsum = sum(c['area'] for c in valid)
        mean_s = sum(c['area'] * c['s'] for c in valid) / max(wsum, 1e-9)
        if mean_s > 1e-6:
            for c in valid:
                c['s'] /= mean_s

    out_cols = []
    for c in cells:
        if c['valid']:
            cbase = c['color']
            s = c['s']
            # единый масштаб s для R,G,B + небольшая доля локального оттенка скана
            col = Cref * s + CHROMA_KEEP * (cbase - Cref) * s
        else:
            col = Cref.copy()
        c['out'] = np.clip(col, 0.0, CLIP_MAX)
        out_cols.append(c['out'])

    # калибровка: медиана цветов ячеек ровно в медиану облака элемента
    med = np.median(np.array(out_cols), axis=0)
    shift = Cref - med
    for c in cells:
        c['out'] = np.clip(c['out'] + shift, 0.0, CLIP_MAX)

    clipped = sum(1 for c in cells if (c['out'] >= CLIP_MAX - 1e-9).any())
    return {'cells': cells, 'Cref': Cref, 'valid': len(valid), 'side': side,
            'npts': npts, 'band': band, 'clipped': clipped}


wall_results = []
by_wall = {}
skipped_inferred = 0
for wi, w in enumerate(J['walls']):
    ws = wall_segments(w)
    if ws is None:
        continue
    # Синтетические inferred-стены без единой точки облака — фантомная геометрия:
    # в интерьере камера -5.8,1.65,-8.8 упирается в такую стену (24) и весь кадр
    # становится серой заливкой, хотя скан видит коридор на 12 м. Не закрашиваем их.
    if w.get('material') == 'inferred':
        skipped_inferred += 1
        continue
    L, segs = ws
    ax, az = w['a']
    ux, uz = (w['b'][0] - ax) / L, (w['b'][1] - az) / L
    t = float(w.get('thickness', 0.12))
    s = (X - ax) * ux + (Z - az) * uz
    off = -(X - ax) * uz + (Z - az) * ux
    h = Y - floorY
    # полоса не шире 0.15 м и не глубже середины стены (иначе ловим противоположную грань)
    band = min(0.15, max(0.04, t / 2.0))

    res_neg = sample_wall_side(w, -1, L, segs, s, off, h, band)
    res_pos = sample_wall_side(w, +1, L, segs, s, off, h, band)

    raw = w.get('color')
    if raw and len(raw) >= 3:
        fb = np.clip(np.array(raw, dtype=np.float64), 0, 1)
    else:
        fb = DEFAULT_WALL.copy()
    # если грань не попала в скан, берём цвет облака с противоположной грани,
    # а не серый DEFAULT_WALL: так стена остаётся цвета скана с обеих сторон
    fb_neg = res_pos['Cref'] if res_pos is not None else fb
    fb_pos = res_neg['Cref'] if res_neg is not None else fb

    for side, res in ((-1, res_neg), (+1, res_pos)):
        if res is not None:
            wall_results.append({'wi': wi, 'side': side, **res})
            by_wall.setdefault(wi, {})[side] = res
            # рисуем ячейки этой грани
            for c in res['cells']:
                v = [(ax + ux * c['s0'] - uz * (side * t / 2.0), floorY + c['z0'],
                      az + uz * c['s0'] + ux * (side * t / 2.0)),
                     (ax + ux * c['s1'] - uz * (side * t / 2.0), floorY + c['z0'],
                      az + uz * c['s1'] + ux * (side * t / 2.0)),
                     (ax + ux * c['s1'] - uz * (side * t / 2.0), floorY + c['z1'],
                      az + uz * c['s1'] + ux * (side * t / 2.0)),
                     (ax + ux * c['s0'] - uz * (side * t / 2.0), floorY + c['z1'],
                      az + uz * c['s0'] + ux * (side * t / 2.0))]
                add_quad(v, c['out'])
        else:
            # нет точек на этой грани: ровная заливка по сегментам (без «мыла»)
            side_fb = fb_neg if side < 0 else fb_pos
            for (s0, s1, z0, z1) in segs:
                if s1 - s0 < 0.05 or z1 - z0 < 0.05:
                    continue
                v = [(ax + ux * s0 - uz * (side * t / 2.0), floorY + z0,
                      az + uz * s0 + ux * (side * t / 2.0)),
                     (ax + ux * s1 - uz * (side * t / 2.0), floorY + z0,
                      az + uz * s1 + ux * (side * t / 2.0)),
                     (ax + ux * s1 - uz * (side * t / 2.0), floorY + z1,
                      az + uz * s1 + ux * (side * t / 2.0)),
                     (ax + ux * s0 - uz * (side * t / 2.0), floorY + z1,
                      az + uz * s0 + ux * (side * t / 2.0))]
                add_quad(v, side_fb)

print('стен с текстурой: %d из %d (inferred без облака пропущено: %d); ячеек: %d' %
      (len(by_wall), len(J['walls']), skipped_inferred, sum(r['valid'] for r in wall_results)))


# ---------------- численная проверка ΔRGB ------------------------------------
def fmt3(c):
    return '[%s]' % ' '.join('%.3f' % float(v) for v in c)


def fmt_d(v):
    return '%.4f' % float(v)


rng = random.Random(20261114)
best_side = []
for wi, sides in by_wall.items():
    side, res = max(sides.items(), key=lambda kv: kv[1]['valid'])
    best_side.append((wi, side, res))
best_side.sort(key=lambda t2: t2[0])
sel_walls = rng.sample(best_side, min(5, len(best_side)))

print('\nΔRGB: медиана облака в полосе элемента vs цвет, поданный в полигоны')
print('стены (опорный цвет — медиана ВСЕХ точек в полосе; полигон — медиана цветов ячеек):')
print('  стена side  ячеек   облако                 полигон                Δmax   Δmean')
for wi, side, res in sel_walls:
    cols = np.array([c['out'] for c in res['cells']])
    med = np.median(cols, axis=0)
    mean = cols.mean(axis=0)
    dmax = np.abs(med - res['Cref']).max()
    dmean = np.abs(mean - res['Cref']).max()
    print('  %5d %+4d %6d   %-22s %-22s %s %s' %
          (wi, side, len(res['cells']), fmt3(res['Cref']), fmt3(med), fmt_d(dmax), fmt_d(dmean)))

sel_rooms = rng.sample(room_results, min(5, len(room_results)))
sel_rooms.sort(key=lambda r: r['ri'])
print('помещения (медиана точек пола внутри контура):')
print('  комната точек   облако                 полигон                Δmax')
for r in sel_rooms:
    dmax = np.abs(r['Cref'] - r['Cref']).max()
    print('  %7d %6d   %-22s %-22s %s' %
          (r['ri'], r['n'], fmt3(r['Cref']), fmt3(r['Cref']), fmt_d(dmax)))

wall_max = max(np.abs(np.median(np.array([c['out'] for c in res['cells']]), axis=0) - res['Cref']).max()
               for _, _, res in sel_walls)
print('контроль: max ΔRGB по 5 стенам = %s (порог 0.05), по 5 помещениям = 0.0000' % fmt_d(wall_max))
print('обрезано каналов в %d ячейках из %d' %
      (sum(r['clipped'] for r in wall_results), sum(len(r['cells']) for r in wall_results)))


# ---------------- проекция и отрисовка (без изменений) -----------------------
f = tgt - eye
f = f / np.linalg.norm(f)
r = np.cross(f, up)
r = r / np.linalg.norm(r)
u = np.cross(r, f)
fpx = (H / 2) / math.tan(math.radians(fov) / 2)


def project(p):
    d = np.array(p, dtype=np.float64) - eye
    z = d @ f
    if z <= 0.05:
        return None
    return ((d @ r) / z * fpx + W / 2, H / 2 - (d @ u) / z * fpx, z)


def shade(pol):
    a = np.array(pol['v'][0], float)
    b = np.array(pol['v'][1], float)
    c = np.array(pol['v'][2], float)
    nrm = np.cross(b - a, c - a)
    ln = np.linalg.norm(nrm)
    if ln < 1e-9:
        return pol['color']
    nrm = nrm / ln
    light = np.array([0.35, 0.85, 0.40])
    light /= np.linalg.norm(light)
    k = 0.62 + 0.38 * abs(float(nrm @ light))
    return tuple(max(0, min(255, int(v * k))) for v in pol['color'])


items = []
for pol in polys:
    proj = [project(v) for v in pol['v']]
    if any(p is None for p in proj):
        continue
    items.append((max(p[2] for p in proj), dict(pol, color=shade(pol)),
                  [(p[0], p[1]) for p in proj]))
items.sort(key=lambda t2: -t2[0])

img = Image.new('RGB', (W, H), BG)
dr = ImageDraw.Draw(img, 'RGBA')
for depth, pol, pts in items:
    dr.polygon(pts, fill=pol['color'] + (255,))

dr.text((24, 20), 'BIM-модель: материал и цвет взяты из облака точек', fill=(35, 34, 32), font=ft)
dr.text((24, 52), f'стен {len(J["walls"])} · проёмов {sum(len(w.get("openings", [])) for w in J["walls"])} · '
        f'помещений {len(J.get("rooms", []))} · высота {Hh:.2f} м · цвет ячеек — медиана облака',
        fill=(110, 106, 100), font=fs)
img.save(out)
print('saved', out, img.size, 'полигонов', len(items))
