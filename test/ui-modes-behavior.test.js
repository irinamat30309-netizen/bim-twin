'use strict';
/* Поведение моста режимов (renderer/ui/modes.js) на минимальной имитации DOM:
 *  • инструмент, завершившийся сам (выбор рамкой закончен, панель закрыта), не «залипает» — следующий клик запускает его заново;
 *  • включённый инструмент выключается повторным кликом и по Esc;
 *  • кнопки «Выйти» в панелях измерения, правки и станций подключены. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ToolManager } = require('../renderer/tool-manager.js');

const R = path.join(__dirname, '..', 'renderer');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

function makeEnv() {
  const handlers = { click: [], keydown: [] }, buttons = [];
  const classList = () => {
    const s = new Set();
    return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c), toggle(c, f) { if (f === undefined ? !s.has(c) : f) s.add(c); else s.delete(c); } };
  };
  const button = (cmd) => {
    const attrs = { 'data-cmd': cmd, 'data-mode-tool': '1' };
    const b = { id: cmd, classList: classList(), getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); }, closest: (sel) => (/data-mode-tool/.test(sel) ? b : null) };
    buttons.push(b); return b;
  };
  const doc = {
    readyState: 'complete', documentElement: { classList: classList() }, body: {},
    getElementById: () => null, addEventListener() {},
    querySelectorAll(sel) {
      const m = /\[data-cmd="([^"]+)"\]/.exec(sel);
      if (m) return buttons.filter((b) => b.getAttribute('data-cmd') === m[1]);
      return /\[data-mode-tool\]/.test(sel) ? buttons.slice() : [];
    }
  };
  const W = {
    document: doc, console, performance, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }, dispatchEvent() { return true; }
  };
  W.window = W;
  W.__lxToolManager = new ToolManager({ eventTarget: W });
  vm.createContext(W);
  vm.runInContext(read('ui/modes.js'), W, { filename: 'ui/modes.js' });
  const fire = (type, ev) => { for (const h of handlers[type]) h(ev); return ev; };
  const click = (b) => fire('click', { target: b, stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const esc = () => fire('keydown', { key: 'Escape', target: { tagName: 'BODY' }, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} });
  return { W, button, click, esc, manager: W.__lxToolManager };
}
/* Инспектор объектов в миниатюре: startPick() включает выбор рамкой, stopPick() — выключает и сообщает мосту режимов. */
function fakeInspector(env, btn) {
  const oi = {
    state: { pick: false }, stops: 0, closes: 0,
    startPick() { oi.state.pick = true; btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true'); },
    stopPick() { oi.stops++; oi.state.pick = false; btn.classList.remove('on', 'lx-mode-active'); btn.setAttribute('aria-pressed', 'false'); env.W.__lxModes.release('lxObjInspectBtn'); },
    close() { oi.closes++; }
  };
  env.W.__lxObjectInspector = oi;
  return oi;
}

test('режимы: инструмент, завершившийся сам, запускается следующим кликом, а не «выключается»', async () => {
  const env = makeEnv(), btn = env.button('lxObjInspectBtn'), oi = fakeInspector(env, btn);
  let e = env.click(btn); assert.equal(e.stopped, false, 'первый клик запускает инструмент');
  oi.startPick(); await tick();
  assert.equal(env.manager.activeId, 'tool:lxObjInspectBtn');
  oi.stopPick();                       // рамка обведена, окно открыто — инструмент завершился сам
  assert.equal(env.manager.activeId, null, 'менеджер отпущен');
  assert.equal(btn.classList.contains('on'), false);
  e = env.click(btn);
  assert.equal(e.stopped, false, 'второй клик — новый запуск');
  oi.startPick(); await tick();
  assert.equal(env.manager.activeId, 'tool:lxObjInspectBtn', 'инструмент снова активен');
});

test('режимы: «залипшее» состояние без release() тоже распознаётся по признаку alive', async () => {
  const env = makeEnv(), btn = env.button('lxObjInspectBtn'), oi = fakeInspector(env, btn);
  env.click(btn); oi.startPick(); await tick();
  oi.state.pick = false;               // инструмент замолчал, а менеджер и кнопка ещё «включены»
  btn.classList.add('on');
  const e = env.click(btn);
  assert.equal(e.stopped, false, 'клик не считается выключением');
  assert.equal(env.manager.activeId, null);
});

test('режимы: включённый инструмент выключается повторным кликом и по Esc', async () => {
  const env = makeEnv(), btn = env.button('lxObjInspectBtn'), oi = fakeInspector(env, btn);
  env.click(btn); oi.startPick(); await tick();
  let e = env.click(btn);
  assert.equal(e.stopped, true, 'повторный клик по включённой кнопке — выключение');
  assert.equal(oi.state.pick, false, 'выбор рамкой остановлен');
  assert.equal(env.manager.activeId, null);
  env.click(btn); oi.startPick(); await tick();
  e = env.esc();
  assert.equal(oi.state.pick, false, 'Esc останавливает выбор рамкой');
  assert.equal(btn.classList.contains('on'), false);
  assert.equal(env.manager.activeId, null);
});

test('режимы: панель среза объекта отпускает кнопку при закрытии', () => {
  const src = read('lixel-object-extract.js');
  assert.match(src, /__lxModes\.release\('lxObjExtractBtn'\)/);
  assert.match(read('lixel-object-inspector.js'), /__lxModes\.release\('lxObjInspectBtn'\)/);
  assert.match(read('ui/modes.js'), /release: release/, 'release входит в публичный API __lxModes');
});

test('панели инструментов: кнопки «Выйти» есть в разметке и подключены', () => {
  const html = read('index.html'), app = read('app.js');
  for (const id of ['mmExit', 'edExit', 'tsExit']) {
    assert.match(html, new RegExp('<button id="' + id + '"[^>]*hbtn-quiet'), id + ': кнопка в разметке');
  }
  assert.match(app, /\['mmExit', 'edExit', 'tsExit'\]\.forEach\(id => bind\(id, exitTool\)\)/);
  assert.match(app, /__lxModes\.cancelAll\('exit'\)/);
});

test('кнопки разметки не бывают «мёртвыми»: у каждой есть ссылка на id в коде', () => {
  const html = read('index.html');
  const js = fs.readdirSync(R).filter((f) => f.endsWith('.js') && f !== 'icons.js').map((f) => read(f))
    .concat(fs.readdirSync(path.join(R, 'ui')).filter((f) => f.endsWith('.js')).map((f) => read('ui/' + f))).join('\n');
  const dead = [];
  for (const m of html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)) {
    const id = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('[\'"`#\\[]' + id + '[\'"`\\]\\s,.)]|\\bid:\\s*[\'"]' + id + '[\'"]').test(js)) dead.push(m[1]);
  }
  assert.deepEqual(dead, [], 'кнопки без обработчика: ' + dead.join(', '));
});
