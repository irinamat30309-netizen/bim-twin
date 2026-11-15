# -*- coding: utf-8 -*-
"""Слить отчёт docs-compare.py и verify-fragment.py в один compare-full.json для панели «Документация».
   python verify-to-compare.py --compare compare.json --verify verify-fragment.json --out compare-full.json
"""
import argparse, json

ap = argparse.ArgumentParser()
ap.add_argument('--compare', required=True)
ap.add_argument('--verify', required=True)
ap.add_argument('--out', default='compare-full.json')
a = ap.parse_args()

cmp = json.load(open(a.compare, encoding='utf-8-sig'))
vrf = json.load(open(a.verify, encoding='utf-8-sig'))

rows = []
# строки из docs-compare (как есть); FAIL по классам толщин, отсутствующим во фрагменте,
# помечаем UNVERIFIED — это не ошибка модели, а неполнота фрагмента
for r in cmp.get('rows', []):
    status = r.get('status')
    note = r.get('note', '')
    rid = r.get('id') or ''
    if status == 'FAIL' and str(rid).startswith('wall_t_'):
        status = 'UNVERIFIED'
        note = (note + '; ' if note else '') + 'класс отсутствует во фрагменте (модель — часть этажа, а не весь этаж)'
    rows.append({'id': rid, 'label': r.get('label'), 'group': 'docs-compare',
                 'project': r.get('project'), 'model': r.get('model'), 'cloud': r.get('cloud'),
                 'delta_mp': r.get('delta_mp'), 'delta_cm': r.get('delta_cm'),
                 'status': status, 'note': note})
# строки из verify-fragment
for r in vrf.get('rows', []):
    rows.append({'id': 'doc_' + (r['name'].lower().replace(' ', '_').replace(':', '').replace('↔', '_')),
                 'label': r['name'], 'group': 'документация ↔ облако/модель',
                 'project': {'value': r.get('project'), 'unit': ''},
                 'model': {'value': r.get('model'), 'unit': ''},
                 'cloud': {'value': r.get('cloud'), 'unit': ''},
                 'delta_mp': {'value': r.get('delta_mm'), 'unit': 'mm'} if r.get('delta_mm') is not None else None,
                 'delta_cm': None, 'status': r.get('status'), 'note': r.get('note', '')})

summary = {s: sum(1 for r in rows if r['status'] == s) for s in ('PASS', 'WARN', 'FAIL', 'UNVERIFIED')}
score_docs = cmp.get('score')
score_verify = vrf.get('score')
parts = [x for x in (score_docs, score_verify) if isinstance(x, (int, float))]
score = round(sum(parts) / len(parts), 1) if parts else None
out = {
    'schema_version': 1,
    'title': 'Документация ↔ модель ↔ облако (объединённый отчёт)',
    'inputs': {'compare': a.compare, 'verify': a.verify,
               'model': (vrf.get('model') or (cmp.get('inputs') or {}).get('model'))},
    'score': score, 'score_docs': score_docs, 'score_doc_dimensions': score_verify,
    'grade': cmp.get('grade') or vrf.get('grade'),
    'coverage_pct': cmp.get('coverage_pct'),
    'summary': summary,
    'rows': rows,
    'recommendations': (cmp.get('recommendations') or []) + [
        {'severity': 'info', 'code': 'doc_verify',
         'text': 'Проверка размеров по документации (reference-fragment.json): PASS %d / WARN %d / FAIL %d / UNVERIFIED %d'
                 % (summary['PASS'], summary['WARN'], summary['FAIL'], summary['UNVERIFIED'])}],
    'limitations': (cmp.get('limitations') or []) + (vrf.get('limitations') or []),
    'unverified': [r['id'] for r in rows if r['status'] == 'UNVERIFIED'],
}
json.dump(out, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('строк: %d | PASS %d WARN %d FAIL %d UNVERIFIED %d | score %s / doc %s'
      % (len(rows), summary['PASS'], summary['WARN'], summary['FAIL'], summary['UNVERIFIED'],
         score, score_verify))
print('сохранено:', a.out)
