'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(R, 'lixel-ui.css'), 'utf8');
const JS = fs.readFileSync(path.join(R, 'lixel-ui.js'), 'utf8');

test('index.html подключает lixel-ui скин и контроллер', () => {
  assert.ok(HTML.includes('lixel-ui.css?v=1217'), 'css not linked');
  assert.ok(HTML.includes('lixel-ui.js?v=1083'), 'js not linked');
});

test('CSS: палитра LixelStudio и лента вкладок', () => {
  assert.ok(CSS.includes('data-lxskin="on"'), 'skin selector missing');
  assert.ok(CSS.includes('.lx-tabs'), 'ribbon tabs missing');
  assert.ok(CSS.includes('.lx-status'), 'status bar missing');
});

test('JS: шесть вкладок включая Объект', () => {
  ['Главная страница', 'Обработка проекта', 'Инструмент', 'Рисование плоскости', 'Объект', 'Приложение'].forEach(function (l) {
    assert.ok(JS.includes(l), 'tab missing: ' + l);
  });
  assert.ok(JS.includes('Этажи') && JS.includes('Документация'), 'object groups missing');
  assert.ok(JS.includes('__lxSetCoords'), 'coord hook missing');
});
