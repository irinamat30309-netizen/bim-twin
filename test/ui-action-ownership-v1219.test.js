'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const UI1208 = fs.readFileSync(path.join(R, 'ui-v1208.js'), 'utf8');
const UI1213 = fs.readFileSync(path.join(R, 'ui-v1213.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const S2B = fs.readFileSync(path.join(R, 'scan2bim-ai-client.js'), 'utf8');
const SCAN_UI = fs.readFileSync(path.join(R, 'lixel-scan2bim-ui.js'), 'utf8');

test('v1219 action dock reparents only known launcher buttons', () => {
  const match = UI1208.match(/function dock\(\)\{[\s\S]*?\}let fitSig=/);
  assert.ok(match, 'viewport launcher dock implementation missing');
  const dock = match[0];
  for (const id of ['lxScan2BimBtn', 'lxScan2BimAiBtn', 'lxObjInspectBtn', 'lxObjExtractBtn']) {
    assert.ok(dock.includes(id), `launcher ${id} must be explicitly owned`);
  }
  assert.ok(dock.includes("closest('#lxRibbonActions')"), 'must leave already-ribboned actions in place');
  assert.doesNotMatch(dock, /document\.querySelectorAll\(['"]button['"]\)/, 'must not steal similarly labelled buttons from panels');
});

test('v1219 ribbon action group never scans all page buttons as a fallback', () => {
  assert.ok(UI1213.includes("const pool=dock?qa('button',dock):[];"), 'button pool must be limited to the owned viewport dock');
  assert.doesNotMatch(UI1213, /const pool=dock\?qa\('button',dock\):qa\('button'\)/, 'global fallback can move panel actions into the ribbon');
});

test('v1219 AI-highlight button reflects the viewer default state', () => {
  assert.ok(APP.includes("const aiBtn = $('btnAI'); const aiOn = !!viewer.showAI;"), 'AI button state must be initialized from the viewer');
  assert.ok(APP.includes("aiBtn.setAttribute('aria-pressed', String(aiOn))"), 'AI toggle state must be exposed to assistive technology');
});

test('v1219 mode cancellation preserves unrelated toolbar toggles', () => {
  assert.ok(UI1213.includes("'btnMeasure','vtMeasure','btnSection','vtSection','vtEdit','vtWalk','vtTour','lxObjPick','lxSectBtn'"), 'mode cancellation must clear only actual tool modes');
  assert.doesNotMatch(UI1213, /qa\('\.lx-mode-active,\.toolbar button\.on,#lxLtbar button\.active'\)/, 'global .on clearing would silently turn off AI highlight and display options');
});

test('v1219 Scan-to-BIM build buttons have stable selectors for UI QA', () => {
  assert.ok(S2B.includes("bGo.id = 'lxS2BBuildBtn'"), 'missing stable BIM 1:1 build control');
  assert.ok(SCAN_UI.includes("bBuild.id = 'lxScan2BimBuildBtn'"), 'missing stable Scan-to-BIM build control');
});
