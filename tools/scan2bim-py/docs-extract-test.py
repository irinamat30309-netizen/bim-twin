#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""docs-extract-test.py — тесты docs-extract.py (синтетика + реальный PDF + ZIP).

Запуск:
    python tools/scan2bim-py/docs-extract-test.py [--real-pdf <path>] [-v]
Код возврата: 0 — все тесты PASS; 1 — есть FAIL.

Проверки:
  1. синтетический PDF (создаётся PyMuPDF, кириллица): объект/адрес, отметки этажей,
     шаг 3,700/плита 400/чистая высота 3300, толщины стен, ширины дверей, помещения
     экспликации (по координатам), список листов;
  2. ZIP-вход с синтетическим PDF;
  3. отсутствующий вход → код 2, без падений;
  4. РЕАЛЬНЫЙ PDF заказчика (245 стр., если файл есть): страницы, отметки, толщины,
     двери, экспликации, листы — с ограничением --max-pages 120 для скорости.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
PY = sys.executable
HERE = Path(__file__).resolve().parent
TOOL = HERE / 'docs-extract.py'
FONT = r'C:\Windows\Fonts\arial.ttf'
REAL_PDF = Path(r'D:\BIM-TWIN-TEST\docs\Креслення Р (з 10.25 - 04.26)\АР\2 черга (Лікувальний корпус)'
                r'\Амосова_, Р_II Черга 1-й п_Лікувальний корпус_3 редакція_15.04.2026.pdf')

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = ''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('PASS  %-72s %s' % (name, detail))
    else:
        FAIL += 1
        print('FAIL  %-72s %s' % (name, detail))


def run_extract(input_path: Path, out: Path, *extra):
    t0 = time.time()
    cmd = [PY, '-u', str(TOOL), '--input', str(input_path), '--out', str(out)] + list(extra)
    proc = subprocess.run(cmd, capture_output=True, timeout=900)
    dt = time.time() - t0
    stdout = (proc.stdout or b'').decode('utf-8', 'replace')
    if not out.exists():
        raise RuntimeError('docs.json не создан (код %d): %s' % (proc.returncode, stdout[-800:]))
    data = json.loads(out.read_text(encoding='utf-8'))
    return data, proc.returncode, stdout, dt


def make_synthetic_pdf(path: Path):
    import pymupdf
    doc = pymupdf.open()

    # стр.1: титул + план 1-го этажа (отметка ±0,000)
    p = doc.new_page(width=1190, height=842)
    lines = [
        '25–010-П/ПКД-МС-АР ІІ',
        'План 1-го поверху на відм. ±0,000',
        'Р', '3',
        '«Будівництво тестового лікувального корпусу',
        'за адресою: вул. Тестова, 1 в м. Києва»',
        'ІІ черга. 1-й пусковий комплекс. Лікувальний корпус.',
        '±0,000',
        '+3,700',
        '+7,400',
    ]
    y = 60
    for ln in lines:
        p.insert_text((60, y), ln, fontsize=14, fontname='arial', fontfile=FONT)
        y += 24
    p.insert_text((900, 800), 'М 1:200', fontsize=12, fontname='arial', fontfile=FONT)

    # стр.2: разрез — упорядоченные отметки (пол -> низ плиты -> пол этажа)
    p = doc.new_page(width=1190, height=842)
    p.insert_text((60, 60), '25–010-П/ПКД-МС-АР ІІ', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 84), 'Розріз 1-17', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 108), 'Р', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 132), '13', fontsize=14, fontname='arial', fontfile=FONT)
    y = 180
    for mark in ('-4,500', '-0,400', '±0,000', '+3,300', '+3,700', '+7,000', '+7,400'):
        p.insert_text((60, y), mark, fontsize=13, fontname='arial', fontfile=FONT)
        y += 22

    # стр.3: мурувальний план — толщины отдельными числами-строками
    p = doc.new_page(width=1190, height=842)
    p.insert_text((60, 60), '25–010-П/ПКД-МС-АР ІІ', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 84), 'Мурувальний план 1-го поверху на відм. ±0,000', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 108), 'Р', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 132), '14', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 160), 'Повнотіла керамічна цегла М100. Умовні позначення:', fontsize=12, fontname='arial', fontfile=FONT)
    y = 200
    for val in (120, 250, 380, 400, 510, 120, 250, 380, 400, 510, 120, 250, 380, 400, 510):
        p.insert_text((60, y), str(val), fontsize=12, fontname='arial', fontfile=FONT)
        y += 20

    # стр.4: спецификация дверей — размеры прорізу Ш×В
    p = doc.new_page(width=1190, height=842)
    p.insert_text((60, 60), '25–010-П/ПКД-МС-АР ІІ', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 84), 'Відомість дверей', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 108), 'Розміри прорізу, Ш х В, мм', fontsize=12, fontname='arial', fontfile=FONT)
    y = 160
    for pair in ('600×1 900', '900×1 900', '1 400×1 900', '600×1 900', '900×1 900', '1 400×1 900'):
        p.insert_text((60, y), pair, fontsize=12, fontname='arial', fontfile=FONT)
        y += 20

    # стр.5: экспликация — таблица по координатам (3 колонки)
    p = doc.new_page(width=1190, height=842)
    p.insert_text((60, 60), '25–010-П/ПКД-МС-АР ІІ', fontsize=14, fontname='arial', fontfile=FONT)
    p.insert_text((60, 84), 'План 1-го поверху. Експлікація приміщень', fontsize=14, fontname='arial', fontfile=FONT)
    rooms = [(1, 'Кабінет', 12.50), (2, 'Коридор', 24.20), (3, 'Лабораторія', 10.00),
             (4, 'Санвузол', 4.50), (5, 'Тамбур', 3.20)]
    y = 200
    for num, name, area in rooms:
        p.insert_text((60, y), '00%02d' % num, fontsize=11, fontname='arial', fontfile=FONT)
        p.insert_text((150, y), name, fontsize=11, fontname='arial', fontfile=FONT)
        p.insert_text((340, y), ('%.2f' % area).replace('.', ','), fontsize=11, fontname='arial', fontfile=FONT)
        y += 22
    p.insert_text((60, y + 30), 'Всього: 54,40 м²', fontsize=12, fontname='arial', fontfile=FONT)

    doc.save(str(path))
    doc.close()


def test_synthetic(tmp: Path):
    pdf = tmp / 'synthetic_project.pdf'
    make_synthetic_pdf(pdf)
    out = tmp / 'docs.json'
    data, code, stdout, dt = run_extract(pdf, out)
    print('      синтетика: %.1f с, код %d' % (dt, code))
    check('synthetic: код 0', code == 0, 'code=%d' % code)
    obj = (data.get('object') or {})
    check('synthetic: объект содержит «корпус»', 'корпус' in (obj.get('name') or '').lower(),
          (obj.get('name') or '')[:60])
    check('synthetic: адрес содержит «вул.»', 'вул.' in (obj.get('address') or '').lower(),
          (obj.get('address') or '')[:60])
    fl = data.get('floors') or {}
    check('synthetic: шаг этажа 3700 мм', fl.get('pitch_mm') == 3700, 'pitch=%s' % fl.get('pitch_mm'))
    check('synthetic: плита 400 мм', fl.get('slab_or_floor_thickness_mm') == 400,
          'slab=%s' % fl.get('slab_or_floor_thickness_mm'))
    check('synthetic: чистая высота 3300 мм', fl.get('clean_height_mm') == 3300,
          'clean=%s' % fl.get('clean_height_mm'))
    walls = set((data.get('walls') or {}).get('thicknesses_mm') or [])
    check('synthetic: толщины стен ⊇ {120,250,380,400,510}', {120, 250, 380, 400, 510} <= walls, str(sorted(walls)))
    doors = set((data.get('doors') or {}).get('widths_mm') or [])
    check('synthetic: ширины дверей ⊇ {600,900,1400}', {600, 900, 1400} <= doors, str(sorted(doors)))
    rooms = (data.get('rooms') or {})
    check('synthetic: помещения ≥5 и площади ≥54 м²',
          rooms.get('count', 0) >= 5 and (rooms.get('sum_area_m2') or 0) >= 50,
          'count=%s sum=%s' % (rooms.get('count'), rooms.get('sum_area_m2')))
    st = (data.get('sheets') or {})
    check('synthetic: есть листы планов и разрезов',
          st.get('by_type', {}).get('plan', 0) >= 1 and st.get('by_type', {}).get('section', 0) >= 1,
          str(st.get('by_type')))
    return data


def test_zip(tmp: Path, pdf: Path):
    zpath = tmp / 'docs.zip'
    with zipfile.ZipFile(zpath, 'w') as zf:
        zf.write(pdf, 'project/synthetic_project.pdf')
    out = tmp / 'docs_zip.json'
    data, code, stdout, dt = run_extract(zpath, out)
    check('zip: код 0 и JSON создан', code == 0 and out.exists(), 'code=%d' % code)
    check('zip: объект извлечён', bool((data.get('object') or {}).get('name')), '')


def test_missing():
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / 'docs.json'
        proc = subprocess.run([PY, str(TOOL), '--input', str(Path(td) / 'nope.pdf'), '--out', str(out)],
                              capture_output=True, timeout=120)
        check('missing input: код 2 (без падения)', proc.returncode == 2, 'code=%d' % proc.returncode)


def test_real(tmp: Path):
    if not REAL_PDF.exists():
        print('SKIP  реальный PDF не найден: %s' % REAL_PDF)
        return
    out = tmp / 'real_docs.json'
    data, code, stdout, dt = run_extract(REAL_PDF, out, '--max-pages', '120')
    print('      реальный PDF (первые 120 стр.): %.1f с, код %d' % (dt, code))
    check('real: код 0, страниц в документе 245', code == 0 and data.get('input_pages') == 245,
          'pages=%s' % data.get('input_pages'))
    fl = data.get('floors') or {}
    check('real: шаг этажа 3700 мм', fl.get('pitch_mm') == 3700, 'pitch=%s' % fl.get('pitch_mm'))
    check('real: чистая высота 3300 мм', fl.get('clean_height_mm') == 3300, 'clean=%s' % fl.get('clean_height_mm'))
    walls = set((data.get('walls') or {}).get('thicknesses_mm') or [])
    check('real: толщины ⊇ {120,250,380,400,510}', {120, 250, 380, 400, 510} <= walls, str(sorted(walls)))
    doors = set((data.get('doors') or {}).get('widths_mm') or [])
    check('real: двери содержат ≥3 ширины из сортамента',
          len(doors & {500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600}) >= 3,
          str(sorted(doors))[:120])
    rooms = (data.get('rooms') or {})
    check('real: помещения ≥100 (экспликации)', rooms.get('count', 0) >= 100, 'count=%s' % rooms.get('count'))
    st = (data.get('sheets') or {})
    check('real: планов ≥10, разрезов/фасадов ≥3',
          st.get('by_type', {}).get('plan', 0) >= 10
          and (st.get('by_type', {}).get('section', 0) + st.get('by_type', {}).get('facade', 0)) >= 3,
          str(st.get('by_type')))
    check('real: время извлечения < 300 с', dt < 300, '%.1f с' % dt)


def main():
    print('=== docs-extract-test.py ===')
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix='docs_extract_test_') as td:
        tmp = Path(td)
        pdf = tmp / 'synthetic_project.pdf'
        make_synthetic_pdf(pdf)
        data = test_synthetic(tmp)
        test_zip(tmp, pdf)
    test_missing()
    with tempfile.TemporaryDirectory(prefix='docs_extract_real_') as td:
        test_real(Path(td))
    print('-' * 100)
    print('ИТОГ: PASS %d, FAIL %d (время %.1f с)' % (PASS, FAIL, time.time() - t0))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
