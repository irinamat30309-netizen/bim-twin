'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'renderer');
const ui = fs.readFileSync(path.join(root, 'lixel-ui.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'lixel-workspace.js'), 'utf8');
const tools = fs.readFileSync(path.join(root, 'lixel-tools-ext.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'lixel-ui-refresh.css'), 'utf8');

test('primary commands are separated into import, cloud, measurement, view, tour, and control tabs', () => {
  for (const [tab, label] of [
    ['home', 'Импорт'], ['process', 'Облако'], ['measure', 'Измерения'],
    ['tool', 'Вид'], ['tour', '3D-модели'], ['analysis', 'Контроль']
  ]) {
    assert.ok(ui.includes(`id: '${tab}'`) && ui.includes(label), `missing ${tab} tab`);
  }
  assert.match(ui, /moveToGroup\(tbtns,\s*\['btnMeasure'\][\s\S]*?'measure'/);
  assert.match(ui, /moveToGroup\(tbtns,\s*\['tsSplatTop', 'tsSplatLcc2', 'lcc2FolderInput'\][\s\S]*?'tour'/);
  assert.match(ui, /moveToGroup\(tbtns,\s*\['btnBackRoom'\][\s\S]*?'object'/);
});

test('point-cloud operations, view controls, and analysis actions route to their functional tabs', () => {
  assert.match(tools, /ensureGroup\('lxToolExtInstrument', 'process'/);
  assert.match(tools, /ensureGroup\('lxToolExtApp', 'analysis'/);
  assert.match(workspace, /group\('lxProcessTools','process'/);
  assert.match(workspace, /group\('lxViewTools','tool'/);
  assert.match(workspace, /group\('lxTourModels','tour'/);
});

test('refreshed ribbon uses readable hit areas and visible keyboard focus', () => {
  assert.match(styles, /\.lx-tab\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.lx-bigbtn[^}]*min-height:\s*88px/s);
  assert.match(styles, /height:\s*130px\s*!important/);
  assert.match(styles, /width:\s*92px\s*!important/);
  assert.match(styles, /\.lx-dock-row \.btn-sm\s*\{[^}]*width:\s*44px\s*!important/s);
  assert.match(styles, /\.lx-dock-row \.btn-sm\s*\{[^}]*height:\s*44px\s*!important/s);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /overflow-x:\s*auto/);
  assert.match(styles, /#uiGrid:empty::before/);
  assert.match(ui, /setAttribute\('role', 'tab'\)/);
  assert.match(ui, /setAttribute\('aria-selected', String\(active\)\)/);
});