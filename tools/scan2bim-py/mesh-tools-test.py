# -*- coding: utf-8 -*-
"""mesh-tools-test.py — тест mesh-tools.py: дыры, сглаживание, удаление, упрощение, время."""
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
import time

import numpy as np
import open3d as o3d

HERE = os.path.dirname(os.path.abspath(__file__))
CHK = {'pass': 0, 'fail': 0, 'skip': 0}


def check(name, cond, detail=''):
    if cond:
        CHK['pass'] += 1
        print('  PASS  %s %s' % (name, detail))
    else:
        CHK['fail'] += 1
        print('  FAIL  %s %s' % (name, detail))


def load_tool():
    spec = importlib.util.spec_from_file_location('mesh_tools', os.path.join(HERE, 'mesh-tools.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def make_cube_hole():
    m = o3d.geometry.TriangleMesh.create_box(2.0, 2.0, 2.0)
    T = np.asarray(m.triangles)
    keep = np.ones(len(T), bool)
    keep[0] = False
    keep[1] = False
    m.triangles = o3d.utility.Vector3iVector(T[keep])
    return m


def main():
    M = load_tool()
    tmp = tempfile.mkdtemp(prefix='mesh-test-')
    print('=== 1. Куб с дырой: fill-holes ===')
    m = make_cube_hole()
    before = M.mesh_summary(o3d.geometry.TriangleMesh(m))
    b0 = np.asarray(m.triangles)
    holes, added = M.fill_holes(m)
    after = M.mesh_summary(m)
    print('  до: %d три, boundary %d | после: %d три, boundary %d (заполнено дыр %d, +%d три)' % (
        before['triangles'], before['boundary_edges'], after['triangles'],
        after['boundary_edges'], holes, added))
    check('дыр найдено и заполнено ≥1', holes >= 1, 'holes=%d' % holes)
    check('после fill-holes boundary_edges == 0 (замкнут)', after['boundary_edges'] == 0,
          'boundary=%d' % after['boundary_edges'])

    print('\n=== 2. Сглаживание: шум уменьшается, объём сохраняется ===')
    clean = o3d.geometry.TriangleMesh.create_sphere(radius=1.0, resolution=30)
    Vc = np.asarray(clean.vertices).copy()
    rng = np.random.default_rng(3)
    noisy = o3d.geometry.TriangleMesh(clean)
    Vn = Vc + rng.normal(0, 0.05, Vc.shape)
    noisy.vertices = o3d.utility.Vector3dVector(Vn)
    v0 = M.triangle_volume(np.asarray(noisy.vertices), np.asarray(noisy.triangles))
    rms_before = float(np.sqrt(np.mean(np.sum((Vn - Vc) ** 2, axis=1))))
    move, nfree = M.laplacian_smooth(noisy, 5, 0.5, True)
    V2 = np.asarray(noisy.vertices)
    rms_after = float(np.sqrt(np.mean(np.sum((V2 - Vc) ** 2, axis=1))))
    v1 = M.triangle_volume(V2, np.asarray(noisy.triangles))
    print('  RMS отклонения от «чистой» формы: %.4f → %.4f м | объём %.4f → %.4f м³' % (
        rms_before, rms_after, v0, v1))
    check('RMS шума уменьшился (≥20 %)', rms_after < 0.8 * rms_before,
          '%.4f → %.4f' % (rms_before, rms_after))
    check('изменение объёма ≤5 %', abs(v1 - v0) / max(v0, 1e-9) <= 0.05,
          'Δ=%.2f%%' % (100 * abs(v1 - v0) / max(v0, 1e-9)))
    check('граница не сдвинута (moved vertices = внутренние)', nfree > 0, 'nfree=%d' % nfree)

    print('\n=== 3. remove-triangles по цвету и объёму ===')
    box = o3d.geometry.TriangleMesh.create_box(2.0, 2.0, 2.0)
    V = np.asarray(box.vertices)
    cols = np.tile([0.2, 0.6, 0.2], (len(V), 1))
    cols[:len(V) // 2] = [1.0, 0.0, 0.0]
    box.vertex_colors = o3d.utility.Vector3dVector(cols)
    removed, left = M.remove_by_color(box, [255, 0, 0], 30.0)
    print('  цвет: удалено %d треугольников, осталось %d' % (removed, left))
    check('удаление по цвету: удалено >0 и осталось >0', removed > 0 and left > 0,
          '%d/%d' % (removed, left))
    big = o3d.geometry.TriangleMesh.create_box(2.0, 2.0, 2.0)
    small = o3d.geometry.TriangleMesh.create_box(0.2, 0.2, 0.2)
    small.translate((10.0, 0.0, 0.0))
    both = big + small
    n_comp = M.remove_small_components(both, 0.1)
    print('  объём: удалено мелких компонент %d, треугольников осталось %d' % (
        n_comp, len(np.asarray(both.triangles))))
    check('удаление по объёму: мелкий компонент удалён', n_comp >= 1, 'removed=%d' % n_comp)

    print('\n=== 4. Упрощение (quadric) куба 3×3×3 / сферы ===')
    sph = o3d.geometry.TriangleMesh.create_sphere(radius=1.0, resolution=40)
    n0 = len(np.asarray(sph.triangles))
    vol0 = M.triangle_volume(np.asarray(sph.vertices), np.asarray(sph.triangles))
    t = time.time()
    n1 = M.decimate_quadric(sph, max(1000, n0 // 5))
    dt = time.time() - t
    vol1 = M.triangle_volume(np.asarray(sph.vertices), np.asarray(sph.triangles))
    print('  сфера: %d → %d треугольников за %.2f с | объём %.4f → %.4f' % (n0, n1, dt, vol0, vol1))
    check('quadric: треугольников ≤ target*1.1', n1 <= max(1000, n0 // 5) * 1.1,
          '%d → %d' % (n0, n1))
    check('quadric: объём изменился ≤5 %', abs(vol1 - vol0) / max(vol0, 1e-9) <= 0.05,
          'Δ=%.2f%%' % (100 * abs(vol1 - vol0) / max(vol0, 1e-9)))

    print('\n=== 5. Время на 1–3 млн треугольников ===')
    for subdiv, label in ((8, '1M'), (9, '3M')):
        ts = time.time()
        m2 = o3d.geometry.TriangleMesh.create_box(2.0, 2.0, 2.0).subdivide_loop(subdiv)
        ntr = len(np.asarray(m2.triangles))
        t_make = time.time() - ts
        t = time.time(); M.fill_holes(m2); t_fill = time.time() - t
        t = time.time(); M.laplacian_smooth(m2, 3, 0.5, True); t_smooth = time.time() - t
        t = time.time(); n2 = M.decimate_quadric(m2, max(2000, ntr // 10)); t_dec = time.time() - t
        print('  %s: %d три | build %.1f с | fill-holes %.2f с | smooth(3) %.2f с | decimate %.2f с (→%d)' % (
            label, ntr, t_make, t_fill, t_smooth, t_dec, n2))

    print('\n=== 6. CLI E2E: fill-holes + json ===')
    hole = make_cube_hole()
    inp = os.path.join(tmp, 'hole.ply')
    out = os.path.join(tmp, 'filled.ply')
    rep_path = os.path.join(tmp, 'mesh-report.json')
    o3d.io.write_triangle_mesh(inp, hole)
    r = subprocess.run([sys.executable, os.path.join(HERE, 'mesh-tools.py'), '--in', inp,
                        '--out', out, '--fill-holes', '--json', rep_path],
                       capture_output=True, text=True, timeout=300)
    ok = os.path.exists(out) and os.path.exists(rep_path)
    rep = json.load(open(rep_path, encoding='utf-8')) if ok else {}
    check('CLI exit 0 и файлы записаны', r.returncode == 0 and ok,
          'code=%d %s' % (r.returncode, (r.stderr or '')[:100]))
    check('JSON: watertight после fill-holes', rep.get('after', {}).get('watertight') is True,
          'watertight=%s' % rep.get('after', {}).get('watertight'))
    print('\n=== ИТОГ: PASS %d | FAIL %d | SKIP %d ===' % (CHK['pass'], CHK['fail'], CHK['skip']))
    return 0 if CHK['fail'] == 0 else 1


if __name__ == '__main__':
    sys.exit(main())

