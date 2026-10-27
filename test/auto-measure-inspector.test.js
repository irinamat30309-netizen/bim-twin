'use strict';
/* «Измерить автоматически» в окне «Инспектор объекта»: настоящий код окна (renderer/lixel-object-inspector.js) в jsdom,
 * 3D-вьюер, проект и таблица сверки — заглушки. Проверяем поведение: вкладки, кнопка, карточки, сохранение только надёжного,
 * отсутствие дублей при повторе, «Показать», смена типа, ссылки в index.html. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const { doorScene } = require('./helpers/auto-synth.js');

const R = path.join(__dirname, '..', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const HTML = read('index.html'), INS = read('lixel-object-inspector.js'), CSS = read('ui/tools.css');
const SHIFT = [5, 1, -2];

function makeEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { viewer: [], overlay: null, labels: null, toasts: [] };
  function Viewer(canvas) { log.viewer.push('new'); this.canvas = canvas; this.pitch = 0; this.yaw = 0; }
  Viewer.isSupported = () => true;
  ['setTheme', 'setMeasureMode', 'setMeasure', 'loadCloud', 'resetView', 'render', '_frame', '_resize', 'setColorMode', 'setEDL', 'setPointSizeScale', '_renderMeasLabels'].forEach((n) => { Viewer.prototype[n] = function () { log.viewer.push(n); }; });
  Viewer.prototype._mkLine = (a, b, c) => ({ line: true, a, b, c });
  Viewer.prototype._setOverlay = function (list) { log.overlay = list; };
  w.Viewer3DGL = Viewer;
  const rows = [];
  const calls = { add: 0, update: 0, setContext: [] };
  w.__lxDocCheck = {
    add(res, ctx) { calls.add++; rows.push({ res, origin: ctx.origin, label: ctx.label, objectType: ctx.objectType, objectName: ctx.objectName, status: 'pending' }); return rows.length - 1; },
    update(i, res) { if (!rows[i]) return false; calls.update++; rows[i].res = res; return true; },
    row(i) { return rows[i] || null; },
    rows() { return rows.slice(); },
    setContext(i, patch) { calls.setContext.push([i, patch]); if (rows[i] && patch.objectType != null) rows[i].objectType = patch.objectType; return true; }
  };
  w.__lxVerify = { statusInfo: () => ({ tone: 'warn', short: 'Проверить', label: 'Нужна проверка', hint: '', busy: false }), open() {} };
  w.__lxKit = { toast: (m) => { log.toasts.push(m); }, hydrate() {} };
  ['measure.js', 'measurement-doc-compare.js', 'auto-measure.js', 'lixel-object-inspector.js'].forEach((f) => w.eval(read(f)));
  return { w, log, rows, calls };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = fn(); if (v) return v; await wait(25); } throw new Error('не дождались'); }
function cloudOf(sc) { const pos = sc.f32(SHIFT); return { pos, col: null, count: pos.length / 3 }; }
const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => Array.from(w.document.querySelectorAll(s));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

test('index.html: auto-measure.js подключён раньше окна инспектора, без inline style; тип «Лоток» есть', () => {
  const a = HTML.indexOf('auto-measure.js'), b = HTML.indexOf('lixel-object-inspector.js');
  assert.ok(a > 0 && b > a, 'auto-measure.js должен идти до lixel-object-inspector.js');
  assert.equal(/\sstyle\s*=/.test(HTML), false);
  assert.ok(/\['лоток',\s*'Лоток'\]/.test(INS));
  assert.ok(INS.includes('lxInsAutoBtn') && INS.includes('Измерить автоматически'));
  assert.ok(CSS.includes('.lx-auto-card') && CSS.includes('.lx-lvl.low') && CSS.includes('.lx-win-tab'));
});

test('окно инспектора: вкладки «Вручную» / «Автоматически», по умолчанию — ручные измерения', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w } = makeEnv();
  assert.equal(w.__lxObjectInspector.open(cloudOf(doorScene({ step: 0.012 })), 'Дверь Д-1'), true);
  assert.equal($(w, '#lxInsTab-manual').getAttribute('aria-selected'), 'true');
  assert.equal($(w, '#lxInsPane-auto').hidden, true);
  assert.equal($(w, '#lxInsPane-manual').hidden, false);
  click(w, $(w, '#lxInsTab-auto'));
  assert.equal($(w, '#lxInsTab-auto').getAttribute('aria-selected'), 'true');
  assert.equal($(w, '#lxInsPane-auto').hidden, false);
  assert.equal($(w, '#lxInsPane-manual').hidden, true);
  const btn = $(w, '#lxInsAutoBtn');
  assert.ok(btn && /Измерить автоматически/.test(btn.textContent));
  assert.equal($$(w, '#lxInsKinds [data-kind]').some((c) => c.dataset.kind === 'лоток'), true);
  assert.equal($$(w, '.lx-auto-card').length, 0, 'до нажатия результатов нет');
});

test('«Измерить автоматически»: карточка с ±σ и уверенностью, надёжное сохраняется само, повтор не плодит дубли', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w, log, rows, calls } = makeEnv();
  w.__lxObjectInspector.open(cloudOf(doorScene({ step: 0.01 })), 'Дверь Д-1');
  click(w, $(w, '#lxInsTab-auto'));
  click(w, $$(w, '#lxInsKinds [data-kind]').find((c) => c.dataset.kind === 'дверь'));
  click(w, $(w, '#lxInsAutoBtn'));
  assert.equal($(w, '#lxInsAutoBtn').disabled, true, 'на время анализа кнопка занята');
  await until(() => $(w, '.lx-auto-card'));
  const card = $(w, '.lx-auto-card.main');
  assert.match(card.textContent, /Дверной проём/);
  assert.match(card.textContent, /главный объект/);
  const rowOf = (key) => $$(w, '.lx-auto-row').find((r) => r.querySelector('[data-auto-show="' + key + '"]'));
  const wRow = rowOf('width'), hRow = rowOf('height'), dRow = rowOf('depth');
  assert.match(wRow.querySelector('.lx-auto-val').textContent, /^1,50\d м$/);
  assert.match(wRow.querySelector('.lx-auto-sig').textContent, /^\u00b1[\d,]+ мм$/);
  assert.match(wRow.querySelector('.lx-lvl').textContent, /уверенность: высокая/);
  assert.match(hRow.querySelector('.lx-auto-val').textContent, /^2,20\d м$/);
  assert.ok(dRow.classList.contains('medium') || dRow.classList.contains('low'), 'глубина — не «высокая»');
  assert.equal($(w, '#lxInsAutoBtn').disabled, false);
  assert.match($(w, '#lxInsAutoBtn').textContent, /Измерить заново/);
  // в проект ушли ровно высокие и средние размеры главного объекта; тип и происхождение — как положено
  const reliable = $$(w, '.lx-auto-card.main .lx-auto-row').filter((r) => !r.classList.contains('low'));
  assert.equal(rows.length, reliable.length);
  assert.ok(rows.length >= 2);
  rows.forEach((r) => {
    assert.equal(r.origin, 'auto');
    assert.equal(r.objectType, 'дверь');
    assert.match(r.label, /^Дверной проём: /);
    assert.equal(r.res.mode, 'distance');
    assert.ok(r.res.auto && r.res.auto.level !== 'low');
  });
  assert.ok(rows.some((r) => r.res.auto.dimension === 'width' && Math.abs(r.res.perp - 1.5) < 0.004));
  assert.equal(wRow.querySelector('.lx-auto-saved') != null, true, 'у сохранённого — «в проекте»');
  assert.ok(wRow.querySelector('.vf-chip'), 'и статус сверки');
  assert.equal(wRow.querySelector('[data-auto-save]'), null);
  // «Показать» рисует отрезок и подпись «значение ±σ» в 3D-окне
  click(w, wRow.querySelector('[data-auto-show="width"]'));
  assert.ok(Array.isArray(log.overlay) && log.overlay[0] && log.overlay[0].line, 'отрезок размера');
  assert.equal(log.overlay[1].points, true);
  assert.equal(log.overlay[0].a.length, 3);
  // повтор: записи обновляются на месте
  const n = rows.length;
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => calls.update >= n);
  await wait(60);
  assert.equal(rows.length, n, 'после повтора записей не стало больше');
  assert.equal($$(w, '.lx-auto-card').length >= 1, true);
});

test('смена типа объекта после замера: запись в проекте переключается на новый тип, а не дублируется', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w, rows, calls } = makeEnv();
  w.__lxObjectInspector.open(cloudOf(doorScene({ step: 0.01 })), 'Проём');
  click(w, $(w, '#lxInsTab-auto'));
  click(w, $$(w, '#lxInsKinds [data-kind]').find((c) => c.dataset.kind === 'дверь'));
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '.lx-auto-card') && rows.length);
  const n = rows.length;
  assert.equal(rows[0].objectType, 'дверь');
  click(w, $$(w, '#lxInsKinds [data-kind]').find((c) => c.dataset.kind === 'проём'));
  assert.match($(w, '.lx-auto-sum.warn').textContent, /Измерить заново/);
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => calls.update >= n);
  await wait(60);
  assert.equal(rows.length, n);
  assert.ok(rows.every((r) => r.objectType === 'проём'), 'тип в проекте: ' + rows.map((r) => r.objectType).join(','));
});

test('низкая уверенность не сохраняется сама, а сохраняется кнопкой; новое облако очищает результаты', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w, rows } = makeEnv();
  // очень разреженное облако без откосов: размер по краям дыры, уверенность не выше средней
  w.__lxObjectInspector.open(cloudOf(doorScene({ step: 0.03, noJambs: true })), 'Дыра в стене');
  click(w, $(w, '#lxInsTab-auto'));
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '.lx-auto-card'));
  const rowsAll = $$(w, '.lx-auto-card.main .lx-auto-row');
  const low = rowsAll.filter((r) => r.classList.contains('low'));
  const rel = rowsAll.filter((r) => !r.classList.contains('low'));
  assert.equal(rows.length, rel.length, 'в проекте только не-низкие');
  low.forEach((r) => {
    assert.ok(r.querySelector('[data-auto-save]'), 'у низкой — кнопка «Сохранить»');
    assert.equal(r.querySelector('.lx-auto-saved'), null);
  });
  assert.ok(low.length >= 1, 'в таком облаке размер по краям дыры помечается «низкой» уверенностью');
  assert.equal(rows.length, 0, 'ничего не сохранено без нажатия');
  const before = rows.length;
  click(w, low[0].querySelector('[data-auto-save]'));
  assert.equal(rows.length, before + 1, 'кнопка «Сохранить» кладёт размер в проект');
  assert.equal($$(w, '.lx-auto-row.low').some((r) => r.querySelector('.lx-auto-saved')), true);
  // новое облако — старые результаты не остаются
  w.__lxObjectInspector.open(cloudOf(doorScene({ step: 0.012 })), 'Другое');
  assert.equal($$(w, '.lx-auto-card').length, 0);
  assert.equal($(w, '#lxInsTab-manual').getAttribute('aria-selected') != null, true);
});

test('пустое или слишком малое облако: понятное сообщение, ничего не сохранено, окно живо', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w, rows } = makeEnv();
  const pos = new Float32Array(30 * 3); for (let i = 0; i < pos.length; i++) pos[i] = Math.random();
  w.__lxObjectInspector.open({ pos, col: null, count: 30 }, 'Пара точек');
  click(w, $(w, '#lxInsTab-auto'));
  click(w, $(w, '#lxInsAutoBtn'));
  await until(() => $(w, '#lxInsAutoOut') && !$(w, '#lxInsAutoOut').hidden && $(w, '.lx-auto-sum.err') );
  assert.equal(rows.length, 0);
  assert.equal($(w, '#lxInsAutoBtn').disabled, false);
  assert.ok($(w, '#lxInsAutoState').textContent.length > 10);
});
