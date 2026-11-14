# -*- coding: utf-8 -*-
"""Валидация IFC4-файла, собранного Scan2BIM (renderer/scan2bim.js → toIFC).

Проверки:
  1) ifcopenshell.validate (штатный валидатор библиотеки; уровень ERROR — блокирующий);
  2) число аргументов у каждого экземпляра сверяется с EXPRESS-схемой IFC4 — ловит
     случаи, которые штатный валидатор пропускает (лишний/недостающий аргумент);
  3) инвентарь сущностей (стены/проёмы/окна/двери/перекрытия/помещения/стили);
  4) геопривязка: IfcProjectedCRS / IfcMapConversion (Readback через ifcopenshell).

Использование:
    python validate-ifc.py file.ifc [--json report.json] [--verbose]

Код возврата: 0 — нет ERROR и нет расхождений арности; 1 — есть проблемы; 2 — файл не читается.
"""
import argparse
import json
import re
import sys
from collections import Counter

import ifcopenshell
import ifcopenshell.validate


INVENTORY_TYPES = [
    'IfcWall', 'IfcWallStandardCase', 'IfcDoor', 'IfcWindow', 'IfcOpeningElement',
    'IfcSlab', 'IfcSpace', 'IfcBuildingStorey', 'IfcBeam', 'IfcColumn', 'IfcPipeSegment',
    'IfcBuildingElementProxy', 'IfcSurfaceStyle', 'IfcSurfaceStyleRendering',
    'IfcStyledItem', 'IfcRelVoidsElement', 'IfcRelFillsElement',
    'IfcProjectedCRS', 'IfcMapConversion',
]


def split_step_args(body):
    """Разбивает тело экземпляра STEP на аргументы верхнего уровня."""
    args, cur, depth, i, n = [], [], 0, 0, len(body)
    while i < n:
        ch = body[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if body[j] == "'":
                    if j + 1 < n and body[j + 1] == "'":  # экранированная кавычка ''
                        j += 2
                        continue
                    break
                j += 1
            cur.append(body[i:j + 1])
            i = j + 1
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ',' and depth == 0:
            args.append(''.join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    tail = ''.join(cur).strip()
    if tail or args:
        args.append(tail)
    return args


def check_arity(ifc_text):
    """Сверяет число аргументов каждого экземпляра с EXPRESS-схемой. Возвращает список расхождений."""
    schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name('IFC4')
    attr_cache = {}
    mismatches = []
    for lineno, line in enumerate(ifc_text.splitlines(), 1):
        m = re.match(r'^#(\d+)\s*=\s*(IFC[A-Z0-9]+)\s*\((.*)\)\s*;\s*$', line)
        if not m:
            continue
        eid, etype, body = m.group(1), m.group(2), m.group(3)
        if etype not in attr_cache:
            try:
                attr_cache[etype] = len(list(schema.declaration_by_name(etype).all_attributes()))
            except Exception:  # noqa: BLE001 — сущность без объявления в схеме
                attr_cache[etype] = None
        expected = attr_cache[etype]
        if expected is None:
            continue
        got = len(split_step_args(body))
        if got != expected:
            mismatches.append({'id': int(eid), 'type': etype, 'line': lineno,
                               'expected': expected, 'got': got})
    return mismatches


def georef_info(f):
    crs = f.by_type('IfcProjectedCRS')
    mc = f.by_type('IfcMapConversion')
    info = {'projectedCrs': None, 'mapConversion': None}
    if crs:
        c = crs[0]
        info['projectedCrs'] = {'name': c.Name, 'description': (c.Description or '')[:120],
                                'mapUnit': c.MapUnit.is_a() if c.MapUnit else None}
    if mc:
        m = mc[0]
        info['mapConversion'] = {
            'sourceCRS': m.SourceCRS.is_a() if m.SourceCRS else None,
            'targetCRS': m.TargetCRS.is_a() if m.TargetCRS else None,
            'eastings': m.Eastings, 'northings': m.Northings,
            'orthogonalHeight': m.OrthogonalHeight,
            'xAxisAbscissa': m.XAxisAbscissa, 'xAxisOrdinate': m.XAxisOrdinate,
            'scale': m.Scale,
        }
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description='Валидация IFC4 из Scan2BIM')
    ap.add_argument('ifc')
    ap.add_argument('--json', dest='json_out', default=None)
    ap.add_argument('--verbose', action='store_true', help='печатать все замечания валидатора')
    args = ap.parse_args(argv)

    try:
        f = ifcopenshell.open(args.ifc)
    except Exception as exc:  # noqa: BLE001
        print('НЕ ЧИТАЕТСЯ: %s (%s)' % (args.ifc, exc))
        return 2

    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, logger)
    statements = [{'level': str(s.get('level', '')).upper(), 'message': str(s.get('message', ''))}
                  for s in logger.statements]
    counts = dict(Counter(s['level'] for s in statements))

    with open(args.ifc, 'r', encoding='utf-8', errors='replace') as fh:
        text = fh.read()
    mismatches = check_arity(text)
    inventory = {}
    for name in INVENTORY_TYPES:
        try:
            inventory[name] = len(f.by_type(name))
        except Exception:  # noqa: BLE001 — сущность не входит в IFC4
            inventory[name] = 0
    inventory = {k: v for k, v in inventory.items() if v}
    geo = georef_info(f)
    errors = counts.get('ERROR', 0)
    ok = errors == 0 and not mismatches

    print('файл:        %s' % args.ifc)
    print('schema:      %s | instances: %d | bytes: %d' % (f.schema, len(list(f)), len(text)))
    print('валидатор:   %s' % json.dumps(counts, sort_keys=True))
    print('арность:     %s' % ('OK (все экземпляры = схеме IFC4)' if not mismatches
                               else '%d расхождений' % len(mismatches)))
    for mm in mismatches[:20]:
        print('  #%d %s: аргументов %d, по схеме %d (строка %d)' % (
            mm['id'], mm['type'], mm['got'], mm['expected'], mm['line']))
    if args.verbose:
        for st in statements:
            print('  [%s] %s' % (st['level'], st['message']))
    print('инвентарь:   %s' % json.dumps(inventory, sort_keys=True))
    if geo['projectedCrs'] or geo['mapConversion']:
        print('геопривязка: %s' % json.dumps(geo, ensure_ascii=False))

    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as fh:
            json.dump({'file': args.ifc, 'schema': f.schema, 'instances': len(list(f)),
                       'validator': counts, 'statements': statements,
                       'arityMismatches': mismatches, 'inventory': inventory,
                       'georef': geo}, fh, ensure_ascii=False, indent=1)

    print('ИТОГ:        %s (ERROR=%d, WARNING=%d, INFO=%d, арность=%s)' % (
        'OK' if ok else 'ПРОБЛЕМЫ', errors, counts.get('WARNING', 0),
        counts.get('INFO', 0), 'OK' if not mismatches else 'FAIL'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
