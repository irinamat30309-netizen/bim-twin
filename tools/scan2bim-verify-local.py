# -*- coding: utf-8 -*-
"""Проверка BIM-модели по облаку (локальный кадр): покрытие стен и труб, пустота проёмов.
   python verify-model.py cloud.bin details.json
"""
import json, math, sys
import numpy as np

P = np.fromfile(sys.argv[1], dtype=np.float32).reshape(-1, 3)
J = json.load(open(sys.argv[2], encoding='utf-8-sig'))
print(f'точек {len(P)}')

# --- покрытие стен: доля шагов вдоль оси, где есть точки в радиусе 0.2 м и по высоте стены
def wall_cov(w, r=0.2):
    a = np.array(w['a']); b = np.array(w['b'])
    L = float(np.linalg.norm(b - a))
    if L < 0.3: return 0.0, 0
    d = (b - a) / L
    n = max(4, int(L / 0.25))
    hit = 0
    for k in range(n + 1):
        s = L * k / n
        cx, cz = a[0] + d[0] * s, a[1] + d[1] * s
        dx = P[:, 0] - cx; dz = P[:, 2] - cz
        m = (dx * dx + dz * dz) <= r * r
        if not m.any(): continue
        ys = P[m, 1]
        if ((ys > 0.3) & (ys < 2.9)).sum() >= 2: hit += 1
    return hit / (n + 1), n + 1

covs = [wall_cov(w) for w in J['walls']]
for w, (c, n) in zip(J['walls'], covs):
    print(f"стена L={w['length']:.2f} м: покрытие {100*c:.0f} %")
print(f"среднее покрытие стен: {100*np.mean([c for c,_ in covs]):.0f} %")

# --- пустота проёмов: доля точек в прямоугольнике проёма (должна быть низкой)
def opening_void(w, o):
    a = np.array(w['a']); b = np.array(w['b'])
    L = float(np.linalg.norm(b - a)) or 1
    d = (b - a) / L
    s0 = o['along'] + 0.1; s1 = o['along'] + o['width'] - 0.1
    if s1 <= s0: return None
    nrm = np.array([-d[1], d[0]])
    z0 = (o.get('sill') or 0) + 0.15; z1 = (o.get('head') or 2.0) - 0.15
    if z1 <= z0: return None
    cnt = 0; tot = 0
    for k in range(6):
        s = s0 + (s1 - s0) * k / 5
        cx, cz = a[0] + d[0] * s, a[1] + d[1] * s
        dx = P[:, 0] - cx; dz = P[:, 2] - cz
        perp = dx * nrm[0] + dz * nrm[1]
        m = np.abs(perp) <= 0.12
        if not m.any(): continue
        ys = P[m, 1]
        cnt += int(((ys >= z0) & (ys <= z1)).sum()); tot += 1
    return cnt / max(1, tot)

empty = []
for w in J['walls']:
    for o in w.get('openings', []):
        v = opening_void(w, o)
        if v is not None: empty.append(v)
if empty:
    print(f"проёмы: точек в проёме в среднем {np.mean(empty):.1f} на сечение (меньше 5 — проём пустой)")

# --- трубы: покрытие по длине
def pipe_cov(p):
    a = np.array([p['a'][0], p['y'], p['a'][1]]); b = np.array([p['b'][0], p['y'], p['b'][1]])
    L = float(np.linalg.norm(b - a))
    if L < 0.3: return 0.0
    d = (b - a) / L
    n = max(4, int(L / 0.5))
    hit = 0
    for k in range(n + 1):
        c = a + d * (L * k / n)
        dd = P - c
        m = np.einsum('ij,ij->i', dd, dd) <= 0.25 ** 2
        if m.sum() >= 3: hit += 1
    return hit / (n + 1)
pc = [pipe_cov(p) for p in J['pipes']]
if pc:
    print(f"трубы: среднее покрытие по длине {100*np.mean(pc):.0f} % (мин {100*min(pc):.0f} %)")

# --- сумма площадей помещений против площади пола
area = sum(r['area'] for r in J['rooms'])
print("помещения: %d шт, суммарно %.1f кв.м, контур пола %.1f кв.м" % (len(J['rooms']), area, 184.3))
