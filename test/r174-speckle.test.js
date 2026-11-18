'use strict';
// r174: удаление спекл-шума (одиноких/изолированных точек) — radius outlier removal в LAS.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const S = require('../speckle-clean');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function writeLas(file, pts, bbox) {
  const n = pts.length, rl = 34;
  const h = XL.lasHeader({ n, ox: 0, oy: 0, oz: 0, min: bbox.slice(0, 3), max: bbox.slice(3) });
  const body = Buffer.alloc(n * rl);
  for (let i = 0; i < n; i++) {
    const p = pts[i], o = i * rl;
    body.writeInt32LE(Math.round(p.x * 1000), o); body.writeInt32LE(Math.round(p.y * 1000), o + 4); body.writeInt32LE(Math.round(p.z * 1000), o + 8);
    body.writeUInt16LE(100, o + 12); body[o + 14] = 9;
    body.writeDoubleLE(p.t || 0, o + 20);
    body.writeUInt16LE(200, o + 28); body.writeUInt16LE(150, o + 30); body.writeUInt16LE(100, o + 32);
  }
  fs.writeFileSync(file, Buffer.concat([h, body]));
}
function readLas(file) {
  const b = fs.readFileSync(file), n = b.readUInt32LE(107), off = b.readUInt32LE(96), rl = b.readUInt16LE(105);
  const sx = b.readDoubleLE(131), ox = b.readDoubleLE(155), oy = b.readDoubleLE(163), oz = b.readDoubleLE(171), pts = [];
  for (let i = 0, q = off; i < n; i++, q += rl) pts.push({ x: b.readInt32LE(q) * sx + ox, y: b.readInt32LE(q + 4) * sx + oy, z: b.readInt32LE(q + 8) * sx + oz, t: b.readDoubleLE(q + 20), r: b.readUInt16LE(q + 28) });
  return { n, pts };
}

test('r174: radius-чистка удаляет спекл, сохраняет поверхность, цвет/время/шапку', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r174-'));
  const src = path.join(d, 'in.las'), dst = path.join(d, 'out.las');
  const pts = [];
  // плотная плоскость x=0, сетка 2 см (10×10 м, z 0..5)
  for (let iy = 0; iy < 500; iy++) for (let iz = 0; iz < 250; iz++) pts.push({ x: 0, y: iy * 0.02, z: iz * 0.02, t: 100 + iy * 0.001 });
  const planeN = pts.length;
  // 300 одиноких спеклов далеко от поверхности
  for (let i = 0; i < 300; i++) pts.push({ x: -1 - i * 0.05, y: 1 + i * 0.013, z: 2 + i * 0.017, t: 200 });
  writeLas(src, pts, [-16, 0, 0, 0.1, 10, 5]);
  const st = S.cleanLas(src, dst, { cell: 0.05, minNeighbors: 4 });
  assert.ok(st.removed >= 295 && st.removed <= 300, JSON.stringify(st));
  assert.ok(st.removedFrac < 0.005, 'потеря поверхности должна быть <0.5%: ' + st.removedFrac);
  const L = readLas(dst);
  assert.strictEqual(L.n, pts.length - st.removed);
  // поверхность на месте: все точки плоскости остались
  const planeKept = L.pts.filter(p => Math.abs(p.x) < 0.01).length;
  assert.strictEqual(planeKept, planeN, 'плоскость должна сохраниться полностью');
  // запись заголовка/цвета корректна
  assert.strictEqual(L.pts[0].r, 200);
  assert.ok(L.pts[0].t >= 100);
});

test('r174: опция clean-outliers в pipeline и CLI', () => {
  const xl = read('xbin-lidar.js');
  assert.match(xl, /cleanOutliers: false/);
  assert.match(xl, /speckle: speckleInfo/);
  assert.match(xl, /require\('\.\/speckle-clean'\)/);
  const tool = read('tools/las-speckle-clean.js');
  assert.match(tool, /S\.cleanLas\(src, dst, opt/);
  assert.ok(fs.existsSync(path.join(ROOT, 'speckle-clean.js')));
});
