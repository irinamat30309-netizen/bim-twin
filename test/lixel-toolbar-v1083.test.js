'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(R, 'lixel-ui.css'), 'utf8');
const TB = fs.readFileSync(path.join(R, 'lixel-toolbar.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

test('index.html: версии v1083 и подключён левый тулбар', () => {
  assert.ok(HTML.includes('lixel-ui.css?v=1217'), 'css not bumped');
  assert.ok(HTML.includes('lixel-ui.js?v=1083'), 'ui js not bumped');
  assert.ok(HTML.includes('lixel-scene.js?v=1090'), 'scene not bumped');
  assert.ok(HTML.includes('lixel-toolbar.js?v=1092'), 'toolbar not linked');
  // measure.js остаётся 1082 (в этом релизе не менялся)
  assert.ok(HTML.includes('measure.js?v=1154'), 'measure.js unexpectedly changed');
});

test('app.js: баннер v1083', () => {
  assert.ok(APP.includes('готова · v1160'), 'banner not v1083');
});

test('CSS: точная палитра LixelStudio', () => {
  assert.ok(CSS.includes('--bg:#131314'), 'bg color wrong');
  assert.ok(CSS.includes('--panel:#1c1d1f'), 'panel color wrong');
  assert.ok(CSS.includes('--panel2:#2f3033'), 'panel2 color wrong');
  assert.ok(CSS.includes('--accent:#1f47ca'), 'accent color wrong');
  assert.ok(CSS.includes('--muted:#8c8c8d'), 'muted color wrong');
  assert.ok(!CSS.includes('#2f80ed'), 'old blue accent still present');
});

test('CSS: стили левого тулбара / окна / версии', () => {
  assert.ok(CSS.includes('.lx-ltbar'), 'left toolbar css missing');
  assert.ok(CSS.includes('.lx-ltbtn'), 'toolbar button css missing');
  assert.ok(CSS.includes('.lx-wintab'), 'window tab css missing');
  assert.ok(CSS.includes('.lx-vertag'), 'version tag css missing');
});

test('toolbar.js: 7 инструментов и привязки', () => {
  ['nav', 'measure', 'grid', 'edl', 'xray', 'section', 'full'].forEach(function (id) {
    assert.ok(TB.includes("id: '" + id + "'"), 'tool missing: ' + id);
  });
  assert.ok(TB.includes("btn: 'btnMeasure'"), 'measure not wired');
  assert.ok(TB.includes("btn: 'btnSection'"), 'section not wired');
  assert.ok(TB.includes("btn: 'btnReset'"), 'nav not wired');
});

test('toolbar.js: окно и версия ПО 4.0.1.6', () => {
  assert.ok(TB.includes('Окно 0'), 'window tab label missing');
  assert.ok(TB.includes('Версия ПО:'), 'version tag label missing');
  assert.ok(TB.includes("'1.1.17 · review v10.1'"), 'sw version missing');
  assert.ok(TB.includes('bimAPI.getVersion'), 'toolbar must use the package version at runtime');
  assert.ok(TB.includes('data-lxskin'), 'skin guard missing');
});
