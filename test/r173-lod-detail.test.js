'use strict';
/*
 * r173 — детализация при 589.9M: LOD_DRAW_BUDGET 80M→300M по режимам качества,
 * «Авто» адаптивно по FPS (≥60 → до 100 % точек), «Быстрое» 80M, «Высокое» без потолка;
 * GPU-бюджет 300M (быстро 80M), стенд-переопределение BIM_RENDER_BUDGET, show-all явно.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CFG = require('../app-config.js');
const APP = read('renderer/app.js');
const SRC = read('renderer/webgl-viewer.js');
const PRE = read('preload.js');

test('r173: LOD_DRAW_BUDGET 300M, режимы качества 80/300/без потолка', () => {
  assert.strictEqual(CFG.LOD_DRAW_BUDGET, 300000000);
  assert.match(APP, /q === 'fast' \? 80000000 : \(q === 'high' \? 2000000000 : capCfg\)/);
  assert.match(SRC, /setLodBudget\(mode === 'fast' \? fastCap : \(mode === 'high' \? 2000000000 : autoCap\)\)/);
  assert.match(SRC, /const fastCap = 80000000, autoCap = \(typeof window !== 'undefined' && window\.APP_CONFIG/);
});

test('r173: GPU-бюджет авто/высокое 300M, быстро 80M, стенд-переопределение', () => {
  assert.match(APP, /GPU_POINT_BUDGET = 300000000/);
  assert.match(APP, /GPU_POINT_BUDGET_FAST = 80000000/);
  assert.match(APP, /const byVram = gpuBudgetPoints\(q === 'high' \? 0\.80 : 0\.78\);/);
  assert.match(APP, /API\.renderBudgetOverride/);
  assert.match(PRE, /BIM_RENDER_BUDGET/);
  assert.match(APP, /bim\.gpuBudgetRev'\) !== '196'/);
});

test('r173: «Авто» адаптивно поднимает точки при ≥60 FPS и не опускает ниже 60 %', () => {
  assert.match(SRC, /if \(this\._qualityMode === 'auto' && this\._interacting\)/);
  assert.match(SRC, /fps >= 58 && pct < 100.*_octMovePct = Math\.min\(100, pct \+ 2\)/s);
  assert.match(SRC, /fps < 45 && pct > 60.*_octMovePct = Math\.max\(60, pct - 2\)/s);
  assert.match(SRC, /_perfProfile === 'max' \? 20 : 16\.5/, 'цель авто ≈60 FPS (16.5 мс)');
});

test('r173: «Показать все точки файла» — явный флаг и open allPoints без прореживания', () => {
  assert.match(APP, /localStorage\.setItem\('bim\.gpuShowAll', '1'\)/);
  assert.match(APP, /opts\.allPoints \? \{ allPoints: true \}/);
  assert.match(APP, /if \(extra && extra\.allPoints\) pre = \{ maxPoints: 0 \}/);
  assert.match(APP, /__bimShowAllPoints[\s\S]{0,4000}allPoints: true/);
});

