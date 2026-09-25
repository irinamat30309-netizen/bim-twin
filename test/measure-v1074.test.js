const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'webgl-viewer.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('viewer: snap + deviation API present', () => {
  for (const m of ['setMeasureSnap', '_applySnap', '_deviationClick']) {
    assert.ok(SRC.includes(m + '('), 'missing method ' + m);
  }
});

test('viewer: deviation mode registered in setMeasureMode', () => {
  assert.ok(/ok = \[[^\]]*'deviation'/.test(SRC), 'deviation not in ok list');
});

test('viewer: deviation uses ransac ref-plane + signedPointPlane', () => {
  assert.ok(SRC.includes('_measRefPlane'), 'no ref plane state');
  assert.ok(SRC.includes('signedPointPlane('), 'no signed distance call');
});

test('measure.js: new math exported', () => {
  const M = require('../renderer/measure.js');
  for (const fn of ['classifyLocal', 'snapToFeature', 'signedPointPlane', 'fitLinePCA', 'measurementsToCsv', 'measureToCsvRow']) {
    assert.strictEqual(typeof M[fn], 'function', 'missing export ' + fn);
  }
});

test('app.js: measurement list + CSV wiring', () => {
  for (const s of ['__measurements', 'saveMeasurement', 'exportMeasCsv', 'renderMeasList', 'measurementsToCsv']) {
    assert.ok(APP.includes(s), 'missing app symbol ' + s);
  }
});

test('app.js: buttons wired (snap/save/csv/list/deviation)', () => {
  for (const id of ['mmSnap', 'mmSave', 'mmCsv', 'mmList', 'mlCsv', 'mlClearAll']) {
    assert.ok(APP.includes("'" + id + "'"), 'button not wired: ' + id);
  }
  assert.ok(APP.includes("case 'deviation'"), 'deviation not formatted');
});

test('index.html: new toolbar buttons + list panel present', () => {
  for (const id of ['mmDeviation', 'mmSnap', 'mmSave', 'mmList', 'mmCsv', 'measureListPanel', 'measureListBody', 'mlCsv', 'mlClearAll']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'missing element ' + id);
  }
  assert.ok(HTML.includes('data-mm="deviation"'), 'no deviation mode button');
});

test('index.html: version bumped to 1077', () => {
  assert.ok(HTML.includes('?v=1089'), 'not bumped');
  assert.ok(!HTML.includes('?v=1073'), 'old version left');
});

test('app.js: banner v1081', () => {
  assert.ok(APP.includes('готова · v1160'), 'banner not bumped');
});
