'use strict';
// Ревизия 12: накопительный кадр потока — все точки рисуются порциями, уже нарисованные узлы можно выгружать из видеопамяти.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const OS = require('../renderer/octree-store.js');
globalThis.window = { OctreeStore: OS, dispatchEvent() {} };
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
function persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
const VP = persp(1, 1.5, 0.1, 1000).map((v, i) => (i === 14 ? v - 0 : v));
function makeIndex(n, cap) {
  let s = 777; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = (rnd() - 0.5) * 4; pos[i * 3 + 1] = (rnd() - 0.5) * 4; pos[i * 3 + 2] = -10 + (rnd() - 0.5) * 0.02; }
  return OS.createOctreeIndex(OS.buildOctree(pos, null, { nodeCapacity: cap }));
}
function makeViewer(index, opts) {
  opts = opts || {};
  const log = { draws: [], deleted: [], fbo: [] };
  const gl = {
    canvas: { height: 600, width: 900 }, POINTS: 0, FRAMEBUFFER: 1, COLOR_BUFFER_BIT: 1, DEPTH_BUFFER_BIT: 2,
    bindFramebuffer(t, f) { log.fbo.push(f); }, clear() { log.clears = (log.clears || 0) + 1; }, finish() {},
    uniform1f() {}, uniform3f() {}, bindVertexArray() {}, drawArrays(m, a, n) { log.draws.push(n); },
    deleteVertexArray(v) { log.deleted.push(v); }, deleteBuffer() {}
  };
  const v = Object.create(Viewer3DGL.prototype);
  const cache = new Map();
  Object.assign(v, {
    gl, u: {}, canvas: gl.canvas, _octActive: true, _octIndex: index, _octCache: cache, _octGeneration: 1, _octFrame: 0, _octFailures: new Map(),
    cloudVisible: true, _interacting: false, _fov: 1, _octHasColor: false, _octPosBytes: 12, _cloudDisplay: { pointSize: 1 }, _grade: {}, _scFbo: 'fbo', dist: 10,
    _eye() { return [0, 0, 0]; }, _clipActive() { return false; }, _clipBounds() { return null; }, getColorMode() { return 'rgb'; },
    _setFrameUniforms() {}, _octCloudUniforms() { return 1; }, _octPump() { log.pumped = (log.pumped || 0) + 1; }, render() {}, _queueFrame() { log.queued = (log.queued || 0) + 1; }
  });
  const lod = OS.prepareLod(index); v._octLod = lod;
  index.nodes.forEach((nd) => { if (opts.resident !== false) cache.set(nd.key, { buf: { vao: 'v' + nd.key, pb: 'p', count: nd.count, bytes: nd.count * 10 }, loading: false, lastUsed: 0 }); });
  return { v, log, cache };
}

test('накопительный кадр: все узлы в кадре рисуются порциями и в сумме дают ВСЕ точки', () => {
  const index = makeIndex(60000, 3000);
  const { v, log } = makeViewer(index);
  const acc = v._octAccBegin(VP, 'k');
  assert.ok(acc.n > 4, 'в кадре несколько узлов');
  assert.equal(acc.totalPts, 60000, 'выбраны все точки (каждая лежит ровно в одном узле)');
  acc.slice = 7000;
  let slices = 0, more = true;
  while (acc.remaining > 0 && slices < 100) { more = v._octAccSlice(acc, VP); slices++; }
  assert.ok(slices > 1 && slices < 100, 'бюджет порции дробит работу на несколько кадров: ' + slices);
  assert.equal(acc.remaining, 0);
  assert.equal(acc.drawnPts, 60000);
  assert.equal(log.draws.reduce((a, b) => a + b, 0), 60000, 'видеокарте отдано ровно 60000 точек, без повторов');
  assert.equal(log.clears, 1, 'текстура очищается один раз — в начале накопления');
  assert.equal(more, false);
});

test('накопительный кадр: узел, ещё не загруженный, ставится в очередь, остальные рисуются, накопление не завершается без него', () => {
  const index = makeIndex(30000, 3000);
  const { v, cache } = makeViewer(index);
  const acc = v._octAccBegin(VP, 'k');
  const lateKey = acc.keys[acc.n - 1], late = cache.get(lateKey); cache.delete(lateKey);
  acc.slice = 1e9;
  v._octAccSlice(acc, VP);
  assert.equal(acc.remaining, 1);
  assert.deepEqual(v._octQueue, [lateKey]);
  cache.set(lateKey, late);
  v._octAccSlice(acc, VP);
  assert.equal(acc.remaining, 0);
  assert.equal(acc.drawnPts, 30000);
});

test('нехватка видеопамяти не отбрасывает точки: нарисованные узлы выгружаются, ожидающие остаются', () => {
  const index = makeIndex(60000, 3000);
  const { v, cache, log } = makeViewer(index);
  v._octVramBytes = 120000;                                // ≈12 000 точек по 10 Б
  const acc = v._octAccBegin(VP, 'k');
  acc.slice = 6000;
  let guard = 0;
  while (acc.remaining > 0 && guard++ < 200) {
    const pend = [];
    for (let i = 0; i < acc.n; i++) if (!acc.flag[i] && cache.has(acc.keys[i])) pend.push(i);
    v._octAccSlice(acc, VP);
    for (const i of pend) if (!acc.flag[i]) assert.ok(cache.has(acc.keys[i]), 'ожидающий узел не выгружен');
  }
  assert.equal(acc.drawnPts, 60000, 'нарисованы все точки при пределе в 12 000');
  assert.ok(log.deleted.length > 0, 'видеопамять освобождалась');
  assert.ok(v._octResPoints <= 12000 + 3500, 'в видеопамяти осталось не больше предела: ' + v._octResPoints);
});

test('ключ накопления меняется от камеры, размера холста, цвета и сечения — и не меняется от пустого перерисовывания', () => {
  const index = makeIndex(3000, 1000);
  const { v } = makeViewer(index);
  const k0 = v._octAccKey(VP);
  assert.equal(v._octAccKey(VP), k0);
  assert.notEqual(v._octAccKey(VP.map((x, i) => (i === 12 ? x + 0.1 : x))), k0);
  v.canvas = { width: 901, height: 600 }; assert.notEqual(v._octAccKey(VP), k0); v.canvas = { width: 900, height: 600 };
  v._cloudDisplay = { pointSize: 2 }; assert.notEqual(v._octAccKey(VP), k0); v._cloudDisplay = { pointSize: 1 };
  v._ptBright = 1.5; assert.notEqual(v._octAccKey(VP), k0); v._ptBright = undefined;
  v._clipActive = () => true; v._clipBounds = () => ({ mn: [0, 0, 0], mx: [1, 1, 1] }); assert.notEqual(v._octAccKey(VP), k0);
});

test('накопление работает только в покое и отключается/сбрасывается по запросу', () => {
  const index = makeIndex(3000, 1000);
  const { v } = makeViewer(index);
  assert.equal(v._octAccUsable(), true);
  v._interacting = true; assert.equal(v._octAccUsable(), false); v._interacting = false;
  v.cloudVisible = false; assert.equal(v._octAccUsable(), false); v.cloudVisible = true;
  assert.equal(v.setOctreeAccum(false), false); assert.equal(v._octAccUsable(), false);
  assert.equal(v.setOctreeAccum(true), true); assert.equal(v._octAccUsable(), true);
  v._octAcc = { remaining: 3, n: 5, drawnPts: 10, totalPts: 20, frames: 2 };
  assert.deepEqual(v.getOctreeAccum(), { active: true, remaining: 3, nodes: 5, drawnPoints: 10, totalPoints: 20, frames: 2 });
  v.invalidateOctreeAccum(); assert.deepEqual(v.getOctreeAccum(), { active: false });
});

test('просмотрщик: покой рисуется накопительным кадром, видеопамять больше не режет число точек в покое', () => {
  const w = read('renderer/webgl-viewer.js');
  assert.match(w, /if \(this\._octAccUsable\(\)\) \{ try \{ this\._renderOctAcc\(\)/);
  assert.match(w, /_trimOctreeGpuCache\(acc\.keySet, acc\.totalPts, acc\.id\)/);
  assert.match(w, /tPx: 0\.0001, budget: Infinity, maxNodes: lod\.n/);
  const app = read('renderer/app.js');
  assert.match(app, /дорисовываются порциями/);
});
