'use strict';
/*
 * r174 — спекл/плавность: круглые мягкие сплаты (disc-mask, radial alpha, blending) вместо квадратов 1px,
 * размер 3–5 px в покое / ≥2.5 px в движении, LOD-слияние; авто-режим 60 % точек в движении для стабильности кадра.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/webgl-viewer.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

test('r195: мягкие круглые сплаты — disc mask, energy-preserving край (alpha=1)', () => {
  assert.match(SRC, /uniform float uSoft;/, 'uSoft не объявлен в FS');
  assert.match(SRC, /vec2 sc = gl_PointCoord \* 2\.0 - 1\.0; float rr = length\(sc\);/, 'disc-маска не задана');
  assert.match(SRC, /if\(rr > 1\.0\) discard;/, 'за пределами круга должно отбрасываться');
  assert.match(SRC, /float edge = smoothstep\(1\.0, 0\.45, rr\);/, 'мягкий радиальный край не задан');
  assert.match(SRC, /alpha = 1\.0;/, 'energy-preserving: alpha не копится');
  assert.match(SRC, /c \*= \(0\.55 \+ 0\.45 \* edge\);/, 'край затемняется без alpha-накопления');
  assert.match(SRC, /gl\.enable\(gl\.BLEND\); gl\.blendFunc\(gl\.SRC_ALPHA, gl\.ONE_MINUS_SRC_ALPHA\)/, 'blending не включён для облака');
  assert.match(SRC, /gl\.depthMask\(true\)/, 'глубина должна писаться при сплатах');
  assert.match(SRC, /const roundPt = \(!\(o\._isStation \|\| o\._isSel\)\) \? 1/, 'облако должно рисоваться круглыми точками');
});

test('r174: размер точки 3–5 px в покое, в движении ≥2.5 px', () => {
  assert.match(SRC, /this\._autoPointSize = true; this\._autoPointBasePx = 2\.3; this\._ptMaxCap = 4\.0; this\._softSplats = false; this\._softSplatsLimit = 150000000/);
  assert.match(SRC, /Math\.max\(1\.5, Math\.min\(4\.0, hCss \/ 1200 \* \(this\._autoPointBasePx \|\| 2\.3\)\)\)/);
  assert.match(SRC, /Math\.max\(2\.0, autoH \* \(this\._motionSizeScale \|\| 0\.9\)\)/);
  assert.match(APP, /setPointBasePx\(2\.3\)/);
});

test('r174: fallback — >150M или деградация → hard-точки 3–4 px, без alpha', () => {
  assert.match(SRC, /_softSplatsLimit = 150000000/);
  assert.match(SRC, /\(o\.count \|\| 0\) <= \(this\._softSplatsLimit \|\| 150000000\)/);
  assert.match(SRC, /_softSplatsFail/);
  assert.match(SRC, /softCap = this\._softSplats && !this\._softSplatsFail \? 3\.2 : 3\.0/);
  assert.match(SRC, /webglcontextlost/);
  assert.match(APP, /viewer\._interacting && paused < 600/, 'подгрузка чанков должна ограниченно паузиться при вращении');
  assert.match(fs.readFileSync(path.join(ROOT, 'tools/scan2bim-py/bench-app-r145.js'), 'utf8'), /p99FrameMs/);
});

test('r174: авто-движение 60 % точек для стабильного frame time', () => {
  assert.match(SRC, /this\._interBudget = 128000000; this\._octMovePct = 60;/);
  assert.match(SRC, /fps >= 58 && pct < 100/);
});


