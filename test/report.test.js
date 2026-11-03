'use strict';
// Юнит-тесты генерации отчётов (ai/report.js). Только встроенные модули Node.
const { test } = require('node:test');
const assert = require('node:assert');
const report = require('../ai/report');

function sampleData() {
  return {
    project: { id: 'p1', name: 'Тестовый проект', address: 'ул. 1', status: 'проект' },
    floors: [{ id: 'f1', number: 1, name: 'Этаж 1' }],
    rooms: [{ id: 'r1', floor_id: 'f1', name: 'Комната 1', area_m2: 20, status: 'проект',
      elements: [{ id: 'e1', name: 'Элемент', type: 'оборудование', ai_status: 'warn' }],
      documents: [], findings: [{ id: 'x1', element_id: 'e1', kind: 'Проверка', severity: 'warn', confidence: 0.7, text: 'текст', review: 'open' }] }],
    users: [], discussions: []
  };
}

test('CSV содержит BOM и utf8', () => {
  const csv = report.build(sampleData(), { type: 'project' }, 'csv', { title: 'Отчёт' });
  assert.strictEqual(csv.content.charCodeAt(0), 0xFEFF, 'BOM в начале');
  assert.strictEqual(csv.encoding, 'utf8');
});

test('PDF начинается с сигнатуры %PDF', () => {
  const pdf = report.build(sampleData(), { type: 'project' }, 'pdf', { title: 'Отчёт' });
  assert.strictEqual(pdf.encoding, 'binary');
  assert.strictEqual(pdf.content.slice(0, 5).toString('latin1'), '%PDF-');
});

test('HTML содержит заголовок отчёта', () => {
  const html = report.build(sampleData(), { type: 'project' }, 'html', { title: 'Мой отчёт' });
  assert.ok(String(html.content).includes('Мой отчёт'), 'заголовок есть в HTML');
});
