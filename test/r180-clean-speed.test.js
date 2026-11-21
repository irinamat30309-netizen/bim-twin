'use strict';
// r180: ускорение чистовой обработки — dense-профиль (>50M: thin off, денойз цвета не включаем), ETA плиток, тайминги.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const RP = require('../scan-refine-parallel');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r180: denseCleanProfile — для >50M thin выключен, денойз цвета по умолчанию выключен', () => {
  const big = RP.denseCleanProfile(589864631, {});
  assert.strictEqual(big.dense, true);
  assert.strictEqual(big.thin, false);
  assert.strictEqual(big.degrain, false);
  const small = RP.denseCleanProfile(14526734, {});
  assert.strictEqual(small.dense, false);
  assert.strictEqual(small.thin, true);
  assert.strictEqual(small.degrain, true);   // для небольших облаков поведение прежнее (degrain можно выключить опцией)
  // явные опции важнее профиля
  assert.strictEqual(RP.denseCleanProfile(589864631, { thin: true }).thin, false);  // плотный профиль всё равно thin=false
  assert.strictEqual(RP.denseCleanProfile(589864631, { degrain: true }).degrain, true);
  assert.strictEqual(RP.denseCleanProfile(589864631, { denseThreshold: 600e6 }).dense, false);
});

test('r180: стадийные тайминги и ETA в чистовой обработке', () => {
  const rp = read('scan-refine-parallel.js');
  assert.match(rp, /function denseCleanProfile/);
  assert.match(rp, /denseProfileUsed = true/);
  assert.match(rp, /Обработка плиток… ' \+ Math\.round\(frac \* 100\)/);
  assert.match(rp, /prepareMs, tilesMs, workerMs/);
  assert.match(rp, /stageMs/);
  const core = read('scan-refine-core.js');
  assert.match(core, /_stageTimings/);
  assert.match(core, /stageMs: st/);
  const tw = read('scan-refine-tile-worker.js');
  assert.match(tw, /stageMs: r\.stageMs/);
});

test('r180: дефолт опций чистки — денойз цвета не включается, thin для плотных отключается в RP', () => {
  const RP2 = require('../scan-refine-parallel');
  // degrain не включается (r180: денойз цвета не включать), tile-worker это понимает
  const tw = read('scan-refine-tile-worker.js');
  assert.match(tw, /opt\.degrain === false/);
  assert.ok(RP2.denseCleanProfile);
});
