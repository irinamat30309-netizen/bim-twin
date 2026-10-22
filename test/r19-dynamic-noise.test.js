'use strict';
// Ревизия 19: движущиеся объекты без траектории («следы» во времени точек), объединение наборов вокселей,
// усиленная очистка шума (уровни), чистовая обработка с заменой открытого файла, «Папка сканера».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../dynamic-clean-core');
const DV = require('../renderer/dynamic-voxels');
const R = require('../scan-refine-core');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// синтетика: сканер идёт вдоль x, стены, пол, неподвижные ящик и столб, прохожий и машина движутся, ящик виден < 1 с
function writeLas(file, pts) {
  const n = pts.length / 4, H = Buffer.alloc(227), sc = 0.001;
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const q = pts[i * 4 + a]; if (q < mn[a]) mn[a] = q; if (q > mx[a]) mx[a] = q; }
  H.write('LASF', 0, 'latin1'); H[24] = 1; H[25] = 2; H.writeUInt16LE(227, 94); H.writeUInt32LE(227, 96); H[104] = 1; H.writeUInt16LE(28, 105); H.writeUInt32LE(n, 107);
  H.writeDoubleLE(sc, 131); H.writeDoubleLE(sc, 139); H.writeDoubleLE(sc, 147);
  H.writeDoubleLE(mx[0], 179); H.writeDoubleLE(mn[0], 187); H.writeDoubleLE(mx[1], 195); H.writeDoubleLE(mn[1], 203); H.writeDoubleLE(mx[2], 211); H.writeDoubleLE(mn[2], 219);
  const B = Buffer.alloc(n * 28);
  for (let i = 0; i < n; i++) { const o = i * 28; B.writeInt32LE(Math.round(pts[i * 4] / sc), o); B.writeInt32LE(Math.round(pts[i * 4 + 1] / sc), o + 4); B.writeInt32LE(Math.round(pts[i * 4 + 2] / sc), o + 8); B.writeDoubleLE(pts[i * 4 + 3], o + 20); }
  fs.writeFileSync(file, Buffer.concat([H, B]));
}
function boxHit(o, d, mn, mx, tmax) {
  let t0 = 1e-6, t1 = tmax;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < mn[a] || o[a] > mx[a]) return Infinity; continue; }
    let u = (mn[a] - o[a]) / d[a], w = (mx[a] - o[a]) / d[a]; if (u > w) { const q = u; u = w; w = q; }
    if (u > t0) t0 = u; if (w < t1) t1 = w; if (t0 > t1) return Infinity;
  }
  return t0;
}
function scene(opts) {
  opts = opts || {};
  const poses = [], pts = [], lab = []; let seed = opts.seed || 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const STATIC = [{ mn: [7, 3, 0], mx: [8, 4, 1.2] }, { mn: [3, 3.8, 0], mx: [3.2, 4.0, 2.8] }];   // ящик, столб
  const BRIEF = { mn: [12, -3.5, 0], mx: [12.6, -3.0, 1.0], t0: 1050, t1: 1050.8 };               // виден < 1 с (за препятствием)
  const nRev = opts.revs || 500, perRev = opts.perRev || 1600;
  for (let k = 0; k <= nRev; k++) {
    const t = 1000 + k * 0.2, sx = k * 0.03, sy = 0, sz = 1.5; poses.push([t, sx, sy, sz].join(','));
    for (let r = 0; r < perRev; r++) {
      const tt = t + r * 0.2 / perRev, az = rnd() * 2 * Math.PI, el = (rnd() - 0.6) * 1.2;
      const d = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)], o = [sx, sy, sz];
      let best = Infinity, who = 0;
      if (d[1] > 1e-6) { const s = (5 - sy) / d[1]; const z = sz + d[2] * s; if (z >= 0 && z <= 3) best = s; }
      if (d[1] < -1e-6) { const s = (-5 - sy) / d[1]; const z = sz + d[2] * s; if (z >= 0 && z <= 3 && s < best) best = s; }
      if (d[2] < -1e-6) { const s = -sz / d[2]; if (s < best) best = s; }
      for (const B of STATIC) { const s = boxHit(o, d, B.mn, B.mx, best); if (s < best) best = s; }
      // прохожий: идёт по y = 2 от x = 14 к x = 2 со скоростью 1,2 м/с с 1020 по 1030 с
      if (tt >= 1020 && tt <= 1030) { const px = 14 - 1.2 * (tt - 1020); const s = boxHit(o, d, [px - 0.25, 1.75, 0], [px + 0.25, 2.25, 1.8], best); if (s < best) { best = s; who = 1; } }
      // машина: едет по y = -3 от x = 0 к x = 20 со скоростью 5 м/с с 1060 по 1064 с
      if (tt >= 1060 && tt <= 1064) { const px = 5 * (tt - 1060); const s = boxHit(o, d, [px - 2, -4, 0], [px + 2, -2.2, 1.5], best); if (s < best) { best = s; who = 1; } }
      if (tt >= BRIEF.t0 && tt <= BRIEF.t1) { const s = boxHit(o, d, BRIEF.mn, BRIEF.mx, best); if (s < best) { best = s; who = 2; } }
      if (best < 30) { pts.push(sx + d[0] * best, sy + d[1] * best, sz + d[2] * best, tt); lab.push(who); }
    }
  }
  return { poses: poses.join('\n'), pts, lab };
}

function score(S, has) {
  let tp = 0, fp = 0, fn = 0, st = 0; const n = S.lab.length;
  for (let i = 0; i < n; i++) { const h = has(S.pts[i * 4], S.pts[i * 4 + 1], S.pts[i * 4 + 2]); if (S.lab[i] === 1) { if (h) tp++; else fn++; } else { st++; if (h) fp++; } }
  return { recall: tp / Math.max(1, tp + fn), precision: tp / Math.max(1, tp + fp), fpShare: fp / Math.max(1, st) };
}

test('r19: движущиеся объекты находятся без траектории — по «следам» во времени точек', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r19t-')), las = path.join(dir, 's.las');
  try {
    const S = scene({ perRev: 2500 }); writeLas(las, S.pts);
    const r = D.detect(las, null, {});
    assert.strictEqual(r.mode, 'trail');
    assert.strictEqual(r.sets.length, 1);
    const M = DV.buildMany(r.sets), q = score(S, (x, y, z) => M.has(x, y, z));
    assert.ok(q.recall > 0.5, 'полнота ' + q.recall.toFixed(3));
    assert.ok(q.precision > 0.95, 'точность ' + q.precision.toFixed(3));
    assert.ok(q.fpShare < 0.002, 'задето неподвижного ' + (q.fpShare * 100).toFixed(3) + ' %');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r19: с траекторией — лучи и следы вместе, точка движущаяся, если попала в любой набор', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r19r-')), las = path.join(dir, 's.las');
  try {
    const S = scene({ perRev: 2500 }); writeLas(las, S.pts);
    const r = D.detect(las, S.poses, { radius: 20 });
    assert.strictEqual(r.mode, 'rays+trail');
    assert.deepStrictEqual(r.sets.map(s => s.kind).sort(), ['rays', 'trail']);
    const M = DV.buildMany(r.sets), q = score(S, (x, y, z) => M.has(x, y, z));
    const T = DV.build(r.sets.find(s => s.kind === 'trail').keys, r.sets.find(s => s.kind === 'trail').grid), qt = score(S, (x, y, z) => T.has(x, y, z));
    assert.ok(q.recall >= qt.recall, 'объединение не хуже одного набора');
    assert.ok(q.precision > 0.95, 'точность ' + q.precision.toFixed(3));
    assert.strictEqual(M.count, r.sets.reduce((a, s) => a + s.keys.length, 0));
    const off = D.detect(las, S.poses, { radius: 20, trail: false });
    assert.strictEqual(off.mode, 'rays');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r19: buildMany — пустые наборы и один набор', () => {
  const E = DV.buildMany([]); assert.strictEqual(E.count, 0); assert.strictEqual(E.has(0, 0, 0), false);
  const g = { gx: 0, gy: 0, gz: 0, v: 1, nx: 4, ny: 4, nz: 4 };
  const one = DV.buildMany([{ keys: Float64Array.from([0]), grid: g }, { keys: new Float64Array(0), grid: g }]);
  assert.strictEqual(one.has(0.5, 0.5, 0.5), true); assert.strictEqual(one.has(1.5, 0.5, 0.5), false);
});

// стена и пол плотные (как realtime-карта), кабель у стены, труба, «туман» и облачка шума
function noisyScene() {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
  const P = [], tag = []; const add = (x, y, z, t) => { P.push(x, y, z); tag.push(t); };
  for (let i = 0; i < 3 * 2 * 6000; i++) add(rnd() * 3, g() * 0.004, rnd() * 2, 0);
  for (let i = 0; i < 9 * 6000; i++) add(rnd() * 3, rnd() * 3, g() * 0.004, 0);
  for (let i = 0; i < 500; i++) { const a = rnd() * Math.PI; add(0.5 + rnd() * 2.5, 0.1 + 0.01 * Math.cos(a), 1.5 + 0.01 * Math.sin(a), 1); }
  for (let i = 0; i < 5000; i++) { const a = rnd() * Math.PI * 2; add(1.5 + 0.05 * Math.cos(a), 0.6 + 0.05 * Math.sin(a), rnd() * 2, 1); }
  for (let i = 0; i < 2000; i++) add(rnd() * 3, 0.02 + rnd() * 0.38, rnd() * 2, 9);
  for (let i = 0; i < 1500; i++) add(rnd() * 3, rnd() * 3, 0.02 + rnd() * 0.3, 9);
  for (let b = 0; b < 30; b++) { const cx = rnd() * 3, cy = 0.8 + rnd() * 2, cz = 0.5 + rnd() * 1.5, k = 3 + Math.floor(rnd() * 12); for (let i = 0; i < k; i++) add(cx + g() * 0.02, cy + g() * 0.02, cz + g() * 0.02, 9); }
  return { X: Float64Array.from(P), tag };
}
function loss(S, alive) { const tot = {}, rem = {}; S.tag.forEach((t, i) => { tot[t] = (tot[t] || 0) + 1; if (!alive[i]) rem[t] = (rem[t] || 0) + 1; }); const o = {}; for (const t in tot) o[t] = (rem[t] || 0) / tot[t]; return o; }

test('r19: шум — «туман» и облачка убираются, стены, пол, кабель и труба остаются', () => {
  const S = noisyScene(), n = S.tag.length, res = {};
  for (const lvl of ['soft', 'normal', 'strong']) { const a = new Uint8Array(n).fill(1); R.denoise(S.X.slice(), n, a, lvl); res[lvl] = loss(S, a); }
  const old = new Uint8Array(n).fill(1); R.isolated(S.X.slice(), n, old, { cell: 0.1, maxNb: 2 }); const o = loss(S, old);
  assert.ok(res.normal[9] > 0.6, 'обычно: убрано шума ' + (res.normal[9] * 100).toFixed(1) + ' %');
  assert.ok(res.normal[9] > o[9] + 0.4, 'заметно сильнее прежнего фильтра');
  assert.ok(res.soft[9] <= res.normal[9] && res.normal[9] <= res.strong[9], 'уровни упорядочены');
  for (const lvl of ['soft', 'normal', 'strong']) {
    // ревизия 20: «обычно» и «сильно» снимают и хвосты разброса (точки дальше 3σ от стены) — до 0,3 %
    assert.ok(res[lvl][0] < (lvl === 'soft' ? 0.001 : 0.003), lvl + ': задеты поверхности ' + (res[lvl][0] * 100).toFixed(2) + ' %');
    assert.ok(res[lvl][1] < 0.01, lvl + ': задеты кабель/труба ' + (res[lvl][1] * 100).toFixed(2) + ' %');
  }
});

test('r19: чистовая обработка передаёт уровень шума и пишет LAS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r19n-'));
  try {
    const S = noisyScene(), n = S.tag.length, pts = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) { pts[i * 4] = S.X[i * 3] + 100; pts[i * 4 + 1] = S.X[i * 3 + 1] + 200; pts[i * 4 + 2] = S.X[i * 3 + 2] + 10; pts[i * 4 + 3] = i * 1e-4; }
    const src = path.join(dir, 'in.las'); writeLas(src, pts);
    const st = {};
    for (const lvl of ['soft', 'strong']) st[lvl] = R.refine(src, path.join(dir, lvl + '.las'), { noiseLevel: lvl, thin: false, color: false, tmpDir: dir });
    assert.ok(st.strong.noise > st.soft.noise && st.soft.noise > 500, JSON.stringify([st.soft.noise, st.strong.noise]));
    const H = R.readHeader(fs.openSync(path.join(dir, 'strong.las'), 'r'));
    assert.strictEqual(H.n, st.strong.written);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r19: траектория необязательна, чистовая обработка заменяет открытый файл с копией исходника', () => {
  const m = read('main.js');
  const dyn = m.slice(m.indexOf("ipcMain.handle('bim:dynamicClean'"), m.indexOf("ipcMain.on('bim:cancelDynamicClean'"));
  assert.ok(!/no_trajectory/.test(dyn), 'без траектории — не ошибка');
  assert.match(dyn, /a\.posesPath === 'none'/);
  const ref = m.slice(m.indexOf("ipcMain.handle('bim:refineScan'"), m.indexOf("ipcMain.on('bim:cancelRefineScan'"));
  assert.ok(!/no_trajectory/.test(ref));
  assert.match(ref, /dynamic: !!a\.dynamic/);
  assert.match(ref, /noiseLevel: NOISE_LEVELS\.includes\(a\.noiseLevel\)/);
  assert.match(ref, /'-original'/);
  assert.match(ref, /fs\.renameSync\(bak, target\)/, 'при ошибке исходник возвращается на место');
  assert.match(m, /function dynOptsFrom[\s\S]*?tn\('spanMax', 0\.2, 10\)/);
  const w = read('scan-refine-worker.js'); assert.match(w, /opt && opt\.dynamic/); assert.match(w, /o\.dynamic = \{ sets: v\.sets \}/);
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /Без траектории — по времени точек/);
  assert.match(ui, /DV\.buildMany/);
  assert.match(ui, /inPlace: inPlace, keepBackup: keepBackup/);
  assert.match(ui, /__bimOpenCloudPath\(res\.path, \{ fresh: true \}\)/);
  assert.match(ui, /V\.canUndo\(\)/, 'предупреждение о несохранённых правках');
  assert.match(read('renderer/app.js'), /window\.__bimDropCloudCache = function/);
});

test('r19: «Папка сканера» — команда, preload и обработчик главного процесса', () => {
  const C = require('../renderer/ui/commands.js'); const it = C.all().map(x => x.item).find(x => x.id === 'opScanFolder');
  assert.ok(it && it.call === '__lxToolsExt.ops.opScanFolder');
  assert.match(read('preload.js'), /pickScanFolder: \(\) => inv\('bim:pickScanFolder'\)/);
  const m = read('main.js');
  assert.match(m, /ipcMain\.handle\('bim:pickScanFolder'/);
  assert.match(m, /scanFolderPoses\.get\(/, 'траектория из папки запоминается для движущихся объектов');
  assert.match(read('renderer/app.js'), /window\.__bimOpenScanFolder = async function/);
});
