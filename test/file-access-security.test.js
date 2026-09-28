'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PathGrantRegistry,
  canonicalExistingFile,
  decodeBase64Strict,
  isPathInside,
  validateSyncFileName
} = require('../security/file-access');

test('path containment rejects prefix tricks and traversal', () => {
  assert.equal(isPathInside('/tmp/project', '/tmp/project/cloud.las', 'linux'), true);
  assert.equal(isPathInside('/tmp/project', '/tmp/project-evil/cloud.las', 'linux'), false);
  assert.equal(isPathInside('/tmp/project', '/tmp/project/../secret.txt', 'linux'), false);
  assert.equal(isPathInside('C:\\Data', 'C:\\Data\\scan.las', 'win32'), true);
  assert.equal(isPathInside('C:\\Data', 'C:\\Database\\scan.las', 'win32'), false);
});

test('sync bundle names are one safe portable path component', () => {
  for (const bad of ['../outside', '..\\outside', '/absolute', 'C:\\secret', '.', '..', 'NUL.txt', 'name.', 'a/b']) {
    assert.throws(() => validateSyncFileName(bad), /invalid_bundle_file_name/);
  }
  assert.equal(validateSyncFileName('фасад 01.las'), 'фасад 01.las');
});

test('strict base64 decoder rejects malformed and oversized payloads', () => {
  assert.deepEqual(decodeBase64Strict(Buffer.from('hello').toString('base64')), Buffer.from('hello'));
  assert.throws(() => decodeBase64Strict('not base64!'), /invalid_base64/);
  assert.throws(() => decodeBase64Strict(Buffer.alloc(8).toString('base64'), 7), /payload_too_large/);
});

test('file grants are sender scoped, expire, and support selected directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-file-grant-'));
  const nested = path.join(root, 'nested');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-file-outside-'));
  fs.mkdirSync(nested);
  const file = path.join(nested, 'cloud.las');
  const outsideFile = path.join(outside, 'secret.las');
  fs.writeFileSync(file, 'LAS');
  fs.writeFileSync(outsideFile, 'SECRET');
  let now = 1000;
  try {
    const grants = new PathGrantRegistry({ fs, platform: process.platform, ttlMs: 1000, now: () => now });
    grants.grantExistingDirectory(7, root);
    assert.equal(grants.resolveExistingFile(7, file), canonicalExistingFile(fs, file));
    assert.equal(grants.resolveExistingFile(8, file), null);
    assert.equal(grants.resolveExistingFile(7, outsideFile), null);
    now = 2001;
    assert.equal(grants.resolveExistingFile(7, file), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('planned output grants do not authorize sibling files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-write-grant-'));
  try {
    const output = path.join(root, 'chosen.ply');
    const grants = new PathGrantRegistry({ fs });
    grants.grantPlannedFile(1, output, { read: true, write: true });
    assert.equal(grants.resolvePlannedFile(1, output), path.resolve(output));
    assert.equal(grants.resolvePlannedFile(1, path.join(root, 'other.ply')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persistent project records cannot grant arbitrary document paths', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /path\.isAbsolute\((?:d|doc)\.file\)/);
  assert.doesNotMatch(source, /_isRegisteredFile/);
  assert.match(source, /const abs = safeReadPath\(doc\.file\)/);
  assert.match(source, /const abs = safeReadPath\(d\.file\)/);
  assert.match(source, /vDocumentPatch/);
});

test('base64 uploads use the bounded strict decoder and atomic storage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /decodeBase64Strict\(base64, MAX_DOCUMENT_WRITE_BYTES\)/);
  assert.match(source, /atomicWriteFileSync\(abs, bytes, \{ mode: 0o600 \}\)/);
  assert.match(source, /decodeBase64Strict\(vStr\(a\.base64\), MAX_DOCUMENT_WRITE_BYTES\)/);
});