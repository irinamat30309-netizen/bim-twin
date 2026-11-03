'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Draw2D = require('../renderer/draw2d.js');
const DXFParse = require('../renderer/dxfparse.js');

test('Z-up georeferenced plan exports in source XY and imports back to viewer coordinates', () => {
  const transform = { axis: 'zup', t: [500000, 6000000, 117] };
  const drawing = new Draw2D.Session({ tool: 'line', projection: 'top', layer: 'WALLS' });
  drawing.addVertex([4, 1, 8]);
  drawing.addVertex([7, 1, 10]);

  const parsed = DXFParse.parse(drawing.toDxf({ sourceTransform: transform }));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].a, [500004, 5999992, 0]);
  assert.deepEqual(parsed[0].b, [500007, 5999990, 0]);

  const local = Draw2D.fromSourceDxfEntities(parsed, transform, 0);
  const imported = new Draw2D.Session({ projection: 'top' });
  assert.equal(imported.importEntities(local, 'top', 0), 1);
  assert.deepEqual(imported.entities[0].a, [4, 0, 8]);
  assert.deepEqual(imported.entities[0].b, [7, 0, 10]);
  assert.equal(imported.entities[0].layer, 'WALLS');
});

test('Y-up georeferenced plan uses source X/Z as CAD plan axes', () => {
  const transform = { axis: 'yup', t: [100, 200, 300] };
  const drawing = new Draw2D.Session({ tool: 'line', projection: 'top' });
  drawing.addVertex([4, 2, 8]);
  drawing.addVertex([6, 2, 9]);

  const parsed = DXFParse.parse(drawing.toDxf({ sourceTransform: transform }));
  assert.deepEqual(parsed[0].a, [104, 308, 0]);
  assert.deepEqual(parsed[0].b, [106, 309, 0]);
  const local = Draw2D.fromSourceDxfEntities(parsed, transform);
  assert.deepEqual(local[0].a, [4, 8, 0]);
  const imported = new Draw2D.Session({ projection: 'top' });
  imported.importEntities(local, 'top', 0);
  assert.deepEqual(imported.entities[0].a, [4, 0, 8]);
});

test('local DXF remains unchanged when no source transform is requested', () => {
  const drawing = new Draw2D.Session({ tool: 'line', projection: 'top' });
  drawing.addVertex([4, 1, 8]);
  drawing.addVertex([7, 1, 10]);
  const parsed = DXFParse.parse(drawing.toDxf());
  assert.deepEqual(parsed[0].a, [4, 8, 0]);
  assert.deepEqual(parsed[0].b, [7, 10, 0]);
});

test('source-frame DXF transformation rejects incomplete transform metadata', () => {
  const drawing = new Draw2D.Session({ tool: 'line', projection: 'top' });
  drawing.addVertex([1, 0, 1]);
  drawing.addVertex([2, 0, 2]);
  assert.throws(
    () => drawing.toDxf({ sourceTransform: { axis: 'unknown', t: [0, 0, 0] } }),
    /исходного DXF/
  );
  assert.throws(
    () => Draw2D.fromSourceDxfEntities([{ type: 'point', p: [1, 2, 0] }], { axis: 'zup', t: [1, 2] }),
    /импорта исходного DXF/
  );
});

test('dimension measures in active drawing plane, ignoring off-plane point height', () => {
  const drawing = new Draw2D.Session({ tool: 'dim', projection: 'top' });
  drawing.addVertex([0, 0, 0]);
  drawing.addVertex([3, 20, 4]);
  assert.equal(drawing.entities[0].len, 5);
  assert.equal(drawing.entities[0].text, '5 m');
});