/*
 * octree-store.js — многоуровневый octree с дисковым хранением и потоковой подгрузкой (этап 4).
 *
 * Идея (стиль Potree/PotreeConverter): облако точек один раз разбивается в octree, где
 *   — каждый узел хранит детерминированную выборку представителей своей области без смещения по порядку сканирования — грубый LOD;
 *   — остальные точки уходят глубже в 8 дочерних октантов — детализация вблизи.
 * Объединение всех узлов = всё облако без потерь и дублей.
 *
 * Дерево пакуется в единый бинарный blob (nodes.bin) + лёгкий index.json.
 * Рендерер каждый кадр выбирает (selectNodes) только видимые узлы в пределах
 * бюджета точек и подгружает их байты с диска по смещению/длине из index.
 *
 *   buildOctree(pos:Float32Array, col:Float32Array|null, opts?) ->
 *     { nodes:[{key,level,mn,mx,pos,col,childKeys,splitMode?}], root:'r', bbox:{mn,mx}, hasColor, pointCount, nodeCount }
 *   packOctree(built) -> { index, blob:Uint8Array }
 *   serializeNodePoints(pos, col, hasColor) -> Uint8Array   // 3×float32 LE + опц. 3×uint8
 *   deserializeNodePoints(bytes, count, hasColor) -> { pos:Float32Array, col:Float32Array|null }
 *   selectNodes(index, opts) -> { keys:[...], points }       // best-first по frustum+дистанции в бюджете
 *
 * Чистый JS/TypedArray — без GPU и без fs; покрыт unit-тестами (test/octree-store.test.js).
 */
(function () {
  'use strict';

  var FLOAT = 4;

  function clamp255(x) { x = Math.round(x * 255); return x < 0 ? 0 : (x > 255 ? 255 : x); }

  // Stable per-node PRNG for the representative sample. Point files are often
  // stored in scan-line order; picking every Nth input record can leave visible
  // stripes in the root LOD. Reservoir sampling removes that order bias while
  // remaining reproducible for the same source order and node key.
  function nodeRandom(key) {
    var state = 2166136261;
    key = String(key || 'r');
    for (var i = 0; i < key.length; i++) {
      state ^= key.charCodeAt(i);
      state = Math.imul(state, 16777619);
    }
    if (!state) state = 0x9e3779b9;
    return function () {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  }

  function sampleNodePositions(pointCount, sampleCount, key) {
    var m = Number(pointCount), keep = Number(sampleCount);
    if (!Number.isSafeInteger(m) || m < 0 || !Number.isSafeInteger(keep) || keep < 0 || keep > m) {
      throw new Error('invalid octree representative sample size');
    }
    var positions = new Uint32Array(keep);
    for (var i = 0; i < keep; i++) positions[i] = i;
    var random = nodeRandom(key);
    for (var seen = keep; seen < m; seen++) {
      var replaceAt = Math.floor(random() * (seen + 1));
      if (replaceAt < keep) positions[replaceAt] = seen;
    }
    return positions;
  }

  // ---- сборка octree в памяти (итеративно, без риска переполнения стека) ----
  function buildOctree(pos, col, opts) {
    opts = opts || {};
    var nodeCapacity = opts.nodeCapacity || 60000;
    if (nodeCapacity < 1000) nodeCapacity = 1000;
    if (nodeCapacity > 500000) nodeCapacity = 500000;
    var maxDepth = Number.isSafeInteger(opts.maxDepth) && opts.maxDepth >= 0
      ? Math.min(64, opts.maxDepth)
      : 14;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var onNode = typeof opts.onNode === 'function' ? opts.onNode : null;
    var retainNodes = opts.retainNodes !== false;
    if (!retainNodes && !onNode) throw new Error('retainNodes:false requires an onNode writer');
    var hasColor = !!col;
    var n = (pos.length / 3) | 0;
    if (n > 4294967295) throw new Error('octree index exceeds Uint32 point-index capacity');
    var nodes = [], descriptors = retainNodes ? null : [];
    var nodeCount = 0, packedOffset = 0, packedStride = hasColor ? 15 : 12;
    var workDone = 0, nextProgress = 262144;
    function reportWork(amount, key) {
      workDone += amount;
      if (onProgress && workDone >= nextProgress) {
        nextProgress = workDone + 262144;
        try { onProgress({ phase: 'octree-build', workDone: workDone, nodeCount: nodeCount, currentNode: key || 'r', pendingNodes: stack.length }); } catch (_) {}
      }
    }
    function emitNode(node) {
      var count = node.pos.length / 3;
      var desc = {
        key: node.key, level: node.level,
        mn: node.mn.slice(), mx: node.mx.slice(),
        count: count, offset: packedOffset, byteLength: count * packedStride,
        childKeys: node.childKeys.slice()
      };
      if (node.splitMode) desc.splitMode = node.splitMode;
      if (onNode) onNode(node, desc, nodeCount);
      if (descriptors) descriptors.push(desc);
      if (retainNodes) nodes.push(node);
      packedOffset += desc.byteLength;
      nodeCount++;
    }

    var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (var i = 0; i < pos.length; i += 3) {
      var x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    if (!isFinite(mnx)) { mnx = mny = mnz = 0; mxx = mxy = mxz = 1; }
    // немного расширим максимум, чтобы граничные точки гарантированно попадали в bbox
    var epsx = Math.max(1e-6, (mxx - mnx) * 1e-6), epsy = Math.max(1e-6, (mxy - mny) * 1e-6), epsz = Math.max(1e-6, (mxz - mnz) * 1e-6);
    mxx += epsx; mxy += epsy; mxz += epsz;

    var allIdx = new Uint32Array(n);
    for (var a = 0; a < n; a++) allIdx[a] = a;

    var stack = [{ key: 'r', level: 0, mn: [mnx, mny, mnz], mx: [mxx, mxy, mxz], idx: allIdx }];

    function gather(list, positions) {
      var count = positions ? positions.length : list.length;
      var out = new Float32Array(count * 3);
      var oc = hasColor ? new Float32Array(count * 3) : null;
      for (var j = 0; j < count; j++) {
        var s = list[positions ? positions[j] : j] * 3, d = j * 3;
        out[d] = pos[s]; out[d + 1] = pos[s + 1]; out[d + 2] = pos[s + 2];
        if (oc) { oc[d] = col[s]; oc[d + 1] = col[s + 1]; oc[d + 2] = col[s + 2]; }
      }
      reportWork(count, 'gather');
      return { pos: out, col: oc };
    }

    while (stack.length) {
      var node = stack.pop();
      var idx = node.idx; var m = idx.length;
      var mn = node.mn, mx = node.mx;
      if (m <= nodeCapacity) {
        var g = gather(idx);
        emitNode({ key: node.key, level: node.level, mn: mn, mx: mx, pos: g.pos, col: g.col, childKeys: [] });
        continue;
      }
      var stride = Math.ceil(m / nodeCapacity); if (stride < 2) stride = 2;
      var ownCount = Math.min(nodeCapacity, Math.ceil(m / stride));
      // Algorithm R selects exactly ownCount representatives independent of
      // scan order. Store local positions, then classify the remainder
      // directly into child buckets (avoids a full-size intermediate `rest`).
      var ownPositions = sampleNodePositions(m, ownCount, node.key);
      var ownMask = new Uint8Array(m);
      for (var mark = 0; mark < ownCount; mark++) ownMask[ownPositions[mark]] = 1;
      reportWork(m, node.key);
      var go = gather(idx, ownPositions);
      var cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
      // At the depth limit, a dense or degenerate cloud may still have far
      // more than nodeCapacity points in one spatial octant. Emitting that
      // remainder as one oversized leaf breaks the renderer's node-read cap
      // and can create a multi-hundred-MiB temporary array. Split only that
      // remainder into deterministic, balanced *overlapping* children. Their
      // shared bbox is honest (the data cannot be spatially separated at this
      // depth); the descriptor marks the fallback so diagnostics can disclose
      // that LOD refinement is no longer spatial at this branch.
      var balancedFallback = node.level >= maxDepth;
      var bucketSizes = [0, 0, 0, 0, 0, 0, 0, 0];
      var restOrdinal = 0;
      for (var r = 0; r < m; r++) {
        if (ownMask[r]) continue;
        var oct;
        if (balancedFallback) {
          oct = Math.min(7, Math.floor(restOrdinal * 8 / (m - ownCount)));
          restOrdinal++;
        } else {
          var ri = idx[r] * 3;
          oct = (pos[ri] >= cx ? 1 : 0) | (pos[ri + 1] >= cy ? 2 : 0) | (pos[ri + 2] >= cz ? 4 : 0);
        }
        bucketSizes[oct]++;
      }
      reportWork(m - ownCount, node.key);
      var buckets = bucketSizes.map(function (size) { return new Uint32Array(size); });
      var bucketAt = [0, 0, 0, 0, 0, 0, 0, 0];
      restOrdinal = 0;
      for (var rr = 0; rr < m; rr++) {
        if (ownMask[rr]) continue;
        var roct;
        if (balancedFallback) {
          roct = Math.min(7, Math.floor(restOrdinal * 8 / (m - ownCount)));
          restOrdinal++;
        } else {
          var rri = idx[rr] * 3;
          roct = (pos[rri] >= cx ? 1 : 0) | (pos[rri + 1] >= cy ? 2 : 0) | (pos[rri + 2] >= cz ? 4 : 0);
        }
        buckets[roct][bucketAt[roct]++] = idx[rr];
      }
      reportWork(m - ownCount, node.key);
      var childKeys = [];
      for (var o = 0; o < 8; o++) {
        if (!buckets[o].length) continue;
        var cmn = balancedFallback
          ? mn.slice()
          : [(o & 1) ? cx : mn[0], (o & 2) ? cy : mn[1], (o & 4) ? cz : mn[2]];
        var cmx = balancedFallback
          ? mx.slice()
          : [(o & 1) ? mx[0] : cx, (o & 2) ? mx[1] : cy, (o & 4) ? mx[2] : cz];
        var ckey = node.key + o;
        childKeys.push(ckey);
        stack.push({ key: ckey, level: node.level + 1, mn: cmn, mx: cmx, idx: buckets[o] });
      }
      emitNode({
        key: node.key, level: node.level, mn: mn, mx: mx, pos: go.pos, col: go.col,
        childKeys: childKeys,
        splitMode: balancedFallback ? 'balanced-overlap-fallback' : undefined
      });
    }

    return {
      nodes: nodes, descriptors: descriptors, root: 'r', hasColor: hasColor,
      bbox: { mn: [mnx, mny, mnz], mx: [mxx, mxy, mxz] },
      pointCount: n, nodeCount: nodeCount, packedBytes: packedOffset
    };
  }

  // ---- сериализация точек узла в бинар (LE): 3×float32 [+ 3×uint8] ----
  function serializeNodePoints(pos, col, hasColor) {
    var n = (pos.length / 3) | 0;
    var stride = hasColor ? (3 * FLOAT + 3) : (3 * FLOAT);
    var buf = new ArrayBuffer(n * stride);
    var dv = new DataView(buf);
    var off = 0;
    for (var i = 0; i < n; i++) {
      dv.setFloat32(off, pos[i * 3], true);
      dv.setFloat32(off + 4, pos[i * 3 + 1], true);
      dv.setFloat32(off + 8, pos[i * 3 + 2], true);
      off += 12;
      if (hasColor) {
        dv.setUint8(off, clamp255(col[i * 3]));
        dv.setUint8(off + 1, clamp255(col[i * 3 + 1]));
        dv.setUint8(off + 2, clamp255(col[i * 3 + 2]));
        off += 3;
      }
    }
    return new Uint8Array(buf);
  }

  function deserializeNodePoints(bytes, count, hasColor) {
    var stride = hasColor ? 15 : 12;
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var n = count != null ? count : (u8.byteLength / stride) | 0;
    var pos = new Float32Array(n * 3);
    var col = hasColor ? new Float32Array(n * 3) : null;
    var off = 0;
    for (var i = 0; i < n; i++) {
      pos[i * 3] = dv.getFloat32(off, true);
      pos[i * 3 + 1] = dv.getFloat32(off + 4, true);
      pos[i * 3 + 2] = dv.getFloat32(off + 8, true);
      off += 12;
      if (hasColor) {
        col[i * 3] = dv.getUint8(off) / 255;
        col[i * 3 + 1] = dv.getUint8(off + 1) / 255;
        col[i * 3 + 2] = dv.getUint8(off + 2) / 255;
        off += 3;
      }
    }
    return { pos: pos, col: col };
  }

  // ---- упаковка дерева в единый blob + index ----
  function createOctreeIndex(built) {
    var hasColor = built.hasColor;
    var stride = hasColor ? 15 : 12;
    var descs;
    if (Array.isArray(built.descriptors)) {
      descs = built.descriptors;
    } else {
      descs = [];
      var offset = 0;
      for (var k = 0; k < built.nodes.length; k++) {
        var nd = built.nodes[k];
        var cnt = nd.pos.length / 3;
        var desc = {
          key: nd.key, level: nd.level,
          mn: [nd.mn[0], nd.mn[1], nd.mn[2]], mx: [nd.mx[0], nd.mx[1], nd.mx[2]],
          count: cnt, offset: offset, byteLength: cnt * stride, childKeys: nd.childKeys.slice()
        };
        if (nd.splitMode) desc.splitMode = nd.splitMode;
        descs.push(desc);
        offset += cnt * stride;
      }
    }
    var index = {
      version: 1, root: built.root, hasColor: hasColor, stride: stride,
      pointCount: built.pointCount, nodeCount: built.nodeCount || descs.length,
      bbox: { mn: built.bbox.mn.slice(), mx: built.bbox.mx.slice() },
      nodes: descs
    };
    return index;
  }

  function packOctree(built) {
    if (!built || !Array.isArray(built.nodes) || built.nodes.length !== (built.nodeCount || built.nodes.length)) {
      throw new Error('packOctree requires retained node points; use createOctreeIndex for streamed builds');
    }
    var index = createOctreeIndex(built);
    var total = index.nodes.length ? index.nodes[index.nodes.length - 1].offset + index.nodes[index.nodes.length - 1].byteLength : 0;
    var blob = new Uint8Array(total);
    for (var k = 0; k < built.nodes.length; k++) {
      var nd = built.nodes[k], desc = index.nodes[k];
      var bytes = serializeNodePoints(nd.pos, nd.col, built.hasColor);
      blob.set(bytes, desc.offset);
    }
    return { index: index, blob: blob };
  }

  // ---- best-first выбор видимых узлов в пределах бюджета ----
  // opts.budget    — потолок точек (default 4 000 000)
  // opts.isVisible(bbox6) -> bool  (frustum, default true)
  // opts.distance(bbox6, desc) -> number (меньше = важнее; default по level)
  function selectNodes(index, opts) {
    opts = opts || {};
    var budget = opts.budget || 4000000;
    var isVisible = opts.isVisible || function () { return true; };
    var distance = opts.distance || function (b6, d) { return d.level; };
    var byKey = {};
    for (var i = 0; i < index.nodes.length; i++) byKey[index.nodes[i].key] = index.nodes[i];
    var root = byKey[index.root];
    if (!root) return { keys: [], points: 0 };

    function bbox6(d) { return [d.mn[0], d.mn[1], d.mn[2], d.mx[0], d.mx[1], d.mx[2]]; }

    var frontier = [{ d: root, pri: distance(bbox6(root), root) }];
    var keys = [];
    var used = 0;
    while (frontier.length && used < budget) {
      // выбираем узел с минимальным pri (ближе/важнее)
      var bi = 0;
      for (var f = 1; f < frontier.length; f++) if (frontier[f].pri < frontier[bi].pri) bi = f;
      var cur = frontier.splice(bi, 1)[0];
      var d = cur.d;
      var bb = bbox6(d);
      if (!isVisible(bb)) continue;              // узел и его поддерево вне кадра — пропускаем
      keys.push(d.key);
      used += d.count;
      for (var c = 0; c < d.childKeys.length; c++) {
        var ch = byKey[d.childKeys[c]];
        if (ch) frontier.push({ d: ch, pri: distance(bbox6(ch), ch) });
      }
    }
    return { keys: keys, points: used };
  }

  var api = {
    buildOctree: buildOctree,
    sampleNodePositions: sampleNodePositions,
    createOctreeIndex: createOctreeIndex,
    packOctree: packOctree,
    serializeNodePoints: serializeNodePoints,
    deserializeNodePoints: deserializeNodePoints,
    selectNodes: selectNodes
  };
  if (typeof window !== 'undefined') window.OctreeStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
