# -*- coding: utf-8 -*-
"""Текстурный рендер BIM-модели: цвет каждой грани стены берётся из облака (сетка 4×6 на грань).
   python render-textured.py details.json local-rgb.bin out.png eye=.. target=.. fov=.. size=..
"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

J = json.load(open(sys.argv[1], encoding='utf-8-sig'))
bin_path = sys.argv[2]
out = sys.argv[3]
args = dict(a.split('=') for a in sys.argv[4:])
eye = np.array([float(v) for v in args.get('eye', '16,13,17').split(',')])
tgt = np.array([float(v) for v in args.get('target', '0,1.4,0').split(',')])
fov = float(args.get('fov', 50))
W, H = [int(v) for v in args.get('size', '1600x1000').split('x')]
up = np.array([0.0, 0.0, 1.0]) if args.get('up') == 'z' else np.array([0.0, 1.0, 0.0])
bright = float(args.get('bright', 1.55))

P = np.fromfile(bin_path, dtype=np.float32).reshape(-1, 6)
PC = P[:, :3].astype(np.float32)
PCOL = np.clip(P[:, 3:6] * bright, 0, 1)
print('точек', len(P))

st = J['storey']
floorY, ceilY = st['floorY'], st['ceilY']
wallH = ceilY - floorY

BG = (247, 245, 239)
WALL_EDGE = (98, 76, 186)
FLOOR = (232, 228, 218)
ROOM = (238, 234, 224)
DEFAULT_WALL = np.array([0.70, 0.66, 0.60])


def font(size):
    for p in ('C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf'):
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()


ft, fs = font(26), font(15)


def sample_color(center, radius=0.22):
    d = PC - np.array(center, dtype=np.float32)
    m = (np.abs(d[:, 0]) <= radius) & (np.abs(d[:, 1]) <= radius) & (np.abs(d[:, 2]) <= radius)
    n = int(m.sum())
    if n < 6: return None
    return np.median(PCOL[m], axis=0)


def add_quad(polys, v, color, edge=None):
    polys.append({'v': v, 'color': tuple(int(round(c * 255)) for c in color), 'edge': edge})


polys = []
# пол
xs = [w['a'][0] for w in J['walls']] + [w['b'][0] for w in J['walls']]
zs = [w['a'][1] for w in J['walls']] + [w['b'][1] for w in J['walls']]
minx, maxx, minz, maxz = min(xs) - 0.3, max(xs) + 0.3, min(zs) - 0.3, max(zs) + 0.3
add_quad(polys, [(minx, floorY, minz), (maxx, floorY, minz), (maxx, floorY, maxz), (minx, floorY, maxz)], np.array(FLOOR) / 255 * 1.0)

# стены: разбиваем по проёмам и по сетке 4×6 на грани, цвет каждой ячейки — из облака
for w in J['walls']:
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L < 0.3: continue
    ux, uz = (bx - ax) / L, (bz - az) / L
    d = w.get('thickness', 0.15)
    wall_rgb = np.array(w.get('color') or DEFAULT_WALL, dtype=float)
    ops = sorted(w.get('openings', []), key=lambda o: o['along'])
    segs = []
    cur = 0.0
    for o in ops:
        s0 = max(0.0, o['along']); s1 = min(L, o['along'] + o['width'])
        if s1 <= s0: continue
        if s0 > cur + 0.02: segs.append((cur, s0, 0, wallH))
        sill = max(0.0, o.get('sill', 0)); head = min(wallH, max(o.get('head', wallH), sill + 0.3))
        if sill > 0.03: segs.append((s0, s1, 0, sill))
        if head < wallH - 0.03: segs.append((s0, s1, head, wallH))
        cur = s1
    if cur < L - 0.02: segs.append((cur, L, 0, wallH))
    cs, sn = math.cos(math.atan2(uz, ux)), math.sin(math.atan2(uz, ux))

    def world(s, t, z):
        # s вдоль стены, t поперёк (смещение от оси), z — высота над полом
        return (ax + ux * s - sn * t, floorY + z, az + uz * s + cs * t)

    for (s0, s1, z0, z1) in segs:
        if s1 - s0 < 0.05 or z1 - z0 < 0.05: continue
        ns = max(2, min(10, int(round((s1 - s0) / 0.45))))
        nz = max(2, min(6, int(round((z1 - z0) / 0.55))))
        for isx in range(ns):
            for izx in range(nz):
                sa = s0 + (s1 - s0) * isx / ns; sb = s0 + (s1 - s0) * (isx + 1) / ns
                za = z0 + (z1 - z0) * izx / nz; zb = z0 + (z1 - z0) * (izx + 1) / nz
                cx = ax + ux * (sa + sb) / 2; cz = az + uz * (sa + sb) / 2
                col = sample_color((cx, floorY + (za + zb) / 2, cz))
                if col is None: col = wall_rgb
                else:
                    lum = max(0.06, float(np.mean(col)))
                    col = np.clip(col * (0.62 / lum), 0.10, 0.95)
                for side in (-1, 1):
                    t = side * d / 2
                    quad = [world(sa, t, za), world(sb, t, za), world(sb, t, zb), world(sa, t, zb)]
                    add_quad(polys, quad, col)

# трубы: цвет из облака, 8-угольное сечение
for p in J['pipes']:
    ax, az = p['a']; bx, bz = p['b']
    y = p.get('y', ceilY - 0.3)
    dia = max(0.03, (p.get('diameterMm') or 100) / 1000.0)
    L = math.hypot(bx - ax, bz - az)
    if L < 0.1: continue
    ux, uz = (bx - ax) / L, (bz - az) / L
    nx, nz = -uz, ux
    r = dia / 2
    col = sample_color(((ax + bx) / 2, y, (az + bz) / 2), radius=0.18)
    if col is None: col = np.array(p.get('color') or [0.45, 0.40, 0.48])
    steps = max(1, int(L / 3.0))
    sides = 8
    for i in range(steps):
        s0 = L * i / steps; s1 = L * (i + 1) / steps
        for sd in range(sides):
            a0 = 2 * math.pi * sd / sides; a1 = 2 * math.pi * (sd + 1) / sides
            def pt(s, ang):
                return (ax + ux * s + nx * r * math.cos(ang), y + r * math.sin(ang), az + uz * s + nz * r * math.cos(ang))
            quad = [pt(s0, a0), pt(s1, a0), pt(s1, a1), pt(s0, a1)]
            k = 0.72 + 0.28 * max(0.0, math.sin((a0 + a1) / 2))
            add_quad(polys, quad, col * k)

# объекты/колонны
for o in J.get('objects', []):
    cx, cy, cz = o.get('cx', 0), o.get('cy', floorY + 1.5), o.get('cz', 0)
    hx, hy, hz = max(0.05, o.get('hx', 0.2)), max(0.05, o.get('hy', 0.5)), max(0.05, o.get('hz', 0.2))
    col = np.array(o.get('color') or [0.55, 0.52, 0.48])
    xs2 = [cx - hx, cx + hx]; ys2 = [floorY, floorY + wallH]; zs2 = [cz - hz, cz + hz]
    V = {}
    for i in (0, 1):
        for j in (0, 1):
            for k in (0, 1):
                V[(i, j, k)] = (xs2[i], ys2[j], zs2[k])
    faces = [[(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)], [(0, 1, 0), (1, 1, 0), (1, 1, 1), (0, 1, 1)],
             [(0, 0, 0), (0, 1, 0), (0, 1, 1), (0, 0, 1)], [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)],
             [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]]
    for f in faces:
        add_quad(polys, [V[i] for i in f], col)

# ---------- проекция ----------
f = tgt - eye; f = f / np.linalg.norm(f)
r = np.cross(f, up); r = r / np.linalg.norm(r)
u = np.cross(r, f)
fpx = (H / 2) / math.tan(math.radians(fov) / 2)


def project(p):
    d = np.array(p, dtype=np.float64) - eye
    z = d @ f
    if z <= 0.05: return None
    return ((d @ r) / z * fpx + W / 2, H / 2 - (d @ u) / z * fpx, z)


def shade(pol):
    a = np.array(pol['v'][0], float); b = np.array(pol['v'][1], float); c = np.array(pol['v'][2], float)
    nrm = np.cross(b - a, c - a)
    ln = np.linalg.norm(nrm)
    if ln < 1e-9: return pol['color']
    nrm = nrm / ln
    light = np.array([0.35, 0.85, 0.40]); light /= np.linalg.norm(light)
    k = 0.62 + 0.38 * abs(float(nrm @ light))
    return tuple(max(0, min(255, int(v * k))) for v in pol['color'])


items = []
for pol in polys:
    proj = [project(v) for v in pol['v']]
    if any(p is None for p in proj): continue
    items.append((max(p[2] for p in proj), dict(pol, color=shade(pol)), [(p[0], p[1]) for p in proj]))
items.sort(key=lambda t: -t[0])

img = Image.new('RGB', (W, H), BG)
dr = ImageDraw.Draw(img, 'RGBA')
for depth, pol, pts in items:
    dr.polygon(pts, fill=pol['color'] + (255,))
    if pol.get('edge'):
        dr.line(pts + [pts[0]], fill=pol['edge'] + (255,), width=1)

dr.text((24, 20), 'BIM-модель из облака точек — цвет и фактура перенесены из скана', fill=(35, 34, 32), font=ft)
dr.text((24, 52), f'стен {len(J["walls"])} · проёмов {sum(len(w.get("openings", [])) for w in J["walls"])} · '
        f'труб {len(J["pipes"])} · высота {wallH:.2f} м · цвет граней — медиана точек облака',
        fill=(110, 106, 100), font=fs)
img.save(out)
print('saved', out, img.size, 'полигонов', len(items))
