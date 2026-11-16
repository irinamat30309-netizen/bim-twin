# -*- coding: utf-8 -*-
"""cloud-register-test.py — тест P1 «Совмещение облаков / ICP / GCP» (r149).

1) Синтетика: эталонное облако (асимметричная сцена: пол, 3 стены под разными углами,
   4 столба), src = известная трансформация (yaw 4°, сдвиг [0.8,-0.5,0.15]) + шум 1–2 см.
   Проверка ICP: Δyaw ≤0.05°, Δсдвига ≤2 см, RMS ≤2 см.
2) manual-points: 6 пар (src↔ref) с шумом 1–2 см → Kabsch: те же допуски; отказ при <3 парах
   (exit 2); выброс 0.5 м → --strict exit 1, без strict ok.
3) gcp: CSV пар → те же допуски, strict-порог 0.15 м.
4) Реальные данные (кроп 20×20 м): интерьер (Lixel map.las + наша сборка), фасад
   (D:\\Skan\\port\\map.las + наш фасад) — RMS и время ICP.

Запуск: python tools/scan2bim-py/cloud-register-test.py [--skip-real]
"""
import argparse
import importlib.util
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CHK = {'pass': 0, 'fail': 0, 'skip': 0}


def check(name, cond, detail=''):
    if cond:
        CHK['pass'] += 1
        print('  PASS  %s %s' % (name, detail))
    else:
        CHK['fail'] += 1
        print('  FAIL  %s %s' % (name, detail))


def skip(name, why):
    CHK['skip'] += 1
    print('  SKIP  %s (%s)' % (name, why))


def load_tool():
    spec = importlib.util.spec_from_file_location('cloud_register', os.path.join(HERE, 'cloud-register.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run_cli(script, args, timeout=900):
    return subprocess.run([sys.executable, os.path.join(HERE, script)] + args,
                          capture_output=True, text=True, timeout=timeout)


# ---------------- synthetic scene ----------------
def make_scene(n=120000, seed=1):
    rng = np.random.default_rng(seed)
    pts = []
    # пол 10×8 м
    pts.append(np.column_stack([rng.uniform(-5, 5, n // 3), rng.uniform(-4, 4, n // 3),
                                np.zeros(n // 3)]))
    # стены (плоскости) под разными углами и на разных расстояниях
    for ang, dist, h in ((0, -4.0, 3.0), (math.radians(35), 4.2, 2.6),
                         (math.radians(-20), -4.8, 2.2)):
        k = n // 6
        s = rng.uniform(-4, 4, k)
        z = rng.uniform(0, h, k)
        u = np.array([math.cos(ang), math.sin(ang), 0.0])
        nvec = np.array([-math.sin(ang), math.cos(ang), 0.0])
        p = u[None, :] * s[:, None] + nvec[None, :] * dist + np.array([0, 0, 1])[None, :] * z[:, None]
        pts.append(p)
    # столбы 0.3×0.3
    for cx, cy in ((-3.0, 1.5), (2.2, -2.0), (3.4, 2.6), (-1.8, -3.2)):
        k = n // 12
        a = rng.uniform(0, 2 * math.pi, k)
        pts.append(np.column_stack([cx + 0.15 * np.cos(a), cy + 0.15 * np.sin(a),
                                    rng.uniform(0, 2.8, k)]))
    P = np.vstack(pts)
    rng.shuffle(P)
    return P


def transform_matrix(yaw_deg, t):
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    T = np.eye(4)
    T[:2, :2] = [[c, -s], [s, c]]
    T[:3, 3] = t
    return T


def apply(T, P):
    return (P @ T[:3, :3].T) + T[:3, 3]


def inv(Tm):
    R = Tm[:3, :3]; t = Tm[:3, 3]
    Ti = np.eye(4)
    Ti[:3, :3] = R.T
    Ti[:3, 3] = -R.T @ t
    return Ti


def rot_err_deg(Ta, Tb):
    R = Ta[:3, :3] @ Tb[:3, :3].T
    c = (np.trace(R) - 1.0) / 2.0
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


# ---------------- tests ----------------
def test_synthetic(CR, tmp):
    print('\n=== 1. Синтетика: ICP с авто-инициализацией (шум 1–2 см) ===')
    ref = make_scene(150000)
    G = transform_matrix(4.0, np.array([0.8, -0.5, 0.15]))
    rng = np.random.default_rng(7)
    src = apply(G, ref) + rng.normal(0, 0.012, ref.shape)
    ref_las = os.path.join(tmp, 'syn-ref.las')
    src_las = os.path.join(tmp, 'syn-src.las')
    CR.write_las(ref_las, ref)
    CR.write_las(src_las, src)
    out = os.path.join(tmp, 'syn-icp.json')
    t0 = time.time()
    r = run_cli('cloud-register.py', ['--ref', ref_las, '--src', src_las, '--mode', 'icp',
                                      '--auto-init', '--out', out, '--strict',
                                      '--max-points', '400000', '--out-las',
                                      os.path.join(tmp, 'syn-src-reg.las')])
    dt = time.time() - t0
    check('ICP CLI exit 0', r.returncode == 0, 'code=%d %s' % (r.returncode, r.stderr.strip()[:140]))
    if not os.path.exists(out):
        return
    rep = json.load(open(out, encoding='utf-8'))
    T = np.array(rep['results'][0]['matrix'])
    T_true = inv(G)
    dr = rot_err_deg(T, T_true)
    dshift = float(np.linalg.norm(T[:3, 3] - T_true[:3, 3]))
    rr = rep['results'][0]['rms']
    rms = rr['rms_inlier_m'] if rr.get('rms_inlier_m') is not None else rr['rms_m']
    check('Δповорота ≤0.05°', dr <= 0.05, 'Δ=%.4f°' % dr)
    check('Δсдвига ≤2 см', dshift <= 0.02, 'Δ=%.1f мм' % (dshift * 1000))
    check('RMS ≤2 см', rms <= 0.02, 'RMS=%.1f мм (inlier %.0f%%)' % (
        rms * 1000, 100 * rr['inlier_ratio']))
    print('  ICP: Δyaw=%.4f°, Δshift=%.1f мм, RMS=%.1f мм, время %.1f с' % (
        dr, dshift * 1000, rms * 1000, dt))


def test_manual_points(CR, tmp):
    print('\n=== 2. manual-points: 3+ пары (шум 1–2 см), отказ <3 пар, strict ===')
    ref = make_scene(40000, seed=3)
    ref[:, :2] *= 2.0
    G = transform_matrix(-2.5, np.array([0.3, 0.6, -0.2]))
    Ti = inv(G)
    rng = np.random.default_rng(11)
    # пары: src = G(ref) (+шум) ↔ ref
    idx = rng.choice(len(ref), 20, replace=False)
    pairs = []
    for i, k in enumerate(idx):
        pr = ref[k]
        ps = apply(G, pr[None, :])[0] + rng.normal(0, 0.010, 3)
        pairs.append({'id': 'P%d' % i, 'src': [round(float(v), 5) for v in ps],
                      'ref': [round(float(v), 5) for v in pr]})
    ref_las = os.path.join(tmp, 'mp-ref.las')
    src_las = os.path.join(tmp, 'mp-src.las')
    CR.write_las(ref_las, ref)
    CR.write_las(src_las, apply(G, ref) + rng.normal(0, 0.012, ref.shape))
    pairs_json = os.path.join(tmp, 'mp-pairs.json')
    json.dump({'pairs': pairs, 'source': 'synthetic 6 pairs'}, open(pairs_json, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    out = os.path.join(tmp, 'mp.json')
    r = run_cli('cloud-register.py', ['--ref', ref_las, '--src', src_las, '--mode',
                                      'manual-points', '--pairs', pairs_json, '--out', out,
                                      '--strict', '--max-points', '200000'])
    check('manual-points CLI exit 0', r.returncode == 0, 'code=%d %s' % (r.returncode, r.stderr.strip()[:120]))
    if os.path.exists(out):
        rep = json.load(open(out, encoding='utf-8'))
        T = np.array(rep['results'][0]['matrix'])
        dr = rot_err_deg(T, Ti)
        dshift = float(np.linalg.norm(T[:3, 3] - Ti[:3, 3]))
        pf = rep['results'][0]['pairs_fit']
        check('пары: Δповорота ≤0.05°', dr <= 0.05, 'Δ=%.4f°' % dr)
        check('пары: Δсдвига ≤2 см', dshift <= 0.02, 'Δ=%.1f мм' % (dshift * 1000))
        check('пары: RMS ≤2 см', pf['rms_m'] <= 0.02, 'RMS=%.1f мм' % (pf['rms_m'] * 1000))
    # отказ: 2 пары
    two = os.path.join(tmp, 'mp-two.json')
    json.dump({'pairs': pairs[:2]}, open(two, 'w', encoding='utf-8'))
    r2 = run_cli('cloud-register.py', ['--ref', ref_las, '--src', src_las, '--mode',
                                       'manual-points', '--pairs', two, '--out',
                                       os.path.join(tmp, 'mp-two-out.json'), '--max-points', '50000'])
    check('<3 пар → exit 2', r2.returncode == 2, 'code=%d' % r2.returncode)
    # выброс 0.5 м: без strict — ok, со strict — exit 1
    bad = [dict(p) for p in pairs[:4]]
    bad[2] = {'id': 'P2', 'src': [bad[2]['src'][0] + 0.5] + bad[2]['src'][1:], 'ref': bad[2]['ref']}
    bad_json = os.path.join(tmp, 'mp-bad.json')
    json.dump({'pairs': bad}, open(bad_json, 'w', encoding='utf-8'))
    out2 = os.path.join(tmp, 'mp-bad-out.json')
    r3 = run_cli('cloud-register.py', ['--ref', ref_las, '--src', src_las, '--mode',
                                       'manual-points', '--pairs', bad_json, '--out', out2,
                                       '--max-points', '50000'])
    rep3 = json.load(open(out2, encoding='utf-8')) if os.path.exists(out2) else {}
    rms3 = rep3.get('results', [{}])[0].get('pairs_fit', {}).get('rms_m', 0)
    check('выброс 0.5 м: без strict exit 0 и RMS>0.15', r3.returncode == 0 and rms3 > 0.15,
          'code=%d RMS=%.3f' % (r3.returncode, rms3))
    r4 = run_cli('cloud-register.py', ['--ref', ref_las, '--src', src_las, '--mode',
                                       'manual-points', '--pairs', bad_json, '--out', out2,
                                       '--max-points', '50000', '--strict'])
    check('выброс 0.5 м: --strict → exit 1', r4.returncode == 1, 'code=%d' % r4.returncode)


def test_gcp(CR, tmp):
    print('\n=== 3. gcp: CSV контрольных точек ===')
    ref = make_scene(40000, seed=5)
    ref[:, :2] *= 2.0
    G = transform_matrix(1.8, np.array([-0.4, 0.2, 0.1]))
    Ti = inv(G)
    rng = np.random.default_rng(21)
    idx = rng.choice(len(ref), 20, replace=False)
    csv = os.path.join(tmp, 'gcp.csv')
    with open(csv, 'w', encoding='utf-8') as f:
        f.write('#id,x_src,y_src,z_src,X_ref,Y_ref,Z_ref\n')
        for i, k in enumerate(idx):
            pr = ref[k]
            ps = apply(G, pr[None, :])[0] + rng.normal(0, 0.012, 3)
            f.write('G%d,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f\n' % (i, ps[0], ps[1], ps[2],
                                                             pr[0], pr[1], pr[2]))
    ref_las = os.path.join(tmp, 'gcp-ref.las')
    src_las = os.path.join(tmp, 'gcp-src.las')
    CR.write_las(ref_las, ref)
    CR.write_las(src_las, apply(G, ref))
    out = os.path.join(tmp, 'gcp.json')
    r = run_cli('cloud-register.py', ['--ref', ref_las, '--src', src_las, '--mode', 'gcp',
                                      '--pairs', csv, '--out', out, '--strict',
                                      '--max-points', '100000'])
    check('gcp CLI exit 0', r.returncode == 0, 'code=%d %s' % (r.returncode, r.stderr.strip()[:120]))
    if os.path.exists(out):
        rep = json.load(open(out, encoding='utf-8'))
        T = np.array(rep['results'][0]['matrix'])
        dr = rot_err_deg(T, Ti)
        dshift = float(np.linalg.norm(T[:3, 3] - Ti[:3, 3]))
        pf = rep['results'][0]['pairs_fit']
        check('gcp: Δповорота ≤0.05°', dr <= 0.05, 'Δ=%.4f°' % dr)
        check('gcp: Δсдвига ≤2 см', dshift <= 0.02, 'Δ=%.1f мм' % (dshift * 1000))
        check('gcp: RMS ≤0.15 (strict-порог)', pf['rms_m'] <= 0.15, 'RMS=%.1f мм' % (pf['rms_m'] * 1000))


def test_real(CR, tmp):
    print('\n=== 4. Реальные данные (кроп 20×20 м) ===')
    # Пары подготовлены в одних и тех же локальных рамках (кроп 20×20 м):
    #   интерьер: Lixel crop lixel-20x20.las  vs  наша сборка r145-interior-full-20x20.las
    #   фасад:    Lixel crop r145-facade-lixel-box.las vs r145-facade-ours-box.las
    cases = [
        ('interior', r'D:\BIM-TWIN-TEST\xbin-verify\lixel-20x20.las',
         r'D:\BIM-TWIN-TEST\xbin-verify\r145-interior-full-20x20.las', None),
        ('facade', r'D:\BIM-TWIN-TEST\xbin-verify\r145-facade-lixel-box.las',
         r'D:\BIM-TWIN-TEST\xbin-verify\r145-facade-ours-box.las', None),
    ]
    import subprocess as sp
    try:
        import psutil
    except Exception:  # noqa: BLE001
        psutil = None
    results = {}
    for name, ref, src, crop in cases:
        if not (os.path.exists(ref) and os.path.exists(src)):
            skip('real %s' % name, 'нет файла'); continue
        out = os.path.join(tmp, 'real-%s.json' % name)
        cmd = [sys.executable, os.path.join(HERE, 'cloud-register.py'),
               '--ref', ref, '--src', src, '--mode', 'icp', '--out', out,
               '--max-points', '600000', '--max-iter', '50']
        t0 = time.time()
        proc = sp.Popen(cmd, stdout=sp.PIPE, stderr=sp.PIPE, text=True)
        peak_mb = 0.0
        if psutil is not None:
            try:
                ps = psutil.Process(proc.pid)
                while proc.poll() is None:
                    try:
                        rss = ps.memory_info().rss
                        for ch in ps.children(recursive=True):
                            try:
                                rss += ch.memory_info().rss
                            except Exception:  # noqa: BLE001
                                pass
                        peak_mb = max(peak_mb, rss / 2 ** 20)
                    except Exception:  # noqa: BLE001
                        pass
                    time.sleep(0.05)
            except Exception:  # noqa: BLE001
                pass
        stdout, stderr = proc.communicate()
        dt = time.time() - t0
        if not os.path.exists(out):
            check('real %s: JSON' % name, False, (stderr or '')[:140]); continue
        rep = json.load(open(out, encoding='utf-8'))
        res = rep['results'][0]
        rr = res.get('rms') or {}
        rms = rr.get('rms_inlier_m') if rr.get('rms_inlier_m') is not None else rr.get('rms_m')
        results[name] = {'rms_inlier_mm': round(rms * 1000, 1) if rms is not None else None,
                         'rms_all_mm': round(rr.get('rms_m', 0) * 1000, 1),
                         'inlier_pct': round(100 * rr.get('inlier_ratio', 0), 1),
                         'yaw_deg': res['transform']['yaw_deg'],
                         'shift_m': res['transform']['translation'],
                         'seconds': round(dt, 2), 'peak_rss_mb': round(peak_mb, 0),
                         'code': proc.returncode,
                         'ref_pts': res['shape']['ref_points'],
                         'src_pts': res['shape']['src_points']}
        print('  %s: RMS(inlier) %s мм | inlier %.0f%% | yaw %.4f° | сдвиг [%.3f, %.3f, %.3f] | %.2f с | память ~%.0f МБ' % (
            name, results[name]['rms_inlier_mm'], results[name]['inlier_pct'],
            results[name]['yaw_deg'], *results[name]['shift_m'], dt, peak_mb))
        check('real %s: exit 0' % name, proc.returncode == 0, 'code=%d' % proc.returncode)
    return results


def main():
    ap = argparse.ArgumentParser(description='Тест cloud-register.py (r149)')
    ap.add_argument('--skip-real', action='store_true')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--json', default=None, help='куда сохранить сводку теста')
    a = ap.parse_args()
    CR = load_tool()
    tmp = tempfile.mkdtemp(prefix='cloud-register-test-')
    summary = {}
    try:
        test_synthetic(CR, tmp)
        test_manual_points(CR, tmp)
        test_gcp(CR, tmp)
        if not a.skip_real:
            summary['real'] = test_real(CR, tmp)
        print('\n=== ИТОГ: PASS %d | FAIL %d | SKIP %d ===' % (CHK['pass'], CHK['fail'], CHK['skip']))
        summary.update({'pass': CHK['pass'], 'fail': CHK['fail'], 'skip': CHK['skip']})
        if a.json:
            json.dump(summary, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print('сводка:', os.path.abspath(a.json))
        return 0 if CHK['fail'] == 0 else 1
    finally:
        if a.keep:
            print('временная папка:', tmp)
        else:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())




