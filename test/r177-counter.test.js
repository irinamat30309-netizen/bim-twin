'use strict';
/* r177: счётчик «Показано X из Y» не должен превышать файл. Причина 845M при файле 589.9M —
 * суммирование count по всем объектам base (при повторной подгрузке/soft-переключении); теперь только
 * основное облако base[0], с клэмпом к sourceCount и к total потока. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/webgl-viewer.js'), 'utf8');

test('r177: getCloudInfo считает только основное облако и клэмпит к sourceCount', () => {
  assert.match(SRC, /const ptsObjs = this\.base\.filter\(o => o\.points\);/);
  assert.match(SRC, /const mainObj = \(ptsObjs\[0\] === this\.base\[0\]/);
  assert.match(SRC, /loadedCount = Math\.min\(loadedCount, srcCount\)/);
  assert.match(SRC, /loadedCount: loadedCount,/);
  assert.doesNotMatch(SRC, /loadedCount:this\.base\.filter\(o=>o\.points\)\.reduce/);
});

test('r177: потоковый счётчик не превышает total сегментов', () => {
  assert.match(SRC, /bo\._gpuCount = Math\.min\(start \+ n, \(bo\._stream && bo\._stream\.total\) \|\| \(start \+ n\)\)/);
  assert.match(SRC, /const loadedRaw = bo\._gpuCount \| 0, total = bo\._stream\.total;/);
  assert.match(SRC, /const loaded = Math\.min\(loadedRaw \|\| 0, total \|\| loadedRaw \|\| 0\)/);
});
