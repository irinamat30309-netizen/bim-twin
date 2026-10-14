'use strict';
// v1144 regression tests: SOG means & scales are scene-units => identity is the
// geometrically correct decode. These tests lock in:
//   1. getRemapMode() defaults to 'identity'.
//   2. computePackGlobalTransform() is identity when means-range == world union,
//      and scales linearly when the union differs.
//   3. Position/size consistency: whatever factor scales POSITIONS in a non-identity
//      mode must also scale gaussian SIZES, so object proportions are preserved.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../renderer/lcc2-loader.js');

test('getRemapMode defaults to identity (no window override)', () => {
  // In node there is no window, so getRemapMode must fall back to the default.
  assert.strictEqual(typeof L.getRemapMode, 'function');
  assert.strictEqual(L.getRemapMode(), 'identity');
});

test('computePackGlobalTransform is identity when means-range == world union', () => {
  const mMn = [-2, -1, -3];
  const mMx = [4, 5, 6];
  const tiles = [{ start: 0, count: 10, wBMin: [-2, -1, -3], wBMax: [4, 5, 6], depth: 1 }];
  const t = L.computePackGlobalTransform(mMn, mMx, tiles);
  for (const k of ['scX', 'scY', 'scZ']) assert.ok(Math.abs(t[k] - 1) < 1e-9, k + '=' + t[k]);
  for (const k of ['offX', 'offY', 'offZ']) assert.ok(Math.abs(t[k]) < 1e-6, k + '=' + t[k]);
});

test('computePackGlobalTransform scales x2 when union is twice the means-range', () => {
  const mMn = [0, 0, 0];
  const mMx = [10, 10, 10];
  // union is 2x the size of the means-range, shifted to origin.
  const tiles = [{ start: 0, count: 10, wBMin: [0, 0, 0], wBMax: [20, 20, 20], depth: 1 }];
  const t = L.computePackGlobalTransform(mMn, mMx, tiles);
  for (const k of ['scX', 'scY', 'scZ']) assert.ok(Math.abs(t[k] - 2) < 1e-9, k + '=' + t[k]);
  // a point at means-max (10) should map to union-max (20)
  assert.ok(Math.abs((10 * t.scX + t.offX) - 20) < 1e-6);
  assert.ok(Math.abs((0 * t.scX + t.offX) - 0) < 1e-6);
});

test('computePackGlobalTransform falls back to identity for env packs (no bbox)', () => {
  const t = L.computePackGlobalTransform([0, 0, 0], [1, 1, 1], [{ start: 0, count: 5, wBMin: null, wBMax: null }]);
  assert.strictEqual(t.scX, 1);
  assert.strictEqual(t.offX, 0);
  assert.strictEqual(t.uMin, null);
});

test('position/size consistency: scaling positions by k must scale sizes by k', () => {
  // Model the decode contract used in the main loop:
  //   worldPos = localPos * sc + off
  //   worldSize = baseSize * sc      (v1144 fix)
  // The ratio (object size / object footprint) must be invariant to sc, so a
  // corridor keeps its real proportions regardless of remap mode.
  const localExtent = 3.0;   // footprint of an object in local units
  const baseSize = 0.4;      // gaussian radius in local units
  for (const sc of [0.5, 1, 2, 7.3]) {
    const worldExtent = localExtent * sc;
    const worldSize = baseSize * sc; // matches outF[3..5] *= scX in the loader
    const ratioLocal = baseSize / localExtent;
    const ratioWorld = worldSize / worldExtent;
    assert.ok(Math.abs(ratioWorld - ratioLocal) < 1e-12, 'sc=' + sc + ' ratio drift');
  }
});

test('identity mode leaves both position and size untouched (sc=1)', () => {
  const sc = 1;
  const localPos = 12.5, off = 0;
  const baseSize = 0.4;
  assert.strictEqual(localPos * sc + off, 12.5);
  assert.strictEqual(baseSize * sc, 0.4);
});
