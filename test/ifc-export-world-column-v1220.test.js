'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IFC = require('../renderer/ifc-export.js');

test('IFC2X3 wall placement uses the requested floor elevation', () => {
  const ifc = IFC.exportIFC(
    [{ a: [500000, 6000000], b: [500004, 6000000] }],
    [{ name: 'Level 0', ymin: 120, ymax: 123 }],
    { floorElevation: 120 }
  );

  assert.match(ifc, /IFCCARTESIANPOINT\(\(500000\.0000,6000000\.0000,120\.0000\)\)/);
  assert.match(ifc, /IFCBUILDINGSTOREY\([^;]*120\.0000\)/);
});

test('IFC2X3 exporter includes mapped column proxies in the storey containment', () => {
  const ifc = IFC.exportIFC([], [{ name: 'Level 0', ymin: 120, ymax: 123 }], {
    columns: [{
      name: 'Column 1', cx: 500002, cy: 6000002,
      baseZ: 120.1, width: 0.4, depth: 0.12, height: 2.7
    }]
  });

  const column = ifc.match(/#(\d+) = IFCCOLUMN\(/);
  assert.ok(column, 'expected one IFC column proxy');
  assert.equal((ifc.match(/\bIFCCOLUMN\(/g) || []).length, 1);
  assert.match(ifc, /IFCCARTESIANPOINT\(\(500002\.0000,6000002\.0000,120\.1000\)\)/);
  assert.match(ifc, new RegExp('IFCRELCONTAINEDINSPATIALSTRUCTURE\\([^;]*\\(#' + column[1] + '\\)'));
});