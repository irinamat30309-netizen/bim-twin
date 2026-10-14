'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_BENCHMARK_POINTS,
  resolveBenchmarkConfig,
  runStage9Benchmark
} = require('../scripts/stage9-large-cloud-benchmark');

function writeLas(filePath, count = 20_000, crsWkt = null) {
  const header = Buffer.alloc(227);
  header.write('LASF', 0, 'ascii');
  header.writeUInt8(1, 24);
  header.writeUInt8(2, 25);
  header.writeUInt16LE(227, 94);
  const wkt = typeof crsWkt === 'string' ? Buffer.from(crsWkt, 'utf8') : null;
  const vlr = wkt ? Buffer.alloc(54) : null;
  if (vlr) {
    vlr.write('LASF_Projection', 2, 'ascii');
    vlr.writeUInt16LE(2112, 18);
    vlr.writeUInt16LE(wkt.length, 20);
    vlr.write('Stage 9 test CRS', 22, 'ascii');
    header.writeUInt32LE(1, 100);
  }
  header.writeUInt32LE(227 + (wkt ? vlr.length + wkt.length : 0), 96);
  header.writeUInt8(3, 104);
  header.writeUInt16LE(34, 105);
  header.writeUInt32LE(count, 107);
  header.writeDoubleLE(0.01, 131);
  header.writeDoubleLE(0.01, 139);
  header.writeDoubleLE(0.01, 147);
  header.writeDoubleLE(500_000, 155);
  header.writeDoubleLE(6_000_000, 163);
  header.writeDoubleLE(100, 171);

  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, header);
    if (vlr) {
      fs.writeSync(fd, vlr);
      fs.writeSync(fd, wkt);
    }
    for (let i = 0; i < count; i++) {
      const record = Buffer.alloc(34);
      record.writeInt32LE(i % 1000, 0);
      record.writeInt32LE(Math.floor(i / 1000) * 20, 4);
      record.writeInt32LE(i % 61, 8);
      record.writeUInt16LE((i * 37) & 0xffff, 12);
      record[14] = 1;
      record[15] = i % 8;
      record.writeUInt16LE(1, 18);
      record.writeDoubleLE(i / 1000, 20);
      record.writeUInt16LE(i & 255, 28);
      record.writeUInt16LE((i * 31) & 255, 30);
      record.writeUInt16LE((i * 67) & 255, 32);
      fs.writeSync(fd, record);
    }
  } finally {
    fs.closeSync(fd);
  }
}

test('Stage 9 benchmark config requires a LAS path and a bounded point budget', () => {
  assert.throws(() => resolveBenchmarkConfig({ env: {} }), /BIMTWIN_GPU_LAS_PATH/);
  assert.throws(() => resolveBenchmarkConfig({
    sourcePath: '/tmp/input.las',
    maxPoints: 0
  }), /BIMTWIN_STAGE9_MAX_POINTS/);
  assert.throws(() => resolveBenchmarkConfig({
    sourcePath: '/tmp/input.las',
    maxPoints: MAX_BENCHMARK_POINTS + 1
  }), /BIMTWIN_STAGE9_MAX_POINTS/);

  const config = resolveBenchmarkConfig({
    sourcePath: '/tmp/input.las',
    maxPoints: 2500,
    expectedPointCount: 5000,
    availableDiskBytes: 1024 * 1024 * 1024
  });
  assert.equal(config.maxPoints, 2500);
  assert.equal(config.expectedPointCount, 5000);
});

test('Stage 9 benchmark scans LAS, builds a capped disk octree, runs sections and cleans temp data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-stage9-test-'));
  const sourcePath = path.join(root, 'survey.las');
  const reportPath = path.join(root, 'stage9-report.json');
  const sourcePointCount = 20_000;
  const crsWkt = 'PROJCRS["Stage 9 fixture",AUTHORITY["EPSG","32610"]]';
  writeLas(sourcePath, sourcePointCount, crsWkt);

  try {
    const result = await runStage9Benchmark({
      sourcePath,
      maxPoints: 4_000,
      expectedPointCount: sourcePointCount,
      availableDiskBytes: 1024 * 1024 * 1024,
      diskMarginBytes: 1,
      workParent: root,
      reportPath,
      nodeCapacity: 1000
    });
    const { report } = result;

    assert.equal(report.status, 'passed');
    assert.equal(report.source.pointCountFromHeader, sourcePointCount);
    assert.equal(report.source.crsWktPresent, true);
    assert.equal(report.source.crsWkt, crsWkt);
    assert.equal(report.source.crsWktLength, crsWkt.length);
    assert.equal(report.source.crsWktTruncated, false);
    assert.equal(report.ingest.fullSourceScannedInTwoPasses, true);
    assert.equal(report.ingest.sourcePointCount, sourcePointCount);
    assert.ok(report.ingest.indexedSamplePointCount <= 4_000);
    assert.equal(report.sections.scope, 'deterministic indexed sample; not the complete source point set');
    assert.deepEqual(report.sections.runs.map(run => run.axis), ['x', 'y', 'z', 'profile']);
    assert.ok(report.sections.runs.every(run => run.selectedPoints > 0));
    assert.ok(report.sections.runs.every(run => run.durationMs >= 0));
    assert.equal(report.disk.temporaryDirectoryRemoved, true);
    assert.equal(result.reportPath, reportPath);
    assert.equal(fs.existsSync(reportPath), true);
    assert.deepEqual(fs.readdirSync(root).sort(), ['stage9-report.json', 'survey.las']);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).status, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});