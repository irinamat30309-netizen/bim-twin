'use strict';

// Immutable, content-hashed cloud-edit snapshots. A manifest is the commit
// pointer; a snapshot is durable before that pointer changes. Corruption of the
// newest snapshot therefore falls back to the last verifiable revision.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('./atomic-file');

const HASH_RE = /^[a-f0-9]{64}$/;
const FILE_RE = /^rev-[A-Za-z0-9-]+\.ply$/;
const MAX_SNAPSHOTS = 8;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function oldHash(key) {
  const s = String(key || 'default');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'as_' + (h >>> 0).toString(36);
}

function safeName(value) {
  const name = path.basename(String(value || 'cloud.ply').replace(/\\/g, '/')).normalize('NFC');
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').slice(0, 120) || 'cloud.ply';
}

function sanitize(value, depth) {
  depth = depth || 0;
  if (depth > 40) throw new RangeError('operation metadata nesting is too deep');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (ArrayBuffer.isView(value)) return Array.from(value, v => sanitize(v, depth + 1));
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || value[key] === undefined) continue;
      out[key] = sanitize(value[key], depth + 1);
    }
    return out;
  }
  return String(value);
}

function normalizeSourceTransform(value, strict) {
  if (value == null) return null;
  const valid = value && typeof value === 'object' &&
    (value.axis === 'zup' || value.axis === 'yup') &&
    Array.isArray(value.t) && value.t.length >= 3 &&
    value.t.slice(0, 3).every(Number.isFinite);
  if (!valid) {
    if (strict) throw new TypeError('sourceTransform must contain axis zup/yup and three finite offsets');
    return null;
  }
  return { axis: value.axis, t: value.t.slice(0, 3).map(Number) };
}

function hashFile(fsImpl, file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function copyFileDurable(fsImpl, source, target) {
  const dir = path.dirname(target);
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${token}`);
  let fd;
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
    // A read-only descriptor can make fsync fail with EPERM on Windows.
    // This is a newly copied temp file owned by the app, so use read/write.
    fsImpl.chmodSync(tmp, 0o600);
    fd = fsImpl.openSync(tmp, 'r+');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tmp, target);
    return target;
  } catch (error) {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch (_) {}
    try { fsImpl.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function bytesFromInput(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('binary must be a Buffer, ArrayBuffer, or typed-array view');
}

class CloudAutosaveStore {
  constructor(options) {
    options = options || {};
    if (!options.root) throw new TypeError('autosave root is required');
    this.root = path.resolve(options.root);
    this.fs = options.fs || fs;
    this.recordOperation = options.recordOperation || null;
    this.getAppVersion = options.getAppVersion || (() => 'unknown');
    this.getSourceHash = options.getSourceHash || null;
    this.keep = Math.max(2, Math.min(MAX_SNAPSHOTS, Number(options.keep) || MAX_SNAPSHOTS));
  }

  keyHash(key) {
    return 'as_' + crypto.createHash('sha256').update(String(key || 'default'), 'utf8').digest('hex').slice(0, 32);
  }
  keyDir(key) { return path.join(this.root, this.keyHash(key)); }
  manifestPath(key) { return path.join(this.keyDir(key), 'manifest.json'); }
  legacyPath(key) { return path.join(this.root, oldHash(key) + '.ply'); }
  legacyMetaPath(key) { return this.legacyPath(key) + '.json'; }
  legacyVersionedDir(key) { return path.join(this.root, oldHash(key)); }

  _readCandidate(file, expectedKeyHash) {
    const manifest = JSON.parse(this.fs.readFileSync(file, 'utf8'));
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.snapshots) ||
        manifest.keyHash !== expectedKeyHash) return null;
    const snapshots = [];
    for (const row of manifest.snapshots) {
      if (!row || typeof row !== 'object' || !FILE_RE.test(String(row.file || '')) ||
          !HASH_RE.test(String(row.sha256 || ''))) continue;
      snapshots.push({
        file: row.file,
        sha256: row.sha256,
        savedAt: Number.isFinite(Number(row.savedAt)) && Number(row.savedAt) >= 0 ? Number(row.savedAt) : 0,
        points: Number.isSafeInteger(Number(row.points)) && Number(row.points) >= 0 ? Number(row.points) : 0,
        bytes: Number.isSafeInteger(Number(row.bytes)) && Number(row.bytes) >= 0 && Number(row.bytes) <= MAX_SNAPSHOT_BYTES ? Number(row.bytes) : 0,
        name: safeName(row.name || manifest.sourceName || 'cloud.ply'),
        sourceTransform: normalizeSourceTransform(row.sourceTransform, false),
        crsWkt: typeof row.crsWkt === 'string' && row.crsWkt.length <= 128 * 1024 ? row.crsWkt : null
      });
    }
    return {
      version: 1,
      keyHash: expectedKeyHash,
      latest: FILE_RE.test(String(manifest.latest || '')) && snapshots.some(row => row.file === manifest.latest) ? manifest.latest : null,
      snapshots,
      sourceName: safeName(manifest.sourceName || 'cloud.ply'),
      clearedAt: Number(manifest.clearedAt) || null
    };
  }

  _readManifestAt(dir, keyHash, primaryPath) {
    const primary = path.join(dir, 'manifest.json');
    const backup = primary + '.bak';
    let found = false;
    let failure = '';
    for (const candidate of [primary, backup]) {
      try { if (this.fs.existsSync(candidate)) found = true; } catch (_) {}
      try {
        const manifest = this._readCandidate(candidate, keyHash);
        if (!manifest) continue;
        if (candidate === backup && primaryPath) {
          // Restore the known-good backup without rotating a corrupt primary
          // over the only valid recovery point.
          try { atomicWriteJsonSync(primary, manifest, { fs: this.fs, mode: 0o600 }); } catch (_) {}
        }
        return { manifest, dir, recovered: candidate === backup, exists: true };
      } catch (error) { failure = String(error && error.message || error); }
    }
    if (found) {
      return {
        manifest: { version: 1, keyHash, latest: null, snapshots: [], sourceName: 'cloud.ply' },
        dir, recovered: false, exists: true, corrupt: true, error: failure || 'invalid_manifest'
      };
    }
    return null;
  }

  readManifest(key) {
    const current = this._readManifestAt(this.keyDir(key), this.keyHash(key), true);
    if (current) return current;
    // Compatibility for v10.1 drafts stored in a 32-bit hash directory.
    const legacy = this._readManifestAt(this.legacyVersionedDir(key), oldHash(key), false);
    if (legacy) return legacy;
    return {
      manifest: { version: 1, keyHash: this.keyHash(key), latest: null, snapshots: [], sourceName: 'cloud.ply' },
      dir: this.keyDir(key),
      recovered: false,
      exists: false
    };
  }

  _writeManifest(key, manifest) {
    const file = this.manifestPath(key);
    this.fs.mkdirSync(this.keyDir(key), { recursive: true });
    atomicWriteJsonSync(file, manifest, { fs: this.fs, backupPath: file + '.bak', mode: 0o600 });
  }

  async _migrateLegacyManifest(key, read) {
    const currentDir = this.keyDir(key);
    const rows = [];
    const sorted = read.manifest.snapshots.slice().sort((a, b) => {
      if (a.file === read.manifest.latest) return -1;
      if (b.file === read.manifest.latest) return 1;
      return (b.savedAt || 0) - (a.savedAt || 0);
    });
    for (const row of sorted) {
      if (rows.length >= this.keep) break;
      const source = path.join(read.dir, row.file);
      try {
        const stat = this.fs.statSync(source);
        if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES ||
            (row.bytes && stat.size !== row.bytes) || await hashFile(this.fs, source) !== row.sha256) continue;
        let name = row.file;
        let target = path.join(currentDir, name);
        if (this.fs.existsSync(target)) {
          let existingHash = null;
          try { existingHash = await hashFile(this.fs, target); } catch (_) {}
          if (existingHash !== row.sha256) {
            name = 'rev-migrated-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.ply';
            target = path.join(currentDir, name);
          }
        }
        if (!this.fs.existsSync(target)) copyFileDurable(this.fs, source, target);
        if (await hashFile(this.fs, target) !== row.sha256) continue;
        rows.push(Object.assign({}, row, { file: name }));
      } catch (_) {}
    }
    const latestRow = rows.find(row => row.file === read.manifest.latest) || rows[0] || null;
    const manifest = {
      version: 1,
      keyHash: this.keyHash(key),
      latest: latestRow && latestRow.file || null,
      snapshots: rows,
      sourceName: read.manifest.sourceName || 'cloud.ply',
      clearedAt: read.manifest.clearedAt || null
    };
    this._writeManifest(key, manifest);
    return { manifest, dir: currentDir, exists: true, recovered: !!read.recovered, migrated: true };
  }

  async _migrateMutableLegacy(key) {
    const source = this.legacyPath(key);
    if (!this.fs.existsSync(source)) return null;
    const stat = this.fs.statSync(source);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) return null;
    const digest = await hashFile(this.fs, source);
    let meta = null;
    try { meta = JSON.parse(this.fs.readFileSync(this.legacyMetaPath(key), 'utf8')); } catch (_) {}
    const name = safeName(meta && meta.name || 'cloud.ply');
    const fileName = 'rev-migrated-' + (Number(meta && meta.savedAt) || Date.now()) + '-' + crypto.randomBytes(4).toString('hex') + '.ply';
    const target = path.join(this.keyDir(key), fileName);
    copyFileDurable(this.fs, source, target);
    if (await hashFile(this.fs, target) !== digest) {
      try { this.fs.unlinkSync(target); } catch (_) {}
      throw new Error('legacy autosave failed integrity check while migrating');
    }
    const entry = {
      file: fileName, sha256: digest,
      savedAt: Number(meta && meta.savedAt) || stat.mtimeMs,
      points: Math.max(0, Number(meta && meta.points) | 0),
      bytes: stat.size, name
    };
    const manifest = {
      version: 1, keyHash: this.keyHash(key), latest: fileName,
      snapshots: [entry], sourceName: name, clearedAt: null
    };
    this._writeManifest(key, manifest);
    return { manifest, dir: this.keyDir(key), exists: true, recovered: false, migrated: true };
  }

  _revisionList(manifest) {
    return manifest.snapshots.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).map(row => ({
      savedAt: row.savedAt, points: row.points, bytes: row.bytes,
      sha256: row.sha256, latest: row.file === manifest.latest
    }));
  }

  async save(input) {
    input = input || {};
    const key = String(input.key || 'default');
    if (key.length > 8192) return { ok: false, error: 'key_too_long' };
    let view;
    try { view = bytesFromInput(input.binary); } catch (error) { return { ok: false, error: String(error.message || error) }; }
    if (!view.length) return { ok: false, error: 'empty' };
    if (view.length > MAX_SNAPSHOT_BYTES) return { ok: false, error: 'snapshot_too_large' };
    const bytes = Buffer.from(view);

    const digest = sha256(bytes), now = Date.now();
    const currentDir = this.keyDir(key);
    this.fs.mkdirSync(currentDir, { recursive: true });
    let read = this.readManifest(key);
    if (read.corrupt) return { ok: false, error: 'autosave_manifest_corrupt', message: read.error };
    if (read.exists && read.dir !== currentDir) {
      try { read = await this._migrateLegacyManifest(key, read); }
      catch (error) { return { ok: false, error: 'autosave_migration_failed', message: String(error && error.message || error) }; }
    } else if (!read.exists) {
      try {
        const migrated = await this._migrateMutableLegacy(key);
        if (migrated) read = migrated;
      } catch (error) { return { ok: false, error: 'autosave_migration_failed', message: String(error && error.message || error) }; }
    }
    const manifest = read.manifest;
    const previous = manifest.latest && manifest.snapshots.find(row => row.file === manifest.latest);
    const previousPath = previous && path.join(read.dir, previous.file);
    if (previous && previous.sha256 === digest && previousPath) {
      let currentValid = false;
      try {
        const stat = this.fs.statSync(previousPath);
        currentValid = stat.isFile() && stat.size === bytes.length && await hashFile(this.fs, previousPath) === digest;
      } catch (_) {}
      if (currentValid) {
        previous.savedAt = now;
        previous.points = Math.max(0, Number(input.points) | 0);
        previous.name = safeName(input.name || previous.name || 'cloud.ply');
        previous.sourceTransform = normalizeSourceTransform(input.sourceTransform, true);
        previous.crsWkt = typeof input.crsWkt === 'string' ? input.crsWkt.slice(0, 128 * 1024) : null;
        manifest.sourceName = previous.name;
        this._writeManifest(key, Object.assign({}, manifest, { keyHash: this.keyHash(key) }));
        return { ok: true, path: previousPath, savedAt: now, bytes: bytes.length, sha256: digest, unchanged: true, revisions: manifest.snapshots.length };
      }
    }

    const name = safeName(input.name || 'cloud.ply');
    const fileName = 'rev-' + now + '-' + crypto.randomBytes(4).toString('hex') + '.ply';
    const file = path.join(currentDir, fileName);
    const entry = {
      file: fileName, sha256: digest, savedAt: now,
      points: Math.max(0, Number(input.points) | 0), bytes: bytes.length, name,
      sourceTransform: normalizeSourceTransform(input.sourceTransform, true),
      crsWkt: typeof input.crsWkt === 'string' ? input.crsWkt.slice(0, 128 * 1024) : null
    };
    const oldFiles = manifest.snapshots.map(row => row.file);
    atomicWriteFileSync(file, bytes, { fs: this.fs, mode: 0o600 });
    const next = Object.assign({}, manifest, {
      keyHash: this.keyHash(key),
      sourceName: name,
      clearedAt: null,
      snapshots: manifest.snapshots.filter(row => row.sha256 !== digest).concat(entry)
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
        .slice(0, this.keep),
      latest: fileName
    });
    try {
      this._writeManifest(key, next); // atomically commit the new snapshot before pruning history
    } catch (error) {
      try { this.fs.unlinkSync(file); } catch (_) {}
      return { ok: false, error: 'autosave_manifest_write_failed', message: String(error && error.message || error) };
    }
    const retained = new Set(next.snapshots.map(row => row.file));
    for (const oldFile of oldFiles) if (!retained.has(oldFile)) {
      try { this.fs.unlinkSync(path.join(currentDir, oldFile)); } catch (_) {}
    }

    let inputHash = previous && previous.sha256 || null;
    if (!inputHash && this.getSourceHash) {
      try { inputHash = await this.getSourceHash(input.sourcePath || key); } catch (_) {}
    }
    if (this.recordOperation) {
      try {
        const op = input.operation && typeof input.operation === 'object' ? sanitize(input.operation) : {};
        const parameters = Object.assign({}, op.parameters || {}, {
          snapshotFormat: 'ply',
          sourceName: name,
          sourceTransform: entry.sourceTransform,
          crsWkt: entry.crsWkt
        });
        await this.recordOperation({
          operation: String(op.operation || 'cloud.edit.autosave').slice(0, 160),
          inputHash: op.inputHash || inputHash,
          parameters: sanitize(parameters),
          output: Object.assign({}, op.output || {}, { sha256: digest, bytes: bytes.length, points: entry.points, revisionCount: next.snapshots.length }),
          warnings: Array.isArray(op.warnings) ? op.warnings : [],
          appVersion: this.getAppVersion()
        }, input.projectId);
      } catch (error) {
        // The file is durable even if the metadata journal is temporarily
        // unavailable; expose this as a warning instead of losing the draft.
        return { ok: true, path: file, savedAt: now, bytes: bytes.length, sha256: digest, inputHash, revisions: manifest.snapshots.length, journalWarning: String(error && error.message || error) };
      }
    }
    return { ok: true, path: file, savedAt: now, bytes: bytes.length, sha256: digest, inputHash, revisions: next.snapshots.length, recoveredManifest: read.recovered };
  }

  async _validSnapshot(dir, row) {
    const file = path.join(dir, row.file);
    try {
      const stat = this.fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES || (row.bytes && stat.size !== row.bytes)) return null;
      const actual = await hashFile(this.fs, file);
      if (actual !== row.sha256) return null;
      return { file, stat };
    } catch (_) { return null; }
  }

  async load(input) {
    input = input || {};
    const key = String(input.key || 'default');
    if (key.length > 8192) return { ok: false, error: 'key_too_long' };
    const requestedHash = input.sha256 == null ? null : String(input.sha256).replace(/^sha256:/i, '').toLowerCase();
    if (requestedHash && !HASH_RE.test(requestedHash)) return { ok: false, error: 'invalid_sha256' };
    const read = this.readManifest(key), manifest = read.manifest;
    if (read.corrupt) return { ok: false, exists: false, error: 'autosave_manifest_corrupt', message: read.error };
    if (!requestedHash && manifest.clearedAt && !manifest.latest && !input.includeCleared) {
      return { ok: true, exists: false, acknowledged: true, revisions: this._revisionList(manifest) };
    }
    let sorted = manifest.snapshots.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    if (requestedHash) sorted = sorted.filter(row => row.sha256 === requestedHash);
    else if (manifest.latest) sorted.sort((a, b) => (a.file === manifest.latest ? -1 : b.file === manifest.latest ? 1 : (b.savedAt || 0) - (a.savedAt || 0)));

    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i], valid = await this._validSnapshot(read.dir, row);
      if (!valid) continue;
      if (!requestedHash && manifest.latest !== row.file && read.dir === this.keyDir(key)) {
        manifest.latest = row.file;
        manifest.clearedAt = null;
        this._writeManifest(key, manifest);
      }
      const revisions = this._revisionList(manifest);
      return {
        ok: true, exists: true, path: valid.file,
        savedAt: row.savedAt || valid.stat.mtimeMs,
        points: row.points || 0, bytes: valid.stat.size,
        name: row.name || manifest.sourceName || '',
        sha256: row.sha256, revisions,
        sourceTransform: row.sourceTransform || null,
        crsWkt: row.crsWkt || null,
        recovered: read.recovered || i > 0
      };
    }

    // Read old mutable v9/v10 drafts only if no new-format manifest has been
    // committed. A cleared current manifest suppresses this legacy fallback.
    if (!requestedHash && !read.exists) {
      const legacyDir = this.legacyVersionedDir(key);
      const legacyManifest = this._readManifestAt(legacyDir, oldHash(key), false);
      if (legacyManifest && !legacyManifest.corrupt) {
        const m = legacyManifest.manifest;
        const rows = m.latest ? m.snapshots.slice().sort((a, b) => a.file === m.latest ? -1 : b.file === m.latest ? 1 : (b.savedAt || 0) - (a.savedAt || 0)) : [];
        for (const row of rows) {
          const valid = await this._validSnapshot(legacyDir, row);
          if (valid) return {
            ok: true, exists: true, path: valid.file, savedAt: row.savedAt || valid.stat.mtimeMs,
            points: row.points || 0, bytes: valid.stat.size,
            name: row.name || m.sourceName || '', sha256: row.sha256,
            revisions: this._revisionList(m), sourceTransform: row.sourceTransform || null,
            crsWkt: row.crsWkt || null, legacy: true
          };
        }
      }
      const legacy = this.legacyPath(key);
      if (this.fs.existsSync(legacy)) {
        let meta = null;
        try { meta = JSON.parse(this.fs.readFileSync(this.legacyMetaPath(key), 'utf8')); } catch (_) {}
        const stat = this.fs.statSync(legacy);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) return { ok: false, exists: false, error: 'invalid_legacy_autosave' };
        return {
          ok: true, exists: true, path: legacy,
          savedAt: Number(meta && meta.savedAt) || stat.mtimeMs,
          points: Math.max(0, Number(meta && meta.points) | 0),
          bytes: stat.size, name: safeName(meta && meta.name || ''),
          sha256: await hashFile(this.fs, legacy), revisions: [], legacy: true
        };
      }
    }
    if (requestedHash) return { ok: false, exists: false, error: 'SNAPSHOT_NOT_FOUND' };
    return { ok: true, exists: false, revisions: this._revisionList(manifest), recoveredManifest: read.recovered };
  }

  async clear(input) {
    input = input || {};
    const key = String(input.key || 'default');
    if (key.length > 8192) return { ok: false, error: 'key_too_long' };
    let read = this.readManifest(key);
    if (read.corrupt) return { ok: false, error: 'autosave_manifest_corrupt', message: read.error };
    if (read.exists && read.dir !== this.keyDir(key)) {
      try { read = await this._migrateLegacyManifest(key, read); }
      catch (error) { return { ok: false, error: 'autosave_migration_failed', message: String(error && error.message || error) }; }
    } else if (!read.exists) {
      try {
        const migrated = await this._migrateMutableLegacy(key);
        if (migrated) read = migrated;
      } catch (error) { return { ok: false, error: 'autosave_migration_failed', message: String(error && error.message || error) }; }
    }
    const manifest = Object.assign({}, read.manifest, { keyHash: this.keyHash(key), latest: null, clearedAt: Date.now() });
    this._writeManifest(key, manifest);
    return { ok: true, retainedRevisions: manifest.snapshots.length };
  }
}

module.exports = { CloudAutosaveStore, sha256, safeName, MAX_SNAPSHOTS, MAX_SNAPSHOT_BYTES };