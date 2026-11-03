'use strict';
// Ревизия 47: «Цвет по фото» на реальном .xbin пользователя показал, что поза кадра из poses.csv ошибается на 0,1–0,8°
// (2–13 пикселей кадра 4000×3000), и соседние точки брали цвет из по-разному сдвинутых кадров — «зерно» и размытые края.
// Теперь ориентация каждого кадра уточняется по облаку (alignFrame): поиск малого поворота, при котором яркость кадра
// лучше всего совпадает с цветом облака. Синтетическая съёмка r22, траектория с ошибкой ориентации 1°.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RC = require('../recolor-core');
const S = require('./helpers/r22-photo-scene');
const { writeLas } = require('./helpers/r20-scenes');

// траектория r22 с поворотом вокруг оси z мира на deg градусов (ошибка ориентации позы)
function posesYaw(deg) {
  const h = deg * Math.PI / 360, qz = Math.sin(h), qw = Math.cos(h); let s = '';
  for (let k = 0; k <= 40; k++) { const t = k * 0.1; s += [t.toFixed(3), 0, S.camY(t).toFixed(4), 0, 0, 0, qz, qw].join(',') + '\n'; }
  return s;
}
async function run(posesText, opt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r47-')), src = path.join(dir, 'in.las'), dst = path.join(dir, 'out.las');
  const C = S.cloud(5); writeLas(src, C.pts, C.rgb);
  const frames = S.frames(5), cache = new Map(), index = { path: null, calib: S.calib(), frames: { 8: frames } };
  const st = await RC.recolor(src, dst, { index, posesText, tmpDir: dir, opt: Object.assign({ cell: 4, dMax: 12 }, opt || {}),
    readFrame: (f) => Buffer.from([f.off]), decode: async (bytes) => { const k = bytes[0]; if (!cache.has(k)) cache.set(k, S.render(frames[k].t)); return cache.get(k); } });
  const B = fs.readFileSync(dst), out = new Float64Array(C.n * 3);
  for (let i = 0; i < C.n; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = B.readUInt16LE(227 + i * 34 + 28 + a * 2) / 256;
  fs.rmSync(dir, { recursive: true, force: true });
  // ошибка цвета стены вдали от швов клетки (на шве цвет смешан фильтром)
  let err = 0, m = 0;
  for (let i = 0; i < C.n; i++) {
    if (C.kind[i] !== 0) continue;
    const x = C.pts[i * 4], y = C.pts[i * 4 + 1], z = C.pts[i * 4 + 2], fy = (y * 4 + 100) % 1, fz = (z * 4 + 100) % 1;
    if (fy < 0.15 || fy > 0.85 || fz < 0.15 || fz > 0.85) continue;
    if (Math.abs(y) < 0.4 && z < -0.45) continue;   // за ящиком
    const tc = S.trueColor(x, y, z); m++; err += Math.abs(out[i * 3] - tc[0]) + Math.abs(out[i * 3 + 1] - tc[1]) + Math.abs(out[i * 3 + 2] - tc[2]);
  }
  return { st, err: err / (3 * m), out };
}

test('r47: поворот кадра — малый поворот в осях камеры и билинейная яркость кадра', () => {
  const R0 = RC.rotDeg(0, 0, 0); assert.deepStrictEqual(R0.map(v => +v.toFixed(12)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const R = RC.rotDeg(0, 1, 0), A = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), B = RC.applyRot(R, A);
  assert.ok(Math.abs(B[2] - Math.sin(Math.PI / 180)) < 1e-12 && Math.abs(B[0] - Math.cos(Math.PI / 180)) < 1e-12, 'поворот на 1° вокруг оси y');
  assert.strictEqual(B[15], 1); assert.strictEqual(B[3], 0);
  const img = { w: 4, h: 4, sY: 4, Y: Uint8Array.from([0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30]) };
  assert.strictEqual(RC.lumaAt(img, 1.5, 1), 15); assert.strictEqual(RC.lumaAt(img, -1, 0), -1); assert.strictEqual(RC.lumaAt(img, 3.5, 0), -1);
});

test('r47: ошибка ориентации позы 1° — кадр уточняется по облаку, цвет стены точнее, поправка ≈ 1°', async () => {
  const bad = posesYaw(1);
  const off = await run(bad, { align: false });
  const on = await run(bad, {});
  assert.ok(on.st.align && on.st.align.used > 0.5 * on.st.align.frames, 'кадры уточнены: ' + JSON.stringify(on.st.align));
  assert.ok(on.st.align.meanDeg > 0.6 && on.st.align.meanDeg < 1.4, 'найденная поправка около 1°: ' + on.st.align.meanDeg);
  assert.ok(on.st.align.corrGain > 0.01, 'совпадение кадра с облаком выросло: ' + on.st.align.corrGain);
  assert.ok(on.err < off.err * 0.75, 'ошибка цвета стены ' + on.err.toFixed(1) + ' против ' + off.err.toFixed(1) + ' без уточнения');
  assert.strictEqual(off.st.align, null, 'align: false — уточнение выключено');
});

test('r47: точная поза — поправки малы, итог не зависит от ошибки позы; облако из лидара .xbin не уточняется', async () => {
  // у синтетического рендера центр пикселя сдвинут на ½ пикселя (u + 0,5): это ≈ 0,19° по каждой оси при F = 150 —
  // уточнение его находит, поэтому поправки на точной позе не нулевые, но меньше 0,35°
  const on = await run(S.posesText(), {}), bad = await run(posesYaw(1), {});
  assert.ok(on.st.align.meanDeg < 0.35, 'поправки малы: ' + on.st.align.meanDeg);
  assert.ok(Math.abs(bad.err - on.err) < 1.5, 'с уточнением ошибка позы 1° почти не влияет на цвет: ' + bad.err.toFixed(2) + ' / ' + on.err.toFixed(2));
  const src = fs.readFileSync(path.join(__dirname, '..', 'recolor-core.js'), 'utf8');
  assert.match(src, /const doAlign = !!o\.align && !fromXbinLidar/, 'серое облако из лидара (яркость отражения) — без уточнения');
});

test('r47: осевой поиск поворота (по умолчанию) находит ту же поправку, что и полный перебор 26 соседей', async () => {
  const bad = posesYaw(1), ax = await run(bad, {}), full = await run(bad, { alignSearch: 'full' });
  assert.ok(Math.abs(ax.st.align.meanDeg - full.st.align.meanDeg) < 0.15, 'поправки ' + ax.st.align.meanDeg + ' / ' + full.st.align.meanDeg);
  assert.ok(ax.err < full.err + 0.5, 'ошибка цвета ' + ax.err.toFixed(2) + ' / ' + full.err.toFixed(2));
});
