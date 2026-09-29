'use strict';

const MiB = 1024 * 1024;

// Conservative estimate for the current in-memory parser + partitioner.
// It is a preflight guard, not a measurement of actual peak RSS.
const DEFAULT_BYTES_PER_POINT = 80;
const DEFAULT_FIXED_OVERHEAD_BYTES = 256 * MiB;
const DEFAULT_AVAILABLE_MEMORY_FRACTION = 0.70;
const DEFAULT_NODE_DISK_BYTES_PER_POINT = 15;
const DEFAULT_NODE_DISK_FIXED_OVERHEAD_BYTES = 32 * MiB;
const DEFAULT_NODE_DISK_RESERVE_BYTES = 256 * MiB;
const DEFAULT_NODE_DISK_EXPANSION = 1.05;
const DEFAULT_CLOUD_PREVIEW_BYTES_PER_POINT = 128;
const DEFAULT_CLOUD_PREVIEW_FIXED_OVERHEAD_BYTES = 128 * MiB;
const OUT_OF_CORE_FIXED_MEMORY_BYTES = 192 * MiB;
const OUT_OF_CORE_BYTES_PER_NODE_POINT = 32;
const OUT_OF_CORE_BYTES_PER_NODE_DESCRIPTOR = 512;
const OUT_OF_CORE_DISK_BYTES_PER_POINT = 30;

function assessOctreeBuildMemory(pointCount, availableBytes, options) {
  options = options || {};
  const count = Number(pointCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    return { ok: false, reason: 'invalid_point_count', pointCount: count };
  }

  if (availableBytes === null || availableBytes === undefined || availableBytes === '') {
    return { ok: true, skipped: true, reason: 'memory_unavailable', pointCount: count };
  }
  const available = Number(availableBytes);
  if (!Number.isFinite(available) || available < 0) {
    return { ok: true, skipped: true, reason: 'memory_unavailable', pointCount: count };
  }

  const bytesPerPoint = Number.isSafeInteger(options.bytesPerPoint) && options.bytesPerPoint > 0
    ? options.bytesPerPoint
    : DEFAULT_BYTES_PER_POINT;
  const fixedOverheadBytes = Number.isSafeInteger(options.fixedOverheadBytes) && options.fixedOverheadBytes >= 0
    ? options.fixedOverheadBytes
    : DEFAULT_FIXED_OVERHEAD_BYTES;
  const availableFraction = Number.isFinite(options.availableMemoryFraction) &&
    options.availableMemoryFraction > 0 && options.availableMemoryFraction <= 1
    ? options.availableMemoryFraction
    : DEFAULT_AVAILABLE_MEMORY_FRACTION;
  const estimatedBytes = Math.ceil(count * bytesPerPoint + fixedOverheadBytes);
  const safeBudgetBytes = Math.floor(available * availableFraction);

  return {
    ok: estimatedBytes <= safeBudgetBytes,
    skipped: false,
    reason: estimatedBytes <= safeBudgetBytes ? null : 'insufficient_memory',
    pointCount: count,
    bytesPerPoint,
    estimatedBytes,
    availableBytes: available,
    safeBudgetBytes,
    availableMemoryFraction: availableFraction
  };
}

function assessOctreeBuildDiskSpace(pointCount, availableBytes, options) {
  options = options || {};
  const count = Number(pointCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    return { ok: false, reason: 'invalid_point_count', pointCount: count };
  }

  if (availableBytes === null || availableBytes === undefined || availableBytes === '') {
    return { ok: true, skipped: true, reason: 'disk_space_unavailable', pointCount: count };
  }
  const available = Number(availableBytes);
  if (!Number.isFinite(available) || available < 0) {
    return { ok: true, skipped: true, reason: 'disk_space_unavailable', pointCount: count };
  }

  const bytesPerPoint = Number.isSafeInteger(options.bytesPerPoint) && options.bytesPerPoint > 0
    ? options.bytesPerPoint
    : DEFAULT_NODE_DISK_BYTES_PER_POINT;
  const fixedOverheadBytes = Number.isSafeInteger(options.fixedOverheadBytes) && options.fixedOverheadBytes >= 0
    ? options.fixedOverheadBytes
    : DEFAULT_NODE_DISK_FIXED_OVERHEAD_BYTES;
  const reserveBytes = Number.isSafeInteger(options.reserveBytes) && options.reserveBytes >= 0
    ? options.reserveBytes
    : DEFAULT_NODE_DISK_RESERVE_BYTES;
  const expansion = Number.isFinite(options.expansion) && options.expansion >= 1 && options.expansion <= 2
    ? options.expansion
    : DEFAULT_NODE_DISK_EXPANSION;
  const extraBytes = Number.isSafeInteger(options.extraBytes) && options.extraBytes >= 0
    ? options.extraBytes
    : 0;
  const outputBytes = Math.ceil(count * bytesPerPoint * expansion + fixedOverheadBytes + extraBytes);
  const requiredBytes = outputBytes + reserveBytes;

  return {
    ok: requiredBytes <= available,
    skipped: false,
    reason: requiredBytes <= available ? null : 'insufficient_disk',
    pointCount: count,
    bytesPerPoint,
    extraBytes,
    outputBytes,
    reserveBytes,
    requiredBytes,
    availableBytes: available
  };
}

// Binary-PLY out-of-core ingest keeps read buffers and one representative node
// in RAM. This is still a conservative estimate (descriptor count is bounded
// approximately from point count); it is deliberately separate from the
// in-memory parser/partitioner estimate above.
function assessOutOfCoreOctreeMemory(pointCount, availableBytes, options) {
  options = options || {};
  const count = Number(pointCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    return { ok: false, reason: 'invalid_point_count', pointCount: count };
  }
  if (availableBytes === null || availableBytes === undefined || availableBytes === '') {
    return { ok: true, skipped: true, reason: 'memory_unavailable', pointCount: count };
  }
  const available = Number(availableBytes);
  if (!Number.isFinite(available) || available < 0) {
    return { ok: true, skipped: true, reason: 'memory_unavailable', pointCount: count };
  }
  const requestedCapacity = Number(options.nodeCapacity);
  const nodeCapacity = Number.isSafeInteger(requestedCapacity) && requestedCapacity > 0
    ? Math.max(1000, Math.min(500000, requestedCapacity))
    : 120000;
  const fixedBytes = Number.isSafeInteger(options.fixedBytes) && options.fixedBytes >= 0
    ? options.fixedBytes
    : OUT_OF_CORE_FIXED_MEMORY_BYTES;
  const pointBytes = Number.isSafeInteger(options.bytesPerNodePoint) && options.bytesPerNodePoint > 0
    ? options.bytesPerNodePoint
    : OUT_OF_CORE_BYTES_PER_NODE_POINT;
  const descriptorBytes = Number.isSafeInteger(options.bytesPerNodeDescriptor) && options.bytesPerNodeDescriptor > 0
    ? options.bytesPerNodeDescriptor
    : OUT_OF_CORE_BYTES_PER_NODE_DESCRIPTOR;
  const estimatedNodeCount = Math.ceil(count / Math.max(500, Math.floor(nodeCapacity / 2)));
  const estimatedBytes = Math.ceil(fixedBytes + Math.min(count, nodeCapacity) * pointBytes + estimatedNodeCount * descriptorBytes);
  const fraction = Number.isFinite(options.availableMemoryFraction) &&
    options.availableMemoryFraction > 0 && options.availableMemoryFraction <= 1
    ? options.availableMemoryFraction
    : DEFAULT_AVAILABLE_MEMORY_FRACTION;
  const safeBudgetBytes = Math.floor(available * fraction);
  return {
    ok: estimatedBytes <= safeBudgetBytes,
    skipped: false,
    reason: estimatedBytes <= safeBudgetBytes ? null : 'insufficient_memory',
    pointCount: count, nodeCapacity, estimatedNodeCount,
    estimatedBytes, availableBytes: available, safeBudgetBytes,
    availableMemoryFraction: fraction
  };
}

function assessOutOfCoreOctreeDiskSpace(pointCount, availableBytes, options) {
  return assessOctreeBuildDiskSpace(pointCount, availableBytes, Object.assign({
    bytesPerPoint: OUT_OF_CORE_DISK_BYTES_PER_POINT
  }, options || {}));
}

// Preview keeps both source-coordinate/attribute arrays and normalized output
// arrays alive during finalization/IPC. This deliberately conservative estimate
// is separate from out-of-core indexing; it is not a GPU-memory guarantee.
function assessCloudPreviewMemory(pointCount, availableBytes, options) {
  options = options || {};
  const count = Number(pointCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    return { ok: false, reason: 'invalid_point_count', pointCount: count };
  }
  if (availableBytes === null || availableBytes === undefined || availableBytes === '') {
    return { ok: true, skipped: true, reason: 'memory_unavailable', pointCount: count };
  }
  const available = Number(availableBytes);
  if (!Number.isFinite(available) || available < 0) {
    return { ok: true, skipped: true, reason: 'memory_unavailable', pointCount: count };
  }
  const bytesPerPoint = Number.isSafeInteger(options.bytesPerPoint) && options.bytesPerPoint > 0
    ? options.bytesPerPoint
    : DEFAULT_CLOUD_PREVIEW_BYTES_PER_POINT;
  const fixedOverheadBytes = Number.isSafeInteger(options.fixedOverheadBytes) && options.fixedOverheadBytes >= 0
    ? options.fixedOverheadBytes
    : DEFAULT_CLOUD_PREVIEW_FIXED_OVERHEAD_BYTES;
  const availableMemoryFraction = Number.isFinite(options.availableMemoryFraction) &&
    options.availableMemoryFraction > 0 && options.availableMemoryFraction <= 1
    ? options.availableMemoryFraction
    : DEFAULT_AVAILABLE_MEMORY_FRACTION;
  const estimatedBytes = Math.ceil(count * bytesPerPoint + fixedOverheadBytes);
  const safeBudgetBytes = Math.floor(available * availableMemoryFraction);
  return {
    ok: estimatedBytes <= safeBudgetBytes,
    skipped: false,
    reason: estimatedBytes <= safeBudgetBytes ? null : 'insufficient_memory',
    pointCount: count,
    bytesPerPoint,
    fixedOverheadBytes,
    estimatedBytes,
    availableBytes: available,
    safeBudgetBytes,
    availableMemoryFraction
  };
}

function formatMiB(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'неизвестно';
  return (value / MiB).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' МиБ';
}

module.exports = {
  MiB,
  DEFAULT_BYTES_PER_POINT,
  DEFAULT_FIXED_OVERHEAD_BYTES,
  DEFAULT_AVAILABLE_MEMORY_FRACTION,
  DEFAULT_NODE_DISK_BYTES_PER_POINT,
  DEFAULT_NODE_DISK_FIXED_OVERHEAD_BYTES,
  DEFAULT_NODE_DISK_RESERVE_BYTES,
  DEFAULT_NODE_DISK_EXPANSION,
  DEFAULT_CLOUD_PREVIEW_BYTES_PER_POINT,
  DEFAULT_CLOUD_PREVIEW_FIXED_OVERHEAD_BYTES,
  OUT_OF_CORE_FIXED_MEMORY_BYTES,
  OUT_OF_CORE_BYTES_PER_NODE_POINT,
  OUT_OF_CORE_BYTES_PER_NODE_DESCRIPTOR,
  OUT_OF_CORE_DISK_BYTES_PER_POINT,
  assessOctreeBuildMemory,
  assessOctreeBuildDiskSpace,
  assessOutOfCoreOctreeMemory,
  assessOutOfCoreOctreeDiskSpace,
  assessCloudPreviewMemory,
  formatMiB
};