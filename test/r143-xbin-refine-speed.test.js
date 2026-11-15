'use strict';
// r143: скорость xbin-refine — быстрый профиль для длинных сканов (2 итерации, regRate 12000),
// ранний выход по сходимости MAD (<1% за итерацию), явные iterations/regRate важнее профиля.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const XR = require('../xbin-refine');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const quatZ = a => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
function matOfQ(q) { const m = new Float64Array(16); XL.qToMat(q[0], q[1], q[2], q[3], m); return m; }
const BX = [-4, 4], BY = [-3, 3], BZ = [0, 3];
function roomCase(T0, T1, err, RATE) {
  const truePose = (t, out) => { const s = t - T0, a = 0.35 * s; out = out || new Float64Array(16); XL.qToMat(...quatZ(a + 0.2 * Math.sin(0.5 * s)), out); out[3] = 1.5 * Math.cos(0.25 * s) - 1.5; out[7] = 1.2 * Math.sin(0.25 * s); out[11] = 1.4; return out; };
  const badPose = (t, out) => {
    out = truePose(t, out); const e = err(t), Rz = matOfQ(quatZ(e.rz)), Rx = matOfQ([Math.sin(e.rx / 2), 0, 0, Math.cos(e.rx / 2)]), tmp = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) { let r = 0; for (let q = 0; q < 3; q++) r += Rz[i * 4 + q] * Rx[q * 4 + k]; s += r * out[k * 4 + j]; } tmp[i * 3 + j] = s; }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 4 + j] = tmp[i * 3 + j];
    out[3] += e.v[0]; out[7] += e.v[1]; out[11] += e.v[2]; return out;
  };
  function fakeWalk(fd, C, o, w0, w1, step, cb) {
    const R = rng(Math.round(w0 * 10)), Mt = new Float64Array(16), Mb = new Float64Array(16);
    const nPts = Math.round((Math.min(w1, C.T1) - Math.max(w0, C.T0)) * RATE);
    for (let i = 0; i < nPts; i++) {
      const t = Math.max(w0, C.T0) + (i + R()) / RATE;
      truePose(t, Mt); C.TR.poseAt(t, Mb);
      const u = R() * 2 - 1, ph = R() * 2 * Math.PI, sq = Math.sqrt(1 - u * u), d = [sq * Math.cos(ph), sq * Math.sin(ph), u];
      const c = [Mt[3], Mt[7], Mt[11]]; let best = Infinity, wall = -1;
      for (let k = 0; k < 3; k++) { if (Math.abs(d[k]) < 1e-9) continue; const lim = [BX, BY, BZ][k][d[k] > 0 ? 1 : 0], s = (lim - c[k]) / d[k]; if (s > 0 && s < best) { best = s; wall = k; } }
      if (wall < 0 || best < 0.8) continue;
      const w = [c[0] + d[0] * best, c[1] + d[1] * best, c[2] + d[2] * best], e = [w[0] - c[0], w[1] - c[1], w[2] - c[2]];
      const b = [Mt[0] * e[0] + Mt[4] * e[1] + Mt[8] * e[2], Mt[1] * e[0] + Mt[5] * e[1] + Mt[9] * e[2], Mt[2] * e[0] + Mt[6] * e[1] + Mt[10] * e[2]];
      const x = Mb[0] * b[0] + Mb[1] * b[1] + Mb[2] * b[2] + Mb[3], y = Mb[4] * b[0] + Mb[5] * b[1] + Mb[6] * b[2] + Mb[7], z = Mb[8] * b[0] + Mb[9] * b[1] + Mb[10] * b[2] + Mb[11];
      cb(x, y, z, t, 10, 0, Mb[3], Mb[7], Mb[11], b[0], b[1], b[2]);
    }
    return { skipped: 0, empty: 0, packets: 0, self: 0 };
  }
  function walls(TR, sel) {
    const S = Array.from({ length: 6 }, () => [0, 0, 0]);
    fakeWalk(null, { T0, T1, TR }, {}, T0, T1, 1, (x, y, z, t) => {
      if (sel && !sel(t)) return;
      const dist = [x - BX[0], BX[1] - x, y - BY[0], BY[1] - y, z - BZ[0], BZ[1] - z]; let k = 0; for (let j = 1; j < 6; j++) if (Math.abs(dist[j]) < Math.abs(dist[k])) k = j;
      S[k][0]++; S[k][1] += dist[k]; S[k][2] += dist[k] * dist[k];
    });
    return S;
  }
  function spread(TR) { let num = 0, den = 0; for (const s of walls(TR)) if (s[0] > 100) { const m = s[1] / s[0]; num += s[2] - s[0] * m * m; den += s[0]; } return Math.sqrt(num / den); }
  const C = { T0, T1, recs: [{ len: Math.round(RATE * 20.5 / 0.6 * (T1 - T0)) }], TR: { poseAt: badPose } };
  return { C, fakeWalk, spread };
}
const errOf = T0 => t => { const s = t - T0; return { rz: 0.4 * Math.PI / 180 * Math.sin(1.3 * s), rx: 0.25 * Math.PI / 180 * Math.cos(0.9 * s), v: [0.015 * Math.sin(0.8 * s), 0.01 * Math.cos(1.1 * s), 0.008 * Math.sin(1.7 * s)] }; };

test('r143: DEF — быстрый профиль и ранний выход; длинный скан по умолчанию быстрый', () => {
  assert.strictEqual(XR.DEF.fast, false);
  assert.strictEqual(XR.DEF.longScan, 600);
  assert.strictEqual(XR.DEF.iterationsLong, 2);
  assert.strictEqual(XR.DEF.regRateLong, 12000);
  assert.strictEqual(XR.DEF.earlyExit, true);
  const T0 = 9000, T1 = T0 + 12, RATE = 40000;
  const K = roomCase(T0, T1, errOf(T0), RATE);
  // длинный скан (порог 5 с) — 2 итерации и regRate 12000 даже без fast
  const rl = XR.refine(null, K.C, { refineOpt: { longScan: 5, mapRate: RATE } }, null, K.fakeWalk);
  assert.strictEqual(rl.summary.longScan, true); assert.strictEqual(rl.summary.fast, false);
  assert.strictEqual(rl.summary.iterationsPlanned, 2); assert.strictEqual(rl.summary.regRateUsed, 12000);
  // fast=true на коротком — тот же быстрый профиль
  const rf = XR.refine(null, K.C, { refineOpt: { fast: true, mapRate: RATE } }, null, K.fakeWalk);
  assert.strictEqual(rf.summary.fast, true); assert.strictEqual(rf.summary.longScan, false);
  assert.strictEqual(rf.summary.iterationsPlanned, 2); assert.strictEqual(rf.summary.regRateUsed, 12000);
  // явные iterations/regRate важнее профиля
  const re = XR.refine(null, K.C, { refineOpt: { iterations: 1, regRate: 8000, fast: true, mapRate: RATE } }, null, K.fakeWalk);
  assert.strictEqual(re.summary.iterationsPlanned, 1); assert.strictEqual(re.summary.regRateUsed, 8000);
  assert.ok(re.summary.iterationsUsed <= re.summary.windows, JSON.stringify(re.summary));
  assert.strictEqual(rl.summary.regRateUsed, 12000);
});

test('r143: ранний выход по MAD — iterations факт 1–2, качество не хуже 10% от полного профиля', () => {
  const T0 = 5000, T1 = T0 + 12, RATE = 40000, err = errOf(T0);
  const K = roomCase(T0, T1, err, RATE);
  const before = K.spread(K.C.TR);
  const base = XR.refine(null, K.C, { refineOpt: { earlyExit: false, iterations: 3, regRate: 12000, maxNb: 40, mapRate: RATE } }, null, K.fakeWalk);
  const early = XR.refine(null, K.C, { refineOpt: { earlyExit: true, earlyExitTol: 100, iterations: 3, regRate: 12000, maxNb: 40, mapRate: RATE } }, null, K.fakeWalk);
  assert.strictEqual(early.summary.iterationsPlanned, 3);
  assert.ok(early.summary.earlyExits >= 1, 'ранний выход должен сработать: ' + JSON.stringify(early.summary));
  assert.ok(early.summary.iterationsUsed <= early.summary.windows * 2, 'итераций факт: ' + early.summary.iterationsUsed);
  assert.ok(early.summary.earlyExitSaved >= 1);
  const afterBase = K.spread(XR.correctedTrajectory(K.C.TR, base.knots));
  const afterEarly = K.spread(XR.correctedTrajectory(K.C.TR, early.knots));
  assert.ok(afterBase < before * 0.5, 'базовый профиль: ' + afterBase);
  assert.ok(afterEarly < before * 0.5, 'даже принудительный ранний выход должен улучшать: ' + afterEarly);
  // штатный ранний выход (порог 1%) — качество не хуже 10% от полного профиля
  const natural = XR.refine(null, K.C, { refineOpt: { earlyExit: true, iterations: 3, regRate: 12000, maxNb: 40, mapRate: RATE } }, null, K.fakeWalk);
  const afterNatural = K.spread(XR.correctedTrajectory(K.C.TR, natural.knots));
  assert.ok(afterNatural <= afterBase * 1.10, 'штатный ранний выход потерял >10%: ' + afterNatural + ' vs ' + afterBase);
  // быстрый профиль (2 итерации/12000) — потеря MAD не больше 10% от полного
  const fast = XR.refine(null, K.C, { refineOpt: { iterations: 2, regRate: 12000, mapRate: RATE } }, null, K.fakeWalk);
  const afterFast = K.spread(XR.correctedTrajectory(K.C.TR, fast.knots));
  assert.ok(afterFast <= afterBase * 1.10, 'fast потерял >10%: ' + afterFast + ' vs ' + afterBase);
});

test('r143: связка — галочка быстрого уточнения в окне, main/preload/worker, opt.fast в сборке', () => {
  const app = read('renderer/app.js'), main = read('main.js'), pre = read('preload.js'), xl = read('xbin-lidar.js'), wr = read('xbin-lidar-worker.js'), pkg = JSON.parse(read('package.json'));
  assert.match(app, /key: 'fast', label: 'Быстрое уточнение \(рекомендуется для длинных сканов\)', type: 'checkbox', value: true/);
  assert.match(app, /fast = v\.fast !== false/);
  assert.match(app, /API\.xbinBuildCloud\(p, jobId, density, \{ refine, fast, color, edge \}\)/);
  assert.match(pre, /fast: !\(opts && opts\.fast === false\)/);
  assert.match(main, /refine: a\.refine === true, fast: a\.fast !== false/);
  assert.match(main, /refine: rf/);   // результат отдаёт сведения об уточнении
  assert.match(main, /fast: !!r\.refine\.fast/);
  assert.match(xl, /for \(const k of \['fast', 'iterations', 'regRate', 'longScan', 'iterationsLong', 'regRateLong'\]\) if \(o\[k\] !== undefined\) ro\[k\] = o\[k\]/);
  assert.match(wr, /XL\.build\(xbinPath, posesText, outPath, opt/);
  assert.ok(pkg.build.files.includes('xbin-refine.js') && pkg.build.asarUnpack.includes('xbin-refine.js'));
  // в главном процессе fast пробрасывается в opt сборки (и дальше — в xbin-refine через refineOpt)
  const r = XL.build; assert.strictEqual(typeof r, 'function');
});
