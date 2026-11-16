# -*- coding: utf-8 -*-
"""crs-tools-test.py — тест crs-tools.py (Karney TM, control-точка dfi, roundtrip, VLR/georef)."""
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile

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


def load_tool(name='crs-tools.py'):
    spec = importlib.util.spec_from_file_location(name.replace('.py', '').replace('-', '_'),
                                                  os.path.join(HERE, name))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run_cli(args, timeout=300):
    return subprocess.run([sys.executable, os.path.join(HERE, 'crs-tools.py')] + args,
                          capture_output=True, text=True, timeout=timeout)


def main():
    C = load_tool()
    tmp = tempfile.mkdtemp(prefix='crs-test-')
    print('=== 1. Control-точка dfi: (322149.45, 5588278.54) ↔ (50.419576, 30.496374) ===')
    E, N = C.utm_forward(50.419576, 30.496374, 36)
    dE = (E - 322149.45) * 1000.0
    dN = (N - 5588278.54) * 1000.0
    d = math.hypot(dE, dN)
    print('  наш forward: E=%.4f N=%.4f | dE=%.2f мм dN=%.2f мм | dist=%.2f мм' % (E, N, dE, dN, d))
    check('control: forward ↔ dfi < 0.15 м (округление 1e-6° ≈ 5–11 см)', d < 150.0,
          'dist=%.1f мм' % d)
    lat, lon = C.utm_inverse(322149.45, 5588278.54, 36)
    dlat_m = (lat - 50.419576) * 111320.0
    dlon_m = (lon - 30.496374) * 111320.0 * math.cos(math.radians(50.419576))
    print('  наш inverse: lat=%.9f lon=%.9f | Δlat=%.1f мм Δlon=%.1f мм' % (
        lat, lon, dlat_m * 1000, dlon_m * 1000))
    check('control: inverse ↔ заданной lat/lon ≤1.5e-6° (округление)', 
          abs(lat - 50.419576) <= 1.5e-6 and abs(lon - 30.496374) <= 1.5e-6,
          'Δlat=%.2e° Δlon=%.2e°' % (lat - 50.419576, lon - 30.496374))
    # внутренняя согласованность forward(inverse(E,N)) — «0.3 мм»
    E2, N2 = C.utm_forward(lat, lon, 36)
    dd = math.hypot(E2 - 322149.45, N2 - 5588278.54)
    print('  forward(inverse(E,N)): dist=%.6f мм' % (dd * 1000))
    check('control: forward∘inverse(E,N) ≤0.3 мм', dd <= 0.0003, '%.6f мм' % (dd * 1000))

    print('\n=== 2. Roundtrip 200 точек WGS84→UTM→WGS84→UTM ≤1 мм ===')
    rng = np.random.default_rng(42)
    lats = rng.uniform(50.30, 50.55, 200)
    lons = rng.uniform(30.35, 30.65, 200)
    ee, nn = C._vec_en(C.TM('wgs84', 36, 'N'), lats, lons)
    la2, lo2 = C._vec_ll(C.TM('wgs84', 36, 'N'), ee, nn)
    e2, n2 = C._vec_en(C.TM('wgs84', 36, 'N'), la2, lo2)
    err = np.hypot(e2 - ee, n2 - nn)
    check('roundtrip 200 точек: max ≤1 мм', float(err.max()) <= 0.001,
          'max=%.6f мм, mean=%.6f мм' % (err.max() * 1000, err.mean() * 1000))
    check('roundtrip: max ≤0.3 мм (доп. требование)', float(err.max()) <= 0.0003,
          'max=%.6f мм' % (err.max() * 1000))

    print('\n=== 3. ETRS89 (25836) vs WGS84 (32636) ===')
    Etr, Ntr = C.utm_forward(50.419576, 30.496374, 36, 'etrs89')
    diff = math.hypot(Etr - E, Ntr - N)
    print('  WGS84: %.4f/%.4f | ETRS89: %.4f/%.4f | Δ=%.3f м' % (E, N, Etr, Ntr, diff))
    check('ETRS89↔WGS84 различие <1 м (только реализация датума)', diff < 1.0, '%.3f м' % diff)

    print('\n=== 4. LAS: пересчёт, VLR/WKT, georef.json ===')
    P = np.column_stack([rng.uniform(322000, 322300, 5000), rng.uniform(5588200, 5588500, 5000),
                         rng.uniform(205, 260, 5000)])
    las = os.path.join(tmp, 'utm.las')
    C.write_las(las, P, wkt=C.wkt_for(32636), epsg=32636)
    out_json = os.path.join(tmp, 'status.json')
    r = run_cli(['--in', las, '--epsg', '32636', '--json', out_json])
    rep = json.load(open(out_json, encoding='utf-8')) if os.path.exists(out_json) else {}
    check('CLI status exit 0 / JSON ok', r.returncode == 0 and rep.get('ok') is True,
          'code=%d' % r.returncode)
    check('в JSON есть source EPSG и corners WGS84',
          rep.get('source', {}).get('epsg') == 32636 and len(rep.get('corners_wgs84', [])) >= 4,
          'corners=%d' % len(rep.get('corners_wgs84', [])))
    # пересчёт в 4326
    out4326 = os.path.join(tmp, 'wgs84.las')
    j2 = os.path.join(tmp, 'to4326.json')
    r = run_cli(['--in', las, '--epsg', '32636', '--to', '4326', '--out-las', out4326, '--json', j2])
    C2 = load_tool()
    H = C2.read_las_header(out4326) if os.path.exists(out4326) else None
    check('пересчёт в 4326: exit 0 и LAS записан', r.returncode == 0 and H is not None,
          'code=%d' % r.returncode)
    if H is not None:
        b = H['bbox']
        check('4326: координаты в градусах (lon 30.49…, lat 50.41…)',
              abs(b[0] - 30.49) < 0.1 and abs(b[1] - 50.41) < 0.1,
              'bbox=%s' % [round(v, 4) for v in b])
    # обратно в UTM и VLR
    out32636 = os.path.join(tmp, 'back.las')
    r = run_cli(['--in', out4326, '--epsg', '4326', '--to', '32636', '--out-las', out32636])
    vlrs = C2.read_las_vlrs(out32636) if os.path.exists(out32636) else []
    eps, wkt = C2.las_crs_from_vlrs(vlrs) if vlrs else (None, None)
    check('VLR/WKT записаны (EPSG 32636 + WKT)', eps == 32636 and wkt and 'PROJCRS' in wkt,
          'epsg=%s wkt=%s' % (eps, (wkt or '')[:20]))
    # roundtrip файла ≤1 мм
    P2, _ = C2.load_ply_points(out32636) if out32636.lower().endswith('.ply') else (None, None)
    if P2 is None:
        # читаем точки LAS вручную
        H = C2.read_las_header(out32636)
        pts = []
        for xyz, rgb in C2.iter_las_chunks(out32636, H):
            pts.append(xyz)
        P2 = np.vstack(pts)
    # сопоставим по порядку (writer сохраняет порядок)
    err = np.linalg.norm(P2[:len(P)] - P, axis=1)
    check('файловый roundtrip UTM→4326→UTM ≤1 мм', float(err.max()) <= 0.001,
          'max=%.6f мм' % (err.max() * 1000))
    # georef-file
    gpath = os.path.join(tmp, 'georef.json')
    r = run_cli(['--in', las, '--epsg', '32636', '--to', '32636', '--georef-file', gpath,
                 '--json', os.path.join(tmp, 'geo.json')])
    g = json.load(open(gpath, encoding='utf-8')) if os.path.exists(gpath) else {}
    check('georef.json для IFC (crs.wkt + ifc_map_conversion)', r.returncode == 0 and
          'PROJCRS' in g.get('crs', {}).get('wkt', '') and
          'ifc_map_conversion' in g.get('transform', {}),
          'keys=%s' % list(g.keys()))
    # update-header
    outu = os.path.join(tmp, 'upd.las')
    r = run_cli(['--in', las, '--update-header', '--epsg', '32636', '--out-las', outu])
    v2 = C2.read_las_vlrs(outu) if os.path.exists(outu) else []
    eps2, wkt2 = C2.las_crs_from_vlrs(v2) if v2 else (None, None)
    check('--update-header: VLR с EPSG/WKT', r.returncode == 0 and eps2 == 32636 and bool(wkt2),
          'epsg=%s vlr=%d' % (eps2, len(v2)))
    print('\n=== 5. Регрессии: 4326 на UTM-36N (N≈6.18e6), --to local, широкий диапазон ===')
    P3 = np.column_stack([rng.uniform(499997, 500007, 3000), rng.uniform(6179998, 6180004, 3000),
                          rng.uniform(-0.02, 3.5, 3000)])
    las3 = os.path.join(tmp, 'utm-36n.las')
    C2.write_las(las3, P3, wkt=C2.wkt_for(32636), epsg=32636)
    out3 = os.path.join(tmp, 'utm-36n-wgs84.las')
    j3 = os.path.join(tmp, 'r3.json')
    r3 = run_cli(['--in', las3, '--to', '4326', '--out-las', out3, '--json', j3])
    ok3 = os.path.exists(out3) and os.path.exists(j3)
    rep3 = json.load(open(j3, encoding='utf-8')) if ok3 else {}
    check('4326 на UTM-36N (N≈6.18e6): exit 0, LAS записан (нет int32-overflow)',
          r3.returncode == 0 and ok3 and rep3.get('ok') is True,
          'code=%d %s' % (r3.returncode, (r3.stderr or '')[:100]))
    if ok3:
        H3 = C2.read_las_header(out3)
        check('4326-файл: bbox в градусах (lon≈33, lat≈55.77)',
              abs(H3['bbox'][0] - 33.0) < 0.01 and abs(H3['bbox'][1] - 55.77) < 0.01,
              'bbox=%s scale=%s' % ([round(v, 5) for v in H3['bbox'][:2]], H3['scale']))
    out4 = os.path.join(tmp, 'utm-local.las')
    j4 = os.path.join(tmp, 'r4.json')
    r4 = run_cli(['--in', las3, '--to', 'local', '--local-params', '0,0,0,1',
                  '--out-las', out4, '--json', j4])
    ok4 = os.path.exists(out4) and os.path.exists(j4)
    check('--to local --local-params: exit 0, LAS записан (нет epsg_info(0))',
          r4.returncode == 0 and ok4, 'code=%d %s' % (r4.returncode, (r4.stderr or '')[:100]))
    if ok4:
        H4 = C2.read_las_header(out4)
        check('local: координаты совпадают с UTM (identity)',
              abs(H4['bbox'][0] - 499997.0) < 0.01 and abs(H4['bbox'][1] - 6179998.0) < 0.01,
              'bbox=%s' % [round(v, 2) for v in H4['bbox'][:2]])
    # широкий диапазон градусов — int32 не должен переполняться
    try:
        Pw = np.column_stack([np.linspace(30, 40, 500), np.linspace(50, 60, 500), np.zeros(500)])
        C2.write_las(os.path.join(tmp, 'wide.las'), Pw, wkt=C2.wkt_for(4326), epsg=4326)
        check('широкий диапазон 10°: запись LAS без переполнения int32', True,
              'scale=%s' % (C2.read_las_header(os.path.join(tmp, 'wide.las'))['scale'],))
    except Exception as e:  # noqa: BLE001
        check('широкий диапазон 10°: запись LAS без переполнения int32', False, str(e))
    print('\n=== ИТОГ: PASS %d | FAIL %d | SKIP %d ===' % (CHK['pass'], CHK['fail'], CHK['skip']))
    return 0 if CHK['fail'] == 0 else 1


if __name__ == '__main__':
    sys.exit(main())

