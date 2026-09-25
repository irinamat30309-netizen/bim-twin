#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Генератор тестовых входных данных для АИ-модуля (сметы/акты/замысел)."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, 'samples')


def main():
    os.makedirs(SAMPLES, exist_ok=True)
    intent = {
        'el_1011': {'section': '500x300', 'model_section': '600x300', 'note': 'воздуховод ВШ-1'},
        'el_1012': {'model': 'ПВ-1', 'passport': 'ПВ-1'},
        'el_2011': {'load_kg': 480, 'floor_limit_kg': 500}
    }
    with open(os.path.join(SAMPLES, 'design_intent.json'), 'w', encoding='utf-8') as f:
        json.dump(intent, f, ensure_ascii=False, indent=2)

    # текстовые заменители бинарных смет/актов (чтобы не тянуть openpyxl/PIL)
    with open(os.path.join(SAMPLES, 'chertyozh_notes.txt'), 'w', encoding='utf-8') as f:
        f.write('АР-12: воздуховод ВШ-1 сечение 500x300; дверь EI-60.\n')
    for name in ('smeta_vent.xlsx', 'smeta_hvac.xlsx', 'akt_grsh.png'):
        open(os.path.join(SAMPLES, name), 'a').close()
    print('[ai] samples written to', SAMPLES)


if __name__ == '__main__':
    main()
