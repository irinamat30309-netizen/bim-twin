'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Cloud = require('../las-node');

const CRS = 'PROJCRS["PCD test",ID["EPSG",32636]]';

function writeBinaryPcd(file, options) {
  options = options || {};
  const count = options.count || 6000;
  const commentLines = [
    '# BIM_TWIN_UP=z',
    '# BIM_TWIN_UNITS=m',
    '# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(CRS)
  ];
  const lines = [
    ...commentLines,
    'VERSION .7',
    'FIELDS x y z intensity rgb classification spare',
    'SIZE 8 8 8 2 4 1 4',
    'TYPE F F F U F U F',
    'COUNT 1 1 1 1 1 1 1',
    'WIDTH ' + count,
    'HEIGHT 1',
    'POINTS ' + count,
    'DATA binary',
    ''
  ];
  const header = Buffer.from(lines.join('\n'), 'ascii');
  const recordLength = 35;
  const record = Buffer.alloc(recordLength);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    for (let i = 0; i < count; i++) {
      record.writeDoubleLE(options.invalidIndex === i ? NaN : 500000 + (i % 100) * 0.01, 0);
      record.writeDoubleLE(6000000 + Math.floor(i / 100) * 0.02, 8);
      record.writeDoubleLE(117 + (i % 37) * 0.02, 16);
      record.writeUInt16LE(i & 0xffff, 24);
      const rgb = (((i * 13) & 255) << 16) | (((i * 29) & 255) << 8) | ((i * 47) & 255);
      record.writeUInt32LE(rgb, 26);
      record.writeUInt8(i % 16, 30);
      record.writeUInt32LE(0, 31); // legal extra scalar field
      fs.writeSync(fd, record);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { count, headerBytes: header.length, recordLength };
}

function writeAsciiPcd(file, options) {
  options = options || {};
  const count = options.count || 6000;
  const lines = [
    '# up=y',
    '# units=m',
    '# crs_wkt_uri=' + encodeURIComponent(CRS),
    'VERSION .7',
    'FIELDS x intensity y z red green blue classification',
    'SIZE 8 2 8 8 1 1 1 1',
    'TYPE F U F F U U U U',
    'COUNT 1 1 1 1 1 1 1 1',
    'WIDTH ' + count,
    'HEIGHT 1',
    'POINTS ' + count,
    'DATA ascii',
    ''
  ];
  for (let i = 0; i < count; i++) {
    const x = 500000 + (i % 100) * 0.01;
    const y = 100 + (i % 37) * 0.02;
    const z = 6000000 + Math.floor(i / 100) * 0.02;
    lines.push([
      options.invalidIndex === i ? 'Infinity' : String(x), String(i * 17),
      String(y), String(z), String(i & 255), String((i * 31) & 255),
      String((i * 67) & 255), String(i % 8)
    ].join(i % 2 ? '\t' : '  '));
  }
  fs.writeFileSync(file, lines.join(options.crlf ? '\r\n' : '\n') + (options.noFinalNewline ? '' : '\n'));
  return { count };
}

function lzfLiteralEncode(input) {
  const chunks = [];
  for (let start = 0; start < input.length;) {
    const length = Math.min(32, input.length - start);
    chunks.push(Buffer.from([length - 1]), input.subarray(start, start + length));
    start += length;
  }
  return Buffer.concat(chunks);
}

function writeCompressedPcd(file, options) {
  options = options || {};
  const count = options.count || 6000;
  const fields = [
    '# BIM_TWIN_UP=z',
    '# BIM_TWIN_UNITS=m',
    '# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(CRS),
    'VERSION .7',
    'FIELDS x y z rgb intensity classification',
    'SIZE 8 8 8 4 2 1',
    'TYPE F F F F U U',
    'COUNT 1 1 1 1 1 1',
    'WIDTH ' + count,
    'HEIGHT 1',
    'POINTS ' + count,
    'DATA binary_compressed',
    ''
  ];
  const header = Buffer.from(fields.join('\n'), 'ascii');
  const fieldBytes = [8, 8, 8, 4, 2, 1];
  const starts = [];
  let offset = 0;
  for (const bytes of fieldBytes) {
    starts.push(offset);
    offset += bytes * count;
  }
  const raw = Buffer.alloc(offset);
  for (let i = 0; i < count; i++) {
    raw.writeDoubleLE(500000 + (i % 100) * 0.01, starts[0] + i * 8);
    raw.writeDoubleLE(6000000 + Math.floor(i / 100) * 0.02, starts[1] + i * 8);
    raw.writeDoubleLE(117 + (i % 37) * 0.02, starts[2] + i * 8);
    const rgb = (((i * 13) & 255) << 16) | (((i * 29) & 255) << 8) | ((i * 47) & 255);
    raw.writeUInt32LE(rgb, starts[3] + i * 4);
    raw.writeUInt16LE(i & 0xffff, starts[4] + i * 2);
    raw.writeUInt8(i % 16, starts[5] + i);
  }
  const compressed = lzfLiteralEncode(raw);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(compressed.length, 0);
  sizes.writeUInt32LE(raw.length, 4);
  fs.writeFileSync(file, Buffer.concat([header, sizes, compressed]));
  return { count, rawBytes: raw.length, compressedBytes: compressed.length };
}

function writeBackReferencePcd(file) {
  const count = 5;
  const header = Buffer.from([
    'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
    'WIDTH 5', 'HEIGHT 1', 'POINTS 5', 'DATA binary_compressed', ''
  ].join('\n'));
  // First 4 bytes are a literal; an overlapping LZF reference then repeats
  // that float byte-pattern to fill the remaining 56 bytes.
  const compressed = Buffer.from([3, 0, 0, 128, 63, 0xe0, 47, 3]);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(compressed.length, 0);
  sizes.writeUInt32LE(count * 12, 4);
  fs.writeFileSync(file, Buffer.concat([header, sizes, compressed]));
  return count;
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

function previewMap(parsed) {
  const result = new Map();
  for (let i = 0; i < parsed.count; i++) {
    const point = [
      parsed.pos[i * 3], parsed.pos[i * 3 + 1], parsed.pos[i * 3 + 2],
      Math.round(parsed.col[i * 3] * 255),
      Math.round(parsed.col[i * 3 + 1] * 255),
      Math.round(parsed.col[i * 3 + 2] * 255)
    ];
    result.set(point.slice(0, 3).map(value => value.toFixed(4)).join(','), point);
  }
  return result;
}

function assertMatchesPreview(expected, actual) {
  const key = actual.slice(0, 3).map(value => value.toFixed(4)).join(',');
  const match = expected.get(key);
  assert.ok(match, 'PCD preview point missing for ' + actual.slice(0, 3).join(','));
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(match[axis] - actual[axis]) <= 1e-5);
  }
  assert.deepEqual(actual.slice(3), match.slice(3), 'RGB8 should match regular PCD import');
  expected.delete(key);
}

test('PCD binary out-of-core index matches source-frame preview, packed RGB, CRS and omissions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-pcd-binary-'));
  const source = path.join(root, 'survey.pcd'), output = path.join(root, 'store');
  const { count } = writeBinaryPcd(source, { count: 6000 });
  try {
    const info = Cloud.getOutOfCorePcdPointFileInfo(source);
    assert.equal(info.pointCount, count);
    assert.equal(info.mode, 'binary');
    assert.equal(info.recordLength, 35);
    assert.equal(Cloud.samePcdPointFileInfo(info, Cloud.getOutOfCorePcdPointFileInfo(source)), true);
    assert.equal(Cloud.isOutOfCorePcdPointFile(source), true);
    const preview = Cloud.parseCloudFile(source, { maxPoints: count, scratchBaseDir: root });
    assert.equal(preview.ok, true, preview.message);
    assert.deepEqual(fs.readdirSync(root).sort(), ['survey.pcd']);
    const { result, progress } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000,
      sourceTransform: preview.meta.srcXform, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'binary-pcd-two-pass');
    assert.equal(result.index.sourcePointCount, count);
    assert.equal(result.index.pointCount, count);
    assert.equal(result.index.sourceMeta.crsWkt, CRS);
    assert.equal(result.index.sourceMeta.colored, true);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    assert.ok(progress.some(value => value.phase === 'parse-scan'));
    assert.ok(progress.some(value => value.phase === 'parse-convert'));
    const expected = previewMap(preview);
    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, count);
    for (const point of actual) assertMatchesPreview(expected, point);
    assert.equal(expected.size, 0);
    assert.deepEqual(fs.readdirSync(output).sort(), ['index.json', 'nodes.bin']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD ASCII out-of-core index matches Y-up source transform and RGB with CRLF/no final newline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-pcd-ascii-'));
  const source = path.join(root, 'survey.pcd'), output = path.join(root, 'store');
  const { count } = writeAsciiPcd(source, { count: 130000, crlf: true, noFinalNewline: true });
  try {
    const info = Cloud.getOutOfCorePcdPointFileInfo(source);
    assert.equal(info.pointCount, count);
    assert.equal(info.mode, 'ascii');
    const preview = Cloud.parseCloudFile(source, { maxPoints: count });
    assert.equal(preview.ok, true, preview.message);
    const { result } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000,
      sourceTransform: preview.meta.srcXform, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'ascii-pcd-two-pass');
    assert.equal(result.index.pointCount, count);
    assert.equal(result.index.sourceMeta.crsWkt, CRS);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    const expected = previewMap(preview);
    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, count);
    for (const point of actual) assertMatchesPreview(expected, point);
    assert.equal(expected.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD out-of-core sampling is deterministic, bounded and reports non-finite source points', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-pcd-sample-'));
  const source = path.join(root, 'sample.pcd'), output = path.join(root, 'store');
  const { count } = writeAsciiPcd(source, { count: 10000, invalidIndex: 0 });
  try {
    const info = Cloud.getOutOfCorePcdPointFileInfo(source);
    const { result } = await runWorker(source, output, {
      maxPoints: 2000, nodeCapacity: 1000, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'ascii-pcd-two-pass');
    assert.equal(result.index.sourcePointCount, count);
    assert.equal(result.index.pointCount, 1999);
    assert.equal(result.index.sourceMeta.sampleStride, 5);
    assert.equal(result.index.sourceMeta.invalidPointCount, 1);
    assert.equal(readAllNodes(output, result.index).length, 1999);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD binary_compressed LZF is decoded to disk in bounded chunks and matches the regular preview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-pcd-lzf-'));
  const source = path.join(root, 'compressed.pcd'), output = path.join(root, 'store');
  const { count, rawBytes } = writeCompressedPcd(source, { count: 300000 });
  try {
    assert.ok(rawBytes > 8 * 1024 * 1024, 'fixture must cross the bounded LZF output chunk');
    const info = Cloud.getOutOfCorePcdPointFileInfo(source);
    assert.equal(info.pointCount, count);
    assert.equal(info.mode, 'binary_compressed');
    assert.equal(info.uncompressedSize, rawBytes);
    assert.equal(info.pointBytes, rawBytes);
    assert.equal(Cloud.isOutOfCorePcdPointFile(source), true);
    assert.equal(Cloud.samePcdPointFileInfo(info, Cloud.getOutOfCorePcdPointFileInfo(source)), true);

    const preview = Cloud.parseCloudFile(source, { maxPoints: count, scratchBaseDir: root });
    assert.equal(preview.ok, true, preview.message);
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.pcd'],
      'regular preview removes its private LZF planar scratch directory');
    const { result, progress } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000,
      sourceTransform: preview.meta.srcXform, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'binary_compressed-pcd-two-pass');
    assert.equal(result.index.sourcePointCount, count);
    assert.equal(result.index.pointCount, count);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    assert.ok(progress.some(value => value.phase === 'parse-decompress-pcd'));
    assert.ok(progress.some(value => value.phase === 'parse-scan'));
    const expected = previewMap(preview);
    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, count);
    for (const point of actual) assertMatchesPreview(expected, point);
    assert.equal(expected.size, 0);
    assert.deepEqual(fs.readdirSync(output).sort(), ['index.json', 'nodes.bin']);
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.pcd', 'store']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD preview disk-space preflight rejects insufficient scratch and removes its private directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-pcd-preview-space-'));
  const source = path.join(root, 'compressed.pcd');
  writeCompressedPcd(source, { count: 2 });
  const originalStatfs = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ bavail: 0n, bsize: 4096n });
    const result = Cloud.parseCloudFile(source, { scratchBaseDir: root });
    assert.equal(result.ok, false);
    assert.match(result.message, /недостаточно места.*LZF/i);
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.pcd'],
      'failed disk preflight must remove the newly-created scratch folder');
  } finally {
    fs.statfsSync = originalStatfs;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD LZF overlapping back-references preserve repeated point bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-pcd-backref-'));
  const source = path.join(root, 'backref.pcd'), output = path.join(root, 'store');
  const count = writeBackReferencePcd(source);
  try {
    const info = Cloud.getOutOfCorePcdPointFileInfo(source);
    const preview = Cloud.parseCloudFile(source, { maxPoints: count });
    assert.equal(preview.ok, true, preview.message);
    const { result } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'binary_compressed-pcd-two-pass');
    assert.equal(result.index.pointCount, count);
    const points = readAllNodes(output, result.index);
    assert.equal(points.length, count);
    const expectedColor = [0, 1, 2].map(axis => Math.round(preview.col[axis] * 255));
    for (const point of points) {
      assert.deepEqual(point.slice(0, 3), [0, 0, 0]);
      assert.deepEqual(point.slice(3), expectedColor, 'uncoloured input should preserve the preview elevation ramp');
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['backref.pcd', 'store']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD malformed/truncated LZF layouts and stale sources are rejected without scratch leaks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-pcd-invalid-'));
  try {
    const truncated = path.join(root, 'truncated.pcd');
    fs.writeFileSync(truncated, [
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
      'WIDTH 2', 'HEIGHT 1', 'POINTS 2', 'DATA binary', ''
    ].join('\n') + Buffer.alloc(12));
    assert.equal(Cloud.isOutOfCorePcdPointFile(truncated), false);
    assert.throws(() => Cloud.getOutOfCorePcdPointFileInfo(truncated), /truncated binary payload/);

    const compressed = path.join(root, 'compressed.pcd');
    fs.writeFileSync(compressed, [
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
      'WIDTH 1', 'HEIGHT 1', 'POINTS 1', 'DATA binary_compressed', ''
    ].join('\n'));
    assert.equal(Cloud.isOutOfCorePcdPointFile(compressed), false);
    assert.throws(() => Cloud.getOutOfCorePcdPointFileInfo(compressed), /truncated binary_compressed sizes/);

    const mismatchCompressed = path.join(root, 'mismatch-compressed.pcd');
    const mismatchHeader = Buffer.from([
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
      'WIDTH 1', 'HEIGHT 1', 'POINTS 1', 'DATA binary_compressed', ''
    ].join('\n'));
    const mismatchSizes = Buffer.alloc(8);
    mismatchSizes.writeUInt32LE(1, 0);
    mismatchSizes.writeUInt32LE(11, 4);
    fs.writeFileSync(mismatchCompressed, Buffer.concat([mismatchHeader, mismatchSizes, Buffer.from([0])]));
    assert.throws(() => Cloud.getOutOfCorePcdPointFileInfo(mismatchCompressed), /uncompressed size does not match/);

    const invalidBackref = path.join(root, 'invalid-backref.pcd');
    const invalidBackrefHeader = Buffer.from([
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
      'WIDTH 1', 'HEIGHT 1', 'POINTS 1', 'DATA binary_compressed', ''
    ].join('\n'));
    const invalidBackrefSizes = Buffer.alloc(8);
    invalidBackrefSizes.writeUInt32LE(2, 0);
    invalidBackrefSizes.writeUInt32LE(12, 4);
    fs.writeFileSync(invalidBackref, Buffer.concat([
      invalidBackrefHeader, invalidBackrefSizes, Buffer.from([0x20, 0])
    ]));
    const invalidBackrefInfo = Cloud.getOutOfCorePcdPointFileInfo(invalidBackref);
    const invalidBackrefResult = await runWorker(invalidBackref, path.join(root, 'invalid-backref-store'), {
      maxPoints: 10, nodeCapacity: 1000, sourcePreflightInfo: invalidBackrefInfo
    });
    assert.equal(invalidBackrefResult.result.ok, false);
    assert.match(invalidBackrefResult.result.error, /invalid LZF back-reference/);

    const invalidLzf = path.join(root, 'invalid-lzf.pcd');
    const invalidOutput = path.join(root, 'invalid-store');
    const invalidLzfHeader = Buffer.from([
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
      'WIDTH 1', 'HEIGHT 1', 'POINTS 1', 'DATA binary_compressed', ''
    ].join('\n'));
    const invalidLzfSizes = Buffer.alloc(8);
    invalidLzfSizes.writeUInt32LE(2, 0);
    invalidLzfSizes.writeUInt32LE(12, 4);
    fs.writeFileSync(invalidLzf, Buffer.concat([invalidLzfHeader, invalidLzfSizes, Buffer.from([11, 0])]));
    const invalidInfo = Cloud.getOutOfCorePcdPointFileInfo(invalidLzf);
    const failedLzfBuild = await runWorker(invalidLzf, invalidOutput, {
      maxPoints: 10, nodeCapacity: 1000, sourcePreflightInfo: invalidInfo
    });
    assert.equal(failedLzfBuild.result.ok, false);
    assert.match(failedLzfBuild.result.error, /truncated LZF literal run/);
    assert.equal(fs.existsSync(invalidOutput), false);

    const mismatch = path.join(root, 'mismatch.pcd');
    fs.writeFileSync(mismatch, [
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
      'WIDTH 2', 'HEIGHT 2', 'POINTS 3', 'DATA ascii', '0 0 0', '1 1 1', '2 2 2'
    ].join('\n') + '\n');
    assert.equal(Cloud.isOutOfCorePcdPointFile(mismatch), false);
    assert.throws(() => Cloud.getOutOfCorePcdPointFileInfo(mismatch), /does not match WIDTH × HEIGHT/);

    const source = path.join(root, 'stale.pcd'), output = path.join(root, 'store');
    writeBinaryPcd(source, { count: 2000 });
    const preflight = Cloud.getOutOfCorePcdPointFileInfo(source);
    fs.appendFileSync(source, Buffer.from([0]));
    const { result } = await runWorker(source, output, {
      maxPoints: 2000, nodeCapacity: 1000, sourcePreflightInfo: preflight
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /changed after resource preflight/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readdirSync(root).sort(), [
      'compressed.pcd', 'invalid-backref.pcd', 'invalid-lzf.pcd', 'mismatch-compressed.pcd',
      'mismatch.pcd', 'stale.pcd', 'truncated.pcd'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});