# -*- coding: utf-8 -*-
"""cloud-register.py — P1 «Совмещение облаков / ICP / GCP» для приложения BIM Twin.

Регистрирует исходное облако (--src) к эталонному (--ref) и выдаёт матрицу 4×4,
поворот/сдвиг, RMS, inlier-ratio, число итераций; умеет пересчитать src в координаты ref
и записать LAS/PLY (--out-las). Режимы:

  --mode icp           многомасштабный point-to-plane ICP (Open3D), опционально авто-инициализация
                       FPFH+RANSAC (--auto-init) или из --init-matrix;
  --mode manual-points 3+ пар точек (JSON/CSV): жёсткая трансформация Kabsch (МНК) + пересчёт;
  --mode gcp           CSV контрольных точек с координатами (те же пары; при необходимости
                       lon/lat/alt → UTM через --epsg, формулы из georef-rtk.py).

Входы: LAS/LAZ-как-LAS (.las, .bin LAS-чанк), PLY (.ply). Для больших файлов — блочный
равномерный сэмпл (--max-points) и кроп (--crop xmin,ymin,zmin,xmax,ymax,zmax).

Выход: JSON (--out): mode, matrix4x4, rotation_deg (yaw+euler), translation, rms, inlier_ratio,
iterations, fitness, n_ref/n_src, thresholds, ok/strict; --out-las — пересчитанное src.

--strict: exit 1 при RMS > порога (icp: 0.05 м; gcp/manual-points: 0.15 м); exit 2 при
<3 парах/ошибке входа.

Примеры:
  python tools/scan2bim-py/cloud-register.py --ref ref.las --src src.las --mode icp \
         --out reg.json --out-las src-registered.las --auto-init --strict
  python tools/scan2bim-py/cloud-register.py --ref ref.las --src src.las \
         --mode manual-points --pairs pairs.csv --out reg.json --strict
  python tools/scan2bim-py/cloud-register.py --ref ref.las --src src.las \
         --mode gcp --pairs gcp.csv --epsg 32636 --out reg.json
"""
import argparse
import json
import math
import os
import struct
import sys
import time

import numpy as np

try:
    import open3d as o3d
except Exception:  # pragma: no cover
    o3d = None

STRICT_RMS = {'icp': 0.05, 'manual-points': 0.15, 'gcp': 0.15}


# ============================ LAS ============================
def read_las_header(path):
    with open(path, 'rb') as f:
        h = f.read(375)
    if h[:4] != b'LASF':
        raise ValueError('не LAS: ' + path)
    ver = (h[24], h[25])
    hsize = struct.unpack_from('<H', h, 94)[0]
    off = struct.unpack_from('<I', h, 96)[0]
    fmt = h[104] & 0x3F
    rl = struct.unpack_from('<H', h, 105)[0]
    n = struct.unpack_from('<I', h, 107)[0]
    if ver >= (1, 4) and hsize >= 375:
        n14 = struct.unpack_from('<Q', h, 247)[0]
        if n14:
            n = n14
    scale = struct.unpack_from('<ddd', h, 131)
    offset = struct.unpack_from('<ddd', h, 155)
    bbox = struct.unpack_from('<dddddd', h, 179)  # maxx, minx, maxy, miny, maxz, minz
    t_off = 20 if fmt in (1, 3, 4, 5, 10) else None
    rgb_off = 28 if fmt in (2, 3, 5, 7, 8, 10) else None
    return {'path': path, 'ver': ver, 'hsize': hsize, 'off': off, 'fmt': fmt, 'rl': rl,
            'n': int(n), 'scale': scale, 'offset': offset,
            'bbox': (bbox[1], bbox[3], bbox[5], bbox[0], bbox[2], bbox[4]),
            't_off': t_off, 'rgb_off': rgb_off, 'size': os.path.getsize(path)}


def _decode_xyz(rec, H):
    c = len(rec)
    X = rec[:, 0:4].copy().view('<i4').reshape(c).astype(np.float64)
    Y = rec[:, 4:8].copy().view('<i4').reshape(c).astype(np.float64)
    Z = rec[:, 8:12].copy().view('<i4').reshape(c).astype(np.float64)
    sx, sy, sz = H['scale']
    ox, oy, oz = H['offset']
    return np.column_stack([X * sx + ox, Y * sy + oy, Z * sz + oz])


def load_las_sample(path, crop=None, max_pts=1_500_000):
    """Блочный равномерный сэмпл LAS; опционально кроп по bbox."""
    H = read_las_header(path)
    n, rl = H['n'], H['rl']
    need = min(n, max_pts)
    block = 20000
    nblocks = max(1, n // block)
    frac = need / n
    step_blocks = max(1, int(round(1.0 / frac))) if frac < 1.0 else 1
    xs = []
    got = 0
    with open(path, 'rb') as f:
        b = 0
        while b < nblocks and got < need:
            start = b * block
            cnt = min(block, n - start)
            f.seek(H['off'] + start * rl)
            buf = f.read(cnt * rl)
            if len(buf) < cnt * rl:
                break
            rec = np.frombuffer(buf, dtype=np.uint8).reshape(cnt, rl)
            xyz = _decode_xyz(rec, H)
            if crop is not None:
                x0, y0, z0, x1, y1, z1 = crop
                m = ((xyz[:, 0] >= x0) & (xyz[:, 0] <= x1) & (xyz[:, 1] >= y0) &
                     (xyz[:, 1] <= y1) & (xyz[:, 2] >= z0) & (xyz[:, 2] <= z1))
                xyz = xyz[m]
            if len(xyz):
                xs.append(xyz)
                got += len(xyz)
            b += step_blocks
    if not xs:
        return np.zeros((0, 3), np.float64), H
    P = np.concatenate(xs)
    est_total = int(round(len(P) * step_blocks))
    return P, {'header': H, 'sampled': len(P), 'step_blocks': step_blocks,
               'estimated_in_region': est_total}


def load_cloud(path, crop=None, max_pts=1_500_000):
    """LAS/PLY → (N,3) xyz. Возвращает (points, info)."""
    low = path.lower()
    if low.endswith('.ply'):
        if o3d is None:
            raise RuntimeError('PLY: нужен open3d')
        pc = o3d.io.read_point_cloud(path)
        P = np.asarray(pc.points, dtype=np.float64)
        if crop is not None:
            x0, y0, z0, x1, y1, z1 = crop
            m = ((P[:, 0] >= x0) & (P[:, 0] <= x1) & (P[:, 1] >= y0) & (P[:, 1] <= y1) &
                 (P[:, 2] >= z0) & (P[:, 2] <= z1))
            P = P[m]
        if len(P) > max_pts:
            idx = np.linspace(0, len(P) - 1, max_pts).astype(np.int64)
            P = P[idx]
        return P, {'format': 'ply', 'sampled': len(P), 'file': path}
    # LAS (.las/.laz-как-LAS/.bin-чанк начинается с LASF)
    P, info = load_las_sample(path, crop, max_pts)
    return P, {'format': 'las', 'sampled': len(P), 'file': path,
               'n_total': info['header']['n'], 'bbox': list(info['header']['bbox']),
               'estimated_in_region': info['estimated_in_region']}


# ============================ write ============================
def write_las(path, pts, src_path=None, rgb=None):
    """Пишет LAS 1.2 формат 3 (XYZ + интенсивность 0 + RGB если есть)."""
    pts = np.asarray(pts, dtype=np.float64)
    n = len(pts)
    mn = pts.min(axis=0) if n else np.zeros(3)
    mx = pts.max(axis=0) if n else np.zeros(3)
    off = (np.floor(mn / 1000.0) * 1000 if False else np.floor(mn)).astype(np.float64)
    scale = (0.001, 0.001, 0.001)
    hsize = 375
    rec = 34
    offbytes = hsize
    h = bytearray(375)
    h[0:4] = b'LASF'
    h[24] = 1; h[25] = 2
    struct.pack_into('<H', h, 90, 0)      # day
    struct.pack_into('<H', h, 92, 2026)   # year
    struct.pack_into('<H', h, 94, hsize)
    struct.pack_into('<I', h, 96, offbytes)
    struct.pack_into('<I', h, 100, 0)     # VLR
    h[104] = 3                            # fmt 3
    struct.pack_into('<H', h, 105, rec)
    struct.pack_into('<I', h, 107, n)
    struct.pack_into('<ddd', h, 131, *scale)
    struct.pack_into('<ddd', h, 155, *off)
    struct.pack_into('<dddddd', h, 179, mx[0], mn[0], mx[1], mn[1], mx[2], mn[2])
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(bytes(h))
        B = 1 << 16
        for i0 in range(0, n, B):
            c = min(B, n - i0)
            buf = bytearray(c * rec)
            p = pts[i0:i0 + c]
            ix = np.round((p[:, 0] - off[0]) / scale[0]).astype(np.int64)
            iy = np.round((p[:, 1] - off[1]) / scale[1]).astype(np.int64)
            iz = np.round((p[:, 2] - off[2]) / scale[2]).astype(np.int64)
            for k in range(c):
                q = k * rec
                struct.pack_into('<3i', buf, q, int(ix[k]), int(iy[k]), int(iz[k]))
                struct.pack_into('<H', buf, q + 12, 0)      # intensity
                buf[q + 14] = 0x09
                struct.pack_into('<H', buf, q + 18, 0)      # scan angle/ring
                struct.pack_into('<d', buf, q + 20, 0.0)    # time
                if rgb is not None:
                    r, g, b = rgb[i0 + k]
                    struct.pack_into('<HHH', buf, q + 28, int(r) * 257, int(g) * 257, int(b) * 257)
            f.write(bytes(buf))
    os.replace(tmp, path)
    return {'file': path, 'points': n}


# ============================ math ============================
def kabsch(src, dst, fit_scale=False):
    """Жёсткая (или с масштабом) трансформация src→dst: R,t (и s)."""
    A = np.asarray(src, dtype=np.float64); B = np.asarray(dst, dtype=np.float64)
    ca, cb = A.mean(axis=0), B.mean(axis=0)
    Ac, Bc = A - ca, B - cb
    H = Ac.T @ Bc
    U, S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    if fit_scale:
        s = float((S @ np.array([1.0, 1.0, d])) / max((Ac ** 2).sum(), 1e-12))
    else:
        s = 1.0
    t = cb - s * (R @ ca)
    T = np.eye(4)
    T[:3, :3] = s * R
    T[:3, 3] = t
    return T, s


def apply(T, P):
    return (np.asarray(P) @ T[:3, :3].T) + T[:3, 3]


def rotation_report(T):
    R = T[:3, :3]
    s = float(np.cbrt(np.linalg.det(R)))
    Rn = R / s if s != 0 else R
    yaw = math.degrees(math.atan2(Rn[1, 0], Rn[0, 0]))
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -Rn[2, 0]))))
    roll = math.degrees(math.atan2(Rn[2, 1], Rn[2, 2]))
    tr = T[:3, 3]
    return {'yaw_deg': round(yaw, 6), 'pitch_deg': round(pitch, 6), 'roll_deg': round(roll, 6),
            'rotation_deg': round(yaw, 6), 'scale': round(s, 8),
            'translation': [round(float(v), 6) for v in tr]}


def rms_report(T, src, ref, inlier_dist=0.10):
    """RMS и inlier-ratio пересчитанного src относительно ref (KD-tree)."""
    Ps = apply(T, src)
    if o3d is None or len(ref) == 0 or len(Ps) == 0:
        return None
    pc_ref = o3d.geometry.PointCloud()
    pc_ref.points = o3d.utility.Vector3dVector(np.asarray(ref, dtype=np.float64))
    kd = o3d.geometry.KDTreeFlann(pc_ref)
    ds = []
    step = max(1, len(Ps) // 200_000)
    for p in Ps[::step]:
        k, idx, d2 = kd.search_knn_vector_3d(p, 1)
        if k > 0:
            ds.append(math.sqrt(d2[0]))
    if not ds:
        return None
    ds = np.asarray(ds)
    inl = ds <= inlier_dist
    rms_in = float(np.sqrt(np.mean(ds[inl] ** 2))) if inl.any() else float('nan')
    return {'rms_m': round(float(np.sqrt(np.mean(ds ** 2))), 5),
            'rms_inlier_m': round(rms_in, 5) if not math.isnan(rms_in) else None,
            'mean_m': round(float(ds.mean()), 5),
            'median_m': round(float(np.median(ds)), 5),
            'inlier_ratio': round(float(inl.mean()), 4),
            'inlier_dist_m': inlier_dist,
            'n_eval': int(len(ds))}


# ============================ ICP ============================
def make_pc(P):
    pc = o3d.geometry.PointCloud()
    pc.points = o3d.utility.Vector3dVector(np.asarray(P, dtype=np.float64))
    return pc


def icp_register(ref, src, auto_init=False, init_matrix=None, max_iter=60, verbose=False):
    """Многомасштабный point-to-plane ICP. Возвращает (T, info)."""
    if o3d is None:
        raise RuntimeError('ICP: нужен open3d')
    t0 = time.time()
    ext = max(1.0, float(np.ptp(ref, axis=0).max()))
    scales = [max(1.0, ext / 25.0), max(0.5, ext / 50.0), max(0.25, ext / 100.0), 0.10]
    scales = sorted({round(s, 3) for s in scales if s >= 0.05}, reverse=True)
    ref_pc = make_pc(ref)
    src_pc = make_pc(src)
    T = np.eye(4)
    if init_matrix is not None:
        T = np.asarray(init_matrix, dtype=np.float64).reshape(4, 4)
    elif auto_init:
        coarse = scales[0]
        ref_d = ref_pc.voxel_down_sample(coarse)
        src_d = src_pc.voxel_down_sample(coarse)
        rad = coarse * 2.5
        for pc in (ref_d, src_d):
            pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=rad, max_nn=40))
        f_ref = o3d.pipelines.registration.compute_fpfh_feature(
            ref_d, o3d.geometry.KDTreeSearchParamHybrid(radius=rad * 2.0, max_nn=100))
        f_src = o3d.pipelines.registration.compute_fpfh_feature(
            src_d, o3d.geometry.KDTreeSearchParamHybrid(radius=rad * 2.0, max_nn=100))
        result = o3d.pipelines.registration.registration_ransac_based_on_feature_matching(
            src_d, ref_d, f_src, f_ref, True, coarse * 1.5,
            o3d.pipelines.registration.TransformationEstimationPointToPoint(False), 3,
            [o3d.pipelines.registration.CorrespondenceCheckerBasedOnEdgeLength(0.9),
             o3d.pipelines.registration.CorrespondenceCheckerBasedOnDistance(coarse * 1.5)],
            o3d.pipelines.registration.RANSACConvergenceCriteria(100000, 0.999))
        T = np.asarray(result.transformation, dtype=np.float64)
        if verbose:
            print('FPFH+RANSAC: fitness %.3f rmse %.4f' % (result.fitness, result.inlier_rmse))
    total_iter = 0
    history = []
    for scale in scales:
        ref_d = ref_pc.voxel_down_sample(scale)
        src_d = src_pc.voxel_down_sample(scale)
        rad = scale * 2.5
        ref_d.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=rad, max_nn=30))
        src_d.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=rad, max_nn=30))
        # point-to-plane требует нормали у target (ref); src — можно point-to-point оценкой по нормалям
        est = o3d.pipelines.registration.TransformationEstimationPointToPlane()
        crit = o3d.pipelines.registration.ICPConvergenceCriteria(
            relative_fitness=1e-6, relative_rmse=1e-6, max_iteration=max_iter)
        res = o3d.pipelines.registration.registration_icp(src_d, ref_d, scale * 2.0, T, est, crit)
        T = np.asarray(res.transformation, dtype=np.float64)
        total_iter += max_iter
        history.append({'scale': scale, 'fitness': round(float(res.fitness), 5),
                        'inlier_rmse': round(float(res.inlier_rmse), 5)})
        if verbose:
            print('ICP scale %.2f: fitness %.3f rmse %.4f' % (scale, res.fitness, res.inlier_rmse))
    return T, {'scales': scales, 'iterations': total_iter, 'history': history,
               'auto_init': bool(auto_init), 'seconds': round(time.time() - t0, 2)}


# ============================ pairs ============================
def load_pairs(path, epsg=None):
    """CSV/JSON пары: src xyz → ref xyz (или ref lon/lat/alt при --epsg)."""
    ext = os.path.splitext(path)[1].lower()
    pairs = []
    if ext == '.json':
        data = json.load(open(path, encoding='utf-8-sig'))
        raw = data.get('pairs') if isinstance(data, dict) else data
        for p in raw:
            a = p.get('src') or p.get('local') or p.get('source')
            b = p.get('ref') or p.get('global') or p.get('target')
            if not a or not b:
                raise ValueError('JSON-пара без src/ref')
            pairs.append({'id': str(p.get('id', len(pairs) + 1)),
                          'src': [float(v) for v in a[:3]], 'ref': [float(v) for v in b[:3]]})
        return pairs, data.get('source') if isinstance(data, dict) else None
    # CSV: id?, x_src,y_src,z_src, x_ref,y_ref,z_ref
    for line in open(path, encoding='utf-8-sig', errors='replace'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = [p.strip() for p in line.replace(';', ',').split(',')]
        vals = []
        for p in parts:
            try:
                vals.append(float(p))
            except ValueError:
                pass
        if len(vals) < 6:
            continue
        src = vals[0:3]
        ref = vals[3:6]
        if epsg and abs(ref[0]) <= 180.0 and abs(ref[1]) <= 90.0:
            # ref задан как lon,lat,alt → UTM
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                'georef_rtk', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'georef-rtk.py'))
            G = importlib.util.module_from_spec(spec); spec.loader.exec_module(G)
            zone, datum, hemi = G.datum_of_epsg(int(epsg))
            if zone is None:
                raise ValueError('--epsg: поддерживаются 258xx/326xx')
            e, n = G.utm_forward(ref[1], ref[0], zone, datum)
            ref = [e, n, ref[2]]
        pairs.append({'id': str(len(pairs) + 1), 'src': src, 'ref': ref})
    return pairs, 'csv'


def fit_pairs(pairs):
    src = np.array([p['src'] for p in pairs], dtype=np.float64)
    dst = np.array([p['ref'] for p in pairs], dtype=np.float64)
    T, s = kabsch(src, dst)
    pred = apply(T, src)
    d = np.linalg.norm(pred - dst, axis=1)
    rms = float(np.sqrt(np.mean(d ** 2)))
    return T, {'rms_m': round(rms, 5), 'max_m': round(float(d.max()), 5),
               'residuals_m': [round(float(v), 5) for v in d],
               'rms_2d_m': round(float(np.sqrt(np.mean(np.linalg.norm(pred[:, :2] - dst[:, :2], axis=1) ** 2))), 5),
               'scale_fit': round(s, 8), 'n_pairs': len(pairs)}


# ============================ main ============================
def main(argv=None):
    ap = argparse.ArgumentParser(description='Совмещение облаков (ICP / manual-points / GCP), P1')
    ap.add_argument('--ref', required=True, help='эталонное облако LAS/PLY')
    ap.add_argument('--src', required=True, nargs='+', help='исходное(ые) облако(а) LAS/PLY')
    ap.add_argument('--mode', default='icp', choices=['icp', 'manual-points', 'gcp'])
    ap.add_argument('--pairs', default=None, help='JSON/CSV пар точек (manual-points/gcp)')
    ap.add_argument('--init-matrix', default=None, help='JSON/CSV 16 чисел — начальная матрица 4x4')
    ap.add_argument('--auto-init', action='store_true', help='FPFH+RANSAC авто-инициализация ICP')
    ap.add_argument('--crop', default=None, help='xmin,ymin,zmin,xmax,ymax,zmax — общий кроп')
    ap.add_argument('--max-points', type=int, default=1_500_000)
    ap.add_argument('--max-iter', type=int, default=60)
    ap.add_argument('--epsg', default=None, help='EPSG для GCP lon/lat/alt (32636 и т.п.)')
    ap.add_argument('--out', default='cloud-register.json')
    ap.add_argument('--out-las', default=None, help='пересчитанное src в координатах ref (LAS/PLY)')
    ap.add_argument('--strict', action='store_true')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args(argv)
    t0 = time.time()
    crop = None
    if a.crop:
        v = [float(x) for x in a.crop.replace(';', ',').split(',')]
        if len(v) != 6:
            print('--crop: нужно 6 чисел', file=sys.stderr); return 2
        crop = tuple(v[:3] + v[3:])
    # ---- данные ----
    try:
        refP, ref_info = load_cloud(a.ref, crop, a.max_points)
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА чтения --ref: %s' % e, file=sys.stderr); return 2
    if len(refP) < 1000:
        print('ОШИБКА: в --ref мало точек (%d)' % len(refP), file=sys.stderr); return 2
    init_matrix = None
    if a.init_matrix:
        txt = a.init_matrix
        if os.path.exists(txt):
            txt = open(txt, encoding='utf-8').read()
        vals = [float(x) for x in txt.replace(';', ',').replace('[', '').replace(']', '')
                .replace('\n', ',').split(',') if x.strip() != '']
        if len(vals) == 16:
            init_matrix = np.array(vals).reshape(4, 4)
    report = {'schema': 'cloud-register/1', 'mode': a.mode,
              'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
              'ref': {'file': a.ref, **ref_info}, 'src': [], 'results': [],
              'strict': bool(a.strict), 'ok': True}
    # ---- пары (manual-points / gcp) ----
    pairs = None
    pairs_info = None
    if a.mode in ('manual-points', 'gcp'):
        if not a.pairs:
            print('ОШИБКА: для %s нужен --pairs' % a.mode, file=sys.stderr); return 2
        try:
            pairs, pairs_source = load_pairs(a.pairs, a.epsg)
        except Exception as e:  # noqa: BLE001
            print('ОШИБКА чтения пар: %s' % e, file=sys.stderr); return 2
        if len(pairs) < 3:
            print('ОШИБКА: пар %d < 3 — нельзя оценить трансформацию' % len(pairs), file=sys.stderr)
            report['ok'] = False
            report['error'] = 'pairs %d < 3' % len(pairs)
            json.dump(report, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            return 2
        T_pairs, pairs_fit = fit_pairs(pairs)
        pairs_info = {'file': a.pairs, 'source': pairs_source, 'n_pairs': len(pairs),
                      'fit': pairs_fit, 'pairs': pairs}
        report['pairs'] = pairs_info
    # ---- по каждому src ----
    out_clouds = []
    for si, src_path in enumerate(a.src):
        try:
            srcP, src_info = load_cloud(src_path, crop, a.max_points)
        except Exception as e:  # noqa: BLE001
            print('ОШИБКА чтения --src %s: %s' % (src_path, e), file=sys.stderr); return 2
        if len(srcP) < 1000:
            print('ОШИБКА: в --src мало точек (%d)' % len(srcP), file=sys.stderr); return 2
        report['src'].append({'file': src_path, **src_info})
        if a.mode == 'icp':
            try:
                T, info = icp_register(refP, srcP, auto_init=a.auto_init,
                                       init_matrix=init_matrix, max_iter=a.max_iter,
                                       verbose=a.verbose)
            except Exception as e:  # noqa: BLE001
                print('ОШИБКА ICP: %s' % e, file=sys.stderr); return 2
            rr = rms_report(T, srcP, refP, 0.10)
            rms = rr['rms_inlier_m'] if rr and rr['rms_inlier_m'] is not None else (rr['rms_m'] if rr else None)
            res = {'src': src_path, 'matrix': [[round(float(v), 8) for v in row] for row in T],
                   'transform': rotation_report(T), 'rms': rr, 'iterations': info['iterations'],
                   'scales': info['scales'], 'history': info['history'],
                   'auto_init': info['auto_init'], 'seconds': info['seconds'],
                   'shape': {'ref_points': int(len(refP)), 'src_points': int(len(srcP))}}
        else:
            T = T_pairs.copy()
            # при желании можно уточнить ICP: --refine  (не документировано отдельно,
            # используем --auto-init в паре с --mode manual-points? нет: только чистый Kabsch)
            rr = rms_report(T, srcP, refP, 0.10) if a.verbose or True else None
            res = {'src': src_path, 'matrix': [[round(float(v), 8) for v in row] for row in T],
                   'transform': rotation_report(T), 'rms': rr,
                   'pairs_fit': pairs_info['fit'],
                   'shape': {'ref_points': int(len(refP)), 'src_points': int(len(srcP))}}
        # строгий порог
        strict_thr = STRICT_RMS[a.mode]
        check_val = res['pairs_fit']['rms_m'] if a.mode in ('manual-points', 'gcp') else (
            res['rms']['rms_inlier_m'] if res['rms'] and res['rms']['rms_inlier_m'] is not None
            else (res['rms']['rms_m'] if res['rms'] else None))
        res['strict_threshold_m'] = strict_thr
        res['strict_pass'] = check_val is not None and check_val <= strict_thr
        if not res['strict_pass']:
            report['ok'] = False
        report['results'].append(res)
        out_clouds.append((src_path, T))
    report['elapsed_s'] = round(time.time() - t0, 2)
    # ---- запись пересчитанного облака ----
    written = []
    if a.out_las and out_clouds:
        src_path, T = out_clouds[0]
        try:
            P, _ = load_cloud(src_path, crop, 20_000_000)   # для записи — плотнее
            Pt = apply(T, P)
            if a.out_las.lower().endswith('.ply'):
                if o3d is None:
                    raise RuntimeError('PLY: нужен open3d')
                pc = o3d.geometry.PointCloud()
                pc.points = o3d.utility.Vector3dVector(Pt)
                o3d.io.write_point_cloud(a.out_las, pc)
                written.append({'file': a.out_las, 'points': int(len(Pt)), 'format': 'ply'})
            else:
                written.append(write_las(a.out_las, Pt))
        except Exception as e:  # noqa: BLE001
            print('ОШИБКА записи --out-las: %s' % e, file=sys.stderr)
            report['ok'] = False
    report['out_las'] = written
    # ---- вывод ----
    print('=== cloud-register: mode=%s ===' % a.mode)
    print('ref: %s (%d точек в сэмпле)' % (os.path.basename(a.ref), len(refP)))
    for res in report['results']:
        tr = res['transform']
        print('src: %s (%d точек)' % (os.path.basename(res['src']), res['shape']['src_points']))
        print('  поворот: yaw %.4f° | сдвиг [%.4f, %.4f, %.4f] м | масштаб %.6f' % (
            tr['yaw_deg'], *tr['translation'], tr['scale']))
        if res.get('rms') and res['rms'].get('rms_inlier_m') is not None:
            print('  RMS(inlier) %.4f м | RMS %.4f м | inlier %d%% | итераций %s' % (
                res['rms']['rms_inlier_m'], res['rms']['rms_m'],
                int(round(100 * res['rms']['inlier_ratio'])), res.get('iterations', '—')))
        if a.mode != 'icp' and res.get('pairs_fit'):
            pf = res['pairs_fit']
            print('  пары: %d | RMS %.4f м | max %.4f м' % (pf['n_pairs'], pf['rms_m'], pf['max_m']))
        print('  strict(%s, %.2f м): %s' % (a.mode, res['strict_threshold_m'],
                                            'PASS' if res['strict_pass'] else 'FAIL'))
    if written:
        print('записано облако: %s (%d точек)' % (written[0]['file'], written[0]['points']))
    print('время: %.2f с' % report['elapsed_s'])
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print('JSON:', os.path.abspath(a.out))
    if not report['ok'] and a.strict:
        return 1
    if not report['ok']:
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
