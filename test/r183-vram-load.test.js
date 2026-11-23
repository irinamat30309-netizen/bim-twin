'use strict';
/* r183: VRAM-адаптивный бюджет под 12 ГБ, параллельное чтение сегментов, крупные сегменты/IPC,
 * индикатор VRAM в HUD. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const MAIN = read('main.js');
const CFG = require('../app-config.js');

test('r183: бюджет из реальной VRAM (12 ГБ): Авто 78 %, Высокое 85 %, полный файл по capacity', () => {
  assert.match(APP, /window\.__bimPcCapacityReady = \(async function/);
  assert.match(APP, /const byVram = gpuBudgetPoints\(q === 'high' \? 0\.80 : 0\.78\)/);
  assert.match(APP, /GPU_BYTES_PER_POINT = 24/);
  assert.match(APP, /window\.__bimPcCapacity = r/);
  assert.match(APP, /API\.systemCapacity\(\{\}\)/);
});

test('r183: параллельное чтение (3 в полёте), крупные сегменты 32M, IPC 8M, первый сегмент 2M', () => {
  assert.match(APP, /const READ_AHEAD = 3; const reads = \[\];/);
  assert.match(APP, /for \(let w = 0; w < Math\.min\(READ_AHEAD, nParts\); w\+\+\) reads\[w\] = readPart\(w\);/);
  assert.match(APP, /reads\[k \+ READ_AHEAD\] = readPart\(k \+ READ_AHEAD\)/);
  assert.match(APP, /segPoints: 32000000/);
  assert.match(APP, /firstSegPoints: 2000000/);
  assert.strictEqual(CFG.IPC_CHUNK_POINTS, 8000000);
  assert.match(MAIN, /payload\.segPoints/);
  assert.match(MAIN, /d\.segPoints = reqSeg/);
});

test('r183: индикатор VRAM в HUD обновляется по облаку/бюджету', () => {
  assert.match(APP, /function ensureVramHud\(\)/);
  assert.match(APP, /function updateVramHud\(\)/);
  assert.match(APP, /lxVramHud/);
  assert.match(APP, /n \* GPU_BYTES_PER_POINT \+ 512 \* 1048576/);
  assert.match(APP, /бюджет ' \+ \(budget \/ 1e6\)\.toFixed\(0\)/);
  assert.match(APP, /ensureVramHud\(\);/);
});
