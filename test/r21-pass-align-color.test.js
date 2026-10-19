'use strict';
// Ревизия 21: сведение проходов (дрейф realtime-траектории), ровный цвет проходов (экспозиция, баланс белого, яркость),
// ограничение «соли с перцем» без размывания швов и проводов; связка main → worker → refine и окно чистовой обработки.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PA = require('../pass-align-core');
const CB = require('../color-balance-core');
const R = require('../scan-refine-core');
const SC = require('./helpers/r20-scenes');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// «комната» 10×8×3 м: пол и четыре стены; проход A — t 0…100 с, проход B — t 200…300 с, сдвинут на shift (дрейф),
// темнее в gainB раз; поверхности окрашены пятнами (кирпич, бетон, синее стекло), чтобы цвет было с чем сравнивать
function room(o) {
  o = Object.assign({ n: 240000, shift: [0.03, -0.02, 0.01], gainB: 0.7, noise: 0.002, seed: 7, cast: [1, 1, 1] }, o || {});
  let seed = o.seed; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = new Float64Array(o.n * 3), T = new Float64Array(o.n), C = new Float32Array(o.n * 3), B = new Uint8Array(o.n);
  const paint = (x, y, z) => { const k = (Math.floor(x * 1.3) + Math.floor(y * 1.7) + Math.floor(z * 2.1)) % 3; return k === 0 ? [150, 70, 55] : (k === 1 ? [140, 140, 140] : [80, 120, 170]); };
  for (let i = 0; i < o.n; i++) {
    const s = rnd() * 22; let x, y, z;
    if (s < 8) { x = rnd() * 10; y = rnd() * 8; z = 0; }
    else if (s < 11) { x = 0; y = rnd() * 8; z = rnd() * 3; } else if (s < 14) { x = 10; y = rnd() * 8; z = rnd() * 3; }
    else if (s < 18) { x = rnd() * 10; y = 0; z = rnd() * 3; } else { x = rnd() * 10; y = 8; z = rnd() * 3; }
    const b = rnd() < 0.5; B[i] = b ? 1 : 0; T[i] = b ? 200 + rnd() * 100 : rnd() * 100;
    const c = paint(x, y, z), g = b ? o.gainB : 1;
    for (let a = 0; a < 3; a++) C[i * 3 + a] = Math.min(255, c[a] * g * o.cast[a] * (0.95 + 0.1 * rnd()));
    P[i * 3] = x + (b ? o.shift[0] : 0) + (rnd() - 0.5) * o.noise; P[i * 3 + 1] = y + (b ? o.shift[1] : 0) + (rnd() - 0.5) * o.noise; P[i * 3 + 2] = z + (b ? o.shift[2] : 0) + (rnd() - 0.5) * o.noise;
  }
  return { n: o.n, P, T, C, B };
}
function sampler(S, withColor) {
  const smp = new PA.Sampler(S.n, S.n, withColor);
  for (let i = 0; i < S.n; i++) smp.add(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i], S.C[i * 3], S.C[i * 3 + 1], S.C[i * 3 + 2]);
  return smp;
}

test('r21: сведение проходов убирает сдвиг позднего прохода (3–4 см), ранний проход остаётся на месте', () => {
  const S = room(), smp = sampler(S, false);
  const sol = PA.solve(smp, null, {});
  assert.ok(sol.ok, 'сведение: ' + (sol.reason || ''));
  assert.ok(sol.stats.after.medRes < sol.stats.before.medRes * 0.5, 'расхождение ' + (sol.stats.before.medRes * 1000).toFixed(1) + ' → ' + (sol.stats.after.medRes * 1000).toFixed(1) + ' мм');
  const corr = PA.makeCorrector(sol, null), out = [0, 0, 0];
  let eB = 0, eA = 0, nB = 0, nA = 0;
  for (let i = 0; i < S.n; i += 97) {
    corr(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i], out);
    const d = [out[0] - S.P[i * 3], out[1] - S.P[i * 3 + 1], out[2] - S.P[i * 3 + 2]];
    if (S.B[i]) { eB += Math.hypot(d[0] + 0.03, d[1] - 0.02, d[2] + 0.01); nB++; } else { eA += Math.hypot(d[0], d[1], d[2]); nA++; }
  }
  assert.ok(eB / nB < 0.006, 'поздний проход: остаток ' + (eB / nB * 1000).toFixed(1) + ' мм');
  assert.ok(eA / nA < 0.004, 'ранний проход сдвинут на ' + (eA / nA * 1000).toFixed(1) + ' мм');
});

test('r21: сведение отказывается, когда сводить нечего (один проход) или времени нет', () => {
  const S = room({ n: 60000 }); for (let i = 0; i < S.n; i++) S.T[i] = (S.T[i] % 100) * 0.3;   // один короткий проход
  const sol = PA.solve(sampler(S, false), null, {});
  assert.strictEqual(sol.ok, false); assert.ok(/сводить нечего|мало/.test(sol.reason), sol.reason);
  const smp = new PA.Sampler(100, 100, true); smp.add(0, 0, 0, NaN, 1, 2, 3); assert.strictEqual(smp.n, 0, 'точка без времени не попадает в выборку');
  smp.add(1, 2, 3, 5, 10, 20, 30); assert.deepStrictEqual([smp.n, smp.C[0], smp.C[1], smp.C[2]], [1, 10, 20, 30]);
});

test('r21: ровный цвет — экспозиция позднего прохода выравнивается, среднее усиление 1', () => {
  const S = room({ shift: [0, 0, 0] }), smp = sampler(S, true);
  const sol = CB.solve(smp, { neutral: false, brighten: false });
  assert.ok(sol.ok && sol.S > 1, 'решение: ' + JSON.stringify(sol.stats));
  assert.ok(sol.stats.after < sol.stats.before * 0.6, 'расхождение ' + sol.stats.before.toFixed(3) + ' → ' + sol.stats.after.toFixed(3));
  const fix = CB.makeColorFix(sol), c = [0, 0, 0]; let la = 0, lb = 0, na = 0, nb = 0;
  for (let i = 0; i < S.n; i += 13) { c[0] = S.C[i * 3]; c[1] = S.C[i * 3 + 1]; c[2] = S.C[i * 3 + 2]; fix(S.T[i], c, 0); const L = c[0] + c[1] + c[2]; if (S.B[i]) { lb += L; nb++; } else { la += L; na++; } }
  const ratio = (lb / nb) / (la / na);
  assert.ok(Math.abs(ratio - 1) < 0.05, 'яркость B/A после: ' + ratio.toFixed(3) + ' (до 0,70)');
  assert.ok(sol.stats.gainMax / sol.stats.gainMin > 1.3, 'диапазон усилений ' + sol.stats.gainMin.toFixed(2) + '…' + sol.stats.gainMax.toFixed(2));
});

test('r21: ровный цвет — без перепадов ничего не меняется; баланс белого и осветление только по делу', () => {
  // одинаковая экспозиция, нейтральный и достаточно яркий цвет → экспозиция не трогается, баланс ≈ 1, гамма 1
  const S = room({ shift: [0, 0, 0], gainB: 1 });
  for (let i = 0; i < S.n * 3; i++) S.C[i] = Math.min(255, S.C[i] * 1.15);
  const sol = CB.solve(sampler(S, true), {});
  assert.ok(sol.S === 1 || sol.stats.gainMax / sol.stats.gainMin < 1.08, 'ложные перепады: ' + JSON.stringify(sol.stats));
  assert.ok(sol.wb.every(v => Math.abs(v - 1) < 0.03), 'баланс ' + sol.wb); assert.strictEqual(sol.gamma, 1);
  // синий оттенок и тёмное облако → баланс снимает оттенок с серых поверхностей, гамма осветляет
  const D = room({ shift: [0, 0, 0], gainB: 1, cast: [0.62, 0.62, 0.72] });
  const s2 = CB.solve(sampler(D, true), {});
  assert.ok(s2.wb[2] < 0.95 && s2.wb[0] > 1, 'баланс ' + s2.wb); assert.ok(s2.gamma < 0.95 && s2.gamma >= 0.6, 'гамма ' + s2.gamma);
  const fix = CB.makeColorFix(s2), c = [0, 0, 0]; let r = 0, b = 0;
  for (let i = 0; i < D.n; i += 11) { const g = D.C[i * 3 + 1] / 0.62; if (Math.abs(g - 140) > 8) continue; c[0] = D.C[i * 3]; c[1] = D.C[i * 3 + 1]; c[2] = D.C[i * 3 + 2]; fix(0, c, 0); r += c[0] / c[1]; b += c[2] / c[1]; }
  assert.ok(b > 0, 'серые точки есть');
  // поправка — монотонная и в пределах 0…255
  const lo = [0, 0, 0], hi = [255, 255, 255], mid = [100, 100, 100]; fix(0, lo, 0); fix(0, hi, 0); fix(0, mid, 0);
  assert.ok(lo.every(v => v >= 0 && v < 1) && hi.every(v => v <= 255 && v > 235) && mid[1] > 100, lo + ' ' + mid + ' ' + hi);
});

// плотная плоская стена 1×1 м (как realtime-карта: ~6 точек на см²): серый 150 ± 4, 5 % «соли с перцем», тёмный провод 1 см, светлый шов 1 см
function denseWall(dens) {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = Math.round(dens), X = new Float64Array(n * 3), C = new Float32Array(n * 3), TC = new Float32Array(n * 3), K = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = rnd(), z = rnd(); X[i * 3] = x; X[i * 3 + 1] = (rnd() - 0.5) * 0.002; X[i * 3 + 2] = z;
    let c = [150, 150, 150], k = 0; if (Math.abs(z - 0.5) < 0.005) { c = [40, 40, 45]; k = 2; } else if (Math.abs(x - 0.3) < 0.005) { c = [210, 205, 200]; k = 3; }
    for (let a = 0; a < 3; a++) { TC[i * 3 + a] = c[a]; C[i * 3 + a] = c[a] + (rnd() - 0.5) * 8; }
    if (k === 0 && rnd() < 0.05) { const s = rnd() < 0.5 ? -90 : 90; for (let a = 0; a < 3; a++) C[i * 3 + a] = Math.max(0, Math.min(255, C[i * 3 + a] + s)); k = 1; }
    K[i] = k;
  }
  return { n, X, C, TC, K };
}
test('r21: «соль с перцем» приводится к цвету поверхности, провод и шов не размываются; в редких местах цвет не трогается', () => {
  const W = denseWall(60000), C = W.C.slice(), alive = new Uint8Array(W.n).fill(1);
  const err = (Cx, k) => { let e = 0, c = 0; for (let i = 0; i < W.n; i++) { if (W.K[i] !== k) continue; e += (Math.abs(Cx[i * 3] - W.TC[i * 3]) + Math.abs(Cx[i * 3 + 1] - W.TC[i * 3 + 1]) + Math.abs(Cx[i * 3 + 2] - W.TC[i * 3 + 2])) / 3; c++; } return e / c; };
  const n = R.clampColors(W.X, C, W.n, alive, { T: 12 });
  assert.ok(n > 0);
  assert.ok(err(C, 1) < err(W.C, 1) * 0.35, '«соль с перцем»: ' + err(W.C, 1).toFixed(1) + ' → ' + err(C, 1).toFixed(1));
  assert.ok(err(C, 2) < err(W.C, 2) + 6, 'провод: ' + err(W.C, 2).toFixed(1) + ' → ' + err(C, 2).toFixed(1));
  assert.ok(err(C, 3) < err(W.C, 3) + 6, 'шов: ' + err(W.C, 3).toFixed(1) + ' → ' + err(C, 3).toFixed(1));
  assert.ok(err(C, 0) < err(W.C, 0) + 1, 'поверхность: ' + err(W.C, 0).toFixed(1) + ' → ' + err(C, 0).toFixed(1));
  // без опоры на похожих соседей (colorSigma 0) провод размывается — защита работает
  const C0 = W.C.slice(); R.clampColors(W.X, C0, W.n, alive, { T: 12, colorSigma: 0 });
  assert.ok(err(C0, 2) > err(C, 2) + 3, 'без защиты провод: ' + err(C0, 2).toFixed(1) + ' против ' + err(C, 2).toFixed(1));
  // редкая стена (~1 точка на см²): шум и деталь не различить — почти ничего не меняется
  const Sp = denseWall(10000), Cs = Sp.C.slice(); const ns = R.clampColors(Sp.X, Cs, Sp.n, new Uint8Array(Sp.n).fill(1), { T: 12 });
  assert.ok(ns < Sp.n * 0.02, 'редкая стена: изменено ' + ns + ' из ' + Sp.n);
});

test('r21: чистовая обработка сводит проходы и выравнивает цвет в файле LAS; без времени — понятный отказ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-'));
  try {
    const S = room({ n: 400000 }), pts = new Array(S.n * 4), rgb = new Array(S.n * 3);
    for (let i = 0; i < S.n; i++) { pts[i * 4] = S.P[i * 3]; pts[i * 4 + 1] = S.P[i * 3 + 1]; pts[i * 4 + 2] = S.P[i * 3 + 2]; pts[i * 4 + 3] = S.T[i]; for (let a = 0; a < 3; a++) rgb[i * 3 + a] = Math.round(S.C[i * 3 + a]); }
    const src = path.join(dir, 'room.las'), dst = path.join(dir, 'room-clean.las'), dst2 = path.join(dir, 'room-off.las');
    SC.writeLas(src, pts, rgb);
    const st = R.refine(src, dst, { noiseLevel: 'strong', thin: false }, () => {});
    assert.ok(st.align && !st.align.skipped, 'сведение: ' + JSON.stringify(st.align));
    assert.ok(st.align.maxShift > 0.02 && st.align.maxShift < 0.1 && st.align.after < st.align.before, JSON.stringify(st.align));
    assert.ok(st.colorBalance && !st.colorBalance.skipped && st.colorBalance.segments > 1, 'цвет: ' + JSON.stringify(st.colorBalance));
    // стена x = 0: поздний проход возвращён к раннему; яркость проходов на одном месте сравнялась
    const b = fs.readFileSync(dst), off = b.readUInt32LE(96), rl = b.readUInt16LE(105), n = b.readUInt32LE(107), sc = b.readDoubleLE(131);
    let xa = 0, xb = 0, na = 0, nb = 0, La = 0, Lb = 0;
    for (let i = 0; i < n; i++) {
      const o = off + i * rl, x = b.readInt32LE(o) * sc, y = b.readInt32LE(o + 4) * sc, z = b.readInt32LE(o + 8) * sc, t = b.readDoubleLE(o + 20);
      if (x > 0.2 || z < 0.3 || y < 0.5 || y > 7.5) continue;
      const L = b.readUInt16LE(o + 28) + b.readUInt16LE(o + 30) + b.readUInt16LE(o + 32);
      if (t >= 200) { xb += x; Lb += L; nb++; } else { xa += x; La += L; na++; }
    }
    assert.ok(na > 1000 && nb > 1000);
    assert.ok(Math.abs(xb / nb - xa / na) < 0.006, 'стена x=0: проходы расходятся на ' + ((xb / nb - xa / na) * 1000).toFixed(1) + ' мм (было 30)');
    assert.ok(Math.abs((Lb / nb) / (La / na) - 1) < 0.06, 'яркость B/A: ' + ((Lb / nb) / (La / na)).toFixed(3) + ' (было 0,70)');
    // выключено пользователем → в итогах причина, координаты и цвет проходов как были
    const st2 = R.refine(src, dst2, { noiseLevel: 'strong', thin: false, align: false, colorBalance: false }, () => {});
    assert.strictEqual(st2.align.skipped, 'выключено'); assert.strictEqual(st2.colorBalance.skipped, 'выключено');
    // формат без времени точек — сведение пропускается с понятной причиной, обработка проходит
    const P2 = [], C2 = []; for (let i = 0; i < 30000; i++) { P2.push(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2]); C2.push(120, 120, 120); }
    const src3 = path.join(dir, 'notime.las'), dst3 = path.join(dir, 'notime-clean.las');
    writeLas2(src3, P2, C2);
    const st3 = R.refine(src3, dst3, { noiseLevel: 'normal' }, () => {});
    assert.strictEqual(st3.align.skipped, 'в файле нет времени точек'); assert.ok(st3.written > 25000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function writeLas2(file, P, C) {   // LAS 1.2 формат 2 — без времени
  const n = P.length / 3, H = Buffer.alloc(227), sc = 0.001;
  H.write('LASF', 0, 'latin1'); H[24] = 1; H[25] = 2; H.writeUInt16LE(227, 94); H.writeUInt32LE(227, 96); H[104] = 2; H.writeUInt16LE(26, 105); H.writeUInt32LE(n, 107);
  H.writeDoubleLE(sc, 131); H.writeDoubleLE(sc, 139); H.writeDoubleLE(sc, 147);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = P[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  H.writeDoubleLE(mx[0], 179); H.writeDoubleLE(mn[0], 187); H.writeDoubleLE(mx[1], 195); H.writeDoubleLE(mn[1], 203); H.writeDoubleLE(mx[2], 211); H.writeDoubleLE(mn[2], 219);
  const B = Buffer.alloc(n * 26);
  for (let i = 0; i < n; i++) { const o = i * 26; for (let a = 0; a < 3; a++) B.writeInt32LE(Math.round(P[i * 3 + a] / sc), o + a * 4); for (let a = 0; a < 3; a++) B.writeUInt16LE(C[i * 3 + a], o + 20 + a * 2); }
  fs.writeFileSync(file, Buffer.concat([H, B]));
}

test('r21: сведение и ровный цвет подключены: сборка, main → worker (траектория), окно обработки', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['pass-align-core.js', 'color-balance-core.js']) { assert.ok(pkg.build.files.includes(f), 'files: ' + f); assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack: ' + f); }
  const core = read('scan-refine-core.js');
  assert.ok(/require\('\.\/pass-align-core'\)/.test(core) && /require\('\.\/color-balance-core'\)/.test(core));
  const worker = read('scan-refine-worker.js'); assert.ok(/o\.posesText = posesText/.test(worker), 'траектория передаётся в refine');
  const main = read('main.js');
  assert.ok(/a\.dynamic \|\| a\.align !== false/.test(main), 'траектория загружается и для сведения');
  assert.ok(/align: a\.align !== false, colorBalance: a\.colorBalance !== false/.test(main));
  const ui = read('renderer/lixel-tools-ext.js');
  assert.ok(/key: 'align', label: 'Свести проходы/.test(ui) && /key: 'colorBalance'/.test(ui));
  assert.ok(/align: values\.align !== false, colorBalance:/.test(ui));
  assert.ok(/Траектория сканера рядом с файлом не найдена/.test(ui), 'подсказка без траектории');
  assert.ok(/проходы сведены/.test(ui) && /яркость проходов/.test(ui), 'итоги в сообщении');
});
