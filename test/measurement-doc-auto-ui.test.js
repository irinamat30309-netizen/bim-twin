'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const dock = fs.readFileSync(path.join(root, 'renderer', 'lixel-tool-dock.js'), 'utf8');

test('measurement list exposes batch automatic document comparison', () => {
  assert.match(html, /id="mlAutoCompare"/);
  assert.match(app, /function autoCompareAllMeasurements\(/);
  assert.match(app, /bind\('mlAutoCompare'/);
  assert.match(app, /showAutomaticComparisonSummary/);
});

test('new measurements start background comparison with reusable room scanning and OCR', () => {
  assert.match(app, /autoCompareMeasurementInBackground\(__measurements\.length - 1\)/);
  assert.match(app, /function scanRoomRequirements\(/);
  assert.match(app, /scanRoomRequirements\(room, \{ autoOcr: true \}\)/);
  assert.match(app, /parseComparisonOcrDocument/);
  assert.match(app, /__measurementRoomRequirementCache/);
  assert.match(app, /function refreshAutomaticComparisonsForRoom\(/);
  assert.match(app, /refreshAutomaticComparisonsForRoom\(current\.id\)/);
});

test('saved comparison v2 contains explainable automation and provenance', () => {
  assert.match(app, /bim-twin\.document-measurement-comparison\.v2/);
  assert.match(app, /algorithmVersion: '1\.0\.0'/);
  assert.match(app, /reasonCodes:/);
  assert.match(app, /warningCodes:/);
  assert.match(app, /autoConfirmed:/);
  assert.match(app, /elementType:/);
  assert.match(app, /elementGuid:/);
  assert.match(app, /ocr: !!/);
  assert.match(app, /truncated: !!/);
});

test('comparison dialog renders confidence summary and top alternatives', () => {
  for (const className of ['cmp-auto-summary', 'cmp-alternatives', 'cmp-alternative', 'cmp-auto-warning']) {
    assert.ok(app.includes(className) || css.includes('.' + className), 'missing ' + className);
  }
  assert.match(app, /function renderAutomaticRanking\(/);
  assert.match(app, /Найдено автоматически/);
  assert.match(app, /Лучшие варианты/);
});

test('measurement toolbar preserves QA export after dock rebuild', () => {
  assert.match(dock, /\['mmList','mmCsv','mmQaReport','mmNotion','mmClear'\]/);
  assert.match(html, /measurement-doc-compare\.js\?v=2/);
});