'use strict';
// Ревизия 37: (1) лассо в окне «Перед загрузкой» — контуры «обвести» / «вырезать» (маска клеток одинакова в окне и в main,
// фильтр частей cloud-segments.filterKeep); (2) предел точек после сброса изображения видеокартой и пониженные рекомендации;
// (3) фильтр смешанных отражений и одиночных скачков дальности по кольцу лидара при сборке облака из .xbin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const XL = require('../xbin-lidar');
const CO = require('../cloud-overview');
const Seg = require('../cloud-segments');
const CP = require('../renderer/cloud-preview.js');
const Cap = require('../system-capacity.js');
const GB = 1073741824;

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
function readLas(f) {
  const b = fs.readFileSync(f), n = b.readUInt32LE(107), off = b.readUInt32LE(96), rl = b.readUInt16LE(105);
  const sx = b.readDoubleLE(131), ox = b.readDoubleLE(155), oy = b.readDoubleLE(163), oz = b.readDoubleLE(171), pts = [];
  for (let i = 0, q = off; i < n; i++, q += rl) pts.push({ x: b.readInt32LE(q) * sx + ox, y: b.readInt32LE(q + 4) * sx + oy, z: b.readInt32LE(q + 8) * sx + oz, i: b.readUInt16LE(q + 12), r: b[q + 17], t: b.readDoubleLE(q + 20), g: b.readUInt16LE(q + 28) });
  return { b, n, fmt: b[104], rl, pts, min: [b.readDoubleLE(187), b.readDoubleLE(203), b.readDoubleLE(219)], max: [b.readDoubleLE(179), b.readDoubleLE(195), b.readDoubleLE(211)], sig: b.toString('latin1', 0, 4) };
}

// сцена для фильтра: 4 кольца, у каждого кольца отражения через 50 мкс (0,36° по азимуту), как у Hesai XT-32.
// Кольца 0–2 — стена x = 8 м с ящиком перед ней (x = 5 м) на участке j 150…179; кольцо 3 — пол, уходящий вдаль под острым углом.
// Подмешано: одиночная пылинка (кольцо 1, j = 100), смешанные отражения на краях ящика (кольцо 0, j = 149 и j = 180).
function wallPoint(ring, j) {
  const y = -4 + 8 * j / 250, z = 0.6 + ring * 0.6;
  if (ring === 3) return [2.5 + 0.12 * j, -1 + 0.002 * j, 0];
  if (j >= 150 && j < 180) return [5, y, z];
  return [8, y, z];
}
function makeEdgeXbin(file) {
  const recs = [Buffer.concat([Buffer.from('XBAG\x00\x02\x01\x00', 'latin1'), Buffer.alloc(40), Buffer.from('\n\nLixel L2Pro test PandarXT-32\nlidar_type: hesai_lidar\n', 'latin1'), Buffer.from(YAML, 'latin1')])];
  recs.push(record(0, T0 * 1e6, [Buffer.from('config')]));
  const truth = [], noise = []; let seq = 0;
  for (let ms = 0; ms < 2000; ms += 50) {
    const t0us = T0 * 1e6 + ms * 1000;
    const mm = []; for (let j = 0; j < 10; j++) mm.push(motorMsg(t0us + j * 5000)); recs.push(record(4, t0us, mm));
    recs.push(record(1, t0us, [Buffer.from([0x08, 0x01, 0x10, 0x02])]));
    const pts = [];
    for (let j = 0; j < 250; j++) for (let ring = 0; ring < 4; ring++) {
      const dt = j * 50, t = (t0us + dt) / 1e6;
      let w = wallPoint(ring, j), kind = 'wall';
      if (ring === 1 && j === 100) { const P = poseAt(t).p; w = [P[0] + (w[0] - P[0]) * 0.55, P[1] + (w[1] - P[1]) * 0.55, P[2] + (w[2] - P[2]) * 0.55]; kind = 'dust'; }
      if (ring === 0 && (j === 149 || j === 180)) { w = [6.5, w[1], w[2]]; kind = 'mixed'; }
      const l = worldToLidar(w, t);
      pts.push({ x: Math.round(l[0] * 1000), y: Math.round(l[1] * 1000), z: Math.round(l[2] * 1000), i: 50, r: ring, dt });
      (kind === 'wall' ? truth : noise).push({ w, t, kind, ring, j });
    }
    recs.push(record(3, t0us, [lidarMsg(seq++, t0us, pts)]));
  }
  fs.writeFileSync(file, Buffer.concat(recs));
  return { truth, noise };
}

test('r37: фильтр смешанных отражений и пылинок по кольцу лидара (.xbin → LAS)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r37-')), x = path.join(d, 'e.xbin');
  const { truth, noise } = makeEdgeXbin(x);
  const S = XL.scan(x);
  const on = XL.build(x, posesCsv(T0, T0 + 2.2), path.join(d, 'on.las'), { maxPoints: 1e9, index: S });
  const off = XL.build(x, posesCsv(T0, T0 + 2.2), path.join(d, 'off.las'), { maxPoints: 1e9, index: S, edge: false });
  assert.strictEqual(off.points, truth.length + noise.length, 'без фильтра — все точки');
  assert.strictEqual(off.edge, 0);
  const L = readLas(path.join(d, 'on.las'));
  const near = (p, w) => Math.hypot(p.x - w[0], p.y - w[1], p.z - w[2]) < 0.02;
  // все шумовые точки удалены
  for (const nz of noise) assert.ok(!L.pts.some(p => Math.abs(p.t - nz.t) < 1e-6 && near(p, nz.w)), nz.kind + ' кольцо ' + nz.ring + ' j ' + nz.j + ' осталась');
  // настоящие точки (стена, ящик, пол под острым углом) остаются: удалено не больше шумовых и соседей края ящика
  assert.strictEqual(on.edge, noise.length, 'удалено ' + on.edge + ' вместо ' + noise.length);
  assert.strictEqual(on.points, truth.length);
  // пол под острым углом (кольцо 3) не тронут
  assert.strictEqual(L.pts.filter(p => p.r === 3).length, truth.filter(p => p.ring === 3).length);
  // синтетика r24 (кольца вперемешку через 11 мс) — соседей нет, фильтр ничего не удаляет
  assert.strictEqual(XL.DEF.edge, true, 'фильтр включён по умолчанию');
});

test('r37: лассо — маска контуров одинакова в окне и в main, «вырезать» первым = всё кроме контура', () => {
  const areas = [{ op: 'add', pts: [0, 0, 10, 0, 10, 10, 0, 10] }, { op: 'sub', pts: [2, 2, 5, 2, 5, 5, 2, 5] }, { op: 'add', pts: [20, 20, 25, 20, 22, 26] }];
  const a = CP.areaMaskJS(areas), b = CO.areaMask(areas);
  assert.deepStrictEqual([a.u0, a.v0, a.cell, a.nx, a.ny, a.outsideOn, a.cells], [b.u0, b.v0, b.cell, b.nx, b.ny, b.outsideOn, b.cells]);
  assert.ok(Buffer.from(a.bits).equals(Buffer.from(b.bits)), 'клетки совпадают');
  assert.ok(Math.abs(a.cells * a.cell * a.cell - (100 - 9 + 15)) < 1.5, 'площадь выбора ' + a.cells * a.cell * a.cell);
  assert.strictEqual(CP.inArea(a, 1, 1), true); assert.strictEqual(CP.inArea(a, 3, 3), false); assert.strictEqual(CP.inArea(a, 15, 15), false); assert.strictEqual(CP.inArea(a, 22, 22), true);
  const cut = CO.areaMask([{ op: 'sub', pts: [0, 0, 4, 0, 4, 4, 0, 4] }]);
  assert.strictEqual(cut.outsideOn, 1);
  assert.strictEqual(CP.inArea(cut, 100, -50), true, 'вне контура и вне сетки — выбрано');
  assert.strictEqual(CP.inArea(cut, 2, 2), false);
  // фильтр частей: точки окна (u = x, v = −z)
  const pts = [], N = 20000; for (let i = 0; i < N; i++) { const u = ((i * 0.618034) % 1) * 30 - 2, v = ((i * 0.414214) % 1) * 30 - 2; pts.push(u, 1, -v); }
  const P = new Float32Array(pts);
  const K = Seg.filterKeep(P, N, { area: b, hShift: 0 });
  let exp = 0; for (let i = 0; i < N; i++) if (CP.inArea(b, P[i * 3], -P[i * 3 + 2])) exp++;
  assert.strictEqual(K.kept, exp);
  const K2 = Seg.filterKeep(P, N, { area: cut, hShift: 0 });
  let in4 = 0; for (let i = 0; i < N; i++) { const u = P[i * 3], v = -P[i * 3 + 2]; if (u > 0.1 && u < 3.9 && v > 0.1 && v < 3.9) in4++; }
  assert.ok(N - K2.kept >= in4 && N - K2.kept <= in4 * 1.15 + 20, 'вырезано ' + (N - K2.kept) + ', внутри ' + in4);
  // оценка окна учитывает контуры
  const sample = new Float32Array(N * 3); for (let i = 0; i < N; i++) { sample[i * 3] = P[i * 3]; sample[i * 3 + 1] = -P[i * 3 + 2]; sample[i * 3 + 2] = 1; }
  const e = CP.estimate(sample, 1e6, { area: b }, null);
  assert.ok(Math.abs(e.frac - exp / N) < 1e-9);
  // упрощение контура от руки
  const raw = []; for (let i = 0; i <= 2000; i++) { const t = i / 2000 * Math.PI * 2; raw.push(Math.cos(t) * 5, Math.sin(t) * 5); }
  const sp = CP.simplifyPath(raw, 0.1, 4000); assert.ok(sp.length / 2 < 400 && sp.length / 2 > 250);
  assert.ok(CP.simplifyPath(raw, 0, 500).length / 2 <= 500);
  assert.ok(Math.abs(CP.polyArea(sp) - Math.PI * 25) < 0.5);
});

test('r37: проводка лассо — окно, main, фильтр, подсказки', () => {
  const pv = read('renderer/cloud-preview.js'), main = read('main.js'), seg = read('cloud-segments.js');
  for (const s of ['data-tool="rect"', 'data-tool="add"', 'data-tool="sub"', 'data-act="undoArea"', 'Обвести', 'Вырезать', 'Alt — вырезать', 'destination-out', 'f.areas = st.areas']) assert.ok(pv.includes(s), 'окно: ' + s);
  assert.ok(/view: \{ rect: st\.rect, areas: st\.areas/.test(pv));
  assert.ok(main.includes('cloudOverview.areaMask(areas)') && main.includes('raw.areas.slice(0, 64)') && main.includes('!f.area) return null'));
  assert.ok(seg.includes('area.outsideOn'));
  // недопустимые контуры отбрасываются main: проверим через функцию напрямую — меньше трёх вершин
  assert.strictEqual(CO.areaMask([{ op: 'add', pts: [0, 0, 1, 1] }]), null);
  assert.strictEqual(CO.areaMask([]), null);
});

test('r37: предел точек после сброса видеокарты и рекомендации для RTX 5070 12 ГБ', () => {
  const r = Cap.recommend({ vramTotal: 12 * GB, vramFree: 10.8 * GB, ramTotal: 32 * GB, ramFree: 22 * GB });
  assert.ok(r.points <= 230e6 && r.points >= 150e6, 'рекомендовано ' + r.points);
  assert.ok(r.safeMax <= 320e6 && r.safeMax > r.points, 'максимум ' + r.safeMax);
  const r2 = Cap.recommend({ vramTotal: 12 * GB, vramFree: 10.8 * GB, ramTotal: 32 * GB, ramFree: 22 * GB, gpuResetAt: 300e6 });
  assert.ok(r2.safeMax <= 210e6 && r2.points <= 150e6 && r2.notes.some(n => /сбрасывала/.test(n)));
  const pv = read('renderer/cloud-preview.js'), app = read('renderer/app.js');
  assert.ok(pv.includes("localStorage.getItem('bim.gpuResetAt')") && pv.includes('saved = clampSaved(saved, safePts)'), 'окно: сохранённое число точек не больше максимума');
  assert.ok(app.includes("localStorage.setItem('bim.gpuResetAt', String(shown))"), 'сброс запоминает число точек');
  assert.ok(/if \(sv > next\) localStorage\.setItem\('bim\.preloadPoints', String\(next\)\)/.test(app), 'сброс уменьшает сохранённое число точек');
});

test('r37: форма сборки из .xbin — фильтр краёв, Чистовая обработка сразу; понятные ошибки LAS и чистка остатков', () => {
  const app = read('renderer/app.js'), main = read('main.js'), pre = read('preload.js'), ext = read('renderer/lixel-tools-ext.js');
  assert.ok(app.includes("key: 'edge', label: 'Убрать «бахрому» у краёв и пыль в воздухе'") && app.includes("key: 'finish'"), 'поля формы');
  assert.ok(app.includes('API.xbinBuildCloud(p, jobId, density, { refine, color, edge })'));
  assert.ok(app.includes("ext.opRefineScan({ title: 'Чистовая обработка нового облака', photoOff: !!r.photo"), 'цепочка Чистовой обработки');
  assert.ok(pre.includes('edge: !(opts && opts.edge === false)'));
  assert.ok(main.includes("edge: a.edge !== false };") && main.includes('edge: Number(r.edge) || 0'));
  assert.ok(ext.includes("value: xb && !o.photoOff ? 'auto' : 'off'") && ext.includes("message: (o.lead ? o.lead + ' ' : '') +"));
  assert.ok(main.includes('function ruCloudMessage(msg, abs)') && main.includes('return ruCloudResult(result, abs);') && main.includes('Файл LAS обрезан'));
  assert.ok(main.includes('cleanupStaleCloudTemp(dir);   // ревизия 37'));
});
