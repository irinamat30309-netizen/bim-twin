'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Compare = require('../renderer/measurement-doc-compare');

test('normalizes supported linear, area, angle, and slope units', () => {
  assert.equal(Compare.unitInfo('мм').factor, 0.001);
  assert.equal(Compare.unitInfo('cm').factor, 0.01);
  assert.equal(Compare.unitInfo('ft').factor, 0.3048);
  assert.equal(Compare.unitInfo('м²').kind, 'area');
  assert.equal(Compare.unitInfo('sq ft').factor, 0.09290304);
  assert.equal(Compare.unitInfo('rad').kind, 'angle');
  assert.equal(Compare.unitInfo('%').kind, 'slope');
  assert.equal(Compare.unitInfo('parsecs'), null);
});

test('extracts Russian and English explicit dimensions and symmetric tolerances', () => {
  const result = Compare.extractRequirements({
    documentId: 'doc-1',
    documentName: 'АР-02.pdf',
    text: 'Ширина проёма: 900 ± 10 мм\nDoor opening height 2.10 m +/- 0.01 m'
  });
  assert.equal(result.requirements.length, 2);
  assert.deepEqual(result.requirements.map(r => r.dimension), ['width', 'height']);
  assert.equal(result.requirements[0].baseValue, 0.9);
  assert.equal(result.requirements[0].tolerance, 0.01);
  assert.equal(result.requirements[0].source.documentName, 'АР-02.pdf');
  assert.equal(result.requirements[1].baseValue, 2.1);
  assert.equal(result.requirements[1].tolerance, 0.01);
});

test('does not let tolerances or dimensions bleed across clauses', () => {
  const result = Compare.extractRequirements({
    text: 'Ширина 900 мм; высота 2100 мм ± 10 мм'
  });
  assert.equal(result.requirements.length, 2);
  assert.equal(result.requirements[0].dimension, 'width');
  assert.equal(result.requirements[0].tolerance, null);
  assert.equal(result.requirements[1].dimension, 'height');
  assert.equal(result.requirements[1].baseValue, 2.1);
  assert.equal(result.requirements[1].tolerance, 0.01);
});

test('keeps unlabelled dimension pairs explicit and records any axis assumption', () => {
  const pair = Compare.extractRequirements({ text: 'Проём: 900 × 2100 мм' }).requirements[0];
  assert.equal(pair.kind, 'pair');
  assert.deepEqual(pair.values.map(v => v.baseValue), [0.9, 2.1]);
  assert.deepEqual(pair.values.map(v => v.dimension), ['width', 'height']);
  assert.equal(pair.needsConfirmation, true);

  const unknownAxes = Compare.extractRequirements({ text: 'Панель: 300 × 1200 мм' }).requirements[0];
  assert.equal(unknownAxes.kind, 'pair');
  assert.deepEqual(unknownAxes.values.map(v => v.dimension), ['first', 'second']);
  assert.equal(unknownAxes.confidence, 'low');
});

test('does not misapply a shared tolerance to both axes of a size pair', () => {
  const parsed = Compare.extractRequirements({ text: 'Проём 900 × 2100 мм ± 10 мм' });
  assert.equal(parsed.requirements.length, 1);
  assert.equal(parsed.requirements[0].kind, 'pair');
  assert.equal(parsed.requirements[0].tolerance, undefined);
  assert.ok(parsed.requirements[0].assumptions.some(x => /распределение по осям неоднозначно/u.test(x)));
});

test('extracts area, angle, and one-sided bounds with the right dimensions', () => {
  const reqs = Compare.extractRequirements({
    text: 'Площадь пола: 24,5 м²\nУгол стены: 90°\nШирина не более 900 мм'
  }).requirements;
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0].kind, 'area');
  assert.equal(reqs[0].baseValue, 24.5);
  assert.equal(reqs[1].kind, 'angle');
  assert.equal(reqs[1].baseValue, 90);
  assert.equal(reqs[2].toleranceMode, 'max');
  assert.equal(reqs[2].bound, 0.9);
});

test('reads labeled values and tolerances from spreadsheet headers', () => {
  const parsed = Compare.extractRequirements({
    documentId: 'sheet-1',
    documentName: 'Спецификация.xlsx',
    sheets: [{
      name: 'Размеры',
      rows: [
        ['Параметр', 'Значение, мм', 'Допуск, мм'],
        ['Ширина', 900, 10],
        ['Высота', 2100, 5]
      ]
    }]
  });
  assert.equal(parsed.requirements.length, 2);
  assert.deepEqual(parsed.requirements.map(r => r.dimension), ['width', 'height']);
  assert.equal(parsed.requirements[0].baseValue, 0.9);
  assert.equal(parsed.requirements[0].tolerance, 0.01);
  assert.equal(parsed.requirements[1].tolerance, 0.005);
  assert.equal(parsed.requirements[0].source.sheet, 'Размеры');
  assert.equal(parsed.requirements[0].source.row, 2);
  assert.equal(parsed.requirements[0].source.documentName, 'Спецификация.xlsx');
});

test('parses separate width and height columns without merging their axes', () => {
  const parsed = Compare.extractRequirements({
    sheets: [{
      name: 'Проём',
      rows: [
        ['Ширина, мм', 'Высота, мм'],
        [900, 2100]
      ]
    }]
  });
  assert.equal(parsed.requirements.length, 2);
  assert.deepEqual(parsed.requirements.map(r => r.dimension), ['width', 'height']);
  assert.deepEqual(parsed.requirements.map(r => r.baseValue), [0.9, 2.1]);
});

test('maps one explicitly dimensioned tolerance column to the matching value', () => {
  const parsed = Compare.extractRequirements({
    sheets: [{
      name: 'Размеры',
      rows: [['Ширина, мм', 'Допуск, мм'], [900, 5]]
    }]
  });
  assert.equal(parsed.requirements.length, 1);
  assert.equal(parsed.requirements[0].dimension, 'width');
  assert.equal(parsed.requirements[0].tolerance, 0.005);
});

test('parses quoted CSV safely and uses explicit unit headings, not guessed units', () => {
  const rows = Compare.parseDelimitedText('Параметр;Значение, мм;Допуск, мм\nШирина;900;10\n\"Наименование;сложное\";2100;5');
  assert.deepEqual(rows[2], ['Наименование;сложное', '2100', '5']);
  const parsed = Compare.extractRequirements({
    documentName: 'размеры.csv',
    sheets: [{ name: 'CSV', rows: rows }]
  });
  assert.equal(parsed.requirements.length, 2);
  assert.equal(parsed.requirements[0].baseValue, 0.9);
  assert.equal(parsed.requirements[0].tolerance, 0.01);
  assert.equal(parsed.requirements[0].source.sheet, 'CSV');
});

test('does not invent units for unitless values', () => {
  const parsed = Compare.extractRequirements({
    text: 'Ширина 900\nВысота 2100'
  });
  assert.equal(parsed.requirements.length, 0);
  assert.ok(parsed.diagnostics.unitlessLines >= 1);

  const table = Compare.extractRequirements({
    sheets: [{ name: 'Размеры', rows: [['Параметр', 'Значение'], ['Ширина', 900]] }]
  });
  assert.equal(table.requirements.length, 0);
});

test('uses only an immediate explicit PDF heading for the next bare value', () => {
  const parsed = Compare.extractRequirements({
    documentName: 'АР-03.pdf',
    text: 'Ширина проёма, мм\n900 ± 10\n\nТекст без размера\n2100'
  });
  assert.equal(parsed.requirements.length, 1);
  assert.equal(parsed.requirements[0].dimension, 'width');
  assert.equal(parsed.requirements[0].baseValue, 0.9);
  assert.equal(parsed.requirements[0].tolerance, 0.01);
  assert.equal(parsed.requirements[0].source.line, 2);
  assert.match(parsed.requirements[0].source.excerpt, /Ширина проёма, мм/);
});

test('requires operator confirmation before assigning a tolerance verdict', () => {
  const requirement = Compare.extractRequirements({ text: 'Ширина 900 ± 10 мм' }).requirements[0];
  const measurement = { mode: 'distance', d3: 0.905, horizontal: 0.905, vertical: 0 };
  const unconfirmed = Compare.compareMeasurement({
    measurement, requirement, fieldKey: 'distance3d', unit: 'м',
    requirementConfirmed: true, unitConfirmed: false
  });
  assert.equal(unconfirmed.status, 'units-unconfirmed');
  assert.equal(unconfirmed.actual, null);

  const confirmed = Compare.compareMeasurement({
    measurement, requirement, fieldKey: 'distance3d', unit: 'м',
    requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(confirmed.status, 'within-tolerance');
  assert.ok(Math.abs(confirmed.delta - 0.005) < 1e-12);
});

test('converts actual millimetres and compares against metre requirements', () => {
  const requirement = Compare.extractRequirements({ text: 'Длина 1,0 м ± 5 мм' }).requirements[0];
  const result = Compare.compareMeasurement({
    measurement: { mode: 'polyline', total: 1002 },
    requirement,
    fieldKey: 'length',
    unit: 'мм',
    requirementConfirmed: true,
    unitConfirmed: true
  });
  assert.equal(result.status, 'within-tolerance');
  assert.ok(Math.abs(result.actual - 1.002) < 1e-12);
  assert.ok(Math.abs(result.expected - 1) < 1e-12);
});

test('returns a non-compliant verdict only when an explicit tolerance is exceeded', () => {
  const requirement = Compare.extractRequirements({ text: 'Высота 2,10 м ± 5 мм' }).requirements[0];
  const result = Compare.compareMeasurement({
    measurement: { mode: 'distance', vertical: 2.12 },
    requirement, fieldKey: 'vertical', unit: 'м',
    requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(result.status, 'outside-tolerance');
  assert.ok(Math.abs(result.absoluteDelta - 0.02) < 1e-12);

  const noTolerance = Compare.extractRequirements({ text: 'Высота 2,10 м' }).requirements[0];
  const noVerdict = Compare.compareMeasurement({
    measurement: { mode: 'distance', vertical: 2.10 },
    requirement: noTolerance, fieldKey: 'vertical', unit: 'м',
    requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(noVerdict.status, 'tolerance-not-specified');
});

test('supports pairs, geometry field suggestions, area, angle, and max/min bounds', () => {
  const pair = Compare.extractRequirements({ text: 'Проём ширина × высота: 900 × 2100 мм' }).requirements[0];
  const plane = { mode: 'plane', length: 2.095, width: 0.902, rectArea: 1.89 };
  const suggested = Compare.suggestField({ kind: 'linear', dimension: 'width' }, Compare.measurementFields(plane));
  assert.equal(suggested.key, 'width');
  const pairResult = Compare.compareMeasurement({
    measurement: plane, requirement: pair, fieldKey: 'width', pairIndex: 0, unit: 'м',
    requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(pairResult.status, 'tolerance-not-specified');
  assert.equal(pairResult.expected, 0.9);

  const maxReq = Compare.extractRequirements({ text: 'Ширина не более 900 мм' }).requirements[0];
  const maxResult = Compare.compareMeasurement({
    measurement: { mode: 'distance', horizontal: 0.89 }, requirement: maxReq,
    fieldKey: 'horizontal', unit: 'м', requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(maxResult.status, 'within-tolerance');

  const minReq = Compare.extractRequirements({ text: 'Зазор не менее 5 мм' }).requirements[0];
  const minResult = Compare.compareMeasurement({
    measurement: { mode: 'deviation', signed: 0.003 }, requirement: minReq,
    fieldKey: 'gap', unit: 'м', requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(minResult.status, 'outside-tolerance');

  const areaReq = Compare.extractRequirements({ text: 'Площадь 2 м²' }).requirements[0];
  const areaResult = Compare.compareMeasurement({
    measurement: { mode: 'area', area: 2.001 }, requirement: areaReq,
    fieldKey: 'area', unit: 'м²', requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(areaResult.status, 'tolerance-not-specified');

  const angleReq = Compare.extractRequirements({ text: 'Угол 90° ± 1°' }).requirements[0];
  const angleResult = Compare.compareMeasurement({
    measurement: { mode: 'angle', deg: 90.5 }, requirement: angleReq,
    fieldKey: 'angle', unit: '°', requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(angleResult.status, 'within-tolerance');
});

test('reports incompatible types and preserves OCR page provenance', () => {
  const requirement = Compare.extractRequirements({
    documentId: 'scan-1',
    text: '=== Страница 2 ===\nШирина стены 3 м'
  }).requirements[0];
  assert.equal(requirement.source.page, 2);
  assert.equal(requirement.source.line, 2);

  const mismatch = Compare.compareMeasurement({
    measurement: { mode: 'angle', deg: 90 }, requirement,
    fieldKey: 'angle', unit: '°', requirementConfirmed: true, unitConfirmed: true
  });
  assert.equal(mismatch.status, 'unit-mismatch');
});

test('keeps extracted excerpt plain text and flags truncated source text', () => {
  const parsed = Compare.extractRequirements({
    documentName: '<script>не исполнять</script>.txt',
    textTruncated: true,
    text: 'Ширина 1 м'
  });
  assert.equal(parsed.diagnostics.truncated, true);
  assert.equal(parsed.requirements[0].source.documentName, '<script>не исполнять</script>.txt');
  assert.equal(parsed.requirements[0].source.excerpt, 'Ширина 1 м');
  assert.equal(typeof parsed.requirements[0].source.excerpt, 'string');
});