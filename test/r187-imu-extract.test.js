'use strict';
// r187: полное извлечение IMU (accel+gyro+время) из .xbin + статистика/синхронизация/self-test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const L = require('../xbin-imu');
const TOOL = require('../tools/xbin-imu-dump.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- protobuf-кодирование для синтетического IMU-сообщения
function varint(v, out) {
  let x = Math.floor(v);
  while (x >= 0x80) { out.push((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
  out.push(x & 0x7f);
}
const tag = (f, wt, out) => varint(f * 8 + wt, out);
const zz = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);   // zigzag encode
function fieldVarint(f, v, out) { tag(f, 0, out); varint(zz(v), out); }
function fieldBytes(f, bytes, out) { tag(f, 2, out); varint(bytes.length, out); out.push(...bytes); }

function makeImuMsg({ seq, tUS, periodUS, ax1e4, ay1e4, az1e4, gx1e4, gy1e4, gz1e4 }) {
  const hdr = [];
  fieldVarint(1, seq, hdr); fieldVarint(2, tUS, hdr); fieldVarint(3, periodUS, hdr);
  const msg = [];
  fieldBytes(1, hdr, msg);
  fieldVarint(2, ax1e4, msg); fieldVarint(3, ay1e4, msg); fieldVarint(4, az1e4, msg);
  fieldVarint(5, gx1e4, msg); fieldVarint(6, gy1e4, msg); fieldVarint(7, gz1e4, msg);
  return { buf: Buffer.from(msg), a: 0, e: msg.length };
}

test('r187: parseImuMsg извлекает accel, gyro, timestamp и период (без потерь)', () => {
  // t = 1788422602.935447 c, период 10 мс, accel ≈ (0.1257, 0.0905, 9.8172), gyro ≈ (0.0019,0.0034,0.0025)
  const m = makeImuMsg({ seq: 740, tUS: 1788422602935447, periodUS: 10000, ax1e4: 1257, ay1e4: 905, az1e4: 98172, gx1e4: 19, gy1e4: 34, gz1e4: 25 });
  const r = XL.parseImuMsg(m.buf, m.a, m.e);
  assert.ok(r, 'parseImuMsg должен разобрать сообщение');
  assert.strictEqual(r.t, 1788422602.935447);
  assert.ok(Math.abs(r.ax - 0.1257) < 1e-9);
  assert.ok(Math.abs(r.ay - 0.0905) < 1e-9);
  assert.ok(Math.abs(r.az - 9.8172) < 1e-9);
  assert.ok(Math.abs(r.gx - 0.0019) < 1e-9);
  assert.ok(Math.abs(r.gy - 0.0034) < 1e-9);
  assert.ok(Math.abs(r.gz - 0.0025) < 1e-9);
  assert.strictEqual(r.period, 0.01);
});

test('r187: scan() сохраняет accel (imu.a) наряду с gyro (imu.g) и временем', () => {
  const src = read('xbin-lidar.js');
  assert.match(src, /const lidar = \[\], mt = \[\], mc = \[\], ms = \[\], it = \[\], ig = \[\], ia = \[\]/);
  assert.match(src, /ia\.push\(m\.ax, m\.ay, m\.az\)/);
  assert.match(src, /IA\[j \* 3\] = ia\[i \* 3\]/);
  assert.match(src, /imu: \{ t: IT, g: IG, a: IA, temp: null \}/);
  assert.match(src, /period = zz\(y\.v\) \/ 1e6/);
});

test('r187: stats — частота, пропуски, диапазоны, |g|, шум', () => {
  const rate = 200, n = 4001, T = new Float64Array(n), G = new Float64Array(n * 3), A = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    T[i] = 1788422600 + i / rate;
    G[i * 3] = 0.002; G[i * 3 + 1] = -0.004; G[i * 3 + 2] = 0.001;
    A[i * 3] = 0.02; A[i * 3 + 1] = -0.01; A[i * 3 + 2] = 9.80665;
  }
  T[n - 1] += 0.5;   // пропуск в конце
  const st = L.stats({ t: T, g: G, a: A });
  assert.strictEqual(st.samples, n);
  assert.ok(Math.abs(st.rate_hz - rate) < 6, 'rate ' + st.rate_hz);   // в конце добавлен пропуск 0.5 с
  assert.strictEqual(st.gaps, 1);
  assert.ok(st.max_gap_ms >= 500);
  assert.ok(Math.abs(st.accel.abs_mean - 9.8067) < 0.01, '|g| ' + st.accel.abs_mean);
  assert.ok(st.accel.x.noise >= 0 && st.gyro.z.noise >= 0);
  const b = L.staticBias({ t: T, g: G, a: A });
  assert.ok(b.bias, 'bias на статике должен найтись');
  assert.ok(Math.abs(b.bias[0] - 0.002) < 1e-6 && Math.abs(b.bias[1] + 0.004) < 1e-6);
});

test('r187: syncPoses находит временной сдвиг по корреляции интеграла гироскопа с yaw', () => {
  const rate = 200, dur = 20, n = rate * dur + 1, t0 = 1788423000;
  const T = new Float64Array(n), G = new Float64Array(n * 3), A = new Float64Array(n * 3);
  const yaw = (t) => 0.5 * Math.sin(0.4 * t) + 0.2 * Math.sin(1.1 * t + 0.3);
  const yawRate = (t) => 0.5 * 0.4 * Math.cos(0.4 * t) + 0.2 * 1.1 * Math.cos(1.1 * t + 0.3);
  for (let i = 0; i < n; i++) { const tt = t0 + i / rate; T[i] = tt; G[i * 3 + 2] = yawRate(tt - t0); A[i * 3 + 2] = 9.80665; }
  const trueShift = 0.083;   // позы запаздывают: poseYaw(t) = imuYaw(t - trueShift)
  const rows = ['t,x,y,z,qx,qy,qz,qw'];
  for (let tt = t0 + 0.2; tt <= t0 + dur - 0.2; tt += 0.2) {
    const y = yaw(tt - t0 - trueShift), qz = Math.sin(y / 2), qw = Math.cos(y / 2);
    rows.push([tt.toFixed(6), 0, 0, 0, 0, 0, qz.toFixed(9), qw.toFixed(9)].join(','));
  }
  const sy = L.syncPoses({ t: T, g: G, a: A }, rows.join('\n'), { maxShift: 0.5, step: 0.002 });
  assert.ok(sy.shift_ms != null, 'сдвиг должен определиться');
  assert.ok(Math.abs(sy.shift_ms + trueShift * 1000) < 12, 'сдвиг ' + sy.shift_ms + ' мс (ожидалось -' + trueShift * 1000 + ')');
  assert.ok(sy.corr > 0.9, 'корреляция ' + sy.corr);
});

test('r187: NPZ-выгрузка валидна (zip/npy float64), CSV-заголовок с temp', () => {
  const tmp = path.join(os.tmpdir(), 'r187-test-' + process.pid + '.npz');
  const n = 5, t = Float64Array.from({ length: n }, (_, i) => i), g = new Float64Array(n * 3), a = new Float64Array(n * 3);
  TOOL.writeNpz(tmp, { t, g, a });
  const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'локальный заголовок zip');
  assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'EOCD');
  const names = buf.toString('latin1');
  assert.ok(names.includes('t.npy') && names.includes('g.npy') && names.includes('a.npy'));
  const csv = path.join(os.tmpdir(), 'r187-test-' + process.pid + '.csv');
  TOOL.toCsv({ t: [1, 2], g: [0, 0, 0, 0, 0, 0], a: [0, 0, 9.8, 0, 0, 9.8] }, csv);
  const txt = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/);
  fs.unlinkSync(csv);
  assert.strictEqual(txt[0], 't,gx,gy,gz,ax,ay,az,temp');
  assert.strictEqual(txt.length, 3);
});
