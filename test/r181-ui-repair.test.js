'use strict';
/* r181: проверка на текущем HEAD (после r179/r180), что гейт extraUi и санитайзер «false» живы,
 * и что сохранённый проект с надписью "false" очищается при загрузке (и перезаписывается очищенным). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const DRAW = read('renderer/lixel-draw.js');

test('r181: гейт extraUi жив — панели r145 по умолчанию не грузятся', () => {
  assert.match(APP, /function extraUiWanted\(\)/);
  assert.match(APP, /if \(extraUiWanted\(\)\) \{ ensurePerfPanel\(\); ensureLxDesign\(\); ensureP1Tools\(\); ensureSectionsP2\(\); ensureClipP3\(\); \}/);
  assert.doesNotMatch(APP, /applyRenderPrefs\(\); ensurePerfPanel\(\);\s*ensureLxDesign/);
});

test('r181: сохранённый чертёж с text:"false" санитизируется при загрузке проекта', () => {
  assert.match(DRAW, /function safeDimText\(v\)/);
  assert.match(DRAW, /var __sanitized = false;/);
  assert.match(DRAW, /__sanitized = true; e = Object\.assign\(\{\}, e, \{ text: t \}\);/);
  assert.match(DRAW, /if \(__sanitized && s\) \{ try \{ lastDrawingStateJson = ''; scheduleDrawingSave\(s\); \} catch \(_\) \{\} \}/, 'очищенный чертёж должен перезаписываться');
  assert.match(DRAW, /s\.entities = \(drawing && Array\.isArray\(drawing\.entities\)/);
  // и при отрисовке, и при импорте DXF
  assert.match(DRAW, /mkText\(tp, safeDimText\(e\.text\)/);
  assert.match(DRAW, /mkText\(mp, safeDimText\(e\.text\)/);
});
