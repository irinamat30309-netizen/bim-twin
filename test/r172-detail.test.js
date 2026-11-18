'use strict';
// r172: detail-preset сборки (полная плотность, без edge/sky/balance) + CLI для приоритетных облаков.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r172: detail-preset в xbin-lidar — edge/sky/balance off, step=1, maxPoints не режет', () => {
  const xl = read('xbin-lidar.js');
  assert.match(xl, /fusion: 'auto', detail: false, cleanOutliers: false \};/);
  assert.match(xl, /if \(o\.detail === true\) \{/);
  assert.match(xl, /o\.edge = false; o\.sky = false; o\.balance = false; o\.step = 1;/);
  assert.match(xl, /o\.maxPoints = 2000000000;/);
});

test('r172: tools/xbin-detail-build.js — сборка с detail:true и отчётом о числе точек', () => {
  const tool = read('tools/xbin-detail-build.js');
  assert.match(tool, /opt\.detail = true/);
  assert.match(tool, /XL\.build\(xbin, poses, outLas, opt/);
  assert.match(tool, /points: r\.points/);
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'xbin-detail-build.js')));
});

test('r172: обычная сборка не затронута — detail по умолчанию выключен', () => {
  const XL = require('../xbin-lidar');
  assert.strictEqual(XL.DEF.detail, false);
  assert.strictEqual(XL.DEF.edge, true);   // обычные сборки сохраняют прежний edge-фильтр
});
