'use strict';
/* Ревизия 4: автозамер должен мерить ИМЕННО нужный объект.
 * Жалоба: у трубы показывалось «то, что снизу в полу». Причины: размеры «привязки к полу» выдавались как надёжные размеры трубы,
 * подгонка цилиндров по земле/пучку давала большие «трубы», выбранный тип не отсекал чужие находки, не было способа указать объект.
 * Здесь: тип отсекает чужое, привязка к окружению помечена и не путается с размером, указанная точка выбирает объект,
 * ложные цилиндры (огибающая пучка, подгонка по земле) отбрасываются, контур объекта виден. Синтетика с известными размерами. */
const test = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../renderer/auto-measure.js');
const { Scene, doorScene } = require('./helpers/auto-synth.js');

const SHIFT = [5, 1, -2];
const near = (a, b, t) => Math.abs(a - b) <= t;

/* Помещение: пол y=0, потолок y=2.9, труба Ø160 на высоте оси 1.2 вдоль z (полная окружность видна). */
function pipeRoom(opt) {
  opt = opt || {};
  const sc = new Scene(opt.seed || 21, 0.01, 0.0005);
  sc.plane([-2, 0, 0], [1, 0, 0], [0, 0, 1], 4, 3);
  sc.plane([-2, 2.9, 0], [1, 0, 0], [0, 0, 1], 4, 3);
  (opt.pipes || [[0, 1.2, 0.08]]).forEach((p) => sc.cyl([p[0], p[1], 0], [0, 0, 1], p[2], 0, 3, {}));
  return sc;
}
const cyls = (r) => r.objects.filter((o) => o.type === 'cylinder');

test('тип «труба»: главный объект — труба; помещение рядом — «другое в рамке», не главный и не «свой тип»', () => {
  const r = AM.analyze(pipeRoom().f32(SHIFT), { kind: 'труба' });
  assert.equal(r.ok, true);
  assert.equal(r.main.type, 'cylinder');
  assert.equal(r.main.onType, true);
  assert.equal(r.main.offType, false);
  assert.ok(near(r.main.dims.find((d) => d.key === 'diameter').value, 0.16, 0.003));
  const room = r.objects.find((o) => o.dims.some((d) => d.key === 'room-height'));
  assert.ok(room, 'помещение найдено');
  assert.equal(room.offType, true);
  assert.equal(room.onType, false);
  assert.equal(r.objects.indexOf(r.main) < r.objects.indexOf(room), true, 'свои находки идут раньше чужих');
  assert.ok(r.info.roles.indexOf('pipe') >= 0 && r.info.roles.indexOf('room-height') >= 0, 'роли: ' + r.info.roles);
});

test('высота оси над полом — «привязка к окружению» (ref): отдельно от размеров трубы, пометка в тексте', () => {
  const r = AM.analyze(pipeRoom().f32(SHIFT), { kind: 'труба' });
  const own = r.main.dims.filter((d) => !d.ref), refs = r.main.dims.filter((d) => d.ref);
  assert.ok(own.length >= 1);
  own.forEach((d) => assert.ok(['diameter', 'length', 'slope'].indexOf(d.dimension) >= 0, 'собственный размер трубы: ' + d.key));
  assert.ok(refs.length >= 1, 'настоящий пол под трубой даёт привязку');
  const ax = refs.find((d) => d.key === 'axis-height');
  assert.ok(ax && near(ax.value, 1.2, 0.01), 'высота оси ' + (ax && ax.value));
  refs.forEach((d) => assert.match(d.notes.join(' '), /не размер самой трубы/));
});

test('тип «дверь» на сцене с трубой: главный — проём, труба — чужая находка; тип «труба» на двери — не найдено', () => {
  const sc = doorScene({ step: 0.012 });
  sc.cyl([0, 2.75, 1.0], [1, 0, 0], 0.05, -1.0, 1.0, { keep: (x, y) => y <= 2.77 });
  const pts = sc.f32(SHIFT);
  const a = AM.analyze(pts, { kind: 'дверь' });
  assert.equal(a.main.type, 'opening');
  assert.equal(a.noMatch, undefined);
  const b = AM.analyze(doorScene({ step: 0.012 }).f32(SHIFT), { kind: 'труба' });
  assert.equal(b.ok, true);
  assert.equal(b.main, null, 'трубы нет — главного объекта нет, а не «первое попавшееся»');
  assert.equal(b.noMatch.kind, 'труба');
  assert.ok(b.noMatch.found.length >= 1);
  assert.ok(b.objects.length >= 1 && b.objects.every((o) => o.offType === true));
});

test('без типа главный — самый уверенный; роли находок перечислены для подсказки', () => {
  const r = AM.analyze(pipeRoom().f32(SHIFT));
  assert.ok(r.main && r.main.onType === true);
  assert.ok(Array.isArray(r.info.roles) && r.info.roles.length >= 2, 'роли: ' + r.info.roles);
  assert.equal(r.kind, null);
});

test('указанная точка выбирает объект среди двух труб; далёкая точка — предупреждение «far»', () => {
  const pts = pipeRoom({ pipes: [[-1, 1.2, 0.08], [1, 1.2, 0.055]] }).f32(SHIFT);
  const onB = AM.analyze(pts, { kind: 'труба', focus: [1 + SHIFT[0], 1.2 + 0.055 + SHIFT[1], 1.5 + SHIFT[2]] });
  assert.ok(near(onB.main.dims.find((d) => d.key === 'diameter').value, 0.11, 0.004), 'указали на тонкую трубу');
  assert.ok(onB.main.focusDist < 0.05);
  assert.equal(onB.focus.far, false);
  const onA = AM.analyze(pts, { kind: 'труба', focus: [-1 + SHIFT[0], 1.2 + 0.08 + SHIFT[1], 1.5 + SHIFT[2]] });
  assert.ok(near(onA.main.dims.find((d) => d.key === 'diameter').value, 0.16, 0.004), 'указали на толстую трубу');
  const far = AM.analyze(pts, { kind: 'труба', focus: [30, 1, 30] });
  assert.equal(far.focus.far, true);
  assert.ok(far.focus.distance > 0.6);
  assert.deepEqual(AM.analyze(pts, { kind: 'труба', focus: [NaN, 0, 0] }).focus, undefined, 'нечисловая точка игнорируется');
});

test('контур объекта: у трубы ось, кольца и образующие (в координатах облака), у проёма — рамка; пар отрезков чётно', () => {
  const r = AM.analyze(pipeRoom().f32(SHIFT), { kind: 'труба' });
  const o = r.main.outline;
  assert.ok(o.length > 40 && o.length % 2 === 0, 'отрезков: ' + o.length / 2);
  o.forEach((p) => { assert.equal(p.length, 3); p.forEach((v) => assert.ok(Number.isFinite(v))); });
  const ys = o.map((p) => p[1]);
  assert.ok(Math.min(...ys) > 1 + 1.2 - 0.09 && Math.max(...ys) < 1 + 1.2 + 0.09, 'контур лежит на трубе (ось y=1.2+сдвиг)');
  const d = AM.analyze(doorScene({ step: 0.012 }).f32(SHIFT), { kind: 'дверь' });
  assert.equal(d.main.outline.length, 8, 'рамка проёма — четыре отрезка');
});

test('_floorIsReal: пол должен быть горизонтальным, ровным и лежать под точкой', () => {
  const mk = (n, rms, occ) => ({ n, rms, u: [1, 0, 0], v: [0, 0, 1], d: 0, cs: 0.05, ext: { u0: 0, u1: 2, v0: 0, v1: 2 }, W: 40, H: 40, occ: new Uint8Array(1600).fill(occ) });
  const p = [1, 1, 1];
  assert.equal(AM._floorIsReal(mk([0, 1, 0], 0.002, 1), p, 0.3), true);
  assert.equal(AM._floorIsReal(mk([0, Math.cos(8 * Math.PI / 180), Math.sin(8 * Math.PI / 180)], 0.002, 1), p, 0.3), false, 'наклон 8°');
  assert.equal(AM._floorIsReal(mk([0, 1, 0], 0.05, 1), p, 0.3), false, 'неровная земля: СКО 5 см');
  assert.equal(AM._floorIsReal(mk([0, 1, 0], 0.002, 0), p, 0.3), false, 'под точкой нет точек пола');
  assert.equal(AM._floorIsReal(null, p, 0.3), false);
});

/* ---------- ложные цилиндры: огибающая пучка, подгонка по земле ---------- */
function cobj(o) {
  const a = o.a || [0, 0, 1], t0 = o.t0 == null ? 0 : o.t0, t1 = o.t1 == null ? 3 : o.t1;
  return {
    type: 'cylinder', title: 'Труба', score: o.score == null ? 1 : o.score,
    dims: [{ key: 'diameter', confidence: o.conf == null ? 0.9 : o.conf, level: 'high', notes: [] }],
    cylinder: { a, c: o.c || [0, 0, 0], r: o.r, rms: o.rms == null ? 0.003 : o.rms, count: o.count == null ? 3000 : o.count, arc: o.arc == null ? 250 : o.arc, t0, t1, length: t1 - t0 }
  };
}
function cloudInside(c, r, n) {
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const th = (i * 2.399963) % (2 * Math.PI), rr = r * Math.sqrt(((i * 0.618034) % 1) * 0.7), t = 3 * ((i * 0.381966) % 1);
    P[i * 3] = c[0] + rr * Math.cos(th); P[i * 3 + 1] = c[1] + rr * Math.sin(th); P[i * 3 + 2] = c[2] + t;
  }
  return P;
}

test('_implausibleCylinders: внутри пусто — труба; много чужих точек внутри — подгонка по огибающей/земле, отбрасывается', () => {
  const ok = cobj({ r: 0.11 }), P0 = new Float64Array(0);
  assert.equal(AM._implausibleCylinders([ok], P0, 0), 0);
  assert.equal(ok.ghost, undefined);
  const bad = cobj({ r: 0.4, count: 1000 });
  const n = AM._implausibleCylinders([bad], cloudInside([0, 0, 0], 0.4, 600), 600);
  assert.equal(n, 1);
  assert.equal(bad.ghost, true);
  assert.match(bad.ghostWhy.join(' '), /внутри контура много чужих точек/);
  assert.ok(bad.dims[0].confidence <= 0.5 && bad.dims[0].level !== 'high');
});

test('_implausibleCylinders: цилиндр, охватывающий более мелкие надёжные параллельные трубы, — огибающая пучка', () => {
  const big = cobj({ r: 0.3, count: 800, arc: 170, conf: 0.8 });
  const s1 = cobj({ r: 0.1, c: [0.0, 0.05, 0], count: 2500 }), s2 = cobj({ r: 0.1, c: [0.1, -0.05, 0], count: 2500 });
  AM._implausibleCylinders([big, s1, s2], new Float64Array(0), 0);
  assert.equal(big.ghost, true);
  assert.match(big.ghostWhy.join(' '), /охватывает/);
  assert.equal(big.cylinder.encloses, 2);
  assert.equal(s1.ghost, undefined);
  assert.equal(s2.ghost, undefined);
  const alone = cobj({ r: 0.3, count: 800, arc: 170, conf: 0.8 }), far = cobj({ r: 0.1, c: [2, 0, 0], count: 2500 });
  AM._implausibleCylinders([alone, far], new Float64Array(0), 0);
  assert.equal(alone.ghost, undefined, 'мелкая труба далеко — не охвачена');
});

test('_implausibleCylinders: для большого диаметра слишком велик разброс точек (Ø1630, СКО 31 мм) — не труба', () => {
  const g = cobj({ r: 0.815, rms: 0.031, arc: 170, count: 1400 });
  AM._implausibleCylinders([g], new Float64Array(0), 0);
  assert.equal(g.ghost, true);
  assert.match(g.ghostWhy.join(' '), /разброс точек/);
  const fine = cobj({ r: 0.3, rms: 0.004, arc: 250 });
  AM._implausibleCylinders([fine], new Float64Array(0), 0);
  assert.equal(fine.ghost, undefined, 'большая, но ровная труба остаётся');
});

test('_dedupeCylinders: одна труба из двух кусков — одна; разные радиусы и сдвиг в сторону — разные', () => {
  const a = cobj({ r: 0.11, score: 1 }), dup = cobj({ r: 0.111, c: [0.004, 0, 0], t0: 0.5, t1: 3.5, score: 0.7 });
  assert.equal(AM._dedupeCylinders([a, dup]).length, 1);
  assert.equal(AM._dedupeCylinders([a, dup])[0], a, 'оставлен сильнейший');
  assert.equal(AM._dedupeCylinders([a, cobj({ r: 0.16, score: 0.7 })]).length, 2, 'радиус отличается');
  assert.equal(AM._dedupeCylinders([a, cobj({ r: 0.11, c: [0.3, 0, 0], score: 0.7 })]).length, 2, 'рядом, но не та же труба');
  assert.equal(AM._dedupeCylinders([a, cobj({ r: 0.11, a: [1, 0, 0], score: 0.7 })]).length, 2, 'другое направление');
});

test('_consensusPipes: короткая дуга с диаметром, не как у ≥3 надёжных соседей, — призрак; при <3 соседей не трогаем', () => {
  const mates = [0, 1, 2].map((i) => cobj({ r: 0.11, c: [0.3 * i, 0, 0], arc: 260, count: 4000 }));
  const ghost = cobj({ r: 0.2, c: [0.9, 0, 0], arc: 120, count: 300 }), likeOthers = cobj({ r: 0.112, c: [1.2, 0, 0], arc: 120, count: 300 });
  assert.equal(AM._consensusPipes(mates.concat([ghost, likeOthers])), 1);
  assert.equal(ghost.ghost, true);
  assert.equal(likeOthers.ghost, undefined);
  const g2 = cobj({ r: 0.2, arc: 120, count: 300 });
  assert.equal(AM._consensusPipes(mates.slice(0, 2).concat([g2])), 0);
});

test('труба и «земля» в одной рамке с типом «труба»: мерится диаметр трубы, а не высота над землёй; чужого в проект не идёт', () => {
  const sc = new Scene(33, 0.01, 0.0006);
  sc.plane([-2, 0, 0], [1, 0, 0], [0, Math.sin(6 * Math.PI / 180), Math.cos(6 * Math.PI / 180)], 4, 3);   // наклонная «земля»
  sc.cyl([0, 0.4, 0], [0, 0, 1], 0.11, 0, 3, { arc0: 0, arc1: 360 });
  const r = AM.analyze(sc.f32(SHIFT), { kind: 'труба' });
  assert.equal(r.ok, true);
  assert.equal(r.main.type, 'cylinder');
  assert.ok(near(r.main.dims.find((d) => d.key === 'diameter').value, 0.22, 0.004));
  r.main.dims.forEach((d) => { if (!d.ref) assert.ok(['diameter', 'length', 'slope'].indexOf(d.dimension) >= 0, d.key); });
  assert.equal(r.main.dims.filter((d) => d.ref).length, 0, 'наклонный «пол» привязкой не считается');
  assert.ok(Array.isArray(r.rejected));
});
