'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateSyncFileName, decodeBase64Strict, isPathInside } = require('./security/file-access');

const MAGIC = Buffer.from('BIMSYNC2\n', 'ascii');
const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxWorkspaceBytes: 64 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024 * 1024,
  maxLegacyBytes: 512 * 1024 * 1024
});

function limitsWith(overrides) {
  return Object.assign({}, DEFAULT_LIMITS, overrides || {});
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest('hex') };
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!result || result.bytesWritten <= 0) throw new Error('bundle_write_failed');
    offset += result.bytesWritten;
  }
}

async function writeRecordHeader(handle, header) {
  const body = Buffer.from(JSON.stringify(header), 'utf8');
  if (!body.length || body.length > MAX_HEADER_BYTES) throw new Error('bundle_header_too_large');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.length, 0);
  await writeAll(handle, prefix);
  await writeAll(handle, body);
}

function cleanWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) throw new Error('invalid_workspace');
  const clean = Object.assign({}, workspace);
  delete clean.files;
  return clean;
}

async function inventoryUploads(uploadsDir, limits) {
  const root = fs.realpathSync(uploadsDir);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (entries.length > limits.maxFiles) throw new Error('bundle_file_limit_exceeded');
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const name = validateSyncFileName(entry.name);
    const filePath = fs.realpathSync(path.join(root, name));
    if (!isPathInside(root, filePath)) throw new Error('bundle_source_outside_uploads');
    const info = await hashFile(filePath);
    if (info.size > limits.maxEntryBytes) throw new Error('bundle_entry_too_large');
    totalBytes += info.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) throw new Error('bundle_total_too_large');
    files.push({ name, path: filePath, size: info.size, sha256: info.sha256 });
  }
  return { files, totalBytes };
}

async function writeSyncBundle(targetPath, options = {}) {
  const limits = limitsWith(options.limits);
  const workspace = cleanWorkspace(options.workspace);
  const workspaceBytes = Buffer.from(JSON.stringify(workspace), 'utf8');
  if (workspaceBytes.length > limits.maxWorkspaceBytes) throw new Error('workspace_too_large');
  const inventory = await inventoryUploads(options.uploadsDir, limits);
  const handle = await fs.promises.open(targetPath, 'wx', 0o600);
  let closed = false;
  try {
    await writeAll(handle, MAGIC);
    await writeRecordHeader(handle, {
      type: 'workspace',
      encoding: 'json',
      size: workspaceBytes.length,
      sha256: sha256(workspaceBytes)
    });
    await writeAll(handle, workspaceBytes);
    for (const file of inventory.files) {
      await writeRecordHeader(handle, {
        type: 'file',
        name: file.name,
        size: file.size,
        sha256: file.sha256
      });
      for await (const chunk of fs.createReadStream(file.path, { highWaterMark: 1024 * 1024 })) {
        await writeAll(handle, chunk);
      }
    }
    await writeRecordHeader(handle, {
      type: 'end',
      size: 0,
      fileCount: inventory.files.length,
      totalBytes: inventory.totalBytes
    });
    await handle.sync();
    await handle.close();
    closed = true;
    return {
      format: 'bimsync-v2',
      files: inventory.files.length,
      fileBytes: inventory.totalBytes,
      workspaceBytes: workspaceBytes.length
    };
  } catch (error) {
    if (!closed) try { await handle.close(); } catch (_) {}
    try { await fs.promises.unlink(targetPath); } catch (_) {}
    throw error;
  }
}

async function readExactly(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid_bundle_length');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result || result.bytesRead <= 0) throw new Error('truncated_bundle');
    offset += result.bytesRead;
  }
  return buffer;
}

async function readHeader(handle, position) {
  const prefix = await readExactly(handle, 4, position);
  const length = prefix.readUInt32BE(0);
  if (!length || length > MAX_HEADER_BYTES) throw new Error('invalid_bundle_header');
  const body = await readExactly(handle, length, position + 4);
  let header;
  try { header = JSON.parse(body.toString('utf8')); }
  catch (_) { throw new Error('invalid_bundle_header_json'); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('invalid_bundle_header_json');
  return { header, next: position + 4 + length };
}

function validateRecordSize(value, maximum) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) throw new Error('invalid_bundle_record_size');
  return size;
}

async function copyRecordToFile(handle, position, size, targetPath, expectedHash) {
  const output = await fs.promises.open(targetPath, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let copied = 0;
  try {
    while (copied < size) {
      const length = Math.min(1024 * 1024, size - copied);
      const chunk = await readExactly(handle, length, position + copied);
      hash.update(chunk);
      await writeAll(output, chunk);
      copied += chunk.length;
    }
    await output.sync();
    await output.close();
  } catch (error) {
    try { await output.close(); } catch (_) {}
    try { await fs.promises.unlink(targetPath); } catch (_) {}
    throw error;
  }
  const actualHash = hash.digest('hex');
  if (!/^[a-f0-9]{64}$/u.test(String(expectedHash || '')) || actualHash !== expectedHash) {
    try { await fs.promises.unlink(targetPath); } catch (_) {}
    throw new Error('bundle_hash_mismatch');
  }
  return actualHash;
}

async function readV2BundleToStage(sourcePath, stageDir, options = {}) {
  const limits = limitsWith(options.limits);
  const handle = await fs.promises.open(sourcePath, 'r');
  let position = MAGIC.length;
  let workspace = null;
  const files = [];
  const names = new Set();
  let totalBytes = 0;
  try {
    const stat = await handle.stat();
    while (position < stat.size) {
      const record = await readHeader(handle, position);
      const header = record.header;
      position = record.next;
      if (header.type === 'workspace') {
        if (workspace || files.length) throw new Error('invalid_workspace_record_order');
        const size = validateRecordSize(header.size, limits.maxWorkspaceBytes);
        const bytes = await readExactly(handle, size, position);
        position += size;
        if (sha256(bytes) !== header.sha256) throw new Error('bundle_hash_mismatch');
        try { workspace = cleanWorkspace(JSON.parse(bytes.toString('utf8'))); }
        catch (error) {
          if (error && error.message === 'invalid_workspace') throw error;
          throw new Error('invalid_workspace_json');
        }
        continue;
      }
      if (header.type === 'file') {
        if (!workspace) throw new Error('workspace_record_required');
        if (files.length >= limits.maxFiles) throw new Error('bundle_file_limit_exceeded');
        const name = validateSyncFileName(header.name);
        const folded = name.toLocaleLowerCase('en-US');
        if (names.has(folded)) throw new Error('duplicate_bundle_file');
        names.add(folded);
        const size = validateRecordSize(header.size, limits.maxEntryBytes);
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) throw new Error('bundle_total_too_large');
        const target = path.join(stageDir, name);
        if (!isPathInside(stageDir, target)) throw new Error('bundle_path_escape');
        const fileHash = await copyRecordToFile(handle, position, size, target, header.sha256);
        position += size;
        files.push({ name, path: target, size, sha256: fileHash });
        continue;
      }
      if (header.type === 'end') {
        if (!workspace || Number(header.size) !== 0) throw new Error('invalid_end_record');
        if (Number(header.fileCount) !== files.length || Number(header.totalBytes) !== totalBytes) {
          throw new Error('bundle_summary_mismatch');
        }
        if (position !== stat.size) throw new Error('bundle_trailing_data');
        return { format: 'bimsync-v2', workspace, files, totalBytes };
      }
      throw new Error('unknown_bundle_record');
    }
    throw new Error('bundle_end_missing');
  } finally {
    await handle.close();
  }
}

async function readLegacyBundleToStage(sourcePath, stageDir, options = {}) {
  const limits = limitsWith(options.limits);
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile() || stat.size > limits.maxLegacyBytes) throw new Error('legacy_bundle_too_large');
  let bundle;
  try { bundle = JSON.parse(await fs.promises.readFile(sourcePath, 'utf8')); }
  catch (_) { throw new Error('invalid_legacy_bundle_json'); }
  const workspace = cleanWorkspace(bundle);
  const encodedFiles = bundle.files == null ? {} : bundle.files;
  if (!encodedFiles || typeof encodedFiles !== 'object' || Array.isArray(encodedFiles)) throw new Error('invalid_legacy_files');
  const entries = Object.entries(encodedFiles);
  if (entries.length > limits.maxFiles) throw new Error('bundle_file_limit_exceeded');
  const files = [];
  const names = new Set();
  let totalBytes = 0;
  for (const [rawName, encoded] of entries) {
    const name = validateSyncFileName(rawName);
    const folded = name.toLocaleLowerCase('en-US');
    if (names.has(folded)) throw new Error('duplicate_bundle_file');
    names.add(folded);
    const remaining = limits.maxTotalBytes - totalBytes;
    const bytes = decodeBase64Strict(encoded, Math.min(limits.maxEntryBytes, remaining));
    totalBytes += bytes.length;
    const target = path.join(stageDir, name);
    if (!isPathInside(stageDir, target)) throw new Error('bundle_path_escape');
    await fs.promises.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    files.push({ name, path: target, size: bytes.length, sha256: sha256(bytes) });
  }
  return { format: 'bimsync-v1-json', workspace, files, totalBytes };
}

async function readSyncBundleToStage(sourcePath, stageDir, options = {}) {
  await fs.promises.mkdir(stageDir, { recursive: true, mode: 0o700 });
  const handle = await fs.promises.open(sourcePath, 'r');
  let prefix;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('bundle_not_file');
    prefix = stat.size >= MAGIC.length ? await readExactly(handle, MAGIC.length, 0) : Buffer.alloc(0);
  } finally {
    await handle.close();
  }
  if (prefix.equals(MAGIC)) return readV2BundleToStage(sourcePath, stageDir, options);
  return readLegacyBundleToStage(sourcePath, stageDir, options);
}

function installStagedFiles(files, uploadsDir) {
  const root = fs.realpathSync(uploadsDir);
  const rollbackDir = fs.mkdtempSync(path.join(root, '.bimsync-rollback-'));
  const operations = [];
  let settled = false;
  const rollback = () => {
    if (settled) return;
    for (const operation of operations.slice().reverse()) {
      try { if (operation.installed && fs.existsSync(operation.destination)) fs.unlinkSync(operation.destination); } catch (_) {}
      try { if (operation.backup && fs.existsSync(operation.backup)) fs.renameSync(operation.backup, operation.destination); } catch (_) {}
    }
    try { fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch (_) {}
    settled = true;
  };
  try {
    for (const file of files) {
      const name = validateSyncFileName(file.name);
      const destination = path.join(root, name);
      if (!isPathInside(root, destination)) throw new Error('bundle_path_escape');
      const operation = { destination, backup: null, installed: false };
      if (fs.existsSync(destination)) {
        const stat = fs.lstatSync(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('bundle_destination_not_regular_file');
        operation.backup = path.join(rollbackDir, name);
        fs.renameSync(destination, operation.backup);
      }
      operations.push(operation);
      fs.renameSync(file.path, destination);
      operation.installed = true;
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    rollback,
    complete() {
      if (settled) return;
      fs.rmSync(rollbackDir, { recursive: true, force: true });
      settled = true;
    }
  };
}

module.exports = {
  MAGIC,
  DEFAULT_LIMITS,
  writeSyncBundle,
  readSyncBundleToStage,
  installStagedFiles,
  cleanWorkspace
};