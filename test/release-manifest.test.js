'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createManifest,
  parseManifest,
  verifyManifest
} = require('../scripts/release-manifest.cjs');

test('release manifest is deterministic and detects modified files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-manifest-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'beta');
    const files = ['a.txt', 'nested/b.txt'];
    const first = createManifest(root, files);
    const second = createManifest(root, files);
    assert.equal(first, second);
    assert.equal(parseManifest(first).length, 2);
    assert.equal(verifyManifest(root, first, { strict: false }).ok, true);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
    const verification = verifyManifest(root, first, { strict: false });
    assert.equal(verification.ok, false);
    assert.match(verification.failures.join('\n'), /a\.txt: sha256 mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release manifest rejects traversal and duplicate entries', () => {
  const digest = '0'.repeat(64);
  assert.throws(() => parseManifest(`${digest}  ../secret\n`), /invalid_manifest_path/);
  assert.throws(
    () => parseManifest(`${digest}  a.txt\n${digest}  a.txt\n`),
    /invalid_manifest_entry/
  );
});

test('packaged application includes runtime security modules', () => {
  const pkg = require('../package.json');
  for (const entry of ['sync-bundle.js', 'security/**']) {
    assert.ok(pkg.build.files.includes(entry), `${entry} must be included in the Electron package`);
  }
});

test('production dependency graph excludes unused vulnerable Univer tree and pins fixed SheetJS', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.dependencies['@univerjs/presets'], undefined);
  assert.equal(
    Object.keys(lock.packages).some(key => key.includes('node_modules/@univerjs/')),
    false
  );
  assert.match(pkg.dependencies.xlsx, /xlsx-0\.20\.3\.tgz$/);
  assert.equal(lock.packages['node_modules/xlsx'].version, '0.20.3');
});