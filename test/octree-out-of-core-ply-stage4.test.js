'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Cloud = require('../las-node');

function writeBinaryPly(file, options) {
  options = options || {};
  const count = options.count || 6000;
  const bigEndian = !!options.bigEndian;
  const withColor = options.withColor !== false;
  const colorType = options.colorType === 'uchar' ? 'uchar' : 'ushort';
  const colorBytes = withColor ? (colorType === 'uchar' ? 3 : 6) : 0;
  const withIntensity = !!options.withIntensity;
  const withClassification = !!options.withClassification;
  const up = options.up || 'z';
  const lines = [
    'ply',
    `format binary_${bigEndian ? 'big' : 'little'}_endian 1.0`,
    `comment up=${up}`,
    'element vertex ' + count,
    'property double x',
    'property double y',
    'property double z'
  ];
  if (withColor) lines.push(`property ${colorType} red`, `property ${colorType} green`, `property ${colorType} blue`);
  if (withIntensity) lines.push('property float intensity');
  if (withClassification) lines.push('property uchar classification');
  lines.push('end_header', '');
  const header = Buffer.from(lines.join('\n'), 'ascii');
  const endian = bigEndian ? 'BE' : 'LE';
  const recordSize = 24 + colorBytes + (withIntensity ? 4 : 0) + (withClassification ? 1 : 0);
  const record = Buffer.alloc(recordSize);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    for (let i = 0; i < count; i++) {
      record[`writeDouble${endian}`](options.coincident ? 125000 : (i === options.invalidIndex ? Infinity : 500000 + (i % 100) * 0.01), 0);
      record[`writeDouble${endian}`](options.coincident ? 6250000 : 6000000 + Math.floor(i / 100) * 0.02, 8);
      record[`writeDouble${endian}`](options.coincident ? 112 : 117 + (i % 37) * 0.02, 16);
      let offset = 24;
      if (withColor) {
        if (colorType === 'uchar') {
          record[offset++] = i & 255;
          record[offset++] = (i >> 8) & 255;
          record[offset++] = (i >> 16) & 255;
        } else {
          record[`writeUInt16${endian}`]((i * 109) & 0xffff, offset); offset += 2;
          record[`writeUInt16${endian}`]((i * 211) & 0xffff, offset); offset += 2;
          record[`writeUInt16${endian}`]((i * 307) & 0xffff, offset); offset += 2;
        }
      }
      if (withIntensity) { record[`writeFloat${endian}`](i / Math.max(1, count - 1), offset); offset += 4; }
      if (withClassification) record.writeUInt8(i % 8, offset);
      fs.writeSync(fd, record);
    }
  } finally { fs.closeSync(fd); }
  return { count, headerBytes: header.length, recordSize };
}

function writeAsciiPly(file, options) {
  options = options || {};
  const count = options.count || 6000;
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment up=z',
    'comment units=m',
    'comment crs_wkt_uri=EPSG%3A32636%20%26%20local',
    `element vertex ${count}`,
    'property double x',
    'property double y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'property float intensity',
    'property uchar classification'
  ];
  if (options.withExtraScalar) lines.push('property short return_number');
  lines.push('end_header');
  for (let i = 0; i < count; i++) {
    const x = options.coincident ? 125000 : 500000 + (i % 100) * 0.01;
    const y = options.coincident ? 6250000 : 6000000 + Math.floor(i / 100) * 0.02;
    const z = options.coincident ? 112 : 117 + (i % 37) * 0.02;
    const row = [
      i === options.invalidIndex ? 'Infinity' : String(x),
      String(y), String(z),
      String(i & 255), String((i >> 8) & 255), String((i >> 16) & 255),
      String(i / Math.max(1, count - 1)), String(i % 8)
    ];
    if (options.withExtraScalar) row.push(String(i % 4));
    lines.push(row.join(options.mixedWhitespace && i % 2 ? '\t' : ' '));
  }
  const bytes = Buffer.from(lines.join(options.crlf ? '\r\n' : '\n') + (options.noFinalNewline ? '' : '\n'), 'ascii');
  fs.writeFileSync(file, bytes);
  return { count, bytes: bytes.length };
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
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < node.count; i++) {
        const at = i * index.stride;
        points.push([
          view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true),
          view.getUint8(at + 12), view.getUint8(at + 13), view.getUint8(at + 14)
        ]);
      }
      nextOffset += node.byteLength;
    }
  } finally { fs.closeSync(fd); }
  assert.equal(nextOffset, fs.statSync(path.join(outputDir, 'nodes.bin')).size);
  return points;
}

function previewRecords(parsed) {
  const out = new Map();
  for (let i = 0; i < parsed.count; i++) {
    const key = [parsed.pos[i * 3], parsed.pos[i * 3 + 1], parsed.pos[i * 3 + 2]].join(',');
    out.set(key, [
      parsed.pos[i * 3], parsed.pos[i * 3 + 1], parsed.pos[i * 3 + 2],
      Math.max(0, Math.min(255, Math.round(parsed.col[i * 3] * 255))),
      Math.max(0, Math.min(255, Math.round(parsed.col[i * 3 + 1] * 255))),
      Math.max(0, Math.min(255, Math.round(parsed.col[i * 3 + 2] * 255)))
    ]);
  }
  return out;
}

test('binary PLY out-of-core worker matches Z-up preview coordinates/colors and leaves only committed files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-z-'));
  const source = path.join(root, 'zup.ply'), output = path.join(root, 'store');
  const { count } = writeBinaryPly(source, { count: 6000, withIntensity: true, withClassification: true });
  try {
    assert.equal(Cloud.isBinaryPlyPointFile(source), true);
    const preview = Cloud.parseCloudFile(source, { maxPoints: count });
    const { result, progress } = await runWorker(source, output, { maxPoints: count, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.outOfCore, true);
    assert.equal(result.index.outOfCore, true);
    assert.equal(result.index.ingest, 'binary-ply-two-pass');
    assert.equal(result.index.pointCount, count);
    assert.equal(result.sourcePointCount, count);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    assert.ok(progress.some(p => p.phase === 'parse-scan'));
    assert.ok(progress.some(p => p.phase === 'parse-convert'));
    assert.ok(progress.some(p => p.phase === 'octree-partition'));
    assert.equal(progress.at(-1).phase, 'done');

    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, count);
    assert.ok(result.index.nodes.every(node => node.count <= 1000));
    const expected = previewRecords(preview);
    assert.equal(expected.size, count);
    for (const point of actual) {
      const key = point.slice(0, 3).join(',');
      assert.deepEqual(expected.get(key), point, 'point coordinates and quantized RGB match the existing parser');
      expected.delete(key);
    }
    assert.equal(expected.size, 0, 'no point is missing or duplicated');
    assert.deepEqual(fs.readdirSync(output).sort(), ['index.json', 'nodes.bin']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('binary big-endian Y-up PLY without RGB uses the same centered coordinates and height ramp', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-y-'));
  const source = path.join(root, 'yup.ply'), output = path.join(root, 'store');
  const { count } = writeBinaryPly(source, { count: 5000, bigEndian: true, up: 'y', withColor: false });
  try {
    const fd = fs.openSync(source, 'r');
    let preview;
    try { preview = Cloud.parsePLYFile(fd, fs.statSync(source).size, count); }
    finally { fs.closeSync(fd); }
    const { result } = await runWorker(source, output, { maxPoints: count, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.outOfCore, true);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.equal(result.index.sourceMeta.colored, false);
    assert.equal(result.index.hasColor, true, 'synthetic elevation ramp is packed for viewer rendering');
    const actual = readAllNodes(output, result.index);
    const expected = previewRecords(preview);
    assert.equal(actual.length, count);
    for (const point of actual) {
      const key = point.slice(0, 3).join(',');
      assert.deepEqual(expected.get(key), point, 'height-ramp color and Y-up coordinates match preview');
      expected.delete(key);
    }
    assert.equal(expected.size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('out-of-core binary PLY applies deterministic point-budget sampling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-sampling-'));
  const source = path.join(root, 'sample.ply'), output = path.join(root, 'store');
  const { count } = writeBinaryPly(source, { count: 10000 });
  try {
    const fd = fs.openSync(source, 'r');
    let preview;
    try { preview = Cloud.parsePLYFile(fd, fs.statSync(source).size, 2000); }
    finally { fs.closeSync(fd); }
    const { result } = await runWorker(source, output, { maxPoints: 2000, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sourcePointCount, count);
    assert.equal(result.indexedPointCount, 2000);
    assert.equal(result.index.pointCount, 2000);
    assert.equal(result.index.samplingRatio, 5);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    const actual = readAllNodes(output, result.index);
    const expected = previewRecords(preview);
    assert.equal(actual.length, 2000);
    for (const point of actual) {
      const key = point.slice(0, 3).join(',');
      assert.deepEqual(expected.get(key), point);
      expected.delete(key);
    }
    assert.equal(expected.size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('out-of-core PLY uses the open preview transform when indexing a denser source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-preview-transform-'));
  const source = path.join(root, 'sampled-preview.ply'), output = path.join(root, 'store');
  writeBinaryPly(source, { count: 10000 });
  try {
    const fd = fs.openSync(source, 'r');
    let preview;
    try { preview = Cloud.parsePLYFile(fd, fs.statSync(source).size, 2000); }
    finally { fs.closeSync(fd); }
    const { result } = await runWorker(source, output, {
      maxPoints: 10000, nodeCapacity: 1000, sourceTransform: preview.meta.srcXform
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.pointCount, 10000);
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    const points = readAllNodes(output, result.index);
    assert.ok(points.every(point => point.every(Number.isFinite)));
    assert.ok(result.index.bbox.mn.every(Number.isFinite) && result.index.bbox.mx.every(Number.isFinite));
    assert.ok(result.index.bbox.mn.every(value => Math.abs(value) < 1000) &&
      result.index.bbox.mx.every(value => Math.abs(value) < 1000),
      'viewer-space bounds are centered rather than left in large world coordinates');
    const [tx, ty, tz] = preview.meta.srcXform.t;
    const expectedFirst = [500000 - tx, 117 - tz, -(6000000 - ty)];
    assert.ok(points.some(point => expectedFirst.every((value, axis) => Math.abs(point[axis] - value) < 1e-5)),
      'the full-resolution point stays registered to the existing preview origin');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('out-of-core binary PLY skips and reports non-finite selected coordinates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-invalid-'));
  const source = path.join(root, 'invalid.ply'), output = path.join(root, 'store');
  const { count } = writeBinaryPly(source, { count: 10000, invalidIndex: 0 });
  try {
    const { result } = await runWorker(source, output, { maxPoints: 2000, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sourcePointCount, count);
    assert.equal(result.indexedPointCount, 1999);
    assert.equal(result.index.pointCount, 1999);
    assert.equal(result.index.sourceMeta.invalidPointCount, 1);
    assert.equal(result.index.sourceMeta.points, 1999);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('out-of-core degenerate PLY splits terminal records into bounded overlapping nodes without loss', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-degenerate-'));
  const source = path.join(root, 'coincident.ply'), output = path.join(root, 'store');
  const { count } = writeBinaryPly(source, { count: 30000, coincident: true, colorType: 'uchar' });
  try {
    const { result } = await runWorker(source, output, { maxPoints: count, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.pointCount, count);
    assert.ok(result.index.nodes.some(node => node.splitMode === 'balanced-overlap-fallback'));
    assert.ok(result.index.nodes.every(node => node.count <= 1000));
    const all = readAllNodes(output, result.index);
    assert.equal(all.length, count);
    const uniqueRgb = new Set(all.map(point => point.slice(3).join(',')));
    assert.equal(uniqueRgb.size, count, 'color-coded point identities prove no duplicate/lost records');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('out-of-core PLY detection accepts scalar ASCII points and rejects meshes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-candidate-'));
  try {
    const ascii = path.join(root, 'ascii.ply');
    writeAsciiPly(ascii, { count: 10 });
    assert.equal(Cloud.isBinaryPlyPointFile(ascii), false);
    assert.equal(Cloud.isOutOfCorePlyPointFile(ascii), true);
    const mesh = path.join(root, 'mesh.ply');
    fs.writeFileSync(mesh, 'ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n');
    assert.equal(Cloud.isBinaryPlyPointFile(mesh), false);
    assert.equal(Cloud.isOutOfCorePlyPointFile(mesh), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('binary PLY header info reports the authoritative count and stable file identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-info-'));
  const source = path.join(root, 'info.ply');
  const { count } = writeBinaryPly(source, { count: 1234, withIntensity: true });
  try {
    const info = Cloud.getBinaryPlyPointFileInfo(source);
    assert.equal(info.vertexCount, count);
    assert.equal(info.recordLength, 34);
    assert.ok(Number.isSafeInteger(info.dataOffset) && info.dataOffset > 0);
    assert.ok(/^\d+$/.test(info.fileSize));
    assert.ok(/^\d+$/.test(info.mtimeNs));
    assert.ok(info.device && info.inode);
    assert.equal(Cloud.sameBinaryPlyPointFileInfo(info, Cloud.getBinaryPlyPointFileInfo(source)), true);
    assert.equal(Cloud.isBinaryPlyPointFile(source), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ASCII PLY two-pass ingest matches preview coordinates/colors with CRLF, arbitrary whitespace and extra scalar fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-ascii-'));
  const source = path.join(root, 'ascii.ply'), output = path.join(root, 'store');
  const { count } = writeAsciiPly(source, { count: 6000, mixedWhitespace: true, crlf: true, withExtraScalar: true });
  try {
    const info = Cloud.getOutOfCorePlyPointFileInfo(source);
    assert.equal(info.vertexCount, count);
    assert.equal(info.format, 'ascii');
    assert.equal(info.propertyCount, 9);
    assert.equal(info.recordLength, 0);
    assert.equal(Cloud.samePlyPointFileInfo(info, Cloud.getOutOfCorePlyPointFileInfo(source)), true);

    const fd = fs.openSync(source, 'r');
    let preview;
    try { preview = Cloud.parsePLYFile(fd, fs.statSync(source).size, count); }
    finally { fs.closeSync(fd); }
    const { result, progress } = await runWorker(source, output, {
      maxPoints: count, nodeCapacity: 1000, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'ascii-ply-two-pass');
    assert.equal(result.index.pointCount, count);
    assert.equal(result.index.sourceMeta.units, 'm');
    assert.equal(result.index.sourceMeta.crsWkt, 'EPSG:32636 & local');
    assert.deepEqual(result.index.sourceMeta.srcXform, preview.meta.srcXform);
    assert.deepEqual(result.index.sourceMeta.streamAttributeOmissions, ['intensity', 'classification']);
    assert.ok(progress.some(p => p.phase === 'parse-scan'));
    assert.ok(progress.some(p => p.phase === 'parse-convert'));
    const expected = previewRecords(preview);
    const actual = readAllNodes(output, result.index);
    assert.equal(actual.length, count);
    for (const point of actual) {
      const key = point.slice(0, 3).join(',');
      assert.deepEqual(expected.get(key), point, 'ASCII point XYZ and RGB match the regular parser');
      expected.delete(key);
    }
    assert.equal(expected.size, 0, 'no ASCII point is missing or duplicated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ASCII PLY sampling, invalid coordinates and no-final-newline records remain bounded and deterministic', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-ascii-sample-'));
  const source = path.join(root, 'sample.ply'), output = path.join(root, 'store');
  const { count } = writeAsciiPly(source, { count: 10000, invalidIndex: 0, noFinalNewline: true });
  try {
    const info = Cloud.getOutOfCorePlyPointFileInfo(source);
    const { result } = await runWorker(source, output, {
      maxPoints: 2000, nodeCapacity: 1000, sourcePreflightInfo: info
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.ingest, 'ascii-ply-two-pass');
    assert.equal(result.sourcePointCount, count);
    assert.equal(result.indexedPointCount, 1999);
    assert.equal(result.index.sourceMeta.invalidPointCount, 1);
    assert.equal(result.index.sourceMeta.sampleStride, 5);
    assert.equal(readAllNodes(output, result.index).length, 1999);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ASCII PLY truncated or malformed rows fail safely and do not leave partial stores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-ascii-invalid-'));
  const source = path.join(root, 'bad.ply'), output = path.join(root, 'store');
  fs.writeFileSync(source, [
    'ply', 'format ascii 1.0', 'element vertex 2',
    'property float x', 'property float y', 'property float z',
    'end_header', '1 2 3', '4 5'
  ].join('\n') + '\n');
  try {
    const { result } = await runWorker(source, output, { maxPoints: 2, nodeCapacity: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /malformed ASCII PLY vertex record/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readdirSync(root), ['bad.ply']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('out-of-core builder rejects a source changed after its resource preflight', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ooc-ply-preflight-stale-'));
  const source = path.join(root, 'before.ply'), output = path.join(root, 'store');
  writeBinaryPly(source, { count: 5000 });
  try {
    const sourcePreflightInfo = Cloud.getOutOfCorePlyPointFileInfo(source);
    fs.appendFileSync(source, Buffer.from([0]));
    const { result } = await runWorker(source, output, {
      maxPoints: 5000, nodeCapacity: 1000, sourcePreflightInfo
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /changed after resource preflight/);
    assert.equal(fs.existsSync(output), false, 'stale preflight must remove the incomplete target directory');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});