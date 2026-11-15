'use strict';
/*
 * r130 — координаты точки облака под курсором в статус-баре (Фаза 7).
 * Проверяем:
 *   • renderer/ui/coords-hud.js подключён в index.html и имеет публичное API;
 *   • чистые функции форматирования: м (3 знака) / мм (1 знак), округление, -0, NaN→«—»,
 *     ровно формат «X: 12.346  Y: 3.210  Z: -8.120 м»;
 *   • пикинг: GPU-pick вьюера (_pickGPU) → CPU-сэмплинг (_pickPoint) → собственный
 *     сэмплинг по проекции; нет точки → прочерк; облако скрыто → прочерк;
 *   • jsdom: элемент #lxCoordsHud в #lxStatus (справа, перед кнопками), hover даёт
 *     координаты, уход курсора/вне вьюера — «—», троттлинг, отключение (localStorage),
 *     единицы мм, немедленный updateAt.
 * Часть проверок — source-level, часть — Node-чистые функции, часть — jsdom.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const SRC = fs.readFileSync(path.join(R, 'ui', 'coords-hud.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const H = require(path.join(R, 'ui', 'coords-hud.js'));

// ===================== source-level =====================
test('r130: coords-hud.js подключён в index.html', () => {
  assert.ok(HTML.includes('ui/coords-hud.js?v=130'), 'нет script в index.html');
  const html = HTML.indexOf('ui/coords-hud.js'), chrome = HTML.indexOf('ui/chrome.js');
  assert.ok(html > chrome, 'скрипт должен идти после chrome.js (статус-бар уже есть)');
  assert.ok(HTML.includes('id="lxStatus"'), 'нет статус-бара #lxStatus');
});

test('r130: модуль — API, пикинг и data-атрибуты', () => {
  assert.ok(SRC.includes('window.__lxCoordsHud'), 'нет публичного API в окне');
  assert.ok(SRC.includes('module.exports'), 'нет module.exports для node --test');
  for (const fn of ['mount', 'dispose', 'refresh', 'setEnabled', 'isEnabled', 'toggle', 'setUnits',
    'setThrottle', 'updateAt', 'current', 'formatPoint', 'formatText', 'formatCoordValue',
    'pickPointAt', 'pickByProjection', 'getViewer']) {
    assert.strictEqual(typeof H[fn], 'function', 'нет функции ' + fn);
  }
  assert.ok(SRC.includes('_pickGPU'), 'нет GPU-pick вьюера');
  assert.ok(SRC.includes('_pickPoint'), 'нет CPU-сэмплинга вьюера');
  assert.ok(SRC.includes('pickByProjection'), 'нет своего сэмплинга по проекции');
  assert.ok(SRC.includes("'pointermove'") || SRC.includes('pointermove'), 'нет pointermove');
  assert.ok(SRC.includes('addEventListener'), 'нет addEventListener');
  assert.ok(SRC.includes('pointerleave') || SRC.includes('pointerout'), 'нет обработки ухода курсора');
  assert.ok(SRC.includes('STORAGE_KEY') && SRC.includes('lxCoordsHud'), 'нет флага localStorage');
  assert.ok(SRC.includes('setTimeout'), 'нет троттлинга');
  // data-контракт элемента
  for (const a of ['lxCoordsHud', 'lx-coords-hud', 'data-coords="x"', 'data-coords="y"', 'data-coords="z"', 'data-coords-unit', 'data-coords-ok']) {
    assert.ok(SRC.includes(a), 'нет атрибута ' + a);
  }
  // только токены палитры, без синего/чистого белого/градиентов
  assert.ok(SRC.includes('var(--txt)') && SRC.includes('var(--txt-3)') && SRC.includes('var(--mono)'), 'нет токенов палитры');
  assert.ok(!/linear-gradient|radial-gradient/.test(SRC), 'градиенты запрещены');
  assert.ok(!/#fff(?:fff)?\b/i.test(SRC), 'чистый белый запрещён');
});

// ===================== Node: форматирование =====================
test('r130: формат координат — метры, 3 знака', () => {
  assert.strictEqual(H.formatText([12.3456, 3.2098, -8.1204]), 'X: 12.346  Y: 3.210  Z: -8.120 м');
  assert.strictEqual(H.formatText([1, 2, 3]), 'X: 1.000  Y: 2.000  Z: 3.000 м');
  assert.strictEqual(H.formatCoordValue(12.3456, 3), '12.346');
  assert.strictEqual(H.formatCoordValue(-8.1199, 3), '-8.120');
  assert.strictEqual(H.formatCoordValue(-0.0004, 3), '0.000', 'отрицательный ноль должен быть 0.000');
  assert.strictEqual(H.formatCoordValue(NaN, 3), '—');
  assert.strictEqual(H.roundCoord(12.3456, 2), 12.35);
});

test('r130: формат координат — миллиметры, 1 знак', () => {
  const f = H.formatPoint([12.3456, 3.2098, -8.1204], { units: 'mm' });
  assert.strictEqual(f.units, 'mm');
  assert.strictEqual(f.unit, 'мм');
  assert.strictEqual(f.decimals, 1);
  assert.strictEqual(f.text, 'X: 12345.6  Y: 3209.8  Z: -8120.4 мм');
  assert.strictEqual(H.formatCoordValue(12.3456, 1, 1000), '12345.6');
  // единицы можно задать и по-русски
  assert.strictEqual(H.formatPoint([1, 2, 3], { units: 'мм' }).unit, 'мм');
  // свой масштаб округления
  assert.match(H.formatPoint([1.23456, 0, 0], { decimals: 2 }).text, /^X: 1\.23  Y: 0\.00  Z: 0\.00 м$/);
});

test('r130: нет точки — прочерки, formatPoint.ok=false', () => {
  const f = H.formatPoint(null);
  assert.strictEqual(f.ok, false);
  assert.strictEqual(f.text, 'X: —  Y: —  Z: — м');
  assert.strictEqual(H.formatText([NaN, 0, 0]), 'X: —  Y: 0.000  Z: 0.000 м');
  assert.strictEqual(H.formatPoint([1, 2]).ok, false, 'короткий массив — не точка');
});

// ===================== Node: пикинг =====================
function stubViewer(over) {
  const rect = { left: 100, top: 100, right: 900, bottom: 700, width: 800, height: 600 };
  const log = { gpu: 0, cpu: 0, pick: 0 };
  const v = {
    canvas: { getBoundingClientRect: () => rect },
    base: [{ pos: new Float32Array([0, 0, 0]) }],
    cloudVisible: true, _interacting: false, _cloudDisplay: { opacity: 1 },
    _pickGPU(sx, sy, radius) { log.gpu++; return log.gpuHit === false ? null : { point: [12.3456, 3.2098, -8.1204] }; },
    _pickPoint(sx, sy) { log.cpu++; return log.cpuHit ? { point: [1, 2, 3] } : null; }
  };
  if (over) for (const k in over) v[k] = over[k];
  return { v: v, log: log };
}

test('r130: пикинг — GPU-pick вьюера первым', () => {
  const { v, log } = stubViewer();
  const r = H.pickPointAt(v, 500, 400);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'gpu');
  assert.deepStrictEqual(r.point, [12.3456, 3.2098, -8.1204]);
  assert.strictEqual(log.gpu, 1);
  assert.strictEqual(log.cpu, 0, 'при успешном GPU-pick CPU не нужен');
});

test('r130: пикинг — фолбэк на CPU-сэмплинг вьюера', () => {
  const { v, log } = stubViewer();
  log.gpuHit = false; log.cpuHit = true;
  const r = H.pickPointAt(v, 500, 400);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'cpu');
  assert.strictEqual(log.cpu, 1);
});

test('r130: пикинг — нет точки рядом → прочерк; облако скрыто → прочерк', () => {
  const { v, log } = stubViewer();
  log.gpuHit = false; log.cpuHit = false;
  const r = H.pickPointAt(v, 500, 400);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /рядом нет точек/);
  const hidden = stubViewer({ cloudVisible: false });
  const r2 = H.pickPointAt(hidden.v, 500, 400);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /скрыто/);
  assert.strictEqual(H.pickPointAt(null, 10, 10).ok, false, 'без вьюера — прочерк');
});

test('r130: пикинг — свой сэмплинг по проекции (вьюер без picking)', () => {
  const rect = { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 };
  const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // identity: NDC = world
  const v = {
    canvas: { getBoundingClientRect: () => rect },
    base: [{ pos: new Float32Array([0.2, 0.3, 0.5, -5, -5, -5, 0.9, 0.9, 0.9]) }],
    cloudVisible: true, _lastVP: M, _interacting: false
  };
  // NDC (0.2, 0.3) → client (600, 350) при rect 1000×1000
  const r = H.pickPointAt(v, 600, 350, { cpuOnly: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'sample');
  assert.ok(Math.abs(r.point[0] - 0.2) < 1e-6 && Math.abs(r.point[1] - 0.3) < 1e-6 && Math.abs(r.point[2] - 0.5) < 1e-6,
    'сэмплинг вернул не ту точку: ' + JSON.stringify(r.point));
  assert.strictEqual(H.pickPointAt(v, 10, 10, { cpuOnly: true }).ok, false, 'вне радиуса — нет точки');
  assert.strictEqual(H.pickByProjection(v, 600, 350, 20).length, 3);
});

// ===================== jsdom: панель в статус-баре =====================
function makeEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body>' +
    '<footer id="lxStatus" class="lx-status">' +
    '<div class="st-mode" id="lxMode"><span id="lxModeText">Обзор</span></div>' +
    '<div class="st-coord"><span class="lx-axis">X</span><span class="lx-val" id="lxX">—</span></div>' +
    '<span class="lx-spacer"></span><span class="st-info" id="lxCloudInfo"></span><span class="st-info" id="lxInfo">СК: локальная</span>' +
    '<div class="st-save" id="lxSaveState"><span id="lxSaveText">Готово</span></div>' +
    '<button id="vtLog" class="st-btn" type="button">Консоль</button></footer>' +
    '</body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const log = { gpu: 0, cpu: 0, toasts: [] };
  w.__toast = (m) => log.toasts.push(String(m));
  const rect = { left: 100, top: 100, right: 900, bottom: 700, width: 800, height: 600 };
  const canvasEl = w.document.createElement('canvas');
  canvasEl.getBoundingClientRect = () => rect;
  w.document.body.appendChild(canvasEl);
  const viewer = {
    canvas: canvasEl,
    base: [{ pos: new Float32Array([0, 0, 0]) }],
    cloudVisible: true, _interacting: false, _cloudDisplay: { opacity: 1 },
    _pickGPU(sx, sy, radius) {
      log.gpu++;
      if (log.noHit) return null;
      return { point: [12.3456, 3.2098, -8.1204] };
    },
    _pickPoint(sx, sy) { log.cpu++; return null; }
  };
  if (opts.failPick) log.noHit = true;
  w.__pcTools = { viewer: () => viewer };
  w.__viewer = viewer;
  w.eval(SRC);
  // в jsdom DOMContentLoaded ещё не наступил — монтируемся явно (в приложении boot сам)
  if (w.__lxCoordsHud && !w.document.getElementById('lxCoordsHud')) w.__lxCoordsHud.mount();
  return { w, log, viewer, canvasEl, H: w.__lxCoordsHud, rect };
}
const hEl = (w) => w.document.getElementById('lxCoordsHud');
function move(w, x, y) {
  const c = w.__viewer.canvas;
  c.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
}
const textOf = (w) => String(hEl(w) && hEl(w).textContent || '').replace(/\s+/g, ' ').trim();

test('r130: jsdom — элемент в статус-баре, справа от #lxInfo и перед кнопками', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, H: hud } = makeEnv();
  t.after(() => { try { hud.dispose(); } catch (e) { } });
  const el = hEl(w);
  assert.ok(el, 'нет #lxCoordsHud в статус-баре');
  assert.strictEqual(el.parentNode.id, 'lxStatus');
  // вставлен после #lxInfo (правая группа) и до st-save/кнопки консоли
  const children = Array.from(w.document.getElementById('lxStatus').children);
  assert.ok(children.indexOf(el) > children.indexOf(w.document.getElementById('lxInfo')), 'координаты должны быть справа от СК');
  assert.ok(children.indexOf(el) < children.indexOf(w.document.getElementById('lxSaveState')), 'координаты не должны перекрывать кнопки/статус сохранения');
  assert.strictEqual(el.getAttribute('data-coords-enabled'), '1');
  assert.strictEqual(el.getAttribute('data-coords-ok'), '0');
  assert.match(textOf(w), /X: — Y: — Z: — м/);
});

test('r130: jsdom — hover даёт координаты точки облака', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, log, H: hud } = makeEnv();
  t.after(() => { try { hud.dispose(); } catch (e) { } });
  move(w, 500, 400);
  assert.strictEqual(log.gpu, 1, 'GPU-pick не вызван');
  assert.strictEqual(textOf(w), 'X: 12.346 Y: 3.210 Z: -8.120 м');
  const el = hEl(w);
  assert.strictEqual(el.getAttribute('data-coords-ok'), '1');
  assert.strictEqual(el.getAttribute('data-coords-source'), 'gpu');
  assert.ok(Number(el.getAttribute('data-coords-ms')) >= 0);
  const cur = hud.current();
  assert.strictEqual(cur.ok, true);
  assert.deepStrictEqual(Array.from(cur.point), [12.3456, 3.2098, -8.1204]);
});

test('r130: jsdom — нет точки рядом, уход с вьюера и выход за его пределы → «—»', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, H: hud } = makeEnv({ failPick: true });
  t.after(() => { try { hud.dispose(); } catch (e) { } });
  hud.setThrottle(0);
  move(w, 500, 400);
  assert.strictEqual(hEl(w).getAttribute('data-coords-ok'), '0');
  assert.match(textOf(w), /X: — Y: — Z: — м/);
  // теперь точка есть — координаты появляются
  w.__viewer._pickGPU = () => ({ point: [1, 2, 3] });
  move(w, 500, 400);
  assert.strictEqual(hEl(w).getAttribute('data-coords-ok'), '1');
  // уход курсора с канвы вьюера (pointerout) — прочерк
  w.__viewer.canvas.dispatchEvent(new w.Event('pointerout', { bubbles: false }));
  assert.strictEqual(hEl(w).getAttribute('data-coords-ok'), '0', 'после ухода курсора должен быть прочерк');
  // курсор вне прямоугольника вьюера (например, над статус-баром)
  move(w, 50, 50);
  assert.strictEqual(hEl(w).getAttribute('data-coords-ok'), '0');
});

test('r130: jsdom — троттлинг pointermove', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, log, H: hud } = makeEnv();
  t.after(() => { try { hud.dispose(); } catch (e) { } });
  hud.setThrottle(500);
  move(w, 500, 400);
  move(w, 501, 401);
  move(w, 502, 402);
  assert.strictEqual(log.gpu, 1, 'за троттлинг-окно должен быть ровно один пик, а не ' + log.gpu);
  hud.setThrottle(0);
  move(w, 503, 403);
  assert.strictEqual(log.gpu, 2, 'при throttle=0 пик выполняется сразу');
});

test('r130: jsdom — отключение (localStorage) и клик по координатам', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, log, H: hud } = makeEnv();
  t.after(() => { try { hud.dispose(); } catch (e) { } });
  assert.strictEqual(hud.setEnabled(false), false);
  assert.strictEqual(hEl(w).hidden, true, 'выключенные координаты должны быть скрыты');
  assert.strictEqual(w.localStorage.getItem('lxCoordsHud'), '0');
  const before = log.gpu;
  move(w, 500, 400);
  assert.strictEqual(log.gpu, before, 'при выключении пикинг не выполняется');
  hud.setEnabled(true);
  assert.strictEqual(hEl(w).hidden, false);
  move(w, 500, 400);
  assert.strictEqual(hEl(w).getAttribute('data-coords-ok'), '1');
  // клик по элементу скрывает координаты
  hEl(w).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(hEl(w).hidden, true);
  assert.strictEqual(w.localStorage.getItem('lxCoordsHud'), '0');
  // флаг перечитывается refresh()
  hud.setEnabled(true);
  w.localStorage.setItem('lxCoordsHud', '0');
  const ref = hud.refresh();
  assert.strictEqual(ref.enabled, false);
  assert.strictEqual(ref.units, 'm');
  assert.strictEqual(hEl(w).hidden, true);
});

test('r130: jsdom — единицы мм и немедленный updateAt', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, H: hud } = makeEnv();
  t.after(() => { try { hud.dispose(); } catch (e) { } });
  hud.setUnits('mm');
  assert.strictEqual(w.localStorage.getItem('lxCoordsHudUnits'), 'mm');
  move(w, 500, 400);
  assert.strictEqual(textOf(w), 'X: 12345.6 Y: 3209.8 Z: -8120.4 мм');
  assert.strictEqual(hEl(w).getAttribute('data-coords-units'), 'mm');
  hud.setUnits('m');
  const r = hud.updateAt(500, 400);
  assert.strictEqual(r.ok, true);
  assert.match(textOf(w), /X: 12\.346 Y: 3\.210 Z: -8\.120 м/);
  // updateAt вне вьюера — прочерк
  assert.strictEqual(hud.updateAt(10, 10), null);
  assert.match(textOf(w), /—/);
});

test('r130: jsdom — авто-монтирование и роль status', { skip: !JSDOM && 'jsdom не установлен' }, async (t) => {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body>' +
    '<footer id="lxStatus" class="lx-status"><span class="st-info" id="lxInfo">СК: локальная</span>' +
    '<div class="st-save" id="lxSaveState"></div></footer></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.__pcTools = { viewer: () => null };
  w.eval(SRC);
  t.after(() => { try { w.__lxCoordsHud.dispose(); } catch (e) { } });
  // boot() ждёт DOMContentLoaded в jsdom — даём событию произойти
  await new Promise((r) => setTimeout(r, 40));
  const el = w.document.getElementById('lxCoordsHud');
  assert.ok(el, 'модуль должен смонтироваться сам после DOMContentLoaded');
  assert.strictEqual(el.getAttribute('role'), 'status');
  assert.strictEqual(el.getAttribute('data-coords-hud'), '1');
  assert.ok(w.__lxCoordsHud._state().mounted, 'модуль должен быть смонтирован');
  assert.strictEqual(w.__lxCoordsHud.getThrottle(), H.DEFAULT_THROTTLE_MS);
  assert.ok(H.DEFAULT_THROTTLE_MS >= 60 && H.DEFAULT_THROTTLE_MS <= 100, 'троттлинг должен быть 60–100 мс');
});
