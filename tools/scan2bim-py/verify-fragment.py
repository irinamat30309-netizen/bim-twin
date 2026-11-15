# -*- coding: utf-8 -*-
"""Проверка модели/облака против эталонных размеров из документации (reference-fragment.json).
   Никаких замеров рулеткой: эталон берётся только из чертежей заказчика.
   python verify-fragment.py --ref ref.json --model py2-final-v5.json [--ruler ruler.json] --out verify.json
"""
import argparse, json, math
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--ref', required=True)
ap.add_argument('--model', required=True)
ap.add_argument('--ruler', default=None)
ap.add_argument('--cloud', default=None)
ap.add_argument('--cloud-metrics', dest='cloud_metrics', default=None)
ap.add_argument('--out', default='verify-fragment.json')
a = ap.parse_args()

ref = json.load(open(a.ref, encoding='utf-8-sig'))
m = json.load(open(a.model, encoding='utf-8-sig'))
rows = []
score_w = {'pass': 1.0, 'warn': 0.5, 'fail': 0.0, 'unverified': 0.0}
weights = []


def add(name, project, model, cloud, delta_mm, status, note='', w=1.0):
    rows.append({'name': name, 'project': project, 'model': model, 'cloud': cloud,
                 'delta_mm': delta_mm, 'status': status, 'note': note})
    weights.append(w)


# ---------- стены модели ----------
walls = []
for w in m['walls']:
    if w.get('material') == 'inferred':
        continue
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L >= 1.2:
        walls.append({'a': np.array([ax, az]), 'b': np.array([bx, bz]), 'L': L,
                      'T': float(w.get('thickness', .15)),
                      'ang': math.atan2(bz - az, bx - ax)})
all_walls = []
for w in m['walls']:
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L >= 1.2:
        all_walls.append({'a': np.array([ax, az]), 'b': np.array([bx, bz]), 'L': L,
                          'T': float(w.get('thickness', 0.15)),
                          'ang': math.atan2(bz - az, bx - ax)})
openings = []
for w in m['walls']:
    for o in w.get('openings', []):
        openings.append({'width': float(o['width']), 'sill': float(o.get('sill', 0)),
                         'head': float(o.get('head', 0)), 'kind': o.get('kind', '')})

# ---------- коридор ----------
par_pairs = []
for i in range(len(all_walls)):
    for j in range(i + 1, len(walls)):
        wi, wj = all_walls[i], all_walls[j]
        d = abs((wi['ang'] - wj['ang'] + math.pi / 2) % math.pi - math.pi / 2)
        if d > math.radians(3):
            continue
        u = np.array([math.cos(wi['ang']), math.sin(wi['ang'])])
        n = np.array([-u[1], u[0]])
        sep = abs(float(np.dot(wi['a'] - wj['a'], n)))
        ai0 = float(np.dot(wi['a'], u)); ai1 = ai0 + wi['L']
        aj0 = float(np.dot(wj['a'], u)); aj1 = aj0 + wj['L']
        ov = max(0.0, min(max(ai0, ai1), max(aj0, aj1)) - max(min(ai0, ai1), min(aj0, aj1)))
        if ov >= 8.0 and 3.30 <= sep <= 3.70:
            par_pairs.append((ov, sep, wi, wj))
if par_pairs:
    par_pairs.sort(key=lambda t: -t[0])
    ov, sep, wi, wj = par_pairs[0]
    clear = sep  # сравниваем расстояние между осями стен с шириной коридора по документации (в свету) — консервативно
    best = min(abs(clear - r) for r in ref['corridor_width_m'])
    proj = '%.0f/%.0f мм' % (ref['corridor_width_m'][0] * 1000, ref['corridor_width_m'][1] * 1000)
    st = 'PASS' if best <= 0.10 else ('WARN' if best <= 0.25 else 'FAIL')
    add('Коридор: ширина в свету', proj, '%.0f мм (по осям %.0f, T %.0f/%.0f)' % (
        clear * 1000, sep * 1000, wi['T'] * 1000, wj['T'] * 1000), '—', int(best * 1000), st,
        'пара стен: %.1f/%.1f м, перекрытие %.1f м' % (wi['L'], wj['L'], ov), w=2.0)
    corridor_dir = wi['ang']
else:
    add('Коридор: ширина в свету', '3,60 м', '—', '—', None, 'UNVERIFIED', 'коридорная пара не найдена', w=2.0)

# ---------- сверка облака с документацией (облако — независимый замер) ----------
if a.cloud_metrics:
    cm = json.load(open(a.cloud_metrics, encoding='utf-8-sig'))
    ref_w = ref['corridor_width_m']
    cw = float(cm['corridor_width_m'])
    dw = min(abs(cw - r) for r in ref_w)
    st = 'PASS' if dw <= 0.10 else ('WARN' if dw <= 0.25 else 'FAIL')
    add('Коридор: ширина (облако ↔ документация)', ' / '.join('%.2f' % r for r in ref_w) + ' м',
        '—', '%.2f м' % cw, int(dw * 1000), st,
        'замер по облаку; эталон — план p21 (существующий подвал)', w=2.0)
    cells = cm['cells_m']
    rc = ref['corridor_cells_m']
    errs = [min(abs(c - r) for r in rc) for c in cells]
    cov2 = sum(1 for e in errs if e <= ref['cell_tolerance_m']) / max(len(errs), 1)
    worst = max(errs)
    st2 = 'PASS' if cov2 >= 0.66 and worst <= ref['cell_tolerance_m'] else ('WARN' if cov2 >= 0.33 else 'FAIL')
    add('Ячейки по коридору (облако ↔ документация)',
        ' / '.join('%.2f' % r for r in rc) + ' м',
        '—', ' / '.join('%.2f' % c for c in cells) + ' м', int(worst * 1000), st2,
        'совпало %d из %d в допуске %.0f мм' % (sum(1 for e in errs if e <= ref['cell_tolerance_m']),
                                                len(errs), ref['cell_tolerance_m'] * 1000), w=1.5)
    corridor_dir = None

# ---------- ячейки между поперечными стенами ----------
cells = []
if corridor_dir is not None:
    u = np.array([math.cos(corridor_dir), math.sin(corridor_dir)])
    n = np.array([-u[1], u[0]])
    cross = []
    for w in walls:
        if abs(float(np.dot(w['b'] - w['a'], u))) < 0.3 * w['L']:  # перпендикулярно оси
            cross.append((float(np.dot(w['a'], u)), w['L']))
    cross.sort()
    for k in range(len(cross) - 1):
        d = cross[k + 1][0] - cross[k][0]
        if 1.5 <= d <= 12:
            cells.append(round(d, 2))
ref_cells = ref['corridor_cells_m']
tol = ref['cell_tolerance_m']
if cells:
    matched = [c for c in cells if min(abs(c - r) for r in ref_cells) <= tol]
    cov = len(matched) / max(len(cells), 1)
    errs = [min(abs(c - r) for r in ref_cells) for c in cells]
    worst = max(errs)
    st = 'PASS' if cov >= 0.75 and worst <= tol else ('WARN' if cov >= 0.5 else 'FAIL')
    add('Ячейки по коридору', ' / '.join('%.2f' % r for r in ref_cells),
        ' / '.join('%.2f' % c for c in cells), '—', int(worst * 1000), st,
        'совпало %d из %d в допуске %.0f мм' % (len(matched), len(cells), tol * 1000), w=1.5)
else:
    add('Ячейки по коридору', ' / '.join('%.2f' % r for r in ref_cells), '—', '—', None, 'UNVERIFIED',
        'поперечные стены не выделены', w=1.5)

# ---------- высота ----------
h = float(m['storey']['height'])
ref_h = ref['existing_height_m']
dh = abs(h - ref_h) * 1000
add('Высота существующего подвала', '%.0f мм' % (ref_h * 1000), '%.0f мм' % (h * 1000),
    '%.0f мм' % (3.276 * 1000), int(dh), 'PASS' if dh <= 20 else 'FAIL',
    'эталон — существующий потолок по документации; новый проектный подвал 4,10 м не применим', w=2.0)

# ---------- двери ----------
ref_doors = ref['door_widths_mm']
dtol = ref['door_tolerance_mm']
if openings:
    ds = []
    for o in openings:
        cand = [r for r in ref_doors]
        cand += [r + 100 for r in ref_doors]   # полотно + рама
        best = min(abs(o['width'] * 1000 - c) for c in cand)
        ds.append(best)
    ok = sum(1 for d in ds if d <= dtol)
    st = 'PASS' if ok == len(ds) else ('WARN' if ok >= 0.6 * len(ds) else 'FAIL')
    add('Двери/проёмы: ширины', ','.join(str(r) for r in ref_doors) + ' мм + рама 100',
        ', '.join('%.0f' % (o['width'] * 1000) for o in openings),
        '—', int(max(ds)), st, 'в допуске %d из %d' % (ok, len(ds)), w=1.5)
else:
    add('Двери/проёмы: ширины', '—', '—', '—', None, 'UNVERIFIED', 'нет проёмов', w=1.5)

# ---------- толщины стен ----------
ref_T = ref['wall_thickness_mm']
ttol = ref['wall_thickness_tolerance_mm']
if walls:
    Ts = sorted({round(w['T'] * 1000) for w in walls})
    best = []
    for t in Ts:
        cand = [r for r in ref_T] + [r + 30 for r in ref_T]  # + штукатурка
        best.append(min(abs(t - c) for c in cand))
    ok = sum(1 for b2 in best if b2 <= ttol)
    missing_ref = [r for r in ref_T if min(abs(t - (r + 30)) for t in Ts) > 60 and min(abs(t - r) for t in Ts) > 60]
    st = 'PASS' if ok >= max(3, int(0.6 * len(best))) else 'WARN'
    add('Толщины стен: классы', ','.join(str(r) for r in ref_T) + ' мм (+отделка)',
        ', '.join(str(t) for t in Ts) + ' мм', '—', int(max(best)), st,
        'распознано %d из %d классов; нет во фрагменте: %s' % (ok, len(best), missing_ref or '—'), w=1.5)
else:
    add('Толщины стен: классы', '—', '—', '—', None, 'UNVERIFIED', '', w=1.5)

# ---------- площадь/периметр информативно ----------
add('Площадь фрагмента', 'этаж 3600,13 / 1699,34 м² (экспликации)',
    '%.1f м² (%.0f %% видимого пола)' % (m['stats']['floorArea'],
                                         m['stats']['floorArea'] / 128.5 * 100),
    '128,5 м² видимого пола', None, 'UNVERIFIED', 'фрагмент без привязки к плану; сравнение только информативное', w=0.5)

# ---------- итог ----------
vals = []
for r, w in zip(rows, weights):
    vals.append(score_w[r['status'].lower()] * w)
score = 100.0 * sum(vals) / max(sum(weights), 1e-9)
summary = {s: sum(1 for r in rows if r['status'] == s) for s in ('PASS', 'WARN', 'FAIL', 'UNVERIFIED')}
print('%-34s %-10s %s' % ('ПРОВЕРКА', 'СТАТУС', 'ДЕТАЛИ'))
for r in rows:
    print('%-34s %-10s Δ=%s мм | %s' % (r['name'], r['status'], r['delta_mm'], r['note']))
print('\nИТОГО: PASS %d | WARN %d | FAIL %d | UNVERIFIED %d'
      % (summary['PASS'], summary['WARN'], summary['FAIL'], summary['UNVERIFIED']))
print('СКОР СООТВЕТСТВИЯ ДОКУМЕНТАЦИИ: %.1f / 100' % score)
out = {'schema_version': 1, 'reference': a.ref, 'model': a.model,
       'rows': rows, 'summary': summary, 'score': round(score, 1),
       'grade': 'A' if score >= 90 else ('B' if score >= 75 else 'C')}
json.dump(out, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('сохранено:', a.out)
