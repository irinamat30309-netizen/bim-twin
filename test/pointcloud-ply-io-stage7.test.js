'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writePlyBinaryToDisk } = require('../pointcloud-ply-io');
const LAS = require('../las-node');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-ply-attrs-'));
}

test('streaming PLY writer round-trips RGB, intensity, classification and frame metadata', () => {
  const dir = tempDir();
  const file = path.join(dir, 'cloud.ply');
  try {
    const positions = new Float64Array([10, 2, -3, 11, 2.5, -2, 12, 3, -1]);
    const colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const intensity = new Float32Array([0, 0.25, 1]);
    const classification = new Uint8Array([2, 5, 255]);
    assert.equal(writePlyBinaryToDisk(file, positions, colors, true, {
      upAxis: 'y', coordinateFrame: 'viewer-local',
      intensity, classification
    }), 3);

    const header = fs.readFileSync(file).subarray(0, 2048).toString('ascii');
    assert.match(header, /comment up=y/);
    assert.match(header, /comment coordinate_frame=viewer-local/);
    assert.match(header, /property float intensity/);
    assert.match(header, /property uchar classification/);
    const cloud = LAS.parseCloudFile(file, { maxPoints: 100 });
    assert.equal(cloud.ok, true, cloud.message);
    assert.deepEqual(Array.from(cloud.intensity), [0, 0.25, 1]);
    assert.deepEqual(Array.from(cloud.classification), [2, 5, 255]);
    assert.deepEqual(Array.from(cloud.col.slice(0, 9)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.equal(cloud.count, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming PLY writer refuses misaligned or invalid attributes without leaving partial files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'invalid.ply');
  const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
  try {
    assert.throws(() => writePlyBinaryToDisk(file, positions, null, false, {
      intensity: new Float32Array([0.5])
    }), /intensity_array_length_mismatch/);
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => writePlyBinaryToDisk(file, positions, null, false, {
      classification: new Uint16Array([2, 300])
    }), /invalid_classification_value/);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Electron packaging includes the shared streaming PLY writer', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('pointcloud-ply-io.js'));
});