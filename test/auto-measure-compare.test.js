'use strict';
/* Автоматический замер → список измерений → сверка с документацией: размеры не теряют смысл по дороге
 * (одно поле, правильный «размер из документа», уклон — в процентах, текст со ±σ и уровнем уверенности). */
const test = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../renderer/auto-measure.js');
const Measure = require('../renderer/measure.js');
const C = require('../renderer/measurement-doc-compare.js');
const { Scene, doorScene } = require('./helpers/auto-synth.js');

const SHIFT = [5, 1, -2];
function measurements() {
  const r = AM.analyze(doorScene({ step: 0.01 }).f32(SHIFT), { kind: 'дверь' });
  const out = {};
  r.main.dims.forEach((d) => { out[d.key] = AM.toMeasurement(d, { object: r.main.title }); out[d.key].measurementContext = { elementName: 'Дверь Д-1', elementType: 'дверь', sourceUnits: 'м' }; });
  return out;
}
function pipe() {
  const sc = new Scene(11, 0.01, 0.0005);
  sc.plane([-2, 2.9, 0], [1, 0, 0], [0, 0, 1], 4, 3);
  sc.cyl([0, 2.62, 0], [0, 0.02, 1], 0.055, 0, 3, { keep: (x, y) => y <= 2.7 });
  const r = AM.analyze(sc.f32(SHIFT), { kind: 'труба' });
  const c = r.objects.find((o) => o.type === 'cylinder');
  const out = {};
  c.dims.forEach((d) => { out[d.key] = AM.toMeasurement(d, { object: c.title }); out[d.key].measurementContext = { elementName: 'Труба Т-1', elementType: 'труба', sourceUnits: 'м' }; });
  return out;
}
const req = (text) => C.extractRequirements({ documentId: 'd1', documentName: 'АР-02.pdf', text }).requirements;
const ent = (rq) => ({ requirement: rq, doc: { id: rq.source.documentId, name: rq.source.documentName } });

test('автоматический размер — ровно одно поле сверки с подписью размера', () => {
  const m = measurements();
  const f = C.measurementFields(m.width);
  assert.equal(f.length, 1);
  assert.equal(f[0].key, 'perp');
  assert.equal(f[0].label, 'Ширина проёма');
  assert.equal(f[0].value, m.width.perp);
  assert.equal(f[0].kind, 'linear');
  const p = pipe();
  const s = C.measurementFields(p.slope);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, 'slope');
  assert.equal(s[0].kind, 'slope');
  assert.ok(Math.abs(s[0].value - 2) < 0.1, 'уклон в процентах: ' + s[0].value);
});

test('размер автоматического замера → «размер из документа»: основной и допустимые соседние', () => {
  const m = measurements(), p = pipe();
  const d = (x) => C.measurementFieldDimensions({ key: 'perp' }, x);
  assert.equal(d(m.width).primary, 'width');
  assert.equal(d(m.height).primary, 'height');
  assert.equal(d(m.depth).primary, 'thickness');
  assert.equal(d(p.diameter).primary, 'diameter');
  assert.equal(d(p.length).primary, 'length');
  assert.equal(d(m.width).auto, true);
  assert.ok(d(m.width).compatible.includes('thickness'), 'ширина стены в документах бывает «шириной»');
  assert.equal(C.measurementFieldDimensions({ key: 'slope' }, p.slope).primary, 'slope');
});

test('сверка: автоматическая ширина двери выбирает требование «Ширина», а высота — «Высота»', () => {
  const m = measurements();
  const reqs = [...req('Ширина дверного проёма: 1500 ± 10 мм'), ...req('Высота дверного проёма: 2200 ± 10 мм')];
  const w = C.rankRequirementMatches({ measurement: m.width, candidates: reqs.map(ent) });
  assert.equal(w.best.field.key, 'perp');
  assert.equal(w.best.selectedRequirement.dimension, 'width');
  assert.equal(w.best.preview.status, 'within-tolerance');
  assert.ok(w.best.reasonCodes.includes('dimension_exact') && w.best.reasonCodes.includes('category_match'));
  const h = C.rankRequirementMatches({ measurement: m.height, candidates: reqs.map(ent) });
  assert.equal(h.best.selectedRequirement.dimension, 'height');
  assert.equal(h.best.preview.status, 'within-tolerance');
});

test('сверка: расхождение с документом видно, а чужой тип объекта не подтверждается молча', () => {
  const m = measurements(), p = pipe();
  const bad = C.rankRequirementMatches({ measurement: m.width, candidates: req('Ширина дверного проёма: 1400 ± 10 мм').map(ent) });
  assert.equal(bad.best.preview.status, 'outside-tolerance');
  assert.ok(Math.abs(bad.best.preview.delta - 0.1) < 0.002);
  const pd = C.rankRequirementMatches({ measurement: p.diameter, candidates: req('Диаметр трубы: 110 ± 2 мм').map(ent) });
  assert.equal(pd.best.selectedRequirement.dimension, 'diameter');
  assert.equal(pd.best.preview.status, 'within-tolerance');
  const other = C.rankRequirementMatches({ measurement: m.width, candidates: req('Диаметр трубы: 110 мм').map(ent) });
  assert.equal(other.decision.canAutoConfirm, false, 'ширину двери с диаметром трубы автоматически не связываем');
  assert.ok(!other.best.reasonCodes.includes('dimension_exact'));
});

test('текст значения: подпись, значение, ±σ, способ и уровень уверенности; уклон — в процентах', () => {
  const m = measurements(), p = pipe();
  const t = Measure.measureValueText(m.width);
  assert.match(t, /^Ширина проёма 1,500 м \u00b1[\d,]+ мм · по откосам/);
  assert.match(t, /уверенность: высокая$/);
  assert.match(Measure.measureValueText(m.depth), /Глубина проёма.* \d+ мм \u00b1\d+ мм .*уверенность: средняя$/);
  assert.match(Measure.measureValueText(p.slope), /^Уклон оси трубы 2,00 % \u00b1[\d,]+ % · по оси цилиндра · уверенность: средняя$/);
  assert.equal(Measure.autoValue(p.slope.auto), '2,00 %');
  assert.equal(Measure.autoValue(m.width.auto), '1,500 м');
  assert.match(Measure.autoSigma(m.width.auto), /^ \u00b1[\d,]+ мм$/);
  assert.equal(Measure.autoValueText(m.width.auto), t);
});

test('обычные измерения не затронуты: без auto текст значения прежний', () => {
  const plain = { mode: 'distance', a: [0, 0, 0], b: [3, 0, 4], d3: 5, dx: 3, dy: 0, dz: 4, horizontal: 5, vertical: 0, slope: 0, grade: 0 };
  assert.doesNotMatch(Measure.measureValueText(plain), /уверенность/);
  assert.equal(C.measurementFields(plain).some((f) => f.key === 'perp' && f.label === 'Ширина проёма'), false);
});
