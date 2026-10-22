'use strict';
// Ревизия 20: «копии» идущих людей в ключевых кадрах realtime-карты находятся без траектории; очистка шума агрессивнее
// («пыль» у поверхностей, «лучи» за кромками, уровень «максимум»), исправление цвета не размывает швы плитки и кладки;
// Автоочистка большого LAS — полная обработка по файлу.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../dynamic-clean-core');
const DV = require('../renderer/dynamic-voxels');
const R = require('../scan-refine-core');
const SC = require('./helpers/r20-scenes');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('r20: копии идущих людей и машина в ключевых кадрах находятся без траектории, неподвижное не задето', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r20y-'));
  try {
    const S = SC.yard({ kf: 1, per: 8000 }), n = S.lab.length, f = path.join(dir, 'yard.las');
    SC.writeLas(f, S.pts);
    const r = D.detect(f, null, {}), M = DV.buildMany(r.sets);
    const hit = { 1: [0, 0], 4: [0, 0] }; let fp0 = 0, n0 = 0;
    for (let i = 0; i < n; i++) {
      const h = M.has(S.pts[i * 4], S.pts[i * 4 + 1], S.pts[i * 4 + 2]);
      if (S.lab[i] === 1 && hit[S.sub[i]]) { hit[S.sub[i]][1]++; if (h) hit[S.sub[i]][0]++; }
      if (S.lab[i] === 0) { n0++; if (h) fp0++; }
    }
    const walk = hit[1][0] / hit[1][1], car = hit[4][0] / hit[4][1];
    assert.ok(walk > 0.7, 'идущие найдены на ' + (walk * 100).toFixed(0) + ' %');
    assert.ok(car > 0.6, 'машина найдена на ' + (car * 100).toFixed(0) + ' %');
    assert.ok(fp0 / n0 < 0.0005, 'ложных на неподвижном ' + (fp0 / n0 * 100).toFixed(3) + ' %');
    // без нового блока «снимков» (snapSpan 0) копии в кадрах через 1 с почти не находились
    const r0 = D.detect(f, null, { trail: { snapSpan: 0 } }), M0 = DV.buildMany(r0.sets); let w0 = 0;
    for (let i = 0; i < n; i++) if (S.lab[i] === 1 && S.sub[i] === 1 && M0.has(S.pts[i * 4], S.pts[i * 4 + 1], S.pts[i * 4 + 2])) w0++;
    assert.ok(walk > w0 / hit[1][1] + 0.25, 'заметно лучше прежнего: ' + (w0 / hit[1][1] * 100).toFixed(0) + ' % → ' + (walk * 100).toFixed(0) + ' %');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function score(S, alive, X) {
  const tot = {}, rem = {}; for (let i = 0; i < S.n; i++) { const t = S.T[i]; tot[t] = (tot[t] || 0) + 1; if (!alive[i]) rem[t] = (rem[t] || 0) + 1; }
  const o = {}; for (const t in tot) o[t] = (rem[t] || 0) / tot[t];
  let live = 0, junk = 0; for (let i = 0; i < S.n; i++) if (alive[i]) { live++; if (S.T[i] >= 5) junk++; }
  o.junk = junk / live;
  if (X) { let s = 0, c = 0; for (let i = 0; i < S.n; i++) { if (!alive[i] || S.T[i] !== 0) continue; const y = X[i * 3 + 1], z = X[i * 3 + 2]; const d = Math.abs(y) < 0.2 && z > 0.2 ? y : (z < 0.2 && y < -0.2 ? z : null); if (d === null) continue; s += d * d; c++; } o.rms = Math.sqrt(s / c); }
  return o;
}
let SURF = null; const surf = () => SURF || (SURF = SC.surfaces({ dens: 12000 }));

test('r20: шум — «пыль» перед стенами, туман и «лучи» убираются, рама, арматура и кабель остаются', () => {
  const S = surf(), res = {};
  for (const lvl of ['soft', 'normal', 'strong', 'max']) { const X = S.X.slice(), a = new Uint8Array(S.n).fill(1); R.denoise(X, S.n, a, lvl); R.thinSurfaces(X, S.n, a, { cell: 0.04, planar: 0.06 }); res[lvl] = score(S, a, X); }
  const st = res.strong;
  assert.ok(st[5] > 0.5, 'пыль: ' + (st[5] * 100).toFixed(0) + ' %');          // остальное — ближе 1 см, неотличимо от разброса σ 8 мм
  assert.ok(st[6] > 0.95, 'туман: ' + (st[6] * 100).toFixed(0) + ' %');
  assert.ok(st[7] > 0.9, '«лучи»: ' + (st[7] * 100).toFixed(0) + ' %');
  assert.ok(st[0] < 0.03, 'поверхности: ' + (st[0] * 100).toFixed(2) + ' %');
  assert.ok(st[1] < 0.01, 'рама, арматура, кабель: ' + (st[1] * 100).toFixed(2) + ' %');
  assert.ok(st.rms < 0.002, 'стена и пол тонкие: ' + (st.rms * 1000).toFixed(1) + ' мм');
  assert.ok(res.max[1] < 0.03, 'максимум: тонкое ' + (res.max[1] * 100).toFixed(2) + ' %');
  assert.ok(res.soft.junk > res.normal.junk && res.normal.junk > res.strong.junk && res.strong.junk >= res.max.junk, 'уровни упорядочены: ' + ['soft', 'normal', 'strong', 'max'].map(l => (res[l].junk * 100).toFixed(1)).join(' > '));
  // прежний уровень «сильно» ревизии 19 (выбросы у плоскостей) почти не трогал пыль
  const a19 = new Uint8Array(S.n).fill(1), X19 = S.X.slice();
  R.isolated(X19, S.n, a19, { cell: 0.1, maxNb: 3 }); R.lowDensity(X19, S.n, a19, { frac: 0.06, minMean: 20 }); R.smallClusters(X19, S.n, a19, { minPts: 40 }); R.planeOutliers(X19, S.n, a19, {});
  const o19 = score(S, a19);
  assert.ok(st.junk < o19.junk * 0.6, 'мусора осталось ' + (o19.junk * 100).toFixed(1) + ' % → ' + (st.junk * 100).toFixed(1) + ' %');
});

test('r20: пёстрые точки исправляются, швы плитки и кладки не размываются', () => {
  const S = surf(), X = S.X.slice(), a = new Uint8Array(S.n).fill(1);
  R.denoise(X, S.n, a, 'strong'); R.thinSurfaces(X, S.n, a, { cell: 0.04, planar: 0.06 });
  const err = (C, pick) => { let e = 0, c = 0; for (let i = 0; i < S.n; i++) { if (!a[i] || !pick(i)) continue; e += (Math.abs(C[i * 3] - S.TC[i * 3]) + Math.abs(C[i * 3 + 1] - S.TC[i * 3 + 1]) + Math.abs(C[i * 3 + 2] - S.TC[i * 3 + 2])) / 3; c++; } return e / c; };
  const seam = i => S.T[i] === 0 && (S.TC[i * 3] === 60 || S.TC[i * 3] === 190);
  const wallDust = i => S.T[i] === 5 && Math.abs(S.X[i * 3 + 1]) < 0.1 && S.X[i * 3 + 2] > 0.1;
  const C0 = S.C.slice(), C1 = S.C.slice(), C2 = S.C.slice();
  const n1 = R.cleanColors(X, C1, S.n, a, 'strong'); R.fixColors(X, C2, S.n, a, { cell: 0.05 });
  assert.ok(n1 > 0);
  assert.ok(err(C1, seam) < err(C0, seam) + 6, 'швы: ' + err(C0, seam).toFixed(1) + ' → ' + err(C1, seam).toFixed(1));
  assert.ok(err(C2, seam) > err(C1, seam) * 2, 'прежний fixColors размывал швы: ' + err(C2, seam).toFixed(1));
  assert.ok(err(C1, wallDust) < err(C0, wallDust) * 0.6, 'белые точки на кирпиче: ' + err(C0, wallDust).toFixed(0) + ' → ' + err(C1, wallDust).toFixed(0));
});

test('r20: чистовая обработка по умолчанию — «сильно», пишет LAS с цветом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r20r-'));
  try {
    const S = SC.surfaces({ dens: 3000 }), pts = new Array(S.n * 4), rgb = new Array(S.n * 3);
    for (let i = 0; i < S.n; i++) { pts[i * 4] = S.X[i * 3] + 500; pts[i * 4 + 1] = S.X[i * 3 + 1] + 300; pts[i * 4 + 2] = S.X[i * 3 + 2] + 20; pts[i * 4 + 3] = i * 1e-5;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(S.C[i * 3 + c]))); }
    const src = path.join(dir, 'in.las'); SC.writeLas(src, pts, rgb);
    const a = R.refine(src, path.join(dir, 'a.las'), { tmpDir: dir }), s = R.refine(src, path.join(dir, 's.las'), { tmpDir: dir, noiseLevel: 'soft' });
    assert.ok(a.noise > s.noise * 2, 'по умолчанию сильнее «мягко»: ' + s.noise + ' → ' + a.noise);
    assert.ok(a.recolored > 0 && a.color16, JSON.stringify(a));
    const H = R.readHeader(fs.openSync(path.join(dir, 'a.las'), 'r')); assert.strictEqual(H.n, a.written);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r20: настройки в приложении — «максимум», «сильно» по умолчанию, «снимки», Автоочистка большого LAS', () => {
  const m = read('main.js');
  assert.match(m, /const NOISE_LEVELS = \['soft', 'normal', 'strong', 'max'(, 'inspect')?\]/);   // ревизия 32: + бережный уровень для контроля геометрии
  assert.match(m, /a\.noiseLevel : 'strong'/);
  assert.match(m, /tn\('snapSpan', 0\.3, 30\)/);
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /normal: \{ ratio: 0\.6, fMin: 3, maxSeen: 50, trail: \{ snapSpan: 2 \} \}/);
  assert.match(ui, /\{ value: 'max', label: 'Максимум/);
  assert.match(ui, /noiseLevel: values\.noiseLevel \|\| 'strong'/);
  assert.match(ui, /return opRefineScan\(\{ title: 'Автоочистка' \}\)/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(ui), 'без эмодзи');
  const core = read('scan-refine-core.js');
  assert.match(core, /nColor \+= cleanColors\(/);
  assert.ok(!/nColor \+= fixColors\(/.test(core), 'прежний fixColors в обработке не используется');
  for (const l of ['soft', 'normal', 'strong', 'max']) assert.ok(R.NOISE_LEVELS[l], l);
});
