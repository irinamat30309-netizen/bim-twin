'use strict';
// Юнит-тесты для движка нормоконтроля (ai/verify.js). Только встроенные модули Node.
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../ai/verify');

test('extractDims находит размеры через x/х/×', () => {
  assert.deepStrictEqual(v.extractDims('воздуховод 400x200 и 500х2 50'), ['400x200']);
  assert.deepStrictEqual(v.extractDims('сечение 600×300'), ['600x300']);
  assert.deepStrictEqual(v.extractDims('нет размеров'), []);
});

test('extractFire распознаёт класс огнестойкости', () => {
  assert.strictEqual(v.extractFire('дверь EI-60'), 'EI-60');
  assert.strictEqual(v.extractFire('EI 30 предел'), 'EI-30');
  assert.strictEqual(v.extractFire('без класса'), null);
});

test('extractDiam распознаёт диаметр (Ø и DN)', () => {
  assert.strictEqual(v.extractDiam('труба Ø100'), 'Ø100');
  assert.strictEqual(v.extractDiam('DN50 сталь'), 'Ø50');
  assert.strictEqual(v.extractDiam('нет'), null);
});

test('num нормализует числа с запятой/единицами', () => {
  assert.strictEqual(v.num('12,5 м'), 12.5);
  assert.strictEqual(v.num('abc'), null);
});

test('statusOf возвращает максимальную тяжесть', () => {
  assert.strictEqual(v.statusOf([{ severity: 'ok' }, { severity: 'err' }, { severity: 'warn' }]), 'err');
  assert.strictEqual(v.statusOf([]), 'none');
});

test('verifyElement: расхождение сечения → err', () => {
  const el = { id: 'el1', name: 'Воздуховод V-1', type: 'воздуховод' };
  const intent = { el1: { section: '400x200', model_section: '500x250' } };
  const findings = v.verifyElement(el, [{ id: 'd1', text: 'чертёж' }], intent);
  assert.ok(findings.some(f => f.severity === 'err' && f.kind === 'Сечение воздуховода'));
});

test('verifyElement: перегрузка перекрытия → err', () => {
  const el = { id: 'el2', name: 'Плита', type: 'перекрытие' };
  const intent = { el2: { load_kg: 1200, floor_limit_kg: 1000 } };
  const findings = v.verifyElement(el, [{ id: 'd1', text: '' }], intent);
  assert.ok(findings.some(f => f.severity === 'err' && /Перегрузка/.test(f.kind)));
});

test('verifyElement: элемент найден в документах → ok', () => {
  const el = { id: 'el3', name: 'Насос P-101', type: 'оборудование' };
  const findings = v.verifyElement(el, [{ id: 'd1', text: 'в составе узла насос P-101 согласно смете' }], {});
  assert.ok(findings.some(f => f.severity === 'ok'));
});

test('verifyElement: элемента нет в документах → warn', () => {
  const el = { id: 'el4', name: 'Клапан XZ-9', type: 'оборудование' };
  const findings = v.verifyElement(el, [{ id: 'd1', text: 'посторонний текст без упоминания' }], {});
  assert.ok(findings.some(f => f.severity === 'warn' && f.kind === 'Нет в документах'));
});

test('verifyRoom агрегирует находки по всем элементам', () => {
  const room = { id: 'r1', elements: [{ id: 'a', name: 'A-1', type: 'оборудование' }, { id: 'b', name: 'B-2', type: 'оборудование' }] };
  const docs = [{ id: 'd1', element_id: null, text: 'A-1 есть в смете' }];
  const findings = v.verifyRoom(room, docs, {});
  assert.ok(findings.length >= 2);
});
