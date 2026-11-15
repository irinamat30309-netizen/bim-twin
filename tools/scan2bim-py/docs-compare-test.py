#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""docs-compare-test.py — тесты docs-compare.py на синтетике (модель/облако с известными ошибками).

Запуск:
    python tools/scan2bim-py/docs-compare-test.py [-v]
Код возврата: 0 — все PASS; 1 — есть FAIL.

Сценарии:
  1. «хорошая» модель + синтетическое облако → высокий скор (≥80), нет FAIL, --strict exit 0;
  2. «плохая» модель (высота/толщины/двери/площади с ошибками) → скор ниже, FAIL-строки и
     рекомендации, --strict exit 1;
  3. неполная документация (нет толщин/дверей) → честные UNVERIFIED, скор по доступному,
     --strict exit 0.
Проверяется также схема compare.json (поля для UI: schema_version, score, rows, recommendations…).
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
PY = sys.executable
HERE = Path(__file__).resolve().parent
TOOL = HERE / 'docs-compare.py'

PASS = 0
FAIL = 0
ALLOWED_STATUS = {'PASS', 'WARN', 'FAIL', 'UNVERIFIED'}


def check(name: str, cond: bool, detail: str = ''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('PASS  %-74s %s' % (name, detail))
    else:
        FAIL += 1
        print('FAIL  %-74s %s' % (name, detail))


# ---------------------------------------------------------------- фикстуры
LAYOUT_W, LAYOUT_D = 6.0, 4.0


def room_polygons():
    """5 помещений внутри прямоугольника 6×4 (по вертикали/горизонтали)."""
    return [
        [[0, 0], [2, 0], [2, 2], [0, 2]],
        [[2, 0], [4, 0], [4, 2], [2, 2]],
        [[4, 0], [6, 0], [6, 2], [4, 2]],
        [[0, 2], [3, 2], [3, 4], [0, 4]],
        [[3, 2], [6, 2], [6, 4], [3, 4]],
    ]


def make_model(path: Path, bad: bool = False):
    height = 3.5 if bad else 3.278
    walls = []
    # наружные стены (толщина 0.3) + внутренняя перегородка 0.12
    outer = [((0.0, 0.0), (6.0, 0.0), 0.30), ((6.0, 0.0), (6.0, 4.0), 0.30),
             ((6.0, 4.0), (0.0, 4.0), 0.30), ((0.0, 4.0), (0.0, 0.0), 0.30),
             ((3.0, 0.0), (3.0, 2.0), 0.12)]
    if bad:
        # грубые ошибки: толщины 90/180 мм, высота 3500, проёмы 750/800
        outer = [((0.0, 0.0), (6.0, 0.0), 0.18), ((6.0, 0.0), (6.0, 4.0), 0.09),
                 ((6.0, 4.0), (0.0, 4.0), 0.18), ((0.0, 4.0), (0.0, 0.0), 0.09),
                 ((3.0, 0.0), (3.0, 2.0), 0.09)]
    else:
        # добавляем измеренные стены с толщинами из проектного сортамента (для PASS)
        outer += [((1.0, 1.0), (1.0, 1.6), 0.25), ((4.5, 1.0), (4.5, 1.6), 0.38),
                  ((2.0, 3.0), (2.4, 3.0), 0.40), ((4.8, 3.0), (5.2, 3.0), 0.51)]
    openings_widths = [0.75, 0.80] if bad else [0.9, 1.0, 1.4, 1.5]
    for i, (a, b, t) in enumerate(outer):
        ops = []
        if i < len(openings_widths):
            ops.append({'along': 0.6, 'width': openings_widths[i], 'sill': 0.0, 'head': 2.1,
                        'kind': 'door' if i % 2 == 0 else 'passage'})
        walls.append({'a': list(a), 'b': list(b), 'dir': [1.0, 0.0], 'thickness': t,
                      'length': math.hypot(b[0] - a[0], b[1] - a[1]), 'base': 0.0, 'height': height,
                      'openings': ops, 'passages': [], 'inferred': False, 'material': 'concrete',
                      'color': [0.5, 0.5, 0.5], 'rms': 0.02})
    areas = [3.2, 4.5, 10.0, 12.5, 24.2] if not bad else [8.0, 9.0, 11.0, 13.0, 20.0]
    rooms = [{'polygon': poly, 'area': ar, 'cx': 0.0, 'cz': 0.0, 'color': [0.5, 0.5, 0.5]}
             for poly, ar in zip(room_polygons(), areas)]
    model = {
        'ok': True, 'units': 'm',
        'storey': {'floorY': 0.0, 'ceilY': height, 'height': height},
        'walls': walls, 'slabs': [{'type': 'floor', 'level': 0.0, 'thickness': 0.1,
                                   'polygon': [[0, 0], [6, 0], [6, 4], [0, 4]]}],
        'rooms': rooms, 'pipes': [], 'beams': [], 'objects': [], 'cables': [],
        'stats': {'wallCount': len(walls), 'openingCount': sum(len(w['openings']) for w in walls),
                  'roomCount': len(rooms), 'floorArea': round(sum(areas), 2)},
    }
    path.write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding='utf-8')
    return model


def make_docs(path: Path, partial: bool = False):
    docs = {
        'schema_version': 1, 'tool': 'docs-extract.py', 'input_pages': 12,
        'object': {'name': 'Будівництво тестового лікувального корпусу',
                   'address': 'вул. Тестова, 1 в м. Києва', 'stage': 'ІІ черга'},
        'floors': {'marks_mm': [-4500, -400, 0, 3300, 3700, 7000, 7400],
                   'pitch_mm': 3700, 'slab_or_floor_thickness_mm': 400,
                   'clean_height_mm': 3300, 'floor_chain_mm': [-4500, 0, 3700, 7400],
                   'storeys_count': 3},
        'walls': {'thicknesses_mm': [] if partial else [120, 250, 380, 400, 510]},
        'doors': {'widths_mm': [] if partial else [600, 900, 1400]},
        'rooms': {'count': 5, 'areas_m2': [3.2, 4.5, 10.0, 12.5, 24.2],
                  'sum_area_m2': 54.4, 'corridor_areas_m2': [24.2],
                  'explication_totals': [{'page': 1, 'floor': '±0,000', 'total_area_m2': 54.4}]},
        'axes': {'pitch_mm': 7200, 'overall_dims_mm': [43200, 26400]},
        'sheets': {'count': 5, 'by_type': {'plan': 3, 'section': 1, 'schedule': 1}},
        'limitations': ['синтетическая документация (тест)'],
    }
    path.write_text(json.dumps(docs, ensure_ascii=False, indent=1), encoding='utf-8')
    return docs


def make_cloud(path: Path, height: float = 3.278):
    """Синтетическое облако комнаты 6×4: пол, потолок, 4 стены (две грани)."""
    pts = []
    step = 0.05
    W, D = LAYOUT_W, LAYOUT_D
    # пол и потолок
    for x in np.arange(0, W + 1e-9, step):
        for z in np.arange(0, D + 1e-9, step):
            pts.append((x, 0.0, z))
            pts.append((x, height, z))
    # стены: две грани у каждой (толщина 0.30 / 0.12)
    def wall(a, b, t):
        ax, az = a
        bx, bz = b
        L = math.hypot(bx - ax, bz - az)
        ux, uz = (bx - ax) / L, (bz - az) / L
        nx, nz = -uz, ux
        for s in np.arange(0, L + 1e-9, step * 2):
            for y in np.arange(0.02, height - 0.02, step * 2):
                for side in (-1, 1):
                    off = side * t / 2
                    pts.append((ax + ux * s + nx * off, y, az + uz * s + nz * off))
    wall((0, 0), (W, 0), 0.30)
    wall((W, 0), (W, D), 0.30)
    wall((W, D), (0, D), 0.30)
    wall((0, D), (0, 0), 0.30)
    wall((3.0, 0.0), (3.0, 2.0), 0.12)
    arr = np.zeros((len(pts), 6), dtype=np.float32)
    arr[:, 0:3] = np.array(pts, dtype=np.float32)
    arr[:, 3:6] = 0.5
    path.write_bytes(arr.tobytes())
    return len(pts)


def run_compare(docs: Path, model: Path, out: Path, cloud: Path = None, strict=False):
    cmd = [PY, '-u', str(TOOL), '--docs', str(docs), '--model', str(model), '--out', str(out)]
    if cloud is not None:
        cmd += ['--cloud', str(cloud)]
    else:
        cmd += ['--no-cloud']
    if strict:
        cmd += ['--strict']
    proc = subprocess.run(cmd, capture_output=True, timeout=900)
    stdout = (proc.stdout or b'').decode('utf-8', 'replace')
    data = None
    if out.exists():
        data = json.loads(out.read_text(encoding='utf-8'))
    return data, proc.returncode, stdout


def check_schema(data: dict):
    ok = (data.get('schema_version') == 1 and isinstance(data.get('score'), (int, float))
          and isinstance(data.get('rows'), list) and isinstance(data.get('recommendations'), list)
          and isinstance(data.get('limitations'), list) and isinstance(data.get('unverified'), list)
          and isinstance(data.get('summary'), dict) and 'grade' in data and 'coverage_pct' in data
          and isinstance((data.get('inputs') or {}).get('docs'), dict)
          and isinstance((data.get('inputs') or {}).get('model'), dict)
          and isinstance((data.get('inputs') or {}).get('cloud'), dict))
    check('схема compare.json (schema_version/score/rows/recommendations/inputs)', ok)
    bad = [r for r in data.get('rows', []) if r.get('status') not in ALLOWED_STATUS]
    check('все rows.status ∈ {PASS,WARN,FAIL,UNVERIFIED}', not bad,
          str([r.get('status') for r in bad][:5]))
    ids = [r.get('id') for r in data.get('rows', [])]
    check('в rows есть floor_height и wall_t_120', 'floor_height' in ids and 'wall_t_120' in ids, str(ids[:8]))


def by_id(rows, rid):
    return next((r for r in rows if r.get('id') == rid), None)


def main():
    print('=== docs-compare-test.py ===')
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix='docs_compare_test_') as td:
        tmp = Path(td)
        docs = tmp / 'docs.json'
        model = tmp / 'model.json'
        bad_model = tmp / 'model_bad.json'
        partial_docs = tmp / 'docs_partial.json'
        cloud = tmp / 'cloud.bin'
        make_docs(docs)
        make_docs(partial_docs, partial=True)
        make_model(model, bad=False)
        make_model(bad_model, bad=True)
        npts = make_cloud(cloud)
        print('      синтетическое облако: %d точек' % npts)

        # ---- 1. хорошая модель + облако ----
        out = tmp / 'compare_good.json'
        data, code, stdout = run_compare(docs, model, out, cloud=cloud, strict=True)
        good_elapsed = None
        check('good: код 0 (--strict)', code == 0, 'code=%d' % code)
        if data is None:
            check('good: compare.json создан', False, stdout[-300:])
            return 1
        check_schema(data)
        check('good: скор ≥ 80', data['score'] >= 80, 'score=%.1f' % data['score'])
        check('good: нет FAIL-строк', data['summary']['fail'] == 0,
              'fail=%d' % data['summary']['fail'])
        fh = by_id(data['rows'], 'floor_height')
        check('good: высота PASS', fh and fh['status'] == 'PASS', fh['status'] if fh else 'no row')
        check('good: облако измерено', bool((data['inputs'].get('cloud') or {}).get('measured')),
              str(data['inputs'].get('cloud', {}))[:100])
        wall = by_id(data['rows'], 'wall_t_120')
        check('good: толщина 120 PASS', wall and wall['status'] == 'PASS', wall['status'] if wall else 'no row')
        check('good: есть периметр/габариты', by_id(data['rows'], 'room_perimeter') is not None)

        # ---- 2. плохая модель (без облака) ----
        out_bad = tmp / 'compare_bad.json'
        data_bad, code_bad, stdout_bad = run_compare(docs, bad_model, out_bad, cloud=None, strict=True)
        check('bad: --strict exit 1', code_bad == 1, 'code=%d' % code_bad)
        check('bad: скор < 70', data_bad['score'] < 70 if data_bad else False,
              'score=%.1f' % (data_bad or {}).get('score', -1))
        check('bad: есть FAIL-строки', (data_bad or {}).get('summary', {}).get('fail', 0) > 0,
              str((data_bad or {}).get('summary')))
        fh_bad = by_id((data_bad or {}).get('rows', []), 'floor_height')
        check('bad: высота FAIL/WARN', fh_bad is not None and fh_bad['status'] in ('FAIL', 'WARN'),
              fh_bad['status'] if fh_bad else 'no row')
        recs = (data_bad or {}).get('recommendations') or []
        check('bad: рекомендации непустые и с числами',
              bool(recs) and any(('мм' in r.get('text', '')) for r in recs),
              '%d рекомендаций' % len(recs))

        # ---- 3. неполная документация ----
        out_part = tmp / 'compare_partial.json'
        data_p, code_p, stdout_p = run_compare(partial_docs, model, out_part, cloud=None, strict=True)
        check('partial: --strict exit 0', code_p == 0, 'code=%d' % code_p)
        if data_p:
            unv_ids = {u.get('id') for u in data_p.get('unverified', [])}
            check('partial: толщины/двери UNVERIFIED',
                  'wall_thicknesses' in unv_ids or 'door_widths' in unv_ids, str(unv_ids)[:120])
            check('partial: скор по доступным данным ≥ 70', data_p['score'] >= 70,
                  'score=%.1f coverage=%.0f%%' % (data_p['score'], data_p['coverage_pct']))
            check('partial: coverage < 90 %', data_p['coverage_pct'] < 90,
                  'coverage=%.0f%%' % data_p['coverage_pct'])

    print('-' * 100)
    print('ИТОГ: PASS %d, FAIL %d (время %.1f с)' % (PASS, FAIL, time.time() - t0))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
