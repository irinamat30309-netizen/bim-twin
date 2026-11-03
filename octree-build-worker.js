'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { buildOctreeToDisk } = require('./octree-build-core');

function progress(value) {
  try { parentPort.postMessage({ type: 'progress', progress: value }); } catch (_) {}
}

try {
  const result = buildOctreeToDisk(workerData.sourcePath, workerData.outputDir, {
    maxPoints: workerData.maxPoints,
    nodeCapacity: workerData.nodeCapacity,
    sourceTransform: workerData.sourceTransform,
    sourcePreflightInfo: workerData.sourcePreflightInfo,
    onProgress: progress
  });
  parentPort.postMessage({
    type: 'result',
    result: {
      ok: true, dir: result.dir, index: result.index, meta: result.meta,
      bytes: result.bytes, sha256: result.sha256,
      sourcePointCount: result.sourcePointCount, indexedPointCount: result.indexedPointCount,
      outOfCore: !!result.outOfCore
    }
  });
} catch (error) {
  try {
    parentPort.postMessage({ type: 'result', result: { ok: false, error: String(error && error.message || error) } });
  } catch (_) {}
}