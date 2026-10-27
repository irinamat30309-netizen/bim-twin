'use strict';
// Ревизия 25: облако из сырого лидара .xbin — гироскоп IMU между позами, уточнение траектории по самому облаку (xbin-refine.js),
// самомаска корпуса сканера, флажок «Уточнить траекторию по облаку» в окне и передача через preload/main.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const XR = require('../xbin-refine');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// детерминированный генератор
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const quatZ = a => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
function matOfQ(q) { const m = new Float64Array(16); XL.qToMat(q[0], q[1], q[2], q[3], m); return m; }
function angleBetween(A, B) {   // угол между поворотами 3×3 из 4×4
  let tr = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += A[i * 4 + j] * B[i * 4 + j];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

test('r25: блочно-трёхдиагональная прогонка 6×6 совпадает с решением плотной системы', () => {
  const L = 7, N = L * 6, R = rng(7), D = new Float64Array(L * 36), U = new Float64Array(L * 36), g = new Float64Array(N);
  const A = Array.from({ length: N }, () => new Float64Array(N));
  for (let k = 0; k < L; k++) {
    // D[k] = MᵀM + 6·I (положительно определённая), U[k] — произвольный малый блок
    const M = Array.from({ length: 36 }, () => R() - 0.5);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { let s = i === j ? 6 : 0; for (let r = 0; r < 6; r++) s += M[r * 6 + i] * M[r * 6 + j]; D[k * 36 + i * 6 + j] = s; }
    if (k < L - 1) for (let i = 0; i < 36; i++) U[k * 36 + i] = (R() - 0.5) * 0.8;
    for (let i = 0; i < 6; i++) g[k * 6 + i] = R() * 2 - 1;
  }
  for (let k = 0; k < L; k++) for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    A[k * 6 + i][k * 6 + j] = D[k * 36 + i * 6 + j];
    if (k < L - 1) { A[k * 6 + i][(k + 1) * 6 + j] = U[k * 36 + i * 6 + j]; A[(k + 1) * 6 + j][k * 6 + i] = U[k * 36 + i * 6 + j]; }
  }
  const x = XR.solveBlockTridiag(D, U, g, L);
  let worst = 0;
  for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += A[i][j] * x[j]; worst = Math.max(worst, Math.abs(s - g[i])); }
  assert.ok(worst < 1e-9, 'невязка ' + worst);
  // eig3: наименьшее собственное значение и вектор нормали плоскости
  const nb = new Float64Array(3), l = XR.eig3(1, 0, 0, 4, 0, 1e-4, nb);
  assert.ok(Math.abs(l[0] - 1e-4) < 1e-9 && Math.abs(Math.abs(nb[2]) - 1) < 1e-9, 'eig3 ' + Array.from(l) + ' ' + Array.from(nb));
});

test('r25: гироскоп между позами 5 Гц восстанавливает быстрое покачивание, которое линейная интерполяция теряет', () => {
  // истинный поворот: рысканье 0,3 рад/с + покачивание 4° с частотой 3 Гц (между позами траектории через 0,2 с)
  const T0 = 1000, Tn = 6, A = 4 * Math.PI / 180, F = 3;
  const yaw = t => 0.3 * (t - T0) + A * Math.sin(2 * Math.PI * F * (t - T0));
  const rate = t => 0.3 + A * 2 * Math.PI * F * Math.cos(2 * Math.PI * F * (t - T0));
  const n = Math.round(Tn / 0.2) + 1, P = { n, t: new Float64Array(n), p: new Float64Array(n * 3), q: new Float64Array(n * 4) };
  for (let i = 0; i < n; i++) { const t = T0 + i * 0.2; P.t[i] = t; P.p.set([t - T0, 0, 1], i * 3); P.q.set(quatZ(yaw(t)), i * 4); }
  const m = Math.round(Tn * 200) + 41, imu = { t: new Float64Array(m), g: new Float64Array(m * 3) };
  for (let k = 0; k < m; k++) { const t = T0 - 0.1 + k / 200; imu.t[k] = t; imu.g[k * 3 + 2] = rate(t); }
  const withImu = XL.makeTrajectory(P, imu, { imu: true }), plain = XL.makeTrajectory(P, imu, { imu: false });
  assert.strictEqual(withImu.imu, true); assert.strictEqual(plain.imu, false); assert.strictEqual(withImu.imuIntervals, n - 1);
  let eImu = 0, ePlain = 0;
  for (let t = T0 + 0.013; t < T0 + Tn; t += 0.037) {
    const truth = matOfQ(quatZ(yaw(t)));
    eImu = Math.max(eImu, angleBetween(withImu.poseAt(t), truth)); ePlain = Math.max(ePlain, angleBetween(plain.poseAt(t), truth));
  }
  assert.ok(ePlain > 2 * Math.PI / 180, 'без гироскопа ошибка должна быть заметной: ' + ePlain * 180 / Math.PI);
  assert.ok(eImu < 0.05 * Math.PI / 180, 'с гироскопом ошибка поворота ' + eImu * 180 / Math.PI + '°');
  // положение: сплайн Эрмита на равномерном движении — точно; на позах — совпадает с poses.csv
  const M = withImu.poseAt(T0 + 1.1); assert.ok(Math.abs(M[3] - 1.1) < 1e-9 && Math.abs(M[11] - 1) < 1e-12);
  assert.strictEqual(withImu.position, 'hermite'); assert.strictEqual(XL.makeTrajectory(P, imu, { position: 'linear' }).position, 'linear');
});

// синтетическая комната 8×6×3 м: сканер ходит по кругу; «лидар» — случайные лучи до стен; точка в системе сканера — по истинной
// позе, в мире — по текущей траектории C.TR (в ней ошибка, как в poses.csv)
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
  // по стенам: число точек, сумма и сумма квадратов расстояния (знак — внутрь комнаты); sel(t) — какие точки брать
  function walls(TR, sel) {
    const S = Array.from({ length: 6 }, () => [0, 0, 0]);
    fakeWalk(null, { T0, T1, TR }, {}, T0, T1, 1, (x, y, z, t) => {
      if (sel && !sel(t)) return;
      const dist = [x - BX[0], BX[1] - x, y - BY[0], BY[1] - y, z - BZ[0], BZ[1] - z]; let k = 0; for (let j = 1; j < 6; j++) if (Math.abs(dist[j]) < Math.abs(dist[k])) k = j;
      S[k][0]++; S[k][1] += dist[k]; S[k][2] += dist[k] * dist[k];
    });
    return S;
  }
  // разброс относительно стен (после вычета среднего по каждой стене — общий сдвиг облака не считается)
  function spread(TR) { let num = 0, den = 0; for (const s of walls(TR)) if (s[0] > 100) { const m = s[1] / s[0]; num += s[2] - s[0] * m * m; den += s[0]; } return Math.sqrt(num / den); }
  const C = { T0, T1, recs: [{ len: Math.round(RATE * 20.5 / 0.6 * (T1 - T0)) }], TR: { poseAt: badPose } };
  return { C, fakeWalk, walls, spread };
}

test('r25: уточнение по облаку убирает ошибку траектории — стены комнаты снова тонкие', () => {
  // ошибка траектории: поворот до 0,4° и сдвиг до 15 мм, плавно меняется за секунды
  const T0 = 5000, T1 = T0 + 12, RATE = 40000;
  const err = t => { const s = t - T0; return { rz: 0.4 * Math.PI / 180 * Math.sin(1.3 * s), rx: 0.25 * Math.PI / 180 * Math.cos(0.9 * s), v: [0.015 * Math.sin(0.8 * s), 0.01 * Math.cos(1.1 * s), 0.008 * Math.sin(1.7 * s)] }; };
  const K = roomCase(T0, T1, err, RATE);
  const before = K.spread(K.C.TR);
  const r = XR.refine(null, K.C, { refineOpt: { regRate: 8000, mapRate: RATE } }, null, K.fakeWalk);
  const after = K.spread(XR.correctedTrajectory(K.C.TR, r.knots));
  if (process.env.R25_DEBUG) console.log('spread', before, after, JSON.stringify(r.summary));
  assert.ok(before > 0.008, 'ошибка траектории должна размывать стены: ' + before);
  assert.ok(after < before * 0.5 && after < 0.006, 'после уточнения разброс ' + (after * 1000).toFixed(2) + ' мм (до ' + (before * 1000).toFixed(2) + ' мм)');
  assert.ok(r.summary.windows >= 1 && r.summary.pairs > 1000 && r.summary.residualAfterMm < r.summary.residualBeforeMm, JSON.stringify(r.summary));
});

test('r25: повторный проход — общая карта съёмки убирает «двойные стены» от медленного ухода траектории', () => {
  // траектория без ошибки первые 4 с, затем за 4 с уходит на 2 см (и 0,3°) и дальше так и остаётся — как дрейф SLAM за минуты
  const T0 = 7000, T1 = T0 + 16, RATE = 20000;
  const ramp = t => Math.max(0, Math.min(1, (t - T0 - 4) / 4));
  const err = t => ({ rz: 0.3 * Math.PI / 180 * ramp(t), rx: 0, v: [0.02 * ramp(t), -0.012 * ramp(t), 0.006 * ramp(t)] });
  const K = roomCase(T0, T1, err, RATE);
  const early = t => t < T0 + 3.5, late = t => t > T0 + 9;
  // сдвиг поздних точек относительно ранних по стенам (мм, наибольший по 6 стенам)
  const doubling = TR => { const A = K.walls(TR, early), B = K.walls(TR, late); let w = 0; for (let k = 0; k < 6; k++) if (A[k][0] > 50 && B[k][0] > 50) w = Math.max(w, Math.abs(A[k][1] / A[k][0] - B[k][1] / B[k][0])); return w; };
  const ro = { window: 5, overlap: 1, regRate: 6000, mapRate: RATE, globalMinAge: 2 };   // в масштабе теста: «старые» точки — старше 2 с
  const before = doubling(K.C.TR);
  const local = XR.refine(null, K.C, { refineOpt: Object.assign({ global: false }, ro) }, null, K.fakeWalk);
  const glob = XR.refine(null, K.C, { refineOpt: ro }, null, K.fakeWalk);
  const dLocal = doubling(XR.correctedTrajectory(K.C.TR, local.knots)), dGlob = doubling(XR.correctedTrajectory(K.C.TR, glob.knots));
  if (process.env.R25_DEBUG) console.log('doubling mm', before * 1000, dLocal * 1000, dGlob * 1000, JSON.stringify(glob.summary));
  assert.ok(before > 0.015, 'двоение до уточнения ' + before);
  assert.ok(dLocal > 0.008, 'без общей карты окна по 5 с дрейф не видят: ' + dLocal);
  assert.ok(dGlob < 0.005 && dGlob < dLocal / 3, 'с общей картой двоение ' + (dGlob * 1000).toFixed(2) + ' мм (без неё ' + (dLocal * 1000).toFixed(2) + ' мм)');
  assert.ok(glob.summary.globalUsed > 0 && glob.summary.globalPairs > 0 && glob.summary.windows >= 3, JSON.stringify(glob.summary));
});

test('r25: связка — опция refine в preload/main/воркере, флажок и выбор облака в окне, самомаска, сборка пакета, заголовок LAS', () => {
  const pre = read('preload.js'), main = read('main.js'), app = read('renderer/app.js'), pkg = JSON.parse(read('package.json')), xl = read('xbin-lidar.js');
  assert.match(pre, /xbinBuildCloud: \(p, jobId, density, opts\) => inv\('bim:xbinBuildCloud', \{ path: p, jobId, density, refine: !!\(opts && opts\.refine\)(, color: [^}]+)? \}\)/);   // ревизия 36: + цвет по фото
  assert.match(main, /refine: a\.refine === true(, edge: a\.edge !== false)? \};/);
  assert.match(main, /new Worker\(unpackedWorker\('xbin-lidar-worker\.js'\), \{ workerData: \{ xbinPath: abs, posesText, outPath: target, opt \} \}\)/);
  assert.match(app, /key: 'refine', label: 'Уточнить траекторию по облаку \(точнее, дольше\)', type: 'checkbox', value: true/);
  assert.match(app, /API\.xbinBuildCloud\(p, jobId, density, \{ refine(, color)?(, edge)? \}\)/);   // ревизия 37: + фильтр краёв
  assert.match(app, /if \(v\.src === 'lidar'\) return window\.__bimXbinCloud\(p, r, ''\);/);
  assert.match(xl, /if \(o\.refine\) \{\s+const XR = require\('\.\/xbin-refine'\);/);
  assert.match(xl, /'BIM Twin xbin-lidar r25'/);
  assert.strictEqual(XL.DEF.refine, false); assert.strictEqual(XR.DEF.global, true); assert.strictEqual(XR.DEF.targetSlot, 6); assert.strictEqual(XL.DEF.imu, true); assert.strictEqual(XL.DEF.selfRadius, 0.6);
  assert.ok(pkg.build.files.includes('xbin-refine.js'), 'files'); assert.ok(pkg.build.asarUnpack.includes('xbin-refine.js'), 'asarUnpack');
  for (const f of ['renderer/app.js', 'xbin-lidar.js', 'xbin-refine.js']) assert.doesNotMatch(read(f), /[\u{1F300}-\u{1FAFF}]/u, f);
});
