'use strict';
// r145: качество сборки из .xbin — VOXEL-балансировка плотности (opt.balance), плотность без прореживания
// (XBIN_DENSITY.all → step 1), авто-включение dynamicRepass для длинных сканов.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// --- мини-конструктор .xbin (как в r24/r133)
function varint(v) { const o = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 128; o.push(b); } while (v); return Buffer.from(o); }
const zz = v => (v >= 0 ? 2 * v : -2 * v - 1);
function field(f, wt, body) { return Buffer.concat([varint(f * 8 + wt), wt === 2 ? Buffer.concat([varint(body.length), body]) : body]); }
const vf = (f, v) => field(f, 0, varint(v));
function record(ch, tUs, msgs) {
  const payload = Buffer.concat(msgs.map(m => field(1, 2, m))), h = Buffer.alloc(52);
  h.writeUInt32LE(0, 0); h.writeUInt32LE(payload.length + 52, 4); h.writeUInt16LE(1, 8); h.writeUInt16LE(36, 10); h.writeBigUInt64LE(BigInt(tUs), 12);
  h.writeUInt32LE(payload.length, 20); h.writeUInt32LE(msgs.length, 24); h.writeBigUInt64LE(BigInt(tUs), 28); h.writeBigUInt64LE(BigInt(tUs), 36); h.writeUInt32LE(ch, 44); h.writeUInt32LE(payload.length, 48);
  return Buffer.concat([h, payload]);
}
const EIM = [0.9988865, -0.02510764, -0.03994153, 0, 0.04684046, 0.4267802, 0.9031417, -0.04478, -0.005629497, -0.9040069, 0.427481, 0.13772, 0, 0, 0, 1];
const EML = [0.9999903, -0.004395619, 0, 0, 0.004395619, 0.9999903, 0.0001307034, 0, -5.745225e-7, -0.0001307022, 1, 0.0146, 0, 0, 0, 1];
const YAML = 'camera.yaml\x1a\x00camera_0:\n  intrinsic:\n    - 965\n    - 965\n    - 1989\n    - 1500\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x18extrinsic_imu_motor.yaml\x1a\xba\x01transform: [' + EIM.join(', ') + ']\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x1aextrinsic_motor_lidar.yaml\x1a\xb5\x01transform: [' + EML.join(', ') + ']\ncalibrated: true\nversion: V3.1.1\n';
const T0 = 1788422609, W = 3.1;
const phiAt = t => 0.4 + W * (t - T0);
function poseAt(t) { const d = t - T0, a = 0.2 * d; return { R: [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1], p: [0.5 * d, 0.1, 1.2] }; }
function posesCsv(t0, t1) {
  const out = ['# t,x,y,z,qx,qy,qz,qw'];
  for (let t = t0; t <= t1 + 1e-9; t += 0.2) { const d = t - T0, a = 0.2 * d; out.push([t.toFixed(6), (0.5 * d).toFixed(6), '0.100000', '1.200000', 0, 0, Math.sin(a / 2).toFixed(9), Math.cos(a / 2).toFixed(9)].join(',')); }
  return out.join('\n') + '\n';
}
const mulV = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + M[3], M[4] * v[0] + M[5] * v[1] + M[6] * v[2] + M[7], M[8] * v[0] + M[9] * v[1] + M[10] * v[2] + M[11]];
function inv4(M) { const R = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]]; const t = [M[3], M[7], M[11]]; const it = [-(R[0] * t[0] + R[1] * t[1] + R[2] * t[2]), -(R[3] * t[0] + R[4] * t[1] + R[5] * t[2]), -(R[6] * t[0] + R[7] * t[1] + R[8] * t[2])]; return [R[0], R[1], R[2], it[0], R[3], R[4], R[5], it[1], R[6], R[7], R[8], it[2], 0, 0, 0, 1]; }
function worldToLidar(w, t) {
  const P = poseAt(t); const d = [w[0] - P.p[0], w[1] - P.p[1], w[2] - P.p[2]];
  const m = [P.R[0] * d[0] + P.R[3] * d[1] + P.R[6] * d[2], P.R[1] * d[0] + P.R[4] * d[1] + P.R[7] * d[2], P.R[2] * d[0] + P.R[5] * d[1] + P.R[8] * d[2]];
  const q = mulV(inv4(EIM), m); const ph = phiAt(t), c = Math.cos(ph), s = Math.sin(ph);
  const r = [c * q[0] - s * q[2], q[1], s * q[0] + c * q[2]];
  return mulV(inv4(EML), r);
}
function scenePoint(k) { const u = (k * 0.618034) % 1, v = (k * 0.414214) % 1, side = k % 5;
  if (side === 0) return [-10, -10 + 20 * u, 6 * v]; if (side === 1) return [10, -10 + 20 * u, 6 * v]; if (side === 2) return [-10 + 20 * u, -10, 6 * v]; if (side === 3) return [-10 + 20 * u, 10, 6 * v]; return [-10 + 20 * u, -10 + 20 * v, 0]; }
function lidarMsg(seq, tUs, pts) {
  const hdr = Buffer.concat([vf(1, seq), vf(2, zz(tUs)), vf(3, 2000)]);
  const body = [field(1, 2, hdr)];
  for (const p of pts) {
    const parts = [];
    if (p.x) parts.push(vf(1, zz(p.x))); if (p.y) parts.push(vf(2, zz(p.y))); if (p.z) parts.push(vf(3, zz(p.z)));
    if (p.i) parts.push(vf(4, p.i)); if (p.r) parts.push(vf(5, p.r)); if (p.dt) parts.push(vf(6, zz(p.dt)));
    body.push(field(2, 2, Buffer.concat(parts)));
  }
  return Buffer.concat(body);
}
function motorMsg(tUs) { const h = (phiAt(tUs / 1e6)) / 2; return Buffer.concat([field(1, 2, Buffer.concat([vf(1, 1), vf(2, zz(tUs))])), vf(3, 989500000), vf(5, zz(Math.round(Math.cos(h) * 1e10))), vf(7, zz(Math.round(Math.sin(h) * 1e10)))]); }
// сцена: стены + в каждом пакете DUP точек в одну точку мира (0,0,1) — «плотный мультипроход» для балансировки
function makeXbin(file, o) {
  o = o || {}; const secs = o.secs || 2, dup = o.dup || 0;
  const recs = [Buffer.concat([Buffer.from('XBAG\x00\x02\x01\x00', 'latin1'), Buffer.alloc(40), Buffer.from('\n\nLixel L2Pro test PandarXT-32\nlidar_type: hesai_lidar\n', 'latin1'), Buffer.from(YAML, 'latin1')])];
  recs.push(record(0, T0 * 1e6, [Buffer.from('config')]));
  let k = 0, seq = 0;
  for (let ms = 0; ms < secs * 1000; ms += 50) {
    const t0us = T0 * 1e6 + ms * 1000;
    const mm = []; for (let j = 0; j < 10; j++) mm.push(motorMsg(t0us + j * 5000)); recs.push(record(4, t0us, mm));
    recs.push(record(1, t0us, [Buffer.from([0x08, 0x01, 0x10, 0x02])]));
    const pts = [];
    for (let j = 0; j < 120; j++) {
      const dt = j * 360, t = (t0us + dt) / 1e6;
      if (j % 10 === 9) { pts.push({ x: 0, y: 0, z: 0, i: 0, r: j % 32, dt }); continue; }
      const w = (dup > 0 && j < dup) ? [0, 0, 1] : scenePoint(k++);
      const l = worldToLidar(w, t);
      pts.push({ x: Math.round(l[0] * 1000), y: Math.round(l[1] * 1000), z: Math.round(l[2] * 1000), i: 10 + (j % 200), r: j % 32, dt });
    }
    recs.push(record(3, t0us, [lidarMsg(seq++, t0us, pts)]));
  }
  fs.writeFileSync(file, Buffer.concat(recs));
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r145-'));
const POSE = () => posesCsv(T0, T0 + 2.2);

test('r145: VOXEL-балансировка плотности (opt.balance) — выравнивает мультипроход, не трогает разреженное', () => {
  assert.strictEqual(XL.DEF.balance, false);
  assert.strictEqual(XL.normalizeBalance(false), null);
  assert.deepStrictEqual(XL.normalizeBalance(true), { voxel: 0.02, cap: 20 });
  assert.throws(() => XL.normalizeBalance({ voxel: 0 }), /voxel/);
  assert.throws(() => XL.normalizeBalance({ cap: 1.5 }), /cap/);
  assert.throws(() => XL.normalizeBalance({ foo: 1 }), /неизвестные/);
  const d = tmpDir(), x = path.join(d, 'b.xbin');
  makeXbin(x, { secs: 2, dup: 40 });
  const S = XL.scan(x);
  const rOff = XL.build(x, POSE(), path.join(d, 'off.las'), { maxPoints: 1e9, index: S, edge: false });
  const rOn = XL.build(x, POSE(), path.join(d, 'on.las'), { maxPoints: 1e9, index: S, edge: false, balance: { voxel: 0.5, cap: 5 } });
  assert.strictEqual(rOff.balance, 0, 'по умолчанию балансировка выключена');
  assert.ok(rOn.balance > 100, 'балансировка должна ограничить плотный участок: ' + rOn.balance);
  assert.ok(rOn.points < rOff.points, 'точек после балансировки меньше: ' + rOn.points + ' vs ' + rOff.points);
  assert.ok(rOn.points > rOff.points * 0.5, 'разреженная часть поверхности сохраняется: ' + rOn.points + ' / ' + rOff.points);
  // поверхности (стены комнаты) остаются — точек вне плотного кластера столько же
  const { execSync } = require('node:child_process');
  const cnt = (f) => { const b = fs.readFileSync(f); const n = b.readUInt32LE(107); return n; };
  assert.ok(cnt(path.join(d, 'on.las')) === rOn.points && cnt(path.join(d, 'off.las')) === rOff.points);
});

test('r145: приоритетные облака собираются без прореживания (XBIN_DENSITY.all → step 1), long-scan repass авто', () => {
  const main = read('main.js'), cli = read('tools/refine-cli.js');
  assert.match(main, /XBIN_DENSITY = \{ normal: 40e6, high: 120e6, all: 0 \}/);
  assert.match(main, /step: density === 'all' \? 1 : 0/);
  assert.match(main, /maxPoints: XBIN_DENSITY\[density\] \|\| 0/);
  // авто dynamicRepass для длинных сканов (>600 с), явные true/false главнее
  assert.match(cli, /const posesDuration = \(text\) =>/);
  assert.match(cli, /auto = dur > 600/);
  assert.match(cli, /if \(opt\.dynamicRepass === false\) return st;/);
  assert.match(cli, /opt\.dynamicRepass !== true/);
  assert.match(cli, /st\.dynamicRepass = \{ dynVoxels: r\.dynVoxels/);
});
