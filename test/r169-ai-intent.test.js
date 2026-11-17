'use strict';
/*
 * r169: локальный интент-парсер (renderer/ai-intent.js) — рус/укр фразы,
 * точность на наборе (≥25 фраз), структурированные действия, ответы по фактам контекста
 * и честное «не знаю» без выдумывания, когда данных нет.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const I = require(path.join(__dirname, '..', 'renderer', 'ai-intent.js'));

function pack(o) {
  o = o || {};
  return {
    schema: 'ai-context/1',
    cloud: o.cloud !== undefined ? o.cloud : { open: true, name: 'room.las', points: 272500, bbox: { size: [10, 3, 6] } },
    selection: o.selection || { active: false, count: 0 },
    element: o.element || null,
    inspection: o.inspection || { available: false },
    model: o.model || { open: false },
    project: o.project || { open: false, name: null, id: null },
    documents: o.documents || { projectDocs: [], norms: { docs: [] }, count: 0 },
    measurements: o.measurements || [],
    checks: o.checks || [],
    capabilities: o.capabilities || { cloud: true, selection: false, element: !!o.element, inspection: !!(o.inspection && o.inspection.available), model: !!(o.model && o.model.open), documents: false, measurements: false }
  };
}
const wallEl = { type: 'wall', title: 'Стена', source: 'auto-measure-selection', confidence: 0.94, dims: [
  { key: 'length', label: 'Длина', value: 5, unit: 'м', text: '5,00 м' },
  { key: 'height', label: 'Высота', value: 3, unit: 'м', text: '3,00 м' },
  { key: 'thickness', label: 'Толщина', value: 0.2, unit: 'м', text: '200 мм' },
  { key: 'plumb', label: 'Отклонение от вертикали', value: 10, unit: 'мм', text: '10 мм' }
], checks: [{ label: 'СП 70: вертикаль', ok: true, text: '10 мм ≤ 15 мм' }] };
const pipeEl = { type: 'pipe', title: 'Труба Ø108', source: 'auto-measure', confidence: 0.9, dims: [{ key: 'diameter', label: 'Диаметр', value: 0.108, unit: 'м', text: 'Ø108 мм (DN100)' }, { key: 'length', label: 'Длина', value: 5.4, unit: 'м', text: '5,40 м' }] };
const floorEl = { type: 'floor', title: 'Пол', source: 'element-identify', dims: [{ key: 'area', label: 'Площадь', value: 30, unit: 'м²', text: '30,0 м²' }, { key: 'clear', label: 'Высота в свету', value: 3, unit: 'м', text: '3,00 м' }] };

const PHRASES = [
  ['что это за элемент', 'element.type'],
  ['что это?', 'element.type'],
  ['это стена?', 'element.type'],
  ['это труба?', 'element.type'],
  ['что за конструкция передо мной', 'element.type'],
  ['определи тип элемента', 'element.type'],
  ['объясни, что это', 'element.type'],
  ['що це таке?', 'element.type'],
  ['що за елемент?', 'element.type'],
  ['это стіна?', 'element.type'],
  ['какая толщина', 'element.measure'],
  ['какая толщина у стены', 'element.measure'],
  ['какая высота потолка', 'element.measure'],
  ['чему равна длина стены', 'element.measure'],
  ['какой диаметр трубы', 'element.measure'],
  ['сколько площадь', 'element.measure'],
  ['какая площадь пола', 'element.measure'],
  ['какие размеры', 'element.measure'],
  ['яка товщина стіни?', 'element.measure'],
  ['яка площа підлоги?', 'element.measure'],
  ['найди двери', 'find'],
  ['покажи окна', 'find'],
  ['сколько дверей', 'find'],
  ['где трубы', 'find'],
  ['найди стены вне допуска', 'find'],
  ['покажи проёмы', 'find'],
  ['знайди двері', 'find'],
  ['сверь с документацией', 'compare.docs'],
  ['проверь по проекту', 'compare.docs'],
  ['соответствует ли стена проекту', 'compare.docs'],
  ['звір з документацією', 'compare.docs'],
  ['построй документ', 'document.build'],
  ['сформируй отчёт', 'document.build'],
  ['сделай исполнительную документацию', 'document.build'],
  ['побудуй документ', 'document.build'],
  ['какой допуск вертикали по СП 70', 'norms.lookup'],
  ['какая норма для толщины стены', 'norms.lookup'],
  ['посчитай 12,5 на 3,2', 'calculate'],
  ['сколько будет 4 на 5', 'calculate'],
  ['что в модели', 'model.info'],
  ['сколько стен в модели', 'model.info'],
  ['итоги проверки', 'checks.summary'],
  ['какие дефекты', 'checks.summary'],
  ['что за проект', 'project.info'],
  ['какие документы загружены', 'project.info'],
  ['что ты умеешь', 'help.capabilities'],
  ['как проверить ровность пола', 'help.howto']
];

test('r169 интент-парсер: ≥25 фраз, точность на наборе', () => {
  let ok = 0; const bad = [];
  for (const [phrase, expected] of PHRASES) {
    const p = I.parse(phrase);
    if (p.intent === expected) ok++; else bad.push(phrase + ' => ' + p.intent + ' (ожидалось ' + expected + ')');
  }
  const acc = ok / PHRASES.length;
  assert.deepEqual(bad, [], 'ошибочные фразы: ' + bad.join(' | '));
  assert.equal(acc, 1, 'точность ' + (acc * 100).toFixed(1) + '%');
  assert.ok(PHRASES.length >= 25, 'набор ≥25 фраз');
});

test('r169 интент-парсер: параметры намерений (тип, размер, фильтр, документ, калькуляция)', () => {
  let p = I.parse('это стена?');
  assert.equal(p.params.target, 'wall');
  p = I.parse('какая толщина у стены');
  assert.equal(p.params.dimension, 'thickness');
  assert.equal(p.params.target, 'wall');
  p = I.parse('какая площадь пола');
  assert.equal(p.params.dimension, 'area');
  assert.equal(p.params.target, 'floor');
  p = I.parse('найди стены вне допуска');
  assert.equal(p.params.target, 'wall');
  assert.equal(p.params.filter, 'bad');
  p = I.parse('какой допуск по СП 70');
  assert.equal(p.params.doc, 'СП 70');
  p = I.parse('посчитай 12,5 на 3,2');
  assert.equal(p.params.value, 40);
  assert.equal(p.params.a, 12.5);
  p = I.parse('сделай исполнительную документацию');
  assert.match(p.params.docType, /исполнительн/i);
  p = I.parse('яка товщина стіни?');
  assert.equal(p.params.dimension, 'thickness');
  assert.equal(p.params.target, 'wall');
});

test('r169 интент-исполнение: «что это» по элементу — тип, размеры, нормоконтроль', () => {
  const ans = I.execute(I.parse('что это за элемент'), pack({ element: wallEl, selection: { active: true, count: 1200 } }));
  assert.equal(ans.handled, true);
  assert.equal(ans.honest, false);
  assert.match(ans.text, /Стена/);
  assert.match(ans.text, /стена/);
  assert.match(ans.text, /Толщина/);
  assert.match(ans.text, /200 мм/);
  assert.match(ans.text, /СП 70/);
});
test('r169 интент-исполнение: «какая толщина»/«какая площадь»/«какой диаметр» — из фактов', () => {
  let ans = I.execute(I.parse('какая толщина у стены'), pack({ element: wallEl }));
  assert.match(ans.text, /Толщина/);
  assert.match(ans.text, /200 мм|0,2/);
  ans = I.execute(I.parse('сколько площадь'), pack({ element: floorEl }));
  assert.match(ans.text, /Площадь/);
  assert.match(ans.text, /30/);
  ans = I.execute(I.parse('какой диаметр трубы'), pack({ element: pipeEl }));
  assert.match(ans.text, /108|Ø108/);
});
test('r169 интент-исполнение: если размер не найден — честно «не знаю» и что доступно', () => {
  const ans = I.execute(I.parse('какой диаметр трубы'), pack({ element: wallEl }));
  assert.equal(ans.honest, true);
  assert.match(ans.text, /Не знаю/);
  assert.match(ans.text, /нет размера/);
  assert.match(ans.text, /доступны/i);
});
test('r169 интент-исполнение: нет элемента, но есть выделение — просит проанализировать (auto-measure)', () => {
  const ans = I.execute(I.parse('что это?'), pack({ selection: { active: true, count: 500 }, capabilities: { cloud: true, selection: true } }));
  assert.equal(ans.handled, false);
  assert.equal(ans.need, 'analyze-selection');
});
test('r169 интент-исполнение: «найди двери»/«сколько стен» — из модели/контроля, без выдумок', () => {
  let ans = I.execute(I.parse('найди двери'), pack({ model: { open: true, openings: 7, walls: 12 } }));
  assert.match(ans.text, /7/);
  let no = I.execute(I.parse('найди двери'), pack({ model: { open: false } }));
  assert.equal(no.honest, true);
  assert.match(no.text, /Не знаю/);
  ans = I.execute(I.parse('сколько стен'), pack({ inspection: { available: true, summary: { walls: 12, wallsOutOfTolerance: 2 } } }));
  assert.match(ans.text, /12/);
});
test('r169 интент-исполнение: «сверь с документацией» — факты сверки или честное «не знаю»', () => {
  let ans = I.execute(I.parse('сверь с документацией'), pack({ inspection: { available: true, fileName: 'room.las', dxfName: 'plan.dxf', compare: { walls: 12, matched: 11, mismatch: 1 } } }));
  assert.match(ans.text, /Сверка/);
  assert.match(ans.text, /1/);
  ans = I.execute(I.parse('сверь с документацией'), pack({ documents: { projectDocs: [{ name: 'ТЗ.pdf' }], norms: { docs: [] }, count: 1 } }));
  assert.equal(ans.honest, true);
  assert.match(ans.text, /Не знаю/);
  assert.match(ans.text, /не выполнялась/);
});
test('r169 интент-исполнение: «построй документ» → структурированное действие открытия документов', () => {
  const ans = I.execute(I.parse('построй документ'), pack({}));
  assert.equal(ans.handled, true);
  assert.ok(ans.action && ans.action.kind === 'open-docs');
  assert.match(ans.text, /документ/i);
  assert.ok(Array.isArray(ans.actions) && ans.actions.some((a) => a.kind === 'open-docs'));
});
test('r169 интент-исполнение: нормы/калькулятор/модель/итоги — по фактам', () => {
  let ans = I.execute(I.parse('какой допуск по СП 70'), pack({}));
  assert.ok(ans.action && ans.action.kind === 'open-norms');
  assert.match(ans.text, /СП 70|база норм/i);
  ans = I.execute(I.parse('посчитай 12,5 на 3,2'), pack({}));
  assert.match(ans.text, /40/);
  ans = I.execute(I.parse('что в модели'), pack({ model: { open: true, storeys: 2, walls: 20, openings: 8, rooms: 5 } }));
  assert.match(ans.text, /этажей 2/);
  assert.match(ans.text, /стен 20/);
  ans = I.execute(I.parse('итоги проверки'), pack({ inspection: { available: true, summary: { walls: 12, wallsOutOfTolerance: 2, defects: 3, rooms: 2, roomsArea: 32.5, floor: { mmPerM: 1.2 } } } }));
  assert.match(ans.text, /12/);
  assert.match(ans.text, /дефектов 3/);
});
test('r169 интент-исполнение: «не знаю что это» — честный ответ без выдумывания + действия', () => {
  const ans = I.execute(I.parse('не знаю что это'), pack({ cloud: { open: true, points: 100, name: 'x.las' }, selection: { active: true, count: 50 } }));
  assert.equal(ans.honest, true);
  assert.match(ans.text, /Не знаю/);
  assert.match(ans.text, /выделено/i);
  assert.ok(ans.actions.length > 0, 'предложены ближайшие действия');
});
test('r169 интент-исполнение: пустой контекст — везде «не знаю», никаких чисел', () => {
  const empty = { schema: 'ai-context/1', cloud: { open: false }, selection: { active: false, count: 0 }, element: null, inspection: { available: false }, model: { open: false }, project: { open: false }, documents: { projectDocs: [], norms: { docs: [] }, count: 0 }, measurements: [], checks: [], capabilities: {} };
  for (const q of ['что это?', 'какая толщина', 'сколько площадь', 'какой диаметр трубы', 'найди двери', 'сверь с документацией', 'что в модели']) {
    const ans = I.execute(I.parse(q), empty);
    assert.ok(ans && ans.honest === true, q + ': должен быть честный ответ');
    assert.match(ans.text, /Не знаю/, q);
    assert.doesNotMatch(ans.text, /\b(272|500|108|30)\b/, q + ': не должно быть выдуманных чисел');
    assert.ok(ans.actions && ans.actions.length > 0, q + ': есть предложения действий');
  }
});
