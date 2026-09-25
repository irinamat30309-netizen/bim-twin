'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Cloud = require('../las-node');

const LAS_HEADER_SIZE = 227;

function writeLas(file, options) {
  options = options || {};
  const count = options.count || 6000;
  const format = options.format == null ? 3 : options.format;
  const colored = options.colored !== false && [2, 3, 5, 7, 8, 10].includes(format);
  const recordLength = ({ 0: 20, 2: 26, 3: 34, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 })[format] || 20;
  const versionMinor = options.versionMinor == null ? (format >= 6 ? 4 : 2) : options.versionMinor;
  const headerSize = versionMinor >= 4 ? 375 : (versionMinor >= 3 ? 235 : LAS_HEADER_SIZE);
  const wkt = options.wkt || null;
  const wktBytes = wkt ? Buffer.from(wkt + '\0', 'utf8') : Buffer.alloc(0);
  const vlrBytes = wkt ? 54 + wktBytes.length : 0;
  const header = Buffer.alloc(headerSize);
  header.write('LASF', 0, 'ascii');
  header.writeUInt8(1, 24);
  header.writeUInt8(versionMinor, 25);
  header.writeUInt16LE(headerSize, 94);
  header.writeUInt32LE(headerSize + vlrBytes, 96);
  header.writeUInt32LE(wkt ? 1 : 0, 100);
  header.writeUInt8(format | (options.compressed ? 0x80 : 0), 104);
  header.writeUInt16LE(recordLength, 105);
  header.writeUInt32LE(format >= 6 ? 0 : count, 107);
  header.writeDoubleLE(0.01, 131);
  header.writeDoubleLE(0.01, 139);
  header.writeDoubleLE(0.01, 147);
  header.writeDoubleLE(500000, 155);
  header.writeDoubleLE(6000000, 163);
  header.writeDoubleLE(100, 171);
  if (versionMinor >= 4) header.writeBigUInt64LE(BigInt(count), 247);

  let vlr = Buffer.alloc(0);
  if (wkt) {
    vlr = Buffer.alloc(vlrBytes);
    vlr.write('LASF_Projection', 2, 'ascii');
    vlr.writeUInt16LE(2112, 18);
    vlr.writeUInt16LE(wktBytes.length, 20);
    vlr.write('Coordinate System WKT', 22, 'ascii');
    wktBytes.copy(vlr, 54);
  }

  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    if (vlr.length) fs.writeSync(fd, vlr);
    for (let i = 0; i < count; i++) {
      const record = Buffer.alloc(recordLength);
      record.writeInt32LE(i % 1000, 0);
      record.writeInt32LE(Math.floor(i / 1000) * 20, 4);
      record.writeInt32LE(i % 61, 8);
      record.writeUInt16LE((i * 37) & 0xffff, 12);
      record[14] = 1;
      if (format >= 6) {
        record[15] = 1;
        record[16] = i % 8;
        record[17] = 0;
        record.writeInt16LE(0, 18);
        record.writeUInt16LE(1, 20);
        record.writeDoubleLE(i / 1000, 22);
      } else {
        record[15] = i % 8;
        record.writeInt8(0, 16);
        record[17] = 0;
        record.writeUInt16LE(1, 18);
      }
      if (format === 3) {
        record.writeDoubleLE(i / 1000, 20);
        if (colored) {
          const color = options.color16
            ? [(i * 1009) & 0xffff, (i * 2017) & 0xffff, (i * 3011) & 0xffff]
            : [i & 255, (i * 31) & 255, (i * 67) & 255];
          record.writeUInt16LE(color[0], 28);
          record.writeUInt16LE(color[1], 30);
          record.writeUInt16LE(color[2], 32);
        }
      } else if (format === 7 && colored) {
        const color = options.color16
          ? [(i * 1009) & 0xffff, (i * 2017) & 0xffff, (i * 3011) & 0xffff]
          : [i & 255, (i * 31) & 255, (i * 67) & 255];
        record.writeUInt16LE(color[0], 30);
        record.writeUInt16LE(color[1], 32);
        record.writeUInt16LE(color[2], 34);
      }
      fs.writeSync(fd, record);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { count, recordLength };
}

function runWorker(sourcePath, outputDir, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'octree-build-worker.js'), {
      workerData: {
        sourcePath, outputDir,
        maxPoints: options.maxPoints,
        nodeCapacity: options.nodeCapacity,
        sourceTransform: options.sourceTransform,
        sourcePreflightInfo: options.sourcePreflightInfo
      }
    });
    const progress = [];
    let result = null;
    worker.on('message', message => {
      if (message && message.type === 'progress') progress.push(message.progress);
      else if (message && message.type === 'result') result = message.result;
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 && (!result || result.ok)) return reject(new Error('octree worker exited ' + code));
      resolve({ result, progress });
    });
  });
}

function readAllNodes(outputDir, index) {
  const fd = fs.openSync(path.join(outputDir, 'nodes.bin'), 'r');
  const points = [];
  let nextOffset = 0;
  try {
    for (const node of index.nodes) {
      assert.equal(node.offset, nextOffset);
      assert.equal(node.byteLength, node.count * index.stride);
      const bytes = Buffer.alloc(node.byteLength);
      assert.equal(fs.readSync(fd, bytes, 0, bytes.length, node.offset), bytes.length);
      for (let i = 0; i < node.count; i++) {
        const at = i * index.stride;
        points.push([
          bytes.readFloatLE(at), bytes.readFloatLE(at + 4), bytes.readFloatLE(at + 8),
          bytes[at + 12], bytes[at + 13], bytes[at + 14]
        ]);
      }
      nextOffset += node.byteLength;
    }
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(nextOffset, fs.statSync(path.join(outputDir, 'nodes.bin')).size);
  return points;
}

function previewRecords(parsed) {
  const points = new Map();
  for (let i = 0; i < parsed.count; i++) {
    const xyz = [parsed.pos[i * 3], parsed.pos[i * 3 + 1], parsed.pos[i * 3 + 2]];
    const key = xyz.map(value => value.toFixed(4)).join(',');
    points.set(key, xyz.concat([
      Math.max(0, Math.min(255, Math.round(parsed.col[i * 3] * 255))),
      Math.max(0, Math.min(255, Math.round(parsed.col[i * 3 + 1] * 255))),
      Math.max(0, Math.min(255, Math.round(parsed.col[i * 3 + 2] * 255)))
    ]));
  }
  return points;
}

function assertPreviewPoint(expected, point) {
  const key = point.slice(0, 3).map(value => value.toFixed(4)).join(',');
  const match = expected.get(key);
  assert.ok(match, 'preview point missing for ' + point.slice(0, 3).join(','));
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(match[axis] - point[axis]) <= 1e-5,
      'viewer axis ' + axis + ' should match within 1e-5 m');
  }
  assert.deepEqual(match.slice(3), point.slice(3), 'RGB8 should match the preview');
  expected.delete(key);
}

test('uncompressed LAS two-pass LOD preserves the preview frame, RGB16, CRS and source-count metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-las-'));
  const source = path.join(root, 'survey.las'), output = path.join(root, 'store');
  const crsWkt = 'PROJCRS["Test UTM",ID["EPSG",32636]]';
  const { count } = writeLas(source, { count: 6000, format: 3, color16: true, wkt: crsWkt });
  try {
    const info = Cloud.getOutOfCoreLasPointFileInfo(source);
    assert.equal(info.pointCount, count);
    assert.equal(info.pointFormat, 3);
    assert.equal(info.recordLength, 34);
    assert.equal(Cloud.sameLasPointFileInfo(info, Cloud.getOutOfCoreLasPointFileInfo(source)), true);
    assert.equal(Cloud.isOutOfCoreLasPointFile(source), true);

    const preview = Cloud.parseCloudFile(source, { maxPoints: count });
    assert.equal(preview.ok, true, preview.message);
    const { result, progress } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000,
      sourceTransform: preview.meta.srcXform,
      sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.outOfCore, true);
    assert.equal(result.index.ingest, 'las-two-pass');
    assert.equal(result.index.sourcePointCount, count);
    assert.equal(result.index.pointCount, count);
    assert.equal(result.index.sourceMeta.colored, true);
    assert.equal(result.index.sourceMeta.crsWkt, crsWkt);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    assert.ok(progress.some(p => p.phase === 'parse-scan'));
    assert.ok(progress.some(p => p.phase === 'parse-convert'));

    const expected = previewRecords(preview);
    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, count);
    for (const point of actual) {
      assertPreviewPoint(expected, point);
    }
    assert.equal(expected.size, 0, 'no LAS point is missing or duplicated');
    assert.deepEqual(fs.readdirSync(output).sort(), ['index.json', 'nodes.bin']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LAS 1.4 point format 7 reads extended counts and modern RGB/classification offsets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-las14-'));
  const source = path.join(root, 'modern.las'), output = path.join(root, 'store');
  const crsWkt = 'PROJCRS["LAS 1.4 test",ID["EPSG",32636]]';
  const { count } = writeLas(source, { count: 4200, format: 7, color16: true, wkt: crsWkt });
  try {
    const info = Cloud.getOutOfCoreLasPointFileInfo(source);
    assert.equal(info.versionMinor, 4);
    assert.equal(info.pointCount, count);
    assert.equal(info.pointFormat, 7);
    assert.equal(info.recordLength, 36);
    const preview = Cloud.parseCloudFile(source, { maxPoints: count });
    assert.equal(preview.ok, true, preview.message);
    const { result } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000,
      sourceTransform: preview.meta.srcXform,
      sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.pointCount, count);
    assert.equal(result.index.ingest, 'las-two-pass');
    assert.equal(result.index.sourceMeta.crsWkt, crsWkt);
    assert.equal(result.index.sourceMeta.hasClassification, true);
    const expected = previewRecords(preview);
    for (const point of readAllNodes(output, result.index)) {
      assertPreviewPoint(expected, point);
    }
    assert.equal(expected.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LAS without RGB uses the elevation ramp and deterministic point-budget sampling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-las-sample-'));
  const source = path.join(root, 'uncolored.las'), output = path.join(root, 'store');
  const { count } = writeLas(source, { count: 6000, format: 0, colored: false });
  try {
    const fd = fs.openSync(source, 'r');
    let preview;
    try { preview = Cloud.parseLASFile(fd, fs.statSync(source).size, 1200); }
    finally { fs.closeSync(fd); }
    assert.equal(preview.ok, true, preview.message);
    const info = Cloud.getOutOfCoreLasPointFileInfo(source);
    const { result } = await runWorker(source, output, {
      maxPoints: 1200, nodeCapacity: 1000,
      sourceTransform: preview.meta.srcXform,
      sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'las-two-pass');
    assert.equal(result.index.sourceMeta.colored, false);
    assert.equal(result.index.sourceMeta.sampleStride, 5);
    assert.equal(result.index.sourceMeta.invalidPointCount, 0);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    const expected = previewRecords(preview);
    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, preview.count);
    for (const point of actual) {
      assertPreviewPoint(expected, point);
    }
    assert.equal(expected.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LAS indexing rejects compressed, truncated and stale sources without committing partial stores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-las-invalid-'));
  try {
    const compressed = path.join(root, 'compressed.las');
    writeLas(compressed, { count: 5, format: 3, compressed: true });
    assert.equal(Cloud.isOutOfCoreLasPointFile(compressed), false);
    assert.throws(() => Cloud.getOutOfCoreLasPointFileInfo(compressed), /compressed or reserved/);
    assert.equal(Cloud.parseCloudFile(compressed, { maxPoints: 100 }).ok, false);

    const truncated = path.join(root, 'truncated.las');
    writeLas(truncated, { count: 10, format: 3 });
    fs.truncateSync(truncated, fs.statSync(truncated).size - 34 * 4);
    assert.equal(Cloud.isOutOfCoreLasPointFile(truncated), false);
    assert.throws(() => Cloud.getOutOfCoreLasPointFileInfo(truncated), /truncated or exceed the file/);
    assert.equal(Cloud.parseCloudFile(truncated, { maxPoints: 100 }).ok, false);

    const source = path.join(root, 'stale.las'), output = path.join(root, 'store');
    writeLas(source, { count: 2000, format: 3 });
    const preflight = Cloud.getOutOfCoreLasPointFileInfo(source);
    fs.appendFileSync(source, Buffer.from([0]));
    assert.equal(Cloud.sameLasPointFileInfo(preflight, Cloud.getOutOfCoreLasPointFileInfo(source)), false);
    const { result } = await runWorker(source, output, {
      maxPoints: 2000, nodeCapacity: 1000, sourcePreflightInfo: preflight
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /changed after resource preflight/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.las', 'stale.las', 'truncated.las']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});