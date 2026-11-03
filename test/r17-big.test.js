'use strict';
// Ревизия 17: большие облака (сегменты по ~16 млн точек) — выделение, правка с откатом, чистка плитками, классы, экспорт БЕЗ потери точек.
// Все алгоритмы big-cloud.js проверяются на малых облаках с крошечными сегментами и плитками: результат должен совпадать с обычным
// (плоским) PCEdit точка в точку.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const BC = require('../renderer/big-cloud.js');
const PE = require('../renderer/pointcloud-edit.js');

// детерминированный генератор
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// облако из «комнаты» (плоскости + шум + далёкие острова), порядок точек — по сканированию, как в файле
function makeCloud(n, seed, o) {
  o = o || {}; const r = rng(seed || 1), pos = new Float32Array(n * 3), col = new Uint8Array(n * 3), I = new Uint16Array(n), K = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n, kind = r();
    let x, y, z;
    if (kind < 0.35) { x = t * 10; y = 0 + r() * 0.01; z = r() * 8; }
    else if (kind < 0.7) { x = t * 10; y = r() * 3; z = 0 + r() * 0.01; }
    else if (kind < 0.93) { x = r() * 10; y = r() * 3; z = 8 + r() * 0.01; }
    else if (kind < 0.97) { x = 3 + r() * 0.4; y = 1 + r() * 0.4; z = 3 + r() * 0.4; }
    else { x = 20 + r() * 5; y = 5 + r() * 5; z = 20 + r() * 5; }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    col[i * 3] = (i * 7) & 255; col[i * 3 + 1] = (i * 13) & 255; col[i * 3 + 2] = (i * 29) & 255; I[i] = (i * 37) % 60000; K[i] = i % 5;
  }
  return { pos, col, intensity: I, classification: K, count: n };
}
// режем облако на сегменты (cap точек) с кирпичами (chunk)
function makeSegs(cloud, segN, chunk, o) {
  o = o || {}; const segs = [];
  for (let a = 0; a < cloud.count; a += segN) {
    const n = Math.min(segN, cloud.count - a), cap = o.cap || n;
    const P = new Float32Array(cap * 3), C = new Uint8Array(cap * 3), I = new Uint16Array(cap), K = new Uint8Array(cap);
    P.set(cloud.pos.subarray(a * 3, (a + n) * 3)); C.set(cloud.col.subarray(a * 3, (a + n) * 3)); I.set(cloud.intensity.subarray(a, a + n)); K.set(cloud.classification.subarray(a, a + n));
    const sg = { P, C, I, K, n, cap, start: 0, chunk, boxes: null, intensity: null, classification: null };
    BC.recomputeBoxes(sg, 0); BC.refreshViews(sg); segs.push(sg);
  }
  BC.renumber(segs); return segs;
}
// плоское облако из сегментов (для сравнения)
function flatten(segs) {
  const n = BC.total(segs), pos = new Float32Array(n * 3), col = new Uint8Array(n * 3), I = new Uint16Array(n), K = new Uint8Array(n); let k = 0;
  for (const sg of segs) { pos.set(sg.P.subarray(0, sg.n * 3), k * 3); col.set(sg.C.subarray(0, sg.n * 3), k * 3); I.set(sg.I.subarray(0, sg.n), k); K.set(sg.K.subarray(0, sg.n), k); k += sg.n; }
  return { pos, col, intensity: I, classification: K, count: n };
}
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
const T = { rng, makeCloud, makeSegs, flatten, same };
module.exports = T;

test('r17: сегменты — нумерация, поиск точки, Set-совместимое выделение', async () => {
  const cl = makeCloud(5000, 1), segs = makeSegs(cl, 1200, 300);
  assert.equal(segs.length, 5); assert.equal(BC.total(segs), 5000);
  for (const g of [0, 1199, 1200, 2399, 2400, 4999]) { const p = BC.pointAt(segs, g); assert.deepEqual(p, [cl.pos[g * 3], cl.pos[g * 3 + 1], cl.pos[g * 3 + 2]]); }
  assert.equal(BC.locate(segs, 5000), -1); assert.equal(BC.locate(segs, -1), -1);
  const sel = new BC.BigSel(segs);
  sel.add(0); sel.add(1200); sel.add(4999); sel.add(4999);
  assert.equal(sel.size, 3); assert.ok(sel.has(1200)); assert.ok(!sel.has(1201));
  assert.deepEqual(Array.from(sel), [0, 1200, 4999]); assert.deepEqual(Array.from(sel.toIndices()), [0, 1200, 4999]);
  assert.ok(sel.delete(1200)); assert.ok(!sel.delete(1200)); assert.equal(sel.size, 2);
  const seen = []; sel.forEach((i) => seen.push(i)); assert.deepEqual(seen, [0, 4999]);
  assert.equal(sel.invert(), 4998); assert.ok(!sel.has(0) && sel.has(1));
  sel.clear(); assert.equal(sel.size, 0);
});

test('r17: выделение рамкой, шаром и по цвету = плоский PCEdit', async () => {
  const cl = makeCloud(20000, 2), segs = makeSegs(cl, 3300, 500), N = cl.count;
  const mn = [2, 0.2, 0.5], mx = [6, 2.5, 6];
  const flatBox = new Set(PE.selectByBox(cl.pos, N, mn, mx)), a = await BC.selectBox(segs, mn, mx);
  assert.equal(a.size, flatBox.size); assert.ok(a.size > 100); for (const g of a) assert.ok(flatBox.has(g));
  const c = [3.2, 1.2, 3.2], flatS = new Set(PE.selectBySphere(cl.pos, N, c, 0.9)), b = await BC.selectSphere(segs, c, 0.9);
  assert.equal(b.size, flatS.size); assert.ok(b.size > 50); for (const g of b) assert.ok(flatS.has(g));
  const flatC = new Set(PE.selectByColor(cl.col, N, [100, 150, 200], { tol: 60 })), d = await BC.selectColor(segs, [100, 150, 200], 60);
  assert.equal(d.size, flatC.size); assert.ok(d.size > 100); for (const g of d) assert.ok(flatC.has(g));
  // фильтр секущего бокса
  const e = await BC.selectBox(segs, mn, mx, { inClip: (x, y, z) => y > 1 }); let cnt = 0; for (const g of flatBox) if (cl.pos[g * 3 + 1] > 1) cnt++;
  assert.equal(e.size, cnt);
  // по списку индексов и сбор точек
  const idx = Uint32Array.from([3, 4000, 4001, 19999]), s2 = BC.selectIndices(segs, idx), g = BC.gather(segs, s2);
  assert.equal(g.count, 4); assert.equal(g.pos[3], cl.pos[4000 * 3]); assert.equal(g.col[3 * 3], cl.col[19999 * 3]); assert.deepEqual(Array.from(g.ref), [3, 4000, 4001, 19999]);
});

test('r17: удаление с компактным откатом возвращает сегменты побайтно', async () => {
  const cl = makeCloud(20000, 3), segs = makeSegs(cl, 3300, 500, { cap: 3300 }), before = flatten(segs);
  const sel = await BC.selectBox(segs, [1, 0, 0], [5, 3, 9]), n0 = BC.total(segs), selSet = new Set(sel), selMasks = sel.m.map((m) => m && m.slice());
  assert.ok(sel.size > 1000);
  const r = BC.removeMasks(segs, sel.m);
  assert.equal(r.ok, true); assert.equal(r.removed, selSet.size); assert.equal(BC.total(segs), n0 - selSet.size);
  // оставшиеся — ровно те, что вне выделения, в прежнем порядке
  const mid = flatten(segs); let k = 0; for (let g = 0; g < n0; g++) if (!selSet.has(g)) { assert.equal(mid.pos[k * 3], cl.pos[g * 3]); assert.equal(mid.col[k * 3 + 1], cl.col[g * 3 + 1]); assert.equal(mid.intensity[k], cl.intensity[g]); assert.equal(mid.classification[k], cl.classification[g]); k++; }
  assert.equal(k, mid.count);
  // рамки кирпичей остались точными
  for (const sg of segs) { const CH = sg.chunk; for (let c = 0; c < Math.ceil(sg.n / CH); c++) { let lo = Infinity, hi = -Infinity; for (let i = c * CH; i < Math.min(sg.n, (c + 1) * CH); i++) { lo = Math.min(lo, sg.P[i * 3]); hi = Math.max(hi, sg.P[i * 3]); } assert.equal(sg.boxes[c * 6], lo); assert.equal(sg.boxes[c * 6 + 3], hi); } }
  // нумерация сквозная
  let s = 0; for (const sg of segs) { assert.equal(sg.start, s); s += sg.n; }
  BC.restoreRemoval(segs, r.rec);
  const after = flatten(segs); assert.ok(same(after.pos, before.pos) && same(after.col, before.col) && same(after.intensity, before.intensity) && same(after.classification, before.classification));
  assert.equal(BC.total(segs), n0);
  // обрезка (оставить выделенное) и откат
  const r2 = BC.removeMasks(segs, selMasks, { keep: true }); assert.equal(BC.total(segs), selSet.size); assert.equal(r2.removed, n0 - selSet.size);
  BC.restoreRemoval(segs, r2.rec); assert.ok(same(flatten(segs).pos, before.pos));
  // удаление выделения целиком из одного сегмента (пустой сегмент) и откат
  const sel3 = BC.selectIndices(segs, Uint32Array.from(Array.from({ length: 3300 }, (_, i) => 3300 + i))), r3 = BC.removeMasks(segs, sel3.m);
  assert.equal(segs[1].n, 0); assert.equal(BC.total(segs), n0 - 3300); assert.equal(BC.locate(segs, 3300), 2);
  BC.restoreRemoval(segs, r3.rec); assert.ok(same(flatten(segs).pos, before.pos));
});

// помощники сравнения: набор удалённых (по маскам) и набор удалённых плоской функцией (по оставленным позициям)
function removedSet(segs, masks) { const s = new Set(); for (let k = 0; k < segs.length; k++) { const m = masks[k]; if (!m) continue; for (let i = 0; i < m.length; i++) if (m[i]) s.add(segs[k].start + i); } return s; }
function flatRemoved(cl, r) {
  // плоская функция возвращает оставшиеся точки по порядку — восстанавливаем номера удалённых
  const kept = r.pos, N = cl.count, out = new Set(); let k = 0;
  for (let i = 0; i < N; i++) { if (k < kept.length / 3 && kept[k * 3] === cl.pos[i * 3] && kept[k * 3 + 1] === cl.pos[i * 3 + 1] && kept[k * 3 + 2] === cl.pos[i * 3 + 2]) k++; else out.add(i); }
  assert.equal(k, kept.length / 3, 'оставшиеся точки идут в прежнем порядке'); return out;
}
function eqSets(a, b, what) { assert.equal(a.size, b.size, what + ': число ' + a.size + ' ≠ ' + b.size); for (const x of a) if (!b.has(x)) assert.fail(what + ': точка ' + x + ' лишняя'); }
T.removedSet = removedSet; T.flatRemoved = flatRemoved; T.eqSets = eqSets;

test('r17: фильтр плотности и кластеры по сегментам = плоский PCEdit', async () => {
  const cl = makeCloud(30000, 5), segs = makeSegs(cl, 4100, 700), flatCl = { pos: cl.pos, col: cl.col, intensity: cl.intensity, classification: cl.classification };
  for (const o of [{ voxel: 0.3, minPts: 6 }, { voxel: 0.15, minPts: 4 }, { minPts: 8 }]) {
    const r = PE.cleanVoxelDensity(flatCl, o), d = await BC.densityMasks(segs, o);
    assert.ok(r.removed > 0); assert.equal(d.removed, r.removed); eqSets(removedSet(segs, d.masks), flatRemoved(cl, r), 'плотность ' + JSON.stringify(o));
  }
  for (const o of [{ voxel: 0.25, minClusterPts: 30 }, { voxel: 0.1, minClusterPts: 100, keepRatio: 0.05 }, { voxel: 0.07, minClusterPts: 200 }]) {
    const r = PE.cleanClusters(flatCl, o), d = await BC.clusterMasks(segs, o);
    assert.ok(r.removed > 0, 'кластеры: плоская функция что-то удалила'); assert.equal(d.removed, r.removed); eqSets(removedSet(segs, d.masks), flatRemoved(cl, r), 'кластеры ' + JSON.stringify(o));
  }
  // разреженный путь (хеш-сетка) при ячейках > 5e7: каждая точка — в своём вокселе размером 0.002 м → удаляются точки, у которых в вокселе < 2 точек
  const dh = await BC.densityMasks(segs, { voxel: 0.002, minPts: 2 }), n0 = BC.total(segs), sets = new Map();
  const mnx = Math.min(...Array.from({ length: 1 }, () => 0)); void mnx;
  for (let i = 0; i < cl.count; i++) { const k = [0, 1, 2].map((a) => Math.floor(((cl.pos[i * 3 + a]) - 0) / 0.002)).join(','); sets.set(k, (sets.get(k) || 0) + 1); }
  assert.ok(dh.removed > 0 && dh.removed < n0);
});

test('r17: SOR, радиус и шум по плиткам = плоский PCEdit (плитки малы, результат тот же)', async () => {
  const cl = makeCloud(12000, 7), segs = makeSegs(cl, 2500, 500), flatCl = { pos: cl.pos, col: cl.col, intensity: cl.intensity, classification: cl.classification };
  const common = { tilePoints: 1500, histCells: 256 };
  const plan = await BC.planTiles(segs, { target: 1500, histCells: 256 }); assert.ok(plan.tiles.length > 3, 'плиток несколько: ' + plan.tiles.length);
  let s = 0; for (const t of plan.tiles) s += t.count; assert.equal(s, cl.count, 'плитки покрывают все точки ровно один раз');
  { const o = { voxel: 0.08, stdRatio: 1.2, k: 12 }, r = PE.cleanStatisticalOutliers(flatCl, o), d = await BC.sorMasks(segs, Object.assign({}, o, common));
    assert.ok(r.removed > 0); assert.equal(d.removed, r.removed); eqSets(removedSet(segs, d.masks), flatRemoved(cl, r), 'SOR'); assert.ok(Math.abs(d.threshold - r.threshold) < 1e-9 * Math.max(1, r.threshold)); }
  { const o = { radius: 0.06, minNeighbors: 5 }, r = PE.cleanRadiusOutliers(flatCl, o), d = await BC.radiusMasks(segs, Object.assign({}, o, common));
    assert.ok(r.removed > 0); assert.equal(d.removed, r.removed); eqSets(removedSet(segs, d.masks), flatRemoved(cl, r), 'радиус'); }
  { const o = { voxel: 0.1, stdRatio: 1.0 }, r = PE.noiseFilterLocalPlane(flatCl, o), d = await BC.noiseMasks(segs, Object.assign({}, o, common));
    assert.ok(r.removed > 0); assert.equal(d.removed, r.removed); eqSets(removedSet(segs, d.masks), flatRemoved(cl, r), 'шум'); }
  { const o = { axis: 1, at: 1.5, thickness: 0.6 }, r = PE.sliceSection(flatCl, o), d = await BC.sliceMasks(segs, o);
    assert.equal(d.removed, r.removed); eqSets(removedSet(segs, d.masks), flatRemoved(cl, r), 'срез'); }
});

// ───────────── часть C: прореживание, классы, экспорт ─────────────
async function collect(it) { const out = []; let n = 0; for await (const c of it) { out.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength)); n += c.byteLength; } return Buffer.concat(out, n); }
// «исходное» плоское облако так, как его отдаёт getSourceCloud (цвет float 0..1, интенсивность float I/65535, позиции float64 при сдвиге)
function srcCloud(segs, meta) {
  const f = flatten(segs), n = f.count, tr = meta && meta.srcXform, t = tr && tr.t;
  let pos = f.pos; if (t) { pos = new Float64Array(n * 3); for (let i = 0; i < n; i++) { const x = f.pos[i * 3], y = f.pos[i * 3 + 1], z = f.pos[i * 3 + 2]; if (tr.axis === 'zup') { pos[i * 3] = x + t[0]; pos[i * 3 + 1] = -z + t[1]; pos[i * 3 + 2] = y + t[2]; } else { pos[i * 3] = x + t[0]; pos[i * 3 + 1] = y + t[1]; pos[i * 3 + 2] = z + t[2]; } } }
  const col = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) col[i] = f.col[i] / 255;
  const it = new Float32Array(n); for (let i = 0; i < n; i++) it[i] = f.intensity[i] / 65535;
  return { pos, col, intensity: it, classification: f.classification, count: n, meta: meta || {} };
}

test('r17: прореживание вокселями по всему облаку = плоский PCEdit; классы голосованием', async () => {
  const cl = makeCloud(30000, 11), segs = makeSegs(cl, 4100, 700), before = flatten(segs);
  for (const voxel of [0.2, 0.05]) {
    const r = PE.voxelDownsample({ pos: cl.pos, col: cl.col, intensity: cl.intensity }, { voxel }), d = await BC.voxelDownsample(segs, { voxel, maxSeg: 1000 });
    assert.equal(d.ok, true); assert.equal(d.kept, r.kept); assert.equal(d.removed, r.removed); assert.ok(d.removed > 1000);
    assert.equal(BC.total(d.segs), r.kept); assert.ok(d.kept <= 1000 ? d.segs.length === 1 : d.segs.length >= 2, 'результат разбит на части ≤ maxSeg: ' + d.segs.length + ' из ' + d.kept);
    const f = flatten(d.segs); assert.ok(same(f.pos, r.pos), 'позиции (центроиды) совпадают побайтно');
    let md = 0, mi = 0; for (let i = 0; i < f.col.length; i++) md = Math.max(md, Math.abs(f.col[i] - r.col[i])); for (let i = 0; i < f.intensity.length; i++) mi = Math.max(mi, Math.abs(f.intensity[i] - r.intensity[i]));
    assert.ok(md <= 1 && mi <= 1, 'цвет/интенсивность отличаются не более чем на 1: ' + md + '/' + mi);
    let s = 0; for (const g of d.segs) { assert.equal(g.start, s); s += g.n; assert.ok(g.boxes && g.boxes.length === Math.ceil(g.n / g.chunk) * 6); }
  }
  assert.ok(same(flatten(segs).pos, before.pos), 'исходные сегменты не изменены (на них откат)');
  // класс = большинство в вокселе, при равенстве — меньший код
  const voxel = 0.3, d = await BC.voxelDownsample(segs, { voxel }), bb = BC.boundsOf(segs), inv = 1 / voxel, votes = new Map(), order = [];
  for (let i = 0; i < cl.count; i++) {
    const k = [0, 1, 2].map((a) => Math.floor((cl.pos[i * 3 + a] - bb.mn[a]) * inv)).join(','); let m = votes.get(k); if (!m) { m = new Map(); votes.set(k, m); order.push(k); }
    m.set(cl.classification[i], (m.get(cl.classification[i]) || 0) + 1);
  }
  const f = flatten(d.segs); assert.equal(f.count, order.length);
  order.forEach((k, j) => { let best = 255, bc = 0; votes.get(k).forEach((c, lab) => { if (c > bc || (c === bc && lab < best)) { best = lab; bc = c; } }); assert.equal(f.classification[j], best, 'класс вокселя ' + k); });
  // воксель крупнее облака → одна точка; очень мелкий → ничего не меняется
  const one = await BC.voxelDownsample(segs, { voxel: 1000 }); assert.equal(one.kept, 1);
  const none = await BC.voxelDownsample(segs, { voxel: 1e-6 }); assert.equal(none.segs, null); assert.equal(none.removed, 0);
});

test('r17: классификация пол/потолок/стены = плоский classifyStructure; метки и присвоение с откатом', async () => {
  const cl = makeCloud(20000, 13), segs = makeSegs(cl, 3700, 600), N = cl.count;
  const flat = PE.classifyStructure({ pos: cl.pos }, { upAxis: 1 }), big = await BC.classifyBig(segs, { upAxis: 1 });
  assert.deepEqual(big.counts, flat.counts); assert.ok(flat.counts.floor + flat.counts.wall + flat.counts.ceiling > N * 0.5);
  const lab = new Uint8Array(N); { let k = 0; for (let s = 0; s < segs.length; s++) { lab.set(big.labels[s], k); k += segs[s].n; } } assert.ok(same(lab, flat.labels));
  // выборка меньше облака: плоскости находятся, все точки размечены
  const small = await BC.classifyBig(segs, { upAxis: 1, sampleMax: 3000 }); assert.equal(small.counts.floor + small.counts.ceiling + small.counts.wall + small.counts.other, N);
  assert.ok(small.counts.floor + small.counts.wall + small.counts.ceiling > N * 0.4);
  // запись меток и откат
  const before = flatten(segs).classification, rec = BC.applyLabelsBySeg(segs, big.labels);
  assert.ok(same(BC.labelsFlat(segs), flat.labels)); BC.restoreLabels(segs, rec); assert.ok(same(BC.labelsFlat(segs), before));
  // присвоение класса выделению и откат; сегменты без классов получают их и теряют при откате
  const sel = await BC.selectBox(segs, [1, 0, 0], [4, 2, 9]), a = BC.assignClass(segs, sel, 7);
  const h = BC.classHistogram(segs); assert.ok(h[7] >= sel.size); assert.ok(a.changed > 0 && a.changed <= sel.size);
  for (const g of sel) assert.equal(segs[BC.locate(segs, g)].K[g - segs[BC.locate(segs, g)].start], 7);
  BC.restoreAssign(segs, a.rec); assert.ok(same(BC.labelsFlat(segs), before));
  const bare = makeSegs(cl, 3700, 600); for (const g of bare) { g.K = null; g.classification = null; }
  const sel2 = await BC.selectBox(bare, [1, 0, 0], [4, 2, 9]), b = BC.assignClass(bare, sel2, 3);
  assert.ok(bare.every((g, i) => !sel2.m[i] || g.K) && b.changed === sel2.size); BC.restoreAssign(bare, b.rec); assert.ok(bare.every((g) => g.K === null));
  const z = BC.assignClass(bare, sel2, 0); assert.equal(z.changed, 0); assert.ok(bare.every((g) => g.K === null), 'класс 0 у облака без классов ничего не меняет');
});

test('r17: потоковый экспорт PLY / LAS / текст = готовые плоские экспортёры, байт в байт', async () => {
  const EH = require('../renderer/export-hub'), SS = require('../renderer/lixel-smart-save');
  const cl = makeCloud(9000, 17), segs = makeSegs(cl, 2000, 400);
  const metas = [{}, { srcXform: { axis: 'zup', t: [1000000.5, 2000000.25, 30.125] }, units: 'm', crsWkt: 'PROJCS["Test / UTM"]' }, { srcXform: { axis: 'yup', t: [500.25, 1.5, -700.75] } }];
  for (const meta of metas) {
    const src = srcCloud(segs, meta), tag = JSON.stringify(meta).slice(0, 40);
    const ply = BC.exportStream(segs, 'ply', { meta, chunkPoints: 1500 }), pb = await collect(ply.chunks);
    assert.ok(Buffer.compare(pb, Buffer.from(EH.exportPLY(src))) === 0, 'PLY ' + tag); assert.equal(pb.length, ply.expectedBytes);
    const las = BC.exportStream(segs, 'las', { meta, chunkPoints: 1500 }), lb = await collect(las.chunks);
    assert.ok(Buffer.compare(lb, Buffer.from(EH.exportLAS(src))) === 0, 'LAS ' + tag); assert.equal(lb.length, las.expectedBytes);
    for (const [fmt, fn] of [['xyz', SS.toXYZText], ['csv', SS.toCSVText], ['pts', SS.toPTSText], ['pcd', SS.toPCDText], ['obj', SS.cloudToOBJ]]) {
      const t = BC.exportStream(segs, fmt, { meta, chunkPoints: 1100 }), tb = (await collect(t.chunks)).toString('utf8');
      assert.equal(tb, fn(src), fmt.toUpperCase() + ' ' + tag);
    }
  }
  // без цвета/интенсивности/классов: свойства не пишутся
  const bare = makeSegs(cl, 2000, 400); for (const g of bare) { g.C = null; g.I = null; g.K = null; g.intensity = null; g.classification = null; }
  const hd = (await collect(BC.exportStream(bare, 'ply', {}).chunks)).toString('latin1', 0, 400);
  assert.ok(/element vertex 9000/.test(hd) && !/red|intensity|classification/.test(hd.split('end_header')[0]));
  // отмена между кусками
  let stop = false; const ctx = BC.makeCtx({ cancelled: () => stop, sliceMs: 0 }), it = BC.exportStream(segs, 'ply', { chunkPoints: 1000 }, ctx).chunks; let got = 0;
  await assert.rejects(async () => { for await (const c of it) { got++; if (got === 3) stop = true; } }, (e) => e && e.cancelled === true);
  assert.equal(BC.EXPORT_FORMATS.join(), 'ply,las,xyz,pts,pcd,csv,obj');
});

test('r17: секущий бокс — временные сегменты, обратная карта масок, окно-выборка, защита плоскостей, добавление сегмента', async () => {
  const cl = makeCloud(6000, 7), segs = makeSegs(cl, 1100, 250), N = 6000;
  const mn = [2, 0.2, 1], mx = [7, 2.5, 9];
  // эталон: точки внутри бокса по порядку
  const ref = []; for (let i = 0; i < N; i++) { const x = cl.pos[i * 3], y = cl.pos[i * 3 + 1], z = cl.pos[i * 3 + 2]; if (x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2]) ref.push(i); }
  assert.ok(ref.length > 500 && ref.length < N);
  const cs = await BC.clipSubset(segs, mn, mx, { attrs: true, maxSeg: 400 });
  assert.equal(cs.count, ref.length); assert.equal(BC.total(cs.segs), ref.length); assert.ok(cs.segs.length >= 2);
  const fl = flatten(cs.segs); const src = []; for (const g of cs.segs) for (let i = 0; i < g.n; i++) src.push(g.src[i]);
  assert.deepEqual(src, ref);
  for (let k = 0; k < ref.length; k++) { const g = ref[k]; assert.equal(fl.pos[k * 3], cl.pos[g * 3]); assert.equal(fl.col[k * 3 + 1], cl.col[g * 3 + 1]); assert.equal(fl.intensity[k], cl.intensity[g]); assert.equal(fl.classification[k], cl.classification[g]); }
  // обратная карта: помечаем каждую 3-ю точку временных сегментов → исходные маски
  const tm = cs.segs.map((g, t) => { const m = new Uint8Array(g.n); for (let i = 0; i < g.n; i++) if ((i + t) % 3 === 0) m[i] = 1; return m; });
  const back = cs.mapBack(tm); let expect = 0; for (const m of tm) for (const v of m) expect += v;
  assert.equal(back.count, expect); let got = 0; for (const m of back) if (m) for (const v of m) got += v; assert.equal(got, expect);
  const all = cs.mapBack(cs.allMasks()); assert.equal(all.count, ref.length);
  // без attrs — только позиции; пустой бокс
  const c2 = await BC.clipSubset(segs, mn, mx, {}); assert.equal(c2.segs[0].C, null); assert.equal(c2.count, ref.length);
  const c3 = await BC.clipSubset(segs, [100, 100, 100], [101, 101, 101], {}); assert.equal(c3.count, 0); assert.equal(c3.segs.length, 0); assert.equal(c3.mapBack([]).count, 0);

  // окно-выборка = выборка protectFloorLocal (та же позиция k-й точки)
  const ws = await BC.windowSample(segs, mn, mx, 300); assert.equal(ws.total, ref.length); assert.equal(ws.count, 300);
  const stepW = ref.length / 300; for (let i = 0; i < 300; i++) { const g = ref[(i * stepW) | 0]; assert.equal(ws.pos[i * 3], cl.pos[g * 3]); assert.equal(ws.pos[i * 3 + 2], cl.pos[g * 3 + 2]); }
  const wa = await BC.windowSample(segs, mn, mx, 100000); assert.equal(wa.count, ref.length); assert.equal(wa.pos[3], cl.pos[ref[1] * 3]);
  assert.equal((await BC.windowSample(segs, [100, 100, 100], [101, 101, 101], 50)).count, 0);

  // защита плоскостей: выделяем всё в одном объёме у «пола» (y≈0) и «куска стены»; те же плоскости и тот же остаток, что у плоского protectFloorLocal
  const sel0 = []; for (let i = 0; i < N; i++) { const x = cl.pos[i * 3], y = cl.pos[i * 3 + 1], z = cl.pos[i * 3 + 2]; if (x > 2 && x < 6 && z > 2 && z < 6 && y < 1.8) sel0.push(i); }
  assert.ok(sel0.length > 300);
  const flatKeep = PE.protectFloorLocal({ pos: cl.pos }, sel0, { spacing: 0.05, maxPlanes: 8, minFrac: 0.02 });
  const sel = new BC.BigSel(segs); for (const i of sel0) sel.add(i);
  const sb = BC.selBounds(segs, sel); const sd = Math.hypot(sb.mx[0] - sb.mn[0], sb.mx[1] - sb.mn[1], sb.mx[2] - sb.mn[2]) || 1, margin = Math.max(sd * 0.5, 0.05 * 20, 0.4);
  const wmn = sb.mn.map((v) => v - margin), wmx = sb.mx.map((v) => v + margin);
  const w2 = await BC.windowSample(segs, wmn, wmx, 60000);
  const ld = Math.hypot(wmx[0] - wmn[0], wmx[1] - wmn[1], wmx[2] - wmn[2]);
  const pp = PE.protectFloorPlanes(w2.pos, w2.count, ld, 0.05, { maxPlanes: 8, minFrac: 0.02 });
  assert.ok(pp && pp.planes.length >= 1);
  const dropped = await BC.unselectOnPlanes(segs, sel, pp.planes, pp.protTol);
  assert.equal(sel.size, flatKeep.length); assert.equal(dropped, sel0.length - flatKeep.length); assert.ok(dropped > 0);
  assert.deepEqual(Array.from(sel.toIndices()), Array.from(flatKeep).sort((a, b) => a - b));
  assert.equal(await BC.unselectOnPlanes(segs, sel, [], 0.1), 0);

  // добавление сегмента в конец + откат через удаление его целиком
  const n0 = BC.total(segs); const pos = new Float32Array([1, 2, 3, 4, 5, 6]);
  const ns = BC.appendSegment(segs, pos, new Uint8Array([9, 8, 7, 6, 5, 4])); assert.equal(ns.n, 2); assert.equal(ns.start, n0); assert.equal(BC.total(segs), n0 + 2);
  assert.deepEqual(BC.pointAt(segs, n0 + 1), [4, 5, 6]); assert.equal(ns.I.length, 2); assert.equal(ns.K.length, 2);
  const rm = await BC.removeMasks(segs, segs.map((g) => g === ns ? new Uint8Array([1, 1]) : null), {});
  assert.ok(rm.ok); assert.equal(BC.total(segs), n0);
});

// ---- выбор рамкой/лассо по экрану: те же правила, что у плоского _resolveVisibleSelection ----
function lookAtVP(eye, at, fov, aspect, near, far) {
  const f = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]; let l = Math.hypot(...f); f[0] /= l; f[1] /= l; f[2] /= l;
  let s = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; // f × up(0,1,0)
  s = [-f[2], 0, f[0]]; l = Math.hypot(...s); s = s.map((v) => v / l);
  const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
  const V = new Float64Array(16); V[0] = s[0]; V[4] = s[1]; V[8] = s[2]; V[1] = u[0]; V[5] = u[1]; V[9] = u[2]; V[2] = -f[0]; V[6] = -f[1]; V[10] = -f[2]; V[15] = 1;
  V[12] = -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]); V[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]); V[14] = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
  const t = 1 / Math.tan(fov / 2), Pm = new Float64Array(16); Pm[0] = t / aspect; Pm[5] = t; Pm[10] = (far + near) / (near - far); Pm[11] = -1; Pm[14] = 2 * far * near / (near - far);
  const M = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let a = 0; for (let k = 0; k < 4; k++) a += Pm[k * 4 + r] * V[c * 4 + k]; M[c * 4 + r] = a; }
  return M;
}
function flatProj(pos, M) {
  const n = pos.length / 3, xy = new Float32Array(n * 2), depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw <= 0) { xy[i * 2] = NaN; xy[i * 2 + 1] = NaN; depth[i] = NaN; continue; }
    xy[i * 2] = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw; xy[i * 2 + 1] = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw; depth[i] = cw;
  }
  return { xy, depth, count: n };
}
// «GPU-выбор»: ближайшая точка в каждом пикселе сетки W×H внутри области
function cpuPick(proj, W, H, inRegion) {
  const best = new Float32Array(W * H).fill(Infinity), id = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < proj.count; i++) {
    const x = proj.xy[i * 2], y = proj.xy[i * 2 + 1], d = proj.depth[i]; if (d !== d || x < -1 || x > 1 || y < -1 || y > 1) continue;
    const px = Math.min(W - 1, ((x * 0.5 + 0.5) * W) | 0), py = Math.min(H - 1, ((1 - (y * 0.5 + 0.5)) * H) | 0);
    if (!inRegion(x, y)) continue; const k = py * W + px; if (d < best[k]) { best[k] = d; id[k] = i; }
  }
  const out = new Set(); for (const v of id) if (v >= 0) out.add(v); return out;
}

test('r17: выбор рамкой и лассо по экрану = плоский _resolveVisibleSelection (режимы глубины 0/1/2, запасной z-буфер, секущий бокс)', async () => {
  const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
  global.window = global.window || {}; window.PCEdit = PE;
  const N = 9000, cl = makeCloud(N, 11), segs = makeSegs(cl, 2000, 500);
  const M = lookAtVP([3.2, 1.2, 0.5], [3.2, 1.2, 6], 1.0, 4 / 3, 0.05, 200), proj = flatProj(cl.pos, M);
  const bb = { mn: [0, 0, 0], mx: [25, 10, 25] }, diag = Math.hypot(25, 10, 25), sp = 0.05;
  const rects = [{ x0: -0.25, y0: -0.3, x1: 0.2, y1: 0.25 }, { x0: -0.9, y0: -0.9, x1: 0.9, y1: 0.9 }];
  const poly = [[-0.4, -0.3], [0.3, -0.35], [0.45, 0.2], [0, 0.4], [-0.35, 0.15]];
  const kinds = [{ kind: 'rect', shape: { kind: 'rect', ...rects[0] }, inReg: (x, y) => x >= rects[0].x0 && x <= rects[0].x1 && y >= rects[0].y0 && y <= rects[0].y1 },
    { kind: 'rect', shape: { kind: 'rect', ...rects[1] }, inReg: (x, y) => x >= rects[1].x0 && x <= rects[1].x1 && y >= rects[1].y0 && y <= rects[1].y1 },
    { kind: 'lasso', shape: { kind: 'poly', poly }, inReg: (x, y) => PE.pointInPolygon([x, y], poly) }];
  const clusterFn = (mode) => {
    let voxel = sp * 3; voxel = Math.min(Math.max(voxel, diag * 0.002), diag * 0.05);
    return { clusterVoxel: voxel, bandDefault: mode === 0 ? Math.min(Math.max(diag * 0.01, 0.05), 0.25) : Math.min(Math.max(diag * 0.05, 0.4), 3),
      cluster: (pos, depth, vox, band) => PE.clusterFront(pos, Array.from({ length: pos.length / 3 }, (_, i) => i), { depth, voxel: vox, band }) };
  };
  let compared = 0;
  for (const mode of [0, 1, 2]) for (const useGpu of [true, false]) for (const k of kinds) {
    const raw = k.kind === 'lasso' ? PE.selectByPolygon(proj.xy, proj.count, poly) : PE.selectByRect(proj.xy, proj.count, k.shape);
    const visSet = useGpu ? cpuPick(proj, 48, 36, k.inReg) : null;
    const fake = { _selDepthMode: mode, _selThrough: mode >= 2, base: [{ pos: cl.pos, _spacing: sp }], bbox: bb,
      canvas: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      _selRegionDev: () => ({ bbox: { x: 0, y: 0, w: 1, h: 1 }, poly: null }), _gpuVisibleSet: () => visSet,
      _clusterFront: Viewer3DGL.prototype._clusterFront, _visibleFilter: Viewer3DGL.prototype._visibleFilter, _depthFilter: Viewer3DGL.prototype._depthFilter };
    const flat = Viewer3DGL.prototype._resolveVisibleSelection.call(fake, raw, proj, k.kind);
    const o = Object.assign({ mode, vis: visSet ? Array.from(visSet) : null, spacing: sp, diag, cssW: 800, cssH: 600 }, clusterFn(mode));
    const sel = await BC.selectScreen(segs, M, k.shape, o);
    const A = new Set(flat), B = new Set(sel.toIndices());
    let diff = 0; for (const v of A) if (!B.has(v)) diff++; for (const v of B) if (!A.has(v)) diff++;
    assert.ok(A.size > 20, 'в плоском выборе есть точки (mode ' + mode + ')');
    assert.ok(diff <= Math.max(2, A.size * 0.003), 'mode ' + mode + ' gpu=' + useGpu + ' ' + k.kind + ': различий ' + diff + ' из ' + A.size);
    compared++;
  }
  assert.equal(compared, 18);
  // секущий бокс применяется после выбора, как _clipFilter
  const k0 = kinds[1], vs = cpuPick(proj, 48, 36, k0.inReg), inClip = (x, y, z) => x < 5;
  const all = await BC.selectScreen(segs, M, k0.shape, { mode: 2 }), cut = await BC.selectScreen(segs, M, k0.shape, { mode: 2, inClip });
  assert.ok(cut.size > 0 && cut.size < all.size); for (const g of cut.toIndices()) assert.ok(cl.pos[g * 3] < 5);
  const cut0 = await BC.selectScreen(segs, M, k0.shape, { mode: 0, vis: Array.from(vs), spacing: sp, diag, inClip }); for (const g of cut0.toIndices()) assert.ok(cl.pos[g * 3] < 5);
  // маркеры подсветки и окно вокруг точки
  const mk = BC.markerSample(segs, all, 500); assert.ok(mk.length <= 1500 && mk.length >= 750);
  const mk2 = BC.markerSample(segs, cut, 1e6); assert.equal(mk2.length, cut.size * 3);
  const win = await BC.windowAround(segs, [3.2, 1.2, 3.2], 0.6, 100000); let ex = 0; for (let i = 0; i < N; i++) if (Math.abs(cl.pos[i * 3] - 3.2) <= 0.6 && Math.abs(cl.pos[i * 3 + 1] - 1.2) <= 0.6 && Math.abs(cl.pos[i * 3 + 2] - 3.2) <= 0.6) ex++;
  assert.equal(win.count, ex); assert.equal(win.pos.length, ex * 3);
  const win2 = await BC.windowAround(segs, [3.2, 1.2, 3.2], 5, 800); assert.ok(win2.count <= 800 && win2.R < 5);
});

test('r17: равномерная выборка из всего облака (для 3DGS): цвет совпадает, порядок файла сохранён, при cap ≥ числу точек — всё облако', async () => {
  const cl = makeCloud(5000, 23), segs = makeSegs(cl, 1300, 300);
  const all = await BC.sampleAll(segs, 99999);
  assert.equal(all.count, 5000); assert.equal(all.total, 5000); assert.ok(all.col && all.col.length === 15000);
  assert.deepEqual(Array.from(all.pos.subarray(0, 60)), Array.from(cl.pos.subarray(0, 60))); assert.deepEqual(Array.from(all.col.subarray(0, 60)), Array.from(cl.col.subarray(0, 60)));
  const sm = await BC.sampleAll(segs, 777);
  assert.equal(sm.count, 777); assert.equal(sm.total, 5000);
  const step = 5000 / 777;
  for (let j = 0; j < 777; j += 37) {
    const i = (j * step) | 0;
    assert.equal(sm.pos[j * 3], cl.pos[i * 3]); assert.equal(sm.pos[j * 3 + 2], cl.pos[i * 3 + 2]); assert.equal(sm.col[j * 3 + 1], cl.col[i * 3 + 1]);
  }
  assert.equal((await BC.sampleAll([], 10)).count, 0);
});

// ---------- исходники: окно, вьюер, main/preload, сборка ----------
test('r17: вьюер — «большое» облако (cpu=true) обслуживается своими методами, прежние методы остаются для обычных облаков и аварийного пути без памяти', () => {
  const b = read('renderer/webgl-viewer-big.js'), w = read('renderer/webgl-viewer.js');
  for (const m of ['_buildSelHighlight', 'clearSelection', 'invertSelection', '_finishMarquee', '_finishLasso', 'selectRegion', 'extractRegionAsObject', '_buildBrushGrid', '_brushAt', '_pickIndex',
    'selectBox', 'selectSphere', 'selectSphereAt', 'selectColorAt', 'selectInSlice', 'magicWandAt', 'smartObjectAt', 'extractSelectionAsObject', '_applyEdit', 'deleteSelection', 'cropToSelection',
    'deleteSelectionForce', 'undoEdit', 'cleanInApp', 'cleanClustersInApp', 'cleanSORInApp', 'cleanRadiusInApp', 'noiseFilterInApp', 'sliceKeepInApp', 'cleanIslandsInApp', 'cleanAutoInApp',
    'voxelDownsampleInApp', 'detectFloorWalls', 'applyClassificationLabels', 'getClassificationLabels', 'clearClassificationLabels', 'classifyInApp', 'assignClassificationInApp']) {
    assert.ok(b.includes("wrap('" + m + "'"), 'wrap ' + m);
  }
  for (const m of ['getBigExport', 'saveBigStream', 'getBigSample', 'bigInfo', 'isBigCloud', '_bigRun', '_bigApplyEdit']) assert.ok(new RegExp('P\\.' + m + ' = ').test(b), 'P.' + m);
  assert.match(b, /b\._stream && b\._stream\.cpu === true && b\._segs/, 'big = поток с CPU-копиями сегментов');
  assert.match(w, /st\.cpu = !!\(this\._bigInstalled && typeof window !== 'undefined' && window\.BigCloud\)/, 'CPU-копии сегментов — только если установлен модуль «большого» облака');
  assert.match(w, /sg\.P = /); assert.match(w, /guardStreamedCloud/, 'аварийный путь r16 (нет памяти) остался');
  assert.match(b, /bim-big-notice/); assert.match(b, /lx-progress-cancel/, 'отмена из карточки прогресса');
});

test('r17: окно — вызовы async-методов ждутся, кнопки не идут в нативный путь для «большого» облака, сохранение потоком', () => {
  const a = read('renderer/app.js');
  assert.match(a, /const isBigCloud = \(\) =>/); assert.match(a, /const hasCloudArrays = \(\) =>/); assert.match(a, /const flatCloudForTool = async \(\) =>/);
  assert.match(a, /\(isBigCloud\(\) \|\| \(_c0 && _c0\.pos && _c0\.pos\.length\)\) && viewer\.cleanInApp/, 'кнопка «Чистка» работает для big и не уходит в Python');
  assert.match(a, /await viewer\.cleanAutoInApp\(\{ maxPasses: 3 \}\)/); assert.match(a, /await viewer\.cleanIslandsInApp\(\{\}\)/); assert.match(a, /await viewer\.cleanRadiusInApp\(/);
  assert.match(a, /await viewer\.noiseFilterInApp\(/); assert.match(a, /await viewer\.classifyInApp\(/); assert.match(a, /await viewer\.cleanSORInApp\(/);
  assert.match(a, /await viewer\.deleteSelection\(\)/); assert.match(a, /await viewer\.cropToSelection\(\)/); assert.match(a, /await viewer\.deleteSelectionForce\(\)/);
  assert.equal((a.match(/await viewer\.deleteSelection\(\)/g) || []).length, 2, 'кнопка и клавиши Delete/Enter');
  assert.match(a, /edBtn\('edSave', async \(\) => \{\s*if \(isBigCloud\(\) && viewer\.saveBigStream\)/, 'PLY из кнопки «Сохранить» — потоком');
  assert.match(a, /addEventListener\('bim-big-notice'/); assert.match(a, /addEventListener\('bim-stream-limit'/);
  assert.match(a, /getBigSample\(12000000\)/, '3DGS — по выборке');
  assert.ok(!/открыто по частям: все точки на экране, но \' \+ \(d\.what \|\| 'эта операция'\) \+ ' для него недоступны — правка/.test(a), 'старое «правка недоступна» убрано');
  const ss = read('renderer/lixel-smart-save.js');
  assert.match(ss, /function bigViewer\(\)/); assert.match(ss, /saveBigStream\(fmt/); assert.match(ss, /bigViewer\(\)\.saveBigStream\(f\.id/); assert.match(ss, /var BIG_FMT = \['ply', 'las', 'xyz', 'pts', 'pcd', 'csv', 'obj'\]/);
  assert.match(read('renderer/lixel-object-extract.js'), /await vv\.smartObjectAt\(/); assert.match(read('renderer/lixel-object-inspector.js'), /await v\.extractRegionAsObject\(/);
  assert.match(read('renderer/convert-hub.js'), /vwr\.getBigSample\(12000000\)/);
});

test('r17: main/preload — потоковая запись PLY/LAS/XYZ/PTS/PCD/CSV/OBJ: куски байт, объявленный размер, тихая запись только в разрешённый путь', () => {
  const m = read('main.js'), p = read('preload.js');
  assert.match(m, /BIG_EXPORT_EXT = \{ ply: 'PLY', las: 'LAS', xyz: 'XYZ', pts: 'PTS', csv: 'CSV', pcd: 'PCD', obj: 'OBJ' \}/);
  assert.match(m, /ext !== 'ptx' && !Object\.prototype\.hasOwnProperty\.call\(BIG_EXPORT_EXT, ext\)/);
  assert.match(m, /MAX_EXPORT_CHUNK_BYTES = 32 \* 1024 \* 1024/); assert.match(m, /expectedBytes/); assert.match(m, /export stream is larger than announced/);
  assert.match(m, /resolveAuthorizedOutput\(event, String\(payload\.targetPath\)\)/); assert.match(m, /path_not_authorized/);
  assert.match(m, /format: session\.ext/); assert.match(m, /session\.sender === \(event && event\.sender\)/);
  assert.match(p, /writeExportStreamChunk: \(payload\) => inv\('bim:writeExportStreamChunk', payload\)/);
});

test('r17: index.html — модули подключены по порядку и с общей версией; сборка включает новые файлы', () => {
  const h = read('renderer/index.html');
  const i1 = h.indexOf('big-cloud.js?v=1240'), i2 = h.indexOf('webgl-viewer.js?v=1240'), i3 = h.indexOf('webgl-viewer-big.js?v=1240');
  assert.ok(i1 > 0 && i2 > 0 && i3 > 0 && i1 < i3 && i2 < i3, 'порядок: big-cloud, viewer, затем viewer-big');
  const pkg = JSON.parse(read('package.json')); const files = JSON.stringify(pkg.build.files);
  assert.ok(files.includes('renderer') || files.includes('renderer/**'), 'renderer целиком в пакете');
});
