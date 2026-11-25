'use strict';
/* r198: профили отображения — Классический (r177) по умолчанию, Сбалансированный, Максимум детализации. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const CMD = read('renderer/ui/commands.js');
const PRE = read('preload.js');

test('r198: профили и их параметры', () => {
  assert.match(APP, /const RENDER_PROFILES = \{/);
  assert.match(APP, /classic: \{ label: 'Классический \(r177\)', soft: true, autoBase: 3\.4, cap: 5\.0, bright: 1\.1, attenuate: false, density: 'classic', budget: 300000000 \}/);
  assert.match(APP, /balanced: \{ label: 'Сбалансированный', soft: false, autoBase: 2\.3, cap: 4\.0, bright: 1\.0, attenuate: true/);
  assert.match(APP, /max: \{ label: 'Максимум детализации', soft: false, autoBase: 2\.3, cap: 4\.5, bright: 1\.0, attenuate: true/);
});

test('r198: default — Классический; миграция rev198; localStorage/env', () => {
  assert.match(APP, /return 'classic';/);
  assert.match(APP, /localStorage\.getItem\('bim\.render\.profile'\)/);
  assert.match(APP, /bim\.uiProfileRev'\) !== '198'.*setItem\('bim\.render\.profile', 'classic'\)/);
  assert.match(PRE, /renderProfileOverride: process\.env\.BIM_RENDER_PROFILE/);
});

test('r198: бюджет по профилю и применение к viewer', () => {
  assert.match(APP, /if \(prof === 'classic'\) return 300000000;/);
  assert.match(APP, /if \(prof === 'max'\)/);
  assert.match(APP, /if \(prof === 'balanced'\)/);
  assert.match(APP, /applyProfileToViewer\(renderProfile\(\)\)/);
  assert.match(APP, /window\.__bimSetRenderProfile = function/);
});

test('r198: меню «Вид → Профиль отображения»', () => {
  assert.match(CMD, /G\('profiles', 'Профиль отображения'/);
  assert.match(CMD, /profileClassic/);
  assert.match(CMD, /__bimSetRenderProfile', args: \['classic'\]/);
  assert.match(CMD, /profileBalanced/);
  assert.match(CMD, /profileMax/);
});
