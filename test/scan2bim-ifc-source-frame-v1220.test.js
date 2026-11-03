'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../renderer/scan2bim.js');

function modelForWall(a, b, dir) {
  return {
    walls: [{
      a, b, dir, length: Math.hypot(b[0] - a[0], b[1] - a[1]),
      base: 0, height: 3, thickness: 0.2, openings: []
    }],
    slabs: [], pipes: [], beams: [], objects: [],
    storey: { floorY: 0, ceilY: 3, height: 3 }
  };
}

test('IFC4 keeps source Z-up coordinates and embeds available projected CRS', () => {
  const ifc = S.toIFC(modelForWall([1, 2], [3, 2], [1, 0]), {
    name: 'georef.ifc',
    sourceTransform: { axis: 'zup', t: [500000, 6000000, 120] },
    crsWkt: 'PROJCRS["ETRS89 / UTM zone 33N",ID["EPSG",25833]]'
  });

  assert.match(ifc, /IFCCARTESIANPOINT\(\(500002\.,5999998\.,120\.\)\)/);
  assert.match(ifc, /IFCBUILDINGSTOREY\([^;]*120\.\)/);
  assert.match(ifc, /IFCPROJECTEDCRS\('EPSG:25833','PROJCRS/);
  assert.match(ifc, /IFCMAPCONVERSION\(#\d+,#\d+,0\.,0\.,0\.,1\.,0\.,1\.\)/);
});

test('IFC4 converts Y-up source coordinates to standard IFC Z-up axes', () => {
  const ifc = S.toIFC(modelForWall([1, 2], [3, 2], [1, 0]), {
    sourceTransform: { axis: 'yup', t: [10, 20, 30] }
  });

  assert.match(ifc, /IFCCARTESIANPOINT\(\(12\.,32\.,20\.\)\)/);
  assert.doesNotMatch(ifc, /IFCPROJECTEDCRS/);
});

test('IFC4 reflects the plan direction when converting Z-up source frames', () => {
  const ifc = S.toIFC(modelForWall([2, 1], [2, 3], [0, 1]), {
    sourceTransform: { axis: 'zup', t: [0, 0, 0] }
  });

  assert.match(ifc, /IFCDIRECTION\(\(0\.,-1\.,0\.\)\)/);
});

test('IFC4 can exclude automatic beam/pipe candidates pending review', () => {
  const model = modelForWall([0, 0], [2, 0], [1, 0]);
  model.beams = [{ a: [0, 1], b: [2, 1], y: 2, width: 0.2, depth: 0.2 }];
  model.pipes = [{ a: [0, 1], b: [2, 1], y: 2, radius: 0.02 }];

  const reviewed = S.toIFC(model, {});
  const conservative = S.toIFC(model, { includeBeams: false, includePipes: false });
  assert.match(reviewed, /=IFCBEAM\(/);
  assert.match(reviewed, /=IFCPIPESEGMENT\(/);
  assert.doesNotMatch(conservative, /=IFCBEAM\(/);
  assert.doesNotMatch(conservative, /=IFCPIPESEGMENT\(/);
});