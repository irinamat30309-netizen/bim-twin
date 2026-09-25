'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../renderer/pointcloud-edit.js');

test('pointInPolygon: inside/outside square', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(E.pointInPolygon([5, 5], sq), true);
  assert.strictEqual(E.pointInPolygon([15, 5], sq), false);
  assert.strictEqual(E.pointInPolygon([-1, 5], sq), false);
});

test('selectByRect: picks points inside, skips NaN (behind camera)', () => {
  // 4 точки: 0 внутри, 1 вне, 2 NaN, 3 внутри
  const xy = new Float32Array([0.1, 0.1,  0.9, 0.9,  NaN, NaN,  0.2, 0.3]);
  const sel = E.selectByRect(xy, 4, { x0: 0.0, y0: 0.0, x1: 0.5, y1: 0.5 });
  assert.deepStrictEqual(sel, [0, 3]);
});

test('selectByRect: normalizes reversed rect corners', () => {
  const xy = new Float32Array([0.3, 0.3]);
  const sel = E.selectByRect(xy, 1, { x0: 0.5, y0: 0.5, x1: 0.0, y1: 0.0 });
  assert.deepStrictEqual(sel, [0]);
});

test('selectByPolygon: triangle contains only inner point', () => {
  const tri = [[0, 0], [10, 0], [0, 10]];
  const xy = new Float32Array([1, 1,  9, 9]);
  assert.deepStrictEqual(E.selectByPolygon(xy, 2, tri), [0]);
});

test('invertSelection', () => {
  assert.deepStrictEqual(E.invertSelection([1, 3], 5), [0, 2, 4]);
});

test('deleteByIndices: removes points and keeps colors aligned', () => {
  const pos = new Float32Array([0,0,0, 1,1,1, 2,2,2, 3,3,3]);
  const col = new Uint8Array([10,10,10, 20,20,20, 30,30,30, 40,40,40]);
  const r = E.deleteByIndices({ pos, col }, [1, 2]);
  assert.strictEqual(r.removed, 2);
  assert.deepStrictEqual(Array.from(r.pos), [0,0,0, 3,3,3]);
  assert.deepStrictEqual(Array.from(r.col), [10,10,10, 40,40,40]);
  assert.ok(r.col instanceof Uint8Array, 'preserves col type');
});

test('deleteByIndices: works without color', () => {
  const pos = new Float32Array([0,0,0, 1,1,1, 2,2,2]);
  const r = E.deleteByIndices({ pos, col: null }, new Set([0]));
  assert.strictEqual(r.col, null);
  assert.deepStrictEqual(Array.from(r.pos), [1,1,1, 2,2,2]);
});

test('keepByIndices: crops to selection', () => {
  const pos = new Float32Array([0,0,0, 1,1,1, 2,2,2, 3,3,3]);
  const r = E.keepByIndices({ pos, col: null }, [1, 3]);
  assert.strictEqual(r.removed, 2);
  assert.deepStrictEqual(Array.from(r.pos), [1,1,1, 3,3,3]);
});

test('toPLY: header + vertex count + float color scaling', () => {
  const pos = new Float32Array([1, 2, 3]);
  const col = new Float32Array([1, 0, 0]); // float 0..1 → 255,0,0
  const ply = E.toPLY({ pos, col });
  const lines = ply.trim().split('\n');
  assert.strictEqual(lines[0], 'ply');
  assert.ok(lines.includes('element vertex 1'));
  assert.ok(lines.includes('property uchar red'));
  const last = lines[lines.length - 1].split(' ');
  assert.deepStrictEqual(last.slice(3), ['255', '0', '0']);
});

test('toPLY: no color omits color properties', () => {
  const ply = E.toPLY({ pos: new Float32Array([0, 0, 0]), col: null });
  assert.ok(!ply.includes('property uchar red'));
  assert.ok(ply.includes('element vertex 1'));
});

function headerString(bytes) {
  let hs = '';
  for (let i = 0; i < bytes.length; i++) { hs += String.fromCharCode(bytes[i]); if (hs.endsWith('end_header\n')) break; }
  return hs;
}

test('toPLYBinary: binary_little_endian header + LE floats + float color scaling', () => {
  const pos = new Float32Array([1, 2, 3]);
  const col = new Float32Array([1, 0, 0]); // float 0..1 → 255,0,0
  const bytes = E.toPLYBinary({ pos, col });
  assert.ok(bytes instanceof Uint8Array);
  const hs = headerString(bytes);
  assert.ok(hs.includes('format binary_little_endian 1.0'));
  assert.ok(hs.includes('element vertex 1'));
  assert.ok(hs.includes('property uchar red'));
  // тело: 3 float32 LE + 3 uchar = 15 байт
  assert.strictEqual(bytes.length - hs.length, 15);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + hs.length, 15);
  assert.ok(Math.abs(dv.getFloat32(0, true) - 1) < 1e-6);
  assert.ok(Math.abs(dv.getFloat32(4, true) - 2) < 1e-6);
  assert.ok(Math.abs(dv.getFloat32(8, true) - 3) < 1e-6);
  assert.strictEqual(dv.getUint8(12), 255);
  assert.strictEqual(dv.getUint8(13), 0);
  assert.strictEqual(dv.getUint8(14), 0);
});

test('toPLYBinary: uchar color preserved (no scaling) + no-color 12-byte stride', () => {
  const pos = new Float32Array([0, 0, 0, 5, 6, 7]);
  const col = new Uint8Array([10, 20, 30, 40, 50, 60]);
  const bytes = E.toPLYBinary({ pos, col });
  const hs = headerString(bytes);
  assert.strictEqual(bytes.length - hs.length, 30); // 2 точки × 15
  const dv = new DataView(bytes.buffer, bytes.byteOffset + hs.length);
  // вторая точка: uchar цвет сохраняется без масштабирования
  assert.strictEqual(dv.getUint8(15 + 12), 40);
  assert.strictEqual(dv.getUint8(15 + 13), 50);
  assert.strictEqual(dv.getUint8(15 + 14), 60);
  // без цвета — stride 12
  const b2 = E.toPLYBinary({ pos: new Float32Array([1, 2, 3]), col: null });
  const hs2 = headerString(b2);
  assert.ok(!hs2.includes('property uchar red'));
  assert.strictEqual(b2.length - hs2.length, 12);
});
