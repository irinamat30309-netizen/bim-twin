'use strict';
// Ревизия 50: «зерно» цвета (color-grain-core.degrain) — одиночные тёмные/светлые точки на ровной поверхности приводятся к
// взвешенной медиане соседей, а провод, шов и край остаются резкими; редкие места не трогаются; в чистовой обработке — последним
// шагом плитки (пул и один поток дают один и тот же LAS), выключается degrain: false.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CG = require('../color-grain-core');
const RP = require('../scan-refine-parallel');
const SC = require('./helpers/r20-scenes');

// стена 1×1 м (плотность как у фасада в realtime-карте, ~0,8 точки на см²): шум ±4, 6 % «соли» (тёмные и светлые точки),
// тёмный провод z = 0,5 (1 см), светлый шов x = 0,3 (1,2 см)
function wall(n, seed0) {
  let seed = seed0 || 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const X = new Float64Array(n * 3), C = new Float32Array(n * 3), T = new Float32Array(n * 3), K = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = rnd(), z = rnd(); X[i * 3] = x; X[i * 3 + 1] = (rnd() - 0.5) * 0.004; X[i * 3 + 2] = z;
    let c = [200, 200, 205], k = 0; if (Math.abs(z - 0.5) < 0.005) { c = [40, 40, 45]; k = 2; } else if (Math.abs(x - 0.3) < 0.006) { c = [250, 245, 240]; k = 3; }
    for (let a = 0; a < 3; a++) T[i * 3 + a] = c[a];
    const salt = k === 0 && rnd() < 0.06; if (salt) K[i] = 1;
    for (let a = 0; a < 3; a++) C[i * 3 + a] = salt ? (rnd() < 0.8 ? 60 : 255) : c[a] + (rnd() - 0.5) * 8;
    if (!K[i]) K[i] = k;
  }
  return { X, C, T, K, n };
}
const err = (W, sel) => { let s = 0, m = 0; for (let i = 0; i < W.n; i++) if (sel(i)) { m++; let d = 0; for (let a = 0; a < 3; a++) d = Math.max(d, Math.abs(W.C[i * 3 + a] - W.T[i * 3 + a])); if (d > 30) s++; } return m ? s / m : 0; };
const meanL = (W, k) => { let s = 0, m = 0; for (let i = 0; i < W.n; i++) if (W.K[i] === k) { s += (W.C[i * 3] + W.C[i * 3 + 1] + W.C[i * 3 + 2]) / 3; m++; } return s / m; };

test('r50: «соль» на стене исчезает, провод и шов остаются, цвет стены не сдвигается', () => {
  const W = wall(80000);
  const before = err(W, i => W.K[i] === 1);
  assert.ok(before > 0.95, 'соль до: ' + before);
  const ch = CG.degrain(W.X, W.C, W.n, null, {});
  assert.ok(ch > W.n * 0.5, 'изменено: ' + ch);
  const after = err(W, i => W.K[i] === 1), all = err(W, () => true);
  assert.ok(after < 0.03, 'соль после: ' + after);
  assert.ok(all < 0.03, 'всего с ошибкой > 30: ' + all);
  assert.ok(meanL(W, 2) < 70, 'провод тёмный: ' + meanL(W, 2));
  assert.ok(meanL(W, 3) > 230, 'шов светлый: ' + meanL(W, 3));
  assert.ok(Math.abs(meanL(W, 0) - 201.7) < 2, 'стена: ' + meanL(W, 0));
});

test('r50: редкие точки (мало соседей) и выключенные (alive = 0) не трогаются; результат не зависит от порядка точек', () => {
  const W = wall(400, 9), C0 = Float32Array.from(W.C);   // 0,04 точки на см² — соседей в 2,5 см почти нет
  CG.degrain(W.X, W.C, W.n, null, {});
  let moved = 0; for (let i = 0; i < W.n * 3; i++) if (Math.abs(W.C[i] - C0[i]) > 0.5) moved++;
  assert.ok(moved < W.n * 0.1, 'изменено в редком: ' + moved);
  const V = wall(20000, 11), alive = new Uint8Array(V.n).fill(1); for (let i = 0; i < V.n; i += 2) alive[i] = 0;
  const D = Float32Array.from(V.C); CG.degrain(V.X, V.C, V.n, alive, {});
  for (let i = 0; i < V.n; i += 2) for (let a = 0; a < 3; a++) assert.strictEqual(V.C[i * 3 + a], D[i * 3 + a]);
  // обратный порядок точек — тот же цвет
  const A = wall(20000, 13), B = wall(20000, 13), n = A.n, X2 = new Float64Array(n * 3), C2 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { X2[(n - 1 - i) * 3 + a] = B.X[i * 3 + a]; C2[(n - 1 - i) * 3 + a] = B.C[i * 3 + a]; }
  CG.degrain(A.X, A.C, n, null, {}); CG.degrain(X2, C2, n, null, {});
  let diff = 0; for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) diff = Math.max(diff, Math.abs(A.C[i * 3 + a] - C2[(n - 1 - i) * 3 + a]));
  assert.ok(diff < 1e-3, 'разница порядка: ' + diff);
});

test('r50: взвешенная медиана и устойчивое среднее', () => {
  const idx = new Int32Array(8);
  assert.strictEqual(CG.wmedian(Float32Array.from([5, 1, 9]), Float64Array.from([1, 1, 1]), 3, idx), 5);
  assert.strictEqual(CG.wmedian(Float32Array.from([5, 1, 9]), Float64Array.from([1, 3, 1]), 3, idx), 1);
  assert.strictEqual(CG.wmedian(Float32Array.from([2, 4]), Float64Array.from([1, 1]), 2, idx), 3);
  // устойчивое среднее средней половины по весу: выброс 250 не тянет
  const o = [0, 0, 0]; CG.trimmed(Int32Array.from([0, 1, 2, 3]), 0, 3, 4, Float64Array.from([1, 1, 1, 1]), Float32Array.from([10, 20, 30, 250]), Float32Array.from([10, 20, 30, 250]), Float32Array.from([10, 20, 30, 250]), o);
  assert.ok(Math.abs(o[0] - 25) < 1e-9, 'trimmed: ' + o[0]);
});

// две стены с «солью» — чистовая обработка (пул): соль убирается, один поток = три потока, degrain: false — как раньше
function wallsLas(file, n) {
  let seed = 21; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pts = new Array(n * 4), rgb = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const w = rnd() < 0.5, u = rnd() * 3, z = rnd() * 2.5;
    pts[i * 4] = w ? u : 0; pts[i * 4 + 1] = w ? 0 : u; pts[i * 4 + 2] = z; pts[i * 4 + 3] = rnd() * 100;
    const salt = rnd() < 0.06, base = w ? [190, 185, 180] : [120, 150, 190];
    for (let a = 0; a < 3; a++) rgb[i * 3 + a] = salt ? 40 : Math.round(base[a] + (rnd() - 0.5) * 6);
  }
  SC.writeLas(file, pts, rgb);
}
function darkShare(file) {
  const b = fs.readFileSync(file), off = b.readUInt32LE(96), rl = b.readUInt16LE(105), fmt = b[104], n = (b.length - off) / rl, ro = { 2: 20, 3: 28 }[fmt];
  let d = 0, mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, b.readUInt16LE(off + i * rl + ro));
  const s = mx > 255 ? 256 : 1;
  for (let i = 0; i < n; i++) { const r = b.readUInt16LE(off + i * rl + ro) / s; if (r < 80) d++; } return d / n;
}

test('r50: чистовая обработка — зерно убрано, пул и один поток дают один LAS, degrain: false — без сглаживания', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r50-'));
  try {
    const src = path.join(dir, 'walls.las'); wallsLas(src, 120000);   // ~0,8 точки на см²
    const a = path.join(dir, 'a.las'), b = path.join(dir, 'b.las'), c = path.join(dir, 'c.las');
    const o = { tmpDir: dir, noiseLevel: 'strong', tileMax: 30000, align: false, colorBalance: false };
    const sa = await RP.refineParallel(src, a, Object.assign({ threads: 1 }, o)), sb = await RP.refineParallel(src, b, Object.assign({ threads: 3 }, o));
    assert.ok(Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0, 'LAS одного потока и пула различаются');
    assert.ok(sa.degrain > 50000 && sb.degrain === sa.degrain, 'degrain: ' + sa.degrain + ' / ' + sb.degrain);
    const sc = await RP.refineParallel(src, c, Object.assign({ threads: 2, degrain: false }, o));
    assert.strictEqual(sc.degrain, 0);
    const dOn = darkShare(a), dOff = darkShare(c), d0 = darkShare(src);
    assert.ok(d0 > 0.04, 'соль в исходном: ' + d0);
    assert.ok(dOn < 0.004, 'соль со сглаживанием: ' + dOn + ' (без: ' + dOff + ')');
    assert.ok(dOn < dOff, 'со сглаживанием меньше соли: ' + dOn + ' / ' + dOff);
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.refine-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r50: модуль попадает в сборку (files и asarUnpack — его грузят потоки чистовой обработки)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('color-grain-core.js'), 'files'); assert.ok(pkg.build.asarUnpack.includes('color-grain-core.js'), 'asarUnpack');
});
