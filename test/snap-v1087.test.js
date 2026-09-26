const test = require('node:test');
const assert = require('node:assert');
const Snap = require('../renderer/snap.js');

test('segInt: пересекающиеся отрезки', () => {
  const p = Snap.segInt([0, 0], [4, 4], [0, 4], [4, 0]);
  assert.ok(p); assert.ok(Math.abs(p[0] - 2) < 1e-9 && Math.abs(p[1] - 2) < 1e-9);
});
test('segInt: непересекающиеся / параллельные', () => {
  assert.equal(Snap.segInt([0, 0], [1, 0], [0, 1], [1, 1]), null);
  assert.equal(Snap.segInt([0, 0], [1, 0], [2, 0], [3, 0]), null);
});
test('snap: к вершине в пределах допуска', () => {
  const ents = [{ type: 'line', a: [0, 0], b: [10, 0] }];
  const r = Snap.snap([9.9, 0.05], ents, { tol: 0.3 });
  assert.ok(r); assert.equal(r.type, 'vertex');
  assert.deepEqual(r.point, [10, 0]);
});
test('snap: ничего вне допуска', () => {
  const ents = [{ type: 'line', a: [0, 0], b: [10, 0] }];
  assert.equal(Snap.snap([5, 5], ents, { tol: 0.3 }), null);
});
test('snap: пересечение двух линий', () => {
  const ents = [{ type: 'line', a: [0, 0], b: [4, 4] }, { type: 'line', a: [0, 4], b: [4, 0] }];
  const r = Snap.snap([2.05, 1.98], ents, { tol: 0.3, vertex: false });
  assert.ok(r); assert.equal(r.type, 'intersection');
});
test('snap: приоритет vertex над intersection', () => {
  const ents = [{ type: 'line', a: [0, 0], b: [4, 4] }, { type: 'line', a: [0, 4], b: [4, 0] }];
  // курсор рядом с центром (пересечение в [2,2]) — вершин рядом нет, берём intersection
  const r = Snap.snap([2.02, 2.02], ents, { tol: 0.3 });
  assert.equal(r.type, 'intersection');
});
test('snap: середина отрезка', () => {
  const ents = [{ type: 'line', a: [0, 0], b: [10, 0] }];
  const r = Snap.snap([5.02, 0.02], ents, { tol: 0.3, vertex: false, intersection: false, midpoint: true });
  assert.ok(r); assert.equal(r.type, 'midpoint'); assert.deepEqual(r.point, [5, 0]);
});
test('snap: к сетке', () => {
  const r = Snap.snap([1.03, 1.96], [], { tol: 0.3, grid: 1 });
  assert.ok(r); assert.equal(r.type, 'grid'); assert.deepEqual(r.point, [1, 2]);
});
test('orthoConstrain: горизонталь/вертикаль 90°', () => {
  const h = Snap.orthoConstrain([0, 0], [10, 0.4]);
  assert.ok(Math.abs(h[1]) < 1e-9); // притянуто к горизонтали
  const v = Snap.orthoConstrain([0, 0], [0.4, 10]);
  assert.ok(Math.abs(v[0]) < 1e-9); // к вертикали
});
test('orthoConstrain: сохраняет длину', () => {
  const r = Snap.orthoConstrain([0, 0], [3, 4], { angleStep: 45 });
  assert.ok(Math.abs(Math.hypot(r[0], r[1]) - 5) < 1e-9);
});
