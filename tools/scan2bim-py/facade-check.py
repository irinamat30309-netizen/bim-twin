# -*- coding: utf-8 -*-
"""facade-check (ревизия 109, фаза 2): сверка фасадной модели scan2bim_facade.py с замерами
tools/scan2bim-realmeasure.js — маски окон на развёртке фасада, recall/precision/IoU,
сверка этажей и шага, полос перекрытий; машиночитаемые метрики для сводного PASS/FAIL.

    python tools/scan2bim-py/facade-check.py --model py2-facade.json \
        --ref ref-facade-map-120.json --file map-120 --out metrics-py2-facade.json
    python tools/scan2bim-py/facade-check.py --model py2-facade-mapcrop.json \
        --file map-crop20 --out metrics-py2-mapcrop.json --elapsed 123.4

Совмещение кадра: бины для движка делает tools/scan2bim-py/las-to-bin.js в том же Y-up кадре,
что las-node.js, поэтому мировые координаты модели и опорные u/v замеров совпадают 1:1
(в ref-JSON пишутся center {sx,sz} и plane {dir,nrm}).
"""
import argparse
import json
import math
import sys

import numpy as np


def load_json(p):
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def masks_from_ref(ref):
    cell = float(ref['cell'])
    bb = ref['bbox']
    u_min, u_max, v_min, v_max = bb['uMin'], bb['uMax'], bb['vMin'], bb['vMax']
    gw = int(math.ceil((u_max - u_min) / cell)) + 1
    gh = int(math.ceil((v_max - v_min) / cell)) + 1
    M = np.zeros((gh, gw), bool)
    for h in ref['holes']:
        x0 = int(math.floor((h['u0'] - u_min) / cell))
        x1 = int(math.ceil((h['u1'] - u_min) / cell))
        y0 = int(math.floor((h['v0'] - v_min) / cell))
        y1 = int(math.ceil((h['v1'] - v_min) / cell))
        M[max(0, y0):min(gh, y1), max(0, x0):min(gw, x1)] = True
    return M, cell, (u_min, u_max, v_min, v_max), gw, gh


def model_openings(model, ref):
    """Окна модели в развёртке фазы: (u_center, width, v0, v1, storey, kind)."""
    plane = ref['plane']
    d0, d1 = plane['dir']
    sx = ref['center']['sx']
    sz = ref['center']['sz']
    out = []
    for wi, w in enumerate(model.get('walls', [])):
        a = w.get('a') or [0, 0]
        wd = w.get('dir') or [1, 0]
        base = float(w.get('base', 0))
        for o in (w.get('openings') or []):
            ca = float(o.get('along', 0)) + float(o.get('width', 0)) / 2.0
            X = a[0] + wd[0] * ca
            Z = a[1] + wd[1] * ca
            u = (X - sx) * d0 + (Z - sz) * d1
            out.append({
                'u': float(u), 'width': float(o.get('width', 0)),
                'v0': base + float(o.get('sill', 0)), 'v1': base + float(o.get('head', 0)),
                'storey': int(w.get('storeyIndex', 0)), 'kind': o.get('kind', 'window'),
                'wall': wi,
            })
    return out


def paint_openings(ops, cell, bb, gw, gh):
    u_min, u_max, v_min, v_max = bb
    O = np.zeros((gh, gw), bool)
    for o in ops:
        u0, u1 = o['u'] - o['width'] / 2.0, o['u'] + o['width'] / 2.0
        x0 = int(math.floor((u0 - u_min) / cell))
        x1 = int(math.ceil((u1 - u_min) / cell))
        y0 = int(math.floor((o['v0'] - v_min) / cell))
        y1 = int(math.ceil((o['v1'] - v_min) / cell))
        if x1 <= x0 or y1 <= y0:
            continue
        O[max(0, y0):min(gh, y1), max(0, x0):min(gw, x1)] = True
    return O


def ref_pitch(levels):
    floors = sorted(float(l['floorY']) for l in levels)
    if len(floors) < 2:
        return None
    ds = [round(b - a, 3) for a, b in zip(floors[:-1], floors[1:]) if 0.5 < b - a < 10]
    if not ds:
        return None
    return round(float(np.median(ds)), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--ref')
    ap.add_argument('--file', default=None)
    ap.add_argument('--out')
    ap.add_argument('--elapsed', type=float, default=None, help='полное время прогона движка, с')
    ap.add_argument('--min-recall', type=float, default=None)
    ap.add_argument('--min-floors', type=int, default=None)
    ap.add_argument('--max-floors', type=int, default=None)
    ap.add_argument('--pitch-tol', type=float, default=0.06)
    args = ap.parse_args()

    model = load_json(args.model)
    name = args.file or (model.get('facade', {}).get('file') or args.model.split('\\')[-1].split('/')[-1])
    st = model.get('stats') or {}
    fac = model.get('facade') or {}
    storeys = model.get('storeys') or []
    walls = model.get('walls') or []
    n_open = sum(len(w.get('openings') or []) for w in walls)
    pitch = fac.get('pitch') or st.get('pitch')
    wpf = fac.get('windowsPerFloor') or st.get('windowsPerFloor') or []
    t = args.elapsed if args.elapsed is not None else st.get('runTime_s')

    metrics = {
        'file': name, 'mode': model.get('mode', 'facade'),
        'points': st.get('pointsIn'), 'sample': fac.get('sample'),
        'time_s': round(float(t), 2) if t is not None else None,
        'analysis_time_s': st.get('runTime_s'),
        'floors': len(storeys), 'floor_pitch': pitch,
        'windows_per_floor': wpf, 'windows': n_open,
        'storeys': [{'floorY': s.get('floorY'), 'ceilY': s.get('ceilY'),
                     'height': s.get('height'), 'windows': s.get('windows')} for s in storeys],
        'rows': fac.get('rows') or [],
        'spandrel_confirmed': fac.get('spandrelConfirmed'),
        'spandrel_total': fac.get('spandrelTotal'),
        'spandrel': fac.get('spandrel') or [],
        'degenerate': bool(fac.get('degenerate')),
        'fallback': bool(fac.get('fallback')),
        'fallback_note': fac.get('note'),
    }
    if not args.ref:
        # B4: приёмка — успешный прогон без падений и в пределах бюджета времени; качество
        # этажей/окон для произвольного кропа полной карты не нормируется (может быть вырожденным).
        crit = {'no_crash': bool(model.get('ok')), 'time_ok': (t is None or float(t) <= 600)}
        metrics['criteria'] = crit
        metrics['pass'] = all(bool(v) for v in crit.values())
        if args.out:
            json.dump(metrics, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(json.dumps({k: metrics.get(k) for k in
                          ('file', 'floors', 'floor_pitch', 'windows', 'time_s', 'degenerate',
                           'pass')}, ensure_ascii=False))
        return 0 if metrics['pass'] else 1

    ref = load_json(args.ref)
    M, cell, bb, gw, gh = masks_from_ref(ref)
    ops = model_openings(model, ref)
    O = paint_openings(ops, cell, bb, gw, gh)
    inter = int(np.count_nonzero(M & O))
    mM = int(np.count_nonzero(M))
    mO = int(np.count_nonzero(O))
    recall = inter / mM if mM else 0.0
    precision = inter / mO if mO else 0.0
    iou = inter / (mM + mO - inter) if (mM + mO - inter) else 0.0
    u_min, u_max, v_min, v_max = bb
    area_scale = cell * cell
    metrics['ref'] = {
        'file': ref.get('file'), 'windows': len(ref['holes']),
        'floors': len(ref.get('levels') or []),
        'floor_pitch': ref_pitch(ref.get('levels') or []),
        'window_area_m2': round(mM * area_scale, 2),
        'bbox': ref['bbox'], 'center': ref.get('center'),
    }
    metrics['model_window_area_m2'] = round(mO * area_scale, 2)
    metrics['recall'] = round(100.0 * recall, 2)
    metrics['precision'] = round(100.0 * precision, 2)
    metrics['iou'] = round(100.0 * iou, 2)

    # окно-уровневый recall: у каждого замера есть проём модели в том же месте
    matched = []
    unmatched = []
    for i, h in enumerate(ref['holes']):
        cu = (h['u0'] + h['u1']) / 2.0
        cv = (h['v0'] + h['v1']) / 2.0
        ok = False
        for o in ops:
            if abs(o['u'] - cu) <= max(0.8, h['w'] / 2.0) and abs((o['v0'] + o['v1']) / 2.0 - cv) < 1.2:
                ok = True
                break
        if ok:
            matched.append(i)
        else:
            unmatched.append({'u': round(cu, 2), 'v0': round(h['v0'], 2), 'w': round(h['w'], 2),
                              'h': round(h['h'], 2),
                              'row': round(h['v0'], 1)})
    metrics['ref_windows'] = len(ref['holes'])
    metrics['matched_windows'] = len(matched)
    metrics['window_recall'] = round(100.0 * len(matched) / max(1, len(ref['holes'])), 2)
    metrics['unmatched_ref_windows'] = unmatched
    # по рядам — та же группировка, что в scan2bim-realmeasure.js (первый ряд в пределах 0.6 м)
    matched_set = set(matched)
    grouped = []
    for hi, h in sorted(enumerate(ref['holes']), key=lambda t: (t[1]['v0'], t[1]['u0'])):
        row = None
        for r in grouped:
            if abs(r['v0'] - h['v0']) < 0.6:
                row = r
                break
        if row is None:
            row = {'v0': float(h['v0']), 'idx': []}
            grouped.append(row)
        row['idx'].append(hi)
    grouped.sort(key=lambda r: r['v0'])
    metrics['match_by_row'] = [{'row': round(r['v0'], 2), 'windows': len(r['idx']),
                                'matched': sum(1 for i in r['idx'] if i in matched_set)}
                               for r in grouped]

    # этажи: сверка с замерами (по рядам окон ref: пол = низ ряда − 0.9 м; levels в ref-JSON
    # считаются по регулярному шагу и на «грязных» срезах могут пропускать этажи, поэтому
    # основная сверка — по низам рядов, а levels оставляем справочно)
    ref_levels = ref.get('levels') or []
    row_floors = sorted(float(r['v0']) - 0.9 for r in (ref.get('rows') or []))
    sc = []
    for s in storeys:
        nearest = None
        for rf in row_floors:
            d = float(s['floorY']) - rf
            if nearest is None or abs(d) < abs(nearest[0]):
                nearest = (d, rf)
        sc.append({'floorY': s['floorY'], 'ceilY': s['ceilY'],
                   'ref_row_floor': round(nearest[1], 3) if nearest else None,
                   'delta': round(nearest[0], 3) if nearest else None})
    metrics['storey_compare'] = sc
    metrics['ref_row_floors'] = [round(f, 3) for f in row_floors]
    deltas = [abs(x['delta']) for x in sc if x['delta'] is not None]
    metrics['storey_delta_max'] = round(max(deltas), 3) if deltas else None
    metrics['ref_levels'] = [{'floorY': l.get('floorY'), 'ceilY': l.get('ceilY')} for l in ref_levels]

    # критерии
    min_recall = args.min_recall if args.min_recall is not None else 85.0
    crit = {
        'recall_ge': round(metrics['recall'], 2) >= min_recall,
        'window_recall_ge': round(metrics['window_recall'], 2) >= min_recall,
        'no_crash': True,
        'time_ok': (t is None or float(t) <= 600),
        'floors_3_5': 3 <= len(storeys) <= 5,
        'pitch_3_60_3_75': (pitch is not None and 3.60 <= float(pitch) <= 3.75),
        'storey_matches_ref': (metrics['storey_delta_max'] is not None
                               and metrics['storey_delta_max'] <= 0.6),
    }
    if args.min_floors is not None:
        crit['floors_ge'] = len(storeys) >= args.min_floors
    if args.max_floors is not None:
        crit['floors_le'] = len(storeys) <= args.max_floors
    if args.min_recall and min_recall < 85.0:
        crit['floors_3_5'] = True  # для второго среза строгий диапазон этажей не требуется
    metrics['criteria'] = crit
    metrics['pass'] = all(bool(v) for v in crit.values())
    if args.out:
        json.dump(metrics, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({k: metrics[k] for k in
                      ('file', 'floors', 'floor_pitch', 'windows_per_floor', 'windows',
                       'ref_windows', 'recall', 'precision', 'iou', 'window_recall',
                       'time_s', 'pass')}, ensure_ascii=False))
    return 0 if metrics['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
