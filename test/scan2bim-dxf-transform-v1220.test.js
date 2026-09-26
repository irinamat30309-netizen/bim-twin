'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../renderer/scan2bim.js');

test('Scan2BIM DXF applies the source-plan transform to walls and openings', () => {
  const dxf = S.toDXF({
    walls: [{
      a: [1, 2], b: [3, 4], dir: [1, 0],
      openings: [{ along: 0.5, width: 1 }]
    }]
  }, {
    planTransform: p => [p[0] + 100, 200 - p[1]]
  });

  assert.match(dxf, /8\nWALLS\n10\n101\.0000\n20\n198\.0000\n30\n0\.0\n11\n103\.0000\n21\n196\.0000/);
  assert.match(dxf, /8\nOPENINGS\n10\n101\.5000\n20\n198\.0000\n30\n0\.0\n11\n102\.5000\n21\n198\.0000/);
});

test('Scan2BIM DXF transforms all plan layers, including object footprints', () => {
  const dxf = S.toDXF({
    objects: [{ cx: 2, cz: 3, hx: 0.5, hz: 0.25 }],
    footprint: [[0, 0], [1, 0], [1, 1]]
  }, {
    planTransform: p => [p[0] + 10, -p[1] + 20]
  });

  assert.match(dxf, /8\nOBJECTS\n10\n11\.5000\n20\n16\.7500/);
  assert.match(dxf, /8\nFOOTPRINT\n10\n10\.0000\n20\n20\.0000/);
  assert.match(dxf, /8\nFOOTPRINT\n10\n11\.0000\n20\n19\.0000/);
});

test('Scan2BIM DXF rejects non-finite transformed coordinates', () => {
  assert.throws(() => S.toDXF({
    walls: [{ a: [0, 0], b: [1, 0] }]
  }, { planTransform: () => [NaN, 0] }), /Некорректное преобразование/);
});

test('floor-plan-only DXF excludes unverified MEP and beam candidates', () => {
  const dxf = S.toDXF({
    walls: [{ a: [0, 0], b: [2, 0], dir: [1, 0], openings: [] }],
    pipes: [{ a: [0, 1], b: [2, 1] }],
    cables: [{ x: 1, z: 1 }],
    beams: [{ a: [0, 2], b: [2, 2] }]
  }, { planOnly: true });

  assert.match(dxf, /WALLS/);
  assert.doesNotMatch(dxf, /PIPES|CABLES|BEAMS/);
});