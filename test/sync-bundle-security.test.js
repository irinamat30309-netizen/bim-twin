'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAGIC,
  writeSyncBundle,
  readSyncBundleToStage,
  installStagedFiles
} = require('../sync-bundle');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-sync-'));
  const uploads = path.join(root, 'uploads');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(uploads);
  return { root, uploads, stage, bundle: path.join(root, 'workspace.bimsync') };
}

test('v2 sync bundle streams workspace and Unicode files with verified hashes', async () => {
  const env = tempRoot();
  try {
    fs.writeFileSync(path.join(env.uploads, 'фасад.ply'), Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a));
    fs.writeFileSync(path.join(env.uploads, 'plan.pdf'), 'PDF');
    const written = await writeSyncBundle(env.bundle, {
      workspace: { schema: 5, project: { id: 'p1', name: 'Тест' }, files: { ignored: true } },
      uploadsDir: env.uploads
    });
    assert.equal(written.files, 2);
    assert.equal(fs.readFileSync(env.bundle).subarray(0, MAGIC.length).equals(MAGIC), true);

    const read = await readSyncBundleToStage(env.bundle, env.stage);
    assert.equal(read.format, 'bimsync-v2');
    assert.equal(read.workspace.files, undefined);
    assert.equal(read.workspace.project.name, 'Тест');
    assert.deepEqual(read.files.map(file => file.name).sort(), ['plan.pdf', 'фасад.ply'].sort());
    assert.equal(fs.readFileSync(path.join(env.stage, 'фасад.ply')).length, 2 * 1024 * 1024 + 17);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('legacy JSON import rejects traversal and malformed base64 before writing outside stage', async () => {
  const env = tempRoot();
  const outside = path.join(env.root, 'outside.txt');
  try {
    fs.writeFileSync(env.bundle, JSON.stringify({
      schema: 1,
      files: { '../outside.txt': Buffer.from('owned').toString('base64') }
    }));
    await assert.rejects(readSyncBundleToStage(env.bundle, env.stage), /invalid_bundle_file_name/);
    assert.equal(fs.existsSync(outside), false);

    fs.rmSync(env.stage, { recursive: true, force: true });
    fs.writeFileSync(env.bundle, JSON.stringify({ schema: 1, files: { 'safe.txt': 'not base64!' } }));
    await assert.rejects(readSyncBundleToStage(env.bundle, env.stage), /invalid_base64/);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('v2 reader rejects corruption and truncated payloads', async () => {
  const env = tempRoot();
  try {
    fs.writeFileSync(path.join(env.uploads, 'cloud.las'), Buffer.alloc(128 * 1024, 7));
    await writeSyncBundle(env.bundle, { workspace: { schema: 1 }, uploadsDir: env.uploads });
    const bytes = fs.readFileSync(env.bundle);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(env.bundle, bytes);
    await assert.rejects(readSyncBundleToStage(env.bundle, env.stage), /(bundle_hash_mismatch|invalid_bundle_header_json)/);

    fs.rmSync(env.stage, { recursive: true, force: true });
    fs.unlinkSync(env.bundle);
    await writeSyncBundle(env.bundle, { workspace: { schema: 1 }, uploadsDir: env.uploads });
    const clean = fs.readFileSync(env.bundle);
    fs.writeFileSync(env.bundle, clean.subarray(0, clean.length - 10));
    await assert.rejects(readSyncBundleToStage(env.bundle, env.stage), /(truncated_bundle|bundle_end_missing)/);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('staged file installation can roll back replacements transactionally', async () => {
  const env = tempRoot();
  try {
    fs.mkdirSync(env.stage);
    fs.writeFileSync(path.join(env.uploads, 'model.ply'), 'old');
    fs.writeFileSync(path.join(env.stage, 'model.ply'), 'new');
    const tx = installStagedFiles([{ name: 'model.ply', path: path.join(env.stage, 'model.ply') }], env.uploads);
    assert.equal(fs.readFileSync(path.join(env.uploads, 'model.ply'), 'utf8'), 'new');
    tx.rollback();
    assert.equal(fs.readFileSync(path.join(env.uploads, 'model.ply'), 'utf8'), 'old');

    fs.writeFileSync(path.join(env.stage, 'model.ply'), 'final');
    const tx2 = installStagedFiles([{ name: 'model.ply', path: path.join(env.stage, 'model.ply') }], env.uploads);
    tx2.complete();
    assert.equal(fs.readFileSync(path.join(env.uploads, 'model.ply'), 'utf8'), 'final');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});