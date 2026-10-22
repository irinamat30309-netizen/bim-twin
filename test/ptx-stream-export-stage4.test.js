'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SmartSaveFmt = require('../renderer/lixel-smart-save');
const { PTXStreamValidator } = require('../renderer/ptx-stream-validator');

function cloud(count) {
  const pos = new Float64Array(count * 3);
  const col = new Float32Array(count * 3);
  const intensity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = i === 0 ? 0 : 500000 + i * 0.125;
    pos[i * 3 + 1] = 6000000 + i * 0.25;
    pos[i * 3 + 2] = 117.5 + i * 0.01;
    col[i * 3] = (i % 3) === 0 ? 1 : 0;
    col[i * 3 + 1] = (i % 3) === 1 ? 1 : 0;
    col[i * 3 + 2] = (i % 3) === 2 ? 1 : 0;
    intensity[i] = count > 1 ? i / (count - 1) : 1;
  }
  return { pos, col, intensity, count };
}

test('incremental PTX validator accepts exact header/point count across arbitrary chunk boundaries', () => {
  const text = SmartSaveFmt.toPTXText(cloud(3));
  const validator = new PTXStreamValidator(3);
  for (let i = 0; i < text.length; i += 7) validator.push(text.slice(i, i + 7));
  assert.deepEqual(validator.finish(), { bytes: Buffer.byteLength(text), points: 3 });
  assert.throws(() => validator.finish(), /already finished/);
});

test('incremental PTX validator accepts multiple scan grids with bounded chunk boundaries', () => {
  const rowPose = [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,200,300,1];
  const columnPose = [1,0,0,10, 0,1,0,20, 0,0,1,30, 0,0,0,1];
  const input = {
    pos: new Float64Array([101,202,303, 102,204,306, 11,22,33]),
    col: new Float32Array([1,0,0, 0,1,0, 0,0,1]),
    intensity: new Float32Array([0.5,0.25,0.75]),
    count: 3,
    meta: {
      format: 'PTX (2 scans)',
      scans: [
        { start: 0, count: 2, transform: rowPose, matrixConvention: 'row-vector',
          scannerPosition: [100,200,300], axes: [[1,0,0],[0,1,0],[0,0,1]] },
        { start: 2, count: 1, transform: columnPose, matrixConvention: 'column-vector',
          scannerPosition: [9,8,7], axes: [[1,0,0],[0,1,0],[0,0,1]] }
      ]
    }
  };
  const text = SmartSaveFmt.toPTXText(input);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines[0], '2');
  assert.equal(lines[1], '1');
  assert.equal(lines[12], '1', 'second scan begins after first scan header and two returns');
  const validator = new PTXStreamValidator(3);
  for (let i = 0; i < text.length; i += 11) validator.push(text.slice(i, i + 11));
  assert.deepEqual(validator.finish(), { bytes: Buffer.byteLength(text), points: 3 });

  const overDeclared = new PTXStreamValidator(3);
  assert.throws(() => overDeclared.push(text.replace(/^2\n1\n/, '4\n1\n')), /grid exceeds|point count/);
  const truncatedGrid = new PTXStreamValidator(3);
  assert.throws(() => truncatedGrid.push(text.replace(/^2\n1\n/, '2\n2\n')), /grid exceeds|incomplete|point rows/);
});

test('incremental PTX validator rejects wrong point count, sentinel and malformed/control data', () => {
  const valid = SmartSaveFmt.toPTXText(cloud(1));
  const wrongCount = valid.replace(/^1\n/, '2\n');
  const countCheck = new PTXStreamValidator(1);
  assert.throws(() => countCheck.push(wrongCount), /point count/);

  const sentinelCloud = { pos: new Float32Array([1, 2, 3]), count: 1 };
  const sentinelText = SmartSaveFmt.toPTXText(sentinelCloud).replace(/\n1 2 3\n$/, '\n0 0 0\n');
  const sentinel = new PTXStreamValidator(1);
  assert.throws(() => sentinel.push(sentinelText), /missing-return sentinel/);

  const nonAscii = new PTXStreamValidator(1);
  assert.throws(() => nonAscii.push('1\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n1 2 3\nΩ'), /non-ASCII/);
  const blank = new PTXStreamValidator(1);
  assert.throws(() => blank.push(valid + '\n'), /empty PTX line/);
});

test('async PTX generator exactly matches deterministic text while yielding bounded chunks', async () => {
  const input = cloud(2507);
  const expected = SmartSaveFmt.toPTXText(input);
  const chunks = [];
  let wrotePoints = 0;
  for await (const item of SmartSaveFmt.ptxTextChunksAsync(input, 1000)) {
    if (item.text) {
      chunks.push(item.text);
      if (item.phase === 'write') wrotePoints = item.points;
    }
  }
  const actual = chunks.join('');
  assert.equal(actual, expected);
  assert.equal(wrotePoints, input.count);
  assert.ok(chunks.length >= 3, 'header and bounded point blocks are emitted separately');
  assert.ok(chunks.every(chunk => chunk.length < 4 * 1024 * 1024));
  const validator = new PTXStreamValidator(input.count);
  for (const chunk of chunks) validator.push(chunk);
  assert.equal(validator.finish().points, input.count);
});

test('async PTX preflight remains cancellable during large-array validation', async () => {
  let cancelled = false, progressEvents = 0;
  const input = cloud(400000);
  await assert.rejects(async () => {
    for await (const item of SmartSaveFmt.ptxTextChunksAsync(input, 10000, () => cancelled)) {
      if (item.phase === 'scan') {
        progressEvents++;
        cancelled = true;
      }
    }
  }, error => error && error.cancelled === true && /отменён/i.test(error.message));
  assert.equal(progressEvents, 1, 'cooperative scan yields to the UI before observing cancel');
});

test('PTX uint16 RGB uses full 16-bit input range before standard 8-bit conversion', () => {
  const input = { pos: new Float32Array([1, 2, 3]), col: new Uint16Array([32768, 65535, 0]), count: 1 };
  const row = SmartSaveFmt.toPTXText(input).trimEnd().split('\n').at(-1).split(' ').map(Number);
  assert.deepEqual(row.slice(4), [128, 255, 0]);
});

test('streamed PTX IPC is allowlisted, sender-scoped, bounded and uses atomic temp commit', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const name of ['beginExportStream', 'writeExportStreamChunk', 'finishExportStream', 'cancelExportStream']) {
    assert.match(preload, new RegExp(name + ':'));
  }
  assert.match(main, /ext !== 'ptx'/);
  assert.match(main, /session\.sender === \(event && event\.sender\)/);
  assert.match(main, /MAX_EXPORT_CHUNK_CHARS/);
  assert.match(main, /MAX_EXPORT_STREAM_BYTES/);
  assert.match(main, /saveCloudOutputFromTemp\(session\.target, session\.tempPath/);
  assert.match(main, /PTXStreamValidator/);
});