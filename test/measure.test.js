'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../renderer/measure.js');

const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

test('distance: 3-4-5 и осевые компоненты', () => {
  const r = M.distance([0, 0, 0], [3, 0, 4]);
  assert.ok(near(r.d3, 5));
  assert.ok(near(r.horizontal, 5)); // dx,dz → sqrt(9+16)=5
  assert.ok(near(r.vertical, 0));
  const r2 = M.distance([0, 0, 0], [0, 2, 0]);
  assert.ok(near(r2.vertical, 2));
  assert.ok(near(r2.horizontal, 0));
});

test('polylineLength: открытая и замкнутая', () => {
  const pts = [[0, 0, 0], [1, 0, 0], [1, 0, 1]];
  assert.ok(near(M.polylineLength(pts).total, 2));
  assert.ok(near(M.polylineLength(pts, true).total, 2 + Math.SQRT2));
});

test('angleAt: прямой угол и 45°', () => {
  const a = M.angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0]);
  assert.ok(near(a.deg, 90, 1e-4));
  const b = M.angleAt([1, 0, 0], [0, 0, 0], [1, 1, 0]);
  assert.ok(near(b.deg, 45, 1e-4));
});

test('fitPlanePCA: горизонтальная плоскость y=2', () => {
  const pts = [];
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) pts.push([x, 2, z]);
  const pl = M.fitPlanePCA(pts);
  assert.ok(Math.abs(pl.normal[1]) > 0.999); // нормаль ≈ ±Y
  assert.ok(near(pl.rms, 0, 1e-6));
  // точка (2,2,2) лежит на плоскости
  assert.ok(near(M.pointPlaneDist([2, 2, 2], pl), 0, 1e-6));
  // точка на 1 выше → |расстояние|=1
  assert.ok(near(Math.abs(M.pointPlaneDist([2, 3, 2], pl)), 1, 1e-6));
});

test('fitPlanePCA: вертикальная стена x=5 → нормаль ≈ X', () => {
  const pts = [];
  for (let y = 0; y <= 3; y++) for (let z = 0; z <= 6; z++) pts.push([5, y, z]);
  const pl = M.fitPlanePCA(pts);
  assert.ok(Math.abs(pl.normal[0]) > 0.999);
  const o = M.orientation(pl.normal);
  assert.ok(o.dip > 78, 'dip=' + o.dip);
  assert.strictEqual(o.kind, 'вертикальная (стена)');
});

test('orientation: горизонталь классифицируется как пол/потолок', () => {
  const o = M.orientation([0, 1, 0]);
  assert.ok(near(o.dip, 0, 1e-6));
  assert.strictEqual(o.kind, 'горизонтальная (пол/потолок)');
});

test('ransacPlane: плоскость с выбросами', () => {
  const pts = [];
  for (let x = 0; x <= 9; x++) for (let z = 0; z <= 9; z++) pts.push([x, 1 + (((x * 7 + z) % 5) - 2) * 0.002, z]); // шум ±4мм
  // 20 точек-выбросов далеко от плоскости
  for (let i = 0; i < 20; i++) pts.push([i % 10, 5 + i, (i * 3) % 10]);
  const pl = M.ransacPlane(pts, { threshold: 0.05, iters: 400 });
  assert.ok(Math.abs(pl.normal[1]) > 0.99, 'normal.y=' + pl.normal[1]);
  assert.ok(pl.inlierCount >= 100, 'inliers=' + pl.inlierCount);
  assert.ok(pl.rms < 0.01, 'rms=' + pl.rms);
});

test('planeExtents: стена 6×3 → длина≈6, высота≈3', () => {
  const pts = [];
  for (let y = 0; y <= 3; y++) for (let z = 0; z <= 6; z++) pts.push([5, y, z]);
  const pl = M.fitPlanePCA(pts);
  const ext = M.planeExtents(pts, pl);
  assert.ok(near(ext.length, 6, 1e-4), 'length=' + ext.length);
  assert.ok(near(ext.width, 3, 1e-4), 'width=' + ext.width);
  assert.ok(near(ext.rectArea, 18, 1e-3), 'area=' + ext.rectArea);
});

test('polygonArea3D: квадрат 2×2 в плоскости XZ', () => {
  const sq = [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]];
  const r = M.polygonArea3D(sq);
  assert.ok(near(r.area, 4, 1e-6), 'area=' + r.area);
  assert.ok(near(r.perimeter, 8, 1e-6));
  assert.ok(Math.abs(r.normal[1]) > 0.999);
});

test('polygonArea3D: наклонный треугольник сохраняет площадь', () => {
  // треугольник в 3D: (0,0,0),(2,0,0),(0,2,2); площадь = 0.5*|AB×AC|
  const t = [[0, 0, 0], [2, 0, 0], [0, 2, 2]];
  const r = M.polygonArea3D(t);
  const AB = [2, 0, 0], AC = [0, 2, 2];
  const cr = M.cross(AB, AC); const expected = 0.5 * M.len(cr);
  assert.ok(near(r.area, expected, 1e-6), r.area + ' vs ' + expected);
});

test('jacobiEigen3: диагональная матрица', () => {
  const e = M.jacobiEigen3([[3, 0, 0], [0, 1, 0], [0, 0, 2]]);
  assert.ok(near(e.values[0], 3) && near(e.values[1], 2) && near(e.values[2], 1));
});

test('jacobiEigen3: известная недиагональная (ортогональность векторов)', () => {
  const e = M.jacobiEigen3([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);
  // собств. значения: 5, 3, 1
  assert.ok(near(e.values[0], 5, 1e-6) && near(e.values[1], 3, 1e-6) && near(e.values[2], 1, 1e-6));
  // векторы ортогональны и единичны
  for (const v of e.vectors) assert.ok(near(M.len(v), 1, 1e-6));
  assert.ok(near(M.dot(e.vectors[0], e.vectors[1]), 0, 1e-6));
  assert.ok(near(M.dot(e.vectors[0], e.vectors[2]), 0, 1e-6));
});

test('fmtLen/fmtArea: единицы', () => {
  assert.ok(M.fmtLen(0.005).includes('мм'));
  assert.ok(M.fmtLen(0.5).includes('см'));
  assert.ok(M.fmtLen(2.5).includes('м'));
  assert.ok(M.fmtArea(0.005).includes('см²'));
  assert.ok(M.fmtArea(5).includes('м²'));
});
