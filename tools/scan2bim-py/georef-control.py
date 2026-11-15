# -*- coding: utf-8 -*-
"""georef-control.py — привязка модели/облака к координатам проекта по КОНТРОЛЬНЫМ ТОЧКАМ.

Вход: control.json — список точек с локальными координатами скана и координатами проекта:
  {"points":[
     {"id":"A","x_local":-50.0,"y_local":20.0,"z_local":3.0,"X":322100.0,"Y":5588300.0,"Z":210.5,"weight":1.0},
     ...]}
 где x_local,y_local — план в кадре облака (LAS/скана), z_local — высота;
     X,Y — координаты проекта (UTM 36N/EPSG:32636 или УСК-Київ), Z — высота (для 7-парам).

Подбирает 4-параметрическую (поворот+масштаб+сдвиг) или 7-параметрическую (3D Helmert)
трансформацию локальные→проектные, считает невязки (rms/max по точкам), пишет georef.json
в схеме georef-rtk (готов для `json-to-ifc.js --georef-file`) и печатает таблицу.
--strict: exit 1, если max невязка > порога (0.15 м) или точек <3.

Запуск:
  python tools/scan2bim-py/georef-control.py --points control.json --out georef.json [--strict]
  python tools/scan2bim-py/georef-control.py --points control.json --mode 7 --epsg 32636
Коды: 0 — успех; 2 — <3 точек/нет данных; 1 — strict не выполнен.
"""
import argparse
import importlib.util
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load_georef_rtk():
    spec = importlib.util.spec_from_file_location('georef_rtk', os.path.join(HERE, 'georef-rtk.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


G = load_georef_rtk()

DEFAULT_EPSG = 32636          # WGS84 / UTM zone 36N


def parse_points(path):
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    data = json.load(open(path, encoding='utf-8-sig'))
    pts = data.get('points') if isinstance(data, dict) else data
    if not isinstance(pts, list) or not pts:
        raise ValueError('control.json: нет списка points')
    out = []
    for i, p in enumerate(pts):
        try:
            rec = {'id': str(p.get('id', i + 1)),
                   'x': float(p['x_local']), 'y': float(p['y_local']),
                   'X': float(p['X']), 'Y': float(p['Y']) if 'Y' in p else float(p['y_project']),
                   'weight': float(p.get('weight', 1.0))}
            zl = p.get('z_local')
            Z = p.get('Z', p.get('z_project'))
            rec['z'] = float(zl) if zl is not None else None
            rec['Z'] = float(Z) if Z is not None else None
            out.append(rec)
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError('точка %d: %s' % (i + 1, e))
    return out, data if isinstance(data, dict) else {}


def fit_similarity(points, mode):
    """Возвращает dict с rotation_deg/scale/translation/residuals/rms/max."""
    pts = [{'X': p['x'], 'Y': p['y'], 'Z': (p['z'] if p['z'] is not None else 0.0),
            'E': p['X'], 'N': p['Y'], 'H': (p['Z'] if p['Z'] is not None else 0.0)} for p in points]
    if mode == 7 and all(p['Z'] is not None and p['z'] is not None for p in points):
        tr = G.fit_7param(pts)
        z_scale, tz = tr['scale'], tr['translation'][2]
        # 4-параметрическая часть по плану для IfcMapConversion
        tr4 = G.fit_4param(pts)
        return {'mode': 7, 'plan': tr4, 'full': tr, 'z_scale': z_scale, 'tz': tz}
    tr = G.fit_4param(pts)
    z_scale, tz = G.fit_height(pts, fit_scale=False) if all(p['Z'] is not None for p in points) else (1.0, 0.0)
    return {'mode': 4, 'plan': tr, 'z_scale': z_scale, 'tz': tz}


def run(points_path, out_path, epsg=32636, crs_name=None, crs_wkt=None, mode='auto',
        strict=False, tol=0.15, height_note=None):
    points, meta = parse_points(points_path)
    n = len(points)
    report = {'schema': 'georef-control/1',
              'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
              'points_file': os.path.abspath(points_path),
              'source': meta.get('source') or 'control points',
              'n_points': n, 'warnings': [], 'ok': False}
    if n < 3:
        report['error'] = 'точек %d < 3 — нельзя оценить трансформацию' % n
        return 2, report, 'недостаточно контрольных точек: %d (нужно >=3)' % n
    if mode == 'auto':
        mode_i = 7 if all(p['z'] is not None and p['Z'] is not None for p in points) else 4
    else:
        mode_i = int(mode)
    try:
        fit = fit_similarity(points, mode_i)
    except ValueError as e:
        report['error'] = str(e)
        return 2, report, 'не удалось подобрать трансформацию: %s' % e
    tr = fit['plan']
    # невязки
    rot = tr['rotation_deg']
    scale = tr['scale']
    tx, ty = tr['translation']
    tz = fit['tz']
    z_scale = fit['z_scale']
    residual = []
    for p, r in zip(points, tr['residuals']):
        d3 = None
        if p['Z'] is not None and p['z'] is not None:
            h_pred = z_scale * p['z'] + tz
            d3 = math.hypot(r['d2d'], h_pred - p['Z'])
        residual.append({'id': p['id'],
                         'local': [round(p['x'], 4), round(p['y'], 4), p['z']],
                         'project': [round(p['X'], 4), round(p['Y'], 4), p['Z']],
                         'pred': [round(r['pred_e'], 4), round(r['pred_n'], 4),
                                  round(z_scale * (p['z'] or 0) + tz, 4) if p['Z'] is not None else None],
                         'd2d_m': round(r['d2d'], 4),
                         'd3d_m': round(d3, 4) if d3 is not None else None})
    rms2 = tr['rms_2d']
    max2 = tr['max_2d']
    rms3 = math.sqrt(sum(x['d3d_m'] ** 2 for x in residual if x['d3d_m'] is not None) /
                     max(1, sum(1 for x in residual if x['d3d_m'] is not None)))
    max3 = max([x['d3d_m'] for x in residual if x['d3d_m'] is not None] or [max2])
    ok = (max3 <= tol)
    if not ok:
        report['warnings'].append('max невязка %.3f м > %.3f м' % (max3, tol))
    # WKT / EPSG
    if crs_wkt:
        wkt = crs_wkt
        epsg_used = epsg
    elif epsg and int(epsg) > 0:
        z, datum, hemi = G.datum_of_epsg(int(epsg))
        if z is None:
            return 1, report, 'неподдерживаемый EPSG: %s (25801–25860, 32601–32660)' % epsg
        wkt = G.wkt_utm(z, datum, hemi)
        epsg_used = int(epsg)
    else:
        # локальная/УСК система: инженерный CRS без геодезической основы
        wkt = ('LOCAL_CS["УСК/местная",LOCAL_DATUM["local",0],UNIT["metre",1],'
               'AXIS["X",EAST],AXIS["Y",NORTH],ORDER[1]]')
        epsg_used = 0
    crs_name = crs_name or ('EPSG:%d' % epsg_used if epsg_used else 'УСК/местная')
    # IfcMapConversion
    rot_rad = math.radians(rot)
    ifc = {'eastings': tx, 'northings': ty, 'orthogonal_height': tz,
           'x_axis_abscissa': math.cos(rot_rad), 'x_axis_ordinate': math.sin(rot_rad),
           'scale': z_scale if mode_i == 7 else scale}
    # ВАЖНО: если z_scale != scale — IFC не может иметь два масштаба; берём горизонтальный,
    # вертикальную разницу фиксируем в warnings.
    if abs((z_scale or 1.0) - scale) > 1e-4:
        report['warnings'].append('масштаб плана %.6f и высоты %.6f различаются — IFC '
                                  'использует горизонтальный масштаб (вертикаль ~%.1f м)'
                                  % (scale, z_scale, tz))
        ifc['scale'] = scale
        ifc['orthogonal_height'] = tz
    # проверка IfcMapConversion на точках (сравнение с предсказанием МНК)
    ifc_check = []
    for p, r in zip(points, tr['residuals']):
        e = ifc['eastings'] + ifc['scale'] * (ifc['x_axis_abscissa'] * p['x'] -
                                              ifc['x_axis_ordinate'] * p['y'])
        nn = ifc['northings'] + ifc['scale'] * (ifc['x_axis_ordinate'] * p['x'] +
                                                ifc['x_axis_abscissa'] * p['y'])
        ifc_check.append({'id': p['id'], 'err2d': round(math.hypot(e - r['pred_e'], nn - r['pred_n']), 9)})
    report.update({
        'crs': {'epsg': epsg_used, 'name': crs_name, 'wkt': wkt},
        'transform': {'mode': mode_i, 'rotation_deg': rot, 'scale': scale,
                      'translation': [tx, ty, tz],
                      'z_scale': z_scale,
                      'ifc_map_conversion': ifc,
                      'ifc_check': ifc_check,
                      'residual_per_point': residual},
        'accuracy': {'rms_2d_m': rms2, 'max_2d_m': max2, 'rms_3d_m': rms3, 'max_3d_m': max3,
                     'tol_strict_m': tol, 'points': n, 'passed_strict': bool(ok)},
        'ok': bool(ok),
        'strict': bool(strict),
        'height_note': height_note,
    })
    if out_path:
        d = os.path.dirname(os.path.abspath(out_path))
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = out_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        os.replace(tmp, out_path)
    # ---- печать ----
    print('=== georef-control: %d точек, источник: %s ===' % (n, report['source']))
    print('CRS:', crs_name, '| EPSG:', epsg_used)
    print('Трансформация %d-парам: поворот %.6f°, масштаб %.8f, сдвиг E0=%.4f N0=%.4f H0=%.4f'
          % (mode_i, rot, scale, tx, ty, tz))
    print('Невязки: rms %.4f м, max %.4f м (2D); 3D rms %.4f / max %.4f' % (rms2, max2, rms3, max3))
    print('\n%-6s %-26s %-28s %-10s %-10s' % ('id', 'локальные (x,y,z)', 'проект (X,Y,Z)',
                                              '2D, мм', '3D, мм'))
    for x in residual:
        print('%-6s %-26s %-28s %-10.1f %-10s' % (
            x['id'], str(x['local'])[:26], str(x['project'])[:28], x['d2d_m'] * 1000,
            ('%.1f' % (x['d3d_m'] * 1000)) if x['d3d_m'] is not None else '—'))
    for w in report['warnings']:
        print('ВНИМАНИЕ:', w)
    if out_path:
        print('\nзаписано:', os.path.abspath(out_path))
    if strict and not ok:
        return 1, report, 'strict: max невязка %.3f м > %.3f м' % (max3, tol)
    return 0, report, 'ok'


def main(argv=None):
    ap = argparse.ArgumentParser(description='Привязка по контрольным точкам (4/7-парам, IfcMapConversion)')
    ap.add_argument('--points', required=True, help='control.json (id,x_local,y_local,z_local,X,Y,Z[,weight])')
    ap.add_argument('--out', default='georef.json')
    ap.add_argument('--model', default=None, help='модель JSON (для сведения bbox; необязательно)')
    ap.add_argument('--mode', default='auto', choices=['auto', '4', '7'])
    ap.add_argument('--epsg', default=str(DEFAULT_EPSG),
                    help='EPSG проекта: 32636 (WGS84/UTM36N) по умолчанию; 0/пусто — УСК/местная')
    ap.add_argument('--crs-name', default=None)
    ap.add_argument('--crs-wkt-file', default=None, help='файл с WKT проектной системы')
    ap.add_argument('--strict', action='store_true', help='exit 1 при max невязке > порога')
    ap.add_argument('--tol', type=float, default=0.15, help='порог невязки для --strict, м (0.15)')
    a = ap.parse_args(argv)
    crs_wkt = None
    if a.crs_wkt_file:
        crs_wkt = open(a.crs_wkt_file, encoding='utf-8').read().strip()
    try:
        code, rep, msg = run(a.points, a.out, epsg=int(a.epsg) if str(a.epsg) else 0,
                             crs_name=a.crs_name, crs_wkt=crs_wkt, mode=a.mode,
                             strict=a.strict, tol=a.tol)
    except FileNotFoundError as e:
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 2
    except (ValueError, KeyError) as e:
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 1
    if code != 0:
        print('РЕЗУЛЬТАТ:', msg, file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
