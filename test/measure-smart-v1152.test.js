'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const SRC = fs.readFileSync(path.join(R, 'webgl-viewer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

// v1152: «умное» измерение расстояния — живые направляющие + привязка к осям.
// Добавлено аддитивно; математика измерений (measure.js) не тронута.

test('smart-measure: включён по умолчанию', () => {
  assert.ok(SRC.includes('this.smartMeasure = true'), 'smartMeasure default off');
});

test('smart-measure: все новые методы присутствуют', () => {
  for (const m of ['_smartAxisLock', '_addSmartGuides', '_addDistanceDecomp', '_robustCeilingY', '_smartFloorCeil', '_smartDistancePreview', '_pushSmartGuideLabels', '_pushDistanceCompLabels', '_mkLine']) {
    assert.ok(SRC.includes(m + '('), 'missing method ' + m);
  }
});

test('smart-measure: привязка к вертикали/горизонтали', () => {
  assert.ok(SRC.includes('return [a[0], p[1], a[2]]'), 'нет вертикальной привязки');
  assert.ok(SRC.includes('return [p[0], a[1], p[2]]'), 'нет горизонтальной привязки');
});

test('smart-measure: направляющие доходят до пола/потолка', () => {
  assert.ok(SRC.includes('fc.floorY') && SRC.includes('fc.ceilY'), 'направляющая не использует пол/потолок');
  assert.ok(SRC.includes('this._robustFloorY()'), 'не переиспользует робастный пол');
});

test('smart-measure: предпросмотр и привязка подключены к наведению/клику', () => {
  assert.ok(SRC.includes('this._smartDistancePreview(pv)'), 'предпросмотр не вызывается при наведении');
  assert.ok(SRC.includes('placePt = this._smartAxisLock('), 'клик не применяет привязку к осям');
});

test('smart-measure: разложение на гориз./верт. катеты', () => {
  assert.ok(SRC.includes("'гор ' + Me.fmtLen(d.horizontal)"), 'нет подписи горизонтали');
  assert.ok(SRC.includes("'верт ' + Me.fmtLen(d.vertical)"), 'нет подписи вертикали');
});

test('smart-measure: версии v1152 и математика measure.js не тронута', () => {
  assert.ok(HTML.includes('webgl-viewer.js?v=1230'), 'webgl-viewer не current');
  assert.ok(HTML.includes('measure.js?v=1154'), 'measure.js версия неожиданно изменена');
  assert.ok(APP.includes('готова · v1160'), 'баннер не v1152');
});
