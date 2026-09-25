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
          observed.push({ name: path.basename(String(file)), flags });
          return targetFs.openSync(file, flags, mode);
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
    const backupSyncOpen = observed.find(({ name }) => name.startsWith('.store.json.bak.tmp-'));
    assert.ok(backupSyncOpen, 'backup temp file was opened before fsync');
    assert.equal(backupSyncOpen.flags, 'r+');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
