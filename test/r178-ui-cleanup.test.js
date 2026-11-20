'use strict';
/* r178: чистка UI — по умолчанию только облако + лента; вспомогательные слои r145 опциональны;
 * «false» в 3D-вьюпорте больше не выводится (санитайзер текста размеров/надписей чертежа). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const DRAW = read('renderer/lixel-draw.js');
const D2 = read('renderer/draw2d.js');

test('r178: вспомогательные UI-слои r145 не грузятся по умолчанию', () => {
  assert.match(APP, /function extraUiWanted\(\)/, 'нет гейта дополнительных слоёв');
  assert.match(APP, /localStorage\.getItem\('bim\.extraUi'\) === '1'/, 'гейт должен читать bim.extraUi');
  assert.match(APP, /if \(extraUiWanted\(\)\) \{ ensurePerfPanel\(\); ensureLxDesign\(\); ensureP1Tools\(\); ensureSectionsP2\(\); ensureClipP3\(\); \}/, 'слои должны грузиться только под гейтом');
  assert.doesNotMatch(APP, /applyRenderPrefs\(\); ensurePerfPanel\(\)/, 'по умолчанию панели не подключаются');
  assert.match(APP, /window\.__bimEnableExtraUi/, 'должен быть способ включить слои');
  // функции слоёв сохраняются для опционального включения
  for (const fn of ['ensurePerfPanel', 'ensureLxDesign', 'ensureP1Tools', 'ensureSectionsP2', 'ensureClipP3']) {
    assert.match(APP, new RegExp('function ' + fn + '\\('), 'нет ' + fn);
  }
});

test('r178: надпись «false» в вьюпорте — санитайзер размеров/чертежа', () => {
  assert.match(DRAW, /function safeDimText\(v\)/);
  assert.ok(DRAW.includes('/^(false|true|undefined|null|NaN)$/i.test'), 'false/true/undefined не должен попадать в text');
  assert.match(DRAW, /mkText\(tp, safeDimText\(e\.text\)/, 'текстовая сущность санитизируется');
  assert.match(DRAW, /mkText\(mp, safeDimText\(e\.text\)/, 'размерная надпись санитизируется');
  assert.match(DRAW, /s\.entities = \(drawing && Array\.isArray\(drawing\.entities\)/, 'старые сохранённые сущности санитизируются при загрузке');
  assert.match(D2, /function safeTextOut\(v\)/);
  assert.match(D2, /text: safeTextOut\(e\.text\)/);
});

test('r178: лента и вкладки остаются (не сломали r130)', () => {
  assert.match(APP, /ensureLxDesign/, 'функция редизайна сохранена для опции');
  // гейт не трогает основной shell/ribbon
  assert.ok(!APP.includes("getElementById('lxTabs').style.display = 'none'"), 'лента не скрывается');
});
