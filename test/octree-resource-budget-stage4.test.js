'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Budget = require('../octree-resource-budget');

test('octree resource preflight accepts a workload inside the conservative safe budget', () => {
  const result = Budget.assessOctreeBuildMemory(15000000, 4 * 1024 * Budget.MiB);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.estimatedBytes, 15000000 * 80 + 256 * Budget.MiB);
  assert.equal(result.safeBudgetBytes, Math.floor(4 * 1024 * Budget.MiB * 0.70));
});

test('octree resource preflight rejects a workload above the safe budget with explicit metrics', () => {
  const result = Budget.assessOctreeBuildMemory(40000000, 4 * 1024 * Budget.MiB);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient_memory');
  assert.ok(result.estimatedBytes > result.safeBudgetBytes);
});

test('unknown available memory skips the heuristic instead of fabricating a pass or failure', () => {
  const result = Budget.assessOctreeBuildMemory(1000000, null);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'memory_unavailable');
  assert.equal(Budget.assessOctreeBuildMemory(1, 0).reason, 'insufficient_memory',
    'zero reported available memory is a real denial, not an unknown value');
});

test('octree disk preflight reserves headroom around the expected node blob', () => {
  const points = 15000000;
  const required = Math.ceil(points * 15 * 1.05 + 32 * Budget.MiB) + 256 * Budget.MiB;
  const result = Budget.assessOctreeBuildDiskSpace(points, required);
  assert.equal(result.ok, true);
  assert.equal(result.requiredBytes, required);
  assert.equal(Budget.assessOctreeBuildDiskSpace(points, required - 1).reason, 'insufficient_disk');
});

test('octree disk preflight rejects no-free-space and skips only unavailable disk telemetry', () => {
  const noSpace = Budget.assessOctreeBuildDiskSpace(1000, 0);
  assert.equal(noSpace.ok, false);
  assert.equal(noSpace.reason, 'insufficient_disk');
  const unknown = Budget.assessOctreeBuildDiskSpace(1000, null);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.skipped, true);
  assert.equal(unknown.reason, 'disk_space_unavailable');
});

test('out-of-core PLY memory preflight depends on bounded node capacity rather than total point arrays', () => {
  const points = 40000000;
  const result = Budget.assessOutOfCoreOctreeMemory(points, 1024 * Budget.MiB, { nodeCapacity: 120000 });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.ok(result.estimatedBytes < 1024 * Budget.MiB * 0.70);
  assert.ok(result.estimatedBytes < points * 20,
    'estimated RAM is bounded by fixed buffers, one representative node, and descriptors');
  const smallerCapacity = Budget.assessOutOfCoreOctreeMemory(points, 1024 * Budget.MiB, { nodeCapacity: 1000 });
  assert.ok(smallerCapacity.estimatedNodeCount > result.estimatedNodeCount);
  assert.ok(smallerCapacity.estimatedBytes > result.estimatedBytes);
  assert.equal(Budget.assessOutOfCoreOctreeMemory(points, 0).reason, 'insufficient_memory');
  assert.equal(Budget.assessOutOfCoreOctreeMemory(points, null).skipped, true);
});

test('out-of-core PLY disk preflight includes canonical and partition scratch space', () => {
  const points = 15000000;
  const required = Math.ceil(points * Budget.OUT_OF_CORE_DISK_BYTES_PER_POINT * 1.05 +
    Budget.DEFAULT_NODE_DISK_FIXED_OVERHEAD_BYTES) + Budget.DEFAULT_NODE_DISK_RESERVE_BYTES;
  const result = Budget.assessOutOfCoreOctreeDiskSpace(points, required);
  assert.equal(result.ok, true);
  assert.equal(result.requiredBytes, required);
  assert.ok(result.outputBytes >= points * 30);
  assert.equal(Budget.assessOutOfCoreOctreeDiskSpace(points, required - 1).reason, 'insufficient_disk');
});

test('out-of-core PCD LZF disk preflight includes the full temporary planar store', () => {
  const points = 1000000, scratchBytes = 31 * points;
  const baseline = Budget.assessOutOfCoreOctreeDiskSpace(points, Number.MAX_SAFE_INTEGER);
  const withScratch = Budget.assessOutOfCoreOctreeDiskSpace(
    points, baseline.requiredBytes + scratchBytes, { extraBytes: scratchBytes }
  );
  assert.equal(withScratch.ok, true);
  assert.equal(withScratch.extraBytes, scratchBytes);
  assert.equal(withScratch.requiredBytes, baseline.requiredBytes + scratchBytes);
  assert.equal(
    Budget.assessOutOfCoreOctreeDiskSpace(
      points, baseline.requiredBytes + scratchBytes - 1, { extraBytes: scratchBytes }
    ).reason,
    'insufficient_disk'
  );
});

test('sampled cloud preview preflight accepts bounded previews and rejects oversized point budgets', () => {
  const available = 4 * 1024 * Budget.MiB;
  const normal = Budget.assessCloudPreviewMemory(300000, available);
  assert.equal(normal.ok, true);
  assert.equal(normal.skipped, false);
  assert.equal(
    normal.estimatedBytes,
    300000 * Budget.DEFAULT_CLOUD_PREVIEW_BYTES_PER_POINT +
      Budget.DEFAULT_CLOUD_PREVIEW_FIXED_OVERHEAD_BYTES
  );
  assert.equal(normal.safeBudgetBytes, Math.floor(available * 0.70));

  const oversized = Budget.assessCloudPreviewMemory(300000000, available);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reason, 'insufficient_memory');
  assert.ok(oversized.estimatedBytes > oversized.safeBudgetBytes);

  const unknown = Budget.assessCloudPreviewMemory(300000000, null);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.skipped, true);
  assert.equal(unknown.reason, 'memory_unavailable');
});

test('invalid point counts are rejected and byte formatting is stable', () => {
  assert.equal(Budget.assessOctreeBuildMemory(0, 1024).reason, 'invalid_point_count');
  assert.equal(Budget.assessOctreeBuildDiskSpace(0, 1024).reason, 'invalid_point_count');
  assert.equal(Budget.assessOctreeBuildMemory(Number.MAX_SAFE_INTEGER + 1, 1024).ok, false);
  assert.equal(Budget.formatMiB(5 * Budget.MiB), '5 МиБ');
});