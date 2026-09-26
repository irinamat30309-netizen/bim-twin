'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
const PCEdit = require('../renderer/pointcloud-edit.js');

function makeViewer(cloud) {
  const viewer = Object.create(Viewer3DGL.prototype);
  viewer.base = [Object.assign({ _spacing: 0 }, cloud)];
  viewer._intensityValues = cloud.intensity || null;
  viewer._classificationLabels = cloud.classification || null;
  viewer._undo = [];
  viewer._sel = new Set();
  viewer._selObj = null;
  viewer.gl = null;
  viewer._cloudColorMode = 'rgb';
  viewer._ptElev = false;
  viewer._cloudRecord = { sourceName: 'fixture.ply', loadedCount: cloud.pos.length / 3, hasClassification: !!cloud.classification };
  viewer.render = () => {};
  viewer._notifyCloudChanged = () => {};
  viewer._buildSelHighlight = () => {};
  viewer._clipActive = () => false;
  viewer._delObjs = () => {};
  viewer.loadCloud = function (next) {
    this.lastLoaded = next;
    this.base = [Object.assign({ _spacing: 0 }, next)];
    this._intensityValues = next.intensity || null;
    this._classificationLabels = next.classification || null;
    return true;
  };
  return viewer;
}

function withPointEditWindow(fn) {
  const previous = global.window;
  global.window = Object.assign({}, previous || {}, { PCEdit });
  const restore = () => {
    if (previous === undefined) delete global.window;
    else global.window = previous;
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function sampleCloud() {
  return {
    pos: new Float32Array([0,0,0, 1,0,0, 2,0,0, 3,0,0]),
    col: new Uint8Array([10,20,30, 40,50,60, 70,80,90, 100,110,120]),
    intensity: new Float32Array([0.1,0.2,0.3,0.4]),
    classification: new Uint8Array([2,3,4,5])
  };
}
function assertFloatArrayClose(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, 'float value at ' + i);
}

test('section-limited edit keeps all outside and edited point attributes aligned', () => {
  const viewer = makeViewer(sampleCloud());
  viewer._clipActive = () => true;
  viewer._clipBounds = () => ({ mn: [1,-1,-1], mx: [2,1,1] });
  const result = viewer._applyEditOp(subset => PCEdit.deleteByIndices(subset, [0]));
  assert.deepEqual(Array.from(result.pos), [0,0,0, 3,0,0, 2,0,0]);
  assertFloatArrayClose(Array.from(result.intensity), [0.1,0.4,0.3]);
  assert.deepEqual(Array.from(result.classification), [2,5,4]);
  assert.deepEqual(Array.from(result.col), [10,20,30, 100,110,120, 70,80,90]);
  assertFloatArrayClose(Array.from(result.removedAttributes.intensity), [0.2]);
  assert.deepEqual(Array.from(result.removedAttributes.classification), [3]);
});

test('delete and undo restore XYZ/RGB/intensity/classification as point tuples', () => withPointEditWindow(() => {
  const original = sampleCloud(), viewer = makeViewer(original);
  viewer._sel = new Set([1]);
  assert.equal(viewer.deleteSelection(), 1);
  assertFloatArrayClose(Array.from(viewer.base[0].intensity), [0.1,0.3,0.4]);
  assert.deepEqual(Array.from(viewer.base[0].classification), [2,4,5]);
  assert.equal(viewer.undoEdit(), true);
  const restored = viewer.base[0];
  assert.equal(restored.pos.length / 3, 4);
  const tuples = new Map();
  for (let i = 0; i < restored.pos.length / 3; i++) {
    tuples.set(restored.pos[i * 3], [restored.intensity[i], restored.classification[i], ...restored.col.slice(i * 3, i * 3 + 3)]);
  }
  assert.ok(Math.abs(tuples.get(0)[0] - 0.1) < 1e-6); assert.deepEqual(tuples.get(0).slice(1), [2,10,20,30]);
  assert.ok(Math.abs(tuples.get(1)[0] - 0.2) < 1e-6); assert.deepEqual(tuples.get(1).slice(1), [3,40,50,60]);
  assert.ok(Math.abs(tuples.get(2)[0] - 0.3) < 1e-6); assert.deepEqual(tuples.get(2).slice(1), [4,70,80,90]);
  assert.ok(Math.abs(tuples.get(3)[0] - 0.4) < 1e-6); assert.deepEqual(tuples.get(3).slice(1), [5,100,110,120]);
}));

test('voxel-downsample undo restores the full pre-downsample point attributes', () => withPointEditWindow(() => {
  const cloud = {
    pos: new Float32Array([0.001,0,0, 0.011,0,0, 0.021,0,0, 0.031,0,0]),
    col: new Uint8Array([1,2,3, 4,5,6, 7,8,9, 10,11,12]),
    intensity: new Float32Array([0.1,0.2,0.3,0.4]),
    classification: new Uint8Array([2,3,4,5])
  };
  const viewer = makeViewer(cloud);
  assert.equal(viewer.voxelDownsampleInApp({ voxel: 0.1 }), 3);
  assert.equal(viewer.base[0].classification.length, 1);
  assert.equal(viewer.canUndo(), true);
  assert.equal(viewer.undoEdit(), true);
  assert.deepEqual(Array.from(viewer.base[0].pos), Array.from(cloud.pos));
  assert.deepEqual(Array.from(viewer.base[0].col), Array.from(cloud.col));
  assertFloatArrayClose(Array.from(viewer.base[0].intensity), Array.from(cloud.intensity));
  assert.deepEqual(Array.from(viewer.base[0].classification), Array.from(cloud.classification));
}));

test('manual LAS-class assignment changes only selected labels and Ctrl+Z restores persisted prior labels', async () => withPointEditWindow(async () => {
  const cloud = sampleCloud(), viewer = makeViewer(cloud), saved = [];
  window.MultiCloud = { getActive: () => ({ id: 'scan-1', path: '/data/scan.ply' }) };
  window.BimProjectState = {
    saveClassification: async input => {
      saved.push({ cloudId: input.cloudId, algorithm: input.algorithm, labels: Array.from(input.labels) });
      return { ok: true };
    }
  };
  viewer._sel = new Set([1, 3]);
  const assigned = viewer.assignClassificationInApp(6);
  assert.deepEqual(assigned, { ok: true, changed: 2, classCode: 6 });
  assert.ok(viewer._undo[0].previousLabels instanceof Uint8Array, 'dense edits should use the compact full-label snapshot');
  assert.deepEqual(Array.from(viewer._classificationLabels), [2, 6, 4, 6]);
  assert.deepEqual(Array.from(viewer.base[0].intensity), Array.from(cloud.intensity));
  assert.deepEqual(Array.from(viewer.base[0].col), Array.from(cloud.col));
  await viewer._lastClassificationPromise;
  assert.deepEqual(saved[0].labels, [2, 6, 4, 6]);
  assert.equal(saved[0].cloudId, 'scan-1');
  assert.equal(saved[0].algorithm, 'manual LAS/ASPRS class assignment');

  assert.equal(viewer.undoEdit(), true);
  assert.deepEqual(Array.from(viewer._classificationLabels), [2, 3, 4, 5]);
  await viewer._lastClassificationPromise;
  assert.deepEqual(saved[1].labels, [2, 3, 4, 5]);
  assert.equal(viewer.canUndo(), false);
}));

test('undo of first manual class assignment clears local and persisted classification', async () => withPointEditWindow(async () => {
  const cloud = sampleCloud(), viewer = makeViewer(Object.assign({}, cloud, { classification: null }));
  const cleared = [];
  window.MultiCloud = { getActive: () => ({ id: 'scan-no-classes', path: '/data/no-classes.ply' }) };
  window.BimProjectState = {
    saveClassification: async () => ({ ok: true }),
    clearClassification: async cloudId => { cleared.push(cloudId); return { ok: true, cleared: true }; }
  };
  viewer.base[0].classification = null;
  viewer._sel = new Set([0, 2]);
  assert.deepEqual(viewer.assignClassificationInApp(2), { ok: true, changed: 2, classCode: 2 });
  assert.equal(viewer._undo[0].indices, null, 'undoing the first class buffer needs no point-index list');
  assert.deepEqual(Array.from(viewer._classificationLabels), [2, 0, 2, 0]);
  await viewer._lastClassificationPromise;
  assert.equal(viewer.undoEdit(), true);
  assert.equal(viewer._classificationLabels, null);
  assert.equal(viewer.base[0].classification, null);
  assert.equal(viewer._cloudRecord.hasClassification, false);
  await viewer._lastClassificationPromise;
  assert.deepEqual(cleared, ['scan-no-classes']);
  assert.equal(viewer.canUndo(), false);
}));

test('sparse manual class assignment stores a compact index/value delta and restores it', async () => withPointEditWindow(async () => {
  const labels = Uint8Array.from({ length: 100 }, (_, i) => i);
  const cloud = { pos: new Float32Array(300), col: null, intensity: null, classification: labels };
  const viewer = makeViewer(cloud);
  window.MultiCloud = { getActive: () => ({ id: 'sparse-scan', path: '/data/sparse.ply' }) };
  window.BimProjectState = { saveClassification: async () => ({ ok: true }) };
  viewer._sel = new Set([25]);
  assert.deepEqual(viewer.assignClassificationInApp(200), { ok: true, changed: 1, classCode: 200 });
  assert.deepEqual(Array.from(viewer._undo[0].indices), [25]);
  assert.deepEqual(Array.from(viewer._undo[0].previousValues), [25]);
  assert.equal(viewer._undo[0].previousLabels, null);
  assert.equal(viewer.undoEdit(), true);
  assert.deepEqual(Array.from(viewer._classificationLabels), Array.from(labels));
  await viewer._lastClassificationPromise;
}));

test('manual class assignment rejects invalid codes, empty selection, streaming mode, and no-op labels', () => {
  const viewer = makeViewer(sampleCloud());
  viewer._sel = new Set([1]);
  assert.equal(viewer.assignClassificationInApp(-1).error, 'invalid_class_code');
  assert.equal(viewer.assignClassificationInApp(256).error, 'invalid_class_code');
  assert.equal(viewer.assignClassificationInApp(1.5).error, 'invalid_class_code');
  viewer._sel.clear();
  assert.equal(viewer.assignClassificationInApp(6).error, 'no_selected_points');
  viewer._sel = new Set([1]);
  viewer._octActive = true;
  assert.equal(viewer.assignClassificationInApp(6).error, 'streaming_cloud_edit_not_supported');
  viewer._octActive = false;
  viewer._cloudRecord.sourceCount = 100;
  assert.equal(viewer.assignClassificationInApp(6).error, 'partial_cloud_edit_not_supported');
  viewer._cloudRecord.sourceCount = 4;
  viewer._sel = new Set([1]);
  const unchanged = viewer.assignClassificationInApp(3);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.unchanged, true);
  assert.equal(viewer.canUndo(), false);
});