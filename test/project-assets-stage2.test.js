'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../db/jsonStore');
const { ProjectAssetStore } = require('../db/project-assets');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bim-project-assets-')); }

test('classification labels are immutable, content-addressed and verified on read', () => {
  const root = tempDir();
  try {
    const assets = new ProjectAssetStore(root);
    const labels = new Uint8Array([0, 1, 2, 2, 5, 255]);
    const meta = assets.saveClassification({
      projectId: 'Проєкт — ЖК «Сонячний»',
      cloudId: 'облако/этаж-1',
      labels,
      pointCount: labels.length,
      algorithm: 'RANSAC structural planes',
      parameters: { planeDistance: 0.015, up: [0, 1, 0] },
      sourceHash: 'a'.repeat(64),
      sourceTransform: { axis: 'zup', t: [500000, 6000000, 112.5] },
      crsWkt: 'LOCAL_CS["test"]',
      counts: { wall: 2, floor: 1 }
    });
    const loaded = assets.loadClassification('Проєкт — ЖК «Сонячний»', 'облако/этаж-1', meta.asset.sha256);
    assert.deepEqual(Array.from(loaded.labels), Array.from(labels));
    assert.equal(loaded.sha256, meta.asset.sha256);
    assert.equal(loaded.bytes, labels.length);
    const same = assets.saveClassification({ projectId: meta.projectId || 'Проєкт — ЖК «Сонячний»', cloudId: 'облако/этаж-1', labels, pointCount: labels.length });
    assert.equal(same.asset.sha256, meta.asset.sha256);
    assert.throws(() => assets.saveClassification({ projectId: 'p', cloudId: 'c', labels, pointCount: labels.length - 1 }), /pointCount/);
    assert.throws(
      () => assets.loadClassification('Проєкт — ЖК «Сонячний»', 'облако/этаж-1', 'A'.repeat(64)),
      error => error.code === 'ASSET_NOT_FOUND'
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace backup round-trips classification bytes and project history', () => {
  const sourceDir = tempDir(), targetDir = tempDir();
  try {
    const source = new JsonStore(sourceDir);
    const projectId = source.getData().project.id;
    const labels = new Uint8Array([4, 4, 1, 0, 7, 9]);
    const metadata = source.projectAssets.saveClassification({
      projectId, cloudId: 'cloud-α', labels, pointCount: labels.length,
      algorithm: 'test-classifier', parameters: { threshold: 0.03 }, counts: { class4: 2 }
    });
    const initial = source.getProjectState(projectId);
    const next = Object.assign({}, initial.payload, {
      clouds: [{ id: 'cloud-α', source: 'Исходник — этаж 1.las', pointCount: labels.length }],
      classifications: [metadata]
    });
    source.saveProjectState(next, {
      projectId, expectedRevision: initial.revision,
      operation: { operation: 'cloud.classify.structure', inputHash: 'b'.repeat(64), parameters: { threshold: 0.03 } }
    });
    const backup = JSON.parse(source.exportBackup());
    assert.equal(backup.version, 5);
    assert.equal(backup.projectAssets.length, 1);
    assert.equal(backup.projectAssets[0].sha256, metadata.asset.sha256);

    const target = new JsonStore(targetDir);
    target.importBackup(JSON.stringify(backup));
    const restoredState = target.getProjectState(projectId);
    assert.equal(restoredState.payload.classifications[0].asset.sha256, metadata.asset.sha256);
    assert.deepEqual(
      Array.from(target.projectAssets.loadClassification(projectId, 'cloud-α', metadata.asset.sha256).labels),
      Array.from(labels)
    );
    assert.ok(target.listProjectRevisions(projectId).length >= 2);
    assert.ok(target.listOperations(10, projectId).some(row => row.operation === 'cloud.classify.structure'));
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('backup asset import rejects tampering and does not permit traversal through ids or digests', () => {
  const root = tempDir();
  try {
    const assets = new ProjectAssetStore(root);
    const labels = Buffer.from([1, 2, 3, 4]);
    const meta = assets.saveClassification({ projectId: '../outside', cloudId: '../../outside', labels, pointCount: labels.length });
    const record = {
      kind: 'classification-labels-u8-v1',
      projectId: '../outside',
      cloudId: '../../outside',
      sha256: meta.asset.sha256,
      bytes: labels.length,
      dataBase64: labels.toString('base64')
    };
    const result = assets.importAssets([record]);
    assert.equal(result.imported, 1);
    assert.deepEqual(Array.from(assets.loadClassification('../outside', '../../outside', meta.asset.sha256).labels), Array.from(labels));
    const assetPath = assets._classificationPath('../outside', '../../outside', meta.asset.sha256);
    assert.equal(path.relative(path.resolve(root), assetPath).startsWith('..'), false);
    const tampered = Object.assign({}, record, { dataBase64: Buffer.from([9, 9, 9, 9]).toString('base64') });
    assert.throws(() => assets.importAssets([tampered]), /checksum mismatch/);
    const outside = path.resolve(root, '..', 'outside');
    assert.equal(fs.existsSync(outside), false);
    assert.throws(() => assets.importAssets([Object.assign({}, record, { sha256: '../file', dataBase64: '!!!!' })]), /invalid classification SHA-256/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});