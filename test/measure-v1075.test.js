const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', 'renderer', p), 'utf8');
const HTML = read('index.html');
const APP = read('app.js');
const VIEWER = read('webgl-viewer.js');
const M = require('../renderer/measure.js');

// —— measure.js: математика пересечений экспортирована ——
test('measure.js: экспорт angleBetweenPlanes/intersectPlanes/intersectThreePlanes', () => {
  assert.strictEqual(typeof M.angleBetweenPlanes, 'function');
  assert.strictEqual(typeof M.intersectPlanes, 'function');
  assert.strictEqual(typeof M.intersectThreePlanes, 'function');
});

test('measure.js: экспорт measurementsToMarkdown/measureValueText', () => {
  assert.strictEqual(typeof M.measurementsToMarkdown, 'function');
  assert.strictEqual(typeof M.measureValueText, 'function');
});

test('measurementsToMarkdown: заголовок + шапка таблицы + подпись', () => {
  const md = M.measurementsToMarkdown([{ mode: 'distance', d3: 2.5, horizontal: 2.4, vertical: 0.5, label: 'стена A' }], 'Отчёт');
  assert.ok(md.includes('## Отчёт'), 'no title');
  assert.ok(md.includes('| # | Тип | Значение | Подпись |'), 'no header');
  assert.ok(md.includes('стена A'), 'no label');
  assert.ok(md.includes('Расстояние'), 'no ru mode');
});

test('measurementsToMarkdown: экранирование вертикальной черты', () => {
  const md = M.measurementsToMarkdown([{ mode: 'point', point: [0, 0, 0], label: 'a|b' }]);
  assert.ok(md.includes('a\\|b'), 'pipe not escaped');
});

// —— webgl-viewer.js: режим corner ——
test('viewer: corner в списке режимов setMeasureMode', () => {
  assert.ok(/ok = \[[^\]]*'corner'/.test(VIEWER), 'corner not in ok list');
});
test('viewer: есть _cornerClick и _fitPlaneRansacAt', () => {
  assert.ok(VIEWER.includes('_cornerClick'), 'no _cornerClick');
  assert.ok(VIEWER.includes('_fitPlaneRansacAt'), 'no _fitPlaneRansacAt');
});
test('viewer: corner использует intersectPlanes/intersectThreePlanes', () => {
  assert.ok(VIEWER.includes('intersectPlanes'), 'no intersectPlanes use');
  assert.ok(VIEWER.includes('intersectThreePlanes'), 'no intersectThreePlanes use');
});
test('viewer: _clearMeasure сбрасывает _measCornerPlanes', () => {
  assert.ok(/_clearMeasure\(\)[^}]*_measCornerPlanes = null/.test(VIEWER), 'corner state not reset');
});

// —— app.js: fmt/hint/кнопки/переименование/Notion ——
test('app.js: measureHint и fmtMeasure знают corner', () => {
  assert.ok(APP.includes("corner: '📦"), 'no corner hint');
  assert.ok(APP.includes("case 'corner':"), 'no corner fmt case');
});
test('app.js: переименование измерений (renameMeasurement + data-mren)', () => {
  assert.ok(APP.includes('function renameMeasurement'), 'no renameMeasurement');
  assert.ok(APP.includes('data-mren'), 'no rename button');
});
test('app.js: exportMeasNotion + привязка mmNotion/mlNotion', () => {
  assert.ok(APP.includes('function exportMeasNotion'), 'no exportMeasNotion');
  assert.ok(APP.includes("bind('mmNotion'"), 'mmNotion not bound');
  assert.ok(APP.includes("bind('mlNotion'"), 'mlNotion not bound');
});
test('app.js: measIcon и meas. знают corner', () => {
  assert.ok(/measIcon[\s\S]{0,200}corner: '📦'/.test(APP), 'no corner icon');
});

// —— index.html: кнопки и версия ——
test('index.html: кнопка mmCorner (data-mm=corner)', () => {
  assert.ok(HTML.includes('id="mmCorner"') && HTML.includes('data-mm="corner"'), 'no corner button');
});
test('index.html: кнопки Notion (mmNotion/mlNotion)', () => {
  assert.ok(HTML.includes('id="mmNotion"'), 'no mmNotion');
  assert.ok(HTML.includes('id="mlNotion"'), 'no mlNotion');
});
test('index.html: версия — все теги 1079, нет 1078', () => {
  assert.ok(HTML.includes('?v=1089'), 'no 1079');
  assert.ok(!HTML.includes('?v=1077'), '1076 left');
});
