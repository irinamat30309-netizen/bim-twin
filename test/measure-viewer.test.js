const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'webgl-viewer.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('viewer: measurement API methods present', () => {
  for (const m of ['setMeasureMode', '_measureClick', '_computeMeasure', '_fitPlaneAt', '_gatherNeighborhood', '_buildMeasLabels', '_renderMeasLabels', 'finishMeasure']) {
    assert.ok(SRC.includes(m + '('), 'missing method ' + m);
  }
});

test('viewer: all six measure modes are handled', () => {
  for (const mode of ['point', 'distance', 'polyline', 'angle', 'area', 'plane']) {
    assert.ok(SRC.includes("'" + mode + "'"), 'mode not referenced: ' + mode);
  }
});

test('viewer: click routes to _measureClick and uses window.Measure', () => {
  assert.ok(SRC.includes('if (this.measuring) { if (hit) this._measureClick(hit.point); return; }'), 'click branch not rewired');
  assert.ok(SRC.includes('window.Measure'), 'does not use Measure math module');
});

test('viewer: plane fit uses RANSAC + extents + orientation', () => {
  assert.ok(SRC.includes('Me.ransacPlane('), 'no ransacPlane');
  assert.ok(SRC.includes('Me.planeExtents('), 'no planeExtents');
  assert.ok(SRC.includes('Me.orientation('), 'no orientation');
});

test('viewer: neighborhood gather caps work on huge clouds', () => {
  assert.ok(SRC.includes('n > 1500000 ? Math.ceil(n / 1500000) : 1'), 'no stride cap');
  assert.ok(SRC.includes('cap = 60000'), 'no collection cap');
});

test('viewer: labels projected with _lastVP each frame', () => {
  assert.ok(SRC.includes('if (this.measuring && this._measLabels && this._measLabels.length) this._renderMeasLabels();'), 'labels not rendered in frame');
  assert.ok(SRC.includes('const M = this._lastVP;'), 'labels not projected with view-projection');
});

test('viewer: markers scale by scene diagonal (not fixed 0.14)', () => {
  assert.ok(SRC.includes('this._sceneDiag() * 0.006'), 'markers not scaled by scene size');
  assert.ok(!SRC.includes('boxGeom(p[0], p[1], p[2], 0.14, 0.14, 0.14)'), 'still using fixed 0.14 markers');
});

test('app: structured onMeasure formatter wired', () => {
  assert.ok(APP.includes('function fmtMeasure(res)'), 'no fmtMeasure');
  assert.ok(APP.includes('viewer.onMeasure = res =>'), 'onMeasure not structured');
  assert.ok(APP.includes('viewer.setMeasureMode'), 'mode buttons not wired');
});

test('html: measure toolbar with all six modes + finish/clear', () => {
  for (const id of ['measureBar', 'mmDistance', 'mmPoint', 'mmPolyline', 'mmAngle', 'mmArea', 'mmPlane', 'mmFinish', 'mmClear']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'missing toolbar element ' + id);
  }
  assert.ok(HTML.includes('measure.js?v=1154'), 'measure.js not included');
});
