'use strict';
/* r191: старый bim.extraUi=1 больше не показывает панели; только явный пункт «Вид → Доп. панели (эксперимент)». */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const CMD = read('renderer/ui/commands.js');

test('r191: однократная миграция удаляет старый bim.extraUi и поднимает rev 191', () => {
  assert.match(APP, /function migrateUiPrefs\(\)/);
  assert.match(APP, /localStorage\.removeItem\('bim\.extraUi'\)/);
  assert.match(APP, /localStorage\.setItem\('bim\.uiRev', '191'\)/);
  assert.match(APP, /if \(!\(rev >= 191\)\)/);
  assert.match(APP, /try \{ migrateUiPrefs\(\); \} catch \(e\) \{\}/);
});

test('r191: явное включение/выключение через меню с подтверждением', () => {
  assert.match(APP, /window\.__bimSetExtraUi = function \(on\)/);
  assert.match(APP, /window\.__bimToggleExtraUiConfirm = async function/);
  assert.match(APP, /Экспериментальные панели r145/);
  assert.match(APP, /Как включить дополнительные панели|Включить дополнительные панели/);
  assert.match(CMD, /extraUiToggle/);
  assert.match(CMD, /Доп\. панели \(опыт\)/);
  assert.match(CMD, /__bimToggleExtraUiConfirm/);
});

test('r191: при выключенном extraUi скрипты слоёв не грузятся (ранний return) и нет дублей HUD', () => {
  for (const fn of ['ensurePerfPanel', 'ensureLxDesign', 'ensureP1Tools', 'ensureSectionsP2', 'ensureClipP3']) {
    assert.match(APP, new RegExp('function ' + fn + '\\(\\) \\{ if \\(!extraUiWanted\\(\\)\\) return;'), fn + ' без гейта');
  }
  assert.match(APP, /document\.querySelectorAll\('#lxVramHud'\)/);
  assert.match(APP, /for \(let i = 1; i < dup\.length; i\+\+\)/);
});
