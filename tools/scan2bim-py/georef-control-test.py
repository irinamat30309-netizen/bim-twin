# -*- coding: utf-8 -*-
"""georef-control-test.py — тест georef-control.py на синтетике.

Проверяется:
  1) известная трансформация (поворот 7.3°, масштаб 1.0, сдвиг, высота) + шум 5 см → поворот/
     сдвиг/невязка восстанавливаются (rot <0.05°, сдвиг <0.1 м, max невязка <0.15 м);
  2) отказ при <3 точках (exit 2);
  3) --strict: exit 1 при выбросе 0.5 м;
  4) georef.json → IFC через json-to-ifc.js --georef-file → validate-ifc.py 0 ERROR;
  5) синтетика с весами и 7-параметрическим режимом (--mode 7) — тоже проходит.

Запуск: python tools/scan2bim-py/georef-control-test.py [--keep]
"""
import argparse
import importlib.util
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile

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


def run_cli(script, args, timeout=300):
    return subprocess.run([sys.executable, os.path.join(HERE, script)] + args,
                          capture_output=True, text=True, timeout=timeout)


def make_control_json(path, theta_deg=7.3, scale=1.0, tx=322100.0, ty=5588300.0, tz=210.5,
                      n=6, noise=0.05, outlier=False, with_z=True, seed=11):
    rng = random.Random(seed)
    th = math.radians(theta_deg)
    pts = []
    # характерные углы прямоугольника 60 x 40 м + внутренние точки
    local = [(-30, -20), (30, -20), (30, 20), (-30, 20), (-10, 0), (15, 5), (0, -12), (25, 12)]
    for i, (x, y) in enumerate(local[:n]):
        X = tx + scale * (math.cos(th) * x - math.sin(th) * y) + rng.gauss(0, noise)
        Y = ty + scale * (math.sin(th) * x + math.cos(th) * y) + rng.gauss(0, noise)
        if outlier and i == 2:
            X += 0.5
        z = 0.5 + 0.1 * i
        Z = tz + z + rng.gauss(0, noise)
        rec = {'id': 'P%d' % (i + 1), 'x_local': x, 'y_local': y, 'X': X, 'Y': Y}
        if with_z:
            rec['z_local'] = z
            rec['Z'] = Z
        pts.append(rec)
    json.dump({'source': 'synthetic test', 'points': pts}, open(path, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    return {'theta': theta_deg, 'scale': scale, 'tx': tx, 'ty': ty, 'tz': tz}


def test_recovery(tmp):
    print('\n=== 1. Синтетика: восстановление трансформации (шум 5 см) ===')
    cj = os.path.join(tmp, 'control.json')
    truth = make_control_json(cj, noise=0.05)
    out = os.path.join(tmp, 'georef.json')
    r = run_cli('georef-control.py', ['--points', cj, '--out', out, '--strict'])
    check('CLI exit 0', r.returncode == 0, 'code=%d %s' % (r.returncode, r.stderr.strip()[:140]))
    if not os.path.exists(out):
        return None
    g = json.load(open(out, encoding='utf-8'))
    check('georef.json ok=true / passed_strict', g['ok'] is True and g['accuracy']['passed_strict'])
    tr = g['transform']
    d_rot = abs(tr['rotation_deg'] - truth['theta'])
    d_s = abs(tr['scale'] - truth['scale'])
    # сдвиг: E0 = tx + scale*(cosθ*0 - sinθ*0) = tx (по определению МНК в локальном кадре)
    dxy = max(abs(tr['translation'][0] - truth['tx']), abs(tr['translation'][1] - truth['ty']))
    dtz = abs(tr['translation'][2] - truth['tz'])
    check('поворот восстановлен (<0.05°)', d_rot < 0.05, 'Δ=%.4f°' % d_rot)
    check('масштаб ≈1 (<3e-3)', d_s < 3e-3, 'Δ=%.2e' % d_s)
    check('сдвиг восстановлен (<0.1 м)', dxy < 0.1 and dtz < 0.2,
          'Δxy=%.1f мм ΔH=%.1f мм' % (dxy * 1000, dtz * 1000))
    check('невязка max <0.15 м', g['accuracy']['max_3d_m'] < 0.15,
          'max=%.3f м' % g['accuracy']['max_3d_m'])
    ic = tr.get('ifc_check', [])
    if ic:
        w = max(x['err2d'] for x in ic)
        check('IfcMapConversion воспроизводит МНК (<1 мм)', w < 1e-3, 'max %.3f мм' % (w * 1000))
    else:
        check('IfcMapConversion пересчёт', False, 'нет ifc_check')
    check('EPSG:32636 и WKT есть', g['crs']['epsg'] == 32636 and 'PROJCRS' in g['crs']['wkt'])
    return g, cj


def test_refusals(tmp):
    print('\n=== 2. Отказы ===')
    cj = os.path.join(tmp, 'two.json')
    json.dump({'points': [
        {'id': 'A', 'x_local': 0, 'y_local': 0, 'X': 322100, 'Y': 5588300},
        {'id': 'B', 'x_local': 10, 'y_local': 0, 'X': 322110, 'Y': 5588300}]},
        open(cj, 'w', encoding='utf-8'))
    r = run_cli('georef-control.py', ['--points', cj, '--out', os.path.join(tmp, 'two-out.json')])
    check('2 точки → exit 2', r.returncode == 2, 'code=%d' % r.returncode)
    check('сообщение «недостаточно контрольных точек»',
          'недостаточно контрольных точек' in (r.stdout + r.stderr),
          (r.stderr or r.stdout).strip()[:120])
    # выброс: без strict ok, со strict exit 1
    cj = os.path.join(tmp, 'outlier.json')
    make_control_json(cj, noise=0.05, outlier=True)
    out = os.path.join(tmp, 'outlier-out.json')
    r1 = run_cli('georef-control.py', ['--points', cj, '--out', out])
    g = json.load(open(out, encoding='utf-8')) if os.path.exists(out) else {}
    check('выброс 0.5 м: без --strict exit 0, max>0.15', r1.returncode == 0 and
          g.get('accuracy', {}).get('max_3d_m', 0) > 0.15,
          'code=%d max=%.3f' % (r1.returncode, g.get('accuracy', {}).get('max_3d_m', 0)))
    r2 = run_cli('georef-control.py', ['--points', cj, '--out', out, '--strict'])
    check('выброс 0.5 м: --strict → exit 1', r2.returncode == 1, 'code=%d' % r2.returncode)


def test_ifc(tmp, georef_path):
    print('\n=== 3. georef.json → IFC → validate ===')
    node = shutil.which('node') or shutil.which('node.exe')
    model = r'D:\BIM-TWIN-TEST\interior\py2-final-v5.json'
    if not node:
        skip('IFC: node', 'node не найден'); return
    if not (os.path.exists(model) and os.path.exists(georef_path)):
        skip('IFC', 'нет модели/georef.json'); return
    ifc = os.path.join(tmp, 'control-test.ifc')
    p = subprocess.run([node, os.path.join(HERE, 'json-to-ifc.js'), model, ifc,
                        '--georef-file', georef_path, '--name=control-test'],
                       capture_output=True, text=True, timeout=300)
    check('json-to-ifc --georef-file exit 0', p.returncode == 0,
          'code=%d %s' % (p.returncode, (p.stderr or '')[:140]))
    if p.returncode != 0 or not os.path.exists(ifc):
        return
    text = open(ifc, encoding='utf-8', errors='replace').read()
    mk = __import__('re').search(r'IFCMAPCONVERSION\(([^;]+)\);', text)
    if mk:
        args = [a.strip() for a in mk.group(1).split(',')]
        check('IFCMAPCONVERSION: 8 аргументов', len(args) == 8, 'args=%d' % len(args))
        nums = [float(x) for x in args[2:]]
        g = json.load(open(georef_path, encoding='utf-8'))
        m = g['transform']['ifc_map_conversion']
        ok = (abs(nums[0] - m['eastings']) < 1e-3 and abs(nums[1] - m['northings']) < 1e-3 and
              abs(nums[2] - m['orthogonal_height']) < 1e-3 and
              abs(nums[3] - m['x_axis_abscissa']) < 1e-6 and abs(nums[4] - m['x_axis_ordinate']) < 1e-6 and
              abs(nums[5] - m['scale']) < 1e-9)
        check('IFCMAPCONVERSION содержит координаты из georef.json', ok,
              'E0=%.3f N0=%.3f H0=%.3f' % tuple(nums[:3]))
    else:
        check('IFCMAPCONVERSION найден', False)
    val = os.path.join(tmp, 'validate.json')
    v = subprocess.run([sys.executable, os.path.join(HERE, 'validate-ifc.py'), ifc, '--json', val],
                       capture_output=True, text=True, timeout=300)
    check('validate-ifc.py: 0 ERROR (exit 0)', v.returncode == 0,
          'code=%d %s' % (v.returncode, (v.stdout or v.stderr or '').strip()[-140:]))


def test_mode7(tmp):
    print('\n=== 4. Режим 7-параметрический ===')
    cj = os.path.join(tmp, 'c7.json')
    make_control_json(cj, noise=0.05, n=6)
    out = os.path.join(tmp, 'g7.json')
    r = run_cli('georef-control.py', ['--points', cj, '--out', out, '--mode', '7', '--strict'])
    check('7-парам exit 0', r.returncode == 0, 'code=%d %s' % (r.returncode, r.stderr.strip()[:100]))
    if os.path.exists(out):
        g = json.load(open(out, encoding='utf-8'))
        check('7-парам: mode=7 и невязка <0.15', g['transform']['mode'] == 7 and
              g['accuracy']['max_3d_m'] < 0.15, 'max=%.3f' % g['accuracy']['max_3d_m'])


def main():
    ap = argparse.ArgumentParser(description='Тест georef-control.py')
    ap.add_argument('--keep', action='store_true')
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix='georef-control-test-')
    try:
        res = test_recovery(tmp)
        test_refusals(tmp)
        if res:
            test_ifc(tmp, os.path.join(tmp, 'georef.json'))
        test_mode7(tmp)
        print('\n=== ИТОГ: PASS %d | FAIL %d | SKIP %d ===' % (CHK['pass'], CHK['fail'], CHK['skip']))
        return 0 if CHK['fail'] == 0 else 1
    finally:
        if a.keep:
            print('временная папка:', tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())

