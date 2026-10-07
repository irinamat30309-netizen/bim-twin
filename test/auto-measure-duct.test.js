'use strict';
/* Прямоугольный воздуховод не должен превращаться в «трубу» с подогнанной окружностью (ревизия 11).
 * Раньше при шуме 8–12 мм подгонка окружности брала точки только у самой окружности и «набирала» дугу 260° на коробе. */
const test = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../renderer/auto-measure.js');
const { Scene } = require('./helpers/auto-synth.js');
const SHIFT = [5, 1, -2];

function duct(o) {
  o = o || {};
  const sc = new Scene(o.seed || 11, o.step || 0.01, o.noise == null ? 0.008 : o.noise), w = o.w || 0.3, h = o.h || 0.2, y0 = 2.2, x0 = o.x0 || 0, L = 3;
  sc.plane([-2, 2.9, 0], [1, 0, 0], [0, 0, 1], 4, 3);                    // потолок
  sc.plane([x0 - w / 2, y0, 0], [1, 0, 0], [0, 0, 1], w, L);               // низ
  sc.plane([x0 - w / 2, y0, 0], [0, 1, 0], [0, 0, 1], h, L);               // левая сторона
  sc.plane([x0 + w / 2, y0, 0], [0, 1, 0], [0, 0, 1], h, L);               // правая сторона
  if (o.top) sc.plane([x0 - w / 2, y0 + h, 0], [1, 0, 0], [0, 0, 1], w, L);
  if (o.pipe) sc.cyl([x0 + 0.9, 2.62, 0], [0, 0, 1], 0.055, 0, 3, { keep: (x, y) => y <= 2.64 });
  return sc;
}
const dims = (r) => { const d = r.objects.find((ob) => ob.type === 'duct'); return d ? { w: d.dims.find((x) => x.key === 'duct-width'), h: d.dims.find((x) => x.key === 'duct-height'), ob: d } : null; };
const cyls = (r) => r.objects.filter((ob) => ob.type === 'cylinder');

test('воздуховод 300×200 с шумом 8 мм: найден как воздуховод с сечением ±6 мм, окружность не подгоняется', () => {
  const r = AM.analyze(duct({ top: 1 }).f32(SHIFT)), d = dims(r);
  assert.equal(r.ok, true);
  assert.ok(d, 'воздуховод найден: ' + r.objects.map((o) => o.title).join(' | '));
  assert.ok(Math.abs(d.w.value - 0.3) < 0.006 && Math.abs(d.h.value - 0.2) < 0.006, 'сечение ' + d.w.value + '×' + d.h.value);
  assert.equal(cyls(r).length, 0, 'ложных труб быть не должно: ' + cyls(r).map((o) => o.title));
  assert.match(d.ob.title, /^Воздуховод (29\d|30\d)×(19\d|20\d) мм$/);
  assert.equal(r.info.ducts, 1);
});

test('воздуховод 500×350 при шуме 12 мм и короб без верхней грани: размеры верны, дубликатов нет', () => {
  const a = AM.analyze(duct({ w: 0.5, h: 0.35, top: 1, noise: 0.012 }).f32(SHIFT)), da = dims(a);
  assert.ok(da && Math.abs(da.w.value - 0.5) < 0.01 && Math.abs(da.h.value - 0.35) < 0.01, 'сечение ' + (da && da.w.value + '×' + da.h.value));
  assert.equal(a.objects.filter((o) => o.type === 'duct').length, 1);
  assert.equal(cyls(a).length, 0);
  const b = AM.analyze(duct({}).f32(SHIFT)), db = dims(b);   // три грани: верха нет — высота по торцам боковых граней
  assert.ok(db && Math.abs(db.w.value - 0.3) < 0.006 && Math.abs(db.h.value - 0.2) < 0.008, 'сечение без верха ' + (db && db.w.value + '×' + db.h.value));
  assert.equal(cyls(b).length, 0);
});

test('труба рядом с воздуховодом остаётся трубой Ø110, воздуховод — коробом; лишних цилиндров нет', () => {
  const r = AM.analyze(duct({ pipe: 1, x0: -0.5 }).f32(SHIFT)), d = dims(r), c = cyls(r);
  assert.ok(d && Math.abs(d.w.value - 0.3) < 0.008, 'воздуховод найден');
  assert.equal(c.length, 1, 'одна труба: ' + c.map((o) => o.title));
  const dia = c[0].dims.find((x) => x.key === 'diameter').value;
  assert.ok(Math.abs(dia - 0.11) < 0.004, 'диаметр трубы ' + dia);
});

test('тип «воздуховод», выбранный человеком, поднимает прямоугольный воздуховод как главный результат; в списке есть контур и размеры в метрах', () => {
  const r = AM.analyze(duct({ top: 1 }).f32(SHIFT), { kind: 'воздуховод' });
  assert.equal(r.main && r.main.type, 'duct');
  assert.ok(r.main.outline.length >= 24 && r.main.dims.every((x) => x.a && x.b));
  assert.equal(r.main.family, 'pipe');
});
