'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Section = require('../renderer/section.js');

test('axis section slice returns stable source indices and inclusive half-thickness boundaries', () => {
  const pos = new Float64Array([
    0, 0, 0,
    1, 1, 2,
    2, 2, 4,
    NaN, 1, 1,
    4, 1, 1
  ]);
  const y = Section.sliceSlab(pos, 5, { axis: 'y', level: 1, thickness: 2 });
  assert.deepEqual(y.indices, [0, 1, 2, 4]);
  assert.deepEqual(y.pts, [[0, 0], [1, 2], [2, 4], [4, 1]]);
  const z = Section.sliceSlab(pos, 5, { axis: 'z', level: 2, thickness: 4 });
  assert.deepEqual(z.indices, [0, 1, 2, 4]);
  assert.deepEqual(z.pts, [[0, 0], [1, 1], [2, 2], [4, 1]]);
  const x = Section.sliceSlab(pos, 5, { axis: 'x', level: 1, thickness: 2 });
  assert.deepEqual(x.indices, [0, 1, 2]);
  assert.deepEqual(x.pts, [[0, 0], [2, 1], [4, 2]]);
});

test('point-slice export is exposed and labels its coordinate-frame/metadata contract', () => {
  const root = path.join(__dirname, '..');
  const draw = fs.readFileSync(path.join(root, 'renderer/lixel-draw.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(root, 'renderer/lixel-workspace.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  assert.ok(draw.includes('function exportSectionPoints(opts)'));
  assert.ok(draw.includes('exportSectionPoints: exportSectionPoints'));
  assert.ok(draw.includes('bim-twin-section-points/v1'));
  assert.ok(draw.includes('attributeLimitations'));
  assert.ok(workspace.includes('lxExportSectionPoints'));
  assert.ok(workspace.includes('aria-label="Сохранить точки полосы сечения в CSV и метаданные JSON"'));
  assert.ok(workspace.includes("result.frame==='source'"));
  assert.ok(html.includes('lixel-draw.js?v=1232'));
  assert.ok(html.includes('lixel-workspace.js?v=1232'));
});