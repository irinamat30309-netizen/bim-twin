'use strict';
/* r192: anti-slop design layer — DESIGN.md, tokens, один акцент, радиусы 4/6/8, типографика, контраст. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('r192: DESIGN.md с направлением и dials', () => {
  const D = read('DESIGN.md');
  assert.match(D, /graphite industrial, violet accent/i);
  assert.match(D, /ENERGY 1 \/ RHYTHM 2 \/ MOTION 1/);
  assert.match(D, /#a78bfa/i);
  assert.match(D, /Radius scale: \*\*4 \/ 6 \/ 8\*\*/);
  assert.match(D, /11 \/ 12 \/ 13 \/ 14 \/ 16 \/ 20 \/ 24/);
});

test('r192: tokens — один акцент, радиусы 4/6/8, шкала, AA-цвета', () => {
  const T = read('renderer/ui/tokens.css');
  assert.match(T, /--accent: #a78bfa;/);
  assert.match(T, /--r-1: 4px;\n  --r-2: 6px;\n  --r-3: 8px;\n  --r-4: 8px;/);
  assert.match(T, /--fs-2xs: 11px;[\s\S]*--fs-xl: 20px;[\s\S]*--fs-2xl: 24px;/);
  assert.match(T, /--shadow-1: 0 1px 2px/);
});

test('r192: design-r192.css подключён последним и задаёт правила', () => {
  const H = read('renderer/index.html');
  const D = read('renderer/ui/design-r192.css');
  assert.ok(H.indexOf('design-r192.css') > H.indexOf('ai-assistant.css'));
  assert.match(D, /:focus-visible/);
  assert.match(D, /outline: 2px solid var\(--accent\) !important/);
  assert.match(D, /text-transform: none/);
  assert.match(D, /prefers-reduced-motion/);
  assert.match(D, /\.btn\.primary/);
  assert.match(D, /border-radius: var\(--r-2\)/);
  assert.match(D, /\.badge \{ border-radius: 4px; \}/);
});

test('r192: контраст пар токенов — программная проверка AA', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools/design-contrast-r192.js')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /CONTRAST PASS/);
});

test('r192: иконки без sparkle/star/magic/wand', () => {
  const C = read('renderer/ui/commands.js');
  assert.doesNotMatch(C, /'(sparkles|star|magic|wand-sparkles|zap)'/);
  assert.match(C, /'brush-cleaning'/);
  assert.match(C, /'message-circle'/);
});
