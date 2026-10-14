const test = require('node:test');
const assert = require('node:assert');
const M = require('../renderer/measure.js');
const near = (a, b, e) => Math.abs(a - b) <= (e === undefined ? 1e-9 : e);

test('angleBetweenPlanes: перпендикулярные = 90°', () => {
  const a = { normal: [1, 0, 0], d: 0 }, b = { normal: [0, 1, 0], d: 0 };
  assert.ok(near(M.angleBetweenPlanes(a, b).deg, 90, 1e-6));
});

test('angleBetweenPlanes: параллельные = 0° (независимо от направления)', () => {
  const a = { normal: [0, 1, 0], d: -2 }, b = { normal: [0, -1, 0], d: 5 };
  assert.ok(near(M.angleBetweenPlanes(a, b).deg, 0, 1e-6));
});

test('angleBetweenPlanes: 45°', () => {
  const a = { normal: [1, 0, 0], d: 0 }, b = { normal: [1, 1, 0], d: 0 };
  assert.ok(near(M.angleBetweenPlanes(a, b).deg, 45, 1e-6));
});

test('intersectPlanes: x=0 ∩ y=0 → ось Z', () => {
  const a = { normal: [1, 0, 0], d: 0 }, b = { normal: [0, 1, 0], d: 0 };
  const r = M.intersectPlanes(a, b);
  assert.ok(near(r.point[0], 0) && near(r.point[1], 0));
  assert.ok(Math.abs(Math.abs(r.dir[2]) - 1) < 1e-9, 'dir=' + r.dir);
});

test('intersectPlanes: смещённые плоскости x=3 ∩ y=2', () => {
  const a = { normal: [1, 0, 0], d: -3 }, b = { normal: [0, 1, 0], d: -2 };
  const r = M.intersectPlanes(a, b);
  assert.ok(near(r.point[0], 3, 1e-9) && near(r.point[1], 2, 1e-9), 'p=' + r.point);
});

test('intersectPlanes: параллельные → null', () => {
  const a = { normal: [0, 1, 0], d: -1 }, b = { normal: [0, 1, 0], d: -4 };
  assert.strictEqual(M.intersectPlanes(a, b), null);
});

test('intersectThreePlanes: угол комнаты (3,2,1)', () => {
  const a = { normal: [1, 0, 0], d: -3 }, b = { normal: [0, 1, 0], d: -2 }, c = { normal: [0, 0, 1], d: -1 };
  const r = M.intersectThreePlanes(a, b, c);
  assert.ok(near(r.point[0], 3, 1e-9) && near(r.point[1], 2, 1e-9) && near(r.point[2], 1, 1e-9), 'p=' + r.point);
});

test('intersectThreePlanes: вырожденная система → null', () => {
  const a = { normal: [1, 0, 0], d: 0 }, b = { normal: [1, 0, 0], d: -1 }, c = { normal: [0, 1, 0], d: 0 };
  assert.strictEqual(M.intersectThreePlanes(a, b, c), null);
});

test('intersectPlanes: точка лежит на обеих плоскостях (проверка уравнений)', () => {
  const a = { normal: M.norm([1, 2, 1]), d: -0.5 }, b = { normal: M.norm([-1, 1, 3]), d: 0.2 };
  const r = M.intersectPlanes(a, b);
  assert.ok(near(M.dot(a.normal, r.point) + a.d, 0, 1e-9), 'not on A');
  assert.ok(near(M.dot(b.normal, r.point) + b.d, 0, 1e-9), 'not on B');
  // направление перпендикулярно обеим нормалям
  assert.ok(near(M.dot(a.normal, r.dir), 0, 1e-9) && near(M.dot(b.normal, r.dir), 0, 1e-9));
});

test('measurementsToCsv: строка режима corner', () => {
  const csv = M.measurementsToCsv([{ mode: 'corner', angleDeg: 90, corner: [3, 2, 1], dir: [0, 0, 1], planeCount: 3, label: 'угол комнаты' }]);
  const line = csv.split('\n')[1];
  assert.ok(line.includes('corner') && line.includes('90') && line.includes('угол_xyz='), line);
});
