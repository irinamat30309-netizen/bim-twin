'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const SRC = fs.readFileSync(path.join(R, 'webgl-viewer.js'), 'utf8');
const MOD = fs.readFileSync(path.join(R, 'lixel-object-extract.js'), 'utf8');
const DRAW = fs.readFileSync(path.join(R, 'lixel-draw.js'), 'utf8');
const WORKSPACE = fs.readFileSync(path.join(R, 'lixel-workspace.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');

// v1153: FARO-подобное «Выделить объект срезом» + сохранение как модели. Аддитивно.

test('viewer: все методы среза/извлечения присутствуют', () => {
  for (const m of ['sliceSetup', 'selectInSlice', 'smartObjectAt', 'extractSelectionAsObject', 'getExtractedObjects', 'getExtractedObjectCloud', 'removeExtractedObject', 'clearExtractedObjects', 'loadExtractedObjectAsCloud']) {
    assert.ok(SRC.includes(m + '('), 'missing viewer method ' + m);
  }
});

test('viewer: извлечение недеструктивно (keepByIndices, без изменения базы)', () => {
  const start = SRC.indexOf('extractSelectionAsObject(name) {');
  const end = SRC.indexOf('getExtractedObjects()', start);
  assert.ok(start > 0 && end > start, 'не найден блок extractSelectionAsObject');
  const body = SRC.slice(start, end);
  assert.ok(body.includes('keepByIndices('), 'extract не использует keepByIndices');
  assert.ok(!body.includes('loadCloud('), 'extract не должен менять активное облако (недеструктивно)');
  assert.ok(!body.includes('deleteByIndices('), 'extract не должен удалять точки');
});

test('viewer: умный захват ограничен срезом (magicWand + _clipFilter)', () => {
  const start = SRC.indexOf('smartObjectAt(cx, cy, opts) {');
  const end = SRC.indexOf('extractSelectionAsObject(name) {', start);
  const body = SRC.slice(start, end);
  assert.ok(body.includes('magicWand('), 'нет region-grow (magicWand)');
  assert.ok(body.includes('this._clipFilter('), 'захват не ограничен срезом');
});

test('viewer: sliceSetup задаёт одну полосу и сбрасывает ограничения прошлой оси', () => {
  const v = Object.create(Viewer3DGL.prototype);
  let renders = 0;
  v.section = { on: false, min: [.2, .3, .4], max: [.8, .9, .7], t: 1 };
  v.bbox = { mn: [0, 0, 0], mx: [10, 5, 20] };
  v.render = () => { renders++; };
  const r = v.sliceSetup('z', .8, .2);
  assert.equal(v.section.on, true);
  assert.deepEqual(v.section.min, [0, 0, .2]);
  assert.deepEqual(v.section.max, [1, 1, .8]);
  assert.deepEqual(r.bounds, { mn: [0, 0, 4], mx: [10, 5, 16] });
  assert.equal(renders, 1, 'срез обновляет кадр один раз');
  assert.equal(v.sliceSetup('q', 0, 1), null, 'неподдерживаемая ось игнорируется');
  assert.throws(() => v.sliceSetup('x', NaN, 1), RangeError);
});

test('viewer: сечение задаёт правильный ортографический вид', () => {
  const v = Object.create(Viewer3DGL.prototype);
  v.bbox = { mn: [0, -2, 10], mx: [4, 6, 20] };
  v.canvas = { width: 1600, height: 900, clientWidth: 1600, clientHeight: 900 };
  v._fov = Math.PI / 4;
  v._tweenTo = spec => { v.lastView = spec; };
  assert.equal(v.setSectionView('x'), true);
  assert.equal(v._ortho, true);
  assert.equal(v.lastView.yaw, Math.PI / 2);
  assert.deepEqual(v.lastView.target, [2, 2, 15]);
  assert.ok(v.lastView.dist > 0);
});

test('viewer: извлечённый объект сохраняет геопривязку при повторном открытии', () => {
  const prior = global.window;
  global.window = { PCEdit: { keepByIndices: () => ({ pos: new Float32Array([4, 5, 6]), col: new Float32Array([.1, .2, .3]) }) } };
  try {
    const v = Object.create(Viewer3DGL.prototype);
    v.base = [{ pos: new Float32Array([1, 2, 3, 4, 5, 6]), col: null }];
    v._sel = new Set([1]); v._objects = []; v._objSeq = 0;
    v._srcXform = { axis: 'zup', t: new Float64Array([500000, 6000000, 117]) };
    v._srcCrs = 'WKT test';
    const saved = v.extractSelectionAsObject('Проверка');
    const cloud = v.getExtractedObjectCloud(saved.id);
    assert.deepEqual(cloud.meta, { srcXform: { axis: 'zup', t: [500000, 6000000, 117] }, crsWkt: 'WKT test' });
    let loaded = null;
    v.resetSection = () => {};
    v.setSection = () => {};
    v.loadCloud = (c, opts) => { loaded = { c, opts }; };
    assert.equal(v.loadExtractedObjectAsCloud(saved.id), true);
    assert.deepEqual(loaded.c.meta, cloud.meta);
    assert.deepEqual(loaded.opts, { preserveView: true });
  } finally {
    if (prior === undefined) delete global.window; else global.window = prior;
  }
});

test('module: кнопка и проводка присутствуют', () => {
  assert.ok(MOD.includes("btn.id = 'lxObjExtractBtn'"), 'нет отдельной кнопки');
  for (const s of ['sliceSetup', 'smartObjectAt', 'extractSelectionAsObject', 'loadExtractedObjectAsCloud', 'exportPLYAsync', 'saveCloud', 'selectInSlice']) {
    assert.ok(MOD.includes(s), 'module не вызывает ' + s);
  }
  assert.ok(MOD.includes('__lxObjectExtract'), 'нет публичного API модуля');
});

test('module: 3 оси среза (горизонталь/вертикаль)', () => {
  assert.ok(/\['y'/.test(MOD) && /\['x'/.test(MOD) && /\['z'/.test(MOD), 'нет выбора осей x/y/z');
  assert.ok(MOD.includes('max="10000"'), 'слайдер должен иметь точный шаг 0.01%');
  assert.ok(MOD.includes('lxObjLoCoord') && MOD.includes('lxObjHiCoord'), 'нет ввода координат в метрах');
  assert.ok(MOD.includes('sourceCloud') && MOD.includes('exportPLYAsync'), 'экспорт объекта должен сохранять мировые координаты');
  assert.ok(WORKSPACE.includes('Вертикальный · фасад (Z)') && WORKSPACE.includes('Вертикальный · сбоку (X)'), 'чертёжное сечение не поддерживает вертикальные виды');
  assert.ok(WORKSPACE.includes('lxSectionMinArea') && WORKSPACE.includes('discardedSmall'), 'нет контроля мелких контуров');
  assert.ok(DRAW.includes('setSectionView(axis)'), 'после построения не выбирается ортографический вид');
});

test('регистрация object-extract v1218 и контурных модулей v1219', () => {
  assert.ok(HTML.includes('lixel-object-extract.js?v=1218'), 'модуль не подключён в index.html');
  assert.ok(HTML.includes('webgl-viewer.js?v=1230'), 'webgl-viewer не current');
  assert.ok(HTML.includes('lixel-draw.js?v=1232') && HTML.includes('lixel-workspace.js?v=1232'), 'модули контурного сечения не обновлены');
  assert.ok(HTML.includes('measure.js?v=1154'), 'measure.js неожиданно изменён');
  assert.ok(APP.includes('готова · v1160'), 'баннер не v1153');
});
