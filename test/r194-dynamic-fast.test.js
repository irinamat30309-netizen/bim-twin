'use strict';
// r194: быстрый профиль dynamic для больших облаков (>200M), UI-выбор профиля, прогресс.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const D = require('../dynamic-clean-core');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r194: autoProfile — >200M включает быстрый профиль, exact/малые не трогает', () => {
  const f = D.autoProfile(637e6, {});
  assert.strictEqual(f.profile, 'fast');
  assert.ok(f.voxel >= 0.2 && f.voxel <= 0.25, 'voxel ' + f.voxel);
  assert.ok(f.rayStep >= 8 && f.rayStep <= 12, 'rayStep ' + f.rayStep);
  assert.ok(f.radius >= 25 && f.radius <= 32, 'radius ' + f.radius);
  const ex = D.autoProfile(637e6, { dynProfile: 'exact' });
  assert.strictEqual(ex.profile, 'exact');
  assert.strictEqual(ex.voxel, undefined, 'точный профиль не подменяет параметры');
  const small = D.autoProfile(66e6, {});
  assert.strictEqual(small.profile, 'normal');
  assert.strictEqual(small.voxel, undefined);
  // явный пользовательский параметр важнее авто-профиля
  const keep = D.autoProfile(637e6, { voxel: 0.1 });
  assert.strictEqual(keep.voxel, 0.1);
});

test('r194: штатная чистовая использует autoProfile и пробрасывает dynProfile из UI/main', () => {
  const w = read('scan-refine-worker.js');
  assert.match(w, /D\.autoProfile/);
  assert.match(w, /dynProfile: o\.dynProfile/);
  assert.match(w, /dynStats\.profile/);
  assert.match(w, /\(быстро\)/);
  const main = read('main.js');
  assert.match(main, /dynProfile: a\.dynProfile === 'exact' \? 'exact' : 'auto'/);
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /key: 'dynProfile'/);
  assert.match(ui, /Быстро — рекомендуется для больших облаков/);
  assert.match(ui, /dynProfile: values\.dynProfile === 'exact' \? 'exact' : 'auto'/);
});
