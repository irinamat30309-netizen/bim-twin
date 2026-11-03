'use strict';

const path = require('node:path');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_GRANTS = 512;

function normalizeForComparison(value, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(String(value || ''));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(baseDir, candidate, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const base = normalizeForComparison(baseDir, platform);
  const child = normalizeForComparison(candidate, platform);
  const relative = pathApi.relative(base, child);
  return relative === '' || (!relative.startsWith('..' + pathApi.sep) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function realpathSync(fsImpl, value) {
  const realpath = fsImpl.realpathSync && fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native.bind(fsImpl.realpathSync)
    : fsImpl.realpathSync.bind(fsImpl);
  return path.resolve(realpath(String(value || '')));
}

function canonicalExistingFile(fsImpl, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid_path');
  const canonical = realpathSync(fsImpl, value);
  const stat = fsImpl.statSync(canonical);
  if (!stat.isFile()) throw new Error('not_file');
  return canonical;
}

function canonicalExistingDirectory(fsImpl, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid_path');
  const canonical = realpathSync(fsImpl, value);
  const stat = fsImpl.statSync(canonical);
  if (!stat.isDirectory()) throw new Error('not_directory');
  return canonical;
}

function canonicalPlannedFile(fsImpl, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid_path');
  const resolved = path.resolve(value);
  const parent = canonicalExistingDirectory(fsImpl, path.dirname(resolved));
  const name = path.basename(resolved);
  if (!name || name === '.' || name === '..') throw new Error('invalid_file_name');
  return path.join(parent, name);
}

function hasAllowedExtension(filePath, allowedExtensions) {
  if (!allowedExtensions) return true;
  return allowedExtensions.has(path.extname(filePath).toLowerCase());
}

function validateSyncFileName(value) {
  if (typeof value !== 'string') throw new Error('invalid_bundle_file_name');
  const name = value.normalize('NFC');
  if (!name || name === '.' || name === '..' || name.length > 240) throw new Error('invalid_bundle_file_name');
  if (/[\u0000-\u001f\u007f/\\:]/u.test(name)) throw new Error('invalid_bundle_file_name');
  if (/[. ]$/u.test(name)) throw new Error('invalid_bundle_file_name');
  const stem = name.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) throw new Error('invalid_bundle_file_name');
  return name;
}

function decodeBase64Strict(value, maxBytes = Infinity) {
  if (typeof value !== 'string') throw new Error('invalid_base64');
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new Error('invalid_base64');
  }
  const padding = compact.endsWith('==') ? 2 : (compact.endsWith('=') ? 1 : 0);
  const expected = (compact.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > maxBytes) throw new Error('payload_too_large');
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.length !== expected) throw new Error('invalid_base64');
  return decoded;
}

class PathGrantRegistry {
  constructor(options = {}) {
    this.fs = options.fs;
    if (!this.fs) throw new Error('fs_required');
    this.platform = options.platform || process.platform;
    this.ttlMs = Number.isFinite(options.ttlMs) ? Math.max(1000, options.ttlMs) : DEFAULT_TTL_MS;
    this.maxGrants = Number.isSafeInteger(options.maxGrants)
      ? Math.max(1, options.maxGrants)
      : DEFAULT_MAX_GRANTS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.bySender = new Map();
  }

  _senderKey(senderId) {
    if (senderId == null || String(senderId) === '') throw new Error('invalid_sender');
    return String(senderId);
  }

  _prune(senderKey) {
    const grants = this.bySender.get(senderKey);
    if (!grants) return;
    const now = this.now();
    for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
    while (grants.size > this.maxGrants) grants.delete(grants.keys().next().value);
    if (!grants.size) this.bySender.delete(senderKey);
  }

  _grant(senderId, canonical, options = {}) {
    const senderKey = this._senderKey(senderId);
    this._prune(senderKey);
    let grants = this.bySender.get(senderKey);
    if (!grants) {
      grants = new Map();
      this.bySender.set(senderKey, grants);
    }
    const key = normalizeForComparison(canonical, this.platform);
    grants.delete(key);
    grants.set(key, {
      canonical,
      directory: options.directory === true,
      read: options.read !== false,
      write: options.write === true,
      expiresAt: this.now() + this.ttlMs
    });
    this._prune(senderKey);
    return canonical;
  }

  grantExistingFile(senderId, value, options = {}) {
    return this._grant(senderId, canonicalExistingFile(this.fs, value), options);
  }

  grantExistingDirectory(senderId, value, options = {}) {
    return this._grant(senderId, canonicalExistingDirectory(this.fs, value), {
      ...options,
      directory: true
    });
  }

  grantPlannedFile(senderId, value, options = {}) {
    return this._grant(senderId, canonicalPlannedFile(this.fs, value), {
      ...options,
      write: options.write !== false
    });
  }

  resolveExistingFile(senderId, value, options = {}) {
    let canonical;
    try { canonical = canonicalExistingFile(this.fs, value); }
    catch (_) { return null; }
    const senderKey = this._senderKey(senderId);
    this._prune(senderKey);
    const grants = this.bySender.get(senderKey);
    if (!grants) return null;
    const wantedWrite = options.write === true;
    const candidateKey = normalizeForComparison(canonical, this.platform);
    for (const grant of grants.values()) {
      const matches = grant.directory
        ? isPathInside(grant.canonical, canonical, this.platform)
        : normalizeForComparison(grant.canonical, this.platform) === candidateKey;
      if (!matches) continue;
      if (wantedWrite ? grant.write : grant.read) return canonical;
    }
    return null;
  }

  resolvePlannedFile(senderId, value) {
    let canonical;
    try { canonical = canonicalPlannedFile(this.fs, value); }
    catch (_) { return null; }
    const senderKey = this._senderKey(senderId);
    this._prune(senderKey);
    const grants = this.bySender.get(senderKey);
    if (!grants) return null;
    const key = normalizeForComparison(canonical, this.platform);
    const grant = grants.get(key);
    return grant && grant.write ? canonical : null;
  }

  revokeSender(senderId) {
    if (senderId != null) this.bySender.delete(String(senderId));
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_GRANTS,
  normalizeForComparison,
  isPathInside,
  canonicalExistingFile,
  canonicalExistingDirectory,
  canonicalPlannedFile,
  hasAllowedExtension,
  validateSyncFileName,
  decodeBase64Strict,
  PathGrantRegistry
};