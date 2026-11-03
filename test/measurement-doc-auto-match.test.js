'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Compare = require('../renderer/measurement-doc-compare');

function extracted(text, options) {
  const input = Object.assign({
    documentId: 'doc-1',
    documentName: 'АР — размеры.pdf',
    text
  }, options || {});
  return Compare.extractRequirements(input).requirements;
}

function entry(requirement, patch) {
  return {
    requirement,
    doc: Object.assign({ id: requirement.source.documentId, name: requirement.source.documentName }, patch || {})
  };
}

test('semantic helpers recognize Russian, Ukrainian, and English construction objects', () => {
  assert.equal(Compare.normalizeSemanticText('СТЕНА / Wall'), 'стена wall');
  assert.deepEqual(Compare.detectObjectCategories('ширина дверного проёма'), ['opening', 'door']);
  assert.deepEqual(Compare.detectObjectCategories('товщина стіни'), ['wall']);
  assert.deepEqual(Compare.detectObjectCategories('air-duct size'), ['duct']);
  assert.ok(Compare.tokenizeSemanticText('Ширина стены А-12').includes('стен'));
});

test('automatically matches a measured wall width and previews the tolerance result', () => {
  const requirement = extracted('Ширина стены А-1: 3000 ± 10 мм')[0];
  const measurement = {
    mode: 'distance',
    d3: 3.005,
    horizontal: 3.005,
    vertical: 0,
    label: 'Ширина стены А-1',
    measurementContext: {
      elementName: 'Стена А-1',
      elementType: 'стена',
      roomName: 'Комната 101',
      sourceUnits: 'м'
    }
  };
  const ranked = Compare.rankRequirementMatches({
    measurement,
    candidates: [entry(requirement)]
  });

  assert.equal(ranked.best.field.key, 'horizontal');
  assert.equal(ranked.best.selectedRequirement.dimension, 'width');
  assert.equal(ranked.best.unit, 'м');
  assert.equal(ranked.best.preview.status, 'within-tolerance');
  assert.equal(ranked.decision.canAutoConfirm, true);
  assert.ok(ranked.best.reasonCodes.includes('category_match'));
  assert.ok(ranked.best.reasonCodes.includes('semantic_overlap'));
});

test('selects the width member of an explicit door size pair', () => {
  const requirement = extracted('Дверной проём, ширина × высота: 900 × 2100 мм')[0];
  const measurement = {
    mode: 'plane',
    width: 0.902,
    length: 2.1,
    rectArea: 1.894,
    label: 'Дверь Д-1',
    measurementContext: {
      elementId: 'door-1',
      elementName: 'Дверь Д-1',
      elementType: 'дверь',
      sourceUnits: 'm'
    }
  };
  const ranked = Compare.rankRequirementMatches({
    measurement,
    candidates: [entry(requirement, { element_id: 'door-1' })]
  });

  assert.equal(ranked.best.pairIndex, 0);
  assert.equal(ranked.best.field.key, 'width');
  assert.equal(ranked.best.selectedRequirement.dimension, 'width');
  assert.equal(ranked.decision.canAutoConfirm, true);
});

test('does not auto-confirm a size pair whose width/height order was only inferred', () => {
  const requirement = extracted('Дверной проём: 900 × 2100 мм')[0];
  const measurement = {
    mode: 'plane',
    width: 0.9,
    length: 2.1,
    rectArea: 1.89,
    label: 'Дверь Д-1',
    measurementContext: {
      elementId: 'door-1',
      elementName: 'Дверь Д-1',
      elementType: 'дверь',
      sourceUnits: 'м'
    }
  };
  const ranked = Compare.rankRequirementMatches({
    measurement,
    candidates: [entry(requirement, { element_id: 'door-1' })]
  });

  assert.ok(requirement.assumptions.length > 0);
  assert.equal(ranked.decision.canAutoConfirm, false);
});

test('a document linked to the selected element outranks an unrelated room document', () => {
  const linked = extracted('Ширина двери Д-1: 900 ± 5 мм', { documentId: 'linked' })[0];
  const other = extracted('Ширина двери Д-1: 900 ± 5 мм', { documentId: 'other' })[0];
  const measurement = {
    mode: 'distance',
    horizontal: 0.901,
    d3: 0.901,
    vertical: 0,
    label: 'Ширина двери Д-1',
    measurementContext: {
      elementId: 'door-1',
      elementName: 'Дверь Д-1',
      elementType: 'дверь',
      sourceUnits: 'м'
    }
  };
  const ranked = Compare.rankRequirementMatches({
    measurement,
    candidates: [
      entry(other, { element_id: 'door-2' }),
      entry(linked, { element_id: 'door-1' })
    ]
  });

  assert.equal(ranked.best.requirement.source.documentId, 'linked');
  assert.equal(ranked.best.signals.exactElementLink, true);
  assert.ok(ranked.best.reasonCodes.includes('element_link'));
});

test('object conflicts beat numerical closeness instead of producing a false automatic match', () => {
  const pipe = extracted('Диаметр трубы: 3,000 м ± 0,010 м')[0];
  const wall = extracted('Ширина стены: 3,100 м ± 0,010 м', { documentId: 'wall' })[0];
  const measurement = {
    mode: 'distance',
    horizontal: 3,
    d3: 3,
    vertical: 0,
    label: 'Ширина стены',
    measurementContext: { elementType: 'стена', elementName: 'Стена', sourceUnits: 'м' }
  };
  const ranked = Compare.rankRequirementMatches({
    measurement,
    candidates: [entry(pipe), entry(wall)]
  });

  assert.equal(ranked.best.requirement.source.documentId, 'wall');
  const pipeMatch = ranked.matches.find(match => match.requirement === pipe && match.field.key === 'horizontal');
  assert.ok(pipeMatch.warningCodes.includes('object_conflict'));
  assert.ok(pipeMatch.score < ranked.best.score);
});

test('derives safe units for areas and blocks automatic confirmation when scale is unknown', () => {
  assert.deepEqual(Compare.suggestMeasurementUnit('мм', 'area'), {
    unit: 'мм²',
    source: 'metadata-derived-area',
    autoConfirm: true
  });
  assert.equal(Compare.suggestMeasurementUnit(null, 'linear').autoConfirm, false);

  const requirement = extracted('Длина стены: 3 м ± 10 мм')[0];
  const measurement = {
    mode: 'polyline',
    total: 3,
    label: 'Длина стены',
    measurementContext: { elementType: 'стена', elementName: 'Стена', sourceUnits: null }
  };
  const ranked = Compare.rankRequirementMatches({ measurement, candidates: [entry(requirement)] });
  assert.equal(ranked.decision.canAutoConfirm, false);
  assert.equal(ranked.best.unit, null);
  assert.ok(ranked.best.warningCodes.includes('units_unknown'));
});

test('equal candidates remain ambiguous and are never auto-confirmed', () => {
  const first = extracted('Длина стены: 3 м ± 10 мм', { documentId: 'first' })[0];
  const second = extracted('Длина стены: 3 м ± 10 мм', { documentId: 'second' })[0];
  const measurement = {
    mode: 'polyline',
    total: 3.001,
    label: 'Длина стены',
    measurementContext: { elementType: 'стена', elementName: 'Стена', sourceUnits: 'м' }
  };
  const ranked = Compare.rankRequirementMatches({
    measurement,
    candidates: [entry(first), entry(second)]
  });

  assert.equal(ranked.margin, 0);
  assert.equal(ranked.decision.state, 'ambiguous');
  assert.equal(ranked.decision.canAutoConfirm, false);
  assert.ok(ranked.best.warningCodes.includes('ambiguous_candidates'));
});

test('room naming alone does not create an object-type conflict', () => {
  const requirement = extracted('Ширина стены: 3 м ± 10 мм')[0];
  const measurement = {
    mode: 'distance',
    horizontal: 3,
    d3: 3,
    vertical: 0,
    measurementContext: { roomName: 'Комната 101', sourceUnits: 'м' }
  };
  const ranked = Compare.rankRequirementMatches({ measurement, candidates: [entry(requirement)] });
  assert.equal(ranked.best.signals.category, 'unknown');
  assert.ok(!ranked.best.warningCodes.includes('object_conflict'));
  assert.equal(ranked.decision.canAutoConfirm, false);
});

test('OCR and truncated sources can be proposed but cannot be auto-confirmed', () => {
  for (const input of [
    { ocr: true, textTruncated: false },
    { ocr: false, textTruncated: true }
  ]) {
    const requirement = extracted('Высота стены: 3 м ± 10 мм', input)[0];
    const measurement = {
      mode: 'distance',
      vertical: 3.001,
      horizontal: 0,
      d3: 3.001,
      label: 'Высота стены',
      measurementContext: { elementType: 'стена', elementName: 'Стена', sourceUnits: 'м' }
    };
    const ranked = Compare.rankRequirementMatches({ measurement, candidates: [entry(requirement)] });
    assert.equal(ranked.decision.canAutoConfirm, false);
    assert.ok(ranked.best.warningCodes.includes(input.ocr ? 'ocr_source' : 'truncated_source'));
  }
});