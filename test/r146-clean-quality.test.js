'use strict';
// r146: толщина/артефакты на плотной сборке — профиль чистки по плотности, VOXEL-балансировка готового LAS.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const R = require('../scan-refine-core');
const XL = require('../xbin-lidar');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r146: cleanProfile — плотные сборки (>50 млн) чистятся без thin, старые 36–53 млн не меняются', () => {
  const a = R.cleanProfile(36.3e6), b = R.cleanProfile(50e6), c = R.cleanProfile(72.4e6), d = R.cleanProfile(276e6);
  assert.strictEqual(a.dense, false); assert.strictEqual(a.thin, true); assert.strictEqual(a.maxThinShift, 0.02);
  assert.strictEqual(b.dense, true); assert.strictEqual(b.thin, false);
  assert.strictEqual(c.dense, true); assert.strictEqual(c.thin, false);
  assert.strictEqual(d.dense, true); assert.strictEqual(d.thin, false);
  // refine-cli сам применяет профиль (thin по умолчанию для плотных — выключен; если thin включён явно — сдвиг 2 см)
  const cli = read('tools/refine-cli.js');
  assert.match(cli, /R\.cleanProfile\(H\.n\)/);
  assert.match(cli, /if \(opt\.thin === undefined\) opt\.thin = cleanProfile\.thin/);
  assert.match(cli, /opt\.maxThinShift = cleanProfile\.maxThinShift/);
});

// --- минимальный LAS 1.2 fmt3 (для балансировки)
function writeLas(file, pts, bbox) {
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
  for (let i = 0, q = off; i < n; i++, q += rl) pts.push({ x: b.readInt32LE(q) * sx + ox, y: b.readInt32LE(q + 4) * sx + oy, z: b.readInt32LE(q + 8) * sx + oz, rgb: [b.readUInt16LE(q + 28), b.readUInt16LE(q + 30), b.readUInt16LE(q + 32)], t: b.readDoubleLE(q + 20) });
  return { n, pts, sig: b.toString('latin1', 0, 4) };
}

test('r146: las-balance — VOXEL-балансировка готового LAS (cap на воксель, поверхность/разреженное не трогает)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r146-'));
  const src = path.join(d, 'in.las'), dst = path.join(d, 'out.las');
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push({ x: 0, y: 0, z: 0.1, t: 1000 + i * 0.01 });      // плотный «мультипроход»
  for (let i = 0; i < 20; i++) pts.push({ x: 5 + i * 0.05, y: 0, z: 0.1, t: 1000 + i * 0.01 });  // разреженные разные воксели
  writeLas(src, pts, [0, -0.1, 0, 6.1, 0.1, 0.2]);
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'tools/las-balance.js'), src, dst, '{"voxel":0.02,"cap":3}'], { stdio: 'pipe' });
  const L = readLas(dst);
  assert.strictEqual(L.sig, 'LASF');
  assert.ok(L.n < 220, 'точек должно стать меньше: ' + L.n);
  assert.ok(L.n >= 20, 'разреженный участок сохраняется');
  const dense = L.pts.filter(p => Math.abs(p.x) < 0.5).length;
  assert.ok(dense <= 3 * 1, 'в плотном вокселе не больше cap точек: ' + dense);
  assert.ok(L.pts.every(p => p.rgb[0] === 200 && p.t > 999), 'цвет/время сохраняются');
  // балансировка доступна и в сборке (opt.balance), и в CLI для готового LAS
  const xl = read('xbin-lidar.js');
  assert.match(xl, /opt\.balance/);
  assert.match(read('tools/las-balance.js'), /R\.finishLas\(ofd, H, out, bb, wpos\)/);
});
