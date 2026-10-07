'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PCE = require('../renderer/pointcloud-edit.js');

function mkCloud() {
  // 3 точки с цветом 0..1
  const pos = new Float32Array([0, 0, 0, 1, 2, 3, -1.5, 4, 2.25]);
  const col = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  return { pos, col };
}

test('toLASBinary: valid LAS 1.2 header + record layout', () => {
  assert.strictEqual(typeof PCE.toLASBinary, 'function');
  const c = mkCloud();
  const u8 = PCE.toLASBinary(c);
  assert.ok(u8 instanceof Uint8Array);
  const HEADER = 227, REC = 26, n = 3;
  assert.strictEqual(u8.length, HEADER + n * REC);
  // сигнатура 'LASF'
  assert.strictEqual(String.fromCharCode(u8[0], u8[1], u8[2], u8[3]), 'LASF');
  const dv = new DataView(u8.buffer);
  assert.strictEqual(dv.getUint8(24), 1); // major
  assert.strictEqual(dv.getUint8(25), 2); // minor -> 1.2
  assert.strictEqual(dv.getUint16(94, true), HEADER); // header size
  assert.strictEqual(dv.getUint32(96, true), HEADER); // offset to data
  assert.strictEqual(dv.getUint8(104), 2); // PDRF 2 (XYZ+RGB)
  assert.strictEqual(dv.getUint16(105, true), REC); // record length
  assert.strictEqual(dv.getUint32(107, true), n); // legacy point count
  // offset = min по осям; minx = -1.5 (у 3-й точки) -> её X == 0, а X 1-й точки = (0-(-1.5))/0.001 = 1500
  assert.strictEqual(dv.getInt32(HEADER + 2 * REC, true), 0);
  assert.strictEqual(dv.getInt32(HEADER, true), 1500);
  // цвет первой точки красный -> R=255*257
  assert.strictEqual(dv.getUint16(HEADER + 20, true), 255 * 257);
});

test('toLASBinary: handles empty cloud', () => {
  const u8 = PCE.toLASBinary({ pos: new Float32Array([]), col: null });
  assert.strictEqual(u8.length, 227);
  assert.strictEqual(new DataView(u8.buffer).getUint32(107, true), 0);
});

test('toXYZText: x y z r g b per line', () => {
  assert.strictEqual(typeof PCE.toXYZText, 'function');
  const txt = PCE.toXYZText(mkCloud());
  const lines = txt.split('\n');
  assert.strictEqual(lines.length, 3);
  const p = lines[0].split(' ');
  assert.strictEqual(p.length, 6);
  assert.strictEqual(p[0], '0'); assert.strictEqual(p[1], '0'); assert.strictEqual(p[2], '0');
  assert.strictEqual(p[3], '255'); assert.strictEqual(p[4], '0'); assert.strictEqual(p[5], '0');
});

test('toXYZText: no color -> only coords', () => {
  const txt = PCE.toXYZText({ pos: new Float32Array([1, 2, 3]), col: null });
  assert.strictEqual(txt.split(' ').length, 3);
});
