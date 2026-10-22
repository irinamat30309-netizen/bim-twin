'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function restoreHarness(savedLabels, loadedCount) {
  const events = [];
  const listeners = {};
  const toast = { textContent: '', classList: { add() {}, remove() {} } };
  const viewer = {
    loaded: null,
    loadCloud(parsed) { this.loaded = parsed; },
    getEditedCloud() { return this.loaded; },
    applyClassificationLabels(labels) {
      this.applyAttempt = Array.from(labels);
      return !!this.loaded && labels.length === this.loaded.pos.length / 3;
    }
  };
  const window = {
    __viewer: viewer,
    __lxScene: { rebuild() {} },
    BimProjectState: {
      projectId: 'stage7-project',
      revision: 3,
      ready: Promise.resolve({
        cloudsVersion: 1,
        activeCloudId: 'scan-stage7',
        clouds: [{ id: 'scan-stage7', name: 'fixture', path: '/fixture/scan.ply', count: loadedCount }]
      }),
      loadClassification: async cloudId => ({
        ok: true,
        classification: { cloudId, pointCount: savedLabels.length },
        labels: savedLabels
      })
    },
    bimAPI: {
      parseCloud: async () => ({
        ok: true,
        pos: new Float32Array(loadedCount * 3),
        col: null,
        meta: { points: loadedCount }
      })
    },
    addEventListener(type, callback) { (listeners[type] = listeners[type] || []).push(callback); },
    dispatchEvent(event) {
      events.push(event);
      (listeners[event.type] || []).forEach(callback => callback(event));
      return true;
    }
  };
  const context = {
    window,
    document: { getElementById(id) { return id === 'toast' ? toast : null; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Event: class Event { constructor(type) { this.type = type; } },
    setTimeout(callback) { callback(); return 0; },
    clearTimeout() {},
    console
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'renderer', 'multicloud.js'), 'utf8'),
    context,
    { filename: 'renderer/multicloud.js' }
  );
  return { events, toast, viewer };
}

test('restored project classification warns and emits diagnostics when cloud point count changed', async () => {
  const h = restoreHarness(new Uint8Array([1, 2]), 3);
  await new Promise(resolve => setImmediate(resolve));
  const mismatch = h.events.find(event => event.type === 'bim-project-classification-mismatch');
  assert.ok(mismatch, 'mismatch diagnostic should be dispatched');
  assert.deepEqual({ ...mismatch.detail }, {
    cloudId: 'scan-stage7',
    savedPointCount: 2,
    loadedPointCount: 3
  });
  assert.match(h.toast.textContent, /разметка не применена/i);
  assert.deepEqual(h.viewer.applyAttempt, [1, 2]);
});

test('restored project classification applies normally when point counts match', async () => {
  const h = restoreHarness(new Uint8Array([1, 2, 3]), 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.viewer.applyAttempt, [1, 2, 3]);
  assert.equal(h.events.some(event => event.type === 'bim-project-classification-mismatch'), false);
  assert.equal(h.toast.textContent, '');
});