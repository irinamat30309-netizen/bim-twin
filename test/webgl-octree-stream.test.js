'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');

function makeBareViewer(lodBudget) {
  const viewer = Object.create(Viewer3DGL.prototype);
  Object.assign(viewer, {
    gl: null,
    _cloudRecord: null,
    _cloudDisplay: { pointSize: 1 },
    _lodBudget: lodBudget,
    _octCache: null,
    _octIndex: null,
    _octFetch: null,
    _octActive: false,
    _octBudget: Infinity,
    base: [],
    _setBase() {},
    _frame() {},
    render() {}
  });
  return viewer;
}

test('disk-backed LOD respects the configured point budget and reacts to budget changes', () => {
  const previousWindow = global.window;
  global.window = { OctreeStore: {} };
  try {
    const viewer = makeBareViewer(3000000);
    const index = {
      pointCount: 15352950,
      bbox: { mn: [0, 0, 0], mx: [100, 40, 100] },
      nodeCount: 12,
      hasColor: true
    };
    assert.equal(viewer.setOctreeStream({ index, fetchNode() {} }), true);
    assert.equal(viewer._octBudget, 3000000,
      'octree must not silently raise the configured budget to the full source size');

    viewer.setLodBudget(1000000);
    assert.equal(viewer._octBudget, 1000000,
      'changing the LOD budget while streaming updates the actual selection limit');

    viewer.clearOctreeStream();
    assert.equal(viewer.octreeActive(), false);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('disk-backed LOD clamps the budget to small clouds and has a safe fallback', () => {
  const previousWindow = global.window;
  global.window = { OctreeStore: {} };
  try {
    const smallCloud = makeBareViewer(3000000);
    smallCloud.setOctreeStream({
      index: { pointCount: 800000, bbox: { mn: [0, 0, 0], mx: [2, 2, 2] }, hasColor: false },
      fetchNode() {}
    });
    assert.equal(smallCloud._octBudget, 800000);

    const unsetBudget = makeBareViewer(undefined);
    unsetBudget.setOctreeStream({
      index: { pointCount: 15000000, bbox: { mn: [0, 0, 0], mx: [2, 2, 2] }, hasColor: false },
      fetchNode() {}
    });
    assert.equal(unsetBudget._octBudget, 4000000);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('GPU octree cache evicts least-recently-used non-visible buffers by byte budget', () => {
  const viewer = makeBareViewer(1000000);
  const deleted = [];
  viewer.gl = {
    deleteVertexArray(id) { deleted.push(['vao', id]); },
    deleteBuffer(id) { deleted.push(['buffer', id]); }
  };
  viewer._octHasColor = true;
  viewer._octCache = new Map([
    ['visible', { lastUsed: 10, buf: { count: 1000000, cb: 'visible-color', vao: 'visible-vao', pb: 'visible-pos' } }],
    ['old', { lastUsed: 1, buf: { count: 7000000, cb: 'old-color', vao: 'old-vao', pb: 'old-pos' } }],
    ['recent', { lastUsed: 5, buf: { count: 1000000, cb: 'recent-color', vao: 'recent-vao', pb: 'recent-pos' } }],
    ['pending', { lastUsed: 2, loading: true, buf: null }]
  ]);

  viewer._trimOctreeGpuCache(new Set(['visible']), 1000000);

  assert.equal(viewer._octCache.has('visible'), true, 'currently visible geometry is never evicted');
  assert.equal(viewer._octCache.has('old'), false, 'oldest off-screen geometry is evicted first');
  assert.equal(viewer._octCache.has('recent'), true, 'recent cache entries are preserved if the budget allows');
  assert.equal(viewer._octCache.has('pending'), true, 'in-flight reads are not mistaken for GPU buffers');
  assert.deepEqual(deleted, [
    ['vao', 'old-vao'],
    ['buffer', 'old-pos'],
    ['buffer', 'old-color']
  ]);
});