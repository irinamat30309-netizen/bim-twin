'use strict';
// Ревизия 132: точечные улучшения чистки —
//  • thinSurfaces: «moved» только для |d|>1 мм и предел сдвига maxThinShift (по умолчанию 2 см);
//  • повторный проход детектора движущихся после шумоподавления (filterVoxels в scan-refine-core).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const R = require('../scan-refine-core');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r132-'));

// плотная плоскость z=0 (60×60 точек с шагом 0.02 м, на центрах ячеек 0.04) + управляемые выбросы
function planePoints() {
  const X = [];
  for (let ix = 0; ix < 60; ix++) for (let iy = 0; iy < 60; iy++) X.push(ix * 0.02 + 0.01, iy * 0.02 + 0.01, 0);
  return X;
}

function offsetPoint(X, z) {           // точка над плоскостью (в центре ячейки 0.04; локальная плоскость почти не наклоняется)
  X.push(0.30, 0.30, z);
  return X.length / 3 - 1;
}

test('r132: thinSurfaces — moved только для |d|>1 мм, сдвиг ограничен maxShift (2 см)', () => {
  // 1) чистая плоскость z=0: локальная плоскость совпадает с точками — moved должен быть 0 (раньше считались все 3600)
  const X0 = planePoints(), n0 = X0.length / 3;
  const moved0 = R.thinSurfaces(X0, n0, new Uint8Array(n0).fill(1), { maxShift: 0.02 });
  assert.strictEqual(moved0, 0, 'плоскость без выбросов: moved=' + moved0 + ' (ожидалось 0)');
  // 2) выброс на 5 см: сдвиг ограничен 2 см (ровно), остальные точки — не более 2 см
  const X1 = planePoints(); const i1 = offsetPoint(X1, 0.05); const n1 = X1.length / 3;
  const X1c = Float64Array.from(X1);
  const moved1 = R.thinSurfaces(X1, n1, new Uint8Array(n1).fill(1), { maxShift: 0.02 });
  assert.ok(moved1 >= 1, 'выброс должен сдвинуться, moved=' + moved1);
  assert.ok(moved1 < n1, 'не все точки должны считаться сдвинутыми: ' + moved1 + '/' + n1);
  assert.ok(Math.abs(X1[i1 * 3 + 2] - 0.03) < 1e-6, 'выброс сдвинут ровно на 2 см: z=' + X1[i1 * 3 + 2]);
  let maxDisp = 0;
  for (let i = 0; i < n1; i++) maxDisp = Math.max(maxDisp, Math.abs(X1[i * 3 + 2] - X1c[i * 3 + 2]));
  assert.ok(maxDisp <= 0.02 + 1e-9, 'максимальный сдвиг ' + maxDisp + ' > 2 см');
  // 3) по умолчанию предел тоже 2 см
  const X2 = planePoints(); const i2 = offsetPoint(X2, 0.05); const n2 = X2.length / 3;
  R.thinSurfaces(X2, n2, new Uint8Array(n2).fill(1), {});
  assert.ok(Math.abs(X2[i2 * 3 + 2] - 0.03) < 1e-6, 'по умолчанию тоже 2 см: z=' + X2[i2 * 3 + 2]);
  // 4) смещение <1 мм не считается сдвигом и точка остаётся на месте
  const X3 = planePoints(); const i3 = offsetPoint(X3, 0.0005); const n3 = X3.length / 3;
  const moved3 = R.thinSurfaces(X3, n3, new Uint8Array(n3).fill(1), { maxShift: 0.02 });
  assert.strictEqual(X3[i3 * 3 + 2], 0.0005, 'точка со смещением 0.5 мм осталась на месте');
  assert.strictEqual(moved3, 0, 'смещение <1 мм не считается сдвигом: moved=' + moved3);
});

// --- минимальный LAS 1.2 fmt3 для filterVoxels
function writeLas(file, pts, bbox) {
  const XL = require('../xbin-lidar');
  const n = pts.length, rl = 34;
  const h = XL.lasHeader({ n, ox: 0, oy: 0, oz: 0, min: bbox.slice(0, 3), max: bbox.slice(3) });
  const body = Buffer.alloc(n * rl);
  for (let i = 0; i < n; i++) {
    const p = pts[i], o = i * rl;
    body.writeInt32LE(Math.round(p.x * 1000), o); body.writeInt32LE(Math.round(p.y * 1000), o + 4); body.writeInt32LE(Math.round(p.z * 1000), o + 8);
    body.writeUInt16LE(100, o + 12); body[o + 14] = 9; body[o + 17] = i % 32;
    body.writeDoubleLE(p.t, o + 20);
    body.writeUInt16LE(200, o + 28); body.writeUInt16LE(200, o + 30); body.writeUInt16LE(200, o + 32);
  }
  fs.writeFileSync(file, Buffer.concat([h, body]));
}

function readLas(file) {
  const b = fs.readFileSync(file), n = b.readUInt32LE(107), off = b.readUInt32LE(96), rl = b.readUInt16LE(105);
  const sx = b.readDoubleLE(131), ox = b.readDoubleLE(155), oy = b.readDoubleLE(163), oz = b.readDoubleLE(171), pts = [];
  for (let i = 0, q = off; i < n; i++, q += rl) pts.push({ x: b.readInt32LE(q) * sx + ox, y: b.readInt32LE(q + 4) * sx + oy, z: b.readInt32LE(q + 8) * sx + oz, t: b.readDoubleLE(q + 20) });
  return { n, pts, sig: b.toString('latin1', 0, 4), off };
}

function voxelGrid(pts, v) {
  let gx = Infinity, gy = Infinity, gz = Infinity;
  for (const p of pts) { gx = Math.min(gx, p.x); gy = Math.min(gy, p.y); gz = Math.min(gz, p.z); }
  gx -= 0.5; gy -= 0.5; gz -= 0.5;
  let nx = 0, ny = 0, nz = 0;
  for (const p of pts) { nx = Math.max(nx, Math.floor((p.x - gx) / v) + 1); ny = Math.max(ny, Math.floor((p.y - gy) / v) + 1); nz = Math.max(nz, Math.floor((p.z - gz) / v) + 1); }
  const key = (p) => Math.floor((p.x - gx) / v) + nx * (Math.floor((p.y - gy) / v) + ny * Math.floor((p.z - gz) / v));
  return { grid: { gx, gy, gz, v, nx, ny, nz }, key };
}

test('r132: filterVoxels — повторное удаление движущихся по вокселям (sets и одиночный набор)', () => {
  const d = tmpDir();
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ x: i * 0.2, y: 0, z: 0.1 + (i % 2) * 0.01, t: 1000 + i * 0.1 });
  const src = path.join(d, 'in.las'), dst = path.join(d, 'out.las');
  writeLas(src, pts, [-0.1, -0.1, 0, 2.0, 0.1, 0.2]);
  const { grid, key } = voxelGrid(pts, 0.1);
  const keyWith = (p, v) => Math.floor((p.x - grid.gx) / v) + grid.nx * (Math.floor((p.y - grid.gy) / v) + grid.ny * Math.floor((p.z - grid.gz) / v));
  // два набора, как у detect(): «лучи» (v=0.1) и «следы» (v=0.15) — в каждом по одной клетке с точками
  const setA = { keys: [key(pts[2]), key(pts[5])], grid };
  const g2 = Object.assign({}, grid, { v: 0.15 });
  const setB = { keys: [keyWith(pts[8], 0.15)], grid: g2 };
  const r = R.filterVoxels(src, dst, { sets: [setA, setB] });
  assert.strictEqual(r.removed, 3, 'удалено точек: ' + r.removed);
  assert.strictEqual(r.points, 7);
  assert.strictEqual(r.sets, 2);
  const L = readLas(dst);
  assert.strictEqual(L.sig, 'LASF'); assert.strictEqual(L.n, 7); assert.ok(L.pts.length === 7);
  const keptT = L.pts.map(p => Math.round(p.t * 10)).sort((a, b) => a - b).join(',');
  const wantT = pts.filter((_, i) => ![2, 5, 8].includes(i)).map(p => Math.round(p.t * 10)).sort((a, b) => a - b).join(',');
  assert.strictEqual(keptT, wantT, 'оставшиеся точки: ' + keptT);
  // одиночный набор (старый формат {keys, grid}) тоже поддерживается
  const dst2 = path.join(d, 'out2.las');
  const r2 = R.filterVoxels(src, dst2, { keys: [key(pts[0])], grid });
  assert.strictEqual(r2.removed, 1); assert.strictEqual(r2.points, 9);
  // если удалять нечего — файл пишется как есть
  const dst3 = path.join(d, 'out3.las');
  const r3 = R.filterVoxels(src, dst3, { keys: [], grid });
  assert.strictEqual(r3.removed, 0); assert.strictEqual(readLas(dst3).n, 10);
});
