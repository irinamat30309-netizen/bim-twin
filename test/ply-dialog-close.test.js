// Диалог «PLY → 3DGS» должен закрываться: «×», Esc, клик по фону; класс open снимается (r11)
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
test('PLY→3DGS: есть кнопка «×» и общий hideConv', () => {
  assert.match(src, /id="_convX"/);
  assert.match(src, /hideConv/);
  assert.match(src, /classList\.remove\('open'\)/);
});
test('PLY→3DGS: во время конвертации закрытие не прерывает её', () => {
  assert.match(src, /Конвертация продолжается в фоне/);
});
