'use strict';
// Ревизия 55: опытный фильтр «слой за стеклом» — тонкая параллельная плёнка в 3–10 см позади плотной плоскости
// (отражение в стекле). Проверяем, что плёнка убирается, а стена, откос и труба перед стеклом остаются.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scan-refine-core');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function scene() {
  const P = [];
  const push = (x, y, z, t) => P.push([x, y, z, t]);
  for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) push((rnd() - 0.5) * 0.002, j * 0.005, i * 0.005, 1);            // стена x = 0
  for (let i = 0; i < 200; i += 2) for (let j = 0; j < 200; j += 2) push(0.06 + (rnd() - 0.5) * 0.002, j * 0.005, i * 0.005, 2); // плёнка 6 см за стеклом (25 % плотности)
  for (let k = 0; k < 200; k++) for (let j = 0; j < 100; j++) push(k * 0.001, 0.5 + (rnd() - 0.5) * 0.002, j * 0.005, 3);      // откос: перпендикулярно стене, 0…20 см
  for (let k = 0; k < 300; k++) { const a = rnd() * Math.PI * 2; push(-0.05 + 0.05 * Math.cos(a), 0.3 + 0.05 * Math.sin(a), 0.7 + rnd() * 0.3, 4); }   // труба перед стеклом
  const n = P.length, X = new Float64Array(n * 3), T = new Uint8Array(n);
  P.forEach((p, i) => { X[i * 3] = p[0]; X[i * 3 + 1] = p[1]; X[i * 3 + 2] = p[2]; T[i] = p[3]; });
  return { X, T, n };
}

test('r55: тонкая плёнка за стеклом убирается, стена, откос и труба остаются', () => {
  const S = scene(), X = S.X, n = S.n, alive = new Uint8Array(n).fill(1);
  const total = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let i = 0; i < n; i++) total[S.T[i]]++;
  const rm = R.fixGlass(X, n, alive, {});
  const gone = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let i = 0; i < n; i++) if (!alive[i]) gone[S.T[i]]++;
  assert.ok(total[2] > 5000, 'плёнка была: ' + total[2]);
  assert.ok(gone[2] > total[2] * 0.6, 'плёнка убрана: ' + gone[2] + ' из ' + total[2]);
  assert.ok(gone[1] < total[1] * 0.05, 'стена цела: снято ' + (100 * gone[1] / total[1]).toFixed(1) + ' %');
  assert.ok(gone[3] < total[3] * 0.10, 'откос цел: снято ' + (100 * gone[3] / total[3]).toFixed(1) + ' %');
  assert.ok(gone[4] < total[4] * 0.10, 'труба цела: снято ' + (100 * gone[4] / total[4]).toFixed(1) + ' %');
  assert.ok(rm > 5000, 'снято всего: ' + rm);
});

test('r55: «слой за стеклом» — включён по умолчанию и доходит до обработки', () => {
  const core = read('scan-refine-core.js');
  assert.match(core, /if \(opt\.glass\) \{ const before/, 'вызов в processTile по опции');
  assert.match(core, /function fixGlass\(X, n, alive, o\)/, 'функция есть');
  assert.match(core, /fixIcicles, fixGlass,/, 'экспортируется');
  assert.match(read('scan-refine-parallel.js'), /'glass'/, 'пул плиток передаёт опцию');
  assert.match(read('main.js'), /icicles: a\.icicles === true, glass: a\.glass === true/, 'main передаёт обе опции');
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /key: 'glass', label: 'Убрать слой за стеклом \(отражения в окнах\)', type: 'checkbox', value: true/, 'галочка в окне, включена по умолчанию');
  assert.match(ui, /key: 'icicles', label: 'Убрать «сосульки» под кромками навесов и окон'/, 'вторая галочка');
  assert.match(ui, /icicles: !!values\.icicles, glass: !!values\.glass/, 'выбор окна уходит в обработку');
});
