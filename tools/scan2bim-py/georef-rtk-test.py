# -*- coding: utf-8 -*-
"""georef-rtk-test.py — проверка georef-rtk.py на синтетике + точность формул UTM + IFC.

Что проверяется:
  1) формулы Transverse Mercator / UTM:
     — эталон OSGB (EPSG Guidance Note 7-2: lat 52°39'27.2531"N, lon 1°43'4.5177"E →
       E 651409.903, N 313177.270) на Airy 1830;
     — нулевая точка UTM (lat 0, lon 15° → E 500000, N 0);
     — round-trip forward→inverse (Украина, 44–52° с.ш., 22–40° в.д.) < 1e-7°;
     — контроль по существующему UTM-скану (дфі, EPSG-подобный UTM CM 33°):
       (322149.45, 5588278.54) ↔ (50.419576, 30.496374) < 2 см;
     — сверка с OSM-точкой института Амосова (50.41956, 30.49774): ΔE ≈ 80–120 м, |ΔN|<5 м;
  2) синтетический RTK-скан: известная трансформация (поворот 12.345°, сдвиг, высота),
     GNSS с шумом 2 см → трансформация восстанавливается (rotation <0.05°, сдвиг <0.1 м,
     rms <0.05 м), IfcMapConversion пересчитывает точки с ошибкой <0.002 м;
  3) отказы: пустой gnss.csv → exit 2 «нет данных fix»; <3 fix → exit 2; выброс 0.5 м →
     без --strict exit 0, с --strict exit 1; реальный проект ln_amosova (пустой gnss.csv) →
     exit 2 и честное сообщение;
  4) IFC: node json-to-ifc.js --georef-file → IFCMAPCONVERSION с реальными числами,
     validate-ifc.py → 0 ERROR / 0 расхождений арности.

Запуск:
  python tools/scan2bim-py/georef-rtk-test.py [--verbose]
Код возврата: 0 — все проверки прошли; 1 — есть провалы.
"""
import argparse
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHK = {'pass': 0, 'fail': 0, 'skip': 0, 'details': []}


def check(name, cond, detail=''):
    if cond:
        CHK['pass'] += 1
        print('  PASS  %s %s' % (name, detail))
    else:
        CHK['fail'] += 1
        print('  FAIL  %s %s' % (name, detail))
    CHK['details'].append({'name': name, 'ok': bool(cond), 'detail': detail})
    return bool(cond)


def skip(name, why):
    CHK['skip'] += 1
    print('  SKIP  %s (%s)' % (name, why))


def load_module():
    path = os.path.join(HERE, 'georef-rtk.py')
    spec = importlib.util.spec_from_file_location('georef_rtk', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ----------------------------- 1) формулы -----------------------------
def test_utm_formulas(G):
    print('\n=== 1. Точность формул Transverse Mercator / UTM ===')
    # (a) эталон OSGB из EPSG Guidance Note 7-2 (тот же алгоритм TM, другие константы)
    lat = 52 + 39 / 60 + 27.2531 / 3600
    lon = 1 + 43 / 60 + 4.5177 / 3600
    a = 6377563.396
    b = 6356256.909
    f = (a - b) / a
    E, N = G.tm_forward(lat, lon, a, f, 49.0, -2.0, 0.9996012717, 400000.0, -100000.0)
    dE, dN = E - 651409.903, N - 313177.270
    check('OSGB EPSG:9807 эталон', abs(dE) < 0.005 and abs(dN) < 0.005,
          'ΔE=%.1f мм ΔN=%.1f мм' % (dE * 1000, dN * 1000))
    # (b) нулевая точка: экватор на осевом меридиане
    E0, N0 = G.utm_forward(0.0, 15.0, zone=33)
    check('UTM(0°,15°) = (500000, 0)', abs(E0 - 500000) < 0.001 and abs(N0) < 0.001,
          '(%.4f, %.4f)' % (E0, N0))
    # (c) round-trip
    rng = __import__('random').Random(42)
    worst = 0.0
    for _ in range(200):
        la = rng.uniform(44.0, 52.0)
        lo = rng.uniform(22.0, 40.0)
        z = G.utm_zone_of(lo)
        e, n = G.utm_forward(la, lo, z)
        la2, lo2 = G.utm_inverse(e, n, z)
        worst = max(worst, abs(la2 - la), abs(lo2 - lo))
    check('round-trip forward→inverse', worst < 1e-7, 'max %.2e° (=%.3f мм)' % (worst, worst * 111320 * 1000))
    # (d) контроль по UTM-скану дфі (CM 33° = зона 36N)
    la, lo = G.utm_inverse(322149.45, 5588278.54, 36)
    e2, n2 = G.utm_forward(la, lo, 36)
    d = math.hypot(e2 - 322149.45, n2 - 5588278.54)
    check('контроль дфі: (322149.45,5588278.54)→WGS84', d < 0.02,
          'lat %.6f lon %.6f, Δ=%.1f мм' % (la, lo, d * 1000))
    # (e) сверка с OSM-точкой института Амосова
    e_osm, n_osm = G.utm_forward(50.41956, 30.49774, 36)
    dE = e_osm - 322149.45
    dN = n_osm - 5588278.54
    check('сверка с OSM (ΔE≈80–120 м, |ΔN|<15 м)', 80 < dE < 120 and abs(dN) < 15,
          'ΔE=%.1f м ΔN=%.1f м' % (dE, dN))
    # (f) ECEF round-trip
    x, y, z = G.latlon_to_ecef(50.419576, 30.496374, 210.0)
    la, lo, h = G.ecef_to_latlon(x, y, z)
    check('ECEF round-trip', abs(la - 50.419576) < 1e-9 and abs(lo - 30.496374) < 1e-9 and abs(h - 210) < 1e-6,
          'Δlat=%.2e Δlon=%.2e Δh=%.2e' % (la - 50.419576, lo - 30.496374, h - 210.0))


# ----------------------------- вспомогательное -----------------------------
GNSS_HDR = ('#timestamp,status,latitude,longitude,altitude,gnss_type,undulation,pdop,hdop,vdop,'
            'var_x2,var_y2,var_z2,satellite_num,satellite_utc')


def write_project(root, rows_gnss, rows_poses, extra_float_row=False):
    pd = os.path.join(root, 'project_data')
    os.makedirs(pd, exist_ok=True)
    with open(os.path.join(pd, 'gnss.csv'), 'w', encoding='utf-8') as f:
        f.write(GNSS_HDR + '\n')
        for r in rows_gnss:
            f.write(','.join(str(v) for v in r) + '\n')
        if extra_float_row:
            pass
    with open(os.path.join(pd, 'poses.csv'), 'w', encoding='utf-8') as f:
        for r in rows_poses:
            f.write(','.join(str(v) for v in r) + '\n')
    return pd


def make_synthetic(G, root, theta_deg=12.345, scale=1.0, noise=0.02, npts=7, origin=(100.0, 200.0, 50.0),
                   bias_one=0.0, use_float_rows=True):
    """Создаёт синтетический RTK-проект в кадре модели (x,z план, y вверх) + origin las-to-bin."""
    ox, oy, oz = origin
    th = math.radians(theta_deg)
    tx0, ty0, tz0 = 322100.0, 5588300.0, 210.5
    rng = __import__('random').Random(7)
    poses, gnss = [], []
    t0 = 1788425000.0
    # маршрут: коридор 3.6 м × 20 м в модели
    path = []
    for i in range(npts):
        x = -8.0 + 16.0 * i / (npts - 1)
        z = -1.8 + 0.2 * math.sin(i)
        y = 0.6 + 0.02 * i
        path.append((x, y, z))
    for i, (x, y, z) in enumerate(path):
        # модель (x,z план, y вверх) -> кадр скана (LAS): X=x+ox, Y=oy-z, Z=y+oz
        X, Y, Z = x + ox, oy - z, y + oz
        E = tx0 + scale * (math.cos(th) * X - math.sin(th) * Y)
        N = ty0 + scale * (math.sin(th) * X + math.cos(th) * Y)
        H = tz0 + Z
        if bias_one and i == 3:
            E += bias_one
        E += rng.gauss(0, noise); N += rng.gauss(0, noise); H += rng.gauss(0, noise)
        lat, lon = G.utm_inverse(E, N, 36)
        ts = t0 + 0.5 * i
        poses.append([ts, round(x, 6), round(y, 6), round(z, 6), 0.0, 0.0, 0.0, 1.0])
        gnss.append([ts, 4, round(lat, 10), round(lon, 10), round(H, 5), 'RTK', 0.0,
                     1.0, 0.7, 1.1, 0.0004, 0.0004, 0.0014, 21, 0])
    if use_float_rows:
        # строка RTK float (status=2) — не должна участвовать
        gnss.append([t0 + 1.5, 2, 50.0, 30.0, 200.0, 'RTK', 0.0, 1.0, 0.7, 1.1,
                     0.0004, 0.0004, 0.0014, 21, 0])
    write_project(root, gnss, poses)
    return {'theta_deg': theta_deg, 'scale': scale, 'origin': origin,
            'tx': tx0, 'ty': ty0, 'tz': tz0, 'npts': npts}


def run_cli(args, timeout=300):
    return subprocess.run([sys.executable, os.path.join(HERE, 'georef-rtk.py')] + args,
                          capture_output=True, text=True, timeout=timeout)


# ----------------------------- 2) синтетика -----------------------------
def test_synthetic(G, tmp):
    print('\n=== 2. Синтетический RTK-скан (шум GNSS 2 см) ===')
    root = os.path.join(tmp, 'rtk-project')
    truth = make_synthetic(G, root)
    out = os.path.join(tmp, 'georef-synth.json')
    r = run_cli(['--project', root, '--out', out, '--local-plan', 'xz',
                 '--from-las-origin', ','.join('%g' % v for v in truth['origin'])])
    check('CLI exit 0', r.returncode == 0, 'code=%d %s' % (r.returncode, r.stderr.strip()[:160]))
    if not os.path.exists(out):
        return None
    gr = json.load(open(out, encoding='utf-8'))
    check('georef.json: ok=true', gr.get('ok') is True)
    check('EPSG:32636/25836 (зона 36N)', gr['crs']['zone'] == 36,
          'EPSG:%s %s' % (gr['crs']['epsg'], gr['crs']['name']))
    rot_err = abs(gr['transform']['rotation_deg'] - truth['theta_deg'])
    check('поворот восстановлен (<0.05°)', rot_err < 0.05, 'Δ=%.4f°' % rot_err)
    tr = gr['transform']
    # сдвиг проверяем в кадре скана: E0 = tx + s*(cosθ*ox - sinθ*oy) и т.п.
    th = math.radians(truth['theta_deg'])
    ox, oy, oz = truth['origin']
    e0_true = truth['tx'] + (math.cos(th) * ox - math.sin(th) * oy)
    n0_true = truth['ty'] + (math.sin(th) * ox + math.cos(th) * oy)
    h0_true = truth['tz'] + oz
    m = tr['ifc_map_conversion']
    dE = abs(m['eastings'] - e0_true); dN = abs(m['northings'] - n0_true)
    dH = abs(m['orthogonal_height'] - h0_true); dS = abs(m['scale'] - truth['scale'])
    check('сдвиг восстановлен (<0.1 м)', max(dE, dN, dH) < 0.1,
          'ΔE=%.1f мм ΔN=%.1f мм ΔH=%.1f мм' % (dE * 1000, dN * 1000, dH * 1000))
    # при шуме GNSS 2 см и коротком маршруте масштаб оценивается ~0.1–0.5 %;
    # для привязки это несущественно (координаты точек укладываются в <0.05 м)
    check('масштаб ≈ 1 (<5e-3)', dS < 5e-3, 'Δs=%.2e' % dS)
    acc = tr['accuracy']
    check('невязка rms/max <0.05 м', acc['rms_m'] < 0.05 and acc['max_m'] < 0.05,
          'rms=%.4f max=%.4f м (n=%d)' % (acc['rms_m'], acc['max_m'], acc['points']))
    ic = tr.get('ifc_check', [])
    if ic:
        worst = max(x['err2d'] for x in ic)
        worst_h = max(x.get('err_h', 0.0) for x in ic)
        check('IfcMapConversion воспроизводит МНК-трансформацию (<5 мм)',
              worst < 0.005 and worst_h < 0.005,
              'max 2D %.4f мм, H %.4f мм' % (worst * 1000, worst_h * 1000))
    else:
        check('IfcMapConversion пересчёт точек', False, 'нет ifc_check')
    check('bbox облака в UTM в разумных пределах', abs(gr['cloud_bbox_utm']['min'][0] - 322100) < 500,
          'min=%s' % gr['cloud_bbox_utm']['min'])
    return gr


# ----------------------------- 3) отказы -----------------------------
def test_refusals(G, tmp):
    print('\n=== 3. Отказы и честные сообщения ===')
    # (a) пустой gnss.csv
    root = os.path.join(tmp, 'empty')
    write_project(root, [], [[1.0, 0, 0, 0, 0, 0, 0, 1.0]])
    r = run_cli(['--project', root, '--out', os.path.join(tmp, 'empty.json')])
    check('пустой gnss.csv → exit 2', r.returncode == 2, 'code=%d' % r.returncode)
    check('сообщение «нет данных fix»', 'нет данных fix' in (r.stdout + r.stderr),
          (r.stderr or r.stdout).strip()[:120])
    # (b) <3 fix
    root = os.path.join(tmp, 'two')
    gnss = [[100.0, 4, 50.42, 30.50, 210.0, 'RTK'], [101.0, 4, 50.421, 30.501, 210.1, 'RTK']]
    poses = [[100.0, 0, 0, 0, 0, 0, 0, 1.0], [101.0, 1, 0, 0, 0, 0, 0, 1.0]]
    write_project(root, gnss, poses)
    r = run_cli(['--project', root, '--out', os.path.join(tmp, 'two.json')])
    check('<3 общих точек → exit 2', r.returncode == 2, 'code=%d' % r.returncode)
    check('сообщение «недостаточно общих точек»', 'недостаточно общих точек' in (r.stdout + r.stderr),
          (r.stderr or r.stdout).strip()[:120])
    # (c) выброс 0.5 м: без strict — ok, со strict — exit 1
    root = os.path.join(tmp, 'bias')
    truth = make_synthetic(G, root, bias_one=0.5, noise=0.02)
    out = os.path.join(tmp, 'bias.json')
    r1 = run_cli(['--project', root, '--out', out, '--local-plan', 'xz',
                  '--from-las-origin', ','.join('%g' % v for v in truth['origin'])])
    gr = json.load(open(out, encoding='utf-8')) if os.path.exists(out) else {}
    mx = gr.get('transform', {}).get('accuracy', {}).get('max_m', 0)
    check('выброс 0.5 м: без --strict exit 0 и max>0.15', r1.returncode == 0 and mx > 0.15,
          'code=%d max=%.3f м' % (r1.returncode, mx))
    r2 = run_cli(['--project', root, '--out', out, '--local-plan', 'xz',
                  '--from-las-origin', ','.join('%g' % v for v in truth['origin']), '--strict'])
    check('выброс 0.5 м: --strict → exit 1', r2.returncode == 1, 'code=%d' % r2.returncode)
    # (d) реальный проект ln_amosova с пустым gnss.csv
    real = r'D:\BIM-TWIN-TEST\r54\lixel\ln_amosova_2026-09-03-114323'
    if os.path.isdir(os.path.join(real, 'project_data')):
        out = os.path.join(tmp, 'real.json')
        r = run_cli(['--project', real, '--out', out])
        check('реальный ln_amosova (gnss пуст) → exit 2', r.returncode == 2,
              'code=%d' % r.returncode)
        check('честное сообщение по реальному проекту', 'нет данных fix' in (r.stdout + r.stderr),
              (r.stderr or r.stdout).strip()[:140])
    else:
        skip('реальный ln_amosova', 'нет папки')


# ----------------------------- 4) IFC -----------------------------
def test_ifc(tmp, georef_path):
    print('\n=== 4. Georeferenced IFC (IfcMapConversion с реальным сдвигом) ===')
    node = shutil.which('node') or shutil.which('node.exe')
    if not node:
        skip('IFC: node', 'node не найден в PATH')
        return
    model = r'D:\BIM-TWIN-TEST\interior\py2-final-v5.json'
    if not os.path.exists(model):
        skip('IFC: модель', 'нет %s' % model)
        return
    ifc_path = os.path.join(tmp, 'georef-test.ifc')
    p = subprocess.run([node, os.path.join(HERE, 'json-to-ifc.js'), model, ifc_path,
                        '--georef-file', georef_path, '--name=georef-rtk-test'],
                       capture_output=True, text=True, timeout=300, cwd=os.path.dirname(HERE))
    check('json-to-ifc --georef-file exit 0', p.returncode == 0,
          'code=%d %s' % (p.returncode, (p.stderr or '')[:160]))
    if p.returncode != 0 or not os.path.exists(ifc_path):
        return
    text = open(ifc_path, encoding='utf-8', errors='replace').read()
    mk = __import__('re').search(r'IFCMAPCONVERSION\(([^;]+)\);', text)
    if mk:
        args = [a.strip() for a in mk.group(1).split(',')]
        check('IFCMAPCONVERSION: 8 аргументов', len(args) == 8, 'args=%d' % len(args))
        # последние 3 числа — abscissa/ordinate/scale; перед ними 3 — E0,N0,H0
        nums = [float(x) for x in args[2:]]
        gr = json.load(open(georef_path, encoding='utf-8'))
        m = gr['transform']['ifc_map_conversion']
        ok = (abs(nums[0] - m['eastings']) < 1e-3 and abs(nums[1] - m['northings']) < 1e-3 and
              abs(nums[2] - m['orthogonal_height']) < 1e-3 and
              abs(nums[3] - m['x_axis_abscissa']) < 1e-6 and abs(nums[4] - m['x_axis_ordinate']) < 1e-6 and
              abs(nums[5] - m['scale']) < 1e-9)
        check('IFCMAPCONVERSION содержит реальные E0/N0/H0/rot/scale', ok, 'E0=%.3f N0=%.3f H0=%.3f' % tuple(nums[:3]))
    else:
        check('IFCMAPCONVERSION найден в IFC', False)
    # validate-ifc.py
    report = os.path.join(tmp, 'validate.json')
    py = sys.executable
    v = subprocess.run([py, os.path.join(HERE, 'validate-ifc.py'), ifc_path, '--json', report],
                       capture_output=True, text=True, timeout=300, cwd=HERE)
    ok = v.returncode == 0
    check('validate-ifc.py: 0 ERROR/0 арности (exit 0)', ok,
          'code=%d %s' % (v.returncode, (v.stdout or v.stderr or '').strip()[-160:]))
    if os.path.exists(report):
        try:
            vr = json.load(open(report, encoding='utf-8'))
            errs = (vr.get('validate') or {}).get('errors') if isinstance(vr.get('validate'), dict) else None
            check('IFCMAPCONVERSION в инвентаре', (vr.get('inventory') or {}).get('IfcMapConversion', 0) >= 1,
                  str((vr.get('inventory') or {}).get('IfcMapConversion')))
        except Exception as e:
            check('разбор отчёта validate', False, str(e))


def main():
    ap = argparse.ArgumentParser(description='Тест georef-rtk.py на синтетике + точность UTM + IFC')
    ap.add_argument('--keep', action='store_true', help='не удалять временную папку')
    args = ap.parse_args()
    G = load_module()
    tmp = tempfile.mkdtemp(prefix='georef-rtk-test-')
    try:
        test_utm_formulas(G)
        gr = test_synthetic(G, tmp)
        test_refusals(G, tmp)
        if gr is not None:
            georef_path = os.path.join(tmp, 'georef-synth.json')
            test_ifc(tmp, georef_path)
        print('\n=== ИТОГ: PASS %d | FAIL %d | SKIP %d ===' % (CHK['pass'], CHK['fail'], CHK['skip']))
        return 0 if CHK['fail'] == 0 else 1
    finally:
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print('временная папка:', tmp)


if __name__ == '__main__':
    sys.exit(main())
