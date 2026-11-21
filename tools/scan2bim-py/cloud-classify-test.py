# -*- coding: utf-8 -*-
"""cloud-classify-test.py — тесты классификатора облака (r189):
  • --max-points на LAS: выходной LAS/JSON/header — ровно N точек (регрессия IndexError
    в write_las_filtered: заголовок исходника n0 > len(cls) при усечённом чтении);
  • без --max-points — полный файл;
  • --max-points + --refine-dynamic (remove_mask короче n0);
  • --max-points + --out-bin;
  • прямой unit write_las_filtered с усечённым массивом классов;
  • реальное облако (если есть) — smoke.
Запуск: python tools/scan2bim-py/cloud-classify-test.py [--real <las>]
"""
import argparse
import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, 'cloud-classify.py')
TMP = tempfile.mkdtemp(prefix='classify-test-')
RESULTS = []


def check(name, fn):
    try:
        fn()
        RESULTS.append((name, 'PASS', ''))
        print('PASS  ' + name)
    except Exception as e:  # noqa: BLE001
        RESULTS.append((name, 'FAIL', str(e)))
        print('FAIL  ' + name + ': ' + str(e)[:400])


def write_las(path, X, rgb=None, scale=0.001):
    """Пишет LAS 1.2 format 3 (34 Б/точка) c int32-координатами и RGB."""
    n = len(X)
    ox, oy, oz = 0.0, 0.0, 0.0
    h = bytearray(375)
    h[0:4] = b'LASF'
    h[24] = 1          # source id
    h[25] = 2          # minor version
    struct.pack_into('<H', h, 94, 375)          # header size
    struct.pack_into('<I', h, 96, 375)          # offset to points
    h[104] = 3                                   # PDRF 3
    struct.pack_into('<H', h, 105, 34)           # record length
    struct.pack_into('<I', h, 107, n)            # legacy point count
    struct.pack_into('<i', h, 111, 0)            # legacy by return 0
    h[131] = 0                                   # scale x/y/z
    h[132] = 0
    h[133] = 0
    struct.pack_into('<d', h, 131, scale)
    struct.pack_into('<d', h, 139, scale)
    struct.pack_into('<d', h, 147, scale)
    struct.pack_into('<d', h, 155, ox)
    struct.pack_into('<d', h, 163, oy)
    struct.pack_into('<d', h, 171, oz)
    struct.pack_into('<d', h, 179, float(X[:, 0].max() * scale))
    struct.pack_into('<d', h, 187, float(X[:, 1].max() * scale))
    struct.pack_into('<d', h, 195, float(X[:, 2].max() * scale))
    struct.pack_into('<d', h, 203, float(X[:, 0].min() * scale))
    struct.pack_into('<d', h, 211, float(X[:, 1].min() * scale))
    struct.pack_into('<d', h, 219, float(X[:, 2].min() * scale))
    body = bytearray()
    inv = 1.0 / scale
    for i in range(n):
        x, y, z = X[i]
        rec = bytearray(34)
        struct.pack_into('<iii', rec, 0, int(round(x * inv)), int(round(y * inv)), int(round(z * inv)))
        struct.pack_into('<H', rec, 12, 100)     # intensity
        rec[14] = 9                              # return bits
        rec[15] = 1                              # classification (unclassified)
        rec[16] = 0                              # scan angle
        rec[17] = i % 32                         # user data
        if rgb is not None:
            r, g, b = rgb[i]
            struct.pack_into('<HHH', rec, 28, int(r) * 257, int(g) * 257, int(b) * 257)
        body += rec
    with open(path, 'wb') as f:
        f.write(bytes(h))
        f.write(body)
    return path


def has_las(path):
    with open(path, 'rb') as f:
        b = f.read(375)
    return b[:4] == b'LASF', struct.unpack_from('<I', b, 107)[0], struct.unpack_from('<I', b, 96)[0], struct.unpack_from('<H', b, 105)[0]


def run_cli(args, timeout=600):
    p = subprocess.run([sys.executable, CLI] + list(args), capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    if p.returncode != 0:
        raise AssertionError('CLI exit %d: %s' % (p.returncode, (p.stderr or p.stdout)[-700:]))
    return p


def make_cloud(n=12000):
    rng = np.random.default_rng(7)
    X = np.zeros((n, 3), np.float32)
    X[:, 0] = rng.uniform(0, 20, n)
    X[:, 1] = rng.uniform(0, 12, n)
    X[:, 2] = rng.uniform(-2, 4, n)
    # плоский пол на z≈0, чтобы классификатор нашёл ground_floor
    X[: n // 2, 2] = 0.0 + rng.normal(0, 0.002, n // 2)
    rgb = rng.integers(20, 240, size=(n, 3), dtype=np.uint8)
    return X, rgb


SRC = os.path.join(TMP, 'cloud.las')
X_ALL, RGB_ALL = make_cloud()
write_las(SRC, X_ALL, RGB_ALL)


def t_max_points(limit=5000):
    out_las = os.path.join(TMP, 'out-5000.las')
    out_json = os.path.join(TMP, 'out-5000.json')
    run_cli([SRC, '--max-points', str(limit), '--out-las', out_las, '--json', out_json])
    ok, n, off, rl = has_las(out_las)
    assert ok and off == 375 and rl == 34, 'LAS header'
    assert n == limit, 'в LAS записано %d точек, ожидалось %d' % (n, limit)
    J = json.load(open(out_json, encoding='utf-8'))
    assert J['format'] == 'las'
    assert J['out_las']['written'] == limit and J['out_las']['removed'] == 0, 'JSON out_las'
    assert isinstance(J.get('classes'), dict) and sum(J['classes'].values()) == limit, 'classes sum'


def t_no_max_points():
    out_las = os.path.join(TMP, 'out-full.las')
    out_json = os.path.join(TMP, 'out-full.json')
    run_cli([SRC, '--out-las', out_las, '--json', out_json])
    ok, n, off, rl = has_las(out_las)
    assert ok, 'LAS header'
    assert n == len(X_ALL), 'в LAS записано %d, ожидалось %d' % (n, len(X_ALL))
    J = json.load(open(out_json, encoding='utf-8'))
    assert J['out_las']['written'] == len(X_ALL), 'JSON out_las'


def t_max_points_refine():
    out_las = os.path.join(TMP, 'out-rm.las')
    out_json = os.path.join(TMP, 'out-rm.json')
    run_cli([SRC, '--max-points', '7000', '--refine-dynamic', '--out-las', out_las, '--json', out_json])
    ok, n, off, rl = has_las(out_las)
    J = json.load(open(out_json, encoding='utf-8'))
    assert J['out_las']['written'] + J['out_las']['removed'] == 7000, 'written+removed != 7000'
    assert n == J['out_las']['written'], 'header != written'


def t_max_points_bin():
    out_bin = os.path.join(TMP, 'out-5000.bin')
    out_json = os.path.join(TMP, 'out-5000-bin.json')
    run_cli([SRC, '--max-points', '5000', '--out-bin', out_bin, '--json', out_json])
    np_bytes = os.path.getsize(out_bin)
    assert np_bytes == 5000 * 8 * 4, 'bin size %d' % np_bytes
    J = json.load(open(out_json, encoding='utf-8'))
    assert J['out_bin']['written'] == 5000, 'JSON out_bin'


def load_mod():
    spec = importlib.util.spec_from_file_location('cloud_classify_mod', CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def t_unit_write_las_truncated():
    mod = load_mod()
    X, rgb, meta = mod.read_las(SRC)
    cls, conf, st = mod.classify(X[:3000], mod.default_opt())
    dst = os.path.join(TMP, 'unit-trunc.las')
    res = mod.write_las_filtered(SRC, X[:3000], cls, conf, dst, remove_mask=None, src_meta=meta)
    ok, n, off, rl = has_las(dst)
    assert ok and n == 3000, 'header %d' % n
    assert res['written'] == 3000 and res['removed'] == 0, 'res %s' % res


REAL = r'D:\BIM-TWIN-TEST\xbin-verify\_frame-test.las'


def t_real_smoke():
    if not os.path.exists(REAL):
        raise AssertionError('SKIP: нет ' + REAL)
    out_las = os.path.join(TMP, 'real-50000.las')
    run_cli([REAL, '--max-points', '50000', '--out-las', out_las, '--json', os.path.join(TMP, 'real.json')])
    ok, n, off, rl = has_las(out_las)
    assert ok and n == 50000, 'real header %d' % n


def main():
    global REAL
    ap = argparse.ArgumentParser()
    ap.add_argument('--real', default=REAL)
    a = ap.parse_args()
    REAL = a.real
    check('--max-points 5000: LAS/header/JSON ровно 5000 точек (был IndexError)', t_max_points)
    check('без --max-points: полный файл (12000)', t_no_max_points)
    check('--max-points + --refine-dynamic: written+removed=7000', t_max_points_refine)
    check('--max-points + --out-bin: 5000 точек * 32 Б', t_max_points_bin)
    check('unit: write_las_filtered с усечённым cls (3000 из 12000)', t_unit_write_las_truncated)
    check('реальное облако: --max-points 50000 (_frame-test.las)', t_real_smoke)
    passed = sum(1 for _, s, _ in RESULTS if s == 'PASS')
    failed = sum(1 for _, s, _ in RESULTS if s == 'FAIL')
    print('')
    print('=== ИТОГ: PASS %d | FAIL %d ===' % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
