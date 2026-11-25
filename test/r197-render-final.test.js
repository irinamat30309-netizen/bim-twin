'use strict';
/* r197: перспективный размер точки 1.5–5 px, pointSize 1.0 для больших облаков, режимы плотности. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const V = read('renderer/webgl-viewer.js');
const APP = read('renderer/app.js');
const HTML = read('renderer/index.html');
const CS = read('cloud-segments.js');

test('r197: pointSize 1.0 для крупных облаков, attenuation 1.5–5 px (не жирные 6)', () => {
  assert.match(V, /var pointSize = n > 1500000 \? 1\.0/);
  assert.match(V, /var ptMax = n > 1500000 \? 4\.0/);
  assert.match(V, /this\._autoPointBasePx = 2\.3; this\._ptMaxCap = 4\.0/);
  assert.match(V, /setPointBasePx\(px\)[^}]*Math\.max\(1\.5, Math\.min\(4\.0, v\)\)/);
  assert.match(V, /setMaxPointPx\(px\)[^}]*Math\.max\(1\.5, Math\.min\(5\.0, v\)\)/);
  assert.match(V, /const auto = Math\.max\(1\.5, Math\.min\(4\.0, hCss \/ 1200 \* \(this\._autoPointBasePx \|\| 2\.3\)\)/);
  assert.match(V, /uPtMin, isCloud \? \(this\._interacting \? 2\.0 : Math\.max\(2\.2/);
  assert.match(V, /Math\.min\(o\._ptMax \|\| 6\.0, this\._ptMaxCap \|\| 6\.0\)/);
});

test('r197: режимы плотности, default balanced 0.53; точно 0.80, быстро 0.42', () => {
  assert.match(APP, /function densityMode\(\)/);
  assert.match(APP, /v === 'exact' \|\| v === 'fast' \? v : 'balanced'/);
  assert.match(APP, /d === 'exact'\) return Math\.max\(qb, gpuBudgetPoints\(0\.80\)\)/);
  assert.match(APP, /d === 'fast'\) return Math\.min\(qb, gpuBudgetPoints\(0\.42\)\)/);
  assert.match(APP, /d === 'balanced'\) return Math\.min\(qb, gpuBudgetPoints\(0\.53\)\)/);
  assert.match(APP, /setMaxPointPx\(d === 'exact' \? 4\.5 : d === 'fast' \? 3\.0 : 4\.0\)/);
  assert.match(HTML, /id="qDensity"/);
  assert.match(HTML, /value="balanced" selected/);
});

test('r197: миграция rev197 сбрасывает сохранённые старые размеры', () => {
  assert.match(APP, /bim\.perfRev'\) !== '197'/);
  assert.match(APP, /bim\.ptBase', 'bim\.pointSize', 'bim\.cloud\.pointSize'/);
});

test('r197: цвет нормализуется по colDiv (8/16-бит), без битового шума', () => {
  assert.match(CS, /const hasColor = desc\.hasColor, kc = 255 \/ desc\.colDiv/);
  assert.match(CS, /kc = 255 \/ \(desc\.colDiv \|\| 1\)/);
  assert.match(CS, /hasRGB: !\!\(H\.hasColor && H\.colorOff \+ 6 <= H\.recLen\)/);
});
