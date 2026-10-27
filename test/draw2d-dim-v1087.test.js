const test = require('node:test');
const assert = require('node:assert');
const D2 = require('../renderer/draw2d.js');
const DP = require('../renderer/dxfparse.js');

test('dim tool: создаёт размер с длиной', () => {
  const s = new D2.Session({ tool: 'dim', projection: 'top' });
  s.addVertex([0, 0, 0]); s.addVertex([3, 0, 4]);
  assert.equal(s.count(), 1);
  const e = s.entities[0];
  assert.equal(e.type, 'dim');
  assert.ok(Math.abs(e.len - 5) < 1e-9); // 3-4-5
  assert.ok(/5/.test(e.text));
});
test('dim → DXF: линия + текст', () => {
  const s = new D2.Session({ tool: 'dim', projection: 'top' });
  s.addVertex([0, 0, 0]); s.addVertex([4, 0, 0]);
  const dxf = s.toDxf();
  const ents = DP.parse(dxf);
  assert.ok(ents.some(e => e.type === 'line'));
  assert.ok(ents.some(e => e.type === 'text'));
});
test('formatLen', () => {
  assert.equal(D2.formatLen(5), '5 m');
  assert.equal(D2.formatLen(2.5), '2.5 m');
});
test('importEntities: DXF → 3D (top) round-trip геометрии', () => {
  const src = new D2.Session({ tool: 'line', projection: 'top' });
  src.addVertex([1, 0, 2]); src.addVertex([5, 0, 6]);
  const dxf = src.toDxf();
  const parsed = DP.parse(dxf);
  const dst = new D2.Session({ projection: 'top' });
  const n = dst.importEntities(parsed, 'top', 0);
  assert.equal(n, 1);
  const e = dst.entities[0];
  assert.equal(e.type, 'line');
  // top: DXF(x,y)=(worldX,worldZ), фикс Y=0
  assert.deepEqual(e.a, [1, 0, 2]); assert.deepEqual(e.b, [5, 0, 6]);
});
test('importEntities: polyline + circle', () => {
  const parsed = [
    { type: 'polyline', layer: 'L', closed: true, points: [[0, 0, 0], [2, 0, 0], [2, 2, 0]] },
    { type: 'circle', layer: 'L', c: [1, 1, 0], r: 3 }
  ];
  const dst = new D2.Session({ projection: 'top' });
  assert.equal(dst.importEntities(parsed, 'top', 0), 2);
  assert.equal(dst.entities[0].points.length, 3);
  assert.equal(dst.entities[1].r, 3);
});
test('bbox учитывает dim', () => {
  const s = new D2.Session({ tool: 'dim' });
  s.addVertex([0, 0, 0]); s.addVertex([10, 0, 0]);
  const bb = s.bbox();
  assert.deepEqual(bb.mn, [0, 0, 0]); assert.deepEqual(bb.mx, [10, 0, 0]);
});
