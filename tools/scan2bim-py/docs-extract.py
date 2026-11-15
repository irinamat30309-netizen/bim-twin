#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""docs-extract.py — извлечение проектной документации (PDF/ZIP/папка) в docs.json.

Блок 2 ROADMAP-DOCS-AI.md (ИИ-помощник «документация перед BIM»).

Что извлекает автоматически (эвристики + регулярные выражения, всё с указанием страниц):
  * объект/адрес/стадия (титул, титульные блоки, имя файла);
  * отметки этажей (±0,000 / +3,700 / −4,500 ...): полный набор отметок с листов;
  * шаг этажа, толщина плиты/пола, «чистая» высота этажа (по разностям отметок);
  * толщины стен (мурувальні/кладкa листы): частотный ряд 60…800 мм;
  * ширины дверей/воріт и высоты полотен (спецификации, пары «Ш×В»);
  * размеры помещений/коридоров (размерные числа на планах) и ширины коридоров;
  * площади помещений (экспликации): помещения {номер, имя, площадь} + итоговые площади;
  * сетка осей: типовой шаг, общие цепочки/габариты;
  * список листов: план/разрез/фасад/схема/відомість/експлікація + номер листа, масштаб.

Устойчивость:
  * кириллица/UTF-8, «±», «−», узкие пробелы, повторы текста в титульных блоках;
  * страницы-«простыни» без текста (сканы) просто не дают данных — не падаем;
  * битые/зашифрованные PDF пропускаются с предупреждением; таймауты не нужны (PyMuPDF);
  * таблицы НЕ извлекаются через page.find_tables() — на CAD-листах это зависает;
    экспликации восстанавливаются по координатам слов (y-строки, x-колонки).
  * документ на 245 стр./131 МБ обрабатывается ~3–4 минуты (полный проход текста).

CLI:
  python docs-extract.py --input <pdf|zip|dir> --out docs.json [--max-pages N] [--quiet]
  python docs-extract.py --input D:\\BIM-TWIN-TEST\\docs --out D:\\BIM-TWIN-TEST\\docs\\docs.json

Код возврата: 0 — ok; 2 — ошибка входа (нет файла/папки/PDF, -1 данных).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

SCHEMA_VERSION = 1

SHEET_CODE_RE = re.compile(r'^\d{2,3}\s*[-–—]\s*\d{3}\s*[-–—]\s*[А-ЯІЇЄA-Z]{1,3}\s*/')
MARK_RE = re.compile(r'([+\-−±])\s*(\d{1,2})\s*[.,]\s*(\d{3})')
PAIR_RE = re.compile(r'(\d{2,4}(?:[ \u00a0\u202f]\d{3})?)\s*[xх×*]\s*(\d{2,4}(?:[ \u00a0\u202f]\d{3})?)')
SPACED_NUM_RE = re.compile(r'(?<![\d.,])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?![\d.,])')
AREA_M2_RE = re.compile(r'(\d{1,3}(?:[ \u00a0\u202f]\d{3})?[.,]\d{1,2})\s*м\s*[²2]')
SCALE_RE = re.compile(r'М\s*1\s*[:：]\s*(\d{2,4})')
SHEET_INDEX_RE = re.compile(r'^\s*(\d{1,3})\s*$')
ROOM_NO_RE = re.compile(r'^\d{3,4}(?:\.\d{1,2})?$')
DECIMAL_RE = re.compile(r'^\d{1,4}[.,]\d{1,2}$')

TITLE_TYPES = [
    ('plan', re.compile(r'\bплан\b', re.I)),
    ('section', re.compile(r'\bрозр[іi]з\b|\bразрез\b', re.I)),
    ('facade', re.compile(r'\bфасад\b', re.I)),
    ('elevation', re.compile(r'\bрозгортк|\bразвертк', re.I)),
    ('schedule', re.compile(r'\bв[іi]дом[іi]сть\b|\bведомость\b|\bспециф[іi]кац', re.I)),
    ('explication', re.compile(r'\bекспл[іi]кац|\bэкспликац', re.I)),
    ('scheme', re.compile(r'\bсхема\b', re.I)),
    ('detail', re.compile(r'\bвузол\b|\bузел\b', re.I)),
]
TITLE_STOPWORDS = re.compile(r'^(стадія|аркуш|аркушів|зм\.|кільк\.|арк\.|№\s*док\.|підп\.|дата|гап|розробив|перевірив|норм\.?\s*контр)', re.I)


def log(msg: str) -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode('ascii', 'replace').decode('ascii'), flush=True)


def m2mm_str(s: str) -> float:
    """'3 600,13' -> 3600.13."""
    return float(s.replace(' ', '').replace('\u00a0', '').replace('\u202f', '').replace(',', '.'))


def num(s: str) -> int:
    return int(re.sub(r'[^\d]', '', s))


# ------------------------------------------------------------------ вход
def collect_pdfs(input_path: Path):
    """Возвращает (primary_pdf: Path|None, all_pdfs: list[dict], tmpdir) — pdf/zip/dir."""
    tmpdir = None
    if input_path.is_file() and input_path.suffix.lower() == '.pdf':
        pdfs = [input_path]
    elif input_path.is_file() and input_path.suffix.lower() == '.zip':
        tmpdir = tempfile.mkdtemp(prefix='docs_extract_')
        names = []
        with zipfile.ZipFile(input_path) as zf:
            for info in zf.infolist():
                if info.filename.lower().endswith('.pdf'):
                    zf.extract(info, tmpdir)
                    names.append(Path(tmpdir) / info.filename)
        pdfs = names
    elif input_path.is_dir():
        pdfs = sorted([p for p in input_path.rglob('*.pdf') if p.is_file()],
                      key=lambda p: -p.stat().st_size)
    else:
        raise SystemExit('[docs-extract] ОШИБКА: --input должен быть файлом .pdf/.zip или папкой')
    if not pdfs:
        raise SystemExit('[docs-extract] ОШИБКА: PDF-файлы не найдены в %s' % input_path)

    import pymupdf
    all_pdfs = []
    for p in pdfs:
        entry = {'path': str(p), 'size': p.stat().st_size}
        try:
            with pymupdf.open(p) as d:
                entry['pages'] = d.page_count
                entry['title'] = (d.metadata or {}).get('title') or ''
        except Exception as exc:  # noqa: BLE001
            entry['pages'] = None
            entry['error'] = str(exc)
        all_pdfs.append(entry)
    valid = [e for e in all_pdfs if e.get('pages')]
    if not valid:
        raise SystemExit('[docs-extract] ОШИБКА: не удалось открыть ни один PDF')
    # главный документ: максимальный размер × число страниц (основной комплект АР)
    primary = max(valid, key=lambda e: (e['size'] or 0) * (e['pages'] or 1))
    return Path(primary['path']), all_pdfs, tmpdir


# ------------------------------------------------------------------ страницы
def page_title_block(text: str):
    """Титульный блок CAD-листа: код проекта, заголовок, номер листа. Возвращает dict|None."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    title = None
    sheet_no = None
    sheet_total = None
    code = None
    for i, ln in enumerate(lines[:80]):
        if SHEET_CODE_RE.match(ln):
            code = ln
            if i + 1 < len(lines) and len(lines[i + 1]) >= 4 and not TITLE_STOPWORDS.match(lines[i + 1]):
                title = lines[i + 1]
            # номер листа: строка «Р», затем число (в пределах 12 строк)
            for j in range(i + 1, min(i + 14, len(lines) - 1)):
                if lines[j].upper() in ('Р', 'P', 'Р.', 'P.'):
                    for k in range(j + 1, min(j + 4, len(lines))):
                        m = SHEET_INDEX_RE.match(lines[k])
                        if m:
                            sheet_no = int(m.group(1))
                            break
                    break
            break
    return {'code': code, 'title': title, 'sheet_no': sheet_no, 'sheet_total': sheet_total}


def sheet_type(title: str, text: str):
    t = (title or '').lower()
    for name, rx in TITLE_TYPES:
        if rx.search(t):
            return name
    low = (text or '').lower()
    for name, rx in TITLE_TYPES:
        if rx.search(low):
            return name
    return 'other'


def find_marks(text: str):
    """Подписанные отметки: ±0,000 / +3,700 / −4,500 → мм (int)."""
    out = []
    for m in MARK_RE.finditer(text):
        sign = m.group(1)
        val = int(m.group(2)) * 1000 + int(m.group(3))
        if sign in '-−':
            val = -val
        out.append(val)
    return out


# ------------------------------------------------------------------ экспликации по словам
def extract_rooms_from_words(page, page_no: int, min_area=0.5, max_area=3000.0):
    """Восстановление строк экспликации по координатам слов (column-based).

    На CAD-листах таблица экспликации — это несколько блоков «№ | название | площадь»,
    а на плане те же номера/площади стоят вразброс. Поэтому:
      1) ищем колонки номеров помещений (4 цифры с ведущими нулями) — кластеры x;
      2) для каждой колонки ищем колонку площадей правее (x + 150…400 pt);
      3) строка = номер и площадь на одном y (±3 pt), имя — буквенные слова между ними.
    Возвращает (rooms, candidate_areas).
    """
    rooms = []
    areas = []
    try:
        words = page.get_text('words')
    except Exception:  # noqa: BLE001
        return rooms, areas
    if not words:
        return rooms, areas
    width = page.rect.width
    num_cols = []       # (x, [(x,y,txt)...])
    area_tokens = []    # (x,y,value)
    num_tokens = []
    for w in words:
        x0, y0, x1, y1, txt = w[0], w[1], w[2], w[3], w[4]
        if re.fullmatch(r'(0\d{2,3}|1\d{3})(?:\.\d{1,2})?', txt):
            num_tokens.append((x0, y0, txt))
        elif re.fullmatch(r'\d{1,3}[.,]\d{2}', txt):
            try:
                v = float(txt.replace(',', '.'))
            except ValueError:
                continue
            if min_area <= v <= max_area and x0 < width * 0.82:
                area_tokens.append((x0, y0, v))
    if not num_tokens or not area_tokens:
        return rooms, areas
    # кластеры x для номеров (шаг 8 pt), только кластеры с >=3 номерами
    num_by_x = defaultdict(list)
    for x, y, txt in num_tokens:
        num_by_x[round(x / 8.0) * 8].append((x, y, txt))
    area_x_hist = Counter(round(x / 8.0) * 8 for x, y, v in area_tokens)
    used_numbers = set()
    for nx, items in sorted(num_by_x.items()):
        if len(items) < 3:
            continue
        # колонка площадей справа от номеров (+120…+420 pt)
        best = None
        for ax in sorted(area_x_hist):
            if 120 <= ax - nx <= 420 and area_x_hist[ax] >= 3:
                d = abs((ax - nx) - 250)
                if best is None or d < best[0]:
                    best = (d, ax)
        if best is None:
            continue
        area_x = best[1]
        # индекс площадей по y для этой колонки
        by_y = defaultdict(list)
        for x, y, v in area_tokens:
            if abs(x - area_x) <= 16:
                by_y[round(y / 3.0)].append(v)
        names_by_y = defaultdict(list)
        for w in words:
            x, y, txt = w[0], w[1], w[4]
            if nx < x < area_x - 5 and re.search(r'[А-Яа-яІіЇїЄєA-Za-z]{2,}', txt) and not txt.startswith('('):
                names_by_y[round(y / 3.0)].append((x, txt))
        for x, y, txt in items:
            key_y = round(y / 3.0)
            cand_areas = []
            for dy in (0, -1, 1):
                cand_areas.extend(by_y.get(key_y + dy, []))
            if not cand_areas:
                continue
            area = cand_areas[0]
            name_words = []
            for dy in (0, -1, 1):
                name_words.extend(names_by_y.get(key_y + dy, []))
            name = ' '.join(t for _, t in sorted(name_words))[:120].strip(' .,;:')
            dedupe = (txt, round(area, 2))
            if dedupe in used_numbers:
                continue
            used_numbers.add(dedupe)
            if len(name) >= 3:
                rooms.append({'page': page_no, 'number': txt, 'name': name, 'area_m2': round(area, 2)})
            else:
                areas.append(round(area, 2))
    return rooms, areas

# ------------------------------------------------------------------ основной разбор
def analyze(primary: Path, max_pages: int, quiet: bool, arg_max_rooms_pages: int):
    import pymupdf
    t_start = time.time()
    doc = pymupdf.open(primary)
    total_pages = doc.page_count
    scan_pages = total_pages if not max_pages else min(total_pages, max_pages)
    log('[docs-extract] файл: %s' % primary)
    log('[docs-extract] страниц: %d (обрабатываю %d)' % (total_pages, scan_pages))

    texts = []
    for i in range(scan_pages):
        try:
            texts.append(doc[i].get_text('text') or '')
        except Exception as exc:  # noqa: BLE001
            texts.append('')
            log('[docs-extract] ПРЕДУПРЕЖДЕНИЕ: страница %d не прочитана: %s' % (i + 1, exc))
        if not quiet and ((i + 1) % 10 == 0 or i + 1 == scan_pages):
            log('[docs-extract] страницы %d/%d (%d%%)' % (i + 1, scan_pages, int(100 * (i + 1) / scan_pages)))

    sheets = []
    all_marks = []
    all_mark_pages = defaultdict(list)
    floor_title_marks = []
    object_lines = []
    address_lines = []
    explanation_pages = []
    door_pages = []
    window_pages = []
    masonry_pages = []
    plan_pages = []
    for i, t in enumerate(texts):
        pno = i + 1
        tb = page_title_block(t)
        styp = sheet_type(tb.get('title'), t)
        marks = find_marks(t)
        if marks:
            all_marks.extend(marks)
            for mv in set(marks):
                all_mark_pages[mv].append(pno)
        scale = None
        m = SCALE_RE.search(t)
        if m:
            scale = '1:%s' % m.group(1)
        title = tb.get('title') or ''
        # мусорные «заголовки» (даты, числа) отбрасываем
        if title and not re.search(r'[А-Яа-яІіЇїЄєA-Za-z]{3,}', title):
            title = ''
        floor_mark = None
        fms = MARK_RE.findall(title) if title else []
        if fms:
            fm = MARK_RE.search(title)
            if fm:
                sign = fm.group(1)
                v = int(fm.group(2)) * 1000 + int(fm.group(3))
                if sign in '-−':
                    v = -v
                floor_title_marks.append(v)
                floor_mark = ('-' if v < 0 else ('±' if v == 0 else '+')) + ('%d,%03d' % (abs(v) // 1000, abs(v) % 1000))
        if title and tb.get('code'):
            sheets.append({'page': pno, 'sheet_no': tb.get('sheet_no'), 'code': tb.get('code'),
                           'title': title, 'type': styp, 'scale': scale, 'floor_mark': floor_mark})
        # отметки в примечаниях («на відм. +3,700») — как дополнительный источник этажей
        for mm in re.finditer(r'в[іi]дм\.?\s*([+\-−±])\s*(\d{1,2})\s*[.,]\s*(\d{3})', t, re.I):
            sign = mm.group(1)
            v = int(mm.group(2)) * 1000 + int(mm.group(3))
            if sign in '-−':
                v = -v
            floor_title_marks.append(v)
        low = t.lower()
        if 'експл' in low or 'экспликац' in low:
            explanation_pages.append(pno)
        if ('двер' in low or 'ворот' in low) and ('розм[іi]р' in low or 'специф[іi]кац' in low
                                                    or 'в[іi]дом[іi]сть' in low or 'проріз' in low):
            door_pages.append(pno)
        if ('вікн' in low or 'окон' in low) and ('розм[іi]р' in low or 'специф[іi]кац' in low
                                                or 'в[іi]дом[іi]сть' in low):
            window_pages.append(pno)
        is_masonry = ('повнот[іi]ла' in low and 'цегл' in low) or 'мурувальн' in low or 'муруван' in low
        if not is_masonry and title:
            is_masonry = ('муруван' in title.lower() or 'кладк' in title.lower())
        if is_masonry:
            masonry_pages.append(pno)
        if styp == 'plan':
            plan_pages.append(pno)
        if i < 12:
            for ln in t.splitlines():
                ln = ln.strip()
                if not ln:
                    continue
                lowln = ln.lower()
                if ('будівництв' in lowln or 'корпус' in lowln or 'інститут' in lowln) and len(ln) > 25:
                    object_lines.append(ln)
                if 'адрес' in lowln or 'вул.' in lowln or 'ул.' in lowln:
                    if len(ln) > 10:
                        address_lines.append(ln)

    # ---------- объект / адрес ----------
    object_cands = []
    for ln in object_lines:
        for mm in re.finditer(r'«([^»]{15,400})»', ln):
            txt = mm.group(1)
            low = txt.lower()
            score = 0
            if 'будівництв' in low:
                score += 3
            if 'корпус' in low:
                score += 2
            if 'інститут' in low:
                score += 1
            if 'адрес' in ln.lower() or 'вул.' in ln.lower():
                score += 2
            object_cands.append((score, len(txt), txt))
    object_name = ''
    if object_cands:
        object_cands.sort(key=lambda x: (-x[0], -x[1]))
        object_name = object_cands[0][2]
    if not object_name and object_lines:
        object_name = max(object_lines, key=len)
    address = ''
    for ln in address_lines:
        mm = re.search(r'(?:за\s+адресою\s*:?\s*)?(вул\.[^\n]{5,160})', ln)
        if mm:
            address = re.sub(r'\s+', ' ', mm.group(1)).strip(' .,;')
            break
    stage = ''
    for ln in object_lines:
        if 'черг' in ln.lower():
            stage = ln
            break

    # ---------- отметки / этажность / высоты ----------
    marks_sorted = sorted(set(all_marks))
    tm = sorted(set(floor_title_marks))
    # разности между отметками, кратными 100 мм (пол ↔ низ плиты ↔ пол этажа)
    pair_diffs = Counter()
    hund = [m for m in marks_sorted if m % 100 == 0]
    for a in hund:
        for b in hund:
            d = b - a
            if 150 <= d <= 6000:
                pair_diffs[d] += 1

    def mode_in(counter, lo, hi):
        cand = [(d, c) for d, c in counter.items() if lo <= d <= hi]
        if not cand:
            return None
        cand.sort(key=lambda x: (-x[1], x[0]))
        return cand[0][0]

    # шаг этажа: приоритет — отметки из титульных блоков (0 / 3700 / 7400 ...)
    pitch_mm = None
    if len(tm) >= 2:
        td = Counter(b - a for a, b in zip(tm, tm[1:]) if 2500 <= b - a <= 5000)
        if td:
            pitch_mm = max(td.items(), key=lambda kv: (kv[1], kv[0]))[0]
    if pitch_mm is None:
        pitch_mm = mode_in(pair_diffs, 3500, 4500)
    slab_mm = mode_in(pair_diffs, 150, 1000)
    clean_height_mm = mode_in(pair_diffs, 2500, 3500)
    if clean_height_mm is None and pitch_mm and slab_mm:
        clean_height_mm = pitch_mm - slab_mm
    floors_mm = [m for m in marks_sorted if -15000 <= m <= 60000]
    floor_marks_mm = sorted(set(tm)) if len(tm) >= 2 else []
    if len(floor_marks_mm) < 2 and pitch_mm:
        pos = [m for m in floors_mm if 0 <= m <= 60000]
        chain = [pos[0]] if pos else []
        for v in pos[1:]:
            if chain and abs((v - chain[-1]) - pitch_mm) <= 50:
                chain.append(v)
        floor_marks_mm = chain

    # ---------- толщины стен ----------
    wall_counts = Counter()
    for pno in masonry_pages:
        t = texts[pno - 1]
        # толщины на мурувальних планах подписаны отдельными числами-строками
        for ln in t.splitlines():
            ln = ln.strip()
            if re.fullmatch(r'\d{2,4}', ln):
                v = int(ln)
                if 60 <= v <= 800:
                    wall_counts[v] += 1
        for tok in re.findall(r'(?<![\d.,])(\d{2,4})\s*мм', t):
            v = int(tok)
            if 60 <= v <= 800:
                wall_counts[v] += 1
    wall_thicknesses = [v for v, c in sorted(wall_counts.items()) if c >= 2]
    if len(wall_thicknesses) > 12:
        wall_thicknesses = [v for v in wall_thicknesses if wall_counts[v] >= 3]

    # ---------- двери / окна ----------
    door_sizes = Counter()
    for pno in door_pages:
        t = texts[pno - 1]
        for m in PAIR_RE.finditer(t):
            w, h = int(m.group(1)), int(m.group(2))
            if 400 <= w <= 3200 and 1500 <= h <= 3200:
                door_sizes[(w, h)] += 1
    window_sizes = Counter()
    for pno in window_pages:
        t = texts[pno - 1]
        for m in PAIR_RE.finditer(t):
            w, h = int(m.group(1)), int(m.group(2))
            if 300 <= w <= 3200 and 500 <= h <= 3200 and h < 1500:
                window_sizes[(w, h)] += 1
    door_widths = sorted({w for (w, h) in door_sizes if 500 <= w <= 2600})
    door_heights = sorted({h for (w, h) in door_sizes if 1700 <= h <= 2600})
    window_widths = sorted({w for (w, h) in window_sizes if 300 <= w <= 3200})

    # ---------- размеры/оси ----------
    dim_counts = Counter()
    for pno in plan_pages:
        t = texts[pno - 1]
        for m in SPACED_NUM_RE.finditer(t):
            v = num(m.group(1))
            if 300 <= v <= 200000:
                dim_counts[v] += 1
        for tok in re.findall(r'(?<![\d.,])(\d{3,5})(?![\d.,])', t):
            v = int(tok)
            if 1000 <= v <= 60000:
                dim_counts[v] += 1
    axis_pitch_cands = [(v, c) for v, c in dim_counts.items() if 3000 <= v <= 12000]
    axis_pitch_mm = max(axis_pitch_cands, key=lambda x: x[1])[0] if axis_pitch_cands else None
    overall_cands = [(v, c) for v, c in dim_counts.items() if 20000 <= v <= 200000]
    overall_dims = [v for v, c in sorted(overall_cands, key=lambda x: -x[1])[:6]]
    typical_dims = [{'mm': v, 'count': c} for v, c in sorted(dim_counts.items(), key=lambda x: -x[1])[:20]]

    # ---------- экспликации (площади, помещения) ----------
    rooms = []
    room_seen = set()
    page_totals = []
    used_pages = 0
    for pno in explanation_pages:
        if used_pages >= arg_max_rooms_pages:
            break
        try:
            page = doc[pno - 1]
        except Exception:  # noqa: BLE001
            continue
        wr, wa = extract_rooms_from_words(page, pno)
        used_pages += 1
        for r in wr:
            key = (r['number'], round(r['area_m2'], 1))
            if key in room_seen:
                continue
            room_seen.add(key)
            rooms.append(r)
        t = texts[pno - 1]
        page_floor = ''
        tb = page_title_block(t)
        ttl = (tb.get('title') or '')
        fm = re.search(r'в[іi]дм\.?\s*([+\-−±]?\s*\d{1,2}\s*[.,]\s*\d{3})', ttl, re.I)
        if fm:
            page_floor = fm.group(1).replace(' ', '')
        page_total = None
        for m in AREA_M2_RE.finditer(t):
            v = m2mm_str(m.group(1))
            if v >= 200:
                page_total = max(page_total or 0, v)
        page_totals.append({'page': pno, 'floor': page_floor, 'total_area_m2': page_total})
        if not quiet:
            log('[docs-extract] экспликация стр.%d: помещений %d' % (pno, len(wr)))

    room_areas = [r['area_m2'] for r in rooms if r['area_m2'] > 0.3]
    corridor_areas = [r['area_m2'] for r in rooms
                      if 'коридор' in r['name'].lower() or 'корідор' in r['name'].lower()]

    # ---------- список листов ----------
    sheet_types = Counter(s['type'] for s in sheets)
    plan_sheets = [s for s in sheets if s['type'] == 'plan']
    section_sheets = [s for s in sheets if s['type'] == 'section']
    facade_sheets = [s for s in sheets if s['type'] == 'facade']

    limitations = []
    if not object_name:
        limitations.append('объект/адрес не распознан на титульных страницах — проверить вручную')
    if not wall_thicknesses:
        limitations.append('толщины стен не извлечены автоматически (нет мурувальних листов с текстом)')
    if not door_widths:
        limitations.append('ширины дверей не извлечены автоматически (нет спецификаций дверей)')
    if not rooms:
        limitations.append('помещения/площади не извлечены (нет экспликаций с текстовым слоем)')
    if scan_pages < total_pages:
        limitations.append('обработаны не все страницы (--max-pages=%d из %d)' % (scan_pages, total_pages))
    limitations.append('площади помещений и ширины коридоров из планов без экспликаций требуют ручной разметки')

    elapsed = round(time.time() - t_start, 1)
    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'tool': 'docs-extract.py',
        'runtime_s': elapsed,
        'input_pages': total_pages,
        'pages_scanned': scan_pages,
        'source_file': str(primary),
        'object': {
            'name': object_name,
            'address': address,
            'stage': stage,
            'document': os.path.basename(str(primary)),
        },
        'floors': {
            'marks_mm': floors_mm,
            'marks_page_examples': {str(k): v[:6] for k, v in sorted(all_mark_pages.items())},
            'pitch_mm': pitch_mm,
            'slab_or_floor_thickness_mm': slab_mm,
            'clean_height_mm': clean_height_mm,
            'floor_chain_mm': floor_marks_mm,
            'storeys_count': len(floor_marks_mm) if floor_marks_mm else None,
        },
        'walls': {
            'thicknesses_mm': wall_thicknesses,
            'evidence_pages': masonry_pages[:20],
            'counts': {str(k): v for k, v in sorted(wall_counts.items())},
        },
        'doors': {
            'widths_mm': door_widths,
            'heights_mm': door_heights,
            'pairs_wh_mm': [{'w': w, 'h': h, 'count': c} for (w, h), c in door_sizes.most_common(30)],
            'evidence_pages': door_pages[:20],
        },
        'windows': {
            'widths_mm': window_widths,
            'pairs_wh_mm': [{'w': w, 'h': h, 'count': c} for (w, h), c in window_sizes.most_common(20)],
            'evidence_pages': window_pages[:20],
        },
        'axes': {
            'pitch_mm': axis_pitch_mm,
            'overall_dims_mm': overall_dims,
            'typical_dims': typical_dims,
            'plan_pages': plan_pages[:40],
        },
        'rooms': {
            'count': len(rooms),
            'areas_m2': sorted(room_areas),
            'median_area_m2': round(sorted(room_areas)[len(room_areas) // 2], 2) if room_areas else None,
            'corridor_areas_m2': sorted(corridor_areas),
            'sum_area_m2': round(sum(room_areas), 2) if room_areas else None,
            'explication_totals': page_totals,
            'list': rooms[:400],
        },
        'sheets': {
            'count': len(sheets),
            'by_type': dict(sheet_types),
            'plans': plan_sheets,
            'sections': section_sheets,
            'facades': facade_sheets,
            'all': sheets,
        },
        'limitations': limitations,
    }


# ------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Извлечение проектной документации (PDF/ZIP/папка) в docs.json (Блок 2 ROADMAP-DOCS-AI).')
    ap.add_argument('--input', required=True, help='PDF, ZIP или папка с документацией')
    ap.add_argument('--out', required=True, help='куда записать JSON')
    ap.add_argument('--max-pages', type=int, default=0, help='ограничить число страниц главного PDF (0 = все)')
    ap.add_argument('--max-rooms-pages', type=int, default=12, help='сколько страниц экспликаций разбирать по словам')
    ap.add_argument('--quiet', action='store_true', help='без прогресса')
    args = ap.parse_args(argv)

    inp = Path(args.input)
    if not inp.exists():
        log('[docs-extract] ОШИБКА: путь не существует: %s' % inp)
        return 2
    try:
        primary, all_pdfs, tmpdir = collect_pdfs(inp)
    except SystemExit as exc:
        log(str(exc))
        return 2
    try:
        result = analyze(primary, args.max_pages, args.quiet, args.max_rooms_pages)
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        log('[docs-extract] ОШИБКА разбора: %s' % exc)
        return 2
    finally:
        if tmpdir:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    result['inputs'] = all_pdfs
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')

    fl = result['floors']
    log('')
    log('=== ИТОГ docs-extract ===')
    log('объект:           %s' % (result['object']['name'][:100] or '—'))
    log('адрес:            %s' % (result['object']['address'][:100] or '—'))
    log('страниц:          %d (обработано %d, %.1f с)' % (result['input_pages'], result['pages_scanned'], result['runtime_s']))
    log('отметки:          %d уровней; шаг этажа %s мм; плита %s мм; чистая высота %s мм'
        % (len(fl['marks_mm']), fl['pitch_mm'], fl['slab_or_floor_thickness_mm'], fl['clean_height_mm']))
    log('толщины стен:     %s мм' % (result['walls']['thicknesses_mm'] or '—'))
    log('двери (ширины):   %s мм; высоты: %s мм'
        % (result['doors']['widths_mm'] or '—', result['doors']['heights_mm'] or '—'))
    log('оси:              шаг %s мм; габариты %s мм'
        % (result['axes']['pitch_mm'], result['axes']['overall_dims_mm'] or '—'))
    log('помещения:        %d; сумма площадей %s м²; итоги: %s'
        % (result['rooms']['count'], result['rooms']['sum_area_m2'],
           [(t['page'], t['total_area_m2']) for t in result['rooms']['explication_totals'][:6]]))
    log('листы:           %d; по типам: %s' % (result['sheets']['count'], result['sheets']['by_type']))
    log('JSON:             %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())





