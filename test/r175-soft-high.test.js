'use strict';
/* r175: мягкие сплаты для 589.9M в режиме «Высокое» (FPS проверен: hard 114.3 / soft 129.0 на 300M);
 * «Авто»/«Быстрое» остаются hard для >150M; fallback сохраняется. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/webgl-viewer.js'), 'utf8');

test('r195: «Высокое» — мягкие сплаты (опция), «Авто»/«Быстрое» — hard по умолчанию', () => {
  assert.match(SRC, /if \(mode === 'high'\) \{ this\._softForce = true; this\._softSplats = true; this\._softSplatsFail = false; \}/);
  assert.match(SRC, /else \{ this\._softForce = false; this\._softSplats = false; \}/);
  assert.match(SRC, /this\._softForce \|\| \(o\.count \|\| 0\) <= \(this\._softSplatsLimit \|\| 150000000\)/);
});

test('r175: fallback на hard сохраняется и для форсированных сплатов', () => {
  assert.match(SRC, /\(this\._qualityMode === 'auto' \|\| this\._softForce\) && this\._interacting/);
  assert.match(SRC, /this\._softSplatsFail = true/);
  assert.match(SRC, /webglcontextlost/);
  assert.match(SRC, /_softReset/);
});
