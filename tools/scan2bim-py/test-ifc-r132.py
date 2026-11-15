# -*- coding: utf-8 -*-
"""r132: проверка IFC после исправления STEP-кодировки и добавления PSet_BimTwin.

Проверяет на реальном артефакте (по умолчанию py2-final-v5-utf8.ifc, собран из py2-final-v5.json):
  1) файл — чистый ASCII (не-ASCII кириллица закодирована \\X2\\…\\X0\\);
  2) ifcopenshell читает имена: 'Стена N' (+' (достроена)' для inferred), 'Помещение N — S м²',
     плиты 'Пол'/'Потолок', этаж 'Storey';
  3) IfcPropertySet/IfcPropertySingleValue/IfcRelDefinesByProperties присутствуют и их значения
     совпадают с JSON-моделью: толщина/материал/признак «достроена»/длина/высота у стен,
     площадь/высота у помещений, толщина/тип у плит;
  4) ifcopenshell.validate: 0 ERROR/WARNING/INFO.

Использование:
    python test-ifc-r132.py [--ifc PATH] [--json PATH]

Код возврата: 0 — всё совпало; 1 — есть расхождения.
"""
import argparse
import json
import sys

import ifcopenshell
import ifcopenshell.validate

DEFAULT_IFC = r'D:\BIM-TWIN-TEST\interior\py2-final-v5-utf8.ifc'
DEFAULT_JSON = r'D:\BIM-TWIN-TEST\interior\py2-final-v5.json'


def close(a, b, tol=1e-6):
    try:
        return abs(float(a) - float(b)) <= tol
    except (TypeError, ValueError):
        return False


def psets_for(f, element):
    """Наборы свойств, привязанные к элементу через IfcRelDefinesByProperties."""
    out = []
    for rel in f.by_type('IfcRelDefinesByProperties'):
        if element in rel.RelatedObjects:
            out.append(rel.RelatingPropertyDefinition)
    return out


def props_of(f, element):
    values = {}
    for pset in psets_for(f, element):
        for prop in pset.HasProperties:
            if prop.is_a('IfcPropertySingleValue') and prop.NominalValue is not None:
                values[prop.Name] = prop.NominalValue.wrappedValue
    return values


def main():
    ap = argparse.ArgumentParser(description='r132: IFC UTF-8/psets проверка')
    ap.add_argument('--ifc', default=DEFAULT_IFC)
    ap.add_argument('--json', default=DEFAULT_JSON)
    args = ap.parse_args()

    problems = []

    def check(ok, msg):
        if not ok:
            problems.append(msg)
        return ok

    with open(args.ifc, 'rb') as fh:
        raw = fh.read()
    check(all(b < 128 for b in raw), 'IFC содержит сырые не-ASCII байты (нужно \\X2\\…\\X0\\)')

    f = ifcopenshell.open(args.ifc)
    model = json.load(open(args.json, encoding='utf-8-sig'))
    storey_h = model['storey']['height']

    log = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, log)
    bad = [s for s in log.statements if str(s.get('level', '')).upper() in ('ERROR', 'WARNING', 'INFO')]
    check(not bad, 'валидатор: %d замечаний' % len(bad))

    walls_ifc = f.by_type('IfcWallStandardCase')
    walls_json = model['walls']
    check(len(walls_ifc) == len(walls_json), 'стен: IFC %d != JSON %d' % (len(walls_ifc), len(walls_json)))
    for i, (iw, wj) in enumerate(zip(walls_ifc, walls_json), 1):
        expected = 'Стена %d' % i + (' (достроена)' if wj.get('inferred') or wj.get('material') == 'inferred' else '')
        check(iw.Name == expected, 'имя стены %d: %r != %r' % (i, iw.Name, expected))
        p = props_of(f, iw)
        if not check('thickness' in p, 'стена %d: нет свойства thickness' % i):
            continue
        check(close(p.get('thickness'), wj.get('thickness')), 'стена %d thickness %r != %r' % (
            i, p.get('thickness'), wj.get('thickness')))
        check(close(p.get('length'), wj.get('length')), 'стена %d length %r != %r' % (
            i, p.get('length'), wj.get('length')))
        check(close(p.get('height'), wj.get('height')), 'стена %d height %r != %r' % (
            i, p.get('height'), wj.get('height')))
        check(p.get('material') == wj.get('material', 'unknown'), 'стена %d material %r != %r' % (
            i, p.get('material'), wj.get('material')))
        check(bool(p.get('inferred')) == bool(wj.get('inferred')), 'стена %d inferred %r != %r' % (
            i, p.get('inferred'), wj.get('inferred')))

    spaces_ifc = f.by_type('IfcSpace')
    rooms_json = model['rooms']
    check(len(spaces_ifc) == len(rooms_json), 'помещений: IFC %d != JSON %d' % (
        len(spaces_ifc), len(rooms_json)))
    for i, (isp, rj) in enumerate(zip(spaces_ifc, rooms_json), 1):
        prefix = 'Помещение %d — ' % i
        check(isp.Name.startswith(prefix), 'имя помещения %d: %r' % (i, isp.Name))
        check('м²' in isp.Name, 'в имени помещения %d нет «м²»: %r' % (i, isp.Name))
        p = props_of(f, isp)
        check(close(p.get('area'), rj.get('area')), 'помещение %d area %r != %r' % (
            i, p.get('area'), rj.get('area')))
        check(close(p.get('height'), storey_h), 'помещение %d height %r != %r' % (
            i, p.get('height'), storey_h))

    slabs_ifc = f.by_type('IfcSlab')
    slabs_json = model['slabs']
    check(len(slabs_ifc) == len(slabs_json), 'плит: IFC %d != JSON %d' % (len(slabs_ifc), len(slabs_json)))
    for i, (isl, sj) in enumerate(zip(slabs_ifc, slabs_json), 1):
        expected = 'Потолок' if sj.get('type') == 'ceiling' else 'Пол'
        check(isl.Name == expected, 'имя плиты %d: %r != %r' % (i, isl.Name, expected))
        p = props_of(f, isl)
        check(close(p.get('thickness'), sj.get('thickness')), 'плита %d thickness %r != %r' % (
            i, p.get('thickness'), sj.get('thickness')))
        check(p.get('type') == (sj.get('type') or 'floor'), 'плита %d type %r != %r' % (
            i, p.get('type'), sj.get('type')))

    expected_psets = len(walls_json) + len(rooms_json) + len(slabs_json)
    sets = f.by_type('IfcPropertySet')
    rels = f.by_type('IfcRelDefinesByProperties')
    props = f.by_type('IfcPropertySingleValue')
    check(len(sets) == expected_psets, 'IfcPropertySet %d != %d' % (len(sets), expected_psets))
    check(len(rels) == expected_psets, 'IfcRelDefinesByProperties %d != %d' % (len(rels), expected_psets))
    for ps in sets:
        check(ps.Name == 'PSet_BimTwin', 'имя набора %r' % ps.Name)
        check(len(ps.HasProperties) > 0, 'пустой набор %r' % ps.Name)

    print('IFC: %s' % args.ifc)
    print('JSON: %s' % args.json)
    print('стен %d, помещений %d, плит %d' % (len(walls_ifc), len(spaces_ifc), len(slabs_ifc)))
    print('psets: %d наборов, %d свойств, %d связей' % (len(sets), len(props), len(rels)))
    print('примеры имён:', [w.Name for w in walls_ifc[:2]], '|', spaces_ifc[0].Name,
          '|', [s.Name for s in slabs_ifc[:2]])
    if problems:
        print('FAIL: %d расхождений' % len(problems))
        for msg in problems[:20]:
            print('  -', msg)
        return 1
    print('OK: имена читаются, psets совпадают с JSON, валидатор 0/0/0')
    return 0


if __name__ == '__main__':
    sys.exit(main())
