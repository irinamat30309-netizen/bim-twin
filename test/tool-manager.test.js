'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ToolManager } = require('../renderer/tool-manager');

test('ToolManager keeps exactly one active tool and cleans the previous owner', () => {
  const calls = [];
  const manager = new ToolManager({ onError: error => { throw error; } });
  manager.register('measure', {
    activate(api) {
      calls.push('measure:activate');
      api.track(() => calls.push('measure:cleanup'));
    },
    deactivate({ reason }) { calls.push('measure:deactivate:' + reason); }
  });
  manager.register('section', {
    activate() { calls.push('section:activate'); },
    deactivate({ reason }) { calls.push('section:deactivate:' + reason); }
  });

  manager.activate('measure');
  manager.activate('section');
  assert.equal(manager.activeId, 'section');
  assert.deepEqual(calls, [
    'measure:activate',
    'measure:deactivate:switch',
    'measure:cleanup',
    'section:activate'
  ]);
});

test('cancel invokes cancel, aborts listeners and deactivates once', () => {
  const target = new EventTarget();
  let events = 0;
  let cancelled = 0;
  let deactivated = 0;
  const manager = new ToolManager({ onError: error => { throw error; } });
  manager.register('pick', {
    activate(api) { api.listen(target, 'point', () => events++); },
    cancel() { cancelled++; },
    deactivate() { deactivated++; }
  });
  manager.activate('pick');
  target.dispatchEvent(new Event('point'));
  assert.equal(events, 1);
  assert.equal(manager.cancel('escape'), true);
  target.dispatchEvent(new Event('point'));
  assert.equal(events, 1);
  assert.equal(cancelled, 1);
  assert.equal(deactivated, 1);
  assert.equal(manager.activeId, null);
});

test('late async activation cleanup cannot reclaim a replacement tool', async () => {
  let resolveActivation;
  let staleCleanup = 0;
  const manager = new ToolManager({ onError: error => { throw error; } });
  manager.register('slow', {
    activate() {
      return new Promise(resolve => { resolveActivation = resolve; });
    }
  });
  manager.register('fast', { activate() {} });
  manager.activate('slow');
  manager.activate('fast');
  resolveActivation(() => staleCleanup++);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.activeId, 'fast');
  assert.equal(staleCleanup, 1);
});

test('dispose releases active state and calls lifecycle disposers', () => {
  let disposed = 0;
  const manager = new ToolManager({ onError: error => { throw error; } });
  manager.register('tool', { activate() {}, dispose() { disposed++; } });
  manager.activate('tool');
  manager.dispose();
  assert.equal(manager.activeId, null);
  assert.equal(manager.has('tool'), false);
  assert.equal(disposed, 1);
});