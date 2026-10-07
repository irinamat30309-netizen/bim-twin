'use strict';
/* Ревизия 4, окно «Инспектор объекта» (настоящий renderer/lixel-object-inspector.js в jsdom, вьюер и проект — заглушки):
 * привязка к окружению не сохраняется сама и показана отдельно; находки не того типа не сохраняются; «Объект типа … не найден»;
 * «Указать объект» (клик по облаку → замер по этой точке, точка не попадает в историю измерений); точка клика умного захвата (meta.seed)
 * передаётся в движок; контур найденного объекта рисуется в окне. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const { Scene, doorScene } = require('./helpers/auto-synth.js');

const R = path.join(__dirname, '..', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const SHIFT = [5, 1, -2];
const skip = !JSDOM && 'jsdom не установлен';

function makeEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { overlay: null, toasts: [], viewer: null, modes: [] };
  function Viewer(canvas) { this.canvas = canvas; this.pitch = 0; this.yaw = 0; log.viewer = this; }
  Viewer.isSupported = () => true;
  ['setTheme', 'setMeasure', 'loadCloud', 'resetView', 'render', '_frame', '_resize', 'setColorMode', 'setEDL', 'setPointSizeScale', '_renderMeasLabels'].forEach((n) => { Viewer.prototype[n] = function () {}; });
  Viewer.prototype.setMeasureMode = function (m) { log.modes.push(m); };
  Viewer.prototype._mkLine = (a, b, c) => ({ line: true, a, b, c });
  Viewer.prototype._setOverlay = function (list) { log.overlay = list; };
  w.Viewer3DGL = Viewer;
  const rows = [], calls = { add: 0 };
  w.__lxDocCheck = {
    add(res, ctx) { calls.add++; rows.push({ res, origin: ctx.origin, label: ctx.label, objectType: ctx.objectType, status: 'pending' }); return rows.length - 1; },
    update(i, res) { if (!rows[i]) return false; rows[i].res = res; return true; },
    row(i) { return rows[i] || null; }, rows() { return rows.slice(); }, setContext() { return true; }
  };
  w.__lxVerify = { statusInfo: () => ({ tone: 'warn', short: 'Проверить', label: 'Нужна проверка', hint: '', busy: false }), open() {} };
  w.__lxKit = { toast: (m) => { log.toasts.push(m); }, hydrate() {} };
  ['measure.js', 'measurement-doc-compare.js', 'auto-measure.js', 'lixel-object-inspector.js'].forEach((f) => w.eval(read(f)));
  return { w, log, rows, calls };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = fn(); if (v) return v; await wait(25); } throw new Error('не дождались'); }
const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => Array.from(w.document.querySelectorAll(s));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
function pipeRoom(pipes) {
  const sc = new Scene(21, 0.01, 0.0005);
  sc.plane([-2, 0, 0], [1, 0, 0], [0, 0, 1], 4, 3);
  sc.plane([-2, 2.9, 0], [1, 0, 0], [0, 0, 1], 4, 3);
  (pipes || [[0, 1.2, 0.08]]).forEach((p) => sc.cyl([p[0], p[1], 0], [0, 0, 1], p[2], 0, 3, {}));
  return sc;
}
const cloudOf = (sc, meta) => { const pos = sc.f32(SHIFT); return { pos, col: null, count: pos.length / 3, meta: meta || {} }; };
function start(env, sc, kind, meta) {
  env.w.__lxObjectInspector.open(cloudOf(sc, meta), 'Тест');
  click(env.w, $(env.w, '#lxInsTab-auto'));
  if (kind) click(env.w, $$(env.w, '#lxInsKinds [data-kind]').find((c) => c.dataset.kind === kind));
}

test('труба над полом: в проект идут размеры трубы, а «привязка к полу» — отдельной группой и только по кнопке', { skip }, async () => {
  const env = makeEnv(), { w, rows } = env;
  start(env, pipeRoom(), 'труба');
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '.lx-auto-card.main'));
  const card = $(w, '.lx-auto-card.main');
  assert.match(card.textContent, /Труба Ø160 мм/);
  const grp = card.querySelector('.lx-auto-grp');
  assert.ok(grp, 'группа «Привязка к окружению»');
  assert.match(grp.textContent, /не размер объекта/);
  const rowOf = (key) => $$(w, '.lx-auto-row').find((r) => r.querySelector('[data-auto-show="' + key + '"]'));
  const heightRow = rowOf('axis-height');
  assert.ok(heightRow, 'высота оси над полом показана');
  assert.ok(grp.compareDocumentPosition(heightRow) & w.Node.DOCUMENT_POSITION_FOLLOWING, 'строка привязки — после заголовка группы');
  assert.ok(heightRow.querySelector('[data-auto-save]'), 'у привязки есть явная кнопка «Сохранить»');
  assert.equal(rows.some((r) => /над полом/.test(r.label)), false, 'сама в проект не ушла');
  assert.ok(rows.length >= 1 && rows.every((r) => /Труба Ø160/.test(r.label) && r.objectType === 'труба'));
  assert.ok(rows.some((r) => /Диаметр трубы/.test(r.label)));
  // «Сохранить всё найденное»: помещение (другой тип) и привязки по-прежнему не сохраняются
  const before = rows.length;
  click(w, $(w, '#lxInsAutoSaveAll'));
  assert.equal(rows.length, before, 'привязки и находки другого типа не сохранены');
  assert.match(env.log.toasts[env.log.toasts.length - 1], /привязки к окружению не сохраняю/);
  // явное «Сохранить» привязки работает
  click(w, rowOf('axis-height').querySelector('[data-auto-save]'));
  assert.equal(rows.length, before + 1);
  assert.match(rows[rows.length - 1].label, /Высота оси над полом/);
});

test('контур найденного объекта рисуется в окне сразу после замера; «Показать объект» рисует его снова', { skip }, async () => {
  const env = makeEnv(), { w, log } = env;
  start(env, pipeRoom(), 'труба');
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '.lx-auto-card.main'));
  const ov = log.overlay;
  assert.ok(Array.isArray(ov) && ov.length === 1 && ov[0].line === true, 'в окне только контур объекта');
  assert.ok(ov[0].pos.length >= 6 * 20 && ov[0].pos.length % 6 === 0, 'пары концов отрезков');
  log.overlay = null;
  click(w, $(w, '[data-auto-outline]'));
  assert.ok(log.overlay && log.overlay[0].line === true);
  // размер + контур вместе
  click(w, $$(w, '.lx-auto-row').find((r) => r.querySelector('[data-auto-show="diameter"]')).querySelector('[data-auto-show]'));
  assert.equal(log.overlay[0].line, true);
  assert.equal(log.overlay[1].points, true);
  assert.equal(log.overlay[2].line, true, 'контур остаётся рядом с размером');
});

test('тип «труба», а в рамке только проём: «Объект типа «труба» не найден», ничего не сохранено, чужое — в «Другое в рамке»', { skip }, async () => {
  const env = makeEnv(), { w, rows, log } = env;
  start(env, doorScene({ step: 0.012 }), 'труба');
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '#lxInsAutoNoMatch'));
  assert.match($(w, '#lxInsAutoNoMatch').textContent, /Объект типа «труба» в рамке не найден/);
  assert.match($(w, '#lxInsAutoState').textContent, /не найден, ничего не сохранено/);
  assert.equal($(w, '.lx-auto-card.main'), null, 'главной карточки нет');
  assert.equal(rows.length, 0);
  assert.match($(w, '#lxInsAutoMore').textContent, /Другое в рамке/);
  click(w, $(w, '#lxInsAutoMore'));
  assert.ok($(w, '.lx-auto-card.off'), 'карточка чужой находки помечена');
  assert.match($(w, '.lx-auto-card.off').textContent, /другой тип/);
  click(w, $(w, '#lxInsAutoSaveAll'));
  assert.equal(rows.length, 0, '«Сохранить всё» чужой тип не сохраняет');
  assert.equal(log.overlay === null || (log.overlay || []).length === 0, true, 'контур не рисуем, когда главного объекта нет');
});

test('«Указать объект»: клик по облаку в окне задаёт точку, замер повторяется по ней, точка не попадает в историю измерений', { skip }, async () => {
  const env = makeEnv(), { w, rows, log } = env;
  start(env, pipeRoom([[-1, 1.2, 0.08], [1, 1.2, 0.055]]), 'труба');
  const AM = w.AutoMeasure, seen = [], orig = AM.analyze;
  AM.analyze = function (pos, o) { seen.push(o); return orig.call(AM, pos, o); };
  click(w, $(w, '#lxInsAutoPick'));
  assert.equal($(w, '#lxInsAutoPick').getAttribute('aria-pressed'), 'true');
  assert.equal(log.modes[log.modes.length - 1], 'point', 'вьюер в режиме «Координата»');
  assert.match($(w, '#lxInsAutoState').textContent, /Кликните по нужному объекту/);
  const pt = [1 + SHIFT[0], 1.2 + 0.055 + SHIFT[1], 1.5 + SHIFT[2]];
  log.viewer.onMeasure({ mode: 'point', point: pt });
  await until(() => $(w, '.lx-auto-card.main'));
  assert.equal(seen.length, 1);
  assert.deepEqual(Array.from(seen[0].focus), pt);
  assert.equal($(w, '#lxInsAutoPick').getAttribute('aria-pressed'), 'false');
  assert.notEqual(log.modes[log.modes.length - 1], 'point', 'режим измерения возвращён');
  assert.match($(w, '.lx-auto-card.main').textContent, /Труба Ø110 мм/, 'указали на тонкую трубу — мерится она');
  assert.match($(w, '.lx-auto-out').textContent, /Объект выбран по вашей точке/);
  assert.ok(rows.every((r) => r.origin === 'auto'), 'координата точки в проект/историю не записана');
  assert.equal(log.overlay.some((o) => o.points === true), true, 'указанная точка отмечена в окне');
  // повторное нажатие отменяет выбор
  click(w, $(w, '#lxInsAutoPick')); assert.equal($(w, '#lxInsAutoPick').getAttribute('aria-pressed'), 'true');
  click(w, $(w, '#lxInsAutoPick')); assert.equal($(w, '#lxInsAutoPick').getAttribute('aria-pressed'), 'false');
  // обычные измерения вне режима выбора работают как раньше
  log.viewer.onMeasure({ mode: 'point', point: [1, 2, 3] });
  assert.match($(w, '#lxInsCur').textContent, /1[,.]000/);
});

test('точка клика «умного захвата» (meta.seed) уходит в движок сама; новое облако сбрасывает указанную точку', { skip }, async () => {
  const env = makeEnv(), { w } = env;
  const seed = [1 + SHIFT[0], 1.2 + SHIFT[1], 1.5 + SHIFT[2]];
  start(env, pipeRoom([[-1, 1.2, 0.08], [1, 1.2, 0.055]]), 'труба', { seed });
  const AM = w.AutoMeasure, seen = [], orig = AM.analyze;
  AM.analyze = function (pos, o) { seen.push(o); return orig.call(AM, pos, o); };
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '.lx-auto-card.main'));
  assert.deepEqual(Array.from(seen[0].focus), seed);
  assert.match($(w, '.lx-auto-card.main').textContent, /Труба Ø110 мм/);
  w.__lxObjectInspector.open(cloudOf(pipeRoom()), 'Другой');
  click(w, $(w, '#lxInsTab-auto'));
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => seen.length === 2 && $(w, '.lx-auto-card.main'));
  assert.equal(seen[1].focus, null, 'у нового объекта своей точки нет, старая не тянется');
});

test('без типа и с несколькими видами находок: подсказка «выберите тип или укажите объект»', { skip }, async () => {
  const env = makeEnv(), { w } = env;
  start(env, pipeRoom(), '');
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '.lx-auto-card.main'));
  assert.match($(w, '.lx-auto-sum.hint').textContent, /В рамке разные объекты/);
  assert.match($(w, '.lx-auto-sum.hint').textContent, /Указать объект/);
});
