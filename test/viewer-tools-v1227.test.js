'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
const HTML = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const WORKSPACE = fs.readFileSync(path.join(__dirname, '../renderer/lixel-workspace.js'), 'utf8');

function bareViewer() {
  const v = Object.create(Viewer3DGL.prototype);
  v.selectedId = null; v.isolate = false; v.lod = false; v.base = [];
  v.render = () => {};
  return v;
}

test('isolate refuses to hide a point cloud when nothing is selected', () => {
  const v = bareViewer();
  v.base = [{ id: null, points: true, hidden: false }];
  assert.equal(v.setIsolate(true), false);
  assert.equal(v.isolate, false);
  assert.equal(v.base[0].hidden, false);
});

test('isolate preserves selected object on empty click and restores all objects on exit', () => {
  const v = bareViewer();
  v.base = [{ id: 'wall-1' }, { id: 'wall-2' }, { id: null, points: true }, { line: true }];
  v.selectedId = 'wall-1';
  assert.equal(v.setIsolate(true), true);
  assert.deepEqual(v.base.map(o => !!o.hidden), [false, true, true, false]);
  assert.equal(v.select(null), 'wall-1');
  assert.deepEqual(v.base.map(o => !!o.hidden), [false, true, true, false]);
  assert.equal(v.setIsolate(false), true);
  assert.deepEqual(v.base.map(o => !!o.hidden), [false, false, false, false]);
});

test('LOD is explicitly unsupported on point clouds and does not change state', () => {
  const v = bareViewer();
  v._modelFull = null;
  assert.equal(v.supportsLOD(), false);
  assert.equal(v.setLOD(true), false);
  assert.equal(v.lod, false);
  assert.equal(v.setLOD(false), true);
});

test('LOD decimates triangle buffers and restores the exact full mesh', () => {
  const v = bareViewer();
  const pos = new Float32Array(4 * 9);
  for (let i = 0; i < pos.length; i++) pos[i] = i / 10;
  const nor = new Float32Array(pos.length).fill(1);
  const col = new Float32Array(pos.length).fill(0.5);
  v._modelFull = { pos, nor, col };
  v._setBase = objects => { v.base = objects; };
  assert.equal(v.supportsLOD(), true);
  assert.equal(v.setLOD(true), true);
  assert.equal(v.lod, true);
  assert.equal(v.base[0].pos.length / 9, 2);
  assert.equal(v.setLOD(false), true);
  assert.equal(v.lod, false);
  assert.equal(v.base[0].pos, pos, 'LOD off restores the original full-resolution position buffer');
  assert.equal(v.base[0].nor, nor);
  assert.equal(v.base[0].col, col);
});

test('loading a BIM room clears stale mesh LOD capability', () => {
  const v = bareViewer();
  v._modelFull = { pos: new Float32Array(18), nor: new Float32Array(18) };
  v.lod = true;
  v._clearMeasure = () => {};
  v._gridObj = () => ({ line: true });
  v._wireObj = () => ({ line: true });
  v._boxObj = id => ({ id });
  v._setBase = objs => { v.base = objs; };
  v._frame = () => {};
  v.loadRoom({ dims: { w: 4, d: 3, h: 2 }, elements: [] });
  assert.equal(v._modelFull, null);
  assert.equal(v.lod, false);
  assert.equal(v.supportsLOD(), false);
});

test('UI gates LOD and explains unsupported point-cloud state', () => {
  assert.match(APP, /LOD доступен только для полигональных моделей/);
  assert.match(APP, /Сначала выберите объект или элемент/);
  assert.match(WORKSPACE, /grid\.disabled = !canLOD/);
  for (const [script, version] of [['webgl-viewer.js', '1230'], ['app.js', '1249'], ['lixel-workspace.js', '1232']]) {
    assert.ok(HTML.includes(script + '?v=' + version), script + ' cache-bust version');
  }
});
