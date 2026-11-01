'use strict';
// Ревизия 49: сверка с полным эталоном Lixel Studio (рамка фасада с двором 68×33 м, 120 млн точек; 363 тыс. пар ячеек 5 см).
// Кривая r48 (×1,36, подъём чёрного +2,5, плечо с 185) давала светлые тона ярче Lixel; r49 — ×1,32, +6, плечо с 165.
// Насыщенность: цвет карты сканера 0,75, облако после «Цвета по фото» (opt.photoColor) — 0,71.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PA = require('../pass-align-core');
const CB = require('../color-balance-core');
const SC = require('./helpers/r20-scenes');

function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function scene(n, k, seed) {   // пол и две стены, серые/кирпичные/голубые пятна, яркость × k
  const rnd = rng(seed || 11), P = new Float64Array(n * 3), T = new Float64Array(n), C = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = rnd() * 3, x = rnd() * 10, y = rnd() * 8, z = rnd() * 3;
    P[i * 3] = s < 2 ? x : 0; P[i * 3 + 1] = s < 1 ? y : (s < 2 ? 0 : y); P[i * 3 + 2] = s < 1 ? 0 : z; T[i] = rnd() * 60;
    const q = (Math.floor(P[i * 3] * 1.3) + Math.floor(P[i * 3 + 1] * 1.7) + Math.floor(P[i * 3 + 2] * 2.1)) % 3;
    const c = q === 0 ? [150, 70, 55] : (q === 1 ? [140, 140, 140] : [80, 120, 170]);
    for (let a = 0; a < 3; a++) C[i * 3 + a] = Math.min(255, c[a] * k * (0.9 + 0.2 * rnd()));
  }
  return { n, P, T, C };
}
function sampler(S) { const smp = new PA.Sampler(S.n, S.n, true); for (let i = 0; i < S.n; i++) smp.add(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i], S.C[i * 3], S.C[i * 3 + 1], S.C[i * 3 + 2]); return smp; }

test('r49: кривая по умолчанию — ×1,32, подъём чёрного +6, плечо с 165; светлые тона спокойнее r48, тени светлее', () => {
  const S = scene(120000, 0.55), s = CB.solve(sampler(S), { neutral: true, brighten: true });
  assert.ok(s.tone && s.tone.lift === 6 && s.tone.knee === 165 && s.tone.dark === 0 && s.tone.gain > 1.2 && s.tone.gain <= 1.32, JSON.stringify(s.stats));
  const L49 = CB.toneLUT({ gain: 1.32, dark: 0, lift: 6, knee: 165 }), L48 = CB.toneLUT({ gain: 1.36, dark: 0, lift: 2.5, knee: 185 });
  const at = (L, v) => L[Math.round(v * 16)];
  for (let k = 1; k <= 4096; k++) assert.ok(L49[k] >= L49[k - 1], 'монотонная');
  assert.ok(at(L49, 0) < 0.5 && at(L49, 255) > 245 && L49[4096] <= 255, 'концы ' + at(L49, 0) + ' ' + at(L49, 255));
  assert.ok(at(L49, 10) > at(L48, 10) + 2, 'тени: ' + at(L49, 10).toFixed(1) + ' vs ' + at(L48, 10).toFixed(1));
  assert.ok(at(L49, 140) < at(L48, 140) - 4 && at(L49, 140) > 150, 'светлые: ' + at(L49, 140).toFixed(1) + ' vs ' + at(L48, 140).toFixed(1));
  assert.ok(Math.abs(at(L49, 75) / 75 - 1.32 - 6 / 75) < 0.05, 'середина ×1,32: ' + at(L49, 75).toFixed(1));
  // прежняя кривая r48 — явными настройками
  const o = CB.solve(sampler(S), { neutral: true, brighten: true, toneGainMax: 1.36, toneLift: 2.5, toneKnee: 185 });
  assert.ok(o.tone && o.tone.lift === 2.5 && o.tone.knee === 185 && o.tone.gain <= 1.36 && o.tone.gain > s.tone.gain, JSON.stringify(o.stats));
});

test('r49: насыщенность — карта сканера 0,75, после «Цвета по фото» 0,71 (scan-refine-worker, opt.photoColor)', async () => {
  assert.strictEqual(CB.LIXEL_SATURATION, 0.75); assert.strictEqual(CB.LIXEL_SATURATION_PHOTO, 0.71);
  const { Worker } = require('node:worker_threads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-'));
  const run = (out, opt) => new Promise((res, rej) => {
    const w = new Worker(path.join(__dirname, '..', 'scan-refine-worker.js'), { workerData: { src: path.join(dir, 's.las'), out, tmpDir: dir, posesText: null, opt } });
    w.on('message', (m) => { if (m.type === 'result') { res(m.result); w.terminate(); } }); w.on('error', rej);
  });
  try {
    const S = scene(50000, 0.55, 5), pts = new Array(S.n * 4), rgb = new Array(S.n * 3);
    for (let i = 0; i < S.n; i++) { pts[i * 4] = S.P[i * 3]; pts[i * 4 + 1] = S.P[i * 3 + 1]; pts[i * 4 + 2] = S.P[i * 3 + 2]; pts[i * 4 + 3] = S.T[i]; for (let a = 0; a < 3; a++) rgb[i * 3 + a] = Math.round(S.C[i * 3 + a]); }
    SC.writeLas(path.join(dir, 's.las'), pts, rgb);
    const a = await run(path.join(dir, 'a.las'), { noiseLevel: 'strong', threads: 1 });
    assert.ok(a.ok && a.stats.colorBalance && a.stats.colorBalance.sat === 0.75, JSON.stringify(a.stats && a.stats.colorBalance));
    assert.ok(a.stats.colorBalance.tone && a.stats.colorBalance.tone.lift === 6 && a.stats.colorBalance.tone.knee === 165, JSON.stringify(a.stats.colorBalance));
    const b = await run(path.join(dir, 'b.las'), { noiseLevel: 'strong', threads: 1, photoColor: true });
    assert.ok(b.ok && b.stats.colorBalance.sat === 0.71, JSON.stringify(b.stats.colorBalance));
    const c = await run(path.join(dir, 'c.las'), { noiseLevel: 'strong', threads: 1, photoColor: true, colorBalanceOpt: { saturation: 0.9 } });
    assert.ok(c.ok && c.stats.colorBalance.sat === 0.9, 'colorBalanceOpt переопределяет: ' + JSON.stringify(c.stats.colorBalance));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
