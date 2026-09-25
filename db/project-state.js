'use strict';

// Versioned, serializable project state shared by the SQLite and JSON stores.
// Point samples and document binaries stay in immutable files; this state keeps
// project metadata/references plus editable vector data and processing history.
const crypto = require('node:crypto');

const PROJECT_STATE_SCHEMA_VERSION = 1;
const PROJECT_STATE_COLLECTIONS = Object.freeze([
  'clouds', 'layers', 'transforms', 'classifications', 'sectionSets',
  'measurements', 'drawings', 'documents'
]);
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 25;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_OPERATION_ENTRIES = 2000;
const MAX_OPERATION_FIELD_BYTES = 256 * 1024;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJsonSafe(value, label, depth) {
  depth = depth || 0;
  if (depth > 80) throw new RangeError((label || 'value') + ' exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError((label || 'value') + ' contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => cloneJsonSafe(item, (label || 'value') + '[' + i + ']', depth + 1));
  if (!isPlainObject(value)) throw new TypeError((label || 'value') + ' must contain JSON-compatible objects');
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new TypeError((label || 'value') + ' contains a forbidden object key');
    }
    out[key] = cloneJsonSafe(value[key], (label || 'value') + '.' + key, depth + 1);
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function emptyProjectState() {
  const state = { schemaVersion: PROJECT_STATE_SCHEMA_VERSION };
  for (const key of PROJECT_STATE_COLLECTIONS) state[key] = [];
  state.metadata = {};
  return state;
}

function normalizeProjectState(projectId, raw) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new TypeError('projectId is required');
  if (!isPlainObject(raw)) throw new TypeError('project state must be an object');

  let input = raw;
  let version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
  if (isPlainObject(raw.payload)) input = raw.payload;
  else if (isPlainObject(raw.state)) input = raw.state;
  if (version > PROJECT_STATE_SCHEMA_VERSION) {
    throw new RangeError('project state schema version ' + version + ' is newer than supported version ' + PROJECT_STATE_SCHEMA_VERSION);
  }
  if (!isPlainObject(input)) throw new TypeError('project state payload must be an object');
  const out = cloneJsonSafe(input, 'project state');

  // v0 compatibility: early project drafts used these names before the
  // project-level contract was formalized.
  if (version < 1) {
    if (!Array.isArray(out.sectionSets) && Array.isArray(out.sectionPresets)) out.sectionSets = out.sectionPresets;
    if (!Array.isArray(out.measurements) && Array.isArray(out.measurementList)) out.measurements = out.measurementList;
    if (!Array.isArray(out.drawings) && Array.isArray(out.drawingEntities)) {
      out.drawings = [{ id: 'legacy-active-drawing', entities: out.drawingEntities }];
    }
  }
  for (const key of PROJECT_STATE_COLLECTIONS) {
    if (out[key] == null) out[key] = [];
    if (!Array.isArray(out[key])) throw new TypeError('project state "' + key + '" must be an array');
    for (let i = 0; i < out[key].length; i++) {
      if (!isPlainObject(out[key][i])) throw new TypeError('project state "' + key + '" entries must be objects');
    }
  }
  if (out.metadata == null) out.metadata = {};
  if (!isPlainObject(out.metadata)) throw new TypeError('project state "metadata" must be an object');
  out.schemaVersion = PROJECT_STATE_SCHEMA_VERSION;

  const byteLength = Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (byteLength > MAX_STATE_BYTES) throw new RangeError('project state exceeds ' + MAX_STATE_BYTES + ' bytes');
  return out;
}

function makeRevision(revision, state, operation, createdAt) {
  const payload = cloneJsonSafe(state, 'revision payload');
  return {
    revision,
    hash: hashJson(payload),
    createdAt: createdAt || new Date().toISOString(),
    operation: String(operation || 'project.save').slice(0, 160),
    payload
  };
}

function createProjectStateRecord(projectId) {
  const payload = emptyProjectState();
  const initial = makeRevision(0, payload, 'project.initial');
  return {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    projectId,
    generation: 0,
    revision: 0,
    nextRevision: 1,
    cursor: 0,
    payload,
    payloadHash: initial.hash,
    history: [initial],
    updatedAt: initial.createdAt
  };
}

function normalizeProjectStateRecord(projectId, raw) {
  if (raw == null) return createProjectStateRecord(projectId);
  if (!isPlainObject(raw) || raw.schemaVersion > PROJECT_STATE_SCHEMA_VERSION) {
    throw new RangeError('unsupported project state record version');
  }
  const payload = normalizeProjectState(projectId, isPlainObject(raw.payload) ? raw.payload : emptyProjectState());
  let history = Array.isArray(raw.history) ? raw.history : [];
  history = history.filter(entry => isPlainObject(entry) && Number.isSafeInteger(entry.revision) && entry.revision >= 0)
    .map(entry => {
      const state = normalizeProjectState(projectId, isPlainObject(entry.payload) ? entry.payload : payload);
      const hash = hashJson(state);
      // Never trust a stored digest to validate a corrupted snapshot.
      return {
        revision: entry.revision,
        hash,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        operation: typeof entry.operation === 'string' ? entry.operation.slice(0, 160) : 'project.migrated',
        payload: state
      };
    }).sort((a, b) => a.revision - b.revision);
  if (!history.length) history = [makeRevision(0, payload, 'project.migrated', raw.updatedAt)];
  let cursor = Number.isInteger(raw.cursor) ? raw.cursor : history.length - 1;
  cursor = Math.max(0, Math.min(history.length - 1, cursor));
  let selected = history[cursor];
  const payloadHash = hashJson(payload);
  if (selected.hash !== payloadHash) {
    // A torn/legacy state can contain a payload newer than its history pointer.
    // Keep the payload as a new recoverable history entry rather than discarding it.
    const rev = Math.max(Number(raw.nextRevision) || 1, history[history.length - 1].revision + 1);
    history = history.slice(0, cursor + 1);
    history.push(makeRevision(rev, payload, 'project.recovered', raw.updatedAt));
    cursor = history.length - 1;
    selected = history[cursor];
  }
  const allMax = history.reduce((n, e) => Math.max(n, e.revision), 0);
  return {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    projectId,
    generation: Number.isSafeInteger(raw.generation) && raw.generation >= 0 ? raw.generation : 0,
    revision: selected.revision,
    nextRevision: Math.max(Number.isSafeInteger(raw.nextRevision) ? raw.nextRevision : 1, allMax + 1),
    cursor,
    payload: cloneJsonSafe(selected.payload, 'project state'),
    payloadHash: selected.hash,
    history,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : selected.createdAt
  };
}

function pruneHistory(record) {
  let bytes = record.history.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0);
  while (record.history.length > 1 &&
    (record.history.length > MAX_HISTORY_ENTRIES || bytes > MAX_HISTORY_BYTES)) {
    const removed = record.history.shift();
    bytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
    record.cursor = Math.max(0, record.cursor - 1);
  }
  return record;
}

function commitProjectState(rawRecord, projectId, rawState, options) {
  options = options || {};
  const record = normalizeProjectStateRecord(projectId, rawRecord || createProjectStateRecord(projectId));
  if (options.expectedRevision != null && options.expectedRevision !== record.generation) {
    const err = new Error('project state changed since it was loaded');
    err.code = 'REVISION_CONFLICT';
    err.currentRevision = record.generation;
    throw err;
  }
  const payload = normalizeProjectState(projectId, rawState);
  const hash = hashJson(payload);
  if (hash === record.payloadHash) return { record, changed: false };

  record.history = record.history.slice(0, record.cursor + 1);
  const revision = Math.max(record.nextRevision, record.history[record.history.length - 1].revision + 1);
  const entry = makeRevision(revision, payload, options.operation || 'project.save', options.savedAt);
  record.history.push(entry);
  record.cursor = record.history.length - 1;
  record.revision = revision;
  record.nextRevision = revision + 1;
  record.payload = payload;
  record.payloadHash = hash;
  record.generation++;
  record.updatedAt = entry.createdAt;
  pruneHistory(record);
  return { record, changed: true, entry };
}

function moveProjectStateHistory(rawRecord, projectId, direction, options) {
  options = options || {};
  const record = normalizeProjectStateRecord(projectId, rawRecord || createProjectStateRecord(projectId));
  if (options.expectedRevision != null && options.expectedRevision !== record.generation) {
    const err = new Error('project state changed since it was loaded');
    err.code = 'REVISION_CONFLICT';
    err.currentRevision = record.generation;
    throw err;
  }
  const nextCursor = record.cursor + (direction === 'undo' ? -1 : 1);
  if (nextCursor < 0 || nextCursor >= record.history.length) {
    return { record, changed: false, error: direction === 'undo' ? 'no_undo' : 'no_redo' };
  }
  record.cursor = nextCursor;
  const entry = record.history[nextCursor];
  record.revision = entry.revision;
  record.payload = cloneJsonSafe(entry.payload, 'project state');
  record.payloadHash = entry.hash;
  record.generation++;
  record.updatedAt = new Date().toISOString();
  return { record, changed: true, entry };
}

function revisionList(rawRecord, projectId) {
  const record = normalizeProjectStateRecord(projectId, rawRecord || createProjectStateRecord(projectId));
  return record.history.map((entry, index) => ({
    revision: entry.revision,
    hash: entry.hash,
    createdAt: entry.createdAt,
    operation: entry.operation,
    current: index === record.cursor,
    canUndo: index > 0,
    canRedo: index < record.history.length - 1
  }));
}

function makeOperation(projectId, draft, defaults) {
  defaults = defaults || {};
  if (typeof projectId !== 'string' || !projectId.trim()) throw new TypeError('projectId is required');
  if (!isPlainObject(draft)) throw new TypeError('operation entry must be an object');
  const operation = String(draft.operation || draft.name || '');
  if (!operation.trim() || operation.length > 160) throw new TypeError('operation must be 1–160 characters');
  const inputHash = draft.inputHash == null ? null : String(draft.inputHash).replace(/^sha256:/i, '').toLowerCase();
  if (inputHash != null && !/^[a-f0-9]{64}$/.test(inputHash)) throw new TypeError('inputHash must be a SHA-256 hex digest');
  const parameters = draft.parameters == null ? {} : cloneJsonSafe(draft.parameters, 'operation parameters');
  const output = draft.output == null ? {} : cloneJsonSafe(draft.output, 'operation output');
  const warnings = draft.warnings == null ? [] : draft.warnings;
  if (!Array.isArray(warnings) || warnings.length > 100) throw new TypeError('operation warnings must be an array of at most 100 items');
  const safeWarnings = warnings.map(w => String(w).slice(0, 4000));
  if (Buffer.byteLength(JSON.stringify(parameters), 'utf8') > MAX_OPERATION_FIELD_BYTES ||
      Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_OPERATION_FIELD_BYTES) {
    throw new RangeError('operation metadata is too large');
  }
  const createdAt = draft.createdAt == null ? new Date().toISOString() : new Date(draft.createdAt).toISOString();
  return {
    id: String(draft.id || crypto.randomUUID()),
    projectId,
    operation,
    parameters,
    inputHash,
    output,
    warnings: safeWarnings,
    appVersion: String(draft.appVersion || defaults.appVersion || 'unknown').slice(0, 64),
    createdAt
  };
}

module.exports = {
  PROJECT_STATE_SCHEMA_VERSION,
  PROJECT_STATE_COLLECTIONS,
  MAX_STATE_BYTES,
  MAX_HISTORY_ENTRIES,
  MAX_OPERATION_ENTRIES,
  stableStringify,
  hashJson,
  cloneJsonSafe,
  emptyProjectState,
  normalizeProjectState,
  createProjectStateRecord,
  normalizeProjectStateRecord,
  commitProjectState,
  moveProjectStateHistory,
  revisionList,
  makeOperation
};