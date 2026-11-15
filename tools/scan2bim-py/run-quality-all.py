# -*- coding: utf-8 -*-
"""run-quality-all.py — регрессионный прогон качества scan-to-BIM по всем облакам.

Фаза 5 ROADMAP-IDEAL.md (пункт 1): «все облака → отчёты → сравнение с порогами;
ненулевой код при ухудшении».

Что делает:
  1. Берёт список облаков из встроенного манифеста:
       * интерьер `koridor-local-rgb.bin` + модель `py2-model.json` (baseline r107);
       * интерьер `koridor-local-rgb.bin` + финальная модель релиза (r111: `py2-final-v2.json`;
 *   запасной вариант — `py2-p1.json` Фазы 1);
       * фасадные модели коллег `py2-facade*.json` — через
         `D:\\BIM-TWIN-TEST\\interior\\py2-facade-manifest.json` (если он есть), иначе
         авто-подхват `py2-facade*.json` + `metrics-*.json`;
       * фасадные самотесты `facade-test.py` (Блок 1 ROADMAP-DOCS-AI.md) — дополнительный
         источник проверок B2/B3/B4 из `facade-tests-report.json` (`--facade-tests=auto|run|off`);
       * пара «облако + модель» может быть добавлена вручную: --cloud/--model/--pair.
  2. Для каждой пары «интерьер» запускает `ruler-v2.py` (НЕ меняет его) и складывает
     JSON-обмер в workdir.
  3. Собирает метрики: покрытие стен (медиана/мин), толщина (медиана/p90/макс),
     высота этажа, площадь помещений / видимый свободный пол, периметр,
     проёмы (полнота/точность/медиана ошибки ширины), помещения вне пола / наложения.
  4. Сравнивает с порогами ROADMAP-IDEAL.md (A1–A8) и печатает таблицу PASS/FAIL.
     Отсутствующий файл — SKIP с причиной (не провал): облака коллег могут быть ещё не готовы.
  5. Пишет сводный JSON-отчёт (--json), по желанию — baseline (--save-baseline) и
     сравнивает с ним: ухудшение метрики больше допуска → FAIL(регрессия).
  6. Код возврата: 0 — все проверки PASS (SKIP допускаются); 1 — есть FAIL или
     регрессия; 2 — окружение/запуск (нет python/ruler, не найден корень данных).

Примеры:
  $py run-quality-all.py
  $py run-quality-all.py --root D:\\BIM-TWIN-TEST --json ..\\..\\qa\\quality-all-report.json
  $py run-quality-all.py --dry-run --list              # только манифест, без прогонов
  $py run-quality-all.py --save-baseline               # зафиксировать текущие метрики
  $py run-quality-all.py --no-targets                  # только регрессия (для CI)
  $py run-quality-all.py --entry "interior|koridor-local-rgb.bin|py2-model.json"

Оговорки (честно):
  * ruler-v2.py меряет только интерьеры (пол/потолок/стены/проёмы/помещения).
    Для фасадов он неприменим — фасадные метрики берутся из metrics-*.json коллег
    (recall/IoU/этажи/окна) и сравниваются с порогами B2/B3; если метрик нет — SKIP.
  * p90 толщины считается по ошибкам в разрезе стен (в ruler JSON есть только
    медиана/максимум; p90 — по тем же числам стен).
  * Полнота/точность проёмов и медиана ошибки ширины пересчитываются из JSON
    тем же алгоритмом, что печатает ruler-v2.py, и сверяются с его stdout
    (расхождение > 1 п.п. — предупреждение).
  * SKIP не считается провалом и не влияет на код возврата.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent            # bim-twin/tools/scan2bim-py
REPO_DIR = SCRIPT_DIR.parents[1]                        # bim-twin
RULER = SCRIPT_DIR / 'ruler-v2.py'

DEFAULT_ROOT = Path(r'D:\BIM-TWIN-TEST')
DEFAULT_WORKDIR = DEFAULT_ROOT / 'quality'
DEFAULT_JSON = REPO_DIR / 'qa' / 'quality-all-report.json'
DEFAULT_BASELINE = SCRIPT_DIR / 'quality-baseline.json'
# Блок 1 ROADMAP-DOCS-AI.md: самотесты фасада (facade-test.py) — дополнительный источник B2/B3/B4
FACADE_TESTS = 'facade-tests-report.json'

# ---------------------------------------------------------------- пороги ROADMAP
# ROADMAP-IDEAL.md, таблица критериев; для A2/A3/A7 условиях два.
THRESHOLDS = {
    'A1': {'label': 'Высота этажа vs облако',        'target': '|Δ| ≤ 10 мм'},
    'A2': {'label': 'Покрытие стен облаком',         'target': 'медиана ≥ 90 %, мин ≥ 60 %'},
    'A3': {'label': 'Толщина стен vs облако',        'target': 'медиана ≤ 20 мм, p90 ≤ 40 мм'},
    'A4': {'label': 'Периметр помещений закрыт',     'target': '≥ 97 %'},
    'A5': {'label': 'Площадь / видимый свободный пол','target': '95–102 %'},
    'A6': {'label': 'Помещения вне пола / наложения','target': '0 / 0'},
    'A7': {'label': 'Проёмы: полнота / точность',    'target': '≥ 90 % / ≥ 90 %'},
    'A8': {'label': 'Ширина проёма vs облако',       'target': 'медиана ≤ 30 мм'},
}

# Допуски регрессии (ухудшение относительно baseline). Знак: +1 = рост метрики,
# -1 = падение метрики, 0 = сравнение модуля/по модулю.
REGRESSION_METRICS = [
    ('median_coverage_pct', +1, 0.5, 'покрытие, медиана, %'),
    ('min_coverage_pct', +1, 1.0, 'покрытие, минимум, %'),
    ('median_T_err_mm', -1, 1.0, 'толщина, медиана ошибки, мм'),
    ('p90_T_err_mm', -1, 2.0, 'толщина, p90 ошибки, мм'),
    ('max_T_err_mm', -1, 5.0, 'толщина, максимум ошибки, мм'),
    ('height_err_mm', 0, 1.0, 'высота, ошибка, мм'),
    ('area_ratio_pct', 0, 0.5, 'площадь/пол, %'),
    ('room_perimeter_covered_pct', +1, 0.5, 'периметр, %'),
    ('openings_recall_pct', +1, 1.0, 'проёмы: полнота, %'),
    ('openings_precision_pct', +1, 1.0, 'проёмы: точность, %'),
    ('openings_width_median_err_mm', -1, 1.0, 'проёмы: ошибка ширины, мм'),
    ('rooms_outside_pct', -1, 0.2, 'помещения вне пола, %'),
    ('rooms_overlap_m2', -1, 0.1, 'наложение помещений, м²'),
]

STATUS_ICON = {'PASS': 'PASS', 'FAIL': 'FAIL', 'SKIP': 'SKIP', 'INFO': 'INFO'}


# ---------------------------------------------------------------- утилиты
def mb(n: int) -> str:
    if n >= 10 * 1e6:
        return '%.1f МБ' % (n / 1e6)
    if n >= 10 * 1e3:
        return '%.1f КБ' % (n / 1e3)
    return '%d Б' % n


def md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest().upper()


def percentile_linear(values, p):
    """p-й перцентиль с линейной интерполяцией (как numpy.percentile по умолчанию)."""
    vals = sorted(float(v) for v in values)
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    k = (len(vals) - 1) * p / 100.0
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return vals[lo]
    return vals[lo] + (vals[hi] - vals[lo]) * (k - lo)


def fmt_num(v, digits=1):
    if v is None:
        return '—'
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return '—'
    return ('%.' + str(digits) + 'f') % v


# ---------------------------------------------------------------- ruler-обмер
OPEN_RE = re.compile(
    r'проёмы: облако (\d+), модель (\d+) \| совпало (\d+) \| '
    r'полнота (\d+) % \| точность (\d+) % \| ширина: медиана ошибки (-?\d+) мм')
ROOMS_RE = re.compile(
    r'помещения: вне видимого пола ([\d.]+) % \| наложение комнат ([\d.]+) м²')
COVER_SUM_RE = re.compile(r'покрытие стен облаком: медиана ([\d.]+) %, минимум ([\d.]+) %')
THICK_SUM_RE = re.compile(r'толщина: медиана ошибки ([\d.]+) мм, максимум ([\d.]+) мм')
HEIGHT_SUM_RE = re.compile(r'высота: модель ([\d.]+), облако ([\d.]+), ошибка (-?[\d.]+) мм')
AREA_SUM_RE = re.compile(r'площадь помещений: модель ([\d.]+) м², видимый пол облака ([\d.]+) м²')
PERIM_SUM_RE = re.compile(r'периметр помещений, закрытый стенами: ([\d.]+) %')
WALLS_SUM_RE = re.compile(r'стен: модель (\d+) \(в т.ч. достроенных (\d+)\), обмерено облаком (\d+)')


def openings_from_rows(rows):
    """Тот же алгоритм сопоставления проёмов, что в ruler-v2.py.

    Возвращает (recall_pct, precision_pct, median_width_err_mm, tp, fn, fp, n_cloud, n_model).
    """
    def ov(a0, a1, b0, b1):
        return max(0.0, min(a1, b1) - max(a0, b0))

    tp = fn = fp = 0
    width_err = []
    for row in rows:
        mods = row.get('openings_model') or []
        gaps = row.get('gaps_cloud') or []
        used = [False] * len(mods)
        for g in gaps:
            g0 = float(g.get('start', 0.0))
            g1 = g0 + float(g.get('width', 0.0))
            best = None
            for k, mo in enumerate(mods):
                if used[k]:
                    continue
                m0 = float(mo.get('start', 0.0))
                m1 = m0 + float(mo.get('width', 0.0))
                inter = ov(g0, g1, m0, m1)
                if inter / max(0.1, min(m1 - m0, g1 - g0)) >= 0.5:
                    if best is None or inter > best[0]:
                        best = (inter, k, mo)
            if best:
                used[best[1]] = True
                tp += 1
                width_err.append(abs(float(best[2].get('width', 0.0)) - float(g.get('width', 0.0))))
            else:
                fn += 1
        fp += sum(1 for u in used if not u)
    recall = 100.0 * tp / max(1, tp + fn)
    precision = 100.0 * tp / max(1, tp + fp)
    med = percentile_linear(width_err, 50) if width_err else None
    return recall, precision, med, tp, fn, fp, tp + fn, tp + fp


def parse_ruler_json(path: Path, stdout: str):
    """Собрать словарь метрик из JSON обмера + stdout (проёмы/помещения/строки сводки)."""
    with open(path, encoding='utf-8-sig') as fh:
        j = json.load(fh)
    rows = j.get('walls') or []
    cov = [float(r['coverage']) for r in rows if r.get('coverage') is not None]
    terr = [abs(float(r['T_err_mm'])) for r in rows if r.get('T_err_mm') is not None]
    summary = j.get('summary') or {}
    cloud = j.get('cloud') or {}
    model = j.get('model') or {}

    m = {
        'n_walls_measured': len(rows),
        'median_coverage_pct': percentile_linear(cov, 50) if cov else summary.get('median_coverage_pct'),
        'min_coverage_pct': min(cov) if cov else summary.get('min_coverage_pct'),
        'median_T_err_mm': percentile_linear(terr, 50) if terr else summary.get('median_T_err_mm'),
        'p90_T_err_mm': percentile_linear(terr, 90),
        'max_T_err_mm': max(terr) if terr else summary.get('max_T_err_mm'),
        'cloud_height_m': cloud.get('height'),
        'model_height_m': model.get('height'),
        'height_err_mm': summary.get('height_err_mm'),
        'model_rooms_area_m2': model.get('rooms_area'),
        'cloud_floor_visible_m2': cloud.get('floor_visible_m2'),
        'room_perimeter_covered_pct': summary.get('room_perimeter_covered_pct'),
        'room_perimeter_m': summary.get('room_perimeter_m'),
        'walls_cloud_beyond': summary.get('walls_cloud_beyond'),
        'model_walls': model.get('walls'),
        'model_openings': model.get('openings'),
        'model_rooms': model.get('rooms'),
    }
    ratio = None
    if m['model_rooms_area_m2'] and m['cloud_floor_visible_m2']:
        ratio = 100.0 * float(m['model_rooms_area_m2']) / float(m['cloud_floor_visible_m2'])
    m['area_ratio_pct'] = ratio

    # проёмы: пересчёт из JSON + сверка со stdout
    rec, prec, width_err, tp, fn, fp, n_cloud, n_model = openings_from_rows(rows)
    m.update({'openings_recall_pct': rec, 'openings_precision_pct': prec,
              'openings_width_median_err_mm': width_err,
              'openings_tp': tp, 'openings_fn': fn, 'openings_fp': fp,
              'openings_cloud': n_cloud, 'openings_model': n_model})
    mo = OPEN_RE.search(stdout)
    if mo:
        m['openings_stdout'] = {'recall': int(mo.group(4)), 'precision': int(mo.group(5)),
                                'width_median_err_mm': int(mo.group(6))}
        if abs(round(rec) - int(mo.group(4))) > 1 or abs(round(prec) - int(mo.group(5))) > 1:
            m['openings_stdout_mismatch'] = True
    else:
        m['openings_stdout'] = None

    # помещения вне видимого пола / наложение
    mr = ROOMS_RE.search(stdout)
    m['rooms_outside_pct'] = float(mr.group(1)) if mr else None
    m['rooms_overlap_m2'] = float(mr.group(2)) if mr else None

    # мелочи из stdout — для отчёта
    for key, rx in (('walls_summary', WALLS_SUM_RE),):
        mm = rx.search(stdout)
        if mm:
            m[key] = {'walls': int(mm.group(1)), 'inferred': int(mm.group(2)),
                      'measured': int(mm.group(3))}
    # если JSON-summary отсутствует — добираем из stdout
    if m['median_coverage_pct'] is None:
        mm = COVER_SUM_RE.search(stdout)
        if mm:
            m['median_coverage_pct'] = float(mm.group(1))
            m['min_coverage_pct'] = float(mm.group(2))
    if m['median_T_err_mm'] is None:
        mm = THICK_SUM_RE.search(stdout)
        if mm:
            m['median_T_err_mm'] = float(mm.group(1))
            m['max_T_err_mm'] = float(mm.group(2))
    if m['height_err_mm'] is None:
        mm = HEIGHT_SUM_RE.search(stdout)
        if mm:
            m['height_err_mm'] = float(mm.group(3))
    if m['area_ratio_pct'] is None:
        mm = AREA_SUM_RE.search(stdout)
        if mm:
            m['model_rooms_area_m2'] = float(mm.group(1))
            m['cloud_floor_visible_m2'] = float(mm.group(2))
            if m['cloud_floor_visible_m2']:
                m['area_ratio_pct'] = 100.0 * m['model_rooms_area_m2'] / m['cloud_floor_visible_m2']
    if m['room_perimeter_covered_pct'] is None:
        mm = PERIM_SUM_RE.search(stdout)
        if mm:
            m['room_perimeter_covered_pct'] = float(mm.group(1))
    return m


def run_ruler(cloud: Path, model: Path, out_json: Path, timeout: float, log_path: Path):
    """Запустить ruler-v2.py. Возвращает (metrics|None, elapsed, error|None, stdout)."""
    cmd = [sys.executable, str(RULER), str(cloud), str(model), str(out_json)]
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None, time.time() - t0, 'ruler-v2.py: таймаут %.0f с' % timeout, ''
    elapsed = time.time() - t0
    enc = 'utf-8'
    stdout = proc.stdout.decode(enc, 'replace') if proc.stdout else ''
    stderr = proc.stderr.decode(enc, 'replace') if proc.stderr else ''
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text('$ %s\n%s\n%s' % (' '.join(cmd), stdout, stderr), encoding='utf-8')
    if proc.returncode != 0:
        tail = (stderr or stdout).strip().splitlines()[-3:]
        return None, elapsed, 'ruler-v2.py: код %d: %s' % (proc.returncode, ' | '.join(tail)), stdout
    if not out_json.exists():
        return None, elapsed, 'ruler-v2.py: нет JSON %s' % out_json, stdout
    try:
        metrics = parse_ruler_json(out_json, stdout)
    except Exception as exc:  # noqa: BLE001
        return None, elapsed, 'разбор ruler JSON: %s' % exc, stdout
    return metrics, elapsed, None, stdout


# ---------------------------------------------------------------- проверки A1–A8
def check_a1(metrics):
    v = metrics.get('height_err_mm')
    if v is None:
        return 'SKIP', 'нет height_err_mm'
    ok = abs(v) <= 10.0
    return ('PASS' if ok else 'FAIL'), 'Δ = %+.0f мм (модель %s / облако %s м)' % (
        v, fmt_num(metrics.get('model_height_m'), 3), fmt_num(metrics.get('cloud_height_m'), 3))


def check_a2(metrics):
    med = metrics.get('median_coverage_pct')
    mn = metrics.get('min_coverage_pct')
    if med is None:
        return 'SKIP', 'нет покрытия'
    if mn is None:
        return 'SKIP', 'медиана %.0f %%, минимум нет' % med
    ok = med >= 90.0 and mn >= 60.0
    detail = 'медиана %.0f %%%s, мин %.0f %%%s' % (
        med, '' if med >= 90 else ' (<90)', mn, '' if mn >= 60 else ' (<60)')
    return ('PASS' if ok else 'FAIL'), detail


def check_a3(metrics):
    med = metrics.get('median_T_err_mm')
    p90 = metrics.get('p90_T_err_mm')
    mx = metrics.get('max_T_err_mm')
    if med is None:
        return 'SKIP', 'нет толщины'
    if p90 is None:
        return 'SKIP', 'медиана %s мм, p90 нет' % fmt_num(med, 0)
    ok = med <= 20.0 and p90 <= 40.0
    detail = 'медиана %.0f мм%s, p90 %.0f мм%s, макс %s мм' % (
        med, '' if med <= 20 else ' (>20)', p90, '' if p90 <= 40 else ' (>40)',
        fmt_num(mx, 0))
    return ('PASS' if ok else 'FAIL'), detail


def check_a4(metrics):
    v = metrics.get('room_perimeter_covered_pct')
    if v is None:
        return 'SKIP', 'нет периметра'
    ok = v >= 97.0
    total = metrics.get('room_perimeter_m')
    covered = (total * v / 100.0) if total is not None else None
    return ('PASS' if ok else 'FAIL'), '%.1f %% (%s из %s м)' % (
        v, fmt_num(covered, 1), fmt_num(total, 1))


def check_a5(metrics):
    ratio = metrics.get('area_ratio_pct')
    if ratio is None:
        return 'SKIP', 'нет площади'
    ok = 95.0 <= ratio <= 102.0
    return ('PASS' if ok else 'FAIL'), '%.1f %% (%s / %s м²)' % (
        ratio, fmt_num(metrics.get('model_rooms_area_m2'), 1),
        fmt_num(metrics.get('cloud_floor_visible_m2'), 1))


def check_a6(metrics):
    outside = metrics.get('rooms_outside_pct')
    overlap = metrics.get('rooms_overlap_m2')
    if outside is None and overlap is None:
        return 'SKIP', 'проверка помещений не выполнена (ruler без shapely?)'
    ok = (outside is not None and outside <= 0.0) and (overlap is not None and overlap <= 0.0)
    detail = 'вне пола %s %%, наложение %s м²' % (fmt_num(outside, 1), fmt_num(overlap, 1))
    return ('PASS' if ok else 'FAIL'), detail


def check_a7(metrics):
    rec = metrics.get('openings_recall_pct')
    prec = metrics.get('openings_precision_pct')
    if rec is None:
        return 'SKIP', 'нет проёмов'
    ok = rec >= 90.0 and prec >= 90.0
    detail = 'полнота %.0f %%%s, точность %.0f %%%s (TP %s, FN %s, FP %s)' % (
        rec, '' if rec >= 90 else ' (<90)', prec, '' if prec >= 90 else ' (<90)',
        metrics.get('openings_tp'), metrics.get('openings_fn'), metrics.get('openings_fp'))
    return ('PASS' if ok else 'FAIL'), detail


def check_a8(metrics):
    v = metrics.get('openings_width_median_err_mm')
    if v is None:
        return 'SKIP', 'нет ошибки ширины проёмов'
    ok = v <= 30.0
    return ('PASS' if ok else 'FAIL'), 'медиана %.0f мм' % v


A_CHECKS = [('A1', check_a1), ('A2', check_a2), ('A3', check_a3), ('A4', check_a4),
            ('A5', check_a5), ('A6', check_a6), ('A7', check_a7), ('A8', check_a8)]


def eval_interior(metrics):
    out = []
    for code, fn in A_CHECKS:
        status, detail = fn(metrics)
        out.append({'code': code, 'label': THRESHOLDS[code]['label'],
                    'target': THRESHOLDS[code]['target'],
                    'status': status, 'detail': detail})
    return out


# ---------------------------------------------------------------- проверки фасада
def facade_thresholds(kind: str):
    """Пороги B2/B3/B4 из ROADMAP-IDEAL.md."""
    if kind == 'B3':
        return {'recall': 85.0, 'iou': 65.0, 'window_recall': 85.0, 'floors': None, 'wpf': None}
    if kind == 'B4':
        return {'recall': None, 'iou': None, 'window_recall': None, 'floors': None, 'wpf': None,
                'time_s': 600.0, 'stability': True}
    if kind == 'B2':
        return {'recall': 90.0, 'iou': 70.0, 'window_recall': 90.0, 'floors': None, 'wpf': None}
    return {'recall': None, 'iou': None, 'window_recall': None, 'floors': None, 'wpf': None}


def _facade_windows(rec):
    """Сумма окон по этажам (windows или windows_per_floor)."""
    if rec.get('windows') is not None:
        return int(rec['windows'])
    wpf = rec.get('windows_per_floor')
    if isinstance(wpf, (list, tuple)):
        return sum(int(x) for x in wpf)
    if isinstance(wpf, int):
        return wpf
    return None


def eval_facade(rec: dict, kind: str):
    """Проверки фасада: B2 (синтетика 3/3, 6/6 + recall/IoU), B3 (map-window), B4 (map.las)."""
    thr = facade_thresholds(kind)
    checks = []
    ref = rec.get('ref') or {}
    floors = rec.get('floors')
    win = _facade_windows(rec)
    ref_windows = rec.get('ref_windows') or ref.get('windows')
    ref_floors = rec.get('ref_floors') or ref.get('floors')

    if kind == 'B2':
        # «этажи/окна на этаж»: синтетический стенд 3/3 и 6/6 проверяется bench-скриптом
        # (см. раздел B1 отчёта); здесь для реального фасада сверяем с эталоном замеров.
        if floors is not None and ref_floors is not None:
            checks.append({'code': 'B2-эт', 'label': 'Этажи vs эталон', 'target': '%d/%d' % (ref_floors, ref_floors),
                           'status': 'PASS' if int(floors) == int(ref_floors) else 'FAIL',
                           'detail': 'найдено %s' % floors})
        elif floors is not None:
            checks.append({'code': 'B2-эт', 'label': 'Этажи', 'target': '—', 'status': 'INFO',
                           'detail': '%s' % floors})
        if win is not None and ref_windows is not None:
            checks.append({'code': 'B2-ок', 'label': 'Окна vs эталон', 'target': '%d/%d' % (ref_windows, ref_windows),
                           'status': 'PASS' if win == int(ref_windows) else 'FAIL',
                           'detail': '%d/%d' % (win, int(ref_windows))})
        sp_c, sp_t = rec.get('spandrel_confirmed'), rec.get('spandrel_total')
        if sp_c is not None and sp_t:
            checks.append({'code': 'B2-п', 'label': 'Полосы перекрытий', 'target': '%d/%d' % (sp_t, sp_t),
                           'status': 'PASS' if int(sp_c) == int(sp_t) else 'FAIL',
                           'detail': '%d/%d' % (int(sp_c), int(sp_t))})
    elif kind == 'B3':
        if win is not None and ref_windows is not None:
            checks.append({'code': 'B3-ок', 'label': 'Окна vs эталон', 'target': '%d/%d' % (ref_windows, ref_windows),
                           'status': 'PASS' if win == int(ref_windows) else 'FAIL',
                           'detail': '%d/%d' % (win, int(ref_windows))})
    elif kind == 'B4':
        time_s = rec.get('time_s')
        if time_s is not None:
            checks.append({'code': 'B4-т', 'label': 'Время прогона', 'target': '≤ %d с' % int(thr['time_s']),
                           'status': 'PASS' if float(time_s) <= thr['time_s'] else 'FAIL',
                           'detail': '%.1f с' % float(time_s)})
        crit = rec.get('criteria') or {}
        no_crash = crit.get('no_crash')
        degenerate = rec.get('degenerate')
        # B4 в роадмапе: «устойчиво, без падений». Вырожденная модель на произвольном
        # кропе полной карты — штатный исход (нет регулярных этажей), а не падение.
        if no_crash is not None:
            checks.append({'code': 'B4-у', 'label': 'Устойчивость (без падений)', 'target': 'да',
                           'status': 'PASS' if no_crash else 'FAIL', 'detail': 'no_crash=%s' % no_crash})
        elif degenerate is not None:
            checks.append({'code': 'B4-у', 'label': 'Устойчивость (без падений)', 'target': 'да',
                           'status': 'PASS' if degenerate is not True else 'INFO',
                           'detail': 'degenerate=%s' % degenerate})
        if degenerate is True:
            checks.append({'code': 'B4-d', 'label': 'Вырожденная модель на кропе', 'target': '—',
                           'status': 'INFO', 'detail': 'нет регулярных этажей — штатно для кропа'})
        if rec.get('fallback') is True:
            checks.append({'code': 'B4-f', 'label': 'Fallback-модель (кроп без этажей)', 'target': '—',
                           'status': 'INFO', 'detail': 'штатно: регулярного фасада в кропе нет'})
        floors, win = rec.get('floors'), _facade_windows(rec)
        checks.append({'code': 'B4-m', 'label': 'Найдено на кропе', 'target': '—', 'status': 'INFO',
                       'detail': 'этажей %s, окон %s, точек %s' % (floors, win, rec.get('points'))})

    for key, code, label, unit in (('recall', 'B2-r' if kind == 'B2' else ('B3-r' if kind == 'B3' else 'B4-r'),
                                    'Recall окон', '%'),
                                   ('iou', 'B2-i' if kind == 'B2' else ('B3-i' if kind == 'B3' else 'B4-i'),
                                    'IoU окон', '%'),
                                   ('window_recall', 'B2-wr' if kind == 'B2' else 'B3-wr',
                                    'Полнота окон (window-recall)', '%')):
        val = rec.get(key)
        target = thr.get(key)
        if target is None:
            if val is not None:
                checks.append({'code': code, 'label': label, 'target': '—', 'status': 'INFO',
                               'detail': '%s %s' % (fmt_num(float(val), 1), unit)})
            continue
        if val is None:
            continue
        checks.append({'code': code, 'label': label, 'target': '≥ %d %s' % (target, unit),
                       'status': 'PASS' if float(val) >= target else 'FAIL',
                       'detail': '%s %s' % (fmt_num(float(val), 1), unit)})

    # для B2/B3: скорость и запас по метрикам — справочно
    if kind in ('B2', 'B3') and rec.get('time_s') is not None:
        checks.append({'code': kind + '-t', 'label': 'Время прогона', 'target': '—', 'status': 'INFO',
                       'detail': '%.1f с' % float(rec['time_s'])})
    if rec.get('pass') is not None:
        checks.append({'code': kind + '-p', 'label': 'Самопроверка коллеги (pass)', 'target': 'true',
                       'status': 'PASS' if rec.get('pass') else 'FAIL',
                       'detail': str(rec.get('pass'))})
    return checks


# ---------------------------------------------------------------- фасадные самотесты (Блок 1 ROADMAP-DOCS-AI.md)
def load_facade_tests_report(root: Path):
    """Прочитать facade-tests-report.json от facade-test.py.

    Возвращает (report|None, path). None — файла нет; {'_error': ...} — не разобран.
    """
    path = root / 'interior' / FACADE_TESTS
    if not path.exists():
        return None, path
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
    except Exception as exc:  # noqa: BLE001
        return {'_error': str(exc)}, path
    if not isinstance(data, dict):
        return {'_error': 'ожидался объект, получено %s' % type(data).__name__}, path
    return data, path


def facade_test_checks(report, stand: str):
    """Проверки facade-test.py для стенда B2/B3/B4 в формате checks run-quality-all.

    Возвращает (checks, warning|None). Самотесты — дополнительный источник: их PASS/FAIL
    добавляются к проверкам соответствующего фасадного стенда; отсутствие отчёта — не провал.
    """
    if not report:
        return [], 'нет %s (самотесты фасада не проверены; запустить: --facade-tests=run)' % FACADE_TESTS
    if report.get('_error'):
        return [], '%s не разобран: %s' % (FACADE_TESTS, report['_error'])
    cases = [c for c in (report.get('cases') or [])
             if isinstance(c, dict) and str(c.get('stand') or '').upper() == str(stand or '').upper()]
    if not cases:
        return [], None
    out = []
    for case in cases:
        for ch in (case.get('checks') or []):
            if not isinstance(ch, dict):
                continue
            status = str(ch.get('status') or 'INFO').upper()
            if status not in ('PASS', 'FAIL', 'SKIP', 'INFO'):
                status = 'INFO'
            out.append({
                'code': 'T-' + str(ch.get('code') or '?'),
                'label': 'самотест: ' + str(ch.get('label') or ''),
                'target': str(ch.get('expected') or '—'),
                'detail': str(ch.get('actual') or ''),
                'status': status,
            })
    return out, None


# ---------------------------------------------------------------- манифест
def load_manifest(root: Path, extra_pairs, no_facade: bool):
    """Собрать список проверок. Возвращает (entries, warnings)."""
    interior = root / 'interior'
    entries = []
    warnings = []

    cloud_koridor = interior / 'koridor-local-rgb.bin'
    entries.append({'name': 'koridor/baseline-r107', 'kind': 'interior', 'role': 'baseline',
                    'cloud': cloud_koridor, 'model': interior / 'py2-model.json',
                    'note': 'стабильная модель r107 (контрольная точка)'})
    # Финальная модель релиза: r111 — py2-final-v2.json (Фаза 4: snap_wall стены 11);
    # если её нет (старые данные) — берём модель Фазы 1 py2-p1.json.
    final_model = interior / 'py2-final-v4.json'
    if not final_model.exists():
        final_model = interior / 'py2-final-v2.json'
    final_note = 'финальная модель r117 (A 8/8, v4: топология A2/A6)'
    if not final_model.exists():
        final_model = interior / 'py2-p1.json'
        final_note = 'финальная модель Фазы 1 (A1/A5/A6) — r111-модель не найдена'
    entries.append({'name': 'koridor/final', 'kind': 'interior', 'role': 'release',
                    'cloud': cloud_koridor, 'model': final_model, 'note': final_note})

    for cloud, model in extra_pairs:
        entries.append({'name': 'custom/%s' % Path(model).stem, 'kind': 'interior',
                        'role': 'custom', 'cloud': Path(cloud), 'model': Path(model),
                        'note': 'задано вручную'})

    if no_facade:
        return entries, warnings

    manifest_path = interior / 'py2-facade-manifest.json'
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
        except Exception as exc:  # noqa: BLE001
            warnings.append('py2-facade-manifest.json не разобран: %s' % exc)
            data = None
        if data:
            raw = data.get('entries') if isinstance(data, dict) else data
            for it in raw or []:
                if not isinstance(it, dict):
                    continue
                model = it.get('model') or it.get('model_file')
                cloud = it.get('cloud') or it.get('cloud_file')
                metrics = it.get('metrics') or it.get('metrics_file')

                def _abs(p):
                    if not p:
                        return None
                    p = Path(p)
                    return p if p.is_absolute() else (interior / p)

                entries.append({
                    'name': 'facade/%s' % (it.get('name') or Path(model or '?').stem),
                    'kind': 'facade', 'role': 'facade',
                    'cloud': _abs(cloud), 'model': _abs(model),
                    'metrics': _abs(metrics),
                    'stand': it.get('stand') or it.get('kind_b') or '',
                    'note': it.get('note', '')})
    else:
        # авто-подхват: py2-facade*.json + metrics-*.json (имена — как договорено с phase2)
        for model in sorted(interior.glob('py2-facade*.json')):
            stem = model.stem                       # py2-facade, py2-facade-window, ...
            suffix = stem[len('py2-facade-'):] if stem.startswith('py2-facade-') else ''
            candidates = []
            if suffix:
                candidates.append(interior / ('metrics-py2-%s.json' % suffix))
            candidates += [interior / ('metrics-%s.json' % stem),
                           interior / ('metrics-py2-%s.json' % stem),
                           interior / 'metrics-py2-facade.json']
            mfile = next((p for p in candidates if p.exists()), None)
            cloud_guess = None
            if stem == 'py2-facade':
                cloud_guess = interior / 'map-120-facade.bin'
            elif suffix:
                cloud_guess = interior / ('%s-facade.bin' % suffix)
            low = stem.lower()
            if 'window' in low:
                kind_hint = 'B3'
            elif 'mapcrop' in low:
                kind_hint = 'B4'
            else:
                kind_hint = 'B2'
            entries.append({'name': 'facade/%s' % stem, 'kind': 'facade', 'role': 'facade',
                            'cloud': cloud_guess, 'model': model, 'metrics': mfile,
                            'stand': kind_hint,
                            'note': 'авто-подхват py2-facade*.json'})
    return entries, warnings


def load_facade_metrics(path: Path):
    """Нормализовать metrics-*.json в список записей."""
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        if any(k in data for k in ('recall', 'iou', 'floors', 'windows_per_floor', 'file')):
            return [data]
        out = []
        for k, v in data.items():
            if isinstance(v, dict):
                v = dict(v)
                v.setdefault('file', k)
                out.append(v)
        if out:
            return out
        return [data]
    return []


def match_facade_record(records, model: Path):
    """Найти запись метрик для модели: точное совпадение имени, иначе единственная запись."""
    stem = model.stem.lower()
    base = model.name.lower()
    exact, loose = [], []
    for rec in records:
        f = str(rec.get('file') or rec.get('model') or '').replace('\\', '/').lower()
        if not f:
            continue
        fb = Path(f).name
        fs = Path(f).stem
        if f == base or fs == stem or fb == base or fb == stem:
            exact.append(rec)
        elif stem in f or f in base:
            loose.append(rec)
    if exact:
        return exact[0]
    if len(records) == 1:
        return records[0]          # отдельный metrics-*.json для одной модели
    if len(loose) == 1:
        return loose[0]
    return None


# ---------------------------------------------------------------- регрессия/baseline
def load_baseline(path: Path):
    if not path or not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        return data.get('entries') or {}
    except Exception:  # noqa: BLE001
        return {}


def regression_check(name, metrics, baseline_entry):
    if not baseline_entry or not metrics:
        return []
    base = baseline_entry.get('metrics') or {}
    out = []
    for key, sign, tol, label in REGRESSION_METRICS:
        cur = metrics.get(key)
        old = base.get(key)
        if cur is None or old is None:
            continue
        if key == 'area_ratio_pct':
            # A5 — метрика «в диапазоне 95–102 %»: ухудшение = рост расстояния до диапазона.
            def _dist(v):
                v = float(v)
                return 0.0 if 95.0 <= v <= 102.0 else min(abs(v - 95.0), abs(v - 102.0))
            worse = _dist(cur) > _dist(old) + tol
            delta = _dist(cur) - _dist(old)
            detail = '%.2f → %.2f %% (расстояние до коридора %.2f → %.2f, допуск %.2f)' % (
                float(old), float(cur), _dist(old), _dist(cur), tol)
        elif sign == 0:
            worse = abs(float(cur)) > abs(float(old)) + tol
            delta = abs(float(cur)) - abs(float(old))
            detail = '%.2f → %.2f (|Δ| %+.2f, допуск %.2f)' % (float(old), float(cur), delta, tol)
        elif sign > 0:
            worse = float(cur) < float(old) - tol
            delta = float(cur) - float(old)
            detail = '%.2f → %.2f (Δ %+.2f, допуск %.2f)' % (float(old), float(cur), delta, tol)
        else:
            worse = float(cur) > float(old) + tol
            delta = float(cur) - float(old)
            detail = '%.2f → %.2f (Δ %+.2f, допуск %.2f)' % (float(old), float(cur), delta, tol)
        if worse:
            out.append({'code': 'REG', 'label': label, 'target': 'не хуже baseline %.2f' % float(old),
                        'status': 'FAIL', 'detail': detail})
    return out


# ---------------------------------------------------------------- печать
def print_interior_table(entry, metrics, checks, ruler_path, elapsed):
    name = entry['name']
    print('\n' + '=' * 100)
    print('ОБЛАКО/МОДЕЛЬ: %s   [%s]' % (name, entry['kind']))
    print('  облако: %s' % entry['cloud'])
    if entry['cloud'].exists():
        print('          %s, изменён %s' % (mb(entry['cloud'].stat().st_size),
                                            datetime.fromtimestamp(entry['cloud'].stat().st_mtime).strftime('%Y-%m-%d %H:%M')))
    print('  модель: %s' % entry['model'])
    if entry['model'].exists():
        st = entry['model'].stat()
        print('          %s, md5 %s, изменён %s' % (mb(st.st_size), md5(entry['model'])[:12],
                                                    datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M')))
    if ruler_path:
        print('  обмер:  %s (%.1f с)' % (ruler_path, elapsed))
    if entry.get('note'):
        print('  примечание: %s' % entry['note'])
    if metrics:
        print('  стен обмерено %s (модель %s) | проёмы облако/модель %s/%s | помещений %s' % (
            metrics.get('n_walls_measured'), metrics.get('model_walls'),
            metrics.get('openings_cloud'), metrics.get('openings_model'), metrics.get('model_rooms')))
    print('-' * 100)
    print('%-4s %-30s %-24s %-42s %s' % ('Код', 'Метрика', 'Цель (ROADMAP)', 'Факт', 'Статус'))
    print('-' * 100)
    n_pass = n_fail = n_skip = 0
    for c in checks:
        n_pass += c['status'] == 'PASS'
        n_fail += c['status'] == 'FAIL'
        n_skip += c['status'] == 'SKIP'
        print('%-4s %-30s %-24s %-42s %s' % (c['code'], c['label'], c['target'], c['detail'],
                                             STATUS_ICON.get(c['status'], c['status'])))
    print('-' * 100)
    print('ИТОГ: PASS %d | FAIL %d | SKIP %d' % (n_pass, n_fail, n_skip))
    return n_pass, n_fail, n_skip


def print_facade_table(entry, checks, rec, metrics_path, cloud_path, cloud_exists):
    print('\n' + '=' * 100)
    stand = entry.get('stand') or '?'
    print('ФАСАД: %s   [стенд %s]' % (entry['name'], stand if stand else 'вне B2/B3'))
    print('  модель: %s%s' % (entry['model'], '' if entry['model'].exists() else '  (НЕТ ФАЙЛА)'))
    if cloud_path:
        print('  облако: %s%s' % (cloud_path, '' if cloud_exists else '  (НЕТ ФАЙЛА)'))
    if metrics_path:
        print('  метрики: %s' % metrics_path)
    if rec:
        sp = ''
        if rec.get('spandrel_total'):
            sp = ', полосы перекрытий %s/%s' % (rec.get('spandrel_confirmed'), rec.get('spandrel_total'))
        print('  метрики: этажи %s, шаг этажа %s м, окна/этаж %s (всего %s), recall %s %%, IoU %s %%, window-recall %s %%%s, время %s с' % (
            rec.get('floors'), fmt_num(rec.get('floor_pitch'), 2), rec.get('windows_per_floor'),
            _facade_windows(rec), fmt_num(rec.get('recall'), 2), fmt_num(rec.get('iou'), 2),
            fmt_num(rec.get('window_recall'), 1), sp, fmt_num(rec.get('time_s'), 1)))
    print('-' * 100)
    print('%-6s %-30s %-24s %-42s %s' % ('Код', 'Метрика', 'Цель (ROADMAP)', 'Факт', 'Статус'))
    print('-' * 100)
    n_pass = n_fail = n_skip = 0
    for c in checks:
        n_pass += c['status'] == 'PASS'
        n_fail += c['status'] == 'FAIL'
        n_skip += c['status'] == 'SKIP'
        print('%-6s %-30s %-24s %-42s %s' % (c['code'], c['label'], c['target'], c['detail'],
                                             STATUS_ICON.get(c['status'], c['status'])))
    print('-' * 100)
    print('ИТОГ: PASS %d | FAIL %d | SKIP %d' % (n_pass, n_fail, n_skip))
    return n_pass, n_fail, n_skip


def print_before_after(entries_results):
    """Сравнение baseline-модели и финальной (до/после Фазы 1), если обе посчитаны."""
    by_name = {r['name']: r for r in entries_results if r.get('kind') == 'interior' and r.get('metrics')}
    before = by_name.get('koridor/baseline-r107')
    after = by_name.get('koridor/final') or by_name.get('koridor/p1-final')
    if not before or not after:
        return
    labels = [
        ('median_coverage_pct', 'Покрытие, медиана, %', +1, 0),
        ('min_coverage_pct', 'Покрытие, минимум, %', +1, 0),
        ('median_T_err_mm', 'Толщина, медиана, мм', -1, 0),
        ('p90_T_err_mm', 'Толщина, p90, мм', -1, 0),
        ('height_err_mm', 'Высота, ошибка, мм', 0, 0),
        ('area_ratio_pct', 'Площадь/пол, %', 0, 1),
        ('room_perimeter_covered_pct', 'Периметр, %', +1, 1),
        ('openings_recall_pct', 'Проёмы: полнота, %', +1, 0),
        ('openings_precision_pct', 'Проёмы: точность, %', +1, 0),
        ('openings_width_median_err_mm', 'Проёмы: ошибка ширины, мм', -1, 0),
        ('rooms_outside_pct', 'Вне пола, %', -1, 1),
        ('rooms_overlap_m2', 'Наложение, м²', -1, 1),
    ]
    print('\n' + '=' * 100)
    before_model = Path(before['model']).name if before.get('model') else 'baseline'
    after_model = Path(after['model']).name if after.get('model') else 'final'
    if before.get('model') and after.get('model') and Path(before['model']).exists() and Path(after['model']).exists():
        same = md5(Path(before['model'])) == md5(Path(after['model']))
    else:
        same = False
    print('ДО/ПОСЛЕ: %s  vs  %s%s' % (before_model, after_model,
                                      '  (файлы побайтово совпадают — изменений нет)' if same else ''))
    print('-' * 100)
    print('%-34s %12s %12s %12s' % ('Метрика', 'baseline', 'финал', 'Δ'))
    print('-' * 100)
    for key, label, sign, digits in labels:
        b = before['metrics'].get(key)
        a = after['metrics'].get(key)
        if b is None and a is None:
            continue
        d = (a - b) if (a is not None and b is not None) else None
        print('%-34s %12s %12s %12s' % (label, fmt_num(b, digits), fmt_num(a, digits),
                                        ('%+.2f' % d) if d is not None else '—'))


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Регрессионный прогон качества scan-to-BIM по всем облакам (Фаза 5 ROADMAP-IDEAL).',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument('--root', default=str(DEFAULT_ROOT), help='корень тестовых данных (по умолчанию %(default)s)')
    ap.add_argument('--workdir', default=None, help='куда писать JSON обмеров (по умолчанию <root>\\quality)')
    ap.add_argument('--json', default=str(DEFAULT_JSON), help='сводный JSON-отчёт (по умолчанию %(default)s)')
    ap.add_argument('--baseline', default=str(DEFAULT_BASELINE), help='файл baseline (по умолчанию %(default)s)')
    ap.add_argument('--save-baseline', action='store_true', help='записать текущие метрики в --baseline')
    ap.add_argument('--no-baseline', action='store_true', help='не читать/не писать baseline')
    ap.add_argument('--no-targets', action='store_true', help='не валить по порогам целей (только регрессия)')
    ap.add_argument('--no-regression', action='store_true', help='не валить по регрессии')
    ap.add_argument('--no-facade', action='store_true', help='не искать фасадные модели')
    ap.add_argument('--facade-tests', choices=['auto', 'run', 'off'], default='auto',
                    help='самотесты facade-test.py: auto — читать готовый facade-tests-report.json, '
                         'run — сначала запустить facade-test.py, off — не использовать (по умолчанию auto)')
    ap.add_argument('--pair', action='append', default=[], metavar='CLOUD|MODEL',
                    help='дополнительная пара облако|модель (можно несколько раз)')
    ap.add_argument('--entry', action='append', default=[], metavar='KIND|CLOUD|MODEL',
                    help='дополнительная проверка: interior|<cloud>|<model> или facade||<model>')
    ap.add_argument('--ruler-timeout', type=float, default=1200.0, help='таймаут одного прогона ruler, с')
    ap.add_argument('--dry-run', action='store_true', help='не запускать ruler, только показать манифест и наличие файлов')
    ap.add_argument('--list', action='store_true', help='показать манифест и выйти')
    args = ap.parse_args(argv)

    root = Path(args.root)
    workdir = Path(args.workdir) if args.workdir else root / 'quality'
    pairs = []
    for p in args.pair:
        parts = p.split('|')
        if len(parts) != 2:
            print('ОШИБКА: --pair ожидает CLOUD|MODEL, получено %r' % p, file=sys.stderr)
            return 2
        pairs.append(parts)
    extra_entries = []
    for e in args.entry:
        parts = e.split('|')
        if len(parts) == 3:
            kind, cloud, model = parts
            extra_entries.append({'name': 'custom/%s' % Path(model).stem, 'kind': kind or 'interior',
                                  'role': 'custom', 'cloud': Path(cloud) if cloud else None,
                                  'model': Path(model), 'note': 'задано --entry'})
        else:
            print('ОШИБКА: --entry ожидает KIND|CLOUD|MODEL, получено %r' % e, file=sys.stderr)
            return 2

    entries, warnings = load_manifest(root, pairs, args.no_facade)
    entries += extra_entries

    # --- фасадные самотесты facade-test.py (Блок 1 ROADMAP-DOCS-AI.md) — дополнительный источник
    facade_tests_report, facade_tests_path = None, None
    if args.facade_tests != 'off':
        if args.facade_tests == 'run' and not (args.list or args.dry_run):
            ft_script = SCRIPT_DIR / 'facade-test.py'
            if ft_script.exists():
                print('\n[самотесты] запуск facade-test.py …')
                try:
                    ft_proc = subprocess.run(
                        [sys.executable, str(ft_script), '--root', str(root / 'interior'),
                         '--out', str(root / 'interior' / FACADE_TESTS)],
                        capture_output=True, text=True, timeout=1800)
                    print('  facade-test.py: код %d' % ft_proc.returncode)
                    for _ln in (ft_proc.stdout or '').strip().splitlines()[-2:]:
                        print('  ' + _ln)
                    if ft_proc.returncode != 0:
                        warnings.append('facade-test.py: FAIL (код %d)' % ft_proc.returncode)
                except Exception as exc:  # noqa: BLE001
                    warnings.append('facade-test.py не запустился: %s' % exc)
            else:
                warnings.append('нет %s — фасадные самотесты пропущены' % ft_script.name)
        facade_tests_report, facade_tests_path = load_facade_tests_report(root)

    print('run-quality-all.py — регрессионный прогон scan-to-BIM (Фаза 5 ROADMAP-IDEAL)')
    print('дата: %s | python: %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), sys.version.split()[0]))
    print('корень данных: %s | workdir: %s' % (root, workdir))
    print('ruler: %s%s' % (RULER, '' if RULER.exists() else '  (НЕТ ФАЙЛА!)'))
    print('проверок в манифесте: %d' % len(entries))
    for w in warnings:
        print('ПРЕДУПРЕЖДЕНИЕ: %s' % w)
    if not RULER.exists():
        print('ОШИБКА: не найден ruler-v2.py — обмер невозможен', file=sys.stderr)
        return 2

    if args.list or args.dry_run:
        for e in entries:
            def mark(p):
                if not p:
                    return 'нет пути'
                return 'есть' if Path(p).exists() else 'НЕТ'
            print('  [%s] %-24s облако: %s | модель: %s%s' % (
                e['kind'], e['name'], mark(e.get('cloud')), mark(e.get('model')),
                '' if e.get('metrics') is None else ' | метрики: %s' % mark(e['metrics'])))
        if args.facade_tests != 'off':
            ft_ok = bool(facade_tests_report) and not (facade_tests_report or {}).get('_error')
            print('  фасадные самотесты: %s%s' % (
                facade_tests_path if facade_tests_path else '—',
                '  (есть)' if ft_ok else '  (НЕТ; запустить: --facade-tests=run)'))
        if args.dry_run and not args.list:
            print('dry-run: ruler не запускался.')
        return 0

    workdir.mkdir(parents=True, exist_ok=True)
    # baseline читаем всегда (кроме --no-baseline): сравнение с предыдущей ревизией;
    # --save-baseline только ПИШЕТ обновлённый эталон после прогона.
    baseline = {} if args.no_baseline else load_baseline(Path(args.baseline))
    results = []
    n_fail_total = 0
    n_pass_total = 0
    n_skip_total = 0
    errors = []
    measured_cache = {}     # md5(model)+cloud → (metrics, ruler_path, elapsed)
    ruler_used = 0

    for entry in entries:
        cloud = Path(entry['cloud']) if entry.get('cloud') else None
        model = Path(entry['model']) if entry.get('model') else None
        rec = {'name': entry['name'], 'kind': entry['kind'], 'role': entry.get('role'),
               'note': entry.get('note', ''),
               'cloud': str(cloud) if cloud else None,
               'model': str(model) if model else None,
               'metrics': None, 'checks': [], 'metrics_file': None,
               'ruler_json': None, 'ruler_seconds': None,
               'status': 'SKIP', 'skip_reason': None, 'stand': entry.get('stand', '')}
        results.append(rec)

        if entry['kind'] == 'interior':
            missing = []
            if cloud is None or not cloud.exists():
                missing.append('облако %s' % cloud)
            if model is None or not model.exists():
                missing.append('модель %s' % model)
            if missing:
                rec['skip_reason'] = 'нет файла: ' + ', '.join(missing)
                print('\n' + '=' * 100)
                print('ОБЛАКО/МОДЕЛЬ: %s   [SKIP]' % entry['name'])
                print('  причина: %s' % rec['skip_reason'])
                n_skip_total += 1
                continue
            key = (md5(model), str(cloud.resolve()))
            if key in measured_cache:
                metrics, rpath, elapsed, src_name = measured_cache[key]
                rec['metrics'] = metrics
                rec['ruler_json'] = str(rpath)
                rec['ruler_seconds'] = elapsed
                rec['duplicate_of'] = src_name
                print('\n[%s] модель побайтово совпадает с уже обмеренной (%s) — ruler повторно не запускался'
                      % (entry['name'], rec['duplicate_of']))
            else:
                safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', entry['name'])
                out_json = workdir / ('%s-ruler.json' % safe)
                rpath = workdir / ('%s-ruler.log' % safe)
                print('\n[%s] запуск ruler-v2.py …' % entry['name'])
                metrics, elapsed, err, _stdout = run_ruler(cloud, model, out_json, args.ruler_timeout, rpath)
                ruler_used += 1
                if err:
                    rec['skip_reason'] = err
                    errors.append('%s: %s' % (entry['name'], err))
                    print('  ОШИБКА: %s' % err)
                    n_skip_total += 1
                    continue
                measured_cache[key] = (metrics, out_json, elapsed, entry['name'])
                rec['metrics'] = metrics
                rec['ruler_json'] = str(out_json)
                rec['ruler_seconds'] = round(elapsed, 1)
            checks = eval_interior(rec['metrics'])
            if not args.no_regression:
                checks += regression_check(entry['name'], rec['metrics'], baseline.get(entry['name']))
            rec['checks'] = checks
            if args.no_targets:
                for c in checks:
                    if c['status'] == 'FAIL' and c['code'] != 'REG':
                        c['status'] = 'INFO'
            n_pass, n_fail, n_skip = print_interior_table(
                entry, rec['metrics'], checks, rec['ruler_json'], rec['ruler_seconds'] or 0.0)
            n_pass_total += n_pass
            n_fail_total += n_fail
            n_skip_total += n_skip
            rec['status'] = 'FAIL' if n_fail else ('PASS' if n_pass else 'SKIP')

        elif entry['kind'] == 'facade':
            # модель/облако/метрики могут ещё не существовать — SKIP с причиной, не падение
            if model is None or not model.exists():
                rec['skip_reason'] = 'ждём phase2-facade: нет модели %s' % model
                print('\n' + '=' * 100)
                print('ФАСАД: %s   [SKIP]' % entry['name'])
                print('  причина: %s' % rec['skip_reason'])
                n_skip_total += 1
                continue
            stem = model.stem
            suffix = stem[len('py2-facade-'):] if stem.startswith('py2-facade-') else ''
            if entry.get('metrics'):
                mpath = Path(entry['metrics'])
            else:
                candidates = []
                if suffix:
                    candidates.append(interior / ('metrics-py2-%s.json' % suffix))
                    candidates.append(interior / ('metrics-%s.json' % stem))
                else:
                    candidates += [interior / ('metrics-%s.json' % stem),
                                   interior / 'metrics-py2-facade.json']
                mpath = next((p for p in candidates if p.exists()), None)
            records = []
            if mpath and mpath.exists():
                try:
                    records = load_facade_metrics(mpath)
                except Exception as exc:  # noqa: BLE001
                    warnings.append('%s: не разобран: %s' % (mpath, exc))
            rec['metrics_file'] = str(mpath) if mpath else None
            fac_rec = match_facade_record(records, model) if records else None
            if not records:
                rec['skip_reason'] = 'нет metrics-*.json (ждём phase2-facade)'
                print('\n' + '=' * 100)
                print('ФАСАД: %s   [SKIP]' % entry['name'])
                print('  причина: %s' % rec['skip_reason'])
                n_skip_total += 1
                continue
            if fac_rec is None:
                rec['skip_reason'] = 'в %s нет записи для %s' % (mpath, model.name)
                print('\n' + '=' * 100)
                print('ФАСАД: %s   [SKIP]' % entry['name'])
                print('  причина: %s' % rec['skip_reason'])
                n_skip_total += 1
                continue
            # облако для печати: если не задано/нет файла — вывести из ref.file метрик
            ref_file = str((fac_rec.get('ref') or {}).get('file') or '')
            if cloud is None or not cloud.exists():
                if ref_file:
                    derived = root / 'interior' / (Path(ref_file).stem + '-facade.bin')
                    if derived.exists():
                        cloud = derived
            if cloud is None or not cloud.exists():
                # последняя попытка: единственный *facade*.bin, в имени которого есть маркер модели
                marker = suffix or Path(ref_file).stem
                if marker:
                    hits = [p for p in (root / 'interior').glob('*facade*.bin') if marker in p.name]
                    if len(hits) == 1:
                        cloud = hits[0]
            stand = rec['stand'] or str(fac_rec.get('stand') or '')
            if not stand:
                low = stem.lower()
                if 'window' in low:
                    stand = 'B3'
                elif 'mapcrop' in low:
                    stand = 'B4'
                else:
                    stand = 'B2'
            rec['stand'] = stand
            rec['cloud'] = str(cloud) if cloud else None
            checks = eval_facade(fac_rec, stand)
            # Блок 1 ROADMAP-DOCS-AI.md: самотесты facade-test.py — отдельные проверки B2/B3/B4
            if args.facade_tests != 'off':
                tchecks, terr = facade_test_checks(facade_tests_report, stand)
                if terr:
                    warnings.append('самотесты фасада (%s): %s' % (stand, terr))
                if tchecks:
                    rec['facade_tests'] = {'report': str(facade_tests_path),
                                           'checks_pass': sum(1 for c in tchecks if c['status'] == 'PASS'),
                                           'checks_fail': sum(1 for c in tchecks if c['status'] == 'FAIL')}
                checks = checks + tchecks
            rec['checks'] = checks
            rec['facade_metrics'] = fac_rec
            cloud_exists = bool(cloud and cloud.exists())
            n_pass, n_fail, n_skip = print_facade_table(entry, checks, fac_rec, mpath, cloud, cloud_exists)
            n_pass_total += n_pass
            n_fail_total += n_fail
            n_skip_total += n_skip
            rec['status'] = 'FAIL' if n_fail else ('PASS' if n_pass else 'SKIP')
            if not cloud_exists and cloud is not None:
                warnings.append('%s: метрики есть, но облако не найдено (%s)' % (entry['name'], cloud))

    print_before_after(results)

    # ------- итог
    print('\n' + '#' * 100)
    print('ИТОГО: PASS %d | FAIL %d | SKIP %d' % (n_pass_total, n_fail_total, n_skip_total))
    if n_fail_total:
        print('ПРОВАЛ: %d проверок ниже порогов ROADMAP-IDEAL (или регрессия). Подробности выше.' % n_fail_total)
    else:
        print('Все проверенные пороги выполнены (SKIP — файлы/метрики ещё не готовы).')
    for e in errors:
        print('ОШИБКА ПРОГОНА: %s' % e)

    # ------- сводный JSON
    report = {
        'tool': 'run-quality-all.py',
        'created_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'root': str(root),
        'workdir': str(workdir),
        'ruler': str(RULER),
        'ruler_version_md5': md5(RULER) if RULER.exists() else None,
        'ruler_runs': ruler_used,
        'thresholds': THRESHOLDS,
        'summary': {'pass': n_pass_total, 'fail': n_fail_total, 'skip': n_skip_total,
                    'exit_code': 1 if (n_fail_total and (not args.no_targets or not args.no_regression)) else 0},
        'entries': results,
        'warnings': warnings,
        'errors': errors,
    }
    out = Path(args.json)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print('JSON-отчёт: %s' % out)

    if args.save_baseline and not args.no_baseline:
        bpath = Path(args.baseline)
        bdata = {'_meta': {'created_at': report['created_at'], 'tool': 'run-quality-all.py',
                           'note': 'эталон для проверки регрессии; обновлять осознанно'},
                 'entries': {}}
        if bpath.exists():
            try:
                prev = json.loads(bpath.read_text(encoding='utf-8-sig'))
                bdata['entries'] = prev.get('entries') or {}
            except Exception:  # noqa: BLE001
                pass
        for r in results:
            if r.get('metrics'):
                bdata['entries'][r['name']] = {'metrics': r['metrics'],
                                               'model': r['model'], 'cloud': r['cloud'],
                                               'created_at': report['created_at']}
        bpath.write_text(json.dumps(bdata, ensure_ascii=False, indent=1), encoding='utf-8')
        print('baseline записан: %s' % bpath)

    if errors and not n_fail_total:
        return 2
    return 1 if n_fail_total else 0


if __name__ == '__main__':
    sys.exit(main())
