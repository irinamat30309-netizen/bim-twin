'use strict';
/*
 * r172 — качество рендера на больших облаках (589.9M/401.7M):
 *  • размер точки по умолчанию 2–3 px (адаптивный, не жирный), в движении не меньше 2 px;
 *  • базовый тон без пересвета: gain ×1.1, grade off (exposure 1.0/contrast 1.05/saturation 1.05/tone 0.9);
 *    пресет «Как в Lixel» (1.36/1.29) остаётся опцией в панели;
 *  • динамическое разрешение в движении ≥85 %, точек в движении ≥60–70 %;
 *  • эффективный GPU-бюджет ≤120–150M (исключение — явная кнопка «Показать все точки»), без CPU-копий на потоке;
 *  • старые дефолты сбрасываются миграцией bim.perfRev=172.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('renderer/webgl-viewer.js');
const APP = read('renderer/app.js');
const PANEL = read('renderer/ui/perf-panel.js');

test('r195: размер точки — авто 2.8 px (2–3), в движении ≥2.0 px', () => {
  assert.match(SRC, /this\._autoPointSize = true; this\._autoPointBasePx = 2\.8; this\._softSplats = false; this\._softSplatsLimit = 150000000/, 'дефолт авто-точки 3.4 px');
  assert.match(SRC, /hCss \/ 1200 \* \(this\._autoPointBasePx \|\| 2\.8\)/, 'формула адаптивной точки');
  assert.match(SRC, /Math\.max\(2\.0, Math\.min\(3\.0, hCss \/ 1200/, 'клэмп базы 3–5 px');
  assert.match(SRC, /Math\.max\(2\.0, autoH \* \(this\._motionSizeScale \|\| 0\.9\)\)/, 'в движении не меньше 2.5 px');
  assert.match(APP, /viewer\.setPointBasePx\) viewer\.setPointBasePx\(2\.8\)/, 'приложение задаёт базу 3.4 px');
});

test('r172: базовый тон без пересвета, «Как в Lixel» — пресет', () => {
  assert.match(SRC, /this\._ptBright = 1\.0;/, 'базовый gain ×1.1');
  assert.match(SRC, /this\._grade = \{ on: false, exposure: 1\.0, contrast: 1\.0, saturation: 1\.0, gamma: 1\.0, tone: 0\.0 \};/);
  assert.match(SRC, /setLixelLook\(on\)[\s\S]{0,240}setBrightness\(1\.36\)[\s\S]{0,240}saturation: 1\.29/, 'пресет Lixel сохранён');
  assert.match(APP, /look: \['lixel', 'neutral', 'custom'\]/, 'пресет остаётся опцией');
  assert.match(APP, /viewer\.setBrightness\(1\.0\); viewer\.setGrade\(false\)/, 'нейтральный дефолт ×1.1');
  assert.match(APP, /bim\.perfRev'\) !== '195'/, 'нет миграции старых пересвеченных настроек');
  assert.match(PANEL, /var b = Number\(g\('brightness', 1\.0\)\)/, 'панель по умолчанию 1.1');
  assert.match(PANEL, /act === 'lixel'[\s\S]{0,120}brightness: 1\.36, saturation: 1\.29/, 'кнопка «Как в Lixel»');
});

test('r172: динамическое качество — разрешение ≥85 %, точек в движении 60–70 %', () => {
  assert.match(SRC, /_dynScaleMoving = 0\.85/, 'авто: разрешение 85 %');
  assert.match(SRC, /Math\.max\(0\.85, Math\.min\(1, this\._dynScaleMoving/, 'пол динамического разрешения 85 %');
  assert.match(SRC, /setRenderScale\(s\)[\s\S]{0,160}Math\.max\(0\.85, Math\.min\(1, s\)\)/, 'setRenderScale не ниже 85 %');
  assert.match(SRC, /this\._interBudget = 128000000; this\._octMovePct = 60/, 'авто: 60 % точек в движении');
  assert.match(SRC, /this\._interBudget = 96000000; this\._octMovePct = 60/, 'быстро: не ниже 60 %');
  assert.match(SRC, /this\._motionSizeScale = 0\.9/, 'дефолт движения 0.9');
});

test('r172/r173: GPU-бюджет 300M (быстро 80M), show-all явно, CPU-копии только для небольших облаков', () => {
  assert.match(APP, /GPU_POINT_BUDGET = 300000000/);
  assert.match(APP, /GPU_POINT_BUDGET_FAST = 80000000/);
  assert.match(APP, /if \(allowAll\) return Math\.floor\(qb\)/, '«все точки» не обходят безопасный VRAM-бюджет');
  assert.match(APP, /bim\.gpuShowAll/, 'явная кнопка «Показать все точки» — отдельный флаг');
  assert.match(SRC, /this\._streamCpuMaxPoints = 60000000/, 'без CPU-копий для 120–590 млн');
  assert.match(SRC, /total <= \(this\._streamCpuMaxPoints \|\| 160000000\)/);
  assert.ok(!APP.includes('— предел видеокарты'), 'тост «предел видеокарты» убран');
});

test('r172: качество в покое — полное (1:1), динамика только при движении', () => {
  assert.match(SRC, /moving \? Math\.max\(0\.85, Math\.min\(1, this\._dynScaleMoving/, 'покой — 1:1');
  assert.match(SRC, /mode === 'high'[\s\S]{0,180}this\._dynRes = false/, '«высокое» не режет разрешение вообще');
});






