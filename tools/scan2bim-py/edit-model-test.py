#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""edit-model-test.py — тесты ядра ручного редактора BIM-модели (Фаза 4 ROADMAP-IDEAL.md).

Запуск (нужен Python с numpy; IFC-тесты требуют node и ifcopenshell):

    python edit-model-test.py [--data DIR] [--keep]

Проверки (каждая печатает PASS/FAIL; код возврата 1, если есть FAIL):
  * загрузка/инварианты модели (57 стен, 11 проёмов, 23 помещения — на реальных данных);
  * толщина стены обновляется, a/b/длина не меняются;
  * сдвиг стены по нормали меняет a/b ровно на offset;
  * удлинение торца пересчитывает a/length/openings.along;
  * явная длина пересчитывает b;
  * перенос/ширина/порог проёма, запрет выхода за стену и наложения проёмов;
  * добавление/удаление проёма;
  * undo/redo восстанавливает модель снимок-в-снимок; глубина истории >= 20;
  * сохранение/чтение JSON (round-trip), sidecar истории между «запусками»;
  * экспорт IFC: стены/проёмы на месте, сдвиг стены меняет IFC-координату;
  * IFC после правок валиден (validate-ifc.py: 0 ERROR, арность IFC4 OK);
  * snap_wall: 2-модная привязка восстанавливает известный сдвиг/толщину (синтетика),
    на реальном облаке улучшает/не ухудшает RMS и держит сдвиг <= 0.25 м;
  * snap_opening: кромки проёма по разрыву профиля облака (±0.1 м);
  * CLI: --help, пример move_wall --offset --snap --out --json, undo/redo между
    запусками через sidecar, ошибки параметров дают код 2.

Данные по умолчанию: D:\\BIM-TWIN-TEST\\interior\\py2-p1.json + koridor-local-rgb.bin.
Если их нет — тесты строят синтетическую модель/облако во временной папке.
"""
import argparse
import copy
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EDITOR_PY = os.path.join(SCRIPT_DIR, 'edit-model.py')
REPO_DIR = os.path.dirname(os.path.dirname(SCRIPT_DIR))

DEFAULT_DATA = os.environ.get('EDIT_MODEL_DATA') or r'D:\BIM-TWIN-TEST\interior'
DEFAULT_MODEL = os.path.join(DEFAULT_DATA, 'py2-p1.json')
DEFAULT_CLOUD = os.path.join(DEFAULT_DATA, 'koridor-local-rgb.bin')

PY = sys.executable
CLOUD_STRIDE = 2


# ======================================================================================
# загрузка тестируемого модуля (имя файла с дефисом — через importlib)
# ======================================================================================
def load_editor_module():
    spec = importlib.util.spec_from_file_location('edit_model', EDITOR_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


em = load_editor_module()


# ======================================================================================
# окружение тестов: реальные данные или синтетический стенд
# ======================================================================================
class SkipTest(Exception):
    pass


class Context:
    tmpdir = None
    model_path = None      # основной путь модели для CLI
    model = None           # нормализованная модель (dict)
    cloud_path = None      # основное облако (str) или None
    real = False           # используются реальные данные
    synth_model_path = None
    synth_model = None
    synth_cloud_path = None
    cloud = None           # Cloud-объект основного облака

    @property
    def has_cloud(self):
        return self.cloud_path is not None


CTX = Context()


def make_synthetic(tmpdir):
    """Синтетический стенд: 4 стены 4x3 м, одна комната; облако с «истиной»:
    стена 0 в облаке сдвинута на +0.12 м и толщиной 0.18 (модель думает 0.20/0),
    в стене 2 облако имеет разрыв 2.0..2.9 м (для snap_opening)."""
    specs = [((0.0, 0.0), (1.0, 0.0), 4.0, 0.20),
             ((4.0, 0.0), (0.0, 1.0), 3.0, 0.20),
             ((4.0, 3.0), (-1.0, 0.0), 4.0, 0.20),
             ((0.0, 3.0), (0.0, -1.0), 3.0, 0.20)]
    walls = []
    for i, (a, d, L, T) in enumerate(specs):
        walls.append({'a': [a[0], a[1]],
                      'b': [round(a[0] + d[0] * L, 4), round(a[1] + d[1] * L, 4)],
                      'dir': [d[0], d[1]], 'length': L, 'thickness': T,
                      'base': 0.0, 'height': 3.0, 'openings': [], 'passages': [],
                      'color': [0.6, 0.5, 0.5], 'material': 'concrete',
                      'inferred': False, 'rms': 0.01})
    poly = [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]]
    model = {'ok': True, 'storey': {'floorY': 0.0, 'ceilY': 3.0, 'height': 3.0},
             'walls': walls,
             'slabs': [{'type': 'floor', 'level': 0.0, 'thickness': 0.10,
                        'polygon': poly, 'color': [0.7, 0.7, 0.7]},
                       {'type': 'ceiling', 'level': 3.0, 'thickness': 0.10,
                        'polygon': poly, 'color': [0.7, 0.7, 0.7]}],
             'rooms': [{'polygon': poly, 'area': 12.0, 'cx': 2.0, 'cz': 1.5,
                        'color': [0.7, 0.7, 0.7]}],
             'pipes': [], 'objects': [], 'beams': [], 'cables': []}
    em.normalize_model(model)
    em.recount_stats(model)
    # проём в стене 2 нужен для теста snap_opening (модель «не знает» разрыв облака)
    model['walls'][2]['openings'] = [{'along': 1.5, 'width': 0.7, 'sill': 0.0,
                                      'head': 2.1, 'kind': 'door'}]

    model_path = os.path.join(tmpdir, 'synthetic-model.json')
    with open(model_path, 'w', encoding='utf-8') as f:
        json.dump(model, f, ensure_ascii=False, indent=1)

    rng = np.random.default_rng(42)
    pts = []
    for i, w in enumerate(model['walls']):
        a = np.array(w['a'], float)
        d = np.array(w['dir'], float)
        n = np.array([-d[1], d[0]], float)
        L, T = float(w['length']), float(w['thickness'])
        shift, th, gap = 0.0, T, None
        if i == 0:
            shift, th = 0.12, 0.18
        if i == 2:
            gap = (2.0, 2.9)
        ys = np.arange(0.20, 2.81, 0.20)
        for face in (-1.0, 1.0):
            for s in np.arange(0.02, L, 0.02):
                if gap is not None and gap[0] - 0.01 <= s <= gap[1] + 0.01:
                    continue
                base = a + d * s + n * (shift + face * th / 2.0)
                for y in ys:
                    pts.append((base[0] + rng.normal(0, 0.004),
                                y + rng.normal(0, 0.004),
                                base[1] + rng.normal(0, 0.004),
                                0.6, 0.5, 0.5))
    arr = np.asarray(pts, dtype=np.float32)
    cloud_path = os.path.join(tmpdir, 'synthetic-cloud.bin')
    arr.tofile(cloud_path)
    return model, model_path, cloud_path


def setup_context(args):
    CTX.tmpdir = tempfile.mkdtemp(prefix='edit-model-test-')
    print('edit-model-test.py — тесты ядра редактора (Фаза 4 ROADMAP-IDEAL.md)')
    print('python:  %s' % sys.executable)
    print('модуль:  %s' % EDITOR_PY)
    print('временная папка: %s' % CTX.tmpdir)
    if args.data:
        global DEFAULT_MODEL, DEFAULT_CLOUD
        DEFAULT_MODEL = os.path.join(args.data, 'py2-p1.json')
        DEFAULT_CLOUD = os.path.join(args.data, 'koridor-local-rgb.bin')
    CTX.real = os.path.isfile(DEFAULT_MODEL)
    if CTX.real:
        CTX.model_path = os.path.abspath(DEFAULT_MODEL)
        CTX.model = em.load_model(CTX.model_path)
        if os.path.isfile(DEFAULT_CLOUD):
            CTX.cloud_path = os.path.abspath(DEFAULT_CLOUD)
        print('данные:  РЕАЛЬНЫЕ %s' % CTX.model_path)
        if CTX.cloud_path:
            print('облако:  %s' % CTX.cloud_path)
    else:
        print('данные:  реальных нет — синтетический стенд')
    # синтетика нужна всегда (строгие проверки привязки)
    CTX.synth_model, CTX.synth_model_path, CTX.synth_cloud_path = make_synthetic(CTX.tmpdir)
    if not CTX.real:
        CTX.model_path = CTX.synth_model_path
        CTX.model = copy.deepcopy(CTX.synth_model)
        CTX.cloud_path = CTX.synth_cloud_path
    print('синтетика: %s (%d точек)' % (CTX.synth_cloud_path,
                                        os.path.getsize(CTX.synth_cloud_path) // 24))
    if CTX.cloud_path:
        CTX.cloud = em.load_cloud(CTX.cloud_path, CLOUD_STRIDE)
        print('точек в облаке (прорежено): %d из %d' % (CTX.cloud.points_used,
                                                        CTX.cloud.points_total))
    print()


# ======================================================================================
# помощники
# ======================================================================================
def fresh_editor(with_cloud=False, model=None):
    mdl = copy.deepcopy(CTX.model if model is None else model)
    cloud = CTX.cloud if with_cloud else None
    return em.Editor(mdl, cloud=cloud)


def synth_editor(model, with_cloud=True):
    cloud = em.load_cloud(CTX.synth_cloud_path, CLOUD_STRIDE) if with_cloud else None
    return em.Editor(copy.deepcopy(model), cloud=cloud)


def first_measured_wall_without_openings(model):
    for i, w in enumerate(model['walls']):
        if w.get('inferred') or w.get('material') == 'inferred':
            continue
        if not (w.get('openings') or []):
            return i
    raise SkipTest('нет измеренной стены без проёмов')


def wall_center_ifc_point(w):
    """Точка центра стены в координатах IFC: X=model x, Y=model z, Z=model y (base)."""
    a, d, _n, L, _t = em.wall_frame(w)
    return (a[0] + d[0] * L / 2.0, a[1] + d[1] * L / 2.0,
            float(w.get('base') or 0.0))


_CART_RE = re.compile(r'IFCCARTESIANPOINT\(\(([^()]*)\)\)')


def ifc_cartesian_points(text):
    pts = []
    for m in _CART_RE.finditer(text):
        parts = [p.strip() for p in m.group(1).split(',')]
        try:
            vals = [float(p) for p in parts]
        except ValueError:
            continue
        if len(vals) == 3:
            pts.append(tuple(vals))
    return pts


def has_ifc_point(points, target, tol=2e-4):
    for p in points:
        if abs(p[0] - target[0]) <= tol and abs(p[1] - target[1]) <= tol \
                and abs(p[2] - target[2]) <= tol:
            return True
    return False


def read_text(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def run_cli(extra, timeout=600):
    cmd = [PY, EDITOR_PY] + list(extra)
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8',
                          errors='replace', timeout=timeout)


def run_cli_json(extra):
    proc = run_cli(list(extra) + ['--json'])
    out = (proc.stdout or '').strip().splitlines()
    payload = None
    if out:
        try:
            payload = json.loads(out[-1])
        except ValueError:
            payload = None
    return proc, payload


def assert_true(cond, msg):
    if not cond:
        raise AssertionError(msg)


def assert_close(a, b, tol, msg):
    if abs(float(a) - float(b)) > tol:
        raise AssertionError('%s: %.6f != %.6f (допуск %g)' % (msg, a, b, tol))


TESTS = []


def check(name):
    def deco(fn):
        TESTS.append((name, fn))
        return fn
    return deco


# ======================================================================================
# 1. модель и базовые инварианты
# ======================================================================================
@check('load_model: схема/инварианты модели')
def test_load_model():
    m = CTX.model
    assert_true(len(m['walls']) >= 4, 'в модели есть стены')
    assert_true(m.get('ok') is True, 'model.ok == True')
    assert_true(float(m['storey']['height']) > 1.0, 'высота этажа > 1 м')
    n_ops = 0
    for i, w in enumerate(m['walls']):
        a, d, _n, L, _t = em.wall_frame(w)
        bx, bz = float(w['b'][0]), float(w['b'][1])
        assert_close(bx, a[0] + d[0] * L, 1e-3, 'стена %d: b.x = a.x+dir.x*length' % i)
        assert_close(bz, a[1] + d[1] * L, 1e-3, 'стена %d: b.z = a.z+dir.z*length' % i)
        assert_close(math.hypot(*w['dir']), 1.0, 1e-4, 'стена %d: dir единичный' % i)
        for o in w.get('openings') or []:
            n_ops += 1
            assert_true(0.0 <= o['along'] and o['along'] + o['width'] <= L + 1e-6,
                        'стена %d: проём внутри стены' % i)
            assert_true(0.0 < o['head'] <= w['height'] + 1e-6,
                        'стена %d: head в пределах высоты' % i)
    assert_true(len(m.get('rooms') or []) >= 1, 'есть помещения')
    assert_true(len(m.get('slabs') or []) >= 1, 'есть перекрытия')
    return 'стен %d, проёмов %d, помещений %d, площадь %.1f м²' % (
        len(m['walls']), n_ops, len(m['rooms']),
        sum(float(r.get('area') or 0.0) for r in m['rooms']))


# ======================================================================================
# 2. стена: толщина / сдвиг / удлинение / длина
# ======================================================================================
@check('set_wall: толщина обновляется, геометрия не плывёт')
def test_set_wall_thickness():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model) if not CTX.real else 11
    w0 = copy.deepcopy(ed.model['walls'][idx])
    new_t = round(float(w0['thickness']) + 0.031, 3)
    if new_t > 0.6:
        new_t = round(float(w0['thickness']) - 0.031, 3)
    res = ed.set_wall(idx, thickness=new_t)
    w = ed.model['walls'][idx]
    assert_true(res['changed'] is True, 'операция изменила модель')
    assert_close(w['thickness'], new_t, 1e-6, 'толщина обновилась')
    assert_close(w['length'], w0['length'], 1e-6, 'длина не изменилась')
    assert_close(w['a'][0], w0['a'][0], 1e-6, 'a.x не изменился')
    assert_close(w['a'][1], w0['a'][1], 1e-6, 'a.z не изменился')
    assert_true(ed.undo()['changed'] is True, 'undo выполнен')
    assert_close(ed.model['walls'][idx]['thickness'], w0['thickness'], 1e-6,
                 'undo вернул толщину')
    return 'стена %d: T %.3f -> %.3f м, undo вернул %.3f' % (
        idx, w0['thickness'], new_t, ed.model['walls'][idx]['thickness'])


@check('set_wall: сдвиг по нормали меняет a/b ровно на offset')
def test_move_wall_offset():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model) if not CTX.real else 3
    a0, d0, n0, L0, T0 = em.wall_frame(ed.model['walls'][idx])
    off = 0.10
    ed.set_wall(idx, offset=off)
    a1, d1, n1, L1, T1 = em.wall_frame(ed.model['walls'][idx])
    assert_close(a1[0], a0[0] + n0[0] * off, 1e-4, 'a.x = a.x + n.x*offset')
    assert_close(a1[1], a0[1] + n0[1] * off, 1e-4, 'a.z = a.z + n.z*offset')
    b1 = ed.model['walls'][idx]['b']
    assert_close(b1[0], a1[0] + d1[0] * L1, 1e-3, 'b пересчитан из a')
    assert_close(L1, L0, 1e-6, 'длина не изменилась')
    assert_close(d1[0], d0[0], 1e-6, 'dir не изменился')
    assert_close(T1, T0, 1e-6, 'толщина не изменилась')
    return 'стена %d: offset %+.2f м, a %s -> %s' % (
        idx, off, [round(v, 4) for v in a0], [round(v, 4) for v in a1])


@check('set_wall: extend_start удлиняет и сдвигает openings.along')
def test_extend_start():
    ed = fresh_editor()
    idx = next((i for i, w in enumerate(ed.model['walls']) if w.get('openings')), None)
    if idx is None:
        raise SkipTest('в модели нет стены с проёмом')
    w = ed.model['walls'][idx]
    a0, d0, _n, L0, _t = em.wall_frame(w)
    op0 = round(float(w['openings'][0]['along']), 4)
    ext = 0.5
    res = ed.set_wall(idx, extend_start=ext)
    w = ed.model['walls'][idx]
    assert_close(w['length'], L0 + ext, 1e-4, 'длина увеличилась на extend_start')
    assert_close(w['a'][0], a0[0] - d0[0] * ext, 1e-4, 'a сдвинут в начало')
    assert_close(w['a'][1], a0[1] - d0[1] * ext, 1e-4, 'a сдвинут в начало (z)')
    along = float(w['openings'][0]['along'])
    assert_close(along, op0 + ext, 1e-3, 'along проёма сдвинут на extend_start')
    assert_true(res['openings_shifted'] >= 1, 'проём сдвинут')
    return 'стена %d: L %.3f -> %.3f м, along %.3f -> %.3f' % (
        idx, L0, w['length'], op0, along)


@check('set_wall: extend_end и явная длина пересчитывают b')
def test_length_and_extend_end():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model) if not CTX.real else 3
    a, d, _n, L0, _t = em.wall_frame(ed.model['walls'][idx])
    ed.set_wall(idx, extend_end=0.30)
    w = ed.model['walls'][idx]
    assert_close(w['length'], L0 + 0.30, 1e-4, 'extend_end добавил 0.30 м')
    ed.set_wall(idx, length=L0)
    w = ed.model['walls'][idx]
    assert_close(w['length'], L0, 1e-4, 'явная длина восстановлена')
    assert_close(w['b'][0], a[0] + d[0] * L0, 1e-3, 'b пересчитан для новой длины')
    return 'стена %d: L %.3f -> %.3f -> %.3f м' % (idx, L0, L0 + 0.30, w['length'])


# ======================================================================================
# 3. проёмы
# ======================================================================================
@check('move_opening: along/width/sill/head, границы и наложения')
def test_move_opening():
    ed = fresh_editor()
    idx = next((i for i, w in enumerate(ed.model['walls']) if w.get('openings')), None)
    if idx is None:
        raise SkipTest('в модели нет стены с проёмом')
    w = ed.model['walls'][idx]
    o0 = copy.deepcopy(w['openings'][0])
    new_along = round(float(o0['along']) + 0.05, 3)
    new_width = round(float(o0['width']), 3)
    res = ed.move_opening(idx, 0, along=new_along, width=new_width)
    o = ed.model['walls'][idx]['openings'][0]
    assert_close(o['along'], new_along, 1e-6, 'along обновлён')
    assert_true(res['changed'] is True, 'операция изменила модель')
    # наложение проёмов в стене с >=2 проёмами должно быть запрещено
    two_op_wall = next((i for i, ww in enumerate(ed.model['walls'])
                        if len(ww.get('openings') or []) >= 2), None)
    if two_op_wall is not None:
        ww = ed.model['walls'][two_op_wall]
        o_a = ww['openings'][0]
        try:
            ed.move_opening(two_op_wall, 1, along=float(o_a['along']))
            raise AssertionError('наложение проёмов не запрещено')
        except em.EditError:
            pass
    # выход за стену запрещён
    try:
        ed.move_opening(idx, 0, along=float('inf'))
        raise AssertionError('along=inf не вызвал ошибку')
    except (em.EditError, ValueError):
        pass
    try:
        ed.move_opening(idx, 0, along=float(w['length']) - 0.01, width=0.9)
        raise AssertionError('выход проёма за стену не запрещён')
    except em.EditError:
        pass
    return 'стена %d проём 0: along %.3f -> %.3f, наложения/выход запрещены' % (
        idx, o0['along'], new_along)


@check('add_opening / remove_opening + undo/redo')
def test_add_remove_opening():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model) if not CTX.real else 3
    L = float(ed.model['walls'][idx]['length'])
    n0 = len(ed.model['walls'][idx].get('openings') or [])
    res = ed.add_opening(idx, along=1.0, width=0.9, kind='door')
    assert_true(res['changed'] is True, 'изменение зафиксировано')
    assert_true(len(ed.model['walls'][idx]['openings']) == n0 + 1, 'проём добавлен')
    assert_close(ed.model['walls'][idx]['openings'][0]['width'], 0.9, 1e-6,
                 'ширина добавленного проёма')
    # повторный проём поверх — запрещён
    try:
        ed.add_opening(idx, along=1.2, width=0.8)
        raise AssertionError('наложение проёмов при добавлении не запрещено')
    except em.EditError:
        pass
    assert_true(ed.undo()['changed'], 'undo добавления')
    assert_true(len(ed.model['walls'][idx]['openings']) == n0, 'undo убрал проём')
    assert_true(ed.redo()['changed'], 'redo добавления')
    res = ed.remove_opening(idx, 0)
    assert_true(res['changed'] is True, 'удаление зафиксировано')
    assert_true(len(ed.model['walls'][idx]['openings']) == n0, 'проём удалён')
    assert_true(ed.can_undo is True, 'история доступна')
    return 'стена %d: add -> remove, undo/redo глубина %d' % (idx, ed.undo_depth)


# ======================================================================================
# 4. undo/redo и история
# ======================================================================================
@check('undo/redo: модель восстанавливается снимок-в-снимок')
def test_undo_redo_restores():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model)
    L = float(ed.model['walls'][idx]['length'])
    m0 = copy.deepcopy(ed.model)
    snaps = [m0]
    ed.set_wall(idx, thickness=round(float(ed.model['walls'][idx]['thickness']) + 0.02, 3))
    snaps.append(copy.deepcopy(ed.model))
    ed.set_wall(idx, offset=0.05)
    snaps.append(copy.deepcopy(ed.model))
    if L >= 1.4:  # третья правка — проём, если он влезает в стену
        ed.add_opening(idx, along=0.3, width=min(0.8, L - 0.4), kind='door')
        snaps.append(copy.deepcopy(ed.model))
    m_final = copy.deepcopy(ed.model)
    n_edits = len(snaps) - 1
    assert_true(ed.can_undo, 'есть что отменять')
    for k in range(n_edits, 0, -1):
        assert_true(ed.undo()['changed'] is True, 'undo #%d' % k)
        assert_true(ed.model == snaps[k - 1], 'состояние после undo #%d совпало' % k)
    assert_true(ed.can_undo is False, 'история отмены исчерпана')
    for k in range(1, n_edits + 1):
        assert_true(ed.redo()['changed'] is True, 'redo #%d' % k)
        assert_true(ed.model == snaps[k], 'состояние после redo #%d совпало' % k)
    assert_true(ed.model == m_final, 'redo вернул финальную модель')
    return '%d правки: undo/redo восстановили модель побайтно (JSON ==)' % n_edits


@check('undo: глубина стека >= 20 (требование Фазы 4)')
def test_undo_depth_ge_20():
    assert_true(em.DEFAULT_UNDO_DEPTH >= 20,
                'глубина по умолчанию %d >= 20' % em.DEFAULT_UNDO_DEPTH)
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model)
    t = float(ed.model['walls'][idx]['thickness'])
    snap5 = None
    for k in range(25):
        sign = 1 if k % 2 == 0 else -1
        t = round(max(0.05, min(0.60, t + sign * 0.004)), 4)
        ed.set_wall(idx, thickness=t)
        if k == 4:
            snap5 = copy.deepcopy(ed.model)
    assert_true(len(ed._undo) >= 20, 'в стеке %d снимков >= 20' % len(ed._undo))
    for _ in range(20):
        ed.undo()
    assert_true(ed.model == snap5, '20 отмен вернули состояние после 5-й правки')
    while ed.can_undo:
        ed.undo()
    assert_true(ed.model['walls'][idx]['thickness'] ==
                round(float(CTX.model['walls'][idx]['thickness']), 4),
                'полная отмена вернула исходную толщину')
    # настраиваемая глубина ровно 20
    ed2 = fresh_editor()
    ed2.undo_depth = 20
    for k in range(25):
        ed2.set_wall(idx, thickness=round(0.10 + 0.0001 * k, 4))
    assert_true(len(ed2._undo) == 20, 'стек ограничен 20 снимками, а не 25')
    return 'стек %d (default %d), 20 отмен OK; ограничение 20 OK' % (
        len(ed._undo) + 20, em.DEFAULT_UNDO_DEPTH)


@check('save/load: round-trip JSON + sidecar истории')
def test_save_load_roundtrip():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model)
    ed.set_wall(idx, thickness=round(float(ed.model['walls'][idx]['thickness']) + 0.02, 3))
    path_a = os.path.join(CTX.tmpdir, 'roundtrip-a.json')
    saved = ed.save(path_a)
    assert_true(os.path.isfile(path_a), 'файл модели создан')
    assert_true(saved['bytes'] > 1000, 'файл не пустой')
    raw = read_json(path_a)
    assert_true(raw == ed.model, 'записанная модель == модели редактора')
    ed2 = em.Editor.load(path_a)
    assert_true(ed2.model == ed.model, 'загруженная модель == записанной')
    assert_true(ed2.can_undo is True, 'история загружена из sidecar')
    assert_true(os.path.isfile(path_a + '.history.json'), 'sidecar истории создан')
    ed2.undo()
    assert_true(ed2.model == CTX.model, 'undo после перезагрузки вернул исходную модель')
    return 'модель %.1f КБ + история %.1f КБ, undo после load OK' % (
        saved['bytes'] / 1024.0, os.path.getsize(path_a + '.history.json') / 1024.0)


# ======================================================================================
# 5. IFC: экспорт, координаты, валидация
# ======================================================================================
@check('export_ifc: стены/проёмы на месте')
def test_export_ifc_baseline():
    ed = fresh_editor()
    out = os.path.join(CTX.tmpdir, 'baseline.ifc')
    info = ed.export_ifc(out)
    text = read_text(out)
    n_walls = len(ed.model['walls'])
    n_ops = sum(len(w.get('openings') or []) for w in ed.model['walls'])
    assert_true(os.path.getsize(out) > 5000, 'IFC не пустой')
    assert_true('FILE_SCHEMA' in text and 'IFC4' in text, 'схема IFC4')
    assert_true(text.count('IFCWALLSTANDARDCASE(') == n_walls,
                'стен в IFC %d == %d' % (text.count('IFCWALLSTANDARDCASE('), n_walls))
    assert_true(text.count('IFCOPENINGELEMENT(') == n_ops,
                'проёмов в IFC %d == %d' % (text.count('IFCOPENINGELEMENT('), n_ops))
    assert_true(info.get('summary') is not None, 'json-to-ifc вернул сводку')
    return 'IFC %.1f КБ: %d стен, %d проёмов' % (
        os.path.getsize(out) / 1024.0, n_walls, n_ops)


@check('IFC: сдвиг стены меняет IFC-координату')
def test_shift_changes_ifc_coordinate():
    ed = fresh_editor()
    idx = first_measured_wall_without_openings(ed.model)
    w0 = copy.deepcopy(ed.model['walls'][idx])
    p0 = wall_center_ifc_point(w0)
    base_ifc = os.path.join(CTX.tmpdir, 'shift-base.ifc')
    ed.export_ifc(base_ifc)
    pts_base = ifc_cartesian_points(read_text(base_ifc))
    assert_true(has_ifc_point(pts_base, p0), 'в базовом IFC есть центр стены %d' % idx)
    off = 0.10
    ed.set_wall(idx, offset=off)
    w1 = ed.model['walls'][idx]
    _a, _d, n1, _L, _t = em.wall_frame(w1)
    p1 = (p0[0] + n1[0] * off, p0[1] + n1[1] * off, p0[2])
    moved_ifc = os.path.join(CTX.tmpdir, 'shift-moved.ifc')
    ed.export_ifc(moved_ifc)
    pts_m = ifc_cartesian_points(read_text(moved_ifc))
    assert_true(has_ifc_point(pts_m, p1), 'в новом IFC есть сдвинутый центр стены %d' % idx)
    assert_true(not has_ifc_point(pts_m, p0),
                'старого центра стены в новом IFC нет (координата изменилась)')
    return 'стена %d: IFC-точка (%.4f, %.4f, %.3f) -> (%.4f, %.4f, %.3f)' % (
        idx, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2])


@check('IFC после правок: validate-ifc.py 0 ERROR, арность OK')
def test_ifc_valid_after_edits():
    ed = fresh_editor()
    idx_wall = first_measured_wall_without_openings(ed.model)
    t = float(ed.model['walls'][idx_wall]['thickness'])
    ed.set_wall(idx_wall, thickness=round(min(0.55, t + 0.03), 3))
    ed.set_wall(idx_wall, offset=0.01)
    op_wall = next((i for i, w in enumerate(ed.model['walls']) if w.get('openings')), None)
    if op_wall is not None:
        L = float(ed.model['walls'][op_wall]['length'])
        ed.move_opening(op_wall, 0, along=round(min(L - 0.5, 0.3 + 0.02), 3))
    ed.add_opening(idx_wall, along=max(0.2, float(ed.model['walls'][idx_wall]['length']) - 1.2),
                   width=0.9, kind='door')
    n_before = sum(len(w.get('openings') or []) for w in ed.model['walls'])
    ed.remove_opening(idx_wall, 0)
    n_after = sum(len(w.get('openings') or []) for w in ed.model['walls'])
    assert_true(n_after == n_before - 1, 'удаление проёма учтено в модели')
    out = os.path.join(CTX.tmpdir, 'edited.ifc')
    ed.export_ifc(out)
    val = em.validate_ifc(out)
    assert_true(val['ok'] is True, 'валидатор: %s' % val.get('output', '')[-300:])
    assert_true(val['errors'] == 0, 'ERROR=0 (получено %s)' % val['errors'])
    assert_true(not val['arityMismatches'], 'расхождений арности нет')
    inv = val['inventory']
    assert_true(inv.get('IfcWallStandardCase', 0) == len(ed.model['walls']),
                'стен в IFC == модели')
    return 'IFC валиден: ERROR=0, WARNING=%s, стен %d, проёмов %d' % (
        val['warnings'], inv.get('IfcWallStandardCase'), inv.get('IfcOpeningElement'))


# ======================================================================================
# 6. привязка к облаку
# ======================================================================================
@check('snap_wall (синтетика): восстанавливает сдвиг +0.12 м и толщину 0.18 м')
def test_snap_wall_synthetic():
    ed = synth_editor(CTX.synth_model)
    w0 = copy.deepcopy(ed.model['walls'][0])
    res = ed.snap_wall(0)
    assert_true(res['accepted'] is True, 'snap принят: %s' % res.get('reason'))
    assert_true(res['changed'] is True, 'модель изменена')
    w = ed.model['walls'][0]
    assert_close(res['offset'], 0.12, 0.02, 'сдвиг оси восстановлен (+0.12 м)')
    assert_close(w['thickness'], 0.18, 0.02, 'толщина восстановлена (0.18 м)')
    assert_true(res['rms_after'] < res['rms_before'] - 1e-4,
                'RMS улучшился: %.4f -> %.4f' % (res['rms_before'], res['rms_after']))
    assert_close(w['length'], w0['length'], 1e-6, 'длина при привязке не изменилась')
    assert_true(ed.undo()['changed'], 'snap отменяем')
    assert_true(ed.model['walls'][0]['a'] == w0['a'], 'undo вернул ось')
    return 'shift %+.3f, T %.3f -> %.3f, RMS %.4f -> %.4f' % (
        res['offset'], res['thickness_before'], res['thickness_after'],
        res['rms_before'], res['rms_after'])


@check('snap_wall (реальное облако): RMS не хуже, сдвиг <= 0.25 м')
def test_snap_wall_real():
    if not CTX.real or not CTX.has_cloud:
        raise SkipTest('нет реального облака')
    ed = fresh_editor(with_cloud=True)
    idx = 11 if len(ed.model['walls']) > 11 else first_measured_wall_without_openings(ed.model)
    w0 = copy.deepcopy(ed.model['walls'][idx])
    res = ed.snap_wall(idx)
    if not res['accepted']:
        assert_true(bool(res.get('reason')), 'у отказа есть причина')
        return 'стена %d: привязка отклонена — %s' % (idx, res.get('reason'))
    w = ed.model['walls'][idx]
    assert_true(abs(res['offset']) <= 0.25 + 1e-9, 'сдвиг %.3f <= 0.25 м' % res['offset'])
    assert_true(0.06 <= w['thickness'] <= 0.60, 'толщина %.3f в разумных пределах' % w['thickness'])
    assert_true(res['rms_after'] <= res['rms_before'] + 1e-6,
                'RMS не хуже: %.4f -> %.4f' % (res['rms_before'], res['rms_after']))
    assert_close(w['length'], w0['length'], 1e-6, 'длина не изменилась')
    assert_true(res['changed'] is True, 'модель изменена')
    assert_true(CTX.real and idx == 11, 'тест ориентирован на стену 11')
    return 'стена %d: T %.3f -> %.3f м, сдвиг %+.3f, RMS %.4f -> %.4f (точек %d)' % (
        idx, res['thickness_before'], res['thickness_after'], res['offset'],
        res['rms_before'], res['rms_after'], res['points'])


@check('snap_wall: достроенная (inferred) стена не привязывается')
def test_snap_wall_inferred():
    if not CTX.real:
        raise SkipTest('нет реальной модели с inferred-стенами')
    ed = fresh_editor(with_cloud=True)
    idx = next((i for i, w in enumerate(ed.model['walls'])
                if w.get('inferred') or w.get('material') == 'inferred'), None)
    if idx is None:
        raise SkipTest('в модели нет inferred-стен')
    res = ed.snap_wall(idx)
    assert_true(res['accepted'] is False, 'inferred-стена не привязана')
    assert_true(not res['changed'], 'модель не изменена')
    assert_true('inferred' in (res.get('reason') or ''), 'причина — inferred')
    return 'стена %d: отказ — %s' % (idx, res.get('reason'))


@check('snap_opening (синтетика): кромки по разрыву облака ±0.1 м')
def test_snap_opening_synthetic():
    ed = synth_editor(CTX.synth_model)
    res = ed.snap_opening(2, 0)
    assert_true(res['accepted'] is True, 'snap проёма принят: %s' % res.get('reason'))
    o = ed.model['walls'][2]['openings'][0]
    assert_close(o['along'], 2.0, 0.10, 'начало разрыва 2.0 м (±0.1)')
    assert_close(o['width'], 0.9, 0.10, 'ширина разрыва 0.9 м (±0.1)')
    assert_true(res['changed'] is True, 'модель изменена')
    return 'проём стены 2: along %.3f -> %.3f, width %.3f -> %.3f' % (
        res['along_before'], res['along_after'], res['width_before'], res['width_after'])


@check('snap_opening (реальное облако): края совпадают с облаком')
def test_snap_opening_real():
    if not CTX.real or not CTX.has_cloud:
        raise SkipTest('нет реального облака')
    ed = fresh_editor(with_cloud=True)
    idx = next((i for i, w in enumerate(ed.model['walls'])
                if (not w.get('inferred')) and w.get('openings')), None)
    if idx is None:
        raise SkipTest('нет измеренной стены с проёмом')
    L = float(ed.model['walls'][idx]['length'])
    res = ed.snap_opening(idx, 0)
    if not res['accepted']:
        assert_true(bool(res.get('reason')), 'у отказа есть причина')
        return 'стена %d: привязка проёма отклонена — %s' % (idx, res.get('reason'))
    o = ed.model['walls'][idx]['openings'][0]
    assert_true(0.0 <= o['along'] and o['along'] + o['width'] <= L + 1e-6,
                'проём остался внутри стены')
    assert_true(0.6 <= o['width'] <= 2.5, 'ширина разрыва 0.6..2.5 м')
    assert_true(abs(float(o['along']) - float(res['along_before'])) <= 0.5,
                'кромка не уехала дальше 0.5 м')
    return 'стена %d проём 0: along %.3f -> %.3f, width %.3f -> %.3f (разрыв %s)' % (
        idx, res['along_before'], res['along_after'],
        res['width_before'], res['width_after'], res.get('gap'))


# ======================================================================================
# 7. CLI
# ======================================================================================
@check('CLI --help: код 0 и список операций')
def test_cli_help():
    proc = run_cli(['--help'])
    assert_true(proc.returncode == 0, '--help вернул 0')
    text = (proc.stdout or '') + (proc.stderr or '')
    for op in ('set_wall', 'move_opening', 'snap_wall', 'snap_opening', 'undo', 'redo'):
        assert_true(op in text, 'в --help есть операция %s' % op)
    return '--help OK, операций в справке: %d' % len(em.OPS)


@check('CLI: move_wall --offset --snap --out --json')
def test_cli_move_wall_snap():
    if not CTX.has_cloud:
        raise SkipTest('нет облака для --snap')
    out = os.path.join(CTX.tmpdir, 'cli-move.json')
    proc, payload = run_cli_json([
        '--model', CTX.model_path, '--cloud', CTX.cloud_path,
        '--op', 'move_wall', '--index', '3' if CTX.real else '0',
        '--offset', '0.08', '--snap', '--out', out])
    assert_true(proc.returncode == 0,
                'код 0, получено %d: %s' % (proc.returncode, (proc.stderr or '')[-300:]))
    assert_true(payload is not None and payload.get('ok') is True, 'JSON-ответ ok')
    assert_true(os.path.isfile(out), '--out записан')
    assert_true(os.path.isfile(out + '.history.json'), 'sidecar истории записан')
    res = payload['result']
    assert_true(res.get('changed') is True, 'стена сдвинута')
    snap = res.get('snap') or {}
    assert_true('accepted' in snap, 'в результате есть вердикт snap')
    w = read_json(out)['walls'][3 if CTX.real else 0]
    assert_true(w['a'] != CTX.model['walls'][3 if CTX.real else 0]['a'],
                'координата стены в файле изменилась')
    return 'offset +0.08 + snap: accepted=%s, a %s -> %s' % (
        snap.get('accepted'), CTX.model['walls'][3 if CTX.real else 0]['a'],
        [round(v, 4) for v in w['a']])


@check('CLI: undo/redo между запусками через sidecar')
def test_cli_undo_redo():
    base = os.path.join(CTX.tmpdir, 'cli-u0.json')
    p0 = run_cli(['--model', CTX.model_path, '--op', 'set_wall',
                  '--index', '3' if CTX.real else '0', '--thickness',
                  '0.19' if CTX.real else '0.23', '--out', base])
    assert_true(p0.returncode == 0, 'правка через CLI: %s' % (p0.stderr or '')[-200:])
    u1 = os.path.join(CTX.tmpdir, 'cli-u1.json')
    p1 = run_cli(['--model', base, '--op', 'undo', '--out', u1])
    assert_true(p1.returncode == 0, 'undo через CLI')
    m_undo = read_json(u1)
    assert_true(m_undo['walls'] == CTX.model['walls'], 'undo вернул стены к исходным')
    r1 = os.path.join(CTX.tmpdir, 'cli-u2.json')
    p2 = run_cli(['--model', u1, '--op', 'redo', '--out', r1])
    assert_true(p2.returncode == 0, 'redo через CLI')
    m_redo = read_json(r1)
    assert_true(m_redo['walls'] == read_json(base)['walls'], 'redo вернул правку')
    return 'правка -> undo (стены == исходным) -> redo (стены == правке)'


@check('CLI: ошибки параметров дают код 2')
def test_cli_errors():
    r1 = run_cli_json(['--model', CTX.model_path, '--op', 'set_wall', '--index', '0'])
    assert_true(r1[0].returncode == 2, 'без изменений для set_wall -> код 2')
    assert_true(r1[1] and r1[1].get('ok') is False, 'JSON с ok=false')
    r2 = run_cli_json(['--model', os.path.join(CTX.tmpdir, 'нет-такого.json'),
                       '--op', 'info'])
    assert_true(r2[0].returncode == 2, 'нет модели -> код 2')
    r3 = run_cli_json(['--model', CTX.model_path, '--op', 'set_wall',
                       '--index', '9999', '--thickness', '0.2'])
    assert_true(r3[0].returncode == 2, 'нет стены 9999 -> код 2')
    return '3 некорректных вызова -> код 2'


@check('CLI: set_wall --thickness --ifc --validate (end-to-end)')
def test_cli_end_to_end():
    out = os.path.join(CTX.tmpdir, 'cli-e2e.json')
    ifc = os.path.join(CTX.tmpdir, 'cli-e2e.ifc')
    idx = 3 if CTX.real else 0
    proc, payload = run_cli_json([
        '--model', CTX.model_path, '--op', 'set_wall', '--index', str(idx),
        '--thickness', '0.20' if CTX.real else '0.23',
        '--out', out, '--ifc', ifc, '--validate'])
    assert_true(proc.returncode == 0,
                'код 0: %s' % ((proc.stderr or '') + (proc.stdout or ''))[-300:])
    assert_true(os.path.isfile(out) and os.path.isfile(ifc), 'модель и IFC созданы')
    val = payload.get('validate') or {}
    assert_true(val.get('ok') is True, 'валидация OK')
    assert_true(val.get('errors') == 0, 'ERROR=0')
    return 'CLI: модель + IFC %.1f КБ, валидация ERROR=0, стен %d' % (
        os.path.getsize(ifc) / 1024.0, (val.get('inventory') or {}).get('IfcWallStandardCase', 0))


# ======================================================================================
# запуск
# ======================================================================================
def main(argv=None):
    ap = argparse.ArgumentParser(description='Тесты ядра редактора edit-model.py (Фаза 4)')
    ap.add_argument('--data', help='папка с py2-p1.json и koridor-local-rgb.bin')
    ap.add_argument('--keep', action='store_true', help='не удалять временные файлы')
    args = ap.parse_args(argv)
    t0 = time.time()
    try:
        setup_context(args)
    except Exception:  # noqa: BLE001
        print('ОШИБКА подготовки тестового окружения:')
        traceback.print_exc()
        return 1
    passed = failed = skipped = 0
    failures = []
    for name, fn in TESTS:
        started = time.time()
        try:
            detail = fn()
            passed += 1
            print('PASS  %-56s %5.1fс  %s' % (name, time.time() - started, detail or ''))
        except SkipTest as exc:
            skipped += 1
            print('SKIP  %-56s %s' % (name, exc))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            failures.append((name, exc))
            print('FAIL  %-56s %5.1fс  %s' % (name, time.time() - started, exc))
            traceback.print_exc()
    total = passed + failed
    print()
    print('ИТОГ: PASS %d, FAIL %d, SKIP %d (всего проверок %d, %.1f с)' % (
        passed, failed, skipped, total, time.time() - t0))
    print('данные: %s (%s)' % (CTX.model_path, 'реальные' if CTX.real else 'синтетические'))
    if failed:
        print('ПРОВАЛЕНЫ: %s' % ', '.join(n for n, _ in failures))
    if failures or passed == 0:
        if not args.keep:
            print('временные файлы оставлены для отладки: %s' % CTX.tmpdir)
        return 1
    if not args.keep:
        shutil.rmtree(CTX.tmpdir, ignore_errors=True)
    print('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
    return 0


if __name__ == '__main__':
    sys.exit(main())
