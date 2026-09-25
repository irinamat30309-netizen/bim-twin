'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Octree = require('../renderer/octree-store');

function makeXYZ(file, count) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, '# BIM_TWIN_UP=z\n# BIM_TWIN_UNITS=m\n');
    for (let i = 0; i < count; i++) {
      fs.writeSync(fd, `${1000 + i * 0.03125} ${2000 + i * 0.015625} ${10 + i * 0.0078125}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function makeDegenerateXYZ(file, count) {
  const fd = fs.openSync(file, 'w');
  try {
    for (let i = 0; i < count; i++) fs.writeSync(fd, '125000 6250000 112\n');
  } finally {
    fs.closeSync(fd);
  }
}

function runWorker(sourcePath, outputDir, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'octree-build-worker.js'), {
      workerData: { sourcePath, outputDir, maxPoints: options.maxPoints, nodeCapacity: options.nodeCapacity }
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

test('worker parses, partitions and packs octree nodes to disk without a contiguous full-cloud blob', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-octree-stage4-'));
  const source = path.join(root, 'cloud.xyz'), output = path.join(root, 'store');
  const count = 200000;
  makeXYZ(source, count);
  try {
    const { result, progress } = await runWorker(source, output, { maxPoints: count, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.pointCount, count);
    assert.equal(result.sourcePointCount, count);
    assert.ok(result.index.nodeCount > 8);
    assert.ok(progress.some(p => String(p.phase).startsWith('parse-')));
    assert.ok(progress.some(p => p.phase === 'octree-build'));
    assert.ok(progress.some(p => p.phase === 'octree-write'));
    assert.ok(progress.findIndex(p => p.phase === 'octree-build') < progress.findIndex(p => p.phase === 'octree-write'),
      'node writes stream during build, then the completed store reports its final write phase');
    assert.equal(progress.at(-1).phase, 'done');

    const nodePath = path.join(output, 'nodes.bin');
    const indexPath = path.join(output, 'index.json');
    assert.ok(fs.statSync(nodePath).size > 0);
    assert.equal(fs.statSync(nodePath).size, result.bytes);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(nodePath)).digest('hex'), result.sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, 'utf8')), result.index);

    let total = 0, previousEnd = 0;
    const records = new Set();
    const fd = fs.openSync(nodePath, 'r');
    try {
      for (const descriptor of result.index.nodes) {
        assert.equal(descriptor.offset, previousEnd);
        assert.equal(descriptor.byteLength, descriptor.count * result.index.stride);
        const bytes = Buffer.alloc(descriptor.byteLength);
        assert.equal(fs.readSync(fd, bytes, 0, bytes.length, descriptor.offset), bytes.length);
        const node = Octree.deserializeNodePoints(bytes, descriptor.count, result.index.hasColor);
        for (let i = 0; i < descriptor.count; i++) {
          const key = [node.pos[3 * i], node.pos[3 * i + 1], node.pos[3 * i + 2]].join(',');
          assert.ok(!records.has(key), 'point is not duplicated in multiple octree nodes');
          records.add(key);
        }
        total += descriptor.count;
        previousEnd += descriptor.byteLength;
      }
    } finally { fs.closeSync(fd); }
    assert.equal(total, count);
    assert.equal(records.size, count);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker reports parser errors and removes an incomplete octree directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-octree-error-'));
  const source = path.join(root, 'broken.xyz'), output = path.join(root, 'failed-store');
  fs.writeFileSync(source, '# not point records\ninvalid\n');
  try {
    const { result } = await runWorker(source, output, { maxPoints: 1000, nodeCapacity: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /координат|строк|point|cloud/i);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sampled octree metadata reports the observed approximate ratio, not a false exact stride', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-octree-sampling-'));
  const source = path.join(root, 'sampled.xyz'), output = path.join(root, 'store');
  const fd = fs.openSync(source, 'w');
  try {
    for (let i = 0; i < 210000; i++) {
      // This numeric-but-unrepresentable XYZ record is counted during the
      // indexing pass and skipped during point decode. It makes the actual
      // source/indexed ratio differ slightly from the parser's stride of 2.
      fs.writeSync(fd, i === 0 ? '1e999 0 0\n' : `${i} ${i % 31} ${i % 17}\n`);
    }
  } finally { fs.closeSync(fd); }
  try {
    const { result } = await runWorker(source, output, { maxPoints: 200000, nodeCapacity: 1000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sourcePointCount, 210000);
    assert.equal(result.indexedPointCount, 104999);
    assert.equal(result.index.exactDecimation, false);
    assert.ok(Math.abs(result.index.samplingRatio - 210000 / 104999) < 1e-12);
    assert.equal(result.index.decimation, 2,
      'user-facing estimate should use the observed ratio rather than round a near-2 sample up to 3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disk builder keeps degenerate depth-limited nodes under the node-size cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-octree-degenerate-'));
  const source = path.join(root, 'coincident.xyz'), output = path.join(root, 'store');
  const count = 30000, capacity = 1000;
  makeDegenerateXYZ(source, count);
  try {
    const { result } = await runWorker(source, output, { maxPoints: count, nodeCapacity: capacity });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.index.pointCount, count);
    assert.ok(result.index.nodes.some(node => node.splitMode === 'balanced-overlap-fallback'));
    assert.ok(result.index.nodes.every(node => node.count <= capacity),
      'no descriptor exceeds the renderer’s bounded node-read size for coincident data');
    assert.equal(result.index.nodes.reduce((sum, node) => sum + node.count, 0), count);
    for (const node of result.index.nodes) {
      assert.equal(node.byteLength, node.count * result.index.stride);
      assert.ok(node.offset + node.byteLength <= result.bytes);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build-file set includes both the unpacked worker and its local parser/index dependencies', () => {
  const pkg = require('../package.json');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const file of ['octree-build-worker.js', 'octree-build-core.js']) assert.ok(pkg.build.files.includes(file));
  assert.ok(pkg.build.files.includes('octree-resource-budget.js'));
  assert.ok(pkg.build.files.includes('pcd-out-of-core.js'));
  assert.match(main, /require\(['"]\.\/octree-resource-budget['"]\)/);
  for (const file of ['octree-build-worker.js', 'octree-build-core.js', 'renderer/octree-store.js', 'db/atomic-file.js']) {
    assert.ok(pkg.build.asarUnpack.includes(file));
  }
  assert.match(main, /new Worker\(path\.join\(__dirname, 'octree-build-worker\.js'\)/);
  assert.match(main, /ipcMain\.on\('bim:cancelOctreeBuild'/);
  assert.match(main, /ipcMain\.handle\('bim:readOctreeNode'/);
  assert.match(main, /ipcMain\.handle\('bim:deleteOctree'/);
  assert.match(main, /lstatSync\(rd\)\.isSymbolicLink/);
  assert.match(preload, /onOctreeProgress:/);
  assert.match(preload, /cancelOctreeBuild:/);
  assert.match(preload, /deleteOctree:/);
});