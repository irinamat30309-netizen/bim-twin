'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Section = require('../renderer/section.js');
const DXF = require('../renderer/dxf.js');

function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function obliqueRoom(angleDeg = 45, origin = [100, 200], offset = 1.25) {
  const a = angleDeg * Math.PI / 180;
  const d = [Math.cos(a), Math.sin(a)];
  const n = [-d[1], d[0]];
  const p = [];
  for (const cross of [offset - 0.08, offset, offset + 0.08]) {
    for (let station = 0; station <= 4.0001; station += 0.05) {
      for (const y of [0, 3]) {
        p.push(origin[0] + station * d[0] + cross * n[0], y, origin[1] + station * d[1] + cross * n[1]);
      }
    }
    for (let y = 0; y <= 3.0001; y += 0.05) {
      for (const station of [0, 4]) {
        p.push(origin[0] + station * d[0] + cross * n[0], y, origin[1] + station * d[1] + cross * n[1]);
      }
    }
  }
  // Noise outside the selected slab must not leak into the profile.
  for (let station = 0; station < 8; station++) {
    const cross = offset + 0.5;
    p.push(origin[0] + station * d[0] + cross * n[0], 1, origin[1] + station * d[1] + cross * n[1]);
  }
  return new Float64Array(p);
}

test('oblique vertical profile returns chainage/elevation contours and filters off-plane points', () => {
  const pos = obliqueRoom();
  const result = Section.profileToPolylines(pos, pos.length / 3, {
    origin: [100, 200], azimuthDeg: 45, offset: 1.25,
    thickness: 0.2, cell: 0.2, minArea: 0.02, simplify: 0.01, includeIndices: true
  });
  assert.equal(result.axis, 'profile');
  assert.equal(result.azimuthDeg, 45);
  assert.equal(result.sliced, result.indices.length);
  assert.ok(result.sliced < pos.length / 3, 'out-of-plane points should be excluded');
  assert.equal(result.loops.length, 2, 'room shell gives outer and inner contours');
  near(result.planeOrigin[0], 100 - 1.25 / Math.sqrt(2));
  near(result.planeOrigin[1], 200 + 1.25 / Math.sqrt(2));
  for (const loop of result.loops) {
    const bb = Section.bbox2d(loop.points);
    assert.ok(bb.mx[0] - bb.mn[0] > 3.5 && bb.mx[0] - bb.mn[0] < 4.6, 'station span');
    assert.ok(bb.mx[1] - bb.mn[1] > 2.5 && bb.mx[1] - bb.mn[1] < 3.6, 'elevation span');
    assert.equal(loop.closed, true);
  }
});

test('profile azimuth wraps, offset and slab endpoints are respected', () => {
  // At 450°, direction is +Z. A point exactly on the half-thickness boundary is included.
  const pos = new Float64Array([
    10, 1, 22,
    9.9, 2, 20,
    9.89, 3, 20
  ]);
  const r = Section.profileToPolylines(pos, 3, {
    origin: [10, 20], azimuthDeg: 450, offset: 0, thickness: 0.2,
    cell: 1, minArea: 0, includeIndices: true
  });
  assert.equal(r.azimuthDeg, 90);
  assert.deepEqual(r.indices, [0, 1]);
  near(r.direction[0], 0, 1e-12);
  near(r.direction[1], 1);
});

test('profile preserves geometry around large translated coordinates', () => {
  const pos = obliqueRoom(30, [1e9, -1e9], -3.5);
  const r = Section.profileToPolylines(pos, pos.length / 3, {
    origin: [1e9, -1e9], azimuthDeg: 30, offset: -3.5,
    thickness: 0.2, cell: 0.2, minArea: 0.02
  });
  assert.equal(r.loops.length, 2);
  assert.ok(r.loops[0].perim > 10 && r.loops[0].perim < 18);
  assert.ok(r.loops[0].points.every(p => p.every(Number.isFinite)));
  assert.equal(Object.hasOwn(r, 'indices'), false, 'large profiles should not retain point IDs unless requested');
});

test('empty, invalid and impractically fine profile grids fail safely', () => {
  const empty = Section.profileToPolylines([0, 0, 10], 1, {
    origin: [0, 0], azimuthDeg: 0, offset: 0, thickness: 0.1, cell: 0.1
  });
  assert.equal(empty.sliced, 0);
  assert.deepEqual(empty.loops, []);
  assert.throws(() => Section.profileToPolylines([0, 0, 0], -1, {}), RangeError);
  assert.throws(() => Section.profileToPolylines([0, 0, 0], 1, { origin: [NaN, 0] }), RangeError);
  assert.throws(() => Section.profileToPolylines([0, 0, 0], 1, { origin: '12' }), RangeError);
  assert.throws(() => Section.profileToPolylines([0, 0, 0], 1, { azimuthDeg: Infinity }), RangeError);
  assert.throws(() => Section.profileToPolylines([0, 0, 0], 1, { thickness: 0 }), RangeError);
  assert.throws(() => Section.profileToPolylines([0, 0, 0, 1e6, 0, 0], 2, {
    origin: [0, 0], thickness: 0.2, cell: 0.01
  }), RangeError);
});

test('contour tracing caps fragmented boundaries before runaway allocation', () => {
  const nx = 20, ny = 20, occ = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if ((x + y) % 2 === 0) occ[y * nx + x] = 1;
  }
  assert.throws(() => Section.traceContours({ occ, nx, ny, mn: [0, 0], cell: 1 }, { maxEdges: 100 }), /Слишком сложная граница/);
  assert.throws(() => Section.traceContours({ occ, nx, ny, mn: [0, 0], cell: 1 }, { maxEdges: -1 }), RangeError);
});

test('profile DXF entities are 2D station/elevation polylines without duplicate closing vertex', () => {
  const result = {
    loops: [
      { closed: true, points: [[0, 0], [2, 0], [2, 1], [0, 0]] },
      { closed: false, points: [[-1, 0], [0, 1]] }
    ]
  };
  const entities = Section.profileToDxfEntities(result);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].closed, true);
  assert.equal(entities[0].points.length, 3);
  assert.deepEqual(entities[0].points[1], [2, 0, 0]);
  assert.equal(entities[1].closed, false);
  assert.ok(entities.every(e => e.points.every(p => p[2] === 0)));
  const text = DXF.toDxf(entities, { layers: ['PROFILE_CONTOUR'] });
  assert.ok(text.includes('AC1009'));
  assert.ok(text.includes('PROFILE_CONTOUR'));
  assert.ok(text.includes('POLYLINE'));
  assert.ok(text.endsWith('0\nEOF\n'));
  assert.throws(() => Section.profileToDxfEntities({ loops: [{ points: [[NaN, 1]] }] }), RangeError);
});

test('profile UI exposes orientation, controls, export and cache-busted scripts', () => {
  const root = path.join(__dirname, '..');
  const workspace = fs.readFileSync(path.join(root, 'renderer/lixel-workspace.js'), 'utf8');
  const draw = fs.readFileSync(path.join(root, 'renderer/lixel-draw.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  for (const id of ['lxSectionAzimuth', 'lxSectionOriginX', 'lxSectionOriginZ', 'lxSectionOffset', 'lxBuildProfile']) {
    assert.ok(workspace.includes(id), `missing profile control ${id}`);
  }
  assert.ok(workspace.includes('profile'));
  assert.ok(workspace.includes('section-v1232'));
  assert.ok(draw.includes('exportProfileDxf'));
  assert.ok(draw.includes('PROFILE_CONTOUR'));
  assert.ok(draw.includes('source_crs_wkt'));
  for (const [file, version] of [['section.js', '1233'], ['lixel-draw.js', '1232'], ['lixel-workspace.js', '1232']]) {
    assert.ok(html.includes(`${file}?v=${version}`), `${file} cache version`);
  }
});