'use strict';
/* Вопросы оператору задаются только во встроенном диалоге (ui/kit.js → ask):
 * в Electron window.prompt не работает, а window.confirm/alert выглядят чужеродно и блокируют окно. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');
// Код без комментариев: упоминание в пояснении не считается вызовом. Строки и регулярные выражения пропускаем целиком.
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/;
function code(src) {
  let out = '', i = 0, prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c && (c === '`' || src[j] !== '\n')) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; prev = c; continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER_WORD.test(out))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; prev = ')'; continue;
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}

test('в коде интерфейса нет вызовов prompt/confirm/alert', () => {
  const bad = [];
  for (const f of fs.readdirSync(R).filter((n) => n.endsWith('.js') && n !== 'startup.js')) {
    const src = code(read(f));
    const m = src.match(/(?:window\.)?\b(?:prompt|confirm|alert)\s*\(/g);
    if (m) bad.push(f + ': ' + [...new Set(m)].join(', '));
  }
  assert.deepEqual(bad, []);
});

test('ask(): многострочный ввод, подсказка, Ctrl+Enter и слой выше окна прогресса', () => {
  const kit = read('ui/kit.js'), css = read('ui/viewers.css') + read('ui/components.css');
  assert.match(kit, /o\.multiline/);
  assert.match(kit, /lx-ask-hint/);
  assert.match(kit, /e\.ctrlKey \|\| e\.metaKey/);
  assert.match(css, /\.modal\.lx-ask\s*\{[^}]*z-index:\s*calc\(var\(--z-modal\)\s*\+\s*50\)/);
  assert.match(css, /\.modal-card\.md\s*\{[^}]*width:\s*min\(600px/);
});

test('модули с вопросами оператору используют встроенный диалог', () => {
  for (const f of ['lixel-tools-ext.js', 'lixel-sprints-ext.js', 'lixel-draw-ext.js']) {
    const src = code(read(f));
    assert.match(src, /function askKit\(o\)\s*\{[^}]*__lxKit[^}]*\.ask/, f);
  }
  const app = code(read('app.js'));
  assert.match(app, /async function confirmGeometryFrame\(/);
  assert.doesNotMatch(app, /(?<!await\s)(?<!function\s)confirmGeometryFrame\(/);
  assert.match(app, /kit\.ask\(\{ title: 'Координаты не подтверждены'/);
  assert.match(app, /__lxKit\.ask\(\{ title: 'Класс LAS'[^}]*min: 0, max: 255/);
  assert.match(code(read('lixel-draw.js')), /function importText\(text, name, frameOk\)/);
  assert.match(code(read('lixel-workspace.js')), /applyPreset\.addEventListener\('click',async\(\)/);
});

test('кнопка «Текст» на чертеже: текст вводится во встроенном диалоге', () => {
  const src = code(read('lixel-draw-ext.js'));
  assert.match(src, /async function doText\(\)/);
  assert.match(src, /await askKit\(\{ title: 'Текст аннотации'[^}]*input: true/);
});
