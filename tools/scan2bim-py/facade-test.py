# -*- coding: utf-8 -*-
"""facade-test.py — самопроверяемые автотесты фасадного режима (Блок 1 ROADMAP-DOCS-AI.md).

Что делает (без внешних ожиданий — все пороги внутри):
  1. запускает `scan2bim-v2.py --mode=facade` на реальных облаках:
       * B2 `map-120-facade.bin`  → этажей 5, шаг 3.700 м, окна [5,6,5,4,5], recall ≥ 95 %, IoU ≥ 70 %;
       * B3 `map-window-facade.bin` → этажей 5, шаг 3.690 м, окна [3,6,12,5,5], recall ≥ 95 %, IoU ≥ 65 %;
       * B4 `map-mapcrop-facade.bin` → прогон без падений, время ≤ 600 с;
  2. сверяет измеренный шаг с проектной документацией: шаг этажа 3 700 мм
     (2-й этаж +3.700, 3-й +7.400, отметки 1-го ±0.000, подвал −4.500), допуск ±10 мм;
  3. сверяет окна с эталонными замерами `scan2bim-realmeasure.js` (recall/IoU по маскам 5 см);
  4. печатает PASS/FAIL по каждой проверке, exit 1 при FAIL, пишет `facade-tests-report.json`
     (его читает `run-quality-all.py` как дополнительный источник проверок B2/B3/B4).

Запуск:
  $py facade-test.py [--root D:\\BIM-TWIN-TEST\\interior] [--out ...] [--timeout 900] [--reuse]
  --reuse — не перезапускать движок, взять уже готовые модели facade-test-*.json (быстрый CTRL-прогон).

Код возврата: 0 — все PASS; 1 — есть FAIL; 2 — окружение (нет bin/ref/движка).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent          # bim-twin/tools/scan2bim-py
REPO_DIR = SCRIPT_DIR.parents[1]                      # bim-twin
ENGINE = SCRIPT_DIR / 'scan2bim-v2.py'
FACADE_CHECK = SCRIPT_DIR / 'facade-check.py'
DEFAULT_ROOT = Path(r'D:\BIM-TWIN-TEST') / 'interior'
DEFAULT_OUT = 'facade-tests-report.json'

# Проектная документация (АР, «Лікувально-реабілітаційний корпус», 245 стр.):
# отметки из планов/мурувальних планів: подвал −4,500; 1-й ±0,000; 2-й +3,700; 3-й +7,400;
# 4-й +11,100; 5-й +14,800; 6-й +18,500; 7-й +22,200; 8-й +25,900; 9-й (тех.) +29,600 (+30,100);
# шаг этажа 3 700 мм (чистая высота 3 300 + плита/пол 400).
PROJECT = {
    'pitch_mm': 3700.0,
    'pitch_tol_mm': 10.0,
    'basement_mm': -4500.0,
    'above_ground_levels': 9,           # 8 обычных + технический 9-й
    'levels_mm': [('подвал', -4500.0), ('1-й', 0.0), ('2-й', 3700.0), ('3-й', 7400.0),
                  ('4-й', 11100.0), ('5-й', 14800.0), ('6-й', 18500.0),
                  ('7-й', 22200.0), ('8-й', 25900.0), ('9-й (тех.)', 29600.0)],
    'source': 'D:\\BIM-TWIN-TEST\\docs\\Креслення Р (з 10.25 - 04.26)\\АР\\2 черга (Лікувальний корпус)'
              '\\Амосова_, Р_II Черга 1-й п_Лікувальний корпус_3 редакція_15.04.2026.pdf; '
              'стр. 4/5 (планы подвала/1-го этажа), р.21–26 (планы 1–5 поверху), '
              'мурувальні плани 2-го (+3,700) и 3-го (+7,400)',
}

# n.b. «в проекте 5 надземных уровней» — это планы 1–5 поверху на стр. 22–26 (листы демонтажа);
# полный проект — 9 надземных уровней (1–8 + тех. 9-й) и кровля, см. PROJECT.

CASES = [
    {
        'name': 'map-120', 'stand': 'B2',
        'bin': 'map-120-facade.bin', 'ref': 'ref-facade-map-120.json',
        'model': 'facade-test-map-120.json',
        'expect_floors': 5,
        'expect_pitch': 3.700, 'pitch_tol': 0.010,
        'expect_wpf': [5, 6, 5, 4, 5],
        'min_recall': 95.0, 'min_iou': 70.0,
        'project': True,
    },
    {
        'name': 'map-window', 'stand': 'B3',
        'bin': 'map-window-facade.bin', 'ref': 'ref-facade-window.json',
        'model': 'facade-test-map-window.json',
        'expect_floors': 5,
        'expect_pitch': 3.690, 'pitch_tol': 0.010,
        'expect_wpf': [3, 6, 12, 5, 5],
        'min_recall': 95.0, 'min_iou': 65.0,
        'project': True,
    },
    {
        'name': 'map-crop20', 'stand': 'B4',
        'bin': 'map-mapcrop-facade.bin', 'ref': None,
        'model': 'facade-test-mapcrop.json',
        'no_crash': True, 'max_time_s': 600.0,
        'project': False,
    },
]


# ---------------------------------------------------------------- инфраструктура
def _chk(code, label, expected, actual, ok, unit=''):
    return {'code': code, 'label': label, 'expected': str(expected),
            'actual': str(actual), 'unit': unit,
            'status': 'PASS' if ok else 'FAIL'}


def _info(code, label, detail):
    return {'code': code, 'label': label, 'expected': '—', 'actual': str(detail),
            'unit': '', 'status': 'INFO'}


def load_facade_check():
    if not FACADE_CHECK.exists():
        return None
    spec = importlib.util.spec_from_file_location('facade_check_mod', str(FACADE_CHECK))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def measure_against_ref(model, ref, fc):
    """recall/precision/IoU/window-recall модели относительно эталонных замеров (как facade-check.py)."""
    M, cell, bb, gw, gh = fc.masks_from_ref(ref)
    ops = fc.model_openings(model, ref)
    O = fc.paint_openings(ops, cell, bb, gw, gh)
    import numpy as np
    inter = int(np.count_nonzero(M & O))
    mM = int(np.count_nonzero(M))
    mO = int(np.count_nonzero(O))
    u_min, u_max, v_min, v_max = bb
    matched = 0
    for h in ref['holes']:
        cu = (h['u0'] + h['u1']) / 2.0
        cv = (h['v0'] + h['v1']) / 2.0
        for o in ops:
            if abs(o['u'] - cu) <= max(0.8, h['w'] / 2.0) and abs((o['v0'] + o['v1']) / 2.0 - cv) < 1.2:
                matched += 1
                break
    return {
        'recall': 100.0 * inter / mM if mM else 0.0,
        'precision': 100.0 * inter / mO if mO else 0.0,
        'iou': 100.0 * inter / (mM + mO - inter) if (mM + mO - inter) else 0.0,
        'window_recall': 100.0 * matched / max(1, len(ref['holes'])),
        'ref_windows': len(ref['holes']), 'matched_windows': matched,
        'model_windows': sum(len(w.get('openings') or []) for w in (model.get('walls') or [])),
        'cell': cell,
    }


def pitch_from_storeys(model):
    floors = sorted(float(s['floorY']) for s in model.get('storeys') or [])
    if len(floors) < 2:
        return None, floors
    diffs = [b - a for a, b in zip(floors[:-1], floors[1:]) if 1.0 < b - a < 10.0]
    return (sum(diffs) / len(diffs)), floors


def run_engine(case, root, timeout):
    bin_path = root / case['bin']
    model_path = root / case['model']
    if not bin_path.exists():
        return None, 0.0, 'нет облака %s' % bin_path
    t0 = time.time()
    try:
        proc = subprocess.run([sys.executable, str(ENGINE), str(bin_path), str(model_path), '--mode=facade'],
                              capture_output=True, text=True, timeout=timeout, cwd=str(SCRIPT_DIR))
    except subprocess.TimeoutExpired:
        return None, time.time() - t0, 'движок не уложился в %s с' % timeout
    elapsed = time.time() - t0
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or '').strip().splitlines()[-3:]
        return None, elapsed, 'движок вернул код %d: %s' % (proc.returncode, ' | '.join(tail))
    if not model_path.exists():
        return None, elapsed, 'движок не записал JSON %s' % model_path
    try:
        model = json.loads(model_path.read_text(encoding='utf-8-sig'))
    except Exception as exc:  # noqa: BLE001
        return None, elapsed, 'JSON модели не разобран: %s' % exc
    if not model.get('ok'):
        return None, elapsed, 'модель ok=false'
    return model, elapsed, None


# ---------------------------------------------------------------- проверки кейса
def eval_case(case, root, fc, reuse):
    checks = []
    bin_path = root / case['bin']
    ref = None
    if case.get('ref'):
        ref_path = root / case['ref']
        if not ref_path.exists():
            return [ _chk(case['stand'] + '-env', 'эталон замеров', 'файл', 'нет %s' % ref_path, False) ], None, 0.0
        ref = json.loads(ref_path.read_text(encoding='utf-8-sig'))

    model = None
    elapsed = 0.0
    err = None
    reused = False
    if reuse:
        mp = root / case['model']
        if mp.exists():
            try:
                model = json.loads(mp.read_text(encoding='utf-8-sig'))
                reused = True
            except Exception as exc:  # noqa: BLE001
                err = 'готовый JSON не разобран: %s' % exc
        else:
            err = 'нет готовой модели %s (--reuse)' % mp
    if model is None and err is None:
        model, elapsed, err = run_engine(case, root, case.get('timeout', 900))

    # --- B4: устойчивость и время (до проверок качества)
    if case.get('no_crash'):
        ok = err is None
        checks.append(_chk(case['stand'] + '-run', 'движок: без падений', 'код 0 + JSON',
                           ('готовая модель (--reuse)' if reused else 'успех') if ok else ('ОШИБКА: ' + str(err)), ok))
        if not ok:
            return checks, model, elapsed
        if reused:
            checks.append(_info(case['stand'] + '-time', 'время прогона (--reuse)',
                                'не измерялось — модель взята готовой'))
        else:
            checks.append(_chk(case['stand'] + '-time', 'время прогона', '≤ %d с' % int(case['max_time_s']),
                               '%.2f с' % elapsed, elapsed <= case['max_time_s']))
        checks.append(_info(case['stand'] + '-m', 'найдено на кропе',
                            'этажей %d, окон %d, fallback=%s' % (
                                len(model.get('storeys') or []),
                                sum(len(w.get('openings') or []) for w in (model.get('walls') or [])),
                                bool((model.get('facade') or {}).get('fallback')))))
        return checks, model, elapsed

    if err is not None:
        checks.append(_chk(case['stand'] + '-run', 'движок: без падений', 'код 0 + JSON', 'ОШИБКА: ' + err, False))
        return checks, None, elapsed

    # --- общие данные модели
    storeys = model.get('storeys') or []
    fac = model.get('facade') or {}
    floors = len(storeys)
    wpf = fac.get('windowsPerFloor') or [s.get('windows') for s in storeys]
    windows = sum(int(x or 0) for x in wpf)
    pitch, floor_list = pitch_from_storeys(model)
    checks.append(_chk(case['stand'] + '-run', 'движок: без падений', 'код 0 + JSON',
                       ('готовая модель (--reuse)' if reused else 'успех, %.2f с' % elapsed), True))
    checks.append(_chk(case['stand'] + '-floors', 'этажей', str(case['expect_floors']), floors,
                       floors == case['expect_floors']))
    # шаг: и против задания, и против проекта (документация)
    pitch_ok = (pitch is not None and abs(pitch - case['expect_pitch']) <= case['pitch_tol'] + 1e-9)
    checks.append(_chk(case['stand'] + '-pitch', 'шаг этажа (задание)',
                       '%.3f ± %.3f м' % (case['expect_pitch'], case['pitch_tol']),
                       ('%.3f м' % pitch) if pitch is not None else 'нет', pitch_ok, 'м'))
    if case.get('project'):
        d_mm = abs(pitch - PROJECT['pitch_mm'] / 1000.0) * 1000.0 if pitch is not None else None
        checks.append(_chk(case['stand'] + '-proj-pitch', 'шаг vs проект 3 700 мм',
                           'Δ ≤ %.0f мм' % PROJECT['pitch_tol_mm'],
                           ('Δ %.2f мм (%.3f м)' % (d_mm, pitch)) if d_mm is not None else 'нет',
                           d_mm is not None and d_mm <= PROJECT['pitch_tol_mm'] + 1e-9, 'мм'))
        checks.append(_info(case['stand'] + '-proj-floors', 'этажи vs проект',
                            '%d из %d надземных уровней (облако — часть здания)' % (
                                floors, PROJECT['above_ground_levels'])))
    checks.append(_chk(case['stand'] + '-wpf', 'окна по этажам', str(case['expect_wpf']), str(wpf),
                       [int(x or 0) for x in wpf] == case['expect_wpf']))
    if case.get('expect_wpf'):
        checks.append(_chk(case['stand'] + '-win', 'окон всего', str(sum(case['expect_wpf'])), windows,
                           windows == sum(case['expect_wpf'])))

    # --- сверка с эталонными замерами
    if ref is not None and fc is not None:
        m = measure_against_ref(model, ref, fc)
        checks.append(_chk(case['stand'] + '-ref-win', 'окон vs эталон замеров',
                           str(m['ref_windows']), '%d/%d' % (m['matched_windows'], m['ref_windows']),
                           m['matched_windows'] == m['ref_windows']))
        checks.append(_chk(case['stand'] + '-recall', 'recall окон (маски 5 см)',
                           '≥ %.0f %%' % case['min_recall'], '%.2f %%' % m['recall'],
                           m['recall'] >= case['min_recall'], '%'))
        checks.append(_chk(case['stand'] + '-iou', 'IoU окон (маски 5 см)',
                           '≥ %.0f %%' % case['min_iou'], '%.2f %%' % m['iou'],
                           m['iou'] >= case['min_iou'], '%'))
        checks.append(_info(case['stand'] + '-precision', 'precision окон',
                            '%.2f %% (window-recall %.1f %%)' % (m['precision'], m['window_recall'])))
    return checks, model, elapsed


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Автотесты фасадного режима Python-движка (Блок 1 ROADMAP-DOCS-AI.md).')
    ap.add_argument('--root', default=str(DEFAULT_ROOT), help='каталог облаков/эталонов (по умолчанию %(default)s)')
    ap.add_argument('--out', default=None, help='JSON-итог (по умолчанию <root>\\facade-tests-report.json)')
    ap.add_argument('--timeout', type=float, default=900.0, help='таймаут одного прогона движка, с')
    ap.add_argument('--reuse', action='store_true', help='не перезапускать движок (взять facade-test-*.json)')
    args = ap.parse_args(argv)

    root = Path(args.root)
    out = Path(args.out) if args.out else (root / DEFAULT_OUT)
    fc = load_facade_check()
    if not ENGINE.exists():
        print('ОШИБКА: нет движка %s' % ENGINE, file=sys.stderr)
        return 2
    if fc is None:
        print('ОШИБКА: нет скрипта сверки %s' % FACADE_CHECK, file=sys.stderr)
        return 2

    print('=' * 100)
    print('АВТОТЕСТЫ ФАСАДА (Блок 1 ROADMAP-DOCS-AI.md) — Python-движок --mode=facade')
    print('дата: %s | python: %s | корень: %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                                                  sys.version.split()[0], root))
    print('проект: шаг этажа %.0f мм (подвал %.0f, 1-й 0,00, 2-й +3,700, 3-й +7,400); надземных уровней %d' % (
        PROJECT['pitch_mm'], PROJECT['basement_mm'], PROJECT['above_ground_levels']))
    print('=' * 100)

    results = []
    env_errors = []
    for i, case in enumerate(CASES, 1):
        case = dict(case)
        case['timeout'] = args.timeout
        print('\n[%d/%d] %s %s (%s)' % (i, len(CASES), case['stand'], case['name'], case['bin']))
        checks, model, elapsed = eval_case(case, root, fc, args.reuse)
        if not model and not checks:
            env_errors.append('%s: нет модели' % case['name'])
        rec = {'name': case['name'], 'stand': case['stand'],
               'bin': str(root / case['bin']), 'model': str(root / case['model']),
               'elapsed_s': round(elapsed, 2), 'checks': checks,
               'pass': bool(checks) and all(c['status'] != 'FAIL' for c in checks),
               'checks_pass': sum(1 for c in checks if c['status'] == 'PASS'),
               'checks_fail': sum(1 for c in checks if c['status'] == 'FAIL')}
        results.append(rec)
        for c in checks:
            print('  %-5s %-32s %-22s %-28s %s' % (c['status'], c['label'], c['expected'],
                                                   c['actual'], c['code']))
        print('  ИТОГ %s: %s' % (case['name'], 'PASS' if rec['pass'] else 'FAIL'))

    n_pass = sum(1 for r in results if r['pass'])
    n_fail = len(results) - n_pass
    checks_pass = sum(r['checks_pass'] for r in results)
    checks_fail = sum(r['checks_fail'] for r in results)
    print('\n' + '=' * 100)
    print('ИТОГ: кейсов PASS %d | FAIL %d | проверок PASS %d | FAIL %d' % (n_pass, n_fail, checks_pass, checks_fail))
    if env_errors:
        for e in env_errors:
            print('ОКРУЖЕНИЕ: %s' % e)
    print('=' * 100)

    report = {
        'tool': 'facade-test.py',
        'version': 1,
        'created_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'root': str(root),
        'engine': str(ENGINE),
        'project': PROJECT,
        'cases': results,
        'summary': {
            'cases': len(results), 'cases_pass': n_pass, 'cases_fail': n_fail,
            'checks_pass': checks_pass, 'checks_fail': checks_fail,
            'ok': n_fail == 0,
            'exit_code': 0 if n_fail == 0 else 1,
        },
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print('JSON: %s' % out)
    if env_errors:
        return 2
    return 0 if n_fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
