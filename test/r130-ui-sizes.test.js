'use strict';
/*
 * r130 — UI: крупнее кнопки/подписи ленты, тёмный 3D-фон в светлой теме,
 * привязка (snap) по умолчанию выключена, адаптивность 1920×1080…4K.
 *
 * Проверяем:
 *   1) размеры ленты: иконка 28px, подпись 11.5px/1.2, max-width 112px, padding 6px,
 *      min-width 52px, подпись группы 11px; --h-ribbon увеличен (tokens.css);
 *   2) светлая тема: интерфейс светлый, 3D-область — тёмная (токен --viewer-bg #0E1013,
 *      chrome.js принудительно включает вьюеру тёмную тему и фон #0E1013 как у Lixel);
 *   3) привязка (snap) при старте выключена и не включается при открытии проекта/облака
 *      (modes.js → viewer.setMeasureSnap(false), кнопка #mmSnap не активна);
 *   4) адаптивность: media-запросы ≥2560 и ≥3200 px масштабируют иконки/подписи/ленту,
 *      размеры через CSS-переменные/clamp(), лента горизонтально скроллится.
 * Часть проверок — source-level по CSS/JS, часть — исполнение модулей в vm (chrome.js,
 * modes.js) на минимальной имитации DOM.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const TOKENS = read('ui/tokens.css');
const SHELL = read('ui/shell.css');
const RIBBON = read('ui/ribbon.js');
const CHROME = read('ui/chrome.js');
const MODES = read('ui/modes.js');

// ---------- минимальные имитации DOM для vm-исполнения модулей ----------
function classList() {
  const s = new Set();
  return {
    add: function () { for (let i = 0; i < arguments.length; i++) s.add(arguments[i]); },
    remove: function () { for (let i = 0; i < arguments.length; i++) s.delete(arguments[i]); },
    contains: (c) => s.has(c),
    toggle: function (c, f) { if (f === undefined ? !s.has(c) : f) s.add(c); else s.delete(c); return s.has(c); }
  };
}
function makeAttrNode(attrs) {
  return {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; }
  };
}

// chrome.js: готовим документ с data-theme, но НЕ запускаем init (readyState=loading) —
// затем вручную вызываем экспортированные initViewerTheme/ paintViewerTheme.
function makeChromeEnv(theme) {
  const attrs = { 'data-theme': theme || 'light' };
  const root = Object.assign(makeAttrNode(attrs), { classList: classList() });
  const listeners = {};
  const doc = {
    readyState: 'loading',
    documentElement: root,
    body: { classList: classList(), remove: function () {} },
    addEventListener: function () {},
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () {
      return { style: {}, classList: classList(), setAttribute: function () {}, appendChild: function () {}, addEventListener: function () {}, remove: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
    }
  };
  const W = {
    document: doc, console, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp,
    innerWidth: 1920, setTimeout: function () { return 0; }, clearTimeout: function () {},
    requestAnimationFrame: function (f) { return 0; },
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    localStorage: { getItem: function () { return null; }, setItem: function () {} }
  };
  W.window = W;
  vm.createContext(W);
  vm.runInContext(CHROME, W, { filename: 'ui/chrome.js' });
  const fake = {
    theme: 'light',
    setTheme: function (t) { this.theme = t === 'light' ? 'light' : 'dark'; return this.theme; },
    _themeColors: function () {
      return this.theme === 'light'
        ? { bg: [0.933, 0.945, 0.961], grid: [0.78, 0.82, 0.88], wire: [0.58, 0.64, 0.74] }
        : { bg: [0.055, 0.063, 0.075], grid: [0.21, 0.24, 0.29], wire: [0.42, 0.47, 0.55] };
    }
  };
  W.__viewer = fake;
  return {
    W, attrs, root, fake, listeners,
    setTheme: function (t) { attrs['data-theme'] = t; },
    fire: function (type) { (listeners[type] || []).forEach(function (fn) { fn(); }); }
  };
}

// modes.js: минимальный DOM + вьюер с measureSnap=true (как в webgl-viewer.js) и кнопка #mmSnap.
function makeModesEnv() {
  const listeners = {};
  const mmAttrs = {};
  const mm = Object.assign(makeAttrNode(mmAttrs), { id: 'mmSnap', classList: classList() });
  const doc = {
    readyState: 'complete',
    documentElement: { classList: classList() },
    body: {},
    getElementById: function (id) { return id === 'mmSnap' ? mm : null; },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };
  const viewer = {
    measureSnap: true,
    setMeasureSnap: function (on) { this.measureSnap = !!on; return this.measureSnap; }
  };
  const W = {
    document: doc, console, performance, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: function () { return true; },
    __viewer: viewer
  };
  W.window = W;
  vm.createContext(W);
  vm.runInContext(MODES, W, { filename: 'ui/modes.js' });
  return {
    W, viewer, mm, mmAttrs,
    fire: function (type) { (listeners[type] || []).forEach(function (fn) { fn(); }); }
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ===================== 1. Размеры ленты =====================
test('r130: токены ленты — крупнее иконки/подписи/кнопки, увеличенная --h-ribbon', () => {
  assert.match(TOKENS, /--h-ribbon:\s*112px/, '--h-ribbon должен быть увеличен до 112px');
  assert.ok(Number(/--h-ribbon:\s*(\d+)px/.exec(TOKENS)[1]) > 96, '--h-ribbon стал больше прежних 96px');
  assert.match(TOKENS, /--rb-ico:\s*28px/, 'иконка большой кнопки 28px');
  assert.match(TOKENS, /--rb-lbl:\s*11px/, 'подпись 11.5px');
  assert.match(TOKENS, /--rb-lbl-max:\s*112px/, 'ширина подписи до 112px');
  assert.match(TOKENS, /--rb-pad:\s*6px/, 'padding кнопки 6px');
  assert.match(TOKENS, /--rb-min:\s*52px/, 'min-width кнопки 52px');
  assert.match(TOKENS, /--rb-glabel:\s*11px/, 'подпись группы 11px');
  // палитра проекта не менялась: фиолетовый акцент обеих тем
  assert.match(TOKENS, /--accent:\s*#a78bfa/, 'тёмная тема: violet #b9a2ff');
  assert.match(TOKENS, /--accent:\s*#6d56d1/, 'светлая тема: violet #6a52cb');
});

test('r130: shell.css использует токены размеров для .lx-lg / подписи / группы', () => {
  assert.match(SHELL, /\.lx-lg\s*\{[^}]*min-width:\s*var\(--rb-min\)/s, 'min-width большой кнопки — из токена');
  assert.match(SHELL, /\.lx-lg\s*\{[^}]*max-width:\s*calc\(var\(--rb-lbl-max\)/s, 'max-width кнопки — из токена подписи');
  assert.match(SHELL, /\.lx-lg\s*\{[^}]*padding:\s*var\(--rb-pad\)/s, 'padding большой кнопки — из токена');
  assert.match(SHELL, /\.lx-lg\s+\.lx-ico\s*\{[^}]*width:\s*var\(--rb-ico\)/s, 'иконка 28px — из токена');
  assert.match(SHELL, /\.lx-lg\s+\.lbl\s*\{[^}]*max-width:\s*var\(--rb-lbl-max\)/s, 'ширина подписи 112px');
  assert.match(SHELL, /\.lx-lg\s+\.lbl\s*\{[^}]*font:\s*500\s+var\(--rb-lbl\)\/1\.2/s, 'подпись 11.5px/1.2');
  assert.match(SHELL, /\.lx-glabel\s*\{[^}]*var\(--rb-glabel\)/s, 'подпись группы — из токена');
  // старые «мелкие» значения не остались активными
  assert.ok(!/\.lx-lg\s*\{[^}]*padding:\s*4px\s+5px/s.test(SHELL), 'старый padding 4px 5px заменён');
  assert.ok(!/\.lx-lg\s+\.lx-ico\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/s.test(SHELL), 'старая иконка 24px заменена');
});

test('r130: ribbon.js создаёт иконки больших кнопок 28px', () => {
  assert.match(RIBBON, /icon\(item\.ico,\s*size === 'lg' \? 28 : 16\)/, 'иконка lg должна быть 28px');
  assert.ok(!/size === 'lg' \? 24 : 16/.test(RIBBON), 'старый размер 24px остался');
});

// ===================== 2. Светлая тема: тёмный 3D =====================
test('r130: светлая тема — тёмный фон 3D-области (CSS-токен и контейнер вьюера)', () => {
  assert.match(TOKENS, /--viewer-bg:\s*#0e1013/i, 'токен тёмного фона 3D — как у Lixel #0E1013');
  assert.match(SHELL, /\.stage\s*\{[^}]*background:\s*var\(--viewer-bg/s, 'контейнер вьюера использует тёмный --viewer-bg');
  assert.ok(!/\.stage\s*\{[^}]*background:\s*var\(--viewport-a\)/s.test(SHELL), 'сцена не должна крашиться в светлый --viewport-a');
});

test('r130: chrome.js принудительно включает вьюеру тёмную тему при светлой теме UI', () => {
  assert.match(CHROME, /function paintViewerTheme\(\)/, 'нет синхронизации темы вьюера');
  assert.match(CHROME, /function initViewerTheme\(\)/, 'нет инициализации темы вьюера');
  assert.match(CHROME, /var VIEWER_BG = \[14 \/ 255, 16 \/ 255, 19 \/ 255\]/, 'фон сцены — #0E1013 как у Lixel');
  assert.match(CHROME, /uiLight \? 'dark' : theme/, 'в светлой теме UI вьюер принудительно тёмный');
  assert.match(CHROME, /lx-viewer-ready/, 'тема вьюера ставится после создания вьюера');
  assert.match(CHROME, /lx-pctools-ready/, 'тема вьюера ставится после готовности pcTools');
  assert.match(CHROME, /MutationObserver\(function \(\) \{ paintTheme\(\); paintViewerTheme\(\); \}\)/, 'смена темы UI синхронизирует вьюер');
  assert.match(CHROME, /paintViewerTheme: paintViewerTheme/, 'paintViewerTheme доступен для проверки/повторного применения');
});

test('r130/r202: chrome.js (vm) — светлая тема UI не делает сцену светлой, фон — #0E1013', () => {
  const env = makeChromeEnv('light');
  env.W.__lxChrome.initViewerTheme();
  assert.strictEqual(env.fake.theme, 'dark', 'вьюер должен быть тёмным в светлой теме UI');
  const bg = env.fake._themeColors().bg;
  assert.ok(Math.abs(bg[0] - 14 / 255) < 1e-9 && Math.abs(bg[1] - 16 / 255) < 1e-9 && Math.abs(bg[2] - 19 / 255) < 1e-9,
    'фон сцены должен быть #0E1013, а не ' + JSON.stringify(bg));
  assert.strictEqual(env.attrs['data-theme'], 'light', 'интерфейс остаётся светлым');
});

test('r130: chrome.js (vm) — смена темы UI и lx-viewer-ready удерживают тёмный вьюер', async () => {
  const env = makeChromeEnv('light');
  env.W.__lxChrome.initViewerTheme();
  // кто-то (app.js) попытался сделать сцену светлой в светлой теме UI
  env.fake.setTheme('light');
  assert.strictEqual(env.fake.theme, 'dark', 'светлая сцена в светлой теме UI запрещена');
  // смена темы на тёмную: явный светлый вьюпорт (презентация) не ломаем — тёмный UI это не трогает
  env.setTheme('dark');
  env.fake.setTheme('light');
  assert.strictEqual(env.fake.theme, 'light', 'в тёмной теме UI явный светлый вьюпорт сохраняется');
  // возврат в светлую тему + событие готовности вьюера
  env.setTheme('light');
  env.fake.theme = 'light';
  env.fire('lx-viewer-ready');
  await tick();
  assert.strictEqual(env.fake.theme, 'dark', 'после lx-viewer-ready вьюер снова тёмный в светлой теме');
});

// ===================== 3. Привязка по умолчанию off =====================
test('r130: modes.js — привязка выключена по умолчанию и на событиях, кнопка не активна', () => {
  assert.match(MODES, /function snapOff\(\)/, 'нет функции выключения привязки');
  assert.match(MODES, /setMeasureSnap\(false\)/, 'привязка не выключается у вьюера');
  assert.match(MODES, /classList\.remove\('on'\)/, 'кнопка #mmSnap не снимает активный класс');
  assert.match(MODES, /setAttribute\('aria-pressed', 'false'\)/, 'кнопка #mmSnap не помечается неактивной');
  assert.match(MODES, /initSnapDefault\(\);/, 'initSnapDefault не вызывается при старте');
  assert.match(MODES, /'bim-cloud-loaded'/, 'при открытии облака привязка не сбрасывается');
  assert.match(MODES, /snapOff: snapOff/, 'snapOff не доступен из __lxModes');
  // старый дефолт "включено" не возвращён в наш код (комментарии не считаем)
  assert.ok(!/\.measureSnap\s*=\s*true/.test(MODES), 'modes.js не должен включать привязку');
});

test('r130: modes.js (vm) — после загрузки measureSnap=false, кнопка #mmSnap не активна', async () => {
  const env = makeModesEnv();
  await tick();
  assert.strictEqual(env.viewer.measureSnap, false, 'вьюер должен стартовать с выключенной привязкой');
  assert.strictEqual(env.mm.classList.contains('on'), false, 'кнопка #mmSnap не должна быть активна');
  assert.strictEqual(env.mm.getAttribute('aria-pressed'), 'false', 'aria-pressed=false у кнопки привязки');
  // при открытии облака привязка не включается сама (даже если кто-то её включил)
  env.viewer.setMeasureSnap(true);
  env.mm.classList.add('on');
  env.fire('bim-cloud-loaded');
  await tick();
  assert.strictEqual(env.viewer.measureSnap, false, 'bim-cloud-loaded: привязка снова выключена');
  assert.strictEqual(env.mm.classList.contains('on'), false);
  // явный вызов позволяет выключить ещё раз
  env.viewer.setMeasureSnap(true);
  assert.strictEqual(env.W.__lxModes.snapOff(), true);
  assert.strictEqual(env.viewer.measureSnap, false);
});

// ===================== 4. Адаптивность 1920…4K =====================
test('r130: media-запросы ≥2560px и ≥3200px масштабируют ленту/иконки/подписи', () => {
  assert.match(SHELL, /@media \(min-width: 2560px\)/, 'нет media ≥2560px');
  assert.match(SHELL, /@media \(min-width: 3200px\)/, 'нет media ≥3200px (4K)');
  assert.match(SHELL, /@media \(min-width: 2560px\)[\s\S]*?--rb-ico:\s*30px/, '≥2560: иконка +2px (30px)');
  assert.match(SHELL, /@media \(min-width: 2560px\)[\s\S]*?--rb-lbl:\s*13px/, '≥2560: подпись +1.5px');
  assert.match(SHELL, /@media \(min-width: 2560px\)[\s\S]*?--h-ribbon:\s*120px/, '≥2560: лента выше');
  assert.match(SHELL, /@media \(min-width: 3200px\)[\s\S]*?--rb-ico:\s*32px/, '≥3200: иконка 32px');
  assert.match(SHELL, /@media \(min-width: 3200px\)[\s\S]*?--rb-lbl:\s*14px/, '≥3200: подпись 14px');
  // размеры через переменные/clamp()
  assert.match(SHELL, /clamp\(/, 'нет clamp() в размерах ленты');
  assert.match(SHELL, /var\(--rb-/, 'размеры ленты не выведены в переменные');
  // лента скроллится, панели не разъезжаются: группы не сжимаются, панель со скроллом
  assert.match(SHELL, /\.lx-panel\s*\{[^}]*overflow-x:\s*auto/s, 'лента должна горизонтально скроллиться');
  assert.match(SHELL, /\.lx-group\s*\{[^}]*flex:\s*none/s, 'группы ленты не должны сжиматься');
  assert.match(SHELL, /\.app\s*\{[^}]*grid-template-columns:\s*var\(--w-side\) minmax\(0, 1fr\) var\(--w-insp\)/s, 'сетка рабочей области не разъезжается');
});

test('r130: старые media для узких экранов сохранены, светлая/тёмная темы не меняют палитру', () => {
  assert.match(SHELL, /@media \(max-width: 1280px\)/, 'адаптивность ≤1280px сохранена');
  assert.match(SHELL, /@media \(max-width: 1100px\)/, 'адаптивность ≤1100px сохранена');
  // тёмная тема по умолчанию, светлая — через data-theme; 3D всё равно тёмный
  assert.match(TOKENS, /html\[data-theme="light"\]/, 'светлая тема описана');
  assert.match(TOKENS, /--viewer-bg:\s*#0e1013/i, 'тёмный фон 3D (#0E1013) не зависит от темы UI');
});
