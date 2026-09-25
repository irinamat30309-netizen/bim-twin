/*
 * meshviewer.js — self-contained WebGL2 textured-mesh viewer for BIM Twin (variant B).
 * Renders glTF 2.0 / GLB meshes (e.g. RealityScan / RealityCapture textured exports)
 * as an isolated overlay above .stage, with orbit + walk navigation and PBR baseColor textures.
 * No external dependencies (does not require three.js) — same self-contained approach as splatviewer.js.
 * API: window.MeshViewer = { mount(host), load(arrayBuffer, name), enter(), exit(), isOpen() }
 * Pure parsers exported for node tests: _parseGLB, _buildScene.
 */
(function () {
  'use strict';

  // ---------- utils ----------
  function u8ToUtf8(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  function dataUriToArrayBuffer(uri) {
    var comma = uri.indexOf(',');
    var meta = uri.slice(0, comma), data = uri.slice(comma + 1);
    if (meta.indexOf('base64') >= 0) {
      var bin = (typeof atob !== 'undefined') ? atob(data)
        : Buffer.from(data, 'base64').toString('binary');
      var len = bin.length, out = new Uint8Array(len);
      for (var i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    }
    var txt = decodeURIComponent(data), o2 = new Uint8Array(txt.length);
    for (var j = 0; j < txt.length; j++) o2[j] = txt.charCodeAt(j);
    return o2.buffer;
  }

  // ---------- GLB / glTF parsing (pure, node-testable) ----------
  function parseGLB(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Не GLB: отсутствует заголовок glTF');
    var version = dv.getUint32(4, true);
    var total = dv.getUint32(8, true);
    var off = 12, json = null, bin = null;
    while (off + 8 <= total) {
      var clen = dv.getUint32(off, true);
      var ctype = dv.getUint32(off + 4, true);
      var start = off + 8;
      if (ctype === 0x4e4f534a) { json = JSON.parse(u8ToUtf8(new Uint8Array(arrayBuffer, start, clen))); }
      else if (ctype === 0x004e4942) { bin = arrayBuffer.slice(start, start + clen); }
      off = start + clen;
    }
    if (!json) throw new Error('GLB без JSON-чанка');
    return { json: json, bin: bin, version: version };
  }

  var COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  var NUMC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

  function getComponent(dv, off, ct) {
    switch (ct) {
      case 5120: return dv.getInt8(off);
      case 5121: return dv.getUint8(off);
      case 5122: return dv.getInt16(off, true);
      case 5123: return dv.getUint16(off, true);
      case 5125: return dv.getUint32(off, true);
      default: return dv.getFloat32(off, true);
    }
  }

  function readAccessorFloat(gltf, buffers, idx) {
    var acc = gltf.accessors[idx];
    var bv = gltf.bufferViews[acc.bufferView];
    var buf = buffers[bv.buffer];
    var nc = NUMC[acc.type], count = acc.count;
    var Comp = COMP[acc.componentType];
    var elemSize = Comp.BYTES_PER_ELEMENT;
    var base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    var stride = bv.byteStride || (elemSize * nc);
    var out = new Float32Array(count * nc);
    var tight = stride === elemSize * nc;
    if (tight && (base % elemSize) === 0) {
      var src = new Comp(buf, base, count * nc);
      for (var i = 0; i < out.length; i++) out[i] = src[i];
    } else {
      var dv = new DataView(buf);
      for (var e = 0; e < count; e++) {
        for (var c = 0; c < nc; c++) out[e * nc + c] = getComponent(dv, base + e * stride + c * elemSize, acc.componentType);
      }
    }
    return { array: out, count: count, numComp: nc };
  }

  function readIndices(gltf, buffers, idx) {
    var acc = gltf.accessors[idx];
    var bv = gltf.bufferViews[acc.bufferView];
    var buf = buffers[bv.buffer];
    var Comp = COMP[acc.componentType];
    var elemSize = Comp.BYTES_PER_ELEMENT;
    var base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    var out = new Uint32Array(acc.count);
    var dv = new DataView(buf);
    for (var i = 0; i < acc.count; i++) out[i] = getComponent(dv, base + i * elemSize, acc.componentType);
    return out;
  }

  // ---------- matrix math (column-major) ----------
  function normalize(v) { var n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function ident4() { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function multiply4(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] + a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function fromTRS(t, r, s) {
    t = t || [0, 0, 0]; r = r || [0, 0, 0, 1]; s = s || [1, 1, 1];
    var x = r[0], y = r[1], z = r[2], w = r[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    var sx = s[0], sy = s[1], sz = s[2];
    var m = new Float32Array(16);
    m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx; m[3] = 0;
    m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy; m[7] = 0;
    m[8] = (xz + wy) * sz; m[9] = (yz - wx) * sz; m[10] = (1 - (xx + yy)) * sz; m[11] = 0;
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
    return m;
  }
  function nodeMatrix(node) {
    if (node.matrix) { var m = new Float32Array(16); for (var i = 0; i < 16; i++) m[i] = node.matrix[i]; return m; }
    return fromTRS(node.translation, node.rotation, node.scale);
  }
  function xformPoint(m, p) {
    var x = p[0], y = p[1], z = p[2];
    var w = m[3] * x + m[7] * y + m[11] * z + m[15]; if (!w) w = 1;
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
  }
  // normal matrix = transpose(inverse(upper-left 3x3)) as mat3 (gl-matrix port)
  function normalFromMat4(a) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[4], a11 = a[5], a12 = a[6], a20 = a[8], a21 = a[9], a22 = a[10];
    var b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
    var det = a00 * b01 + a01 * b11 + a02 * b21;
    var o = new Float32Array(9);
    if (!det) { o[0] = o[4] = o[8] = 1; return o; }
    det = 1.0 / det;
    o[0] = b01 * det; o[1] = (-a22 * a01 + a02 * a21) * det; o[2] = (a12 * a01 - a02 * a11) * det;
    o[3] = b11 * det; o[4] = (a22 * a00 - a02 * a20) * det; o[5] = (-a12 * a00 + a02 * a10) * det;
    o[6] = b21 * det; o[7] = (-a21 * a00 + a01 * a20) * det; o[8] = (a11 * a00 - a01 * a10) * det;
    return o;
  }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
    return m;
  }
  function lookAt(eye, center, up) {
    var z = normalize(sub(eye, center));
    var x = normalize(cross(up, z));
    var y = cross(z, x);
    var m = new Float32Array(16);
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0]; m[3] = 0;
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1]; m[7] = 0;
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2]; m[11] = 0;
    m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye); m[15] = 1;
    return m;
  }

  // ---------- build renderable scene (pure) ----------
  function buildScene(gltf, glbBin) {
    var buffers = (gltf.buffers || []).map(function (b) {
      if (b.uri) return dataUriToArrayBuffer(b.uri);
      return glbBin;
    });
    var images = (gltf.images || []).map(function (img) {
      if (img.uri) {
        if (/^data:/.test(img.uri)) return { arrayBuffer: dataUriToArrayBuffer(img.uri), mimeType: (img.mimeType || '') };
        return { uri: img.uri, mimeType: (img.mimeType || '') };
      }
      if (img.bufferView != null) {
        var bv = gltf.bufferViews[img.bufferView];
        var buf = buffers[bv.buffer];
        return { bytes: new Uint8Array(buf, bv.byteOffset || 0, bv.byteLength), mimeType: (img.mimeType || 'image/jpeg') };
      }
      return { empty: true };
    });
    function materialFor(mi) {
      var mat = (mi != null && gltf.materials) ? gltf.materials[mi] : null;
      var pbr = (mat && mat.pbrMetallicRoughness) || {};
      var bcf = pbr.baseColorFactor || [1, 1, 1, 1];
      var texImage = -1;
      if (pbr.baseColorTexture && gltf.textures) {
        var t = gltf.textures[pbr.baseColorTexture.index];
        if (t && t.source != null) texImage = t.source;
      }
      return { baseColorFactor: bcf, textureImage: texImage, doubleSided: !!(mat && mat.doubleSided) };
    }

    var prims = [];
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    var sceneIdx = (gltf.scene != null) ? gltf.scene : 0;
    var scene = (gltf.scenes && gltf.scenes[sceneIdx]) || { nodes: (gltf.nodes || []).map(function (_, i) { return i; }) };

    function visit(nodeIdx, parent) {
      var node = gltf.nodes[nodeIdx];
      if (!node) return;
      var world = multiply4(parent, nodeMatrix(node));
      if (node.mesh != null && gltf.meshes) {
        var mesh = gltf.meshes[node.mesh];
        (mesh.primitives || []).forEach(function (p) {
          if (p.mode != null && p.mode !== 4) return; // triangles only
          var attr = p.attributes || {};
          if (attr.POSITION == null) return;
          var pos = readAccessorFloat(gltf, buffers, attr.POSITION);
          var nrm = (attr.NORMAL != null) ? readAccessorFloat(gltf, buffers, attr.NORMAL) : null;
          var uv = (attr.TEXCOORD_0 != null) ? readAccessorFloat(gltf, buffers, attr.TEXCOORD_0) : null;
          var idx = (p.indices != null) ? readIndices(gltf, buffers, p.indices) : null;
          if (!idx) { idx = new Uint32Array(pos.count); for (var q = 0; q < pos.count; q++) idx[q] = q; }
          // world-space bounds
          for (var v = 0; v < pos.count; v++) {
            var wp = xformPoint(world, [pos.array[v * 3], pos.array[v * 3 + 1], pos.array[v * 3 + 2]]);
            if (wp[0] < lo[0]) lo[0] = wp[0]; if (wp[1] < lo[1]) lo[1] = wp[1]; if (wp[2] < lo[2]) lo[2] = wp[2];
            if (wp[0] > hi[0]) hi[0] = wp[0]; if (wp[1] > hi[1]) hi[1] = wp[1]; if (wp[2] > hi[2]) hi[2] = wp[2];
          }
          prims.push({
            positions: pos.array,
            normals: nrm ? nrm.array : null,
            uvs: uv ? uv.array : null,
            indices: idx,
            vertexCount: pos.count,
            model: world,
            normalMatrix: normalFromMat4(world),
            material: materialFor(p.material)
          });
        });
      }
      (node.children || []).forEach(function (ci) { visit(ci, world); });
    }
    (scene.nodes || []).forEach(function (n) { visit(n, ident4()); });

    if (!isFinite(lo[0])) { lo = [-1, -1, -1]; hi = [1, 1, 1]; }
    var center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    var radius = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    var tris = 0; for (var pi = 0; pi < prims.length; pi++) tris += prims[pi].indices.length / 3;
    return { primitives: prims, images: images, bounds: { lo: lo, hi: hi, center: center, radius: radius }, triangles: tris | 0 };
  }

  // ---------- PLY triangle-mesh parsing (pure, node-testable) ----------
  // Reads ascii / binary_little_endian / binary_big_endian PLY with a vertex element
  // (x,y,z + optional red/green/blue) and a face element (list of vertex indices).
  // Produces the same scene shape as buildScene so the tour renderer can show it.
  var PLY_SZ = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  function parsePLYMesh(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var s = '';
    for (var hi = 0; hi < u8.length && hi < 100000; hi++) { s += String.fromCharCode(u8[hi]); if (s.length >= 10 && s.slice(-10) === 'end_header') break; }
    var idx = s.indexOf('end_header');
    if (idx < 0) throw new Error('PLY: \u043d\u0435\u0442 \u0437\u0430\u0433\u043e\u043b\u043e\u0432\u043a\u0430');
    var dataStart = idx + 10;
    if (u8[dataStart] === 0x0d) dataStart++;
    if (u8[dataStart] === 0x0a) dataStart++;
    var lines = s.slice(0, idx).split(/\r?\n/);
    var format = 'ascii', le = true, elements = [], cur = null, comments = [];
    for (var l = 0; l < lines.length; l++) {
      var pp = lines[l].trim().split(/\s+/);
      if (pp[0] === 'format') { format = pp[1]; le = (pp[1] !== 'binary_big_endian'); }
      else if (pp[0] === 'comment' || pp[0] === 'obj_info') comments.push(lines[l].trim().slice(pp[0].length).trim());
      else if (pp[0] === 'element') { cur = { name: pp[1], count: parseInt(pp[2], 10) || 0, props: [] }; elements.push(cur); }
      else if (pp[0] === 'property' && cur) {
        if (pp[1] === 'list') cur.props.push({ list: true, countType: pp[2], valType: pp[3], name: pp[4] });
        else cur.props.push({ list: false, type: pp[1], name: pp[2] });
      }
    }
    function rd(dv, o, t) {
      switch (t) {
        case 'char': case 'int8': return dv.getInt8(o);
        case 'uchar': case 'uint8': return dv.getUint8(o);
        case 'short': case 'int16': return dv.getInt16(o, le);
        case 'ushort': case 'uint16': return dv.getUint16(o, le);
        case 'int': case 'int32': return dv.getInt32(o, le);
        case 'uint': case 'uint32': return dv.getUint32(o, le);
        case 'float': case 'float32': return dv.getFloat32(o, le);
        case 'double': case 'float64': return dv.getFloat64(o, le);
      }
      throw new Error('PLY \u0442\u0438\u043f: ' + t);
    }
    var vEl = null, fEl = null;
    for (var ei = 0; ei < elements.length; ei++) { if (elements[ei].name === 'vertex') vEl = elements[ei]; else if (elements[ei].name === 'face') fEl = elements[ei]; }
    if (!vEl) throw new Error('PLY: \u043d\u0435\u0442 \u0432\u0435\u0440\u0448\u0438\u043d');
    var vc = vEl.count;
    var coordProps = {};
    for (var cp = 0; cp < vEl.props.length; cp++) coordProps[vEl.props[cp].name.toLowerCase()] = vEl.props[cp].type;
    var exactSourceCoords = ['x', 'y', 'z'].some(function (axis) { return coordProps[axis] === 'double' || coordProps[axis] === 'float64'; });
    // PLY double coordinates (commonly survey/world coordinates) stay double
    // for slicing; only the GPU copy is reduced to a local Float32 frame below.
    var sourcePositions = exactSourceCoords ? new Float64Array(vc * 3) : new Float32Array(vc * 3);
    var redProp = null;
    for (var q = 0; q < vEl.props.length; q++) { if (vEl.props[q].name === 'red') redProp = vEl.props[q]; }
    var hasColor = !!redProp;
    var colDiv = (redProp && (redProp.type === 'float' || redProp.type === 'float32' || redProp.type === 'double' || redProp.type === 'float64')) ? 1 : 255;
    var colors = hasColor ? new Float32Array(vc * 3) : null;
    var dv = new DataView(arrayBuffer);
    var indices = [];
    var lo = [Infinity, Infinity, Infinity], hi2 = [-Infinity, -Infinity, -Infinity];

    if (format === 'ascii') {
      var txt = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8').decode(u8.subarray(dataStart)) : '';
      var tok = txt.split(/\s+/), ti = 0;
      var next = function () { while (ti < tok.length && tok[ti] === '') ti++; return tok[ti++]; };
      for (var vi = 0; vi < vc; vi++) {
        var vx = 0, vy = 0, vz = 0, cr = 0, cg = 0, cbb = 0;
        for (var pa = 0; pa < vEl.props.length; pa++) {
          var prA = vEl.props[pa], val = parseFloat(next());
          if (prA.name === 'x') vx = val; else if (prA.name === 'y') vy = val; else if (prA.name === 'z') vz = val;
          else if (prA.name === 'red') cr = val; else if (prA.name === 'green') cg = val; else if (prA.name === 'blue') cbb = val;
        }
        sourcePositions[vi * 3] = vx; sourcePositions[vi * 3 + 1] = vy; sourcePositions[vi * 3 + 2] = vz;
        if (colors) { colors[vi * 3] = cr / colDiv; colors[vi * 3 + 1] = cg / colDiv; colors[vi * 3 + 2] = cbb / colDiv; }
        if (vx < lo[0]) lo[0] = vx; if (vy < lo[1]) lo[1] = vy; if (vz < lo[2]) lo[2] = vz;
        if (vx > hi2[0]) hi2[0] = vx; if (vy > hi2[1]) hi2[1] = vy; if (vz > hi2[2]) hi2[2] = vz;
      }
      if (fEl) {
        for (var fi = 0; fi < fEl.count; fi++) {
          for (var fp = 0; fp < fEl.props.length; fp++) {
            var fprA = fEl.props[fp];
            if (fprA.list) {
              var cnt = parseInt(next(), 10) || 0, poly = [];
              for (var c2 = 0; c2 < cnt; c2++) poly.push(parseInt(next(), 10));
              for (var t2 = 2; t2 < cnt; t2++) indices.push(poly[0], poly[t2 - 1], poly[t2]);
            } else next();
          }
        }
      }
    } else {
      var vStride = 0; for (var sp = 0; sp < vEl.props.length; sp++) vStride += PLY_SZ[vEl.props[sp].type] || 0;
      var offX = 0, offY = 0, offZ = 0, offR = 0, offG = 0, offB = 0, acc = 0;
      var tX = 'float', tY = 'float', tZ = 'float', tC = 'uchar';
      for (var s2 = 0; s2 < vEl.props.length; s2++) {
        var pr2 = vEl.props[s2];
        if (pr2.name === 'x') { offX = acc; tX = pr2.type; } else if (pr2.name === 'y') { offY = acc; tY = pr2.type; } else if (pr2.name === 'z') { offZ = acc; tZ = pr2.type; }
        else if (pr2.name === 'red') { offR = acc; tC = pr2.type; } else if (pr2.name === 'green') offG = acc; else if (pr2.name === 'blue') offB = acc;
        acc += PLY_SZ[pr2.type] || 0;
      }
      var o = dataStart;
      for (var vi2 = 0; vi2 < vc; vi2++) {
        var x = rd(dv, o + offX, tX), y = rd(dv, o + offY, tY), z = rd(dv, o + offZ, tZ);
        sourcePositions[vi2 * 3] = x; sourcePositions[vi2 * 3 + 1] = y; sourcePositions[vi2 * 3 + 2] = z;
        if (colors) { colors[vi2 * 3] = rd(dv, o + offR, tC) / colDiv; colors[vi2 * 3 + 1] = rd(dv, o + offG, tC) / colDiv; colors[vi2 * 3 + 2] = rd(dv, o + offB, tC) / colDiv; }
        if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
        if (x > hi2[0]) hi2[0] = x; if (y > hi2[1]) hi2[1] = y; if (z > hi2[2]) hi2[2] = z;
        o += vStride;
      }
      if (fEl) {
        for (var fi2 = 0; fi2 < fEl.count; fi2++) {
          for (var fp2 = 0; fp2 < fEl.props.length; fp2++) {
            var fpr2 = fEl.props[fp2];
            if (fpr2.list) {
              var cnt2 = rd(dv, o, fpr2.countType); o += PLY_SZ[fpr2.countType] || 1;
              var vsz = PLY_SZ[fpr2.valType] || 4, poly2 = [];
              for (var c3 = 0; c3 < cnt2; c3++) { poly2.push(rd(dv, o, fpr2.valType)); o += vsz; }
              for (var t3 = 2; t3 < cnt2; t3++) indices.push(poly2[0], poly2[t3 - 1], poly2[t3]);
            } else o += PLY_SZ[fpr2.type] || 0;
          }
        }
      }
    }

    if (!indices.length) throw new Error('PLY \u0431\u0435\u0437 \u0433\u0440\u0430\u043d\u0435\u0439 (\u044d\u0442\u043e \u043e\u0431\u043b\u0430\u043a\u043e, \u0430 \u043d\u0435 \u043c\u0435\u0448)');
    var idxArr = new Uint32Array(indices);
    if (!isFinite(lo[0])) { lo = [-1, -1, -1]; hi2 = [1, 1, 1]; }
    var sourceCenter = [
      lo[0] + (hi2[0] - lo[0]) * 0.5,
      lo[1] + (hi2[1] - lo[1]) * 0.5,
      lo[2] + (hi2[2] - lo[2]) * 0.5
    ];
    var commentText = comments.join(' ').toLowerCase();
    var sourceUpAxisKnown = /\bup\s*[=:]\s*[yz]\b|\b[yz][- ]up\b/.test(commentText);
    var sourceUpAxis = /\bup\s*[=:]\s*z\b|\bz[- ]up\b/.test(commentText) ? 'z' : 'y';
    var crsComment = comments.find(function (c) { return /^crs_wkt_uri=/i.test(c); });
    var sourceCrsWkt = null;
    if (crsComment) {
      var encodedCrs = crsComment.replace(/^crs_wkt_uri=/i, '');
      try { sourceCrsWkt = decodeURIComponent(encodedCrs); } catch (e) { sourceCrsWkt = encodedCrs; }
    }
    var frameComment = comments.find(function (c) { return /^coordinate_frame=/i.test(c); });
    var coordinateFrame = frameComment ? frameComment.replace(/^coordinate_frame=/i, '') : null;
    var maxAbs = Math.max(Math.abs(lo[0]), Math.abs(lo[1]), Math.abs(lo[2]), Math.abs(hi2[0]), Math.abs(hi2[1]), Math.abs(hi2[2]));
    var localize = exactSourceCoords || sourceUpAxis === 'z' || maxAbs > 10000;
    var positions = sourcePositions;
    var viewLo = lo.slice(), viewHi = hi2.slice(), center = sourceCenter.slice();
    if (localize) {
      positions = new Float32Array(vc * 3);
      for (var vpi = 0; vpi < vc; vpi++) {
        var sx = sourcePositions[vpi * 3], sy = sourcePositions[vpi * 3 + 1], sz = sourcePositions[vpi * 3 + 2];
        if (sourceUpAxis === 'z') {
          positions[vpi * 3] = sx - sourceCenter[0];
          positions[vpi * 3 + 1] = sz - sourceCenter[2];
          positions[vpi * 3 + 2] = -(sy - sourceCenter[1]);
        } else {
          positions[vpi * 3] = sx - sourceCenter[0];
          positions[vpi * 3 + 1] = sy - sourceCenter[1];
          positions[vpi * 3 + 2] = sz - sourceCenter[2];
        }
      }
      if (sourceUpAxis === 'z') {
        viewLo = [lo[0] - sourceCenter[0], lo[2] - sourceCenter[2], -(hi2[1] - sourceCenter[1])];
        viewHi = [hi2[0] - sourceCenter[0], hi2[2] - sourceCenter[2], -(lo[1] - sourceCenter[1])];
      } else {
        viewLo = [lo[0] - sourceCenter[0], lo[1] - sourceCenter[1], lo[2] - sourceCenter[2]];
        viewHi = [hi2[0] - sourceCenter[0], hi2[1] - sourceCenter[1], hi2[2] - sourceCenter[2]];
      }
      center = [0, 0, 0];
    }
    var radius = 0.5 * Math.hypot(hi2[0] - lo[0], hi2[1] - lo[1], hi2[2] - lo[2]) || 1;
    var I4 = ident4();
    var prim = { positions: positions, sectionPositions: sourcePositions, normals: null, uvs: null, colors: colors, indices: idxArr, vertexCount: vc, model: I4, normalMatrix: normalFromMat4(I4), material: { baseColorFactor: [1, 1, 1, 1], textureImage: -1, doubleSided: true } };
    var sourceBounds = { lo: lo.slice(), hi: hi2.slice(), center: sourceCenter.slice(), radius: radius };
    return {
      primitives: [prim], images: [],
      bounds: { lo: viewLo, hi: viewHi, center: center, radius: radius },
      sectionBounds: sourceBounds,
      sourceFormat: 'PLY',
      sourceUpAxis: sourceUpAxis,
      sourceUpAxisKnown: sourceUpAxisKnown,
      sectionViewTransform: { axis: sourceUpAxis, center: localize ? sourceCenter.slice() : [0, 0, 0] },
      sourceCrsWkt: sourceCrsWkt,
      coordinateFrame: coordinateFrame,
      triangles: (idxArr.length / 3) | 0
    };
  }

  function detectAndBuild(arrayBuffer, name) {
    var isGlb = false;
    if (arrayBuffer.byteLength >= 4) { var m = new DataView(arrayBuffer).getUint32(0, true); if (m === 0x46546c67) isGlb = true; }
    if (isGlb) { var g = parseGLB(arrayBuffer); var glbScene = buildScene(g.json, g.bin); glbScene.sourceFormat = 'GLB'; return glbScene; }
    var u0 = new Uint8Array(arrayBuffer, 0, Math.min(4, arrayBuffer.byteLength));
    if (u0[0] === 0x70 && u0[1] === 0x6c && u0[2] === 0x79) return parsePLYMesh(arrayBuffer); // 'ply'
    var importers = (typeof module !== 'undefined' && module.exports) ? require('./mesh-importers') :
      (typeof window !== 'undefined' ? window.MeshImporters : null);
    var ext = String(name || '').split(/[?#]/)[0].toLowerCase();
    if (/\.obj$/.test(ext)) {
      if (!importers || !importers.parseOBJ) throw new Error('Импортер OBJ не загружен');
      return importers.parseOBJ(arrayBuffer);
    }
    if (/\.stl$/.test(ext)) {
      if (!importers || !importers.parseSTL) throw new Error('Импортер STL не загружен');
      return importers.parseSTL(arrayBuffer);
    }
    // .gltf JSON text (buffers/images via data URIs)
    var json = JSON.parse(u8ToUtf8(new Uint8Array(arrayBuffer)));
    var gltfScene = buildScene(json, null); gltfScene.sourceFormat = 'glTF'; return gltfScene;
  }

  // ---------- viewer state ----------
  var S = {
    host: null, wrap: null, canvas: null, overlayCanvas: null, overlayCtx: null, gl: null, hud: null, titleEl: null,
    program: null, u: {}, prims: null, texByImage: null, bounds: null, sectionPrimitives: null,
    sectionBounds: null, sectionViewTransform: null, sourceUpAxis: 'y', sourceUpAxisKnown: false, sourceFormat: null, sourceCrsWkt: null, coordinateFrame: null, sectionAxisTouched: false,
    sectionPreview: null, sectionPreviewKey: null, sectionLevelTouched: false,
    loadSeq: 0, loadWorker: null, loadCancel: null,
    sectionSeq: 0, sectionWorker: null, sectionCancel: null,
    open: false, raf: 0, exposure: 1.0, walk: false, wire: false,
    cam: { target: [0, 0, 0], dist: 5, yaw: 0.6, pitch: -0.35, eye: [0, 0, 5] },
    keys: {}, dt: 0.016, _t: 0, moveSpeed: 1, zoomVel: 0, near: 0.01, far: 1000
  };

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function toast(msg) { if (typeof window !== 'undefined' && typeof window.toast === 'function') window.toast(msg); }
  function forwardVec() {
    var cp = Math.cos(S.cam.pitch), sp = Math.sin(S.cam.pitch);
    return normalize([cp * Math.sin(S.cam.yaw), sp, cp * Math.cos(S.cam.yaw)]);
  }

  // ---------- GL setup ----------
  var VS = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform mat4 uProj, uView, uModel;\nuniform mat3 uNormal;\n' +
    'in vec3 position;\nin vec3 normal;\nin vec2 uv;\nin vec3 color;\n' +
    'out vec3 vWorld;\nout vec3 vNormal;\nout vec2 vUv;\nout vec3 vColor;\n' +
    'void main(){\n' +
    '  vec4 wp = uModel * vec4(position,1.0);\n' +
    '  vWorld = wp.xyz; vNormal = uNormal * normal; vUv = uv; vColor = color;\n' +
    '  gl_Position = uProj * uView * wp;\n' +
    '}\n';
  var FS = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform sampler2D uTex;\nuniform int uHasTex;\nuniform int uHasNormal;\n' +
    'uniform vec4 uBaseColor;\nuniform vec3 uCamPos;\nuniform float uExposure;\nuniform int uWire;\nuniform int uHasColor;\n' +
    'in vec3 vWorld;\nin vec3 vNormal;\nin vec2 vUv;\nin vec3 vColor;\nout vec4 frag;\n' +
    'void main(){\n' +
    '  vec3 N;\n' +
    '  if (uHasNormal==1 && length(vNormal)>0.0001) N = normalize(vNormal);\n' +
    '  else N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));\n' +
    '  vec3 V = normalize(uCamPos - vWorld);\n' +
    '  if (dot(N,V) < 0.0) N = -N;\n' +
    '  vec3 base = uBaseColor.rgb;\n' +
    '  if (uHasColor==1) base *= vColor;\n' +
    '  if (uHasTex==1) base *= texture(uTex, vUv).rgb;\n' +
    '  float diff = max(dot(N,V), 0.0);\n' +
    '  float amb = 0.4;\n' +
    '  vec3 col = base * (amb + (1.0-amb)*diff) * uExposure;\n' +
    '  if (uWire==1) col = vec3(0.55,0.75,1.0);\n' +
    '  frag = vec4(col, 1.0);\n' +
    '}\n';

  function compile(gl, type, src) {
    var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }
  function initGL() {
    var gl = S.canvas.getContext('webgl2', { antialias: true, alpha: true, preserveDrawingBuffer: false });
    if (!gl) { toast('WebGL2 недоступен — меш не показать'); return false; }
    S.gl = gl;
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'position');
    gl.bindAttribLocation(prog, 1, 'normal');
    gl.bindAttribLocation(prog, 2, 'uv');
    gl.bindAttribLocation(prog, 3, 'color');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    S.program = prog;
    S.u = {
      proj: gl.getUniformLocation(prog, 'uProj'), view: gl.getUniformLocation(prog, 'uView'),
      model: gl.getUniformLocation(prog, 'uModel'), normal: gl.getUniformLocation(prog, 'uNormal'),
      tex: gl.getUniformLocation(prog, 'uTex'), hasTex: gl.getUniformLocation(prog, 'uHasTex'),
      hasNormal: gl.getUniformLocation(prog, 'uHasNormal'), baseColor: gl.getUniformLocation(prog, 'uBaseColor'),
      camPos: gl.getUniformLocation(prog, 'uCamPos'), exposure: gl.getUniformLocation(prog, 'uExposure'),
      wire: gl.getUniformLocation(prog, 'uWire'),
      hasColor: gl.getUniformLocation(prog, 'uHasColor')
    };
    return true;
  }

  function makeTex(gl, img) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 200, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (!img || img.empty) return tex;
    var url = null;
    try {
      if (img.uri) url = img.uri;
      else {
        var bytes = img.bytes || (img.arrayBuffer ? new Uint8Array(img.arrayBuffer) : null);
        if (!bytes) return tex;
        url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType || 'image/jpeg' }));
      }
    } catch (e) { return tex; }
    var im = new Image();
    im.onload = function () {
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } catch (e) {}
      if (url && !img.uri) { try { URL.revokeObjectURL(url); } catch (e) {} }
      S._dirty = true;
    };
    im.onerror = function () { if (url && !img.uri) { try { URL.revokeObjectURL(url); } catch (e) {} } };
    im.src = url;
    return tex;
  }

  function resetMeshSectionPanel() {
    var panel = S.wrap && S.wrap.querySelector('#meshSectionPanel');
    if (!panel) return;
    panel.style.display = 'none';
    var preview = panel.querySelector('#meshSectionPreview');
    var exportButton = panel.querySelector('#meshSectionExport');
    var cancelButton = panel.querySelector('#meshSectionCancel');
    var progress = panel.querySelector('#meshSectionProgress');
    var status = panel.querySelector('#meshSectionStatus');
    if (preview) preview.disabled = false;
    if (exportButton) exportButton.disabled = false;
    if (cancelButton) {
      cancelButton.disabled = true;
      cancelButton.style.display = 'none';
    }
    if (progress) {
      progress.value = 0;
      progress.style.display = 'none';
    }
    if (status) status.textContent = 'Выберите плоскость сечения для текущего меша.';
    S.sectionPreview = null;
    S.sectionPreviewKey = null;
    if (S.overlayCtx && S.overlayCanvas) {
      S.overlayCtx.clearRect(0, 0, S.overlayCanvas.width, S.overlayCanvas.height);
    }
  }

  function uploadScene(scene) {
    cancelPendingMeshSection();
    resetMeshSectionPanel();
    var gl = S.gl;
    // Keep the CPU-side triangle buffers for exact section extraction. They are
    // the same arrays parsed for rendering; no second vertex copy is made.
    S.sectionPrimitives = scene.primitives;
    S.sectionBounds = scene.sectionBounds || scene.bounds;
    S.sectionViewTransform = scene.sectionViewTransform || null;
    S.sourceUpAxis = scene.sourceUpAxis || 'y';
    S.sourceUpAxisKnown = scene.sourceUpAxisKnown == null ? true : !!scene.sourceUpAxisKnown;
    S.sourceFormat = scene.sourceFormat || 'mesh';
    S.sourceCrsWkt = scene.sourceCrsWkt || null;
    S.coordinateFrame = scene.coordinateFrame || null;
    S.sectionAxisTouched = false;
    S.sectionLevelTouched = false;
    S.sectionPreview = null; S.sectionPreviewKey = null;
    S.texByImage = (scene.images || []).map(function (img) { return makeTex(gl, img); });
    S.prims = scene.primitives.map(function (p) {
      var vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      var pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, p.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      if (p.normals) { var nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, p.normals, gl.STATIC_DRAW); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); }
      else { gl.disableVertexAttribArray(1); gl.vertexAttrib3f(1, 0, 0, 0); }
      if (p.uvs) { var ub = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ub); gl.bufferData(gl.ARRAY_BUFFER, p.uvs, gl.STATIC_DRAW); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0); }
      else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }
      if (p.colors) { var cbf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cbf); gl.bufferData(gl.ARRAY_BUFFER, p.colors, gl.STATIC_DRAW); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 0, 0); }
      else { gl.disableVertexAttribArray(3); gl.vertexAttrib3f(3, 1, 1, 1); }
      var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao: vao, count: p.indices.length, model: p.model, normalMatrix: p.normalMatrix, material: p.material, hasNormal: !!p.normals, hasColor: !!p.colors };
    });
    S.bounds = scene.bounds;
    resetView();
  }

  function cancelPendingMeshWorker() {
    if (S.loadCancel) {
      var cancel = S.loadCancel;
      S.loadCancel = null;
      cancel();
    }
  }

  var MESH_SECTION_WORKER_MAX_BYTES = 128 * 1024 * 1024;
  var MESH_SECTION_MAX_TRIANGLES = 2000000;
  var MESH_SECTION_SYNC_FALLBACK_TRIANGLES = 20000;
  function inspectMeshSectionInput(primitives) {
    if (!Array.isArray(primitives) || !primitives.length) throw new TypeError('Не передана геометрия меша');
    var specs = [], byteCount = 0, triangleCount = 0;
    function sourceBytes(source, label, arrayElementBytes) {
      if (ArrayBuffer.isView(source) && !(source instanceof DataView)) return source.byteLength;
      if (Array.isArray(source)) return source.length * arrayElementBytes;
      throw new TypeError(label + ' не является числовым массивом');
    }
    for (var i = 0; i < primitives.length; i++) {
      var primitive = primitives[i];
      var positions = primitive && (primitive.sectionPositions || primitive.positions || primitive.vertices);
      var indices = primitive && (primitive.indices || primitive.index || null);
      if (!positions || !Number.isSafeInteger(positions.length) || positions.length < 9 || positions.length % 3 !== 0) {
        throw new RangeError('Некорректный массив XYZ в меше #' + (i + 1));
      }
      if (indices && (!Number.isSafeInteger(indices.length) || indices.length % 3 !== 0)) {
        throw new RangeError('Число индексов в меше #' + (i + 1) + ' не кратно трём');
      }
      var triangles = indices ? indices.length / 3 : positions.length / 9;
      if (!Number.isSafeInteger(triangles)) throw new RangeError('Меш #' + (i + 1) + ' содержит неполные треугольники');
      triangleCount += triangles;
      if (triangleCount > MESH_SECTION_MAX_TRIANGLES) {
        throw new RangeError('Точное сечение ограничено ' + MESH_SECTION_MAX_TRIANGLES.toLocaleString('ru-RU') + ' треугольниками');
      }
      var positionBytes = sourceBytes(positions, 'Вершины меша #' + (i + 1), 8);
      var indexBytes = indices ? sourceBytes(indices, 'Индексы меша #' + (i + 1), 4) : 0;
      var matrix = primitive.model || primitive.transform || null;
      if (matrix != null) {
        if ((!Array.isArray(matrix) && !(ArrayBuffer.isView(matrix) && !(matrix instanceof DataView))) || matrix.length !== 16) {
          throw new RangeError('Матрица меша #' + (i + 1) + ' должна содержать 16 значений');
        }
        for (var mi = 0; mi < 16; mi++) if (!Number.isFinite(Number(matrix[mi]))) throw new RangeError('Матрица меша #' + (i + 1) + ' содержит нечисловое значение');
      }
      byteCount += positionBytes + indexBytes + (matrix ? 16 * 8 : 0);
      if (!Number.isFinite(byteCount) || byteCount > MESH_SECTION_WORKER_MAX_BYTES) {
        throw new RangeError('Для безопасного фонового сечения нужна копия геометрии больше 128 МиБ; уменьшите плотность меша');
      }
      specs.push({ primitive: primitive, positions: positions, indices: indices, matrix: matrix });
    }
    return { specs: specs, bytes: byteCount, triangles: triangleCount };
  }

  function copyMeshSectionInput(info) {
    var primitives = [], transfers = [];
    info.specs.forEach(function (spec) {
      var positions = ArrayBuffer.isView(spec.positions) && !(spec.positions instanceof DataView)
        ? new spec.positions.constructor(spec.positions)
        : Float64Array.from(spec.positions);
      var indices = null;
      if (spec.indices) {
        indices = ArrayBuffer.isView(spec.indices) && !(spec.indices instanceof DataView)
          ? new spec.indices.constructor(spec.indices)
          : Uint32Array.from(spec.indices);
      }
      var matrix = spec.matrix ? Array.from(spec.matrix, function (v) { return Number(v); }) : null;
      primitives.push({ positions: positions, indices: indices, model: matrix });
      transfers.push(positions.buffer);
      if (indices) transfers.push(indices.buffer);
    });
    return { primitives: primitives, transfers: transfers };
  }

  function cancelPendingMeshSection() {
    S.sectionSeq++;
    var cancel = S.sectionCancel;
    S.sectionCancel = null;
    if (cancel) cancel();
  }

  function runMeshSectionWorker(plane, requestId, onProgress) {
    var info;
    try { info = inspectMeshSectionInput(S.sectionPrimitives); }
    catch (error) { return Promise.reject(error); }
    if (typeof Worker !== 'function') {
      if (info.triangles > MESH_SECTION_SYNC_FALLBACK_TRIANGLES) {
        return Promise.reject(new Error('Фоновое сечение недоступно; для такого меша безопасный синхронный расчёт отключён'));
      }
      try { return Promise.resolve(window.Section.meshPlaneSection(S.sectionPrimitives, plane)); }
      catch (error) { return Promise.reject(error); }
    }
    var packed;
    try { packed = copyMeshSectionInput(info); }
    catch (error) { return Promise.reject(new Error('Не удалось подготовить копию меша для сечения: ' + (error && error.message || String(error)))); }
    return new Promise(function (resolve, reject) {
      var worker;
      try { worker = new Worker(new URL('mesh-section-worker.js?v=1226', document.baseURI)); }
      catch (error) {
        if (info.triangles <= MESH_SECTION_SYNC_FALLBACK_TRIANGLES) {
          try { resolve(window.Section.meshPlaneSection(S.sectionPrimitives, plane)); }
          catch (fallbackError) { reject(fallbackError); }
        } else {
          reject(new Error('Не удалось запустить фоновое сечение меша: ' + (error && error.message || String(error))));
        }
        return;
      }
      var settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) {}
        if (S.sectionWorker === worker) S.sectionWorker = null;
        if (S.sectionCancel === cancel) S.sectionCancel = null;
        if (error) reject(error); else resolve(value);
      }
      function cancel() {
        var error = new Error('Расчёт точного сечения отменён');
        error.name = 'AbortError';
        finish(error);
      }
      S.sectionWorker = worker;
      S.sectionCancel = cancel;
      worker.onmessage = function (event) {
        var data = event.data || {};
        if (data.type === 'fatal') {
          finish(new Error('Ошибка загрузки Worker сечения: ' + (data.error || 'неизвестная ошибка')));
          return;
        }
        if (data.id !== requestId) return;
        if (data.type === 'progress') {
          if (requestId === S.sectionSeq && typeof onProgress === 'function') {
            try { onProgress(data); } catch (e) {}
          }
          return;
        }
        if (data.type === 'result') { finish(null, data.result); return; }
        if (data.type === 'error') {
          var error = new Error(data.error || 'Ошибка расчёта точного сечения');
          error.name = data.name || 'Error';
          finish(error);
        }
      };
      worker.onerror = function (event) {
        finish(new Error('Worker точного сечения завершился с ошибкой: ' + (event && event.message || 'неизвестная ошибка')));
      };
      try {
        worker.postMessage({
          id: requestId,
          operation: 'mesh-section',
          primitives: packed.primitives,
          plane: plane
        }, packed.transfers);
      } catch (error) {
        finish(new Error('Не удалось передать меш в Worker сечения: ' + (error && error.message || String(error))));
      }
    });
  }

  function completeMeshLoad(scene, name) {
    if (!scene.primitives.length) throw new Error('В файле нет треугольных мешей');
    uploadScene(scene);
    if (S.titleEl) {
      S.titleEl.textContent = (name || 'mesh') + '  ·  ' + scene.triangles.toLocaleString('ru-RU') + ' треуг.';
      S.titleEl.title = (scene.warnings || []).join('\n');
    }
    api.enter();
    toast('Меш открыт: ' + scene.triangles.toLocaleString('ru-RU') + ' треугольников · ЛКМ — осмотр, WASD — ходьба, Esc — выход');
    return scene;
  }

  function resetView() {
    if (!S.bounds) return;
    S.cam.target = S.bounds.center.slice();
    var r = S.bounds.radius || 1;
    S.cam.dist = r / Math.sin(0.5) * 1.3; // fov ~ 1.0 rad
    S.cam.yaw = 0.7; S.cam.pitch = -0.32;
    S.moveSpeed = r * 0.9;
    S.near = Math.max(r / 5000, 0.001); S.far = r * 40;
    S._dirty = true;
  }

  function updateCamera() {
    var dt = S.dt;
    var fwd = forwardVec();
    var right = normalize(cross([0, 1, 0], fwd));
    var up = [0, 1, 0];
    var sp = S.moveSpeed * (S.keys['shift'] ? 3 : 1);
    var moved = false;
    var d = [0, 0, 0];
    if (S.keys['w']) { d = add(d, fwd); moved = true; }
    if (S.keys['s']) { d = sub(d, fwd); moved = true; }
    if (S.keys['d']) { d = add(d, right); moved = true; }
    if (S.keys['a']) { d = sub(d, right); moved = true; }
    if (S.keys['e']) { d = add(d, up); moved = true; }
    if (S.keys['q']) { d = sub(d, up); moved = true; }
    if (moved) { S.cam.target = add(S.cam.target, scale3(normalize(d), sp * dt)); S._dirty = true; }
    if (Math.abs(S.zoomVel) > 1e-4) {
      S.cam.dist *= Math.exp(-S.zoomVel * dt * 3);
      S.cam.dist = Math.max((S.bounds ? S.bounds.radius : 1) * 0.02, Math.min(S.cam.dist, (S.bounds ? S.bounds.radius : 1) * 80));
      S.zoomVel *= Math.pow(0.0001, dt);
      if (Math.abs(S.zoomVel) < 1e-3) S.zoomVel = 0;
      S._dirty = true;
    }
    var f2 = forwardVec();
    S.cam.eye = sub(S.cam.target, scale3(f2, S.cam.dist));
  }

  function resize() {
    if (!S.canvas || !S.wrap) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(S.wrap.clientWidth * dpr));
    var h = Math.max(1, Math.floor(S.wrap.clientHeight * dpr));
    if (S.canvas.width !== w || S.canvas.height !== h) { S.canvas.width = w; S.canvas.height = h; S._dirty = true; }
    if (S.overlayCanvas && (S.overlayCanvas.width !== w || S.overlayCanvas.height !== h)) {
      S.overlayCanvas.width = w; S.overlayCanvas.height = h;
    }
  }

  function projectSectionPoint(point, result, proj, view, width, height) {
    var a = result.anchor, o = result.coordOffset, u = result.plane.u, v = result.plane.v;
    var x = a[0] + (point[0] - o[0]) * u[0] + (point[1] - o[1]) * v[0];
    var y = a[1] + (point[0] - o[0]) * u[1] + (point[1] - o[1]) * v[1];
    var z = a[2] + (point[0] - o[0]) * u[2] + (point[1] - o[1]) * v[2];
    if (S.sectionViewTransform) {
      var tr = S.sectionViewTransform, c = tr.center;
      if (tr.axis === 'z') {
        var sx = x, sy = y, sz = z;
        x = sx - c[0]; y = sz - c[2]; z = -(sy - c[1]);
      } else { x -= c[0]; y -= c[1]; z -= c[2]; }
    }
    var vx = view[0] * x + view[4] * y + view[8] * z + view[12];
    var vy = view[1] * x + view[5] * y + view[9] * z + view[13];
    var vz = view[2] * x + view[6] * y + view[10] * z + view[14];
    var vw = view[3] * x + view[7] * y + view[11] * z + view[15];
    var cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw;
    var cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw;
    var cz = proj[2] * vx + proj[6] * vy + proj[10] * vz + proj[14] * vw;
    var cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;
    if (!(cw > 1e-9) || !Number.isFinite(cx + cy + cz + cw)) return null;
    var nz = cz / cw;
    if (nz < -1 || nz > 1) return null;
    return [(cx / cw * 0.5 + 0.5) * width, (1 - (cy / cw * 0.5 + 0.5)) * height];
  }

  function drawSectionPreview(proj, view) {
    var canvas = S.overlayCanvas, ctx = S.overlayCtx, result = S.sectionPreview;
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!result || !result.paths || !result.paths.length || !result.anchor || !result.plane) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.save();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#24e0c2';
    ctx.shadowColor = '#071c25';
    ctx.shadowBlur = 3 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (var i = 0; i < result.paths.length; i++) {
      var path = result.paths[i], drawing = false;
      ctx.beginPath();
      for (var j = 0; j < path.points.length; j++) {
        var screen = projectSectionPoint(path.points[j], result, proj, view, canvas.width, canvas.height);
        if (!screen) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(screen[0], screen[1]); drawing = true; }
        else ctx.lineTo(screen[0], screen[1]);
      }
      if (path.closed && drawing) ctx.closePath();
      if (drawing) ctx.stroke();
    }
    ctx.restore();
  }

  function frame() {
    if (!S.open) return;
    var gl = S.gl, now = nowMs();
    S.dt = S._t ? Math.min(0.05, (now - S._t) / 1000) : 0.016; S._t = now;
    resize();
    updateCamera();
    var w = S.canvas.width, h = S.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.06, 0.07, 0.09, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var proj = perspective(1.0, w / h, S.near, S.far);
    var view = lookAt(S.cam.eye, S.cam.target, [0, 1, 0]);
    gl.useProgram(S.program);
    gl.uniformMatrix4fv(S.u.proj, false, proj);
    gl.uniformMatrix4fv(S.u.view, false, view);
    gl.uniform3f(S.u.camPos, S.cam.eye[0], S.cam.eye[1], S.cam.eye[2]);
    gl.uniform1f(S.u.exposure, S.exposure);
    gl.uniform1i(S.u.tex, 0);
    gl.uniform1i(S.u.wire, S.wire ? 1 : 0);
    if (S.prims) {
      for (var i = 0; i < S.prims.length; i++) {
        var p = S.prims[i], mat = p.material;
        gl.uniformMatrix4fv(S.u.model, false, p.model);
        gl.uniformMatrix3fv(S.u.normal, false, p.normalMatrix);
        gl.uniform1i(S.u.hasNormal, p.hasNormal ? 1 : 0);
        gl.uniform1i(S.u.hasColor, p.hasColor ? 1 : 0);
        var bcf = mat.baseColorFactor;
        gl.uniform4f(S.u.baseColor, bcf[0], bcf[1], bcf[2], bcf[3] == null ? 1 : bcf[3]);
        var hasTex = (!S.wire && mat.textureImage >= 0 && S.texByImage[mat.textureImage]);
        gl.uniform1i(S.u.hasTex, hasTex ? 1 : 0);
        if (hasTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.texByImage[mat.textureImage]); }
        if (mat.doubleSided || S.wire) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
        gl.bindVertexArray(p.vao);
        gl.drawElements(S.wire ? gl.LINES : gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
      }
    }
    drawSectionPreview(proj, view);
    S.raf = requestAnimationFrame(frame);
  }

  // ---------- DOM / controls ----------
  function btnCss() {
    return 'display:inline-flex;align-items:center;gap:6px;background:#2a2f3a;color:#eef2f7;border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:6px 10px;font:600 12.5px system-ui,sans-serif;cursor:pointer;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)';
  }
  function buildDom() {
    var wrap = document.createElement('div');
    wrap.id = 'meshViewer';
    // Sit above the base point-cloud canvas, but below the optional Lixel overlay
    // (left tool column/version tag). The mesh canvas still receives pointer input
    // everywhere except those explicit controls.
    wrap.style.cssText = 'position:absolute;inset:0;z-index:13;background:#0f1216;overflow:hidden;display:none';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;outline:none';
    canvas.tabIndex = 0;
    wrap.appendChild(canvas);
    var overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'meshSectionOverlay';
    overlayCanvas.setAttribute('aria-hidden', 'true');
    overlayCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    // The workspace skin applies an opaque background to every stage canvas;
    // keep this 2D layer transparent so it cannot hide the WebGL mesh beneath it.
    overlayCanvas.style.setProperty('background', 'transparent', 'important');
    wrap.appendChild(overlayCanvas);
    var hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;pointer-events:none';
    var left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:10px;pointer-events:auto;background:rgba(10,14,20,.72);border:1px solid rgba(127,182,255,.3);border-radius:10px;padding:6px 12px;color:#e6edf3;font:600 12.5px system-ui,sans-serif';
    var title = document.createElement('span'); title.textContent = 'Меш (glTF)'; left.appendChild(title);
    var right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:8px;pointer-events:auto';
    // exposure slider
    var expWrap = document.createElement('label');
    expWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#2a2f3a;border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:4px 10px;color:#eef2f7;font:600 12px system-ui,sans-serif';
    var expLab = document.createElement('span'); expLab.textContent = 'Свет';
    var expIn = document.createElement('input'); expIn.type = 'range'; expIn.min = '0.4'; expIn.max = '2.5'; expIn.step = '0.05'; expIn.value = String(S.exposure); expIn.style.cssText = 'width:80px;accent-color:#2563eb';
    expIn.oninput = function () { S.exposure = +expIn.value; S._dirty = true; };
    expWrap.appendChild(expLab); expWrap.appendChild(expIn);
    var resetBtn = document.createElement('button'); resetBtn.textContent = '⌂ Сброс вида'; resetBtn.style.cssText = btnCss();
    resetBtn.onclick = function () { resetView(); };
    var wireBtn = document.createElement('button'); wireBtn.textContent = '▦ Каркас'; wireBtn.style.cssText = btnCss();
    wireBtn.onclick = function () { S.wire = !S.wire; wireBtn.style.background = S.wire ? '#2563eb' : '#2a2f3a'; S._dirty = true; };
    var sectionBtn = document.createElement('button'); sectionBtn.textContent = '✂ Сечение'; sectionBtn.title = 'Точное пересечение треугольной геометрии меша плоскостью'; sectionBtn.style.cssText = btnCss();
    var exitBtn = document.createElement('button'); exitBtn.textContent = '✕ Выйти'; exitBtn.style.cssText = btnCss() + ';background:#b3402f;border-color:rgba(255,180,170,.45)';
    exitBtn.onclick = function () { api.exit(); };
    right.appendChild(expWrap); right.appendChild(resetBtn); right.appendChild(wireBtn); right.appendChild(sectionBtn); right.appendChild(exitBtn);
    hud.appendChild(left); hud.appendChild(right);
    wrap.appendChild(hud);
    var sectionPanel = document.createElement('div');
    sectionPanel.id = 'meshSectionPanel';
    sectionPanel.setAttribute('role', 'dialog');
    sectionPanel.setAttribute('aria-label', 'Точное сечение меша');
    sectionPanel.style.cssText = 'position:absolute;right:12px;top:58px;width:290px;max-height:calc(100% - 80px);overflow:auto;display:none;background:rgba(27,31,38,.97);border:1px solid rgba(127,182,255,.35);border-radius:10px;padding:12px;color:#e6edf3;font:12px system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45)';
    sectionPanel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:10px"><span>Точное сечение меша</span><button id="meshSectionClose" type="button" aria-label="Закрыть" style="background:#2a2f3a;color:#e6edf3;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:3px 8px;cursor:pointer">×</button></div>' +
      '<label style="display:block;margin:8px 0">Плоскость<select id="meshSectionAxis" style="display:block;width:100%;margin-top:4px;background:#20242c;color:#e6edf3;padding:6px;border:1px solid #525d6d;border-radius:5px"><option value="y">Плоскость Y = const</option><option value="z">Плоскость Z = const</option><option value="x">Плоскость X = const</option></select></label>' +
      '<label id="meshSectionLevelLabel" style="display:block;margin:8px 0">Уровень Y, ед.<input id="meshSectionLevel" type="number" step="0.001" style="display:block;width:100%;margin-top:4px;background:#20242c;color:#e6edf3;padding:6px;border:1px solid #525d6d;border-radius:5px;box-sizing:border-box"></label>' +
      '<input id="meshSectionRange" aria-label="Положение плоскости сечения" type="range" step="0.001" style="width:100%;accent-color:#4c8dff">' +
      '<button id="meshSectionPreview" type="button" style="width:100%;margin-top:10px;background:#165b66;color:#fff;border:1px solid rgba(36,224,194,.45);border-radius:6px;padding:8px;cursor:pointer;font-weight:700">Показать контур сечения</button>' +
      '<button id="meshSectionExport" type="button" style="width:100%;margin-top:10px;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:8px;cursor:pointer;font-weight:700">Сохранить точное сечение DXF</button>' +
      '<progress id="meshSectionProgress" max="100" value="0" aria-label="Прогресс расчёта сечения" style="display:none;width:100%;height:8px;margin-top:9px"></progress>' +
      '<button id="meshSectionCancel" type="button" disabled style="display:none;width:100%;margin-top:7px;background:#3b414b;color:#f2f4f7;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:7px;cursor:pointer">Отменить расчёт</button>' +
      '<div id="meshSectionStatus" role="status" aria-live="polite" style="margin-top:9px;line-height:1.4;color:#b9c4d0">Контур рассчитывается по треугольникам. Нажмите «Показать контур сечения»; исходный меш не обрезается.</div>' +
      '<p style="margin:8px 0 0;color:#9aa6b5;line-height:1.35">DXF сохраняет координаты плоскости и единицы меша. CRS может читаться из PLY, но формат DXF R12 её не переносит — назначьте систему координат в CAD.</p>';
    wrap.appendChild(sectionPanel);
    function updateSectionLevel(keepCurrent) {
      if (!S.sectionBounds) return;
      var axisSelect = sectionPanel.querySelector('#meshSectionAxis');
      var isZUp = S.sourceUpAxis === 'z';
      axisSelect.querySelector('[value="x"]').textContent = isZUp ? 'Вертикальная · X = const (Y/Z)' : 'Вертикальная · боковая (X = const)';
      axisSelect.querySelector('[value="y"]').textContent = isZUp ? 'Вертикальная · Y = const (X/Z)' : 'Горизонтальная · план (Y↑)';
      axisSelect.querySelector('[value="z"]').textContent = isZUp ? 'Горизонтальная · план (Z↑)' : 'Вертикальная · фасад (Z = const)';
      var axis = sectionPanel.querySelector('#meshSectionAxis').value;
      var axisIndex = { x: 0, y: 1, z: 2 }[axis];
      var lo = Number(S.sectionBounds.lo[axisIndex]), hi = Number(S.sectionBounds.hi[axisIndex]);
      var range = sectionPanel.querySelector('#meshSectionRange'), level = sectionPanel.querySelector('#meshSectionLevel');
      var mid = lo + (hi - lo) * 0.5, current = Number(level.value);
      var hasCurrent = level.value.trim() !== '' && Number.isFinite(current);
      var value = keepCurrent && hasCurrent ? Math.max(lo, Math.min(hi, current)) : mid;
      range.min = String(lo); range.max = String(hi > lo ? hi : lo + 0.001); range.step = String(Math.max(0.001, (hi - lo) / 1000));
      range.disabled = !(hi > lo);
      level.min = String(lo); level.max = String(hi); level.step = range.step;
      level.value = String(value); range.value = String(value);
      sectionPanel.querySelector('#meshSectionLevelLabel').childNodes[0].textContent = 'Уровень ' + axis.toUpperCase() + ', ед.';
      var upText = S.sourceUpAxisKnown
        ? 'up=' + S.sourceUpAxis.toUpperCase() + (S.sourceFormat === 'GLB' || S.sourceFormat === 'glTF' ? ' по спецификации glTF' : ' по метаданным')
        : 'up-axis в PLY не задан; принято Y↑';
      var crsText = S.sourceCrsWkt ? ' · CRS найдена в PLY, но DXF R12 её не содержит' : ' · CRS в меше не подтверждена';
      sectionPanel.querySelector('#meshSectionStatus').textContent = 'Границы оси ' + axis.toUpperCase() + ': ' + lo.toPrecision(6) + '…' + hi.toPrecision(6) + ' · ' + upText + crsText;
    }
    function clearSectionPreview(message) {
      S.sectionPreview = null; S.sectionPreviewKey = null;
      if (S.overlayCtx && S.overlayCanvas) S.overlayCtx.clearRect(0, 0, S.overlayCanvas.width, S.overlayCanvas.height);
      if (message) sectionPanel.querySelector('#meshSectionStatus').textContent = message;
    }
    function setSectionBusy(busy, percent) {
      var previewButton = sectionPanel.querySelector('#meshSectionPreview');
      var exportButton = sectionPanel.querySelector('#meshSectionExport');
      var cancelButton = sectionPanel.querySelector('#meshSectionCancel');
      var progress = sectionPanel.querySelector('#meshSectionProgress');
      previewButton.disabled = !!busy;
      exportButton.disabled = !!busy;
      cancelButton.disabled = !busy;
      cancelButton.style.display = busy ? 'block' : 'none';
      progress.style.display = busy ? 'block' : 'none';
      progress.value = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : 0;
    }
    function makeSectionRequest() {
      var axis = sectionPanel.querySelector('#meshSectionAxis').value;
      var levelInput = sectionPanel.querySelector('#meshSectionLevel');
      if (levelInput.value.trim() === '') throw new Error('Задайте положение плоскости сечения');
      var level = Number(levelInput.value), axisIndex = { x: 0, y: 1, z: 2 }[axis];
      if (!Number.isFinite(level)) throw new Error('Положение плоскости должно быть конечным числом');
      var lo = Number(S.sectionBounds.lo[axisIndex]), hi = Number(S.sectionBounds.hi[axisIndex]);
      if (level < lo || level > hi) throw new Error('Уровень должен быть в границах меша: ' + lo + '…' + hi);
      if (!window.Section || !window.Section.axisPlane || !window.Section.meshPlaneSection) throw new Error('Модуль точного сечения не загружен');
      return { axis: axis, level: level, key: axis + '|' + level, plane: window.Section.axisPlane(axis, level, S.sectionBounds.center) };
    }
    function setSectionResultStatus(result) {
      var status = sectionPanel.querySelector('#meshSectionStatus');
      if (!result.paths.length) {
        var details = result.invalidTriangles ? ' · повреждённых граней: ' + result.invalidTriangles : '';
        status.textContent = 'Пересечений не найдено · треугольников: ' + result.triangleCount + details + '. Проверьте уровень.';
        return;
      }
      var warning = '';
      if (result.branchNodes) warning += ' · ветвлений: ' + result.branchNodes + ' — проверьте топологию';
      if (result.invalidTriangles) warning += ' · пропущено повреждённых граней: ' + result.invalidTriangles;
      if (result.degenerateTriangles) warning += ' · вырожденных граней: ' + result.degenerateTriangles;
      status.textContent = 'Контур показан · замкнутых: ' + result.closedCount + ' · открытых: ' + result.openCount + ' · сегментов: ' + result.segmentCount + warning + ' · исходный меш не обрезан';
    }
    function exportSectionResult(result, axis) {
      if (!window.DXF || !window.DXF.toDxf) throw new Error('Модуль DXF не загружен');
      var layer = 'MESH_SECTION_' + axis.toUpperCase();
      var entities = window.Section.meshSectionToEntities(result, layer);
      var text = window.DXF.toDxf(entities, { layers: [layer] });
      var blob = new Blob([text], { type: 'application/dxf;charset=utf-8' });
      var url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'mesh-section-' + axis + '-' + Date.now() + '.dxf';
      document.body.appendChild(link); link.click();
      setTimeout(function () { if (link.parentNode) link.parentNode.removeChild(link); URL.revokeObjectURL(url); }, 500);
      sectionPanel.querySelector('#meshSectionStatus').textContent =
        'DXF готов · замкнутых контуров: ' + result.closedCount + ' · открытых линий: ' + result.openCount +
        ' · сегментов: ' + result.segmentCount + ' · допуск: ' + result.epsilon.toPrecision(3) + ' ед.' +
        (S.sourceCrsWkt ? ' · CRS есть в источнике, не встроена в R12 DXF' : '');
      toast('Точное сечение меша: ' + result.paths.length + ' линий · DXF сохранён' + (S.sourceCrsWkt ? ' · CRS не встроена' : ''));
    }
    function runSectionAction(action) {
      var status = sectionPanel.querySelector('#meshSectionStatus');
      var request;
      try {
        request = makeSectionRequest();
        if (action === 'export' && (!window.DXF || !window.DXF.toDxf)) throw new Error('Модуль DXF не загружен');
      } catch (error) {
        status.textContent = error && error.message ? error.message : 'Некорректные параметры сечения';
        toast('Ошибка сечения меша: ' + status.textContent);
        return;
      }
      var cached = S.sectionPreview && S.sectionPreviewKey === request.key ? S.sectionPreview : null;
      cancelPendingMeshSection();
      var requestId = S.sectionSeq;
      if (!cached) clearSectionPreview('Подготовка точного сечения…');
      setSectionBusy(!cached, 0);
      var phases = {
        prepare: 'подготовка буферов',
        bounds: 'границы меша',
        intersect: 'пересечение треугольников',
        coplanar: 'совпадающие грани',
        adjacency: 'топология сегментов',
        trace: 'сборка контуров',
        complete: 'завершение'
      };
      var work = cached
        ? Promise.resolve(cached)
        : runMeshSectionWorker(request.plane, requestId, function (progress) {
          if (requestId !== S.sectionSeq) return;
          var percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
          sectionPanel.querySelector('#meshSectionProgress').value = percent;
          var phase = phases[progress.phase] || 'расчёт';
          status.textContent = 'Расчёт сечения… ' + percent + '% · ' + phase;
        });
      work.then(function (result) {
        if (requestId !== S.sectionSeq) return;
        setSectionBusy(false, 100);
        if (!result || !Array.isArray(result.paths)) throw new Error('Worker не вернул корректные контуры сечения');
        if (!result.paths.length) {
          S.sectionPreview = null; S.sectionPreviewKey = null;
          setSectionResultStatus(result);
          toast('Сечение mesh: пересечений не найдено');
          return;
        }
        S.sectionPreview = result;
        S.sectionPreviewKey = request.key;
        S._dirty = true;
        setSectionResultStatus(result);
        if (action === 'export') exportSectionResult(result, request.axis);
        else toast('Контур точного сечения рассчитан и показан');
      }).catch(function (error) {
        if (requestId !== S.sectionSeq) return;
        setSectionBusy(false, 0);
        if (error && error.name === 'AbortError') {
          clearSectionPreview('Расчёт отменён. Частичный контур не применён.');
          return;
        }
        status.textContent = error && error.message ? error.message : 'Не удалось построить точное сечение';
        toast('Ошибка сечения меша: ' + status.textContent);
      });
    }
    sectionBtn.onclick = function () {
      if (sectionPanel.style.display === 'block') {
        cancelPendingMeshSection(); setSectionBusy(false, 0); sectionPanel.style.display = 'none'; return;
      }
      if (!S.sectionPrimitives || !S.sectionPrimitives.length) { toast('Сечение недоступно: геометрия меша не загружена'); return; }
      if (!S.sectionAxisTouched) sectionPanel.querySelector('#meshSectionAxis').value = S.sourceUpAxis === 'z' ? 'z' : 'y';
      sectionPanel.style.display = 'block'; updateSectionLevel(S.sectionLevelTouched); S.sectionLevelTouched = true;
    };
    sectionPanel.querySelector('#meshSectionClose').onclick = function () {
      cancelPendingMeshSection(); setSectionBusy(false, 0); sectionPanel.style.display = 'none';
    };
    sectionPanel.querySelector('#meshSectionCancel').onclick = function () {
      if (!S.sectionCancel) return;
      cancelPendingMeshSection();
      setSectionBusy(false, 0);
      clearSectionPreview('Расчёт отменён. Частичный контур не применён.');
    };
    sectionPanel.querySelector('#meshSectionAxis').addEventListener('change', function () {
      cancelPendingMeshSection(); setSectionBusy(false, 0);
      S.sectionAxisTouched = true; S.sectionLevelTouched = true; clearSectionPreview(); updateSectionLevel(false);
      sectionPanel.querySelector('#meshSectionStatus').textContent = 'Плоскость изменилась. Нажмите «Показать контур сечения» для пересчёта.';
    });
    sectionPanel.querySelector('#meshSectionRange').addEventListener('input', function () {
      cancelPendingMeshSection(); setSectionBusy(false, 0);
      S.sectionLevelTouched = true;
      sectionPanel.querySelector('#meshSectionLevel').value = this.value;
      clearSectionPreview('Уровень изменён. Нажмите «Показать контур сечения» для пересчёта.');
    });
    sectionPanel.querySelector('#meshSectionRange').addEventListener('change', function () {
      sectionPanel.querySelector('#meshSectionLevel').value = this.value;
    });
    sectionPanel.querySelector('#meshSectionLevel').addEventListener('input', function () {
      cancelPendingMeshSection(); setSectionBusy(false, 0);
      S.sectionLevelTouched = true;
      clearSectionPreview('Уровень изменён. Нажмите «Показать контур сечения» для пересчёта.');
    });
    sectionPanel.querySelector('#meshSectionLevel').addEventListener('change', function () {
      var axis = sectionPanel.querySelector('#meshSectionAxis').value, axisIndex = { x: 0, y: 1, z: 2 }[axis];
      if (this.value.trim() === '') {
        cancelPendingMeshSection(); setSectionBusy(false, 0);
        clearSectionPreview('Задайте положение плоскости сечения.');
        return;
      }
      var lo = Number(S.sectionBounds.lo[axisIndex]), hi = Number(S.sectionBounds.hi[axisIndex]), value = Number(this.value);
      if (!Number.isFinite(value)) {
        cancelPendingMeshSection(); setSectionBusy(false, 0);
        clearSectionPreview('Положение плоскости должно быть конечным числом.');
        return;
      }
      value = Math.max(lo, Math.min(hi, value)); this.value = String(value);
      sectionPanel.querySelector('#meshSectionRange').value = String(value);
      cancelPendingMeshSection(); setSectionBusy(false, 0);
      clearSectionPreview('Уровень изменён. Нажмите «Показать контур сечения» для пересчёта.');
    });
    sectionPanel.querySelector('#meshSectionPreview').onclick = function () { runSectionAction('preview'); };
    sectionPanel.querySelector('#meshSectionExport').onclick = function () { runSectionAction('export'); };
    var help = document.createElement('div');
    help.style.cssText = 'position:absolute;left:12px;bottom:12px;background:rgba(10,14,20,.72);border:1px solid rgba(127,182,255,.3);border-radius:8px;padding:6px 10px;color:#b9c4d0;font:12px system-ui,sans-serif;pointer-events:none';
    help.textContent = 'ЛКМ — вращение · колесо — зум · WASD — ходьба · Q/E — вниз/вверх · Esc — выход';
    wrap.appendChild(help);
    S.wrap = wrap; S.canvas = canvas; S.overlayCanvas = overlayCanvas; S.overlayCtx = overlayCanvas.getContext('2d'); S.hud = hud; S.titleEl = title;
    bindControls();
  }
  function bindControls() {
    var c = S.canvas, dragging = false, lx = 0, ly = 0;
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    c.addEventListener('mousedown', function (e) { dragging = true; lx = e.clientX; ly = e.clientY; c.style.cursor = 'grabbing'; c.focus(); });
    window.addEventListener('mouseup', function () { dragging = false; if (S.canvas) S.canvas.style.cursor = 'grab'; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging || !S.open) return;
      var dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      S.cam.yaw -= dx * 0.005; S.cam.pitch -= dy * 0.005;
      var lim = 1.5; if (S.cam.pitch > lim) S.cam.pitch = lim; if (S.cam.pitch < -lim) S.cam.pitch = -lim;
      S._dirty = true;
    });
    c.addEventListener('wheel', function (e) { e.preventDefault(); S.zoomVel += (e.deltaY > 0 ? -1 : 1) * 1.1; }, { passive: false });
    var keyName = function (e) {
      var cc = e.code || '';
      if (cc.indexOf('Key') === 0) return cc.slice(3).toLowerCase();
      if (cc === 'ShiftLeft' || cc === 'ShiftRight') return 'shift';
      if (cc === 'ArrowUp') return 'w'; if (cc === 'ArrowDown') return 's';
      if (cc === 'ArrowLeft') return 'a'; if (cc === 'ArrowRight') return 'd';
      return (e.key || '').toLowerCase();
    };
    window.addEventListener('keydown', function (e) { if (!S.open) return; S.keys[keyName(e)] = true; });
    window.addEventListener('keyup', function (e) { if (!S.open) return; S.keys[keyName(e)] = false; if (e.key === 'Escape') api.exit(); });
  }

  // ---------- public API ----------
  var api = {
    mount: function (host) {
      if (S.wrap) return;
      S.host = host || document.querySelector('.stage') || document.body;
      buildDom();
      S.host.appendChild(S.wrap);
    },
    load: function (arrayBuffer, name) {
      cancelPendingMeshWorker();
      S.loadSeq++;
      cancelPendingMeshSection();
      resetMeshSectionPanel();
      if (!S.wrap) api.mount();
      if (!S.gl && !initGL()) return;
      try { return completeMeshLoad(detectAndBuild(arrayBuffer, name || ''), name || 'mesh'); }
      catch (err) { toast('Не удалось прочитать меш: ' + (err && err.message ? err.message : err)); throw err; }
    },
    enter: function () {
      if (!S.wrap) return;
      S.wrap.style.display = 'block';
      S.open = true; S._t = 0;
      if (!S.raf) S.raf = requestAnimationFrame(frame);
      if (S.canvas) S.canvas.focus();
    },
    exit: function () {
      S.loadSeq++;
      cancelPendingMeshWorker();
      cancelPendingMeshSection();
      resetMeshSectionPanel();
      S.open = false;
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
      if (S.wrap) S.wrap.style.display = 'none';
      S.keys = {};
    },
    isOpen: function () { return !!S.open; },
    _parseGLB: parseGLB,
    _buildScene: buildScene,
    _parsePLYMesh: parsePLYMesh,
    _parseOBJMesh: function (input) {
      var imp = (typeof module !== 'undefined' && module.exports) ? require('./mesh-importers') :
        (typeof window !== 'undefined' ? window.MeshImporters : null);
      if (!imp || !imp.parseOBJ) throw new Error('Импортер OBJ не загружен');
      return imp.parseOBJ(input);
    },
    _parseSTLMesh: function (input) {
      var imp = (typeof module !== 'undefined' && module.exports) ? require('./mesh-importers') :
        (typeof window !== 'undefined' ? window.MeshImporters : null);
      if (!imp || !imp.parseSTL) throw new Error('Импортер STL не загружен');
      return imp.parseSTL(input);
    },
    _detectAndBuild: detectAndBuild,
    loadAsync: function (arrayBuffer, name) {
      if (!S.wrap) api.mount();
      if (!S.gl && !initGL()) return Promise.reject(new Error('WebGL2 недоступен — меш не показать'));
      cancelPendingMeshWorker();
      cancelPendingMeshSection();
      resetMeshSectionPanel();
      var requestId = ++S.loadSeq;
      var ext = String(name || '').split(/[?#]/)[0].toLowerCase();
      if (!/\.obj$|\.stl$/.test(ext) || typeof Worker === 'undefined') {
        try { return Promise.resolve(completeMeshLoad(detectAndBuild(arrayBuffer, name || ''), name || 'mesh')); }
        catch (err) { toast('Не удалось прочитать меш: ' + (err && err.message ? err.message : err)); return Promise.reject(err); }
      }
      return new Promise(function (resolve, reject) {
        var worker;
        try {
          worker = new Worker(new URL('mesh-import-worker.js?v=1224', document.baseURI));
        } catch (workerCreateError) {
          try { resolve(completeMeshLoad(detectAndBuild(arrayBuffer, name || ''), name || 'mesh')); }
          catch (fallbackError) { reject(fallbackError); }
          return;
        }
        var finished = false;
        function cleanup() {
          if (worker) worker.terminate();
          if (S.loadWorker === worker) S.loadWorker = null;
          if (S.loadCancel === cancel) S.loadCancel = null;
        }
        function cancel() {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(null);
        }
        S.loadWorker = worker;
        S.loadCancel = cancel;
        worker.onmessage = function (event) {
          if (finished) return;
          finished = true;
          var data = event.data || {};
          cleanup();
          if (requestId !== S.loadSeq) { resolve(null); return; }
          if (!data.ok || !data.scene) { reject(new Error(data.error || 'Worker не вернул разобранную геометрию')); return; }
          try { resolve(completeMeshLoad(data.scene, name || 'mesh')); }
          catch (error) { reject(error); }
        };
        worker.onerror = function (event) {
          if (finished) return;
          finished = true;
          cleanup();
          if (requestId !== S.loadSeq) { resolve(null); return; }
          reject(new Error((event && event.message) || 'Ошибка фонового mesh-парсера'));
        };
        try {
          var transfer = [];
          if (arrayBuffer instanceof ArrayBuffer) transfer.push(arrayBuffer);
          worker.postMessage({ requestId: requestId, name: name || '', buffer: arrayBuffer }, transfer);
        } catch (postError) {
          if (!finished) { finished = true; cleanup(); reject(postError); }
        }
      });
    },
    getSectionGeometry: function () { return S.sectionPrimitives; }
  };

  if (typeof window !== 'undefined') window.MeshViewer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
