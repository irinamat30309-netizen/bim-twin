'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(R, 'lixel-shell.css'), 'utf8');
const JS = fs.readFileSync(path.join(R, 'lixel-shell.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

test('index.html: подключён shell css/js v1085', () => {
  assert.ok(HTML.includes('lixel-shell.css?v=1217'), 'shell css not linked');
  assert.ok(HTML.includes('lixel-shell.js?v=1089'), 'shell js not linked');
  // предыдущие модули не тронуты
  assert.ok(HTML.includes('lixel-ribbon.js?v=1154'), 'ribbon version changed');
  assert.ok(HTML.includes('lixel-scene.js?v=1090'), 'scene version changed');
});

test('app.js: баннер v1085', () => {
  assert.ok(APP.includes('готова · v1160'), 'banner not v1085');
});

test('1) гизмо осей + кнопка дом', () => {
  assert.ok(JS.includes("id = 'lxGizmo'"), 'gizmo container missing');
  assert.ok(JS.includes("id=\"lxHome\"") || JS.includes('lxHome'), 'home button missing');
  assert.ok(JS.includes("clickBtn('btnReset')"), 'home not wired to reset');
  assert.ok(JS.includes('#ff4d4d'), 'X axis red missing');
  assert.ok(JS.includes('#4e4cff'), 'Y/Z axis blue missing');
  assert.ok(JS.includes("data-ax="), 'axis labels missing');
  assert.ok(CSS.includes('.lx-gizmo'), 'gizmo css missing');
  assert.ok(CSS.includes('.lx-home'), 'home css missing');
  assert.ok(CSS.includes('.lx-cube'), 'cube css missing');
});

test('2) тайтлбар: логотип, Настройки, тема, Не авторизовано', () => {
  assert.ok(JS.includes('lx-tblogo'), 'logo missing');
  assert.ok(JS.includes('lx-tbmenu') && JS.includes('Настройки'), 'settings menu missing');
  assert.ok(JS.includes('lx-tbtheme'), 'theme toggle missing');
  assert.ok(JS.includes('Не авторизовано'), 'auth pill missing');
  assert.ok(JS.includes("dataset.lxdecor"), 'idempotency guard missing');
  assert.ok(CSS.includes('.lx-tbauth') && CSS.includes('.lx-tbcenter') && CSS.includes('.lx-tbright'), 'titlebar css missing');
});

test('3) дерево: SVG-иконки + узел LCC', () => {
  ['cloud', 'mesh', 'traj', 'pano', 'vector', 'lcc'].forEach(function (k) {
    assert.ok(JS.includes(k + ':'), 'tree icon missing: ' + k);
  });
  assert.ok(JS.includes('data-layer="lcc"'), 'LCC node missing');
  assert.ok(JS.includes('lx-svgico'), 'svg icon class missing');
  assert.ok(JS.includes("data-lxsvg"), 'icon idempotency guard missing');
  assert.ok(JS.includes('3DGS'), 'LCC badge missing');
  assert.ok(CSS.includes('.lx-svgico') && CSS.includes('.lx-badge'), 'tree css missing');
});

test('аддитивность: активен только под скином, есть observer', () => {
  assert.ok(JS.includes("data-lxskin"), 'skin guard missing');
  assert.ok(JS.includes('MutationObserver'), 'observer missing');
  assert.ok(JS.includes('window.__lxShell'), 'public handle missing');
});
