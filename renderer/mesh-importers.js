/*
 * mesh-importers.js — bounded, dependency-free OBJ/STL readers for MeshViewer.
 * Geometry is preserved in the source coordinate frame for exact sectioning;
 * the render copy is localized when large world coordinates would lose Float32
 * precision. OBJ materials/MTL files and source units/CRS are not guessed.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeshImporters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_TRIANGLES = 2000000;
  var MAX_OBJ_VERTICES = 5000000;
  var MAX_OBJ_ATTRIBUTES = 5000000;
  var MAX_FACE_CORNERS = 2048;
  var TEXT_CHUNK_BYTES = 1024 * 1024;
  var MAX_LINE_CHARS = 4 * 1024 * 1024;

  function asBytes(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('Ожидался ArrayBuffer с геометрией');
  }

  function forEachTextLine(input, visit) {
    var bytes = asBytes(input);
    if (typeof TextDecoder === 'undefined') throw new Error('Кодировщик UTF-8 недоступен');
    var decoder = new TextDecoder('utf-8');
    var carry = '';
    var lineNo = 0;
    for (var off = 0; off < bytes.length; off += TEXT_CHUNK_BYTES) {
      var end = Math.min(bytes.length, off + TEXT_CHUNK_BYTES);
      var text = decoder.decode(bytes.subarray(off, end), { stream: end < bytes.length });
      var block = carry + text;
      var from = 0, nl;
      while ((nl = block.indexOf('\n', from)) >= 0) {
        var line = block.slice(from, nl);
        if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
        if (line.length > MAX_LINE_CHARS) throw new Error('Строка текстовой модели превышает безопасный лимит 4 МиБ');
        visit(line, ++lineNo);
        from = nl + 1;
      }
      carry = block.slice(from);
      if (carry.length > MAX_LINE_CHARS) throw new Error('Строка текстовой модели превышает безопасный лимит 4 МиБ');
    }
    if (carry) visit(carry, ++lineNo);
  }

  function finiteNumber(raw, context) {
    var n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(context + ': координата не является конечным числом');
    return n;
  }

  function cross2(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  }

  function pointInsideTriangleStrict(p, a, b, c, orientation, eps) {
    var c1 = cross2(a, b, p) * orientation;
    var c2 = cross2(b, c, p) * orientation;
    var c3 = cross2(c, a, p) * orientation;
    return c1 >= -eps && c2 >= -eps && c3 >= -eps;
  }

  function onSegment(a, b, p, eps) {
    return p[0] >= Math.min(a[0], b[0]) - eps && p[0] <= Math.max(a[0], b[0]) + eps &&
      p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps;
  }

  // Ear clipping after projection onto the dominant plane. A malformed or
  // self-intersecting polygon is rejected (and reported) instead of silently
  // producing a plausible-looking but incorrect fan triangulation.
  function triangulatePolygon(corners, vertices) {
    var ring = [], removedDuplicates = 0, removedCollinear = 0;
    for (var i = 0; i < corners.length; i++) {
      if (!ring.length || corners[ring[ring.length - 1]].v !== corners[i].v) ring.push(i);
      else removedDuplicates++;
    }
    if (ring.length > 1 && corners[ring[0]].v === corners[ring[ring.length - 1]].v) { ring.pop(); removedDuplicates++; }
    if (ring.length < 3) return null;
    if (ring.length === 3) return { triangles: [[ring[0], ring[1], ring[2]],], removedDuplicates: removedDuplicates, removedCollinear: removedCollinear };

    var nx = 0, ny = 0, nz = 0;
    for (var j = 0; j < ring.length; j++) {
      var p = corners[ring[j]].v * 3;
      var q = corners[ring[(j + 1) % ring.length]].v * 3;
      var x = vertices[p], y = vertices[p + 1], z = vertices[p + 2];
      var xx = vertices[q], yy = vertices[q + 1], zz = vertices[q + 2];
      nx += (y - yy) * (z + zz);
      ny += (z - zz) * (x + xx);
      nz += (x - xx) * (y + yy);
    }
    var drop = Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz) ? 0 :
      (Math.abs(ny) >= Math.abs(nz) ? 1 : 2);
    var projected = new Array(corners.length);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var k = 0; k < ring.length; k++) {
      var vi = corners[ring[k]].v * 3;
      var point = drop === 0 ? [vertices[vi + 1], vertices[vi + 2]] :
        (drop === 1 ? [vertices[vi], vertices[vi + 2]] : [vertices[vi], vertices[vi + 1]]);
      projected[ring[k]] = point;
      minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
    }
    var scale = Math.max(maxX - minX, maxY - minY, 1e-12);
    var eps = scale * scale * 1e-12;
    var area2 = 0;
    for (var a = 0; a < ring.length; a++) {
      var pa = projected[ring[a]], pb = projected[ring[(a + 1) % ring.length]];
      area2 += pa[0] * pb[1] - pb[0] * pa[1];
    }
    if (!Number.isFinite(area2) || Math.abs(area2) <= eps) return null;
    var orientation = area2 > 0 ? 1 : -1;
    var triangles = [];
    var guard = ring.length * ring.length;
    while (ring.length > 3 && guard-- > 0) {
      var clipped = false;
      for (var cur = 0; cur < ring.length; cur++) {
        var prev = (cur + ring.length - 1) % ring.length;
        var next = (cur + 1) % ring.length;
        var ia = ring[prev], ib = ring[cur], ic = ring[next];
        var aa = projected[ia], bb = projected[ib], cc = projected[ic];
        var turn = cross2(aa, bb, cc) * orientation;
        if (Math.abs(turn) <= eps && onSegment(aa, cc, bb, scale * 1e-12)) {
          ring.splice(cur, 1);
          removedCollinear++;
          clipped = true;
          break;
        }
        if (turn <= eps) continue;
        var blocked = false;
        for (var other = 0; other < ring.length; other++) {
          if (other === prev || other === cur || other === next) continue;
          if (pointInsideTriangleStrict(projected[ring[other]], aa, bb, cc, orientation, eps)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        triangles.push([ia, ib, ic]);
        ring.splice(cur, 1);
        clipped = true;
        break;
      }
      if (!clipped) return null;
    }
    if (ring.length !== 3) return null;
    if (Math.abs(cross2(projected[ring[0]], projected[ring[1]], projected[ring[2]])) > eps) {
      triangles.push([ring[0], ring[1], ring[2]]);
    }
    return triangles.length ? { triangles: triangles, removedDuplicates: removedDuplicates, removedCollinear: removedCollinear } : null;
  }

  function identity4() {
    var m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  function makeScene(positionsSource, normals, uvs, colors, indices, format, bounds, details) {
    var center = [
      bounds.lo[0] + (bounds.hi[0] - bounds.lo[0]) * 0.5,
      bounds.lo[1] + (bounds.hi[1] - bounds.lo[1]) * 0.5,
      bounds.lo[2] + (bounds.hi[2] - bounds.lo[2]) * 0.5
    ];
    var maxAbs = Math.max(Math.abs(bounds.lo[0]), Math.abs(bounds.lo[1]), Math.abs(bounds.lo[2]),
      Math.abs(bounds.hi[0]), Math.abs(bounds.hi[1]), Math.abs(bounds.hi[2]));
    var localized = maxAbs > 10000;
    var vertexCount = positionsSource.length / 3;
    var positions = new Float32Array(positionsSource.length);
    for (var i = 0; i < vertexCount; i++) {
      var s = i * 3;
      positions[s] = positionsSource[s] - (localized ? center[0] : 0);
      positions[s + 1] = positionsSource[s + 1] - (localized ? center[1] : 0);
      positions[s + 2] = positionsSource[s + 2] - (localized ? center[2] : 0);
    }
    var viewLo = localized ? bounds.lo.map(function (v, i) { return v - center[i]; }) : bounds.lo.slice();
    var viewHi = localized ? bounds.hi.map(function (v, i) { return v - center[i]; }) : bounds.hi.slice();
    var viewCenter = localized ? [0, 0, 0] : center.slice();
    var radius = Math.hypot(bounds.hi[0] - bounds.lo[0], bounds.hi[1] - bounds.lo[1], bounds.hi[2] - bounds.lo[2]) * 0.5 || 1;
    var I = identity4();
    var primitive = {
      positions: positions,
      sectionPositions: positionsSource,
      normals: normals,
      uvs: uvs,
      colors: colors,
      indices: indices,
      vertexCount: vertexCount,
      model: I,
      normalMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      material: { baseColorFactor: [0.84, 0.86, 0.89, 1], textureImage: -1, doubleSided: true }
    };
    var sourceBounds = { lo: bounds.lo.slice(), hi: bounds.hi.slice(), center: center.slice(), radius: radius };
    return {
      primitives: [primitive],
      images: [],
      bounds: { lo: viewLo, hi: viewHi, center: viewCenter, radius: radius },
      sectionBounds: sourceBounds,
      sectionViewTransform: { axis: 'y', center: localized ? center.slice() : [0, 0, 0] },
      sourceFormat: format,
      sourceUpAxis: 'y',
      sourceUpAxisKnown: false,
      sourceCrsWkt: null,
      coordinateFrame: null,
      unitsKnown: false,
      warnings: (details && details.warnings) || [],
      triangles: indices.length / 3,
      metadata: details || {}
    };
  }

  function resolveIndex(raw, count, lineNo, label) {
    if (!raw) return -1;
    var n = Number(raw);
    if (!Number.isSafeInteger(n) || n === 0) throw new Error('OBJ, строка ' + lineNo + ': некорректный индекс ' + label);
    var idx = n > 0 ? n - 1 : count + n;
    if (idx < 0 || idx >= count) throw new Error('OBJ, строка ' + lineNo + ': индекс ' + label + ' вне диапазона');
    return idx;
  }

  function parseOBJ(input) {
    var vertices = [], texcoords = [], sourceNormals = [], sourceColors = [];
    var outPositions = [], outNormals = [], outUvs = [], outVertexRefs = [];
    var indices = [];
    var vertexMap = new Map();
    var anyColor = false, allNormals = true, allUvs = true;
    var mtllibs = new Set(), materialNames = new Set(), objectNames = new Set(), groupNames = new Set();
    var groupStatements = 0, objectStatements = 0, unsupportedLineRecords = 0;
    var faceCount = 0, rejectedFaces = 0, triangleCount = 0, removedCollinearCorners = 0, removedDuplicateCorners = 0;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];

    function renderIndex(corner) {
      var key = corner.v + '/' + corner.t + '/' + corner.n;
      var found = vertexMap.get(key);
      if (found !== undefined) return found;
      var id = outPositions.length / 3;
      if (id >= MAX_OBJ_VERTICES) throw new Error('OBJ превышает лимит ' + MAX_OBJ_VERTICES.toLocaleString('ru-RU') + ' вершин; уменьшите модель или экспортируйте её частями');
      vertexMap.set(key, id);
      var p = corner.v * 3;
      var x = vertices[p], y = vertices[p + 1], z = vertices[p + 2];
      outPositions.push(x, y, z);
      lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
      hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
      if (corner.n >= 0) outNormals.push(sourceNormals[corner.n * 3], sourceNormals[corner.n * 3 + 1], sourceNormals[corner.n * 3 + 2]);
      else { allNormals = false; outNormals.push(0, 0, 0); }
      if (corner.t >= 0) outUvs.push(texcoords[corner.t * 2], texcoords[corner.t * 2 + 1]);
      else { allUvs = false; outUvs.push(0, 0); }
      outVertexRefs.push(corner.v);
      return id;
    }

    forEachTextLine(input, function (rawLine, lineNo) {
      var line = rawLine.trim();
      if (!line || line.charAt(0) === '#') return;
      var comment = line.indexOf('#');
      if (comment >= 0) line = line.slice(0, comment).trim();
      if (!line) return;
      var parts = line.split(/\s+/), kind = parts[0];
      if (kind === 'v') {
        if (vertices.length / 3 >= MAX_OBJ_VERTICES) throw new Error('OBJ превышает лимит ' + MAX_OBJ_VERTICES.toLocaleString('ru-RU') + ' исходных вершин');
        var x = finiteNumber(parts[1], 'OBJ, строка ' + lineNo), y = finiteNumber(parts[2], 'OBJ, строка ' + lineNo), z = finiteNumber(parts[3], 'OBJ, строка ' + lineNo);
        if (parts.length === 5 || parts.length === 6 || parts.length >= 8) {
          var w = finiteNumber(parts[4], 'OBJ, строка ' + lineNo);
          if (w === 0) throw new Error('OBJ, строка ' + lineNo + ': однородная координата w равна нулю');
          x /= w; y /= w; z /= w;
        }
        vertices.push(x, y, z);
        if (parts.length >= 7) {
          var ci = parts.length >= 8 ? 5 : 4;
          var cr = finiteNumber(parts[ci], 'OBJ, строка ' + lineNo);
          var cg = finiteNumber(parts[ci + 1], 'OBJ, строка ' + lineNo);
          var cb = finiteNumber(parts[ci + 2], 'OBJ, строка ' + lineNo);
          sourceColors.push(cr, cg, cb);
          anyColor = true;
        } else sourceColors.push(null, null, null);
      } else if (kind === 'vt') {
        if (texcoords.length / 2 >= MAX_OBJ_ATTRIBUTES) throw new Error('OBJ превышает безопасный лимит UV-координат');
        texcoords.push(finiteNumber(parts[1], 'OBJ, строка ' + lineNo), finiteNumber(parts[2] || '0', 'OBJ, строка ' + lineNo));
      } else if (kind === 'vn') {
        if (sourceNormals.length / 3 >= MAX_OBJ_ATTRIBUTES) throw new Error('OBJ превышает безопасный лимит нормалей');
        sourceNormals.push(finiteNumber(parts[1], 'OBJ, строка ' + lineNo), finiteNumber(parts[2], 'OBJ, строка ' + lineNo), finiteNumber(parts[3], 'OBJ, строка ' + lineNo));
      } else if (kind === 'f') {
        faceCount++;
        var values = parts.slice(1);
        if (values.length > MAX_FACE_CORNERS) throw new Error('OBJ, строка ' + lineNo + ': грань превышает лимит ' + MAX_FACE_CORNERS + ' вершин');
        if (values.length < 3) { rejectedFaces++; return; }
        var corners = new Array(values.length);
        for (var c = 0; c < values.length; c++) {
          var fields = values[c].split('/');
          corners[c] = {
            v: resolveIndex(fields[0], vertices.length / 3, lineNo, 'вершины'),
            t: fields.length > 1 && fields[1] ? resolveIndex(fields[1], texcoords.length / 2, lineNo, 'UV') : -1,
            n: fields.length > 2 && fields[2] ? resolveIndex(fields[2], sourceNormals.length / 3, lineNo, 'нормали') : -1
          };
        }
        var tessellation = triangulatePolygon(corners, vertices);
        if (!tessellation) { rejectedFaces++; return; }
        removedCollinearCorners += tessellation.removedCollinear;
        removedDuplicateCorners += tessellation.removedDuplicates;
        var tris = tessellation.triangles;
        if (triangleCount + tris.length > MAX_TRIANGLES) throw new Error('OBJ превышает лимит ' + MAX_TRIANGLES.toLocaleString('ru-RU') + ' треугольников; экспортируйте модель частями');
        for (var ti = 0; ti < tris.length; ti++) {
          var tri = tris[ti];
          indices.push(renderIndex(corners[tri[0]]), renderIndex(corners[tri[1]]), renderIndex(corners[tri[2]]));
          triangleCount++;
        }
      } else if (kind === 'mtllib') {
        for (var ml = 1; ml < parts.length; ml++) mtllibs.add(parts[ml]);
      } else if (kind === 'usemtl') {
        if (parts[1]) materialNames.add(parts.slice(1).join(' '));
      } else if (kind === 'g') {
        groupStatements++;
        if (parts[1]) for (var gi = 1; gi < parts.length; gi++) groupNames.add(parts[gi]);
      } else if (kind === 'o') {
        objectStatements++;
        if (parts.length > 1) objectNames.add(parts.slice(1).join(' '));
      } else if (kind === 'l' || kind === 'p' || kind === 'curv' || kind === 'surf') {
        unsupportedLineRecords++;
      }
    });

    if (!vertices.length) throw new Error('OBJ: геометрия не содержит вершин v');
    if (!indices.length) throw new Error('OBJ: не найдено ни одной корректной треугольной грани f');
    var colorDiv = 1;
    if (anyColor) {
      for (var sc = 0; sc < sourceColors.length; sc++) {
        if (sourceColors[sc] != null && sourceColors[sc] > 1) { colorDiv = 255; break; }
      }
    }
    var colors = anyColor ? new Float32Array(outVertexRefs.length * 3) : null;
    if (colors) {
      for (var oi = 0; oi < outVertexRefs.length; oi++) {
        var src = outVertexRefs[oi] * 3, dst = oi * 3;
        if (sourceColors[src] == null) colors[dst] = colors[dst + 1] = colors[dst + 2] = 1;
        else {
          colors[dst] = Math.max(0, Math.min(1, sourceColors[src] / colorDiv));
          colors[dst + 1] = Math.max(0, Math.min(1, sourceColors[src + 1] / colorDiv));
          colors[dst + 2] = Math.max(0, Math.min(1, sourceColors[src + 2] / colorDiv));
        }
      }
    }
    var warnings = [];
    if (mtllibs.size || materialNames.size) warnings.push('MTL, материалы и текстуры этого OBJ не загружены; для сохранения вида экспортируйте модель в GLB/glTF.');
    if (groupStatements || objectStatements) warnings.push('Иерархия OBJ-групп и объектов сведена к одному мешу; исходная структура не сохранена.');
    if (unsupportedLineRecords) warnings.push('Пропущены OBJ-примитивы, не являющиеся поверхностями: ' + unsupportedLineRecords.toLocaleString('ru-RU') + '.');
    if (rejectedFaces) warnings.push('Не удалось корректно триангулировать граней: ' + rejectedFaces.toLocaleString('ru-RU') + '; они не включены в модель.');
    if (removedCollinearCorners || removedDuplicateCorners) warnings.push('Перед триангуляцией исключены нулевые/повторные углы: ' + (removedCollinearCorners + removedDuplicateCorners).toLocaleString('ru-RU') + '.');
    warnings.push('В OBJ не заданы CRS, единицы и ось вверх; координаты оставлены без пересчёта.');
    var scene = makeScene(
      new Float64Array(outPositions),
      allNormals ? new Float32Array(outNormals) : null,
      allUvs ? new Float32Array(outUvs) : null,
      colors,
      new Uint32Array(indices),
      'OBJ',
      { lo: lo, hi: hi },
      { faces: faceCount, triangles: triangleCount, sourceVertices: vertices.length / 3, renderVertices: outPositions.length / 3,
        materialLibraries: Array.from(mtllibs), materialNames: Array.from(materialNames), rejectedFaces: rejectedFaces,
        groupStatements: groupStatements, objectStatements: objectStatements, uniqueGroups: groupNames.size, uniqueObjects: objectNames.size,
        removedCollinearCorners: removedCollinearCorners, removedDuplicateCorners: removedDuplicateCorners,
        unsupportedLineRecords: unsupportedLineRecords, warnings: warnings }
    );
    return scene;
  }

  function normalizeNormal(nx, ny, nz, p0, p1, p2) {
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) nx = ny = nz = 0;
    var len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-20)) {
      var ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      var bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
      len = Math.hypot(nx, ny, nz);
    }
    return len > 1e-20 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
  }

  function parseSTL(input) {
    var bytes = asBytes(input);
    if (bytes.length < 84) throw new Error('STL: файл короче минимального бинарного заголовка');
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var declared = dv.getUint32(80, true);
    var expected = 84 + declared * 50;
    var isBinary = declared > 0 && expected === bytes.length;
    var source = [], normals = [], indices = [];
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    var triangles = 0, nonZeroAttributes = 0;

    function addTriangle(a, b, c, n) {
      if (triangles >= MAX_TRIANGLES) throw new Error('STL превышает лимит ' + MAX_TRIANGLES.toLocaleString('ru-RU') + ' треугольников; экспортируйте модель частями');
      var normal = normalizeNormal(n[0], n[1], n[2], a, b, c);
      var pts = [a, b, c];
      for (var i = 0; i < 3; i++) {
        var p = pts[i];
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) throw new Error('STL: обнаружена нечисловая координата');
        source.push(p[0], p[1], p[2]);
        normals.push(normal[0], normal[1], normal[2]);
        indices.push(indices.length);
        lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); lo[2] = Math.min(lo[2], p[2]);
        hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); hi[2] = Math.max(hi[2], p[2]);
      }
      triangles++;
    }

    if (isBinary) {
      var offset = 84;
      var pts = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (var t = 0; t < declared; t++, offset += 50) {
        var nx = dv.getFloat32(offset, true), ny = dv.getFloat32(offset + 4, true), nz = dv.getFloat32(offset + 8, true);
        for (var v = 0; v < 3; v++) {
          var vo = offset + 12 + v * 12;
          pts[v][0] = dv.getFloat32(vo, true); pts[v][1] = dv.getFloat32(vo + 4, true); pts[v][2] = dv.getFloat32(vo + 8, true);
        }
        var attribute = dv.getUint16(offset + 48, true);
        if (attribute !== 0) nonZeroAttributes++;
        addTriangle(pts[0], pts[1], pts[2], [nx, ny, nz]);
      }
    } else {
      var facetNormal = [0, 0, 0], facetVertices = [], sawFacet = false;
      forEachTextLine(input, function (rawLine, lineNo) {
        var line = rawLine.trim();
        if (!line || line.charAt(0) === '#') return;
        var tokens = line.split(/\s+/), tag = tokens[0].toLowerCase();
        if (tag === 'facet' && tokens[1] && tokens[1].toLowerCase() === 'normal') {
          if (facetVertices.length) throw new Error('STL, строка ' + lineNo + ': новая грань началась до завершения предыдущей');
          facetNormal = [finiteNumber(tokens[2], 'STL, строка ' + lineNo), finiteNumber(tokens[3], 'STL, строка ' + lineNo), finiteNumber(tokens[4], 'STL, строка ' + lineNo)];
          sawFacet = true;
        } else if (tag === 'vertex') {
          if (!sawFacet) throw new Error('STL, строка ' + lineNo + ': vertex вне facet');
          if (facetVertices.length >= 3) throw new Error('STL, строка ' + lineNo + ': в facet больше трёх вершин');
          facetVertices.push([
            finiteNumber(tokens[1], 'STL, строка ' + lineNo),
            finiteNumber(tokens[2], 'STL, строка ' + lineNo),
            finiteNumber(tokens[3], 'STL, строка ' + lineNo)
          ]);
          if (facetVertices.length === 3) {
            addTriangle(facetVertices[0], facetVertices[1], facetVertices[2], facetNormal);
            facetVertices = [];
          }
        } else if (tag === 'endfacet') {
          if (facetVertices.length) throw new Error('STL, строка ' + lineNo + ': facet должен содержать ровно три вершины');
          sawFacet = false;
        }
      });
      if (facetVertices.length) throw new Error('STL: последняя facet должна содержать ровно три вершины');
      if (!triangles) throw new Error('STL: не найдена корректная ASCII или бинарная геометрия');
    }
    if (!triangles) throw new Error('STL: модель не содержит треугольников');
    var warnings = ['STL не содержит CRS, единиц или подтверждённой оси вверх; исходные координаты сохранены.'];
    if (nonZeroAttributes) warnings.push('Не интерпретированы STL facet-атрибуты/возможные цвета: ' + nonZeroAttributes.toLocaleString('ru-RU') + '.');
    return makeScene(
      new Float32Array(source),
      new Float32Array(normals),
      null,
      null,
      new Uint32Array(indices),
      'STL',
      { lo: lo, hi: hi },
      { triangles: triangles, binary: isBinary, declaredTriangles: isBinary ? declared : null, nonZeroAttributes: nonZeroAttributes, warnings: warnings }
    );
  }

  return {
    parseOBJ: parseOBJ,
    parseSTL: parseSTL,
    triangulatePolygon: triangulatePolygon,
    MAX_TRIANGLES: MAX_TRIANGLES
  };
});