'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CloudAutosaveStore } = require('../db/cloud-autosave');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bim-autosave-stage2-')); }
function bytes(text) { return Buffer.from('ply\nformat binary_little_endian 1.0\n' + text, 'utf8'); }

test('autosave revisions are immutable, hash-verified, project-journaled and retain source metadata', async () => {
  const root = tempDir(), operations = [];
  const sourcePath = '/synthetic-fixtures/sample-room.las';
  const projectId = 'project-roundtrip-tests';
  try {
    const store = new CloudAutosaveStore({
      root,
      getAppVersion: () => 'stage2-test',
      getSourceHash: async p => p === sourcePath ? 'a'.repeat(64) : null,
      recordOperation: (entry, projectId) => operations.push({ entry, projectId })
    });
    const options = {
      key: `project:${projectId}\u0000${sourcePath}`, sourcePath, projectId,
      name: 'synthetic-room.las', points: 2,
      sourceTransform: { axis: 'zup', t: [500000, 6000000, 112.5] },
      crsWkt: 'LOCAL_CS["Тестовая система координат"]'
    };
    const firstBytes = bytes('revision-1');
    const first = await store.save(Object.assign({}, options, { binary: firstBytes, operation: { operation: 'cloud.clean', parameters: { voxel: 0.02 } } }));
    assert.equal(first.ok, true);
    assert.equal(first.inputHash, 'a'.repeat(64));
    assert.equal(first.revisions, 1);
    assert.equal(operations[0].projectId, 'project-roundtrip-tests');
    assert.equal(operations[0].entry.operation, 'cloud.clean');
    assert.equal(operations[0].entry.appVersion, 'stage2-test');
    assert.equal(operations[0].entry.inputHash, 'a'.repeat(64));
    assert.deepEqual(operations[0].entry.parameters, {
      voxel: 0.02, snapshotFormat: 'ply', sourceName: options.name,
      sourceTransform: options.sourceTransform, crsWkt: options.crsWkt
    });
    assert.deepEqual(operations[0].entry.output, {
      sha256: first.sha256, bytes: firstBytes.length, points: options.points, revisionCount: 1
    });
    assert.deepEqual(operations[0].entry.warnings, []);

    const secondBytes = bytes('revision-2');
    const second = await store.save(Object.assign({}, options, { binary: secondBytes, operation: { operation: 'cloud.align' } }));
    assert.equal(second.ok, true);
    assert.equal(second.inputHash, first.sha256);
    assert.equal(second.revisions, 2);
    assert.equal(operations[1].entry.inputHash, first.sha256);
    assert.notEqual(second.path, first.path);
    assert.deepEqual(fs.readFileSync(first.path), firstBytes);
    assert.deepEqual(fs.readFileSync(second.path), secondBytes);

    const unchanged = await store.save(Object.assign({}, options, { binary: secondBytes }));
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.path, second.path);

    const latest = await store.load({ key: options.key });
    assert.equal(latest.ok, true);
    assert.equal(latest.exists, true);
    assert.equal(latest.sha256, second.sha256);
    assert.deepEqual(latest.sourceTransform, options.sourceTransform);
    assert.equal(latest.crsWkt, options.crsWkt);
    assert.equal(latest.revisions.length, 2);
    const old = await store.load({ key: options.key, sha256: first.sha256 });
    assert.equal(old.ok, true);
    assert.deepEqual(fs.readFileSync(old.path), firstBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manifest backup recovers the last committed revision and corrupt latest snapshot falls back safely', async () => {
  const root = tempDir();
  try {
    const store = new CloudAutosaveStore({ root });
    const key = 'cloud-recovery';
    const first = await store.save({ key, binary: bytes('valid') });
    const second = await store.save({ key, binary: bytes('newer') });
    assert.equal(second.ok, true);
    fs.writeFileSync(second.path, 'tampered');
    const fallback = await store.load({ key });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.sha256, first.sha256);
    assert.equal(fallback.recovered, true);
    assert.deepEqual(fs.readFileSync(fallback.path), bytes('valid'));

    const third = await store.save({ key, binary: bytes('third') });
    assert.equal(third.ok, true);
    fs.writeFileSync(store.manifestPath(key), '{ interrupted');
    const recoveredBackup = await store.load({ key });
    assert.equal(recoveredBackup.ok, true);
    assert.equal(recoveredBackup.exists, true);
    assert.equal(recoveredBackup.recovered, true);
    assert.ok(fs.existsSync(store.manifestPath(key) + '.bak'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed manifest commit preserves the old committed pointer and all prior bytes', async () => {
  const root = tempDir();
  try {
    const store = new CloudAutosaveStore({ root });
    const key = 'atomic-save';
    const firstBytes = bytes('committed');
    const first = await store.save({ key, binary: firstBytes });
    const writeManifest = store._writeManifest.bind(store);
    store._writeManifest = () => { throw new Error('simulated disk-full'); };
    const failed = await store.save({ key, binary: bytes('uncommitted') });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'autosave_manifest_write_failed');
    store._writeManifest = writeManifest;
    const loaded = await store.load({ key });
    assert.equal(loaded.sha256, first.sha256);
    assert.deepEqual(fs.readFileSync(loaded.path), firstBytes);
    assert.equal(fs.readdirSync(store.keyDir(key)).filter(name => /^rev-/.test(name)).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('acknowledging a draft hides automatic recovery but keeps selectable history', async () => {
  const root = tempDir();
  try {
    const store = new CloudAutosaveStore({ root });
    const key = 'acknowledge';
    const first = await store.save({ key, binary: bytes('one') });
    await store.save({ key, binary: bytes('two') });
    const cleared = await store.clear({ key });
    assert.equal(cleared.ok, true);
    const hidden = await store.load({ key });
    assert.equal(hidden.exists, false);
    assert.equal(hidden.acknowledged, true);
    assert.equal(hidden.revisions.length, 2);
    const history = await store.load({ key, includeCleared: true });
    assert.equal(history.exists, true);
    const old = await store.load({ key, sha256: first.sha256 });
    assert.equal(old.exists, true);
    assert.equal(old.sha256, first.sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy mutable draft migrates before the next save without losing its recovery version', async () => {
  const root = tempDir();
  try {
    const store = new CloudAutosaveStore({ root });
    const key = 'legacy/облако.las';
    const legacyBytes = bytes('old-draft');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(store.legacyPath(key), legacyBytes);
    fs.writeFileSync(store.legacyMetaPath(key), JSON.stringify({ name: 'старый черновик.ply', points: 9, savedAt: Date.now() - 1000 }));
    const prior = await store.load({ key });
    assert.equal(prior.ok, true);
    assert.equal(prior.legacy, true);
    assert.deepEqual(fs.readFileSync(prior.path), legacyBytes);

    const next = await store.save({ key, binary: bytes('new-draft') });
    assert.equal(next.ok, true);
    const history = await store.load({ key, includeCleared: true });
    assert.equal(history.revisions.length, 2);
    const migrated = await store.load({ key, sha256: prior.sha256 });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.exists, true);
    assert.deepEqual(fs.readFileSync(migrated.path), legacyBytes);
    assert.equal(fs.existsSync(store.legacyPath(key)), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid binary and transform metadata are rejected before a manifest is committed', async () => {
  const root = tempDir();
  try {
    const store = new CloudAutosaveStore({ root });
    assert.equal((await store.save({ key: 'bad', binary: 100 })).ok, false);
    await assert.rejects(store.save({ key: 'bad-transform', binary: bytes('x'), sourceTransform: { axis: 'wrong', t: [0, 0, 0] } }), /sourceTransform/);
    assert.equal(fs.existsSync(store.manifestPath('bad-transform')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});