# -*- coding: utf-8 -*-
"""Быстрая привязка модели v5 (локальный SLAM-кадр) к плану демонтажу подвала (PDF стр.21, M1:250).
   Векторизованная 4-параметрическая регистрация по измеренным стенам (масштаб 1:1)."""
import os, math, json
import numpy as np
import pymupdf

DOCS = r'D:\BIM-TWIN-TEST\docs'
MODEL = r'D:\BIM-TWIN-TEST\interior\py2-final-v5.json'
PAGE_NO = 21
SCALE = 0.3527777778 * 250.0

fs = [(os.path.getsize(os.path.join(r, f)), os.path.join(r, f)) for r, d, ff in os.walk(DOCS)
      for f in ff if f.lower().endswith('.pdf')]
fs.sort(reverse=True); BIG = fs[0][1]
doc = pymupdf.open(BIG); pg = doc[PAGE_NO - 1]
H = pg.rect.height
raw = []
for d in pg.get_drawings():
    for it in d.get('items', []):
        if it[0] == 'l':
            raw.append((it[1].x, it[1].y, it[2].x, it[2].y))
        elif it[0] == 're':
            r = it[1]
            raw += [(r.x0, r.y0, r.x1, r.y0), (r.x1, r.y0, r.x1, r.y1),
                    (r.x1, r.y1, r.x0, r.y1), (r.x0, r.y1, r.x0, r.y0)]
doc.close()

# отрезки плана в мм (Y вверх), только почти горизонтальные/вертикальные и длина 1.5..45 м
seg = []
for x1, y1, x2, y2 in raw:
    X1, Y1 = x1 * SCALE, (H - y1) * SCALE
    X2, Y2 = x2 * SCALE, (H - y2) * SCALE
    L = math.hypot(X2 - X1, Y2 - Y1)
    if not (1500 <= L <= 45000):
        continue
    a = math.degrees(math.atan2(Y2 - Y1, X2 - X1)) % 180
    if min(abs(a), abs(a - 180)) < 3.0:      # горизонталь
        seg.append(('h', (Y1 + Y2) / 2, min(X1, X2), max(X1, X2), L))
    elif abs(a - 90) < 3.0:                   # вертикаль
        seg.append(('v', (X1 + X2) / 2, min(Y1, Y2), max(Y1, Y2), L))
print('файл:', os.path.basename(BIG))
print('плановых отрезков h/v:', len(seg))

# слить коллинеарные отрезки в линии: ключ (тип, offset с шагом 20 мм), диапазон >= 1 м
groups = {}
for typ, off, a, b, L in seg:
    key = (typ, round(off / 20.0))
    if key not in groups:
        groups[key] = [off, a, b, L]
    else:
        g = groups[key]
        g[0] = 0.5 * (g[0] + off); g[1] = min(g[1], a); g[2] = max(g[2], b); g[3] += L
lines = []
for (typ, _), (off, a, b, Lsum) in groups.items():
    if b - a >= 800:
        lines.append({'type': typ, 'offset': off / 1000.0, 'start': a / 1000.0,
                      'end': b / 1000.0, 'len': (b - a) / 1000.0})
print('слитых линий плана:', len(lines), '| h:', sum(1 for l in lines if l['type'] == 'h'),
      '| v:', sum(1 for l in lines if l['type'] == 'v'))

# ---------- модель ----------
m = json.load(open(MODEL, encoding='utf-8-sig'))
cw = []
for w in m['walls']:
    if w.get('material') == 'inferred':
        continue
    ax, az = w['a']; bx, bz = w['b']
    L = math.hypot(bx - ax, bz - az)
    if L >= 1.2:
        cw.append({'a': (ax, az), 'b': (bx, bz), 'L': L, 'T': float(w.get('thickness', .15))})
print('измеренных стен:', len(cw), 'суммарно %.1f м' % sum(w['L'] for w in cw))


def ang(w):
    return math.atan2(w['b'][1] - w['a'][1], w['b'][0] - w['a'][0])


def R(theta):
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s], [s, c]])


def score(Rm, t, tol=300.0):
    total = 0.0; matched = 0
    for w in cw:
        p1 = Rm @ np.array(w['a']) + t; p2 = Rm @ np.array(w['b']) + t
        d = p2 - p1; L = np.linalg.norm(d)
        if L < 1e-6:
            continue
        u = d / L
        a = math.degrees(math.atan2(u[1], u[0])) % 180
        typ = 'h' if min(abs(a), abs(a - 180)) < 12 else ('v' if abs(a - 90) < 12 else None)
        if typ is None:
            continue
        best = 0.0
        for ln in lines:
            if ln['type'] != typ:
                continue
            if typ == 'h':
                dperp = abs(p1[1] - ln['offset'])
                s0, s1 = min(p1[0], p2[0]), max(p1[0], p2[0])
            else:
                dperp = abs(p1[0] - ln['offset'])
                s0, s1 = min(p1[1], p2[1]), max(p1[1], p2[1])
            if dperp > tol:
                continue
            ov = max(0.0, min(s1, ln['end']) - max(s0, ln['start']))
            if ov >= 0.35 * L:
                best = max(best, min(ov, L))
        total += best
        if best > 0.35 * L:
            matched += 1
    return total / max(sum(w['L'] for w in cw), 1e-9), matched


# ---------- кандидаты: коридорные пары ----------
def corridors(walls, is_plan):
    res = []
    for i in range(len(walls)):
        for j in range(i + 1, len(walls)):
            if is_plan:
                li, lj = walls[i], walls[j]
                if li['type'] != lj['type']:
                    continue
                if li['type'] == 'h':
                    off_i, off_j = li['offset'], lj['offset']
                    sep = abs(off_i - off_j)
                    # перекрытие по x
                    ov = max(0.0, min(li['end'], lj['end']) - max(li['start'], lj['start']))
                    Lmin = min(li['len'], lj['len'])
                else:
                    sep = abs(li['offset'] - lj['offset'])
                    ov = max(0.0, min(li['end'], lj['end']) - max(li['start'], lj['start']))
                    Lmin = min(li['len'], lj['len'])
                if 3.3 <= sep <= 3.9 and ov >= 8.0 and Lmin >= 8.0:
                    res.append((li, lj, sep, ov))
            else:
                wi, wj = walls[i], walls[j]
                if abs((ang(wi) - ang(wj) + math.pi / 2) % math.pi - math.pi / 2) > math.radians(3):
                    continue
                # расстояние между параллельными стенами
                u = np.array([math.cos(ang(wi)), math.sin(ang(wi))])
                n = np.array([-u[1], u[0]])
                sep = abs(np.dot(np.array(wi['a']) - np.array(wj['a']), n))
                if not (3.3 <= sep <= 3.9):
                    continue
                # перекрытие проекций
                ai0 = np.dot(np.array(wi['a']), u); ai1 = ai0 + wi['L']
                aj0 = np.dot(np.array(wj['a']), u); aj1 = aj0 + wj['L']
                ov = max(0.0, min(max(ai0, ai1), max(aj0, aj1)) - max(min(ai0, ai1), min(aj0, aj1)))
                if ov >= 6.0:
                    res.append((wi, wj, sep, ov))
    return res


cloud_corr = corridors(cw, False)
plan_corr = corridors(lines, True)
print('коридорных пар: облако %d | план %d' % (len(cloud_corr), len(plan_corr)))

best = None
for (wi, wj, csep, cov) in cloud_corr:
    ca = ang(wi)
    cmid = (np.array(wi['a']) + np.array(wi['b'])) / 2
    cn = np.array([-math.sin(ca), math.cos(ca)])
    # центр коридора облака
    ccenter = cmid + cn * (0.5 * (np.dot(np.array(wj['a']) - np.array(wi['a']), cn)))
    for (li, lj, psep, pov) in plan_corr:
        pa = 0.0 if li['type'] == 'h' else math.pi / 2
        for k in range(8):
            _kk = k if k < 4 else k - 4
            theta = pa + _kk * math.pi / 2 - ca
            _M = np.eye(2) if k < 4 else np.diag([1.0, -1.0])
            Rm = R(theta) @ _M
            for side in (1, -1):
                if li['type'] == 'h':
                    pcenter = np.array([(max(li['start'], lj['start']) + min(li['end'], lj['end'])) / 2,
                                        0.5 * (li['offset'] + lj['offset']) / 1000.0])
                    pcenter = np.array([(max(li['start'], lj['start']) + min(li['end'], lj['end'])) / 2 / 1000.0,
                                        0.5 * (li['offset'] + lj['offset']) / 1000.0])
                else:
                    pcenter = np.array([0.5 * (li['offset'] + lj['offset']) / 1000.0,
                                        (max(li['start'], lj['start']) + min(li['end'], lj['end'])) / 2 / 1000.0])
                if side < 0:
                    pcenter = pcenter + np.array([0, 0])  # same center, mirrored handled by rotation variants
                t = pcenter - Rm @ ccenter
                sc, mt = score(Rm, t)
                if best is None or sc > best[0]:
                    best = (sc, mt, theta, t.copy(), (wi, wj), (li, lj))

if best is None:
    print('кандидатов не найдено'); raise SystemExit(1)
sc, mt, theta, t, cpair, ppair = best
print('\nЛУЧШАЯ ПРИВЯЗКА: score %.1f %% | стен совпало %d/%d | поворот %.2f° | сдвиг (%.3f, %.3f) м'
      % (sc * 100, mt, len(cw), math.degrees(theta), t[0], t[1]))

# уточнение: МНК по перпендикулярным расстояниям к плановым линиям
Rm = R(theta)
sc150, mt150 = score(Rm, t, tol=150.0)
sc100, mt100 = score(Rm, t, tol=100.0)
print('при допуске 150 мм: %.1f %% (%d стен) | 100 мм: %.1f %% (%d стен)'
      % (sc150 * 100, mt150, sc100 * 100, mt100))
A = []; b = []
_matched_tol = {'tol300': round(sc * 100, 1), 'tol150': round(sc150 * 100, 1),
                'tol100': round(sc100 * 100, 1), 'matched150': mt150, 'matched100': mt100}
for w in cw:
    p1 = Rm @ np.array(w['a']) + t; p2 = Rm @ np.array(w['b']) + t
    d = p2 - p1; L = np.linalg.norm(d)
    a = math.degrees(math.atan2(d[1], d[0])) % 180
    typ = 'h' if min(abs(a), abs(a - 180)) < 12 else ('v' if abs(a - 90) < 12 else None)
    if typ is None: continue
    best_ln = None; bd = 1e9
    for ln in lines:
        if ln['type'] != typ: continue
        if typ == 'h':
            dist = abs(p1[1] - ln['offset'])
            s0, s1 = min(p1[0], p2[0]), max(p1[0], p2[0])
        else:
            dist = abs(p1[0] - ln['offset'])
            s0, s1 = min(p1[1], p2[1]), max(p1[1], p2[1])
        ov = max(0.0, min(s1, ln['end']) - max(s0, ln['start']))
        if dist < bd and ov >= 0.35 * L:
            bd = dist; best_ln = ln
    if best_ln is not None and bd < 0.6:
        if best_ln['type'] == 'h':
            A.append([0.0, 1.0]); b.append(best_ln['offset'] - p1[1])
        else:
            A.append([1.0, 0.0]); b.append(best_ln['offset'] - p1[0])
if A:
    dt = np.linalg.lstsq(np.array(A), np.array(b), rcond=None)[0]
    t = t + dt
    sc2, mt2 = score(Rm, t)
    print('уточнение: %.1f%% -> %.1f%% | сдвиг (%.3f, %.3f) м' % (sc * 100, sc2 * 100, t[0], t[1]))
    sc, mt = sc2, mt2

out = {'page': PAGE_NO, 'rotation_deg': math.degrees(theta), 'translation_m': [float(t[0]), float(t[1])],
       'score_pct': round(sc * 100, 1), 'matched_walls': mt, 'wall_count': len(cw),
       'cloud_corridor_pair': [{'a': list(cpair[0]['a']), 'b': list(cpair[0]['b'])},
                               {'a': list(cpair[1]['a']), 'b': list(cpair[1]['b'])}],
       'plan_corridor_pair': [dict(x) for x in ppair],
       'walls_in_plan_coords': []}
for w in cw:
    p1 = Rm @ np.array(w['a']) + t; p2 = Rm @ np.array(w['b']) + t
    out['walls_in_plan_coords'].append({'a': [round(float(p1[0]), 3), round(float(p1[1]), 3)],
                                        'b': [round(float(p2[0]), 3), round(float(p2[1]), 3)],
                                        'L': round(w['L'], 2), 'T': w['T']})
json.dump(out, open(r'D:\BIM-TWIN-TEST\docs\registration-v5.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('сохранено registration-v5.json')
