#!/usr/bin/env node
'use strict';
/*
 * tools/xbin-imu-dump.js — r187: выгрузка и проверка IMU из .xbin (accel+gyro+время).
 *
 * Примеры:
 *   node tools/xbin-imu-dump.js --xbin scan.xbin --window 1788423100 1788423220 \
 *        --out D:/tmp/imu.csv --stats --sync poses.csv --bias
 *   node tools/xbin-imu-dump.js --xbin scan.xbin --out imu.npz --stats --json stats.json
 *   node tools/xbin-imu-dump.js --self-test
 *
 * CSV: t,gx,gy,gz,ax,ay,az,temp  (temp = nan — в сообщениях L2 Pro температуры нет)
 * NPZ: массивы t (N), g (N×3), a (N×3) float64 — читается numpy.load.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('../xbin-imu');

function parseArgs(argv) {
  const a = { window: null, out: null, stats: false, sync: null, bias: false, selfTest: false, json: null, xbin: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--xbin') a.xbin = argv[++i];
    else if (k === '--window') { a.window = [Number(argv[++i]), Number(argv[++i])]; }
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--stats') a.stats = true;
    else if (k === '--sync') a.sync = argv[++i];
    else if (k === '--bias') a.bias = true;
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--self-test') a.selfTest = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else if (!a.xbin) a.xbin = k;
  }
  return a;
}

function toCsv(imu, file) {
  const n = imu.t.length, parts = ['t,gx,gy,gz,ax,ay,az,temp\n'];
  for (let i = 0; i < n; i++) {
    parts.push(imu.t[i].toFixed(6) + ',' +
      imu.g[i * 3].toFixed(9) + ',' + imu.g[i * 3 + 1].toFixed(9) + ',' + imu.g[i * 3 + 2].toFixed(9) + ',' +
      imu.a[i * 3].toFixed(9) + ',' + imu.a[i * 3 + 1].toFixed(9) + ',' + imu.a[i * 3 + 2].toFixed(9) + ',nan\n');
    if (parts.length > 200000) { fs.appendFileSync(file, parts.join('')); parts.length = 1; }
  }
  fs.appendFileSync(file, parts.join(''));
}

// ---------- NPZ (zip из .npy float64), без внешних зависимостей
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function npyFloat64(arr) {
  const n = arr.length;
  let hdr = "{'descr': '<f8', 'fortran_order': False, 'shape': (" + n + ",), }";
  const base = 10 + hdr.length + 1;   // magic+ver+len(2)
  const pad = (16 - (base % 16)) % 16;
  hdr = hdr + ' '.repeat(pad) + '\n';
  const head = Buffer.alloc(10 + hdr.length);
  head.write('\x93NUMPY', 0, 'latin1'); head[6] = 1; head[7] = 0;
  head.writeUInt16LE(hdr.length, 8); head.write(hdr, 10, 'latin1');
  const data = Buffer.allocUnsafe(n * 8);
  for (let i = 0; i < n; i++) data.writeDoubleLE(arr[i], i * 8);
  return Buffer.concat([head, data]);
}
function writeNpz(file, arrays) {
  const names = Object.keys(arrays);
  const entries = [];
  const chunks = [];
  let offset = 0;
  for (const name of names) {
    const raw = npyFloat64(arrays[name]);
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name + '.npy', 'latin1');
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28); nameBuf.copy(lh, 30);
    entries.push({ name: nameBuf, crc, comp: comp.length, raw: raw.length, offset });
    chunks.push(lh, comp);
    offset += lh.length + comp.length;
  }
  const cdStart = offset;
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.name.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(e.crc, 16); cd.writeUInt32LE(e.comp, 20); cd.writeUInt32LE(e.raw, 24);
    cd.writeUInt16LE(e.name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt32LE(e.offset, 42); e.name.copy(cd, 46);
    chunks.push(cd); offset += cd.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  fs.writeFileSync(file, Buffer.concat(chunks));
}

// ---------- self-test (синтетика, без файла)
function selfTest() {
  const ok = [];
  const fail = [];
  const chk = (name, cond, info) => { (cond ? ok : fail).push(name + (info ? ': ' + info : '')); };
  // синтетика: 200 Гц, 60 с; yaw-профиль, gyro z = его производная + bias
  const rate = 200, dur = 60, n = rate * dur + 1, t0 = 1788423000;
  const T = new Float64Array(n), G = new Float64Array(n * 3), A = new Float64Array(n * 3);
  const bias = [0.002, -0.004, 0.011];
  const yaw = (t) => 0.4 * Math.sin(0.35 * t) + 0.15 * Math.sin(1.3 * t + 0.7);
  const yawRate = (t) => 0.4 * 0.35 * Math.cos(0.35 * t) + 0.15 * 1.3 * Math.cos(1.3 * t + 0.7);
  for (let i = 0; i < n; i++) {
    const tt = t0 + i / rate; T[i] = tt;
    G[i * 3] = bias[0] + 0.003 * Math.sin(0.1 * tt); G[i * 3 + 1] = bias[1] + 0.002 * Math.cos(0.2 * tt); G[i * 3 + 2] = bias[2] + yawRate(tt - t0);
    A[i * 3] = 0.03 * Math.sin(0.5 * tt); A[i * 3 + 1] = -0.02; A[i * 3 + 2] = 9.80665 + 0.01 * Math.sin(0.7 * tt);
  }
  const st = L.stats({ t: T, g: G, a: A });
  chk('stats.samples', st.samples === n, String(st.samples));
  chk('stats.rate', Math.abs(st.rate_hz - rate) < 0.5, String(st.rate_hz));
  chk('stats.gaps', st.gaps === 0, String(st.gaps));
  chk('stats.abs', Math.abs(st.accel.abs_mean - 9.80665) < 0.05, st.accel.abs_mean.toFixed(4));
  // poses 5 Гц с известной задержкой xbin относительно poses: ~ +137 мс
  const shiftTrue = 0.137, posesText = ['t,x,y,z,qx,qy,qz,qw'];
  const poseYaw = (t) => yaw(t - t0 - shiftTrue);
  for (let tt = t0 + 0.2; tt <= t0 + dur - 0.2; tt += 0.2) {
    const y = poseYaw(tt), qz = Math.sin(y / 2), qw = Math.cos(y / 2);
    posesText.push([tt.toFixed(6), 0, 0, 0, 0, 0, qz.toFixed(9), qw.toFixed(9)].join(','));
  }
  const sync = L.syncPoses({ t: T, g: G, a: A }, posesText.join('\n'), { maxShift: 1.0, step: 0.002 });
  chk('sync.shift', Math.abs(sync.shift_ms + shiftTrue * 1000) < 15, 'получено ' + sync.shift_ms + ' мс (знак: + к времени xbin для совпадения с poses), задано -' + (shiftTrue * 1000) + ' мс');
  chk('sync.corr', sync.corr > 0.95, String(sync.corr));
  const b = L.staticBias({ t: T, g: G, a: A }, { accelTol: 0.3, gyroTol: 0.2, minStaticDur: 0.3 });
  chk('bias', b.bias && Math.abs(b.bias[2] - bias[2]) < 0.03, JSON.stringify(b.bias));
  // NPZ
  const tmp = path.join(require('os').tmpdir(), 'r187-selftest.npz');
  writeNpz(tmp, { t: T.subarray(0, 10), g: G.subarray(0, 30), a: A.subarray(0, 30) });
  const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
  chk('npz.magic', buf[0] === 0x50 && buf[1] === 0x4b, 'PK');
  chk('npz.size', buf.length > 100, String(buf.length));
  const report = { ok: fail.length === 0, passed: ok, failed: fail };
  console.log(JSON.stringify(report, null, 1));
  return fail.length === 0;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log('usage: node tools/xbin-imu-dump.js --xbin file --window t0 t1 --out imu.csv|imu.npz [--stats --sync poses.csv --bias --json out.json] | --self-test'); return 0; }
  if (a.selfTest) return selfTest() ? 0 : 1;
  if (!a.xbin) { console.error('нужно --xbin file (или --self-test)'); return 2; }
  const XL = require('../xbin-lidar');
  const t0 = Date.now();
  const S = XL.scan(a.xbin, () => {});
  const scanMs = Date.now() - t0;
  if (!S.imu || !S.imu.t || !S.imu.t.length) { console.error('IMU не найден в .xbin'); return 3; }
  let imu = { t: S.imu.t, g: S.imu.g, a: S.imu.a };
  if (a.window) imu = L.sliceWindow(imu, a.window[0], a.window[1]);
  const result = { xbin: a.xbin, size: S.size, scan_ms: scanMs, window: a.window, imu_samples: imu.t.length, accel_available: !!imu.a && imu.a.length > 0 };
  if (a.stats || !a.out) result.stats = L.stats(imu);
  if (a.bias) result.bias = L.staticBias(imu);
  if (a.sync) {
    const txt = fs.readFileSync(a.sync, 'utf8');
    result.sync = L.syncPoses(imu, txt, {});
  }
  if (a.out) {
    if (/\.npz$/i.test(a.out)) writeNpz(a.out, { t: imu.t, g: imu.g, a: imu.a });
    else toCsv(imu, a.out);
    result.out = a.out;
  }
  const json = JSON.stringify(result, null, 1);
  if (a.json) fs.writeFileSync(a.json, json);
  console.log(json);
  return 0;
}

module.exports = { writeNpz, toCsv, parseArgs, selfTest };
if (require.main === module) process.exitCode = main();
