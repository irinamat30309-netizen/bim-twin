'use strict';
/* Автоматический замер (renderer/auto-measure.js) на синтетических сценах с известными размерами.
 * Проверяем не только «число совпало», но и честность: погрешность и уровень уверенности должны отражать реальные условия
 * (шум, разреженность, косой вид, видна часть окружности), а ложные срабатывания — не появляться. */
const test = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../renderer/auto-measure.js');
const { Scene, doorScene } = require('./helpers/auto-synth.js');

const SHIFT = [5, 1, -2];   // как в приложении: облако смещено в «координаты просмотра»
function dim(res, key, titleRe) {
  const ob = res.objects.find((o) => (!titleRe || titleRe.test(o.title)) && o.dims.some((d) => d.key === key));
  return ob ? ob.dims.find((d) => d.key === key) : null;
}
function pipesScene(opt) {
  opt = opt || {};
  const sc = new Scene(opt.seed || 11, opt.step || 0.01, opt.noise == null ? 0.0005 : opt.noise);
  sc.plane([-2, 2.9, 0], [1, 0, 0], [0, 0, 1], 4, 3);   // потолок
  (opt.pipes || [[0, 2.62, 0.055], [0.45, 2.66, 0.0315], [-0.6, 2.55, 0.08]]).forEach((p) => {
    sc.cyl([p[0], p[1], 0], opt.axis || [0, 0, 1], p[2], 0, 3, { keep: (x, y) => y <= p[1] + 0.02, arc0: opt.arc0, arc1: opt.arc1 });
  });
  return sc;
}

test('проём с откосами: ширина и высота до пары миллиметров, глубина — с оговоркой', () => {
  const r = AM.analyze(doorScene({ step: 0.01 }).f32(SHIFT));
  assert.equal(r.ok, true);
  const w = dim(r, 'width'), h = dim(r, 'height'), d = dim(r, 'depth');
  assert.ok(Math.abs(w.value - 1.5) < 0.004, 'ширина ' + w.value);
  assert.ok(Math.abs(h.value - 2.2) < 0.004, 'высота ' + h.value);
  assert.ok(Math.abs(d.value - 0.26) < 0.04, 'глубина ' + d.value);
  assert.equal(w.method, 'planes'); assert.equal(w.level, 'high'); assert.equal(h.level, 'high');
  assert.notEqual(d.level, 'high', 'глубина — по длине откосов, наверняка не скажешь');
  assert.ok(w.sigma > 0 && w.sigma < 0.003, 'σ ширины ' + w.sigma);
  assert.match(r.main.title, /Дверной проём|Проём/);
  assert.ok(r.main.notes === undefined || Array.isArray(r.main.notes));
});

test('проём без откосов (только дыра в стене): значение близко, но уверенность не «высокая», путь помечен', () => {
  const r = AM.analyze(doorScene({ step: 0.01, noJambs: true }).f32(SHIFT));
  assert.equal(r.ok, true);
  const w = dim(r, 'width');
  assert.ok(w, 'ширина найдена по краям дыры');
  assert.ok(Math.abs(w.value - 1.5) < 0.03, 'ширина по краям дыры ' + w.value);
  assert.notEqual(w.level, 'high');
  assert.ok(w.sigma >= 0.01, 'σ не меньше сантиметра для краёв дыры: ' + w.sigma);
  assert.ok(/дыр|кра/.test(w.how), w.how);
});

test('разреженное облако (шаг 3 см): дыра не раздувается, а погрешность растёт', () => {
  const r = AM.analyze(doorScene({ step: 0.03, noise: 0.002, noJambs: true }).f32(SHIFT));
  assert.equal(r.ok, true);
  const w = dim(r, 'width');
  assert.ok(w, 'проём найден и на разреженном облаке');
  assert.ok(Math.abs(w.value - 1.5) < 0.08, 'ширина ' + w.value + ' (раньше случайные пустые ячейки раздували дыру на десятки сантиметров)');
  assert.ok(w.sigma > 0.012, 'σ учитывает разрежение: ' + w.sigma);
  assert.notEqual(w.level, 'high');
});

test('помещение: высота пол—потолок и расстояние между стенами', () => {
  const sc = new Scene(5, 0.02, 0.001);
  sc.plane([0, 0, 0], [1, 0, 0], [0, 0, 1], 6, 4);          // пол
  sc.plane([0, 2.8, 0], [1, 0, 0], [0, 0, 1], 6, 4);        // потолок
  sc.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], 6, 2.8);        // стена z=0
  sc.plane([0, 0, 4], [1, 0, 0], [0, 1, 0], 6, 2.8);        // стена z=4
  sc.plane([0, 0, 0], [0, 0, 1], [0, 1, 0], 4, 2.8);        // стена x=0
  sc.plane([6, 0, 0], [0, 0, 1], [0, 1, 0], 4, 2.8);        // стена x=6
  const r = AM.analyze(sc.f32(SHIFT));
  assert.equal(r.ok, true);
  const hh = dim(r, 'room-height'), rw = r.objects.flatMap((o) => o.dims).filter((d) => d.key === 'room-width').map((d) => d.value).sort();
  assert.ok(Math.abs(hh.value - 2.8) < 0.004, 'высота ' + hh.value);
  assert.equal(rw.length >= 2, true);
  assert.ok(Math.abs(rw[0] - 4) < 0.006 && Math.abs(rw[rw.length - 1] - 6) < 0.006, 'ширины ' + rw.join(', '));
});

test('три трубы: диаметры, расстояния между осями, уклон 0, стандартные Ø', () => {
  const r = AM.analyze(pipesScene().f32(SHIFT), { kind: 'труба' });
  assert.equal(r.ok, true);
  const cyl = r.objects.filter((o) => o.type === 'cylinder');
  assert.equal(cyl.length, 3);
  const ds = cyl.map((o) => o.dims.find((d) => d.key === 'diameter')).sort((a, b) => a.value - b.value);
  [0.063, 0.11, 0.16].forEach((t, i) => {
    assert.ok(Math.abs(ds[i].value - t) < 0.003, 'Ø' + t + ' получилось ' + ds[i].value);
    assert.ok(ds[i].sigma > 0 && ds[i].sigma < 0.004, 'σ ' + ds[i].sigma);
    assert.notEqual(ds[i].level, 'low');
  });
  const gaps = r.objects.filter((o) => o.type === 'pipes').flatMap((o) => o.dims).filter((d) => d.key === 'axis-gap').map((d) => d.value).sort();
  assert.equal(gaps.length, 3);
  [0.4518, 0.604, 1.0557].forEach((t, i) => assert.ok(Math.abs(gaps[i] - t) < 0.004, 'расстояние ' + gaps[i] + ' ≠ ' + t));
  cyl.forEach((o) => { const s = o.dims.find((d) => d.key === 'slope'); if (s) assert.ok(Math.abs(s.value) < 0.15, 'уклон горизонтальной трубы ' + s.value); });
  assert.deepEqual([AM.nearestStandard(0.063).d, AM.nearestStandard(0.11).d, AM.nearestStandard(0.16).d], [63, 110, 160]);   // стандартный Ø — в мм
  assert.equal(r.main.type, 'cylinder', 'при типе «труба» главным идёт цилиндр');
});

test('видна лишь дуга окружности: диаметр найден, но уверенность ниже, чем для полной окружности', () => {
  /* Труба под потолком видна снизу: дуга 30°–150° (угол отсчитывается от –X к –Y, т.е. это нижняя часть трубы). */
  const full = AM.analyze(pipesScene({ pipes: [[0, 2.6, 0.055]] }).f32(SHIFT), { kind: 'труба' });
  const part = AM.analyze(pipesScene({ pipes: [[0, 2.6, 0.055]], arc0: 30, arc1: 150 }).f32(SHIFT), { kind: 'труба' });
  const a = dim(full, 'diameter'), b = dim(part, 'diameter');
  assert.ok(a && b, 'труба найдена в обоих случаях');
  assert.ok(Math.abs(a.value - 0.11) < 0.003, 'полная ' + a.value);
  assert.ok(Math.abs(b.value - 0.11) < 0.006, 'дуга ' + b.value);
  assert.ok(b.sigma >= a.sigma, 'σ по дуге не меньше, чем по полной окружности');
  assert.ok(b.confidence < a.confidence, 'уверенность по дуге ниже: ' + b.confidence + ' против ' + a.confidence);
  assert.notEqual(b.level, 'high');
  /* совсем короткая дуга (60°): лучше не найти, чем найти с ложной уверенностью */
  const tiny = AM.analyze(pipesScene({ pipes: [[0, 2.6, 0.055]], arc0: 60, arc1: 120 }).f32(SHIFT), { kind: 'труба' });
  const t = tiny.ok ? dim(tiny, 'diameter') : null;
  if (t) assert.notEqual(t.level, 'high', 'дуга 60° не может быть «высокой»');
});

test('труба с большим шумом: σ растёт, ошибка укладывается в 3σ', () => {
  const quiet = AM.analyze(pipesScene({ pipes: [[0, 2.6, 0.055]], noise: 0.0004 }).f32(SHIFT), { kind: 'труба' });
  const noisy = AM.analyze(pipesScene({ pipes: [[0, 2.6, 0.055]], noise: 0.004 }).f32(SHIFT), { kind: 'труба' });
  const a = dim(quiet, 'diameter'), b = dim(noisy, 'diameter');
  assert.ok(b.sigma > a.sigma * 1.5, 'σ с шумом ' + b.sigma + ' против ' + a.sigma);
  assert.ok(Math.abs(b.value - 0.11) <= Math.max(3 * b.sigma, 0.003), 'ошибка ' + (b.value - 0.11) + ' при σ ' + b.sigma);
  assert.ok(b.confidence <= a.confidence + 1e-9, 'шум не повышает уверенность');
});

test('ложные срабатывания: плоская стена и коробчатая колонна не дают «труб»', () => {
  const wall = new Scene(3, 0.015, 0.0008); wall.plane([-2, 0, 0], [1, 0, 0], [0, 1, 0], 4, 3);
  const r1 = AM.analyze(wall.f32(SHIFT));
  assert.equal(r1.ok, true);
  assert.equal(r1.objects.filter((o) => o.type === 'cylinder').length, 0);
  const col = new Scene(4, 0.012, 0.0008);
  col.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], 0.4, 3); col.plane([0, 0, 0.4], [1, 0, 0], [0, 1, 0], 0.4, 3);
  col.plane([0, 0, 0], [0, 0, 1], [0, 1, 0], 0.4, 3); col.plane([0.4, 0, 0], [0, 0, 1], [0, 1, 0], 0.4, 3);
  const r2 = AM.analyze(col.f32(SHIFT));
  assert.equal(r2.ok, true);
  assert.equal(r2.objects.filter((o) => o.type === 'cylinder').length, 0, 'колонна из четырёх плоскостей — не труба');
});

test('труба, лежащая под углом к осям здания: помечается, уклон не выдаётся', () => {
  const ax = [0.55, 0.0, 0.835];   // ≈ 33° к оси Z в плане
  const sc = new Scene(21, 0.01, 0.0005);
  sc.plane([-3, 2.9, -1], [1, 0, 0], [0, 0, 1], 6, 5);
  sc.cyl([0, 2.62, 1], ax, 0.055, -1.5, 1.5, { keep: (x, y) => y <= 2.64 });
  const r = AM.analyze(sc.f32(SHIFT), { kind: 'труба' });
  const c = r.objects.find((o) => o.type === 'cylinder');
  if (c) {
    assert.equal(c.dims.some((d) => d.key === 'slope'), false, 'уклон оси при косом направлении не считаем');
    const d = c.dims.find((x) => x.key === 'diameter');
    assert.ok(Math.abs(d.value - 0.11) < 0.006, 'диаметр ' + d.value);
  }
});

test('одинаковое облако — одинаковый ответ; мало точек — понятная ошибка', () => {
  const sc = pipesScene({ step: 0.02 }), a = AM.analyze(sc.f32(SHIFT)), b = AM.analyze(sc.f32(SHIFT));
  const strip = (r) => JSON.stringify(r.objects.map((o) => [o.title, o.dims.map((d) => [d.key, +d.value.toFixed(6), +d.sigma.toFixed(6), d.level])]));
  assert.equal(strip(a), strip(b));
  const few = AM.analyze(new Float32Array(30 * 3));
  assert.equal(few.ok, false);
  assert.match(few.error, /мало точек/);
});

test('тип объекта задаёт главный объект; holes:false отключает путь «по дыре»', () => {
  const sc = doorScene({ step: 0.012 });
  sc.cyl([0, 2.75, 1.0], [1, 0, 0], 0.05, -1.0, 1.0, { keep: (x, y) => y <= 2.77 });
  const pts = sc.f32(SHIFT);
  assert.equal(AM.analyze(pts, { kind: 'дверь' }).main.type, 'opening');
  assert.equal(AM.analyze(pts, { kind: 'труба' }).objects.find((o) => o.type === 'cylinder') != null, true);
  const noHole = AM.analyze(doorScene({ step: 0.012, noJambs: true }).f32(SHIFT), { holes: false });
  assert.equal(noHole.info.holes || 0, 0);
});

test('toMeasurement: стандартный результат «distance» с пометкой auto, уклон — отдельным полем', () => {
  const r = AM.analyze(pipesScene({ step: 0.012 }).f32(SHIFT), { kind: 'труба' });
  const ob = r.objects.find((o) => o.type === 'cylinder'), d = ob.dims.find((x) => x.key === 'diameter'), m = AM.toMeasurement(d, { object: ob.title });
  assert.equal(m.mode, 'distance');
  assert.ok(Math.abs(m.perp - d.value) < 1e-12);
  assert.equal(m.auto.dimension, 'diameter'); assert.equal(m.auto.unit, 'm'); assert.equal(m.auto.object, ob.title);
  assert.ok(m.auto.sigma > 0 && ['high', 'medium', 'low'].includes(m.auto.level));
  assert.ok(Math.abs(Math.hypot(m.dx, m.dy, m.dz) - m.d3) < 1e-9);
  const s = ob.dims.find((x) => x.key === 'slope');
  assert.ok(s, 'у горизонтальной трубы длиной 3 м уклон оси есть');
  assert.equal(s.dimension, 'slope');
  assert.notEqual(s.level, 'high', 'уклон отсчитан от вертикали облака и не учитывает прогиб — выше «средней» не ставим');
  assert.ok(s.notes.some((n) => /вертикали облака/.test(n)));
  const ms = AM.toMeasurement(s, {});
  assert.equal(ms.auto.unit, '%'); assert.equal(ms.perp, undefined); assert.ok(Math.abs(ms.grade - s.value) < 1e-12); assert.equal(ms.gradeSigma, s.sigma);
});
