'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const VW = fs.readFileSync(path.join(R, 'webgl-viewer.js'), 'utf8');

// v1079: точный GPU-пикинг для измерений (WYSIWYG depth-buffer picking).

test('viewer: есть метод _pickGPU и _drawPickPass', () => {
  assert.ok(VW.includes('_pickGPU('), '_pickGPU missing');
  assert.ok(VW.includes('_drawPickPass('), '_drawPickPass missing');
});

test('viewer: _pick использует GPU-пикинг до CPU-фолбэка', () => {
  assert.ok(VW.includes('const pg = this._pickGPU(sx, sy); if (pg) return pg;'), 'GPU pick not wired into _pick');
});

test('viewer: pick-шейдер учитывает клип-бокс (срез)', () => {
  // PICK_FS передаёт vW и отбрасывает точки вне клип-бокса
  assert.ok(VW.includes('flat out uint vId; out vec3 vW;'), 'PICK_VS vW output missing');
  assert.ok(VW.includes('uniform float uClipOn; uniform vec3 uClipMin; uniform vec3 uClipMax; flat in uint vId; in vec3 vW; out uvec4 frag;'), 'PICK_FS clip uniforms missing');
  assert.ok(VW.includes("'uRound', 'uGrow', 'uClipOn', 'uClipMin', 'uClipMax'"), 'pick clip uniforms not registered');
});

test('viewer: _pickGPU возвращает реальную точку по vertex ID', () => {
  assert.ok(VW.includes('const idx = bestId - 1; const P = bo.pos;'), 'vertex-id → world point mapping missing');
  assert.ok(VW.includes('gl.readPixels(x0, y0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, px)'), 'window readback missing');
});

test('viewer: двухпроходный снап (реальный размер + grow)', () => {
  assert.ok(VW.includes('this._drawPickPass(bo, attempt === 0 ? 0 : 5)'), 'two-pass snap missing');
});

test('html/app: версия 1079', () => {
  assert.ok(HTML.includes('measure.js?v=1154'), 'measure.js not 1082');
  assert.ok(HTML.includes('webgl-viewer.js?v=1230'), 'webgl-viewer.js not current');
  assert.ok(APP.includes('готова · v1160'), 'banner not 1082');
});
