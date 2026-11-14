# -*- coding: utf-8 -*-
"""Текстурный рендер модели scan2bim v2: цвет каждой ячейки грани стены — медиана точек облака.
   python render-textured2.py model.json local-rgb.bin out.png eye=x,y,z target=x,y,z fov=.. size=..
"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

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
print('точек облака:', len(P))

st = J['storey']
floorY, ceilY = st['floorY'], st['ceilY']
Hh = ceilY - floorY
DEFAULT_WALL = np.array([0.62, 0.58, 0.53])
BG = (247, 245, 239)


def font(size):
    for p in ('C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf'):
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()


ft, fs = font(26), font(15)


def brighten(c, target=0.56):
    lum = max(0.05, float(np.mean(c)))
    base = np.asarray(c, float) * (target / lum)
    grey = float(np.mean(base))
    base = 0.72 * base + 0.28 * grey          # немного убираем цветовой перекос сканера
    return np.clip(base, 0.10, 0.95)


def sample_color(center, radius=0.20):
    m = (np.abs(PC[:, 0] - center[0]) <= radius) & (np.abs(PC[:, 1] - center[1]) <= radius) & \
        (np.abs(PC[:, 2] - center[2]) <= radius)
    if m.sum() < 6:
        return None
    return np.median(COL[m], axis=0)


polys = []


def add_quad(v, color, edge=None):
    polys.append({'v': v, 'color': tuple(int(round(c * 255)) for c in color), 'edge': edge})


# пол — из плиты модели, цвет из облака
floor_col = None
for s in J.get('slabs', []):
    if s.get('type') == 'floor':
        c = sample_color((np.mean([p[0] for p in s['polygon']]), floorY + 0.05,
                          np.mean([p[1] for p in s['polygon']])), radius=0.5)
        floor_col = brighten(c) if c is not None else np.array([0.80, 0.76, 0.68])
        poly = [(p[0], floorY, p[1]) for p in s['polygon']]
        add_quad(poly, floor_col)
        break
if floor_col is None:
    floor_col = np.array([0.80, 0.76, 0.68])

# помещения: цветное покрытие пола из облака
for rm in J.get('rooms', []):
    poly = rm.get('polygon') or []
    if len(poly) < 3:
        continue
    c = rm.get('color')
    col = brighten(c) * 0.98 if c and len(c) >= 3 else floor_col
    add_quad([(p[0], floorY + 0.005, p[1]) for p in poly], col)

# стены: разбиваем по проёмам, внутри грани — сетка с цветом из облака
for w in J['walls']:
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L < 0.3:
        continue
    ux, uz = (bx - ax) / L, (bz - az) / L
    t = float(w.get('thickness', 0.12))
    wall_col = brighten(w.get('color') or DEFAULT_WALL)
    if w.get('material') == 'inferred':
        wall_col = np.array([0.72, 0.71, 0.68])
    ops = sorted(w.get('openings', []), key=lambda o: o['along'])
    segs = []
    cur = 0.0
    for o in ops:
        s0 = max(0.0, o['along']); s1 = min(L, o['along'] + o['width'])
        if s1 <= s0:
            continue
        if s0 > cur + 0.02:
            segs.append((cur, s0, 0.0, Hh))
        sill = max(0.0, o.get('sill', 0)); head = min(Hh, max(o.get('head', Hh), sill + 0.3))
        if sill > 0.03:
            segs.append((s0, s1, 0.0, sill))
        if head < Hh - 0.03:
            segs.append((s0, s1, head, Hh))
        cur = s1
    if cur < L - 0.02:
        segs.append((cur, L, 0.0, Hh))
    cs, sn = math.cos(math.atan2(uz, ux)), math.sin(math.atan2(uz, ux))

    def world(s, off, z):
        return (ax + ux * s - sn * off, floorY + z, az + uz * s + cs * off)

    for (s0, s1, z0, z1) in segs:
        if s1 - s0 < 0.05 or z1 - z0 < 0.05:
            continue
        ns = max(2, min(14, int(round((s1 - s0) / 0.35))))
        nz = max(2, min(8, int(round((z1 - z0) / 0.5))))
        for isx in range(ns):
            for izx in range(nz):
                sa = s0 + (s1 - s0) * isx / ns; sb = s0 + (s1 - s0) * (isx + 1) / ns
                za = z0 + (z1 - z0) * izx / nz; zb = z0 + (z1 - z0) * (izx + 1) / nz
                cx = ax + ux * (sa + sb) / 2; cz = az + uz * (sa + sb) / 2
                c = sample_color((cx, floorY + (za + zb) / 2, cz), radius=0.18)
                col = brighten(c) if c is not None else wall_col
                for side in (-1, 1):
                    off = side * t / 2
                    add_quad([world(sa, off, za), world(sb, off, za), world(sb, off, zb), world(sa, off, zb)], col)

# ---------- проекция ----------
f = tgt - eye; f = f / np.linalg.norm(f)
r = np.cross(f, up); r = r / np.linalg.norm(r)
u = np.cross(r, f)
fpx = (H / 2) / math.tan(math.radians(fov) / 2)


def project(p):
    d = np.array(p, dtype=np.float64) - eye
    z = d @ f
    if z <= 0.05:
        return None
    return ((d @ r) / z * fpx + W / 2, H / 2 - (d @ u) / z * fpx, z)


def shade(pol):
    a = np.array(pol['v'][0], float); b = np.array(pol['v'][1], float); c = np.array(pol['v'][2], float)
    nrm = np.cross(b - a, c - a)
    ln = np.linalg.norm(nrm)
    if ln < 1e-9:
        return pol['color']
    nrm = nrm / ln
    light = np.array([0.35, 0.85, 0.40]); light /= np.linalg.norm(light)
    k = 0.62 + 0.38 * abs(float(nrm @ light))
    return tuple(max(0, min(255, int(v * k))) for v in pol['color'])


items = []
for pol in polys:
    proj = [project(v) for v in pol['v']]
    if any(p is None for p in proj):
        continue
    items.append((max(p[2] for p in proj), dict(pol, color=shade(pol)), [(p[0], p[1]) for p in proj]))
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
