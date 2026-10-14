'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SqliteStore } = require('../db/sqliteStore');
const ProjectState = require('../db/project-state');

class BetterSqliteCompat {
  constructor(file) { this.db = new DatabaseSync(file); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  pragma(sql) { return this.db.prepare('PRAGMA ' + sql).all(); }
  transaction(fn) {
    return (...args) => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
    };
  }
  close() { this.db.close(); }
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bim-sql-state-')); }
function stateWithDrawing(id) {
  const state = ProjectState.emptyProjectState();
  state.drawings = [{ id, projection: 'top', entities: [{ type: 'line', a: [0, 0, 0], b: [1, 0, 0] }] }];
  state.clouds = [{ id: 'cloud-1', path: 'данные/scan.e57', crs: { epsg: 32636 } }];
  state.measurements = [{ id: 'measurement-1', mode: 'distance', d3: 1 }];
  return state;
}

test('SQLite v6 project-state migration, save, history and operation log work transactionally', () => {
  const parent = tempDir();
  const dir = path.join(parent, 'проект');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const legacy = new SqliteStore(dir, BetterSqliteCompat);
    legacy.db.exec('DROP TABLE project_states; DROP TABLE operation_journal;');
    legacy.db.prepare("UPDATE schema_meta SET value='5' WHERE key='version'").run();
    legacy.db.close();

    let store = new SqliteStore(dir, BetterSqliteCompat);
    assert.equal(store.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value, '6');
    const initial = store.getProjectState();
    const one = store.saveProjectState(stateWithDrawing('rev-1'), {
      expectedRevision: initial.revision,
      operation: { operation: 'cloud.register', inputHash: 'b'.repeat(64), parameters: { method: 'rigid', iterations: 50 }, output: { rmse: 0.003 }, warnings: ['проверить CRS'], appVersion: 'test' }
    });
    assert.equal(one.ok, true);
    assert.equal(one.payload.drawings[0].id, 'rev-1');
    assert.equal(store.listProjectRevisions().length, 2);
    assert.equal(store.listOperations(10)[0].inputHash, 'b'.repeat(64));

    const two = store.saveProjectState(stateWithDrawing('rev-2'), { expectedRevision: one.revision });
    assert.equal(store.undoProjectState({ expectedRevision: two.revision }).payload.drawings[0].id, 'rev-1');
    const undone = store.getProjectState();
    assert.equal(store.redoProjectState({ expectedRevision: undone.revision }).payload.drawings[0].id, 'rev-2');

    const oldGeneration = store.getProjectState().revision;
    assert.throws(() => store.saveProjectState(stateWithDrawing('stale'), { expectedRevision: oldGeneration - 1 }), e => e && e.code === 'REVISION_CONFLICT');
    assert.equal(store.getProjectState().payload.drawings[0].id, 'rev-2');
    store.db.close();
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('SQLite backup round-trip preserves state and rejects tampering without partial import', () => {
  const sourceDir = tempDir(), targetDir = tempDir();
  let source, target;
  try {
    source = new SqliteStore(sourceDir, BetterSqliteCompat);
    const initial = source.getProjectState();
    source.saveProjectState(stateWithDrawing('backup-revision'), { expectedRevision: initial.revision });
    source.recordOperation({ operation: 'cloud.clean', parameters: { voxel: 0.01 }, output: { removed: 10 }, appVersion: 'test' });
    const backup = source.exportBackup();

    target = new SqliteStore(targetDir, BetterSqliteCompat);
    target.importBackup(backup);
    assert.equal(target.getProjectState().payload.drawings[0].id, 'backup-revision');
    assert.ok(target.listOperations(10).some(op => op.operation === 'cloud.clean'));

    const before = target.getData().project.id;
    const corrupt = JSON.parse(backup); corrupt.data.projects[0].project.name = 'tampered';
    assert.throws(() => target.importBackup(corrupt), /checksum mismatch/);
    assert.equal(target.getData().project.id, before);
  } finally {
    try { if (source && source.db) source.db.close(); } catch (_) {}
    try { if (target && target.db) target.db.close(); } catch (_) {}
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('SQLite state history stays isolated when projects are switched', () => {
  const dir = tempDir();
  let store;
  try {
    store = new SqliteStore(dir, BetterSqliteCompat);
    const firstId = store.getData().project.id;
    store.saveProjectState(stateWithDrawing('first'));
    const second = store.createProject({ name: 'Отдельный проект' });
    assert.equal(store.getProjectState().payload.drawings.length, 0);
    store.saveProjectState(stateWithDrawing('second'));
    store.switchProject(firstId);
    assert.equal(store.getProjectState().payload.drawings[0].id, 'first');
    store.switchProject(second.id);
    assert.equal(store.getProjectState().payload.drawings[0].id, 'second');
  } finally { try { store && store.db.close(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); }
});