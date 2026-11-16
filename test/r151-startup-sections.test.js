'use strict';
/*
 * r151 — ленивый/быстрый старт и P2 «Профили/сечения».
 *  1) main: clearCache не блокирует стартовую страницу; первый сегмент 2–5 млн (firstSegPoints);
 *     cloudPartsRead читает маленькую первую часть, дальше обычные; preload передаёт firstSegPoints;
 *     app: pending-облако стартует после viewer, forceParts, ранний прогрессивный первый кадр.
 *  2) P2: профиль по линии (чистая функция), экспорт PNG/TIFF (несжатый RGB), панель/кнопки, горизонтальный срез.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const SEC = fs.readFileSync(path.join(R, 'ui', 'sections-p2.js'), 'utf8');
const Sec = require(path.join(R, 'ui', 'sections-p2.js'));

test('r151: старт — clearCache не ждём перед стартовой страницей', () => {
  assert.match(MAIN, /clearCache\(\)\.catch\(\(\) => \{\}\);[\s\S]{0,500}?try \{ win\.loadFile\(path\.join\(__dirname, 'renderer', 'startup\.html'\)/, 'стартовая страница должна грузиться сразу');
  assert.ok(!/clearCache\(\)[\s\S]{0,60}\.finally\(\(\) => \{\s*win\.loadFile/.test(MAIN), 'clearCache не должен блокировать загрузку');
});

test('r151: первый сегмент 2–5 млн — main/preload/app', () => {
  assert.match(MAIN, /payload\.firstSegPoints/, 'main не читает firstSegPoints');
  assert.match(MAIN, /const firstLen = firstLenRaw > 0 \? Math\.max\(200000, Math\.min\(8000000, Math\.floor\(firstLenRaw\)\)\) : 0;/, 'нет ограничения первого сегмента 2–5 млн');
  assert.match(MAIN, /firstSegPoints: useFirst \? firstLen : 0/, 'firstSegPoints не возвращается окну');
  assert.match(MAIN, /const from = k === 0 \? 0 : \(firstLen \+ \(k - 1\) \* d\.segPoints\)/, 'чтение частей не учитывает маленькую первую');
  assert.match(PRELOAD, /firstSegPoints: opts && opts\.firstSegPoints > 0/, 'preload не передаёт firstSegPoints');
  assert.match(APP, /firstSegPoints: 3000000/, 'app не просит первый сегмент 3 млн');
  assert.match(APP, /function startPendingCloudOpen\(\)/, 'pending-облако должно стартовать после viewer');
  assert.match(APP, /progressive: true/, 'нет прогрессивного первого кадра');
});

// ---------- чистые функции профиля/TIFF ----------
test('r151: профиль по линии — полоса, биннинг, min/max/mean', () => {
  // линия вдоль X от 0 до 10 при Z=0, точки двух уровней
  const pts = [1, 1, 0, 1, 3, 0, 5, 2, 0, 9, 4, 0, 5, 9, 5]; // последняя вне полосы
  const p = Sec.profile(pts, { x1: 0, z1: 0, x2: 10, z2: 0 }, { band: 1.0, bins: 10 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.bins.length, 10);
  assert.strictEqual(p.used, 4, 'точка вне полосы не должна учитываться');
  assert.ok(Math.abs(p.length - 10) < 1e-9);
  const filled = p.bins.filter((b) => b.count > 0);
  assert.ok(filled.length >= 3);
  assert.ok(filled.every((b) => b.min <= b.mean && b.mean <= b.max));
  const zero = Sec.profile([], { x1: 0, z1: 0, x2: 1, z2: 0 }, {});
  assert.strictEqual(zero.ok, false);
});

test('r151: TIFF — несжатый RGB, корректный заголовок и размер', () => {
  const w = 4, h = 2, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = i * 10; rgba[i * 4 + 1] = 100; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255; }
  const bytes = Sec.tiffRGB(w, h, rgba);
  assert.strictEqual(bytes[0], 0x49); assert.strictEqual(bytes[1], 0x49);
  const dv = new DataView(bytes.buffer);
  assert.strictEqual(dv.getUint16(2, true), 42);
  const ifd = dv.getUint32(4, true);
  assert.strictEqual(dv.getUint16(ifd, true), 13, '13 IFD-записей');
  const pix = bytes.length - (ifd + 13 * 12 + 4 + 6 + 4 + 8 + 8);
  assert.strictEqual(pix, w * h * 3, 'размер пиксельных данных — RGB без сжатия');
  // StripOffsets (273) указывает на пиксели, и первый пиксель = [0,100,200]
  let stripOff = null;
  for (let e = 0; e < 13; e++) { const q = ifd + 2 + e * 12; if (dv.getUint16(q, true) === 273) stripOff = dv.getUint32(q + 8, true); }
  assert.ok(stripOff > 0);
  assert.strictEqual(bytes[stripOff], 0); assert.strictEqual(bytes[stripOff + 1], 100); assert.strictEqual(bytes[stripOff + 2], 200);
});

test('r151: P2-модуль — панель, кнопки, горизонтальный срез, экспорт', () => {
  for (const t of ['Горизонтальный срез', 'Вертикальное сечение', 'Построить профиль', 'Экспорт PNG', 'Экспорт TIFF']) assert.ok(SEC.includes(t), 'нет «' + t + '»');
  assert.match(SEC, /window\.__lxSections/);
  assert.match(SEC, /setSectionValue/);
  assert.match(SEC, /data-sec="png"/);
  assert.match(SEC, /data-sec-bar/);
  assert.ok(SEC.includes('var(--accent)') && SEC.includes('var(--bg-2)'));
  assert.ok(!/linear-gradient|radial-gradient/.test(SEC));
  // вызов модуля из app.js
  assert.match(APP, /sections-p2\.js\?v=151/);
  assert.match(APP, /function ensureSectionsP2\(\)/);
});

function makeSecEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.__toast = (m, tone) => calls.push(['toast', String(m), tone]);
  w.__lxIcons = { svg: () => '<svg></svg>' };
  w.__viewer = {
    bbox: { mn: [-5, 0, -5], mx: [5, 3, 5] },
    base: [{ pos: new Float32Array([0, 1, 0, 1, 2, 0, 2, 1.5, 0, -3, 0.5, 0]) }],
    section: { on: false },
    setSection(on) { calls.push(['section', on]); this.section.on = !!on; },
    setSectionValue(t) { calls.push(['sectionValue', t]); }
  };
  // canvas 2d: минимальная заглушка, чтобы панель рисовала профиль
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { clearRect() { }, fillRect() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, fillText() { }, set fillStyle(v) { }, set strokeStyle(v) { }, set lineWidth(v) { }, set font(v) { }, getImageData: (x, y, ww, hh) => ({ data: new Uint8ClampedArray(ww * hh * 4) }) };
  };
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
  w.eval(SEC);
  return { w, dom, calls, api: w.__lxSections };
}

test('r151: P2 (jsdom) — срез/профиль/экспорт работают', { skip: !JSDOM && 'jsdom' }, () => {
  const env = makeSecEnv();
  try {
    const api = env.api;
    assert.ok(api, 'нет __lxSections');
    api.mount();
    assert.ok(env.w.document.getElementById('lxSecBar'), 'нет кнопки/панели');
    api.open();
    assert.ok(!env.w.document.getElementById('lxSecPanel').hidden);
    // горизонтальный срез
    const slice = env.w.document.querySelector('[data-sec="slice-on"]');
    slice.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'section' && c[1] === true), 'setSection(true) не вызван');
    const z = env.w.document.querySelector('[data-sec-z]'); z.value = '0.35';
    z.dispatchEvent(new env.w.Event('input', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'sectionValue' && Math.abs(c[1] - 0.35) < 1e-9), 'setSectionValue не вызван');
    // вертикальный профиль
    env.w.document.querySelector('[data-sec="mode-v"]').dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
    const prof = api.build();
    assert.ok(prof && prof.ok, 'профиль не построен: ' + JSON.stringify(prof && prof.reason));
    assert.ok(api.state().hasProfile);
    // экспорт
    assert.strictEqual(api.exportPNG(), true);
    assert.strictEqual(api.exportTIFF(), true);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});
