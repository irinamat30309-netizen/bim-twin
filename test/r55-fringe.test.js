'use strict';
// Ревизия 55: «сиреневая кайма» на резких краях (хроматическая аберрация камеры) убирается, а крупный фиолетовый
// предмет остаётся; точка с фиолетовым цветом сама по себе (без соседей) не считается каймой.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scan-refine-core');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function wall() {
  const SP = 0.005, N = Math.round(1 / SP), n = N * N;
  const X = new Float64Array(n * 3), C = new Float32Array(n * 3);
  let k = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const y = (j + 0.5) * SP, z = (i + 0.5) * SP;
    X[k * 3] = 0; X[k * 3 + 1] = y; X[k * 3 + 2] = z;
    C[k * 3] = 200; C[k * 3 + 1] = 200; C[k * 3 + 2] = 200;
    k++;
  }
  return { X, C, n, SP, N };
}
const MAG = [255, 30, 250];
const isMag = (C, i) => C[i * 3] - C[i * 3 + 1] > 25 && C[i * 3 + 2] - C[i * 3 + 1] > 25;

test('r55: тонкая сиреневая кайма убирается, крупное фиолетовое пятно остаётся', () => {
  const W = wall(), X = W.X, C = W.C, n = W.n, alive = new Uint8Array(n).fill(1);
  // кайма: одна строка по z = 0,500 (ширина 5 мм) через всю стену
  for (let i = 0; i < n; i++) if (Math.abs(X[i * 3 + 2] - 0.5) < 0.003) { C[i * 3] = MAG[0]; C[i * 3 + 1] = MAG[1]; C[i * 3 + 2] = MAG[2]; }
  // пятно 20 × 20 см (настоящий фиолетовый объект)
  for (let i = 0; i < n; i++) { const y = X[i * 3 + 1], z = X[i * 3 + 2]; if (y > 0.2 && y < 0.4 && z > 0.2 && z < 0.4) { C[i * 3] = MAG[0]; C[i * 3 + 1] = MAG[1]; C[i * 3 + 2] = MAG[2]; } }
  let lineBefore = 0, patchBefore = 0;
  for (let i = 0; i < n; i++) if (isMag(C, i)) { const y = X[i * 3 + 1], z = X[i * 3 + 2]; if (y > 0.2 && y < 0.4 && z > 0.2 && z < 0.4) patchBefore++; else lineBefore++; }
  const fixed = R.fixFringe(X, C, n, alive, {});
  let lineAfter = 0, patchAfter = 0;
  for (let i = 0; i < n; i++) if (isMag(C, i)) { const y = X[i * 3 + 1], z = X[i * 3 + 2]; if (y > 0.2 && y < 0.4 && z > 0.2 && z < 0.4) patchAfter++; else lineAfter++; }
  assert.ok(lineBefore > 100, 'кайма была: ' + lineBefore);
  assert.ok(lineAfter < lineBefore * 0.25, 'кайма убрана: ' + lineBefore + ' → ' + lineAfter);
  assert.ok(patchAfter > patchBefore * 0.9, 'пятно осталось: ' + patchBefore + ' → ' + patchAfter);
  assert.ok(fixed > 100, 'исправлено точек: ' + fixed);
  // исправленные стали серыми
  for (let i = 0; i < n; i++) if (Math.abs(X[i * 3 + 2] - 0.5) < 0.003) {
    assert.ok(Math.abs(C[i * 3] - 200) < 25, 'цвет каймы заменён на цвет стены: ' + C[i * 3]);
    break;
  }
});

test('r55: кайма подключена к чистовой обработке', () => {
  const core = read('scan-refine-core.js');
  assert.match(core, /nColor \+= fixFringe\(X, RGB, n, alive, opt\.fringeOpt \|\| \{\}\)/, 'вызов в processTile');
  assert.match(core, /function fixFringe\(X, RGB, n, alive, o\)/, 'функция есть');
  assert.match(core, /fixSpeckles, fixFringe,/, 'экспортируется');
});
