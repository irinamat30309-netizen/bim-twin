'use strict';
// v1145 regression tests: SOG `means` are stored in LOG space (sign-preserving
// log1p at export). The loader must invert this with expm1 to recover true world
// coordinates. This was the root cause of the corridor-size distortion: without
// expm1 the whole scene decoded into a ~7.7m squished box while gaussian sizes
// stayed in meters, so far-from-origin corridors looked huge and near ones tiny.
//
// Ground truth used below comes from the real converted scan (bgf.lcc2 + mesh):
//   - leaf pack 0_7_0_0_1_0 means.mins[0]=3.078474, maxs[0]=3.911751
//   - expm1(3.078474)=20.72, expm1(3.911751)=48.99  -> branch 7 world X range
//   - octree node span for that leaf ~= [29.19, 29.37, 7.88]

const test = require('node:test');
const assert = require('node:assert');
const L = require('../renderer/lcc2-loader.js');

test('logDecode is exported and is the signed inverse of log1p', () => {
  assert.strictEqual(typeof L.logDecode, 'function');
  // inverse of v = sign(x)*log1p(|x|)  =>  x = sign(v)*expm1(|v|)
  for (const x of [0, 0.5, -0.5, 3.0785, -3.4068, 12.7, -39.44, 48.99]) {
    const v = (x < 0 ? -1 : 1) * Math.log1p(Math.abs(x));
    assert.ok(Math.abs(L.logDecode(v) - x) < 1e-9, 'roundtrip x=' + x);
  }
});

test('logDecode(0) === 0 and preserves sign', () => {
  assert.strictEqual(L.logDecode(0), 0);
  assert.ok(L.logDecode(2) > 0);
  assert.ok(L.logDecode(-2) < 0);
});

test('leaf pack 0_7_0_0_1_0 X extremes decode to true world range (branch 7)', () => {
  const minX = L.logDecode(3.078474760055542);
  const maxX = L.logDecode(3.9117512702941895);
  assert.ok(Math.abs(minX - 20.72) < 0.05, 'minX=' + minX);
  assert.ok(Math.abs(maxX - 48.99) < 0.05, 'maxX=' + maxX);
  // The decoded X span must be ~28.3m (matches octree node bbox ~29m), NOT the
  // squished linear span of ~0.83m that caused the distortion.
  assert.ok((maxX - minX) > 25, 'decoded span too small: ' + (maxX - minX));
});

test('log decode expands far-from-origin regions more than near ones (explains distortion)', () => {
  // Two objects of equal STORED span (0.5) but at different distances.
  const nearSpan = L.logDecode(1.0) - L.logDecode(0.5);   // near origin
  const farSpan  = L.logDecode(4.0) - L.logDecode(3.5);   // far from origin
  // Under the old linear decode both spans were identical (0.5). Under the correct
  // log decode the far span is much larger, which is exactly why a single global
  // scale could never fix every corridor at once.
  assert.ok(farSpan > nearSpan * 5, 'far/near ratio=' + (farSpan / nearSpan));
});

test('getRemapMode still defaults to identity (placement per USD scene)', () => {
  assert.strictEqual(L.getRemapMode(), 'identity');
});
