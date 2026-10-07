const test = require('node:test');
const assert = require('node:assert');
const DXF = require('../renderer/dxf.js');

test('toDxf produces valid R12 skeleton', () => {
  const s = DXF.toDxf([]);
  assert.match(s, /\nSECTION\n/); assert.match(s, /AC1009/);
  assert.match(s, /\nHEADER\n/); assert.match(s, /\nTABLES\n/); assert.match(s, /\nENTITIES\n/);
  assert.ok(s.trim().endsWith('EOF'));
});

test('LINE entity has both endpoints', () => {
  const s = DXF.toDxf([{ type: 'line', layer: 'DRAW', a: [1, 2, 0], b: [4, 6, 0] }]);
  assert.match(s, /\nLINE\n/);
  assert.match(s, /\n10\n1\.0\n/); assert.match(s, /\n20\n2\.0\n/);
  assert.match(s, /\n11\n4\.0\n/); assert.match(s, /\n21\n6\.0\n/);
});

test('closed POLYLINE uses 70=1 and VERTEX/SEQEND', () => {
  const s = DXF.toDxf([{ type: 'polyline', closed: true, points: [[0,0,0],[1,0,0],[1,1,0]] }]);
  assert.match(s, /\nPOLYLINE\n/);
  assert.match(s, /\n70\n1\n/);
  assert.match(s, /\nSEQEND\n/);
  assert.equal((s.match(/\nVERTEX\n/g) || []).length, 3);
});

test('open POLYLINE uses 70=0', () => {
  const s = DXF.toDxf([{ type: 'polyline', closed: false, points: [[0,0,0],[1,0,0]] }]);
  assert.match(s, /\nPOLYLINE\n[\s\S]*?\n70\n0\n/);
});

test('CIRCLE and POINT entities', () => {
  const s = DXF.toDxf([{ type: 'circle', c: [2,3,0], r: 5 }, { type: 'point', p: [7,8,0] }]);
  assert.match(s, /\nCIRCLE\n/); assert.match(s, /\n40\n5\.0\n/);
  assert.match(s, /\nPOINT\n/);
});

test('TEXT entity carries string', () => {
  const s = DXF.toDxf([{ type: 'text', p: [0,0,0], h: 2, text: 'A1' }]);
  assert.match(s, /\nTEXT\n/); assert.match(s, /\n1\nA1\n/);
});

test('extents computed over all entities', () => {
  const e = DXF.extents([{ type: 'line', a: [-1, 0, 2], b: [3, 5, -4] }]);
  assert.deepEqual(e.mn, [-1, 0, -4]);
  assert.deepEqual(e.mx, [3, 5, 2]);
});

test('layerSet always includes 0 and custom layers', () => {
  const L = DXF.layerSet([{ type: 'point', p: [0,0,0], layer: 'DRAW' }]);
  assert.ok(L.indexOf('0') >= 0); assert.ok(L.indexOf('DRAW') >= 0);
});

test('fmt trims trailing zeros but keeps decimal', () => {
  assert.equal(DXF.fmt(1), '1.0');
  assert.equal(DXF.fmt(2.5), '2.5');
  assert.equal(DXF.fmt(0), '0.0');
});
