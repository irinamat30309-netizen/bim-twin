'use strict';
// Ревизия 24: облако из сырого лидара .xbin — декодер пакетов Hesai, угол мотора (половинный угол в полях 5/7), цепочка калибровок,
// поза по траектории, LAS 1.2 формата 3, прорежение, фильтр дальности, определение каналов, связка с окном.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

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
// калибровки как в L2 Pro (повёрнутый мотор относительно IMU, лидар с небольшим поворотом и сдвигом)
const EIM = [0.9988865, -0.02510764, -0.03994153, 0, 0.04684046, 0.4267802, 0.9031417, -0.04478, -0.005629497, -0.9040069, 0.427481, 0.13772, 0, 0, 0, 1];
const EML = [0.9999903, -0.004395619, 0, 0, 0.004395619, 0.9999903, 0.0001307034, 0, -5.745225e-7, -0.0001307022, 1, 0.0146, 0, 0, 0, 1];
const YAML = 'camera.yaml\x1a\x00camera_0:\n  intrinsic:\n    - 965\n    - 965\n    - 1989\n    - 1500\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x18extrinsic_imu_motor.yaml\x1a\xba\x01transform: [' + EIM.join(', ') + ']\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x1aextrinsic_motor_lidar.yaml\x1a\xb5\x01transform: [' + EML.join(', ') + ']\ncalibrated: true\nversion: V3.1.1\n';
const T0 = 1788422609, W = 3.1;   // угол мотора, рад/с
const phiAt = t => 0.4 + W * (t - T0);
// траектория: движение по x 0,5 м/с и поворот вокруг z 0,2 рад/с
function poseAt(t) { const d = t - T0, a = 0.2 * d; return { R: [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1], p: [0.5 * d, 0.1, 1.2] }; }
function posesCsv(t0, t1) {
  const out = ['# t,x,y,z,qx,qy,qz,qw'];
  for (let t = t0; t <= t1 + 1e-9; t += 0.2) { const d = t - T0, a = 0.2 * d; out.push([t.toFixed(6), (0.5 * d).toFixed(6), '0.100000', '1.200000', 0, 0, Math.sin(a / 2).toFixed(9), Math.cos(a / 2).toFixed(9)].join(',')); }
  return out.join('\n') + '\n';
}
const mulV = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + M[3], M[4] * v[0] + M[5] * v[1] + M[6] * v[2] + M[7], M[8] * v[0] + M[9] * v[1] + M[10] * v[2] + M[11]];
function inv4(M) { const R = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]]; const t = [M[3], M[7], M[11]]; const it = [-(R[0] * t[0] + R[1] * t[1] + R[2] * t[2]), -(R[3] * t[0] + R[4] * t[1] + R[5] * t[2]), -(R[6] * t[0] + R[7] * t[1] + R[8] * t[2])]; return [R[0], R[1], R[2], it[0], R[3], R[4], R[5], it[1], R[6], R[7], R[8], it[2], 0, 0, 0, 1]; }
// мировая точка → лидар в момент t (обратная цепочка)
function worldToLidar(w, t) {
  const P = poseAt(t); const d = [w[0] - P.p[0], w[1] - P.p[1], w[2] - P.p[2]];
  const m = [P.R[0] * d[0] + P.R[3] * d[1] + P.R[6] * d[2], P.R[1] * d[0] + P.R[4] * d[1] + P.R[7] * d[2], P.R[2] * d[0] + P.R[5] * d[1] + P.R[8] * d[2]];
  const q = mulV(inv4(EIM), m); const ph = phiAt(t), c = Math.cos(ph), s = Math.sin(ph);
  const r = [c * q[0] - s * q[2], q[1], s * q[0] + c * q[2]];   // Ry(φ)ᵀ
  return mulV(inv4(EML), r);
}
// сцена: точки на стенах «комнаты» 20×20×6 м
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
function motorMsg(tUs) { const h = (phiAt(tUs / 1e6)) / 2; return Buffer.concat([field(1, 2, Buffer.concat([vf(1, 1), vf(2, zz(tUs))])), vf(3, 989500000), vf(5, zz(Math.round(Math.cos(h) * 1e10))), vf(7, zz(Math.round(Math.sin(h) * 1e10))), vf(9, zz(Math.round(((h % Math.PI) + Math.PI) % Math.PI * 180 / Math.PI * 1e10)))]); }
function makeXbin(file, o) {
  o = o || {}; const lidCh = o.lidarCh || 3, motCh = o.motorCh || 4, secs = o.secs || 2;
  const recs = [Buffer.concat([Buffer.from('XBAG\x00\x02\x01\x00', 'latin1'), Buffer.alloc(40), Buffer.from('\n\nLixel L2Pro test PandarXT-32\nlidar_type: hesai_lidar\n', 'latin1'), Buffer.from(o.noCalib ? 'camera.yaml\x1a\x00camera_0:\n' : YAML, 'latin1')])];
  recs.push(record(0, T0 * 1e6, [Buffer.from('config')]));
  const truth = []; let k = 0, seq = 0;
  for (let ms = 0; ms < secs * 1000; ms += 50) {
    const t0us = T0 * 1e6 + ms * 1000;
    if (!o.noMotor) { const mm = []; for (let j = 0; j < 10; j++) mm.push(motorMsg(t0us + j * 5000)); recs.push(record(motCh, t0us, mm)); }
    recs.push(record(1, t0us, [Buffer.from([0x08, 0x01, 0x10, 0x02])]));
    const pts = [];
    for (let j = 0; j < 120; j++) {
      const dt = j * 360, t = (t0us + dt) / 1e6;
      if (j % 10 === 9) { pts.push({ x: 0, y: 0, z: 0, i: 0, r: j % 32, dt }); continue; }   // нет отражения
      if (j % 10 === 8) { pts.push({ x: 120, y: -50, z: 80, i: 7, r: 3, dt }); continue; }   // ближе 0,5 м — отбрасывается
      const w = scenePoint(k++), l = worldToLidar(w, t);
      const p = { x: Math.round(l[0] * 1000), y: Math.round(l[1] * 1000), z: Math.round(l[2] * 1000), i: 10 + (j % 200), r: j % 32, dt };
      pts.push(p); truth.push({ w, t, i: p.i, r: p.r });
    }
    recs.push(record(lidCh, t0us, [lidarMsg(seq++, t0us, pts)]));
  }
  fs.writeFileSync(file, Buffer.concat(recs));
  return truth;
}
function readLas(f) {
  const b = fs.readFileSync(f), n = b.readUInt32LE(107), off = b.readUInt32LE(96), rl = b.readUInt16LE(105);
  const sx = b.readDoubleLE(131), ox = b.readDoubleLE(155), oy = b.readDoubleLE(163), oz = b.readDoubleLE(171), pts = [];
  for (let i = 0, q = off; i < n; i++, q += rl) pts.push({ x: b.readInt32LE(q) * sx + ox, y: b.readInt32LE(q + 4) * sx + oy, z: b.readInt32LE(q + 8) * sx + oz, i: b.readUInt16LE(q + 12), r: b[q + 17], t: b.readDoubleLE(q + 20), g: b.readUInt16LE(q + 28) });
  return { b, n, fmt: b[104], rl, pts, min: [b.readDoubleLE(187), b.readDoubleLE(203), b.readDoubleLE(219)], max: [b.readDoubleLE(179), b.readDoubleLE(195), b.readDoubleLE(211)], sig: b.toString('latin1', 0, 4) };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r24-'));

test('r24: облако из лидара .xbin совпадает со сценой (мотор, калибровки, траектория), LAS формата 3 со временем', () => {
  const d = tmpDir(), x = path.join(d, 's.xbin'), out = path.join(d, 's-lidar.las');
  const truth = makeXbin(x);
  const S = XL.scan(x);
  assert.strictEqual(S.lidarCh, 3); assert.strictEqual(S.motorCh, 4); assert.strictEqual(S.lidar.length, 40); assert.ok(S.motor.t.length >= 390);
  const r = XL.build(x, posesCsv(T0, T0 + 2.2), out, { maxPoints: 1e9, index: S });
  assert.strictEqual(r.step, 1); assert.strictEqual(r.points, truth.length);
  assert.ok(fs.existsSync(out) && !fs.existsSync(out + '.part'));
  const L = readLas(out); assert.strictEqual(L.sig, 'LASF'); assert.strictEqual(L.fmt, 3); assert.strictEqual(L.rl, 34); assert.strictEqual(L.n, truth.length);
  let worst = 0;
  const byT = new Map(truth.map(p => [Math.round(p.t * 1e6), p]));
  for (const p of L.pts) {
    const q = byT.get(Math.round(p.t * 1e6)); assert.ok(q, 'время точки ' + p.t);
    worst = Math.max(worst, Math.hypot(p.x - q.w[0], p.y - q.w[1], p.z - q.w[2]));
    assert.strictEqual(p.r, q.r); assert.strictEqual(p.i, q.i * 257); assert.strictEqual(p.g, q.i * 257);
  }
  assert.ok(worst < 0.01, 'ошибка положения ' + worst);
  { const RC = require('../recolor-core'); const fd = fs.openSync(out, 'r'); try { const H = RC.readHeader(fd); assert.match(H.soft, /^BIM Twin xbin-lidar/); assert.strictEqual(H.rgb !== undefined && H.tOff !== undefined, true); } finally { fs.closeSync(fd); } }   // мм-округление + линейная поза за пакет
  for (let k = 0; k < 3; k++) { assert.ok(L.min[k] <= Math.min(...L.pts.map(p => [p.x, p.y, p.z][k])) + 1e-3); assert.ok(L.max[k] >= Math.max(...L.pts.map(p => [p.x, p.y, p.z][k])) - 1e-3); }
});

test('r24: прорежение, окно времени, другие номера каналов; без мотора, траектории и калибровок — понятные ошибки', () => {
  const d = tmpDir(), x = path.join(d, 'c.xbin');
  const truth = makeXbin(x, { lidarCh: 7, motorCh: 9 });
  const S = XL.scan(x); assert.strictEqual(S.lidarCh, 7); assert.strictEqual(S.motorCh, 9);
  const r = XL.build(x, posesCsv(T0, T0 + 2.2), path.join(d, 'a.las'), { step: 4, index: S });
  assert.strictEqual(r.step, 4); assert.ok(Math.abs(r.points - truth.length / 4) <= 2);
  const r2 = XL.build(x, posesCsv(T0, T0 + 2.2), path.join(d, 'b.las'), { maxPoints: 200, index: S });
  assert.ok(r2.step > 1 && r2.points <= 400, 'шаг ' + r2.step + ', точек ' + r2.points);
  const r3 = XL.build(x, posesCsv(T0, T0 + 2.2), path.join(d, 'w.las'), { t0: T0 + 0.5, t1: T0 + 1.0, maxPoints: 1e9, index: S });
  const L3 = readLas(path.join(d, 'w.las')); assert.ok(L3.pts.every(p => p.t >= T0 + 0.5 && p.t <= T0 + 1.0)); assert.ok(r3.points > 800 && r3.points < 1100, String(r3.points));
  // траектория короче записи — точки вне неё не попадают
  const r4 = XL.build(x, posesCsv(T0, T0 + 1.0), path.join(d, 'p.las'), { maxPoints: 1e9, index: S }); assert.ok(r4.t1 <= T0 + 1.0 + 1e-6 && r4.points < truth.length * 0.6);
  assert.throws(() => XL.build(x, '', path.join(d, 'n.las'), {}), /траектори/);
  const xm = path.join(d, 'm.xbin'); makeXbin(xm, { noMotor: true }); assert.throws(() => XL.build(xm, posesCsv(T0, T0 + 2.2), path.join(d, 'm.las'), {}), /мотор/);
  const xc = path.join(d, 'k.xbin'); makeXbin(xc, { noCalib: true }); assert.throws(() => XL.build(xc, posesCsv(T0, T0 + 2.2), path.join(d, 'k.las'), {}), /калибровк/);
  assert.ok(!fs.readdirSync(d).some(f => f.endsWith('.part')), 'временные файлы удалены');
  const bad = path.join(d, 'x.xbin'); fs.writeFileSync(bad, 'not xbin'); assert.throws(() => XL.scan(bad), /XBAG/);
});

test('r24: связка — проверка доступа и поток в main, мост preload, диалог и команда в окне, проект без облака, сборка', () => {
  const main = read('main.js'), pre = read('preload.js'), app = read('renderer/app.js'), ext = read('renderer/lixel-tools-ext.js'), cmd = read('renderer/ui/commands.js');
  assert.match(main, /ipcMain\.handle\('bim:xbinBuildCloud'[\s\S]{0,400}resolveAuthorizedFile\(event, String\(a\.path \|\| ''\), new Set\(\['\.xbin'\]\)\)/);
  assert.match(main, /unpackedWorker\('xbin-lidar-worker\.js'\)/); assert.match(main, /ipcMain\.on\('bim:cancelXbinCloud'/);
  assert.match(main, /fs\.rmSync\(partFile, \{ force: true \}\)/); assert.match(main, /grantExistingFile\(sender\.id, target, \{ read: true \}\)/);
  assert.match(pre, /xbinBuildCloud: \(p, jobId, density\) => inv\('bim:xbinBuildCloud'/); assert.match(pre, /cancelXbinCloud:/); assert.match(pre, /'bim:xbinCloudProgress'/);
  assert.match(app, /window\.__bimXbinCloud = async function/); assert.match(app, /!r\.cloud && x\.lidarReady && r\.poses/);
  assert.match(read('recolor-core.js'), /if \(!\(corr >= o\.minCorr\) && !fromXbinLidar\) throw/);   // серое облако из лидара: корреляция с фото — не проверка
  assert.match(ext, /opXbinCloud: opXbinCloud/); assert.match(cmd, /I\('opXbinCloud', 'scan-line', 'Облако из \.xbin'/);
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['xbin-lidar.js', 'xbin-lidar-worker.js']) { assert.ok(pkg.build.files.includes(f), f); assert.ok(pkg.build.asarUnpack.includes(f), f); }
  for (const f of ['xbin-core.js', 'recolor-core.js']) assert.ok(pkg.build.asarUnpack.includes(f), f);
  const XP = require('../xbin-project'); const d = tmpDir(); makeXbin(path.join(d, 'q.xbin'));
  fs.mkdirSync(path.join(d, 'project_data')); fs.writeFileSync(path.join(d, 'project_data', 'poses.csv'), posesCsv(T0, T0 + 2.2));
  const info = XP.inspect(path.join(d, 'q.xbin')); assert.strictEqual(info.xbin.lidarReady, true); assert.strictEqual(info.cloud, null); assert.ok(info.poses && info.poses.n > 5);
});
