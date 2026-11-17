'use strict';
/* r169. Автоопределение типа элемента по выделенным точкам + точность размеров.
 *
 * Жалоба: в «Инспекторе объекта» автоматический замер на колонне/стене/балке всегда показывал
 * «Труба Ø…» и плохо мерил. Здесь проверяем классификатор AM.classify (плоскость/коробка/
 * цилиндр/проём/ребро) и интеграцию в AM.analyze:
 *   • тип на синтетических выделениях (стена, колонна квадратная/круглая, балка, труба, проём)
 *     — точность ≥98 %;
 *   • размеры по типу — ошибка ≤2 мм на случайно-равномерных облаках (края не квантуются сеткой);
 *   • top-3 вероятности корректны и различимы по типу;
 *   • в analyze главный объект — определённый тип, а не ложная «труба»;
 *   • старые сценарии (труба, дверь, помещение) не сломаны. */
const test = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../renderer/auto-measure.js');
const { doorScene } = require('./helpers/auto-synth.js');

const SHIFT = [5, 1, -2];

/* ---------- Генератор облаков со случайно-равномерной выборкой поверхностей ----------
   Нужен, чтобы измеренные размеры сравнивать с НАЗНАЧЕННЫМИ размерами: у регулярной сетки
   крайние точки смещены на полшага, а равномерная выборка даёт края почти без смещения. */
function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function cr(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function RScene(seed, noise) { this.r = rng(seed || 1); this.noise = noise == null ? 0.0003 : noise; this.p = []; }
RScene.prototype.plane = function (o, u, v, w, h, opt) {
  opt = opt || {};
  const n = cr(u, v), np = opt.n || Math.max(400, Math.round(7000 * w * h));
  for (let i = 0; i < np; i++) {
    const x = w * this.r(), y = h * this.r(), e = gauss(this.r) * this.noise;
    this.p.push(o[0] + u[0] * x + v[0] * y + n[0] * e, o[1] + u[1] * x + v[1] * y + n[1] * e, o[2] + u[2] * x + v[2] * y + n[2] * e);
  }
};
RScene.prototype.cyl = function (c, a, r, t0, t1, opt) {
  opt = opt || {};
  a = norm(a);
  const e1 = Math.abs(a[1]) > 0.9 ? norm(cr(a, [1, 0, 0])) : norm(cr(a, [0, 1, 0])), e2 = cr(a, e1);
  const n = opt.n || Math.max(600, Math.round(9000 * r * (t1 - t0)));
  const a0 = (opt.arc0 == null ? 0 : opt.arc0) * Math.PI / 180, a1 = (opt.arc1 == null ? 360 : opt.arc1) * Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const t = t0 + (t1 - t0) * this.r(), th = a0 + (a1 - a0) * this.r(), rr = r + gauss(this.r) * this.noise;
    const cx = Math.cos(th), sx = Math.sin(th);
    const x = c[0] + a[0] * t + rr * (cx * e1[0] + sx * e2[0]);
    const y = c[1] + a[1] * t + rr * (cx * e1[1] + sx * e2[1]);
    const z = c[2] + a[2] * t + rr * (cx * e1[2] + sx * e2[2]);
    if (opt.keep && !opt.keep(x, y, z)) continue;
    this.p.push(x, y, z);
  }
};
RScene.prototype.f32 = function (shift) {
  shift = shift || [0, 0, 0];
  const o = new Float32Array(this.p.length);
  for (let i = 0; i < this.p.length; i += 3) { o[i] = this.p[i] + shift[0]; o[i + 1] = this.p[i + 1] + shift[1]; o[i + 2] = this.p[i + 2] + shift[2]; }
  return o;
};

/* ---------- Фикстуры: эталонные выделения одного элемента ---------- */
function wallScene() {
  const sc = new RScene(1201, 0.0003);       // стена 3.0 x 2.5 м, толщина 0.2 м — видны обе грани
  sc.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], 3.0, 2.5);
  sc.plane([0, 0, 0.2], [1, 0, 0], [0, 1, 0], 3.0, 2.5);
  return sc.f32(SHIFT);
}
function wallOneFaceScene() {
  const sc = new RScene(1202, 0.0003);       // только одна грань — толщину измерить нельзя
  sc.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], 2.4, 2.0);
  return sc.f32(SHIFT);
}
function columnBoxScene(noise) {
  const sc = new RScene(1203, noise == null ? 0.0003 : noise);   // 0.4 x 0.4 x 2.8
  const W = 0.4, H = 2.8;
  sc.plane([0, 0, 0], [0, 0, 1], [0, 1, 0], W, H); sc.plane([W, 0, 0], [0, 0, 1], [0, 1, 0], W, H);
  sc.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], W, H); sc.plane([0, 0, W], [1, 0, 0], [0, 1, 0], W, H);
  return sc.f32(SHIFT);
}
function columnCornerScene() {
  const sc = new RScene(1204, 0.0003);       // частично видимая колонна: две смежные грани + пол
  const W = 0.4, H = 1.5;
  sc.plane([0, 0, 0], [0, 0, 1], [0, 1, 0], W, H);
  sc.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], W, H);
  sc.plane([-0.8, 0, -0.8], [1, 0, 0], [0, 0, 1], 1.6, 1.6);
  return sc.f32(SHIFT);
}
function columnRoundScene(noise) {
  const sc = new RScene(1205, noise == null ? 0.0003 : noise);   // круглая колонна Ø0.4, H2.8
  sc.cyl([0, 0, 0], [0, 1, 0], 0.2, 0, 2.8);
  return sc.f32(SHIFT);
}
function beamScene() {
  const sc = new RScene(1206, 0.0003);       // балка 0.2 x 0.4 x 3.0: низ + два бока
  const W = 0.2, H = 0.4, L = 3.0;
  sc.plane([0, 1.8, 0], [1, 0, 0], [0, 0, 1], L, W);
  sc.plane([0, 1.8, 0], [1, 0, 0], [0, 1, 0], L, H);
  sc.plane([0, 1.8, W], [1, 0, 0], [0, 1, 0], L, H);
  return sc.f32(SHIFT);
}
function pipeScene(arc0, arc1) {
  const sc = new RScene(1207, 0.0003);       // труба Ø0.11, L2.5
  sc.cyl([0, 1.2, 0], [0, 0, 1], 0.055, 0, 2.5, { arc0: arc0, arc1: arc1 });
  return sc.f32(SHIFT);
}
function floorScene() {
  const sc = new RScene(1208, 0.0003);       // пол 5x4, одна горизонтальная плоскость внизу
  sc.plane([0, 0, 0], [1, 0, 0], [0, 0, 1], 5.0, 4.0);
  return sc.f32(SHIFT);
}

const DIM = (cls, key) => (cls.dims || []).find((d) => d.key === key);
function dimErr(cls, key, expected, tol) {
  const d = DIM(cls, key);
  assert.ok(d, 'нет размера «' + key + '» (есть: ' + (cls.dims || []).map((x) => x.key).join(', ') + ')');
  const err = Math.abs(d.value - expected);
  assert.ok(err <= tol, key + ': измерено ' + d.value.toFixed(4) + ', эталон ' + expected.toFixed(4) + ', ошибка ' + (1000 * err).toFixed(2) + ' мм > ' + (1000 * tol) + ' мм');
  return err;
}

/* ---------- 1. Точность типа на 12 выделениях (6 типов × 2 варианта) ---------- */
test('r169: тип элемента на синтетике — точность ≥98 % (12/12)', () => {
  const cases = [
    ['стена (две грани)', wallScene(), 'wall'],
    ['стена (одна грань)', wallOneFaceScene(), 'wall'],
    ['колонна квадратная 400×400', columnBoxScene(), 'column'],
    ['колонна (видны 2 грани)', columnCornerScene(), 'column'],
    ['колонна круглая Ø400', columnRoundScene(), 'column'],
    ['колонна круглая Ø400 (шум 1.5 мм)', columnRoundScene(0.0015), 'column'],
    ['балка 200×400', beamScene(), 'beam'],
    ['труба Ø110', pipeScene(), 'pipe'],
    ['труба Ø110 (дуга 270°)', pipeScene(30, 300), 'pipe'],
    ['проём 1.5×2.2 (с откосами)', doorScene({ step: 0.01 }).f32(SHIFT), 'opening'],
    ['проём 1.5×2.2 (только дыра)', doorScene({ step: 0.015, noJambs: true }).f32(SHIFT), 'opening'],
    ['пол 5×4', floorScene(), 'floor']
  ];
  const rows = [];
  let ok = 0;
  cases.forEach(([name, pts, expect]) => {
    const c = AM.classify(pts, {});
    assert.equal(c.ok, true, name + ': ' + (c.error || 'классификация не удалась'));
    const pass = c.type === expect;
    if (pass) ok++;
    rows.push({ name, expect, got: c.type, kind: c.kind, conf: +c.confidence.toFixed(3) });
    assert.equal(pass, true, name + ': ожидался «' + expect + '», получено «' + c.type + '» (' + c.kind + ', ' + (100 * c.confidence).toFixed(1) + '%)');
  });
  const acc = ok / cases.length;
  assert.ok(acc >= 0.98, 'точность типа ' + (100 * acc).toFixed(1) + ' % < 98 %');
  assert.equal(ok, cases.length, 'все типы определены верно');
  console.log('    r169 типы: ' + rows.map((r) => r.expect + '→' + r.got + '(' + (100 * r.conf).toFixed(0) + '%)').join(', '));
});

/* ---------- 2. Размеры по типам: ошибка ≤2 мм ---------- */
test('r169: стена — толщина/длина/высота с ошибкой ≤2 мм', () => {
  const c = AM.classify(wallScene(), {});
  assert.equal(c.type, 'wall');
  const eT = dimErr(c, 'wall-thickness', 0.200, 0.002);
  const eL = dimErr(c, 'wall-length', 3.000, 0.002);
  const eH = dimErr(c, 'wall-height', 2.500, 0.002);
  console.log('    стена: T ' + (1000 * eT).toFixed(2) + ' мм, L ' + (1000 * eL).toFixed(2) + ' мм, H ' + (1000 * eH).toFixed(2) + ' мм');
});

test('r169: стена с одной видимой гранью — длина/высота, толщины нет', () => {
  const c = AM.classify(wallOneFaceScene(), {});
  assert.equal(c.type, 'wall');
  dimErr(c, 'wall-length', 2.400, 0.002);
  dimErr(c, 'wall-height', 2.000, 0.002);
  assert.equal(DIM(c, 'wall-thickness'), undefined, 'толщина без второй грани не выдумывается');
  assert.ok((c.notes || []).some((n) => /толщина/i.test(n)), 'есть оговорка про толщину');
});

test('r169: колонна квадратная — сечение 400×400, высота, ошибка ≤2 мм', () => {
  const c = AM.classify(columnBoxScene(), {});
  assert.equal(c.type, 'column');
  const ew = dimErr(c, 'column-width', 0.400, 0.002);
  const ed = dimErr(c, 'column-depth', 0.400, 0.002);
  const eh = dimErr(c, 'column-height', 2.800, 0.002);
  console.log('    колонна: ' + (1000 * ew).toFixed(2) + '/' + (1000 * ed).toFixed(2) + ' мм сечение, H ' + (1000 * eh).toFixed(2) + ' мм');
});

test('r169: колонна по двум смежным граням — 400×400, H1.5, ошибка ≤2 мм', () => {
  const c = AM.classify(columnCornerScene(), {});
  assert.equal(c.type, 'column');
  dimErr(c, 'column-width', 0.400, 0.002);
  dimErr(c, 'column-depth', 0.400, 0.002);
  dimErr(c, 'column-height', 1.500, 0.002);
});

test('r169: колонна круглая — диаметр 400 и высота, ошибка ≤2 мм', () => {
  const c = AM.classify(columnRoundScene(), {});
  assert.equal(c.type, 'column');
  const eD = dimErr(c, 'diameter', 0.400, 0.002);
  const eH = dimErr(c, 'column-height', 2.800, 0.002);
  console.log('    круглая колонна: Ø ' + (1000 * eD).toFixed(2) + ' мм, H ' + (1000 * eH).toFixed(2) + ' мм');
});

test('r169: балка — 200×400×3000, ошибка ≤2 мм', () => {
  const c = AM.classify(beamScene(), {});
  assert.equal(c.type, 'beam');
  const ew = dimErr(c, 'beam-width', 0.200, 0.002);
  const eh = dimErr(c, 'beam-height', 0.400, 0.002);
  const el = dimErr(c, 'beam-length', 3.000, 0.002);
  console.log('    балка: ' + (1000 * ew).toFixed(2) + '×' + (1000 * eh).toFixed(2) + ' мм, L ' + (1000 * el).toFixed(2) + ' мм');
});

test('r169: труба — диаметр 110 и длина, ошибка ≤2 мм', () => {
  const c = AM.classify(pipeScene(), {});
  assert.equal(c.type, 'pipe');
  const eD = dimErr(c, 'diameter', 0.110, 0.002);
  const eL = dimErr(c, 'length', 2.500, 0.002);
  console.log('    труба: Ø ' + (1000 * eD).toFixed(2) + ' мм, L ' + (1000 * eL).toFixed(2) + ' мм');
  // видимая дуга: диаметр тоже в пределах пары мм
  const c2 = AM.classify(pipeScene(30, 300), {});
  assert.equal(c2.type, 'pipe');
  dimErr(c2, 'diameter', 0.110, 0.002);
});

test('r169: проём — ширина 1500 и высота 2200, ошибка ≤2 мм', () => {
  const c = AM.classify(doorScene({ step: 0.01 }).f32(SHIFT), {});
  assert.equal(c.type, 'opening');
  const ew = dimErr(c, 'width', 1.500, 0.002);
  const eh = dimErr(c, 'height', 2.200, 0.002);
  console.log('    проём: W ' + (1000 * ew).toFixed(2) + ' мм, H ' + (1000 * eh).toFixed(2) + ' мм');
});

/* ---------- 3. Вероятности top-3 ---------- */
test('r169: top-3 вероятности — разные типы, сумма с «другим» ≤1, уверенность разумна', () => {
  [['стена', wallScene()], ['колонна', columnRoundScene()], ['труба', pipeScene()], ['проём', doorScene({ step: 0.01 }).f32(SHIFT)]].forEach(([name, pts]) => {
    const c = AM.classify(pts, {});
    assert.equal(c.ok, true, name);
    assert.ok(Array.isArray(c.probabilities) && c.probabilities.length >= 1, name + ': нет top-3');
    assert.ok(c.probabilities.length <= 3, name + ': top-3 не больше трёх');
    const types = c.probabilities.map((p) => p.type);
    assert.equal(new Set(types).size, types.length, name + ': типы в top-3 не дублируются');
    let sum = 0;
    c.probabilities.forEach((p) => { assert.ok(p.probability > 0 && p.probability <= 1, name + ': вероятность в (0,1]'); sum += p.probability; });
    assert.ok(sum + c.otherProbability <= 1.0001, name + ': сумма вероятностей ≤1');
    assert.ok(c.confidence >= 0.5, name + ': уверенность ≥50 % (' + (100 * c.confidence).toFixed(1) + '%)');
    assert.ok(c.probabilities[0].type === c.type, name + ': первый top-3 — выбранный тип');
  });
});

/* ---------- 4. Интеграция в analyze: главный объект — правильный тип, а не «труба» ---------- */
test('r169: analyze — на колонне/стене/балке главный объект НЕ труба', () => {
  const checks = [
    ['колонна квадратная', columnBoxScene(), 'column'],
    ['колонна (2 грани)', columnCornerScene(), 'column'],
    ['колонна круглая', columnRoundScene(), 'column'],
    ['стена', wallScene(), 'wall'],
    ['балка', beamScene(), 'beam']
  ];
  checks.forEach(([name, pts, type]) => {
    const r = AM.analyze(pts, {});
    assert.equal(r.ok, true, name);
    assert.ok(r.main, name + ': главный объект найден');
    assert.notEqual(r.main.type, 'cylinder', name + ': главный объект не «Труба» (было «Труба» из-за ложной подгонки цилиндра)');
    assert.equal(r.main.clsType || r.main.type, type, name + ': тип главного объекта «' + type + '», получено «' + (r.main.clsType || r.main.type) + '» (' + r.main.title + ')');
    assert.ok(r.info.classification && r.info.classification.type === type, name + ': классификатор в info.classification');
    assert.ok(r.main.outline && r.main.outline.length >= 4, name + ': у главного объекта есть контур для показа');
  });
  const pipe = AM.analyze(pipeScene(), {});
  assert.ok(pipe.main, 'труба: главный объект найден');
  assert.equal(pipe.main.type, 'cylinder', 'труба остаётся цилиндром');
  assert.ok(Math.abs(pipe.main.dims.find((d) => d.key === 'diameter').value - 0.11) < 0.003, 'диаметр трубы');
});

test('r169: analyze — дверной проём и помещение не сломаны', () => {
  const door = AM.analyze(doorScene({ step: 0.01 }).f32(SHIFT), {});
  assert.equal(door.main.type, 'opening');
  assert.ok(Math.abs(door.main.dims.find((d) => d.key === 'width').value - 1.5) < 0.004);
  // помещение: пол/потолок/стены — по-прежнему находятся размеры помещения
  const { Scene } = require('./helpers/auto-synth.js');
  const sc = new Scene(5, 0.02, 0.001);
  sc.plane([0, 0, 0], [1, 0, 0], [0, 0, 1], 6, 4);
  sc.plane([0, 2.8, 0], [1, 0, 0], [0, 0, 1], 6, 4);
  sc.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], 6, 2.8);
  sc.plane([0, 0, 4], [1, 0, 0], [0, 1, 0], 6, 2.8);
  sc.plane([0, 0, 0], [0, 0, 1], [0, 1, 0], 4, 2.8);
  sc.plane([6, 0, 0], [0, 0, 1], [0, 1, 0], 4, 2.8);
  const room = AM.analyze(sc.f32(SHIFT), {});
  assert.ok(room.objects.some((o) => o.dims.some((d) => d.key === 'room-height')), 'высота помещения найдена');
  assert.ok(room.objects.some((o) => o.dims.some((d) => d.key === 'room-width')), 'ширина помещения найдена');
});

/* ---------- 5. Детерминизм и защита от мусора ---------- */
test('r169: классификация детерминирована и не падает на мусоре', () => {
  const a = AM.classify(columnBoxScene(), {}), b = AM.classify(columnBoxScene(), {});
  assert.deepEqual(a.probabilities, b.probabilities, 'одинаковое облако — одинаковые вероятности');
  assert.equal(a.type, b.type);
  for (let k = 0; k < 5; k++) {
    const junk = new Float32Array(300 * 3);
    const r = rng(300 + k);
    for (let i = 0; i < junk.length; i++) junk[i] = (r() - 0.5) * 2;
    const c = AM.classify(junk, {});
    assert.equal(typeof c.ok, 'boolean', 'мусор: не падаем');
    if (c.ok) assert.ok(c.type && c.confidence >= 0 && c.confidence <= 1, 'мусор: корректный ответ');
  }
  const tiny = AM.classify(new Float32Array(90), {});
  assert.equal(tiny.ok, false, 'мало точек — понятная ошибка');
  assert.match(tiny.error, /мало точек/i);
});
