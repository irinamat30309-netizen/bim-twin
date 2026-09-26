'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(R, 'lixel-ribbon.css'), 'utf8');
const JS = fs.readFileSync(path.join(R, 'lixel-ribbon.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

test('index.html: подключены риббон css/js v1084', () => {
  assert.ok(HTML.includes('lixel-ribbon.css?v=1217'), 'ribbon css not linked');
  assert.ok(HTML.includes('lixel-ribbon.js?v=1154'), 'ribbon js not linked');
  // предыдущие модули не тронуты
  assert.ok(HTML.includes('lixel-ui.css?v=1217'), 'ui css version changed unexpectedly');
  assert.ok(HTML.includes('lixel-toolbar.js?v=1092'), 'toolbar version changed unexpectedly');
});

test('app.js: баннер v1084', () => {
  assert.ok(APP.includes('готова · v1160'), 'banner not v1084');
});

test('CSS: большие вертикальные кнопки', () => {
  assert.ok(CSS.includes('.btn.lx-bigbtn'), 'big button rule missing');
  assert.ok(CSS.includes('flex-direction:column'), 'vertical layout missing');
  assert.ok(CSS.includes('.lx-bic'), 'icon slot css missing');
  assert.ok(CSS.includes('.lx-blabel'), 'label slot css missing');
  assert.ok(CSS.includes('-webkit-line-clamp:2'), 'two-line clamp missing');
});

test('JS: карта иконок покрывает ключевые кнопки', () => {
  ['btnOpenCloud', 'btnVerify', 'btnReset', 'btnSection', 'btnMeasure', 'btnIsolate', 'btnLOD', 'btnEdit', 'btnSettings', 'ifcInput', 'modelInput', 'docInput', 'tsSplatTop'].forEach(function (id) {
    assert.ok(JS.includes(id + ':'), 'mapping missing for ' + id);
  });
  assert.ok(JS.includes('forLabel: true'), 'file-input label handling missing');
  assert.ok(JS.includes('lx-bigbtn'), 'big class not applied');
  assert.ok(JS.includes('lx-blabel'), 'label span missing');
  assert.ok(JS.includes("data-lxskin"), 'skin guard missing');
  assert.ok(JS.includes('primary: true'), 'primary flag missing');
});

test('JS: меняет только innerHTML (обработчики сохраняются)', () => {
  assert.ok(JS.includes('el.innerHTML ='), 'should set innerHTML on existing element');
  assert.ok(!JS.includes('removeChild') && !JS.includes('replaceWith'), 'must not replace button node');
});
