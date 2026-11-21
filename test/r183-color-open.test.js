'use strict';
/* r183 (дополнение): серое/цветное облако — детектор 8-бит RGB (R≠G) не должен давать «цвета нет»,
 * баннер «Облако без цвета» для серого; стенд открывает *-color.las, если он рядом. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const CORE = require('../las-core.js');

test('r183c: детектор цвета — серый R=G=B (даже при max>0) не цвет; 8-бит RGB (R≠G) — цвет', () => {
  assert.strictEqual(typeof CORE.decideColorSample, 'function');
  assert.strictEqual(CORE.decideColorSample(200, 0, 4000).hasColor, false, 'серый лидар R=G=B не должен считаться цветом');
  assert.strictEqual(CORE.decideColorSample(255, 3900, 4000).hasColor, true, '8-бит RGB (R≠G) — цветной');
  assert.strictEqual(CORE.decideColorSample(255, 10, 4000).hasColor, false, 'почти все R=G=B — серая яркость');
  assert.strictEqual(CORE.decideColorSample(0, 0, 0).hasColor, false, 'пустые RGB — не цвет');
});

test('r183c: баннер «Облако без цвета» + автозапуск раскраски по фото', () => {
  assert.match(APP, /function ensureNoColorBanner\(\)/);
  assert.match(APP, /Облако без цвета/);
  assert.match(APP, /info\.hasColor === false/);
  assert.match(APP, /__bimPhotoColor\(lastCloudPath, \{ auto: true \}\)/);
  assert.match(APP, /const auto = !!\(optsIn && optsIn\.auto\)/);
});

test('r183c: bench открывает рядом лежащую цветную версию и помечает файл в отчёте', () => {
  const B = read('tools/scan2bim-py/bench-app-r145.js');
  assert.match(B, /-color\.las/);
  assert.match(B, /colorAuto = true/);
  assert.match(B, /\(цветной\)/);
  assert.match(B, /no-color-auto/);
});
