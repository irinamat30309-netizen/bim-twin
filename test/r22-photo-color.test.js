'use strict';
// Ревизия 22: цвет по фото сканера (кадры камер из .xbin) — чтение XBAG, калибровки, проекция KB4, z-буфер, маска оператора,
// согласование взглядов; связка main → скрытое окно (preload, WebCodecs) → чистовая обработка и пункт в окне автоочистки.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XB = require('../xbin-core');
const RC = require('../recolor-core');
const S = require('./helpers/r22-photo-scene');
const { writeLas } = require('./helpers/r20-scenes');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- синтетический .xbin: подпись, YAML калибровок, записи кадров (protobuf) двух каналов и «чужой» канал IMU ----
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

test('r22: .xbin — оглавление кадров обеих камер, время, калибровки KB4 и внешние матрицы', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r22x-')), f = path.join(dir, 'scan.xbin');
  try {
    makeXbin(f);
    const X = XB.open(f);
    assert.deepStrictEqual(Object.keys(X.frames).sort(), ['12', '8'], 'кадры — только каналы с H.264');
    assert.strictEqual(X.frames['8'].length, 6); assert.strictEqual(X.frames['12'].length, 6);
    assert.ok(Math.abs(X.frames['8'][1].t - (1788422609 + 0.4)) < 1e-6, 'время кадра — секунды (zigzag мкс)');
    const fd = fs.openSync(f, 'r'); const b = XB.readFrame(fd, X.frames['12'][3]); fs.closeSync(fd);
    assert.strictEqual(b.readUInt32BE(0), 1, 'кадр начинается с 00 00 00 01'); assert.ok(b.toString('latin1').endsWith('frame12-3'));
    const C = X.calib; assert.strictEqual(C.cams.length, 2);
    assert.ok(Math.abs(C.cams[0].fx - 965.42) < 1e-9 && Math.abs(C.cams[1].cy - 1498.56) < 1e-9);
    assert.deepStrictEqual(C.cams[0].d, [-0.031389, 0.001335, -0.002039, 0.000144]);
    assert.strictEqual(C.cams[1].pose[11], -0.106);
    assert.ok(C.camMotor && C.camMotor.length === 16 && C.camMotor[3] === 0.03, 'transform списком «- …»');
    assert.ok(C.imuMotor && C.imuMotor.length === 16 && C.imuMotor[11] === 0.138, 'transform в скобках [ … ]');
    assert.ok(C.motorLidar && C.motorLidar[11] === 0.0146);
    assert.strictEqual(XB.findNear(path.join(dir, 'map.las')), f, '.xbin находится рядом с облаком');
    assert.throws(() => { fs.writeFileSync(path.join(dir, 'bad.xbin'), 'NOPE'); XB.open(path.join(dir, 'bad.xbin')); }, /XBAG/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r22: траектория с ориентацией (slerp), жёсткие матрицы, проекция KB4 и выборка I420', () => {
  const P = RC.parsePoses('t,x,y,z,qx,qy,qz,qw\n0,0,0,0,0,0,0,1\n1,2,0,0,0,0,0.7071068,0.7071068\n');
  assert.strictEqual(P.n, 2);
  const M = RC.poseAt(P, 0.5);
  assert.ok(Math.abs(M[3] - 1) < 1e-9, 'положение — линейно');
  const a = Math.PI / 4;   // поворот на 45° вокруг z
  assert.ok(Math.abs(M[0] - Math.cos(a)) < 1e-6 && Math.abs(M[4] - Math.sin(a)) < 1e-6, 'ориентация — slerp');
  const I = RC.mul4(M, RC.invRigid(M)); for (let i = 0; i < 16; i++) assert.ok(Math.abs(I[i] - (i % 5 === 0 ? 1 : 0)) < 1e-9);
  const R = { fx: 100, fy: 100, cx: 200, cy: 150, d: [0, 0, 0, 0] }, uv = new Float64Array(3);
  RC.projectKB4(R, 0, 0, 1, uv); assert.deepStrictEqual([uv[0], uv[1], uv[2]], [200, 150, 0]);
  RC.projectKB4(R, 1, 0, 0, uv); assert.ok(Math.abs(uv[0] - (200 + 100 * Math.PI / 2)) < 1e-9 && Math.abs(uv[2] - Math.PI / 2) < 1e-12, 'равноугольная проекция θ·f');
  const img = { w: 4, h: 4, Y: new Uint8Array(16).fill(126), U: new Uint8Array(4).fill(128), V: new Uint8Array(4).fill(128), sY: 4, sU: 2, fullRange: false }, c = new Float64Array(3);
  assert.ok(RC.sampleRGB(img, 1.5, 1.5, c)); assert.ok(Math.abs(c[0] - 128) < 0.5 && Math.abs(c[2] - 128) < 0.5, 'limited range: Y 126 → ~128');
  assert.strictEqual(RC.sampleRGB(img, 3.5, 1, c), false, 'за краем кадра — нет цвета');
  // согласование взглядов: выброс (пурпурный оператор) отпадает, согласованные усредняются
  const q = new Float32Array([0.9, 0.8, 1.0]), cc = new Uint32Array([100 | 50 << 8 | 40 << 16, 104 | 52 << 8 | 44 << 16, 250 | 0 << 8 | 250 << 16]), o = new Float64Array(3);
  assert.ok(RC.resolveColor(q, cc, 0, 3, 75, o)); assert.ok(o[0] > 99 && o[0] < 105 && o[1] < 60, 'одиночный выброс не побеждает два согласованных взгляда');
});

test('r22: камеры из калибровки — T_imu_cam0 = E_IM · inv(E_CM), вторая камера через camera_pose', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r22r-')), f = path.join(dir, 'scan.xbin');
  try {
    makeXbin(f); const X = XB.open(f), RG = RC.rigs(X.calib, Object.keys(X.frames));
    assert.deepStrictEqual(RG.map(r => r.ch), [8, 12], 'меньший канал — camera_0');
    const E = RC.mul4(Float64Array.from(X.calib.imuMotor), RC.invRigid(Float64Array.from(X.calib.camMotor)));
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(RG[0].T[i] - E[i]) < 1e-12);
    const E1 = RC.mul4(E, Float64Array.from(X.calib.cams[1].pose)); for (let i = 0; i < 16; i++) assert.ok(Math.abs(RG[1].T[i] - E1[i]) < 1e-12);
    assert.throws(() => RC.rigs({ cams: X.calib.cams, camMotor: null, imuMotor: null }, ['8']), /extrinsic/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function runScene(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r22s-')), src = path.join(dir, 'in.las'), dst = path.join(dir, 'out.las');
  const C = S.cloud(5); writeLas(src, C.pts, C.rgb);
  const frames = S.frames(o.fps || 5), cache = new Map();
  const index = { path: null, calib: S.calib(), frames: { 8: frames } };
  let decoded = 0;
  const st = await RC.recolor(src, dst, { index, posesText: o.posesText || S.posesText(), tmpDir: dir, opt: Object.assign({ cell: 4, dMax: 12 }, o.opt || {}),
    readFrame: (f) => Buffer.from([f.off]), decode: async (bytes, f) => { decoded++; const k = bytes[0]; if (!cache.has(k)) cache.set(k, S.render(frames[k].t)); return cache.get(k); } });
  const B = fs.readFileSync(dst); const n = C.n, out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = B.readUInt16LE(227 + i * 34 + 28 + a * 2) / 256;
  const srcB = fs.readFileSync(src);
  fs.rmSync(dir, { recursive: true, force: true });
  return { st, C, out, decoded, sameOther: srcB.subarray(0, 227).equals(B.subarray(0, 227)) && (() => { for (let i = 0; i < n; i++) { const p = 227 + i * 34; if (!srcB.subarray(p, p + 28).equals(B.subarray(p, p + 28))) return false; } return true; })() };
}

test('r22: перекраска по кадрам — цвет поверхностей как на фото, без заслонённого ящика и оператора', async () => {
  const { st, C, out, sameOther } = await runScene();
  assert.ok(sameOther, 'координаты, время и прочие поля записей не меняются — только RGB');
  assert.ok(st.corr > 0.5, 'фото совпадают с облаком: ' + st.corr);
  assert.ok(st.colored > 0.75 * C.n, 'перекрашено ' + st.colored + ' из ' + C.n);
  let errNew = 0, errOld = 0, m = 0, red = 0, behind = 0, mag = 0, nFloor = 0;
  for (let i = 0; i < C.n; i++) {
    const x = C.pts[i * 4], y = C.pts[i * 4 + 1], z = C.pts[i * 4 + 2], tc = S.trueColor(x, y, z), k = C.kind[i];
    const r = out[i * 3], g = out[i * 3 + 1], b = out[i * 3 + 2];
    if (r > 200 && b > 200 && g < 60) mag++;
    if (k === 1) nFloor++;
    if (k !== 0) continue;
    // стена вдали от швов клетки (на шве цвет смешан фильтром)
    const fy = (y * 4 + 100) % 1, fz = (z * 4 + 100) % 1; if (fy < 0.15 || fy > 0.85 || fz < 0.15 || fz > 0.85) continue;
    m++; errNew += Math.abs(r - tc[0]) + Math.abs(g - tc[1]) + Math.abs(b - tc[2]);
    errOld += Math.abs(C.rgb[i * 3] - tc[0]) + Math.abs(C.rgb[i * 3 + 1] - tc[1]) + Math.abs(C.rgb[i * 3 + 2] - tc[2]);
    if (Math.abs(y) < 0.4 && z < -0.45) { behind++; if (r > 200 && g < 50 && b < 50) red++; }
  }
  errNew /= 3 * m; errOld /= 3 * m;
  assert.ok(errNew < 12, 'ошибка цвета стены ' + errNew.toFixed(1) + ' (было ' + errOld.toFixed(1) + ')');
  assert.ok(errNew < errOld / 4);
  assert.ok(behind > 50 && red / behind < 0.02, 'стена за ящиком не красится в цвет ящика: ' + red + ' из ' + behind);
  assert.ok(mag < 0.005 * C.n, 'пурпурный «оператор» в облако не попадает: ' + mag);
  assert.ok(st.masked[0] > 10, 'ячейки оператора замаскированы: ' + st.masked[0]);
  // передняя грань ящика — красная
  let br = 0, bn = 0; for (let i = 0; i < C.n; i++) if (C.kind[i] === 2) { bn++; if (out[i * 3] > 190 && out[i * 3 + 1] < 60) br++; }
  assert.ok(br > 0.8 * bn, 'ящик красный: ' + br + ' из ' + bn);
});

test('r22: чужая траектория / не та съёмка — ошибка с понятной причиной, исходный файл не меняется', async () => {
  // траектория сдвинута на 1,5 м вбок — фото не совпадают с облаком
  const bad = S.posesText().split('\n').filter(Boolean).map(l => { const a = l.split(','); a[1] = String(+a[1] + 1.5); a[3] = String(+a[3] + 0.8); return a.join(','); }).join('\n');
  await assert.rejects(runScene({ posesText: bad }), /не совпадают|корреляц/);
  await assert.rejects(runScene({ posesText: '0,0,0,0\n1,1,0,0\n' }), /ориентаци/);
});

test('r22: связка — main (поиск .xbin, скрытое окно без nodeIntegration), preload окна (WebCodecs), окно автоочистки, сборка', () => {
  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\('bim:findXbin'/); assert.match(main, /ipcMain\.handle\('bim:pickXbin'/);
  const win = main.slice(main.indexOf('function runPhotoRecolor'), main.indexOf('function runPhotoRecolor') + 4000);
  assert.match(win, /contextIsolation: true/); assert.match(win, /nodeIntegration: false/); assert.match(win, /show: false/);
  assert.match(win, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/); assert.match(win, /will-navigate/);
  assert.match(win, /e\.sender === win\.webContents/, 'сообщения окна принимаются только от него самого');
  const ref = main.slice(main.indexOf("ipcMain.handle('bim:refineScan'"), main.indexOf("ipcMain.on('bim:cancelRefineScan'"));
  assert.match(ref, /runPhotoRecolor\(/); assert.match(ref, /srcForRefine/); assert.match(ref, /photoWarning/);
  assert.match(main.slice(main.indexOf("ipcMain.on('bim:cancelRefineScan'")), /job\.recolorStop/);
  const html = read('recolor-host.html'); assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /<script/);
  const pre = read('recolor-host-preload.js'); assert.match(pre, /new VideoDecoder/); assert.match(pre, /EncodedVideoChunk\(\{ type: 'key'/); assert.match(pre, /recolor:done/);
  assert.match(read('preload.js'), /findXbin: \(payload\) => inv\('bim:findXbin'/);
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /key: 'photo', main: !!xb, label: 'Цвет по фото'/); assert.match(ui, /photo: photo, xbinPath: xbinPath/); assert.match(ui, /api\.pickXbin\(\)/);
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['xbin-core.js', 'recolor-core.js', 'recolor-host.html', 'recolor-host-preload.js']) assert.ok(pkg.build.files.includes(f), f + ' в сборке');
});
