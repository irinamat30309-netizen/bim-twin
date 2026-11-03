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

  // ---- бинарный формат записи точки в узле ----
  // v1: XYZ float32 LE + optional RGB8.
  // v2: v1 + optional normalized intensity float32 LE + classification uint8.
  function getNodePointLayout(index) {
    if (!index || typeof index !== 'object' || Array.isArray(index)) return null;
    var version = index.version == null ? 1 : Number(index.version);
    var hasColor = index.hasColor === true;
    var hasIntensity = version === 2 && index.hasIntensity === true;
    var hasClassification = version === 2 && index.hasClassification === true;
    if (version !== 1 && version !== 2) return null;
    if (version === 1 && (index.hasIntensity === true || index.hasClassification === true)) return null;
    var offset = hasColor ? 15 : 12;
    var intensityOffset = hasIntensity ? offset : null;
    if (hasIntensity) offset += 4;
    var classificationOffset = hasClassification ? offset : null;
    if (hasClassification) offset += 1;
    var stride = version === 1 ? (hasColor ? 15 : 12) : offset;
    if (index.stride != null && (!Number.isSafeInteger(index.stride) || index.stride !== stride)) return null;
    return {
      version: version,
      stride: stride,
      hasColor: hasColor,
      hasIntensity: hasIntensity,
      hasClassification: hasClassification,
      colorOffset: hasColor ? 12 : null,
      intensityOffset: intensityOffset,
      classificationOffset: classificationOffset
    };
  }

  // Validate the persistent index before the main process trusts any
  // renderer-supplied node key or file range. This is intentionally linear in
  // descriptor count and runs once when index.json enters the cache.
  function validateOctreeIndex(index, nodeFileBytes) {
    var layout = getNodePointLayout(index);
    if (!layout || !Number.isSafeInteger(index.stride) ||
        !Number.isSafeInteger(index.pointCount) || index.pointCount < 1 ||
        !Number.isSafeInteger(index.nodeCount) || index.nodeCount < 1 ||
        !Array.isArray(index.nodes) || index.nodes.length !== index.nodeCount ||
        index.root !== 'r' || !index.bbox || !Array.isArray(index.bbox.mn) ||
        !Array.isArray(index.bbox.mx) || index.bbox.mn.length !== 3 ||
        index.bbox.mx.length !== 3) return false;

    var rootMin = index.bbox.mn, rootMax = index.bbox.mx;
    for (var axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(rootMin[axis]) || !Number.isFinite(rootMax[axis]) ||
          rootMin[axis] > rootMax[axis]) return false;
    }

    var byKey = new Map();
    var parentCount = new Map();
    var expectedOffset = 0, pointTotal = 0;
    for (var i = 0; i < index.nodes.length; i++) {
      var node = index.nodes[i];
      if (!node || typeof node.key !== 'string' || !/^r[0-7]*$/.test(node.key) ||
          node.level !== node.key.length - 1 ||
          !Number.isSafeInteger(node.count) || node.count < 1 ||
          !Number.isSafeInteger(node.offset) || node.offset !== expectedOffset ||
          !Number.isSafeInteger(node.byteLength) ||
          node.byteLength !== node.count * layout.stride ||
          !Number.isSafeInteger(expectedOffset + node.byteLength) ||
          !Array.isArray(node.mn) || !Array.isArray(node.mx) ||
          node.mn.length !== 3 || node.mx.length !== 3 ||
          !Array.isArray(node.childKeys)) return false;
      if (byKey.has(node.key)) return false;
      if (i === 0 && (node.key !== 'r' || node.offset !== 0)) return false;
      for (var a = 0; a < 3; a++) {
        if (!Number.isFinite(node.mn[a]) || !Number.isFinite(node.mx[a]) ||
            node.mn[a] > node.mx[a] ||
            node.mn[a] < rootMin[a] - 1e-5 || node.mx[a] > rootMax[a] + 1e-5) return false;
      }
      byKey.set(node.key, node);
      parentCount.set(node.key, 0);
      expectedOffset += node.byteLength;
      pointTotal += node.count;
      if (!Number.isSafeInteger(pointTotal)) return false;
    }
    if (pointTotal !== index.pointCount ||
        (nodeFileBytes != null &&
          (!Number.isSafeInteger(nodeFileBytes) || nodeFileBytes !== expectedOffset))) return false;

    for (var j = 0; j < index.nodes.length; j++) {
      var parent = index.nodes[j];
      var seenChildren = new Set();
      for (var c = 0; c < parent.childKeys.length; c++) {
        var childKey = parent.childKeys[c];
        if (typeof childKey !== 'string' || seenChildren.has(childKey) ||
            childKey.length !== parent.key.length + 1 ||
            childKey.slice(0, parent.key.length) !== parent.key ||
            !/^[0-7]$/.test(childKey.slice(-1)) || !byKey.has(childKey)) return false;
        seenChildren.add(childKey);
        parentCount.set(childKey, parentCount.get(childKey) + 1);
      }
    }
    for (var k = 0; k < index.nodes.length; k++) {
      var key = index.nodes[k].key;
      if (parentCount.get(key) !== (key === 'r' ? 0 : 1)) return false;
    }
    return true;
  }

  // ---- сериализация узла: XYZ float32 [+ RGB8] [+ intensity float32] [+ class uint8] ----
  function serializeNodePoints(pos, col, hasColor, attributes) {
    var n = (pos.length / 3) | 0;
    attributes = attributes || {};
    var intensity = attributes.intensity || null;
    var classification = attributes.classification || null;
    var hasIntensity = !!intensity;
    var hasClassification = !!classification;
    if ((hasColor && (!col || col.length < n * 3)) ||
        (hasIntensity && intensity.length < n) ||
        (hasClassification && classification.length < n)) {
      throw new RangeError('octree node attribute array is shorter than the point count');
    }
    var layout = getNodePointLayout({
      version: hasIntensity || hasClassification ? 2 : 1,
      hasColor: !!hasColor,
      hasIntensity: hasIntensity,
      hasClassification: hasClassification
    });
    var stride = layout.stride;
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
      if (hasIntensity) {
        var iv = Number(intensity[i]);
        dv.setFloat32(off, Number.isFinite(iv) ? Math.max(0, Math.min(1, iv)) : 0, true);
        off += 4;
      }
      if (hasClassification) {
        var cv = Number(classification[i]);
        dv.setUint8(off, Number.isFinite(cv) ? Math.max(0, Math.min(255, Math.round(cv))) : 0);
        off += 1;
      }
    }
    return new Uint8Array(buf);
  }

  function deserializeNodePoints(bytes, count, hasColor, format) {
    var layout;
    if (format && typeof format === 'object') {
      layout = getNodePointLayout(format);
      if (!layout) throw new Error('invalid octree node point layout');
    } else {
      layout = getNodePointLayout({
        version: 1, hasColor: !!hasColor, stride: hasColor ? 15 : 12
      });
    }
    var stride = layout.stride;
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!Number.isSafeInteger(count) || count < 0 || u8.byteLength !== count * stride) {
      throw new RangeError('octree node byte length does not match its point count and layout');
    }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var n = count;
    var pos = new Float32Array(n * 3);
    var col = layout.hasColor ? new Float32Array(n * 3) : null;
    var intensity = layout.hasIntensity ? new Float32Array(n) : null;
    var classification = layout.hasClassification ? new Uint8Array(n) : null;
    var off = 0;
    for (var i = 0; i < n; i++) {
      pos[i * 3] = dv.getFloat32(off, true);
      pos[i * 3 + 1] = dv.getFloat32(off + 4, true);
      pos[i * 3 + 2] = dv.getFloat32(off + 8, true);
      off += 12;
      if (layout.hasColor) {
        col[i * 3] = dv.getUint8(off) / 255;
        col[i * 3 + 1] = dv.getUint8(off + 1) / 255;
        col[i * 3 + 2] = dv.getUint8(off + 2) / 255;
        off += 3;
      }
      if (layout.hasIntensity) {
        intensity[i] = dv.getFloat32(off, true);
        off += 4;
      }
      if (layout.hasClassification) classification[i] = dv.getUint8(off++);
    }
    return { pos: pos, col: col, intensity: intensity, classification: classification };
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

  // ---- ревизия 9: LOD по экранной плотности (как в Potree), без разбора index.json в каждом кадре ----
  // Узел хранит выборку точек своей ячейки; дети — остальные точки. Узел «достаточно плотен», если расстояние между его точками на экране
  // не больше tPx пикселей: тогда глубже не идём. Рисуется ровно то, что экран способен разрешить, а все точки остаются в индексе и появляются
  // при приближении. Выбор best-first по «разреженности» узла (самые грубые уточняются первыми) в пределах бюджета точек и числа узлов.
  function prepareLod(index) {
    var nodes = (index && index.nodes) || [], n = nodes.length, i, k;
    var keyToId = new Map(), keys = new Array(n);
    for (i = 0; i < n; i++) { keys[i] = nodes[i].key; keyToId.set(nodes[i].key, i); }
    var mn = new Float64Array(n * 3), mx = new Float64Array(n * 3), cnt = new Float64Array(n);
    var level = new Uint8Array(n), ext = new Float64Array(n), cs = new Int32Array(n + 1), kids = [];
    for (i = 0; i < n; i++) {
      var nd = nodes[i], ex = 0;
      for (k = 0; k < 3; k++) {
        mn[i * 3 + k] = Number(nd.mn[k]); mx[i * 3 + k] = Number(nd.mx[k]);
        ex = Math.max(ex, mx[i * 3 + k] - mn[i * 3 + k]);
      }
      ext[i] = ex > 1e-9 ? ex : 1e-9;
      cnt[i] = Number(nd.count) || 0;
      level[i] = Math.min(255, nd.level | 0);
      cs[i] = kids.length;
      var ck = nd.childKeys || [];
      for (k = 0; k < ck.length; k++) { var cid = keyToId.get(ck[k]); if (cid !== undefined) kids.push(cid); }
    }
    cs[n] = kids.length;
    var root = index && keyToId.has(index.root) ? keyToId.get(index.root) : 0;
    return { n: n, keys: keys, keyToId: keyToId, mn: mn, mx: mx, cnt: cnt, level: level, ext: ext, cs: cs, kids: Int32Array.from(kids), root: root };
  }

  // view: { vp:[16] (столбцами, как в WebGL) | null, eye:[x,y,z], f: фокус в пикселях (высота/2/tan(fov/2)), ortho:bool, ppu: пикселей на метр (ортогональная),
  //         tPx: допустимое расстояние между точками на экране, budget: потолок точек, maxNodes }
  // out: { ids:[], sp:[], points, n } — индексы узлов и «расстояние между точками узла» в пикселях (для размера точки и очереди загрузки)
  function selectLod(lod, view, out) {
    out = out || {};
    var ids = out.ids || (out.ids = []), sp = out.sp || (out.sp = []);
    ids.length = 0; sp.length = 0; out.points = 0; out.n = 0;
    if (!lod || !lod.n) return out;
    var mn = lod.mn, mx = lod.mx, cnt = lod.cnt, ext = lod.ext, cs = lod.cs, kids = lod.kids;
    var eye = view.eye || [0, 0, 0], ex = eye[0], ey = eye[1], ez = eye[2];
    var ortho = !!view.ortho, f = view.f > 0 ? view.f : 800, ppu = view.ppu > 0 ? view.ppu : 1;
    var t = view.tPx > 0 ? view.tPx : 1, budget = view.budget > 0 ? view.budget : Infinity;
    var maxNodes = view.maxNodes > 0 ? view.maxNodes : 6000;
    var pl = null, M = view.vp;
    if (M && M.length >= 16) {
      pl = new Float64Array(24);
      var rows = [[3, 0, 1], [3, 0, -1], [3, 1, 1], [3, 1, -1], [3, 2, 1], [3, 2, -1]];
      for (var q = 0; q < 6; q++) {
        var a = rows[q][0], b = rows[q][1], sg = rows[q][2];
        pl[q * 4] = M[a] + sg * M[b]; pl[q * 4 + 1] = M[4 + a] + sg * M[4 + b];
        pl[q * 4 + 2] = M[8 + a] + sg * M[8 + b]; pl[q * 4 + 3] = M[12 + a] + sg * M[12 + b];
      }
    }
    function outside(i) {
      if (!pl) return false;
      var o = i * 3;
      for (var p = 0; p < 24; p += 4) {
        var A = pl[p], B = pl[p + 1], C = pl[p + 2];
        if (A * (A >= 0 ? mx[o] : mn[o]) + B * (B >= 0 ? mx[o + 1] : mn[o + 1]) + C * (C >= 0 ? mx[o + 2] : mn[o + 2]) + pl[p + 3] < 0) return true;
      }
      return false;
    }
    function spacing(i) {
      var px;
      if (ortho) px = ext[i] * ppu;
      else {
        var o = i * 3;
        var dx = Math.max(mn[o] - ex, 0, ex - mx[o]), dy = Math.max(mn[o + 1] - ey, 0, ey - mx[o + 1]), dz = Math.max(mn[o + 2] - ez, 0, ez - mx[o + 2]);
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz), dmin = ext[i] * 0.02;
        px = ext[i] * f / (d > dmin ? d : dmin);
      }
      return px / Math.sqrt(Math.max(1, cnt[i]) * 1.15);
    }
    var hp = [], hi = [];
    function push(pri, id) {
      var k = hp.length; hp.push(pri); hi.push(id);
      while (k > 0) { var par = (k - 1) >> 1; if (hp[par] >= pri) break; hp[k] = hp[par]; hi[k] = hi[par]; k = par; }
      hp[k] = pri; hi[k] = id;
    }
    function pop() {
      var top = hi[0], lp = hp.pop(), li = hi.pop(), n = hp.length;
      if (n) {
        var k = 0;
        for (;;) {
          var c = 2 * k + 1; if (c >= n) break;
          if (c + 1 < n && hp[c + 1] > hp[c]) c++;
          if (hp[c] <= lp) break;
          hp[k] = hp[c]; hi[k] = hi[c]; k = c;
        }
        hp[k] = lp; hi[k] = li;
      }
      return top;
    }
    var root = lod.root, pts = 0;
    if (!outside(root)) push(Infinity, root);
    while (hp.length && pts < budget && ids.length < maxNodes) {
      var id = pop(), s = spacing(id);
      ids.push(id); sp.push(s); pts += cnt[id];
      if (s > t) for (var c = cs[id]; c < cs[id + 1]; c++) { var ch = kids[c]; if (!outside(ch)) push(s, ch); }
    }
    out.points = pts; out.n = ids.length;
    return out;
  }

  // Быстрый разбор узла для видеокарты: цвет RGBA8 (4 байта вместо 12) [+ интенсивность float32] [+ класс uint8].
  // Позиции: Float32 (12 байт) или, при quantize, Uint16 внутри точного ящика узла (6 байт на точку): pos16 + q = { off, scale }, позиция = pos16 * scale + off.
  // Ошибка квантования ≤ ящик узла / 131070 (у узла 8 м — 0,06 мм; у корня сцены 150 м — 1,1 мм), то есть много меньше шага точек.
  function decodeNodeGpu(bytes, count, format, quantize) {
    var layout = getNodePointLayout(format);
    if (!layout) throw new Error('invalid octree node point layout');
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), stride = layout.stride;
    if (!Number.isSafeInteger(count) || count < 0 || u8.byteLength !== count * stride) {
      throw new RangeError('octree node byte length does not match its point count and layout');
    }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var pos = quantize ? null : new Float32Array(count * 3);
    var pos16 = quantize ? new Uint16Array(count * 3) : null, q = null;
    var rgba = layout.hasColor ? new Uint8Array(count * 4) : null;
    var inten = layout.hasIntensity ? new Float32Array(count) : null;
    var cls = layout.hasClassification ? new Uint8Array(count) : null;
    var io = layout.intensityOffset, co = layout.classificationOffset;
    var i, off, j, v;
    var ox = 0, oy = 0, oz = 0, ix = 0, iy = 0, iz = 0;
    if (quantize) {
      var nx = Infinity, ny = Infinity, nz = Infinity, xx = -Infinity, xy = -Infinity, xz = -Infinity;
      for (i = 0, off = 0; i < count; i++, off += stride) {
        v = dv.getFloat32(off, true); if (v < nx) nx = v; if (v > xx) xx = v;
        v = dv.getFloat32(off + 4, true); if (v < ny) ny = v; if (v > xy) xy = v;
        v = dv.getFloat32(off + 8, true); if (v < nz) nz = v; if (v > xz) xz = v;
      }
      if (!(nx <= xx)) { nx = xx = 0; } if (!(ny <= xy)) { ny = xy = 0; } if (!(nz <= xz)) { nz = xz = 0; }
      ox = nx; oy = ny; oz = nz;
      var ex = xx - nx, ey = xy - ny, ez = xz - nz;
      ix = ex > 0 ? 65535 / ex : 0; iy = ey > 0 ? 65535 / ey : 0; iz = ez > 0 ? 65535 / ez : 0;
      q = { off: [ox, oy, oz], scale: [ex > 0 ? ex / 65535 : 0, ey > 0 ? ey / 65535 : 0, ez > 0 ? ez / 65535 : 0] };
    }
    for (i = 0, off = 0, j = 0; i < count; i++, off += stride, j += 3) {
      if (quantize) {
        v = Math.round((dv.getFloat32(off, true) - ox) * ix); pos16[j] = v > 0 ? (v < 65535 ? v : 65535) : 0;
        v = Math.round((dv.getFloat32(off + 4, true) - oy) * iy); pos16[j + 1] = v > 0 ? (v < 65535 ? v : 65535) : 0;
        v = Math.round((dv.getFloat32(off + 8, true) - oz) * iz); pos16[j + 2] = v > 0 ? (v < 65535 ? v : 65535) : 0;
      } else {
        pos[j] = dv.getFloat32(off, true); pos[j + 1] = dv.getFloat32(off + 4, true); pos[j + 2] = dv.getFloat32(off + 8, true);
      }
      if (rgba) { var k = i * 4; rgba[k] = u8[off + 12]; rgba[k + 1] = u8[off + 13]; rgba[k + 2] = u8[off + 14]; rgba[k + 3] = 255; }
      if (inten) inten[i] = dv.getFloat32(off + io, true);
      if (cls) cls[i] = u8[off + co];
    }
    return { pos: pos, pos16: pos16, q: q, col: null, rgba: rgba, intensity: inten, classification: cls };
  }

  var api = {
    buildOctree: buildOctree,
    sampleNodePositions: sampleNodePositions,
    createOctreeIndex: createOctreeIndex,
    packOctree: packOctree,
    serializeNodePoints: serializeNodePoints,
    deserializeNodePoints: deserializeNodePoints,
    getNodePointLayout: getNodePointLayout,
    validateOctreeIndex: validateOctreeIndex,
    selectNodes: selectNodes,
    prepareLod: prepareLod,
    selectLod: selectLod,
    decodeNodeGpu: decodeNodeGpu
  };
  if (typeof window !== 'undefined') window.OctreeStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
