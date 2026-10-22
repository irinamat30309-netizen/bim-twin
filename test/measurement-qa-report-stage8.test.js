'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Measure = require('../renderer/measure');

test('Stage 8 measurement report keeps known provenance and never invents CRS, units, or tolerances', () => {
  const measures = [{ mode: 'distance', d3: 1, horizontal: 1, vertical: 0, dx: 1, dy: 0, dz: 0, label: 'test span' }];
  const report = Measure.createMeasurementReport(measures, {
    generatedAt: '2026-09-03T12:00:00.000Z',
    project: { id: 'p-1', name: 'Fixture', room: 'Room A' },
    source: { name: 'scan.las', format: 'LAS', pointCount: 100, loadedPointCount: 80 },
    coordinateReference: { frame: 'viewer', crsWkt: null, units: null, sourceTransform: null }
  });

  assert.equal(report.schema, 'bim-twin.measurement-report.v1');
  assert.equal(report.generatedAt, '2026-09-03T12:00:00.000Z');
  assert.equal(report.source.name, 'scan.las');
  assert.equal(report.source.pointCount, 100);
  assert.equal(report.measurementCount, 1);
  assert.equal(report.coordinateReference.crsWkt, null);
  assert.equal(report.coordinateReference.units, null);
  assert.equal(report.coordinateReference.status, 'incomplete_or_not_provided');
  assert.deepEqual(report.tolerances, {
    status: 'not_provided',
    linear: null,
    linearUnits: null,
    angular: null,
    angularUnits: null,
    evaluationStatus: 'not_evaluated'
  });
  assert.equal(report.author, null);

  measures[0].d3 = 999;
  assert.equal(report.measurements[0].d3, 1, 'report data must be a detached snapshot');
});

test('Stage 8 report preserves declared CRS and unit without assigning a tolerance', () => {
  const report = Measure.createMeasurementReport([], {
    coordinateReference: { crsWkt: 'LOCAL_TEST_WKT', units: 'm', sourceTransform: { axis: 'yup', t: [0, 0, 0] } }
  });
  assert.equal(report.coordinateReference.crsWkt, 'LOCAL_TEST_WKT');
  assert.equal(report.coordinateReference.units, 'm');
  assert.equal(report.coordinateReference.status, 'provided');
  assert.equal(report.tolerances.status, 'not_provided');
  assert.deepEqual(report.coordinateReference.sourceTransform, { axis: 'yup', t: [0, 0, 0] });
});

test('Stage 8 report records only nonnegative operator tolerances and never claims evaluation', () => {
  const report = Measure.createMeasurementReport([], {
    author: 'QA operator',
    coordinateReference: { units: 'm' },
    tolerances: { linear: 0.01, angular: 2, units: 'm' }
  });
  assert.equal(report.author, 'QA operator');
  assert.equal(report.tolerances.status, 'declared_by_operator');
  assert.equal(report.tolerances.linear, 0.01);
  assert.equal(report.tolerances.linearUnits, 'm');
  assert.equal(report.tolerances.angular, 2);
  assert.equal(report.tolerances.angularUnits, 'deg');
  assert.equal(report.tolerances.evaluationStatus, 'not_evaluated');

  const invalid = Measure.createMeasurementReport([], { tolerances: { linear: -1, angular: 'NaN' } });
  assert.equal(invalid.tolerances.status, 'not_provided');
  assert.equal(invalid.tolerances.linear, null);
  assert.equal(invalid.tolerances.angular, null);
});

test('Stage 8 UI exposes QA JSON export and uses a basename rather than an absolute source path', () => {
  const root = path.join(__dirname, '..', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /id="mmQaReport"/);
  assert.match(app, /function exportMeasQaReport\(\)/);
  assert.match(app, /bind\('mmQaReport',\s*\(\)\s*=>\s*exportMeasQaReport\(\)\)/);
  assert.match(app, /String\(sourcePath\)\.split\(\/\[\\\\\/\]\//);
  assert.match(app, /coordinateReference:[\s\S]{0,200}crsWkt:[\s\S]{0,100}units:/);
  assert.match(app, /Параметры QA-отчёта/);
  assert.match(app, /linearTolerance/);
  assert.match(app, /evaluationStatus|автоматическая оценка не выполнялась/);
});