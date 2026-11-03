const test = require('node:test');
const assert = require('node:assert');
const DXF = require('../renderer/dxf.js');
const DP = require('../renderer/dxfparse.js');

test('round-trip: LINE', () => {
  const dxf = DXF.toDxf([{ type: 'line', layer: 'DRAW', a: [1, 2, 0], b: [5, 6, 0] }], { layers: ['DRAW'] });
  const ents = DP.parse(dxf);
  assert.equal(ents.length, 1); assert.equal(ents[0].type, 'line');
  assert.deepEqual(ents[0].a, [1, 2, 0]); assert.deepEqual(ents[0].b, [5, 6, 0]);
  assert.equal(ents[0].layer, 'DRAW');
});
test('round-trip: POLYLINE замкнутая (VERTEX/SEQEND)', () => {
  const dxf = DXF.toDxf([{ type: 'polyline', layer: 'DRAW', closed: true, points: [[0, 0, 0], [2, 0, 0], [2, 2, 0]] }], { layers: ['DRAW'] });
  const ents = DP.parse(dxf);
  assert.equal(ents.length, 1); assert.equal(ents[0].type, 'polyline');
  assert.equal(ents[0].closed, true); assert.equal(ents[0].points.length, 3);
  assert.deepEqual(ents[0].points[1], [2, 0, 0]);
});
test('round-trip: POINT + CIRCLE + TEXT', () => {
  const dxf = DXF.toDxf([
    { type: 'point', layer: 'DRAW', p: [3, 4, 0] },
    { type: 'circle', layer: 'DRAW', c: [1, 1, 0], r: 2.5 },
    { type: 'text', layer: 'DRAW', p: [0, 0, 0], h: 0.3, text: 'HELLO' }
  ], { layers: ['DRAW'] });
  const ents = DP.parse(dxf);
  assert.equal(ents.length, 3);
  assert.equal(ents.find(e => e.type === 'circle').r, 2.5);
  assert.equal(ents.find(e => e.type === 'text').text, 'HELLO');
  assert.deepEqual(ents.find(e => e.type === 'point').p, [3, 4, 0]);
});
test('parse LWPOLYLINE (внешний формат)', () => {
  const dxf = ['0','SECTION','2','ENTITIES','0','LWPOLYLINE','8','L1','90','3','70','1','10','0.0','20','0.0','10','4.0','20','0.0','10','4.0','20','3.0','0','ENDSEC','0','EOF'].join('\n');
  const ents = DP.parse(dxf);
  assert.equal(ents.length, 1); assert.equal(ents[0].type, 'polyline');
  assert.equal(ents[0].closed, true); assert.equal(ents[0].points.length, 3);
  assert.equal(ents[0].layer, 'L1');
});
test('layers(): уникальные слои', () => {
  const ents = [{ layer: 'A' }, { layer: 'B' }, { layer: 'A' }];
  assert.deepEqual(DP.layers(ents).sort(), ['A', 'B']);
});
test('parse: пустой/без ENTITIES → []', () => {
  assert.deepEqual(DP.parse('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF'), []);
});
