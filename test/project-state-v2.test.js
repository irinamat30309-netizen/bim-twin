'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JsonStore } = require('../db/jsonStore');
const ProjectState = require('../db/project-state');

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function projectPayload(overrides) {
  return Object.assign(ProjectState.emptyProjectState(), {
    clouds: [{ id: 'cloud-1', name: 'Обмер — Жилой дом', sourceHash: 'abc', crs: { epsg: 32636 }, transformId: 't1' }],
    layers: [{ id: 'layer-1', visible: true }],
    transforms: [{ id: 't1', axis: 'zup', offset: [500000, 6000000, 100] }],
    classifications: [{ id: 'c1', class: 'wall', pointCount: 42 }],
    sectionSets: [{ id: 's1', name: 'Этаж 1', axis: 'y', level: 2.5 }],
    measurements: [{ id: 'm1', mode: 'distance', d3: 1.25 }],
    drawings: [{ id: 'd1', entities: [{ type: 'line', a: [0, 0, 0], b: [1, 0, 0] }] }],
    documents: [{ id: 'doc1', file: 'uploads/План этажа.pdf', mime: 'application/pdf' }]
  }, overrides || {});
}

test('project state schema migrates v0 names and hashes deterministically', () => {
  const legacy = ProjectState.normalizeProjectState('p1', {
    schemaVersion: 0,
    sectionPresets: [{ id: 'sec-old', name: 'Контроль' }],
    measurementList: [{ mode: 'distance' }],
    drawingEntities: [{ type: 'point', p: [1, 2, 3] }]
  });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.sectionSets[0].id, 'sec-old');
  assert.equal(legacy.measurements.length, 1);
  assert.equal(legacy.drawings[0].entities.length, 1);
  assert.equal(ProjectState.hashJson({ b: 2, a: 1 }), ProjectState.hashJson({ a: 1, b: 2 }));
});

test('project state commits, undo/redo and branch history survive restart', () => {
  const dir = tempDir('bim-state-');
  try {
    let store = new JsonStore(dir);
    const pid = store.getData().project.id;
    const start = store.getProjectState();
    const first = store.saveProjectState(projectPayload(), { expectedRevision: start.revision, operation: { operation: 'cloud.register', parameters: { method: 'rigid' } } });
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    assert.equal(first.payload.clouds[0].crs.epsg, 32636);
    assert.equal(first.canUndo, true);
    const revisionCountBeforeRepeat = store.listProjectRevisions(pid).length;
    const operationCountBeforeRepeat = store.listOperations(100, pid).length;
    const repeated = store.saveProjectState(projectPayload(), { expectedRevision: first.revision });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.payloadHash, first.payloadHash);
    assert.equal(store.listProjectRevisions(pid).length, revisionCountBeforeRepeat);
    assert.equal(store.listOperations(100, pid).length, operationCountBeforeRepeat);

    const changed = projectPayload({ measurements: [{ id: 'm2', mode: 'distance', d3: 2 }] });
    const second = store.saveProjectState(changed, { expectedRevision: first.revision, operation: { operation: 'measure.save', parameters: { unit: 'm' } } });
    assert.equal(second.historyRevision, 2);
    assert.equal(store.undoProjectState({ expectedRevision: second.revision }).payload.measurements[0].id, 'm1');
    const afterUndo = store.getProjectState();
    assert.equal(afterUndo.canRedo, true);
    assert.equal(store.redoProjectState({ expectedRevision: afterUndo.revision }).payload.measurements[0].id, 'm2');

    const undone = store.undoProjectState();
    const branch = projectPayload({ drawings: [{ id: 'branch', entities: [] }] });
    const branched = store.saveProjectState(branch, { expectedRevision: undone.revision });
    assert.equal(branched.canRedo, false);
    assert.equal(store.listProjectRevisions().at(-1).current, true);
    assert.ok(store.listOperations(20).some(op => op.operation === 'project.undo'));

    store = new JsonStore(dir);
    assert.equal(store.getProjectState().payload.drawings[0].id, 'branch');
    assert.equal(store.getProjectState(pid).projectId, pid);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('state is project-scoped and backup preserves revisions, operation journal, Unicode', () => {
  const dir = tempDir('bim-state-');
  try {
    const store = new JsonStore(dir);
    const firstId = store.getData().project.id;
    store.saveProjectState(projectPayload(), { operation: { operation: 'cloud.clean', inputHash: 'a'.repeat(64), parameters: { voxel: 0.02 }, output: { removed: 3 }, warnings: ['контроль'], appVersion: 'test-1' } });
    const secondProject = store.createProject({ name: 'Проєкт — ЖБК «Сонячний»' });
    assert.equal(store.getProjectState().payload.clouds.length, 0);
    store.saveProjectState(projectPayload({ clouds: [{ id: 'other', name: 'Другой проект' }] }));
    assert.equal(store.switchProject(firstId).id, firstId);
    assert.equal(store.getProjectState().payload.clouds[0].id, 'cloud-1');

    const backup = store.exportBackup();
    const parsed = JSON.parse(backup);
    assert.equal(parsed.version, 5);
    assert.equal(parsed.checksum.algorithm, 'sha256');
    const otherDir = tempDir('bim-state-backup-');
    try {
      const restored = new JsonStore(otherDir);
      restored.importBackup(backup);
      assert.equal(restored.listProjects().some(p => p.name === secondProject.name), true);
      assert.equal(restored.getProjectState(firstId).payload.documents[0].file, 'uploads/План этажа.pdf');
      const cleanOperation = restored.listOperations(10, firstId).find(op => op.operation === 'cloud.clean' && op.inputHash === 'a'.repeat(64));
      assert.ok(cleanOperation);
      assert.ok(Number.isFinite(Date.parse(cleanOperation.createdAt)));
      parsed.data.project.name += ' tampered';
      assert.throws(() => restored.importBackup(parsed), /checksum mismatch/);
    } finally { fs.rmSync(otherDir, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSON store recovers last committed backup and keeps a corrupt copy', () => {
  const dir = tempDir('bim-recovery-');
  try {
    let store = new JsonStore(dir);
    store.updateProject({ name: 'Последнее сохранённое' });
    store.updateProject({ name: 'Повреждаемая запись' });
    fs.writeFileSync(path.join(dir, 'store.json'), '{"interrupted":', 'utf8');
    store = new JsonStore(dir);
    assert.equal(store.getData().project.name, 'Последнее сохранённое');
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('store.json.corrupt-')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).project.name, 'Последнее сохранённое');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt store without a valid backup is not silently replaced by seed data', () => {
  const dir = tempDir('bim-corrupt-');
  try {
    new JsonStore(dir);
    fs.rmSync(path.join(dir, 'store.json.bak'), { force: true });
    const original = 'not a database';
    fs.writeFileSync(path.join(dir, 'store.json'), original);
    assert.throws(() => new JsonStore(dir), e => e && e.code === 'STORE_CORRUPT');
    assert.equal(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('write error rolls back the in-memory project and leaves the old file readable', () => {
  const dir = tempDir('bim-write-fail-');
  const oldRename = fs.renameSync;
  try {
    const store = new JsonStore(dir);
    const before = store.getData().project.name;
    fs.renameSync = function (from, to) {
      if (to === store.storePath) { const err = new Error('simulated disk error'); err.code = 'EIO'; throw err; }
      return oldRename.call(fs, from, to);
    };
    assert.throws(() => store.updateProject({ name: 'Не должно сохраниться' }), /simulated disk error/);
    assert.equal(store.getData().project.name, before);
    fs.renameSync = oldRename;
    assert.equal(new JsonStore(dir).getData().project.name, before);
  } finally {
    fs.renameSync = oldRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EACCES during atomic file creation rejects a project commit without changing durable or in-memory state', () => {
  const dir = tempDir('bim-eacces-');
  const oldOpen = fs.openSync;
  try {
    const store = new JsonStore(dir);
    const before = store.getProjectState();
    const bytesBefore = fs.readFileSync(store.storePath);
    fs.openSync = function (file, flags, mode) {
      if (String(file).startsWith(path.join(dir, '.store.json.tmp-'))) {
        const error = new Error('simulated permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return oldOpen.call(fs, file, flags, mode);
    };
    assert.throws(
      () => store.saveProjectState(projectPayload({ measurements: [{ id: 'blocked-write', mode: 'distance', d3: 99 }] }), { expectedRevision: before.revision }),
      error => error && error.code === 'EACCES'
    );
    fs.openSync = oldOpen;
    assert.equal(store.getProjectState().payloadHash, before.payloadHash);
    assert.deepEqual(fs.readFileSync(store.storePath), bytesBefore);
  } finally {
    fs.openSync = oldOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const canTestOsPermissions = (() => {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return false;
  try {
    const probe = spawnSync('setpriv', [
      '--reuid=65534', '--regid=65534', '--clear-groups',
      '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
      '--', process.execPath, '-e', 'process.exit(0)'
    ], {
      stdio: 'ignore', timeout: 5000
    });
    return !probe.error && probe.status === 0;
  } catch (_) { return false; }
})();

test('real Linux DAC denial leaves the durable and in-memory project unchanged', { skip: !canTestOsPermissions }, () => {
  const storeModule = JSON.stringify(path.resolve(__dirname, '../db/jsonStore.js'));
  const childScript = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { JsonStore } = require(${storeModule});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-real-acl-'));
    try {
      const store = new JsonStore(dir);
      const before = store.getProjectState();
      const bytes = fs.readFileSync(store.storePath);
      fs.chmodSync(dir, 0o500);
      let denied = false;
      try {
        store.saveProjectState(Object.assign({}, before.payload, {
          measurements: [{ id: 'acl-denied', mode: 'distance', d3: 99 }]
        }), { expectedRevision: before.revision });
      } catch (error) {
        if (!error || (error.code !== 'EACCES' && error.code !== 'EPERM')) throw error;
        denied = true;
      }
      assert.equal(denied, true, 'read-only directory must reject the atomic temp-file creation');
      assert.equal(store.getProjectState().payloadHash, before.payloadHash);
      assert.deepEqual(fs.readFileSync(store.storePath), bytes);
      console.log('OS_DAC_EACCES_OK');
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  `;
  const result = spawnSync('setpriv', [
    '--reuid=65534', '--regid=65534', '--clear-groups',
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
    '--',
    process.execPath, '-e', childScript
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error || 'permission child failed');
  assert.match(result.stdout, /OS_DAC_EACCES_OK/);
});

test('hard process exit after a committed save can be reopened with Unicode paths', () => {
  const parent = tempDir('bim-проект-');
  const dir = path.join(parent, 'данные');
  const script = `
    const {JsonStore}=require(${JSON.stringify(path.resolve(__dirname, '../db/jsonStore'))});
    const s=new JsonStore(${JSON.stringify(dir)});
    const state=s.getProjectState();
    const payload=state.payload;
    payload.drawings=[{id:'crash-safe',entities:[{type:'point',p:[1,2,3]}]}];
    s.saveProjectState(payload,{expectedRevision:state.revision});
    process.exit(0);
  `;
  try {
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const reopened = new JsonStore(dir);
    assert.equal(reopened.getProjectState().payload.drawings[0].id, 'crash-safe');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('abrupt termination during atomic temp-file write preserves the previous commit and cleans stale temp files', () => {
  const dir = tempDir('bim-kill-during-save-');
  const storeModule = JSON.stringify(path.resolve(__dirname, '../db/jsonStore.js'));
  const directory = JSON.stringify(dir);
  const terminateChild = process.platform === 'win32'
    ? 'process.exit(86);'
    : "process.kill(process.pid, 'SIGKILL');";
  try {
    let store = new JsonStore(dir);
    store.updateProject({ name: 'Сохранённая версия до остановки процесса' });
    const script = `
      const fs = require('node:fs');
      const { JsonStore } = require(${storeModule});
      const originalWrite = fs.writeFileSync.bind(fs);
      fs.writeFileSync = function (file, data, ...args) {
        if (typeof file === 'number') {
          originalWrite(file, Buffer.from(data).subarray(0, 32));
          ${terminateChild}
        }
        return originalWrite(file, data, ...args);
      };
      const store = new JsonStore(${directory});
      store.updateProject({ name: 'Эта версия не должна стать commit' });
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    if (process.platform === 'win32') {
      assert.equal(child.status, 86, child.stderr || 'child must exit inside the temp-file write');
    } else {
      assert.equal(child.signal, 'SIGKILL', child.stderr || 'child must be terminated inside the temp-file write');
    }
    store = new JsonStore(dir);
    assert.equal(store.getData().project.name, 'Сохранённая версия до остановки процесса');
    assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.store.json.tmp-')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});