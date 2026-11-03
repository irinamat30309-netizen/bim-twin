'use strict';
// Ревизия 23: открытие файла .xbin (проект сканера Lixel) — выбор облака в папке проекта, траектория, калибровки, связка с окном.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XP = require('../xbin-project');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function varint(v) { const o = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 128; o.push(b); } while (v); return Buffer.from(o); }
function field(f, wt, body) { return Buffer.concat([varint(f * 8 + wt), wt === 2 ? Buffer.concat([varint(body.length), body]) : body]); }
function imageMsg(tUs, w, h, data) {
  const hdr = field(2, 0, varint(tUs * 2));   // время — zigzag
  return Buffer.concat([field(1, 2, hdr), field(2, 0, varint(3)), field(3, 0, varint(w)), field(4, 0, varint(h)), field(5, 2, data)]);
}
function record(ch, tUs, msgs) {
  const payload = Buffer.concat(msgs.map(m => field(1, 2, m))), h = Buffer.alloc(52);
  h.writeUInt32LE(0, 0); h.writeUInt32LE(payload.length + 52, 4); h.writeUInt16LE(1, 8); h.writeUInt16LE(36, 10); h.writeBigUInt64LE(BigInt(tUs), 12);
  h.writeUInt32LE(payload.length, 20); h.writeUInt32LE(msgs.length, 24); h.writeBigUInt64LE(BigInt(tUs), 28); h.writeBigUInt64LE(BigInt(tUs), 36); h.writeUInt32LE(ch, 44); h.writeUInt32LE(payload.length, 48);
  return Buffer.concat([h, payload]);
}
const CAM_YAML = 'camera.yaml\x1a\x00camera_0:\n  camera_pose:\n' + [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].map(v => '    - ' + v).join('\n') +
  '\n  calibrated: true\n  image_height: 3000\n  image_width: 4000\n  camera_model: kb4\n  intrinsic:\n    - 965.42\n    - 965.23\n    - 1989.28\n    - 1500.83\n  distortion:\n    - -0.031389\n    - 0.001335\n    - -0.002039\n    - 0.000144\n' +
  'camera_1:\n  calibrated: true\n  camera_pose:\n' + [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -0.106, 0, 0, 0, 1].map(v => '    - ' + v).join('\n') +
  '\n  image_height: 3000\n  image_width: 4000\n  camera_model: kb4\n  intrinsic:\n    - 965.88\n    - 965.98\n    - 1994.2\n    - 1498.56\n  distortion:\n    - -0.032945\n    - 0.002484\n    - -0.002691\n    - 0.000264\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x1bextrinsic_camera_motor.yaml\x1a\xc3\x02transform:\n' + [0, 0, -1, 0.03, 0, 1, 0, -0.13, 1, 0, 0, -0.05, 0, 0, 0, 1].map(v => '  - ' + v).join('\n') + '\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x18extrinsic_imu_motor.yaml\x1a\xba\x01transform: [1, 0, 0, 0, 0, 0.43, 0.9, -0.045, 0, -0.9, 0.43, 0.138, 0, 0, 0, 1]\ncalibrated: true\nversion: V3.1.1\n' +
  '\x12\x1aextrinsic_motor_lidar.yaml\x1a\xb5\x01transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0.0146, 0, 0, 0, 1]\ncalibrated: true\nversion: V3.1.1\n';
function makeXbin(file) {
  const head = Buffer.concat([Buffer.from('XBAG\x00\x02\x01\x00', 'latin1'), Buffer.alloc(40), Buffer.from('\n\nLixel L2Pro test\n', 'latin1'), Buffer.from(CAM_YAML, 'latin1')]);
  const recs = [record(0, 1e15, [Buffer.from('config')])];
  const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x3c, 0xac]);
  for (let k = 0; k < 6; k++) {
    const t = 1788422609e6 + k * 400000;
    recs.push(record(1, t, [Buffer.from([0x08, 0x01, 0x10, 0x02])]));   // IMU — не кадры
    recs.push(record(8, t, [imageMsg(t, 4000, 3000, Buffer.concat([sps, Buffer.from('frame8-' + k)]))]));
    recs.push(record(12, t + 1000, [imageMsg(t + 1000, 4000, 3000, Buffer.concat([sps, Buffer.from('frame12-' + k)]))]));
  }
  fs.writeFileSync(file, Buffer.concat([head, ...recs]));
}

// минимальный LAS 1.2: программа, формат точек, число точек
function makeLas(file, software, fmt, n) {
  const rl = [20, 28, 26, 34][fmt], h = Buffer.alloc(227);
  h.write('LASF', 0, 'latin1'); h[24] = 1; h[25] = 2; h.write('TEST', 26, 'latin1'); h.write(software, 58, 'latin1');
  h.writeUInt16LE(227, 94); h.writeUInt32LE(227, 96); h[104] = fmt; h.writeUInt16LE(rl, 105); h.writeUInt32LE(n, 107);
  for (let k = 0; k < 3; k++) h.writeDoubleLE(0.001, 131 + 8 * k);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.alloc(rl * n)]));
}
function project(withStudio, withMap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23x-'));
  makeXbin(path.join(dir, '2026-09-03-110319.xbin'));
  fs.mkdirSync(path.join(dir, 'project_data'));
  let s = ''; for (let k = 0; k <= 600; k++) s += [(1788422609 + k * 0.2).toFixed(6), (k * 0.1).toFixed(3), 0, 0, 0, 0, 0, 1].join(',') + '\n';
  fs.writeFileSync(path.join(dir, 'project_data', 'poses.csv'), s);
  if (withMap) makeLas(path.join(dir, 'map.las'), 'LixelGO realtime', 3, 50);
  if (withStudio) makeLas(path.join(dir, 'fasad (1).las'), 'Xgrids LixelStudio', 3, 80);
  makeLas(path.join(dir, 'map-original.las'), 'BIM Twin backup', 3, 10);
  return dir;
}

test('r23: .xbin — калибровки и сканер из начала файла, траектория project_data/poses.csv, выбор экспорта Lixel Studio', () => {
  const dir = project(true, true);
  try {
    const r = XP.inspect(path.join(dir, '2026-09-03-110319.xbin'));
    assert.strictEqual(r.xbin.cams, 2); assert.strictEqual(r.xbin.camRes, '4000×3000'); assert.ok(r.xbin.photoReady, 'есть калибровки для цвета по фото');
    assert.match(r.xbin.model, /Lixel L2Pro/);
    assert.strictEqual(r.cloud.name, 'fasad (1).las'); assert.strictEqual(r.cloud.kind, 'studio'); assert.strictEqual(r.cloud.points, 80); assert.strictEqual(r.cloud.hasTime, true);
    assert.deepStrictEqual(r.others.map(o => o.name), ['map.las'], 'копия -original.las не предлагается');
    assert.strictEqual(r.others[0].kind, 'realtime');
    assert.strictEqual(r.poses.name, path.join('project_data', 'poses.csv')); assert.strictEqual(r.poses.n, 601);
    assert.ok(Math.abs(r.poses.duration - 120) < 1e-6); assert.ok(Math.abs(r.poses.length - 60) < 1e-6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r23: .xbin — без экспорта берётся map.las, без облака — пусто, чужой файл — ошибка', () => {
  const d1 = project(false, true), d2 = project(false, false);
  try {
    const r1 = XP.inspect(path.join(d1, '2026-09-03-110319.xbin'));
    assert.strictEqual(r1.cloud.name, 'map.las'); assert.strictEqual(r1.cloud.kind, 'realtime');
    fs.unlinkSync(path.join(d2, 'map-original.las'));
    const r2 = XP.inspect(path.join(d2, '2026-09-03-110319.xbin'));
    assert.strictEqual(r2.cloud, null); assert.ok(r2.poses && r2.poses.n === 601);
    fs.writeFileSync(path.join(d2, 'bad.xbin'), 'NOPE');
    assert.throws(() => XP.inspect(path.join(d2, 'bad.xbin')), /XBAG/);
    assert.strictEqual(XP.lasInfo(path.join(d2, 'bad.xbin')), null);
  } finally { fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true }); }
});

test('r23: связка — выбор файла .xbin в окне, проверка доступа в main, мост preload, сборка', () => {
  const html = read('renderer/index.html'), app = read('renderer/app.js'), main = read('main.js'), pre = read('preload.js');
  assert.match(html, /id="modelInput"[^>]*accept="[^"]*\.xbin/);
  assert.match(app, /\/\\\.xbin\$\/i\.test\(file\.name\)[^\n]*__bimOpenXbin\(xp\)/);
  assert.match(app, /window\.__bimOpenXbin = async function/); assert.match(app, /API\.openXbin\(p\)/); assert.match(app, /__bimOpenCloudPath\(c\.path, \{ fresh: true \}\)/);
  assert.match(main, /USER_PICK_EXT_ALLOW = new Set\(\[[^\]]*'\.xbin'/);
  assert.doesNotMatch(main.match(/const CLOUD_EXT_ALLOW = new Set\(\[[^\]]*\]\)/)[0], /xbin/, '.xbin не читается как облако');
  assert.match(main, /ipcMain\.handle\('bim:openXbin'[\s\S]{0,400}resolveAuthorizedFile\(event, [^\n]*new Set\(\['\.xbin'\]\)\)/);
  assert.match(main, /require\('\.\/xbin-project'\)\.inspect\(abs\)/);
  assert.match(pre, /openXbin: \(p\) => inv\('bim:openXbin', \{ path: p \}\)/);
  const pkg = JSON.parse(read('package.json')); assert.ok(pkg.build.files.includes('xbin-project.js'));
});
