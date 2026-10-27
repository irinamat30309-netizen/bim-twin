'use strict';

// Large project assets are stored separately from the JSON/SQLite metadata
// graph. References are content-addressed and can therefore be included in a
// workspace backup without embedding point-sized buffers in project_state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('./atomic-file');
const ProjectState = require('./project-state');

const MAX_CLASSIFICATION_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_ASSETS_BYTES = 512 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;

function validId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError((label || 'id') + ' must be a non-empty string of at most 512 characters');
  }
  return value;
}

function idHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('classification labels must be an ArrayBuffer or typed array');
}

function safeMetadata(value, label) {
  if (value == null) return {};
  const cloned = ProjectState.cloneJsonSafe(value, label || 'asset metadata');
  const size = Buffer.byteLength(JSON.stringify(cloned), 'utf8');
  if (size > 256 * 1024) throw new RangeError((label || 'asset metadata') + ' is too large');
  return cloned;
}

class ProjectAssetStore {
  constructor(storeDir, options) {
    options = options || {};
    this.root = path.resolve(options.root || path.join(storeDir, 'project-assets'));
    this.fs = options.fs || fs;
  }

  _classificationPath(projectId, cloudId, digest) {
    if (!HASH_RE.test(digest)) throw new TypeError('invalid classification SHA-256');
    return path.join(
      this.root, 'classifications',
      idHash(validId(projectId, 'projectId')),
      idHash(validId(cloudId, 'cloudId')),
      digest + '.u8'
    );
  }

  saveClassification(input) {
    input = input || {};
    const projectId = validId(input.projectId, 'projectId');
    const cloudId = validId(input.cloudId, 'cloudId');
    const labels = asBytes(input.labels);
    const count = Number(input.pointCount);
    if (!Number.isSafeInteger(count) || count < 0 || count !== labels.length) {
      throw new RangeError('classification pointCount must equal the label-buffer length');
    }
    if (!labels.length || labels.length > MAX_CLASSIFICATION_BYTES) {
      throw new RangeError('classification label buffer must be 1..' + MAX_CLASSIFICATION_BYTES + ' bytes');
    }
    const sourceHash = input.sourceHash == null ? null : String(input.sourceHash).replace(/^sha256:/i, '').toLowerCase();
    if (sourceHash != null && !HASH_RE.test(sourceHash)) throw new TypeError('sourceHash must be a SHA-256 hex digest');
    const digest = sha256(labels);
    const file = this._classificationPath(projectId, cloudId, digest);
    if (this.fs.existsSync(file)) {
      const existing = this.fs.readFileSync(file);
      if (sha256(existing) !== digest) throw new Error('existing classification asset failed integrity check');
    } else {
      atomicWriteFileSync(file, labels, { fs: this.fs, mode: 0o600 });
    }
    return {
      id: 'cls_' + crypto.randomUUID(),
      cloudId,
      algorithm: String(input.algorithm || 'unknown').slice(0, 120),
      parameters: safeMetadata(input.parameters, 'classification parameters'),
      sourceHash,
      sourceTransform: input.sourceTransform == null ? null : safeMetadata(input.sourceTransform, 'source transform'),
      crsWkt: input.crsWkt == null ? null : String(input.crsWkt).slice(0, 128 * 1024),
      pointCount: count,
      counts: safeMetadata(input.counts, 'classification counts'),
      asset: { kind: 'classification-labels-u8-v1', sha256: digest, bytes: labels.length },
      createdAt: input.createdAt == null ? new Date().toISOString() : new Date(input.createdAt).toISOString()
    };
  }

  loadClassification(projectId, cloudId, digest) {
    const normalizedDigest = String(digest || '').toLowerCase();
    const file = this._classificationPath(projectId, cloudId, normalizedDigest);
    let bytes;
    try { bytes = this.fs.readFileSync(file); }
    catch (cause) {
      if (cause && cause.code === 'ENOENT') {
        const error = new Error('classification asset is missing');
        error.code = 'ASSET_NOT_FOUND';
        error.cause = cause;
        throw error;
      }
      throw cause;
    }
    if (sha256(bytes) !== normalizedDigest) {
      const error = new Error('classification asset SHA-256 mismatch');
      error.code = 'ASSET_CORRUPT';
      throw error;
    }
    return { labels: new Uint8Array(bytes), sha256: normalizedDigest, bytes: bytes.length };
  }

  exportAssets(records) {
    const refs = new Map();
    function add(projectId, state) {
      if (!state || !Array.isArray(state.classifications)) return;
      for (const item of state.classifications) {
        const asset = item && item.asset;
        if (!item || !item.cloudId || !asset || asset.kind !== 'classification-labels-u8-v1' || !HASH_RE.test(String(asset.sha256 || ''))) continue;
        refs.set([projectId, item.cloudId, asset.sha256].join('\0'), { projectId, cloudId: item.cloudId, sha256: asset.sha256 });
      }
    }
    if (Array.isArray(records)) {
      for (const row of records) {
        if (!row || !row.projectId || !row.record) continue;
        add(row.projectId, row.record.payload);
        for (const revision of row.record.history || []) add(row.projectId, revision && revision.payload);
      }
    } else {
      for (const [projectId, record] of Object.entries(records || {})) {
        add(projectId, record && record.payload);
        for (const revision of (record && record.history) || []) add(projectId, revision && revision.payload);
      }
    }

    let totalBytes = 0;
    const exported = [];
    for (const ref of refs.values()) {
      const file = this._classificationPath(ref.projectId, ref.cloudId, ref.sha256);
      const bytes = this.fs.readFileSync(file);
      if (sha256(bytes) !== ref.sha256) throw new Error('classification asset is missing or corrupt: ' + ref.sha256);
      totalBytes += bytes.length;
      if (totalBytes > MAX_BACKUP_ASSETS_BYTES) throw new RangeError('classification assets exceed the backup size limit');
      exported.push({
        kind: 'classification-labels-u8-v1',
        projectId: ref.projectId,
        cloudId: ref.cloudId,
        sha256: ref.sha256,
        bytes: bytes.length,
        dataBase64: bytes.toString('base64')
      });
    }
    return exported;
  }

  importAssets(assets) {
    if (assets == null) return { imported: 0, bytes: 0 };
    if (!Array.isArray(assets)) throw new TypeError('project assets must be an array');
    let totalBytes = 0, imported = 0;
    const seen = new Set();
    for (const item of assets) {
      if (!item || item.kind !== 'classification-labels-u8-v1') throw new TypeError('unsupported project asset kind');
      const projectId = validId(item.projectId, 'projectId');
      const cloudId = validId(item.cloudId, 'cloudId');
      const digest = String(item.sha256 || '').toLowerCase();
      if (!HASH_RE.test(digest)) throw new TypeError('invalid classification SHA-256');
      const key = [projectId, cloudId, digest].join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof item.dataBase64 !== 'string' || item.dataBase64.length > MAX_CLASSIFICATION_BYTES * 4 / 3 + 8 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.dataBase64)) {
        throw new TypeError('invalid classification asset encoding');
      }
      const bytes = Buffer.from(item.dataBase64, 'base64');
      if (!bytes.length || bytes.length > MAX_CLASSIFICATION_BYTES || bytes.length !== Number(item.bytes) || sha256(bytes) !== digest) {
        throw new Error('classification asset size or checksum mismatch');
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_BACKUP_ASSETS_BYTES) throw new RangeError('classification assets exceed the backup size limit');
      const file = this._classificationPath(projectId, cloudId, digest);
      if (this.fs.existsSync(file)) {
        if (sha256(this.fs.readFileSync(file)) !== digest) throw new Error('existing classification asset failed integrity check');
      } else {
        atomicWriteFileSync(file, bytes, { fs: this.fs, mode: 0o600 });
      }
      imported++;
    }
    return { imported, bytes: totalBytes };
  }

  deleteProject(projectId) {
    const dir = path.join(this.root, 'classifications', idHash(validId(projectId, 'projectId')));
    this.fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  ProjectAssetStore,
  MAX_CLASSIFICATION_BYTES,
  MAX_BACKUP_ASSETS_BYTES,
  sha256,
  idHash
};