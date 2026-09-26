'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
const OctreeStore = require('../renderer/octree-store.js');

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

function makeRenderHarnessViewer() {
  const calls = [];
  let next = 0;
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, UNSIGNED_BYTE: 4, POINTS: 5,
    canvas: { height: 600 },
    uniform1f(...args) { calls.push(['uniform1f', ...args]); },
    uniform3fv(...args) { calls.push(['uniform3fv', ...args]); },
    bindVertexArray(value) { calls.push(['bindVertexArray', value]); },
    drawArrays(...args) { calls.push(['drawArrays', ...args]); },
    createVertexArray() { return `vao-${next++}`; },
    createBuffer() { return `buffer-${next++}`; },
    bindBuffer(...args) { calls.push(['bindBuffer', ...args]); },
    bufferData(target, data, usage) {
      calls.push(['bufferData', target, data.constructor.name, Array.from(data), usage]);
    },
    enableVertexAttribArray(location) { calls.push(['enable', location]); },
    vertexAttribPointer(...args) { calls.push(['pointer', ...args]); },
    deleteVertexArray(value) { calls.push(['deleteVertexArray', value]); },
    deleteBuffer(value) { calls.push(['deleteBuffer', value]); }
  };
  const viewer = makeBareViewer(100);
  Object.assign(viewer, {
    gl,
    aPos: 0, aColor: 1, aIntensity: 2, aClassification: 3,
    u: {
      uUnlit: 'unlit', uUseVColor: 'useVColor', uRound: 'round', uAmbient: 'ambient',
      uAttenuate: 'attenuate', uPtScale: 'ptScale', uPtMin: 'ptMin', uPtMax: 'ptMax',
      uPointSize: 'pointSize', uCloudPass: 'cloudPass', uElevMode: 'elevMode',
      uAttrMode: 'attrMode', uClipOn: 'clipOn', uClipMin: 'clipMin', uClipMax: 'clipMax',
      uColor: 'color'
    },
    _notifyCloudChanged() {},
    _eye() { return [0, 0, 3]; },
    _clipActive() { return false; },
    _clipBounds() { return null; },
    _lastVP: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    _fov: Math.PI / 3,
    render() { this.renderCalls = (this.renderCalls || 0) + 1; }
  });
  return { viewer, calls };
}

function makeSingleNodeIndex() {
  return {
    version: 1, root: 'r', hasColor: false, stride: 12,
    pointCount: 1, nodeCount: 1,
    bbox: { mn: [-1, -1, -1], mx: [1, 1, 1] },
    nodes: [{
      key: 'r', level: 0, mn: [-1, -1, -1], mx: [1, 1, 1],
      count: 1, offset: 0, byteLength: 12, childKeys: []
    }]
  };
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
  viewer._octHasIntensity = true;
  viewer._octHasClassification = true;
  viewer._octCache = new Map([
    ['visible', { lastUsed: 10, buf: { count: 1000000, cb: 'visible-color', ib: 'visible-intensity', kb: 'visible-class', vao: 'visible-vao', pb: 'visible-pos' } }],
    ['old', { lastUsed: 1, buf: { count: 7000000, cb: 'old-color', ib: 'old-intensity', kb: 'old-class', vao: 'old-vao', pb: 'old-pos' } }],
    ['recent', { lastUsed: 5, buf: { count: 1000000, cb: 'recent-color', ib: 'recent-intensity', kb: 'recent-class', vao: 'recent-vao', pb: 'recent-pos' } }],
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
    ['buffer', 'old-color'],
    ['buffer', 'old-intensity'],
    ['buffer', 'old-class']
  ]);
});

test('color-mode availability follows streamed attributes and restores preview mode after legacy LOD fallback', () => {
  const previousWindow = global.window;
  global.window = { OctreeStore: {} };
  try {
    const viewer = makeBareViewer(100000);
    viewer._cloudRecord = { hasIntensity: true, hasClassification: true };
    viewer._intensityValues = new Float32Array([0.1, 0.9]);
    viewer._classificationLabels = new Uint8Array([2, 6]);
    viewer._cloudColorMode = 'intensity';
    viewer._ptElev = false;
    viewer.bbox = { mn: [0, 0, 0], mx: [2, 2, 2] };
    viewer._notifyCloudChanged = () => {};

    assert.deepEqual(viewer.getAvailableColorModes(),
      ['rgb', 'elev', 'intensity', 'classification']);
    assert.equal(viewer.setColorMode('classification'), 'classification');
    assert.equal(viewer.getColorMode(), 'classification');

    const oldIndex = {
      version: 1, pointCount: 2, nodeCount: 1, hasColor: true, stride: 15,
      bbox: { mn: [0, 0, 0], mx: [2, 2, 2] }, nodes: []
    };
    assert.equal(viewer.setOctreeStream({ index: oldIndex, fetchNode() {} }), true);
    assert.equal(viewer.getColorMode(), 'rgb',
      'unsupported attribute mode must fall back instead of displaying stale/default values');
    assert.deepEqual(viewer.getAvailableColorModes(), ['rgb', 'elev']);
    viewer.clearOctreeStream();
    assert.equal(viewer.getColorMode(), 'classification',
      'the in-memory preview mode is restored when stream mode lacks its attribute');

    const newIndex = {
      version: 2, pointCount: 2, nodeCount: 1, hasColor: true,
      hasIntensity: true, hasClassification: true, stride: 20,
      bbox: { mn: [0, 0, 0], mx: [2, 2, 2] }, nodes: []
    };
    assert.equal(viewer.setOctreeStream({ index: newIndex, fetchNode() {} }), true);
    assert.deepEqual(viewer.getAvailableColorModes(),
      ['rgb', 'elev', 'intensity', 'classification']);
    assert.equal(viewer.getColorMode(), 'classification');
    viewer.clearOctreeStream();
    assert.equal(viewer.getColorMode(), 'classification');
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('GPU point buffers upload intensity and class bytes with the expected vertex formats', () => {
  const calls = [];
  let next = 0;
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, UNSIGNED_BYTE: 4,
    createVertexArray() { return 'vao-' + next++; },
    createBuffer() { return 'buffer-' + next++; },
    bindVertexArray(value) { calls.push(['vao', value]); },
    bindBuffer(target, value) { calls.push(['bind-buffer', target, value]); },
    bufferData(target, data, usage) {
      calls.push(['buffer-data', target, Array.from(data), data.constructor.name, usage]);
    },
    enableVertexAttribArray(location) { calls.push(['enable', location]); },
    vertexAttribPointer(...args) { calls.push(['pointer', ...args]); }
  };
  const viewer = makeBareViewer(1000);
  Object.assign(viewer, {
    gl, aPos: 0, aColor: 1, aIntensity: 2, aClassification: 3
  });
  const position = new Float32Array([1, 2, 3, 4, 5, 6]);
  const color = new Float32Array([1, 0, 0, 0, 1, 0]);
  const intensity = new Float32Array([0.25, 0.75]);
  const classification = new Uint8Array([2, 42]);
  const buffer = viewer._mkPtBuf(position, color, intensity, classification);

  assert.equal(buffer.count, 2);
  assert.equal(buffer.bytes,
    position.byteLength + color.byteLength + intensity.byteLength + classification.byteLength);
  assert.deepEqual(calls.filter(call => call[0] === 'pointer').map(call => call.slice(1)), [
    [0, 3, gl.FLOAT, false, 0, 0],
    [1, 3, gl.FLOAT, false, 0, 0],
    [2, 1, gl.FLOAT, false, 0, 0],
    [3, 1, gl.UNSIGNED_BYTE, false, 0, 0]
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'buffer-data').map(call => call[3]), [
    'Float32Array', 'Float32Array', 'Float32Array', 'Uint8Array'
  ]);
});

test('newly calculated classifications replace the cloud VAO class buffer', () => {
  const deleted = [];
  const calls = [];
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, UNSIGNED_BYTE: 4,
    createBuffer() { return 'new-class-buffer'; },
    bindVertexArray(value) { calls.push(['vao', value]); },
    bindBuffer(target, value) { calls.push(['bind-buffer', target, value]); },
    bufferData(target, data) { calls.push(['data', target, Array.from(data)]); },
    enableVertexAttribArray(location) { calls.push(['enable', location]); },
    vertexAttribPointer(...args) { calls.push(['pointer', ...args]); },
    deleteBuffer(value) { deleted.push(value); }
  };
  const viewer = makeBareViewer(1000);
  const old = { points: true, pos: new Float32Array(6), _vao: 'cloud-vao', _kb: 'old-class-buffer' };
  Object.assign(viewer, {
    gl, base: [old], aClassification: 3,
    _cloudRecord: { hasClassification: false },
    render() {}, _notifyCloudChanged() {}
  });

  assert.equal(viewer.applyClassificationLabels(new Uint8Array([2, 42])), true);
  assert.deepEqual(Array.from(old.classification), [2, 42]);
  assert.equal(old._kb, 'new-class-buffer');
  assert.equal(viewer._cloudRecord.hasClassification, true);
  assert.deepEqual(deleted, ['old-class-buffer']);
  assert.deepEqual(calls.find(call => call[0] === 'pointer'), [
    'pointer', 3, 1, gl.UNSIGNED_BYTE, false, 0, 0
  ]);
});

test('clearing classification detaches its VAO buffer, clears availability, and exits class color mode', () => {
  const calls = [];
  const gl = {
    bindVertexArray(value) { calls.push(['vao', value]); },
    disableVertexAttribArray(location) { calls.push(['disable', location]); },
    vertexAttrib1f(location, value) { calls.push(['constant', location, value]); },
    deleteBuffer(value) { calls.push(['delete', value]); }
  };
  const viewer = makeBareViewer(1000);
  const cloud = { points: true, pos: new Float32Array(6), classification: new Uint8Array([2, 6]), _vao: 'cloud-vao', _kb: 'class-buffer' };
  Object.assign(viewer, {
    gl, base: [cloud], aClassification: 3,
    _classificationLabels: new Uint8Array([2, 6]),
    _cloudColorMode: 'classification', _ptElev: false,
    _cloudRecord: { hasClassification: true },
    render() {}, _notifyCloudChanged() {}
  });

  assert.equal(viewer.clearClassificationLabels(), true);
  assert.equal(cloud.classification, null);
  assert.equal(cloud._kb, null);
  assert.equal(viewer._classificationLabels, null);
  assert.equal(viewer._cloudRecord.hasClassification, false);
  assert.equal(viewer.getColorMode(), 'rgb');
  assert.deepEqual(calls, [
    ['vao', 'cloud-vao'],
    ['disable', 3],
    ['constant', 3, 0],
    ['vao', null],
    ['delete', 'class-buffer']
  ]);
});

test('streamed octree fetches a visible node once, uploads attributes and draws both color modes', async () => {
  const previousWindow = global.window;
  global.window = { OctreeStore };
  try {
    const calls = [];
    let nextBuffer = 0;
    const gl = {
      ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, UNSIGNED_BYTE: 4, POINTS: 5,
      canvas: { height: 600 },
      uniform1f(location, value) { calls.push(['uniform1f', location, value]); },
      uniform3fv(location, value) { calls.push(['uniform3fv', location, Array.from(value)]); },
      bindVertexArray(value) { calls.push(['bindVertexArray', value]); },
      drawArrays(mode, first, count) { calls.push(['drawArrays', mode, first, count]); },
      createVertexArray() { return `vao-${nextBuffer++}`; },
      createBuffer() { return `buffer-${nextBuffer++}`; },
      bindBuffer(target, value) { calls.push(['bindBuffer', target, value]); },
      bufferData(target, data, usage) {
        calls.push(['bufferData', target, data.constructor.name, Array.from(data), usage]);
      },
      enableVertexAttribArray(location) { calls.push(['enable', location]); },
      vertexAttribPointer(...args) { calls.push(['pointer', ...args]); },
      deleteVertexArray(value) { calls.push(['deleteVertexArray', value]); },
      deleteBuffer(value) { calls.push(['deleteBuffer', value]); }
    };
    const viewer = makeBareViewer(100);
    Object.assign(viewer, {
      gl,
      aPos: 0, aColor: 1, aIntensity: 2, aClassification: 3,
      u: {
        uUnlit: 'unlit', uUseVColor: 'useVColor', uRound: 'round', uAmbient: 'ambient',
        uAttenuate: 'attenuate', uPtScale: 'ptScale', uPtMin: 'ptMin', uPtMax: 'ptMax',
        uPointSize: 'pointSize', uCloudPass: 'cloudPass', uElevMode: 'elevMode',
        uAttrMode: 'attrMode', uClipOn: 'clipOn', uClipMin: 'clipMin', uClipMax: 'clipMax',
        uColor: 'color'
      },
      _notifyCloudChanged() {},
      _eye() { return [0, 0, 3]; },
      _clipActive() { return false; },
      _clipBounds() { return null; },
      _lastVP: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      _fov: Math.PI / 3,
      render() { this.renderCalls = (this.renderCalls || 0) + 1; }
    });

    const index = {
      version: 2, root: 'r', hasColor: false,
      hasIntensity: true, hasClassification: true, stride: 17,
      pointCount: 4, nodeCount: 1,
      bbox: { mn: [-1, -1, -1], mx: [1, 1, 1] },
      nodes: [{
        key: 'r', level: 0, mn: [-1, -1, -1], mx: [1, 1, 1],
        count: 4, offset: 0, byteLength: 68, childKeys: []
      }]
    };
    assert.equal(OctreeStore.validateOctreeIndex(index, 68), true);

    let fetchCount = 0;
    let resolveFetch;
    const pendingRead = new Promise(resolve => { resolveFetch = resolve; });
    assert.equal(viewer.setOctreeStream({
      index,
      fetchNode(key) {
        assert.equal(key, 'r');
        fetchCount++;
        return pendingRead;
      }
    }), true);
    viewer.setColorMode('intensity');

    // Multiple display frames while I/O is pending must not enqueue duplicate reads.
    viewer._drawOctree();
    viewer._drawOctree();
    await Promise.resolve();
    assert.equal(fetchCount, 1);
    assert.equal(viewer._octCache.get('r').loading, true);

    resolveFetch({
      pos: new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, -0.5, 0]),
      col: null,
      intensity: new Float32Array([0.1, 0.4, 0.7, 1]),
      classification: new Uint8Array([2, 6, 2, 6])
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(viewer._octCache.get('r').buf.count, 4);
    assert.equal(viewer._octCache.get('r').buf.bytes, 4 * 17);

    viewer._drawOctree();
    viewer.setColorMode('classification');
    viewer._drawOctree();

    const uploads = calls.filter(call => call[0] === 'bufferData');
    assert.deepEqual(uploads.map(call => call[2]), [
      'Float32Array', 'Float32Array', 'Uint8Array'
    ]);
    assert.ok(uploads.some(call => call[3].join(',') === '0.10000000149011612,0.4000000059604645,0.699999988079071,1'));
    assert.ok(uploads.some(call => call[3].join(',') === '2,6,2,6'));
    assert.equal(calls.filter(call => call[0] === 'drawArrays' && call[3] === 4).length, 2);
    assert.ok(calls.some(call => call[0] === 'uniform1f' && call[1] === 'attrMode' && call[2] === 2));
    assert.ok(calls.some(call => call[0] === 'uniform1f' && call[1] === 'attrMode' && call[2] === 3));
    assert.ok(viewer.renderCalls > 0, 'node completion schedules a redraw');

    viewer.clearOctreeStream();
    assert.equal(viewer.octreeActive(), false);
    assert.equal(viewer._octCache, null);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('failed node reads use bounded exponential backoff instead of retrying on every frame', async () => {
  const previousWindow = global.window;
  const previousCustomEvent = global.CustomEvent;
  const events = [];
  global.CustomEvent = class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options && options.detail; }
  };
  global.window = { OctreeStore, dispatchEvent(event) { events.push(event); } };
  try {
    const { viewer } = makeRenderHarnessViewer();
    let now = 1000;
    let fetchCount = 0;
    viewer._octNow = () => now;
    assert.equal(viewer.setOctreeStream({
      index: makeSingleNodeIndex(),
      fetchNode() { fetchCount++; throw new Error('temporary disk read failure'); }
    }), true);

    viewer._drawOctree();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCount, 1);
    assert.equal(viewer._octCache.has('r'), false);
    assert.deepEqual(viewer._octFailures.get('r'), { attempt: 1, retryAt: 1250 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'bim-octree-node-error');
    assert.equal(events[0].detail.retryInMs, 250);

    viewer._drawOctree();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCount, 1, 'another render during the cooldown does not re-read the same node');

    now = 1250;
    viewer._drawOctree();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCount, 2);
    assert.deepEqual(viewer._octFailures.get('r'), { attempt: 2, retryAt: 1750 });
    assert.equal(events.length, 2);
    viewer.clearOctreeStream();
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousCustomEvent === undefined) delete global.CustomEvent;
    else global.CustomEvent = previousCustomEvent;
  }
});

test('late node read from an old cloud cannot populate the replacement octree', async () => {
  const previousWindow = global.window;
  global.window = { OctreeStore };
  try {
    const { viewer, calls } = makeRenderHarnessViewer();
    let resolveOld, resolveCurrent;
    const oldRead = new Promise(resolve => { resolveOld = resolve; });
    const currentRead = new Promise(resolve => { resolveCurrent = resolve; });
    const index = makeSingleNodeIndex();

    viewer.setOctreeStream({ index, fetchNode: () => oldRead });
    const oldGeneration = viewer._octGeneration;
    viewer._drawOctree();
    await Promise.resolve();

    viewer.clearOctreeStream();
    viewer.setOctreeStream({ index, fetchNode: () => currentRead });
    assert.notEqual(viewer._octGeneration, oldGeneration);
    viewer._drawOctree();
    await Promise.resolve();

    resolveOld({ pos: new Float32Array([-0.5, 0, 0]) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.filter(call => call[0] === 'bufferData'), [],
      'a stale response is discarded before creating GPU buffers');
    assert.equal(viewer._octCache.get('r').loading, true,
      'the current generation keeps its own request pending');

    resolveCurrent({ pos: new Float32Array([0.5, 0, 0]) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.filter(call => call[0] === 'bufferData').map(call => call[3]), [
      [0.5, 0, 0]
    ]);
    assert.equal(viewer._octCache.get('r').buf.count, 1);
    viewer.clearOctreeStream();
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});