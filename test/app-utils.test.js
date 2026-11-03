'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const U = require('../renderer/app-utils');

test('is3DModelName detects 3D/point-cloud extensions', () => {
  assert.ok(U.is3DModelName('scan.las'));
  assert.ok(U.is3DModelName('MODEL.GLTF'));
  assert.ok(U.is3DModelName('cloud.e57'));
  assert.ok(!U.is3DModelName('doc.pdf'));
  assert.ok(!U.is3DModelName(''));
  assert.ok(!U.is3DModelName(null));
});

test('fmtSize formats bytes/KB/MB', () => {
  assert.equal(U.fmtSize(null), '');
  assert.equal(U.fmtSize(512), '512 Б');
  assert.equal(U.fmtSize(2048), '2.0 КБ');
  assert.equal(U.fmtSize(1572864), '1.5 МБ');
});

test('guessDocType classifies by name', () => {
  assert.equal(U.guessDocType('plan.dwg'), 'чертеж');
  assert.equal(U.guessDocType('smeta.xlsx'), 'смета');
  assert.equal(U.guessDocType('акт приёмки.pdf'), 'акт');
  assert.equal(U.guessDocType('photo.JPG'), 'фото');
  assert.equal(U.guessDocType('readme.txt'), 'документ');
});
