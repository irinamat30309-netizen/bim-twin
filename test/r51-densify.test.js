'use strict';
// Ревизия 51: уплотнение облака по сырому лидару (cloud-densify-core.js): точки лидара прижимаются к плоскости опоры
// того же отрезка времени, добавляются только в пустые ячейки; опора не меняется; источник — LAS или прямо .xbin (пул потоков).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const D = require('../cloud-densify-core');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// генератор .xbin — как в r24-xbin-lidar.test.js; сцена — участок стены x = 3 м и участок пола 0,6 × 0,6 м (плотно)
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
// сцена: стена x = 3 (y 0…0,6, z 0,5…1,1) и пол z = 0 (x 1…1,6, y 0…0,6)
function scenePoint(k) { const u = (k * 0.618034) % 1, v = (k * 0.414214) % 1;
  return k % 2 ? [3, 0.6 * u, 0.5 + 0.6 * v] : [1 + 0.6 * u, 0.6 * v, 0]; }
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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r51-'));
// LAS 1.2 формата 3 из точек { x, y, z, t, c }
function writeLas(f, pts) {
  const h = XL.lasHeader({ n: pts.length, ox: 0, oy: 0, oz: 0, min: [0, 0, 0], max: [1, 1, 1] }), B = Buffer.alloc(pts.length * 34);
  pts.forEach((p, i) => { const q = i * 34; B.writeInt32LE(Math.round(p.x * 1000), q); B.writeInt32LE(Math.round(p.y * 1000), q + 4); B.writeInt32LE(Math.round(p.z * 1000), q + 8);
    B.writeUInt16LE(100, q + 12); B[q + 14] = 9; B[q + 15] = 2; B.writeDoubleLE(p.t, q + 20); for (let a = 0; a < 3; a++) B.writeUInt16LE(p.c[a], q + 28 + a * 2); });
  fs.writeFileSync(f, Buffer.concat([h, B]));
}
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };

test('r51: наименьший собственный вектор 3×3 — нормаль плоскости при любом повороте', () => {
  const out = [0, 0, 0];
  for (let k = 0; k < 50; k++) {
    const n = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], L = Math.hypot(...n); n.forEach((_, i) => { n[i] /= L; });
    // A = I − 0,99·n nᵀ: наименьшее собственное 0,01 с вектором n
    const A = (i, j) => (i === j ? 1 : 0) - 0.99 * n[i] * n[j];
    const l = D.minEig(A(0, 0), A(0, 1), A(0, 2), A(1, 1), A(1, 2), A(2, 2), out);
    assert.ok(Math.abs(l - 0.01) < 1e-9, 'собственное ' + l);
    assert.ok(Math.abs(Math.abs(out[0] * n[0] + out[1] * n[1] + out[2] * n[2]) - 1) < 1e-9);
  }
});

test('r51: snap — шумные точки ложатся на плоскость опоры, общий сдвиг найден, пустые ячейки заполнены один раз, кромка и даль не трогаются', () => {
  // опора: плоскость z = 0,3·x (наклон), шаг 1,5 см, цвет — градиент по x; сырые: шум ±1 см по нормали, сдвиг (0, 0, +1,5 см)
  const G = [], C = [];
  for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) { const x = i * 0.015, y = j * 0.015; G.push(x, y, 0.3 * x); C.push(1000 + 50000 * x, 20000, 30000); }
  const Q = [], nz = 1 / Math.hypot(0.3, 1), nx = -0.3 * nz;
  for (let k = 0; k < 20000; k++) { const x = 0.05 + rnd() * 0.8, y = 0.05 + rnd() * 0.8, e = gauss() * 0.01; Q.push(x + e * nx, y, 0.3 * x + e * nz + 0.015); }
  for (let k = 0; k < 300; k++) Q.push(0.4, 0.4, 2 + k * 0.01);   // далеко от опоры
  const r = D.snap(new Float64Array(G), G.length / 3, new Float32Array(C), new Float64Array(Q), Q.length / 3, { cell: 0.006 });
  assert.ok(r.k > 3000, 'добавлено ' + r.k);
  assert.ok(r.stats.none >= 300, 'дальние точки отброшены: ' + r.stats.none);
  assert.ok(r.stats.dup > 0, 'занятые ячейки пропускаются');
  // сдвиг по нормали: (0,0,0,015)·n = 0,015·nz; найденный сдвиг компенсирует его
  const sn = r.shift[0] * nx + r.shift[2] * nz; assert.ok(Math.abs(sn + 0.015 * nz) < 0.002, 'сдвиг по нормали ' + sn);
  let worst = 0, cells = new Set(), dupl = 0;
  for (let q = 0; q < r.k; q++) {
    const x = r.P[q * 3], y = r.P[q * 3 + 1], z = r.P[q * 3 + 2];
    worst = Math.max(worst, Math.abs((z - 0.3 * x) * nz));
    const key = Math.floor(x / 0.006) + ',' + Math.floor(y / 0.006) + ',' + Math.floor(z / 0.006); if (cells.has(key)) dupl++; cells.add(key);
    const want = 1000 + 50000 * x; assert.ok(Math.abs(r.C[q * 3] - want) < 1500, 'цвет по месту: ' + r.C[q * 3] + ' / ' + want);
    assert.ok(r.src[q] < 20000 && r.nb[q] >= 0);
  }
  assert.ok(worst < 0.002, 'отклонение от плоскости ' + worst);
  assert.strictEqual(dupl, 0, 'в ячейке — не больше одной новой точки');
  // кромка: две перпендикулярные плоскости — точки у ребра (кривизна) не прижимаются
  const G2 = []; for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) { G2.push(i * 0.01, j * 0.01, 0); G2.push(0, j * 0.01, i * 0.01); }
  const Q2 = []; for (let k = 0; k < 2000; k++) Q2.push(0.002 + rnd() * 0.004, 0.05 + rnd() * 0.3, 0.002 + rnd() * 0.004);
  const r2 = D.snap(new Float64Array(G2), G2.length / 3, null, new Float64Array(Q2), Q2.length / 3, { align: false });
  assert.ok(r2.stats.curv > 1500, 'у ребра — отказ по кривизне: ' + JSON.stringify(r2.stats));
  assert.strictEqual(r2.C, null);
});

test('r51: densifyLas из LAS — опора без изменений, новые точки на поверхности со временем сырых, заголовок и рамка, временные файлы удалены', async () => {
  const d = tmpDir(), g = path.join(d, 'g.las'), w = path.join(d, 'raw.las'), out = path.join(d, 'o.las');
  const T = 1788423000, gp = [], rp = [];
  // стена y = 2 (x 0…1, z 0…1): опора — шаг 2 см по 4 отрезкам времени, сырые — плотные шумные (σ 8 мм), время 0…40 с
  for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) gp.push({ x: i * 0.02, y: 2, z: j * 0.02, t: T + ((i * 50 + j) % 40), c: [40000, 30000, 20000] });
  for (let k = 0; k < 40000; k++) rp.push({ x: rnd(), y: 2 + gauss() * 0.008, z: rnd(), t: T + k / 1000, c: [0, 0, 0] });
  rp.push({ x: 0.5, y: 4, z: 0.5, t: T + 40.5, c: [0, 0, 0] });
  writeLas(g, gp); writeLas(w, rp);
  const st = await D.densifyLas(g, out, { lasPath: w }, { tmpDir: d, cell: 0.01 });
  assert.strictEqual(st.guide, gp.length); // r52: общая карта ячеек — новые точки только в ячейки, пустые по всему облаку (сырые этого генератора покрывают ~45 % ячеек 1 см)
  assert.ok(st.added > 2000, 'добавлено ' + st.added); assert.strictEqual(st.points, gp.length + st.added);
  const G = fs.readFileSync(g), O = fs.readFileSync(out);
  assert.strictEqual(O.readUInt32LE(107), st.points); assert.strictEqual(O.length, 227 + st.points * 34);
  assert.ok(G.subarray(227).equals(O.subarray(227, 227 + gp.length * 34)), 'опора — побайтно как была');
  let worst = 0, tOk = 0;
  for (let q = gp.length; q < st.points; q++) {
    const p = 227 + q * 34, y = O.readInt32LE(p + 4) / 1000, t = O.readDoubleLE(p + 20);
    worst = Math.max(worst, Math.abs(y - 2)); if (t >= T && t <= T + 40.5) tOk++;
    assert.strictEqual(O.readUInt16LE(p + 28), 40000); assert.strictEqual(O[p + 15], 2);
  }
  assert.ok(worst <= 0.0015, 'отклонение от стены ' + worst); assert.strictEqual(tOk, st.added);
  assert.ok(O.readDoubleLE(195) <= 2.002 && O.readDoubleLE(203) >= 1.998, 'рамка по y');
  assert.ok(!fs.readdirSync(d).some(f => f.startsWith('.bimtwin-densify-')), 'временная папка удалена');
  await assert.rejects(D.densifyLas(g, path.join(d, 'x.las'), {}, { tmpDir: d }), /нет источника/);
  assert.ok(!fs.existsSync(path.join(d, 'x.las')), 'при ошибке недописанный файл удалён');
});

test('r51: densifyLas прямо из .xbin — один поток и пул потоков дают одинаковый LAS', async () => {
  const d = tmpDir(), x = path.join(d, 's.xbin'), poses = posesCsv(T0, T0 + 2.2);
  makeXbin(x, { secs: 2 });
  const g = path.join(d, 'g.las'); XL.build(x, poses, g, { step: 3, maxPoints: 1e9 });
  const o1 = path.join(d, 'a.las'), o2 = path.join(d, 'b.las'), opt = { tmpDir: d, chunk: 0.5, margin: 3, segChunks: 1, cell: 0.012 };
  const s1 = await D.densifyLas(g, o1, { xbinPath: x, posesText: poses }, Object.assign({ threads: 1 }, opt));
  const s2 = await D.densifyLas(g, o2, { xbinPath: x, posesText: poses }, Object.assign({ threads: 2 }, opt));
  assert.strictEqual(s1.threads, 1); assert.strictEqual(s2.threads, 2);
  assert.ok(s1.added > 50, 'добавлено ' + s1.added + ' ' + JSON.stringify(s1)); assert.ok(s1.raw > 2000);
  assert.ok(fs.readFileSync(o1).equals(fs.readFileSync(o2)), 'LAS совпадает побайтно');
  const L = readLas(o1); let worst = 0;
  for (const p of L.pts.slice(L.n - s1.added)) worst = Math.max(worst, Math.min(Math.abs(p.x - 3) + (p.z > 0.45 ? 0 : 1), Math.abs(p.z) + (p.x < 1.7 ? 0 : 1)));
  assert.ok(worst < 0.003, 'новые точки на стене или полу: ' + worst);
});

test('r51: связка — чистовая обработка уплотняет по .xbin (рядом или от «Цвета по фото»), облако из .xbin не уплотняется, CLI и сборка', () => {
  const w = read('scan-refine-worker.js'), pre = read('recolor-host-preload.js'), cli = read('tools/refine-cli.js'), pkg = JSON.parse(read('package.json'));
  assert.match(w, /function densifySource\(src, tmpDir, o\)/); assert.match(w, /xbin-lidar\/\.test/); assert.match(w, /xbin-source\.txt/); assert.match(w, /findNear\(path\.resolve\(src\)\)/);
  assert.match(w, /require\('\.\/cloud-densify-core'\)\.densifyLas\(out, dOut/); assert.match(w, /densifyWarning/); assert.match(w, /o\.densify === false \|\| o\.noiseLevel === 'inspect'/);
  assert.match(pre, /writeFileSync\(path\.join\(cfg\.tmpDir, 'xbin-source\.txt'\), String\(cfg\.xbin\)\)/);
  assert.match(cli, /cloud-densify-core'\)\.densifyLas\(dst, tmp/);
  assert.ok(pkg.build.files.includes('cloud-densify-core.js')); assert.ok(pkg.build.asarUnpack.includes('cloud-densify-core.js'));
});
