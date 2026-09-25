'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Me = require('../renderer/measure.js');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

// v1082: калибровка масштаба/единиц, масштабирование измерений, координатные выноски.

test('calibrate: k = эталон / измеренное, ppm и поправка', () => {
  const c = Me.calibrate(0.998, 1.0);
  assert.ok(c.ok);
  assert.ok(Math.abs(c.scale - (1.0 / 0.998)) < 1e-12);
  assert.ok(Math.abs(c.delta - 0.002) < 1e-12);
  assert.ok(Math.abs(c.ppm - (c.scale - 1) * 1e6) < 1e-6);
});

test('calibrate: единичный масштаб при равных значениях', () => {
  const c = Me.calibrate(2, 2);
  assert.ok(c.ok);
  assert.strictEqual(c.scale, 1);
  assert.strictEqual(c.ppm, 0);
});

test('calibrate: отклоняет некорректный ввод', () => {
  for (const bad of [[0, 1], [1, 0], [-1, 1], [NaN, 1], [1, Infinity]]) {
    const c = Me.calibrate(bad[0], bad[1]);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.scale, 1);
  }
});

test('scaleMeasurement: длины × k, площади × k²', () => {
  const k = 2;
  const dist = Me.scaleMeasurement({ mode: 'distance', d3: 3, dx: 1, dy: 2, dz: 2, horizontal: Math.hypot(1, 2), vertical: 2 }, k);
  assert.strictEqual(dist.d3, 6);
  assert.strictEqual(dist.dy, 4);
  assert.strictEqual(dist.calibScale, 2);
  const area = Me.scaleMeasurement({ mode: 'area', area: 5, perimeter: 10 }, k);
  assert.strictEqual(area.area, 20);      // k²
  assert.strictEqual(area.perimeter, 20); // k
});

test('scaleMeasurement: согласовано с реальными точками', () => {
  const d0 = Me.distance([0, 0, 0], [3, 4, 0]); d0.mode = 'distance';
  const scaled = Me.scaleMeasurement(d0, 1.5);
  const d1 = Me.distance([0, 0, 0], [4.5, 6, 0]);
  assert.ok(Math.abs(scaled.d3 - d1.d3) < 1e-9);
});

test('scaleMeasurement: невалидный k → без изменений длины', () => {
  const out = Me.scaleMeasurement({ mode: 'distance', d3: 3 }, 0);
  assert.strictEqual(out.d3, 3);
});

test('coordLabel: инженерные и геодезические координаты', () => {
  const eng = Me.coordLabel([1, 2, 3]);
  assert.deepStrictEqual([eng.x, eng.y, eng.z], [1, 2, 3]);
  assert.strictEqual(eng.text.indexOf('X 1.000'), 0);
  const sv = Me.coordLabel([1, 2, 3], { order: 'survey' });
  assert.deepStrictEqual([sv.x, sv.y, sv.z], [1, -3, 2]);
});

test('html/app: версия 1082', () => {
  assert.ok(HTML.includes('measure.js?v=1154'), 'measure.js not 1082');
  assert.ok(APP.includes('готова · v1160'), 'banner not 1082');
});
