'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../renderer/scan2bim.js');

function modelWithOpenings(openings) {
  return {
    walls: [{
      a: [10, 20], b: [16, 20], dir: [1, 0], length: 6,
      base: 0, height: 3, thickness: 0.2, openings: openings || []
    }],
    slabs: [], pipes: [], beams: [], objects: [],
    storey: { floorY: 0, ceilY: 3, height: 3 }
  };
}

function entityMap(step) {
  const out = new Map();
  for (const line of step.split(/\r?\n/)) {
    const m = line.match(/^#(\d+)=(\w+)\((.*)\);$/);
    if (m) out.set('#' + m[1], { type: m[2], body: m[3] });
  }
  return out;
}

function relationshipRefs(entity) {
  const m = entity.body.match(/,(#\d+),(#\d+)$/);
  assert.ok(m, `relationship has no relating/related entities: ${entity.body}`);
  return [m[1], m[2]];
}

test('IFC4 emits door opening geometry and links IfcOpeningElement to its wall', () => {
  const step = S.toIFC(modelWithOpenings([
    { along: 1.5, width: 0.9, kind: 'door', uncertain: false }
  ]), {
    name: 'door.ifc',
    sourceTransform: { axis: 'zup', t: [500000, 6000000, 100] }
  });
  const entities = entityMap(step);
  for (const [id, entity] of entities) {
    if (entity.type !== 'IFCLOCALPLACEMENT') continue;
    const placementRefs = entity.body.match(/^(?:\$|#\d+),(#\d+)$/);
    assert.ok(placementRefs, `${id} must reference separate placement entities: ${entity.body}`);
    assert.equal(entities.get(placementRefs[1])?.type, 'IFCAXIS2PLACEMENT3D');
  }
  const openings = [...entities.entries()].filter(([, e]) => e.type === 'IFCOPENINGELEMENT');
  const voids = [...entities.values()].filter(e => e.type === 'IFCRELVOIDSELEMENT');
  assert.equal(openings.length, 1);
  assert.equal(voids.length, 1);
  const [wallRef, openingRef] = relationshipRefs(voids[0]);
  assert.equal(entities.get(wallRef)?.type, 'IFCWALLSTANDARDCASE');
  assert.equal(entities.get(openingRef)?.type, 'IFCOPENINGELEMENT');
  assert.match(openings[0][1].body, /'Проём 1 \(дверной\)'/);

  // 1.5 m along the wall puts the opening centre at local X=11.95; source
  // Z-up maps the plan to X/Y and elevation to IFC Z.
  assert.ok(step.includes('IFCCARTESIANPOINT((500011.95,5999980.,100.))'),
    'opening placement must preserve source frame and coordinate offset');
  assert.ok(step.includes('IFCRECTANGLEPROFILEDEF(.AREA.,$,'), 'opening needs a swept rectangular volume');
  assert.ok(step.includes('IFCEXTRUDEDAREASOLID('), 'opening solid is missing');
  assert.ok(step.includes(',2.1)'), 'door opening height must match the wall-cut geometry');

  const containment = [...entities.values()].find(e => e.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
  assert.ok(containment, 'wall and opening should be assigned to the storey');
  assert.ok(containment.body.includes(openingRef), 'opening missing from storey containment');
  assert.equal((step.match(/=IFCWALLSTANDARDCASE\(/g) || []).length, 1);
});

test('IFC4 emits a separate void relation for each valid opening and rejects out-of-wall spans', () => {
  const step = S.toIFC(modelWithOpenings([
    { along: 0.8, width: 0.9, kind: 'door' },
    { along: 3, width: 1.2, kind: 'opening' },
    { along: 7, width: 1, kind: 'door' },
    { along: 2, width: 0, kind: 'door' }
  ]));
  const entities = entityMap(step);
  const openings = [...entities.entries()].filter(([, e]) => e.type === 'IFCOPENINGELEMENT');
  const voids = [...entities.entries()].filter(([, e]) => e.type === 'IFCRELVOIDSELEMENT');
  assert.equal(openings.length, 2);
  assert.equal(voids.length, 2);
  const labels = openings.map(([, e]) => e.body);
  assert.ok(labels.some(s => s.includes('(дверной)')));
  assert.ok(labels.some(s => s.includes('(оконный)')));
  for (const [, relation] of voids) {
    const [wallRef, openingRef] = relationshipRefs(relation);
    assert.equal(entities.get(wallRef)?.type, 'IFCWALLSTANDARDCASE');
    assert.equal(entities.get(openingRef)?.type, 'IFCOPENINGELEMENT');
  }
});

test('IFC4 without detected openings does not invent voids or opening products', () => {
  const step = S.toIFC(modelWithOpenings([]));
  assert.doesNotMatch(step, /=IFCOPENINGELEMENT\(/);
  assert.doesNotMatch(step, /=IFCRELVOIDSELEMENT\(/);
});
