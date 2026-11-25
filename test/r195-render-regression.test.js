'use strict';
/* r195: регрессия качества — возврат hard-точек 2.8px, нейтрального тона 1.0, energy-preserving soft (опция),
 * миграция старых пересвеченных настроек; CSS не фильтрует канвас. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('renderer/webgl-viewer.js');
const APP = read('renderer/app.js');
const PANEL = read('renderer/ui/perf-panel.js');
const CSS = read('renderer/ui/design-r192.css');

test('r195: default — hard-точки, 2.8 px, клэмп 2–3, нейтральный тон 1.0', () => {
  assert.match(SRC, /this\._autoPointBasePx = 2\.3; this\._ptMaxCap = 4\.0; this\._softSplats = false/);
  assert.match(SRC, /const auto = Math\.max\(1\.5, Math\.min\(4\.0, hCss \/ 1200 \* \(this\._autoPointBasePx \|\| 2\.3\)\)\)/);
  assert.match(SRC, /Math\.max\(2\.0, autoH \* \(this\._motionSizeScale \|\| 0\.9\)\)/);
  assert.match(SRC, /this\._ptBright = 1\.0;/);
  assert.match(SRC, /this\._grade = \{ on: false, exposure: 1\.0, contrast: 1\.0, saturation: 1\.0, gamma: 1\.0, tone: 0\.0 \};/);
  assert.match(APP, /viewer\.setPointBasePx\(2\.3\)/);
  assert.match(APP, /viewer\.setBrightness\(1\.0\); viewer\.setGrade\(false\)/);
});

test('r195: миграция старых пресетов (rev 195) и панель без «Lixel» по умолчанию', () => {
  assert.match(APP, /bim\.perfRev'\) !== '197'/);
  assert.match(APP, /localStorage\.setItem\('bim\.perfRev', '197'\)/);
  assert.match(APP, /bright = n\('bim\.perf\.brightness', 1\.0\)/);
  assert.match(PANEL, /var b = Number\(g\('brightness', 1\.0\)\)/);
  assert.match(PANEL, /savePrefs\(\{ quality: 'auto', look: 'neutral', autoPoint: true, brightness: 1\.0/);
});

test('r195: soft — только опция «Высокое», energy-preserving (alpha=1), без накопления', () => {
  assert.match(SRC, /if \(mode === 'high'\) \{ this\._softForce = true; this\._softSplats = true; this\._softSplatsFail = false; \}/);
  assert.match(SRC, /alpha = 1\.0;/);
  assert.match(SRC, /c \*= \(0\.55 \+ 0\.45 \* edge\);/);
  assert.doesNotMatch(SRC, /alpha = 0\.30 \+ 0\.70 \* edge;/);
});

test('r195: CSS не меняет яркость/фон канваса (нет filter/opacity на canvas)', () => {
  assert.doesNotMatch(CSS, /canvas[^}]*\{[^}]*filter:/is);
  assert.doesNotMatch(CSS, /canvas[^}]*\{[^}]*opacity:/is);
  assert.doesNotMatch(CSS, /\.viewer-canvas[^}]*\{[^}]*filter:/is);
});
