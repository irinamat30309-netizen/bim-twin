'use strict';
// r179: ускорение сборки — параллельный refine по сегментам + буферизованное чтение + стадии/ETA.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const RP = require('../xbin-refine-parallel');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r179: mergeKnots — два сегмента с перекрытием дают плавную общую поправку', () => {
  const T0 = 1000, T1 = 1400, dt = 0.1, overlap = 30;
  // сегменты [1000..1200], [1180..1400]; поправки: поступательный сдвиг 0.1 м/с вдоль X
  const mk = (a, b, v) => {
    const K = Math.ceil((b - a) / dt) + 2, x = new Float64Array(K * 6);
    for (let k = 0; k < K; k++) x[k * 6 + 3] = v; // translation x
    return { t0: a, dt, x };
  };
  const segs = [{ knots: mk(1000, 1200, 0.1), T0: 1000, T1: 1200 }, { knots: mk(1180, 1400, 0.1), T0: 1180, T1: 1400 }];
  const m = RP.mergeKnots(segs, T0, T1, dt, overlap);
  assert.strictEqual(m.K, Math.ceil((T1 - T0) / dt) + 2);
  // все узлы покрыты, значения плавные (в перекрытии 1180..1200 — смесь, без скачков)
  let prev = null, maxJump = 0;
  for (let k = 0; k < m.K; k++) {
    const tx = m.x[k * 6 + 3];
    assert.ok(Number.isFinite(tx), 'узел ' + k + ' NaN');
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(tx - prev));
    prev = tx;
  }
  assert.ok(maxJump < 0.02, 'скачок между узлами слишком большой: ' + maxJump);
  assert.ok(Math.abs(m.x[m.K * 3 + 3] - 0.1) < 1e-6);
});

test('r179: build поддерживает готовые параллельные поправки (refineKnots) и стадийные тайминги', () => {
  const xl = read('xbin-lidar.js');
  assert.match(xl, /if \(o\.refineKnots && o\.refineKnots\.knots\) \{/);
  assert.match(xl, /prepMs: tPrep, refineMs: tRefine, writeMs: tWrite, totalMs: Date\.now\(\) - tStart/);
  assert.match(xl, /const etaLabel = \(start, frac, label\)/);
  assert.match(xl, /makeSeqReader/);
  assert.ok(fs.existsSync(path.join(ROOT, 'xbin-refine-parallel.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'xbin-refine-worker.js')));
  const wk = read('xbin-lidar-worker.js');
  assert.match(wk, /refineParallel/);
  assert.match(wk, /opt\.refineKnots = pr/);
  assert.match(wk, /durationHint > 900/);
});

test('r179: fusion по умолчанию выключен (скорость сборки), остаётся опцией', () => {
  const XL = require('../xbin-lidar');
  assert.strictEqual(XL.DEF.fusion, false);
  // при явном включении режимы сохраняются
  const F = require('../xbin-fusion');
  assert.strictEqual(F.resolveMode('hist', 1000, true), 'hist');
  assert.strictEqual(F.resolveMode(true, 1000, true), 'icp');
});
