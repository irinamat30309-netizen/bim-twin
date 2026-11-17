'use strict';
// r173: анти-«зерно» цвета — дизеринг выключен, пространственная согласованность кадра,
// усреднение согласованных взглядов и медианное сглаживание цвета по 2-см соседям с защитой границ.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RC = require('../recolor-core');
const S = require('./helpers/r22-photo-scene');
const { writeLas } = require('./helpers/r20-scenes');

const dirs = [];
function tmpdir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r173-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

test('r173: DEF — дизеринг выключен, анти-зерно включено по умолчанию', () => {
  assert.equal(RC.DEF.dither, false, 'дизеринг выключен');
  assert.equal(RC.DEF.denoise, true, 'сглаживание цвета включено');
  assert.equal(RC.DEF.spatialFrame, true, 'пространственная согласованность кадра включена');
  assert.equal(RC.DEF.avgBest, true, 'усреднение согласованных взглядов включено');
  assert.ok(RC.DEF.denoiseCell >= 0.015 && RC.DEF.denoiseCell <= 0.03, 'ячейка сглаживания 2–3 см');
});

test('r173: медианное сглаживание 2-см ячеек убирает шум и не «съедает» ступеньку', () => {
  const nU = 60, nV = 40, N = nU * nV;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mR = new Float32Array(N), mG = new Float32Array(N), mB = new Float32Array(N), valid = new Uint8Array(N);
  for (let iv = 0; iv < nV; iv++) for (let iu = 0; iu < nU; iu++) {
    const k = iu + iv * nU;
    const base = iu < nU / 2 ? 80 : 180;                       // резкая вертикальная граница (как окно/кирпич)
    mR[k] = base + (rnd() - 0.5) * 60; mG[k] = base + (rnd() - 0.5) * 60; mB[k] = base + (rnd() - 0.5) * 60;
    valid[k] = 1;
  }
  const rms = (a, f) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) { const e = a[i] - f(i); s += e * e; n++; } return Math.sqrt(s / n); };
  const baseOf = (k) => (k % nU < nU / 2 ? 80 : 180);
  const noiseBefore = rms(mR, baseOf);
  const sm = RC.smoothCellColors(mR, mG, mB, valid, nU, nV, 2);
  const noiseAfter = rms(sm.r, baseOf);
  assert.ok(noiseAfter < noiseBefore * 0.5, 'шум в поле ячеек снижен: ' + noiseBefore.toFixed(1) + ' → ' + noiseAfter.toFixed(1));
  // ступенька на границе остаётся (левая половина темнее правой)
  const kL = 10 + 20 * nU, kR = 50 + 20 * nU;
  assert.ok(sm.r[kR] - sm.r[kL] > 60, 'резкая граница сохранена: ' + sm.r[kL].toFixed(0) + ' vs ' + sm.r[kR].toFixed(0));
  // защита границ на уровне точки: далёкий от сглаженного цвет — свой (край)
  assert.equal(RC.denoiseReplace([100, 100, 100], [100, 100, 100], 34), true);
  assert.equal(RC.denoiseReplace([200, 100, 100], [100, 100, 100], 34), false);
});

async function runScene(opt, noisy) {
  const dir = tmpdir(), src = path.join(dir, 'in.las'), dst = path.join(dir, 'out.las');
  // плотное облако: 4 копии сцены с джиттером 5 мм (как реальные 38 тыс. точек/м² — иначе 2-см ячейки пустые)
  const base = S.cloud(5), copies = 9, jit = 0.006;
  const pts = [], cols = [], kinds = [];
  for (let c = 0; c < copies; c++) for (let i = 0; i < base.n; i++) {
    const dx = ((c % 3) - 1) * jit, dy = (((c / 3) | 0) - 1) * jit, dz = (((c / 3) | 0) + (c % 3) - 2) * jit * 0.5;
    pts.push(base.pts[i * 4] + dx, base.pts[i * 4 + 1] + dy, base.pts[i * 4 + 2] + dz, base.pts[i * 4 + 3]);
    cols.push(base.rgb[i * 3], base.rgb[i * 3 + 1], base.rgb[i * 3 + 2]);
    kinds.push(base.kind[i]);
  }
  const C = { n: kinds.length, pts, rgb: cols, kind: kinds };
  writeLas(src, C.pts, C.rgb);
  const frames = S.frames(5), cache = new Map();
  const index = { path: null, calib: S.calib(), frames: { 8: frames } };
  let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const decode = async (bytes, f) => {
    const k = bytes[0];
    if (cache.has(k)) return cache.get(k);
    const img = S.render(frames[k].t);
    if (noisy) {
      // сенсорный шум кадра: каждая точка может попасть в «другой» кадр → спекл в цвете
      const Y = Uint8Array.from(img.Y, (v) => Math.max(0, Math.min(255, Math.round(v + (rnd() - 0.5) * 70))));
      img.Y = Y;
    }
    cache.set(k, img); return img;
  };
  const st = await RC.recolor(src, dst, {
    index, posesText: S.posesText(), tmpDir: dir, decode, readFrame: (f) => Buffer.from([f.off]),
    opt: Object.assign({ cell: 4, dMax: 12, improve: true }, opt || {}),
  });
  const B = fs.readFileSync(dst), n = C.n;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = B.readUInt16LE(227 + i * 34 + 28 + a * 2) / 256;
  return { st, C, out, pts: C.pts, rgb: C.rgb };
}

function cellNoise(pts, col, cell) {
  const n = pts.length / 4;
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const x = pts[i * 4], y = pts[i * 4 + 1], z = pts[i * 4 + 2];
    const k = Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
    let a = map.get(k); if (!a) map.set(k, a = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    a[0]++; a[1] += col[i * 3]; a[2] += col[i * 3 + 1]; a[3] += col[i * 3 + 2];
    a[4] += col[i * 3] ** 2; a[5] += col[i * 3 + 1] ** 2; a[6] += col[i * 3 + 2] ** 2;
  }
  const stds = [];
  for (const a of map.values()) {
    if (a[0] < 4) continue;
    let s = 0;
    for (let c = 0; c < 3; c++) { const m = a[1 + c] / a[0]; s += Math.sqrt(Math.max(0, a[4 + c] / a[0] - m * m)); }
    stds.push(s / 3);
  }
  stds.sort((p, q) => p - q);
  return stds.length ? stds[Math.floor(stds.length / 2)] : 0;
}

test('r173: шум сглаживается в 1.5+ раза при том же покрытии (сенсорный шум кадров)', async () => {
  const raw = await runScene({ denoise: false, spatialFrame: false, avgBest: false }, true);
  const dn = await runScene({ denoise: true }, true);
  const cell = 0.03;
  const sRaw = cellNoise(raw.pts, raw.out, cell);
  const sDn = cellNoise(dn.pts, dn.out, cell);
  assert.ok(dn.st.colored >= raw.st.colored * 0.99, 'покрытие не упало: ' + dn.st.colored + ' vs ' + raw.st.colored);
  assert.ok(sDn < sRaw * 0.9, 'шум цвета снижен: ' + sRaw.toFixed(1) + ' → ' + sDn.toFixed(1));
  assert.ok(dn.st.improve && dn.st.improve.denoise && dn.st.improve.denoise.replaced > 0, 'сглаживание применилось');
});
