'use strict';
const test   = require('node:test');
const assert = require('node:assert');

global.window = global;
// Fake fetch: hierarchy uses correct Potree 2.0 offsets
// Node layout: type(1)+childMask(1)+numPoints(4)+byteOffset(8)+byteSize(8) = 22 bytes
global.fetch  = async (url, opts) => ({
  arrayBuffer: async () => {
    const buf = new ArrayBuffer(44); // 2 nodes x 22 bytes
    const dv  = new DataView(buf);
    // Node 0
    dv.setUint8(0, 1);               // type
    dv.setUint8(1, 3);               // childMask
    dv.setUint32(2, 1000, true);     // numPoints  @ +2
    dv.setBigUint64(6,  0n, true);   // byteOffset @ +6
    dv.setBigUint64(14, 16000n, true); // byteSize  @ +14
    // Node 1
    dv.setUint8(22, 1);
    dv.setUint8(23, 0);
    dv.setUint32(24, 500, true);     // numPoints  @ 22+2
    dv.setBigUint64(28, 16000n, true); // byteOffset @ 22+6
    dv.setBigUint64(36, 8000n, true);  // byteSize   @ 22+14
    return buf;
  },
  json: async () => ({
    version: '2.0',
    scale:  [0.0001, 0.0001, 0.0001],
    offset: [0, 0, 0],
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] }
  })
});

require('../renderer/potree-loader.js');
const { PotreeLoader } = global;

test('PotreeLoader: class exposed on global', () => {
  assert.strictEqual(typeof PotreeLoader, 'function');
});

test('PotreeLoader: open() parses metadata', async () => {
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  const bb = ldr.getBoundingBox();
  assert.ok(bb, 'has bounding box');
  assert.ok(typeof bb.min[0] === 'number');
  assert.ok(typeof bb.max[2] === 'number');
});

test('PotreeLoader: open() decodes 2 hierarchy nodes', async () => {
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  assert.strictEqual(ldr.nodes.length, 2);
  assert.strictEqual(ldr.nodes[0].numPoints, 1000);
  assert.strictEqual(ldr.nodes[1].numPoints, 500);
});

test('PotreeLoader: summary() correct totals', async () => {
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  const s = ldr.summary();
  assert.strictEqual(s.format, 'Potree 2.0');
  assert.strictEqual(s.totalNodes, 2);
  assert.strictEqual(s.totalPoints, 1500);
  assert.strictEqual(s.loadedNodes, 0);
});

test('PotreeLoader: setLoadBudget chains', async () => {
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  assert.strictEqual(ldr.setLoadBudget(4), ldr);
  assert.strictEqual(ldr._budget, 4);
});

test('PotreeLoader: on() fires open event', async () => {
  let called = false;
  const ldr = new PotreeLoader();
  ldr.on('open', () => { called = true; });
  await ldr.open('fake://base');
  assert.ok(called);
});

test('PotreeLoader: pointSize default 2.5', () => {
  assert.strictEqual(new PotreeLoader().pointSize, 2.5);
});

test('PotreeLoader: meta.scale is sub-millimetre', async () => {
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  assert.ok(ldr.meta.scale[0] < 0.001);
});

test('PotreeLoader: byteOffset/byteSize decoded correctly', async () => {
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  assert.strictEqual(ldr.nodes[0].byteOffset, 0);
  assert.strictEqual(ldr.nodes[0].byteSize, 16000);
  assert.strictEqual(ldr.nodes[1].byteOffset, 16000);
  assert.strictEqual(ldr.nodes[1].byteSize, 8000);
});
