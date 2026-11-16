'use strict';
// r145: цвет и текстура из сырого .xbin — улучшение «как в Lixel Studio».
// Тесты: нормализация кадров (экспозиция/баланс белого по 5–95 %), гамма-кривая вместо умножения,
// насыщенность, дизеринг 8-бит, лучший кадр без усреднения, заполнение серых зон и динамическая маска.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RC = require('../recolor-core');
const S = require('./helpers/r22-photo-scene');
const { writeLas } = require('./helpers/r20-scenes');

const dirs = [];
function tmpdir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r145-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

test('r145: нормализация кадра — тёмный кадр подтягивается к целевому (экспозиция+WB по 5–95 %)', () => {
  const bright = S.render(0);
  const O = Object.assign({}, RC.DEF, { improve: true });
  const tb = RC.frameStats(bright); assert.ok(tb && tb.p95 > tb.p5, JSON.stringify(tb));
  // тёмный кадр = меньшая экспозиция: масштабируются и яркость, и амплитуда цветности (U/V вокруг 128)
  const dark = { w: bright.w, h: bright.h, sY: bright.sY, sU: bright.sU, uvStep: 1, fullRange: true,
    Y: Uint8Array.from(bright.Y, v => Math.round(v * 0.55)),
    U: Uint8Array.from(bright.U, v => Math.max(0, Math.min(255, Math.round(128 + (v - 128) * 0.55)))),
    V: Uint8Array.from(bright.V, v => Math.max(0, Math.min(255, Math.round(128 + (v - 128) * 0.55)))) };
  const td = RC.frameStats(dark); assert.ok(td.meanY < tb.meanY - 20, 'кадр темнее: ' + td.meanY + ' vs ' + tb.meanY);
  RC.prepareFrame(dark, td, { meanY: tb.meanY, meanR: tb.meanR, meanG: tb.meanG, meanB: tb.meanB }, Object.assign({}, O, { normGainMin: 0.5, normGainMax: 2.5 }));
  assert.ok(dark.norm && dark.norm.scale > 1, 'растяжка контраста: ' + JSON.stringify(dark.norm));
  const ref = Object.assign({ w: bright.w, h: bright.h, sY: bright.sY, sU: bright.sU, uvStep: 1, fullRange: true,
    Y: Uint8Array.from(bright.Y), U: Uint8Array.from(bright.U), V: Uint8Array.from(bright.V) });
  RC.prepareFrame(ref, tb, { meanY: tb.meanY, meanR: tb.meanR, meanG: tb.meanG, meanB: tb.meanB }, Object.assign({}, O, { normGainMin: 0.5, normGainMax: 2.5 }));
  const out = new Float64Array(3);
  let eb = 0, n = 0;
  for (let y = 100; y < 200; y += 10) for (let x = 80; x < 320; x += 10) {
    RC.sampleRGB(ref, x, y, out); const r1 = out[0] + out[1] + out[2];
    RC.sampleRGB(dark, x, y, out); const r2 = out[0] + out[1] + out[2];
    eb += Math.abs(r1 - r2); n++;
  }
  assert.ok(eb / n < 35, 'тёмный кадр после нормализации близок к светлому: ΔRGB ' + (eb / n).toFixed(1));
});

test('r145: цветокоррекция — тоновая кривая по яркости (не умножение), насыщенность, дизеринг', () => {
  const O = Object.assign({}, RC.DEF, { improve: true, gradeGain: 1.36, gradeKnee: 170, gradeDark: 25, gradeSat: 1.29 });
  const L = RC.gradeLUT(O);
  assert.ok(L.length > 100 && L[0] === 0 && L[L.length - 1] > 240, 'LUT монотонна и доходит до светов');
  for (let k = 1; k < L.length; k++) assert.ok(L[k] >= L[k - 1], 'LUT не убывает: ' + k);
  const mid = new Float64Array([90, 90, 90]); RC.gradeRGB(mid, 0, L, 1.29);
  assert.ok(mid[0] > 110 && mid[0] < 140, 'середина 90 → ~122 (gain 1.36): ' + mid[0].toFixed(1));
  const sh = new Float64Array([10, 10, 10]); RC.gradeRGB(sh, 0, L, 1);
  assert.ok(sh[0] > 8 && sh[0] < 22, 'тени не проваливаются и не выжигаются: ' + sh[0].toFixed(1));
  const hi = new Float64Array([250, 250, 250]); RC.gradeRGB(hi, 0, L, 1);
  assert.ok(hi[0] > 250 && hi[1] > 250, 'света не выгорают: ' + hi[0]);
  const col = new Float64Array([120, 100, 80]);
  const grayBefore = 0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2];
  RC.gradeRGB(col, 0, null, 1.29);
  const grayAfter = 0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2];
  assert.ok(Math.abs(grayAfter - grayBefore) < 6 && (col[2] - col[0]) < (80 - 120), 'насыщенность растёт, яркость почти та же');
  for (let i = 0; i < 16; i++) { const d = RC.dithOff(i); assert.ok(d >= -0.5 && d <= 0.5, 'дизеринг в пределах ±0.5'); }
});

// прогон синтетической сцены r22 с нашими опциями
async function runScene(opt) {
  const dir = tmpdir(), src = path.join(dir, 'in.las'), dst = path.join(dir, 'out.las');
  const C = S.cloud(5); writeLas(src, C.pts, C.rgb);
  const frames = S.frames(5), cache = new Map();
  const index = { path: null, calib: S.calib(), frames: { 8: frames } };
  const st = await RC.recolor(src, dst, {
    index, posesText: S.posesText(), tmpDir: dir, opt: Object.assign({ cell: 4, dMax: 12 }, opt || {}),
    readFrame: (f) => Buffer.from([f.off]),
    decode: async (bytes, f) => { const k = bytes[0]; if (!cache.has(k)) cache.set(k, S.render(frames[k].t)); return cache.get(k); },
  });
  const B = fs.readFileSync(dst), n = C.n, out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = B.readUInt16LE(227 + i * 34 + 28 + a * 2) / 256;
  return { st, C, out, dst };
}
const luma = (out, i) => 0.299 * out[i * 3] + 0.587 * out[i * 3 + 1] + 0.114 * out[i * 3 + 2];

test('r145: улучшенный цвет — больше покрытие (заполнение), ярче, без «магентового» мусора', async () => {
  const old = await runScene({ window: 0.5, fill: false, grade: false, bestView: false });
  const now = await runScene({ window: 0.5, improve: true, fillRadius: 0.5, fillCell: 0.15, fillIters: 8 });
  assert.ok(now.st.colored >= old.st.colored, 'покрытие не меньше: ' + now.st.colored + ' vs ' + old.st.colored);
  assert.ok(now.st.filled > 0, 'серые зоны заполнены соседями: ' + now.st.filled);
  let lo = 0, ln = 0, mo = 0, mn = 0;
  for (let i = 0; i < old.C.n; i++) {
    const r = now.out[i * 3], g = now.out[i * 3 + 1], b = now.out[i * 3 + 2];
    if (r > 200 && b > 200 && g < 60) mn++;   // «оператор» — пурпурных пятен быть не должно
    const ro = old.out[i * 3], bo = old.out[i * 3 + 2];
    if (ro > 200 && bo > 200 && old.out[i * 3 + 1] < 60) mo++;
    if (Math.abs(now.out[i * 3] - old.out[i * 3]) + Math.abs(now.out[i * 3 + 1] - old.out[i * 3 + 1]) > 2) { lo += luma(now.out, i); ln++; }
  }
  assert.ok(mn < 0.005 * now.C.n, 'пурпурный «оператор» не красится: ' + mn);
  assert.ok(ln > 0, 'есть точки с изменённым цветом');
  const Lnow = lo / ln;
  let so = 0, sn = 0;
  for (let i = 0; i < now.C.n; i++) { if (now.out[i * 3] || now.out[i * 3 + 1] || now.out[i * 3 + 2]) { sn += luma(now.out, i); so += luma(old.out, i); } }
  assert.ok(sn > so * 1.05, 'яркость после улучшения выше; суммарно ' + sn.toFixed(0) + ' vs ' + so.toFixed(0) + ', средняя ' + Lnow.toFixed(1));
});

test('r145: динамическая маска — точки «людей» не получают цвет и не участвуют в заполнении', async () => {
  const dir = tmpdir(), src = path.join(dir, 'in.las'), dst = path.join(dir, 'out.las');
  const C = S.cloud(5); writeLas(src, C.pts, C.rgb);
  // «люди» — все точки стены x=5 (kind 0): в динамической маске вокселями 0.5 м
  const g = { gx: -10, gy: -10, gz: -10, v: 0.5, nx: 40, ny: 40, nz: 40 };
  const keys = [];
  for (let i = 0; i < C.n; i++) {
    if (C.kind[i] !== 0) continue;
    const x = C.pts[i * 4], y = C.pts[i * 4 + 1], z = C.pts[i * 4 + 2];
    keys.push(Math.floor((x - g.gx) / g.v) + g.nx * (Math.floor((y - g.gy) / g.v) + g.ny * Math.floor((z - g.gz) / g.v)));
  }
  const frames = S.frames(5);
  const st = await RC.recolor(src, dst, {
    index: { path: null, calib: S.calib(), frames: { 8: frames } }, posesText: S.posesText(), tmpDir: dir,
    opt: { cell: 4, dMax: 12, improve: true, fill: true }, dyn: { keys: new Set(keys), grid: g },
    readFrame: (f) => Buffer.from([f.off]), decode: async (b, f) => S.render(frames[b[0]].t),
  });
  const B = fs.readFileSync(dst);
  let coloredWall = 0, coloredAll = 0;
  for (let i = 0; i < C.n; i++) {
    const r = B.readUInt16LE(227 + i * 34 + 28) / 256;
    const gg = B.readUInt16LE(227 + i * 34 + 30) / 256;
    const bb = B.readUInt16LE(227 + i * 34 + 32) / 256;
    const changed = Math.abs(r - C.rgb[i * 3]) > 1 || Math.abs(gg - C.rgb[i * 3 + 1]) > 1 || Math.abs(bb - C.rgb[i * 3 + 2]) > 1;
    if (!changed) continue;
    coloredAll++;
    if (C.kind[i] === 0) coloredWall++;
  }
  assert.ok(coloredAll > 0, 'облако раскрашено');
  assert.equal(coloredWall, 0, 'точки в динамической маске не получили цвет: ' + coloredWall + ' из ' + coloredAll);
  assert.ok(st.improve && st.improve.fill, 'статистика улучшений есть');
});
