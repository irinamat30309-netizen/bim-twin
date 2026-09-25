'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Terrain = require('../renderer/terrain');
const rendererHtml = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const sprintUi = fs.readFileSync(path.join(__dirname, '../renderer/lixel-sprints-ext.js'), 'utf8');

function rampDSM() {
  return {
    nx: 3, nz: 3, cell: 1, minX: 10, minZ: 20,
    grid: new Float32Array([
      0, 1, 2,
      0, 1, 2,
      0, 1, 2
    ])
  };
}

test('buildContours: positive interval makes finite, in-grid contour segments', () => {
  const result = Terrain.buildContours(rampDSM(), { interval: 0.5 });
  assert.ok(result.length > 0);
  assert.ok(result.every(level => Number.isFinite(level.level) && level.segments.length > 0));
  for (const level of result) for (const segment of level.segments) {
    assert.equal(segment.length, 2);
    for (const point of segment) {
      assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
      assert.ok(point[0] >= 10 && point[0] <= 12);
      assert.ok(point[1] >= 20 && point[1] <= 22);
    }
  }
});

test('buildContours: rejects zero, negative, NaN, and infinite intervals', () => {
  for (const interval of [0, -0.1, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => Terrain.buildContours(rampDSM(), { interval }),
      /Шаг горизонталей/
    );
  }
});

test('buildContours: guards pathological requests with too many levels', () => {
  const dsm = rampDSM();
  dsm.grid = new Float32Array([0, 100, 0, 100, 0, 100, 0, 100, 0]);
  assert.throws(
    () => Terrain.buildContours(dsm, { interval: 0.001 }),
    /Слишком много уровней/
  );
});

test('buildContours: returns no contour for an empty/flat surface', () => {
  assert.deepEqual(Terrain.buildContours(null, { interval: 0.5 }), []);
  assert.deepEqual(Terrain.buildContours({ nx: 0, nz: 0, cell: 0.5, grid: [] }, { interval: 0.5 }), []);
  const flat = rampDSM();
  flat.grid.fill(5.04);
  assert.deepEqual(Terrain.buildContours(flat, { interval: 0.5 }), []);
});

test('buildContours: skips cells containing invalid raster samples', () => {
  const dsm = rampDSM();
  dsm.grid[4] = NaN;
  const result = Terrain.buildContours(dsm, { interval: 0.5 });
  for (const level of result) for (const segment of level.segments) {
    for (const point of segment) assert.ok(point.every(Number.isFinite));
  }
});

test('contour UI: cache-busted modules, editable interval, and no false empty-file success', () => {
  assert.match(rendererHtml, /terrain\.js\?v=1223/);
  assert.match(rendererHtml, /lixel-sprints-ext\.js\?v=1224/);
  assert.match(sprintUi, /window\.prompt\('Шаг горизонталей в метрах/);
  assert.match(sprintUi, /пустой DXF не сохранён/);
  assert.match(sprintUi, /if \(!download\('contours-/);
});