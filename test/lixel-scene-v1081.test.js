const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const SCENE = fs.readFileSync(path.join(R, 'lixel-scene.js'), 'utf8');
const UI = fs.readFileSync(path.join(R, 'lixel-ui.js'), 'utf8');
const CSS = fs.readFileSync(path.join(R, 'lixel-ui.css'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

test('index.html подключает lixel-scene.js v1081', () => {
  assert.ok(HTML.includes('lixel-scene.js?v=1090'), 'scene js not linked');
});

test('app.js открывает доступ к вьюеру', () => {
  assert.ok(APP.includes('window.__viewer = viewer'), 'viewer not exposed');
  assert.ok(APP.includes('lx-viewer-ready'), 'ready event missing');
});

test('scene: точные подписи LixelStudio в дереве', () => {
  assert.ok(SCENE.includes('Облако точек'), 'cloud label');
  assert.ok(SCENE.includes('Траектория'), 'traj label');
  assert.ok(SCENE.includes('Панорамный'), 'pano label');
  assert.ok(SCENE.includes('Векторные данные'), 'vector label');
  assert.ok(SCENE.includes('Mesh'), 'mesh label');
});

test('scene: этажи с диапазоном высот и изоляцией', () => {
  assert.ok(SCENE.includes('function addFloor'), 'addFloor missing');
  assert.ok(SCENE.includes('function isolateFloor'), 'isolateFloor missing');
  assert.ok(SCENE.includes('function renameFloor'), 'renameFloor missing');
  assert.ok(SCENE.includes('function delFloor'), 'delFloor missing');
  assert.ok(SCENE.includes('setSectionRange') || SCENE.includes('setSection'), 'section wiring missing');
});

test('scene: публичный API для ленты «Объект»', () => {
  assert.ok(SCENE.includes('window.__lxScene'), 'public api missing');
  ['addFloor', 'autoSlice', 'isolateActive', 'attachDoc', 'report'].forEach(function (m) {
    assert.ok(SCENE.includes(m + ':') || SCENE.includes(m + ' :') || SCENE.includes(m + ': function'), 'api ' + m + ' missing');
  });
});

test('scene: глазки-переключатели видимости', () => {
  assert.ok(SCENE.includes('data-eye'), 'layer eye missing');
  assert.ok(SCENE.includes('data-feye'), 'floor eye missing');
  assert.ok(SCENE.includes('applyLayerVisibility'), 'visibility apply missing');
});

test('scene: панель документации', () => {
  assert.ok(SCENE.includes('renderDocs'), 'docs render missing');
  assert.ok(SCENE.includes('function attachDoc'), 'attach missing');
  assert.ok(SCENE.includes('Документация'), 'docs label');
});

test('ui: кнопки «Объект» связаны с __lxScene', () => {
  assert.ok(UI.includes('window.__lxScene.addFloor'), 'add wire');
  assert.ok(UI.includes('window.__lxScene.isolateActive'), 'isolate wire');
  assert.ok(UI.includes('window.__lxScene.autoSlice'), 'slice wire');
  assert.ok(UI.includes('window.__lxScene.report'), 'report wire');
});

test('css: стили дерева и модалки', () => {
  assert.ok(CSS.includes('.lx-scene'), 'scene css');
  assert.ok(CSS.includes('.lx-eye'), 'eye css');
  assert.ok(CSS.includes('.lx-modal'), 'modal css');
  assert.ok(CSS.includes('.lx-floor.active'), 'active floor css');
});
