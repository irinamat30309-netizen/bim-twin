'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Section = require('../renderer/section.js');
const DXF = require('../renderer/dxf.js');

function cube(min = [0, 0, 0], max = [1, 1, 1]) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const vertices = new Float64Array([
    x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
    x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7,
    0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2
  ]);
  return { positions: vertices, indices };
}

function combine(...meshes) {
  const positions = [], indices = [];
  for (const mesh of meshes) {
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...Array.from(mesh.indices, i => i + offset));
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function bounds(path) {
  const xs = path.points.map(p => p[0]), ys = path.points.map(p => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

test('exact mesh section intersects a cube into one closed horizontal contour', () => {
  const mesh = cube();
  const result = Section.meshPlaneSection(mesh, Section.axisPlane('y', 0.5));
  assert.equal(result.triangleCount, 12);
  assert.equal(result.segmentCount, 8, 'each triangulated side may contribute two collinear segments');
  assert.equal(result.closedCount, 1);
  assert.equal(result.openCount, 0);
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0].closed, true);
  assert.equal(result.paths[0].points.length, 4, 'collinear triangle-edge vertices should be removed from the DXF contour');
  assert.ok(Math.abs(result.paths[0].length - 4) < 1e-8);
  const bb = bounds(result.paths[0]);
  assert.deepEqual(bb, { min: [0, 0], max: [1, 1] });
});

test('exact mesh section reports finite monotonic progress through geometry phases', () => {
  const progress = [];
  const result = Section.meshPlaneSection(cube(), Section.axisPlane('y', 0.5), {
    onProgress: event => progress.push(event)
  });
  assert.equal(result.closedCount, 1);
  assert.ok(progress.length > 0);
  for (const event of progress) {
    assert.ok(Number.isFinite(event.fraction) && event.fraction >= 0 && event.fraction <= 1);
    if (event.total > 0) assert.ok(event.completed >= 0 && event.completed <= event.total);
  }
  const phases = new Map();
  for (const event of progress) {
    const values = phases.get(event.phase) || [];
    values.push(event.fraction);
    phases.set(event.phase, values);
  }
  for (const [phase, values] of phases) {
    for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], phase + ' progress regressed');
  }
  for (const phase of ['bounds', 'intersect', 'coplanar', 'adjacency', 'trace', 'complete']) {
    assert.ok(phases.has(phase), 'missing progress phase ' + phase);
  }
  assert.equal(progress.at(-1).phase, 'complete');
});

test('coplanar mesh faces produce only their patch boundary, not triangulation diagonals', () => {
  const result = Section.meshPlaneSection(cube(), Section.axisPlane('y', 0));
  assert.equal(result.coplanarTriangles, 2);
  assert.equal(result.segmentCount, 4);
  assert.equal(result.closedCount, 1);
  assert.ok(Math.abs(result.paths[0].length - 4) < 1e-8);
});

test('mesh section retains holes and disconnected closed components', () => {
  const outer = cube([0, 0, 0], [4, 3, 4]);
  const inner = cube([1, 0.5, 1], [3, 2.5, 3]);
  const separate = cube([6, 0, 0], [7, 3, 1]);
  const result = Section.meshPlaneSection(combine(outer, inner, separate), Section.axisPlane('y', 1.5));
  assert.equal(result.closedCount, 3);
  assert.equal(result.paths.length, 3);
  const areas = result.paths.map(p => p.area).sort((a, b) => a - b);
  assert.deepEqual(areas, [1, 4, 16]);
});

test('vertical X/Z sections project into the expected drafting coordinates', () => {
  const mesh = cube();
  const front = Section.meshPlaneSection(mesh, Section.axisPlane('z', 0.5));
  const side = Section.meshPlaneSection(mesh, Section.axisPlane('x', 0.5));
  assert.equal(front.closedCount, 1);
  assert.equal(side.closedCount, 1);
  assert.deepEqual(bounds(front.paths[0]), { min: [0, 0], max: [1, 1] }); // X, Y
  assert.deepEqual(bounds(side.paths[0]), { min: [0, 0], max: [1, 1] }); // Z, Y
});

test('cylindrical section removes triangle-diagonal midpoints without changing its length', () => {
  const sides = 48, positions = [], indices = [];
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < sides; i++) {
      const angle = 2 * Math.PI * i / sides;
      positions.push(Math.cos(angle), ring ? 1 : -1, Math.sin(angle));
    }
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides, bottom = i, top = sides + i;
    const nextBottom = j, nextTop = sides + j;
    indices.push(bottom, nextBottom, nextTop, bottom, nextTop, top);
  }
  const result = Section.meshPlaneSection({
    positions: new Float64Array(positions),
    indices: new Uint32Array(indices)
  }, Section.axisPlane('y', 0));
  assert.equal(result.closedCount, 1);
  assert.equal(result.openCount, 0);
  assert.equal(result.paths[0].points.length, sides, 'one DXF vertex per actual polygon corner');
  assert.ok(Math.abs(result.paths[0].length - 2 * sides * Math.sin(Math.PI / sides)) < 1e-9);
  assert.ok(Math.abs(result.paths[0].area - sides * Math.sin(2 * Math.PI / sides) / 2) < 1e-9);
});

test('single open triangle returns a finite open chain', () => {
  const mesh = {
    positions: new Float64Array([0, -1, 0, 1, 1, 0, 2, -1, 0]),
    indices: new Uint32Array([0, 1, 2])
  };
  const result = Section.meshPlaneSection(mesh, Section.axisPlane('y', 0));
  assert.equal(result.closedCount, 0);
  assert.equal(result.openCount, 1);
  assert.equal(result.paths[0].closed, false);
  assert.ok(Math.abs(result.paths[0].length - 1) < 1e-8);
});

test('indexed geometry applies the glTF column-major model transform', () => {
  const mesh = cube();
  mesh.model = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
  const result = Section.meshPlaneSection(mesh, Section.axisPlane('y', 20.5));
  assert.equal(result.closedCount, 1);
  assert.deepEqual(bounds(result.paths[0]), { min: [10, 30], max: [11, 31] });
});

test('large translated meshes retain local section dimensions and source-plane coordinates', () => {
  const mesh = cube([500000, 6000000, 120], [500001, 6000001, 121]);
  const result = Section.meshPlaneSection(mesh, Section.axisPlane('y', 6000000.5, [500000.5, 6000000.5, 120.5]));
  assert.equal(result.closedCount, 1);
  assert.ok(Math.abs(result.paths[0].length - 4) < 1e-6);
  assert.deepEqual(bounds(result.paths[0]), { min: [500000, 120], max: [500001, 121] });
});

test('mesh section exports R12 DXF polylines with closed/open state', () => {
  const mesh = combine(
    cube([0, 0, 0], [1, 1, 1]),
    { positions: new Float64Array([3, -1, 0, 4, 1, 0, 5, -1, 0]), indices: new Uint32Array([0, 1, 2]) }
  );
  const result = Section.meshPlaneSection(mesh, Section.axisPlane('y', 0));
  const entities = Section.meshSectionToEntities(result, 'SECTION_Y');
  const dxf = DXF.toDxf(entities, { layers: ['SECTION_Y'] });
  assert.equal(entities.length, 2);
  assert.equal(entities.filter(e => e.closed).length, 1);
  assert.equal(entities.filter(e => !e.closed).length, 1);
  assert.match(dxf, /AC1009/);
  assert.equal((dxf.match(/POLYLINE/g) || []).length, 2);
  assert.match(dxf, /SECTION_Y/);
  assert.ok(dxf.endsWith('0\nEOF\n'));
});

test('invalid geometry, transforms, plane parameters, and resource limits fail safely', () => {
  const mesh = cube();
  assert.throws(() => Section.meshPlaneSection(mesh, { origin: [0, 0, 0], normal: [0, 0, 0] }), /нулевой/);
  assert.throws(() => Section.meshPlaneSection(mesh, Section.axisPlane('y', 0), { epsilon: 0 }), /Допуск/);
  assert.throws(() => Section.meshPlaneSection(mesh, Section.axisPlane('y', 0), { maxTriangles: 2 }), /ограничено/);
  assert.throws(() => Section.meshPlaneSection({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 4] }, Section.axisPlane('y', 0)), /Индекс/);
  assert.throws(() => Section.meshPlaneSection({ ...mesh, model: [1, 2, 3] }, Section.axisPlane('y', 0)), /16 значен/);
  assert.throws(() => Section.axisPlane('q', 0), /ось/);
  assert.throws(() => Section.axisPlane('x', Infinity), /ось/);
});