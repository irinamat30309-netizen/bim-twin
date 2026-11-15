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
    'IfcPropertySet', 'IfcPropertySingleValue', 'IfcRelDefinesByProperties',
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


def style_info(f, limit=5):
    """Стили IfcSurfaceStyle: имя, цвет RGB (0..1 и 0..255), какие элементы используют.
    Если у поверхности нет рендер-стиля (IfcSurfaceStyleShading) — rgb=None."""
    out = []
    for st in f.by_type('IfcSurfaceStyle'):
        rgb = None
        for item in st.Styles:
            if item.is_a('IfcSurfaceStyleRendering') and item.SurfaceColour is not None:
                c = item.SurfaceColour
                rgb = [round(c.Red, 3), round(c.Green, 3), round(c.Blue, 3),
                       int(round(c.Red * 255)), int(round(c.Green * 255)),
                       int(round(c.Blue * 255))]
        used = []
        for rel in f.get_inverse(st):
            targets = []
            if rel.is_a('IfcPresentationStyleAssignment'):
                targets = f.get_inverse(rel)
            elif rel.is_a('IfcStyledItem'):
                targets = [rel]
            for t in targets:
                if t.is_a('IfcStyledItem') and t.Item is not None:
                    used.append(t.Item.is_a())
        out.append({'name': st.Name, 'rgb_norm': rgb[:3] if rgb else None,
                    'rgb255': rgb[3:] if rgb else None, 'used_by': used[:4]})
        if len(out) >= limit:
            break
    return out


def step_unescape(raw):
    """Декодирует внутренность STEP-строки: \\X2\\hhhh…\\X0\\, '' и \\\\."""
    out, i, n = [], 0, len(raw)
    while i < n:
        if raw.startswith('\\X2\\', i):
            j = raw.find('\\X0\\', i + 4)
            if j < 0:
                out.append(raw[i:])
                break
            hexpart = raw[i + 4:j]
            for k in range(0, len(hexpart) - 3, 4):
                try:
                    out.append(chr(int(hexpart[k:k + 4], 16)))
                except ValueError:
                    return raw
            i = j + 4
            continue
        if raw.startswith("''", i):
            out.append("'")
            i += 2
            continue
        if raw.startswith('\\\\', i):
            out.append('\\')
            i += 2
            continue
        out.append(raw[i])
        i += 1
    return ''.join(out)


def names_info(f, text):
    """Имена элементов из сырого STEP-текста + контроль их чтения через ifcopenshell.
    encodingOk = False, если не-ASCII пишется сырым UTF-8 или имя читается иначе."""
    wall_re = re.compile(r"=IFCWALL(?:STANDARDCASE)?\('((?:[^']|'')*)',\$,'((?:[^']|'')*)'")
    space_re = re.compile(r"=IFCSPACE\('((?:[^']|'')*)',\$,'((?:[^']|'')*)'")
    storey_re = re.compile(r"=IFCBUILDINGSTOREY\('((?:[^']|'')*)',\$,'((?:[^']|'')*)'")
    slab_re = re.compile(r"=IFCSLAB\('((?:[^']|'')*)',\$,'((?:[^']|'')*)'")
    wall_raw = [m.group(2) for m in wall_re.finditer(text)]
    wall_dec = [step_unescape(n) for n in wall_raw]
    walls = f.by_type('IfcWallStandardCase') or f.by_type('IfcWall')
    readback = [w.Name for w in walls]
    pairs = list(zip(wall_dec, readback))
    bad = [(d, r) for d, r in pairs if d != r]
    raw_utf8 = [n for n in wall_raw if any(ord(ch) > 127 for ch in n)]
    escaped = [n for n in wall_raw if '\\X2\\' in n]
    return {
        'walls': len(wall_raw),
        'inferredNames': sum(1 for n in wall_dec if 'достроена' in n),
        'wallNamesSample': wall_dec[:3],
        'inferredNamesSample': [n for n in wall_dec if 'достроена' in n][:2],
        'spaceNames': [step_unescape(m.group(2)) for m in space_re.finditer(text)][:5],
        'spaces': len(f.by_type('IfcSpace')),
        'storeyNames': [step_unescape(m.group(2)) for m in storey_re.finditer(text)][:3],
        'storeys': len(f.by_type('IfcBuildingStorey')),
        'slabNames': [step_unescape(m.group(2)) for m in slab_re.finditer(text)][:4],
        'nameReadbackFirstWall': readback[0] if readback else None,
        'nameRawFirstWall': wall_raw[0] if wall_raw else None,
        'nonAsciiRawUtf8': len(raw_utf8),
        'escapedX2Count': len(escaped),
        'encodingOk': len(raw_utf8) == 0 and not bad,
        'encodingBad': [{'raw': d, 'readback': r} for d, r in bad[:3]],
    }


def pset_info(f):
    """IfcPropertySet + IfcPropertySingleValue + IfcRelDefinesByProperties (чтение значений)."""
    sets = f.by_type('IfcPropertySet')
    rels = f.by_type('IfcRelDefinesByProperties')
    props = f.by_type('IfcPropertySingleValue')
    names = Counter(s.Name for s in sets)
    samples = []
    for s in sets[:5]:
        d = {}
        for p in s.HasProperties:
            if p.is_a('IfcPropertySingleValue') and p.NominalValue is not None:
                v = p.NominalValue
                d[p.Name] = {'type': v.is_a(), 'value': v.wrappedValue}
        samples.append({'name': s.Name, 'props': d})
    return {
        'count': len(sets),
        'relations': len(rels),
        'propertyCount': len(props),
        'names': dict(names),
        'samples': samples,
    }


def spatial_info(f):
    storey_ids = {s.id() for s in f.by_type('IfcBuildingStorey')}
    contained = 0
    aggregated = 0
    for rel in f.by_type('IfcRelContainedInSpatialStructure'):
        if rel.RelatingStructure.id() in storey_ids:
            contained += sum(1 for e in rel.RelatedElements if e.is_a('IfcSpace'))
    for rel in f.by_type('IfcRelAggregates'):
        if rel.RelatingObject.id() in storey_ids:
            aggregated += sum(1 for e in rel.RelatedObjects if e.is_a('IfcSpace'))
    return {
        'storeys': [{'name': s.Name, 'elevation': s.Elevation}
                    for s in f.by_type('IfcBuildingStorey')],
        'spacesContainedInStorey': contained,
        'spacesAggregatedToStorey': aggregated,
    }


def deep_info(f, text):
    names = names_info(f, text)
    return {
        'styles': style_info(f),
        'styleCount': len(f.by_type('IfcSurfaceStyle')),
        'styledItems': len(f.by_type('IfcStyledItem')),
        'names': names,
        'spatial': spatial_info(f),
        'propertySets': len(f.by_type('IfcPropertySet')),
        'psets': pset_info(f),
        'encodingOk': names['encodingOk'],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description='Валидация IFC4 из Scan2BIM')
    ap.add_argument('ifc')
    ap.add_argument('--json', dest='json_out', default=None)
    ap.add_argument('--verbose', action='store_true', help='печатать все замечания валидатора')
    ap.add_argument('--deep', action='store_true',
                    help='доп.: стили/цвета (первые 5), имена «(достроена)», этажи/помещения, psets')
    ap.add_argument('--require-psets', action='store_true',
                    help='FAIL, если в файле нет IfcPropertySet (для интерьерных/фасадных IFC)')
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
    deep = deep_info(f, text) if args.deep else None
    errors = counts.get('ERROR', 0)
    ok = errors == 0 and not mismatches
    if deep is not None and not deep['encodingOk']:
        ok = False
    if args.require_psets and not (deep or {}).get('psets', {}).get('count', 0):
        ok = False

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
    if deep:
        print('стили:       %d IfcSurfaceStyle, %d IfcStyledItem; первые %d:' % (
            deep['styleCount'], deep['styledItems'], len(deep['styles'])))
        for i, st in enumerate(deep['styles']):
            print('  %d. %r rgb255=%s used_by=%s' % (
                i + 1, st['name'], st['rgb255'], st['used_by']))
        ni = deep['names']
        print('имена:       стен %d, с «(достроена)» %d; примеры: %s' % (
            ni['walls'], ni['inferredNames'], ni['wallNamesSample']))
        print('             помещения: %d %s' % (ni['spaces'], ni['spaceNames']))
        print('             этажи: %d %s; плиты: %s' % (
            ni['storeys'], ni['storeyNames'], ni['slabNames']))
        sp = deep['spatial']
        print('структура:   помещения в подчинении этажа: contained=%d, aggregated=%d' % (
            sp['spacesContainedInStorey'], sp['spacesAggregatedToStorey']))
        ps = deep['psets']
        print('psets:       IfcPropertySet: %d, IfcPropertySingleValue: %d, '
              'IfcRelDefinesByProperties: %d' % (
                  ps['count'], ps['propertyCount'], ps['relations']))
        for smp in ps['samples'][:3]:
            short = ', '.join('%s=%r' % (k, v['value']) for k, v in list(smp['props'].items())[:6])
            print('  pset:      %s [%s]' % (smp['name'], short))
        if ni['encodingOk']:
            print('кодировка:   OK — имена читаются ifcopenshell корректно '
                  '(пример: %r; экранировано \\X2\\: %d)' % (
                      ni['nameReadbackFirstWall'], ni['escapedX2Count']))
        else:
            print('кодировка:   FAIL — не-ASCII сырым UTF-8 (STEP требует \\X2\\…\\X0\\): %d, '
                  'ошибок чтения: %d; ifcopenshell: %r вместо %r' % (
                      ni['nonAsciiRawUtf8'], len(ni['encodingBad']),
                      ni['nameReadbackFirstWall'], ni['nameRawFirstWall']))

    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as fh:
            json.dump({'file': args.ifc, 'schema': f.schema, 'instances': len(list(f)),
                       'validator': counts, 'statements': statements,
                       'arityMismatches': mismatches, 'inventory': inventory,
                       'georef': geo, 'deep': deep}, fh, ensure_ascii=False, indent=1)

    print('ИТОГ:        %s (ERROR=%d, WARNING=%d, INFO=%d, арность=%s)' % (
        'OK' if ok else 'ПРОБЛЕМЫ', errors, counts.get('WARNING', 0),
        counts.get('INFO', 0), 'OK' if not mismatches else 'FAIL'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
