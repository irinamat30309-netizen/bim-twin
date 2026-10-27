'use strict';
// Удаление движущихся объектов по траектории: синтетическая сцена (стена, пол, «прохожий», который потом ушёл)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../dynamic-clean-core');
const DV = require('../renderer/dynamic-voxels');

function writeLas(file, pts) {   // LAS 1.2, формат 1 (28 байт, время точки в +20)
  const n = pts.length / 4, H = Buffer.alloc(227), sc = 0.001;
  H.write('LASF', 0, 'latin1'); H[24] = 1; H[25] = 2; H.writeUInt16LE(227, 94); H.writeUInt32LE(227, 96); H[104] = 1; H.writeUInt16LE(28, 105); H.writeUInt32LE(n, 107);
  H.writeDoubleLE(sc, 131); H.writeDoubleLE(sc, 139); H.writeDoubleLE(sc, 147);
  const B = Buffer.alloc(n * 28);
  for (let i = 0; i < n; i++) { const o = i * 28; B.writeInt32LE(Math.round(pts[i * 4] / sc), o); B.writeInt32LE(Math.round(pts[i * 4 + 1] / sc), o + 4); B.writeInt32LE(Math.round(pts[i * 4 + 2] / sc), o + 8); B.writeDoubleLE(pts[i * 4 + 3], o + 20); }
  fs.writeFileSync(file, Buffer.concat([H, B]));
}
// сцена: сканер идёт вдоль x (0→10 м) за 100 с на высоте 1,5 м; стена y = 5; пол z = 0; прохожий — ящик у x = 5, y = 2,5 (0…20 с)
function scene() {
  const poses = [], pts = []; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const person = { mn: [4.75, 2.25, 0], mx: [5.25, 2.75, 1.8] };
  for (let k = 0; k <= 500; k++) {
    const t = 1000 + k * 0.2, sx = k * 0.02, sy = 0, sz = 1.5; poses.push([t, sx, sy, sz].join(','));
    for (let r = 0; r < 1600; r++) {
      const tt = t + r * 0.2 / 1600, az = (rnd() * 0.9 + 0.05) * Math.PI, el = (rnd() - 0.6) * 1.2;
      const dx = Math.cos(az) * Math.cos(el), dy = Math.sin(az) * Math.cos(el), dz = Math.sin(el);
      let best = Infinity;
      if (dy > 1e-6) { const s = (5 - sy) / dy; const z = sz + dz * s; if (z >= 0 && z <= 3) best = s; }
      if (dz < -1e-6) { const s = -sz / dz; if (s < best && sy + dy * s <= 5) best = s; }
      if (tt < 1020) {   // прохожий стоит первые 20 с
        let t0 = 0, t1 = best; const o = [sx, sy, sz], d = [dx, dy, dz];
        for (let a = 0; a < 3 && t0 <= t1; a++) { if (Math.abs(d[a]) < 1e-12) { if (o[a] < person.mn[a] || o[a] > person.mx[a]) t1 = -1; continue; } let u = (person.mn[a] - o[a]) / d[a], v = (person.mx[a] - o[a]) / d[a]; if (u > v) { const q = u; u = v; v = q; } t0 = Math.max(t0, u); t1 = Math.min(t1, v); }
        if (t0 <= t1 && t0 > 0) best = t0;
      }
      if (best < 30) pts.push(sx + dx * best, sy + dy * best, sz + dz * best, tt);
    }
  }
  return { poses: poses.join('\n'), pts, person };
}

test('движущийся объект находится по траектории, стена и пол остаются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-')), las = path.join(dir, 's.las');
  try {
    const S = scene(); writeLas(las, S.pts);
    const r = D.run(las, S.poses, { radius: 8, rayStep: 1 });
    const n = S.pts.length / 4; let pIn = 0, pHit = 0, sHit = 0, sAll = 0;
    for (let i = 0; i < n; i++) {
      const x = S.pts[i * 4], y = S.pts[i * 4 + 1], z = S.pts[i * 4 + 2];
      const inP = x > 4.7 && x < 5.3 && y > 2.2 && y < 2.8 && z > 0.25;
      if (inP) { pIn++; if (r.mask[i] === 1) pHit++; } else if (z > 0.15 || y > 4.9) { sAll++; if (r.mask[i] === 1) sHit++; }
    }
    assert.ok(pIn > 1000, 'на прохожего попало мало точек: ' + pIn);
    assert.ok(pHit / pIn > 0.6, 'прохожий найден лишь на ' + (pHit / pIn * 100).toFixed(1) + ' %');
    assert.ok(sHit / sAll < 0.002, 'задета стена: ' + sHit + ' из ' + sAll);
    // режим для окна: список вокселей + разметка точек по координатам (без srcXform)
    const v = D.run(las, S.poses, { radius: 8, rayStep: 1, voxelsOnly: true });
    assert.ok(v.keys.length > 0 && v.grid.v === 0.1);
    const M = DV.build(v.keys, v.grid), P = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { P[i * 3] = S.pts[i * 4]; P[i * 3 + 1] = S.pts[i * 4 + 1]; P[i * 3 + 2] = S.pts[i * 4 + 2]; }
    let same = 0, cnt = DV.classify(M, P, 0, n, null, (i) => { if (r.mask[i] === 1) same++; });
    assert.ok(cnt - same <= Math.max(3, cnt * 0.005), "разметка по координатам расходится с маской: " + same + " из " + cnt);   // Float32 у границы вокселя
    assert.ok(Math.abs(cnt - pHit - sHit) <= Math.max(5, cnt * 0.01));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('координаты окна Z-up переводятся в координаты файла', () => {
  const g = { gx: 10, gy: 20, gz: 0, v: 0.1, nx: 50, ny: 50, nz: 30 };
  const key = 12 + 50 * (34 + 50 * 7), M = DV.build(new Float64Array([key]), g);
  assert.ok(M.has(11.25, 23.45, 0.75)); assert.ok(!M.has(11.35, 23.45, 0.75));
  const xf = DV.xfOf({ axis: 'zup', t: [11, 24, 0.5] }), P = new Float32Array([0.25, 0.25, 0.55]); let hit = -1;   // окно: x = X − tx, y = Z − tz, z = −(Y − ty)
  assert.strictEqual(DV.classify(M, P, 0, 1, xf, (i) => { hit = i; }), 1); assert.strictEqual(hit, 0);
});

test('poses.csv Lixel: время, x, y, z, кватернион', () => {
  const P = D.parsePoses('1.5,1,2,3,0,0,0,1\n1.0,0,0,0,0,0,0,1\n# comment\n');
  assert.strictEqual(P.n, 2); assert.strictEqual(P.t[0], 1.0);
  const at = D.makePoseAt(P), o = new Float64Array(3); at(1.25, o); assert.deepStrictEqual(Array.from(o), [0.5, 1, 1.5]);
});
