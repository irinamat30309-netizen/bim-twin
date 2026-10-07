/* BIM Twin centralized tool lifecycle.
 * One active interactive tool owns its listeners, abort signal and cleanup.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.BimToolManager = api.ToolManager;
    if (!root.__lxToolManager) root.__lxToolManager = new api.ToolManager({ eventTarget: root });
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function callSafely(fn, args, onError) {
    if (typeof fn !== 'function') return undefined;
    try {
      const result = fn.apply(null, args || []);
      if (result && typeof result.then === 'function') {
        result.catch(error => onError(error));
      }
      return result;
    } catch (error) {
      onError(error);
      return undefined;
    }
  }

  class ToolManager {
    constructor(options) {
      options = options || {};
      this._tools = new Map();
      this._active = null;
      this._generation = 0;
      this._eventTarget = options.eventTarget || null;
      this._onError = typeof options.onError === 'function'
        ? options.onError
        : error => {
          try { console.error('[tool-manager]', error); } catch (_) {}
        };
    }

    get activeId() {
      return this._active ? this._active.id : null;
    }

    get active() {
      return this._active;
    }

    has(id) {
      return this._tools.has(String(id));
    }

    register(id, lifecycle) {
      id = String(id || '');
      if (!id) throw new Error('tool_id_required');
      if (!lifecycle || typeof lifecycle !== 'object') throw new Error('tool_lifecycle_required');
      if (this._tools.has(id)) throw new Error('tool_already_registered:' + id);
      this._tools.set(id, lifecycle);
      return () => this.unregister(id);
    }

    unregister(id) {
      id = String(id || '');
      if (this.activeId === id) this.deactivate('unregister');
      return this._tools.delete(id);
    }

    _emit(name, detail) {
      const target = this._eventTarget;
      if (!target || typeof target.dispatchEvent !== 'function') return;
      try {
        const EventCtor = typeof CustomEvent === 'function'
          ? CustomEvent
          : function ToolEvent(type, init) { this.type = type; this.detail = init && init.detail; };
        target.dispatchEvent(new EventCtor(name, { detail }));
      } catch (_) {}
    }

    _sessionApi(session) {
      const cleanups = session.cleanups;
      return {
        id: session.id,
        context: session.context,
        signal: session.controller.signal,
        isCurrent: () => this._active === session && !session.controller.signal.aborted,
        track: cleanup => {
          if (typeof cleanup === 'function') cleanups.push(cleanup);
          return cleanup;
        },
        listen: (target, type, listener, options) => {
          if (!target || typeof target.addEventListener !== 'function') throw new Error('invalid_event_target');
          const opts = Object.assign({}, options || {});
          let usedSignal = false;
          try {
            opts.signal = session.controller.signal;
            target.addEventListener(type, listener, opts);
            usedSignal = true;
          } catch (_) {
            delete opts.signal;
            target.addEventListener(type, listener, opts);
          }
          if (!usedSignal) cleanups.push(() => {
            try { target.removeEventListener(type, listener, opts); } catch (_) {}
          });
          return listener;
        }
      };
    }

    activate(id, context) {
      id = String(id || '');
      const lifecycle = this._tools.get(id);
      if (!lifecycle) throw new Error('unknown_tool:' + id);
      if (this.activeId === id) return this._active;
      this.deactivate('switch');
      const session = {
        id,
        context: context || {},
        controller: new AbortController(),
        cleanups: [],
        lifecycle,
        generation: ++this._generation,
        state: 'activating'
      };
      this._active = session;
      this._emit('bim-tool-activating', { id, context: session.context });
      const result = callSafely(
        lifecycle.activate,
        [this._sessionApi(session)],
        error => this._failSession(session, error)
      );
      if (result && typeof result.then === 'function') {
        result.then(cleanup => this._finishActivation(session, cleanup), error => this._failSession(session, error));
      } else {
        this._finishActivation(session, result);
      }
      return session;
    }

    _finishActivation(session, cleanup) {
      if (this._active !== session || session.controller.signal.aborted) {
        if (typeof cleanup === 'function') callSafely(cleanup, [], this._onError);
        if (session.state !== 'disposed') this._cleanupSession(session, 'stale-activation');
        return;
      }
      if (typeof cleanup === 'function') session.cleanups.push(cleanup);
      session.state = 'active';
      this._emit('bim-tool-activated', { id: session.id, context: session.context });
    }

    _failSession(session, error) {
      this._onError(error);
      if (this._active === session) {
        this._cleanupSession(session, 'activation-error');
        this._active = null;
      }
      this._emit('bim-tool-error', { id: session.id, error: String(error && error.message || error) });
    }

    _cleanupSession(session, reason) {
      if (!session || session.state === 'disposed') return;
      session.state = 'deactivating';
      try { session.controller.abort(reason); } catch (_) { try { session.controller.abort(); } catch (_) {} }
      callSafely(session.lifecycle.deactivate, [{ reason, context: session.context }], this._onError);
      for (const cleanup of session.cleanups.splice(0).reverse()) {
        callSafely(cleanup, [], this._onError);
      }
      session.state = 'disposed';
      this._emit('bim-tool-deactivated', { id: session.id, reason });
    }

    deactivate(reason) {
      const session = this._active;
      if (!session) return false;
      this._active = null;
      this._generation++;
      this._cleanupSession(session, reason || 'deactivate');
      return true;
    }

    cancel(reason) {
      const session = this._active;
      if (!session) return false;
      callSafely(session.lifecycle.cancel, [{ reason: reason || 'cancel', context: session.context }], this._onError);
      return this.deactivate(reason || 'cancel');
    }

    dispose() {
      this.deactivate('manager-dispose');
      for (const [id, lifecycle] of this._tools) {
        callSafely(lifecycle.dispose, [{ id }], this._onError);
      }
      this._tools.clear();
    }
  }

  return { ToolManager };
});