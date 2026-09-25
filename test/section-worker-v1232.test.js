'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Section = require('../renderer/section.js');

function roomSlab() {
  const points = [];
  for (let x = 0; x <= 2.0001; x += 0.1) {
    points.push(x, 0, 0, x, 0, 1);
  }
  for (let z = 0; z <= 1.0001; z += 0.1) {
    points.push(0, 0, z, 2, 0, z);
  }
  points.push(20, 4, 20, NaN, 0, 0);
  return new Float32Array(points);
}

test('compact worker buffers preserve axis/profile contours without nested point arrays', () => {
  const axisPos = roomSlab();
  const axisOptions = { axis: 'y', level: 0, thickness: 0.1, cell: 0.1, minArea: 0 };
  const axisNormal = Section.sectionToPolylines(axisPos, axisPos.length / 3, axisOptions);
  const axisCompact = Section.sectionToPolylines(axisPos, axisPos.length / 3, {
    ...axisOptions, compact: true
  });
  assert.deepEqual(axisCompact, axisNormal);
  const compactSlab = Section.sliceSlabCompact(axisPos, axisPos.length / 3, axisOptions);
  assert.ok(compactSlab.pts instanceof Float32Array);
  assert.equal(compactSlab.pts.length, compactSlab.count * 2);
  assert.deepEqual([...compactSlab.pts.slice(0, 4)], [0, 0, 0, 1]);

  const angle = Math.PI / 4;
  const d = [Math.cos(angle), Math.sin(angle)];
  const n = [-d[1], d[0]];
  const profilePoints = [];
  for (const cross of [-0.05, 0.05]) {
    for (const station of [0, 1]) {
      for (const y of [0, 2]) {
        profilePoints.push(station * d[0] + cross * n[0], y, station * d[1] + cross * n[1]);
      }
    }
  }
  const profilePos = new Float64Array(profilePoints);
  const profileOptions = {
    origin: [0, 0], azimuthDeg: 45, offset: 0, thickness: 0.2,
    cell: 0.1, minArea: 0
  };
  const profileNormal = Section.profileToPolylines(profilePos, profilePos.length / 3, profileOptions);
  const profileCompact = Section.profileToPolylines(profilePos, profilePos.length / 3, {
    ...profileOptions, compact: true
  });
  assert.deepEqual(profileCompact, profileNormal);
});

test('section progress reports real, monotone phases without changing axis geometry', () => {
  const pos = roomSlab();
  const options = { axis: 'y', level: 0, thickness: 0.1, cell: 0.1, minArea: 0 };
  const expected = Section.sectionToPolylines(pos, pos.length / 3, options);
  const updates = [];
  const actual = Section.sectionToPolylines(pos, pos.length / 3, {
    ...options,
    onProgress: update => updates.push(update)
  });
  assert.deepEqual(actual, expected, 'progress instrumentation must not change output');
  assert.deepEqual([...new Set(updates.map(update => update.phase))],
    ['slice', 'bounds', 'occupancy', 'trace-grid', 'trace-loops']);
  for (const phase of new Set(updates.map(update => update.phase))) {
    const values = updates.filter(update => update.phase === phase);
    assert.ok(values.length > 0, `phase ${phase} should report progress`);
    assert.equal(values.at(-1).fraction, 1, `phase ${phase} should reach completion`);
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i].fraction >= values[i - 1].fraction, `${phase} progress must be monotone`);
    }
  }
  assert.ok(updates.every(update =>
    Number.isFinite(update.fraction) && update.fraction >= 0 && update.fraction <= 1));
});

test('oblique profile reports scan progress and isolates callback failures', () => {
  const pos = new Float64Array([
    0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0,
    0, 0, 0.03, 1, 0, 0.03, 0, 2, 0.03, 1, 2, 0.03
  ]);
  const updates = [];
  const result = Section.profileToPolylines(pos, pos.length / 3, {
    origin: [0, 0], azimuthDeg: 0, thickness: 0.1, cell: 0.1, minArea: 0,
    onProgress(update) {
      updates.push(update);
      throw new Error('UI observer failure must be isolated');
    }
  });
  assert.equal(result.axis, 'profile');
  assert.equal(result.sliced, 8);
  assert.ok(result.loops.length > 0);
  assert.equal(updates.find(update => update.phase === 'profile').fraction, 0);
  assert.equal(updates.filter(update => update.phase === 'profile').at(-1).fraction, 1);
});

test('progress callbacks do not weaken geometry validation or allocation limits', () => {
  const events = [];
  assert.throws(() => Section.sectionToPolylines(new Float32Array([0, 0, 0]), 1, {
    axis: 'q', level: 0, thickness: 0.1, cell: 0.1, onProgress: e => events.push(e)
  }), /параметр/i);
  assert.throws(() => Section.gridOccupancy([[0, 0], [NaN, 1]], 0.1), /координаты/i);
  assert.throws(() => Section.gridOccupancy([[0, 0], [1e6, 1e6]], 0.001), /Слишком большая сетка/);
  assert.equal(events.length, 0, 'invalid parameters are rejected before scanning');
});

test('section Worker and accessible cancel/progress controls are wired into the application', () => {
  const root = path.join(__dirname, '..');
  const worker = fs.readFileSync(path.join(root, 'renderer/section-worker.js'), 'utf8');
  const draw = fs.readFileSync(path.join(root, 'renderer/lixel-draw.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(root, 'renderer/lixel-workspace.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  assert.match(worker, /importScripts\('section\.js\?v=1233'\)/);
  assert.match(worker, /type:\s*'progress'/);
  assert.match(worker, /type:\s*'result'/);
  assert.match(worker, /request\.operation === 'profile'/);
  assert.match(worker, /compact:\s*true/);
  assert.match(draw, /sectionFromCloudAsync/);
  assert.match(draw, /exportProfileDxfAsync/);
  assert.match(draw, /worker\.terminate\(\)/);
  assert.match(draw, /maxSectionWorkerBytes/);
  assert.match(draw, /bim-section-progress/);
  assert.match(workspace, /lxSectionProgress/);
  assert.match(workspace, /lxCancelSection/);
  assert.match(workspace, /sectionFromCloudAsync/);
  assert.match(workspace, /exportProfileDxfAsync/);
  assert.match(workspace, /Расчёт отменён · чертёж не изменён/);
  assert.match(html, /section\.js\?v=1233/);
  assert.match(html, /lixel-draw\.js\?v=1232/);
  assert.match(html, /lixel-workspace\.js\?v=1232/);
});