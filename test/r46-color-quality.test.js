'use strict';
// Ревизия 46: качество цвета чистовой обработки по сравнению с Lixel Studio — точки без цвета (0,0,0) не тянут
// выравнивание проходов и получают цвет соседей; тоновая кривая вместо гаммы (тени не «молочные»); местное
// выравнивание проходов («рябь» на стенах) без размывания швов; связка с плитками и пулом потоков.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PA = require('../pass-align-core');
const CB = require('../color-balance-core');
const R = require('../scan-refine-core');
const RP = require('../scan-refine-parallel');
const SC = require('./helpers/r20-scenes');

function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
// комната 10×8×3 м, два прохода: B — позже и темнее (gainB); у части точек нет цвета (0,0,0), чаще в проходе B
function room(o) {
  o = Object.assign({ n: 200000, gainB: 0.7, black: 0, blackB: 0, seed: 11 }, o || {});
  const rnd = rng(o.seed), P = new Float64Array(o.n * 3), T = new Float64Array(o.n), C = new Float32Array(o.n * 3), B = new Uint8Array(o.n);
  const paint = (x, y, z) => { const k = (Math.floor(x * 1.3) + Math.floor(y * 1.7) + Math.floor(z * 2.1)) % 3; return k === 0 ? [150, 70, 55] : (k === 1 ? [140, 140, 140] : [80, 120, 170]); };
  for (let i = 0; i < o.n; i++) {
    const s = rnd() * 22; let x, y, z;
    if (s < 8) { x = rnd() * 10; y = rnd() * 8; z = 0; } else if (s < 11) { x = 0; y = rnd() * 8; z = rnd() * 3; } else if (s < 14) { x = 10; y = rnd() * 8; z = rnd() * 3; }
    else if (s < 18) { x = rnd() * 10; y = 0; z = rnd() * 3; } else { x = rnd() * 10; y = 8; z = rnd() * 3; }
    const b = rnd() < 0.5; B[i] = b ? 1 : 0; T[i] = b ? 200 + rnd() * 100 : rnd() * 100;
    const c = paint(x, y, z), g = b ? o.gainB : 1, blk = rnd() < (b ? o.blackB : o.black);
    for (let a = 0; a < 3; a++) C[i * 3 + a] = blk ? 0 : Math.min(255, c[a] * g * (0.95 + 0.1 * rnd()));
    P[i * 3] = x + (rnd() - 0.5) * 0.002; P[i * 3 + 1] = y + (rnd() - 0.5) * 0.002; P[i * 3 + 2] = z + (rnd() - 0.5) * 0.002;
  }
  return { n: o.n, P, T, C, B };
}
function sampler(S) { const smp = new PA.Sampler(S.n, S.n, true); for (let i = 0; i < S.n; i++) smp.add(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i], S.C[i * 3], S.C[i * 3 + 1], S.C[i * 3 + 2]); return smp; }
const ratioBA = (S, fix) => { const c = [0, 0, 0]; let la = 0, lb = 0, na = 0, nb = 0; for (let i = 0; i < S.n; i += 7) { if (!S.C[i * 3] && !S.C[i * 3 + 1] && !S.C[i * 3 + 2]) continue; c[0] = S.C[i * 3]; c[1] = S.C[i * 3 + 1]; c[2] = S.C[i * 3 + 2]; fix(S.T[i], c, 0); const L = c[0] + c[1] + c[2]; if (S.B[i]) { lb += L; nb++; } else { la += L; na++; } } return (lb / nb) / (la / na); };

test('r46: точки без цвета не тянут выравнивание проходов — поздний проход выравнивается так же, как без них', () => {
  const clean = CB.solve(sampler(room()), { neutral: false, brighten: false });
  const S = room({ black: 0.01, blackB: 0.12 }), dirty = CB.solve(sampler(S), { neutral: false, brighten: false });
  assert.ok(clean.ok && dirty.ok, JSON.stringify(dirty.stats));
  const r = ratioBA(S, CB.makeColorFix(dirty));
  assert.ok(Math.abs(r - 1) < 0.05, 'яркость B/A после: ' + r.toFixed(3));
  assert.ok(Math.abs(dirty.stats.gainMax / dirty.stats.gainMin - clean.stats.gainMax / clean.stats.gainMin) < 0.06, 'усиления ' + dirty.stats.gainMax / dirty.stats.gainMin + ' и ' + clean.stats.gainMax / clean.stats.gainMin);
});

test('r46: тоновая кривая — тени не трогаются, середина ярче, светлые не пережжены, кривая монотонная', () => {
  const L = CB.toneLUT({ gain: 1.36, dark: 25, knee: 170 }), at = (v) => L[Math.round(v * 16)];
  assert.ok(at(0) === 0 && at(255) > 245 && at(256) <= 255, at(0) + ' ' + at(255));
  for (let k = 1; k < L.length; k++) assert.ok(L[k] >= L[k - 1], 'немонотонно в ' + k);
  assert.ok(Math.abs(at(12) - 12) < 1.5, 'тени: 12 → ' + at(12));
  // сверено с Lixel Studio (фасад, ячейки 10 см): 41→46, 64→79, 92→118, 128→164, 158→186
  // плечо 170 (было 150 — светлые у нас были темнее Lixel: 158 → 181 против 186, во дворе 176 против 197)
  for (const [v, ref] of [[128, 164], [158, 186]]) assert.ok(Math.abs(at(v) - ref) <= 0.02 * ref, 'плечо: ' + v + ' → ' + at(v).toFixed(1));
  for (const [v, ref] of [[41, 46], [64, 79], [92, 118], [128, 164], [158, 186]]) assert.ok(Math.abs(at(v) - ref) <= 0.06 * ref, v + ' → ' + at(v).toFixed(1) + ', у Lixel ' + ref);
  // тёмное облако: кривая вместо гаммы; яркое — без осветления; по желанию — прежняя гамма
  const D = room({ gainB: 1 }); for (let i = 0; i < D.n * 3; i++) D.C[i] *= 0.6;
  const s1 = CB.solve(sampler(D), {});
  assert.ok(s1.tone && s1.tone.gain > 1.2 && s1.tone.gain <= 1.4 && s1.gamma === 1, JSON.stringify(s1.stats));
  const fix = CB.makeColorFix(s1), lo = [10, 10, 10], mid = [80, 80, 80], hi = [255, 255, 255]; fix(0, lo, 0); fix(0, mid, 0); fix(0, hi, 0);
  assert.ok(lo[1] < 13 && mid[1] > 88 && hi[1] > 235, lo + ' ' + mid + ' ' + hi);
  const s2 = CB.solve(sampler(D), { tone: 'gamma' }); assert.ok(s2.gamma < 0.95 && !s2.tone, JSON.stringify(s2.stats));
  const Br = room({ gainB: 1 }); for (let i = 0; i < Br.n * 3; i++) Br.C[i] = Math.min(255, Br.C[i] * 1.15);
  const s3 = CB.solve(sampler(Br), {}); assert.ok(!s3.tone && s3.gamma === 1, JSON.stringify(s3.stats));
});

// стена 1×1 м (x — вдоль, z — вверх, y≈0), серый 150 с тёмными швами 1 см через 25 см; проход A — 0…10 с, B — 100…110 с
function wall(o) {
  o = Object.assign({ n: 160000, gainB: 0.65, black: 0, seed: 5 }, o || {});
  const rnd = rng(o.seed), X = new Float64Array(o.n * 3), RGB = new Float32Array(o.n * 3), T = new Float64Array(o.n), B = new Uint8Array(o.n), nc = new Uint8Array(o.n), seam = new Uint8Array(o.n);
  for (let i = 0; i < o.n; i++) {
    const x = rnd(), z = rnd(), b = rnd() < 0.5; B[i] = b ? 1 : 0; T[i] = b ? 100 + rnd() * 10 : rnd() * 10;
    X[i * 3] = x - 0.5; X[i * 3 + 1] = (rnd() - 0.5) * 0.002; X[i * 3 + 2] = z - 0.5;
    const s = (x % 0.25) < 0.01; seam[i] = s ? 1 : 0; const base = s ? 60 : 150, g = (b ? o.gainB : 1) * (0.94 + 0.12 * rnd());
    if (rnd() < o.black) { nc[i] = 1; continue; }
    RGB[i * 3] = base * g; RGB[i * 3 + 1] = base * g; RGB[i * 3 + 2] = base * g * 1.02;
  }
  return { n: o.n, X, RGB, T, B, nc, seam };
}
const med = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : NaN; };

test('r46: местное выравнивание проходов — рябь уходит, швы и текстура остаются, одиночный проход не трогается', () => {
  const W = wall(), alive = new Uint8Array(W.n).fill(1);
  const before = med(Array.from({ length: W.n }, (_, i) => i).filter(i => W.B[i] && !W.seam[i]).map(i => W.RGB[i * 3 + 1])) / med(Array.from({ length: W.n }, (_, i) => i).filter(i => !W.B[i] && !W.seam[i]).map(i => W.RGB[i * 3 + 1]));
  const st = R.passEqualize(W.X, W.RGB, W.T, W.n, alive, {});
  const g = (f) => med(Array.from({ length: W.n }, (_, i) => i).filter(f).map(i => W.RGB[i * 3 + 1]));
  const bA = g(i => !W.B[i] && !W.seam[i]), bB = g(i => W.B[i] && !W.seam[i]), sA = g(i => !W.B[i] && W.seam[i]), sB = g(i => W.B[i] && W.seam[i]);
  assert.ok(before < 0.7, 'до: ' + before);
  assert.ok(Math.abs(bB / bA - 1) < 0.06, 'проходы B/A после: ' + (bB / bA).toFixed(3) + ' (до ' + before.toFixed(2) + ') ' + JSON.stringify(st));
  assert.ok(sA / bA < 0.5 && sB / bB < 0.5, 'швы остались тёмными: ' + (sA / bA).toFixed(2) + ' ' + (sB / bB).toFixed(2));
  // общий уровень — между проходами (не «уезжает» в одну сторону)
  assert.ok(bA > 150 * 0.65 * 0.98 && bA < 150 * 1.02, 'уровень A ' + bA);
  // зерно внутри прохода сохраняется (выравнивается уровень, а не каждая точка)
  const sd = (f) => { const v = Array.from({ length: W.n }, (_, i) => i).filter(f).map(i => W.RGB[i * 3 + 1]); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) / m; };
  assert.ok(sd(i => !W.B[i] && !W.seam[i]) > 0.025, 'зерно A ' + sd(i => !W.B[i] && !W.seam[i]));
  // один короткий проход: цвет не меняется
  const S1 = wall({ seed: 9 }); for (let i = 0; i < S1.n; i++) S1.T[i] = S1.T[i] % 2.5; const c0 = Float32Array.from(S1.RGB);
  R.passEqualize(S1.X, S1.RGB, S1.T, S1.n, new Uint8Array(S1.n).fill(1), {});
  let mx = 0; for (let i = 0; i < c0.length; i++) mx = Math.max(mx, Math.abs(c0[i] - S1.RGB[i])); assert.ok(mx < 1e-6, 'один проход изменён на ' + mx);
  // два прохода одной яркости: правки — в пределах шума (99 % точек меньше чем на 6 %)
  const S2 = wall({ seed: 13, gainB: 1 }), c2 = Float32Array.from(S2.RGB); R.passEqualize(S2.X, S2.RGB, S2.T, S2.n, new Uint8Array(S2.n).fill(1), {});
  const rel = []; for (let i = 0; i < S2.n; i++) rel.push(Math.abs(S2.RGB[i * 3 + 1] / c2[i * 3 + 1] - 1)); rel.sort((a, b) => a - b);
  assert.ok(rel[Math.floor(rel.length * 0.99)] < 0.06, 'правки при равной яркости: ' + rel[Math.floor(rel.length * 0.99)].toFixed(3));
});

test('r46: точки без цвета получают цвет соседей (соседи без цвета затемняют, не темнее 10); не участвуют в выравнивании; одиночные — остаются', () => {
  const W = wall({ black: 0.03, gainB: 1 }), alive = new Uint8Array(W.n).fill(1), nc = Uint8Array.from(W.nc);
  const nb = nc.reduce((a, b) => a + b, 0); assert.ok(nb > 3000, 'без цвета: ' + nb);
  const f = R.fillNoColor(W.X, W.RGB, W.n, alive, nc); assert.strictEqual(f, nb);
  let bad = 0; for (let i = 0; i < W.n; i++) if (W.nc[i] && !W.seam[i] && !((i % 4) && 0)) { const v = W.RGB[i * 3 + 1]; if (v < 70) bad++; }
  assert.ok(bad < 0.08 * nb, 'тёмных после заливки: ' + bad + ' из ' + nb);
  // далёкая точка без цветных соседей в 30 см остаётся без цвета
  const n = 5, X = new Float64Array([0, 0, 0, 0.01, 0, 0, 0.02, 0, 0, 5, 5, 5, 0.015, 0.01, 0]), C = new Float32Array([100, 100, 100, 110, 110, 110, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // две цветные (100 и 110) и две без цвета рядом: тёмное место → (100 + 110) / 4; простое среднее цветных — по zeroAsDark:false
  const m = new Uint8Array([0, 0, 1, 1, 1]); R.fillNoColor(X, C, n, new Uint8Array(n).fill(1), m);
  assert.deepStrictEqual(Array.from(m), [0, 0, 0, 1, 0]); assert.ok(Math.abs(C[6] - 52.5) < 1e-6 && Math.abs(C[12] - 52.5) < 1e-6 && C[9] === 0, Array.from(C).join(','));
  const C1 = new Float32Array([100, 100, 100, 110, 110, 110, 0, 0, 0, 0, 0, 0, 0, 0, 0]), m1 = new Uint8Array([0, 0, 1, 1, 1]);
  R.fillNoColor(X, C1, n, new Uint8Array(n).fill(1), m1, { zeroAsDark: false }); assert.ok(Math.abs(C1[6] - 105) < 1e-6, Array.from(C1).join(','));
  // почти чёрное место (одна цветная (4,6,9) среди трёх без цвета → (1; 1,5; 2,25)): не темнее 10 — сдвиг, разница каналов остаётся
  const C2 = new Float32Array([4, 6, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0]), X2 = new Float64Array([0, 0, 0, 0.01, 0, 0, 0.02, 0, 0, 0.015, 0.01, 0]), m2 = new Uint8Array([0, 1, 1, 1]);
  R.fillNoColor(X2, C2, 4, new Uint8Array(4).fill(1), m2);
  const L2 = 0.3 * C2[3] + 0.59 * C2[4] + 0.11 * C2[5]; assert.ok(Math.abs(L2 - 10) < 1e-4 && Math.abs(C2[5] - C2[3] - 1.25) < 1e-4, Array.from(C2).join(','));
  // выравнивание с skip: точки без цвета не правятся (остаются 0) и не сдвигают опору
  const W2 = wall({ black: 0.05 }), a2 = new Uint8Array(W2.n).fill(1); R.passEqualize(W2.X, W2.RGB, W2.T, W2.n, a2, { skip: W2.nc });
  let nz = 0; for (let i = 0; i < W2.n; i++) if (W2.nc[i] && (W2.RGB[i * 3] || W2.RGB[i * 3 + 1] || W2.RGB[i * 3 + 2])) nz++; assert.strictEqual(nz, 0);
});

// LAS комнаты с двумя проходами и точками без цвета → чистовая обработка
function roomLas(file, n, o) {
  const S = room(Object.assign({ n }, o || {})), pts = new Array(n * 4), rgb = new Array(n * 3);
  for (let i = 0; i < n; i++) { pts[i * 4] = S.P[i * 3]; pts[i * 4 + 1] = S.P[i * 3 + 1]; pts[i * 4 + 2] = S.P[i * 3 + 2]; pts[i * 4 + 3] = S.T[i]; for (let a = 0; a < 3; a++) rgb[i * 3 + a] = Math.round(S.C[i * 3 + a]); }
  SC.writeLas(file, pts, rgb); return S;
}
function readLasRgb(file) {
  const b = fs.readFileSync(file), off = b.readUInt32LE(96), rl = b.readUInt16LE(105), fmt = b[104], n = (b.length - off) / rl, ro = { 2: 20, 3: 28 }[fmt];
  const out = new Uint16Array(n * 3); for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = b.readUInt16LE(off + i * rl + ro + a * 2); return { n, rgb: out };
}

test('r46: чистовая обработка — без чёрных точек, итоги «без цвета», один поток и пул дают один и тот же LAS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r46-'));
  try {
    const src = path.join(dir, 'room.las'); roomLas(src, 160000, { black: 0.01, blackB: 0.03 });
    const a = path.join(dir, 'a.las'), b = path.join(dir, 'b.las'), c = path.join(dir, 'c.las');
    const o = { tmpDir: dir, noiseLevel: 'strong', tileMax: 30000 };
    const sa = R.refine(src, a, o), sb = await RP.refineParallel(src, b, Object.assign({ threads: 2 }, o));
    assert.ok(Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0, 'LAS одного потока и пула различаются');
    assert.ok(sa.noColor.found > 2000 && sa.noColor.left === 0, JSON.stringify(sa.noColor)); assert.deepStrictEqual(sb.noColor, sa.noColor);
    const A = readLasRgb(a); let blk = 0; for (let i = 0; i < A.n; i++) if (!A.rgb[i * 3] && !A.rgb[i * 3 + 1] && !A.rgb[i * 3 + 2]) blk++;
    assert.strictEqual(blk, 0, 'чёрных точек: ' + blk);
    // выключено — точки без цвета остаются как есть
    const sc = R.refine(src, c, Object.assign({}, o, { fillNoColor: false, passEq: false }));
    const C = readLasRgb(c); let blk2 = 0; for (let i = 0; i < C.n; i++) if (!C.rgb[i * 3] && !C.rgb[i * 3 + 1] && !C.rgb[i * 3 + 2]) blk2++;
    assert.ok(blk2 > 1000 && blk2 <= sc.noColor.left && sc.noColor.left > 0.8 * sc.noColor.found, blk2 + ' ' + JSON.stringify(sc.noColor));
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.refine-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r46: новые параметры передаются потокам пула; модуль цвета экспортирует кривую', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scan-refine-parallel.js'), 'utf8');
  for (const k of ['colorBalance', 'passEq', 'passEqOpt', 'fillNoColor']) assert.ok(src.includes("'" + k + "'"), k);
  assert.strictEqual(typeof CB.toneLUT, 'function'); assert.strictEqual(typeof R.passEqualize, 'function'); assert.strictEqual(typeof R.fillNoColor, 'function');
});
