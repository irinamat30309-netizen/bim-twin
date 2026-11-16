'use strict';
// r149: scan-matching проходов + fusion (xbin-fusion.js): сдвиг проходов по плоскостям, слияние без прореживания.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const F = require('../xbin-fusion');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

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
  for (let i = 0, q = off; i < n; i++, q += rl) pts.push({ x: b.readInt32LE(q) * sx + ox, y: b.readInt32LE(q + 4) * sx + oy, z: b.readInt32LE(q + 8) * sx + oz, t: b.readDoubleLE(q + 20) });
  return { n, pts };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r149-'));

test('r149: passBounds/passIdOf/solveShift — геометрия проходов и робастный сдвиг', () => {
  assert.deepStrictEqual(F.passBounds(1000, 1025, 20), [[1000, 1020], [1020, 1040]]);
  assert.strictEqual(F.passIdOf(1005, 1000, 20), 0);
  assert.strictEqual(F.passIdOf(1025, 1000, 20), 1);
  // две вертикальные плоскости (x=0.1, y=5) и пол z=0.1; проход смещён на (+0.02, −0.01, +0.03)
  const planes = [{ nx: 1, ny: 0, nz: 0, c: 0.1, n: 1000 }, { nx: 0, ny: 1, nz: 0, c: 5, n: 1000 },
                  { nx: 0, ny: 0, nz: 1, c: 0.1, n: 1000 }];
  const obs = new Map([[planes[0], { median: 0.02, count: 1000 }], [planes[1], { median: -0.01, count: 1000 }],
                       [planes[2], { median: 0.03, count: 1000 }]]);
  const t = F.solveShift(planes, obs);
  assert.ok(Math.abs(t.tx + 0.02) < 1e-9 && Math.abs(t.ty - 0.01) < 1e-9 && Math.abs(t.tz + 0.03) < 1e-9, JSON.stringify(t));
});

test('r149: fusion — два прохода одной сцены сдвигаются к общей плоскости, толщина падает, плотность сохраняется', () => {
  const d = tmpDir(), src = path.join(d, 'in.las'), dst = path.join(d, 'out.las');
  const rnd = (() => { let s = 7; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
  const pts = [];
  const passes = [{ t0: 1000, dx: 0.010, dz: 0.008 }, { t0: 1020, dx: -0.010, dz: -0.008 }];
  for (const P of passes) {
    for (let i = 0; i < 25000; i++) {   // стена x≈0
      pts.push({ x: P.dx + (rnd() - 0.5) * 0.002, y: rnd() * 6, z: rnd() * 3, t: P.t0 + rnd() * 9 });
    }
    for (let i = 0; i < 15000; i++) {   // пол z≈0
      pts.push({ x: rnd() * 6, y: rnd() * 6, z: P.dz + (rnd() - 0.5) * 0.002, t: P.t0 + rnd() * 9 });
    }
    for (let i = 0; i < 10000; i++) {   // вторая стена y≈0
      pts.push({ x: rnd() * 6, y: P.dx * 0.5 + (rnd() - 0.5) * 0.002, z: rnd() * 3, t: P.t0 + rnd() * 9 });
    }
  }
  writeLas(src, pts, [0, 0, 0, 6.1, 6.1, 3.1]);
  const st = F.fuseLas(src, dst, { passSec: 10, minPassPts: 500, band: 0.15, planeBand: 0.02, sample: 200000 });
  assert.ok(st.passes >= 2, JSON.stringify(st));
  assert.ok(st.residualBeforeMm && st.residualAfterMm, JSON.stringify(st));
  assert.ok(st.residualAfterMm.median_sigma_mm < st.residualBeforeMm.median_sigma_mm,
    'разброс проходов должен уменьшиться: ' + JSON.stringify(st.residualAfterMm) + ' vs ' + JSON.stringify(st.residualBeforeMm));
  const L = readLas(dst);
  assert.strictEqual(L.n, pts.length, 'fusion не прореживает: точек столько же');
  // после fusion разброс координат стены относительно x=0 меньше, чем до
  const wallX = L.pts.filter(p => Math.abs(p.y - 3) < 0.2 && p.z > 0.3 && p.z < 2.2).map(p => p.x);
  const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  assert.ok(sd(wallX) * 1000 < 6, 'стена после fusion должна быть тоньше 6 мм: ' + (sd(wallX) * 1000).toFixed(2));
  // сборка включает fusion и пробрасывает статистику
  const xl = read('xbin-lidar.js');
  assert.match(xl, /const wantFusion = o\.fusion === true;/);
  assert.match(xl, /require\('\.\/xbin-fusion'\)/);
  assert.match(xl, /fusion: fusionInfo/);
  assert.match(read('tools/las-fusion.js'), /F\.fuseLas/);
  assert.ok(require('../package.json').build.files.includes('xbin-fusion.js'));
});
