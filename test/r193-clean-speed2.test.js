'use strict';
// r193: регрессия скорости чистовой — параллелизм не должен падать до 1 потока при занятой памяти,
// ETA/прогресс по фактическому времени плиток, упрощение цветовой стадии для плотных облаков.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const RP = require('../scan-refine-parallel');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r193: при малой свободной памяти уменьшается плитка, а не число потоков', () => {
  const o = { _freeMem: 2.5 * 1073741824, _cpus: 6, tileMax: 4000000, _bigCloud: true };
  RP.fitTileMaxToMemory(o);
  assert.ok(o.tileMax < 4000000, 'плитка уменьшена: ' + o.tileMax);
  const threads = RP.pickThreads(o, 300, o.tileMax);
  assert.ok(threads >= 2, 'потоков должно быть больше одного: ' + threads);
  assert.ok(threads <= 6, 'не больше числа ядер: ' + threads);
  // при нормальной памяти размер плитки не режем
  const n = { _freeMem: 11 * 1073741824, _cpus: 6, tileMax: 4000000, _bigCloud: true };
  RP.fitTileMaxToMemory(n);
  assert.strictEqual(n.tileMax, 4000000);
});

test('r193: большие облака используют все ядра (main-поток ждёт), малые — CPU−1', () => {
  const big = { _freeMem: 11 * 1073741824, _cpus: 6, _bigCloud: true };
  assert.strictEqual(RP.pickThreads(big, 300, 4000000), 6);
  const small = { _freeMem: 11 * 1073741824, _cpus: 6 };
  assert.strictEqual(RP.pickThreads(small, 300, 4000000), 5);
});

test('r193: passEq отключается для плотных облаков без проходов; опции цвета проброшены', () => {
  const rp = read('scan-refine-parallel.js');
  assert.match(rp, /colorSimplify = 'no-multipass'/);
  assert.match(rp, /opt\.passEq = false/);
  assert.match(rp, /fitTileMaxToMemory/);
  assert.match(rp, /_bigCloud/);
  assert.match(rp, /'fringe', 'speckles'/);
  const core = read('scan-refine-core.js');
  assert.match(core, /opt\.fringe !== false/);
  assert.match(core, /o\.speckles === false/);
});

test('r193: ETA/прогресс — по фактическому времени плиток, fallback не в один поток', () => {
  const w = read('scan-refine-worker.js');
  assert.match(w, /meta\.stage === 'tiles'/);
  assert.match(w, /elapsed \/ \(elapsed \+ eta\)/);
  assert.match(w, /meta\.stage === 'prepare'/);
  assert.match(w, /send\(0\.08 \* f/);
  assert.doesNotMatch(w, /threads: 1/);
  assert.match(w, /tileMax: 600000/);
});
