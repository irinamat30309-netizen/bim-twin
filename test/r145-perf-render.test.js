'use strict';
/*
 * r145 — производительность и «как в Lixel» для больших облаков:
 *   • viewer: адаптивный размер точки 3–4 px (perspective), quality-режимы auto/high/fast,
 *     динамическое разрешение при вращении, CPU-копии потока только для облаков ≤160 млн,
 *     пресет «Как в Lixel» (яркость ×1.36, насыщенность ×1.29, без размытия);
 *   • app: бюджет GPU 520 млн (сброс старых 300–400 млн), «показать все» до 600 млн,
 *     рендер-настройки по умолчанию и динамическая загрузка панели «Производительность»;
 *   • панель ui/perf-panel.js (jsdom): FPS/точки/память/VRAM/бюджет, качество авто/высокое/быстрое,
 *     яркость/контраст/насыщенность, «Как в Lixel», скрытие/показ, hotkey F2.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../renderer/webgl-viewer.js');
const { Viewer3DGL } = V;
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const SRC = fs.readFileSync(path.join(R, 'webgl-viewer.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const PANEL_SRC = fs.readFileSync(path.join(R, 'ui', 'perf-panel.js'), 'utf8');

function viewerStub() {
  const v = Object.create(Viewer3DGL.prototype);
  v.render = function () { };
  v._notifyCloudChanged = function () { };
  v._resize = function () { };
  v.base = [{ points: true, count: 1000, _gpuCount: 1000, pointSize: 2.2 }];
  v._cloudDisplay = { pointSize: 1, opacity: 1, min: 0, max: 1, palette: 0, hideOutside: false };
  v._grade = { on: false, exposure: 1.0, contrast: 1.05, saturation: 1.05, gamma: 1.0, tone: 0.9 };
  v._ptBright = 1.1;
  v._renderScale = 1; v._dynRes = true; v._dynScaleMoving = 0.85; v._qualityMode = 'auto';
  v._interBudget = 128000000; v._autoPointSize = true; v._softSplats = true; v._ptSizeMul = 1;
  return v;
}

// ---------- исходник: ключи реализации (source-level, стабильно для node --test) ----------
test('r145: viewer — адаптивный размер точки, качество и динамическое разрешение на месте', () => {
  for (const k of ['_autoPointSize', 'setAutoPointSize', 'setPointBasePx', 'autoPointSizeOn',
    'setQualityMode', 'qualityMode', 'setRenderScale', 'getRenderScale', 'setLixelLook',
    '_dynScaleMoving', '_streamCpuMaxPoints', '_applyDynRes']) {
    assert.ok(SRC.includes(k), 'нет ' + k);
  }
  assert.match(SRC, /_resize\(\)[\s\S]{0,200}\(this\._renderScale \|\| 1\)/, 'динамическое разрешение не применяется в _resize');
  assert.match(SRC, /const autoPx = isCloud && this\._autoPointSize/, 'авто-размер не учитывается в отрисовке');
  assert.match(SRC, /hCss \/ 1200 \* \(this\._autoPointBasePx \|\| 2\.3\)/, 'база 3–5 px (perspective) не задана');
  assert.match(SRC, /total <= \(this\._streamCpuMaxPoints \|\| 160000000\)/, 'CPU-копии потока не ограничены 160 млн');
  assert.match(SRC, /setLixelLook\(on\)[\s\S]{0,240}setBrightness\(1\.36\)[\s\S]{0,240}saturation: 1\.29/, 'пресет «как в Lixel» не задан (1.36/1.29)');
  assert.match(SRC, /_grade\s*=\s*\{\s*on:\s*false/, 'нейтральный grade по умолчанию должен сохраниться (r145 включает его из настроек)');
});

test('r145: app — эффективный VRAM-бюджет (96 млн ≈ 1,4 ГБ), «показать все» до 600 млн, панель и пресеты', () => {
  assert.match(APP, /GPU_POINT_BUDGET = 300000000/);
  assert.match(APP, /GPU_VRAM_TARGET_MB = 5120/);
  assert.ok(APP.includes('600000000'), 'нет повышенного предела «показать все точки»');
  assert.match(APP, /bim\.gpuBudgetRev/, 'нет миграции старых пределов GPU (иначе 589 млн останется прореженным)');
  assert.ok(!APP.includes('— предел видеокарты'), 'старый тост «предел видеокарты» должен быть заменён на эффективный бюджет');
  assert.match(APP, /Эффективный бюджет по VRAM/, 'нет сообщения об эффективном бюджете');
  assert.match(APP, /function applyRenderPrefs\(\)/);
  assert.match(APP, /function ensurePerfPanel\(\)/);
  assert.match(APP, /perf-panel\.js\?v=145/);
  assert.match(APP, /bim\.perf\.look/);
  assert.match(APP, /viewer\.setAutoPointSize\(p\.autoPoint\)/);
  assert.match(APP, /viewer\.setLixelLook\(true\)/, 'по умолчанию должен применяться пресет Lixel');
});

// ---------- поведение методов viewer ----------
test('r145: setAutoPointSize включает perspective-режим и снимает fixedPx', () => {
  const v = viewerStub();
  assert.strictEqual(v.setAutoPointSize(false), false);
  assert.strictEqual(v._autoPointSize, false);
  assert.strictEqual(v.setAutoPointSize(true), true);
  assert.strictEqual(v._autoPointSize, true);
  assert.strictEqual(v._cloudDisplay.pointSize, null, 'в авто-режиме фиксированный px не задаёт размер');
  assert.strictEqual(v.autoPointSizeOn(), true);
  // слайдер размера в авто-режиме — множитель, а не фикс
  v.setPointSizeScale(1.5);
  assert.strictEqual(v._ptSizeMul, 1.5);
  assert.strictEqual(v._autoPointSize, true);
  // ручной размер отключает авто
  v.setCloudPointSize(4);
  assert.strictEqual(v._autoPointSize, false);
  assert.strictEqual(v._cloudDisplay.pointSize, 4);
});

test('r145: quality-режимы auto/high/fast задают бюджеты и динамическое разрешение', () => {
  const v = viewerStub();
  assert.strictEqual(v.setQualityMode('fast'), 'fast');
  assert.strictEqual(v._interBudget, 96000000);
  assert.strictEqual(v._dynScaleMoving, 0.85);
  assert.strictEqual(v._dynRes, true);
  assert.strictEqual(v.setQualityMode('high'), 'high');
  assert.strictEqual(v._dynRes, false, 'в «высоком» разрешение не режется');
  assert.ok(v._interBudget >= 1000000000);
  assert.strictEqual(v.setQualityMode('auto'), 'auto');
  assert.strictEqual(v._dynScaleMoving, 0.85, 'разрешение в движении не ниже 85 %');
  assert.strictEqual(v._octMovePct, 60, 'авто-режим рисует при движении 60 % точек');
  assert.strictEqual(v._motionSizeScale, 0.9, 'в движении точки почти не мельчают');
  assert.strictEqual(v.setQualityMode('нет-такого'), 'auto', 'неизвестный режим — авто');
  assert.strictEqual(v.qualityMode(), 'auto');
});

test('r145: setRenderScale и _applyDynRes меняют масштаб, в покое возвращают 1', () => {
  const v = viewerStub();
  assert.strictEqual(v.setRenderScale(0.9), 0.9);
  assert.strictEqual(v.getRenderScale(), 0.9);
  assert.strictEqual(v.setRenderScale(0.1), 0.85, 'нижний предел 0.85');
  assert.strictEqual(v.setRenderScale(5), 1, 'верхний предел 1');
  v._renderScale = 0.7; v._dynRes = true;
  v._applyDynRes(false);
  assert.strictEqual(v._renderScale, 1, 'в покое 1:1 (резкая картинка)');
  v._applyDynRes(true);
  assert.strictEqual(v._renderScale, 0.85, 'при вращении — динамическое разрешение 85 %');
});

test('r145: «Как в Lixel» — яркость ×1.36 и насыщенность ×1.29, grade включается', () => {
  const v = viewerStub();
  v.setBrightness = function (x) { this._ptBright = x; return x; };
  v.setGrade = function (g) {
    if (g === false) this._grade = { on: false };
    else if (g === true) this._grade = Object.assign({}, this._grade, { on: true });
    else this._grade = Object.assign({}, this._grade, g);
    return this._grade;
  };
  assert.strictEqual(v.setLixelLook(true), true);
  assert.strictEqual(v._ptBright, 1.36);
  assert.strictEqual(v._grade.on, true);
  assert.strictEqual(v._grade.saturation, 1.29);
  assert.strictEqual(v._grade.tone, 0);
  assert.strictEqual(v.setLixelLook(false), false);
  assert.strictEqual(v._ptBright, 1);
  assert.strictEqual(v._grade.on, false);
});

// ---------- панель «Производительность» (jsdom) ----------
function makePanelEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = function () { return null; };
  const calls = [];
  const viewer = {
    _autoPointSize: false, _interPts: 4000000, _interBudget: 128000000, _renderScale: 1, _qualityMode: 'auto', _ptBright: 1,
    _grade: { on: false }, _cloudDisplay: { pointSize: null, opacity: 1 },
    base: [{ _gpuCount: 120000000, count: 120000000, _stream: { total: 271540842 } }],
    setQualityMode(m) { calls.push(['quality', m]); this._qualityMode = m; return m; },
    setAutoPointSize(on) { calls.push(['autoPoint', on]); this._autoPointSize = on; return on; },
    setPointBasePx(px) { calls.push(['basePx', px]); return px; },
    setBrightness(v) { calls.push(['bright', v]); this._ptBright = v; return v; },
    setGrade(g) { calls.push(['grade', g]); if (g && typeof g === 'object') this._grade = Object.assign({}, this._grade, g, { on: true }); else this._grade = { on: !!g }; return this._grade; },
    setLixelLook(on) { calls.push(['lixel', on]); if (on === true) { this.setBrightness(1.36); this.setGrade({ on: true, exposure: 1, contrast: 1, saturation: 1.29, gamma: 1, tone: 0 }); } return true; },
    qualityMode() { return this._qualityMode; },
    getRenderScale() { return this._renderScale; },
    getCullStats() { return { drawn: 1000000, visible: 2000000, total: 271540842 }; },
    render() { }
  };
  w.__viewer = viewer;
  w.performance.memory = { usedJSHeapSize: 123 * 1048576, jsHeapSizeLimit: 4096 * 1048576 };
  w.eval(PANEL_SRC);
  return { w, dom, viewer, calls, api: w.__lxPerf };
}

test('r145: панель (jsdom) — открывается, показывает FPS/точки/память/бюджет', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makePanelEnv();
  try {
    assert.ok(env.api, 'нет window.__lxPerf');
    env.api.attach(); env.api.open();
    assert.ok(env.w.document.querySelector('[data-perf-pill]'), 'нет кнопки «FPS»');
    await new Promise((r) => setTimeout(r, 650));
    const p = env.w.document.querySelector('[data-perf-panel]');
    assert.ok(p && !p.hidden, 'панель не открылась');
    assert.ok(p.querySelector('[data-perf-fps]'), 'нет FPS');
    assert.ok(p.querySelector('[data-perf-points]'), 'нет точек');
    assert.ok(p.querySelector('[data-perf-budget]'), 'нет бюджета');
    assert.ok(p.querySelector('[data-perf-mem]'), 'нет памяти');
    assert.ok(p.querySelector('[data-perf-total]'), 'нет всего в облаке');
    assert.ok(p.querySelector('[data-perf-gpu]'), 'нет GPU');
    assert.ok(p.querySelector('[data-perf-scale]'), 'нет разрешения рендера');
    assert.match(p.querySelector('[data-perf-total]').textContent, /271,5|271\.5/);
    const st = env.api.state();
    assert.strictEqual(st.total, 271540842);
    assert.strictEqual(st.quality, 'auto');
    assert.strictEqual(st.autoPoint, true);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r145: панель (jsdom) — качество «быстрое», «Как в Lixel» и яркость/насыщенность', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makePanelEnv();
  try {
    env.api.attach(); env.api.open();
    await new Promise((r) => setTimeout(r, 50));
    const p = env.w.document.querySelector('[data-perf-panel]');
    const q = p.querySelector('[data-perf-quality]');
    q.value = 'fast'; q.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'quality' && c[1] === 'fast'), 'качество не применилось к viewer');
    const lx = p.querySelector('[data-perf="lixel"]');
    lx.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'lixel' && c[1] === true), 'пресет Lixel не применён');
    assert.ok(env.calls.some((c) => c[0] === 'bright' && Math.abs(c[1] - 1.36) < 1e-9), 'яркость 1.36 не применена');
    assert.ok(env.viewer._grade.on === true && Math.abs(env.viewer._grade.saturation - 1.29) < 1e-9, 'насыщенность 1.29 не применена');
    // слайдеры яркости/насыщенности
    const b = p.querySelector('[data-perf-bright]');
    b.value = '1.2'; b.dispatchEvent(new env.w.Event('input', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'bright' && Math.abs(c[1] - 1.2) < 1e-9), 'слайдер яркости не применён');
    assert.ok(env.w.localStorage.getItem('bim.perf.look') === 'custom', 'кастомный пресет не сохраняется');
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r145: панель (jsdom) — сворачивание/раскрытие и hotkey F2', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makePanelEnv();
  try {
    env.api.attach();
    assert.strictEqual(env.api.isOpen(), false);
    env.w.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    assert.strictEqual(env.api.isOpen(), true, 'F2 не открывает панель');
    env.api.close();
    assert.strictEqual(env.api.isOpen(), false);
    assert.strictEqual(env.w.document.querySelector('[data-perf-panel]').hidden, true);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});







