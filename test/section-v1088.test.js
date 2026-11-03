'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../renderer/section.js');

test('sliceSlab keeps only points in the slab and projects to plane (axis y)', () => {
  const pos = [];
  for (let i = 0; i < 10; i++) pos.push(i * 0.1, 0.0, 2.0);      // плита y=0
  for (let i = 0; i < 5; i++) pos.push(i * 0.1, 5.0, 2.0);       // шум y=5
  const count = pos.length / 3;
  const sl = S.sliceSlab(pos, count, { axis: 'y', level: 0, thickness: 0.2 });
  assert.strictEqual(sl.pts.length, 10, 'only the y=0 slab points survive');
  assert.deepStrictEqual(sl.pts[0], [0.0, 2.0]);   // проекция 'y' → (x,z)
  assert.deepStrictEqual(sl.pts[9], [0.9, 2.0]);
});

test('gridOccupancy marks occupied cells and grid dims', () => {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const g = S.gridOccupancy(pts, 0.5);
  assert.strictEqual(g.nx, 3);   // ceil(1/0.5)+1 = 3
  assert.strictEqual(g.ny, 3);
  let occN = 0; for (let i = 0; i < g.occ.length; i++) occN += g.occ[i];
  assert.strictEqual(occN, 4, 'four corner cells occupied');
});

test('traceContours returns one closed loop for a filled rectangle', () => {
  const nx = 5, ny = 4, cell = 1;
  const occ = new Uint8Array(nx * ny); occ.fill(1);
  const grid = { occ, nx, ny, mn: [0, 0], cell };
  const loops = S.traceContours(grid, { minLoop: 4 });
  assert.strictEqual(loops.length, 1, 'solid rect -> single boundary loop');
  const closed = loops[0].concat([loops[0][0]]);
  assert.ok(Math.abs(S.perim(closed) - 2 * (nx + ny)) < 1e-6, 'perimeter matches rectangle');
});

test('simplifyRDP collapses collinear runs but keeps corners', () => {
  const pts = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2]];
  const out = S.simplifyRDP(pts, 0.01);
  assert.deepStrictEqual(out, [[0, 0], [3, 0], [3, 2]], 'reduced to two segments (one corner)');
});

test('perpDist is correct', () => {
  assert.ok(Math.abs(S.perpDist([1, 1], [0, 0], [2, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(S.perpDist([1, 0], [0, 0], [2, 0]) - 0) < 1e-9);
});

test('sectionToPolylines turns a room slice into a closed plan contour', () => {
  // синтетическая комната 4m x 3m со стенами толщиной ~0.3м на y=0
  const pos = [];
  const step = 0.05;
  for (let t = 0; t <= 0.3001; t += 0.1) {
    for (let x = 0; x <= 4.0001; x += step) { pos.push(x, 0, 0 + t); pos.push(x, 0, 3 - t); }
    for (let z = 0; z <= 3.0001; z += step) { pos.push(0 + t, 0, z); pos.push(4 - t, 0, z); }
  }
  // шум на другой высоте — не должен попасть в сечение
  for (let k = 0; k < 50; k++) pos.push((k % 40) * 0.1, 3, (k % 30) * 0.1);
  const count = pos.length / 3;
  const res = S.sectionToPolylines(pos, count, { axis: 'y', level: 0, thickness: 0.2, cell: 0.2 });
  assert.ok(res.loops.length >= 1, 'at least one contour');
  const big = res.loops[0];
  assert.ok(big.closed, 'contour is closed');
  const bb = S.bbox2d(big.points);
  const w = bb.mx[0] - bb.mn[0], h = bb.mx[1] - bb.mn[1];
  assert.ok(w > 3.6 && w < 4.6, 'outer width near 4m: ' + w);
  assert.ok(h > 2.6 && h < 3.6, 'outer height near 3m: ' + h);
  assert.ok(big.points.length >= 4 && big.points.length <= 12, 'few corners after RDP: ' + big.points.length);
  assert.strictEqual(res.sliced > 0, true);
});
