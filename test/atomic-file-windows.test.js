'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteJsonSync } = require('../db/atomic-file');

test('atomic backup fsync uses a writable descriptor for Windows compatibility', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-atomic-fsync-'));
  const target = path.join(root, 'store.json');
  const backup = `${target}.bak`;
  const observed = [];
  const fsImpl = new Proxy(fs, {
    get(targetFs, property) {
      if (property === 'openSync') {
        return (file, flags, mode) => {
          observed.push({ operation: 'open', name: path.basename(String(file)), flags });
          return targetFs.openSync(file, flags, mode);
        };
      }
      if (property === 'chmodSync') {
        return (file, mode) => {
          observed.push({ operation: 'chmod', name: path.basename(String(file)), mode });
          return targetFs.chmodSync(file, mode);
        };
      }
      const value = Reflect.get(targetFs, property, targetFs);
      return typeof value === 'function' ? value.bind(targetFs) : value;
    }
  });

  try {
    atomicWriteJsonSync(target, { revision: 1 }, { fs: fsImpl, backupPath: backup });
    atomicWriteJsonSync(target, { revision: 2 }, { fs: fsImpl, backupPath: backup });

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { revision: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), { revision: 1 });
    const backupName = observed.find(({ operation, name }) =>
      operation === 'open' && name.startsWith('.store.json.bak.tmp-'))?.name;
    assert.ok(backupName, 'backup temp file was opened before fsync');
    const backupMode = observed.find(({ operation, name }) =>
      operation === 'chmod' && name === backupName);
    assert.equal(backupMode && backupMode.mode, 0o600, 'backup copy is writable/private before fsync');
    const backupSyncOpen = observed.find(({ operation, name }) =>
      operation === 'open' && name === backupName);
    assert.ok(backupSyncOpen, 'backup temp file was opened before fsync');
    assert.equal(backupSyncOpen.flags, 'r+');
    assert.ok(observed.indexOf(backupMode) < observed.indexOf(backupSyncOpen),
      'backup permissions must be normalized before opening for fsync');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
