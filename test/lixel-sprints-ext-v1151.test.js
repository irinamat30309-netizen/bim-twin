'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const EXT = fs.readFileSync(path.join(R, 'lixel-sprints-ext.js'), 'utf8');

// v1151: UI-обвязка несвязанных спринтов 1/3/4/5/6/8 через мост __pcTools.

test('index.html: подключён lixel-sprints-ext.js v1151', () => {
  assert.ok(HTML.includes('lixel-sprints-ext.js?v=1224'), 'sprints-ext not linked');
  for (const m of ['xray-view.js', 'wall-detect.js', 'terrain.js', 'georef.js', 'ifc-export.js', 'potree-loader.js', 'multicloud.js', 'tin-volume.js', 'export-hub.js']) {
    assert.ok(HTML.includes(m + '?v='), m + ' not linked');
  }
});

test('app.js: баннер v1151', () => {
  assert.ok(APP.includes('готова · v1160'), 'banner not v1151');
});

test('sprints-ext: операции всех несвязанных спринтов присутствуют', () => {
  for (const op of ['opView', 'opOrtho', 'opXray', 'opWalls', 'opDSM', 'opContours', 'opGround', 'opGeoref', 'opIFC', 'opIFC4', 'opPotree']) {
    assert.ok(EXT.includes(op), 'missing op ' + op);
  }
});

test('sprints-ext: вызывает чистые функции спринт-модулей', () => {
  assert.ok(EXT.includes('window.XrayView'), 'XrayView not used');
  assert.ok(EXT.includes('window.WallDetect.autoFloorPlan'), 'WallDetect not used');
  assert.ok(EXT.includes('window.Terrain.buildDSM'), 'Terrain.buildDSM not used');
  assert.ok(EXT.includes('window.Terrain.dsmToTiff'), 'Terrain.dsmToTiff not used');
  assert.ok(EXT.includes('window.Terrain.csfClassify'), 'Terrain.csfClassify not used');
  assert.ok(EXT.includes('window.Georef'), 'Georef not used');
  assert.ok(EXT.includes('window.IfcExport.exportIFC'), 'IfcExport not used');
  assert.ok(EXT.includes('S.toDXF(model'), 'Scan→BIM DXF route not used');
  assert.ok(EXT.includes('S.toIFC(model'), 'Scan→BIM IFC4 route not used');
  assert.ok(EXT.includes("mkBtn('IFC4 BIM'"), 'IFC4 action not exposed');
  assert.ok(EXT.includes('window.PotreeLoader'), 'PotreeLoader not used');
});

test('sprints-ext: мост к __pcTools и экспорт API', () => {
  assert.ok(EXT.includes('window.__pcTools'), 'no __pcTools bridge');
  assert.ok(EXT.includes('window.__lxSprintsExt'), 'no public API');
  assert.ok(EXT.includes("addEventListener('lx-pctools-ready'"), 'not booted on pctools-ready');
});

test('sprints-ext: X-Ray мост добавляет недостающие методы вьюера', () => {
  assert.ok(EXT.includes('setStandardView'), 'setStandardView bridge missing');
  assert.ok(EXT.includes('setOrtho'), 'setOrtho bridge missing');
  assert.ok(EXT.includes('setCloudOpacity'), 'setCloudOpacity bridge missing');
});
