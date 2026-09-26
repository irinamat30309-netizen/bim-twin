// v1147 — avatar walkthrough: local-floor spawn, wall barriers (median threshold),
// gravity/jump/ground physics, and motion-aware sort cadence.
const test = require('node:test');
const assert = require('node:assert');
const SV = require('../renderer/splatviewer.js');

// Build a 32-byte/splat interleaved buffer (pos f32[3] at offset 0) like the viewer uses.
function makeBuf(points) {
  const buf = new Uint8Array(points.length * 32);
  const dv = new DataView(buf.buffer);
  points.forEach((p, i) => {
    const o = i * 32;
    dv.setFloat32(o, p[0], true);
    dv.setFloat32(o + 4, p[1], true);
    dv.setFloat32(o + 8, p[2], true);
  });
  return new Float32Array(buf.buffer);
}

// A 4m x 4m room: dense floor at y=0, four walls (x=0, x=4, z=0, z=4) up to y=2.5m.
// Interior (roughly 0.4..3.6 in x/z) is empty space.
function roomPoints() {
  const pts = [];
  for (let x = 0; x <= 4.0001; x += 0.1) for (let z = 0; z <= 4.0001; z += 0.1) pts.push([x, 0, z]);
  for (let z = 0; z <= 4.0001; z += 0.1) for (let y = 0.1; y <= 2.5001; y += 0.1) { pts.push([0, y, z]); pts.push([4, y, z]); }
  for (let x = 0; x <= 4.0001; x += 0.1) for (let y = 0.1; y <= 2.5001; y += 0.1) { pts.push([x, y, 0]); pts.push([x, y, 4]); }
  return pts;
}
const BOUNDS = { lo: [0, 0, 0], hi: [4, 2.5, 4], center: [2, 1.25, 2], radius: 3 };

function buildRoomGrid(opts) {
  const pts = roomPoints();
  const f = makeBuf(pts);
  // minAbs:3 so the (sparse) synthetic floor slab (~4 splats/cell) counts as solid ground
  // for groundY/spawn; the denser walls (~10) stay solid and the interior stays empty.
  return SV._buildCollisionGrid(f, pts.length, BOUNDS, Object.assign({ cell: 0.2, layerH: 0.5, minAbs: 3, densFrac: 0 }, opts || {}));
}

const YA = 0.55, YB = 1.6, R = 0.28;

test('buildCollisionGrid: returns a populated grid with median stats', () => {
  const g = buildRoomGrid();
  assert.ok(g && g.solid && g.solid.length > 0, 'grid built');
  assert.ok(g.nx > 1 && g.nz > 1 && g.ny >= 1, 'has dimensions');
  assert.ok(g.medianOcc >= 0, 'median occupancy reported');
});

test('collision: interior of the room is walkable (not blocked)', () => {
  const g = buildRoomGrid();
  assert.strictEqual(SV._worldBlocked(g, 2, 2, YA, YB, R), false, 'center free');
  assert.strictEqual(SV._worldBlocked(g, 1, 3, YA, YB, R), false, 'off-center free');
});

test('collision: walls are solid (blocked)', () => {
  const g = buildRoomGrid();
  assert.strictEqual(SV._worldBlocked(g, 0.05, 2, YA, YB, R), true, 'left wall x=0 blocks');
  assert.strictEqual(SV._worldBlocked(g, 3.95, 2, YA, YB, R), true, 'right wall x=4 blocks');
  assert.strictEqual(SV._worldBlocked(g, 2, 0.05, YA, YB, R), true, 'wall z=0 blocks');
});

test('resolveWalk: cannot pass straight through a wall (stays inside)', () => {
  const g = buildRoomGrid();
  const r = SV._resolveWalk(g, 2, 2, -1, 2, YA, YB, R);
  assert.ok(r[0] > 0.2, 'did not teleport through the wall, x stayed inside: ' + r[0]);
});

test('resolveWalk: slides along the wall (цепляется за стену)', () => {
  const g = buildRoomGrid();
  const r = SV._resolveWalk(g, 2, 2, -1, 3, YA, YB, R);
  assert.ok(r[0] > 0.2, 'blocked X component (stays inside): ' + r[0]);
  assert.ok(r[1] > 2.4, 'slid along wall in +Z: ' + r[1]);
});

test('resolveWalk: free interior move is applied unchanged', () => {
  const g = buildRoomGrid();
  const r = SV._resolveWalk(g, 2, 2, 2.5, 2.3, YA, YB, R);
  assert.ok(Math.abs(r[0] - 2.5) < 1e-9 && Math.abs(r[1] - 2.3) < 1e-9, 'free move kept');
});

test('median threshold: thin walls stay solid when a few cells are ultra-dense', () => {
  // Regression for the v1146 pass-through bug: a huge, super-dense floor/ceiling slab
  // used to lift the MEAN so high that thin walls (few splats) fell below threshold.
  const pts = roomPoints();
  // Pile a very dense blob in one floor cell (like ceiling pipes / ground clutter).
  for (let k = 0; k < 4000; k++) pts.push([2.0, 0.0, 2.0]);
  const f = makeBuf(pts);
  const g = SV._buildCollisionGrid(f, pts.length, BOUNDS, { cell: 0.2, layerH: 0.35, minAbs: 2, densFrac: 0.6 });
  assert.ok(g.meanOcc > g.medianOcc, 'mean is skewed above the median by the dense blob');
  // Walls must still block despite the skew.
  assert.strictEqual(SV._worldBlocked(g, 0.05, 3, YA, YB, R), true, 'wall solid under median threshold');
  assert.strictEqual(SV._worldBlocked(g, 3.95, 1, YA, YB, R), true, 'far wall solid under median threshold');
  assert.strictEqual(SV._worldBlocked(g, 2, 2, YA, YB, R), false, 'interior still walkable');
});

test('groundY: returns the top of the floor slab below the probe', () => {
  const g = buildRoomGrid();
  const gy = SV._groundY(g, 2, 2, 2.0);
  assert.ok(gy != null, 'found a floor');
  // floor points at y=0 fall in the bottom layer; its top is oy + layerH.
  assert.ok(Math.abs(gy - (g.oy + g.layerH)) < 1e-9, 'floor top at oy+layerH: ' + gy);
});

test('groundY: null outside the grid footprint (open void)', () => {
  const g = buildRoomGrid();
  assert.strictEqual(SV._groundY(g, -5, -5, 2.0), null, 'no floor outside footprint');
});

test('integrateFall: gravity pulls a floating avatar downward', () => {
  const r = SV._integrateFall(2.0, 0, 0.1, null, false, false);
  assert.ok(r.velY < 0, 'velocity became negative (falling)');
  assert.ok(r.foot < 2.0, 'foot moved down');
  assert.strictEqual(r.onGround, false, 'still airborne with no ground');
});

test('integrateFall: snaps to ground and zeroes velocity on landing', () => {
  // foot just above ground=0.5, moving down fast -> should land exactly on 0.5.
  const r = SV._integrateFall(0.52, -5, 0.1, 0.5, false, false);
  assert.ok(Math.abs(r.foot - 0.5) < 1e-9, 'landed on the floor: ' + r.foot);
  assert.strictEqual(r.velY, 0, 'vertical velocity cleared on land');
  assert.strictEqual(r.onGround, true, 'now grounded');
});

test('integrateFall: jump gives upward velocity only when grounded', () => {
  const jumped = SV._integrateFall(0.5, 0, 0.016, 0.5, true, true);
  assert.ok(jumped.velY > 0, 'jump launched upward');
  assert.strictEqual(jumped.onGround, false, 'left the ground');
  // Cannot jump in mid-air.
  const noAir = SV._integrateFall(3.0, -1, 0.016, null, true, false);
  assert.ok(noAir.velY < -1, 'still falling, air-jump ignored');
});

test('pickSpawn: stands on the LOCAL floor at eye height, facing the room', () => {
  const g = buildRoomGrid();
  const stations = [
    { pos: [0.5, 0, 0.5] },   // corner
    { pos: [2.0, 0, 2.0] },   // center (closest to centroid)
    { pos: [3.5, 0, 1.0] },
  ];
  const eyeH = 1.6;
  const sp = SV._pickSpawn(stations, BOUNDS, g, eyeH);
  assert.ok(Math.abs(sp.eye[0] - 2.0) < 1e-9 && Math.abs(sp.eye[2] - 2.0) < 1e-9, 'xz at central station');
  const floorTop = g.oy + g.layerH;
  assert.ok(Math.abs(sp.eye[1] - (floorTop + eyeH)) < 1e-9, 'eye at local floor + eyeHeight: ' + sp.eye[1]);
  assert.strictEqual(sp.pitch, 0, 'level pitch');
  assert.ok(isFinite(sp.yaw), 'yaw is finite');
});

test('pickSpawn: never spawns on the ceiling (regression for v1146)', () => {
  const g = buildRoomGrid();
  // The whole scene tops out at 2.5m; a correct eye must be near the floor, not the roof.
  const sp = SV._pickSpawn([{ pos: [2, 0, 2] }], BOUNDS, g, 1.6);
  assert.ok(sp.eye[1] < 2.5, 'eye is below the ceiling: ' + sp.eye[1]);
  assert.ok(sp.eye[1] > 1.5, 'eye is at human standing height: ' + sp.eye[1]);
});

test('pickSpawn: falls back to scene center when no grid/stations', () => {
  const sp = SV._pickSpawn([], BOUNDS, null, 1.6);
  assert.strictEqual(sp.stationIndex, -1);
  assert.ok(Math.abs(sp.eye[0] - 2) < 1e-9 && Math.abs(sp.eye[2] - 2) < 1e-9, 'at center xz');
  assert.ok(Math.abs(sp.eye[1] - (0 + 1.6)) < 1e-9, 'center eye = bbox floor + eyeHeight');
});

test('sortIntervalMs: still camera sorts promptly, moving camera throttles', () => {
  assert.strictEqual(SV._sortIntervalMs(100000, false), 0, 'small still = immediate');
  assert.strictEqual(SV._sortIntervalMs(50000, true), 45, 'small moving = short interval');
  assert.ok(SV._sortIntervalMs(5000000, true) > SV._sortIntervalMs(5000000, false), 'big scene: moving throttles more than still');
  assert.ok(SV._sortIntervalMs(5000000, true) >= SV._sortIntervalMs(1000000, true), 'interval grows with count while moving');
});

test('collision grid: adaptive threshold rises above minAbs for dense scans', () => {
  const g = buildRoomGrid({ minAbs: 3, densFrac: 0.6 });
  assert.ok(g.threshold >= 3, 'threshold at least minAbs');
  assert.ok(g.meanOcc > 0, 'measured mean occupancy');
  assert.strictEqual(SV._worldBlocked(g, 2, 2, YA, YB, R), false, 'interior free (adaptive)');
  assert.strictEqual(SV._worldBlocked(g, 0.05, 2, YA, YB, R), true, 'wall solid (adaptive)');
});
