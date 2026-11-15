#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""edit-model.py — ядро ручного редактора BIM-модели Scan2BIM (Фаза 4 ROADMAP-IDEAL.md, r110).

Инструмент работает с JSON-моделью движка scan2bim-v2.py (схема: storey + walls[] + slabs +
rooms[] + stats): правит стены/проёмы, привязывает их к облаку точек, ведёт undo/redo
(стек JSON-снимков модели, глубина по умолчанию 32) и перегенерирует IFC через
renderer/scan2bim.js (node tools/scan2bim-py/json-to-ifc.js).

Библиотека (импорт из других Python-модулей — имя файла с дефисом, но функции/класс ниже
импортируются через importlib):

    from edit_model import Editor, load_model, save_model, set_wall, snap_wall, ...

    ed = Editor.load('model.json', cloud='cloud.bin')
    ed.set_wall(3, offset=0.08)          # сдвиг оси на 8 см (по нормали)
    ed.set_wall(11, thickness=0.17)      # толщина
    ed.snap_wall(3)                      # привязка к облаку (2-модная медиана)
    ed.move_opening(0, 0, along=1.20)
    ed.add_opening(0, along=2.5, width=0.9, kind='door')
    ed.remove_opening(0, 1)
    ed.undo(); ed.redo()
    ed.save('model-edit.json')           # + sidecar истории
    ed.export_ifc('model-edit.ifc')
    validate_ifc('model-edit.ifc')       # 0 ERROR через validate-ifc.py

CLI (операция за один запуск, состояние истории — в sidecar <модель>.history.json).
Облако для `--snap`/`snap_wall`/`snap_opening` можно не указывать — оно ищется рядом
с моделью (`<модель>.bin`, `koridor-local-rgb.bin`, …):

    python edit-model.py --model M.json --op move_wall --index 3 --offset 0.08 --snap \\
        --cloud C.bin --out M2.json --ifc M2.ifc --validate --json
    python edit-model.py --model M.json --op move_wall --index 3 --offset 0.08 --snap --out M2.json
    python edit-model.py --model M.json --op undo --out M2.json
    python edit-model.py --model M.json --op info --json
    python edit-model.py --help

Коды возврата CLI: 0 — операция выполнена (в т.ч. snap отклонён с accepted=false);
2 — ошибка параметров/модели; 1 — ошибка экспорта IFC или валидации.

Соглашения модели: a=[x,z], b=[x,z], dir=[dx,dz] (план, XZ), Y — вверх; сдвиг offset —
вдоль нормали n=(-dz,dx); в IFC координаты отображаются X=model x, Y=model z, Z=model y.
"""
import argparse
import copy
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

try:  # геометрия/CLI без облака работают и без numpy; для облака он обязателен
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

# ---------- константы ----------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_TO_IFC = os.path.join(SCRIPT_DIR, 'json-to-ifc.js')
VALIDATE_IFC = os.path.join(SCRIPT_DIR, 'validate-ifc.py')

DEFAULT_UNDO_DEPTH = 32
MIN_UNDO_DEPTH = 20          # требование Фазы 4: глубина истории не меньше 20
SNAP_LATERAL = 0.5           # полоса поиска мод, ±м (как в scan2bim-v2.py / ruler-v2.py)
SNAP_BIN = 0.01              # шаг гистограммы sn, м
SNAP_MAX_SHIFT = 0.25        # предел сдвига оси при привязке, м
SNAP_MIN_THICK, SNAP_MAX_THICK = 0.06, 0.60
SNAP_MIN_POINTS = 200.0      # минимум точек в полосе (max(200, 30*L))
SNAP_TRIM = 0.70             # доля точек с наименьшими невязками для устойчивого RMS
SNAP_MIN_PEAK = 400          # минимум точек в пике моды: защита от ложной пары в шуме
SNAP_MIN_PEAK_FRAC = 0.005   # ... или 0.5 % точек полосы (что больше)
SNAP_ROTATE_MAX_DEG = 3.0    # предел поворота стены при привязке, градусы
SNAP_ROTATE_MIN_DEG = 0.3    # меньше этого поворот не применяем (это шум)
SNAP_ROTATE_GAIN = 0.10      # поворот применяем, только если RMS лучше shift-only на 10 %
SNAP_BIN_LEN = 1.0           # длина бина вдоль стены для оценки наклона, м
OPENING_MIN_WIDTH = 0.6      # проём по облаку (как в scan2bim-v2.py)
OPENING_MAX_WIDTH = 2.5
WALL_MIN_LENGTH = 0.05
WALL_MIN_THICK, WALL_MAX_THICK = 0.04, 2.00


class EditError(Exception):
    """Ошибка операции/параметров редактирования (CLI: код 2)."""


def _require_numpy():
    if np is None:
        raise EditError('для операций с облаком нужен numpy (pip install numpy)')
    return np


# ======================================================================================
# 1. Загрузка / сохранение / нормализация модели
# ======================================================================================
def _norm2(x, z):
    l = math.hypot(x, z)
    if l <= 1e-12:
        raise EditError('dir стены нулевой')
    return (x / l, z / l)


def wall_frame(w):
    """(a, dir, normal, length, thickness) стены; нормаль в плане n=(-dz,dx)."""
    a = (float(w['a'][0]), float(w['a'][1]))
    d = _norm2(float(w['dir'][0]), float(w['dir'][1]))
    n = (-d[1], d[0])
    return a, d, n, float(w['length']), float(w['thickness'])


def wall_normal(w):
    d = _norm2(float(w['dir'][0]), float(w['dir'][1]))
    return (-d[1], d[0])


def wall_b(w):
    """Торец b, пересчитанный из a + dir*length."""
    a, d, _n, L, _t = wall_frame(w)
    return (round(a[0] + d[0] * L, 4), round(a[1] + d[1] * L, 4))


def _recompute_b(w):
    bx, bz = wall_b(w)
    w['b'] = [bx, bz]


def _clip_openings(w, warnings=None):
    """Приводит проёмы стены к длине/высоте стены; сортирует по along."""
    warnings = warnings if warnings is not None else []
    L = float(w['length'])
    H = float(w.get('height') or 0.0)
    out = []
    for k, o in enumerate(w.get('openings') or []):
        o = dict(o)
        along = max(0.0, min(float(o.get('along', 0.0)), L))
        width = max(0.0, min(float(o.get('width', 0.0)), L - along))
        if width < 0.10:
            warnings.append('проём %d стены обрезан до нуля и удалён' % k)
            continue
        op = o
        op['along'] = round(along, 3)
        op['width'] = round(width, 3)
        sill = float(op.get('sill', 0.0) or 0.0)
        head = float(op.get('head', H) or H)
        sill = max(0.0, min(sill, max(0.0, H - 0.20)))
        head = max(sill + 0.20, min(head, H if H > 0 else head))
        op['sill'] = round(sill, 3)
        op['head'] = round(head, 3)
        op.setdefault('kind', 'door')
        out.append(op)
    out.sort(key=lambda q: float(q['along']))
    w['openings'] = out
    return out


def _normalize_wall(w, i, storey_h, floorY):
    if not isinstance(w, dict):
        raise EditError('стена %d — не объект' % i)
    for key in ('a', 'b', 'dir', 'length', 'thickness'):
        if key not in w:
            raise EditError('у стены %d нет поля %r' % (i, key))
    ax, az = float(w['a'][0]), float(w['a'][1])
    if not (math.isfinite(ax) and math.isfinite(az)):
        raise EditError('у стены %d некорректные координаты a' % i)
    d = _norm2(float(w['dir'][0]), float(w['dir'][1]))
    L = float(w['length'])
    T = float(w['thickness'])
    if not math.isfinite(L) or L < WALL_MIN_LENGTH:
        raise EditError('у стены %d некорректная длина %r' % (i, w['length']))
    if not math.isfinite(T):
        raise EditError('у стены %d некорректная толщина' % i)
    w['a'] = [ax, az]
    if abs(math.hypot(float(w['dir'][0]), float(w['dir'][1])) - 1.0) > 1e-5:
        w['dir'] = [round(d[0], 5), round(d[1], 5)]
    w['length'] = round(L, 4)
    w['thickness'] = round(min(WALL_MAX_THICK, max(WALL_MIN_THICK, T)), 4)
    w.setdefault('base', floorY)
    if w.get('height') is None:
        w['height'] = storey_h
    w['height'] = round(min(max(float(w['height']), 0.3), 20.0), 4)
    w['base'] = round(float(w['base']), 4)
    if 'b' not in w or not isinstance(w['b'], list) or len(w['b']) < 2:
        _recompute_b(w)
    _clip_openings(w)
    return w


def normalize_model(model):
    """Проверяет и мягко нормализует модель на месте. Возвращает её же."""
    if not isinstance(model, dict):
        raise EditError('JSON модели — не объект')
    walls = model.get('walls')
    if not isinstance(walls, list) or not walls:
        raise EditError('в модели нет стен (model["walls"])')
    storey = model.get('storey')
    if not isinstance(storey, dict):
        storey = {}
        model['storey'] = storey
    floorY = float(storey.get('floorY', 0.0) or 0.0)
    ceilY = float(storey.get('ceilY', floorY + 3.0) or (floorY + 3.0))
    if ceilY <= floorY:
        ceilY = floorY + 3.0
    storey['floorY'] = round(floorY, 4)
    storey['ceilY'] = round(ceilY, 4)
    storey['height'] = round(ceilY - floorY, 4)
    h = storey['height']
    for i, w in enumerate(walls):
        _normalize_wall(w, i, h, floorY)
    for key in ('rooms', 'slabs', 'pipes', 'objects', 'beams', 'cables'):
        if key not in model or model[key] is None:
            model[key] = []
    if model.get('ok') is False:
        raise EditError('модель помечена ok=false — редактировать и экспортировать нечего')
    model['ok'] = True
    return model


def load_model(path):
    """Читает JSON-модель и нормализует её. Ошибки — EditError."""
    if not os.path.isfile(path):
        raise EditError('модель не найдена: %s' % path)
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            model = json.load(f)
    except (OSError, ValueError) as exc:
        raise EditError('не читается JSON модели %s: %s' % (path, exc))
    return normalize_model(model)


def recount_stats(model):
    """Пересчитывает сводные числа stats (по стенам/проёмам/помещениям)."""
    walls = model.get('walls') or []
    rooms = model.get('rooms') or []
    stats = model.setdefault('stats', {})
    stats['wallCount'] = len(walls)
    stats['openingCount'] = int(sum(len(w.get('openings') or []) for w in walls))
    stats['passageCount'] = int(sum(len(w.get('passages') or []) for w in walls))
    stats['roomCount'] = len(rooms)
    stats['floorArea'] = round(float(sum(float(r.get('area') or 0.0) for r in rooms)), 1)
    stats['totalWallLength'] = round(float(sum(float(w.get('length') or 0.0) for w in walls)), 1)
    return stats


def _atomic_json_dump(obj, path, indent=1, ensure_ascii=False):
    path = os.path.abspath(path)
    d = os.path.dirname(path) or '.'
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.edit-model-', suffix='.json.tmp', dir=d)
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=ensure_ascii, indent=indent)
            f.write('\n')
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def save_model(model, path):
    """Пересчитывает stats и атомарно пишет модель (проверяя, что она читается)."""
    normalize_model(model)
    recount_stats(model)
    # контроль: сериализуем и читаем обратно (не пишем битый файл)
    blob = json.dumps(model, ensure_ascii=False)
    try:
        json.loads(blob)
    except ValueError as exc:  # pragma: no cover — страховка
        raise EditError('модель не сериализуется: %s' % exc)
    return _atomic_json_dump(model, path)


# ======================================================================================
# 2. Облако точек: x,y,z,r,g,b float32, Y вверх (формат движков scan2bim)
# ======================================================================================
class Cloud:
    """Облако точек (.bin float32 x,y,z,r,g,b, Y вверх). Читается через memmap + прореживание."""

    def __init__(self, path, stride=2):
        _require_numpy()
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise EditError('облако не найдено: %s' % path)
        size = os.path.getsize(path)
        if size == 0 or size % 24 != 0:
            raise EditError('размер облака %s не кратен 24 байтам (float32 x,y,z,r,g,b)' % path)
        n = size // 24
        self.path = path
        self.points_total = int(n)
        self.stride = max(1, int(stride))
        mm = np.memmap(path, dtype=np.float32, mode='r').reshape(n, 6)
        sub = np.asarray(mm[:: self.stride])
        self.points_used = int(len(sub))
        self.xyz = np.ascontiguousarray(sub[:, :3], dtype=np.float64)

    def band(self, wall, lateral, y_lo, y_hi, along_margin=0.0):
        """Точки в полосе |sn|<=lateral и su в [-along_margin, L+along_margin].

        Возвращает (su, sn) — расстояния вдоль/поперёк оси стены, float64.
        """
        a, d, n, L, _T = wall_frame(wall)
        xyz = self.xyz
        dx = xyz[:, 0] - a[0]
        dz = xyz[:, 2] - a[1]
        su = dx * d[0] + dz * d[1]
        sn = dx * n[0] + dz * n[1]
        m = (np.abs(sn) <= float(lateral)) & (su >= -float(along_margin)) & \
            (su <= L + float(along_margin)) & (xyz[:, 1] >= y_lo) & (xyz[:, 1] <= y_hi)
        return su[m], sn[m]

    def __repr__(self):
        return 'Cloud(%s, %d/%d точек, stride %d)' % (
            os.path.basename(self.path), self.points_used, self.points_total, self.stride)


_CLOUD_CACHE = {}


def load_cloud(path, stride=2):
    """Кешированная загрузка облака (одно облако на процесс)."""
    key = (os.path.abspath(path), max(1, int(stride)))
    if key not in _CLOUD_CACHE:
        _CLOUD_CACHE[key] = Cloud(key[0], key[1])
    return _CLOUD_CACHE[key]


def discover_cloud(model_path):
    """Ищет облако рядом с моделью (для `--snap` без явного --cloud).

    Порядок: переменная окружения EDIT_MODEL_CLOUD → файлы рядом с моделью с
    приоритетными именами (`<модель>-rgb.bin`, `<модель>.bin`, `koridor-local-rgb.bin`,
    `koridor-local.bin`, `cloud.bin`) → единственный *.bin в папке модели.
    Возвращает путь или None.
    """
    env = os.environ.get('EDIT_MODEL_CLOUD')
    if env and os.path.isfile(env):
        return os.path.abspath(env)
    if not model_path:
        return None
    model_dir = os.path.dirname(os.path.abspath(model_path)) or '.'
    stem = os.path.splitext(os.path.basename(str(model_path)))[0]
    for name in (stem + '-rgb.bin', stem + '.bin', 'koridor-local-rgb.bin',
                 'koridor-local.bin', 'cloud.bin'):
        cand = os.path.join(model_dir, name)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    try:
        bins = sorted(glob.glob(os.path.join(model_dir, '*.bin')))
    except OSError:  # pragma: no cover
        bins = []
    if len(bins) == 1:
        return os.path.abspath(bins[0])
    return None


# ======================================================================================
# 3. Вспомогательное: 2-модная медиана и устойчивый RMS
# ======================================================================================
def _two_mode_peaks(sn, lateral=SNAP_LATERAL, binw=SNAP_BIN):
    """Пики гистограммы поперечных расстояний (локальные максимумы, как в scan2bim-v2.py)."""
    _require_numpy()
    nb = max(8, int(round(2.0 * lateral / binw)))
    hist, edges = np.histogram(sn, bins=nb, range=(-lateral, lateral))
    cen = (edges[:-1] + edges[1:]) / 2.0
    mx = float(hist.max()) if len(hist) else 0.0
    peaks = [k for k in range(1, len(hist) - 1)
             if hist[k] >= hist[k - 1] and hist[k] > hist[k + 1] and hist[k] > mx * 0.18]
    peaks.sort(key=lambda k: -hist[k])
    return hist, cen, peaks


def _pick_two_mode(hist, cen, peaks, th_hint=None, th_tol=None):
    """Две моды → (thickness, offset_shift, peak_info). Оценка как в ruler-v2.py:
    минимизируем |mid|*6 - min(support)/max(support) с ограничениями по толщине.

    th_hint/th_tol — необязательный фильтр: брать только пары с толщиной около th_hint
    (используется в оценке наклона, чтобы в каждом бине отслеживать ТЕ ЖЕ две грани).
    """
    best = None
    top = min(len(peaks), 8)
    min_sep = int(round(0.08 / SNAP_BIN))
    for ia in range(top):
        for ib in range(ia + 1, top):
            k1, k2 = peaks[ia], peaks[ib]
            if abs(k1 - k2) < min_sep:
                continue
            c1, c2 = sorted((float(cen[k1]), float(cen[k2])))
            th = abs(c2 - c1)
            if not (SNAP_MIN_THICK <= th <= SNAP_MAX_THICK):
                continue
            if th_hint is not None and abs(th - float(th_hint)) > float(th_tol or 0.08):
                continue
            mid = (c1 + c2) / 2.0
            score = abs(mid) * 6.0 - min(hist[k1], hist[k2]) / max(1.0, float(hist.max()))
            if best is None or score < best[0]:
                best = (score, th, mid, k1, k2)
    if best is None:
        return None
    _score, th, mid, k1, k2 = best
    info = [
        {'sn': round(float(cen[k1]), 3), 'count': int(hist[k1])},
        {'sn': round(float(cen[k2]), 3), 'count': int(hist[k2])},
    ]
    return th, mid, info


def _residuals(sn, shift, thickness):
    _require_numpy()
    sn2 = sn - float(shift)
    return np.minimum(np.abs(sn2 - float(thickness) / 2.0), np.abs(sn2 + float(thickness) / 2.0))


def _rms(res):
    return float(np.sqrt(np.mean(np.square(res)))) if len(res) else None


def _trimmed_rms(sn, shift, thickness, keep=SNAP_TRIM):
    """Устойчивый RMS невязки точек до ближайшей грани стены: берём долю keep точек с
    наименьшими невязками (облако в полосе ±0.5 м содержит мебель/трубы/соседние стены,
    поэтому обычный RMS по всей полосе к качеству привязки отношения не имеет)."""
    res = _residuals(sn, shift, thickness)
    if not len(res):
        return None
    k = max(1, int(len(res) * float(keep)))
    part = np.partition(res, k - 1)[:k]
    return float(np.sqrt(np.mean(np.square(part))))


def _fit_rotation(su, sn, L, th_hint, lateral=SNAP_LATERAL):
    """Оценка наклона стены к облаку (поворот в плане).

    Вдоль оси стены берутся бины по SNAP_BIN_LEN м; в каждом бине теми же двумя модами
    (толщина около th_hint) находится середина пары граней mid_k. Если таких бинов
    достаточно (>=60 %, минимум 3), через точки (center_k, mid_k) робастно (Тейл-Сен +
    уточнение по инлайерам) проводится прямая: sn = c0 + b*su. Наклон b — оценки поворота,
    середина на центре стены — сдвиг. Возвращает dict или None, если наклон не оценивается
    (например, видна только одна грань — типичный случай для стен у проёмов/в углах).
    """
    _require_numpy()
    nb = max(4, min(40, int(round(L / SNAP_BIN_LEN))))
    centers, mids, ths, weights = [], [], [], []
    for k in range(nb):
        lo, hi = k * L / nb, (k + 1) * L / nb
        m = (su >= lo) & (su < hi)
        if int(m.sum()) < 250:
            continue
        hist, cen, peaks = _two_mode_peaks(sn[m], lateral=float(lateral))
        picked = _pick_two_mode(hist, cen, peaks, th_hint=th_hint,
                                th_tol=max(0.06, 0.35 * float(th_hint)))
        if picked is None:
            continue
        th, mid, info = picked
        centers.append((lo + hi) / 2.0)
        mids.append(float(mid))
        ths.append(float(th))
        weights.append(float(min(info[0]['count'], info[1]['count'])))
    need_bins = max(3, int(math.ceil(0.60 * nb)))
    if len(centers) < need_bins:
        return None
    centers = np.asarray(centers, float)
    mids = np.asarray(mids, float)
    weights = np.asarray(weights, float)
    slopes = []
    for i in range(len(centers)):
        for j in range(i + 1, len(centers)):
            ds = centers[j] - centers[i]
            if abs(ds) > 0.5:
                slopes.append(float((mids[j] - mids[i]) / ds))
    if not slopes:
        return None
    b = float(np.median(slopes))
    # страховочный предел ТОЛЬКО от абсурдных наклонов: решение о допустимом угле
    # принимает вызывающий код (max_rotation_deg), чтобы в отчёте был виден реальный наклон
    b_safety = math.tan(math.radians(20.0))
    b = max(-b_safety, min(b_safety, b))
    for _ in range(2):
        c0 = float(np.median(mids - b * centers))
        res = mids - (c0 + b * centers)
        mad = float(np.median(np.abs(res)))
        inl = np.abs(res) <= max(0.02, 3.0 * mad + 1e-9)
        if int(inl.sum()) < 3:
            break
        sw = np.sqrt(weights[inl])
        A = np.vstack([np.ones(int(inl.sum())), centers[inl]]).T
        coef, *_ = np.linalg.lstsq(A * sw[:, None], mids[inl] * sw, rcond=None)
        b = float(coef[1])
        b = max(-b_safety, min(b_safety, b))
    c0 = float(np.median(mids - b * centers))
    theta = math.atan(b)
    # качество прямой: разброс середин вокруг неё и толщина
    spread = float(np.median(np.abs(mids - (c0 + b * centers))))
    return {'b': b, 'c0': c0, 'theta': theta, 'th': float(np.median(ths)),
            'bins': int(len(centers)), 'bins_total': int(nb),
            'spread': spread, 'mid_center': c0 + b * L / 2.0}


def _rotated_residuals(su, sn, b, c0, th):
    _require_numpy()
    scale = math.sqrt(1.0 + float(b) * float(b))
    sn2 = (sn - (float(c0) + float(b) * su)) / scale
    return np.minimum(np.abs(sn2 - float(th) / 2.0), np.abs(sn2 + float(th) / 2.0))


def _rotated_trimmed_rms(su, sn, b, c0, th, keep=SNAP_TRIM):
    res = _rotated_residuals(su, sn, b, c0, th)
    if not len(res):
        return None
    k = max(1, int(len(res) * float(keep)))
    part = np.partition(res, k - 1)[:k]
    return float(np.sqrt(np.mean(np.square(part))))


def _coverage_along(su, sn, L, half, openings, step=0.10, tol=0.07):
    """Покрытие длины стены облаком — та же формула, что в ruler-v2.py: на каждом шаге
    step вдоль стены (интервалы проёмов ±step пропускаются) нужно >=2 точек в полосе
    |sn| <= half и |su - s| <= tol. Нужен как защита от сдвига/поворота, который улучшает
    RMS, но «съедает» покрытие вдоль стены."""
    _require_numpy()
    m = np.abs(sn) <= float(half)
    su_m = su[m]
    if not len(su_m):
        return None
    ops = [(float(s0), float(s1)) for (s0, s1) in (openings or [])]
    hit = total = 0
    for s in np.arange(0.0, L + 1e-9, float(step)):
        if any(s0 - step <= s <= s1 + step for (s0, s1) in ops):
            continue
        total += 1
        if int(np.count_nonzero(np.abs(su_m - s) <= float(tol))) >= 2:
            hit += 1
    return float(hit) / max(1, total)


# ======================================================================================
# 4. Редактор: операции над моделью + undo/redo + save/export/validate
# ======================================================================================
class Editor:
    """Редактор модели: операции, стек снимков (undo/redo), сохранение и IFC."""

    def __init__(self, model, cloud=None, undo_depth=DEFAULT_UNDO_DEPTH, history_path=None):
        self.model = normalize_model(model)
        self.cloud = cloud
        self.undo_depth = max(1, int(undo_depth))
        self._undo = []
        self._redo = []
        self.history_path = history_path
        self.model_path = None
        self.warnings = []

    # ---------- создание ----------
    @classmethod
    def load(cls, path, cloud=None, undo_depth=DEFAULT_UNDO_DEPTH, history_path=None,
             stride=2, load_history=True):
        model = load_model(path)
        ed = cls(model, cloud=None, undo_depth=undo_depth, history_path=history_path)
        ed.model_path = os.path.abspath(path)
        if cloud is not None:
            ed.cloud = load_cloud(cloud, stride) if isinstance(cloud, str) else cloud
        if load_history:
            hp = history_path if history_path is not None else (path + '.history.json')
            if os.path.isfile(hp):
                try:
                    ed.load_history(hp)
                except (OSError, ValueError, TypeError) as exc:
                    ed.warnings.append('история %s не прочитана: %s' % (hp, exc))
            ed.history_path = hp
        return ed

    # ---------- облако / этаж ----------
    def _cloud(self):
        if self.cloud is None:
            raise EditError('для этой операции нужно облако точек: укажите --cloud <file.bin> '
                            '(или положите <модель>.bin / koridor-local-rgb.bin рядом с моделью, '
                            'либо задайте EDIT_MODEL_CLOUD)')
        if isinstance(self.cloud, str):
            self.cloud = load_cloud(self.cloud)
        return self.cloud

    def _storey_band(self):
        st = self.model.get('storey') or {}
        floorY = float(st.get('floorY', 0.0) or 0.0)
        ceilY = float(st.get('ceilY', floorY + 3.0) or (floorY + 3.0))
        return floorY, ceilY

    # ---------- история ----------
    def _snapshot(self):
        return copy.deepcopy(self.model)

    def _commit(self, before, result):
        """Фиксирует изменение: если модель изменилась, кладём снимок в undo и чистим redo."""
        changed = (self.model != before)
        if changed:
            self._undo.append(before)
            while len(self._undo) > self.undo_depth:
                self._undo.pop(0)
            self._redo.clear()
        result['changed'] = bool(changed)
        return result

    @property
    def can_undo(self):
        return bool(self._undo)

    @property
    def can_redo(self):
        return bool(self._redo)

    def state(self):
        return {'canUndo': self.can_undo, 'canRedo': self.can_redo,
                'undo': len(self._undo), 'redo': len(self._redo),
                'undoDepth': self.undo_depth}

    def undo(self):
        if not self._undo:
            return {'op': 'undo', 'changed': False, 'reason': 'история пуста',
                    **self.state()}
        self._redo.append(self._snapshot())
        while len(self._redo) > self.undo_depth:
            self._redo.pop(0)
        snap = self._undo.pop()
        self.model.clear()
        self.model.update(snap)
        return {'op': 'undo', 'changed': True, **self.state()}

    def redo(self):
        if not self._redo:
            return {'op': 'redo', 'changed': False, 'reason': 'нечего повторять',
                    **self.state()}
        self._undo.append(self._snapshot())
        while len(self._undo) > self.undo_depth:
            self._undo.pop(0)
        snap = self._redo.pop()
        self.model.clear()
        self.model.update(snap)
        return {'op': 'redo', 'changed': True, **self.state()}

    # ---------- получение объектов ----------
    def wall(self, index):
        walls = self.model['walls']
        try:
            index = int(index)
        except (TypeError, ValueError):
            raise EditError('индекс стены должен быть целым: %r' % (index,))
        if not (0 <= index < len(walls)):
            raise EditError('нет стены с индексом %d (в модели %d стен)' % (index, len(walls)))
        return walls[index]

    def opening(self, wall_index, opening_index):
        w = self.wall(wall_index)
        ops = w.get('openings') or []
        try:
            opening_index = int(opening_index)
        except (TypeError, ValueError):
            raise EditError('индекс проёма должен быть целым: %r' % (opening_index,))
        if not (0 <= opening_index < len(ops)):
            raise EditError('в стене %d нет проёма с индексом %d (всего %d)' % (
                int(wall_index), opening_index, len(ops)))
        return w, ops[opening_index]

    def _opening_index(self, wall_index, op):
        """Индекс проёма в стене после нормализации/сортировки (по значениям, не по объекту)."""
        ops = self.wall(wall_index).get('openings') or []
        for k, cand in enumerate(ops):
            if cand is op:
                return k
        for k, cand in enumerate(ops):
            if all(cand.get(key) == op.get(key) for key in ('along', 'width', 'sill', 'head', 'kind')):
                return k
        return 0

    def _check_openings_overlap(self, w, skip_index=None, extra=None):
        """Проверяет, что проёмы не накладываются друг на друга (extra — новый/двинутый)."""
        spans = []
        for k, o in enumerate(w.get('openings') or []):
            if skip_index is not None and k == int(skip_index):
                continue
            spans.append((float(o['along']), float(o['along']) + float(o['width']), k))
        if extra is not None:
            spans.append((float(extra['along']), float(extra['along']) + float(extra['width']), 'new'))
        spans.sort()
        for a in range(1, len(spans)):
            if spans[a][0] < spans[a - 1][1] - 1e-6:
                raise EditError('проёмы накладываются: %s и %s' % (spans[a - 1][2], spans[a][2]))

    # ---------- 1) стена: сдвиг/толщина/длина/удлинение ----------
    def set_wall(self, index, offset=None, thickness=None, length=None,
                 extend_start=None, extend_end=None, height=None, base=None, snap=False,
                 max_shift=SNAP_MAX_SHIFT, rotate=True, max_rotation_deg=SNAP_ROTATE_MAX_DEG):
        """Правка стены.

        offset       — сдвиг оси по нормали n=(-dz,dx), м (знак: + в сторону нормали);
        thickness    — новая толщина, м;
        length       — новая длина, м (торец b пересчитывается из a+dir*length);
        extend_start — удлинение в начало (a -= dir*extend_start; openings.along += extend_start);
        extend_end   — удлинение в торец (length += extend_end);
        height/base  — высота/низ стены (доп. параметры роадмапа «изменение высоты»);
        snap         — после правки привязать стену к облаку (см. snap_wall).
        """
        w = self.wall(index)
        before = self._snapshot()
        a, d, n, L, T = wall_frame(w)
        res = {'op': 'set_wall', 'wall': int(index),
               'before': {'a': [round(a[0], 4), round(a[1], 4)],
                          'b': [round(a[0] + d[0] * L, 4), round(a[1] + d[1] * L, 4)],
                          'length': round(L, 4), 'thickness': round(T, 4)},
               'warnings': []}
        changed_any = False

        # --- сдвиг по нормали ---
        if offset is not None:
            off = float(offset)
            if not math.isfinite(off) or abs(off) > 100.0:
                raise EditError('offset должен быть конечным числом в метрах')
            a = (a[0] + n[0] * off, a[1] + n[1] * off)
            changed_any = changed_any or abs(off) > 1e-9
            res['offset'] = round(off, 4)

        # --- толщина ---
        if thickness is not None:
            th = float(thickness)
            if not math.isfinite(th) or not (WALL_MIN_THICK <= th <= WALL_MAX_THICK):
                raise EditError('толщина должна быть в пределах %.2f..%.2f м' % (
                    WALL_MIN_THICK, WALL_MAX_THICK))
            res['thickness'] = {'from': round(T, 4), 'to': round(th, 4)}
            T = th
            changed_any = changed_any or abs(th - float(w['thickness'])) > 1e-9
            w['thickness'] = round(th, 4)

        # --- высота/низ ---
        if height is not None:
            hgt = float(height)
            if not math.isfinite(hgt) or not (0.3 <= hgt <= 20.0):
                raise EditError('высота стены должна быть 0.3..20 м')
            res['height'] = {'from': float(w.get('height')), 'to': round(hgt, 4)}
            w['height'] = round(hgt, 4)
            changed_any = True
        if base is not None:
            bs = float(base)
            if not math.isfinite(bs):
                raise EditError('base должен быть конечным числом')
            res['base'] = {'from': float(w.get('base')), 'to': round(bs, 4)}
            w['base'] = round(bs, 4)
            changed_any = True

        # --- удлинения торцов (с пересчётом along проёмов) ---
        new_L = L
        ex_s = float(extend_start or 0.0)
        ex_e = float(extend_end or 0.0)
        if ex_s or ex_e:
            if not (math.isfinite(ex_s) and math.isfinite(ex_e)):
                raise EditError('extend_start/extend_end должны быть числами')
            shifted = 0
            if abs(ex_s) > 1e-12:
                a = (a[0] - d[0] * ex_s, a[1] - d[1] * ex_s)
                new_L += ex_s
                for o in (w.get('openings') or []):
                    o['along'] = round(float(o['along']) + ex_s, 4)
                    shifted += 1
                res['extend_start'] = round(ex_s, 4)
            if abs(ex_e) > 1e-12:
                new_L += ex_e
                res['extend_end'] = round(ex_e, 4)
            if new_L < WALL_MIN_LENGTH:
                raise EditError('после удлинения длина стены %r м < %.2f м' % (
                    round(new_L, 4), WALL_MIN_LENGTH))
            res['openings_shifted'] = shifted
            changed_any = True

        # --- явная длина ---
        if length is not None:
            new_L = float(length)
            if not math.isfinite(new_L) or new_L < WALL_MIN_LENGTH:
                raise EditError('длина стены должна быть >= %.2f м' % WALL_MIN_LENGTH)
            res['length'] = {'from': round(L, 4), 'to': round(new_L, 4)}
            changed_any = True

        w['a'] = [round(a[0], 4), round(a[1], 4)]
        w['dir'] = [round(d[0], 5), round(d[1], 5)]
        w['length'] = round(new_L, 4)
        _recompute_b(w)
        n_ops_before = len(w.get('openings') or [])
        _clip_openings(w, res['warnings'])
        if len(w.get('openings') or []) != n_ops_before:
            res['warnings'].append('проёмы вне новой длины стены удалены/обрезаны')

        res['after'] = {'a': list(w['a']), 'b': list(w['b']),
                        'length': w['length'], 'thickness': w['thickness']}
        res['openings'] = len(w.get('openings') or [])
        self._commit(before, res)

        # --- привязка к облаку после правки ---
        if snap:
            snap_res = self.snap_wall(int(index), max_shift=max_shift, rotate=rotate,
                                      max_rotation_deg=max_rotation_deg)
            res['snap'] = snap_res
            res['after'] = {'a': list(self.wall(index)['a']), 'b': list(self.wall(index)['b']),
                            'length': self.wall(index)['length'],
                            'thickness': self.wall(index)['thickness']}
        return res

    def move_wall(self, index, offset=None, **kwargs):
        """Псевдоним set_wall (CLI: --op move_wall)."""
        return self.set_wall(index, offset=offset, **kwargs)

    # ---------- 2) проёмы ----------
    def move_opening(self, wall_index, opening_index, along=None, width=None, sill=None, head=None):
        """Перенос/ширина/порог/перемычка проёма с проверками границ и наложений."""
        w, o = self.opening(wall_index, opening_index)
        before = self._snapshot()
        L = float(w['length'])
        H = float(w.get('height') or 3.0)
        res = {'op': 'move_opening', 'wall': int(wall_index), 'opening': int(opening_index),
               'before': {'along': round(float(o['along']), 3),
                          'width': round(float(o['width']), 3),
                          'sill': round(float(o.get('sill', 0.0)), 3),
                          'head': round(float(o.get('head', H)), 3)},
               'warnings': []}
        new = {k: float(o.get(k, d)) for k, d in
               (('along', 0.0), ('width', 0.9), ('sill', 0.0), ('head', H))}
        if width is not None:
            new['width'] = float(width)
        if along is not None:
            new['along'] = float(along)
        if sill is not None:
            new['sill'] = float(sill)
        if head is not None:
            new['head'] = float(head)
        if not math.isfinite(new['width']) or new['width'] < 0.10:
            raise EditError('ширина проёма должна быть >= 0.10 м')
        if new['width'] > L:
            raise EditError('ширина проёма %.3f м больше длины стены %.3f м' % (new['width'], L))
        if new['along'] < 0.0 or new['along'] + new['width'] > L + 1e-6:
            raise EditError('проём выходит за стену: along=%.3f, width=%.3f, L=%.3f' % (
                new['along'], new['width'], L))
        if not math.isfinite(new['sill']):
            raise EditError('sill должен быть числом')
        new['sill'] = max(0.0, min(new['sill'], H - 0.20))
        if not math.isfinite(new['head']):
            raise EditError('head должен быть числом')
        new['head'] = max(new['sill'] + 0.20, min(new['head'], H))
        cand = dict(o)
        cand.update({'along': round(new['along'], 3), 'width': round(new['width'], 3),
                     'sill': round(new['sill'], 3), 'head': round(new['head'], 3)})
        self._check_openings_overlap(w, skip_index=int(opening_index), extra=cand)
        o.clear()
        o.update(cand)
        _clip_openings(w, res['warnings'])
        res['after'] = {'along': round(float(o['along']), 3),
                        'width': round(float(o['width']), 3),
                        'sill': round(float(o.get('sill', 0.0)), 3),
                        'head': round(float(o.get('head', H)), 3)}
        res['opening_index'] = self._opening_index(wall_index, o)
        return self._commit(before, res)

    def add_opening(self, wall_index, along, width, sill=None, head=None, kind=None):
        """Вставка проёма в стену (along — от начала a, м). kind: door|window|opening."""
        w = self.wall(wall_index)
        before = self._snapshot()
        L = float(w['length'])
        H = float(w.get('height') or 3.0)
        res = {'op': 'add_opening', 'wall': int(wall_index), 'warnings': []}
        try:
            along = float(along)
            width = float(width)
        except (TypeError, ValueError):
            raise EditError('along/width должны быть числами')
        if not (math.isfinite(along) and math.isfinite(width)):
            raise EditError('along/width должны быть конечными числами')
        if width < 0.10:
            raise EditError('ширина проёма должна быть >= 0.10 м')
        if along < 0.0 or along + width > L + 1e-6:
            raise EditError('проём выходит за стену: along=%.3f, width=%.3f, L=%.3f' % (
                along, width, L))
        kind = (kind or 'door').strip().lower()
        if kind not in ('door', 'window', 'opening', 'passage'):
            raise EditError("kind проёма: 'door', 'window', 'opening' или 'passage'")
        if sill is None:
            sill = 0.0 if kind in ('door', 'opening') else 0.9
        if head is None:
            if kind == 'window':
                head = min(H, max(0.8, sill + 1.2))
            else:
                head = min(H - 0.05, 2.1)
        sill = float(sill)
        head = float(head)
        if not (math.isfinite(sill) and math.isfinite(head)):
            raise EditError('sill/head должны быть числами')
        sill = max(0.0, min(sill, H - 0.20))
        head = max(sill + 0.20, min(head, H))
        op = {'along': round(along, 3), 'width': round(width, 3),
              'sill': round(sill, 3), 'head': round(head, 3), 'kind': kind}
        self._check_openings_overlap(w, extra=op)
        w.setdefault('openings', []).append(op)
        _clip_openings(w, res['warnings'])
        res['opening'] = op
        res['opening_index'] = self._opening_index(wall_index, op)
        res['openings'] = len(self.wall(wall_index)['openings'])
        return self._commit(before, res)

    def remove_opening(self, wall_index, opening_index):
        """Удаление проёма из стены."""
        w, o = self.opening(wall_index, opening_index)
        before = self._snapshot()
        removed = dict(o)
        del w['openings'][int(opening_index)]
        res = {'op': 'remove_opening', 'wall': int(wall_index),
               'opening': int(opening_index), 'removed': removed,
               'openings': len(w.get('openings') or [])}
        return self._commit(before, res)

    # ---------- 3) привязка оси стены к облаку ----------
    def snap_wall(self, index, lateral=SNAP_LATERAL, max_shift=SNAP_MAX_SHIFT, min_points=None,
                  rotate=True, max_rotation_deg=SNAP_ROTATE_MAX_DEG):
        """2-модная привязка оси+толщины стены к облаку (как scan2bim-v2.py).

        Берём точки в полосе ±lateral м от оси (по длине стены, между полом и потолком),
        строим гистограмму поперечных расстояний sn, находим две самые сильные моды:
        расстояние между ними — толщина, середина — сдвиг оси. Принимаем правку только если:
          * обе моды достаточно сильные (защита от ложной пары в шуме);
          * |сдвиг| <= max_shift;
          * устойчивый RMS (по 70 % точек с наименьшей невязкой) не хуже.

        rotate=True — дополнительно пробуем оценить наклон стены к облаку по бинам
        (две грани должны быть видны на большей части длины); поворот применяется, только
        если он даёт заметно лучший RMS (SNAP_ROTATE_GAIN), не превышает max_rotation_deg
        и толщина при этом не «уезжает». Если наклон оценить нельзя (видна одна грань),
        остаётся привязка сдвиг+толщина (как раньше).
        """
        w = self.wall(index)
        res = {'op': 'snap_wall', 'wall': int(index), 'accepted': False, 'changed': False,
               'rotated': False, 'rotation_deg': 0.0,
               'rotation': {'applied': False, 'reason': 'не оценивалось'}}
        if w.get('inferred') or w.get('material') == 'inferred':
            res['reason'] = 'стена достроенная (inferred): облако её не подтверждает'
            return res
        a, d, n, L, T = wall_frame(w)
        res.update({'length': round(L, 3), 'thickness_before': round(T, 4),
                    'max_rotation_deg': round(float(max_rotation_deg), 3)})
        cloud = self._cloud()
        floorY, ceilY = self._storey_band()
        su, sn = cloud.band(w, lateral=float(lateral), y_lo=floorY + 0.20,
                            y_hi=ceilY - 0.20)
        npts = int(len(sn))
        need = int(min_points if min_points is not None
                   else max(SNAP_MIN_POINTS, 30.0 * L))
        res.update({'points': npts, 'points_need': need, 'cloud': cloud.path})
        if npts < max(30, need):
            res['reason'] = 'мало точек в полосе: %d < %d' % (npts, need)
            return res
        hist, cen, peaks = _two_mode_peaks(sn, lateral=float(lateral))
        picked = _pick_two_mode(hist, cen, peaks)
        if picked is None:
            res['reason'] = 'в полосе нет двух мод (стена/толщина не подтверждены облаком)'
            res['peaks'] = [{'sn': round(float(cen[k]), 3), 'count': int(hist[k])}
                            for k in peaks[:5]]
            return res
        th, mid, peak_info = picked
        # защита от ложной пары: обе моды должны быть представлены заметным числом точек.
        # Слабые моды не дают права менять сдвиг/толщину, но поворот по бинам всё ещё может
        # подтвердить позу (у наклонённой стены моды «размазаны» и слабее по построению).
        min_peak = int(max(SNAP_MIN_PEAK, SNAP_MIN_PEAK_FRAC * npts))
        support = min(peak_info[0]['count'], peak_info[1]['count'])
        weak_modes = support < min_peak
        res.update({'peaks': peak_info, 'peak_support': support,
                    'min_peak_support': min_peak, 'weak_modes': bool(weak_modes)})
        rms_b = _trimmed_rms(sn, 0.0, T)
        # проверяем ровно ту позу, которую применим (округление как в модели)
        shift = round(float(mid), 4)
        th_new = round(float(th), 3)
        rms_s = _trimmed_rms(sn, shift, th_new)
        res.update({'offset': shift, 'thickness_after': th_new,
                    'rms_before': round(rms_b, 6) if rms_b is not None else None,
                    'rms_shift_only': round(rms_s, 6) if rms_s is not None else None,
                    'rms_raw_before': round(_rms(_residuals(sn, 0.0, T)) or 0.0, 6),
                    'rms_raw_after': round(_rms(_residuals(sn, shift, th_new)) or 0.0, 6),
                    'rotated': False, 'rotation_deg': 0.0,
                    'rotation': {'applied': False, 'reason': 'не оценивалось'}})
        # --- выбор позы: shift-only и/или поворот ---
        shift_ok = (not weak_modes and rms_s is not None and rms_b is not None
                    and rms_s <= rms_b + 1e-6
                    and abs(shift) <= float(max_shift) + 1e-9)
        pose = {'type': 'shift', 'shift': shift, 'th': th_new, 'rms': rms_s} if shift_ok else None
        pose_shift = pose
        # с чем сравниваем RMS поворота: со сдвигом, если он допустим, иначе с исходным
        rms_ref = rms_s if shift_ok else rms_b
        if rotate:
            fit = _fit_rotation(su, sn, L, th_new, lateral=float(lateral))
            rot_info = {'applied': False, 'reason': 'наклон не оценён (видна одна грань '
                                                    'или мало бинов с двумя гранями)'}
            if fit is not None:
                theta_deg = math.degrees(fit['theta'])
                th_rot = round(float(fit['th']), 3)
                shift_center = fit['mid_center']
                rms_r = _rotated_trimmed_rms(su, sn, fit['b'], fit['c0'], th_rot)
                rot_info = {'applied': False, 'deg': round(theta_deg, 3),
                            'bins': '%d/%d' % (fit['bins'], fit['bins_total']),
                            'spread': round(fit['spread'], 4),
                            'thickness': th_rot,
                            'shift_center': round(shift_center, 4),
                            'rms_shift_only': round(rms_s, 6) if rms_s is not None else None,
                            'rms_rotated': round(rms_r, 6) if rms_r is not None else None}
                rot_problem = None
                if abs(theta_deg) < SNAP_ROTATE_MIN_DEG:
                    rot_problem = 'наклон меньше %.1f° — поворот не нужен' % SNAP_ROTATE_MIN_DEG
                elif abs(theta_deg) > float(max_rotation_deg) + 1e-9:
                    rot_problem = 'наклон %.2f° больше предела %.2f°' % (
                        theta_deg, float(max_rotation_deg))
                elif not (SNAP_MIN_THICK <= th_rot <= SNAP_MAX_THICK):
                    rot_problem = 'толщина после поворота %.3f вне диапазона' % th_rot
                elif abs(th_rot - th_new) > 0.06:
                    rot_problem = 'толщина при повороте меняется слишком сильно: %.3f -> %.3f' % (
                        th_new, th_rot)
                elif abs(shift_center) > float(max_shift) + 1e-9:
                    rot_problem = 'сдвиг центра %.3f м больше предела' % shift_center
                elif rms_r is None or rms_ref is None or rms_r > rms_ref * (1.0 - SNAP_ROTATE_GAIN):
                    rot_problem = 'RMS с поворотом недостаточно лучше: %.4f -> %.4f' % (
                        rms_ref or 0.0, rms_r or 0.0)
                elif rms_b is not None and rms_r >= rms_b - 1e-6:
                    rot_problem = 'RMS с поворотом не лучше исходного: %.4f -> %.4f' % (
                        rms_b, rms_r)
                if rot_problem:
                    rot_info['reason'] = rot_problem
                else:
                    pose = {'type': 'rotate', 'b': fit['b'], 'c0': fit['c0'],
                            'theta': math.radians(round(theta_deg, 3)),
                            'shift_center': shift_center, 'th': th_rot, 'rms': rms_r}
                    rot_info['applied'] = True
                    rot_info['reason'] = 'поворот принят: RMS лучше shift-only на >= %d %%' % (
                        int(SNAP_ROTATE_GAIN * 100))
            res['rotation'] = rot_info

        if pose is None:
            if weak_modes:
                res['reason'] = (
                    'моды слабые (поддержка %d < %d точек) — вероятно ложная пара '
                    'в шуме/мебели; поворот тоже не подтвердил позу' % (support, min_peak))
            elif abs(shift) > float(max_shift) + 1e-9:
                res['reason'] = 'сдвиг %.3f м больше предела %.2f м' % (
                    shift, float(max_shift))
            elif rms_s is None or rms_b is None or rms_s > rms_b + 1e-6:
                res['reason'] = 'RMS не улучшается: %.4f -> %.4f' % (
                    rms_b or 0.0, rms_s or 0.0)
            else:
                res['reason'] = 'поза не принята (см. rotation/reason)'
            return res

        # --- защита покрытия вдоль стены: поза не должна «съедать» облако вдоль оси ---
        openings = [(float(o.get('along', 0.0)),
                     float(o.get('along', 0.0)) + float(o.get('width', 0.0)))
                    for o in (w.get('openings') or [])]
        half_cmp = max(0.10, max(T, float(pose['th'])) / 2.0 + 0.10)
        cov_before = _coverage_along(su, sn, L, half_cmp, openings)

        def _pose_coverage(p):
            if p['type'] == 'rotate':
                b_cov = math.tan(p['theta'])
                sn_cov = (sn - (p['c0'] + b_cov * su)) / math.sqrt(1.0 + b_cov * b_cov)
            else:
                sn_cov = sn - float(p['shift'])
            return _coverage_along(su, sn_cov, L, half_cmp, openings)

        cov_after = _pose_coverage(pose)
        if (cov_before is not None and cov_after is not None
                and cov_after < cov_before - 0.02):
            # поворот может улучшать RMS, но «съедать» покрытие — тогда откатываемся к
            # привязке сдвигом (если она допустима), иначе отклоняем позу целиком
            if pose['type'] == 'rotate' and pose_shift is not None:
                cov_shift = _pose_coverage(pose_shift)
                if cov_shift is not None and cov_shift >= cov_before - 0.02:
                    res['rotation'] = dict(res.get('rotation') or {})
                    res['rotation']['applied'] = False
                    res['rotation']['reason'] = (
                        'поворот отклонён: покрытие %.0f -> %.0f %%' % (
                            100 * cov_before, 100 * cov_after))
                    pose = pose_shift
                    cov_after = cov_shift
                else:
                    pose = None
            else:
                pose = None
            if pose is None:
                res['coverage_before'] = round(cov_before, 4)
                res['coverage_after'] = round(cov_after, 4) if cov_after is not None else None
                res['reason'] = ('покрытие облаком вдоль стены падает: %.0f -> %.0f %% — '
                                 'сдвиг не подтверждён' % (
                                     100 * cov_before, 100 * (cov_after or 0.0)))
                return res
        res['coverage_before'] = round(cov_before, 4) if cov_before is not None else None
        res['coverage_after'] = round(cov_after, 4) if cov_after is not None else None

        # --- применяем позу ---
        before = self._snapshot()
        if pose['type'] == 'rotate':
            theta = pose['theta']
            bb = math.tan(theta)
            d_new = _norm2(d[0] + bb * n[0], d[1] + bb * n[1])
            p_c = (a[0] + d[0] * L / 2.0 + n[0] * (pose['c0'] + bb * L / 2.0),
                   a[1] + d[1] * L / 2.0 + n[1] * (pose['c0'] + bb * L / 2.0))
            a_new = (p_c[0] - d_new[0] * L / 2.0, p_c[1] - d_new[1] * L / 2.0)
            w['dir'] = [round(d_new[0], 5), round(d_new[1], 5)]
            res['rotated'] = True
            res['rotation_deg'] = round(math.degrees(theta), 3)
            res['offset'] = round(pose['shift_center'], 4)
            res['thickness_after'] = pose['th']
        else:
            a_new = (a[0] + n[0] * pose['shift'], a[1] + n[1] * pose['shift'])
            w['dir'] = [round(d[0], 5), round(d[1], 5)]
            res['thickness_after'] = pose['th']
        w['a'] = [round(a_new[0], 4), round(a_new[1], 4)]
        w['thickness'] = pose['th']
        _recompute_b(w)
        # RMS фактически записанной позы считаем на ТОЙ ЖЕ полосе точек, что и до правки
        # (иначе сдвиг меняет состав полосы ±lateral и сравнение «до/после» некорректно)
        if pose['type'] == 'rotate':
            b_app = math.tan(pose['theta'])
            rms_applied = _rotated_trimmed_rms(su, sn, b_app, pose['c0'], w['thickness'])
            raw_applied = _rms(_rotated_residuals(su, sn, b_app, pose['c0'], w['thickness']))
        else:
            applied_shift = round(pose['shift'], 4)
            rms_applied = _trimmed_rms(sn, applied_shift, w['thickness'])
            raw_applied = _rms(_residuals(sn, applied_shift, w['thickness']))
        res['rms_applied'] = round(rms_applied, 6) if rms_applied is not None else None
        res['rms_after'] = res['rms_applied']
        res['rms_raw_after'] = round(raw_applied or 0.0, 6)
        res['accepted'] = True
        res['reason'] = ('принято: две моды облака, RMS не хуже, сдвиг в пределе'
                         + ('; поворот %+.2f°' % res['rotation_deg'] if res['rotated'] else ''))
        res['after'] = {'a': list(w['a']), 'b': list(w['b']), 'dir': list(w['dir']),
                        'length': w['length'], 'thickness': w['thickness']}
        return self._commit(before, res)

    def snap_all(self, lateral=SNAP_LATERAL, max_shift=SNAP_MAX_SHIFT,
                 rotate=True, max_rotation_deg=SNAP_ROTATE_MAX_DEG):
        """Привязать к облаку ВСЕ измеренные (не inferred) стены модели.

        Каждая стена — отдельный шаг undo (как при последовательных snap_wall), поэтому
        правки можно отменять по одной. Возвращает сводку: accepted/rejected по стенам.
        """
        base = self._snapshot()
        res = {'op': 'snap_all', 'accepted': [], 'rejected': [], 'unchanged': [],
               'rotated': []}
        for i, w in enumerate(list(self.model['walls'])):
            if w.get('inferred') or w.get('material') == 'inferred':
                continue
            r = self.snap_wall(i, lateral=lateral, max_shift=max_shift, rotate=rotate,
                               max_rotation_deg=max_rotation_deg)
            rec = {'wall': i, 'accepted': bool(r.get('accepted')), 'changed': bool(r.get('changed')),
                   'reason': r.get('reason'),
                   'thickness_before': r.get('thickness_before'),
                   'thickness_after': r.get('thickness_after'),
                   'offset': r.get('offset'),
                   'rotation_deg': r.get('rotation_deg') or 0.0}
            if rec['accepted'] and rec['changed']:
                res['accepted'].append(rec)
                if r.get('rotated'):
                    res['rotated'].append({'wall': i, 'deg': r.get('rotation_deg')})
            elif rec['accepted']:
                res['unchanged'].append(rec)
            else:
                res['rejected'].append(rec)
        res['changed'] = (self.model != base)
        res['measured'] = len(res['accepted']) + len(res['unchanged']) + len(res['rejected'])
        res['accepted_count'] = len(res['accepted'])
        res['unchanged_count'] = len(res['unchanged'])
        res['rejected_count'] = len(res['rejected'])
        return res

    # ---------- 4) привязка проёма к разрыву в облаке ----------
    def snap_opening(self, wall_index, opening_index, lateral=None, max_edge_shift=0.50):
        """Кромки проёма по пустотам облака: ищем разрыв в профиле вдоль стены (±0.1 м)
        и ставим along/width по нему. Принимаем, если разрыв шириной 0.6..2.5 м,
        а кромки смещаются не более max_edge_shift.

        Так же, как ruler-v2.py: полоса |sn| <= max(0.10, T/2+0.10), y в [пол+0.25, потолок-0.25],
        заполненность бина occ >= max(2, медиана*0.20).
        """
        w, o = self.opening(wall_index, opening_index)
        res = {'op': 'snap_opening', 'wall': int(wall_index),
               'opening': int(opening_index), 'accepted': False, 'changed': False,
               'along_before': round(float(o['along']), 3),
               'width_before': round(float(o['width']), 3)}
        if w.get('inferred') or w.get('material') == 'inferred':
            res['reason'] = 'стена достроенная (inferred): облако её не подтверждает'
            return res
        a, d, n, L, T = wall_frame(w)
        half = float(lateral) if lateral else max(0.10, T / 2.0 + 0.10)
        cloud = self._cloud()
        floorY, ceilY = self._storey_band()
        su, sn = cloud.band(w, lateral=half, y_lo=floorY + 0.25, y_hi=ceilY - 0.25,
                            along_margin=0.6)
        m = (su >= 0.0) & (su <= L)
        su = su[m]
        npts = int(len(su))
        res.update({'points': npts, 'cloud': cloud.path, 'band_half': round(half, 3)})
        if npts < max(30, int(20.0 * L)):
            res['reason'] = 'мало точек в полосе: %d' % npts
            return res

        def _gaps(binw):
            nb = max(8, int(math.ceil(L / binw)))
            occ, edges = np.histogram(su, bins=nb, range=(0.0, L))
            pos = occ[occ > 0]
            med = float(np.median(pos)) if len(pos) else 1.0
            filled = occ >= max(2.0, med * 0.20)
            out = []
            b0 = None
            for bi, f in enumerate(filled):
                if not f and b0 is None:
                    b0 = bi
                elif f and b0 is not None:
                    out.append((b0 * L / nb, (bi - b0) * L / nb))
                    b0 = None
            if b0 is not None:
                out.append((b0 * L / nb, (nb - b0) * L / nb))
            return [(round(s0, 3), round(wd, 3)) for (s0, wd) in out
                    if OPENING_MIN_WIDTH <= wd <= OPENING_MAX_WIDTH
                    and s0 >= 0.25 and s0 + wd <= L - 0.25]

        gaps = _gaps(0.05)
        if not gaps:
            gaps = _gaps(0.10)
        res['gaps'] = [{'start': s0, 'width': wd} for (s0, wd) in gaps]
        if not gaps:
            res['reason'] = 'в профиле облака нет разрыва 0.6..2.5 м (проём не подтверждён)'
            return res

        o0 = float(o['along'])
        o1 = o0 + float(o['width'])
        best = None
        # 1) разрыв перекрывает проём не меньше чем на половину — берём максимальное перекрытие
        for (g0, gw) in gaps:
            g1 = g0 + gw
            ov = max(0.0, min(o1, g1) - max(o0, g0))
            ratio = ov / max(1e-9, min(float(o['width']), gw))
            if ratio >= 0.5 and (best is None or ov > best[0]):
                best = (ov, g0, gw, ratio)
        # 2) иначе — ближайший разрыв в пределах допуска по обеим кромкам (перенос проёма)
        if best is None:
            lim = float(max_edge_shift) + 1e-9
            cand = [(g0, gw) for (g0, gw) in gaps
                    if abs(g0 - o0) <= lim and abs(gw - float(o['width'])) <= lim]
            if cand:
                g0, gw = min(cand, key=lambda g: abs(g[0] - o0) + abs(g[1] - float(o['width'])))
                best = (0.0, g0, gw, 0.0)
        if best is None:
            res['reason'] = 'разрыв облака не сопоставлен с проёмом (кромки дальше допуска)'
            return res
        _ov, g0, gw, ratio = best
        res.update({'gap': {'start': round(g0, 3), 'width': round(gw, 3)},
                    'along_after': round(g0, 3), 'width_after': round(gw, 3),
                    'moved': round(g0 - o0, 3), 'width_delta': round(gw - float(o['width']), 3)})
        if abs(g0 - o0) > float(max_edge_shift) + 1e-9:
            res['reason'] = 'кромка разрыва дальше %.2f м от проёма' % float(max_edge_shift)
            return res
        if abs(gw - float(o['width'])) > float(max_edge_shift) + 1e-9:
            res['reason'] = 'ширина разрыва отличается больше чем на %.2f м' % float(max_edge_shift)
            return res
        before = self._snapshot()
        o['along'] = round(float(g0), 3)
        o['width'] = round(float(gw), 3)
        res['accepted'] = True
        res['reason'] = 'принято: разрыв профиля облака совпал с проёмом'
        res['after'] = {'along': o['along'], 'width': o['width'],
                        'sill': round(float(o.get('sill', 0.0)), 3),
                        'head': round(float(o.get('head', 0.0)), 3)}
        return self._commit(before, res)

    # ---------- 5) сохранение / история / IFC ----------
    def save_history(self, path=None):
        path = path or self.history_path
        if not path:
            return None
        payload = {'version': 1, 'tool': 'edit-model.py', 'undoDepth': self.undo_depth,
                   'undo': self._undo, 'redo': self._redo}
        _atomic_json_dump(payload, path, indent=None)
        self.history_path = os.path.abspath(path)
        return self.history_path

    def load_history(self, path):
        with open(path, 'r', encoding='utf-8') as f:
            payload = json.load(f)
        if not isinstance(payload, dict):
            raise ValueError('история — не объект')
        self._undo = list(payload.get('undo') or [])
        self._redo = list(payload.get('redo') or [])
        for snap in self._undo + self._redo:
            if not isinstance(snap, dict) or not snap.get('walls'):
                raise ValueError('снимок в истории не похож на модель')
        while len(self._undo) > self.undo_depth:
            self._undo.pop(0)
        while len(self._redo) > self.undo_depth:
            self._redo.pop(0)
        self.history_path = os.path.abspath(path)
        return self

    def save(self, path, history_path=None, write_history=True):
        """Пишет модель (атомарно, stats пересчитаны) и sidecar истории.

        По умолчанию история пишется рядом с ВЫХОДНОЙ моделью (<out>.history.json) —
        так следующая команда `--model <out> --op undo` находит стек правок.
        """
        out = save_model(self.model, path)
        self.model_path = out
        res = {'saved': out, 'bytes': os.path.getsize(out), 'historyPath': None}
        if write_history:
            hp = history_path if history_path is not None else (out + '.history.json')
            res['historyPath'] = self.save_history(hp)
        return res

    def export_ifc(self, path, node_bin=None, name=None):
        """JSON-модель → IFC4 через renderer/scan2bim.js (node tools/scan2bim-py/json-to-ifc.js)."""
        if not os.path.isfile(JSON_TO_IFC):
            raise EditError('не найден IFC-writer: %s' % JSON_TO_IFC)
        node = find_node(node_bin)
        out = os.path.abspath(path)
        d = os.path.dirname(out) or '.'
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.edit-model-', suffix='.json', dir=d)
        os.close(fd)
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.model, f, ensure_ascii=False)
            cmd = [node, JSON_TO_IFC, tmp, out]
            if name:
                cmd.append('--name=' + str(name))
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  encoding='utf-8', errors='replace')
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if proc.returncode != 0:
            raise EditError('json-to-ifc.js завершился с кодом %d: %s' % (
                proc.returncode, (proc.stderr or proc.stdout or '').strip()[-800:]))
        if not os.path.isfile(out):
            raise EditError('IFC не создан: %s' % out)
        summary = None
        tail = (proc.stdout or '').strip().splitlines()
        if tail:
            try:
                summary = json.loads(tail[-1])
            except ValueError:
                summary = None
        res = {'path': out, 'bytes': os.path.getsize(out), 'node': node,
               'writer': JSON_TO_IFC, 'summary': summary}
        return res

    def validate_ifc(self, ifc_path, python_bin=None):
        return validate_ifc(ifc_path, python_bin=python_bin)

    def info(self):
        walls = self.model['walls']
        storey = self.model.get('storey') or {}
        rooms = self.model.get('rooms') or []
        return {'model': self.model_path,
                'walls': len(walls),
                'measuredWalls': sum(1 for w in walls if not (w.get('inferred') or w.get('material') == 'inferred')),
                'inferredWalls': sum(1 for w in walls if (w.get('inferred') or w.get('material') == 'inferred')),
                'openings': int(sum(len(w.get('openings') or []) for w in walls)),
                'rooms': len(rooms),
                'floorArea': round(float(sum(float(r.get('area') or 0.0) for r in rooms)), 1),
                'storey': {'floorY': storey.get('floorY'), 'ceilY': storey.get('ceilY'),
                           'height': storey.get('height')},
                'cloud': self.cloud.path if isinstance(self.cloud, Cloud) else (
                    os.path.abspath(self.cloud) if isinstance(self.cloud, str) else None),
                'history': self.state()}


# ======================================================================================
# 5. Поиск node / python с ifcopenshell и валидация IFC
# ======================================================================================
def find_node(node_bin=None):
    cand = [node_bin, os.environ.get('EDIT_MODEL_NODE'), shutil.which('node'),
            shutil.which('node.exe')]
    for c in cand:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    raise EditError('не найден node (нужен для json-to-ifc.js); задайте --node или EDIT_MODEL_NODE')


_PY_WITH_IFC = None
_PY_CHECK_CACHE = {}


def _python_has_ifcopenshell(exe):
    key = os.path.normcase(os.path.abspath(exe))
    if key not in _PY_CHECK_CACHE:
        try:
            proc = subprocess.run([exe, '-c', 'import ifcopenshell'],
                                  capture_output=True, timeout=120)
            _PY_CHECK_CACHE[key] = (proc.returncode == 0)
        except (OSError, subprocess.SubprocessError):
            _PY_CHECK_CACHE[key] = False
    return _PY_CHECK_CACHE[key]


def _candidate_pythons():
    cands = []
    env = os.environ.get('EDIT_MODEL_PYTHON')
    if env:
        cands.append(env)
    if sys.executable:
        cands.append(sys.executable)
    # окружение DSH: ~/.dsh/dsh-runtimes/*/dependencies/python/python.exe
    base = os.path.expanduser(os.path.join('~', '.dsh', 'dsh-runtimes'))
    if os.path.isdir(base):
        cands.extend(sorted(glob.glob(os.path.join(base, '*', 'dependencies', 'python', 'python.exe'))))
    for name in ('python', 'python3'):
        p = shutil.which(name)
        if p:
            cands.append(p)
    seen, out = set(), []
    for c in cands:
        try:
            key = os.path.normcase(os.path.abspath(c))
        except (OSError, TypeError):
            continue
        if key in seen or not os.path.isfile(c):
            continue
        seen.add(key)
        out.append(c)
    return out


def find_python_with_ifcopenshell():
    """Python-интерпретатор с ifcopenshell (для validate-ifc.py)."""
    global _PY_WITH_IFC
    if _PY_WITH_IFC:
        return _PY_WITH_IFC
    for exe in _candidate_pythons():
        if _python_has_ifcopenshell(exe):
            _PY_WITH_IFC = exe
            return exe
    raise EditError('не найден Python с ifcopenshell (validate-ifc.py); '
                    'задайте EDIT_MODEL_PYTHON или pip install ifcopenshell')


def validate_ifc(ifc_path, python_bin=None):
    """Валидация IFC4 через tools/scan2bim-py/validate-ifc.py. Ошибки — EditError.

    Возвращает {ok, errors, warnings, info, arityMismatches, inventory, schema, instances,
    returncode, output, path}.
    """
    if not os.path.isfile(VALIDATE_IFC):
        raise EditError('не найден валидатор: %s' % VALIDATE_IFC)
    if not os.path.isfile(ifc_path):
        raise EditError('IFC-файл не найден: %s' % ifc_path)
    py = python_bin or find_python_with_ifcopenshell()
    fd, tmp = tempfile.mkstemp(prefix='.edit-model-validate-', suffix='.json')
    os.close(fd)
    try:
        proc = subprocess.run([py, VALIDATE_IFC, os.path.abspath(ifc_path), '--json', tmp],
                              capture_output=True, text=True, encoding='utf-8', errors='replace')
        report = None
        try:
            if os.path.getsize(tmp) > 0:
                with open(tmp, 'r', encoding='utf-8') as f:
                    report = json.load(f)
        except (OSError, ValueError):
            report = None
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    out = ((proc.stdout or '') + (proc.stderr or '')).strip()
    if report is None:
        return {'ok': False, 'path': os.path.abspath(ifc_path), 'returncode': proc.returncode,
                'errors': None, 'warnings': None, 'info': None,
                'arityMismatches': [], 'inventory': {}, 'schema': None, 'instances': None,
                'output': out, 'python': py,
                'error': 'validate-ifc.py не выдал JSON-отчёт (код %d)' % proc.returncode}
    counts = report.get('validator') or {}
    errors = int(counts.get('ERROR', 0) or 0)
    warnings = int(counts.get('WARNING', 0) or 0)
    info = int(counts.get('INFO', 0) or 0)
    arity = report.get('arityMismatches') or []
    ok = bool(proc.returncode == 0 and errors == 0 and not arity)
    return {'ok': ok, 'path': os.path.abspath(ifc_path), 'returncode': proc.returncode,
            'errors': errors, 'warnings': warnings, 'info': info,
            'arityMismatches': arity, 'inventory': report.get('inventory') or {},
            'schema': report.get('schema'), 'instances': report.get('instances'),
            'georef': report.get('georef'), 'output': out, 'python': py}


# ======================================================================================
# 6. Модульные функции-обёртки (импортируемый API)
# ======================================================================================
def _editor_for(model, cloud=None, undo_depth=DEFAULT_UNDO_DEPTH):
    if isinstance(model, Editor):
        return model
    if isinstance(model, str):
        return Editor.load(model, cloud=cloud, undo_depth=undo_depth)
    ed = Editor(model, cloud=cloud, undo_depth=undo_depth)
    if isinstance(cloud, str):
        ed.cloud = load_cloud(cloud)
    return ed


def set_wall(model, index, cloud=None, undo_depth=DEFAULT_UNDO_DEPTH, **kwargs):
    """Модульная обёртка: правит стену в переданной модели (in-place)."""
    return _editor_for(model, cloud, undo_depth).set_wall(index, **kwargs)


def move_wall(model, index, cloud=None, undo_depth=DEFAULT_UNDO_DEPTH, **kwargs):
    return _editor_for(model, cloud, undo_depth).move_wall(index, **kwargs)


def move_opening(model, wall_index, opening_index, **kwargs):
    return _editor_for(model).move_opening(wall_index, opening_index, **kwargs)


def add_opening(model, wall_index, along, width, cloud=None, undo_depth=DEFAULT_UNDO_DEPTH,
                **kwargs):
    return _editor_for(model, cloud, undo_depth).add_opening(wall_index, along, width, **kwargs)


def remove_opening(model, wall_index, opening_index):
    return _editor_for(model).remove_opening(wall_index, opening_index)


def snap_wall(model, index, cloud, undo_depth=DEFAULT_UNDO_DEPTH, **kwargs):
    return _editor_for(model, cloud, undo_depth).snap_wall(index, **kwargs)


def snap_all(model, cloud, undo_depth=DEFAULT_UNDO_DEPTH, **kwargs):
    return _editor_for(model, cloud, undo_depth).snap_all(**kwargs)


def snap_opening(model, wall_index, opening_index, cloud, undo_depth=DEFAULT_UNDO_DEPTH, **kwargs):
    return _editor_for(model, cloud, undo_depth).snap_opening(wall_index, opening_index, **kwargs)


def export_ifc(model, path, node_bin=None, name=None):
    """Модель (dict или путь) → IFC."""
    ed = _editor_for(model)
    return ed.export_ifc(path, node_bin=node_bin, name=name)


# ======================================================================================
# 7. CLI
# ======================================================================================
OPS = ['set_wall', 'move_wall', 'move_opening', 'add_opening', 'remove_opening',
       'snap_wall', 'snap_opening', 'snap_all', 'undo', 'redo', 'info']


def _build_argparser():
    epilog = """Примеры:
  # сдвинуть стену 3 на 8 см по нормали и сразу привязать её к облаку
  # (облако не передано — найдётся рядом с моделью: koridor-local-rgb.bin)
  python edit-model.py --model py2-p1.json --op move_wall --index 3 --offset 0.08 \\
      --snap --out py2-edit.json --json

  # то же с явным облаком и перегенерацией IFC
  python edit-model.py --model py2-p1.json --cloud koridor-local-rgb.bin \\
      --op move_wall --index 3 --offset 0.08 --snap --out py2-edit.json \\
      --ifc py2-edit.ifc --validate --json

  # привязать к облаку ВСЕ измеренные стены (inferred пропускаются; каждая стена — шаг undo)
  python edit-model.py --model M.json --op snap_all --out M-snap.json --json

  # исправить толщину стены 11 и проверить IFC
  python edit-model.py --model py2-p1.json --op set_wall --index 11 --thickness 0.17 \\
      --out py2-edit.json --ifc py2-edit.ifc --validate --json

  # вставка дверного проёма / удаление проёма
  python edit-model.py --model M.json --op add_opening --wall 0 --along 2.5 --width 0.9 --kind door --out M2.json
  python edit-model.py --model M.json --op remove_opening --wall 0 --opening 1 --out M2.json

  # отменить последнюю правку (история — в sidecar <модель>.history.json)
  python edit-model.py --model py2-edit.json --op undo --out py2-undo.json

  # сводка модели / история
  python edit-model.py --model py2-p1.json --op info --json
"""
    ap = argparse.ArgumentParser(
        prog='edit-model.py',
        description='Ядро ручного редактора BIM-модели Scan2BIM (Фаза 4): операции над '
                    'стенами/проёмами, привязка к облаку, undo/redo, экспорт и валидация IFC.',
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', required=True, help='входная JSON-модель (scan2bim-v2)')
    ap.add_argument('--out', help='куда сохранить изменённую модель JSON (атомарно)')
    ap.add_argument('--cloud', help='облако точек .bin (float32 x,y,z,r,g,b, Y вверх) '
                                    'для --snap / snap_wall / snap_opening; если не задано, '
                                    'ищется рядом с моделью: <модель>.bin, koridor-local-rgb.bin, '
                                    'koridor-local.bin, cloud.bin или единственный *.bin в папке')
    ap.add_argument('--op', choices=OPS, help='операция редактора')
    ap.add_argument('--index', type=int, help='индекс стены для set_wall/move_wall/snap_wall')
    ap.add_argument('--wall', type=int, help='индекс стены (алиас --index; для операций с проёмами)')
    ap.add_argument('--opening', type=int, help='индекс проёма в стене')
    ap.add_argument('--offset', type=float, help='сдвиг оси стены по нормали, м (set_wall/move_wall)')
    ap.add_argument('--thickness', type=float, help='толщина стены, м')
    ap.add_argument('--length', type=float, help='длина стены, м')
    ap.add_argument('--extend-start', type=float, dest='extend_start',
                    help='удлинить стену в начало, м (проёмы сдвигаются)')
    ap.add_argument('--extend-end', type=float, dest='extend_end',
                    help='удлинить стену в торец, м')
    ap.add_argument('--height', type=float, help='высота стены, м')
    ap.add_argument('--base', type=float, help='низ стены, м')
    ap.add_argument('--along', type=float, help='положение проёма от начала стены, м')
    ap.add_argument('--width', type=float, help='ширина проёма, м')
    ap.add_argument('--sill', type=float, help='подоконник проёма, м')
    ap.add_argument('--head', type=float, help='перемычка проёма, м')
    ap.add_argument('--kind', choices=['door', 'window', 'opening', 'passage'],
                    help='тип проёма (door/window/opening/passage — как в схеме scan2bim)')
    ap.add_argument('--snap', action='store_true',
                    help='после set_wall/move_wall привязать стену к облаку (нужен --cloud)')
    ap.add_argument('--no-rotate', action='store_true', dest='no_rotate',
                    help='при привязке к облаку не поворачивать стену (только сдвиг+толщина)')
    ap.add_argument('--max-rotation', type=float, default=SNAP_ROTATE_MAX_DEG,
                    dest='max_rotation',
                    help='предел поворота стены при привязке, градусы (по умолчанию %.1f)'
                         % SNAP_ROTATE_MAX_DEG)
    ap.add_argument('--ifc', help='экспортировать IFC4 в этот файл (json-to-ifc.js)')
    ap.add_argument('--validate', action='store_true',
                    help='после экспорта проверить IFC (0 ERROR, арность IFC4)')
    ap.add_argument('--history', help='путь к sidecar истории (по умолчанию <модель>.history.json)')
    ap.add_argument('--no-history', action='store_true', help='не читать/не писать историю')
    ap.add_argument('--undo-depth', type=int, default=DEFAULT_UNDO_DEPTH, dest='undo_depth',
                    help='глубина undo/redo (по умолчанию %d, не меньше %d)' % (
                        DEFAULT_UNDO_DEPTH, MIN_UNDO_DEPTH))
    ap.add_argument('--stride', type=int, default=2,
                    help='прореживание облака при чтении (1 — все точки, по умолчанию 2)')
    ap.add_argument('--node', help='путь к node.exe для json-to-ifc.js')
    ap.add_argument('--python', dest='python_bin', help='Python с ifcopenshell для validate-ifc.py')
    ap.add_argument('--name', help='имя модели в IFC (json-to-ifc --name=)')
    ap.add_argument('--json', action='store_true', help='машинный вывод: один JSON в stdout')
    ap.add_argument('--quiet', action='store_true', help='не печатать человекочитаемый отчёт')
    return ap


def _result_payload(editor, res, saved=None, ifc=None, validate=None):
    payload = {'ok': True, 'op': res.get('op') if res else None, 'result': res,
               'model': editor.info(), 'saved': saved, 'ifc': ifc, 'validate': validate,
               'history': editor.state(), 'warnings': list(editor.warnings)}
    if res and res.get('snap') and not res['snap'].get('accepted'):
        payload['ok'] = True
        payload['snapRejected'] = res['snap'].get('reason')
    return payload


def _print_human(payload):
    r = payload.get('result') or {}
    m = payload.get('model') or {}
    print('модель:      %s' % (m.get('model') or '—'))
    cloud = payload.get('cloud') or {}
    if cloud.get('source') == 'auto':
        print('облако:      %s (найдено автоматически рядом с моделью)' % cloud.get('path'))
    print('содержимое:  стен %d (измерено %d, достроено %d), проёмов %d, помещений %d, '
          'площадь %.1f м²' % (m.get('walls', 0), m.get('measuredWalls', 0),
                               m.get('inferredWalls', 0), m.get('openings', 0),
                               m.get('rooms', 0), m.get('floorArea') or 0.0))
    print('история:     undo %d, redo %d (глубина %d)' % (
        payload['history']['undo'], payload['history']['redo'], payload['history']['undoDepth']))
    op = r.get('op')
    if op == 'set_wall':
        print('операция:    set_wall #%d %s' % (
            r.get('wall'),
            'изменена' if r.get('changed') else 'без изменений'))
        if 'offset' in r:
            print('  сдвиг по нормали: %+.4f м' % r['offset'])
        if 'thickness' in r:
            print('  толщина:          %.4f -> %.4f м' % (
                r['thickness']['from'], r['thickness']['to']))
        if 'length' in r:
            print('  длина:            %.4f -> %.4f м' % (r['length']['from'], r['length']['to']))
        if 'extend_start' in r or 'extend_end' in r:
            print('  удлинение:        начало %+.3f, торец %+.3f м (проёмов сдвинуто: %d)' % (
                r.get('extend_start', 0.0), r.get('extend_end', 0.0),
                r.get('openings_shifted', 0)))
        print('  a: %s -> %s' % (r['before']['a'], r['after']['a']))
        print('  b: %s -> %s' % (r['before']['b'], r['after']['b']))
        snap = r.get('snap')
        if snap:
            print('  привязка к облаку: %s, сдвиг %+.3f м, T %.3f -> %.3f м%s' % (
                'принята' if snap.get('accepted') else 'отклонена',
                snap.get('offset') or 0.0, snap.get('thickness_before') or 0.0,
                snap.get('thickness_after') or 0.0,
                '' if snap.get('accepted') else ' (' + str(snap.get('reason')) + ')'))
            if snap.get('rotated'):
                print('  поворот стены:    %+.2f° (оценён по бинам облака)' % snap['rotation_deg'])
        for wmsg in r.get('warnings') or []:
            print('  ! ' + wmsg)
    elif op == 'snap_wall':
        print('операция:    snap_wall #%d: %s' % (
            r.get('wall'), 'ПРИНЯТО' if r.get('accepted') else 'ОТКЛОНЕНО'))
        print('  точки в полосе:   %s (нужно >= %s)' % (r.get('points'), r.get('points_need')))
        if r.get('peaks'):
            print('  моды облака sn:   %s' % ', '.join(
                '%+.3f (%d т.)' % (p['sn'], p['count']) for p in r['peaks']))
        if 'peak_support' in r:
            print('  поддержка мод:    %s (минимум %s)' % (
                r.get('peak_support'), r.get('min_peak_support')))
        if 'offset' in r:
            print('  толщина:          %.3f -> %.3f м' % (
                r.get('thickness_before'), r.get('thickness_after')))
            print('  сдвиг оси:        %+.4f м' % r['offset'])
            print('  RMS (70%% лучших): %.4f -> %.4f м (shift-only %.4f)' % (
                r.get('rms_before') or 0.0, r.get('rms_after') or 0.0,
                r.get('rms_shift_only') or 0.0))
        rot = r.get('rotation') or {}
        if rot.get('deg') is not None:
            print('  поворот:          %+.2f° (%s бинов), применить: %s%s' % (
                rot['deg'], rot.get('bins'), 'да' if rot.get('applied') else 'нет',
                '' if rot.get('applied') else ' — ' + str(rot.get('reason'))))
        if not r.get('accepted'):
            print('  причина отказа:   %s' % r.get('reason'))
        elif r.get('after'):
            print('  a: %s, dir: %s, толщина %.3f м' % (
                r['after']['a'], r['after'].get('dir'), r['after']['thickness']))
    elif op == 'snap_all':
        print('операция:    snap_all (измеренных стен %s): принято %s, без изменений %s, '
              'отклонено %s' % (r.get('measured'), r.get('accepted_count'),
                                r.get('unchanged_count'), r.get('rejected_count')))
        for a in (r.get('accepted') or []):
            print('  принята #%d: T %.3f -> %.3f, сдвиг %+.3f%s' % (
                a['wall'], a.get('thickness_before') or 0.0, a.get('thickness_after') or 0.0,
                a.get('offset') or 0.0,
                ', поворот %+.2f°' % a['rotation_deg']
                if abs(a.get('rotation_deg') or 0) > 1e-6 else ''))
        for a in (r.get('rejected') or [])[:8]:
            print('  отклонена #%d: %s' % (a['wall'], a.get('reason')))
    elif op == 'snap_opening':
        print('операция:    snap_opening стена #%d проём #%d: %s' % (
            r.get('wall'), r.get('opening'),
            'ПРИНЯТО' if r.get('accepted') else 'ОТКЛОНЕНО'))
        print('  along/width:      %.3f/%.3f -> %s/%s м' % (
            r.get('along_before'), r.get('width_before'),
            r.get('along_after'), r.get('width_after')))
        if r.get('gaps') is not None:
            print('  разрывы облака:   %d' % len(r['gaps']))
        if not r.get('accepted'):
            print('  причина отказа:   %s' % r.get('reason'))
    elif op in ('add_opening', 'remove_opening', 'move_opening'):
        print('операция:    %s стена #%d' % (op, r.get('wall')))
        if r.get('opening'):
            print('  проём:            %s' % json.dumps(r['opening'], ensure_ascii=False))
        if r.get('after'):
            print('  после:            %s' % json.dumps(r['after'], ensure_ascii=False))
        if r.get('removed'):
            print('  удалён:           %s' % json.dumps(r['removed'], ensure_ascii=False))
    elif op in ('undo', 'redo'):
        print('операция:    %s: %s' % (op, 'выполнено' if r.get('changed') else r.get('reason')))
    elif op == 'info' or op is None:
        print('операция:    %s' % ('info' if op == 'info' else 'без изменений'))
    if payload.get('saved'):
        print('сохранено:   %s (%d байт)' % (payload['saved']['saved'], payload['saved']['bytes']))
        if payload['saved'].get('historyPath'):
            print('история:     %s' % payload['saved']['historyPath'])
    if payload.get('ifc'):
        summary = payload['ifc'].get('summary') or {}
        print('IFC:         %s (%d байт)' % (payload['ifc']['path'], payload['ifc']['bytes']))
        if summary.get('counts'):
            print('  сущности:   %s' % summary['counts'])
    if payload.get('validate'):
        v = payload['validate']
        print('валидация:   %s (ERROR=%s, WARNING=%s, INFO=%s, арность=%s)' % (
            'OK' if v.get('ok') else 'ПРОБЛЕМЫ', v.get('errors'), v.get('warnings'),
            v.get('info'), 'OK' if not v.get('arityMismatches') else 'FAIL'))
        if v.get('inventory'):
            print('  инвентарь:  %s' % json.dumps(v['inventory'], sort_keys=True))
        if not v.get('ok') and v.get('output'):
            print('  ' + (v['output'].splitlines() or [''])[-1])


def main(argv=None):
    ap = _build_argparser()
    args = ap.parse_args(argv)
    result = {'ok': True, 'op': args.op, 'result': None, 'saved': None, 'ifc': None,
              'validate': None}
    try:
        if args.undo_depth < MIN_UNDO_DEPTH:
            raise EditError('--undo-depth должен быть >= %d (требование Фазы 4)' % MIN_UNDO_DEPTH)
        history_path = None
        if args.no_history:
            history_path = None
        elif args.history:
            history_path = args.history
        else:
            history_path = os.path.abspath(args.model) + '.history.json'
        op = args.op
        needs_cloud = op in ('snap_wall', 'snap_opening', 'snap_all') or bool(args.snap)
        cloud_path = args.cloud
        cloud_source = 'cli' if cloud_path else None
        if not cloud_path and needs_cloud:
            cloud_path = discover_cloud(args.model)
            if cloud_path:
                cloud_source = 'auto'
        if needs_cloud and not cloud_path:
            raise EditError('для %s нужно облако точек: укажите --cloud <file.bin>, '
                            'или EDIT_MODEL_CLOUD, или положите koridor-local-rgb.bin / '
                            '<модель>.bin рядом с моделью' % (op or '--snap'))
        ed = Editor.load(args.model, cloud=None, undo_depth=args.undo_depth,
                         history_path=history_path if not args.no_history else None,
                         stride=max(1, args.stride), load_history=not args.no_history)
        if cloud_path:
            ed.cloud = load_cloud(cloud_path, max(1, args.stride))
        res = None
        wall_index = args.index if args.index is not None else args.wall
        if op in ('set_wall', 'move_wall'):
            if wall_index is None:
                raise EditError('нужен --index (или --wall) стены')
            given = any(v is not None for v in (args.offset, args.thickness, args.length,
                                                args.extend_start, args.extend_end,
                                                args.height, args.base))
            if not given and not args.snap:
                raise EditError('не задано ни одного изменения '
                                '(offset/thickness/length/extend-start/extend-end/height/base/--snap)')
            res = ed.set_wall(wall_index, offset=args.offset, thickness=args.thickness,
                              length=args.length, extend_start=args.extend_start,
                              extend_end=args.extend_end, height=args.height, base=args.base,
                              snap=args.snap, rotate=not args.no_rotate,
                              max_rotation_deg=args.max_rotation)
        elif op == 'snap_wall':
            if wall_index is None:
                raise EditError('нужен --index (или --wall) стены для snap_wall')
            res = ed.snap_wall(wall_index, rotate=not args.no_rotate,
                               max_rotation_deg=args.max_rotation)
        elif op == 'snap_all':
            res = ed.snap_all(rotate=not args.no_rotate,
                              max_rotation_deg=args.max_rotation)
        elif op == 'snap_opening':
            if args.wall is None or args.opening is None:
                raise EditError('нужны --wall и --opening для snap_opening')
            res = ed.snap_opening(args.wall, args.opening)
        elif op == 'move_opening':
            if args.wall is None or args.opening is None:
                raise EditError('нужны --wall и --opening')
            if not any(v is not None for v in (args.along, args.width, args.sill, args.head)):
                raise EditError('не задано ни одного изменения проёма (along/width/sill/head)')
            res = ed.move_opening(args.wall, args.opening, along=args.along, width=args.width,
                                  sill=args.sill, head=args.head)
        elif op == 'add_opening':
            if args.wall is None or args.along is None or args.width is None:
                raise EditError('нужны --wall, --along и --width')
            res = ed.add_opening(args.wall, args.along, args.width, sill=args.sill,
                                 head=args.head, kind=args.kind)
        elif op == 'remove_opening':
            if args.wall is None or args.opening is None:
                raise EditError('нужны --wall и --opening')
            res = ed.remove_opening(args.wall, args.opening)
        elif op == 'undo':
            res = ed.undo()
        elif op == 'redo':
            res = ed.redo()
        elif op == 'info':
            res = None
        elif op is None:
            pass
        else:  # pragma: no cover — argparse ограничивает choices
            raise EditError('неизвестная операция: %s' % op)

        saved = None
        if args.out:
            saved = ed.save(args.out, history_path=args.history if args.history else None,
                            write_history=not args.no_history)
        if args.ifc:
            ifc = ed.export_ifc(args.ifc, node_bin=args.node, name=args.name)
            result['ifc'] = ifc
            if args.validate:
                val = validate_ifc(ifc['path'], python_bin=args.python_bin)
                result['validate'] = val
        elif args.validate:
            raise EditError('--validate требует --ifc (что валидировать)')
        payload = _result_payload(ed, res, saved=saved, ifc=result['ifc'],
                                  validate=result['validate'])
        payload['cloud'] = ({'path': cloud_path, 'source': cloud_source}
                            if cloud_path else None)
        payload['ok'] = not (result['validate'] and not result['validate'].get('ok'))
        if args.json:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        elif not args.quiet:
            _print_human(payload)
        if result['validate'] and not result['validate'].get('ok'):
            return 1
        return 0
    except EditError as exc:
        if args.json:
            sys.stdout.write(json.dumps({'ok': False, 'op': args.op, 'error': str(exc)},
                                        ensure_ascii=False) + '\n')
        else:
            sys.stderr.write('ОШИБКА: %s\n' % exc)
        return 2
    except (OSError, ValueError, TypeError) as exc:
        if args.json:
            sys.stdout.write(json.dumps({'ok': False, 'op': args.op, 'error': str(exc)},
                                        ensure_ascii=False) + '\n')
        else:
            sys.stderr.write('ОШИБКА: %s\n' % exc)
        return 2


if __name__ == '__main__':
    sys.exit(main())
