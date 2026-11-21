# -*- coding: utf-8 -*-
"""fusion2.py — безопасное сведение проходов (r183, прототип).

Пайплайн:
 1. проходы по времени (окна --pass-sec), hist-сведение: вертикальные плоскости + пол/потолок,
    сдвиг на проход с ограничением --hist-clamp;
 2. перекрытие проходов по вокселям 0.5 м; пары с overlap >= --min-overlap (по умолчанию 0.6);
 3. pairwise ICP point-to-plane (cloud-register.py, mode icp) для пар; фильтр inlier >= --min-inlier,
    наклон <= --max-tilt, yaw <= --max-yaw, сдвиг <= --max-shift;
 4. pose graph 4DoF (yaw+XYZ) взвешенный МНК, приоры 0, якорь первого прохода;
 5. применение поз (поворот вокруг центроида прохода), варианты:
    keep — все точки; mergeNN — снап к центроиду вокселя NN мм; clampNN — ограничение поз NN мм.
Выход: <out>/<variant>.las + metrics.json. Требует numpy и las_tools/las_metrics/cloud-register.py
из tools/scan2bim-py (см. --tools-dir).

Пример:
  python tools/scan2bim-py/fusion2.py --src cloud.las --out D:/tmp/fusion2 --pass-sec 20
"""
import argparse, os, sys, json, math, struct, subprocess, glob
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--pass-sec', type=float, default=20.0)
ap.add_argument('--min-pass', type=int, default=50000)
ap.add_argument('--min-overlap', type=float, default=0.6)
ap.add_argument('--min-inlier', type=float, default=0.4)
ap.add_argument('--max-tilt', type=float, default=2.0)
ap.add_argument('--max-yaw', type=float, default=2.0)
ap.add_argument('--max-shift', type=float, default=0.3)
ap.add_argument('--hist-clamp', type=float, default=0.03)
ap.add_argument('--max-pairs', type=int, default=120)
ap.add_argument('--merge', default='0,0.02')          # мм через запятую; 0 — keep
ap.add_argument('--clamp', default='')                # мм через запятую (ограничение поз)
ap.add_argument('--tools-dir', default=os.path.join(os.path.dirname(os.path.abspath(__file__))))
ap.add_argument('--python', default=sys.executable)
args = ap.parse_args()
sys.path.insert(0, args.tools_dir)
import las_tools as LT
import las_metrics as LM

SRC = args.src; OUT = args.out
TMP = os.path.join(OUT, 'passes'); os.makedirs(TMP, exist_ok=True)

X, Y, Z, T, RGB = [], [], [], [], []
H = LT.read_header(SRC)
for xyz, t, rgb, inten in LT.iter_chunks(SRC, H, chunk=1 << 20):
    X.append(xyz[:, 0]); Y.append(xyz[:, 1]); Z.append(xyz[:, 2]); T.append(t); RGB.append(rgb.astype(np.float32))
P = np.column_stack([np.concatenate(X), np.concatenate(Y), np.concatenate(Z)]).astype(np.float64)
T = np.concatenate(T); RGB = np.concatenate(RGB); n = len(P)
t0 = float(T.min()); pid = np.floor((T - t0) / args.pass_sec).astype(np.int64)
passes = [(int(k), np.nonzero(pid == k)[0]) for k in np.unique(pid) if (pid == k).sum() >= args.min_pass]
if len(passes) < 2:
    print(json.dumps({'ok': False, 'error': 'меньше двух проходов', 'passes': len(passes)})); sys.exit(2)

# ---------- опорные плоскости
sub = P[::60]; planes = []
for pl in LM.wall_planes_ransac({'x': sub[:, 0], 'y': sub[:, 1], 'z': sub[:, 2]}, seed=7, max_planes=20):
    if pl.get('n', 0) > 3000: planes.append({'n': np.array([pl['nx'], pl['ny'], 0.0]), 'c': float(pl['c'])})
hz, he = np.histogram(P[:, 2], bins=400)
kf = int(np.argmax(hz[:200])) + 1; kc = int(np.argmax(hz[200:])) + 200 + 1
planes += [{'n': np.array([0., 0., 1.]), 'c': float(0.5 * (he[kf - 1] + he[kf]))},
           {'n': np.array([0., 0., 1.]), 'c': float(0.5 * (he[kc - 1] + he[kc]))}]

def solve_hist(Q):
    obs = []
    for pl in planes:
        d = pl['n'][0] * Q[:, 0] + pl['n'][1] * Q[:, 1] + pl['n'][2] * Q[:, 2] - pl['c']
        m = np.abs(d) < 0.15
        if m.sum() >= 300: obs.append((pl, float(np.median(d[m]))))
    t = np.zeros(3)
    vert = [(o[0]['n'], o[1]) for o in obs if abs(o[0]['n'][2]) < 0.1]
    hor = [(o[0]['n'], o[1]) for o in obs if abs(o[0]['n'][2]) > 0.9]
    if len(vert) >= 2:
        A = np.array([v[0][:2] for v in vert]); b = np.array([-v[1] for v in vert])
        w = 1.0 / (1.0 + (np.abs(b) / 0.02) ** 2); Aw = A * w[:, None]; bw = b * w
        try: t[:2] = np.linalg.solve(Aw.T @ Aw + np.eye(2) * 1e-9, Aw.T @ bw)
        except np.linalg.LinAlgError: pass
    if hor: t[2] = -float(np.median([h[1] for h in hor]))
    nn = np.linalg.norm(t)
    if nn > args.hist_clamp: t = t / nn * args.hist_clamp
    return t

hist = {k: solve_hist(P[ix][::4]) for k, ix in passes}

# ---------- запись/чтение pass LAS
def write_las(path, Q, C=None, TT=None):
    m = len(Q); rl = 34
    h = bytearray(227); h[0:4] = b'LASF'; h[24] = 1; h[25] = 2
    struct.pack_into('<H', h, 94, 227); struct.pack_into('<I', h, 96, 227); h[104] = 3; struct.pack_into('<H', h, 105, rl)
    struct.pack_into('<I', h, 107, m)
    for i in range(5): struct.pack_into('<I', h, 111 + 4 * i, m if i == 0 else 0)
    sx = 0.001; struct.pack_into('<3d', h, 131, sx, sx, sx); struct.pack_into('<3d', h, 155, 0, 0, 0)
    struct.pack_into('<6d', h, 179, float(Q[:, 0].max()), float(Q[:, 0].min()), float(Q[:, 1].max()), float(Q[:, 1].min()), float(Q[:, 2].max()), float(Q[:, 2].min()))
    with open(path, 'wb') as f:
        f.write(h)
        for s0 in range(0, m, 1 << 20):
            e = min(m, s0 + (1 << 20)); k = e - s0; rec = np.zeros((k, rl), np.uint8)
            rec[:, 0:4] = np.rint(Q[s0:e, 0] / sx).astype('<i4').view(np.uint8).reshape(k, 4)
            rec[:, 4:8] = np.rint(Q[s0:e, 1] / sx).astype('<i4').view(np.uint8).reshape(k, 4)
            rec[:, 8:12] = np.rint(Q[s0:e, 2] / sx).astype('<i4').view(np.uint8).reshape(k, 4)
            rec[:, 12:14] = np.frombuffer(np.uint16(100).tobytes(), np.uint8); rec[:, 14] = 9; rec[:, 17] = np.arange(s0, e) % 32
            if TT is not None: rec[:, 20:28] = TT[s0:e].astype('<f8').view(np.uint8).reshape(k, 8)
            if C is not None:
                for a in range(3): rec[:, 28 + a * 2:28 + a * 2 + 2] = C[s0:e, a].astype('<u2').view(np.uint8).reshape(k, 2)
            f.write(rec.tobytes())

files = {k: write_las(os.path.join(TMP, 'p%03d.las' % k), P[ix] + hist[k], RGB[ix], T[ix]) for k, ix in passes}

# ---------- перекрытие по вокселям 0.5 м
vox = {}
for k, ix in passes:
    c = np.floor((P[ix] + hist[k]) / 0.5).astype(np.int64)
    key = c[:, 0] + 1000000 * (c[:, 1] + 1000000 * c[:, 2])
    vox[k] = set(np.unique(key).tolist())
pairs = []
for a in range(len(passes)):
    for b in range(a + 1, len(passes)):
        ka, kb = passes[a][0], passes[b][0]
        sa, sb = vox[ka], vox[kb]
        ov = len(sa & sb) / max(1, min(len(sa), len(sb)))
        if ov >= args.min_overlap: pairs.append((ka, kb, round(float(ov), 3)))
pairs.sort(key=lambda x: -x[2]); pairs = pairs[:args.max_pairs]

# ---------- pairwise ICP
ICP = os.path.join(args.tools_dir, 'cloud-register.py'); edges = []; edge_stats = []
for (ka, kb, ov) in pairs:
    jf = os.path.join(TMP, 'reg-%03d-%03d.json' % (ka, kb))
    try:
        r = subprocess.run([args.python, ICP, '--ref', files[ka], '--src', files[kb], '--mode', 'icp', '--max-points', '120000', '--out', jf],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0 or not os.path.exists(jf):
            edge_stats.append({'i': ka, 'j': kb, 'ok': False}); continue
        reg = json.load(open(jf, encoding='utf-8')); rr = reg['results'][0]
        M = np.array(rr['matrix']); yaw = math.atan2(M[1, 0], M[0, 0])
        pitch = math.asin(max(-1, min(1, -M[2, 0]))); roll = math.atan2(M[2, 1], M[2, 2])
        tilt = max(abs(pitch), abs(roll)) * 180 / math.pi
        tr = np.array([M[0, 3], M[1, 3], M[2, 3]]); sh = float(np.linalg.norm(tr)); inl = rr['rms']['inlier_ratio']
        ok = inl >= args.min_inlier and tilt <= args.max_tilt and abs(yaw) * 180 / math.pi <= args.max_yaw and sh <= args.max_shift
        if ok: edges.append({'i': ka, 'j': kb, 'yaw': yaw, 't': tr, 'w': inl})
        edge_stats.append({'i': ka, 'j': kb, 'ok': bool(ok), 'inlier': inl, 'yaw_deg': round(yaw * 180 / math.pi, 3), 'tilt_deg': round(tilt, 3), 'shift_mm': round(sh * 1000, 2), 'ov': ov})
    except Exception as e:
        edge_stats.append({'i': ka, 'j': kb, 'ok': False, 'err': str(e)[:120]})

# ---------- pose graph 4DoF
order = [k for k, _ in passes]; idx = {k: i for i, k in enumerate(order)}; N = len(order); NV = 4 * N
A = np.zeros((NV, NV)); b = np.zeros(NV); sw = 1 / 0.02 ** 2; sy = 1 / 0.01 ** 2
def add_eq(coefs, rhs, w):
    for ca, va in coefs:
        b[ca] += w * va * rhs
        for cc, vc in coefs: A[ca, cc] += w * va * vc
for k in order:
    i = idx[k]; add_eq([(4 * i, 1)], 0.0, 100 * sy)
    for a2 in range(3): add_eq([(4 * i + 1 + a2, 1)], 0.0, sw)
anc = idx[order[0]]
for a2 in range(4): add_eq([(4 * anc + a2, 1)], 0.0, 1e6)
for e in edges:
    i, j = idx[e['i']], idx[e['j']]; w = max(0.05, min(1, e['w']))
    add_eq([(4 * j, 1), (4 * i, -1)], e['yaw'], w * sy)
    for a2 in range(3): add_eq([(4 * j + 1 + a2, 1), (4 * i + 1 + a2, -1)], float(e['t'][a2]), w * sw)
X = np.linalg.solve(A + np.eye(NV) * 1e-9, b)
poses = [{'yaw': float(X[4 * i]), 't': X[4 * i + 1:4 * i + 4].copy()} for i in range(N)]

def apply_poses(clamp=None):
    Q = P.copy()
    for k in np.unique(pid):
        ix = np.nonzero(pid == k)[0]
        if len(ix) >= 1000: Q[ix] = P[ix] + hist.get(int(k), np.zeros(3))
    for i in range(N):
        ix = passes[i][1]; pose = poses[i]; tr = pose['t'].copy()
        nn = np.linalg.norm(tr)
        if clamp and nn > clamp: tr = tr / nn * clamp
        cen = Q[ix].mean(axis=0); cy, sy_ = math.cos(pose['yaw']), math.sin(pose['yaw'])
        dx = Q[ix, 0] - cen[0]; dy = Q[ix, 1] - cen[1]
        Q[ix, 0] = cen[0] + cy * dx - sy_ * dy + tr[0]
        Q[ix, 1] = cen[1] + sy_ * dx + cy * dy + tr[1]
        Q[ix, 2] += tr[2]
    return Q

def snap_merge(Q, cell):
    base = Q.min(axis=0)
    c = np.floor((Q - base) / cell).astype(np.int64)
    key = c[:, 0] + 100000 * (c[:, 1] + 100000 * c[:, 2])
    order2 = np.argsort(key, kind='stable'); ks = key[order2]
    uk, starts, counts = np.unique(ks, return_index=True, return_counts=True)
    sumpos = np.zeros((len(uk), 3)); np.add.at(sumpos, np.repeat(np.arange(len(uk)), counts), Q[order2])
    cen = sumpos / counts[:, None]
    out = Q.copy(); out[order2] = np.repeat(cen, counts, axis=0)
    return out

variants = {}
for ms in [v for v in args.merge.split(',') if v]:
    mm = float(ms)
    variants['icp2_keep' if mm <= 0 else 'icp2_merge%d' % round(mm * 1000)] = (apply_poses(), mm)
for ms in [v for v in args.clamp.split(',') if v]:
    mm = float(ms) / 1000.0
    variants['icp2_clamp%d' % round(mm * 1000)] = (apply_poses(mm), 0)
b0 = np.array([P[:, 0].min(), P[:, 1].min(), P[:, 2].min(), P[:, 0].max(), P[:, 1].max(), P[:, 2].max()])
res = {'src': SRC, 'points': int(n), 'passes': len(passes), 'pairs': len(pairs), 'edges': len(edges),
       'hist_max_mm': round(float(max(np.linalg.norm(v) for v in hist.values())) * 1000, 2),
       'hist_median_mm': round(float(np.median([np.linalg.norm(v) for v in hist.values()])) * 1000, 2),
       'edge_stats': edge_stats, 'variants': {}}
for name, (Q, cell) in variants.items():
    if cell > 0: Q = snap_merge(Q, cell)
    b1 = np.array([Q[:, 0].min(), Q[:, 1].min(), Q[:, 2].min(), Q[:, 0].max(), Q[:, 1].max(), Q[:, 2].max()])
    d = float(np.max(np.abs(b1 - b0))) * 1000
    out = os.path.join(OUT, name + '.las'); write_las(out, Q, RGB, T)
    res['variants'][name] = {'path': out, 'bbox_delta_mm': round(d, 2), 'points': int(n), 'cell_mm': round(cell * 1000 if cell > 0 else 0)}
    print(name, json.dumps(res['variants'][name]), flush=True)
json.dump(res, open(os.path.join(OUT, 'metrics-fusion2.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
print(json.dumps({'ok': True, 'out': OUT, 'variants': list(variants)}), flush=True)
