'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Mock dlya brauzernogo okruzheniya
global.window = global.window || {};
global.document = global.document || {
  addEventListener: function(){},
  readyState: 'complete'
};

const XV = require('../renderer/xray-view');

test('setMode: izmenyaet tekushchiy rezhim', () => {
  XV.setMode('top');
  assert.equal(XV.getMode(), 'top');
  XV.setMode('perspective');
  assert.equal(XV.getMode(), 'perspective');
});

test('setXray: upravlyaet flagom', () => {
  XV.setXray(false);
  assert.equal(XV.isXray(), false);
  XV.setXray(true);
  assert.equal(XV.isXray(), true);
});

test('setXray: ogranichivaet glubinu [0,1]', () => {
  XV.setXray(true, 1.5);
  assert.equal(XV.getXrayDepth(), 1.0);
  XV.setXray(true, -0.3);
  assert.equal(XV.getXrayDepth(), 0.0);
  XV.setXray(true, 0.4);
  assert.ok(Math.abs(XV.getXrayDepth() - 0.4) < 1e-9);
});

test('toggleXray: pereключaet flag', () => {
  XV.setXray(false);
  XV.toggleXray();
  assert.equal(XV.isXray(), true);
  XV.toggleXray();
  assert.equal(XV.isXray(), false);
});

test('getPresets: soderzhit top/front/side', () => {
  const presets = XV.getPresets();
  assert.ok('top' in presets);
  assert.ok('front' in presets);
  assert.ok('side' in presets);
});

test('on: slushatel vyzyvaetsya pri smene rezhima', () => {
  let called = false;
  XV.on('mode-changed', () => { called = true; });
  XV.setMode('front');
  assert.ok(called, 'listener dolzhen byt vyzvan');
});
