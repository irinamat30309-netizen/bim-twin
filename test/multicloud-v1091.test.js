'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Изолируем window для node-окружения
global.window = global.window || {};
// DOM event shims for Node.js
if (!global.window.addEventListener) {
  const _evs = {};
  global.window.addEventListener = (t,fn) => { (_evs[t]=_evs[t]||[]).push(fn); };
  global.window.removeEventListener = (t,fn) => { _evs[t]=(_evs[t]||[]).filter(f=>f!==fn); };
  global.window.dispatchEvent = (ev) => { (_evs[ev.type]||[]).forEach(fn=>fn(ev)); };
}
if (!global.document) {
  global.document = {
    createElement: () => ({ style:{}, addEventListener(){} }),
    addEventListener() {},
    dispatchEvent() {},
  };
}
global.localStorage = { _s:{}, getItem(k){return this._s[k]||null;}, setItem(k,v){this._s[k]=v;}, removeItem(k){delete this._s[k];} };

const MC = require('../renderer/multicloud');

test('addCloud: dobavlyaet oblako i vozvrashchaet ob\'ekt', () => {
  const cloud = MC.addCloud('Test', '/path/a.las', null, 12345, null);
  assert.ok(cloud.id);
  assert.equal(cloud.name, 'Test');
  assert.equal(cloud.path, '/path/a.las');
  assert.equal(cloud.count, 12345);
  assert.ok(cloud.visible);
  assert.ok(MC.count() >= 1);
});

test('list: vozvrashchaet massiv oblakov', () => {
  const list = MC.list();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
});

test('getActive: vozvrashchaet aktivnoye oblako', () => {
  const cloud = MC.addCloud('Active', '', null, 0, null);
  assert.ok(MC.getActive());
  assert.equal(MC.getActive().id, cloud.id);
});

test('setVisible: menyaet vidimist', () => {
  const cloud = MC.addCloud('Vis', '', null, 0, null);
  MC.setVisible(cloud.id, false);
  assert.ok(!MC.byId(cloud.id).visible);
  MC.setVisible(cloud.id, true);
  assert.ok(MC.byId(cloud.id).visible);
});

test('setOpacity: ogranicheno [0,1]', () => {
  const cloud = MC.addCloud('Opac', '', null, 0, null);
  MC.setOpacity(cloud.id, 1.5);
  assert.equal(MC.byId(cloud.id).opacity, 1.0);
  MC.setOpacity(cloud.id, -0.5);
  assert.equal(MC.byId(cloud.id).opacity, 0.0);
  MC.setOpacity(cloud.id, 0.7);
  assert.ok(Math.abs(MC.byId(cloud.id).opacity - 0.7) < 1e-9);
});

test('rename: izmenyaet imya', () => {
  const cloud = MC.addCloud('OldName', '', null, 0, null);
  MC.rename(cloud.id, 'NewName');
  assert.equal(MC.byId(cloud.id).name, 'NewName');
});

test('setColor: izmenyaet tsvet', () => {
  const cloud = MC.addCloud('Color', '', null, 0, null);
  MC.setColor(cloud.id, '#ff0000');
  assert.equal(MC.byId(cloud.id).color, '#ff0000');
});

test('removeCloud: udalyaet oblako', () => {
  const before = MC.count();
  const cloud = MC.addCloud('ToRemove', '', null, 0, null);
  assert.equal(MC.count(), before + 1);
  MC.removeCloud(cloud.id);
  assert.equal(MC.count(), before);
  assert.equal(MC.byId(cloud.id), null);
});

test('totalPoints: summiruet vse tochki', () => {
  // Sbrasyvayem
  MC.list().forEach(c => MC.removeCloud(c.id));
  MC.addCloud('A', '', null, 1000, null);
  MC.addCloud('B', '', null, 2000, null);
  assert.equal(MC.totalPoints(), 3000);
});

test('summaryHtml: vozvrashchaet HTML s imenami oblakov', () => {
  MC.list().forEach(c => MC.removeCloud(c.id));
  MC.addCloud('Oblako1', '', null, 500, null);
  const html = MC.summaryHtml();
  assert.ok(html.includes('Oblako1'));
  assert.ok(html.includes('500'));
});

test('syncFromViewer: ne duplikaet sushchestvuyushchiy path', () => {
  MC.list().forEach(c => MC.removeCloud(c.id));
  MC.addCloud('Scan', '/a.las', null, 100, null);
  const before = MC.count();
  MC.syncFromViewer('Scan', '/a.las');
  assert.equal(MC.count(), before, 'ne dolzhen dobavlyat duplikat');
});
