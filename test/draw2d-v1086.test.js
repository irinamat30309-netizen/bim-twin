const test = require('node:test');
const assert = require('node:assert');
const Draw2D = require('../renderer/draw2d.js');

test('line tool commits a line from two vertices', () => {
  const s = new Draw2D.Session({ tool: 'line' });
  s.addVertex([0, 1, 0]); s.addVertex([2, 1, 3]);
  assert.equal(s.count(), 1);
  assert.equal(s.entities[0].type, 'line');
  assert.deepEqual(s.entities[0].a, [0, 1, 0]);
  assert.deepEqual(s.entities[0].b, [2, 1, 3]);
  assert.equal(s.draft, null);
});

test('polyline: verts + commit -> open; closePath -> closed', () => {
  const s = new Draw2D.Session({ tool: 'polyline' });
  s.addVertex([0,0,0]); s.addVertex([1,0,0]); s.addVertex([1,0,1]);
  s.commit();
  assert.equal(s.count(), 1);
  assert.equal(s.entities[0].closed, false);
  assert.equal(s.entities[0].points.length, 3);
  const s2 = new Draw2D.Session({ tool: 'polyline' });
  s2.addVertex([0,0,0]); s2.addVertex([1,0,0]); s2.closePath();
  assert.equal(s2.entities[0].closed, true);
});

test('rect tool makes closed 4-corner polyline (top projection)', () => {
  const s = new Draw2D.Session({ tool: 'rect', projection: 'top' });
  s.addVertex([0, 5, 0]); s.addVertex([4, 5, 6]);
  assert.equal(s.count(), 1);
  const e = s.entities[0];
  assert.equal(e.type, 'polyline'); assert.equal(e.closed, true);
  assert.equal(e.points.length, 4);
  // top: fixed axis Y = avg(5,5)=5
  e.points.forEach(p => assert.equal(p[1], 5));
  const proj = e.points.map(p => [p[0], p[2]]);
  assert.deepEqual(proj, [[0,0],[4,0],[4,6],[0,6]]);
});

test('circle tool: radius = planar distance', () => {
  const s = new Draw2D.Session({ tool: 'circle', projection: 'top' });
  s.addVertex([0, 0, 0]); s.addVertex([3, 0, 4]);
  assert.equal(s.entities[0].type, 'circle');
  assert.equal(s.entities[0].r, 5);
});

test('point tool adds standalone points', () => {
  const s = new Draw2D.Session({ tool: 'point' });
  s.addVertex([1,2,3]); s.addVertex([4,5,6]);
  assert.equal(s.count(), 2);
  assert.equal(s.entities[0].type, 'point');
});

test('undo removes draft vertex then last entity', () => {
  const s = new Draw2D.Session({ tool: 'polyline' });
  s.addVertex([0,0,0]); s.addVertex([1,0,0]); s.addVertex([2,0,0]);
  s.undo();
  assert.equal(s.draft.length, 2);
  s.commit();
  assert.equal(s.count(), 1);
  s.undo();
  assert.equal(s.count(), 0);
});

test('empty drawing actions remain harmless no-ops before there is history', () => {
  const s = new Draw2D.Session({ tool: 'polyline' });
  s.closePath().undo().clear();
  assert.equal(s.count(), 0);
  assert.equal(s.draft, null);
  s.addVertex([0, 0, 0]);
  s.closePath();
  assert.equal(s.count(), 0, 'one vertex is not a closable polyline');
  assert.equal(s.draft, null);
});

test('project/unproject round-trip on all planes', () => {
  const p = [3, 7, 5];
  ['top', 'front', 'side'].forEach(m => {
    const uv = Draw2D.project(p, m);
    const back = Draw2D.unproject(uv, m, p[Draw2D.fixedAxis(m)]);
    assert.deepEqual(back, p);
  });
});

test('toDxf integrates DXF module and projects to z=0', () => {
  const s = new Draw2D.Session({ tool: 'line', projection: 'top', layer: 'DRAW' });
  s.addVertex([1, 9, 2]); s.addVertex([5, 9, 8]);
  const dxf = s.toDxf();
  assert.match(dxf, /\nLINE\n/);
  // top projection of [1,9,2] -> (1,2); z flattened to 0
  assert.match(dxf, /\n10\n1\.0\n20\n2\.0\n30\n0\.0\n/);
  assert.match(dxf, /\n8\nDRAW\n/);
});

test('setTool commits an open polyline before switching', () => {
  const s = new Draw2D.Session({ tool: 'polyline' });
  s.addVertex([0,0,0]); s.addVertex([1,0,0]);
  s.setTool('line');
  assert.equal(s.count(), 1);
  assert.equal(s.tool, 'line');
});
