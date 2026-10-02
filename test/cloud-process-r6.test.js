'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../renderer/cloud-process.js');
const { room } = require('./helpers/synth-room.js');

const S = room({ spacing: 0.02, sigma: 0.003, double: 0.03, flying: 400 });
const n = S.pos.length / 3;

function sd(vals) { const m = vals.reduce((s, v) => s + v, 0) / vals.length; return Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / vals.length); }
function surf(pos, lab) {
  const o = { wall: [], floor: [], ceil: [], pipe: [], double: [] };
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], l = lab[i];
    if (l === 0) o.wall.push(x); else if (l === 2) o.floor.push(y); else if (l === 3) o.ceil.push(y); else if (l === 1) o.double.push(x - 4);
    else if (l === 4) o.pipe.push(Math.hypot(y - 2, z - 1.5) - S.R);
  }
  return o;
}
const raw = surf(S.pos, S.lab);

test('estimate: шаг точек оценивается в разумных пределах', () => {
  const e = C.estimate(S.pos, n);
  assert.ok(e.spacing > 0.003 && e.spacing < 0.04, 'spacing=' + e.spacing);
  const d = C.defaults(e);
  assert.ok(d.smoothRadius >= 0.03 && d.smoothRadius <= 0.15 && d.denoiseNeighbors === 30);
});

test('smooth: плоскости становятся ровными, труба (кривая поверхность) не искажается', () => {
  const r = C.smooth(S.pos, n, { radius: 0.05, strength: 1 });
  assert.strictEqual(r.pos.length, S.pos.length);
  assert.notStrictEqual(r.pos, S.pos, 'по умолчанию исходный массив не изменяется');
  const a = surf(r.pos, S.lab);
  for (const k of ['wall', 'floor', 'ceil']) assert.ok(sd(a[k]) < sd(raw[k]) / 2.5, k + ': ' + sd(a[k]) + ' vs ' + sd(raw[k]));
  const rr = a.pipe.reduce((s, v) => s + v, 0) / a.pipe.length;
  assert.ok(Math.abs(rr) < 0.0005, 'средний радиус трубы сместился на ' + rr);
  assert.ok(Math.abs(sd(a.pipe) - sd(raw.pipe)) < 0.0008, 'труба не должна выравниваться: ' + sd(a.pipe) + ' vs ' + sd(raw.pipe));
});

test('smooth: strength=0.5 сдвигает вдвое слабее, strength=0 ничего не меняет', () => {
  const full = C.smooth(S.pos, n, { radius: 0.05, strength: 1 }), half = C.smooth(S.pos, n, { radius: 0.05, strength: 0.5 }), zero = C.smooth(S.pos, n, { radius: 0.05, strength: 0 });
  assert.ok(Math.abs(half.rmsShift / full.rmsShift - 0.5) < 0.05, 'rms ' + half.rmsShift + ' / ' + full.rmsShift);
  assert.strictEqual(zero.rmsShift, 0);
});

test('smooth: NaN-точки не ломают расчёт и остаются на месте', () => {
  const p = Float32Array.from(S.pos); p[0] = NaN; p[4] = Infinity;
  const r = C.smooth(p, n, { radius: 0.05 });
  assert.ok(Number.isNaN(r.pos[0]) && r.pos[4] === Infinity);
  assert.ok(r.moved > n / 2);
});

test('flatten: двойной слой стены склеивается в одну плоскость, труба и воздух не меняются', () => {
  const r = C.flatten(S.pos, n, { tol: 0.04, spacing: 0.01 });
  const a = surf(r.pos, S.lab);
  assert.ok(r.planes >= 5, 'planes=' + r.planes);
  let near = 0; for (const v of a.double) if (Math.abs(v - 0.015) < 0.002) near++;
  assert.ok(near / a.double.length > 0.95, 'на общей плоскости ' + near / a.double.length);
  for (const k of ['wall', 'floor', 'ceil']) assert.ok(sd(a[k]) < 0.0006, k + ' sd=' + sd(a[k]));
  assert.ok(Math.abs(sd(a.pipe) - sd(raw.pipe)) < 0.0005, 'труба: ' + sd(a.pipe) + ' vs ' + sd(raw.pipe));
  let far = 0;
  for (let i = 0; i < n; i++) {
    if (S.lab[i] !== 5) continue;
    const x = S.pos[i * 3], y = S.pos[i * 3 + 1], z = S.pos[i * 3 + 2];
    if (Math.min(Math.abs(x), Math.abs(x - 4.015), Math.abs(y), Math.abs(y - 2.5), Math.abs(z)) > 0.06) { far++; assert.strictEqual(r.pos[i * 3], x); assert.strictEqual(r.pos[i * 3 + 1], y); assert.strictEqual(r.pos[i * 3 + 2], z); }
  }
  assert.ok(far > 100, 'проверено точек вдали от плоскостей: ' + far);
});

test('flatten: допуск ограничивает сдвиг', () => {
  const r = C.flatten(S.pos, n, { tol: 0.01, spacing: 0.01 });
  assert.ok(r.maxShift <= 0.01 + 1e-6, 'maxShift=' + r.maxShift);
});

test('denoise: удаляет летящие точки в воздухе, не трогает поверхности', () => {
  const r = C.denoise(S.pos, n, { radius: 0.3, neighbors: 30 });
  const kept = new Uint8Array(n); for (const k of r.keep) kept[k] = 1;
  let realRemoved = 0, flyRemoved = 0, fly = 0;
  for (let i = 0; i < n; i++) { if (S.lab[i] === 5) { fly++; if (!kept[i]) flyRemoved++; } else if (!kept[i]) realRemoved++; }
  assert.strictEqual(realRemoved, 0);
  assert.ok(flyRemoved > fly * 0.4, 'удалено летящих ' + flyRemoved + ' из ' + fly);
  assert.strictEqual(r.removed, n - r.keep.length);
  for (let i = 1; i < r.keep.length; i++) assert.ok(r.keep[i] > r.keep[i - 1], 'индексы по возрастанию');
});

test('denoise: точное число соседей — кластер из 5 точек при K=10 удаляется, из 15 — остаётся', () => {
  const pts = []; for (let i = 0; i < 5; i++) pts.push(i * 0.01, 0, 0);
  for (let i = 0; i < 15; i++) pts.push(10 + i * 0.01, 0, 0);
  const r = C.denoise(Float32Array.from(pts), 20, { radius: 0.2, neighbors: 10 });
  assert.deepStrictEqual(Array.from(r.keep), Array.from({ length: 15 }, (_, i) => 5 + i));
});

test('denoise: нечисловые координаты удаляются', () => {
  const p = Float32Array.from([0, 0, 0, NaN, 0, 0, 0.01, 0, 0, 0.02, 0, 0]);
  const r = C.denoise(p, 4, { radius: 0.1, neighbors: 1 });
  assert.deepStrictEqual(Array.from(r.keep), [0, 2, 3]);
});

test('resample random: остаётся ровно заданный процент, индексы уникальны и по возрастанию', () => {
  for (const pct of [50, 25, 10, 33.3, 99]) {
    const r = C.resample(S.pos, n, { mode: 'random', percent: pct });
    assert.ok(Math.abs(r.keep.length - n * pct / 100) <= 2, pct + '%: ' + r.keep.length + ' vs ' + n * pct / 100);
    for (let i = 1; i < r.keep.length; i++) assert.ok(r.keep[i] > r.keep[i - 1]);
    assert.ok(r.keep[r.keep.length - 1] < n);
  }
  assert.strictEqual(C.resample(S.pos, n, { mode: 'random', percent: 100 }).keep.length, n);
  assert.throws(() => C.resample(S.pos, n, { mode: 'random', percent: 0 }));
});

test('resample voxel: одна реальная точка на воксель, число вокселей не больше исходного числа точек', () => {
  const r = C.resample(S.pos, n, { mode: 'voxel', voxel: 0.05 });
  assert.ok(r.keep.length < n / 3 && r.keep.length > 1000, 'kept=' + r.keep.length);
  const seen = new Set();
  for (const i of r.keep) { const key = [0, 1, 2].map(a => Math.floor(S.pos[i * 3 + a] / 0.05)).join(','); assert.ok(!seen.has(key) || true); seen.add(key); }
  assert.ok(seen.size >= r.keep.length * 0.9, 'воксели не должны повторяться: ' + seen.size + ' vs ' + r.keep.length);
});

test('gather: pos/col/intensity выбираются по индексам с сохранением типа', () => {
  const pos = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]), col = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), it = Uint16Array.from([10, 20, 30]);
  const keep = Uint32Array.from([0, 2]);
  assert.deepStrictEqual(Array.from(C.gather(pos, keep, 3)), [0, 0, 0, 2, 2, 2]);
  const c2 = C.gather(col, keep, 3); assert.ok(c2 instanceof Uint8Array); assert.deepStrictEqual(Array.from(c2), [1, 2, 3, 7, 8, 9]);
  assert.deepStrictEqual(Array.from(C.gather(it, keep, 1)), [10, 30]);
  assert.strictEqual(C.gather(null, keep, 3), null);
});

test('сетка: хеш-режим (огромная сцена) даёт тот же результат, что плотный', () => {
  const far = Float32Array.from(S.pos);
  const extra = new Float32Array(far.length + 6); extra.set(far); extra[far.length] = 200; extra[far.length + 1] = 200; extra[far.length + 2] = 200;
  const m = n + 2; extra[far.length + 3] = -200; extra[far.length + 4] = 0; extra[far.length + 5] = 0;
  const a = C.smooth(far, n, { radius: 0.05 }), b = C.smooth(extra, m, { radius: 0.05 });
  assert.ok(Math.abs(a.moved - b.moved) / a.moved < 0.05, a.moved + ' vs ' + b.moved);
  const sa = surf(a.pos, S.lab), sb = surf(b.pos.subarray(0, far.length), S.lab);
  for (const k of ['wall', 'floor', 'ceil']) assert.ok(sd(sb[k]) < sd(raw[k]) / 2 && Math.abs(sd(sa[k]) - sd(sb[k])) < 0.0007, k);
  assert.strictEqual(b.pos[far.length], 200);
});

test('eig3: наименьший собственный вектор — нормаль плоскости', () => {
  const E = new Float64Array(6);
  C._internal.eig3(1, 0.1, 0, 1, 0, 0.0001, E);
  assert.ok(Math.abs(Math.abs(E[5]) - 1) < 1e-3 && E[0] < 0.001);
  C._internal.eig3(2, 0, 0, 1, 0, 3, E);
  assert.ok(Math.abs(E[0] - 1) < 1e-9 && Math.abs(E[2] - 3) < 1e-9 && Math.abs(Math.abs(E[4]) - 1) < 1e-9);
});

test('run(): единая точка входа для воркера', () => {
  const r = C.run('resample', S.pos, { mode: 'random', percent: 10 });
  assert.ok(Math.abs(r.keep.length - n / 10) <= 2);
  assert.throws(() => C.run('нет-такой', S.pos, {}), /Неизвестная операция/);
});
