'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Cloud = require('../las-node');

function temp(ext) {
  return path.join(os.tmpdir(), 'bimtwin-cloud-worker-' + process.pid + '-' + Math.random().toString(36).slice(2) + ext);
}

function zeroLzf(length) {
  if (!Number.isSafeInteger(length) || length < 1) throw new Error('invalid fixture length');
  const repeated = length - 1;
  const blocks = Math.floor(repeated / 264);
  const remainder = repeated - blocks * 264;
  const out = Buffer.alloc(2 + blocks * 3 + remainder + Math.ceil(remainder / 32));
  out[0] = 0; // one literal zero establishes the overlapping back-reference
  out[1] = 0;
  let offset = 2;
  for (let i = 0; i < blocks; i++) {
    out[offset++] = 0xe0; // extended LZF run: 7 + 255 + 2 = 264 bytes
    out[offset++] = 255;
    out[offset++] = 0; // distance 1; overlapping copy repeats the zero byte
  }
  let left = remainder;
  while (left) {
    const count = Math.min(32, left);
    out[offset++] = count - 1;
    out.fill(0, offset, offset + count);
    offset += count;
    left -= count;
  }
  return out;
}

function writeZeroCompressedPcd(file, count) {
  const rawBytes = count * 12;
  if (!Number.isSafeInteger(rawBytes)) throw new Error('fixture is too large');
  const compressed = zeroLzf(rawBytes);
  const header = Buffer.from([
    'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F',
    'COUNT 1 1 1', 'WIDTH ' + count, 'HEIGHT 1', 'POINTS ' + count,
    'DATA binary_compressed', ''
  ].join('\n'));
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(compressed.length, 0);
  sizes.writeUInt32LE(rawBytes, 4);
  fs.writeFileSync(file, Buffer.concat([header, sizes, compressed]));
}

test('async point-cloud parsing runs in a worker, streams monotonic progress and transfers typed arrays', async () => {
  const file = temp('.xyz');
  fs.writeFileSync(file, [
    '# BIM_TWIN_UP=z',
    '# BIM_TWIN_UNITS=m',
    '# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent('PROJCRS["Worker test",ID["EPSG",32610]]'),
    'x y z intensity red green blue',
    '500000.125 6000000.25 117.5 0.0 255 0 0',
    '500001.125 6000001.25 119.0 0.5 0 255 0',
    ''
  ].join('\n'));
  const updates = [];
  try {
    const parsed = await Cloud.parseCloudFileAsync(file, {
      maxPoints: 200000,
      onProgress: value => updates.push(value)
    });
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.count, 2);
    assert.ok(parsed.pos instanceof Float32Array);
    assert.ok(parsed.col instanceof Float32Array);
    assert.ok(parsed.intensity instanceof Float32Array);
    assert.equal(parsed.meta.crsWkt, 'PROJCRS["Worker test",ID["EPSG",32610]]');
    assert.ok(updates.length >= 3, 'header/index/finalize progress reaches the caller');
    for (let i = 1; i < updates.length; i++) {
      assert.ok(Number(updates[i].fraction) >= Number(updates[i - 1].fraction),
        `progress must be monotonic: ${updates[i - 1].fraction} -> ${updates[i].fraction}`);
    }
    assert.equal(updates[updates.length - 1].phase, 'finalize');
    assert.ok(Number(updates[updates.length - 1].fraction) >= 0.95);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('PCD LZF worker cleans its private planar scratch on success and cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-cloud-worker-pcd-'));
  const file = path.join(root, 'compressed.pcd');
  try {
    writeZeroCompressedPcd(file, 4);
    const progress = [];
    const parsed = await Cloud.parseCloudFileAsync(file, {
      maxPoints: 200000, scratchBaseDir: root, onProgress: value => progress.push(value)
    });
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.count, 4);
    assert.ok(progress.some(value => value.phase === 'pcd-lzf-decompress'));
    assert.ok(progress.some(value => value.phase === 'pcd-lzf-sample'));
    for (let i = 1; i < progress.length; i++) {
      assert.ok(Number(progress[i].fraction) >= Number(progress[i - 1].fraction),
        `PCD worker progress must be monotonic: ${progress[i - 1].fraction} -> ${progress[i].fraction}`);
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.pcd']);

    const brokenHeader = Buffer.from([
      'VERSION .7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F',
      'COUNT 1 1 1', 'WIDTH 1', 'HEIGHT 1', 'POINTS 1',
      'DATA binary_compressed', ''
    ].join('\n'));
    const brokenSizes = Buffer.alloc(8);
    brokenSizes.writeUInt32LE(2, 0);
    brokenSizes.writeUInt32LE(12, 4);
    fs.writeFileSync(file, Buffer.concat([brokenHeader, brokenSizes, Buffer.from([0, 0])]));
    const broken = await Cloud.parseCloudFileAsync(file, { scratchBaseDir: root });
    assert.equal(broken.ok, false);
    assert.match(broken.message, /truncated LZF payload/);
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.pcd'],
      'malformed LZF also removes its partial planar store');

    // The worker's first LZF progress event is emitted after it has created
    // the planar store. Terminating here exercises parent-owned cleanup (the
    // worker's finally block cannot run after Worker.terminate()).
    writeZeroCompressedPcd(file, 3000000);
    const controller = new AbortController();
    let lzfProgressSeen = false;
    const cancelled = await Cloud.parseCloudFileAsync(file, {
      maxPoints: 200000,
      scratchBaseDir: root,
      signal: controller.signal,
      onProgress: value => {
        if (!lzfProgressSeen && value && value.phase === 'pcd-lzf-decompress') {
          lzfProgressSeen = true;
          controller.abort();
        }
      }
    });
    assert.equal(lzfProgressSeen, true, 'the worker reported streaming decompression progress');
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(fs.readdirSync(root).sort(), ['compressed.pcd'],
      'parent removes the worker scratch directory only after termination');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PCD sampled preview rejects an unsafe RAM estimate before allocating output arrays', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-cloud-worker-pcd-memory-'));
  const file = path.join(root, 'oversized-preview.pcd');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch);
  const originalAvailableMemory = process.availableMemory;
  const originalFreeMem = os.freemem;
  try {
    // The compressed fixture is small on disk but declares two million sampled
    // output points. The parser must deny it before allocating multi-hundred-MiB
    // typed arrays or creating an LZF scratch directory.
    writeZeroCompressedPcd(file, 2000000);
    process.availableMemory = () => 256 * 1024 * 1024;
    os.freemem = () => 512 * 1024 * 1024;

    const result = Cloud.parseCloudFile(file, {
      maxPoints: 2000000,
      scratchBaseDir: scratch
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /недостаточно доступной оперативной памяти/i);
    assert.match(result.message, /оценка 372 МиБ/);
    assert.deepEqual(fs.readdirSync(scratch), [],
      'RAM preflight runs before PCD LZF temporary storage is created');
  } finally {
    process.availableMemory = originalAvailableMemory;
    os.freemem = originalFreeMem;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PTX multi-scan transform and per-scan progress survive the asynchronous worker boundary', async () => {
  const file = temp('.ptx');
  fs.writeFileSync(file, [
    '1', '2', '0 0 0', '1 0 0', '0 1 0', '0 0 1',
    '1 0 0 0', '0 1 0 0', '0 0 1 0', '100 200 300 1',
    '1 2 3 0.5 255 0 0', '3 4 5 0.25 0 255 0', ''
  ].join('\n'));
  const updates = [];
  try {
    const parsed = await Cloud.parseCloudFileAsync(file, { onProgress: value => updates.push(value) });
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.meta.scanCount, 1);
    assert.equal(parsed.meta.scans[0].matrixConvention, 'row-vector');
    assert.equal(parsed.count, 2);
    const t = parsed.meta.srcXform.t;
    for (const [i, expected] of [[0, [101, 202, 303]], [1, [103, 204, 305]]]) {
      const world = [parsed.pos[i * 3] + t[0], -parsed.pos[i * 3 + 2] + t[1], parsed.pos[i * 3 + 1] + t[2]];
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(world[axis] - expected[axis]) < 1e-5);
    }
    assert.deepEqual(Array.from(parsed.intensity), [0.5, 0.25]);
    assert.ok(updates.some(event => event.phase === 'ptx-index'));
    assert.ok(updates.some(event => event.phase === 'ptx-sample'));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('worker import cancellation terminates a long text parse and returns an explicit cancelled result', async () => {
  const file = temp('.xyz');
  const fd = fs.openSync(file, 'w');
  const line = '500000 6000000 117 0.5 255 0 0\n';
  const chunk = Buffer.from(line.repeat(30000));
  try {
    for (let written = 0; written < 18 * 1024 * 1024; written += chunk.length) {
      fs.writeSync(fd, chunk, 0, chunk.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  const controller = new AbortController();
  let firstProgress = null;
  try {
    const result = await Cloud.parseCloudFileAsync(file, {
      maxPoints: 200000,
      signal: controller.signal,
      onProgress: value => {
        if (firstProgress) return;
        firstProgress = value;
        controller.abort();
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.match(result.message, /отменён/i);
    assert.ok(firstProgress, 'the worker emitted a cancellable progress update');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('worker import converts invalid files into actionable errors without crashing the caller', async () => {
  const file = temp('.xyz');
  fs.writeFileSync(file, '# no coordinates here\nnot a cloud\n');
  try {
    const result = await Cloud.parseCloudFileAsync(file);
    assert.equal(result.ok, false);
    assert.match(result.message, /координатами|строк/i);
  } finally {
    fs.rmSync(file, { force: true });
  }
});