#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST_NAME = 'MANIFEST.sha256';
const EXCLUDED_PARTS = new Set(['.git', 'node_modules', 'dist', 'release', 'coverage']);

function normalizeEntry(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error('invalid_manifest_path');
  }
  const portable = value.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable)) {
    throw new Error('invalid_manifest_path');
  }
  const parts = portable.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('invalid_manifest_path');
  return portable;
}

function excluded(relativePath) {
  const parts = relativePath.split('/');
  return relativePath === MANIFEST_NAME || parts.some(part => EXCLUDED_PARTS.has(part));
}

function hashPath(absolutePath) {
  const stat = fs.lstatSync(absolutePath);
  const hash = crypto.createHash('sha256');
  if (stat.isSymbolicLink()) {
    hash.update('symlink\0');
    hash.update(fs.readlinkSync(absolutePath));
    return hash.digest('hex');
  }
  if (!stat.isFile()) throw new Error(`manifest_entry_not_file:${absolutePath}`);
  const fd = fs.openSync(absolutePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function gitFiles(root) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  if (result.error || result.status !== 0) {
    throw new Error(`git_file_list_failed:${result.error?.message || String(result.stderr || '').trim()}`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeEntry)
    .filter(relativePath => !excluded(relativePath))
    .filter(relativePath => fs.existsSync(path.join(root, ...relativePath.split('/'))))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function createManifest(root, files = gitFiles(root)) {
  const seen = new Set();
  return files.map(relativePath => {
    const normalized = normalizeEntry(relativePath);
    if (excluded(normalized) || seen.has(normalized)) throw new Error(`invalid_manifest_entry:${normalized}`);
    seen.add(normalized);
    const absolute = path.join(root, ...normalized.split('/'));
    return `${hashPath(absolute)}  ${normalized}`;
  }).join('\n') + '\n';
}

function parseManifest(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty_manifest');
  const entries = [];
  const seen = new Set();
  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error('invalid_manifest_line');
    const relativePath = normalizeEntry(match[2]);
    if (excluded(relativePath) || seen.has(relativePath)) throw new Error('invalid_manifest_entry');
    seen.add(relativePath);
    entries.push({ sha256: match[1], path: relativePath });
  }
  if (!entries.length) throw new Error('empty_manifest');
  return entries;
}

function verifyManifest(root, text, options = {}) {
  const entries = parseManifest(text);
  const failures = [];
  for (const entry of entries) {
    const absolute = path.join(root, ...entry.path.split('/'));
    if (!fs.existsSync(absolute)) {
      failures.push(`${entry.path}: missing`);
      continue;
    }
    let actual;
    try { actual = hashPath(absolute); }
    catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
      continue;
    }
    if (actual !== entry.sha256) failures.push(`${entry.path}: sha256 mismatch`);
  }
  if (options.strict !== false) {
    const expected = gitFiles(root);
    const listed = entries.map(entry => entry.path).sort((a, b) => a.localeCompare(b, 'en'));
    const expectedSet = new Set(expected);
    const listedSet = new Set(listed);
    for (const file of expected) if (!listedSet.has(file)) failures.push(`${file}: not listed`);
    for (const file of listed) if (!expectedSet.has(file)) failures.push(`${file}: no longer in release set`);
  }
  return { ok: failures.length === 0, entries: entries.length, failures };
}

function main() {
  const root = path.resolve(__dirname, '..');
  const manifestPath = path.join(root, MANIFEST_NAME);
  const check = process.argv.includes('--check');
  if (check) {
    const result = verifyManifest(root, fs.readFileSync(manifestPath, 'utf8'));
    if (!result.ok) {
      for (const failure of result.failures) console.error(`MANIFEST ERROR: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Release manifest verified: ${result.entries} files.`);
    return;
  }
  const text = createManifest(root);
  fs.writeFileSync(manifestPath, text, 'utf8');
  console.log(`Release manifest written: ${text.split('\n').filter(Boolean).length} files.`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`Release manifest failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MANIFEST_NAME,
  normalizeEntry,
  hashPath,
  gitFiles,
  createManifest,
  parseManifest,
  verifyManifest
};