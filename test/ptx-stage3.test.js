'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Cloud = require('../las-node');
const SmartSaveFmt = require('../renderer/lixel-smart-save');
const ExportHub = require('../renderer/export-hub');
const E57Core = require('../e57-core');

function scan(columns, rows, matrix, points, origin = [0, 0, 0]) {
  return [
    String(columns), String(rows), origin.join(' '),
    '1 0 0', '0 1 0', '0 0 1',
    ...matrix.map(row => row.join(' ')),
    ...points.map(p => p.join(' '))
  ].join('\n');
}
function parsePTX(text) {
  const file = path.join(os.tmpdir(), `bimtwin-ptx-${process.pid}-${Math.random().toString(36).slice(2)}.ptx`);
  fs.writeFileSync(file, text);
  try { return Cloud.parseCloudFile(file, { maxPoints: 200000 }); }
  finally { fs.rmSync(file, { force: true }); }
}
function worldAt(cloud, i) {
  const t = cloud.meta.srcXform.t, p = cloud.pos;
  return [p[i * 3] + t[0], -p[i * 3 + 2] + t[1], p[i * 3 + 1] + t[2]];
}

test('PTX imports multi-scan transforms, skips empty returns and preserves intensity/RGB/pose metadata', () => {
  const first = scan(2, 2, [
    [0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [100, 200, 300, 1]
  ], [
    [1, 0, 0, 0.5, 255, 0, 0],
    [0, 1, 0, 0.25, 0, 255, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 1, 0, 0, 255]
  ], [100, 200, 300]);
  const second = scan(1, 1, [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [1000, 2000, 3000, 1]
  ], [[1, 2, 3, 0.75, 20, 40, 60]], [1000, 2000, 3000]);
  const result = parsePTX(first + '\n' + second + '\n');
  assert.equal(result.ok, true, result.message);
  assert.equal(result.count, 4);
  assert.equal(result.meta.recordCount, 5);
  assert.equal(result.meta.scanCount, 2);
  assert.equal(result.meta.scans[0].matrixConvention, 'row-vector');
  assert.deepEqual(result.meta.scans.map(s => s.validPoints), [3, 1]);
  const expected = [
    [100, 199, 300], [101, 200, 300], [100, 200, 301], [1001, 2002, 3003]
  ];
  for (let i = 0; i < expected.length; i++)
    for (let a = 0; a < 3; a++)
      assert.ok(Math.abs(worldAt(result, i)[a] - expected[i][a]) < 1e-5, `point ${i}/${a}`);
  assert.deepEqual(Array.from(result.intensity), [0.5, 0.25, 1, 0.75]);
  assert.equal(result.classification, null);
  const expectedColor = [1, 0, 0, 0, 1, 0, 0, 0, 1, 20 / 255, 40 / 255, 60 / 255];
  for (let i = 0; i < expectedColor.length; i++)
    assert.ok(Math.abs(result.col[i] - expectedColor[i]) < 1e-6, `RGB ${i}`);
  assert.equal(result.meta.crsWkt, null);
});

test('PTX accepts affine column-vector matrices and reports declared-grid truncation', () => {
  const alt = scan(1, 1, [
    [1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 30], [0, 0, 0, 1]
  ], [[2, 3, 4, 0.5]]);
  const result = parsePTX(alt);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.meta.scans[0].matrixConvention, 'column-vector');
  assert.ok(Math.abs(worldAt(result, 0)[0] - 12) < 1e-5);
  assert.ok(Math.abs(worldAt(result, 0)[1] - 23) < 1e-5);
  assert.ok(Math.abs(worldAt(result, 0)[2] - 34) < 1e-5);

  const truncated = scan(2, 2, [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]
  ], [[1, 2, 3, 0.5]]);
  const bad = parsePTX(truncated);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /truncated point grid/);
});

test('PTX rejects invalid dimensions and clouds containing only missing returns', () => {
  const invalid = parsePTX(['0', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1',
    '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1'].join('\n'));
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /invalid columns/);

  const empty = scan(1, 1, [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]
  ], [[0, 0, 0, 0]]);
  const noReturns = parsePTX(empty);
  assert.equal(noReturns.ok, false);
  assert.match(noReturns.message, /all points are missing/);
});

test('PTX writer round-trips multi-scan point ranges, row/column poses, RGB and intensity', () => {
  const first = scan(2, 2, [
    [0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [100, 200, 300, 1]
  ], [
    [1, 0, 0, 0.5, 255, 0, 0],
    [0, 1, 0, 0.25, 0, 255, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 1, 0, 0, 255]
  ], [100, 200, 300]);
  const second = scan(1, 1, [
    [1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 30], [0, 0, 0, 1]
  ], [[1, 2, 3, 0.75, 20, 40, 60]], [1000, 2000, 3000]);
  const imported = parsePTX(first + '\n' + second + '\n');
  assert.equal(imported.ok, true, imported.message);
  assert.deepEqual(imported.meta.scans.map(s => [s.start, s.count]), [[0, 3], [3, 1]]);
  const sourcePos = new Float64Array(imported.count * 3);
  for (let i = 0; i < imported.count; i++) sourcePos.set(worldAt(imported, i), i * 3);
  const source = {
    pos: sourcePos, col: imported.col, intensity: imported.intensity, count: imported.count,
    meta: imported.meta
  };
  const preflight = ExportHub.preflightExport('ptx', source);
  assert.equal(preflight.ok, true);
  assert.ok(preflight.warnings.some(w => /preserves per-scan rigid poses/i.test(w)));

  const text = SmartSaveFmt.toPTXText(source);
  const lines = text.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], '3', 'first scan remains a separate 3-return PTX grid');
  assert.equal(lines[13], '1', 'second scan starts with its own header and one-row grid');
  const round = parsePTX(text);
  assert.equal(round.ok, true, round.message);
  assert.equal(round.count, imported.count);
  assert.equal(round.meta.scanCount, 2);
  assert.deepEqual(round.meta.scans.map(s => [s.start, s.count]), [[0, 3], [3, 1]]);
  assert.equal(round.meta.scans[0].matrixConvention, 'row-vector');
  assert.equal(round.meta.scans[1].matrixConvention, 'column-vector');
  assert.deepEqual(round.meta.scans[0].transform, imported.meta.scans[0].transform);
  assert.deepEqual(round.meta.scans[1].transform, imported.meta.scans[1].transform);
  for (let i = 0; i < imported.count; i++) {
    const actual = worldAt(round, i), expected = worldAt(imported, i);
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-7);
  }
  assert.deepEqual(Array.from(round.col), Array.from(imported.col));
  assert.deepEqual(Array.from(round.intensity), Array.from(imported.intensity));

  // PTX scan ranges are also valid scan groups for E57: positions are
  // world-frame and E57 writes them in local coordinates under each pose.
  const e57 = E57Core.readBuffer(ExportHub.exportE57(source.pos, source.count, {
    col: source.col, intensity: source.intensity, crs: source.meta.crsWkt || '',
    scans: source.meta.scans
  }));
  assert.equal(e57.scans.length, 2);
  assert.deepEqual(e57.scans.map(s => s.name), ['PTX Scan 1', 'PTX Scan 2']);
  for (let i = 0; i < imported.count; i++) {
    const expected = worldAt(imported, i);
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(e57.pos[i * 3 + axis] - expected[axis]) < 1e-7);
  }
});

test('multi-scan PTX writer shifts a true local origin without turning it into a missing return', () => {
  const input = scan(2, 1, [
    [0, -1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [100, 200, 300, 1]
  ], [[1, 0, 0, 0.4], [2, 3, 4, 0.8]], [100, 200, 300]);
  const imported = parsePTX(input);
  assert.equal(imported.ok, true, imported.message);
  assert.equal(imported.count, 2);
  const pos = new Float64Array(6);
  for (let i = 0; i < 2; i++) pos.set(worldAt(imported, i), i * 3);
  // Simulate a valid edited return at the scanner origin. The importer cannot
  // receive this as raw (0,0,0), since that exact PTX triple is the no-return sentinel.
  pos.set([100, 200, 300], 0);
  const expectedWorld = new Float64Array(pos);
  const source = { pos, col: imported.col, intensity: imported.intensity, count: 2, meta: imported.meta };
  const round = parsePTX(SmartSaveFmt.toPTXText(source));
  assert.equal(round.ok, true, round.message);
  assert.equal(round.count, 2);
  for (let i = 0; i < 2; i++) {
    const actual = worldAt(round, i), expected = Array.from(expectedWorld.subarray(i * 3, i * 3 + 3));
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-7);
  }
});