'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ProjectState = require('../db/project-state');

function harness() {
  let state = ProjectState.emptyProjectState();
  let generation = 0, historyRevision = 0, cursor = 0;
  const history = [JSON.parse(JSON.stringify(state))];
  let activeSaves = 0, maxConcurrentSaves = 0, delayFirstSave = true;
  const events = [];
  function view() {
    return {
      ok: true, projectId: 'project-stage2', schemaVersion: 1,
      revision: generation, historyRevision, cursor,
      payload: JSON.parse(JSON.stringify(state)),
      canUndo: cursor > 0, canRedo: cursor < history.length - 1
    };
  }
  function commit(args) {
    if (args.expectedRevision !== generation) return { ok: false, error: 'REVISION_CONFLICT', currentRevision: generation };
    const next = JSON.parse(JSON.stringify(args.state));
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      history.splice(cursor + 1);
      history.push(JSON.parse(JSON.stringify(state)));
      cursor = history.length - 1;
      generation++;
      historyRevision++;
    }
    return Object.assign(view(), { changed: true });
  }
  const api = {
    getProjectState: async () => view(),
    saveProjectState: async args => {
      activeSaves++;
      maxConcurrentSaves = Math.max(maxConcurrentSaves, activeSaves);
      try {
        if (delayFirstSave) { delayFirstSave = false; await new Promise(resolve => setTimeout(resolve, 25)); }
        return commit(args);
      } finally { activeSaves--; }
    },
    undoProjectState: async args => {
      if (args.expectedRevision !== generation) return { ok: false, error: 'REVISION_CONFLICT' };
      if (cursor <= 0) return { ok: false, error: 'no_undo' };
      state = JSON.parse(JSON.stringify(history[--cursor]));
      generation++; return Object.assign(view(), { changed: true });
    },
    redoProjectState: async args => {
      if (args.expectedRevision !== generation) return { ok: false, error: 'REVISION_CONFLICT' };
      if (cursor >= history.length - 1) return { ok: false, error: 'no_redo' };
      state = JSON.parse(JSON.stringify(history[++cursor]));
      generation++; return Object.assign(view(), { changed: true });
    },
    saveProjectClassification: async args => {
      const labels = new Uint8Array(args.labels);
      const digest = crypto.createHash('sha256').update(labels).digest('hex');
      const classification = { cloudId: args.cloudId, pointCount: labels.length, asset: { sha256: digest } };
      const next = JSON.parse(JSON.stringify(state));
      next.classifications.push(classification);
      const saved = commit({ expectedRevision: args.expectedRevision, state: next });
      return saved.ok ? { ok: true, classification, state: saved } : saved;
    },
    loadProjectClassification: async args => ({ ok: true, projectId: args.projectId, cloudId: args.cloudId, sha256: args.sha256 }),
    recordProjectOperation: async entry => ({ ok: true, operation: entry })
  };
  const window = {
    bimAPI: api,
    dispatchEvent: event => { events.push(event); return true; }
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const context = { window, CustomEvent, Promise, setTimeout, clearTimeout, console, JSON, Object, Array, Number, String, Math, Error, TypeError };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'project-state.js'), 'utf8'), context, { filename: 'renderer/project-state.js' });
  return {
    ps: window.BimProjectState, api, events,
    maxConcurrent: () => maxConcurrentSaves,
    externalChange(key, value) {
      state[key] = JSON.parse(JSON.stringify(value));
      history.splice(cursor + 1);
      history.push(JSON.parse(JSON.stringify(state)));
      cursor = history.length - 1;
      generation++; historyRevision++;
    },
    get state() { return JSON.parse(JSON.stringify(state)); }
  };
}

test('renderer bridge serializes concurrent saves, rebases independent collections and rejects same-field conflicts', async () => {
  const h = harness(), ps = h.ps;
  await ps.ready;
  const first = ps.update({ drawings: [{ id: 'drawing-a', entities: [] }] }, { immediate: true });
  await new Promise(resolve => setTimeout(resolve, 3));
  const second = ps.update({ measurements: [{ id: 'measurement-a', mode: 'distance', value: 2 }] }, { immediate: true });
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result && result.ok));
  assert.equal(h.maxConcurrent(), 1);
  assert.equal(ps.snapshot().drawings[0].id, 'drawing-a');
  assert.equal(ps.snapshot().measurements[0].id, 'measurement-a');

  h.externalChange('layers', [{ id: 'remote-layer', visible: false }]);
  const rebased = await ps.update({ measurements: [{ id: 'measurement-b', mode: 'distance', value: 3 }] }, { immediate: true });
  assert.equal(rebased.ok, true);
  assert.equal(h.state.layers[0].id, 'remote-layer');
  assert.equal(h.state.measurements[0].id, 'measurement-b');

  h.externalChange('drawings', [{ id: 'remote-drawing', entities: [] }]);
  const conflict = await ps.update({ drawings: [{ id: 'local-conflicting-drawing', entities: [] }] }, { immediate: true });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'REVISION_CONFLICT');
  assert.deepEqual(Array.from(conflict.conflicts), ['drawings']);
  assert.equal(h.state.drawings[0].id, 'remote-drawing');
  const reloaded = await ps.discardPendingAndReload();
  assert.equal(reloaded.drawings[0].id, 'remote-drawing');
  assert.equal(ps.snapshot().drawings[0].id, 'remote-drawing');
  assert.ok(h.events.some(event => event.type === 'bim-project-state-saved'));
});

test('project bridge routes undo/redo and large classification buffers through dedicated IPC', async () => {
  const h = harness(), ps = h.ps;
  await ps.ready;
  const updated = await ps.update({ sectionSets: [{ id: 'section-1', name: 'Этаж 1', axis: 'y' }] }, { immediate: true });
  assert.equal(updated.ok, true);
  assert.equal(ps.canUndo, true);

  const undone = await ps.undo();
  assert.equal(undone.ok, true);
  assert.equal(ps.canRedo, true);
  assert.equal(ps.snapshot().sectionSets.length, 0);
  const redone = await ps.redo();
  assert.equal(redone.ok, true);
  assert.equal(ps.snapshot().sectionSets[0].id, 'section-1');
  assert.ok(h.events.some(event => event.type === 'bim-project-state-restored' && event.detail.direction === 'undo'));

  const labels = new Uint8Array([0, 4, 1, 4, 7]);
  const saved = await ps.saveClassification({
    cloudId: 'облако-этаж-1',
    labels,
    pointCount: labels.length,
    algorithm: 'test',
    parameters: { tolerance: 0.02 }
  });
  assert.equal(saved.ok, true);
  assert.equal(ps.snapshot().classifications[0].cloudId, 'облако-этаж-1');
  const loaded = await ps.loadClassification('облако-этаж-1', saved.classification.asset.sha256);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.sha256, saved.classification.asset.sha256);
  assert.ok(h.events.some(event => event.type === 'bim-project-classification-saved'));
});