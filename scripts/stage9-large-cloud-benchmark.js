'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const DEFAULT_MAX_POINTS = 1_000_000;
const MAX_BENCHMARK_POINTS = 10_000_000;
const DEFAULT_DISK_MARGIN_BYTES = 512 * 1024 * 1024;
const MAX_GRID_SIDE = 1400;
const CLOUD = require('../las-node');
const OCTREE = require('../renderer/octree-store');
const SECTION = require('../renderer/section');
const { buildOctreeToDisk } = require('../octree-build-core');

function parsePositiveInteger(value, fallback, name, maxValue) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maxValue) {
    throw new RangeError(`${name} must be an integer from 1 to ${maxValue}`);
  }
  return number;
}

function parseOptionalPositiveInteger(value, name) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return number;
}

function resolveBenchmarkConfig(options = {}) {
  const env = options.env || process.env;
  const sourcePath = String(
    options.sourcePath ||
    env.BIMTWIN_STAGE9_LAS_PATH ||
    env.BIMTWIN_GPU_LAS_PATH ||
    ''
  ).trim();
  if (!sourcePath) {
    throw new Error('Set BIMTWIN_GPU_LAS_PATH to an uncompressed LAS file for the Stage 9 benchmark.');
  }

  const maxPoints = parsePositiveInteger(
    options.maxPoints ??
      env.BIMTWIN_STAGE9_MAX_POINTS ??
      env.BIMTWIN_GPU_LAS_MAX_POINTS,
    DEFAULT_MAX_POINTS,
    'BIMTWIN_STAGE9_MAX_POINTS',
    MAX_BENCHMARK_POINTS
  );
  const expectedPointCount = options.expectedPointCount ??
    parseOptionalPositiveInteger(env.BIMTWIN_GPU_LAS_EXPECTED_POINTS, 'BIMTWIN_GPU_LAS_EXPECTED_POINTS');
  const diskMarginBytes = options.diskMarginBytes ??
    parsePositiveInteger(
      env.BIMTWIN_STAGE9_DISK_MARGIN_BYTES,
      DEFAULT_DISK_MARGIN_BYTES,
      'BIMTWIN_STAGE9_DISK_MARGIN_BYTES',
      Number.MAX_SAFE_INTEGER
    );
  const configuredFreeBytes = options.availableDiskBytes ??
    parseOptionalPositiveInteger(env.BIMTWIN_STAGE9_FREE_DISK_BYTES, 'BIMTWIN_STAGE9_FREE_DISK_BYTES');
  const absoluteSourcePath = path.resolve(sourcePath);
  const workParent = path.resolve(
    options.workParent ||
      env.BIMTWIN_STAGE9_WORK_DIR ||
      path.dirname(absoluteSourcePath)
  );
  const reportPathValue = options.reportPath ?? env.BIMTWIN_STAGE9_REPORT_PATH;
  const reportPath = reportPathValue ? path.resolve(String(reportPathValue)) : null;

  return {
    sourcePath: absoluteSourcePath,
    sourceName: path.basename(absoluteSourcePath),
    maxPoints,
    expectedPointCount,
    diskMarginBytes,
    configuredFreeBytes,
    workParent,
    reportPath,
    nodeCapacity: parsePositiveInteger(
      options.nodeCapacity ?? env.BIMTWIN_STAGE9_NODE_CAPACITY,
      120_000,
      'BIMTWIN_STAGE9_NODE_CAPACITY',
      500_000
    )
  };
}

function availableBytesForDirectory(directory, configuredBytes) {
  if (configuredBytes != null) return configuredBytes;
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stat = fs.statfsSync(directory, { bigint: true });
    const free = stat.bavail * stat.bsize;
    return free <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(free) : null;
  } catch (_) {
    return null;
  }
}

function readExactAt(fd, buffer, length, position) {
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (count <= 0) throw new Error('Unexpected end of octree node data.');
    offset += count;
  }
}

function readIndexedPositions(nodeFile, index) {
  const nodeStat = fs.statSync(nodeFile);
  if (!OCTREE.validateOctreeIndex(index, nodeStat.size)) {
    throw new Error('The out-of-core octree index or nodes.bin failed validation.');
  }
  const pointCount = index.pointCount;
  if (!Number.isSafeInteger(pointCount) || pointCount < 1 ||
      pointCount > MAX_BENCHMARK_POINTS) {
    throw new Error(`Indexed point count ${pointCount} exceeds the safe section benchmark limit.`);
  }

  const positions = new Float32Array(pointCount * 3);
  let writtenPoints = 0;
  const fd = fs.openSync(nodeFile, 'r');
  try {
    for (const node of index.nodes) {
      const bytes = Buffer.allocUnsafe(node.byteLength);
      readExactAt(fd, bytes, node.byteLength, node.offset);
      for (let point = 0; point < node.count; point++) {
        const sourceOffset = point * index.stride;
        const targetOffset = (writtenPoints + point) * 3;
        const x = bytes.readFloatLE(sourceOffset);
        const y = bytes.readFloatLE(sourceOffset + 4);
        const z = bytes.readFloatLE(sourceOffset + 8);
        if (![x, y, z].every(Number.isFinite)) {
          throw new Error(`The indexed LAS contains a non-finite XYZ point at ${writtenPoints + point}.`);
        }
        positions[targetOffset] = x;
        positions[targetOffset + 1] = y;
        positions[targetOffset + 2] = z;
      }
      writtenPoints += node.count;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (writtenPoints !== pointCount) {
    throw new Error(`Octree point totals differ: index=${pointCount}, read=${writtenPoints}.`);
  }
  return positions;
}

function quantileOfComponent(positions, count, component) {
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const value = positions[i * 3 + component];
    if (!Number.isFinite(value)) throw new Error('Cannot select a section level from non-finite points.');
    values[i] = value;
  }
  values.sort();
  return values[Math.floor((count - 1) / 2)];
}

function quantileOfProfileOffset(positions, count, originX, originZ) {
  const angle = Math.PI / 4;
  const normalX = -Math.sin(angle);
  const normalZ = Math.cos(angle);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('Cannot select a profile offset from non-finite points.');
    }
    values[i] = (x - originX) * normalX + (z - originZ) * normalZ;
  }
  values.sort();
  return values[Math.floor((count - 1) / 2)];
}

function sectionCellSize(index, firstAxis, secondAxis) {
  const spanA = Math.max(0, index.bbox.mx[firstAxis] - index.bbox.mn[firstAxis]);
  const spanB = Math.max(0, index.bbox.mx[secondAxis] - index.bbox.mn[secondAxis]);
  const maxSpan = Math.max(spanA, spanB);
  return maxSpan > 0 ? maxSpan / MAX_GRID_SIDE : 1;
}

function runSectionBenchmarks(positions, index) {
  const count = index.pointCount;
  const axisRuns = [
    { axis: 'x', component: 0, projected: [2, 1] },
    { axis: 'y', component: 1, projected: [0, 2] },
    { axis: 'z', component: 2, projected: [0, 1] }
  ];
  const runs = [];

  for (const spec of axisRuns) {
    const range = Math.max(0, index.bbox.mx[spec.component] - index.bbox.mn[spec.component]);
    const level = quantileOfComponent(positions, count, spec.component);
    const thickness = Math.max(range * 0.02, Number.EPSILON * Math.max(1, Math.abs(level)) * 64);
    const cell = sectionCellSize(index, spec.projected[0], spec.projected[1]);
    const started = performance.now();
    const result = SECTION.sectionToPolylines(positions, count, {
      axis: spec.axis,
      level,
      thickness,
      cell,
      minArea: 0,
      compact: true
    });
    const durationMs = performance.now() - started;
    if (!Number.isSafeInteger(result.sliced) || result.sliced < 1) {
      throw new Error(`Stage 9 ${spec.axis.toUpperCase()} section selected no points from the deterministic sample.`);
    }
    runs.push({
      mode: 'raster-section',
      axis: spec.axis,
      level,
      thickness,
      cell,
      selectedPoints: result.sliced,
      contourCount: result.loops.length,
      contourVertices: result.loops.reduce((sum, loop) => sum + loop.points.length, 0),
      durationMs: Number(durationMs.toFixed(3))
    });
  }

  const originX = (index.bbox.mn[0] + index.bbox.mx[0]) / 2;
  const originZ = (index.bbox.mn[2] + index.bbox.mx[2]) / 2;
  const diagonal = Math.hypot(
    index.bbox.mx[0] - index.bbox.mn[0],
    index.bbox.mx[2] - index.bbox.mn[2]
  );
  const profileOffset = quantileOfProfileOffset(positions, count, originX, originZ);
  const profileThickness = Math.max(
    diagonal * 0.02,
    Number.EPSILON * Math.max(1, Math.abs(profileOffset)) * 64
  );
  const profileCell = Math.max(
    1e-12,
    Math.max(diagonal, index.bbox.mx[1] - index.bbox.mn[1]) / MAX_GRID_SIDE
  );
  const profileStarted = performance.now();
  const profile = SECTION.profileToPolylines(positions, count, {
    origin: [originX, originZ],
    azimuthDeg: 45,
    offset: profileOffset,
    thickness: profileThickness,
    cell: profileCell,
    minArea: 0,
    compact: true
  });
  const profileDurationMs = performance.now() - profileStarted;
  if (!Number.isSafeInteger(profile.sliced) || profile.sliced < 1) {
    throw new Error('Stage 9 oblique profile selected no points from the deterministic sample.');
  }
  runs.push({
    mode: 'raster-profile',
    axis: 'profile',
    azimuthDeg: 45,
    origin: [originX, originZ],
    offset: profileOffset,
    thickness: profileThickness,
    cell: profileCell,
    selectedPoints: profile.sliced,
    contourCount: profile.loops.length,
    contourVertices: profile.loops.reduce((sum, loop) => sum + loop.points.length, 0),
    durationMs: Number(profileDurationMs.toFixed(3))
  });

  return runs;
}

function sampleRss() {
  return process.memoryUsage().rss;
}

async function runWorkerBenchmark(config) {
  const sourceStat = fs.statSync(config.sourcePath);
  if (!sourceStat.isFile()) throw new Error('The LAS benchmark input must be a regular file.');
  if (path.extname(config.sourcePath).toLowerCase() !== '.las') {
    throw new Error('The Stage 9 benchmark currently supports only uncompressed .las files.');
  }
  if (!fs.existsSync(config.workParent) || !fs.statSync(config.workParent).isDirectory()) {
    throw new Error(`Benchmark work directory does not exist: ${config.workParent}`);
  }
  fs.accessSync(config.workParent, fs.constants.W_OK);

  const sourceInfo = CLOUD.getOutOfCoreLasPointFileInfo(config.sourcePath);
  if (config.expectedPointCount != null && sourceInfo.pointCount !== config.expectedPointCount) {
    throw new Error(
      `LAS point-count mismatch: expected ${config.expectedPointCount}, header reports ${sourceInfo.pointCount}.`
    );
  }
  const maxPoints = Math.min(config.maxPoints, sourceInfo.pointCount);
  const recordStride = 15 + (sourceInfo.hasIntensity ? 4 : 0) + (sourceInfo.hasClassification ? 1 : 0);
  const estimatedTemporaryBytes = maxPoints * recordStride * 3 + config.diskMarginBytes;
  if (!Number.isSafeInteger(estimatedTemporaryBytes)) {
    throw new Error('Estimated temporary disk requirement exceeds safe limits.');
  }
  const availableFreeBytes = availableBytesForDirectory(config.workParent, config.configuredFreeBytes);
  if (availableFreeBytes == null) {
    throw new Error(
      'Cannot verify free space on the benchmark work volume. Set BIMTWIN_STAGE9_FREE_DISK_BYTES from a trusted OS disk-space check.'
    );
  }
  if (availableFreeBytes < estimatedTemporaryBytes) {
    throw new Error(
      `Insufficient free space: need about ${estimatedTemporaryBytes} bytes, have ${availableFreeBytes}.`
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(config.workParent, '.bimtwin-stage9-'));
  const octreeDir = path.join(tempRoot, 'octree');
  let peakRssBytes = sampleRss();
  const sampleMemory = () => { peakRssBytes = Math.max(peakRssBytes, sampleRss()); };
  const startedAt = performance.now();
  let output = null;
  try {
    const buildStartedAt = performance.now();
    const built = buildOctreeToDisk(config.sourcePath, octreeDir, {
      maxPoints,
      nodeCapacity: config.nodeCapacity,
      sourcePreflightInfo: sourceInfo,
      onProgress(progress) {
        sampleMemory();
        if (parentPort) parentPort.postMessage({ type: 'progress', progress });
      }
    });
    const buildDurationMs = performance.now() - buildStartedAt;
    sampleMemory();

    if (!built.outOfCore || built.index.ingest !== 'las-two-pass') {
      throw new Error('The input did not use the expected two-pass out-of-core LAS path.');
    }
    if (built.sourcePointCount !== sourceInfo.pointCount ||
        built.indexedPointCount > maxPoints ||
        built.index.pointCount !== built.indexedPointCount) {
      throw new Error('The out-of-core index does not match the LAS header or configured sample budget.');
    }

    const nodeFile = path.join(octreeDir, 'nodes.bin');
    const positions = readIndexedPositions(nodeFile, built.index);
    sampleMemory();
    const sectionRuns = runSectionBenchmarks(positions, built.index);
    sampleMemory();
    const sectionDurationMs = sectionRuns.reduce((sum, run) => sum + run.durationMs, 0);
    output = {
      schemaVersion: 1,
      status: 'passed',
      appVersion: require('../package.json').version,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpuModel: os.cpus()[0]?.model || 'unknown'
      },
      source: {
        name: config.sourceName,
        fileSizeBytes: sourceStat.size,
        pointCountFromHeader: sourceInfo.pointCount,
        pointFormat: sourceInfo.pointFormat,
        recordLength: sourceInfo.recordLength,
        lasVersion: `${sourceInfo.versionMajor}.${sourceInfo.versionMinor}`,
        hasIntensity: sourceInfo.hasIntensity,
        hasClassification: sourceInfo.hasClassification,
        expectedPointCount: config.expectedPointCount,
        crsWktPresent: typeof built.meta?.crsWkt === 'string' && built.meta.crsWkt.length > 0,
        crsWktLength: typeof built.meta?.crsWkt === 'string' ? built.meta.crsWkt.length : 0,
        crsWktTruncated: typeof built.meta?.crsWkt === 'string' && built.meta.crsWkt.length > 4096,
        crsWkt: typeof built.meta?.crsWkt === 'string'
          ? built.meta.crsWkt.slice(0, 4096)
          : null
      },
      ingest: {
        mode: built.index.ingest,
        fullSourceScannedInTwoPasses: true,
        sourcePointCount: built.sourcePointCount,
        indexedSamplePointCount: built.indexedPointCount,
        configuredPointBudget: maxPoints,
        sampleStride: built.meta.sampleStride || built.index.samplingRatio,
        invalidPointCount: built.meta.invalidPointCount || 0,
        nodeCount: built.index.nodeCount,
        nodeFileBytes: built.bytes,
        nodeFileSha256: built.sha256,
        durationMs: Number(buildDurationMs.toFixed(3)),
        indexedPointRatio: Number((built.indexedPointCount / built.sourcePointCount).toFixed(8))
      },
      sections: {
        scope: 'deterministic indexed sample; not the complete source point set',
        durationMs: Number(sectionDurationMs.toFixed(3)),
        runs: sectionRuns
      },
      memory: {
        rssAtStartBytes: null,
        peakRssBytes: peakRssBytes,
        processRssIncreaseBytes: null
      },
      disk: {
        availableFreeBytesBeforeRun: availableFreeBytes,
        estimatedTemporaryBytes: estimatedTemporaryBytes,
        temporaryDirectoryRemoved: false
      },
      totalDurationMs: Number((performance.now() - startedAt).toFixed(3)),
      interpretation:
        'The LAS source was fully scanned by the two-pass out-of-core indexer, but only a deterministic sample up to the configured point budget was indexed. Section kernels ran on that indexed sample.'
    };
    output.memory.rssAtStartBytes = peakRssBytes;
    output.memory.processRssIncreaseBytes = 0;
    return { report: output, peakRssBytes };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (output) output.disk.temporaryDirectoryRemoved = !fs.existsSync(tempRoot);
  }
}

function runWorkerThread(config) {
  const send = message => {
    parentPort.postMessage(message);
    parentPort.close();
  };
  return runWorkerBenchmark(config).then(
    result => send({ type: 'result', ...result }),
    error => send({
      type: 'error',
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : ''
    })
  );
}

function writeJsonReport(reportPath, report) {
  if (!reportPath) return null;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
  return reportPath;
}

function runStage9Benchmark(options = {}) {
  const config = resolveBenchmarkConfig(options);
  const startedAt = performance.now();
  const rssAtStartBytes = sampleRss();
  let peakRssBytes = rssAtStartBytes;
  let lastPhase = '';
  let lastPercent = -5;

  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { stage9Benchmark: true, config } });
    const timer = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, sampleRss());
    }, 200);
    let workerResult = null;
    let workerError = null;

    worker.on('message', message => {
      if (message.type === 'progress') {
        const progress = message.progress || {};
        const phase = String(progress.phase || 'working');
        const percent = Number.isFinite(progress.fraction) ? Math.floor(progress.fraction * 100) : null;
        if (phase !== lastPhase || (percent != null && percent >= lastPercent + 5)) {
          console.log(`[Stage 9] ${phase}${percent == null ? '' : ` ${percent}%`}`);
          lastPhase = phase;
          if (percent != null) lastPercent = percent;
        }
      } else if (message.type === 'result') {
        workerResult = message;
        peakRssBytes = Math.max(peakRssBytes, Number(message.peakRssBytes) || 0);
      } else if (message.type === 'error') {
        workerError = new Error(message.message);
        if (message.stack) workerError.stack = message.stack;
      }
    });
    worker.once('error', error => { workerError = error; });
    worker.once('exit', code => {
      clearInterval(timer);
      peakRssBytes = Math.max(peakRssBytes, sampleRss());
      if (workerError) return reject(workerError);
      if (code !== 0) return reject(new Error(`Stage 9 benchmark worker exited with code ${code}.`));
      if (!workerResult || !workerResult.report) {
        return reject(new Error('Stage 9 benchmark worker returned no report.'));
      }

      const report = workerResult.report;
      report.memory.rssAtStartBytes = rssAtStartBytes;
      report.memory.peakRssBytes = peakRssBytes;
      report.memory.processRssIncreaseBytes = Math.max(0, peakRssBytes - rssAtStartBytes);
      report.totalDurationMs = Number((performance.now() - startedAt).toFixed(3));
      report.disk.temporaryDirectoryRemoved = true;
      try {
        const savedReportPath = writeJsonReport(config.reportPath, report);
        resolve({ report, reportPath: savedReportPath });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const { report, reportPath } = await runStage9Benchmark();
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) console.log(`[Stage 9] Report saved to ${reportPath}`);
}

if (!isMainThread && workerData && workerData.stage9Benchmark) {
  runWorkerThread(workerData.config);
} else if (require.main === module) {
  main().catch(error => {
    console.error(`[Stage 9] FAILED: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MAX_POINTS,
  MAX_BENCHMARK_POINTS,
  resolveBenchmarkConfig,
  runStage9Benchmark
};