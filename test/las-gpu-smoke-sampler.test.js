'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGpuLasSample } = require('../qa/windows-gpu-smoke/las-sample.cjs');

function makeLas12Format3(filePath) {
  const points = [
    { x: 0, y: 0, z: 0, intensity: 1000, classification: 2, rgb: [1000, 2000, 3000] },
    { x: 100, y: 0, z: 20, intensity: 2000, classification: 6, rgb: [2000, 3000, 4000] },
    { x: 0, y: 100, z: 40, intensity: 3000, classification: 2, rgb: [3000, 4000, 5000] },
    { x: 100, y: 100, z: 60, intensity: 4000, classification: 6, rgb: [4000, 5000, 6000] },
    { x: 20, y: 50, z: 80, intensity: 5000, classification: 2, rgb: [5000, 6000, 7000] },
    { x: 80, y: 50, z: 100, intensity: 6000, classification: 6, rgb: [6000, 7000, 8000] },
  ];
  const header = Buffer.alloc(227);
  header.write('LASF', 0, 'ascii');
  header.writeUInt8(1, 24);
  header.writeUInt8(2, 25);
  header.writeUInt16LE(227, 94);
  header.writeUInt32LE(227, 96);
  header.writeUInt32LE(0, 100);
  header.writeUInt8(3, 104);
  header.writeUInt16LE(34, 105);
  header.writeUInt32LE(points.length, 107);
  header.writeDoubleLE(0.01, 131);
  header.writeDoubleLE(0.01, 139);
  header.writeDoubleLE(0.01, 147);
  header.writeDoubleLE(0, 155);
  header.writeDoubleLE(0, 163);
  header.writeDoubleLE(0, 171);

  const records = Buffer.alloc(points.length * 34);
  points.forEach((point, index) => {
    const record = index * 34;
    records.writeInt32LE(point.x, record);
    records.writeInt32LE(point.y, record + 4);
    records.writeInt32LE(point.z, record + 8);
    records.writeUInt16LE(point.intensity, record + 12);
    records.writeUInt8(point.classification, record + 15);
    point.rgb.forEach((value, channel) => records.writeUInt16LE(value, record + 28 + channel * 2));
  });
  fs.writeFileSync(filePath, Buffer.concat([header, records]));
  return points.length;
}

function floatSection(data, section, expectedValues) {
  assert.equal(section.byteLength, expectedValues * 4);
  const start = data.byteOffset + section.offset;
  return new Float32Array(data.buffer.slice(start, start + section.byteLength));
}

test('LAS GPU sampler uses BIM Twin production parser and writes bounded WebGL arrays', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-las-gpu-sample-'));
  try {
    const input = path.join(tempDir, 'fixture.las');
    const pointCount = makeLas12Format3(input);
    const outputDir = path.join(tempDir, 'sample');
    const progressEvents = [];
    const sample = createGpuLasSample(input, outputDir, {
      maxPoints: 3,
      onProgress: (progress) => progressEvents.push(progress)
    });

    assert.equal(sample.metadata.format, 'LAS fmt 3');
    assert.equal(sample.metadata.fileBytes, fs.statSync(input).size);
    assert.equal(sample.metadata.totalPoints, pointCount);
    assert.equal(sample.metadata.samplePoints, 3);
    assert.equal(sample.metadata.hasColor, true);
    assert.equal(sample.metadata.hasIntensity, true);
    assert.equal(sample.metadata.hasClassification, true);
    assert.ok(progressEvents.length > 0);
    assert.ok(progressEvents.every((event) =>
      event && typeof event.phase === 'string' &&
      Number.isFinite(event.fraction) && event.fraction >= 0 && event.fraction <= 1
    ), JSON.stringify(progressEvents));
    assert.ok(progressEvents.some((event) => event.phase === 'read'));

    const metadata = JSON.parse(fs.readFileSync(sample.metadataPath, 'utf8'));
    const data = fs.readFileSync(sample.samplePath);
    assert.equal(data.byteLength, metadata.byteLength);
    const positions = floatSection(data, metadata.sections.positions, 9);
    const colors = floatSection(data, metadata.sections.colors, 9);
    const intensities = floatSection(data, metadata.sections.intensity, 3);
    const classifications = new Uint8Array(data.buffer.slice(
      data.byteOffset + metadata.sections.classification.offset,
      data.byteOffset + metadata.sections.classification.offset + metadata.sections.classification.byteLength
    ));

    assert.ok(Array.from(positions).every(Number.isFinite));
    assert.ok(Array.from(colors).every((value) => value >= 0 && value <= 1));
    assert.ok(Array.from(intensities).every((value) => value > 0 && value < 1));
    assert.ok(Array.from(classifications).every((value) => value === 2 || value === 6));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});