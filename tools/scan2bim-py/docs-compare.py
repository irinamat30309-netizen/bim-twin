#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""docs-compare.py — сравнение проектной документации с BIM-моделью и облаком точек.

Блок 2 ROADMAP-DOCS-AI.md (шаг 2.2/2.3): «проект ↔ модель ↔ облако», Δ в мм/%, скор
соответствия 0–100, рекомендации, честные UNVERIFIED там, где в проекте нет размера.

Вход:
  --docs   docs.json   (результат docs-extract.py)
  --model  model.json  (модель scan2bim-v2, например py2-final-v4.json)
  --cloud  cloud.bin   (float32 x,y,z,r,g,b, Y вверх; необязателен — тогда облако UNVERIFIED)
Выход:
  --out compare.json + таблица в stdout.
Код возврата: 0 — успех; 1 — при --strict, если скор < --strict-score или есть критичный FAIL;
              2 — ошибка входных данных/окружения.

Пороговые допуски (константы, обоснованы в DOCS-ASSISTANT.md):
  * высота этажа: модель/облако vs проект — 50 мм (проект задаёт «чистую» высоту, ±22 мм норма);
  * шаг этажа: 50 мм; толщина стен: PASS ≤30 мм (с учётом отделки 40 мм), WARN ≤80 мм;
    двери: проект задаёт полотно, проём = полотно + рама (~100 мм): PASS если модель попала
    в [d+40; d+180], WARN ≤150 мм от ожидаемой середины; площадь/периметр/габариты — %
    (фрагмент модели может не совпадать с планом этажа — статус UNVERIFIED с пометкой).

Скор: взвешенно только по категориям, где ЕСТЬ данные проекта: высота 30, толщины стен 30,
двери 20, шаг этажа 10, площадь 10 (если сопоставима). coverage_pct — доля веса,
покрытая проверенными категориями.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

SCHEMA_VERSION = 1
SCRIPT_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------- допуски
TOL_HEIGHT_MM = 50.0
TOL_PITCH_MM = 50.0
TOL_WALL_PASS_MM = 30.0
TOL_WALL_WARN_MM = 80.0
WALL_FINISH_MM = 40.0          # отделка кирпича/штукатурка: проект 250 → чистовая ~290
DOOR_FRAME_MM = 100.0          # рама двери: полотно 900 → проём ~1000
TOL_DOOR_PASS_MM = 60.0
TOL_DOOR_WARN_MM = 150.0
TOL_AREA_PCT = 15.0
TOL_PERIMETER_PCT = 15.0
TOL_BBOX_PCT = 10.0
SCORE_GRADE = ((85, 'A'), (70, 'B'), (55, 'C'), (40, 'D'))


def log(msg: str) -> None:
    print(msg, flush=True)


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def linear_score(err: float, tol: float) -> float:
    """1.0 при err<=tol, 0 при err>=3*tol."""
    if err <= tol:
        return 1.0
    return clamp01(1.0 - (err - tol) / (2.0 * tol))


def grade_of(score: float) -> str:
    for thr, g in SCORE_GRADE:
        if score >= thr:
            return g
    return 'E'


def fmt_mm(v):
    if v is None:
        return '—'
    if abs(v) < 1:
        return '%.1f' % v
    return '%d' % round(v)


def fmt_pct(v):
    if v is None:
        return '—'
    return '%+.1f%%' % v


# ---------------------------------------------------------------- модель
def load_model(path: Path):
    import hashlib
    raw = path.read_bytes()
    data = json.loads(raw.decode('utf-8-sig'))
    walls = data.get('walls') or []
    measured = [w for w in walls if not (w.get('inferred') or w.get('material') == 'inferred')]
    thick = [round(float(w['thickness']) * 1000.0) for w in measured if w.get('thickness')]
    thick_clusters = Counter(round(v / 5.0) * 5 for v in thick)
    openings = []
    for w in walls:
        for o in (w.get('openings') or []):
            openings.append({'width_mm': round(float(o.get('width', 0)) * 1000.0),
                             'kind': o.get('kind') or 'door'})
    rooms = data.get('rooms') or []
    areas = [float(r.get('area') or 0.0) for r in rooms]
    perim = 0.0
    xs, zs = [], []
    for w in walls:
        for p in (w.get('a'), w.get('b')):
            if p:
                xs.append(float(p[0]))
                zs.append(float(p[1]))
    for r in rooms:
        poly = r.get('polygon') or []
        for i in range(len(poly)):
            x0, z0 = poly[i]
            x1, z1 = poly[(i + 1) % len(poly)]
            perim += math.hypot(float(x1) - float(x0), float(z1) - float(z0))
            xs.append(float(x0))
            zs.append(float(z0))
    # внешний периметр объединения помещений (сопоставим с внешней границей пола облака)
    union_perimeter = None
    try:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
        polys = []
        for r in rooms:
            poly = r.get('polygon') or []
            if len(poly) >= 3:
                try:
                    polys.append(Polygon([(float(x), float(z)) for x, z in poly]))
                except Exception:  # noqa: BLE001
                    pass
        if polys:
            u = unary_union(polys)
            union_perimeter = round(float(u.length), 2)
    except Exception:  # noqa: BLE001
        union_perimeter = None

    storey = data.get('storey') or {}
    return {
        'path': str(path),
        'md5': hashlib.md5(raw).hexdigest().upper(),
        'raw': data,
        'height_mm': round(float(storey.get('height') or 0.0) * 1000.0, 1),
        'floor_y_mm': round(float(storey.get('floorY') or 0.0) * 1000.0, 1),
        'ceil_y_mm': round(float(storey.get('ceilY') or 0.0) * 1000.0, 1),
        'walls_total': len(walls),
        'walls_measured': len(measured),
        'wall_thickness_clusters': {v: c for v, c in sorted(thick_clusters.items())},
        'wall_thicknesses_mm': sorted(thick),
        'openings': openings,
        'door_widths_mm': sorted({o['width_mm'] for o in openings if o['kind'] in ('door', 'passage')}),
        'window_widths_mm': sorted({o['width_mm'] for o in openings if o['kind'] == 'window'}),
        'rooms': len(rooms),
        'room_areas_m2': sorted(areas),
        'rooms_area_m2': round(sum(areas), 2),
        'rooms_perimeter_m': round(perim, 2),
        'rooms_perimeter_union_m': union_perimeter,
        'bbox': {'x_m': round(max(xs) - min(xs), 2) if xs else None,
                 'z_m': round(max(zs) - min(zs), 2) if zs else None},
        'stats': data.get('stats') or {},
    }


# ---------------------------------------------------------------- облако
def run_ruler(python: str, cloud: Path, model: Path, out_json: Path):
    env = dict(**__import__('os').environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    cmd = [python, str(SCRIPT_DIR / 'ruler-v2.py'), str(cloud), str(model), str(out_json)]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=900, env=env)
    except subprocess.TimeoutExpired:
        return None, 'ruler-v2.py: таймаут 900 с'
    if proc.returncode != 0 or not out_json.exists():
        tail = (proc.stderr or proc.stdout or b'').decode('utf-8', 'replace').strip().splitlines()[-2:]
        return None, 'ruler-v2.py: код %d: %s' % (proc.returncode, ' | '.join(tail))
    return json.loads(out_json.read_text(encoding='utf-8-sig')), None


def measure_cloud(cloud: Path, model: Path, python: str, quiet=False):
    import numpy as np
    tmp = Path(tempfile.mkdtemp(prefix='docs_compare_'))
    ruler_json = tmp / 'ruler.json'
    ruler, err = run_ruler(python, cloud, model, ruler_json)
    cloud_metrics = {'path': str(cloud), 'ruler_json': str(ruler_json), 'measured': ruler is not None}
    if ruler is None:
        cloud_metrics['error'] = err
        return cloud_metrics, tmp
    summary = ruler.get('summary') or {}
    rows = ruler.get('walls') or []
    t_cloud = [round(float(r['T_cloud']) * 1000.0) for r in rows if r.get('T_cloud')]
    gaps = []
    for r in rows:
        for g in (r.get('gaps_cloud') or []):
            gaps.append(round(float(g.get('width', 0)) * 1000.0))
    cloud_metrics.update({
        'height_mm': round(float((ruler.get('cloud') or {}).get('height') or 0.0) * 1000.0, 1),
        'floor_visible_m2': (ruler.get('cloud') or {}).get('floor_visible_m2'),
        'wall_thicknesses_mm': sorted(set(t_cloud)),
        'wall_thickness_clusters': dict(sorted(Counter(round(v / 5.0) * 5 for v in t_cloud).items())),
        'gap_widths_mm': sorted(set(gaps)),
        'rooms_perimeter_covered_pct': summary.get('room_perimeter_covered_pct'),
        'ruler_summary': summary,
    })
    # bbox и периметр пола — независимо от ruler (по точкам облака)
    try:
        arr = np.fromfile(str(cloud), dtype=np.float32).reshape(-1, 6)
        step = max(1, len(arr) // 800000)
        pts = arr[::step, :3].astype('float64')
        floor_y = float((ruler.get('cloud') or {}).get('floorY') or np.percentile(pts[:, 1], 1))
        fp = pts[(pts[:, 1] > floor_y - 0.10) & (pts[:, 1] < floor_y + 0.30)]
        if len(fp):
            cloud_metrics['bbox'] = {'x_m': round(float(np.ptp(fp[:, 0])), 2),
                                     'z_m': round(float(np.ptp(fp[:, 2])), 2)}
            # периметр ВНЕШНЕЙ границы пола по растру 10 см (дырки от стен/колонн заполняем)
            cell = 0.10
            gx = np.floor((fp[:, 0] - fp[:, 0].min()) / cell).astype('int32')
            gz = np.floor((fp[:, 2] - fp[:, 2].min()) / cell).astype('int32')
            grid = np.zeros((int(gz.max()) + 3, int(gx.max()) + 3), bool)
            grid[gz + 1, gx + 1] = True
            # вкладка дырок: заливка фона снаружи -> всё незалитое внутри = пол без дырок
            filled = grid.copy()
            if filled.any():
                pad = np.pad(filled, 1, constant_values=False)
                bg = np.zeros_like(pad)
                bg[0, :] = bg[-1, :] = bg[:, 0] = bg[:, -1] = True
                for _ in range(500):
                    nb = bg.copy()
                    nb[1:, :] |= bg[:-1, :]
                    nb[:-1, :] |= bg[1:, :]
                    nb[:, 1:] |= bg[:, :-1]
                    nb[:, :-1] |= bg[:, 1:]
                    nb &= ~pad
                    if (nb == bg).all():
                        break
                    bg = nb
                filled = ~bg
            bound = 0
            for ax in (0, 1):
                d = np.abs(np.diff(filled.astype(np.int8), axis=ax))
                bound += int(d.sum())
            cloud_metrics['floor_perimeter_outer_m'] = round(bound * cell, 2)
            cloud_metrics['floor_perimeter_m'] = cloud_metrics['floor_perimeter_outer_m']
            cloud_metrics['floor_area_cells_m2'] = round(float(filled.sum()) * cell * cell, 1)
    except Exception as exc:  # noqa: BLE001
        cloud_metrics['cloud_read_warning'] = str(exc)
    return cloud_metrics, tmp


# ---------------------------------------------------------------- строки таблицы
def mk_row(**kwargs):
    row = {'id': '', 'category': '', 'label': '', 'project': None, 'model': None, 'cloud': None,
           'delta_mp': None, 'delta_cm': None, 'tolerance': None, 'status': 'UNVERIFIED', 'note': ''}
    row.update(kwargs)
    return row


def v(value, unit, source=None):
    if value is None:
        return None
    out = {'value': value, 'unit': unit}
    if source:
        out['source'] = source
    return out


def nearest(value, values):
    if value is None or not values:
        return None
    return min(values, key=lambda x: abs(x - value))


def status_threshold(delta_abs, tol_pass, tol_warn, both_present=True):
    if not both_present or delta_abs is None:
        return 'UNVERIFIED'
    if delta_abs <= tol_pass:
        return 'PASS'
    if delta_abs <= tol_warn:
        return 'WARN'
    return 'FAIL'


# ---------------------------------------------------------------- сравнение
def build_compare(docs: dict, model: dict, cloud: dict, frame_mm: float):
    rows = []
    recommendations = []
    limitations = []
    unverified = []
    project = {
        'height_mm': (docs.get('floors') or {}).get('clean_height_mm'),
        'pitch_mm': (docs.get('floors') or {}).get('pitch_mm'),
        'slab_mm': (docs.get('floors') or {}).get('slab_or_floor_thickness_mm'),
        'wall_thicknesses_mm': (docs.get('walls') or {}).get('thicknesses_mm') or [],
        'door_widths_mm': (docs.get('doors') or {}).get('widths_mm') or [],
        'room_areas_m2': (docs.get('rooms') or {}).get('areas_m2') or [],
        'room_totals': [t.get('total_area_m2') for t in ((docs.get('rooms') or {}).get('explication_totals') or [])
                        if t.get('total_area_m2')],
        'axis_pitch_mm': (docs.get('axes') or {}).get('pitch_mm'),
        'overall_dims_mm': (docs.get('axes') or {}).get('overall_dims_mm') or [],
        'object': (docs.get('object') or {}).get('name') or '',
        'address': (docs.get('object') or {}).get('address') or '',
        'sheets': docs.get('sheets') or {},
        'limitations': docs.get('limitations') or [],
    }
    limitations.extend(project['limitations'][:8])
    limitations.append('модель измеряет локальный фрагмент интерьера; точная привязка к осям/плану '
                       'этажа отсутствует — часть проверок (площади, габариты, оси) даёт UNVERIFIED')

    def add_reco(severity, code, text):
        recommendations.append({'severity': severity, 'code': code, 'text': text})

    # ---- A1: высота этажа (чистая) ----
    ph, mh, ch = project['height_mm'], model['height_mm'], cloud.get('height_mm')
    d_mp = (mh - ph) if (ph and mh) else None
    d_cm = (ch - mh) if (ch is not None and mh) else None
    if d_mp is None:
        unverified.append({'id': 'floor_height', 'label': 'Высота этажа (чистая)',
                           'reason': 'в документации не найдена чистая высота этажа'})
    row = mk_row(id='floor_height', category='floors', label='Высота этажа (чистая)',
                 project=v(ph, 'mm', 'docs.json: floors.clean_height_mm'),
                 model=v(mh, 'mm', 'model: storey.height'),
                 cloud=v(ch, 'mm', 'ruler-v2.py: cloud.height'),
                 delta_mp=v(d_mp, 'mm'), delta_cm=v(d_cm, 'mm'),
                 tolerance=v(TOL_HEIGHT_MM, 'mm'),
                 status=status_threshold(abs(d_mp) if d_mp is not None else None, TOL_HEIGHT_MM, TOL_HEIGHT_MM * 2))
    if d_mp is not None:
        row['delta_mp']['pct'] = round(100.0 * d_mp / ph, 2) if ph else None
        if row['status'] == 'PASS':
            row['note'] = 'проект: чистая высота = шаг − плита; совпадение в допуске 50 мм'
        else:
            add_reco('fail' if row['status'] == 'FAIL' else 'warn', 'A1',
                     'Высота этажа: проект %s мм, модель %s мм (Δ %+d мм) — проверить отметки пола/потолка '
                     'и толщину перекрытия' % (fmt_mm(ph), fmt_mm(mh), round(d_mp)))
    rows.append(row)

    # ---- шаг этажа ----
    pp = project['pitch_mm']
    model_pitch = (mh + project['slab_mm']) if (mh and project['slab_mm']) else None
    d_p = (model_pitch - pp) if (pp and model_pitch) else None
    row = mk_row(id='floor_pitch', category='floors', label='Шаг этажа (пол-пол)',
                 project=v(pp, 'mm', 'docs.json: floors.pitch_mm'),
                 model=v(model_pitch, 'mm', 'model: storey.height + плита проекта'),
                 cloud=v((ch + project['slab_mm']) if (ch and project['slab_mm']) else None, 'mm',
                         'ruler: cloud.height + плита проекта'),
                 delta_mp=v(d_p, 'mm'), delta_cm=None,
                 tolerance=v(TOL_PITCH_MM, 'mm'),
                 status=status_threshold(abs(d_p) if d_p is not None else None, TOL_PITCH_MM, TOL_PITCH_MM * 2),
                 note='плита проекта %s мм; чистая высота модели + плита' % fmt_mm(project['slab_mm']))
    if d_p is not None and row['status'] != 'PASS':
        add_reco('warn', 'A1-pitch', 'Шаг этажа: проект %s мм, оценка по модели %s мм (Δ %+d мм)'
                 % (fmt_mm(pp), fmt_mm(model_pitch), round(d_p)))
    rows.append(row)

    # ---- A3: толщины стен ----
    model_th = model['wall_thicknesses_mm']
    cloud_th = cloud.get('wall_thicknesses_mm') or []
    pwalls = [int(w) for w in project['wall_thicknesses_mm']]
    wall_scores = []
    if not pwalls:
        unverified.append({'id': 'wall_thicknesses', 'label': 'Толщины стен',
                           'reason': 'в документации не найдены подписи толщин стен'})
    for pw in pwalls[:10]:
        # модель: ближайшая измеренная толщина; допускаем «проект + отделка»
        best = None
        for cand_label, expected in (('raw', pw), ('finish+%d' % int(WALL_FINISH_MM), pw + WALL_FINISH_MM)):
            for kind, values in (('model', model_th), ('cloud', cloud_th)):
                nv = nearest(expected, values)
                if nv is None:
                    continue
                d = nv - expected
                if best is None or abs(d) < abs(best['d']):
                    best = {'expected': expected, 'kind': kind, 'cand': nv, 'd': d, 'label': cand_label}
        model_near = nearest(pw, model_th)
        cloud_near = nearest(pw, cloud_th)
        d_mp = (model_near - pw) if model_near is not None else None
        d_mp_fin = ((model_near - (pw + WALL_FINISH_MM)) if model_near is not None else None)
        # статус: лучшее объяснение — «проект+отделка» либо сырой номинал
        best_d = min([abs(d) for d in (d_mp, d_mp_fin) if d is not None], default=None)
        st = status_threshold(best_d, TOL_WALL_PASS_MM, TOL_WALL_WARN_MM)
        extra = ''
        if d_mp is not None and d_mp_fin is not None:
            extra = ' (сырой Δ %+d мм; с отделкой +%d мм → Δ %+d мм)' % (
                round(d_mp), int(WALL_FINISH_MM), round(d_mp_fin))
        row = mk_row(id='wall_t_%d' % pw, category='walls', label='Толщина стены %d мм (проект)' % pw,
                     project=v(pw, 'mm', 'docs.json: walls.thicknesses_mm'),
                     model=v(model_near, 'mm', 'model: ближайшая измеренная толщина (%d стен)' % model['walls_measured']),
                     cloud=v(cloud_near, 'mm', 'ruler-v2.py: T_cloud' if cloud.get('measured') else None),
                     delta_mp=v(d_mp, 'mm'), delta_cm=v((cloud_near - model_near) if (cloud_near is not None and model_near is not None) else None, 'mm'),
                     tolerance=v(TOL_WALL_PASS_MM, 'mm'), status=st, note=extra)
        if st == 'FAIL':
            add_reco('fail', row['id'],
                     'Толщина стены: проект %d мм (с отделкой ~%d мм), модель %s мм%s — проверить'
                     % (pw, pw + int(WALL_FINISH_MM), fmt_mm(model_near), extra))
        elif st == 'WARN':
            add_reco('warn', row['id'],
                     'Толщина стены: проект %d мм, модель %s мм%s — уточнить тип стены (кирпич/перегородка/отделка)'
                     % (pw, fmt_mm(model_near), extra))
        rows.append(row)
        if st in ('PASS', 'WARN'):
            wall_scores.append(linear_score(best_d or 0, TOL_WALL_PASS_MM))
    # модель: измеренные толщины без проектного аналога
    unmatched = []
    for mt in sorted(set(round(x / 5.0) * 5 for x in model_th)):
        if not pwalls:
            break
        near = nearest(mt, [pw for pw in pwalls] + [pw + WALL_FINISH_MM for pw in pwalls])
        if near is None or abs(mt - near) > TOL_WALL_WARN_MM:
            unmatched.append(mt)
    if unmatched:
        add_reco('info', 'walls-unmatched',
                 'В модели есть измеренные толщины без проектного аналога: %s мм — проверить по облаку/документации'
                 % ', '.join(str(x) for x in unmatched[:8]))

    # ---- двери: сопоставление «проём модели → типы проекта» ----
    # Проект содержит сортамент дверей всего здания (ширины полотен/проёмов), а модель —
    # только фрагмент. Поэтому идём от модели: каждый проём модели должен найтись среди
    # проектного сортамента (полотно+рама ~100 мм либо размер проёма как есть).
    pdoors = [int(w) for w in project['door_widths_mm']]
    model_open = sorted({o['width_mm'] for o in model['openings'] if o['kind'] in ('door', 'passage')})
    cloud_gaps = [w for w in (cloud.get('gap_widths_mm') or []) if w >= 400]
    door_scores = []
    if not pdoors:
        unverified.append({'id': 'door_widths', 'label': 'Ширины дверей',
                           'reason': 'в документации не найдены ширины дверных полотен/проёмов'})
    unmatched_doors = []
    for mw in (model_open[:14] if pdoors else []):
        cands = []
        for pw in pdoors:
            for kind, expected in (('panel+frame', pw + frame_mm), ('opening', pw)):
                d = mw - expected
                cands.append({'pw': pw, 'kind': kind, 'expected': expected, 'd': d})
        cands.sort(key=lambda c: (abs(c['d']), c['kind'] != 'opening'))
        best = cands[0] if cands else None
        # порог: рама/сортмент — проект допускает разброс; 80 мм PASS, 180 мм WARN
        st = status_threshold(abs(best['d']) if best else None, 80.0, 180.0)
        cloud_near = nearest(mw, cloud_gaps) if cloud_gaps else None
        if st == 'FAIL':
            unmatched_doors.append(mw)
        row = mk_row(id='door_model_%d' % mw, category='doors',
                     label='Проём модели %d мм' % mw,
                     project=v(best['pw'], 'mm', 'docs.json: doors.widths_mm (сортамент)'),
                     model=v(mw, 'mm', 'model: ширина проёма'),
                     cloud=v(cloud_near, 'mm', 'ruler-v2.py: разрыв облака' if cloud.get('measured') else None),
                     delta_mp=v(best['d'] if best else None, 'mm'),
                     delta_cm=v((cloud_near - mw) if cloud_near is not None else None, 'mm'),
                     tolerance=v({'pass_mm': 80, 'warn_mm': 180, 'unit': 'mm'}, ''),
                     status=st,
                     note='проект: полотно %d мм → проём ~%d мм (или проём %d мм как есть); Δ %+d мм'
                          % (best['pw'], best['pw'] + int(frame_mm), best['pw'], round(best['d'])) if best else '')
        if st == 'FAIL':
            add_reco('fail', row['id'],
                     'Проём модели %d мм: в проекте ближайший %d мм (полотно) / %d мм (проём) — проверить ширину/раму'
                     % (mw, best['pw'], best['pw']))
        elif st == 'WARN':
            add_reco('warn', row['id'],
                     'Проём модели %d мм: проект %d мм (%s) — уточнить по облаку/чертежу'
                     % (mw, best['pw'], best['kind']))
        rows.append(row)
        if st in ('PASS', 'WARN'):
            door_scores.append(1.0 if st == 'PASS' else linear_score(abs(best['d']), 80.0))
    if unmatched_doors:
        add_reco('info', 'door_unmatched',
                 'Проёмы модели без проектного аналога: %s мм — проверить (возможно, проём вне сортамента)'
                 % ', '.join(str(x) for x in unmatched_doors[:8]))

    # ---- A5: площади помещений ----
    pa = [float(x) for x in project['room_areas_m2']]
    ma = [float(x) for x in model['room_areas_m2']]
    area_scores = []
    proj_total = max(project['room_totals']) if project['room_totals'] else None
    fragment = True
    if proj_total and model['rooms_area_m2']:
        ratio = model['rooms_area_m2'] / proj_total
        fragment = ratio < 0.5
    if pa and ma:
        # ближайшее сопоставление площадей (без повторов)
        pool = list(pa)
        diffs = []
        pairs = []
        for m in ma:
            if not pool:
                break
            near = min(pool, key=lambda x: abs(x - m))
            pool.remove(near)
            diffs.append(abs(m - near) / max(1e-9, near) * 100.0)
            pairs.append((near, m))
        med_pct = sorted(diffs)[len(diffs) // 2] if diffs else None
        if fragment:
            st = 'UNVERIFIED'
            note = ('модель — фрагмент %.1f м², проектные площади этажа %.1f м²: сопоставление '
                    'по ближайшим неприменимо без привязки к плану' % (model['rooms_area_m2'], proj_total))
            unverified.append({'id': 'rooms_area_match', 'label': 'Площади помещений (по ближайшим)',
                               'reason': note})
        else:
            st = status_threshold(med_pct, TOL_AREA_PCT, TOL_AREA_PCT * 2)
            note = 'медиана расхождения по %d парам' % len(diffs)
            if st == 'FAIL':
                add_reco('fail', 'A5', 'Площади помещений: медиана расхождения %.1f %% (> %.0f %%) — проверить контуры/перегородки'
                         % (med_pct, TOL_AREA_PCT * 2))
        row = mk_row(id='rooms_area_median', category='areas', label='Площади помещений (медиана по ближайшим)',
                     project=v(round(sorted(pa)[len(pa) // 2], 2), 'm2', 'docs.json: rooms.areas_m2'),
                     model=v(round(sorted(ma)[len(ma) // 2], 2), 'm2', 'model: rooms[].area'),
                     cloud=v(cloud.get('floor_visible_m2'), 'm2', 'ruler-v2.py: floor_visible_m2'),
                     delta_mp=v(round(med_pct, 1), '%') if med_pct is not None else None,
                     tolerance=v(TOL_AREA_PCT, '%'), status=st, note=note)
        rows.append(row)
        if med_pct is not None and not fragment:
            area_scores.append(linear_score(med_pct, TOL_AREA_PCT))
        # итог площади этажа — информативно
        row = mk_row(id='rooms_area_total', category='areas', label='Площадь помещений / видимый пол',
                     project=v(proj_total, 'm2', 'docs.json: rooms.explication_totals'),
                     model=v(model['rooms_area_m2'], 'm2', 'model: сумма rooms[].area'),
                     cloud=v(cloud.get('floor_visible_m2'), 'm2', 'ruler-v2.py: floor_visible_m2'),
                     delta_mp=v(None, '%'), delta_cm=v(None, '%'), tolerance=v(None, '%'),
                     status='UNVERIFIED',
                     note='проектная площадь — этаж целиком, модель — фрагмент; сравнение только информативное')
        unverified.append({'id': 'rooms_area_total', 'label': 'Площадь этажа', 'reason': row['note']})
        rows.append(row)
    else:
        unverified.append({'id': 'rooms_area_total', 'label': 'Площади помещений',
                           'reason': 'нет площадей в документации или в модели'})

    # ---- периметр ----
    mp = model['rooms_perimeter_union_m'] or model['rooms_perimeter_m']
    cp = cloud.get('floor_perimeter_outer_m') or cloud.get('floor_perimeter_m')
    d_pct = ((cp - mp) / mp * 100.0) if (mp and cp) else None
    perimeter_scores = []
    if mp:
        # семантика разная (внешний контур объединения комнат vs внешняя граница пола):
        # при расхождении честно UNVERIFIED, а не FAIL; A4 отдельно меряется ruler-v2
        if d_pct is not None and abs(d_pct) <= TOL_PERIMETER_PCT:
            st = 'PASS'
        else:
            st = 'UNVERIFIED'
            if d_pct is not None:
                add_reco('info', 'perimeter',
                         'Периметр: внешний контур модели %.1f м, внешняя граница пола облака %.1f м '
                         '(Δ %+.1f %%); семантика разная — сравнение информативное (A4 меряет ruler-v2)'
                         % (mp, cp, d_pct))
        row = mk_row(id='room_perimeter', category='perimeter',
                     label='Периметр: внешний контур модели / внешняя граница пола',
                     project=None, model=v(mp, 'm', 'model: периметр объединения комнат'),
                     cloud=v(cp, 'm', 'облако: внешняя граница пола (растр 10 см, дырки заполнены)'),
                     delta_mp=None, delta_cm=v(round(d_pct, 1) if d_pct is not None else None, '%'),
                     tolerance=v(TOL_PERIMETER_PCT, '%'), status=st,
                     note='в проекте нет однозначного периметра фрагмента — колонка проекта UNVERIFIED')
        unverified.append({'id': 'room_perimeter', 'label': 'Периметр проектный',
                           'reason': 'проект не содержит периметра, сопоставимого с фрагментом'})
        rows.append(row)

    # ---- габариты / оси ----
    pb = model['bbox']
    cb = cloud.get('bbox') or {}
    dims_scores = []
    for axis, key in (('X', 'x_m'), ('Z', 'z_m')):
        mv = pb.get(key)
        cv = cb.get(key)
        d_pct = ((cv - mv) / mv * 100.0) if (mv and cv) else None
        st = status_threshold(abs(d_pct) if d_pct is not None else None, TOL_BBOX_PCT, TOL_BBOX_PCT * 2)
        rows.append(mk_row(id='bbox_%s' % key[0], category='dims', label='Габарит %s, м' % axis,
                           project=None, model=v(mv, 'm', 'model: bbox'),
                           cloud=v(cv, 'm', 'облако: bbox точек пола'),
                           delta_mp=None, delta_cm=v(round(d_pct, 1) if d_pct is not None else None, '%'),
                           tolerance=v(TOL_BBOX_PCT, '%'), status=st,
                           note='проектные габариты — всё здание, модель — фрагмент: проект UNVERIFIED'))
        if st in ('PASS', 'WARN') and d_pct is not None:
            dims_scores.append(linear_score(abs(d_pct), TOL_BBOX_PCT))
    if project['axis_pitch_mm']:
        rows.append(mk_row(id='axis_pitch', category='dims', label='Шаг осей проекта, м',
                           project=v(project['axis_pitch_mm'], 'mm', 'docs.json: axes.pitch_mm'),
                           model=None, cloud=None,
                           tolerance=v(None, ''), status='UNVERIFIED',
                           note='в модели/облаке нет привязки к осям проекта — проверка вручную'))
        unverified.append({'id': 'axis_pitch', 'label': 'Шаг осей %s мм' % project['axis_pitch_mm'],
                           'reason': 'в модели/облаке нет привязки к осям проекта — проверка вручную'})

    # ---- скор ----
    categories = []
    if ph and d_mp is not None:
        categories.append(('floors_height', 30, linear_score(abs(d_mp), TOL_HEIGHT_MM)))
    if pp and d_p is not None:
        categories.append(('floors_pitch', 10, linear_score(abs(d_p), TOL_PITCH_MM)))
    if wall_scores:
        categories.append(('walls', 30, sum(wall_scores) / len(wall_scores)))
    if door_scores:
        categories.append(('doors', 20, sum(door_scores) / len(door_scores)))
    if area_scores:
        categories.append(('areas', 10, sum(area_scores) / len(area_scores)))
    # периметр/габариты — дополнительные, без проектных данных: в скор не входят
    coverage_pct = round(sum(w for _, w, _ in categories), 1) if categories else 0.0
    score = round(100.0 * sum(w * s for _, w, s in categories) / sum(w for _, w, _ in categories), 1) \
        if categories else 0.0

    # ---- сводка статусов ----
    cnt = Counter(r['status'] for r in rows)
    summary = {'checks': len(rows), 'pass': cnt.get('PASS', 0), 'warn': cnt.get('WARN', 0),
               'fail': cnt.get('FAIL', 0), 'unverified': cnt.get('UNVERIFIED', 0)}

    # UNVERIFIED строки — в отдельный список для UI
    for r in rows:
        if r['status'] == 'UNVERIFIED' and not any(u.get('id') == r['id'] for u in unverified):
            unverified.append({'id': r['id'], 'label': r['label'],
                               'reason': r.get('note') or 'нет проектного значения'})

    limitations.extend([
        'ширины коридоров по плану автоматически не измеряются (нужна ручная разметка растров)',
        'дверные полотна сопоставляются с проёмами через условную раму ~%d мм' % int(frame_mm),
        'площади/оси/габариты проекта относятся к зданию целиком, модель — фрагмент: эти строки UNVERIFIED',
    ])
    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'tool': 'docs-compare.py',
        'inputs': {
            'docs': {'path': docs.get('_path'), 'md5': docs.get('_md5'), 'object': project['object'],
                     'address': project['address'], 'pages': docs.get('input_pages'),
                     'sheets': (project['sheets'] or {}).get('count')},
            'model': {'path': model['path'], 'md5': model.get('md5'), 'walls': model['walls_total'],
                      'walls_measured': model['walls_measured'], 'rooms': model['rooms'],
                      'storey_height_mm': model['height_mm'],
                      'rooms_area_m2': model['rooms_area_m2']},
            'cloud': {k: cloud.get(k) for k in ('path', 'measured', 'height_mm', 'floor_visible_m2',
                                                'rooms_perimeter_covered_pct', 'floor_perimeter_outer_m', 'floor_area_cells_m2', 'error')},
        },
        'score': score,
        'grade': grade_of(score),
        'coverage_pct': coverage_pct,
        'summary': summary,
        'rows': rows,
        'recommendations': recommendations,
        'limitations': limitations,
        'unverified': unverified,
    }


# ---------------------------------------------------------------- stdout
def print_table(result: dict):
    log('')
    log('=== ПРОЕКТ ↔ МОДЕЛЬ ↔ ОБЛАКО ===')
    log('%-42s %-10s %-10s %-10s %-10s %-10s %s' % ('параметр', 'проект', 'модель', 'облако',
                                                    'Δ мод-пр', 'Δ обл-мод', 'статус'))
    log('-' * 118)
    for r in result['rows']:
        def val(x, unit):
            if not x or x.get('value') is None:
                return '—'
            v_ = x['value']
            if isinstance(v_, dict):
                return '—'
            return ('%s %s' % (fmt_mm(v_) if unit in ('mm',) else v_, unit)).strip()
        p = val(r['project'], (r['project'] or {}).get('unit')) if r['project'] else '—'
        m = val(r['model'], (r['model'] or {}).get('unit')) if r['model'] else '—'
        c = val(r['cloud'], (r['cloud'] or {}).get('unit')) if r['cloud'] else '—'
        dmp = r['delta_mp']
        dcm = r['delta_cm']
        dmp_s = '—' if not dmp or dmp.get('value') is None else ('%+.1f %s' % (dmp['value'], dmp.get('unit', '')))
        dcm_s = '—' if not dcm or dcm.get('value') is None else ('%+.1f %s' % (dcm['value'], dcm.get('unit', '')))
        log('%-42s %-10s %-10s %-10s %-10s %-10s %s' % (r['label'][:42], p[:10], m[:10], c[:10],
                                                        dmp_s[:10], dcm_s[:10], r['status']))
    log('-' * 118)
    log('проверок: %d | PASS %d | WARN %d | FAIL %d | UNVERIFIED %d'
        % (result['summary']['checks'], result['summary']['pass'], result['summary']['warn'],
           result['summary']['fail'], result['summary']['unverified']))
    log('СКОР СООТВЕТСТВИЯ: %.1f / 100 (grade %s); покрытие проектными данными %.0f %%'
        % (result['score'], result['grade'], result['coverage_pct']))
    if result['recommendations']:
        log('РЕКОМЕНДАЦИИ:')
        for rec in result['recommendations']:
            log('  [%s] %s: %s' % (rec['severity'].upper(), rec['code'], rec['text']))


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Сравнение документации (docs.json) с моделью и облаком (ROADMAP-DOCS-AI, блок 2).')
    ap.add_argument('--docs', required=True, help='docs.json из docs-extract.py')
    ap.add_argument('--model', required=True, help='JSON-модель scan2bim-v2 (py2-final-vN.json)')
    ap.add_argument('--cloud', default=None, help='облако .bin (float32 XYZRGB, Y вверх)')
    ap.add_argument('--out', required=True, help='куда записать compare.json')
    ap.add_argument('--strict', action='store_true', help='exit 1 при скор<--strict-score или критичном FAIL')
    ap.add_argument('--strict-score', type=float, default=70.0, help='порог скора для --strict (по умолчанию 70)')
    ap.add_argument('--frame-mm', type=float, default=DOOR_FRAME_MM, help='условная рама двери, мм')
    ap.add_argument('--python', default=sys.executable, help='Python для ruler-v2.py')
    ap.add_argument('--no-cloud', action='store_true', help='не запускать обмер облака (облако UNVERIFIED)')
    args = ap.parse_args(argv)

    docs_path = Path(args.docs)
    model_path = Path(args.model)
    if not docs_path.exists():
        log('[docs-compare] ОШИБКА: нет docs.json: %s' % docs_path)
        return 2
    if not model_path.exists():
        log('[docs-compare] ОШИБКА: нет модели: %s' % model_path)
        return 2
    import hashlib as _hashlib
    docs_raw = docs_path.read_bytes()
    docs = json.loads(docs_raw.decode('utf-8-sig'))
    docs['_path'] = str(docs_path)
    docs['_md5'] = _hashlib.md5(docs_raw).hexdigest().upper()
    model = load_model(model_path)
    log('[docs-compare] docs: %s (страниц %s, помещений в экспликациях %s)'
        % (docs_path.name, docs.get('input_pages'), (docs.get('rooms') or {}).get('count')))
    log('[docs-compare] модель: %s (стен %d, измерено %d, помещений %d, высота %.1f мм)'
        % (model_path.name, model['walls_total'], model['walls_measured'], model['rooms'], model['height_mm']))

    cloud = {'measured': False}
    tmpdir = None
    if args.cloud and not args.no_cloud:
        cp = Path(args.cloud)
        if not cp.exists():
            cloud = {'measured': False, 'error': 'файл облака не найден: %s' % cp}
            log('[docs-compare] ВНИМАНИЕ: %s' % cloud['error'])
        else:
            log('[docs-compare] обмер облака ruler-v2.py (может занять ~15 с)…')
            cloud, tmpdir = measure_cloud(cp, model_path, args.python)
            if cloud.get('measured'):
                log('[docs-compare] облако: высота %s мм, видимый пол %s м², стен измерено, периметр пола %s м'
                    % (fmt_mm(cloud.get('height_mm')), cloud.get('floor_visible_m2'),
                       cloud.get('floor_perimeter_outer_m') or cloud.get('floor_perimeter_m')))
            else:
                log('[docs-compare] ВНИМАНИЕ: обмер облака не удался: %s' % cloud.get('error'))
    elif args.no_cloud:
        cloud = {'measured': False, 'error': '--no-cloud'}

    result = build_compare(docs, model, cloud, args.frame_mm)
    print_table(result)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
    log('JSON: %s' % out)
    if tmpdir:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    if args.strict:
        critical_fail = any(r['status'] == 'FAIL' and r['category'] in ('floors', 'walls', 'doors')
                            for r in result['rows'])
        if result['score'] < args.strict_score or critical_fail:
            log('[docs-compare] --strict: FAIL (скор %.1f < %.1f или критичное расхождение)'
                % (result['score'], args.strict_score))
            return 1
        log('[docs-compare] --strict: OK (скор %.1f >= %.1f)' % (result['score'], args.strict_score))
    return 0


if __name__ == '__main__':
    sys.exit(main())

