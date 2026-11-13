# -*- coding: utf-8 -*-
"""Скриншоты готовой BIM-модели: стены с проёмами, пол, трубы, колонны, помещения.
   Рисуем полигоны в перспективе (алгоритм художника) в палитре проекта.
   python render-ifc.py details.json out.png eye=x,y,z target=x,y,z fov=55 size=1600x1000
"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

J = json.load(open(sys.argv[1], encoding='utf-8-sig'))
out = sys.argv[2]
args = dict(a.split('=') for a in sys.argv[3:])
eye = np.array([float(v) for v in args.get('eye', '18,14,20').split(',')])
tgt = np.array([float(v) for v in args.get('target', '0,1.5,0').split(',')])
fov = float(args.get('fov', 55))
W, H = [int(v) for v in args.get('size', '1600x1000').split('x')]
up = np.array([0.0, 0.0, 1.0]) if args.get('up') == 'z' else np.array([0.0, 1.0, 0.0])

st = J['storey']
floorY, ceilY = st['floorY'], st['ceilY']
wallH = ceilY - floorY

BG = (240, 238, 230)
WALL = (226, 223, 214)
WALL_EDGE = (106, 82, 203)
FLOOR = (232, 228, 218)
FLOOR_EDGE = (150, 146, 138)
PIPE = (150, 120, 220)
PIPE_HI = (176, 152, 236)
COL = (210, 205, 196)
ROOM = (236, 232, 222)


def font(size):
    for p in ('C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf'):
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()


ft, fs = font(26), font(16)


def box_faces(cx, cy, cz, hx, hy, hz):
    """6 граней параллелепипеда (центр, полуразмеры)."""
    xs, ys, zs = [cx - hx, cx + hx], [cy - hy, cy + hy], [cz - hz, cz + hz]
    V = [(xs[i], ys[j], zs[k]) for i in range(2) for j in range(2) for k in range(2)]
    def idx(a, b, c, d): return [V[a], V[b], V[c], V[d]]
    # индексы: (i,j,k) → 4*i+2*j+k
    return [
        idx(0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0),  # y-
        idx(4, 1, 5, 1, 6, 1, 7, 1, 0),           # y+
        idx(0, 0, 1, 0, 1, 1, 2, 1, 0),
        idx(3, 0, 2, 0, 0, 1, 1, 1, 0),
        idx(1, 0, 1, 0, 5, 0, 4, 0, 0),
        idx(0, 1, 0, 1, 2, 1, 3, 1, 0),
    ]


def add_box(polys, cx, cy, cz, hx, hy, hz, color, edge=None):
    xs, ys, zs = [cx - hx, cx + hx], [cy - hy, cy + hy], [cz - hz, cz + hz]
    def v(i, j, k): return (xs[i], ys[j], zs[k])
    faces = [
        [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
        [v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)],
        [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)],
        [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
        [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)],
        [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    ]
    for f in faces:
        polys.append({'v': f, 'color': color, 'edge': edge})


polys = []
# --- пол и потолок по контуру пола
floor = np.array([[J['walls'][0]['a'][0] if False else 0, 0]])
# контур пола: используем помещения, а если их нет — габарит стен
pts_all = []
for w in J['walls']:
    pts_all += [w['a'], w['b']]
xs = [p[0] for p in pts_all]; zs = [p[1] for p in pts_all]
minx, maxx, minz, maxz = min(xs) - 0.3, max(xs) + 0.3, min(zs) - 0.3, max(zs) + 0.3
add_box(polys, (minx + maxx) / 2, floorY - 0.08, (minz + maxz) / 2, (maxx - minx) / 2, 0.08, (maxz - minz) / 2, FLOOR, FLOOR_EDGE)
if not args.get('noceiling'):
    add_box(polys, (minx + maxx) / 2, ceilY + 0.08, (minz + maxz) / 2, (maxx - minx) / 2, 0.08, (maxz - minz) / 2, (214, 210, 200), FLOOR_EDGE)

# --- стены с проёмами: разбиваем по длине на сплошные куски и проёмы
for w in J['walls']:
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L < 0.3: continue
    ux, uz = (bx - ax) / L, (bz - az) / L
    d = w.get('thickness', 0.15)
    segs = []
    ops = sorted(w.get('openings', []), key=lambda o: o['along'])
    cur = 0.0
    for o in ops:
        s0 = max(0.0, o['along']); s1 = min(L, o['along'] + o['width'])
        if s1 <= s0: continue
        if s0 > cur + 0.02: segs.append((cur, s0, 0, wallH))
        sill = max(0.0, o.get('sill', 0)); head = min(wallH, max(o.get('head', wallH), sill + 0.3))
        if sill > 0.03: segs.append((s0, s1, 0, sill))               # подоконная часть
        if head < wallH - 0.03: segs.append((s0, s1, head, wallH))   # перемычка
        cur = s1
    if cur < L - 0.02: segs.append((cur, L, 0, wallH))
    for (s0, s1, z0, z1) in segs:
        if s1 - s0 < 0.02 or z1 - z0 < 0.02: continue
        cx = ax + ux * (s0 + s1) / 2; cz = az + uz * (s0 + s1) / 2
        ang = math.atan2(uz, ux)
        hx = (s1 - s0) / 2; hz = d / 2
        # повёрнутый параллелепипед
        cs, sn = math.cos(ang), math.sin(ang)
        cy = floorY + (z0 + z1) / 2; hy = (z1 - z0) / 2
        corners = [(-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)]
        def rot(u, v): return (cx + u * cs - v * sn, cz + u * sn + v * cs)
        Vb = [rot(u, v) for u, v in corners]
        low = [(x, floorY + z0, z) for (x, z) in Vb]
        high = [(x, floorY + z1, z) for (x, z) in Vb]
        faces = [[low[0], low[1], low[2], low[3]], [high[0], high[1], high[2], high[3]],
                 [low[0], low[1], high[1], high[0]], [low[1], low[2], high[2], high[1]],
                 [low[2], low[3], high[3], high[2]], [low[3], low[0], high[0], high[3]]]
        for f in faces:
            polys.append({'v': f, 'color': WALL, 'edge': WALL_EDGE})
    # створки дверей: полупрозрачная панель внутри проёма, чтобы двери читались на скриншоте
    for o in ops:
        sill = max(0.0, o.get('sill', 0)); head = min(wallH, max(o.get('head', wallH), sill + 0.3))
        if sill > 0.35: continue
        s0 = max(0.0, o['along']); s1 = min(L, o['along'] + o['width'])
        if s1 - s0 < 0.25: continue
        cx = ax + ux * (s0 + s1) / 2; cz = az + uz * (s0 + s1) / 2
        ang2 = math.atan2(uz, ux); cs2, sn2 = math.cos(ang2), math.sin(ang2)
        hx2 = (s1 - s0) / 2 - 0.02; hz2 = 0.015
        corners2 = [(-hx2, -hz2), (hx2, -hz2), (hx2, hz2), (-hx2, hz2)]
        def rot2(u, v): return (cx + u * cs2 - v * sn2, cz + u * sn2 + v * cs2)
        Vb2 = [rot2(u, v) for u, v in corners2]
        lowc = [(x, floorY + sill + 0.02, z) for (x, z) in Vb2]
        highc = [(x, floorY + head - 0.02, z) for (x, z) in Vb2]
        # только рамка двери по периметру, без сплошной панели
        for kk in range(4):
            a0 = lowc[kk]; a1 = lowc[(kk + 1) % 4]; b0 = highc[kk]; b1 = highc[(kk + 1) % 4]
            polys.append({'v': [a0, a1, b1, b0], 'color': (214, 204, 194), 'edge': (150, 130, 118)})

# --- трубы: отрезки с толщиной (квадратного сечения для простоты)
for p in J['pipes']:
    ax, az = p['a']; bx, bz = p['b']
    y = p.get('y', ceilY - 0.3); dia = max(0.03, (p.get('diameterMm') or 100) / 1000.0)
    L = math.hypot(bx - ax, bz - az)
    if L < 0.1: continue
    ux, uz = (bx - ax) / L, (bz - az) / L
    nx, nz = -uz, ux
    r = dia / 2
    def pt(s, n, dy):
        return ((ax + ux * s + nx * n), y + dy, (az + uz * s + nz * n))
    steps = max(1, int(L / 2.0))
    for i in range(steps):
        s0 = L * i / steps; s1 = L * (i + 1) / steps
        quad = [pt(s0, -r, -r), pt(s1, -r, -r), pt(s1, -r, r), pt(s0, -r, r)]
        quad2 = [pt(s0, r, -r), pt(s1, r, -r), pt(s1, r, r), pt(s0, r, r)]
        polys.append({'v': quad, 'color': PIPE, 'edge': None})
        polys.append({'v': quad2, 'color': PIPE_HI, 'edge': None})

# --- колонны и объекты
for o in J.get('objects', []):
    kind = (o.get('kind') or '').lower()
    if 'column' not in kind and 'колон' not in kind: continue
    cx, cy, cz = o.get('cx', 0), o.get('cy', floorY + 1.5), o.get('cz', 0)
    add_box(polys, cx, floorY + wallH / 2, cz, max(0.05, o.get('hx', 0.2)), wallH / 2, max(0.05, o.get('hz', 0.2)), COL, (140, 136, 128))

# --- помещения: тонкие плиты на полу
for r in J.get('rooms', []):
    poly = r.get('polygon') or []
    if len(poly) < 3: continue
    v = [(p[0], floorY + 0.012, p[1]) for p in poly]
    polys.append({'v': v, 'color': ROOM, 'edge': (188, 182, 170)})

# ---------- проекция ----------
f = tgt - eye; f = f / np.linalg.norm(f)
r = np.cross(f, up); r = r / np.linalg.norm(r)
u = np.cross(r, f)
fpx = (H / 2) / math.tan(math.radians(fov) / 2)


ORTHO = bool(args.get('ortho'))
OSCALE = float(args.get('oscale', 46))


def project(p):
    d = np.array(p, dtype=np.float64) - eye
    z = d @ f
    if ORTHO:
        x = (d @ r) * OSCALE + W / 2
        y = H / 2 - (d @ u) * OSCALE
        return (x, y, z)
    if z <= 0.05: return None
    x = (d @ r) / z * fpx + W / 2
    y = H / 2 - (d @ u) / z * fpx
    return (x, y, z)


def shade(pol):
    a = np.array(pol['v'][0], dtype=float); b = np.array(pol['v'][1], dtype=float); c = np.array(pol['v'][2], dtype=float)
    nrm = np.cross(b - a, c - a)
    ln = np.linalg.norm(nrm)
    if ln < 1e-9: return pol['color']
    nrm = nrm / ln
    light = np.array([0.35, 0.85, 0.40]); light = light / np.linalg.norm(light)
    k = 0.55 + 0.45 * abs(float(nrm @ light))
    return tuple(min(255, int(v * k)) for v in pol['color'])


items = []
planmode = bool(args.get('planmode'))
for pol in polys:
    if planmode:
        a0 = np.array(pol['v'][0], float); b0 = np.array(pol['v'][1], float); c0 = np.array(pol['v'][2], float)
        nrm0 = np.cross(b0 - a0, c0 - a0)
        ln0 = np.linalg.norm(nrm0)
        if ln0 < 1e-9 or abs(nrm0[1] / ln0) < 0.5:
            continue
    proj = [project(v) for v in pol['v']]
    if any(p is None for p in proj): continue
    depth = max(p[2] for p in proj)
    items.append((depth, dict(pol, color=shade(pol)), [(p[0], p[1]) for p in proj]))
items.sort(key=lambda t: -t[0])

img = Image.new('RGB', (W, H), BG)
dr = ImageDraw.Draw(img, 'RGBA')
for depth, pol, pts in items:
    dr.polygon(pts, fill=pol['color'] + (255,))
    if pol.get('edge'):
        dr.line(pts + [pts[0]], fill=pol['edge'] + (255,), width=2)

dr.text((24, 20), 'BIM-модель из облака точек — интерьер с трубами', fill=(35, 34, 32), font=ft)
dr.text((24, 54), f'стен {len(J["walls"])} · проёмов {sum(len(w.get("openings", [])) for w in J["walls"])} · труб {len(J["pipes"])} · '
        f'высота {wallH:.2f} м · площадь помещений {sum((r.get("area") or 0) for r in J.get("rooms", [])):.1f} м²', fill=(110, 106, 100), font=fs)
img.save(out)
print('saved', out, img.size)
