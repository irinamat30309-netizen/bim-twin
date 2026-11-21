'use strict';
/* r190: hasRGB (атрибут) и hasColor (реальный цвет) разделены. Серый RGB-атрибут (R=G=B) → баннер есть,
 * цветной → нет, серый без RGB → баннер есть. Баннер/панель — по hasColor. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VIEW = read('renderer/webgl-viewer.js');
const APP = read('renderer/app.js');
const UI = read('renderer/lixel-cloud-ui.js');

test('r190: getCloudInfo отдаёт отдельно hasRGB и hasColor (выборка 50k, порог серого)', () => {
  assert.match(VIEW, /_sampleCloudColor\(o\)/);
  assert.match(VIEW, /const step = Math\.max\(1, Math\.floor\(total \/ 50000\)\)/);
  assert.match(VIEW, /diff > 0\.08 \|\| sat > 0\.15/);
  assert.match(VIEW, /colored \/ seen >= 0\.02/);
  assert.match(VIEW, /hasRGBrec/);
  assert.match(VIEW, /hasRGB: hasRGBrec, hasColor: hasColorReal/);
  // серая яркость с RGB-атрибутом: hasRGB true, hasColor false
  assert.match(VIEW, /if \(!hasRGBrec\) hasColorReal = false/);
  assert.match(VIEW, /hasColorReal = sampled === null/);
});

test('r190: баннер и панель используют hasColor, атрибут hasRGB — только для «нет RGB»', () => {
  assert.match(APP, /info\.hasColor === false/);
  assert.doesNotMatch(APP, /info\.hasRGB === false/);
  assert.match(UI, /info\.hasColor === false \? true : cloudIsGray/);
  assert.match(UI, /if \(!info\.hasRGB\) \{ el\.textContent = 'В исходнике нет RGB/);
});
