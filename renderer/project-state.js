/* Project-scoped, versioned state bridge for Stage 2.
 * The main-process store is authoritative. Edits are debounced, serialized,
 * optimistic-concurrency checked, and explicitly flushed before a project
 * switch or window close. Large point/label buffers use dedicated asset IPC.
 */
(function () {
  'use strict';

  var COLLECTIONS = ['clouds', 'layers', 'transforms', 'classifications', 'sectionSets', 'measurements', 'drawings', 'documents'];
  var api = (typeof window !== 'undefined' && window.bimAPI) || null;
  var state = emptyState();
  var projectId = null, revision = 0, historyRevision = 0, canUndo = false, canRedo = false;
  var pending = {}, pendingOptions = {}, pendingWaiters = [], timer = null;
  var flushPromise = null, ready = Promise.resolve(null);
  var classificationQueue = Promise.resolve();
  var destroyed = false;

  function emptyState() {
    var out = { schemaVersion: 1, metadata: {} };
    COLLECTIONS.forEach(function (key) { out[key] = []; });
    return out;
  }
  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }
  function mergePatch(target, patch) {
    Object.keys(patch || {}).forEach(function (key) { target[key] = clone(patch[key]); });
    return target;
  }
  function sameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }
  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }
  function setProjectDirty(value) {
    try { if (api && api.setProjectDirty) api.setProjectDirty(!!value); } catch (_) {}
  }
  function settledWaiters(waiters, result) {
    (waiters || []).forEach(function (resolve) { try { resolve(result); } catch (_) {} });
  }
  function applyRecord(result, eventName, extra) {
    if (!result || !result.ok || !result.payload) return false;
    state = clone(result.payload) || emptyState();
    projectId = result.projectId || projectId;
    revision = Number(result.revision) || 0;
    historyRevision = Number(result.historyRevision) || 0;
    canUndo = !!result.canUndo;
    canRedo = !!result.canRedo;
    var detail = Object.assign({
      projectId: projectId,
      state: clone(state),
      revision: revision,
      historyRevision: historyRevision,
      canUndo: canUndo,
      canRedo: canRedo
    }, extra || {});
    emit(eventName || 'bim-project-state-ready', detail);
    return true;
  }
  function loadActive(extra) {
    if (!api || typeof api.getProjectState !== 'function') return Promise.resolve(null);
    return api.getProjectState().then(function (result) {
      if (!applyRecord(result, 'bim-project-state-ready', extra)) {
        throw new Error(result && result.error || 'Не удалось загрузить состояние проекта');
      }
      return clone(state);
    }).catch(function (error) {
      try { console.warn('[project-state] load failed', error); } catch (_) {}
      emit('bim-project-state-error', { error: String(error && error.message || error) });
      return clone(state);
    });
  }
  ready = loadActive({ initial: true });

  function scheduleFlush(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(); }, Math.max(0, delay || 0));
  }

  function hasPending() { return Object.keys(pending).length > 0; }
  function enqueueClassification(task) {
    var result = classificationQueue.then(task, task);
    classificationQueue = result.then(function () {}, function () {});
    return result;
  }
  function recordConflictError(error) {
    return !!(error && (error.code === 'REVISION_CONFLICT' || error.error === 'REVISION_CONFLICT' ||
      /project state changed since it was loaded/i.test(error.message || '')));
  }
  function runFlushLoop() {
    if (flushPromise) {
      return flushPromise.then(function (result) {
        return hasPending() && (!result || result.ok !== false) ? flush() : result;
      });
    }
    if (!hasPending()) {
      return ready.then(function () {
        setProjectDirty(false);
        return { ok: true, unchanged: true, projectId: projectId, revision: revision };
      });
    }

    flushPromise = (async function () {
      var lastResult = { ok: true, unchanged: true, projectId: projectId, revision: revision };
      await ready;
      while (hasPending()) {
        var patch = pending;
        var options = pendingOptions;
        var waiters = pendingWaiters;
        pending = {}; pendingOptions = {}; pendingWaiters = [];
        var batchProjectId = projectId;
        var baseState = clone(state) || emptyState();
        var payload = mergePatch(clone(baseState) || emptyState(), patch);
        var result;

        try {
          if (!api || typeof api.saveProjectState !== 'function') {
            result = { ok: false, error: 'desktop_store_unavailable' };
          } else {
            result = await api.saveProjectState({
              projectId: batchProjectId,
              expectedRevision: revision,
              state: payload,
              operation: options.operation || null,
              appVersion: options.appVersion || null
            });
          }
          if (recordConflictError(result)) {
            var remote = await api.getProjectState(batchProjectId);
            if (!remote || !remote.ok || !remote.payload) {
              result = { ok: false, error: 'REVISION_CONFLICT', message: 'Could not reload the current project state' };
            } else {
              // Do not silently clobber a property concurrently changed by
              // another app window. Different top-level collections can merge.
              var conflicts = Object.keys(patch).filter(function (key) {
                return !sameJson(baseState[key], remote.payload[key]);
              });
              if (conflicts.length) {
                result = { ok: false, error: 'REVISION_CONFLICT', conflicts: conflicts, currentRevision: remote.revision };
              } else {
                var retryPayload = mergePatch(clone(remote.payload) || emptyState(), patch);
                result = await api.saveProjectState({
                  projectId: batchProjectId,
                  expectedRevision: remote.revision,
                  state: retryPayload,
                  operation: options.operation || null,
                  appVersion: options.appVersion || null
                });
              }
            }
          }
        } catch (error) {
          result = {
            ok: false,
            error: recordConflictError(error) ? 'REVISION_CONFLICT' : String(error && error.message || error),
            message: String(error && error.message || error)
          };
        }

        if (result && result.ok && batchProjectId === projectId) {
          applyRecord(result, 'bim-project-state-saved');
          lastResult = result;
          settledWaiters(waiters, result);
          continue;
        }

        // Keep failed changes in memory for a later explicit retry. Newer
        // edits win if they touched the same collection while IPC was pending.
        pending = mergePatch(patch, pending);
        pendingOptions = Object.keys(pendingOptions).length ? pendingOptions : options;
        setProjectDirty(true);
        lastResult = result || { ok: false, error: 'project_state_save_failed' };
        settledWaiters(waiters, lastResult);
        if (recordConflictError(lastResult)) {
          emit('bim-project-state-conflict', {
            projectId: batchProjectId,
            conflicts: Array.isArray(lastResult.conflicts) ? lastResult.conflicts.slice() : [],
            currentRevision: lastResult.currentRevision,
            message: lastResult.message || lastResult.error
          });
        }
        break;
      }
      if (!hasPending()) setProjectDirty(false);
      return lastResult;
    })().catch(function (error) {
      var result = { ok: false, error: String(error && error.message || error) };
      setProjectDirty(true);
      return result;
    }).then(function (result) {
      flushPromise = null;
      // An update can arrive between the loop's final condition and this
      // continuation. Drain it after a successful commit. Do not spin-retry a
      // rejected write (especially a same-field revision conflict): preserve
      // the dirty local patch for explicit user resolution instead.
      if (hasPending() && !destroyed && (!result || result.ok !== false)) return runFlushLoop();
      return result;
    });
    return flushPromise;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    return runFlushLoop();
  }

  function update(patch, options) {
    options = options || {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return Promise.reject(new TypeError('project-state patch must be an object'));
    if (!Object.keys(patch).length) return Promise.resolve({ ok: true, unchanged: true });
    return ready.then(function () {
      mergePatch(pending, patch);
      if (options.operation) pendingOptions.operation = options.operation;
      if (options.appVersion) pendingOptions.appVersion = options.appVersion;
      setProjectDirty(true);
      return new Promise(function (resolve) {
        pendingWaiters.push(resolve);
        scheduleFlush(options.immediate ? 0 : 500);
      });
    });
  }

  function updateCollection(name, value, options) {
    if (COLLECTIONS.indexOf(name) < 0) return Promise.reject(new Error('unknown project state collection: ' + name));
    if (!Array.isArray(value)) return Promise.reject(new TypeError(name + ' must be an array'));
    var patch = {}; patch[name] = value;
    return update(patch, options);
  }

  function reload(options) {
    options = options || {};
    var discardPending = !!options.discardPending;
    var inFlight = flushPromise;
    if (options.discardPending) {
      if (timer) { clearTimeout(timer); timer = null; }
      var discardedWaiters = pendingWaiters;
      pending = {}; pendingOptions = {}; pendingWaiters = [];
      settledWaiters(discardedWaiters, { ok: false, error: 'discarded_by_reload' });
      setProjectDirty(false);
    }
    var saveBarrier = discardPending && inFlight
      ? Promise.resolve(inFlight).catch(function () { return null; })
      : flush();
    return saveBarrier.then(function (saved) {
      if (!discardPending && saved && saved.ok === false) throw new Error('Не удалось сохранить изменения перед загрузкой проекта: ' + (saved.message || saved.error));
      if (!api || typeof api.getProjectState !== 'function') return clone(state);
      ready = api.getProjectState().then(function (result) {
        if (!applyRecord(result, 'bim-project-state-ready', { reloaded: true })) {
          throw new Error(result && result.error || 'Не удалось перезагрузить состояние проекта');
        }
        return clone(state);
      });
      return ready;
    });
  }

  function recordOperation(entry) {
    return flush().then(function (saved) {
      if (saved && saved.ok === false) return saved;
      if (!api || typeof api.recordProjectOperation !== 'function') return { ok: false, error: 'desktop_store_unavailable' };
      var body = Object.assign({}, entry || {});
      if (!body.projectId && projectId) body.projectId = projectId;
      return api.recordProjectOperation(body);
    });
  }

  function move(direction) {
    return flush().then(function (saved) {
      if (saved && saved.ok === false) return saved;
      if (!api) return { ok: false, error: 'desktop_store_unavailable' };
      var fn = direction === 'undo' ? api.undoProjectState : api.redoProjectState;
      if (typeof fn !== 'function') return { ok: false, error: 'not_supported' };
      return fn({ projectId: projectId, expectedRevision: revision }).then(function (result) {
        if (result && result.ok && result.payload) {
          applyRecord(result, 'bim-project-state-restored', { direction: direction });
        }
        return result;
      });
    });
  }

  function saveClassification(input) {
    input = Object.assign({}, input || {});
    // The viewer produces immutable Uint8Array snapshots and replaces them on
    // each edit. Keep those large buffers zero-copy in the renderer queue;
    // Electron's IPC serialization owns the transport copy.
    if (input.labels instanceof ArrayBuffer) input.labels = new Uint8Array(input.labels);
    else if (Array.isArray(input.labels)) input.labels = new Uint8Array(input.labels);
    return enqueueClassification(function () {
      return flush().then(function (saved) {
        if (saved && saved.ok === false) return saved;
        if (!api || typeof api.saveProjectClassification !== 'function') return { ok: false, error: 'classification_asset_storage_unavailable' };
        var body = Object.assign({}, input, { projectId: projectId, expectedRevision: revision });
        return api.saveProjectClassification(body).then(function (result) {
          if (result && result.ok && result.state && result.state.payload) {
            applyRecord(result.state, 'bim-project-state-saved', { assetOperation: 'classification' });
            emit('bim-project-classification-saved', {
              projectId: projectId,
              classification: clone(result.classification),
              revision: revision
            });
          }
          return result;
        });
      });
    });
  }

  function clearClassification(cloudId) {
    return enqueueClassification(function () {
      return flush().then(function (saved) {
        if (saved && saved.ok === false) return saved;
        if (!api || typeof api.clearProjectClassification !== 'function') return { ok: false, error: 'classification_asset_storage_unavailable' };
        return api.clearProjectClassification({
          projectId: projectId,
          cloudId: cloudId,
          expectedRevision: revision
        }).then(function (result) {
          if (result && result.ok && result.state && result.state.payload) {
            applyRecord(result.state, 'bim-project-state-saved', { assetOperation: 'classification-clear' });
            emit('bim-project-classification-cleared', {
              projectId: projectId,
              cloudId: cloudId,
              cleared: result.cleared !== false,
              revision: revision
            });
          }
          return result;
        });
      });
    });
  }

  function loadClassification(cloudId, digest) {
    return ready.then(function () {
      if (!api || typeof api.loadProjectClassification !== 'function') return { ok: false, error: 'classification_asset_storage_unavailable' };
      return api.loadProjectClassification({ projectId: projectId, cloudId: cloudId, sha256: digest || undefined });
    });
  }

  function snapshot() {
    return mergePatch(clone(state) || emptyState(), pending);
  }

  window.BimProjectState = {
    ready: ready,
    flush: flush,
    reload: reload,
    discardPendingAndReload: function () { return reload({ discardPending: true }); },
    update: update,
    updateCollection: updateCollection,
    recordOperation: recordOperation,
    saveClassification: saveClassification,
    clearClassification: clearClassification,
    loadClassification: loadClassification,
    undo: function () { return move('undo'); },
    redo: function () { return move('redo'); },
    snapshot: snapshot,
    get projectId() { return projectId; },
    get revision() { return revision; },
    get historyRevision() { return historyRevision; },
    get canUndo() { return canUndo; },
    get canRedo() { return canRedo; }
  };
})();