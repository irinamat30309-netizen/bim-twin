'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PCLod = require('../renderer/pointcloud-octree.js');

function makeCloud(n, withColor) {
  const pos = new Float32Array(n * 3);
  const col = withColor ? new Float32Array(n * 3) : null;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    pos[i * 3] = rnd() * 100;
    pos[i * 3 + 1] = rnd() * 40;
    pos[i * 3 + 2] = rnd() * 100;
    if (col) { col[i * 3] = rnd(); col[i * 3 + 1] = rnd(); col[i * 3 + 2] = rnd(); }
  }
  return { pos, col };
}

test('build preserves every point across cells (no loss, no duplication)', () => {
  const { pos } = makeCloud(50000, false);
  const lod = PCLod.build(pos, null, { pointsPerCell: 8000 });
  let sum = 0;
  for (const c of lod.cells) sum += c.pos.length / 3;
  assert.strictEqual(sum, lod.total, 'sum of cell points must equal total');
  assert.strictEqual(lod.total, 50000);
  assert.ok(lod.cellCount > 1, 'should split into multiple cells');
});

test('coarse layer respects budget and is a subsample', () => {
  const { pos } = makeCloud(40000, false);
  const lod = PCLod.build(pos, null, { coarseBudget: 5000 });
  const cc = lod.coarse.pos.length / 3;
  assert.ok(cc <= 5000 + 1, 'coarse must not exceed budget');
  assert.ok(cc > 0, 'coarse must have points');
});

test('bbox encloses all points', () => {
  const { pos } = makeCloud(20000, false);
  const lod = PCLod.build(pos, null, {});
  const { mn, mx } = lod.bbox;
  for (let i = 0; i < pos.length; i += 3) {
    assert.ok(pos[i] >= mn[0] - 1e-3 && pos[i] <= mx[0] + 1e-3);
    assert.ok(pos[i + 1] >= mn[1] - 1e-3 && pos[i + 1] <= mx[1] + 1e-3);
    assert.ok(pos[i + 2] >= mn[2] - 1e-3 && pos[i + 2] <= mx[2] + 1e-3);
  }
});

test('each cell aabb encloses its own points', () => {
  const { pos } = makeCloud(30000, false);
  const lod = PCLod.build(pos, null, { pointsPerCell: 5000 });
  for (const c of lod.cells) {
    for (let i = 0; i < c.pos.length; i += 3) {
      assert.ok(c.pos[i] >= c.mn[0] - 1e-3 && c.pos[i] <= c.mx[0] + 1e-3);
      assert.ok(c.pos[i + 1] >= c.mn[1] - 1e-3 && c.pos[i + 1] <= c.mx[1] + 1e-3);
      assert.ok(c.pos[i + 2] >= c.mn[2] - 1e-3 && c.pos[i + 2] <= c.mx[2] + 1e-3);
    }
  }
});

test('color arrays preserved with matching length', () => {
  const { pos, col } = makeCloud(15000, true);
  const lod = PCLod.build(pos, col, { pointsPerCell: 4000 });
  for (const c of lod.cells) {
    assert.ok(c.col, 'cell must have color');
    assert.strictEqual(c.col.length, c.pos.length, 'color length matches pos length');
  }
  assert.ok(lod.coarse.col && lod.coarse.col.length === lod.coarse.pos.length);
});

test('handles tiny cloud gracefully', () => {
  const { pos } = makeCloud(10, false);
  const lod = PCLod.build(pos, null, {});
  let sum = 0; for (const c of lod.cells) sum += c.pos.length / 3;
  assert.strictEqual(sum, 10);
});
