'use strict';
/* Ручная привязка курсора (renderer/precision-snap.js): угол прямоугольного воздуховода не даёт «круглую поверхность» с радиусом (ревизия 11),
 * а настоящая труба рядом по-прежнему распознаётся. */
const test = require('node:test');
const assert = require('node:assert/strict');
const PS = require('../renderer/precision-snap.js');
const { Scene } = require('./helpers/auto-synth.js');

function ductScene(noise, pipe) {
  const sc = new Scene(11, 0.01, noise), w = 0.3, h = 0.2, y0 = 2.2;
  sc.plane([-w / 2, y0, 0], [1, 0, 0], [0, 0, 1], w, 3);
  sc.plane([-w / 2, y0, 0], [0, 1, 0], [0, 0, 1], h, 3);
  sc.plane([w / 2, y0, 0], [0, 1, 0], [0, 0, 1], h, 3);
  sc.plane([-w / 2, y0 + h, 0], [1, 0, 0], [0, 0, 1], w, 3);
  if (pipe) sc.cyl([1.0, 2.3, 0], [0, 0, 1], 0.06, 0, 3, {});
  const pos = sc.f32([0, 0, 0]);
  return { pos, index: PS.buildIndex(pos) };
}

test('углы и грани прямоугольного воздуховода при шуме 4–12 мм не превращаются в цилиндр', () => {
  for (const noise of [0.004, 0.008, 0.012]) {
    const { index } = ductScene(noise, false);
    for (const seed of [[0.15, 2.2, 1.5], [0.15, 2.4, 1.5], [-0.15, 2.2, 1.5], [-0.15, 2.4, 1.5], [0.15, 2.3, 1.5], [0, 2.2, 1.5]]) {
      const r = PS.snap(seed, index, { snapDist: 0.06, grow: true });
      assert.ok(!(r && r.kind === 'curve'), 'шум ' + noise + ', курсор ' + seed + ': ' + (r && r.kind) + (r && r.cylinder ? ' R=' + r.cylinder.radius : ''));
    }
  }
});

test('труба Ø120 рядом с воздуховодом по-прежнему распознаётся как цилиндр с верным радиусом', () => {
  const { index } = ductScene(0.004, true);
  const r = PS.snap([1.0, 2.36, 1.5], index, { snapDist: 0.06, grow: true });
  assert.ok(r && r.kind === 'curve' && r.cylinder, 'вид: ' + (r && r.kind));
  assert.ok(Math.abs(r.cylinder.radius - 0.06) < 0.004, 'радиус ' + r.cylinder.radius);
});
