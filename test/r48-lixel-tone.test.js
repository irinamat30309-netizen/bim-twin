'use strict';
// Ревизия 48: цвет чистовой обработки сверен с эталоном Lixel Studio на всём облаке «фасад + двор» (рамка 68×33 м, ячейки 5 см):
// усиление ≈×1,36 и в тенях (раньше тени до 10-го процентиля не трогались и были в 1,4–1,6 раза темнее), мягкий подъём чёрного,
// плечо с 185; серые — чуть тёплые, как у Lixel; насыщенность 0,73.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PA = require('../pass-align-core');
const CB = require('../color-balance-core');
const R = require('../scan-refine-core');
const SC = require('./helpers/r20-scenes');

function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
// пол и стены 10×8×3 м, серые/кирпичные/голубые пятна, яркость × k (тёмная realtime-карта)
function scene(n, k, seed) {
  const rnd = rng(seed || 7), P = new Float64Array(n * 3), T = new Float64Array(n), C = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = rnd() * 3, x = rnd() * 10, y = rnd() * 8, z = rnd() * 3;
    P[i * 3] = s < 1 ? x : (s < 2 ? 0 : x); P[i * 3 + 1] = s < 1 ? y : (s < 2 ? y : 0); P[i * 3 + 2] = s < 1 ? 0 : z; T[i] = rnd() * 60;
    const q = (Math.floor(P[i * 3] * 1.3) + Math.floor(P[i * 3 + 1] * 1.7) + Math.floor(P[i * 3 + 2] * 2.1)) % 3;
    const c = q === 0 ? [150, 70, 55] : (q === 1 ? [140, 140, 140] : [80, 120, 170]);
    for (let a = 0; a < 3; a++) C[i * 3 + a] = Math.min(255, c[a] * k * (0.9 + 0.2 * rnd()));
  }
  return { n, P, T, C };
}
function sampler(S) { const smp = new PA.Sampler(S.n, S.n, true); for (let i = 0; i < S.n; i++) smp.add(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i], S.C[i * 3], S.C[i * 3 + 1], S.C[i * 3 + 2]); return smp; }

test('r48: кривая с подъёмом теней — монотонная, 0 → 0, совпадает с квантилями Lixel (фасад + двор)', () => {
  const L = CB.toneLUT({ gain: 1.36, dark: 0, lift: 2.5, knee: 185 }), at = (v) => L[Math.round(v * 16)];
  for (let k = 1; k < L.length; k++) assert.ok(L[k] >= L[k - 1], 'немонотонно в ' + k);
  assert.ok(at(0) < 0.5 && at(255) > 245 && at(256) <= 255, at(0) + ' ' + at(255));
  // вход кривой → Lixel (квантили 1…99 % по 174 тыс. ячеек 5 см): 4,1 → 8,2; 10,5 → 16,7; 18,7 → 26,5; 37,5 → 50,6; 65,9 → 89,7;
  // 107,9 → 146,6; 130 → 175; 145,7 → 192,4; 169 → 210,2
  for (const [v, ref] of [[10.5, 16.7], [18.7, 26.5], [37.5, 50.6], [65.9, 89.7], [107.9, 146.6], [130, 175], [145.7, 192.4], [169, 210.2]])
    assert.ok(Math.abs(at(v) - ref) <= 0.06 * ref + 1, v + ' → ' + at(v).toFixed(1) + ', у Lixel ' + ref);
  // прежняя кривая r46 (тени как есть) — на тех же тенях заметно темнее
  const O = CB.toneLUT({ gain: 1.36, dark: 25, knee: 170 }); assert.ok(O[Math.round(18.7 * 16)] < 0.8 * at(18.7), 'r46: ' + O[Math.round(18.7 * 16)]);
});

test('r48: решение по умолчанию — усиление не больше 1,36, тени ярче, серые чуть тёплые; toneShadows: keep — как в r46', () => {
  const S = scene(120000, 0.55), s = CB.solve(sampler(S), {});
  assert.ok(s.tone && s.tone.lift === 2.5 && s.tone.dark === 0 && s.tone.knee === 185 && s.tone.gain > 1.2 && s.tone.gain <= 1.36, JSON.stringify(s.stats));
  const fix = CB.makeColorFix(s), g = [70, 70, 70], d = [12, 12, 12]; fix(0, g, 0); fix(0, d, 0);
  assert.ok(g[0] / g[1] > 1.015 && g[0] / g[1] < 1.06 && Math.abs(g[2] / g[1] - 1) < 0.03, 'серый: ' + g.map(v => v.toFixed(1)));
  assert.ok(d[1] > 15, 'тень 12 → ' + d[1].toFixed(1));
  const k = CB.solve(sampler(S), { toneShadows: 'keep' });
  assert.ok(k.tone && k.tone.lift === undefined && k.tone.dark > 0 && k.tone.knee === 170 && k.tone.gain <= 1.4, JSON.stringify(k.stats));
  const n = CB.solve(sampler(S), { wbTarget: [1, 1, 1] }), f2 = CB.makeColorFix(n), g2 = [70, 70, 70]; f2(0, g2, 0);
  assert.ok(Math.abs(g2[0] / g2[1] - 1) < 0.02, 'нейтральный по желанию: ' + g2);
});

test('r48: чистовая обработка в приложении (scan-refine-worker) — насыщенность 0,73 и кривая с подъёмом теней; colorBalanceOpt переопределяет', async () => {
  const { Worker } = require('node:worker_threads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r48-'));
  const run = (out, opt) => new Promise((res, rej) => {
    const w = new Worker(path.join(__dirname, '..', 'scan-refine-worker.js'), { workerData: { src: path.join(dir, 's.las'), out, tmpDir: dir, posesText: null, opt } });
    w.on('message', (m) => { if (m.type === 'result') { res(m.result); w.terminate(); } }); w.on('error', rej);
  });
  try {
    const S = scene(60000, 0.55, 3), pts = new Array(S.n * 4), rgb = new Array(S.n * 3);
    for (let i = 0; i < S.n; i++) { pts[i * 4] = S.P[i * 3]; pts[i * 4 + 1] = S.P[i * 3 + 1]; pts[i * 4 + 2] = S.P[i * 3 + 2]; pts[i * 4 + 3] = S.T[i]; for (let a = 0; a < 3; a++) rgb[i * 3 + a] = Math.round(S.C[i * 3 + a]); }
    SC.writeLas(path.join(dir, 's.las'), pts, rgb);
    const a = await run(path.join(dir, 'a.las'), { noiseLevel: 'strong', threads: 1 });
    assert.ok(a.ok && a.stats.colorBalance && a.stats.colorBalance.sat === CB.LIXEL_SATURATION && CB.LIXEL_SATURATION === 0.73, JSON.stringify(a));
    assert.ok(a.stats.colorBalance.tone && a.stats.colorBalance.tone.lift === 2.5, JSON.stringify(a.stats.colorBalance));
    const b = await run(path.join(dir, 'b.las'), { noiseLevel: 'strong', threads: 1, colorBalanceOpt: { saturation: 0.8, toneShadows: 'keep' } });
    assert.ok(b.ok && b.stats.colorBalance.sat === 0.8 && b.stats.colorBalance.tone && b.stats.colorBalance.tone.lift === undefined, JSON.stringify(b.stats.colorBalance));
    // ядро без приложения — прежняя насыщенность 0,8
    const c = R.refine(path.join(dir, 's.las'), path.join(dir, 'c.las'), { tmpDir: dir, noiseLevel: 'strong' });
    assert.strictEqual(c.colorBalance.sat, 0.8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
