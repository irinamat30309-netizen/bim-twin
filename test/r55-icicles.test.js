'use strict';
// Ревизия 55: «сосульки» — редкая вертикальная бахрома под кромками навесов/окон. Фильтр убирает её, но обязан
// сохранять трубы, кабели и стойки; проверяется и то, что фильтр включён в чистовую обработку.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scan-refine-core');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// сцена: козырёк z = 3 (плита 4 × 3 м), под его кромкой y ≈ 2 — РЕДКАЯ «бахрома» (5 см в ширину, 25 см вниз, ~2 точки/см),
// рядом вертикальный кабель (1 см, плотный — 7 точек/см) и горизонтальная труба Ø10 см на 60 см ниже козырька
function scene() {
  const P = [];
  const push = (x, y, z, t) => P.push([x, y, z, t]);
  for (let i = 0; i < 400; i++) for (let j = 0; j < 300; j++) push(i * 0.01, j * 0.01, 3 + (rnd() - 0.5) * 0.002, 1);   // козырёк
  for (let k = 0; k < 55; k++) {                                                                                        // редкая бахрома под кромкой
    const z = 3 - 0.01 - rnd() * 0.25, y = 2 - 0.05 + rnd() * 0.05;
    push(2 + (rnd() - 0.5) * 0.01, y, z, 2);
  }
  for (let k = 0; k < 420; k++) push(1, 1, 3 - 0.01 - k * 0.0014, 3);                                                   // вертикальный кабель: 7 точек/см
  for (let k = 0; k < 400; k++) { const a = k / 400 * Math.PI * 2; push(3 + 0.05 * Math.cos(a), 1 + 0.05 * Math.sin(a), 2.4, 4); }   // труба
  for (let k = 0; k < 200; k++) { const a = k / 200 * Math.PI * 2; push(3.2 + 0.05 * Math.cos(a), 1 + 0.05 * Math.sin(a), 2.4 + 0.02, 4); }
  const n = P.length, X = new Float64Array(n * 3), T = new Float64Array(n);
  P.forEach((p, i) => { X[i * 3] = p[0]; X[i * 3 + 1] = p[1]; X[i * 3 + 2] = p[2]; T[i] = p[3]; });
  return { X, T, n };
}

test('r55: «сосульки» под кромкой убираются, труба, кабель и козырёк остаются', () => {
  const S = scene(), X = S.X, n = S.n, alive = new Uint8Array(n).fill(1);
  const total = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let i = 0; i < n; i++) total[S.T[i]]++;
  const rm = R.fixIcicles(X, n, alive, {});
  const gone = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let i = 0; i < n; i++) if (!alive[i]) gone[S.T[i]]++;
  assert.ok(total[2] > 40, 'бахрома была: ' + total[2]);
  assert.ok(gone[2] > total[2] * 0.5, 'бахрома убрана: ' + gone[2] + ' из ' + total[2]);
  assert.ok(gone[1] <= 5, 'козырёк цел: снято ' + gone[1]);
  assert.strictEqual(gone[3], 0, 'кабель цел: снято ' + gone[3]);
  assert.strictEqual(gone[4], 0, 'труба цела: снято ' + gone[4]);
  assert.ok(rm > 30 && rm < 200, 'снято всего: ' + rm);
});

test('r55: «сосульки» включаются опцией и подключены к чистовой обработке', () => {
  const core = read('scan-refine-core.js');
  assert.match(core, /if \(opt\.icicles\) \{ const before/, 'вызов в processTile по опции');
  assert.match(core, /function fixIcicles\(X, n, alive, o\)/, 'функция есть');
  assert.match(core, /fixFringe, fixIcicles,/, 'экспортируется');
  assert.match(read('scan-refine-parallel.js'), /'icicles'/, 'пул плиток передаёт опцию');
});
