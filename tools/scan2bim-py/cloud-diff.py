"""cloud-diff.py — r151 P2 «Отчёт о точности»: 3D-разница двух облаков и RMSE плоскостей.

Сравнивает наше облако с эталоном (LAS/PLY):
  * 3D-разница: для каждой точки нашего облака — расстояние до ближайшей точки эталона
    (воксельный поиск, без scipy): среднее, RMSE, медиана, p95, max, % точек в допусках 2/5/10 см;
  * RMSE плоскостей: пол (нижние 2% точек) и стены (4 стороны bbox) — RMS отклонения от
    собственной плоскости для каждого облака + разница;
  * heatmap сверху: карта расстояний (PNG).

Зависимости: только numpy + Pillow (как у quality-compare.py).
Входные облака читаются через cloud-classify.py (LAS/PLY/BIN), поэтому поддержка форматов та же.

Запуск:
  python cloud-diff.py --our ours.las --ref etalon.las --out diff.json --heatmap diff.png
"""
import argparse
import importlib.util
import json
import math
import os
import time

import numpy as np

try:
    import PIL.Image as Image
    import PIL.ImageDraw as ImageDraw
except Exception:  # pragma: no cover
    Image = None
    ImageDraw = None

HERE = os.path.dirname(os.path.abspath(__file__))
VERSION = 'r151.1'


def _load_module(name, filename):
    path = os.path.join(HERE, filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _classify():
    return _load_module('p1_classify', 'cloud-classify.py')


def load_points(path, max_points=None):
    """X (N,3) float32 через парсер cloud-classify.py (LAS/PLY/BIN)."""
    C = _classify()
    X, rgb, meta, kind = C.read_cloud(path, max_points)
    return np.asarray(X, dtype=np.float64), kind, meta


def downsample(P, max_n, seed=7):
    if max_n <= 0 or len(P) <= max_n:
        return P
    rng = np.random.RandomState(seed)
    idx = rng.choice(len(P), size=max_n, replace=False)
    idx.sort()
    return P[idx]


def nn_distances(A, B, base_voxel=None):
    """Ближайшая точка B для каждой точки A (воксельный хэш, без scipy)."""
    if len(A) == 0 or len(B) == 0:
        return np.full(len(A), np.inf)
    ext = np.ptp(np.vstack([A, B]), axis=0)
    diag = float(np.linalg.norm(ext)) or 1.0
    vs = float(base_voxel or max(0.02, diag / 220.0))
    dist = np.full(len(A), np.inf, dtype=np.float64)
    todo = np.arange(len(A))
    for scale in (1.0, 2.0, 4.0, 8.0):
        v = vs * scale
        keys = np.floor(B / v).astype(np.int64)
        cells = {}
        for i in range(len(B)):
            k = (int(keys[i, 0]), int(keys[i, 1]), int(keys[i, 2]))
            arr = cells.get(k)
            if arr is None:
                cells[k] = [i]
            else:
                arr.append(i)
        cells = {k: np.asarray(v2, dtype=np.int64) for k, v2 in cells.items()}
        still = []
        for ai in todo:
            p = A[ai]
            kx, ky, kz = int(math.floor(p[0] / v)), int(math.floor(p[1] / v)), int(math.floor(p[2] / v))
            best = np.inf
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        cand = cells.get((kx + dx, ky + dy, kz + dz))
                        if cand is None:
                            continue
                        d = np.linalg.norm(B[cand] - p, axis=1)
                        m = float(d.min())
                        if m < best:
                            best = m
            if np.isfinite(best):
                dist[ai] = best
            else:
                still.append(ai)
        todo = np.asarray(still, dtype=np.int64)
        if len(todo) == 0:
            break
    if len(todo):
        sub = B if len(B) <= 60000 else B[np.random.RandomState(11).choice(len(B), 60000, replace=False)]
        for ai in todo:
            dist[ai] = float(np.linalg.norm(sub - A[ai], axis=1).min())
    return dist


def _plane_rms(P, axis, updir):
    """RMS отклонения от собственной плоскости: координата axis ~ f(двух других)."""
    if len(P) < 50:
        return None
    others = [i for i in range(3) if i != axis]
    A = np.column_stack([P[:, others[0]], P[:, others[1]], np.ones(len(P))])
    b = P[:, axis]
    try:
        coef, *_ = np.linalg.lstsq(A, b, rcond=None)
    except Exception:
        return None
    res = b - (A @ coef)
    return float(np.sqrt(np.mean(res * res)))


def plane_metrics(our, ref):
    """RMSE пола и стен (мм): своя плоскость для каждого облака + разница."""
    ext = np.ptp(np.vstack([our, ref]), axis=0)
    up = int(np.argmin(ext))            # ось с минимальным разбросом — «вверх»
    horiz = [i for i in range(3) if i != up]
    lo = np.percentile(np.vstack([our, ref])[:, up], 0.0)
    hi = np.percentile(np.vstack([our, ref])[:, up], 100.0)
    band = max(0.05, (hi - lo) * 0.02)
    out = {'up_axis': 'xyz'[up], 'floor_mm': {}, 'walls_mm': {}}
    for name, P in (('our', our), ('ref', ref)):
        if len(P) < 100:
            out['floor_mm'][name] = None
            continue
        m = P[:, up] <= (np.min(P[:, up]) + band)
        r = _plane_rms(P[m], up, 1)
        out['floor_mm'][name] = None if r is None else round(r * 1000, 3)
    fo, fr = out['floor_mm'].get('our'), out['floor_mm'].get('ref')
    out['floor_mm']['delta'] = None if (fo is None or fr is None) else round(fo - fr, 3)
    # стены: 4 стороны bbox по двум горизонтальным осям
    sides = []
    for ax in horiz:
        lo_v, hi_v = float(np.min(ref[:, ax])), float(np.max(ref[:, ax]))
        thick = max(0.05, (hi_v - lo_v) * 0.03)
        for val in (lo_v, hi_v):
            sides.append((ax, val, thick))
    wall = {'our': [], 'ref': []}
    for name, P in (('our', our), ('ref', ref)):
        for ax, val, thick in sides:
            m = np.abs(P[:, ax] - val) <= thick
            r = _plane_rms(P[m], ax, 1)
            if r is not None:
                wall[name].append(r)
    for name in ('our', 'ref'):
        arr = wall[name]
        out['walls_mm'][name] = round(float(np.mean(arr)) * 1000, 3) if arr else None
    wo, wr = out['walls_mm'].get('our'), out['walls_mm'].get('ref')
    out['walls_mm']['delta'] = None if (wo is None or wr is None) else round(wo - wr, 3)
    out['sides'] = len(sides)
    return out


def make_heatmap(A, dist, path, title='3D difference'):
    if Image is None:
        return None
    W = 900
    H = 620
    pad_l, pad_r, pad_t, pad_b = 10, 10, 34, 22
    img = Image.new('RGB', (W, H), (24, 27, 32))
    d = ImageDraw.Draw(img)
    x0, x1 = float(A[:, 0].min()), float(A[:, 0].max())
    y0, y1 = float(A[:, 1].min()), float(A[:, 1].max())
    sx = (W - pad_l - pad_r) / max(1e-9, (x1 - x0))
    sy = (H - pad_t - pad_b) / max(1e-9, (y1 - y0))
    grid = np.full((H - pad_t - pad_b, W - pad_l - pad_r), np.inf, dtype=np.float64)
    for i in range(len(A)):
        px = int((A[i, 0] - x0) * sx)
        py = int((y1 - A[i, 1]) * sy)
        if 0 <= px < grid.shape[1] and 0 <= py < grid.shape[0]:
            if dist[i] < grid[py, px]:
                grid[py, px] = dist[i]
    finite = np.isfinite(grid)
    vmax = float(np.percentile(np.where(finite, grid, np.nan)[finite], 98)) if finite.any() else 0.05
    vmax = max(vmax, 0.01)
    arr = np.array(img)
    for py in range(grid.shape[0]):
        for px in range(grid.shape[1]):
            v = grid[py, px]
            if not np.isfinite(v):
                continue
            t = min(1.0, v / vmax)
            # синий → зелёный → жёлтый → красный
            if t < 0.33:
                f = t / 0.33; r, g, b = 40, int(90 + 160 * f), 255
            elif t < 0.66:
                f = (t - 0.33) / 0.33; r, g, b = int(40 + 215 * f), 250, int(255 - 190 * f)
            else:
                f = (t - 0.66) / 0.34; r, g, b = 255, int(250 - 235 * f), int(65 - 60 * f)
            yy = pad_t + py
            xx = pad_l + px
            if yy < arr.shape[0] and xx < arr.shape[1]:
                arr[yy, xx] = (r, g, b)
    img = Image.fromarray(arr)
    d = ImageDraw.Draw(img)
    d.text((pad_l, 8), '%s: max %.3f m, mean %.4f m, RMSE %.4f m' % (
        title, float(np.nanmax(dist)), float(np.nanmean(dist)),
        float(np.sqrt(np.nanmean(np.square(dist))))), fill=(230, 234, 240))
    d.text((pad_l, H - 16), 'blue 0 m  ->  red > %.2f m' % vmax, fill=(160, 166, 176))
    img.save(path)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description='P2: 3D-разница и RMSE плоскостей (r151)')
    ap.add_argument('--our', required=True, help='наше облако LAS/PLY')
    ap.add_argument('--ref', required=True, help='эталон LAS/PLY')
    ap.add_argument('--out', default=None, help='JSON-отчёт')
    ap.add_argument('--heatmap', default=None, help='PNG-карта 3D-разницы (вид сверху)')
    ap.add_argument('--max-points', type=int, default=300000, help='максимум точек на облако для сравнения')
    a = ap.parse_args(argv)
    t0 = time.time()
    our_all, kind_our, meta_our = load_points(a.our)
    ref_all, kind_ref, meta_ref = load_points(a.ref)
    if len(our_all) < 100 or len(ref_all) < 100:
        print('ОШИБКА: мало точек (our=%d, ref=%d)' % (len(our_all), len(ref_all)))
        return 2
    # общая рамка
    lo = np.maximum(our_all.min(axis=0), ref_all.min(axis=0))
    hi = np.minimum(our_all.max(axis=0), ref_all.max(axis=0))
    if np.any(hi <= lo):
        print('ОШИБКА: облака не пересекаются по bbox')
        return 2
    def crop(P):
        m = np.all((P >= lo) & (P <= hi), axis=1)
        return P[m]
    our, ref = crop(our_all), crop(ref_all)
    if len(our) < 100 or len(ref) < 100:
        print('ОШИБКА: в общей рамке мало точек')
        return 2
    our_s = downsample(our, a.max_points)
    ref_s = downsample(ref, a.max_points)
    dist = nn_distances(our_s, ref_s)
    d = dist[np.isfinite(dist)]
    stats = {
        'mean_m': round(float(np.mean(d)), 5),
        'rmse_m': round(float(np.sqrt(np.mean(np.square(d)))), 5),
        'median_m': round(float(np.median(d)), 5),
        'p95_m': round(float(np.percentile(d, 95)), 5),
        'max_m': round(float(np.max(d)), 5),
        'within_2cm_pct': round(float(100.0 * np.mean(d <= 0.02)), 2),
        'within_5cm_pct': round(float(100.0 * np.mean(d <= 0.05)), 2),
        'within_10cm_pct': round(float(100.0 * np.mean(d <= 0.10)), 2),
        'points_our': int(len(our_s)), 'points_ref': int(len(ref_s)),
        'total_our': int(len(our_all)), 'total_ref': int(len(ref_all))
    }
    planes = plane_metrics(our, ref)
    heat = None
    if a.heatmap:
        os.makedirs(os.path.dirname(os.path.abspath(a.heatmap)) or '.', exist_ok=True)
        heat = make_heatmap(our_s, dist, a.heatmap)
    report = {
        'schema': 'cloud-diff/1', 'version': VERSION,
        'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'our': a.our, 'ref': a.ref,
        'kinds': {'our': kind_our, 'ref': kind_ref},
        'samples': {'our': int(len(our_s)), 'ref': int(len(ref_s))},
        'bbox_common': [round(float(v), 4) for v in np.concatenate([lo, hi])],
        'up_axis': planes.get('up_axis'),
        'dist_m': stats,
        'planes_mm': {'floor': planes['floor_mm'], 'walls': planes['walls_mm']},
        'heatmap': heat,
        'elapsed_s': round(time.time() - t0, 2)
    }
    print('=== cloud-diff: наше vs эталон ===')
    print('3D-разница: mean %.2f мм | RMSE %.2f мм | медиана %.2f мм | p95 %.2f мм | max %.2f мм' % (
        stats['mean_m'] * 1000, stats['rmse_m'] * 1000, stats['median_m'] * 1000, stats['p95_m'] * 1000, stats['max_m'] * 1000))
    print('в допуске 2 см: %.1f%% | 5 см: %.1f%% | 10 см: %.1f%%' % (
        stats['within_2cm_pct'], stats['within_5cm_pct'], stats['within_10cm_pct']))
    print('RMSE пола, мм: наш %s | эталон %s | d %s' % (planes['floor_mm'].get('our'), planes['floor_mm'].get('ref'), planes['floor_mm'].get('delta')))
    print('RMSE стен, мм: наш %s | эталон %s | d %s' % (planes['walls_mm'].get('our'), planes['walls_mm'].get('ref'), planes['walls_mm'].get('delta')))
    print('время: %.2f с' % report['elapsed_s'])
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
        with open(a.out, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        print('report:', os.path.abspath(a.out))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
