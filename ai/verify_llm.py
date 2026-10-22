#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM-верификатор (каркас для Фазы C). Сравнивает элемент модели с текстами
чертежа/сметы/акта через LLM и возвращает finding или None.
Поддержка OpenAI (OPENAI_API_KEY) или локального Ollama (OLLAMA_HOST).
"""
import os, json

PROMPT = (
    'Ты — инженер-нормоконтролёр. Сравни элемент BIM-модели с документами. '
    'Верни JSON: {"severity":"ok|warn|err","kind":"...","text":"...","confidence":0..1}. '
    'Если расхождений нет — severity=ok.'
)


def verify(element, drawing='', estimate='', act_text=''):
    payload = {'element': element, 'drawing': drawing, 'estimate': estimate, 'act': act_text}
    if os.environ.get('OPENAI_API_KEY'):
        return _openai(payload)
    if os.environ.get('OLLAMA_HOST'):
        return _ollama(payload)
    # оффлайн-заглушка
    return None


def _openai(payload):
    try:
        from openai import OpenAI
        client = OpenAI()
        r = client.chat.completions.create(
            model=os.environ.get('OPENAI_MODEL', 'gpt-4o-mini'),
            messages=[{'role': 'system', 'content': PROMPT},
                      {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)}],
            response_format={'type': 'json_object'})
        return json.loads(r.choices[0].message.content)
    except Exception as e:
        print('[llm] openai error:', e)
        return None


def _ollama(payload):
    try:
        import urllib.request
        host = os.environ['OLLAMA_HOST'].rstrip('/')
        body = json.dumps({'model': os.environ.get('OLLAMA_MODEL', 'llama3.1'),
                           'prompt': PROMPT + '\n' + json.dumps(payload, ensure_ascii=False),
                           'stream': False, 'format': 'json'}).encode('utf-8')
        req = urllib.request.Request(host + '/api/generate', data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return json.loads(data.get('response', 'null'))
    except Exception as e:
        print('[llm] ollama error:', e)
        return None


if __name__ == '__main__':
    demo = verify({'id': 'el_1011', 'type': 'вентшахта', 'section': '600x300'},
                  drawing='АР-12: 500x300', estimate='', act_text='')
    print(json.dumps(demo, ensure_ascii=False) if demo else '[llm] нет ключа — заглушка (None)')
