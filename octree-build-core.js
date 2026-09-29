'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Cloud = require('./las-node');
const Octree = require('./renderer/octree-store');
const { atomicWriteJsonSync } = require('./db/atomic-file');

const MAX_INDEX_POINTS = 40000000;
const CANONICAL_PARTITION_BUFFER_RECORDS = 16384;

function writeAllSync(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!written) throw new Error('short write while writing octree node data');
    offset += written;
  }
}

function syncFile(filePath) {
  let fd;
  // Windows can reject fsync on a read-only handle with EPERM.
  try { fd = fs.openSync(filePath, 'r+'); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

function nodeFraction(bytesWritten, totalBytes) {
  return 0.5 + 0.43 * Math.min(1, totalBytes > 0 ? bytesWritten / totalBytes : 0);
}

function buildCanonicalPointOctreeToDisk(source, targetDir, maxPoints, nodeCapacity, tempNodePath,
    onProgress, sourceTransform, sourceInfo, prepareSource, sourceKind) {
  const token = crypto.randomBytes(8).toString('hex');
  const canonicalPath = path.join(targetDir, '.source-' + token + '.tmp');
  let nodeFd = null;
  try {
    const prepared = prepareSource(source, canonicalPath, maxPoints, progress => {
      const value = Object.assign({}, progress || {});
      if (Number.isFinite(value.fraction)) {
        value.phase = 'parse-' + String(value.phase || 'read');
        value.fraction = Math.min(0.48, Math.max(0, value.fraction));
      } else value.phase = 'parse-' + String(value.phase || 'read');
      onProgress(value);
    }, sourceTransform, sourceInfo);
    if (!prepared || !prepared.ok || !prepared.count) {
      throw new Error('out-of-core ' + sourceKind.toUpperCase() + ' preparation returned no points');
    }

    const pointCount = prepared.count;
    const sourceMeta = prepared.meta || {};
    const hasIntensity = sourceMeta.hasIntensity === true;
    const hasClassification = sourceMeta.hasClassification === true;
    const recordStride = 15 + (hasIntensity ? 4 : 0) + (hasClassification ? 1 : 0);
    const totalNodeBytes = pointCount * recordStride;
    if (!Number.isSafeInteger(totalNodeBytes)) throw new Error('out-of-core point-store byte size exceeds safe file limits');
    const rootStat = fs.statSync(canonicalPath);
    if (!rootStat.isFile() || rootStat.size !== totalNodeBytes) throw new Error('canonical point store has an invalid size');

    nodeFd = fs.openSync(tempNodePath, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const descriptors = [];
    let offset = 0, emittedPoints = 0, workDone = 0, partitionCount = 0;
    const maxDepth = 14; // fixed deterministic safety bound
    const readRecords = Math.max(1, Math.floor(8 * 1024 * 1024 / recordStride));
    const readBuffer = Buffer.alloc(readRecords * recordStride);
    const partBuffer = Buffer.alloc(CANONICAL_PARTITION_BUFFER_RECORDS * recordStride);

    function writeNodeBytes(key, level, mn, mx, childKeys, splitMode, bytes, count) {
      const byteLength = count * recordStride;
      if (bytes.length !== byteLength) throw new Error('out-of-core node buffer has an invalid size');
      const descriptor = {
        key, level, mn: mn.slice(), mx: mx.slice(), count,
        offset, byteLength, childKeys: childKeys.slice()
      };
      if (splitMode) descriptor.splitMode = splitMode;
      writeAllSync(nodeFd, bytes, offset);
      hash.update(bytes);
      offset += byteLength;
      emittedPoints += count;
      descriptors.push(descriptor);
      if (descriptors.length === 1 || descriptors.length % 32 === 0) {
        onProgress({
          phase: 'octree-build', fraction: nodeFraction(offset, totalNodeBytes),
          nodeCount: descriptors.length, nodesWritten: descriptors.length,
          bytesWritten: offset, workDone
        });
      }
      return descriptor;
    }

    function flushSink(sink) {
      if (!sink.used) return;
      writeAllSync(sink.fd, sink.buffer.subarray(0, sink.used), sink.position);
      sink.position += sink.used;
      sink.used = 0;
    }

    function processNode(key, level, mn, mx, inputPath, count) {
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid point count in out-of-core partition');
      const st = fs.statSync(inputPath);
      if (!st.isFile() || st.size !== count * recordStride) {
        throw new Error('out-of-core partition size/count mismatch at node ' + key);
      }
      if (count <= nodeCapacity) {
        const fd = fs.openSync(inputPath, 'r');
        try {
          let record = 0;
          while (record < count) {
            const take = Math.min(readRecords, count - record);
            const bytes = take * recordStride;
            let got = 0;
            while (got < bytes) {
              const n = fs.readSync(fd, readBuffer, got, bytes - got, record * recordStride + got);
              if (n <= 0) throw new Error('short read in out-of-core leaf node ' + key);
              got += n;
            }
            const part = readBuffer.subarray(0, bytes);
            writeAllSync(nodeFd, part, offset);
            hash.update(part);
            offset += bytes;
            record += take;
            workDone += take;
          }
        } finally { fs.closeSync(fd); }
        const descriptor = {
          key, level, mn: mn.slice(), mx: mx.slice(), count,
          offset: offset - count * recordStride,
          byteLength: count * recordStride, childKeys: []
        };
        descriptors.push(descriptor);
        emittedPoints += count;
        if (descriptors.length === 1 || descriptors.length % 32 === 0) {
          onProgress({
            phase: 'octree-build', fraction: nodeFraction(offset, totalNodeBytes),
            nodeCount: descriptors.length, nodesWritten: descriptors.length,
            bytesWritten: offset, workDone
          });
        }
        fs.unlinkSync(inputPath);
        return;
      }

      const sampleStep = Math.max(2, Math.ceil(count / nodeCapacity));
      const ownCount = Math.min(nodeCapacity, Math.ceil(count / sampleStep));
      const selected = Octree.sampleNodePositions(count, ownCount, key);
      selected.sort();
      const ownBytes = Buffer.alloc(ownCount * recordStride);
      const remainingCount = count - ownCount;
      const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
      const balancedFallback = level >= maxDepth;
      const sinks = new Array(8).fill(null);
      const inputFd = fs.openSync(inputPath, 'r');
      let nextSelected = 0, restOrdinal = 0, restCount = 0, record = 0;
      const bucketCounts = new Array(8).fill(0);
      try {
        while (record < count) {
          const take = Math.min(readRecords, count - record);
          const bytes = take * recordStride;
          let got = 0;
          while (got < bytes) {
            const n = fs.readSync(inputFd, readBuffer, got, bytes - got, record * recordStride + got);
            if (n <= 0) throw new Error('short read in out-of-core partition ' + key);
            got += n;
          }
          for (let i = 0; i < take; i++) {
            const globalRecord = record + i;
            const src = i * recordStride;
            if (nextSelected < ownCount && selected[nextSelected] === globalRecord) {
              readBuffer.copy(ownBytes, nextSelected * recordStride, src, src + recordStride);
              nextSelected++;
              continue;
            }
            restCount++;
            let octant;
            if (balancedFallback) {
              octant = Math.min(7, Math.floor(restOrdinal * 8 / remainingCount));
              restOrdinal++;
            } else {
              const x = readBuffer.readFloatLE(src), y = readBuffer.readFloatLE(src + 4), z = readBuffer.readFloatLE(src + 8);
              octant = (x >= cx ? 1 : 0) | (y >= cy ? 2 : 0) | (z >= cz ? 4 : 0);
            }
            let sink = sinks[octant];
            if (!sink) {
              const childKey = key + octant;
              const partPath = path.join(targetDir, '.part-' + childKey + '-' + token + '.tmp');
              const fd = fs.openSync(partPath, 'wx', 0o600);
              sink = sinks[octant] = { key: childKey, path: partPath, fd, buffer: Buffer.from(partBuffer), used: 0, position: 0, count: 0 };
            }
            readBuffer.copy(sink.buffer, sink.used, src, src + recordStride);
            sink.used += recordStride;
            sink.count++;
            bucketCounts[octant]++;
            if (sink.used === sink.buffer.length) flushSink(sink);
          }
          record += take;
          workDone += take;
          partitionCount += take;
          if (partitionCount >= 1048576) {
            partitionCount = 0;
            onProgress({
              phase: 'octree-partition',
              fraction: nodeFraction(offset, totalNodeBytes),
              currentNode: key, sourceRecordsProcessed: record,
              sourceRecordsTotal: count, nodesWritten: descriptors.length,
              bytesWritten: offset, workDone
            });
          }
        }
        if (nextSelected !== ownCount || restCount !== remainingCount ||
            (balancedFallback && restOrdinal !== remainingCount)) {
          throw new Error('out-of-core split did not account for every source record at node ' + key);
        }
        for (const sink of sinks) if (sink) flushSink(sink);
      } finally {
        try { fs.closeSync(inputFd); } catch (_) {}
        for (const sink of sinks) if (sink) {
          try { fs.closeSync(sink.fd); } catch (_) {}
        }
      }
      onProgress({
        phase: 'octree-partition', fraction: nodeFraction(offset, totalNodeBytes),
        currentNode: key, sourceRecordsProcessed: count,
        sourceRecordsTotal: count, nodesWritten: descriptors.length,
        bytesWritten: offset, workDone
      });
      fs.unlinkSync(inputPath);

      const childKeys = [];
      const children = [];
      for (let octant = 0; octant < 8; octant++) {
        const sink = sinks[octant];
        if (!sink || !bucketCounts[octant]) {
          if (sink) try { fs.unlinkSync(sink.path); } catch (_) {}
          continue;
        }
        const childMn = balancedFallback
          ? mn.slice()
          : [(octant & 1) ? cx : mn[0], (octant & 2) ? cy : mn[1], (octant & 4) ? cz : mn[2]];
        const childMx = balancedFallback
          ? mx.slice()
          : [(octant & 1) ? mx[0] : cx, (octant & 2) ? mx[1] : cy, (octant & 4) ? mx[2] : cz];
        childKeys.push(sink.key);
        children.push({ key: sink.key, level: level + 1, mn: childMn, mx: childMx, path: sink.path, count: sink.count });
      }
      if (childKeys.length === 0 || children.reduce((sum, child) => sum + child.count, 0) + ownCount !== count) {
        throw new Error('out-of-core child partition totals do not match node ' + key);
      }
      writeNodeBytes(key, level, mn, mx, childKeys,
        balancedFallback ? 'balanced-overlap-fallback' : undefined,
        ownBytes, ownCount);
      for (const child of children) processNode(child.key, child.level, child.mn, child.mx, child.path, child.count);
    }

    onProgress({
      phase: 'octree-start', fraction: 0.49, pointCount,
      sourcePointCount: prepared.sourcePointCount, mode: 'out-of-core-' + sourceKind
    });
    processNode('r', 0, prepared.bbox.mn, prepared.bbox.mx, canonicalPath, pointCount);
    if (offset !== totalNodeBytes || emittedPoints !== pointCount) {
      throw new Error('out-of-core octree point/byte totals do not match');
    }
    const index = {
      version: (hasIntensity || hasClassification) ? 2 : 1,
      root: 'r', hasColor: true, hasIntensity, hasClassification, stride: recordStride,
      pointCount, nodeCount: descriptors.length,
      bbox: { mn: prepared.bbox.mn.slice(), mx: prepared.bbox.mx.slice() },
      nodes: descriptors,
      outOfCore: true, ingest: prepared.ingest || (sourceKind + '-two-pass')
    };
    index.sourcePointCount = prepared.sourcePointCount;
    index.indexedPointCount = pointCount;
    index.samplingRatio = prepared.sourcePointCount > 0 ? prepared.sourcePointCount / pointCount : 1;
    index.decimation = Math.max(1, Math.round(index.samplingRatio * 10) / 10);
    index.exactDecimation = false;
    index.sourceMeta = sourceMeta;

    onProgress({ phase: 'octree-write', fraction: 0.99, nodesWritten: descriptors.length, nodeCount: descriptors.length, bytesWritten: offset });
    fs.fsyncSync(nodeFd);
    fs.closeSync(nodeFd);
    nodeFd = null;
    fs.renameSync(tempNodePath, path.join(targetDir, 'nodes.bin'));
    syncFile(path.join(targetDir, 'nodes.bin'));
    // Only immutable deliverables survive a successful commit.
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.isFile() && /^\.(?:source|part-|nodes-).*\.tmp$/.test(entry.name)) {
        fs.unlinkSync(path.join(targetDir, entry.name));
      }
    }
    atomicWriteJsonSync(path.join(targetDir, 'index.json'), index, { mode: 0o600 });
    onProgress({
      phase: 'done', fraction: 1, pointCount, nodeCount: descriptors.length,
      bytesWritten: offset, sourcePointCount: prepared.sourcePointCount,
      outOfCore: true, peakPointArrayBytes: 0
    });
    return {
      dir: targetDir, index, meta: sourceMeta, bytes: offset,
      sha256: hash.digest('hex'), sourcePointCount: prepared.sourcePointCount,
      indexedPointCount: pointCount, outOfCore: true
    };
  } catch (error) {
    if (nodeFd !== null) try { fs.closeSync(nodeFd); } catch (_) {}
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function buildOctreeToDisk(sourcePath, outputDir, options) {
  options = options || {};
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const source = path.resolve(String(sourcePath || ''));
  const targetDir = path.resolve(String(outputDir || ''));
  if (!source || !targetDir || source === targetDir) throw new Error('invalid octree build path');
  const sourceStat = fs.statSync(source);
  if (!sourceStat.isFile()) throw new Error('point-cloud source is not a regular file');
  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: false, mode: 0o700 });

  const requestedBudget = Number(options.maxPoints);
  const maxPoints = Math.max(1, Math.min(MAX_INDEX_POINTS, Number.isSafeInteger(requestedBudget) && requestedBudget > 0 ? requestedBudget : MAX_INDEX_POINTS));
  const requestedCapacity = Number(options.nodeCapacity);
  const nodeCapacity = Math.max(1000, Math.min(500000, Number.isSafeInteger(requestedCapacity) && requestedCapacity > 0 ? requestedCapacity : 120000));
  const tempNodePath = path.join(targetDir, '.nodes-' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let tempFd = null;
  try {
    const extension = path.extname(source).toLowerCase();
    let pointFileInfo = null, sourceKind = null, sameInfo = null, prepareSource = null;
    if (extension === '.ply' && typeof Cloud.getOutOfCorePlyPointFileInfo === 'function') {
      sourceKind = 'ply';
      sameInfo = Cloud.samePlyPointFileInfo;
      prepareSource = Cloud.preparePlyOctreeFile;
      try { pointFileInfo = Cloud.getOutOfCorePlyPointFileInfo(source); } catch (_) {}
    } else if (extension === '.las' &&
        typeof Cloud.getOutOfCoreLasPointFileInfo === 'function' &&
        typeof Cloud.prepareLasOctreeFile === 'function') {
      sourceKind = 'las';
      sameInfo = Cloud.sameLasPointFileInfo;
      prepareSource = Cloud.prepareLasOctreeFile;
      try { pointFileInfo = Cloud.getOutOfCoreLasPointFileInfo(source); } catch (_) {}
    } else if (extension === '.pcd' &&
        typeof Cloud.getOutOfCorePcdPointFileInfo === 'function' &&
        typeof Cloud.preparePcdOctreeFile === 'function') {
      sourceKind = 'pcd';
      sameInfo = Cloud.samePcdPointFileInfo;
      prepareSource = Cloud.preparePcdOctreeFile;
      try { pointFileInfo = Cloud.getOutOfCorePcdPointFileInfo(source); } catch (_) {}
    }
    if (options.sourcePreflightInfo &&
        (!pointFileInfo || !sameInfo ||
         !sameInfo(pointFileInfo, options.sourcePreflightInfo))) {
      throw new Error('source ' + String(sourceKind || 'point cloud').toUpperCase() +
        ' changed after resource preflight; retry indexing');
    }
    if (pointFileInfo && prepareSource) {
      return buildCanonicalPointOctreeToDisk(
        source, targetDir, maxPoints, nodeCapacity, tempNodePath, onProgress,
        options.sourceTransform, options.sourcePreflightInfo || pointFileInfo,
        prepareSource, sourceKind
      );
    }
    onProgress({ phase: 'parse-start', fraction: 0, sourceBytes: sourceStat.size, maxPoints });
    const parsed = Cloud.parseCloudFile(source, {
      maxPoints,
      onProgress: progress => {
        if (progress && Number.isFinite(progress.fraction)) {
          onProgress(Object.assign({}, progress, { phase: 'parse-' + String(progress.phase || 'read'), fraction: Math.min(0.48, Math.max(0, progress.fraction * 0.48)) }));
        } else onProgress(Object.assign({ phase: 'parse' }, progress || {}));
      }
    });
    if (!parsed || !parsed.ok) throw new Error((parsed && parsed.message) || 'point-cloud parse failed');
    if (parsed.kind && parsed.kind !== 'points') throw new Error('octree input must be a point cloud');
    if (!parsed.pos || !parsed.pos.length) throw new Error('point-cloud parse returned no points');

    const sourceMeta = parsed.meta || {};
    const sourcePoints = Number(sourceMeta.total || sourceMeta.points || parsed.count || parsed.pos.length / 3);
    const indexedPoints = parsed.count == null ? Math.floor(parsed.pos.length / 3) : parsed.count;
    if (!Number.isSafeInteger(indexedPoints) || indexedPoints < 1 || parsed.pos.length !== indexedPoints * 3) {
      throw new Error('parsed XYZ buffer does not match its point count');
    }
    onProgress({ phase: 'octree-start', fraction: 0.5, pointCount: indexedPoints, sourcePointCount: sourcePoints });
    tempFd = fs.openSync(tempNodePath, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const hasColor = !!parsed.col;
    let offset = 0, nodesWritten = 0;
    const built = Octree.buildOctree(parsed.pos, parsed.col || null, {
      nodeCapacity,
      retainNodes: false,
      onProgress: value => onProgress(Object.assign({}, value, { phase: 'octree-build' })),
      onNode: (node, desc) => {
        const bytes = Octree.serializeNodePoints(node.pos, node.col, hasColor);
        if (bytes.byteLength !== desc.byteLength || desc.offset !== offset) throw new Error('octree index/blob offset mismatch');
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        writeAllSync(tempFd, buffer, offset);
        hash.update(buffer);
        offset += buffer.length;
        nodesWritten++;
        if (nodesWritten === 1 || nodesWritten % 32 === 0) {
          onProgress({ phase: 'octree-build', nodesWritten: nodesWritten, bytesWritten: offset });
        }
      }
    });
    const index = Octree.createOctreeIndex(built);
    if (offset !== built.packedBytes || nodesWritten !== index.nodeCount) throw new Error('octree streamed write totals do not match the index');
    index.sourcePointCount = sourcePoints;
    index.samplingRatio = sourcePoints > 0 ? sourcePoints / indexedPoints : 1;
    index.decimation = Number(sourceMeta.decimation) > 0
      ? Number(sourceMeta.decimation)
      : Math.max(1, Math.round(index.samplingRatio * 10) / 10);
    index.exactDecimation = Number(sourceMeta.decimation) > 0;
    index.sourceMeta = sourceMeta;
    // The writer consumes each node as soon as it is built and retains only
    // small descriptors, so no second full point-coordinate/color copy stays
    // resident while the tree is packed to disk.
    parsed.pos = null; parsed.col = null; parsed.intensity = null; parsed.classification = null;

    onProgress({ phase: 'octree-write', fraction: 0.99, nodesWritten: nodesWritten, nodeCount: index.nodeCount, bytesWritten: offset });
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = null;
    fs.renameSync(tempNodePath, path.join(targetDir, 'nodes.bin'));
    syncFile(path.join(targetDir, 'nodes.bin'));
    atomicWriteJsonSync(path.join(targetDir, 'index.json'), index, { mode: 0o600 });
    onProgress({ phase: 'done', fraction: 1, pointCount: index.pointCount, nodeCount: index.nodeCount, bytesWritten: offset });
    return {
      dir: targetDir, index, meta: sourceMeta,
      bytes: offset, sha256: hash.digest('hex'),
      sourcePointCount: sourcePoints, indexedPointCount: indexedPoints
    };
  } catch (error) {
    if (tempFd !== null) try { fs.closeSync(tempFd); } catch (_) {}
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

module.exports = { buildOctreeToDisk, MAX_INDEX_POINTS };