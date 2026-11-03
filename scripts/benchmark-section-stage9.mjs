#!/usr/bin/env node
'use strict';

// Reproducible Stage 9 smoke benchmark for the compact point-cloud section
// kernel. This deliberately uses a generated grid with an analytic contour;
// it does not claim to benchmark UI/Worker overhead or a customer LAS file.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const Section = require('../renderer/section.js');

const MiB = 1024 * 1024;
const cell = 0.5;
const gridSide = 200;
const gridCells = gridSide * gridSide;
const expectedSide = gridSide * cell;
const expectedArea = expectedSide * expectedSide;
const expectedPerimeter = expectedSide * 4;
const phaseOrder = ['slice', 'bounds', 'occupancy', 'trace-grid', 'trace-loops'];

function makeFixture(count) {
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const gridIndex = i % gridCells;
    const offset = i * 3;
    points[offset] = (gridIndex % gridSide) * cell + cell / 2;
    points[offset + 1] = i % 8 === 0 ? 0.02 : 0;
    points[offset + 2] = Math.floor(gridIndex / gridSide) * cell + cell / 2;
  }
  return points;
}

function benchmark(count) {
  if (global.gc) global.gc();
  const rssBefore = process.memoryUsage().rss;
  const points = makeFixture(count);
  const progress = [];
  const started = performance.now();
  const result = Section.sectionToPolylines(points, count, {
    axis: 'y',
    level: 0,
    thickness: 0.1,
    cell,
    minArea: 1,
    simplify: cell / 2,
    compact: true,
    onProgress: update => progress.push(update)
  });
  const elapsedMs = performance.now() - started;
  const memoryAfter = process.memoryUsage();

  assert.equal(result.sliced, count, 'all fixture points should be inside the slab');
  assert.equal(result.loops.length, 1, 'filled grid must produce one closed contour');
  const [loop] = result.loops;
  assert.equal(loop.closed, true);
  assert.ok(Math.abs(loop.area - expectedArea) <= 1e-5, 'contour area must match the analytic 100×100 m square');
  assert.ok(Math.abs(loop.perim - expectedPerimeter) <= 1e-5, 'contour perimeter must match the analytic square');

  const phases = [...new Set(progress.map(update => update.phase))];
  assert.deepEqual(phases, phaseOrder, 'all section phases must report progress in order');
  for (const phase of phases) {
    const updates = progress.filter(update => update.phase === phase);
    assert.equal(updates.at(-1).fraction, 1, `${phase} must complete`);
    for (let i = 0; i < updates.length; i++) {
      assert.ok(Number.isFinite(updates[i].fraction) && updates[i].fraction >= 0 && updates[i].fraction <= 1);
      if (i) assert.ok(updates[i].fraction >= updates[i - 1].fraction, `${phase} progress must be monotone`);
    }
  }

  const report = {
    benchmark: 'stage9-point-cloud-section-v1',
    scope: 'Section.sectionToPolylines compact kernel; no UI, Worker startup, or source-file I/O',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    count,
    fixture: {
      type: 'deterministic filled grid',
      extentMeters: [expectedSide, expectedSide],
      cellMeters: cell,
      expectedAreaSquareMeters: expectedArea,
      expectedPerimeterMeters: expectedPerimeter
    },
    result: {
      sliced: result.sliced,
      loops: result.loops.length,
      area: loop.area,
      perimeter: loop.perim,
      progressEvents: progress.length
    },
    elapsedMs: Number(elapsedMs.toFixed(2)),
    memoryMiB: {
      rssBefore: Number((rssBefore / MiB).toFixed(1)),
      rssAfter: Number((memoryAfter.rss / MiB).toFixed(1)),
      rssDeltaAfter: Number(((memoryAfter.rss - rssBefore) / MiB).toFixed(1)),
      arrayBuffersAfter: Number((memoryAfter.arrayBuffers / MiB).toFixed(1))
    }
  };
  console.log(JSON.stringify(report));
}

for (const count of [1_000_000, 10_000_000]) benchmark(count);