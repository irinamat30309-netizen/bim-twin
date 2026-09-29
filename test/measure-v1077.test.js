const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', 'renderer', p), 'utf8');
const CSS = read('styles.css');

// —— регрессия: у .btn-sm не было базового правила — текст был невидим ——
test('styles.css: у .btn-sm есть базовое правило с фоном и цветом', () => {
  const m = CSS.match(/\.btn-sm\{[^}]*\}/);
  assert.ok(m, 'нет базового правила .btn-sm{}');
  const rule = m[0];
  assert.ok(/background:/.test(rule), '.btn-sm без background');
  assert.ok(/color:var\(--txt\)/.test(rule), '.btn-sm без читаемого цвета текста');
  assert.ok(/border/.test(rule), '.btn-sm без border');
});

test('styles.css: есть состояния .btn-sm.on и .btn-sm.danger', () => {
  assert.ok(CSS.includes('.btn-sm.on'), 'нет .btn-sm.on');
  assert.ok(CSS.includes('.btn-sm.danger'), 'нет .btn-sm.danger');
});

test('styles.css: цвет текста кнопки != нативный белый фон (не white-on-white)', () => {
  const m = CSS.match(/\.btn-sm\{[^}]*\}/)[0];
  // фон — темная панель, а не #fff
  assert.ok(/background:var\(--panel2\)/.test(m), 'фон .btn-sm должен быть var(--panel2)');
});
