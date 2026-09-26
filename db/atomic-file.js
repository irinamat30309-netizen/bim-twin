'use strict';

// Durable same-directory replacement used by the JSON store, backups and drafts.
// A failed write/rename leaves the previous target untouched; temporary files are
// intentionally unique so a stale file from a crash can never be mistaken for a
// completed save.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function syncDirectory(dir, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(fd);
  } catch (err) {
    // Directory fsync is not supported by every Windows/network filesystem.
    if (!err || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF', 'EACCES'].includes(err.code)) throw err;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_) {}
    }
  }
}

function fsyncFile(file, fsImpl) {
  let fd;
  try {
    // Windows may reject fsync on a read-only descriptor (EPERM). Backups are
    // our own temporary files, so open them read/write before forcing metadata.
    fd = fsImpl.openSync(file, 'r+');
    fsImpl.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function atomicWriteFileSync(target, data, options) {
  options = options || {};
  const fsImpl = options.fs || fs;
  const abs = path.resolve(String(target));
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(dir, `.${base}.tmp-${token}`);
  const backupPath = options.backupPath ? path.resolve(options.backupPath) : null;
  const backupTmp = backupPath
    ? path.join(path.dirname(backupPath), `.${path.basename(backupPath)}.tmp-${token}`)
    : null;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let fd;
  let wroteTemp = false;
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    if (backupPath) fsImpl.mkdirSync(path.dirname(backupPath), { recursive: true });
    fd = fsImpl.openSync(tmp, 'wx', options.mode == null ? 0o600 : options.mode);
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    wroteTemp = true;

    // Rotate only an existing, already-durable target. If preserving the old
    // version fails, abort rather than replacing the only known-good copy.
    if (backupPath && fsImpl.existsSync(abs)) {
      fsImpl.copyFileSync(abs, backupTmp);
      // Make the private temporary backup writable even when the source file
      // carried read-only permissions; Windows fsync requires a writable handle.
      fsImpl.chmodSync(backupTmp, 0o600);
      fsyncFile(backupTmp, fsImpl);
      fsImpl.renameSync(backupTmp, backupPath);
    }

    fsImpl.renameSync(tmp, abs);
    syncDirectory(dir, fsImpl);
    return { path: abs, bytes: bytes.length, backupPath: backupPath || null };
  } catch (err) {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_) {}
    }
    if (wroteTemp) {
      try { fsImpl.unlinkSync(tmp); } catch (_) {}
    } else {
      try { fsImpl.unlinkSync(tmp); } catch (_) {}
    }
    if (backupTmp) {
      try { fsImpl.unlinkSync(backupTmp); } catch (_) {}
    }
    throw err;
  }
}

function atomicWriteJsonSync(target, value, options) {
  return atomicWriteFileSync(target, JSON.stringify(value, null, 2) + '\n', options);
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync, parseJsonFile };