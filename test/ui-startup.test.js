'use strict';
/* Стартовый экран (выбор проекта): разметка, политика CSP, связь с preload и идентификаторами. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const html = read('startup.html'), js = read('startup.js'), css = read('startup.css');

test('startup.html: стили и скрипты дизайн-системы подключены, файлы существуют', () => {
  const refs = [...html.matchAll(/(?:href|src)="([^"]+?)(?:\?[^"]*)?"/g)].map((m) => m[1]).filter((u) => !/^data:/.test(u));
  for (const f of ['ui/fonts.css', 'ui/tokens.css', 'ui/base.css', 'ui/components.css', 'ui/motion.css', 'startup.css', 'icons.js', 'ui/kit.js', 'startup.js']) {
    assert.ok(refs.includes(f), 'не подключён ' + f);
    assert.ok(fs.existsSync(path.join(R, f)), 'нет файла ' + f);
  }
  // порядок: токены раньше компонентов, значки и кит раньше логики экрана
  assert.ok(refs.indexOf('ui/tokens.css') < refs.indexOf('ui/components.css'));
  assert.ok(refs.indexOf('icons.js') < refs.indexOf('ui/kit.js') && refs.indexOf('ui/kit.js') < refs.indexOf('startup.js'));
});

test('startup.html: CSP без inline-скриптов и стилей; разметка без style= и on*=', () => {
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert.match(csp, /script-src 'self'(?:;|$)/);
  assert.match(csp, /style-src 'self'(?:;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /font-src 'self' data:/);   // Inter вшит как data-URI
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /\son[a-z]+="/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
});

test('startup.html: идентификаторы уникальны; у всех, к кому обращается startup.js, есть элемент', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'повторяются id');
  const used = new Set([...js.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, []);
});

test('startup.html: у кнопок и полей есть доступное имя', () => {
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    const named = /aria-label="[^"]+"/.test(m[0]) || m[1].replace(/<[^>]+>/g, '').trim();
    assert.ok(named, 'кнопка без имени: ' + m[0].slice(0, 80));
  }
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    assert.ok(/aria-label="[^"]+"/.test(m[0]) || /type="checkbox"/.test(m[0]), 'поле без имени: ' + m[0].slice(0, 80));
  }
});

test('startup.js: использует только существующие методы preload и не вызывает prompt/alert', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const methods = new Set([...js.matchAll(/\bapi\.([A-Za-z]+)/g)].map((m) => m[1]));
  for (const name of methods) {
    if (name === 'platform') { assert.match(preload, /platform:\s*process\.platform/); continue; }
    assert.match(preload, new RegExp('\\b' + name + '\\s*:'), 'в preload нет ' + name);
  }
  for (const name of ['listProjects', 'createProject', 'switchProject', 'winMin', 'winMax', 'winClose']) assert.ok(methods.has(name), name);
  assert.doesNotMatch(js, /(?:^|[^.\w])(?:prompt|alert|confirm)\s*\(/m);
  assert.match(js, /kit\.ask\(/);                          // название проекта — во встроенном диалоге
  assert.match(js, /location\.replace\('index\.html\?fromStart=1/);   // переход, который разрешён в main.js
  assert.match(js, /bim\.autoFloorOnOpen/);               // флаг автораскладки по этажам читает chrome.js
});

test('startup.css: только токены дизайн-системы, без «чужих» цветов и шрифтов', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const colors = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  // допустимы только белый для значка на акценте и красная подсветка «Закрыть» в заголовке окна
  for (const c of colors) assert.ok(['#fff', '#ffffff', '#d83b45'].includes(c), 'свой цвет ' + c);
  assert.doesNotMatch(stripped, /font-family\s*:\s*['"A-Za-z]/);   // шрифт приходит из --font
});
