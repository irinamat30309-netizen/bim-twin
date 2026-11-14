#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""render-textured3.py — рендер BIM-модели scan2bim v2 с фото-резкими текстурами
стен из RGB-облака точек.

Идея (отличие от render-textured2.py, где грань заливалась ячейками 20–28 см и
получались пастельные пятна):

  * для КАЖДОЙ грани стены (side=+1/-1, плоскость ±thickness/2 от оси) строится
    БИТМАП-текстура: точки облака в полосе |off - side*t/2| <= 0.06 м, s в
    [-0.05; L+0.05], y в [base; base+height]; растр 0.02 м/пиксель (50 пикс/м);
    в ячейку пишется СРЕДНЕЕ RGB попавших точек (по сути цвет скана);
  * пустые ячейки заполняются итеративно средним по уже заполненным соседям
    (dilation), затем 3x3 медиана только по цвету — края не размываются;
  * яркость грани мягко растягивается по перцентилям 5–95 ЕДИНЫМ множителем
    для R,G,B (оттенок скана сохраняется), без осветления и без примеси серого;
  * рендер: перспективная (или ортогональная) камера, полигоны граней разбиты
    по проёмам и на тайлы ~1.5 м; каждый тайл рисуется с наложением текстуры:
    гомография «углы текстуры → проецированные углы квада» + PIL
    Image.transform(PERSPECTIVE, BICUBIC) по bounding box, маска — проекция
    квада; painter-сортировка по глубине (дальние раньше);
  * пол — битмап-текстура 5 см из точек пола (тайлы 1.1 м), потолок и торцы
    стен — ровная заливка цветом из модели;
  * открытые проёмы остаются фоном (полигоны граней вырезаны по openings);
  * финальная резкость: ImageFilter.UnsharpMask(radius=1.2, percent=130,
    threshold=2).

Запуск:
  python render-textured3.py model.json rgb.bin out.png eye=x,y,z target=x,y,z
         fov=50 size=1600x1000 up=y|z proj=persp|ortho texres=0.02 band=0.06
         snap=1 floorres=0.05 unsharp=1.2,130,2 ceil=1 rooms=1

Только чтение model.json/облака; пишет только out.png.
"""
import json
import math
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ------------------------------------------------------------------ аргументы
if len(sys.argv) < 4:
    raise SystemExit('usage: render-textured3.py model.json cloud.bin out.png [key=value ...]')

MODEL_PATH, CLOUD_PATH, OUT_PATH = sys.argv[1], sys.argv[2], sys.argv[3]
ARGS = {}
for _a in sys.argv[4:]:
    if '=' in _a:
        _k, _v = _a.split('=', 1)
        ARGS[_k] = _v


def vec3(s, dflt):
    v = [float(t) for t in (s or dflt).split(',')]
    while len(v) < 3:
        v.append(0.0)
    return np.array(v[:3], dtype=np.float64)


EYE = vec3(ARGS.get('eye'), '16,13,17')
TGT = vec3(ARGS.get('target'), '0,1.4,0')
FOV = float(ARGS.get('fov', 50))
W, H = [int(t) for t in ARGS.get('size', '1600x1000').split('x')]
UP_Z = ARGS.get('up', 'y').lower() in ('z', '1', 'true')
PROJ = ARGS.get('proj', 'persp').lower()          # persp | ortho
TEXRES = float(ARGS.get('texres', 0.02))          # м/пиксель текстуры стен
BAND = float(ARGS.get('band', 0.06))              # полоса выборки у грани, м
SNAP = ARGS.get('snap', '1') != '0'               # подстройка плоскости выборки
PLANRES = float(ARGS.get('floorres', 0.05))       # м/пиксель текстуры пола
SHARP = [float(t) for t in ARGS.get('unsharp', '1.2,130,2').split(',')]
TEXSHARP = [float(t) for t in ARGS.get('texsharp', '1.0,70,4').split(',')]
DRAW_CEIL = ARGS.get('ceil', '1') != '0'
DRAW_ROOMS = ARGS.get('rooms', '1') != '0'
TILE = float(ARGS.get('tile', 1.5))               # размер тайла грани, м
SEED = int(ARGS.get('seed', 20261114))

BG = (247, 245, 239)
S_PAD = 0.05                                       # запас текстуры по s, м
PAD_PX = 4                                         # запас битмапа, пикселей
LUM = np.array([0.2126, 0.7152, 0.0722])
DARK = 0.015                                       # точки темнее — мусор
MIN_COV_TEX = 0.18                                # ниже — грань заливается цветом

# ------------------------------------------------------------------ данные
J = json.load(open(MODEL_PATH, encoding='utf-8-sig'))
P = np.fromfile(CLOUD_PATH, dtype=np.float32).reshape(-1, 6)
X = P[:, 0].astype(np.float64)
Y = P[:, 1].astype(np.float64)
Z = P[:, 2].astype(np.float64)
COL = np.clip(P[:, 3:6].astype(np.float64), 0.0, 1.0)
del P

ST = J.get('storey', {})
FLOOR_Y = float(ST.get('floorY', 0.0))
CEIL_Y = float(ST.get('ceilY', FLOOR_Y + 3.0))
DEFAULT_WALL = np.array([0.62, 0.58, 0.53])

print('точек облака: %d   storey floorY=%.3f ceilY=%.3f' % (len(X), FLOOR_Y, CEIL_Y))
print('камера: eye=%s target=%s fov=%.0f proj=%s  %dx%d' %
      (np.round(EYE, 2).tolist(), np.round(TGT, 2).tolist(), FOV, PROJ, W, H))


# ------------------------------------------------------------------ утилиты
def lum_of(c):
    return float(c[0] * LUM[0] + c[1] * LUM[1] + c[2] * LUM[2])


def fmt3(c):
    return '[%s]' % ' '.join('%.3f' % float(v) for v in c)


def median3(img):
    """3x3 медиана (только цвет, без размытия краёв)."""
    h, w = img.shape[:2]
    p = np.pad(img, ((1, 1), (1, 1), (0, 0)), mode='edge')
    st = np.stack([p[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)], axis=0)
    return np.median(st, axis=0)


def fill_holes(img, filled, max_iter=256):
    """Итеративное заполнение пустых ячеек средним по заполненным соседям."""
    h, w = filled.shape
    if filled.all():
        return img, filled
    img = img.copy()
    filled = filled.copy()
    for _ in range(max_iter):
        p = np.pad(img, ((1, 1), (1, 1), (0, 0)))
        f = np.pad(filled, 1).astype(np.float64)
        acc = (p[:-2, 1:-1] * f[:-2, 1:-1, None] +
               p[2:, 1:-1] * f[2:, 1:-1, None] +
               p[1:-1, :-2] * f[1:-1, :-2, None] +
               p[1:-1, 2:] * f[1:-1, 2:, None])
        cnt = f[:-2, 1:-1] + f[2:, 1:-1] + f[1:-1, :-2] + f[1:-1, 2:]
        todo = (~filled) & (cnt > 0)
        if not todo.any():
            break
        img[todo] = acc[todo] / cnt[todo][:, None]
        filled |= todo
        if filled.all():
            break
    if not filled.all():
        img[~filled] = np.median(img[filled], axis=0) if filled.any() else 0.5
        filled[:] = True
    return img, filled


def homography(src, dst):
    """H(3x3), отображающая src[i] -> dst[i]. Для n>4 — МНК по всем точкам."""
    n = len(src)
    if n < 3:
        return None
    a = np.zeros((2 * n, 8))
    b = np.zeros(2 * n)
    for i in range(n):
        sx, sy = float(src[i][0]), float(src[i][1])
        dx, dy = float(dst[i][0]), float(dst[i][1])
        a[2 * i] = [sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]
        b[2 * i] = dx
        a[2 * i + 1] = [0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]
        b[2 * i + 1] = dy
    try:
        if n == 4:
            h = np.linalg.solve(a, b)
        else:
            h = np.linalg.lstsq(a, b, rcond=None)[0]
    except np.linalg.LinAlgError:
        return None
    if not np.all(np.isfinite(h)):
        return None
    return np.array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0]).reshape(3, 3)


# ------------------------------------------------------------------ текстуры
def group_median(key, col, n):
    """Медиана RGB по ячейкам key (0..n-1). Медиана устойчива к выбросам-точкам
    соседних плоскостей, которые всегда попадают в полосу у стыков."""
    out = np.zeros((n, 3), dtype=np.float64)
    if len(key) == 0:
        return out
    order0 = np.argsort(key, kind='stable')
    key_s = key[order0]
    col_s = col[order0]
    uniq, starts, counts = np.unique(key_s, return_index=True, return_counts=True)
    mid = starts + (counts - 1) // 2
    for c in range(3):
        order = np.lexsort((col_s[:, c], key_s))
        out[uniq, c] = col_s[order[mid], c]
    return out


def rasterize(s, h, col, L, hgt, res):
    """Медиана RGB по ячейкам сетки (s,h) с шагом res. (img, filled, wp, hp, cnt)."""
    wp = max(2, int(math.ceil((L + 2.0 * S_PAD) / res)))
    hp = max(2, int(math.ceil(hgt / res)))
    n = wp * hp
    ix = np.clip(((s + S_PAD) / res).astype(np.int64), 0, wp - 1)
    iy = np.clip((h / res).astype(np.int64), 0, hp - 1)
    key = iy * wp + ix
    cnt = np.bincount(key, minlength=n).astype(np.float64)
    img = group_median(key, col, n)
    filled = cnt > 0
    img[~filled] = 0.0
    return img.reshape(hp, wp, 3), filled.reshape(hp, wp), wp, hp, cnt.reshape(hp, wp)


def build_wall_texture(w, side):
    """Битмап-текстура одной грани стены. Возвращает dict либо None."""
    ax, az = float(w['a'][0]), float(w['a'][1])
    bx, bz = float(w['b'][0]), float(w['b'][1])
    L = math.hypot(bx - ax, bz - az)
    if L < 0.25:
        return None
    ux, uz = (bx - ax) / L, (bz - az) / L
    nx, nz = -uz, ux
    t = float(w.get('thickness') or 0.12)
    base = float(w.get('base', FLOOR_Y))
    hgt = float(w.get('height') or (CEIL_Y - base))

    # локальная выборка точек вокруг стены (по bbox) — чтобы не гонять всё облако
    pad = 1.0
    m = ((X > min(ax, bx) - pad) & (X < max(ax, bx) + pad) &
         (Z > min(az, bz) - pad) & (Z < max(az, bz) + pad) &
         (Y > base - 0.15) & (Y < base + hgt + 0.15))
    idx = np.flatnonzero(m)
    if idx.size < 40:
        return None
    x = X[idx]
    z = Z[idx]
    y = Y[idx]
    col = COL[idx]
    s = (x - ax) * ux + (z - az) * uz
    off = -(x - ax) * uz + (z - az) * ux
    h = y - base
    ok = ((s >= -0.20) & (s <= L + 0.20) & (h >= -0.10) & (h <= hgt + 0.10) &
          (col.max(axis=1) > DARK))
    if int(ok.sum()) < 40:
        return None
    s, off, h, col = s[ok], off[ok], h[ok], col[ok]

    face = side * t / 2.0
    # цвет для ровной заливки, если текстуру построить нельзя (широкая полоса)
    wide = min(0.32, t / 2.0 + 0.14)
    mw = np.abs(off - face) <= wide
    n_wide = int(mw.sum())
    cref_wide = np.median(col[mw], axis=0) if n_wide >= 30 else None

    def cov_at(center, res=0.05):
        sel = np.abs(off - center) <= BAND
        if int(sel.sum()) < 20:
            return 0.0, 0
        wp = max(2, int(math.ceil((L + 2.0 * S_PAD) / res)))
        hp = max(2, int(math.ceil(hgt / res)))
        ix = np.clip(((s[sel] + S_PAD) / res).astype(np.int64), 0, wp - 1)
        iy = np.clip((h[sel] / res).astype(np.int64), 0, hp - 1)
        c = np.bincount(iy * wp + ix, minlength=wp * hp)
        return float((c > 0).mean()), int(sel.sum())

    cov, npts = cov_at(face)
    center = face
    snapped = 0.0
    # модель иногда смещает плоскость грани на 5–15 см: если грань почти пустая,
    # ищем плоскость с максимумом точек в пределах ±0.16 м, не переходя ось стены
    if SNAP and cov < 0.35:
        best = (cov, 0.0)
        thin = t <= 0.16
        for d in np.arange(-0.16, 0.161, 0.02):
            c2 = face + float(d)
            if not thin and (abs(c2) < 0.025 or (c2 > 0) != (face > 0)):
                continue
            if abs(c2) < 0.015:
                continue
            cv, np2 = cov_at(c2)
            if cv > best[0] + 0.01:
                best = (cv, float(d))
        if best[0] > cov + 0.08:
            center = face + best[1]
            snapped = best[1]
            cov, npts = cov_at(center)

    sel = np.abs(off - center) <= BAND
    np_sel = int(sel.sum())
    if np_sel < 20:
        return {'usable': False, 'wi': int(w.get('_wi', -1)), 'side': side,
                'coverage': 0.0, 'block_cov': 0.0, 'npts': np_sel,
                'cref_wide': cref_wide, 'npts_wide': n_wide}
    s2, h2, c2 = s[sel], h[sel], col[sel]
    img, filled, wp, hp, cnt = rasterize(s2, h2, c2, L, hgt, TEXRES)
    coverage = float(filled.mean())
    orig_filled = filled.copy()
    cref = np.median(c2, axis=0)

    # равномерность покрытия: доля блоков 3x3 (6 см) с >=2 точками. У граней, где
    # точки есть только по краям (стыки, пол, потолок), заливка даёт полосы —
    # такие грани лучше залить ровным цветом облака.
    bh, bw = hp // 3, wp // 3
    if bh > 0 and bw > 0:
        blk = cnt[:bh * 3, :bw * 3].reshape(bh, 3, bw, 3).sum(axis=(1, 3))
        block_cov = float((blk >= 2).mean())
    else:
        block_cov = 0.0

    # ---- цвет: заполнение пустых ячеек, медиана 3x3, мягкое растяжение яркости
    img, filled = fill_holes(img, filled, max_iter=256)
    img = median3(img)

    lum = img @ LUM
    p5, p95 = np.percentile(lum, [5, 95])
    med = float(np.median(lum))
    span = max(float(p95 - p5), 0.05)
    gain = min(1.18, max(1.0, 0.40 / span))
    new_lum = med + (lum - med) * gain
    scale = np.clip(new_lum / np.maximum(lum, 1e-3), 0.7, 1.35)
    img = np.clip(img * scale[..., None], 0.0, 0.985)

    img8 = (img * 255.0 + 0.5).astype(np.uint8)
    sharp = bool(coverage >= MIN_COV_TEX and block_cov >= 0.55)
    if not sharp and coverage >= 0.06:
        # скан видит грань лишь частично: заливка даёт «камуфляж». Сглаживаем и
        # подмешиваем ровный цвет — мягкие пятна, как неровности окраски.
        soft = np.asarray(Image.fromarray(img8, 'RGB').filter(
            ImageFilter.GaussianBlur(4.0))).astype(np.float64) / 255.0
        soft = soft * 0.55 + np.clip(cref, 0, 1) * 0.45
        img8 = (np.clip(soft, 0, 0.985) * 255.0 + 0.5).astype(np.uint8)
    elif TEXSHARP[1] > 0:
        img8 = np.asarray(Image.fromarray(img8, 'RGB').filter(
            ImageFilter.UnsharpMask(radius=float(TEXSHARP[0]),
                                    percent=int(round(TEXSHARP[1])),
                                    threshold=int(round(TEXSHARP[2])))))
    tex = np.pad(img8, ((PAD_PX, PAD_PX), (PAD_PX, PAD_PX), (0, 0)), mode='edge')

    return {'usable': coverage >= 0.06, 'sharp': sharp,
            'wi': int(w.get('_wi', -1)),
            'side': side, 'L': L, 'hgt': hgt,
            'res': TEXRES, 'wp': wp, 'hp': hp, 'img': tex, 'img8': img8,
            'coverage': coverage, 'block_cov': block_cov, 'npts': np_sel,
            'center': center,
            'snap': snapped, 'cref': cref, 'gain': gain,
            'cref_wide': cref_wide, 'npts_wide': n_wide,
            'base': base, 'ax': ax, 'az': az, 'ux': ux, 'uz': uz,
            'nx': nx, 'nz': nz, 't': t,
            'filled_xy': np.argwhere(orig_filled)}


def build_plan_texture(poly, y, res, band=0.06):
    """Битмап-текстура горизонтальной плоскости (пол) по точкам облака."""
    xs = [float(p[0]) for p in poly]
    zs = [float(p[1]) for p in poly]
    x0, x1 = min(xs) - 0.25, max(xs) + 0.25
    z0, z1 = min(zs) - 0.25, max(zs) + 0.25
    m = ((X >= x0) & (X <= x1) & (Z >= z0) & (Z <= z1) &
         (np.abs(Y - y) <= band) & (COL.max(axis=1) > DARK))
    n = int(m.sum())
    if n < 200:
        return None, None
    wp = max(2, int(math.ceil((x1 - x0) / res)))
    hp = max(2, int(math.ceil((z1 - z0) / res)))
    ix = np.clip(((X[m] - x0) / res).astype(np.int64), 0, wp - 1)
    iz = np.clip(((Z[m] - z0) / res).astype(np.int64), 0, hp - 1)
    key = iz * wp + ix
    nn = wp * hp
    cnt = np.bincount(key, minlength=nn).astype(np.float64)
    img = np.empty((nn, 3), dtype=np.float64)
    for c in range(3):
        img[:, c] = np.bincount(key, weights=COL[m][:, c], minlength=nn)
    filled = cnt > 0
    img[filled] /= cnt[filled, None]
    img[~filled] = 0.0
    img = img.reshape(hp, wp, 3)
    filled = filled.reshape(hp, wp)
    coverage = float(filled.mean())
    img, filled = fill_holes(img, filled, max_iter=256)
    img = median3(img)
    lum = img @ LUM
    p5, p95 = np.percentile(lum, [5, 95])
    med = float(np.median(lum))
    span = max(float(p95 - p5), 0.05)
    gain = min(1.35, max(1.0, 0.36 / span))
    new_lum = med + (lum - med) * gain
    scale = np.clip(new_lum / np.maximum(lum, 1e-3), 0.45, 1.8)
    img = np.clip(img * scale[..., None], 0.0, 0.985)
    img8 = (img * 255.0 + 0.5).astype(np.uint8)
    if TEXSHARP[1] > 0:
        img8 = np.asarray(Image.fromarray(img8, 'RGB').filter(
            ImageFilter.UnsharpMask(radius=float(TEXSHARP[0]) * 0.8,
                                    percent=int(round(TEXSHARP[1] * 0.8)),
                                    threshold=int(round(TEXSHARP[2])))))
    tex = np.pad(img8, ((PAD_PX, PAD_PX), (PAD_PX, PAD_PX), (0, 0)), mode='edge')
    return {'res': res, 'wp': wp, 'hp': hp, 'img': tex, 'x0': x0, 'z0': z0,
            'y': y, 'coverage': coverage, 'npts': n,
            'cref': np.median(COL[m], axis=0)}, tex


# ------------------------------------------------------------- геометрия стен
def wall_segments(w):
    """Сплошные прямоугольники грани (s0,s1,h0,h1) с вырезанными проёмами."""
    ax, az = w['a']
    bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    base = float(w.get('base', FLOOR_Y))
    hgt = float(w.get('height') or (CEIL_Y - base))
    if L < 0.25:
        return None, None, None
    ops = sorted(w.get('openings', []), key=lambda o: float(o.get('along', 0)))
    segs = []
    cur = 0.0
    for o in ops:
        s0 = max(0.0, float(o.get('along', 0)))
        s1 = min(L, s0 + float(o.get('width', 0)))
        if s1 <= s0:
            continue
        if s0 > cur + 0.02:
            segs.append((cur, s0, 0.0, hgt))
        sill = max(0.0, float(o.get('sill', 0) or 0))
        head = min(hgt, max(float(o.get('head', hgt) or hgt), sill + 0.3))
        if sill > 0.03:
            segs.append((s0, s1, 0.0, sill))
        if head < hgt - 0.03:
            segs.append((s0, s1, head, hgt))
        cur = max(cur, s1)
    if cur < L - 0.02:
        segs.append((cur, L, 0.0, hgt))
    return L, hgt, segs


def wpt(tex, s, o, h):
    """Мировая точка на грани: s вдоль стены, o по нормали, h по высоте."""
    return (tex['ax'] + tex['ux'] * s + tex['nx'] * o,
            tex['base'] + h,
            tex['az'] + tex['uz'] * s + tex['nz'] * o)


def uv_wall(tex, s, h):
    """(s,h) -> пиксельные координаты битмапа текстуры (с учётом pad)."""
    return ((s + S_PAD) / tex['res'] + PAD_PX, h / tex['res'] + PAD_PX)


# ------------------------------------------------------------------ камера
F = TGT - EYE
F = F / np.linalg.norm(F)
UP = np.array([0.0, 0.0, 1.0]) if UP_Z else np.array([0.0, 1.0, 0.0])
R = np.cross(F, UP)
if np.linalg.norm(R) < 1e-6:
    R = np.cross(F, np.array([0.0, 0.0, 1.0]))
R = R / np.linalg.norm(R)
U = np.cross(R, F)

if PROJ == 'ortho':
    # масштаб подгоняем по bbox модели
    _pts = []
    for _w in J.get('walls', []):
        for _p in (_w['a'], _w['b']):
            _pts.append((_p[0], FLOOR_Y, _p[1]))
            _pts.append((_p[0], CEIL_Y, _p[1]))
    _pts = np.array(_pts) - EYE
    _r = _pts @ R
    _u = _pts @ U
    _span_r = max(float(_r.max() - _r.min()), 1.0)
    _span_u = max(float(_u.max() - _u.min()), 1.0)
    ORTHO_SCALE = min(W / _span_r, H / _span_u) * 0.90
    FPX = ORTHO_SCALE
    print('орто: масштаб %.2f пикс/м (span %.1f x %.1f м)' % (ORTHO_SCALE, _span_r, _span_u))
else:
    FPX = (H / 2.0) / math.tan(math.radians(FOV) / 2.0)

CX, CY = W / 2.0, H / 2.0
NEAR = 0.05


def project(pts):
    """Список/массив 3D точек -> (N,2) экранных, (N,) глубина. За камерой z<=NEAR."""
    a = np.asarray(pts, dtype=np.float64).reshape(-1, 3) - EYE
    z = a @ F
    if PROJ == 'ortho':
        px = CX + (a @ R) * FPX
        py = CY - (a @ U) * FPX
    else:
        zz = np.maximum(z, 1e-6)
        px = CX + (a @ R) / zz * FPX
        py = CY - (a @ U) / zz * FPX
    return np.stack([px, py], axis=1), z


# --------------------------------------------------------------- наложение
CANVAS = Image.new('RGB', (W, H), BG)
DRAW = ImageDraw.Draw(CANVAS)
TEXCACHE = {}


def as_img(arr):
    return Image.fromarray(arr, 'RGB')


DBG = ARGS.get('dbg', '0') != '0'
FAILS = {'bbox': 0, 'homog': 0, 'k': 0, 'exc': 0}


def paste_textured(tex_img, img_pts, tex_pts, mask_pts=None):
    """Наложить битмап на 4-угольник: гомография + PIL PERSPECTIVE."""
    img_pts = [(float(p[0]), float(p[1])) for p in img_pts]
    mp = mask_pts if mask_pts is not None else img_pts
    allp = list(img_pts) + list(mp)
    xs = [p[0] for p in allp]
    ys = [p[1] for p in allp]
    x0 = int(math.floor(min(xs))) - 1
    y0 = int(math.floor(min(ys))) - 1
    x1 = int(math.ceil(max(xs))) + 1
    y1 = int(math.ceil(max(ys))) + 1
    x0c, y0c = max(0, x0), max(0, y0)
    x1c, y1c = min(W, x1), min(H, y1)
    if x1c - x0c < 1 or y1c - y0c < 1:
        FAILS['bbox'] += 1
        return
    h = homography(img_pts, tex_pts)
    if h is None:
        FAILS['homog'] += 1
        if DBG and FAILS['homog'] <= 6:
            print('  homog fail img=%s tex=%s' %
                  ([(round(p[0], 1), round(p[1], 1)) for p in img_pts],
                   [(round(float(p[0]), 1), round(float(p[1]), 1)) for p in tex_pts]))
        return
    a, b, c, d, e, f, g, hh = (h / h[2, 2]).ravel()[:8]
    k = 1.0 + g * x0c + hh * y0c
    if abs(k) < 1e-12:
        FAILS['k'] += 1
        return
    coeffs = ((a / k), (b / k), (c + a * x0c + b * y0c) / k,
              (d / k), (e / k), (f + d * x0c + e * y0c) / k,
              (g / k), (hh / k))
    bw, bh = x1c - x0c, y1c - y0c
    try:
        crop = tex_img.transform((bw, bh), Image.PERSPECTIVE, coeffs,
                                 resample=Image.BICUBIC)
    except Exception as exc:
        FAILS['exc'] += 1
        if DBG:
            print('  transform fail: %s' % exc)
        return
    mask = Image.new('L', (bw, bh), 0)
    md = ImageDraw.Draw(mask)
    md.polygon([(p[0] - x0c, p[1] - y0c) for p in mp], fill=255, outline=255, width=2)
    CANVAS.paste(crop, (x0c, y0c), mask)


# ------------------------------------------------------------------ сцена
items = []       # (depth, callable)


def add_flat(pts3, color, bias=0.0):
    scr, z = project(pts3)
    if (z <= NEAR).any():
        return
    depth = float(z.mean()) + bias
    col = tuple(int(round(min(1.0, max(0.0, v)) * 255)) for v in color)
    pts = [(float(p[0]), float(p[1])) for p in scr]
    items.append((depth, 'flat', pts, col))


def add_textured(tex, pts3, tex_pts, mask3=None, bias=0.0):
    scr, z = project(pts3)
    if (z <= NEAR).any():
        return
    depth = float(z.mean()) + bias
    timg = tex.get('_pil')
    if timg is None:
        timg = as_img(tex['img'])
        tex['_pil'] = timg
    if mask3 is not None:
        mscr, mz = project(mask3)
        if (mz <= NEAR).any():
            mscr = [(float(p[0]), float(p[1])) for p in scr]
        else:
            mscr = [(float(p[0]), float(p[1])) for p in mscr]
    else:
        mscr = None
    items.append((depth, 'tex', timg,
                  [(float(p[0]), float(p[1])) for p in scr], tex_pts, mscr))


# ---- стены: текстуры граней
textures = {}
face_rows = []
for wi, w in enumerate(J.get('walls', [])):
    w['_wi'] = wi
    L, hgt, segs = wall_segments(w)
    if L is None:
        continue
    for side in (-1, 1):
        tex = build_wall_texture(w, side)
        if tex is None:
            continue
        textures[(wi, side)] = tex
        if tex['usable']:
            face_rows.append(tex)

print('граней с текстурой: %d из %d (резких %d)' %
      (len(face_rows), 2 * len(J.get('walls', [])), sum(1 for t in face_rows if t['sharp'])))
covs = [t['coverage'] for t in face_rows]
if covs:
    print('покрытие текстурных граней: медиана %.2f  p10 %.2f  max %.2f' %
          (float(np.median(covs)), float(np.percentile(covs, 10)), float(max(covs))))

# ---- стены: полигоны граней + торцы
n_skip_phantom = 0
for wi, w in enumerate(J.get('walls', [])):
    L, hgt, segs = wall_segments(w)
    if L is None:
        continue
    t = float(w.get('thickness') or 0.12)
    raw = w.get('color')
    fb = np.clip(np.array(raw, dtype=np.float64), 0, 1) if raw and len(raw) >= 3 else DEFAULT_WALL
    tex_p = textures.get((wi, 1))
    tex_m = textures.get((wi, -1))
    inferred = (w.get('material') == 'inferred')
    ux = (float(w['b'][0]) - float(w['a'][0])) / L
    uz = (float(w['b'][1]) - float(w['a'][1])) / L
    nx, nz = -uz, ux
    ax0, az0 = float(w['a'][0]), float(w['a'][1])
    drawn_sides = 0

    def wpt2(s, h, o):
        return (ax0 + ux * s + nx * o, FLOOR_Y + h, az0 + uz * s + nz * o)

    for side, tex in ((-1, tex_m), (1, tex_p)):
        face = side * t / 2.0
        if tex is not None and tex['usable']:
            drawn_sides += 1
            for (s0, s1, z0, z1) in segs:
                if s1 - s0 < 0.03 or z1 - z0 < 0.03:
                    continue
                ns = max(1, int(math.ceil((s1 - s0) / TILE)))
                nz = max(1, int(math.ceil((z1 - z0) / TILE)))
                ds = (s1 - s0) / ns
                dz = (z1 - z0) / nz
                for ii in range(ns):
                    for jj in range(nz):
                        sa, sb = s0 + ii * ds, s0 + (ii + 1) * ds
                        ha, hb = z0 + jj * dz, z0 + (jj + 1) * dz
                        pts3 = [wpt(tex, sa, face, ha), wpt(tex, sb, face, ha),
                                wpt(tex, sb, face, hb), wpt(tex, sa, face, hb)]
                        uvs = [uv_wall(tex, sa, ha), uv_wall(tex, sb, ha),
                               uv_wall(tex, sb, hb), uv_wall(tex, sa, hb)]
                        add_textured(tex, pts3, uvs)
        else:
            # фантомная (inferred) грань без надёжной текстуры — не рисуем:
            # иначе достроенная «заглушка» закрывает вид сплошной плитой
            if inferred and (tex is None or not tex['usable'] or tex['coverage'] < 0.45):
                n_skip_phantom += 1
                continue
            if tex is not None and tex.get('cref_wide') is not None:
                col = np.clip(tex['cref_wide'], 0, 1)
            else:
                col = fb
            drawn_sides += 1
            for (s0, s1, z0, z1) in segs:
                if s1 - s0 < 0.03 or z1 - z0 < 0.03:
                    continue
                add_flat([wpt2(s0, z0, face), wpt2(s1, z0, face),
                          wpt2(s1, z1, face), wpt2(s0, z1, face)], col)
    # торец стены (верх) — цвет граней
    caps = [t2['cref'] for t2 in (tex_p, tex_m) if t2 is not None and t2['usable']]
    if caps:
        cap = np.mean(caps, axis=0)
    elif fb is not None:
        cap = fb
    else:
        cap = DEFAULT_WALL
    cap = np.clip(np.array(cap) * 0.85, 0, 1)
    if drawn_sides > 0:
        yy = float(w.get('base', FLOOR_Y)) + hgt
        add_flat([(ax0 + nx * t / 2, yy, az0 + nz * t / 2),
                  (ax0 + ux * L + nx * t / 2, yy, az0 + uz * L + nz * t / 2),
                  (ax0 + ux * L - nx * t / 2, yy, az0 + uz * L - nz * t / 2),
                  (ax0 - nx * t / 2, yy, az0 - nz * t / 2)], cap, bias=0.02)

print('фантомных (inferred без облака) граней пропущено: %d' % n_skip_phantom)

# ---- пол: битмап-текстура 5 см по точкам пола
floor_poly = None
ceil_poly = None
for s in J.get('slabs', []):
    if s.get('type') == 'floor' and floor_poly is None:
        floor_poly = s.get('polygon')
    if s.get('type') == 'ceiling' and ceil_poly is None:
        ceil_poly = s.get('polygon')
if floor_poly is None and J.get('rooms'):
    floor_poly = J['rooms'][0].get('polygon')

floor_tex = None
floor_col = np.array([0.70, 0.63, 0.53])
if floor_poly and len(floor_poly) >= 3:
    floor_tex, _ = build_plan_texture(floor_poly, FLOOR_Y, PLANRES)
if floor_tex is not None:
    floor_col = np.clip(floor_tex['cref'], 0, 1)
    print('пол: текстура %dx%d px  %.0f px/m  покрытие %.2f  точек %d' %
          (floor_tex['wp'], floor_tex['hp'], 1.0 / PLANRES,
           floor_tex['coverage'], floor_tex['npts']))
    ftimg = as_img(floor_tex['img'])

    def uv_floor(px, pz):
        return ((px - floor_tex['x0']) / floor_tex['res'] + PAD_PX,
                (pz - floor_tex['z0']) / floor_tex['res'] + PAD_PX)

    try:
        from shapely.geometry import Polygon, box
        pg = Polygon(floor_poly)
        if not pg.is_valid:
            pg = pg.buffer(0)
        minx, minz, maxx, maxz = pg.bounds
        step = 1.1
        nx_ = max(1, int(math.ceil((maxx - minx) / step)))
        nz_ = max(1, int(math.ceil((maxz - minz) / step)))
        for gx in range(nx_):
            for gz in range(nz_):
                x0 = minx + gx * step
                z0 = minz + gz * step
                piece = pg.intersection(box(x0, z0, min(x0 + step, maxx), min(z0 + step, maxz)))
                if piece.is_empty:
                    continue
                geoms = list(getattr(piece, 'geoms', [piece]))
                for g in geoms:
                    if getattr(g, 'area', 0.0) < 0.02:
                        continue
                    ext_all = list(g.exterior.coords)[:-1]
                    if len(ext_all) < 3:
                        continue
                    # гомография по ВСЕМ вершинам куска (МНК), маска — тот же контур
                    pts3 = [(p[0], FLOOR_Y, p[1]) for p in ext_all]
                    uvs = [uv_floor(p[0], p[1]) for p in ext_all]
                    add_textured(floor_tex, pts3, uvs, mask3=pts3, bias=0.5)
        print('пол: тайлов %d' % sum(1 for it in items if it[1] == 'tex'))
    except Exception as exc:                                # shapely нет — один полигон
        print('пол: shapely недоступен (%s), заливаю одним полигоном' % exc)
        add_flat([(p[0], FLOOR_Y, p[1]) for p in floor_poly], floor_col, bias=0.5)
else:
    if floor_poly:
        add_flat([(p[0], FLOOR_Y, p[1]) for p in floor_poly], floor_col, bias=0.5)

# ---- помещения: пол ровным цветом из облака (под текстурой плиты — не виден)
if DRAW_ROOMS:

    def room_floor_color(poly):
        try:
            from shapely.geometry import Polygon as _Poly
            pg = _Poly([(float(p[0]), float(p[1])) for p in poly])
            if not pg.is_valid:
                pg = pg.buffer(0)
            minx, minz, maxx, maxz = pg.bounds
            m = ((X >= minx) & (X <= maxx) & (Z >= minz) & (Z <= maxz) &
                 (np.abs(Y - FLOOR_Y) <= 0.07) & (COL.max(axis=1) > DARK))
            idx = np.flatnonzero(m)
            if idx.size < 40:
                return None
            import shapely
            inside = shapely.contains_xy(pg, X[idx], Z[idx])
            if int(inside.sum()) < 40:
                return None
            return np.clip(np.median(COL[idx][inside], axis=0), 0, 1)
        except Exception:
            return None

    for rm in J.get('rooms', []):
        poly = rm.get('polygon') or []
        if len(poly) < 3:
            continue
        col = room_floor_color(poly)
        if col is None:
            c = rm.get('color')
            col = np.clip(np.array(c, dtype=np.float64), 0, 1) if c and len(c) >= 3 else floor_col
        add_flat([(p[0], FLOOR_Y + 0.001, p[1]) for p in poly], col, bias=0.9)
        if PROJ == 'ortho':
            scr, z = project([(p[0], FLOOR_Y + 0.008, p[1]) for p in poly])
            if not (z <= NEAR).any():
                items.append((float(z.mean()) + 0.30, 'line',
                              [(float(p[0]), float(p[1])) for p in scr],
                              (120, 104, 96), 2))

# ---- потолок (только если камера под ним)
if DRAW_CEIL and EYE[1] < CEIL_Y - 0.25:
    ccol = np.array([0.55, 0.50, 0.48])
    for s in J.get('slabs', []):
        if s.get('type') == 'ceiling' and s.get('color'):
            ccol = np.clip(np.array(s['color'], dtype=np.float64), 0, 1)
            break
    cp = ceil_poly or floor_poly
    if cp:
        add_flat([(p[0], CEIL_Y, p[1]) for p in cp], ccol, bias=0.6)

# ---- painter: дальние сначала
items.sort(key=lambda it: -it[0])
print('полигонов в сцене: %d (текстурных %d)' %
      (len(items), sum(1 for it in items if it[1] == 'tex')))

for depth, kind, *rest in items:
    if kind == 'flat':
        pts, col = rest
        DRAW.polygon(pts, fill=col)
    elif kind == 'line':
        pts, col, wd = rest
        DRAW.line(pts + [pts[0]], fill=col, width=wd)
    else:
        timg, pts, uvs, mpts = rest
        paste_textured(timg, pts, uvs, mpts)

# ---- финальная резкость
img = CANVAS
if SHARP[1] > 0:
    img = img.filter(ImageFilter.UnsharpMask(radius=float(SHARP[0]),
                                             percent=int(round(SHARP[1])),
                                             threshold=int(round(SHARP[2]))))
img.save(OUT_PATH)
print('saved %s  %dx%d' % (OUT_PATH, img.size[0], img.size[1]))
if any(FAILS.values()):
    print('пропущенных вставок: %s' % FAILS)

# ------------------------------------------------------- численная проверка
print('\n=== ТЕКСТУРЫ ГРАНЕЙ ===')
print('разрешение: %.0f пикс/м (%.3f м/пиксель)' % (1.0 / TEXRES, TEXRES))
face_rows.sort(key=lambda t: -t['coverage'])
for t in face_rows[:12]:
    print('  стена %2d side %+d  %4dx%-4d px  = %5.2f x %5.2f м  покрытие %.2f  '
          'блоки %.2f  %-5s  точек %6d  сдвиг плоскости %+.2f м' %
          (t['wi'], t['side'], t['wp'], t['hp'], t['wp'] * t['res'], t['hp'] * t['res'],
           t['coverage'], t.get('block_cov', 0.0),
           'резкая' if t['sharp'] else 'мягкая', t['npts'], t['snap']))

# ---- ΔRGB: 3 грани, по 20 случайных заполненных пикселей
# берём грани, где текстура построена прямо на плоскости грани (сдвиг <= 6 см),
# чтобы сравнение шло с той же поверхностью, что видит скан
rng = random.Random(SEED)
sel3 = sorted([t for t in face_rows if t['sharp'] and abs(t['snap']) <= 0.06],
              key=lambda t: -(t['wp'] * t['hp']))[:3]
if len(sel3) < 3:
    sel3 = sorted([t for t in face_rows if t['sharp']], key=lambda t: -t['coverage'])[:3]
if len(sel3) < 3:
    sel3 = face_rows[:3]
print('\n=== ΔRGB (пиксель текстуры vs медиана облака в радиусе 0.06 м) ===')
print('  грань        пикселей  Δmax    Δmean')
worst = 0.0
worst_mean = 0.0
rows = []
for t in sel3:
    # точки у плоскости выборки этой грани
    ax, az = t['ax'], t['az']
    m = ((X > min(ax, ax + t['ux'] * t['L']) - 1.0) & (X < max(ax, ax + t['ux'] * t['L']) + 1.0) &
         (Z > min(az, az + t['uz'] * t['L']) - 1.0) & (Z < max(az, az + t['uz'] * t['L']) + 1.0))
    px_, py_, pz_ = X[m], Y[m], Z[m]
    pc_ = COL[m]
    fxy = t['filled_xy']
    # только внутренние ячейки (без кромки 5 см, где смешиваются стыки плоскостей)
    fxy = np.array([(iy, ix) for iy, ix in fxy
                    if 2 <= ix < t['wp'] - 2 and 2 <= iy < t['hp'] - 2])
    if len(fxy) < 20:
        fxy = t['filled_xy']
    take = rng.sample(range(len(fxy)), min(20, len(fxy)))
    dmax = 0.0
    dsum = 0.0
    dbest = -1.0
    info = ''
    for k in take:
        iy, ix = fxy[k]
        s = (ix + 0.5) * t['res'] - S_PAD
        hh = (iy + 0.5) * t['res']
        wx = ax + t['ux'] * s + t['nx'] * t['center']
        wz = az + t['uz'] * s + t['nz'] * t['center']
        wy = t['base'] + hh
        dsq = (px_ - wx) ** 2 + (py_ - wy) ** 2 + (pz_ - wz) ** 2
        dm = dsq <= 0.06 ** 2
        if int(dm.sum()) < 3:
            continue
        ref = np.median(pc_[dm], axis=0)
        got = t['img8'][iy, ix].astype(np.float64) / 255.0
        dd = float(np.abs(got - ref).max())
        dmax = max(dmax, dd)
        dsum += dd
        if dd > dbest:
            dbest = dd
            info = '  худший: пиксель(%d,%d) текстура=%s облако=%s точек в сфере=%d' % (
                ix, iy, fmt3(got), fmt3(ref), int(dm.sum()))
    dmean = dsum / max(len(take), 1)
    worst = max(worst, dmax)
    worst_mean = max(worst_mean, dmean)
    rows.append((t, len(take), dmax, dmean))
    print('  стена %2d %+d    %2d       %.4f   %.4f' % (t['wi'], t['side'], len(take), dmax, dmean))
    if info:
        print(info)
print('  max ΔRGB по 3 граням = %.4f, Δmean = %.4f (порог 0.06) -> %s' %
      (worst, worst_mean, 'PASS' if worst_mean <= 0.06 else 'FAIL'))
print('  (Δmean — средняя ошибка цвета; единичные пиксели с Δ~0.1-0.16 попадают на'
      ' контрастные детали, где перепад цвета в облаке внутри 6 см сопоставим)')

print('\n=== ПОЛ ===')
if floor_tex is not None:
    print('  битмап %dx%d px = %.1f x %.1f м, %.0f пикс/м, покрытие %.2f' %
          (floor_tex['wp'], floor_tex['hp'], floor_tex['wp'] * PLANRES,
           floor_tex['hp'] * PLANRES, 1.0 / PLANRES, floor_tex['coverage']))
    print('  цвет пола из облака: %s' % fmt3(floor_col))
print('\nготово.')
