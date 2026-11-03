const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', 'renderer', p), 'utf8');
// Кнопки — общий компонент ui/components.css (.btn и совместимый алиас .btn-sm), цвета берутся из токенов ui/tokens.css.
const CSS = read('ui/components.css');
const TOKENS = read('ui/tokens.css');

// —— регрессия: у кнопок должно быть базовое правило — иначе текст невидим (белый на белом) ——
test('components.css: у .btn / .btn-sm есть базовое правило с фоном и цветом', () => {
  const m = CSS.match(/\.btn, \.btn-sm, button\.chip \{[^}]*\}/);
  assert.ok(m, 'нет общего базового правила кнопок');
  assert.ok(/background:/.test(m[0]), 'кнопка без background');
  assert.ok(/color:\s*var\(--txt\)/.test(m[0]), 'кнопка без читаемого цвета текста');
  assert.ok(/border:/.test(m[0]), 'кнопка без border');
});

test('components.css: есть состояния .btn.on и .btn.danger (и алиасы .btn-sm.*)', () => {
  assert.ok(CSS.includes('.btn.on') && CSS.includes('.btn-sm.on'), 'нет .btn.on');
  assert.ok(CSS.includes('.btn.danger') && CSS.includes('.btn-sm.danger'), 'нет .btn.danger');
  assert.ok(CSS.includes('.btn.primary'), 'нет .btn.primary');
  assert.ok(/\.btn:disabled/.test(CSS), 'нет состояния disabled');
});

test('components.css: фон кнопки — токен панели, а не нативный белый (не white-on-white)', () => {
  const m = CSS.match(/\.btn, \.btn-sm, button\.chip \{[^}]*\}/)[0];
  assert.ok(/background:\s*var\(--bg-3\)/.test(m), 'фон кнопки должен быть токеном var(--bg-3)');
  assert.ok(!/background:\s*#fff/i.test(m), 'фон кнопки не должен быть белым');
  assert.ok(/--bg-3:\s*#/.test(TOKENS) && /--txt:\s*#/.test(TOKENS), 'токены фона и текста заданы');
});
