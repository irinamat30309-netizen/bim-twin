const test = require('node:test');
const assert = require('node:assert');
const M = require('../renderer/measure.js');
const near = (a, b, e) => Math.abs(a - b) <= (e === undefined ? 1e-6 : e);

// ---- classifyLocal: plane / edge / corner ----
test('classifyLocal: планарное облако распознаётся как plane', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) pts.push([i * 0.1, 5, j * 0.1]);
  const c = M.classifyLocal(pts);
  assert.strictEqual(c.kind, 'plane');
  assert.ok(c.planarity > 0.5, 'planarity=' + c.planarity);
});

test('classifyLocal: линейное облако распознаётся как edge', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([i * 0.05, 1 + (Math.random() - 0.5) * 1e-4, 2 + (Math.random() - 0.5) * 1e-4]);
  const c = M.classifyLocal(pts);
  assert.strictEqual(c.kind, 'edge');
  assert.ok(c.linearity > 0.55, 'linearity=' + c.linearity);
});

test('classifyLocal: объёмное облако распознаётся как corner', () => {
  const pts = [];
  let s = 7;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 200; i++) pts.push([rnd(), rnd(), rnd()]);
  const c = M.classifyLocal(pts);
  assert.strictEqual(c.kind, 'corner');
  assert.ok(c.scattering > 0.10, 'scattering=' + c.scattering);
});

// ---- fitLinePCA ----
test('fitLinePCA: направление вдоль оси X', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push([i * 0.1, 3, -2]);
  const l = M.fitLinePCA(pts);
  assert.ok(Math.abs(Math.abs(l.dir[0]) - 1) < 1e-6, 'dir=' + l.dir);
  assert.ok(l.rms < 1e-9);
});

// ---- snapToFeature ----
test('snapToFeature: клик рядом с плоскостью проецируется на неё (y=5)', () => {
  const pts = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) pts.push([i * 0.1, 5, j * 0.1]);
  const snapped = M.snapToFeature([0.55, 5.08, 0.55], pts); // 8 см в сторону от плоскости
  assert.strictEqual(snapped.kind, 'plane');
  assert.ok(near(snapped.point[1], 5, 1e-3), 'y=' + snapped.point[1]);
});

test('snapToFeature: клик рядом с ребром проецируется на линию', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([i * 0.05, 1, 2]);
  const snapped = M.snapToFeature([1.0, 1.05, 2.05], pts);
  assert.strictEqual(snapped.kind, 'edge');
  assert.ok(near(snapped.point[1], 1, 1e-6) && near(snapped.point[2], 2, 1e-6));
});

test('snapToFeature: угол → ближайшая реальная точка', () => {
  let s = 3;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([rnd(), rnd(), rnd()]);
  const snapped = M.snapToFeature([0.5, 0.5, 0.5], pts);
  assert.strictEqual(snapped.kind, 'corner');
  assert.ok(pts.some(p => p[0] === snapped.point[0] && p[1] === snapped.point[1] && p[2] === snapped.point[2]));
});

// ---- signedPointPlane (deviation) ----
test('signedPointPlane: знак и величина отклонения', () => {
  const plane = { normal: [0, 1, 0], d: -5 }; // y = 5
  const above = M.signedPointPlane([1, 5.03, 2], plane);
  assert.ok(near(above.signed, 0.03, 1e-9) && above.sign === 1);
  assert.ok(near(above.foot[1], 5, 1e-9));
  const below = M.signedPointPlane([1, 4.98, 2], plane);
  assert.ok(near(below.signed, -0.02, 1e-9) && below.sign === -1);
  assert.ok(near(below.distance, 0.02, 1e-9));
});

// ---- CSV export ----
test('measurementsToCsv: заголовок + строки по типам', () => {
  const list = [
    { mode: 'distance', d3: 2.5, horizontal: 2.0, vertical: 1.5, dx: 1, dy: 1.5, dz: 1.732, label: 'ширина' },
    { mode: 'plane', length: 6, width: 3, dip: 89.5, rms: 0.004, kind: 'вертикальная (стена)' },
    { mode: 'deviation', signed: -0.012, sign: -1 }
  ];
  const csv = M.measurementsToCsv(list);
  const lines = csv.split('\n');
  assert.strictEqual(lines.length, 4);
  assert.ok(lines[0].startsWith('#,'));
  assert.ok(lines[1].includes('distance') && lines[1].includes('2.5000'));
  assert.ok(lines[2].includes('plane') && lines[2].includes('6.0000×3.0000'));
  assert.ok(lines[3].includes('deviation'));
});

test('measurementsToCsv: экранирование запятых/кавычек в подписи', () => {
  const csv = M.measurementsToCsv([{ mode: 'point', point: [1, 2, 3], label: 'стена, №1 "главная"' }]);
  const line = csv.split('\n')[1];
  assert.ok(line.includes('"стена, №1 ""главная"""'), line);
});
