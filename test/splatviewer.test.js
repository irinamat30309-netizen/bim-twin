const test = require('node:test');
const assert = require('node:assert');
const SV = require('../renderer/splatviewer.js');

const SH_C0 = 0.28209479177387814;

// ---- .splat raw format: 32 bytes/splat: pos f32[3], scale f32[3], rgba u8[4], rot u8[4] ----
function makeSplat(splats) {
  const buf = new Uint8Array(splats.length * 32);
  const dv = new DataView(buf.buffer);
  splats.forEach((s, i) => {
    const o = i * 32;
    dv.setFloat32(o, s.pos[0], true); dv.setFloat32(o + 4, s.pos[1], true); dv.setFloat32(o + 8, s.pos[2], true);
    dv.setFloat32(o + 12, s.scale[0], true); dv.setFloat32(o + 16, s.scale[1], true); dv.setFloat32(o + 20, s.scale[2], true);
    buf[o + 24] = s.rgba[0]; buf[o + 25] = s.rgba[1]; buf[o + 26] = s.rgba[2]; buf[o + 27] = s.rgba[3];
    buf[o + 28] = s.rot[0]; buf[o + 29] = s.rot[1]; buf[o + 30] = s.rot[2]; buf[o + 31] = s.rot[3];
  });
  return buf.buffer;
}

test('parseSplat: reads count and positions', () => {
  const ab = makeSplat([
    { pos: [1, 2, 3], scale: [0.1, 0.1, 0.1], rgba: [10, 20, 30, 255], rot: [255, 128, 128, 128] },
    { pos: [4, 5, 6], scale: [0.2, 0.2, 0.2], rgba: [40, 50, 60, 200], rot: [255, 128, 128, 128] }
  ]);
  const r = SV._parseSplat(ab);
  assert.strictEqual(r.count, 2);
  const f = new Float32Array(r.buffer.buffer, r.buffer.byteOffset, r.count * 8);
  assert.strictEqual(f[0], 1); assert.strictEqual(f[1], 2); assert.strictEqual(f[2], 3);
  assert.strictEqual(f[8], 4); assert.strictEqual(f[9], 5); assert.strictEqual(f[10], 6);
});

test('computeBounds: center and radius', () => {
  const ab = makeSplat([
    { pos: [-1, -1, -1], scale: [0.1, 0.1, 0.1], rgba: [0, 0, 0, 255], rot: [255, 128, 128, 128] },
    { pos: [1, 1, 1], scale: [0.1, 0.1, 0.1], rgba: [0, 0, 0, 255], rot: [255, 128, 128, 128] }
  ]);
  const r = SV._parseSplat(ab);
  const b = SV._computeBounds(r.buffer, r.count);
  assert.ok(Math.abs(b.center[0]) < 1e-6 && Math.abs(b.center[1]) < 1e-6 && Math.abs(b.center[2]) < 1e-6);
  assert.strictEqual(b.radius, 1);
});

test('floatToHalf: 1.0 -> 0x3C00', () => {
  assert.strictEqual(SV._floatToHalf(1.0), 0x3C00);
  assert.strictEqual(SV._floatToHalf(0), 0);
});

// ---- INRIA 3DGS ply (gaussian) ----
function makeGaussianPly() {
  const propNames = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  let header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\n';
  propNames.forEach(n => { header += 'property float ' + n + '\n'; });
  header += 'end_header\n';
  const hb = new TextEncoder().encode(header);
  const body = new Float32Array(propNames.length);
  body[0] = 5; body[1] = 6; body[2] = 7;
  body[3] = 1; body[4] = 0; body[5] = -1;
  body[6] = 2;
  body[7] = -3; body[8] = -3; body[9] = -3;
  body[10] = 1; body[11] = 0; body[12] = 0; body[13] = 0;
  const bb = new Uint8Array(body.buffer);
  const out = new Uint8Array(hb.length + bb.length);
  out.set(hb, 0); out.set(bb, hb.length);
  return out.buffer;
}

test('parsePly: INRIA 3DGS detected as gaussian', () => {
  const r = SV._parsePly(makeGaussianPly());
  assert.strictEqual(r.kind, 'gaussian');
  assert.strictEqual(r.count, 1);
  const f = new Float32Array(r.buffer.buffer, r.buffer.byteOffset, r.count * 8);
  assert.strictEqual(f[0], 5); assert.strictEqual(f[1], 6); assert.strictEqual(f[2], 7);
  assert.ok(Math.abs(f[3] - Math.exp(-3)) < 1e-5, 'scale = exp(log scale)');
  const u = new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, r.count * 32);
  const expR = Math.round((0.5 + SH_C0 * 1) * 255);
  assert.strictEqual(u[24], expR);
});

// ---- plain RGB point cloud ply (uchar red/green/blue) ----
function makePointCloudPly() {
  let header = 'ply\nformat binary_little_endian 1.0\ncomment CloudCompare\nelement vertex 2\n';
  header += 'property float x\nproperty float y\nproperty float z\n';
  header += 'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const headBytes = new TextEncoder().encode(header);
  const rowLen = 3 * 4 + 3;
  const body = new Uint8Array(rowLen * 2);
  const dv = new DataView(body.buffer);
  dv.setFloat32(0, 0, true); dv.setFloat32(4, 0, true); dv.setFloat32(8, 0, true);
  body[12] = 200; body[13] = 100; body[14] = 50;
  dv.setFloat32(15, 10, true); dv.setFloat32(19, 4, true); dv.setFloat32(23, 2, true);
  body[27] = 10; body[28] = 20; body[29] = 30;
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes, 0); out.set(body, headBytes.length);
  return out.buffer;
}

test('parsePly: plain RGB point cloud detected as points', () => {
  const r = SV._parsePly(makePointCloudPly());
  assert.strictEqual(r.kind, 'points');
  assert.strictEqual(r.count, 2);
  const u = new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, r.count * 32);
  assert.strictEqual(u[24], 200);
  assert.strictEqual(u[25], 100);
  assert.strictEqual(u[26], 50);
  assert.strictEqual(u[27], 255);
  const f = new Float32Array(r.buffer.buffer, r.buffer.byteOffset, r.count * 8);
  assert.ok(f[3] > 0, 'scale assigned from bounds');
  assert.strictEqual(f[8], 10);
});

test('parsePly: subsamples large point clouds', () => {
  let header = 'ply\nformat binary_little_endian 1.0\nelement vertex 10\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const hb = new TextEncoder().encode(header);
  const rowLen = 15;
  const body = new Uint8Array(rowLen * 10);
  const dv = new DataView(body.buffer);
  for (let i = 0; i < 10; i++) { dv.setFloat32(i * rowLen, i, true); body[i * rowLen + 12] = i; }
  const out = new Uint8Array(hb.length + body.length);
  out.set(hb, 0); out.set(body, hb.length);
  const r = SV._parsePly(out.buffer, { maxPoints: 4 });
  assert.strictEqual(r.stride, 3);
  assert.ok(r.count <= 4 && r.count >= 3);
  assert.strictEqual(r.totalVertices, 10);
});

test('robustBounds + pruneOutliers: drops far floaters, keeps cluster', () => {
  const n = 103;
  const buf = new Uint8Array(n * 32);
  const f = new Float32Array(buf.buffer);
  for (let i = 0; i < 100; i++) {
    f[i * 8] = (i % 10) * 0.1 - 0.5;
    f[i * 8 + 1] = ((i / 10) | 0) * 0.1 - 0.5;
    f[i * 8 + 2] = 0.1;
  }
  f[100 * 8] = 9000; f[101 * 8 + 1] = -50000; f[102 * 8 + 2] = 32000;
  const rb = SV._robustBounds(buf, n);
  assert.ok(Math.abs(rb.center[0]) < 2, 'robust center near cluster');
  assert.ok(rb.radius < 100, 'robust radius stays small: ' + rb.radius);
  const pr = SV._pruneOutliers(buf, n, rb, 2.5);
  assert.strictEqual(pr.count, 100, 'exactly the 3 outliers removed');
});

// ---- tour: raycasting, screen rays, station generation ----
function cloudBuf(points) {
  const buf = new Uint8Array(points.length * 32);
  const f = new Float32Array(buf.buffer);
  points.forEach((p, i) => { f[i * 8] = p[0]; f[i * 8 + 1] = p[1]; f[i * 8 + 2] = p[2]; f[i * 8 + 3] = 0.05; });
  return buf;
}

test('raycastNearest: hits splat straight ahead, ignores off-axis', () => {
  const buf = cloudBuf([[0, 0, 10], [50, 0, 10], [0, 0, 20]]);
  const hit = SV._raycastNearest(buf, 3, [0, 0, 0], [0, 0, 1], 0.02);
  assert.ok(hit, 'should hit');
  assert.strictEqual(hit.index, 0, 'nearest along ray');
  assert.ok(Math.abs(hit.point[2] - 10) < 1e-6);
});

test('raycastNearest: returns null when nothing in cone', () => {
  const buf = cloudBuf([[100, 100, 10]]);
  const hit = SV._raycastNearest(buf, 1, [0, 0, 0], [0, 0, 1], 0.02);
  assert.strictEqual(hit, null);
});

test('raycastNearest: ignores splats behind the camera', () => {
  const buf = cloudBuf([[0, 0, -10]]);
  const hit = SV._raycastNearest(buf, 1, [0, 0, 0], [0, 0, 1], 0.05);
  assert.strictEqual(hit, null);
});

test('screenRayDir: center pixel points along forward', () => {
  const cam = { yaw: 0, pitch: 0, upSign: 1 };
  const dir = SV._screenRayDir(400, 300, 800, 600, cam, 1.1);
  assert.ok(dir[2] > 0.99, 'center ray ~ +z: ' + dir.join(','));
  assert.ok(Math.abs(dir[0]) < 1e-6 && Math.abs(dir[1]) < 1e-6);
});

test('screenRayDir: right-of-center pixel tilts +x', () => {
  const cam = { yaw: 0, pitch: 0, upSign: 1 };
  const dir = SV._screenRayDir(700, 300, 800, 600, cam, 1.1);
  assert.ok(dir[0] > 0, 'ray should tilt +x: ' + dir.join(','));
});

test('computeStations: returns k separated stations', () => {
  const pts = [];
  for (let i = 0; i < 500; i++) pts.push([Math.cos(i) * 10, (i % 5), Math.sin(i) * 10]);
  const buf = cloudBuf(pts);
  const st = SV._computeStations(buf, pts.length, 6);
  assert.strictEqual(st.length, 6);
  st.forEach(s => { assert.ok(Array.isArray(s.pos) && s.pos.length === 3); });
  const d = Math.hypot(st[0].pos[0] - st[1].pos[0], st[0].pos[1] - st[1].pos[1], st[0].pos[2] - st[1].pos[2]);
  assert.ok(d > 1, 'stations separated: ' + d);
});

test('anglesFromDir: +z -> yaw 0, +x -> yaw pi/2', () => {
  const a = SV._anglesFromDir([0, 0, 1]);
  assert.ok(Math.abs(a.yaw) < 1e-6 && Math.abs(a.pitch) < 1e-6);
  const b = SV._anglesFromDir([1, 0, 0]);
  assert.ok(Math.abs(b.yaw - Math.PI / 2) < 1e-6);
});

test('projectPoint: identity vp maps center to (0,0), off-center to +x', () => {
  const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const c = SV._projectPoint([0, 0, 5], I);
  assert.ok(c && Math.abs(c.x) < 1e-6 && Math.abs(c.y) < 1e-6, 'center at 0,0');
  assert.ok(c.w === 1, 'identity w=1');
  const r = SV._projectPoint([0.3, 0, 5], I);
  assert.ok(r.x > 0, 'point to the right has +ndc.x');
});

test('projectPoint: returns null when w<=0 (behind)', () => {
  const M = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,0]);
  const p = SV._projectPoint([1, 1, 1], M);
  assert.strictEqual(p, null);
});

test('stepVelocity: eases toward target, clamps when rate*dt>=1', () => {
  let v = [0, 0, 0];
  v = SV._stepVelocity(v, [10, 0, 0], 9, 0.016);
  assert.ok(v[0] > 0 && v[0] < 10, 'partial step: ' + v[0]);
  const v2 = SV._stepVelocity([2, 0, 0], [10, 0, 0], 100, 0.02); // rate*dt=2 -> clamp
  assert.ok(Math.abs(v2[0] - 10) < 1e-9, 'clamped to target');
});

test('stepVelocity: decays toward zero when target is zero', () => {
  let v = [8, 0, 0];
  for (let i = 0; i < 200; i++) v = SV._stepVelocity(v, [0, 0, 0], 7, 0.016);
  assert.ok(Math.hypot(v[0], v[1], v[2]) < 0.01, 'velocity decays to ~0');
});

test('mmMap/mmInv: roundtrip and center mapping', () => {
  const b = { lo: [-10, 0, -20], hi: [30, 5, 40], center: [10, 2.5, 10], radius: 30 };
  const size = 170;
  const m = SV._mmMap(10, 10, b, size);
  const back = SV._mmInv(m.px, m.py, b, size);
  assert.ok(Math.abs(back[0] - 10) < 1e-6 && Math.abs(back[1] - 10) < 1e-6, 'roundtrip xz');
  // point at box min maps to pad*size
  const lo = SV._mmMap(-10, -20, b, size);
  assert.ok(Math.abs(lo.px - 0.08 * size) < 1e-6 && Math.abs(lo.py - 0.08 * size) < 1e-6);
});

test('serializeTour/deserializeTour: roundtrip preserves station positions', () => {
  const stations = [{ pos: [1, 2, 3] }, { pos: [-4.5, 0, 12.25] }];
  const json = SV._serializeTour(stations);
  const back = SV._deserializeTour(json);
  assert.strictEqual(back.length, 2);
  assert.deepStrictEqual(back[0].pos, [1, 2, 3]);
  assert.deepStrictEqual(back[1].pos, [-4.5, 0, 12.25]);
});

test('deserializeTour: coerces strings and skips malformed points', () => {
  const obj = { stations: [{ pos: ['5', '6', '7'] }, { pos: [1, 2] }, { nope: true }] };
  const back = SV._deserializeTour(JSON.stringify(obj));
  assert.strictEqual(back.length, 1);
  assert.deepStrictEqual(back[0].pos, [5, 6, 7]);
});

test('deserializeTour: throws on missing station list or empty result', () => {
  assert.throws(() => SV._deserializeTour('{}'));
  assert.throws(() => SV._deserializeTour(JSON.stringify({ stations: [{ pos: [1, 2] }] })));
});

test('makeStation: keeps pos, includes name/yaw/pitch only when valid', () => {
  const a = SV._makeStation([1, 2, 3], 'Вход', 0.5, -0.2);
  assert.deepStrictEqual(a.pos, [1, 2, 3]);
  assert.strictEqual(a.name, 'Вход');
  assert.strictEqual(a.yaw, 0.5);
  assert.strictEqual(a.pitch, -0.2);
  const b = SV._makeStation(['4', '5', '6'], '', NaN, undefined);
  assert.deepStrictEqual(b.pos, [4, 5, 6]);
  assert.ok(!('name' in b) && !('yaw' in b) && !('pitch' in b));
});

test('withStation add/remove/rename are pure and correct', () => {
  const base = [SV._makeStation([0, 0, 0], 'A'), SV._makeStation([1, 1, 1], 'B')];
  const added = SV._withStationAdded(base, SV._makeStation([2, 2, 2], 'C'));
  assert.strictEqual(added.length, 3);
  assert.strictEqual(base.length, 2, 'original untouched');
  const removed = SV._withStationRemoved(added, 1);
  assert.deepStrictEqual(removed.map(s => s.name), ['A', 'C']);
  const renamed = SV._withStationRenamed(base, 0, 'Start');
  assert.strictEqual(renamed[0].name, 'Start');
  assert.strictEqual(base[0].name, 'A', 'rename does not mutate original');
});

test('serializeTour/deserializeTour: roundtrip preserves name/yaw/pitch', () => {
  const stations = [
    SV._makeStation([1, 2, 3], 'Лестница', 1.2, -0.3),
    SV._makeStation([4, 5, 6]) // plain point, no meta
  ];
  const back = SV._deserializeTour(SV._serializeTour(stations));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].name, 'Лестница');
  assert.ok(Math.abs(back[0].yaw - 1.2) < 1e-9);
  assert.ok(Math.abs(back[0].pitch + 0.3) < 1e-9);
  assert.deepStrictEqual(back[1].pos, [4, 5, 6]);
  assert.ok(!('name' in back[1]) && !('yaw' in back[1]));
});

test('withStationMoved: reorders purely, guards bad indices', () => {
  const base = [
    SV._makeStation([0, 0, 0], 'A'),
    SV._makeStation([1, 1, 1], 'B'),
    SV._makeStation([2, 2, 2], 'C')
  ];
  const moved = SV._withStationMoved(base, 0, 2);
  assert.deepStrictEqual(moved.map(s => s.name), ['B', 'C', 'A']);
  assert.deepStrictEqual(base.map(s => s.name), ['A', 'B', 'C'], 'original untouched');
  const up = SV._withStationMoved(base, 2, 1);
  assert.deepStrictEqual(up.map(s => s.name), ['A', 'C', 'B']);
  // out-of-range or no-op returns an equivalent array
  assert.deepStrictEqual(SV._withStationMoved(base, 0, 0).map(s => s.name), ['A', 'B', 'C']);
  assert.deepStrictEqual(SV._withStationMoved(base, -1, 2).map(s => s.name), ['A', 'B', 'C']);
  assert.deepStrictEqual(SV._withStationMoved(base, 1, 9).map(s => s.name), ['A', 'B', 'C']);
});

test('mmNearestStation: returns nearest within radius, -1 otherwise', () => {
  const b = { lo: [0, 0, 0], hi: [10, 0, 10], center: [5, 0, 5], radius: 7 };
  const size = 170;
  const stations = [
    SV._makeStation([0, 0, 0]),
    SV._makeStation([10, 0, 10]),
    SV._makeStation([5, 0, 5])
  ];
  // pixel of station index 2 (center) should map back to index 2
  const p = SV._mmMap(5, 5, b, size);
  assert.strictEqual(SV._mmNearestStation(stations, p.px, p.py, b, size, 10), 2);
  // a far-away pixel with tiny radius yields no hit
  assert.strictEqual(SV._mmNearestStation(stations, -999, -999, b, size, 10), -1);
});

test('routePolyline: XZ points, closes loop only when >2 and loop=true', () => {
  const s = [
    SV._makeStation([0, 9, 0]),
    SV._makeStation([2, 9, 3]),
    SV._makeStation([5, 9, 1])
  ];
  const open = SV._routePolyline(s, false);
  assert.deepStrictEqual(open, [[0, 0], [2, 3], [5, 1]]);
  const closed = SV._routePolyline(s, true);
  assert.strictEqual(closed.length, 4);
  assert.deepStrictEqual(closed[3], [0, 0], 'loop appends first point');
  // 2 points never close even with loop
  const two = SV._routePolyline([SV._makeStation([0, 0, 0]), SV._makeStation([1, 0, 1])], true);
  assert.strictEqual(two.length, 2);
  assert.deepStrictEqual(SV._routePolyline([], true), []);
});

test('estimateTourDurationMs: intro + n*(move+dwell), with defaults', () => {
  // intro = round(900*0.78)=702; per = 900+2600=3500; n=3 -> 702+10500=11202
  assert.strictEqual(SV._estimateTourDurationMs(3, 900, 2600), 11202);
  // defaults kick in for falsy args
  assert.strictEqual(SV._estimateTourDurationMs(0, 0, 0), 702);
  // custom values
  assert.strictEqual(SV._estimateTourDurationMs(2, 500, 1000), Math.round(500 * 0.78) + 2 * 1500);
});

test('catmullRomSpline: <3 points returns copy', () => {
  assert.deepStrictEqual(SV._catmullRomSpline([], 10, false), []);
  assert.deepStrictEqual(SV._catmullRomSpline([[0, 0]], 10, false), [[0, 0]]);
  assert.deepStrictEqual(SV._catmullRomSpline([[0, 0], [1, 1]], 10, false), [[0, 0], [1, 1]]);
});

test('catmullRomSpline: open passes through endpoints, denser', () => {
  const pts = [[0, 0], [1, 2], [3, 1], [4, 4]];
  const out = SV._catmullRomSpline(pts, 8, false);
  assert.strictEqual(out.length, (pts.length - 1) * 8 + 1);
  assert.deepStrictEqual(out[0], [0, 0]);
  assert.deepStrictEqual(out[out.length - 1], [4, 4]);
});

test('catmullRomSpline: passes through interior control points', () => {
  const pts = [[0, 0], [1, 2], [3, 1], [4, 4]];
  const seg = 8;
  const out = SV._catmullRomSpline(pts, seg, false);
  // control point i (open) lands at index i*seg
  assert.deepStrictEqual(out[seg], [1, 2]);
  assert.deepStrictEqual(out[2 * seg], [3, 1]);
});

test('catmullRomSpline: closed loops back to first point', () => {
  const pts = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const seg = 6;
  const out = SV._catmullRomSpline(pts, seg, true);
  assert.strictEqual(out.length, pts.length * seg + 1);
  assert.deepStrictEqual(out[0], [0, 0]);
  assert.deepStrictEqual(out[out.length - 1], [0, 0]);
});

test('stationCaption: numbers + name', () => {
  const st = [{ name: 'Вход' }, { name: '' }, {}];
  assert.strictEqual(SV._stationCaption(st, 0), '1. Вход');
  assert.strictEqual(SV._stationCaption(st, 1), '2. Точка 2');
  assert.strictEqual(SV._stationCaption(st, 2), '3. Точка 3');
});

test('stationCaption: out of range returns empty', () => {
  assert.strictEqual(SV._stationCaption([], 0), '');
  assert.strictEqual(SV._stationCaption([{ name: 'A' }], 5), '');
});

test('approachAlpha: steps toward target, clamps', () => {
  // fade in: 100ms of 450ms fade -> ~0.222
  assert.ok(Math.abs(SV._approachAlpha(0, 1, 100, 450) - (100 / 450)) < 1e-9);
  // does not overshoot up
  assert.strictEqual(SV._approachAlpha(0.9, 1, 1000, 450), 1);
  // fade out toward 0, no undershoot
  assert.strictEqual(SV._approachAlpha(0.1, 0, 1000, 450), 0);
  // partial fade out
  assert.ok(Math.abs(SV._approachAlpha(1, 0, 90, 450) - (1 - 90 / 450)) < 1e-9);
});

test('approachAlpha: zero/neg fade snaps to target', () => {
  assert.strictEqual(SV._approachAlpha(0, 1, 16, 0), 1);
  assert.strictEqual(SV._approachAlpha(0.5, 0, 16, -5), 0);
});

test('subtitleText: combines subtitle and date', () => {
  assert.strictEqual(SV._subtitleText('Проект A', true, '25.08.2026'), 'Проект A  \u2022  25.08.2026');
  assert.strictEqual(SV._subtitleText('Проект A', false, '25.08.2026'), 'Проект A');
  assert.strictEqual(SV._subtitleText('', true, '25.08.2026'), '25.08.2026');
  assert.strictEqual(SV._subtitleText('', false, ''), '');
  assert.strictEqual(SV._subtitleText('X', true, ''), 'X');
});
