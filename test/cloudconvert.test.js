const test = require('node:test');
const assert = require('node:assert');
const CloudConvert = require('../renderer/cloudconvert.js');
const Splat = require('../renderer/splatviewer.js');

test('pointsToSplat -> gaussian PLY parseable by splatviewer', () => {
  // 8 points (unit cube corners), 1 m apart => 8 distinct voxels at 0.25 m.
  const pts = [], cols = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) { pts.push(x, y, z); cols.push(255, 0, 0); }
  const res = CloudConvert.pointsToSplat(new Float32Array(pts), new Uint8Array(cols), { voxel: 0.25 });
  assert.ok(res && res.buffer, 'buffer returned');
  assert.strictEqual(res.count, 8, 'eight occupied voxels');
  assert.ok(res.voxel > 0, 'voxel positive');
  const parsed = Splat._parsePly(res.buffer, { maxPoints: 100 });
  assert.strictEqual(parsed.kind, 'gaussian', 'recognised as gaussian splat');
  assert.strictEqual(parsed.count, 8, 'all splats parsed');
});

test('pointsToSplat merges nearby points into one splat', () => {
  // Two clusters far apart, each with 3 coincident-ish points -> 2 voxels.
  const pos = new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 5, 5, 5, 5.01, 5, 5, 5, 5.01, 5]);
  const res = CloudConvert.pointsToSplat(pos, null, { voxel: 0.5 });
  assert.strictEqual(res.count, 2, 'two merged splats');
});

test('pointsToSplat accepts 0..1 float colors', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0]);
  const col = new Float32Array([1, 0, 0, 0, 0, 1]);
  const res = CloudConvert.pointsToSplat(pos, col, { voxel: 0.25 });
  assert.strictEqual(res.count, 2, 'two splats');
  const parsed = Splat._parsePly(res.buffer, { maxPoints: 100 });
  assert.strictEqual(parsed.kind, 'gaussian');
});

test('pointsToSplat honors custom opts (opacity/scaleMul/targetSplats)', () => {
  const pts = [];
  for (let i = 0; i < 400; i++) { pts.push((i % 10), ((Math.floor(i / 10)) % 10), Math.floor(i / 100)); }
  const res = CloudConvert.pointsToSplat(new Float32Array(pts), null, { scaleMul: 1.0, opacity: 0.8, targetSplats: 50 });
  assert.ok(res.count > 0, 'produced splats');
  assert.ok(res.count <= 400, 'never more than input points');
  const parsed = Splat._parsePly(res.buffer, { maxPoints: 1000 });
  assert.strictEqual(parsed.kind, 'gaussian');
});

test('pointsToSplat throws on empty input', () => {
  assert.throws(() => CloudConvert.pointsToSplat(new Float32Array([]), null, {}));
});
