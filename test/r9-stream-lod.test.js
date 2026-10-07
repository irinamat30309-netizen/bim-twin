'use strict';
// Ревизия 9: LOD по экранной плотности (selectLod), быстрый разбор узла (decodeNodeGpu), планировщик загрузки узлов во вьюере.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OS = require('../renderer/octree-store.js');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');

function persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]; }
function look(e, c, u) {
  let z = [e[0] - c[0], e[1] - c[1], e[2] - c[2]]; let l = Math.hypot(...z); z = z.map(v => v / l);
  let x = [u[1] * z[2] - u[2] * z[1], u[2] * z[0] - u[0] * z[2], u[0] * z[1] - u[1] * z[0]]; l = Math.hypot(...x); x = x.map(v => v / l);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]), -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]), -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1];
}
function mul(a, b) { const r = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let q = 0; q < 4; q++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + q] * b[c * 4 + k]; r[c * 4 + q] = s; } return r; }
const FOV = 50 * Math.PI / 180, H = 1080, F = H / 2 / Math.tan(FOV / 2);
function camera(eye, target) { return { vp: mul(persp(FOV, 16 / 9, 0.05, 5000), look(eye, target, [0, 1, 0])), eye, f: F }; }

// облако: плоскость 40×40 м (≈ фасад) + шум; детерминированный генератор
function makeIndex(n, cap) {
  let s = 12345; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = (rnd() - 0.5) * 40; pos[i * 3 + 1] = (rnd() - 0.5) * 40; pos[i * 3 + 2] = (rnd() - 0.5) * 0.02; }
  const built = OS.buildOctree(pos, null, { nodeCapacity: cap });
  return { index: OS.createOctreeIndex(built), total: n };
}

test('decodeNodeGpu: те же позиции/цвета/интенсивность/класс, что и deserializeNodePoints, цвет — RGBA8', () => {
  const pos = new Float32Array([1, 2, 3, -4, 5.5, 6]), col = new Float32Array([1, 0, 0.5, 0.2, 0.4, 1]);
  const inten = new Float32Array([0.25, 0.75]), cls = new Uint8Array([2, 6]);
  const bytes = OS.serializeNodePoints(pos, col, true, { intensity: inten, classification: cls });
  const fmt = { version: 2, hasColor: true, hasIntensity: true, hasClassification: true, stride: 20 };
  const a = OS.deserializeNodePoints(bytes, 2, true, fmt), b = OS.decodeNodeGpu(bytes, 2, fmt);
  assert.deepEqual(Array.from(b.pos), Array.from(a.pos));
  assert.equal(b.col, null);
  assert.equal(b.rgba.length, 8);
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < 3; k++) assert.equal(b.rgba[i * 4 + k], Math.round(a.col[i * 3 + k] * 255));
    assert.equal(b.rgba[i * 4 + 3], 255);
  }
  assert.deepEqual(Array.from(b.intensity), Array.from(a.intensity));
  assert.deepEqual(Array.from(b.classification), [2, 6]);
  assert.throws(() => OS.decodeNodeGpu(bytes.subarray(1), 2, fmt), /byte length/);
  const noColor = OS.decodeNodeGpu(OS.serializeNodePoints(pos, null, false), 2, { version: 1, hasColor: false, stride: 12 });
  assert.equal(noColor.rgba, null);
});

test('selectLod: корень первым, родитель всегда раньше потомка, при tPx→0 выбираются все узлы (все точки), бюджет соблюдается', () => {
  const { index, total } = makeIndex(300000, 2000);
  const lod = OS.prepareLod(index);
  assert.equal(lod.n, index.nodes.length);
  const all = OS.selectLod(lod, { vp: null, eye: [0, 0, 30], f: F, tPx: 1e-9, budget: Infinity, maxNodes: 1e9 });
  assert.equal(all.n, lod.n, 'без отсечения и при нулевом допуске видны все узлы');
  assert.equal(all.points, total, 'сумма точек узлов = всё облако (без потерь и дублей)');
  assert.equal(all.ids[0], lod.root);
  const pos = new Map(all.ids.map((id, i) => [id, i]));
  for (let id = 0; id < lod.n; id++) for (let c = lod.cs[id]; c < lod.cs[id + 1]; c++) assert.ok(pos.get(lod.kids[c]) > pos.get(id), 'ребёнок после родителя');
  const capped = OS.selectLod(lod, { vp: null, eye: [0, 0, 30], f: F, tPx: 1e-9, budget: 50000 });
  assert.ok(capped.points >= 50000 && capped.points <= 50000 + 2000, 'бюджет превышается не более чем на один узел: ' + capped.points);
});

test('selectLod: вблизи узлы глубже и их больше, вдали — грубее; точек на экране не больше, чем способен показать экран', () => {
  const { index } = makeIndex(600000, 3000);
  const lod = OS.prepareLod(index);
  const far = OS.selectLod(lod, Object.assign(camera([0, 0, 400], [0, 0, 0]), { tPx: 1, budget: Infinity, maxNodes: 1e9 }));
  const mid = OS.selectLod(lod, Object.assign(camera([0, 0, 40], [0, 0, 0]), { tPx: 1, budget: Infinity, maxNodes: 1e9 }));
  const near = OS.selectLod(lod, Object.assign(camera([5, 5, 3], [5, 5, 0]), { tPx: 1, budget: Infinity, maxNodes: 1e9 }));
  const maxLevel = (r) => Math.max(...r.ids.map(id => lod.level[id]));
  assert.ok(maxLevel(near) > maxLevel(far), 'вблизи глубже: ' + maxLevel(near) + ' > ' + maxLevel(far));
  assert.ok(far.points < mid.points, 'издалека точек меньше: ' + far.points + ' < ' + mid.points);
  assert.ok(near.points < mid.points, 'вблизи отсекается невидимое: ' + near.points + ' < ' + mid.points);
  // грубее допуск при движении — меньше точек
  const coarse = OS.selectLod(lod, Object.assign(camera([0, 0, 40], [0, 0, 0]), { tPx: 1.7, budget: Infinity, maxNodes: 1e9 }));
  assert.ok(coarse.points <= mid.points);
  // узел, достаточно плотный на экране (расстояние между точками ≤ 1 px), не уточняется: его детей в выборке нет
  const chosen = new Set(mid.ids);
  for (let i = 0; i < mid.n; i++) {
    const id = mid.ids[i];
    if (mid.sp[i] <= 1) for (let c = lod.cs[id]; c < lod.cs[id + 1]; c++) assert.ok(!chosen.has(lod.kids[c]), 'плотный узел не уточняется');
  }
});

test('selectLod: камера, смотрящая мимо облака, не выбирает ничего; ортогональный режим работает', () => {
  const { index } = makeIndex(100000, 2000);
  const lod = OS.prepareLod(index);
  const away = OS.selectLod(lod, Object.assign(camera([0, 0, 100], [0, 0, 300]), { tPx: 1, budget: Infinity }));
  assert.equal(away.n, 0);
  const ortho = OS.selectLod(lod, { vp: null, eye: [0, 0, 100], ortho: true, ppu: 20, f: F, tPx: 1, budget: Infinity, maxNodes: 1e9 });
  const orthoFar = OS.selectLod(lod, { vp: null, eye: [0, 0, 100], ortho: true, ppu: 0.5, f: F, tPx: 1, budget: Infinity, maxNodes: 1e9 });
  assert.ok(ortho.points > orthoFar.points, 'крупнее масштаб — больше точек');
});

test('selectLod: индекс на 30 000 узлов выбирается быстро (без объектов/строк в каждом кадре)', () => {
  // синтетическое дерево: 8-арное, глубина 5 = 37449 узлов
  const nodes = []; const stack = [{ key: 'r', level: 0, mn: [0, 0, 0], mx: [100, 100, 100] }];
  while (stack.length) {
    const s = stack.pop(); const kids = [];
    if (s.level < 5) for (let o = 0; o < 8; o++) {
      const mn = s.mn.slice(), mx = s.mx.slice(), mid = [0, 1, 2].map(k => (s.mn[k] + s.mx[k]) / 2);
      for (let k = 0; k < 3; k++) { if ((o >> k) & 1) mn[k] = mid[k]; else mx[k] = mid[k]; }
      stack.push({ key: s.key + o, level: s.level + 1, mn, mx }); kids.push(s.key + o);
    }
    nodes.push({ key: s.key, level: s.level, mn: s.mn, mx: s.mx, count: 120000, offset: 0, byteLength: 0, childKeys: kids });
  }
  assert.ok(nodes.length > 30000);
  const lod = OS.prepareLod({ root: 'r', nodes });
  const cam = Object.assign(camera([50, 50, 400], [50, 50, 50]), { tPx: 1, budget: 30e6 });
  OS.selectLod(lod, cam);
  const t0 = process.hrtime.bigint(); let r;
  for (let i = 0; i < 20; i++) r = OS.selectLod(lod, cam);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.ok(r.points <= 30e6 + 120000);
  assert.ok(ms < 25, 'выбор узлов ' + ms.toFixed(2) + ' мс');
});

function harness(nodeCount) {
  const calls = []; let next = 0;
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, UNSIGNED_BYTE: 4, POINTS: 5, canvas: { height: 1080 },
    uniform1f(...a) { calls.push(['uniform1f', ...a]); }, uniform3fv() {}, bindVertexArray() {},
    drawArrays(m, f, c) { calls.push(['draw', c]); },
    createVertexArray() { return 'vao' + next++; }, createBuffer() { return 'b' + next++; }, bindBuffer() {},
    bufferData(t, d) { calls.push(['data', d.constructor.name, d.length]); },
    enableVertexAttribArray() {}, vertexAttribPointer(...a) { calls.push(['pointer', ...a]); }, deleteVertexArray() {}, deleteBuffer() {}
  };
  const v = Object.create(Viewer3DGL.prototype);
  Object.assign(v, {
    gl, aPos: 0, aColor: 1, aIntensity: -1, aClassification: -1, base: [], _cloudRecord: null, _cloudDisplay: { pointSize: 1.4 }, _lodBudget: 100000000,
    _setBase() {}, _frame() {}, _notifyCloudChanged() {}, _eye() { return [0, 0, 3]; }, _clipActive() { return false; }, _clipBounds() { return null; },
    _lastVP: camera([0, 0, 3], [0, 0, 0]).vp, _fov: FOV, renders: 0, render() { this.renders++; },
    u: new Proxy({}, { get: (t, k) => k })
  });
  return { v, calls, gl };
}
function treeIndex(depth) {
  const nodes = []; const stack = [{ key: 'r', level: 0, mn: [-1, -1, -1], mx: [1, 1, 1] }];
  while (stack.length) {
    const s = stack.pop(); const kids = [];
    if (s.level < depth) for (let o = 0; o < 8; o++) {
      const mn = s.mn.slice(), mx = s.mx.slice(), mid = [0, 1, 2].map(k => (s.mn[k] + s.mx[k]) / 2);
      for (let k = 0; k < 3; k++) { if ((o >> k) & 1) mn[k] = mid[k]; else mx[k] = mid[k]; }
      stack.push({ key: s.key + o, level: s.level + 1, mn, mx }); kids.push(s.key + o);
    }
    nodes.push({ key: s.key, level: s.level, mn: s.mn, mx: s.mx, count: 100000, offset: 0, byteLength: 0, childKeys: kids });
  }
  return { version: 1, root: 'r', hasColor: true, stride: 15, pointCount: nodes.length * 100000, nodeCount: nodes.length, bbox: { mn: [-1, -1, -1], mx: [1, 1, 1] }, nodes };
}
const node = (n) => ({ pos: new Float32Array(n * 3), rgba: new Uint8Array(n * 4), col: null, intensity: null, classification: null });

test('планировщик: не более 6 одновременных чтений в покое (3 при движении), грубые узлы первыми, без дублей; грузится только нужное', async () => {
  const prev = global.window; global.window = { OctreeStore: OS };
  try {
    const { v } = harness();
    const idx = treeIndex(3);
    const started = []; const resolvers = [];
    v.setOctreeStream({ index: idx, fetchNode(key) { started.push(key); return new Promise(r => resolvers.push(() => r(node(10)))); } });
    v._drawOctree(); v._drawOctree();
    await Promise.resolve();
    assert.equal(started.length, 6, 'в покое одновременно ≤ 6 чтений');
    assert.equal(new Set(started).size, 6, 'дублей нет');
    assert.equal(started[0], 'r', 'корень — первым');
    assert.ok(started.slice(1).every(k => k.length === 2), 'затем узлы первого уровня (грубые раньше мелких): ' + started.join(','));
    assert.equal(v.getOctreeStats().inflight, 6);
    resolvers.splice(0).forEach(f => f());
    await new Promise(r => setImmediate(r));
    assert.ok(v.renders > 0, 'после загрузки запрошена перерисовка');
    // очередь сама запускает следующие чтения без нового кадра, но не больше 6 одновременно
    assert.ok(started.length > 6 && new Set(started).size === started.length, 'очередь продолжила загрузку без дублей');
    assert.ok(v._octInflight <= 6);
    v.clearOctreeStream();
    assert.equal(v.getOctreeStats(), null);
  } finally { if (prev === undefined) delete global.window; else global.window = prev; }
});

test('узел с цветом RGBA8 загружается 16 байт/точку (позиция float32 + цвет 4 байта, нормализованный UNSIGNED_BYTE)', async () => {
  const prev = global.window; global.window = { OctreeStore: OS };
  try {
    const { v, calls } = harness();
    const idx = treeIndex(0);
    v.setOctreeStream({ index: idx, fetchNode() { return Promise.resolve(node(7)); } });
    v._drawOctree();
    await new Promise(r => setImmediate(r));
    const e = v._octCache.get('r');
    assert.equal(e.buf.count, 7);
    assert.equal(e.buf.bytes, 7 * 16);
    assert.deepEqual(calls.filter(c => c[0] === 'pointer').map(c => c.slice(1)), [[0, 3, 3, false, 0, 0], [1, 3, 4, true, 4, 0]]);
    calls.length = 0; v._drawOctree();
    assert.deepEqual(calls.filter(c => c[0] === 'draw'), [['draw', 7]]);
    const st = v.getOctreeStats();
    assert.equal(st.drawn, 7); assert.equal(st.missing, 0);
  } finally { if (prev === undefined) delete global.window; else global.window = prev; }
});

test('бюджет кадра: в покое — ВСЕ точки файла, при движении — авто или фиксированный процент; предел видеопамяти и пользователя', () => {
  const prev = global.window; global.window = { OctreeStore: OS };
  try {
    const { v } = harness();
    const idx = treeIndex(2);                                  // 73 узла × 100 000 = 7,3 млн
    v.setOctreeStream({ index: idx, fetchNode() { return new Promise(() => {}); } });
    const total = idx.pointCount;
    v._octBudget = 5000000;                                    // старый «бюджет плотности» поток больше не ограничивает
    assert.equal(v._octFrameCap(), total, 'в покое потолок = все точки');
    v._drawOctree();
    assert.equal(v.getOctreeStats().budget, total);
    assert.ok(v.getOctreeStats().tPx < 0.01, 'в покое уточняем до листьев');
    // движение, авто
    v._interacting = true; v._interPts = 2000000; v._drawOctree();
    assert.equal(v.getOctreeStats().budget, 2000000);
    assert.equal(v.getOctreeStats().tPx, 1.7);
    // движение, фиксированный процент: 10 % файла
    v.setOctreeMovePercent(10); v._drawOctree();
    assert.equal(v.getOctreeStats().budget, Math.round(total * 0.1));
    assert.ok(v.getOctreeStats().tPx < 0.01);
    v.setOctreeMovePercent(0); v._interacting = false;
    // предел пользователя
    v.setOctreeIdleLimit(3000000); assert.equal(v._octFrameCap(), 3000000); v.setOctreeIdleLimit(0);
    // предел видеопамяти (после OUT_OF_MEMORY): байты / (6 или 12 + цвет)
    v._octVramBytes = 2000000 * 16; v._octPosBytes = 12; v._octHasColor = true;
    assert.equal(v._octFrameCap(), 2000000);
    // старый режим с потолком 30/60 млн остаётся доступен
    v._octVramBytes = 0; v.setOctreeAllPoints(false); v._octBudget = 80000000;
    assert.equal(v._octFrameCap(), Math.min(total, 30000000));
  } finally { if (prev === undefined) delete global.window; else global.window = prev; }
});

test('ошибка OUT_OF_MEMORY при загрузке узла: узел не остаётся, предел видеопамяти запоминается, событие отправлено', async () => {
  const events = [];
  const prev = global.window; global.window = { OctreeStore: OS, dispatchEvent(e) { events.push(e); } };
  const prevCE = global.CustomEvent; global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  try {
    const { v, gl } = harness();
    gl.OUT_OF_MEMORY = 0x0505; let oom = false; gl.getError = () => (oom ? 0x0505 : 0);
    let nfetch = 0;
    v.setOctreeStream({ index: treeIndex(1), fetchNode() { if (++nfetch === 1) return Promise.resolve(node(10)); return new Promise(r => setImmediate(() => { oom = true; r(node(10)); })); } });
    v._drawOctree();
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));   // корень загрузился, на втором узле — OUT_OF_MEMORY
    assert.ok(v._octCache.get('r').buf);
    assert.ok(v._octVramBytes > 0, 'предел видеопамяти запомнен');
    assert.ok(events.some(e => e.type === 'bim-octree-vram-limit'));
    assert.ok(v._octFrameCap() < Infinity);
  } finally { if (prev === undefined) delete global.window; else global.window = prev; if (prevCE === undefined) delete global.CustomEvent; else global.CustomEvent = prevCE; }
});

test('узел с квантованными позициями Uint16 (6 Б/точку): декодирование точное до 1/131070 ящика, буфер и uniform-ы распаковки', async () => {
  const prev = global.window; global.window = { OctreeStore: OS };
  try {
    // декодер
    const fmt = { stride: 15, hasColor: true };
    const n = 5, buf = new Uint8Array(n * 15), dv = new DataView(buf.buffer);
    const P = [[-3.5, 1, 2], [10, 1.25, -2], [0.001, 3, 7], [9.99, -1, 0], [2, 2, 2]];
    P.forEach((p, i) => { dv.setFloat32(i * 15, p[0], true); dv.setFloat32(i * 15 + 4, p[1], true); dv.setFloat32(i * 15 + 8, p[2], true); buf[i * 15 + 12] = 10 * i; buf[i * 15 + 13] = 20; buf[i * 15 + 14] = 30; });
    const d = OS.decodeNodeGpu(buf, n, { stride: 15, hasColor: true, hasIntensity: false, hasClassification: false, version: 1 }, true);
    assert.ok(d.pos16 instanceof Uint16Array && d.pos === null && d.pos16.length === n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      const back = d.pos16[i * 3 + k] * d.q.scale[k] + d.q.off[k];
      assert.ok(Math.abs(back - Math.fround(P[i][k])) <= d.q.scale[k] * 0.51 + 1e-9, 'позиция ' + i + '/' + k);
    }
    assert.equal(d.rgba[4 * 2], 20);
    // видеобуфер: ushort, 6 + 4 байта на точку, uniform-ы распаковки перед отрисовкой
    const { v, calls, gl } = harness();
    gl.UNSIGNED_SHORT = 6; gl.uniform3f = (...a) => calls.push(['uniform3f', ...a]);
    v.setOctreeStream({ index: treeIndex(0), fetchNode() { return Promise.resolve(d); } });
    v._drawOctree(); await new Promise(r => setImmediate(r));
    const e = v._octCache.get('r');
    assert.equal(e.buf.bytes, n * 6 + n * 4);
    assert.ok(calls.some(c => c[0] === 'pointer' && c[1] === 0 && c[2] === 3 && c[3] === 6), 'позиции — UNSIGNED_SHORT');
    calls.length = 0; v._drawOctree();
    const u = calls.filter(c => c[0] === 'uniform3f');
    assert.ok(u.length >= 2 && u[0][1] === 'uQScale' && u[0][2] === d.q.scale[0] && u[1][1] === 'uQOff' && u[1][2] === d.q.off[0], 'uniform-ы распаковки заданы');
    const last = u[u.length - 1]; assert.deepEqual(last.slice(1), ['uQOff', 0, 0, 0], 'после потока вернули единичное преобразование');
  } finally { if (prev === undefined) delete global.window; else global.window = prev; }
});
