'use strict';
/* Подбор поля измерения под размер из документа с учётом того, как расположен замер.
 * В приложении ось «вверх» — Y: раньше горизонтальный замер (ΔY = 0) подходил под «ширину» по полю ΔY и получал факт 0. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Compare = require('../renderer/measurement-doc-compare');

function req(text) { return Compare.extractRequirements({ documentId: 'd', documentName: 'ТЗ.pdf', text }).requirements[0]; }
function rank(measurement, text, extra) {
  const requirement = req(text);
  return Compare.rankRequirementMatches(Object.assign({ measurement, candidates: [{ requirement, doc: { id: 'd', name: 'ТЗ.pdf' } }] }, extra || {}));
}
const ctx = { elementName: 'Стена', elementType: 'стена', roomName: 'Зал', sourceUnits: 'м' };
const horizontal = { mode: 'distance', d3: 6, dx: 6, dy: 0, dz: 0, horizontal: 6, vertical: 0, label: 'Ширина стены', measurementContext: ctx };
const vertical = { mode: 'distance', d3: 2.1, dx: 0, dy: 2.1, dz: 0, horizontal: 0, vertical: 2.1, label: 'Высота проёма', measurementContext: Object.assign({}, ctx, { elementName: 'Проём', elementType: 'проём' }) };

test('горизонтальный замер сравнивается по горизонтальной длине, а не по ΔY = 0', () => {
  const ranked = rank(horizontal, 'Ширина стены: 6000 ± 10 мм');
  assert.ok(ranked.best, 'есть предложение');
  assert.notEqual(ranked.best.field.key, 'deltaY');
  assert.ok(['distance3d', 'horizontal'].includes(ranked.best.field.key), ranked.best.field.key);
  assert.equal(ranked.best.preview.status, 'within-tolerance');
  assert.ok(Math.abs(ranked.best.preview.actual - 6) < 1e-9);
});

test('вертикальный замер сравнивается как высота', () => {
  const ranked = rank(vertical, 'Высота проёма: 2100 ± 10 мм');
  assert.ok(['distance3d', 'vertical'].includes(ranked.best.field.key), ranked.best.field.key);
  assert.equal(ranked.best.signals.dimension, 'exact');
  assert.equal(ranked.best.preview.status, 'within-tolerance');
});

test('ΔX/ΔY/ΔZ не участвуют в автоподборе, но остаются для ручного выбора', () => {
  const fields = Compare.measurementFields(horizontal).map(f => f.key);
  assert.ok(fields.includes('deltaX') && fields.includes('deltaY') && fields.includes('deltaZ'));
  assert.equal(Compare.measurementFieldDimensions({ key: 'deltaY' }, horizontal).auto, false);
  const all = rank(horizontal, 'Высота: 6000 мм', { allFields: true }).matches.map(m => m.field.key);
  const auto = rank(horizontal, 'Высота: 6000 мм').matches.map(m => m.field.key);
  assert.ok(all.includes('deltaY'), 'при явном запросе поле доступно');
  assert.ok(!auto.includes('deltaY') && !auto.includes('deltaX') && !auto.includes('deltaZ'), 'автоподбор их не берёт');
});

test('размерность поля зависит от расположения замера', () => {
  const d = (m, key) => Compare.measurementFieldDimensions({ key }, m);
  assert.equal(Compare.measurementOrientation(horizontal), 'horizontal');
  assert.equal(Compare.measurementOrientation(vertical), 'vertical');
  assert.equal(Compare.measurementOrientation({ mode: 'distance', d3: 5, horizontal: 3, dy: 4 }), 'diagonal');
  assert.deepEqual(d(horizontal, 'distance3d').primaries, ['width', 'length']);
  assert.deepEqual(d(vertical, 'distance3d').primaries, ['height']);
  assert.deepEqual(d(horizontal, 'horizontal').primaries, ['width', 'length']);
  assert.deepEqual(d({ mode: 'distance', d3: 5, horizontal: 3, dy: 4 }, 'distance3d').primaries, ['length']);
});

test('расстояние между плоскостями (⊥) — отдельное поле и сравнивается с высотой помещения', () => {
  const room = { mode: 'distance', d3: 4.163, dx: 0, dy: 4.163, dz: 0, horizontal: 0, vertical: 4.163, perp: 4.163, perpKind: 'planes',
    label: 'Высота помещения', measurementContext: Object.assign({}, ctx, { elementName: 'Помещение', elementType: 'помещение' }) };
  const fields = Compare.measurementFields(room);
  const perp = fields.find(f => f.key === 'perp');
  assert.ok(perp && /плоскост/.test(perp.label) && Math.abs(perp.value - 4.163) < 1e-9);
  assert.deepEqual(Compare.measurementFieldDimensions(perp, room).primaries, ['height']);
  const ranked = rank(room, 'Высота помещения: 4160 ± 20 мм');
  assert.equal(ranked.best.preview.status, 'within-tolerance');
  const edges = Compare.measurementFields({ mode: 'distance', d3: 0.9, dx: 0.9, dy: 0, dz: 0, horizontal: 0.9, vertical: 0, perp: 0.9, perpKind: 'edges' }).find(f => f.key === 'perp');
  assert.ok(/рёбр/.test(edges.label));
});
