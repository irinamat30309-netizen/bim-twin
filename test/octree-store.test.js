'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OS = require('../renderer/octree-store.js');

function makeCloud(n, withColor) {
  const pos = new Float32Array(n * 3);
  const col = withColor ? new Float32Array(n * 3) : null;
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    pos[i * 3] = rnd() * 200 - 100;
    pos[i * 3 + 1] = rnd() * 60;
    pos[i * 3 + 2] = rnd() * 200 - 100;
    if (col) { col[i * 3] = rnd(); col[i * 3 + 1] = rnd(); col[i * 3 + 2] = rnd(); }
  }
  return { pos, col };
}

test('buildOctree preserves every point across nodes (no loss, no duplication)', () => {
  const { pos } = makeCloud(120000, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 5000 });
  let sum = 0;
  for (const nd of built.nodes) sum += nd.pos.length / 3;
  assert.strictEqual(sum, built.pointCount, 'sum of node points equals total');
  assert.strictEqual(built.pointCount, 120000);
  assert.ok(built.nodeCount > 8, 'large cloud must produce a multi-level tree');
});

test('octree root LOD sample is deterministic and does not inherit scan-line ordering', () => {
  const side = 60, count = side * side * side;
  const pos = new Float32Array(count * 3);
  let at = 0;
  // Deliberately scan-line ordered: X changes fastest, then Y, then Z.
  for (let z = 0; z < side; z++) {
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        pos[at++] = x;
        pos[at++] = y;
        pos[at++] = z;
      }
    }
  }
  const first = OS.buildOctree(pos, null, { nodeCapacity: 1000 });
  const second = OS.buildOctree(pos, null, { nodeCapacity: 1000 });
  const root = first.nodes.find(node => node.key === 'r');
  const repeatedRoot = second.nodes.find(node => node.key === 'r');
  assert.ok(root && root.pos.length / 3 === 1000);
  assert.deepStrictEqual(Array.from(root.pos), Array.from(repeatedRoot.pos), 'same input creates the same LOD');

  const octants = new Array(8).fill(0);
  for (let i = 0; i < root.pos.length; i += 3) {
    const oct = (root.pos[i] >= side / 2 ? 1 : 0) |
      (root.pos[i + 1] >= side / 2 ? 2 : 0) |
      (root.pos[i + 2] >= side / 2 ? 4 : 0);
    octants[oct]++;
  }
  for (const sampleCount of octants) {
    assert.ok(sampleCount >= 75 && sampleCount <= 175,
      'uniform spatial octants receive representative points: ' + octants.join(','));
  }

  const total = first.nodes.reduce((sum, node) => sum + node.pos.length / 3, 0);
  assert.equal(total, count, 'LOD representatives plus descendants retain every source point exactly once');
});

test('root exists and non-leaf nodes reference existing children', () => {
  const { pos } = makeCloud(80000, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 4000 });
  const keys = new Set(built.nodes.map(n => n.key));
  assert.ok(keys.has('r'), 'root node r present');
  for (const nd of built.nodes) {
    for (const ck of nd.childKeys) assert.ok(keys.has(ck), 'child key ' + ck + ' must exist');
    assert.strictEqual(nd.level, nd.key.length - 1, 'level matches key path length');
  }
});

test('each node points lie within its bbox', () => {
  const { pos } = makeCloud(60000, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 3000 });
  for (const nd of built.nodes) {
    for (let i = 0; i < nd.pos.length; i += 3) {
      assert.ok(nd.pos[i] >= nd.mn[0] - 1e-3 && nd.pos[i] <= nd.mx[0] + 1e-3, 'x within node bbox');
      assert.ok(nd.pos[i + 1] >= nd.mn[1] - 1e-3 && nd.pos[i + 1] <= nd.mx[1] + 1e-3, 'y within node bbox');
      assert.ok(nd.pos[i + 2] >= nd.mn[2] - 1e-3 && nd.pos[i + 2] <= nd.mx[2] + 1e-3, 'z within node bbox');
    }
  }
});

test('serialize/deserialize node roundtrip: exact geometry, near-exact color', () => {
  const { pos, col } = makeCloud(2000, true);
  const bytes = OS.serializeNodePoints(pos, col, true);
  assert.strictEqual(bytes.length, 2000 * 15, 'stride 15 with color');
  const back = OS.deserializeNodePoints(bytes, 2000, true);
  for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(back.pos[i] - pos[i]) < 1e-3, 'geometry preserved');
  for (let i = 0; i < col.length; i++) assert.ok(Math.abs(back.col[i] - col[i]) <= 1 / 255 + 1e-6, 'color within 1/255');
});

test('serialize colorless node uses 12-byte stride and null color', () => {
  const { pos } = makeCloud(500, false);
  const bytes = OS.serializeNodePoints(pos, null, false);
  assert.strictEqual(bytes.length, 500 * 12, 'stride 12 without color');
  const back = OS.deserializeNodePoints(bytes, 500, false);
  assert.strictEqual(back.col, null);
  for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(back.pos[i] - pos[i]) < 1e-3);
});

test('packOctree builds contiguous blob matching index offsets', () => {
  const { pos, col } = makeCloud(70000, true);
  const built = OS.buildOctree(pos, col, { nodeCapacity: 4000 });
  const { index, blob } = OS.packOctree(built);
  assert.strictEqual(index.hasColor, true);
  assert.strictEqual(index.stride, 15);
  assert.strictEqual(index.nodeCount, built.nodes.length);
  let expected = 0;
  let totalPts = 0;
  for (const d of index.nodes) {
    assert.strictEqual(d.offset, expected, 'offsets are contiguous');
    assert.strictEqual(d.byteLength, d.count * 15, 'byteLength = count*stride');
    expected += d.byteLength;
    totalPts += d.count;
  }
  assert.strictEqual(blob.length, expected, 'blob length equals sum of node byteLengths');
  assert.strictEqual(totalPts, 70000, 'index accounts for all points');
});

test('buildOctree can emit node bytes incrementally without retaining point copies', () => {
  for (const withColor of [false, true]) {
    const { pos, col } = makeCloud(50000, withColor);
    const full = OS.buildOctree(pos, col, { nodeCapacity: 3000 });
    const packed = OS.packOctree(full);
    const chunks = [];
    let nextOffset = 0;
    const streamed = OS.buildOctree(pos, col, {
      nodeCapacity: 3000,
      retainNodes: false,
      onNode(node, descriptor, nodeIndex) {
        assert.equal(descriptor.offset, nextOffset, 'streamed descriptors stay contiguous');
        assert.equal(descriptor.count, node.pos.length / 3);
        assert.equal(nodeIndex, chunks.length);
        const bytes = OS.serializeNodePoints(node.pos, node.col, withColor);
        assert.equal(bytes.length, descriptor.byteLength);
        chunks.push(Buffer.from(bytes));
        nextOffset += bytes.length;
      }
    });
    assert.equal(streamed.nodes.length, 0, 'point-bearing node buffers are not retained by the result');
    assert.ok(Array.isArray(streamed.descriptors));
    assert.equal(streamed.nodeCount, streamed.descriptors.length);
    assert.deepStrictEqual(OS.createOctreeIndex(streamed), packed.index);
    assert.deepStrictEqual(Buffer.concat(chunks), Buffer.from(packed.blob));
    assert.throws(() => OS.packOctree(streamed), /requires retained node points/);
  }
});

test('buildOctree requires a writer when point-bearing nodes are not retained', () => {
  const { pos } = makeCloud(1000, false);
  assert.throws(() => OS.buildOctree(pos, null, { retainNodes: false }), /requires an onNode writer/);
});

test('depth-limited degenerate clouds use bounded overlapping fallback leaves without losing records', () => {
  const count = 20000, capacity = 1000;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  // Identical XYZ forces every geometric split into one octant. Encode each
  // source ordinal in RGB so the test can detect loss/duplication even though
  // all coordinates are intentionally coincident.
  for (let i = 0; i < count; i++) {
    pos[i * 3] = 125000;
    pos[i * 3 + 1] = 6250000;
    pos[i * 3 + 2] = 112;
    col[i * 3] = ((i >>> 8) & 255) / 255;
    col[i * 3 + 1] = (i & 255) / 255;
  }

  const built = OS.buildOctree(pos, col, { nodeCapacity: capacity, maxDepth: 0 });
  const packed = OS.packOctree(built);
  const seen = new Uint8Array(count);
  let pointTotal = 0;
  let fallbackNodes = 0;
  for (const node of built.nodes) {
    const nodeCount = node.pos.length / 3;
    assert.ok(nodeCount <= capacity, 'no terminal node exceeds the configured read/render cap');
    pointTotal += nodeCount;
    if (node.splitMode === 'balanced-overlap-fallback') fallbackNodes++;
    for (let i = 0; i < nodeCount; i++) {
      const high = Math.round(node.col[i * 3] * 255);
      const low = Math.round(node.col[i * 3 + 1] * 255);
      const sourceOrdinal = high * 256 + low;
      assert.ok(sourceOrdinal < count);
      assert.equal(seen[sourceOrdinal], 0, 'source record is emitted only once');
      seen[sourceOrdinal] = 1;
    }
  }
  assert.equal(pointTotal, count);
  assert.ok(fallbackNodes > 0, 'the depth limit is disclosed in node metadata');
  assert.ok(packed.index.nodes.some(node => node.splitMode === 'balanced-overlap-fallback'));
  assert.equal(seen.reduce((sum, value) => sum + value, 0), count);
});

test('packed node bytes read back via index offset match original node', () => {
  const { pos, col } = makeCloud(40000, true);
  const built = OS.buildOctree(pos, col, { nodeCapacity: 3000 });
  const { index, blob } = OS.packOctree(built);
  const nodeByKey = {};
  for (const nd of built.nodes) nodeByKey[nd.key] = nd;
  for (const d of index.nodes) {
    const slice = blob.subarray(d.offset, d.offset + d.byteLength);
    const back = OS.deserializeNodePoints(slice, d.count, index.hasColor);
    const orig = nodeByKey[d.key];
    assert.strictEqual(back.pos.length, orig.pos.length, 'point count matches for ' + d.key);
    for (let i = 0; i < orig.pos.length; i++) assert.ok(Math.abs(back.pos[i] - orig.pos[i]) < 1e-3);
  }
});

test('selectNodes returns root first and respects a tiny budget', () => {
  const { pos } = makeCloud(90000, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 4000 });
  const { index } = OS.packOctree(built);
  const rootCount = index.nodes.find(n => n.key === 'r').count;
  const sel = OS.selectNodes(index, { budget: 1 });
  assert.deepStrictEqual(sel.keys, ['r'], 'tiny budget yields only root');
  assert.strictEqual(sel.points, rootCount);
});

test('selectNodes respects a mid budget and returns valid coarse-to-fine keys', () => {
  const { pos } = makeCloud(120000, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 4000 });
  const { index } = OS.packOctree(built);
  const keySet = new Set(index.nodes.map(n => n.key));
  const budget = 30000;
  const sel = OS.selectNodes(index, { budget });
  assert.ok(sel.keys.length > 1, 'should select more than the root');
  assert.strictEqual(sel.keys[0], 'r', 'root selected first');
  for (const k of sel.keys) assert.ok(keySet.has(k), 'selected key exists');
  // budget respected up to one node overshoot
  assert.ok(sel.points <= budget + index.nodes.find(n => n.key === sel.keys[sel.keys.length - 1]).count);
});

test('selectNodes visibility filter prunes hidden subtrees', () => {
  const { pos } = makeCloud(90000, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 4000 });
  const { index } = OS.packOctree(built);
  // hide everything except the root bbox: only root passes
  const rootBB = (() => { const r = index.nodes.find(n => n.key === 'r'); return [r.mn[0], r.mn[1], r.mn[2], r.mx[0], r.mx[1], r.mx[2]]; })();
  const sel = OS.selectNodes(index, {
    budget: 10000000,
    isVisible: (b6) => b6[0] === rootBB[0] && b6[3] === rootBB[3] && b6[1] === rootBB[1]
  });
  assert.deepStrictEqual(sel.keys, ['r'], 'only root visible => only root selected');
});

test('handles tiny cloud as single root leaf', () => {
  const { pos } = makeCloud(12, false);
  const built = OS.buildOctree(pos, null, { nodeCapacity: 5000 });
  assert.strictEqual(built.nodeCount, 1);
  assert.strictEqual(built.nodes[0].key, 'r');
  assert.strictEqual(built.nodes[0].pos.length / 3, 12);
});
