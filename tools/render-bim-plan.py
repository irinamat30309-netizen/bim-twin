# -*- coding: utf-8 -*-
"""2D-план BIM-модели (как чертёж): помещения, стены с проёмами, трубы, подписи размеров."""
import json, math, sys
from PIL import Image, ImageDraw, ImageFont

J = json.load(open(sys.argv[1], encoding='utf-8-sig'))
out = sys.argv[2]
W, H = 1600, 1100

BG = (250, 249, 245)
WALL = (52, 50, 47)
WALLF = (225, 221, 212)
ROOMF = (242, 239, 231)
ROOML = (196, 190, 180)
PIPE = (122, 92, 210)
DOOR = (176, 150, 232)

walls = J['walls']
xs = [w['a'][0] for w in walls] + [w['b'][0] for w in walls]
zs = [w['a'][1] for w in walls] + [w['b'][1] for w in walls]
for r in J.get('rooms', []):
    for pt in (r.get('polygon') or []):
        xs.append(pt[0]); zs.append(pt[1])
for pp in J.get('pipes', []):
    xs += [pp['a'][0], pp['b'][0]]; zs += [pp['a'][1], pp['b'][1]]
minx, maxx = min(xs), max(xs)
minz, maxz = min(zs), max(zs)
pad = 1.2
minx -= pad; maxx += pad; minz -= pad; maxz += pad
scale = min((W - 200) / (maxx - minx), (H - 240) / (maxz - minz))


def X(x): return 100 + (x - minx) * scale
def Z(z): return H - 120 - (z - minz) * scale


def font(size):
    for p in ('C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf'):
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()


ft, fs, fx = font(26), font(16), font(13)
img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img, 'RGBA')

# помещения
for r in J.get('rooms', []):
    poly = r.get('polygon') or []
    if len(poly) < 3: continue
    pts = [(X(p[0]), Z(p[1])) for p in poly]
    d.polygon(pts, fill=ROOMF + (255,), outline=ROOML + (255,))

# стены с проёмами: разбиваем на сплошные куски
for w in walls:
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L < 0.3: continue
    ux, uz = (bx - ax) / L, (bz - az) / L
    t = w.get('thickness', 0.15)
    th = max(3, t * scale)
    ops = sorted(w.get('openings', []), key=lambda o: o['along'])
    cur = 0.0
    segs = []
    for o in ops:
        s0 = max(0.0, o['along']); s1 = min(L, o['along'] + o['width'])
        if s1 <= s0: continue
        if s0 > cur + 0.02: segs.append((cur, s0))
        cur = s1
    if cur < L - 0.02: segs.append((cur, L))
    for (s0, s1) in segs:
        x0 = X(ax + ux * s0); z0 = Z(az + uz * s0)
        x1 = X(ax + ux * s1); z1 = Z(az + uz * s1)
        d.line([(x0, z0), (x1, z1)], fill=WALL + (255,), width=int(th))
    # створки дверей — тонкие линии поперёк проёма
    for o in ops:
        s0 = max(0.0, o['along']); s1 = min(L, o['along'] + o['width'])
        if s1 - s0 < 0.2: continue
        x0 = X(ax + ux * s0); z0 = Z(az + uz * s0)
        x1 = X(ax + ux * s1); z1 = Z(az + uz * s1)
        d.line([(x0, z0), (x1, z1)], fill=DOOR + (200,), width=2)

# трубы
for p in J.get('pipes', []):
    ax, az = p['a']; bx, bz = p['b']
    d.line([(X(ax), Z(az)), (X(bx), Z(bz))], fill=PIPE + (190,), width=3)
    mx, mz = (ax + bx) / 2, (az + bz) / 2
    if math.hypot(bx - ax, bz - az) > 3:
        d.text((X(mx) + 3, Z(mz) - 12), 'DN' + str(int(p.get('diameterMm') or 0)), fill=(110, 82, 190), font=fx)

# колонны
for o in J.get('objects', []):
    if 'column' not in (o.get('kind') or '').lower() and 'колон' not in (o.get('kind') or '').lower(): continue
    cx, cz = o.get('cx', 0), o.get('cz', 0)
    hx = max(0.12, o.get('hx', 0.2)); hz = max(0.12, o.get('hz', 0.2))
    d.rectangle([X(cx - hx), Z(cz + hz), X(cx + hx), Z(cz - hz)], fill=(200, 195, 186, 255), outline=WALL + (255,), width=2)

# подписи
d.text((40, 26), 'План BIM-модели — интерьер с трубами (по облаку точек)', fill=(35, 34, 32), font=ft)
st = J['storey']
nops = sum(len(w.get('openings', [])) for w in walls)
area = sum((r.get('area') or 0) for r in J.get('rooms', []))
d.text((40, 60), f'стен {len(walls)} · проёмов {nops} · труб {len(J.get("pipes", []))} · '
       f'высота {st["height"]:.2f} м · помещения {area:.1f} м² · план {maxx-minx:.1f}×{maxz-minz:.1f} м',
       fill=(110, 106, 100), font=fs)
# линейка
rx0, rx1 = 100, W - 100
d.line([(rx0, H - 60), (rx1, H - 60)], fill=(120, 116, 110), width=2)
d.text((rx0, H - 50), 'масштаб: 5 м', fill=(120, 116, 110), font=fx)
d.line([(rx0, H - 66), (rx0, H - 54)], fill=(120, 116, 110), width=2)
d.line([(rx0 + 5 * scale, H - 66), (rx0 + 5 * scale, H - 54)], fill=(120, 116, 110), width=2)
img.save(out)
print('saved', out, img.size)
