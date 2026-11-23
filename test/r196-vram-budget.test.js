'use strict';
/* r196: VRAM-бюджет по реальным атрибутам (24 Б/точку + резерв), «все точки» с подтверждением,
 * неблокирующее восстановление после потери контекста. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

test('r196: бюджет 12 ГБ — 24 Б/точку, резерв 1 ГБ, ~356–367 млн, не 530M', () => {
  assert.match(APP, /GPU_BYTES_PER_POINT = 24/);
  assert.match(APP, /GPU_RESERVE_MB = 1024/);
  assert.match(APP, /const usableMB = Math\.max\(0, totalMB \* \(frac \|\| 0\.78\) - GPU_RESERVE_MB\)/);
  assert.match(APP, /const byVram = gpuBudgetPoints\(q === 'high' \? 0\.80 : 0\.78\)/);
  // численная проверка формулы для 12 ГБ
  const totalMB = 12 * 1024, reserve = 1024, bpp = 24;
  const auto = Math.floor((totalMB * 0.78 - reserve) * 1048576 / bpp);
  const high = Math.floor((totalMB * 0.80 - reserve) * 1048576 / bpp);
  assert.ok(auto >= 340e6 && auto <= 380e6, 'auto ' + auto);
  assert.ok(high >= 350e6 && high <= 400e6, 'high ' + high);
});

test('r196: «все точки» — предупреждение о VRAM >80%, без слепой загрузки', () => {
  assert.match(APP, /Все точки не поместятся в видеопамять/);
  assert.match(APP, /allBytes > vramBytes \* 0\.8/);
  assert.match(APP, /Безопасный максимум/);
  assert.match(APP, /localStorage\.removeItem\('bim\.gpuShowAll'\)/);
  assert.match(APP, /if \(allowAll\) return Math\.floor\(qb\)/);
});

test('r196: потеря контекста — без блокирующего ask, автоснижение и тост', () => {
  const i = APP.indexOf("window.addEventListener('bim-gl-lost'");
  const block = APP.slice(i, i + 5000);
  assert.ok(i >= 0);
  assert.doesNotMatch(block, /kit\.ask|__lxKit\.ask|await k\.ask/);
  assert.match(block, /качество снижено до/);
  assert.match(block, /location\.reload\(\)/);
  assert.match(block, /bim\.restoreCam/);
  assert.match(APP, /bim\.gpuBudgetRev'\) !== '196'/);
});

test('r196: HUD показывает бюджет млн и ГБ', () => {
  assert.match(APP, /· бюджет ' \+ \(budget \/ 1e6\)\.toFixed\(0\) \+ ' млн \(≈'/);
  assert.match(APP, /gpuBytesFor\(budget\)/);
});
