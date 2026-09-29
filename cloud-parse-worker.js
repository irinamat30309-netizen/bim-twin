'use strict';

// Isolate CPU-heavy point-cloud parsing from Electron's UI/main event loop.
// Buffers are transferred back (not cloned) to keep one extra full copy from
// appearing in the worker/main boundary. Cancellation is implemented by
// terminating this worker from the owning main-process IPC job.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Module = require('module');
if (process.versions && process.versions.electron && process.resourcesPath) {
  const packedNodeModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
  try {
    if (fs.existsSync(packedNodeModules) && !Module.globalPaths.includes(packedNodeModules)) {
      Module.globalPaths.push(packedNodeModules);
    }
  } catch (_) {}
}
const Cloud = require('./las-node');

function transferables(result) {
  const transfers = [];
  const seen = new Set();
  for (const key of ['pos', 'col', 'intensity', 'classification']) {
    const value = result && result[key];
    if (!ArrayBuffer.isView(value) || !(value.buffer instanceof ArrayBuffer)) continue;
    if (value.buffer.byteLength && !seen.has(value.buffer)) {
      seen.add(value.buffer);
      transfers.push(value.buffer);
    }
  }
  return transfers;
}

function progress(message) {
  if (!parentPort) return;
  try { parentPort.postMessage({ type: 'progress', progress: message }); } catch (_) {}
}

async function run() {
  const absPath = String(workerData && workerData.absPath || '');
  if (!absPath) throw new Error('не задан путь к облаку');
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new Error('это не файл');
  const ext = absPath.split('.').pop().toLowerCase();
  let result;
  if (ext === 'laz') {
    result = await Cloud.parseLAZFile(absPath, {
      maxPoints: workerData.maxPoints,
      onProgress: progress
    });
  } else {
    result = Cloud.parseCloudFile(absPath, {
      maxPoints: workerData.maxPoints,
      scratchBaseDir: workerData.scratchBaseDir,
      onProgress: progress
    });
  }
  if (!parentPort) return;
  parentPort.postMessage({ type: 'result', result }, transferables(result));
}

run().catch((error) => {
  if (!parentPort) return;
  parentPort.postMessage({
    type: 'result',
    result: { ok: false, message: 'Ошибка чтения облака: ' + String((error && error.message) || error) }
  });
});