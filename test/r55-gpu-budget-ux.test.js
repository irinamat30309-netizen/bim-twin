'use strict';
// Ревизия 55: удобство на большом облаке — предел видеокарты объясняется, его можно вернуть, а не «закрыть программы».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r55: предел видеокарты объясняется в окне загрузки и его можно вернуть', () => {
  const p = read('renderer/cloud-preview.js');
  assert.match(p, /data-act="resetGpu"/, 'кнопка «Вернуть полный предел»');
  assert.match(p, /localStorage\.removeItem\('bim\.gpuPointBudget'\)/, 'снимает снижённый предел');
  assert.match(p, /Видеокарта сбрасывала изображение при/, 'объясняет причину снижения');
});

test('r55: свойства облака и итог объясняют предел понятными словами', () => {
  const ui = read('renderer/lixel-cloud-ui.js');
  assert.match(ui, /это предел показа для этой видеокарты/, 'свойства облака');
  assert.match(ui, /выберите «Все точки»/, 'подсказывают, где выбрать все точки');
  assert.match(ui, /Вернуть полный предел/, 'подсказывают кнопку сброса');
  const app = read('renderer/app.js');
  assert.match(app, /Показано ' \+ Math\.round\(shown \/ 1e6\)/, 'итог после загрузки');
  assert.match(app, /предел показа на этой видеокарте/, 'итог объясняет предел');
  assert.ok(!/сконвертируйте файл в LAS или PLY/.test(app), 'старого совета «сконвертировать в LAS» больше нет');
});
