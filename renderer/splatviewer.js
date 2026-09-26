/*
 * splatviewer.js — self-contained WebGL2 3D Gaussian Splatting viewer for BIM Twin.
 * Renders .ply (INRIA 3DGS) and .splat scenes as an isolated overlay above .stage.
 * Rendering approach follows the well-known antimatter15/splat (MIT) technique.
 * API: window.SplatViewer = { mount(host), load(arrayBuffer, name), enter(), exit(), isOpen() }
 * Parsers are also exported for node tests: _parsePly, _parseSplat, _floatToHalf.
 */
(function () {
  'use strict';

  var SH_C0 = 0.28209479177387814;

  // ---------- half-float packing ----------
  var _fView = new Float32Array(1);
  var _iView = new Int32Array(_fView.buffer);
  function floatToHalf(val) {
    _fView[0] = val;
    var x = _iView[0];
    var bits = (x >> 16) & 0x8000;
    var m = (x >> 12) & 0x07ff;
    var e = (x >> 23) & 0xff;
    if (e < 103) return bits;
    if (e > 142) {
      bits |= 0x7c00;
      bits |= ((e === 255) ? 0 : 1) && (x & 0x007fffff);
      return bits;
    }
    if (e < 113) {
      m |= 0x0800;
      bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
      return bits;
    }
    bits |= ((e - 112) << 10) | (m >> 1);
    bits += m & 1;
    return bits;
  }
  function packHalf2x16(x, y) {
    return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
  }

  // ---------- parsers -> internal 32-byte splat buffer ----------
  // Layout per splat (32 bytes): pos f32[3], scale f32[3], rgba u8[4], rot u8[4]

  function parseSplat(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var count = Math.floor(u8.length / 32);
    return { buffer: u8.subarray(0, count * 32), count: count };
  }

  function parsePly(arrayBuffer, opts) {
    opts = opts || {};
    var maxPoints = opts.maxPoints || 130000000;
    var u8all = new Uint8Array(arrayBuffer);
    // find end_header
    var marker = 'end_header\n';
    var headerText = '';
    var scan = Math.min(u8all.length, 300000);
    for (var i = 0; i < scan; i++) {
      headerText += String.fromCharCode(u8all[i]);
      if (headerText.length >= marker.length && headerText.slice(-marker.length) === marker) break;
    }
    var headerEnd = headerText.length;
    var lines = headerText.split('\n');
    var vertexCount = 0;
    var props = [];
    var inVertex = false;
    for (var l = 0; l < lines.length; l++) {
      var ln = lines[l].trim();
      if (ln.indexOf('element vertex') === 0) { vertexCount = parseInt(ln.split(/\s+/)[2], 10); inVertex = true; }
      else if (ln.indexOf('element') === 0) { inVertex = false; }
      else if (ln.indexOf('property') === 0 && inVertex) {
        var parts = ln.split(/\s+/);
        if (parts[1] === 'list') continue; // skip face lists
        props.push({ type: parts[1], name: parts[2] });
      }
    }
    function tsize(t) {
      if (t === 'double' || t === 'float64') return 8;
      if (t === 'float' || t === 'float32' || t === 'int' || t === 'uint' || t === 'int32' || t === 'uint32') return 4;
      if (t === 'short' || t === 'ushort' || t === 'int16' || t === 'uint16') return 2;
      return 1; // char/uchar/uint8
    }
    var offset = {}, ptype = {}, rowLength = 0;
    for (var p = 0; p < props.length; p++) { offset[props[p].name] = rowLength; ptype[props[p].name] = props[p].type; rowLength += tsize(props[p].type); }
    var dv = new DataView(arrayBuffer, headerEnd);
    function has(n) { return offset[n] !== undefined; }
    function isFloatType(t) { return t === 'float' || t === 'float32' || t === 'double' || t === 'float64'; }
    function readAt(row, name) {
      if (offset[name] === undefined) return 0;
      var o = row * rowLength + offset[name];
      switch (ptype[name]) {
        case 'double': case 'float64': return dv.getFloat64(o, true);
        case 'float': case 'float32': return dv.getFloat32(o, true);
        case 'int': case 'int32': return dv.getInt32(o, true);
        case 'uint': case 'uint32': return dv.getUint32(o, true);
        case 'short': case 'int16': return dv.getInt16(o, true);
        case 'ushort': case 'uint16': return dv.getUint16(o, true);
        case 'char': case 'int8': return dv.getInt8(o);
        default: return dv.getUint8(o);
      }
    }
    var isGaussian = has('f_dc_0') && has('scale_0') && has('rot_0');
    if (!isGaussian) {
      // ===== СЫРОЕ ОБЛАКО ТОЧЕК =====
      // Рендер-буфер компактный: 16 байт/точка (позиция 3*f32 + rgba 4*u8),
      // поэтому ПОЛНОЕ облако (100М+ ≈ 1.6ГБ) влезает в один массив (лимит ~2ГБ)
      // и грузится без прореживания. Отдельный маленький 32B-буфер — для рамки/пикинга/станций.
      var rStride = 1;
      if (vertexCount > maxPoints) rStride = Math.ceil(vertexCount / maxPoints);
      var rKept, rbuf;
      for (;;) {
        rKept = Math.ceil(vertexCount / rStride);
        try { rbuf = new ArrayBuffer(rKept * 16); break; }
        catch (e1) { rStride += 1; if (rStride >= vertexCount) throw new Error('недостаточно памяти для облака точек'); }
      }
      var rF = new Float32Array(rbuf), rU = new Uint8Array(rbuf);
      var helperMax = 4000000;
      var hStride = rStride;
      if (Math.ceil(vertexCount / hStride) > helperMax) hStride = Math.ceil(vertexCount / helperMax);
      var hKept = Math.ceil(vertexCount / hStride);
      var hOut = new Uint8Array(hKept * 32), hF = new Float32Array(hOut.buffer);
      var pMin = [Infinity, Infinity, Infinity], pMax = [-Infinity, -Infinity, -Infinity];
      var rw = 0, hw = 0, hNext = 0;
      for (var vv = 0; vv < vertexCount; vv += rStride) {
        var px = readAt(vv, 'x'), py = readAt(vv, 'y'), pz = readAt(vv, 'z');
        var cr, cg, cb, ca = 255;
        if (has('red')) {
          cr = readAt(vv, 'red'); cg = readAt(vv, 'green'); cb = readAt(vv, 'blue');
          if (isFloatType(ptype['red'])) { cr *= 255; cg *= 255; cb *= 255; }
          if (has('alpha')) { ca = readAt(vv, 'alpha'); if (isFloatType(ptype['alpha'])) ca *= 255; }
        } else if (has('f_dc_0')) {
          cr = (0.5 + SH_C0 * readAt(vv, 'f_dc_0')) * 255;
          cg = (0.5 + SH_C0 * readAt(vv, 'f_dc_1')) * 255;
          cb = (0.5 + SH_C0 * readAt(vv, 'f_dc_2')) * 255;
        } else { cr = cg = cb = 220; }
        var Rc = clamp255(cr), Gc = clamp255(cg), Bc = clamp255(cb), Ac = clamp255(ca);
        rF[rw * 4 + 0] = px; rF[rw * 4 + 1] = py; rF[rw * 4 + 2] = pz;
        rU[rw * 16 + 12] = Rc; rU[rw * 16 + 13] = Gc; rU[rw * 16 + 14] = Bc; rU[rw * 16 + 15] = Ac;
        rw++;
        if (vv >= hNext && hw < hKept) {
          var hb = hw * 8, hu = hw * 32;
          hF[hb + 0] = px; hF[hb + 1] = py; hF[hb + 2] = pz;
          hF[hb + 3] = 1; hF[hb + 4] = 1; hF[hb + 5] = 1;
          hOut[hu + 24] = Rc; hOut[hu + 25] = Gc; hOut[hu + 26] = Bc; hOut[hu + 27] = Ac;
          hOut[hu + 28] = 255; hOut[hu + 29] = 128; hOut[hu + 30] = 128; hOut[hu + 31] = 128;
          if (px < pMin[0]) pMin[0] = px; if (py < pMin[1]) pMin[1] = py; if (pz < pMin[2]) pMin[2] = pz;
          if (px > pMax[0]) pMax[0] = px; if (py > pMax[1]) pMax[1] = py; if (pz > pMax[2]) pMax[2] = pz;
          hw++; hNext += hStride;
        }
      }
      var pdiag = Math.hypot(pMax[0] - pMin[0], pMax[1] - pMin[1], pMax[2] - pMin[2]) || 1;
      var ps = pdiag * 0.0008 * Math.max(0.6, Math.sqrt(Math.max(1, hStride) / 8));
      for (var kk = 0; kk < hw; kk++) { hF[kk * 8 + 3] = ps; hF[kk * 8 + 4] = ps; hF[kk * 8 + 5] = ps; }
      return {
        buffer: hOut.subarray(0, hw * 32), count: hw,
        renderBuffer: new Uint8Array(rbuf, 0, rw * 16), renderCount: rw,
        kind: 'points', stride: rStride, totalVertices: vertexCount
      };
    }
    var stride = 1;
    var kept, out;
    for (;;) {
      kept = Math.ceil(vertexCount / stride);
      try { out = new Uint8Array(kept * 32); break; }
      catch (eMem) { stride += 1; if (stride >= vertexCount) throw new Error('недостаточно памяти для облака'); }
    }
    var outF = new Float32Array(out.buffer);
    var minb = [Infinity, Infinity, Infinity], maxb = [-Infinity, -Infinity, -Infinity];
    var w = 0;
    for (var v = 0; v < vertexCount; v += stride) {
      var base = w * 8, ubase = w * 32;
      var x = readAt(v, 'x'), y = readAt(v, 'y'), z = readAt(v, 'z');
      outF[base + 0] = x; outF[base + 1] = y; outF[base + 2] = z;
      if (x < minb[0]) minb[0] = x; if (y < minb[1]) minb[1] = y; if (z < minb[2]) minb[2] = z;
      if (x > maxb[0]) maxb[0] = x; if (y > maxb[1]) maxb[1] = y; if (z > maxb[2]) maxb[2] = z;
      if (isGaussian) {
        outF[base + 3] = Math.exp(readAt(v, 'scale_0'));
        outF[base + 4] = Math.exp(readAt(v, 'scale_1'));
        outF[base + 5] = Math.exp(readAt(v, 'scale_2'));
        var r = 0.5 + SH_C0 * readAt(v, 'f_dc_0');
        var g = 0.5 + SH_C0 * readAt(v, 'f_dc_1');
        var b = 0.5 + SH_C0 * readAt(v, 'f_dc_2');
        var a = 1.0 / (1.0 + Math.exp(-readAt(v, 'opacity')));
        out[ubase + 24] = clamp255(r * 255); out[ubase + 25] = clamp255(g * 255);
        out[ubase + 26] = clamp255(b * 255); out[ubase + 27] = clamp255(a * 255);
        var q0 = readAt(v, 'rot_0'), q1 = readAt(v, 'rot_1'), q2 = readAt(v, 'rot_2'), q3 = readAt(v, 'rot_3');
        var ql = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3) || 1;
        out[ubase + 28] = clamp255((q0 / ql) * 128 + 128); out[ubase + 29] = clamp255((q1 / ql) * 128 + 128);
        out[ubase + 30] = clamp255((q2 / ql) * 128 + 128); out[ubase + 31] = clamp255((q3 / ql) * 128 + 128);
      } else {
        // plain colored point cloud -> render each point as a tiny sphere splat
        var cr, cg, cb, ca = 255;
        if (has('red')) {
          cr = readAt(v, 'red'); cg = readAt(v, 'green'); cb = readAt(v, 'blue');
          if (isFloatType(ptype['red'])) { cr *= 255; cg *= 255; cb *= 255; }
          if (has('alpha')) { ca = readAt(v, 'alpha'); if (isFloatType(ptype['alpha'])) ca *= 255; }
        } else if (has('f_dc_0')) {
          cr = (0.5 + SH_C0 * readAt(v, 'f_dc_0')) * 255;
          cg = (0.5 + SH_C0 * readAt(v, 'f_dc_1')) * 255;
          cb = (0.5 + SH_C0 * readAt(v, 'f_dc_2')) * 255;
        } else { cr = cg = cb = 220; }
        out[ubase + 24] = clamp255(cr); out[ubase + 25] = clamp255(cg);
        out[ubase + 26] = clamp255(cb); out[ubase + 27] = clamp255(ca);
        // identity rotation, scale filled after bounds are known
        out[ubase + 28] = 255; out[ubase + 29] = 128; out[ubase + 30] = 128; out[ubase + 31] = 128;
        outF[base + 3] = 1; outF[base + 4] = 1; outF[base + 5] = 1;
      }
      w++;
    }
    var count = w;
    if (!isGaussian) {
      var diag = Math.hypot(maxb[0] - minb[0], maxb[1] - minb[1], maxb[2] - minb[2]) || 1;
      var s = diag * 0.0008 * Math.max(0.6, Math.sqrt(Math.max(1, stride) / 8));
      for (var k = 0; k < count; k++) { outF[k * 8 + 3] = s; outF[k * 8 + 4] = s; outF[k * 8 + 5] = s; }
    }
    return { buffer: out.subarray(0, count * 32), count: count, kind: isGaussian ? 'gaussian' : 'points', stride: stride, totalVertices: vertexCount };
  }
  function clamp255(x) { x = Math.round(x); return x < 0 ? 0 : (x > 255 ? 255 : x); }

  function detectAndParse(arrayBuffer, name) {
    var head = '';
    var u8 = new Uint8Array(arrayBuffer, 0, Math.min(16, arrayBuffer.byteLength));
    for (var i = 0; i < u8.length; i++) head += String.fromCharCode(u8[i]);
    var isPly = head.slice(0, 3) === 'ply';
    if ((name && /\.ply$/i.test(name)) || isPly) return parsePly(arrayBuffer);
    return parseSplat(arrayBuffer);
  }

  function computeBounds(buf, count) {
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < count; i++) {
      for (var k = 0; k < 3; k++) {
        var val = f[i * 8 + k];
        if (val < min[k]) min[k] = val;
        if (val > max[k]) max[k] = val;
      }
    }
    var center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    var radius = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
    return { min: min, max: max, center: center, radius: radius };
  }

  // Percentile-based bounds robust to stray outlier splats (common in SuperSplat/COLMAP exports)
  function robustBounds(buf, count) {
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    var stride = Math.max(1, Math.floor(count / 120000));
    var xs = [], ys = [], zs = [];
    for (var i = 0; i < count; i += stride) { xs.push(f[i * 8]); ys.push(f[i * 8 + 1]); zs.push(f[i * 8 + 2]); }
    var num = function (a, b) { return a - b; };
    xs.sort(num); ys.sort(num); zs.sort(num);
    function q(arr, p) { return arr[Math.max(0, Math.min(arr.length - 1, Math.floor(p * (arr.length - 1))))]; }
    var lo = [q(xs, 0.02), q(ys, 0.02), q(zs, 0.02)];
    var hi = [q(xs, 0.98), q(ys, 0.98), q(zs, 0.98)];
    var center = [q(xs, 0.5), q(ys, 0.5), q(zs, 0.5)];
    var radius = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
    return { center: center, radius: radius, lo: lo, hi: hi };
  }

  // Drop splats far outside the robust box (removes floaters that wreck framing + depth sort)
  function pruneOutliers(buf, count, rb, margin, vqLabels) {
    margin = margin || 2.5;
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    var srcU = new Uint8Array(buf.buffer, buf.byteOffset, count * 32);
    var c = rb.center;
    var ex = [
      Math.max(rb.hi[0] - c[0], c[0] - rb.lo[0], 1e-4) * margin,
      Math.max(rb.hi[1] - c[1], c[1] - rb.lo[1], 1e-4) * margin,
      Math.max(rb.hi[2] - c[2], c[2] - rb.lo[2], 1e-4) * margin
    ];
    var out = new Uint8Array(count * 32);
    var outVq = vqLabels ? new Uint16Array(count) : null;
    var w = 0;
    for (var i = 0; i < count; i++) {
      var x = f[i * 8], y = f[i * 8 + 1], z = f[i * 8 + 2];
      if (Math.abs(x - c[0]) <= ex[0] && Math.abs(y - c[1]) <= ex[1] && Math.abs(z - c[2]) <= ex[2]) {
        out.set(srcU.subarray(i * 32, i * 32 + 32), w * 32);
        if (outVq && vqLabels) outVq[w] = vqLabels[i];
        w++;
      }
    }
    return { buffer: out.subarray(0, w * 32), count: w, vqLabels: outVq ? outVq.subarray(0, w) : null };
  }

  // ---------- texture generation ----------
  // Build SH centroid GPU texture: 15 RGBA32F texels per centroid (one per SH basis func)
  // texwidth=3840 (=15*256), 256 centroids/row, 256 rows for 65536 centroids
  // texel at (sh_col+k, sh_row): .rgb = [R_coeff_k, G_coeff_k, B_coeff_k]
  function buildShTex(gl, shCentroids, nCent) {
    if (!shCentroids) return null;
    var tw = 15 * 256; // 3840 <= 4096 safe
    var th = Math.ceil(nCent / 256);
    var buf32 = new Float32Array(tw * th * 4);
    for (var ci = 0; ci < nCent; ci++) {
      var sr = ci >> 8;
      var sc = (ci & 0xFF) * 15;
      for (var k = 0; k < 15; k++) {
        var base = ((sr * tw) + sc + k) * 4;
        buf32[base + 0] = shCentroids[ci * 45 + k * 3 + 0];
        buf32[base + 1] = shCentroids[ci * 45 + k * 3 + 1];
        buf32[base + 2] = shCentroids[ci * 45 + k * 3 + 2];
        buf32[base + 3] = 0.0;
      }
    }
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, tw, th, 0, gl.RGBA, gl.FLOAT, buf32);
    if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(tex); return null; }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  function generateTexture(buf, count, vqLabels) {
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    var u = new Uint8Array(buf.buffer, buf.byteOffset, count * 32);
    // ORIGINAL 2-texel format (texwidth=4096) — safe for all GPUs
    var texwidth = 2048 * 2;
    var texheight = Math.ceil((2 * count) / texwidth);
    var texdata = new Uint32Array(texwidth * texheight * 4);
    var texdata_c = new Uint8Array(texdata.buffer);
    var texdata_f = new Float32Array(texdata.buffer);
    for (var i = 0; i < count; i++) {
      // position
      texdata_f[8 * i + 0] = f[8 * i + 0];
      texdata_f[8 * i + 1] = f[8 * i + 1];
      texdata_f[8 * i + 2] = f[8 * i + 2];
      // color at slot 7 — raw SH0 base color (SH1+SH2+SH3 applied on GPU)
      texdata_c[4 * (8 * i + 7) + 0] = u[32 * i + 24 + 0];
      texdata_c[4 * (8 * i + 7) + 1] = u[32 * i + 24 + 1];
      texdata_c[4 * (8 * i + 7) + 2] = u[32 * i + 24 + 2];
      texdata_c[4 * (8 * i + 7) + 3] = u[32 * i + 24 + 3];
      // VQ index for GPU SH lookup (stored in cen.w)
      texdata[8 * i + 3] = vqLabels ? vqLabels[i] : 0;
      // covariance from scale + rotation
      var scale = [f[8 * i + 3], f[8 * i + 4], f[8 * i + 5]];
      var rot = [
        (u[32 * i + 28 + 0] - 128) / 128,
        (u[32 * i + 28 + 1] - 128) / 128,
        (u[32 * i + 28 + 2] - 128) / 128,
        (u[32 * i + 28 + 3] - 128) / 128
      ];
      var M = [
        1.0 - 2.0 * (rot[2] * rot[2] + rot[3] * rot[3]),
        2.0 * (rot[1] * rot[2] + rot[0] * rot[3]),
        2.0 * (rot[1] * rot[3] - rot[0] * rot[2]),
        2.0 * (rot[1] * rot[2] - rot[0] * rot[3]),
        1.0 - 2.0 * (rot[1] * rot[1] + rot[3] * rot[3]),
        2.0 * (rot[2] * rot[3] + rot[0] * rot[1]),
        2.0 * (rot[1] * rot[3] + rot[0] * rot[2]),
        2.0 * (rot[2] * rot[3] - rot[0] * rot[1]),
        1.0 - 2.0 * (rot[1] * rot[1] + rot[2] * rot[2])
      ];
      for (var m = 0; m < 9; m++) M[m] *= scale[Math.floor(m / 3)];
      var sigma = [
        M[0] * M[0] + M[3] * M[3] + M[6] * M[6],
        M[0] * M[1] + M[3] * M[4] + M[6] * M[7],
        M[0] * M[2] + M[3] * M[5] + M[6] * M[8],
        M[1] * M[1] + M[4] * M[4] + M[7] * M[7],
        M[1] * M[2] + M[4] * M[5] + M[7] * M[8],
        M[2] * M[2] + M[5] * M[5] + M[8] * M[8]
      ];
      texdata[8 * i + 4] = packHalf2x16(4 * sigma[0], 4 * sigma[1]);
      texdata[8 * i + 5] = packHalf2x16(4 * sigma[2], 4 * sigma[3]);
      texdata[8 * i + 6] = packHalf2x16(4 * sigma[4], 4 * sigma[5]);
    }
    return { data: texdata, width: texwidth, height: texheight };
  }

  // ---------- depth sort (16-bit counting sort) ----------
  // v1146: scratch buffers are cached and reused across frames. Allocating a fresh
  // Int32Array(count) + two Uint32Array(65536) on every sort (many times/second for
  // a multi-million splat scene) caused heavy GC churn and main-thread stalls — the
  // root cause of the stutter while navigating between points and while recording video.
  var _sortScratch = null;
  function sortSplats(buf, count, viewProj, depthIndex) {
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    if (!_sortScratch || _sortScratch.cap < count) {
      _sortScratch = { sizeList: new Int32Array(count), counts: new Uint32Array(256 * 256), starts: new Uint32Array(256 * 256), cap: count };
    }
    var sizeList = _sortScratch.sizeList;
    var counts0 = _sortScratch.counts;
    var starts0 = _sortScratch.starts;
    var maxDepth = -Infinity, minDepth = Infinity;
    for (var i = 0; i < count; i++) {
      var d = ((viewProj[2] * f[8 * i + 0] + viewProj[6] * f[8 * i + 1] + viewProj[10] * f[8 * i + 2]) * 4096) | 0;
      sizeList[i] = d;
      if (d > maxDepth) maxDepth = d;
      if (d < minDepth) minDepth = d;
    }
    if (!isFinite(maxDepth - minDepth) || maxDepth === minDepth) {
      for (var j = 0; j < count; j++) depthIndex[j] = j;
      return;
    }
    var depthInv = (256 * 256 - 1) / (maxDepth - minDepth);
    counts0.fill(0);
    for (var a = 0; a < count; a++) {
      sizeList[a] = ((sizeList[a] - minDepth) * depthInv) | 0;
      counts0[sizeList[a]]++;
    }
    starts0[0] = 0;
    for (var b = 1; b < 256 * 256; b++) starts0[b] = starts0[b - 1] + counts0[b - 1];
    for (var c = 0; c < count; c++) depthIndex[starts0[sizeList[c]]++] = c;
  }

  // v1146: motion-aware depth-sort cadence (ms). While the camera moves we tolerate a
  // slightly stale splat order to keep the frame rate high (kills nav/video stutter);
  // when the camera is still we re-sort promptly for a crisp image.
  function sortIntervalMs(count, moving) {
    if (!moving) return count > 3000000 ? 55 : 0;
    if (count > 4000000) return 260;
    if (count > 2000000) return 180;
    if (count > 800000) return 110;
    return 45;
  }

  // ---------- walk collision (v1146) ----------
  // Coarse 3D occupancy grid built from splat density so the walking avatar cannot
  // pass through walls/furniture. XZ resolution `cell`, vertical layers `layerH`.
  // A cell is solid when its splat count exceeds an adaptive threshold derived from
  // the mean density of occupied cells (adapts to sparse vs dense scans).
  function buildCollisionGrid(buf, count, bounds, opts) {
    opts = opts || {};
    if (!bounds || !count) return null;
    var lo = bounds.lo, hi = bounds.hi;
    var spanX = Math.max(1e-3, hi[0] - lo[0]);
    var spanY = Math.max(1e-3, hi[1] - lo[1]);
    var spanZ = Math.max(1e-3, hi[2] - lo[2]);
    var cell = opts.cell || Math.min(0.25, Math.max(0.08, (bounds.radius || 10) * 0.006));
    var layerH = opts.layerH || 0.5;
    var nx = Math.max(1, Math.ceil(spanX / cell));
    var nz = Math.max(1, Math.ceil(spanZ / cell));
    var ny = Math.max(1, Math.ceil(spanY / layerH));
    if (nx * nz * ny > 6000000) {
      var sc = Math.cbrt((nx * nz * ny) / 6000000);
      cell *= sc; layerH *= sc;
      nx = Math.max(1, Math.ceil(spanX / cell));
      nz = Math.max(1, Math.ceil(spanZ / cell));
      ny = Math.max(1, Math.ceil(spanY / layerH));
    }
    var counts = new Uint16Array(nx * ny * nz);
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    for (var i = 0; i < count; i++) {
      var gx = ((f[i * 8] - lo[0]) / cell) | 0; if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
      var gy = ((f[i * 8 + 1] - lo[1]) / layerH) | 0; if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
      var gz = ((f[i * 8 + 2] - lo[2]) / cell) | 0; if (gz < 0) gz = 0; else if (gz >= nz) gz = nz - 1;
      var idx = (gy * nz + gz) * nx + gx;
      if (counts[idx] < 65535) counts[idx]++;
    }
    var occVals = [];
    var occupied = 0, sum = 0;
    for (var q = 0; q < counts.length; q++) { if (counts[q]) { occupied++; sum += counts[q]; occVals.push(counts[q]); } }
    var meanOcc = occupied ? sum / occupied : 0;
    // v1147: threshold from the MEDIAN density of occupied cells, not the mean. A few
    // very dense floor/ceiling cells (pipes, ground) skewed the mean so high that thin
    // walls (density ~ the median) fell below it and the walker passed through them.
    var medianOcc = 0;
    if (occVals.length) { occVals.sort(function (a, b) { return a - b; }); medianOcc = occVals[occVals.length >> 1]; }
    var densFrac = (opts.densFrac == null) ? 0.6 : opts.densFrac;
    var thr = Math.max(opts.minAbs || 2, medianOcc * densFrac);
    var solid = new Uint8Array(counts.length);
    for (var s2 = 0; s2 < counts.length; s2++) solid[s2] = counts[s2] >= thr ? 1 : 0;
    return { cell: cell, layerH: layerH, nx: nx, ny: ny, nz: nz, ox: lo[0], oy: lo[1], oz: lo[2], solid: solid, threshold: thr, meanOcc: meanOcc, medianOcc: medianOcc };
  }
  function gridSolidAt(g, gx, gy, gz) {
    if (!g || gx < 0 || gz < 0 || gy < 0 || gx >= g.nx || gz >= g.nz || gy >= g.ny) return false;
    return g.solid[(gy * g.nz + gz) * g.nx + gx] === 1;
  }
  // v1147: highest solid surface at/below probeY in column (x,z). Returns the world Y of
  // that surface top, or null when there is no floor beneath (open void -> avatar falls).
  function groundY(g, x, z, probeY) {
    if (!g) return null;
    if (x < g.ox || x > g.ox + g.nx * g.cell || z < g.oz || z > g.oz + g.nz * g.cell) return null;
    var gx = ((x - g.ox) / g.cell) | 0; if (gx < 0) gx = 0; else if (gx >= g.nx) gx = g.nx - 1;
    var gz = ((z - g.oz) / g.cell) | 0; if (gz < 0) gz = 0; else if (gz >= g.nz) gz = g.nz - 1;
    var top = ((probeY - g.oy) / g.layerH) | 0; if (top >= g.ny) top = g.ny - 1; if (top < 0) return null;
    for (var ly = top; ly >= 0; ly--) {
      if (g.solid[(ly * g.nz + gz) * g.nx + gx] === 1) return g.oy + (ly + 1) * g.layerH;
    }
    return null;
  }
  // v1147: first-person avatar vertical integration (gravity + jump + ground snap).
  var WALK_GRAV = 9.8, WALK_JUMP_V = 4.6, WALK_STEP_UP = 0.6;
  function integrateFall(foot, velY, dt, gnd, jump, onGround) {
    if (jump && onGround) { velY = WALK_JUMP_V; onGround = false; }
    velY -= WALK_GRAV * dt; if (velY < -30) velY = -30;
    var nf = foot + velY * dt;
    if (gnd != null && nf <= gnd) { nf = gnd; velY = 0; onGround = true; }
    else { onGround = false; }
    return { foot: nf, velY: velY, onGround: onGround };
  }
  // Is the body column [yLo,yHi] within `radius` of (x,z) blocked by solid geometry?
  function worldBlocked(g, x, z, yLo, yHi, radius) {
    if (!g) return false;
    radius = radius || 0.28;
    // Outside the scanned footprint counts as solid so the walker can't leave the scene
    // through a boundary (also stops large single steps from skipping over a wall).
    if (x < g.ox || x > g.ox + g.nx * g.cell || z < g.oz || z > g.oz + g.nz * g.cell) return true;
    var gx0 = ((x - radius - g.ox) / g.cell) | 0, gx1 = ((x + radius - g.ox) / g.cell) | 0;
    var gz0 = ((z - radius - g.oz) / g.cell) | 0, gz1 = ((z + radius - g.oz) / g.cell) | 0;
    var gy0 = ((yLo - g.oy) / g.layerH) | 0, gy1 = ((yHi - g.oy) / g.layerH) | 0;
    if (gy1 < gy0) { var t = gy0; gy0 = gy1; gy1 = t; }
    for (var gy = gy0; gy <= gy1; gy++)
      for (var gz = gz0; gz <= gz1; gz++)
        for (var gx = gx0; gx <= gx1; gx++)
          if (gridSolidAt(g, gx, gy, gz)) return true;
    return false;
  }
  // Resolve a horizontal move with wall-sliding ("цепляться за стены"). Returns [x,z].
  function resolveWalk(g, fromX, fromZ, toX, toZ, yLo, yHi, radius) {
    if (!g) return [toX, toZ];
    if (!worldBlocked(g, toX, toZ, yLo, yHi, radius)) return [toX, toZ];
    if (!worldBlocked(g, toX, fromZ, yLo, yHi, radius)) return [toX, fromZ];
    if (!worldBlocked(g, fromX, toZ, yLo, yHi, radius)) return [fromX, toZ];
    return [fromX, fromZ];
  }
  // v1147: choose an interior spawn (like LCC Studio): a tour station near the middle of
  // the route, standing on the LOCAL floor at eye height, facing the room. The old code
  // used the global bbox floor (bounds.lo[1]); in a multi-level scan that put the camera
  // metres off the real floor (spawning near the ceiling). Now we probe the local ground.
  function pickSpawn(stations, bounds, grid, eyeHeight) {
    eyeHeight = eyeHeight || 1.6;
    var c = bounds.center;
    var cx = c[0], cz = c[2];
    if (stations && stations.length) {
      var sx = 0, sz = 0;
      for (var k = 0; k < stations.length; k++) { sx += stations[k].pos[0]; sz += stations[k].pos[2]; }
      cx = sx / stations.length; cz = sz / stations.length;
    }
    function standAt(x, z, yHint) {
      var fy = groundY(grid, x, z, (yHint != null ? yHint : bounds.hi[1]) + WALK_STEP_UP);
      if (fy == null) fy = groundY(grid, x, z, bounds.hi[1]);
      if (fy == null) return null;
      var eyeY = fy + eyeHeight;
      if (grid && worldBlocked(grid, x, z, fy + 0.3, eyeY - 0.1, 0.25)) return null;
      return eyeY;
    }
    if (stations && stations.length) {
      var order = stations.map(function (s, i) { var dx = s.pos[0] - cx, dz = s.pos[2] - cz; return { i: i, d: dx * dx + dz * dz }; })
        .sort(function (a, b) { return a.d - b.d; });
      for (var o = 0; o < order.length; o++) {
        var st = stations[order[o].i];
        var ey = standAt(st.pos[0], st.pos[2], st.pos[1]);
        if (ey != null) {
          var yaw = (order[o].d < 1e-6 && typeof st.yaw === 'number' && isFinite(st.yaw)) ? st.yaw
            : anglesFromDir(normalize([cx - st.pos[0], 0, cz - st.pos[2]])).yaw;
          return { eye: [st.pos[0], ey, st.pos[2]], yaw: yaw, pitch: 0, stationIndex: order[o].i };
        }
      }
    }
    var fey = standAt(cx, cz, null);
    if (fey == null) fey = (grid ? grid.oy : bounds.lo[1]) + eyeHeight;
    return { eye: [cx, fey, cz], yaw: 0, pitch: 0, stationIndex: -1 };
  }

  // ---------- math ----------
  function normalize(v) { var n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function multiply4(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] + a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
    }
    return o;
  }

  // ---------- shaders ----------
  var VS = '#version 300 es\n' +
    'precision highp float;\nprecision highp int;\n' +
    'uniform highp usampler2D u_texture;\n' +
    'uniform sampler2D u_sh;\n' +
    'uniform int uHasSh;\n' +
    'uniform mat4 projection, view;\n' +
    'uniform vec2 focal;\nuniform vec2 viewport;\nuniform float uMaxPx;\nuniform float uSizeMul;\n' +
    'in vec2 position;\nin int index;\n' +
    'out vec4 vColor;\nout vec2 vPosition;\n' +
    'void main () {\n' +
    '  uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x7ffu) << 1, uint(index) >> 11), 0);\n' +
    '  vec4 cam = view * vec4(uintBitsToFloat(cen.xyz), 1);\n' +
'  vec4 pos2d = projection * cam;\n' +
    '  float clip = 1.2 * pos2d.w;\n' +
    '  if (pos2d.z < -clip || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }\n' +
    '  uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x7ffu) << 1) | 1u, uint(index) >> 11), 0);\n' +
    '  vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);\n' +
    '  mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);\n' +
    '  mat3 J = mat3(focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z), 0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z), 0., 0., 0.);\n' +
    '  mat3 T = transpose(mat3(view)) * J;\n' +
    '  mat3 cov2d = transpose(T) * Vrk * T;\n' +
    '  float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;\n' +
    '  float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));\n' +
    '  float lambda1 = mid + radius, lambda2 = mid - radius;\n' +
    '  if(lambda2 < 0.0) return;\n' +
    '  vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));\n' +
    '  float natMaj = sqrt(2.0 * lambda1) * uSizeMul;\n' +
    '  float natMin = sqrt(2.0 * lambda2) * uSizeMul;\n' +
    '  float capMaj = min(natMaj, uMaxPx);\n' +
    '  float capMin = min(natMin, uMaxPx);\n' +
    '  // Коррекция альфы при обрезке (убирает яркий циркульный край)\n' +
    '  float areaRatio = (natMaj * natMin > 1.0) ? (capMaj * capMin) / (natMaj * natMin) : 1.0;\n' +
    '  vec2 majorAxis = capMaj * diagonalVector;\n' +
    '  vec2 minorAxis = capMin * vec2(diagonalVector.y, -diagonalVector.x);\n' +
    '  vColor = clamp(pos2d.z/pos2d.w+1.0, 0.0, 1.0) * vec4(float(cov.w & 0xffu), float((cov.w >> 8) & 0xffu), float((cov.w >> 16) & 0xffu), float((cov.w >> 24) & 0xffu)) / 255.0;\n' +
        '  vColor.a *= areaRatio; // уменьшаем вклад обрезанных гауссиан\n' +
    '  // === Full SH3 view-dependent coloring via VQ centroid texture ===\n' +
    '  if (uHasSh == 1) {\n' +
    '    uint vqIdx = cen.w;\n' +
    '    int sh_row = int(vqIdx) >> 8;\n' +
    '    int sh_col = (int(vqIdx) & 0xFF) * 15;\n' +
    '    vec3 worldPos = uintBitsToFloat(cen.xyz);\n' +
    '    // Derive camera world position from view matrix (guaranteed correct coords)\n' + '    vec3 camWorld = -(transpose(mat3(view)) * vec3(view[3]));\n' + '    vec3 dir = normalize(camWorld - worldPos);\n' +
    '    float dx=dir.x, dy=dir.y, dz=dir.z;\n' +
    '    float xx=dx*dx, yy=dy*dy, zz=dz*dz, xy=dx*dy, xz=dx*dz, yz=dy*dz;\n' +
    '    vec3 p0  = texelFetch(u_sh, ivec2(sh_col+ 0, sh_row), 0).rgb;\n' +
    '    vec3 p1  = texelFetch(u_sh, ivec2(sh_col+ 1, sh_row), 0).rgb;\n' +
    '    vec3 p2  = texelFetch(u_sh, ivec2(sh_col+ 2, sh_row), 0).rgb;\n' +
    '    vec3 p3  = texelFetch(u_sh, ivec2(sh_col+ 3, sh_row), 0).rgb;\n' +
    '    vec3 p4  = texelFetch(u_sh, ivec2(sh_col+ 4, sh_row), 0).rgb;\n' +
    '    vec3 p5  = texelFetch(u_sh, ivec2(sh_col+ 5, sh_row), 0).rgb;\n' +
    '    vec3 p6  = texelFetch(u_sh, ivec2(sh_col+ 6, sh_row), 0).rgb;\n' +
    '    vec3 p7  = texelFetch(u_sh, ivec2(sh_col+ 7, sh_row), 0).rgb;\n' +
    '    vec3 p8  = texelFetch(u_sh, ivec2(sh_col+ 8, sh_row), 0).rgb;\n' +
    '    vec3 p9  = texelFetch(u_sh, ivec2(sh_col+ 9, sh_row), 0).rgb;\n' +
    '    vec3 p10 = texelFetch(u_sh, ivec2(sh_col+10, sh_row), 0).rgb;\n' +
    '    vec3 p11 = texelFetch(u_sh, ivec2(sh_col+11, sh_row), 0).rgb;\n' +
    '    vec3 p12 = texelFetch(u_sh, ivec2(sh_col+12, sh_row), 0).rgb;\n' +
    '    vec3 p13 = texelFetch(u_sh, ivec2(sh_col+13, sh_row), 0).rgb;\n' +
    '    vec3 p14 = texelFetch(u_sh, ivec2(sh_col+14, sh_row), 0).rgb;\n' +
    '    vec3 dRGB = vec3(0.0);\n' +
    '    float C1=0.4886025;\n' +
    '    dRGB += C1*(-dy*p0 + dz*p1 - dx*p2);\n' +
    '    float C2a=1.09255,C2b=-1.09255,C2c=0.31540,C2d=-1.09255,C2e=0.54627;\n' +
    '    dRGB += C2a*xy*p3 + C2b*yz*p4 + C2c*(2.0*zz-xx-yy)*p5 + C2d*xz*p6 + C2e*(xx-yy)*p7;\n' +
    '    float C3a=-0.59004,C3b=2.89061,C3c=-0.45705,C3d=0.37318,C3e=-0.45705,C3f=1.44531,C3g=-0.59004;\n' +
    '    dRGB += C3a*dy*(3.0*xx-yy)*p8 + C3b*xy*dz*p9 + C3c*dy*(4.0*zz-xx-yy)*p10;\n' +
    '    dRGB += C3d*dz*(2.0*zz-3.0*xx-3.0*yy)*p11 + C3e*dx*(4.0*zz-xx-yy)*p12;\n' +
    '    dRGB += C3f*dz*(xx-yy)*p13 + C3g*dx*(xx-3.0*yy)*p14;\n' +
    '    vColor.rgb = clamp(vColor.rgb + dRGB, 0.0, 1.0);\n' +
    '  }\n' +
    '  vPosition = position;\n' +
    '  vec2 vCenter = vec2(pos2d) / pos2d.w;\n' +
    '  gl_Position = vec4(vCenter + position.x * majorAxis / viewport + position.y * minorAxis / viewport, pos2d.z / pos2d.w, 1.0);\n' +
    '}\n';

  var FS = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform float uBright;\nuniform float uSharp;\n' +
    'in vec4 vColor;\nin vec2 vPosition;\nout vec4 fragColor;\n' +
    'void main () {\n' +
    '  float r2 = dot(vPosition, vPosition);\n' +
    '  if (uSharp > 0.5) { if (r2 > 4.0) discard; fragColor = vec4(vColor.rgb * uBright, 1.0); return; }\n' +
    '  if (r2 > 4.0) discard;\n' +
    '  float B = exp(-r2) * vColor.a;\n' +
    '  fragColor = vec4(B * vColor.rgb * uBright, B);\n' +
    '}\n';

  // ---------- point-cloud shaders (быстрый gl.POINTS для сырых XYZ+RGB облаков) ----------
  // У сырого облака нет гауссовой ковариации; рисовать его инстансными квадами с тяжёлым
  // шейдером ковариации (4 вершины/точка) — именно это вешало «Чёткие» на 20М+ точках.
  // gl.POINTS = 1 вершина на точку + лёгкий шейдер -> тянет 100М+ точек без лагов.
  var VS_PTS = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform mat4 projection, view;\n' +
    'uniform float uPtSize;\nuniform float uMaxPx;\nuniform float uFocal;\n' +
    'in vec3 aPos;\nin vec4 aColor;\n' +
    'out vec4 vColor;\nout float vDepth;\n' +
    'void main () {\n' +
    '  vec4 cam = view * vec4(aPos, 1.0);\n' +
    '  gl_Position = projection * cam;\n' +
    '  float d = max(0.05, cam.z);\n' +
    '  float px = uPtSize * uFocal / d;\n' +
    '  gl_PointSize = clamp(px, 1.0, uMaxPx);\n' +
    '  vColor = aColor;\n' +
    '  vDepth = d;\n' +
    '}\n';
  var FS_PTS = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform float uBright;\nuniform float uOutline;\nuniform float uDepthA;\n' +
    'in vec4 vColor;\nin float vDepth;\nout vec4 fragColor;\n' +
    'void main () {\n' +
    '  vec2 dc = gl_PointCoord - vec2(0.5);\n' +
    '  float r2 = dot(dc, dc);\n' +
    '  vec3 col = vColor.rgb * uBright;\n' +
    '  if (uOutline > 0.5 && r2 > 0.18) col = vec3(0.0);\n' +
    '  float a = (uDepthA > 0.5) ? vDepth : 1.0;\n' +
    '  fragColor = vec4(col, a);\n' +
    '}\n';
  // Полноэкранный квадрат для EDL-постобработки.
  var VS_QUAD = '#version 300 es\n' +
    'precision highp float;\n' +
    'in vec2 aXY;\nout vec2 vUv;\n' +
    'void main () { vUv = aXY * 0.5 + 0.5; gl_Position = vec4(aXY, 0.0, 1.0); }\n';
  // Eye-Dome Lighting: затеняет перепады глубины (log2 -> не зависит от масштаба сцены).
  var FS_EDL = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform sampler2D uTex;\nuniform vec2 uTexel;\nuniform float uStrength;\nuniform float uRadius;\n' +
    'in vec2 vUv;\nout vec4 o;\n' +
    'void main () {\n' +
    '  vec4 c = texture(uTex, vUv);\n' +
    '  float z0 = c.a;\n' +
    '  if (z0 >= 9000.0) { o = vec4(0.0); return; }\n' +
    '  float lz0 = log2(z0 + 1e-6);\n' +
    '  vec2 offs[8] = vec2[8](vec2(1.,0.),vec2(-1.,0.),vec2(0.,1.),vec2(0.,-1.),vec2(1.,1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,-1.));\n' +
    '  float sum = 0.0; float n = 0.0;\n' +
    '  for (int i = 0; i < 8; i++) {\n' +
    '    float zn = texture(uTex, vUv + offs[i] * uTexel * uRadius).a;\n' +
    '    if (zn >= 9000.0) continue;\n' +
    '    sum += max(0.0, lz0 - log2(zn + 1e-6));\n' +
    '    n += 1.0;\n' +
    '  }\n' +
    '  float resp = (n > 0.0) ? sum / n : 0.0;\n' +
    '  float shade = exp(-uStrength * resp);\n' +
    '  o = vec4(c.rgb * shade, 1.0);\n' +
    '}\n';

  // ---------- viewer state ----------
  var S = {
    host: null, wrap: null, canvas: null, hud: null, titleEl: null, countEl: null,
    gl: null, program: null, u: {}, indexBuffer: null, texture: null,
    ptProgram: null, ptVAO: null, ptBuf: null, ptU: {}, _ptUploaded: false, ptOutline: false, renderBuf: null, renderCount: 0,
    buf: null, count: 0, depthIndex: null, bounds: null,
    cam: { eye: [0, 0, -5], yaw: 0, pitch: 0, upSign: 1 },
    open: false, raf: 0, needsSort: true, lastKey: '', keys: {}, step: 0.1,
    stations: null, tourIndex: 0, tourActive: false, tween: null, tourNextAt: 0,
    _dwellSet: false, tourBtn: null, kind: 'gaussian', exposure: 1.0, maxPx: 40, sizeMul: 1.0, sharp: false,
    edlOn: true, edlStrength: 30.0, edlRadius: 1.3, edl: null,
    walk: false, walkBtn: null, walkH: 1, lockY: 0, markerWrap: null, markerEls: null,
    vel: [0, 0, 0], moveSpeed: 1, _t: 0, dt: 0.016, zoomVel: 0,
    mmCanvas: null, mmCtx: null, mapBtn: null, tourFileInput: null,
    editMode: false, editBtn: null,
    dwellMs: 2600, moveDurMs: 900, listPanel: null, listBody: null,
    tourLoop: true, showRoute: true, routeCanvas: null, routeCtx: null,
    smoothRoute: true, recRes: 0, recBitrate: 16, recTitles: true,
    recSubtitle: '', recShowDate: false, recLogoImg: null, recLogoUrl: '',
    capFadeMs: 450, _capAlpha: 0, _recDateStr: '',
    recBtn: null, _recording: false, _recorder: null, _recTimer: null,
    _recOff: null, _recOffCtx: null
  };

  function forwardVec() {
    var cp = Math.cos(S.cam.pitch), sp = Math.sin(S.cam.pitch);
    return normalize([cp * Math.sin(S.cam.yaw), sp, cp * Math.cos(S.cam.yaw)]);
  }
  function viewMatrix() {
    var fwd = forwardVec();
    var wup = [0, S.cam.upSign, 0];
    var right = normalize(cross(wup, fwd));
    var up = cross(fwd, right);
    var e = S.cam.eye;
    var m = new Float32Array(16);
    m[0] = right[0]; m[1] = up[0]; m[2] = fwd[0]; m[3] = 0;
    m[4] = right[1]; m[5] = up[1]; m[6] = fwd[1]; m[7] = 0;
    m[8] = right[2]; m[9] = up[2]; m[10] = fwd[2]; m[11] = 0;
    m[12] = -dot(right, e); m[13] = -dot(up, e); m[14] = -dot(fwd, e); m[15] = 1;
    return m;
  }
  function projMatrix(w, h) {
    var fov = 1.1; // radians (~63 deg)
    var fy = 0.5 * h / Math.tan(fov / 2);
    var fx = fy;
    var znear = 0.2, zfar = 500;
    var m = new Float32Array(16);
    m[0] = (2 * fx) / w; m[5] = -(2 * fy) / h;
    m[10] = zfar / (zfar - znear); m[11] = 1;
    m[14] = -(zfar * znear) / (zfar - znear); m[15] = 0;
    return { m: m, fx: fx, fy: fy };
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  function initGL() {
    var gl = S.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true, powerPreference: 'high-performance' });
    if (!gl) { throw new Error('WebGL2 недоступен'); }
    console.log('%c BIM Twin v1148 | GPU SH3 фотореализм ', 'background:#4a90d9;color:white;font-size:14px;padding:4px');
    S.gl = gl;
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    S.program = prog;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    // quad
    var quad = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
    var vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    // index (instanced)
    S.indexBuffer = gl.createBuffer();
    var aIndex = gl.getAttribLocation(prog, 'index');
    gl.bindBuffer(gl.ARRAY_BUFFER, S.indexBuffer);
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribIPointer(aIndex, 1, gl.INT, 0, 0);
    gl.vertexAttribDivisor(aIndex, 1);
    // texture
    S.texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, S.texture);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_texture'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_sh'), 1); // SH centroid texture on TEXTURE1
    S.u.projection = gl.getUniformLocation(prog, 'projection');
    S.u.view = gl.getUniformLocation(prog, 'view');
    S.u.focal = gl.getUniformLocation(prog, 'focal');
    S.u.viewport = gl.getUniformLocation(prog, 'viewport');
    S.u.bright = gl.getUniformLocation(prog, 'uBright');
    S.u.maxpx = gl.getUniformLocation(prog, 'uMaxPx');
    S.u.sizemul = gl.getUniformLocation(prog, 'uSizeMul');
    S.u.sharp = gl.getUniformLocation(prog, 'uSharp');
    // uCamPos replaced by in-shader view matrix extraction
    S.u.hasSh = gl.getUniformLocation(prog, 'uHasSh');

    // Программа точек (gl.POINTS) для сырых облаков — без data-текстуры и без покадровой сортировки.
    var pp = gl.createProgram();
    gl.attachShader(pp, compile(gl, gl.VERTEX_SHADER, VS_PTS));
    gl.attachShader(pp, compile(gl, gl.FRAGMENT_SHADER, FS_PTS));
    gl.linkProgram(pp);
    if (!gl.getProgramParameter(pp, gl.LINK_STATUS)) throw new Error('link pts: ' + gl.getProgramInfoLog(pp));
    S.ptProgram = pp;
    S.ptU = {
      projection: gl.getUniformLocation(pp, 'projection'),
      view: gl.getUniformLocation(pp, 'view'),
      ptSize: gl.getUniformLocation(pp, 'uPtSize'),
      maxPx: gl.getUniformLocation(pp, 'uMaxPx'),
      focal: gl.getUniformLocation(pp, 'uFocal'),
      bright: gl.getUniformLocation(pp, 'uBright'),
      outline: gl.getUniformLocation(pp, 'uOutline'),
      depthA: gl.getUniformLocation(pp, 'uDepthA')
    };
    S.ptBuf = gl.createBuffer();
    S.ptVAO = gl.createVertexArray();
    gl.bindVertexArray(S.ptVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.ptBuf);
    var aP = gl.getAttribLocation(pp, 'aPos');
    var aC = gl.getAttribLocation(pp, 'aColor');
    gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 4, gl.UNSIGNED_BYTE, true, 16, 12);
    gl.bindVertexArray(null);
    gl.useProgram(prog);
    try { initEDL(gl); } catch (e) { S.edl = { ok: false }; }
  }

  // ---------- EDL (Eye-Dome Lighting) post-process ----------
  function initEDL(gl) {
    var e = { ok: false, fbo: null, colorTex: null, depthRb: null, prog: null, u: {}, vao: null, w: 0, h: 0, f32: false };
    S.edl = e;
    try {
      e.f32 = !!gl.getExtension('EXT_color_buffer_float');
      var hf = e.f32 || !!gl.getExtension('EXT_color_buffer_half_float');
      if (!hf) return; // нет float render-target -> EDL выкл, обычная отрисовка
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS_QUAD));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS_EDL));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      e.prog = prog;
      e.u = {
        tex: gl.getUniformLocation(prog, 'uTex'),
        texel: gl.getUniformLocation(prog, 'uTexel'),
        strength: gl.getUniformLocation(prog, 'uStrength'),
        radius: gl.getUniformLocation(prog, 'uRadius')
      };
      var vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      var vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var ap = gl.getAttribLocation(prog, 'aXY');
      gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      e.vao = vao;
      e.ok = true;
    } catch (err) { e.ok = false; }
  }

  function ensureEDLTargets(gl, w, h) {
    var e = S.edl; if (!e || !e.ok) return false;
    if (e.w === w && e.h === h && e.fbo) return true;
    try {
      gl.activeTexture(gl.TEXTURE0);
      if (!e.fbo) e.fbo = gl.createFramebuffer();
      if (!e.colorTex) e.colorTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, e.colorTex);
      var ifmt = e.f32 ? gl.RGBA32F : gl.RGBA16F;
      var typ = e.f32 ? gl.FLOAT : gl.HALF_FLOAT;
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, gl.RGBA, typ, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (!e.depthRb) e.depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, e.depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, e.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, e.colorTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, e.depthRb);
      var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (st !== gl.FRAMEBUFFER_COMPLETE) { e.ok = false; return false; }
      e.w = w; e.h = h;
      return true;
    } catch (err) { e.ok = false; return false; }
  }

  function uploadScene() {
    var gl = S.gl;
    if (S.kind === 'points') {
      // Быстрый путь: грузим череслоённый 32B-буфер один раз и рисуем через gl.POINTS.
      // Нет текстуры ковариации и нет покадровой сортировки — экономия памяти/CPU,
      // что и позволяет показать всё облако (100М+) без зависаний.
      gl.bindBuffer(gl.ARRAY_BUFFER, S.ptBuf);
      gl.bufferData(gl.ARRAY_BUFFER, S.renderBuf || S.buf, gl.STATIC_DRAW);
      S._ptUploaded = true;
      S.needsSort = false;
      return;
    }
    var tex = generateTexture(S.buf, S.count, S.vqLabels);
    // Build SH centroid texture if data available
    if (S.shCentroids && !S.shTex) {
      S.shTex = buildShTex(gl, S.shCentroids, 65536);
      if (S.shTex) console.log('[SH3] GPU SH3 texture OK: 65536 centroids x 45 SH coefficients');
      else console.error('[SH3] ERROR: SH texture creation failed (check GPU RGBA32F support)');
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, S.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, tex.width, tex.height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, tex.data);
    S.depthIndex = new Uint32Array(S.count);
    for (var i = 0; i < S.count; i++) S.depthIndex[i] = i;
    S._idxUploaded = false;
    S.needsSort = true;
  }

  function resize() {
    if (!S.canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(S.wrap.clientWidth * dpr));
    var h = Math.max(1, Math.floor(S.wrap.clientHeight * dpr));
    if (S.canvas.width !== w || S.canvas.height !== h) {
      S.canvas.width = w; S.canvas.height = h;
    }
  }

  function drawPointCloud(proj, view, w, h) {
    var gl = S.gl;
    if (!S.ptProgram || !S._ptUploaded || (S.renderCount || S.count) <= 0) return;
    // EDL включается только в чётком режиме и если float-буфер доступен (иначе — обычная отрисовка).
    var useEDL = !!(S.edlOn && S.edl && S.edl.ok && S.sharp);
    if (useEDL) useEDL = ensureEDLTargets(gl, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, useEDL ? S.edl.fbo : null);
    gl.viewport(0, 0, w, h);
    // Глубина вкл, непрозрачно, без бленда -> корректное перекрытие и нулевой овердро.
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND);
    if (useEDL) { gl.clearColor(0, 0, 0, 1e4); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); }
    else { gl.clear(gl.DEPTH_BUFFER_BIT); }
    gl.useProgram(S.ptProgram);
    gl.uniformMatrix4fv(S.ptU.projection, false, proj.m);
    gl.uniformMatrix4fv(S.ptU.view, false, view);
    gl.uniform1f(S.ptU.focal, proj.fy);
    gl.uniform1f(S.ptU.bright, S.exposure || 1.0);
    // Базовый мировой размер точки от размаха сцены, масштабируется ползунком «Точки».
    var r = (S.bounds && S.bounds.radius) ? S.bounds.radius : 1;
    var world = r * 0.006 * (S.sizeMul || 0.35) * (S.sharp ? 0.55 : 1.1);
    gl.uniform1f(S.ptU.ptSize, world);
    gl.uniform1f(S.ptU.maxPx, S.sharp ? 3.0 : 7.0);
    gl.uniform1f(S.ptU.outline, S.ptOutline ? 1.0 : 0.0);
    if (S.ptU.depthA) gl.uniform1f(S.ptU.depthA, useEDL ? 1.0 : 0.0);
    gl.bindVertexArray(S.ptVAO);
    gl.drawArrays(gl.POINTS, 0, S.renderCount || S.count);
    gl.bindVertexArray(null);
    if (useEDL) {
      // Постобработка EDL: читаем цвет+глубину из FBO и затеняем перепады.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(S.edl.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, S.edl.colorTex);
      gl.uniform1i(S.edl.u.tex, 0);
      gl.uniform2f(S.edl.u.texel, 1.0 / w, 1.0 / h);
      gl.uniform1f(S.edl.u.strength, S.edlStrength || 30.0);
      gl.uniform1f(S.edl.u.radius, Math.max(1.0, S.edlRadius || 1.3));
      gl.bindVertexArray(S.edl.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }
    gl.useProgram(S.program);
  }

  function frame() {
    if (!S.open) return;
    var gl = S.gl;
    var _now = nowMs();
    S.dt = S._t ? Math.min(0.05, (_now - S._t) / 1000) : 0.016;
    S._t = _now;
    resize();
    updateTween();
    updateTour();
    var w = S.canvas.width, h = S.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    if (S.sharp) {
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    // keyboard movement
    applyKeys();
    updateZoom(S.dt);
    var proj = projMatrix(w, h);
    var view = viewMatrix();
    var vp = multiply4(proj.m, view);
    if (S.kind === 'points') {
      drawPointCloud(proj, view, w, h);
    } else {
      if (S.sharp) {
        if (!S._idxUploaded && S.count > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, S.indexBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, S.depthIndex, gl.DYNAMIC_DRAW);
          S._idxUploaded = true;
        }
      } else if (S.count > 0) {
        var _nowS = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var _mv = !!(S.tween || S.tourActive || S._recording || (S.vel && (Math.abs(S.vel[0]) + Math.abs(S.vel[1]) + Math.abs(S.vel[2]) > 1e-3)) || (S.zoomVel && Math.abs(S.zoomVel) > 1e-3));
        // v1148: only re-sort when the camera pose actually changed enough to matter (or an
        // explicit invalidation set needsSort). Skipping full-scene radix sorts on sub-pixel
        // drift removes the periodic hitching/stutter on multi-million-splat scans.
        var _sp0 = S._sortedPose;
        var _posThr = (S.bounds ? S.bounds.radius * 0.0015 : 0.02);
        var _poseMoved = !_sp0 ||
          (Math.abs(S.cam.eye[0] - _sp0.e0) + Math.abs(S.cam.eye[1] - _sp0.e1) + Math.abs(S.cam.eye[2] - _sp0.e2)) > _posThr ||
          Math.abs(S.cam.yaw - _sp0.yaw) > 0.02 || Math.abs(S.cam.pitch - _sp0.pitch) > 0.02;
        if ((S.needsSort || _poseMoved) && (!S._lastSortT || (_nowS - S._lastSortT) >= sortIntervalMs(S.count, _mv))) {
          sortSplats(S.buf, S.count, vp, S.depthIndex);
          gl.bindBuffer(gl.ARRAY_BUFFER, S.indexBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, S.depthIndex, gl.DYNAMIC_DRAW);
          S._lastSortT = _nowS;
          S._sortedPose = { e0: S.cam.eye[0], e1: S.cam.eye[1], e2: S.cam.eye[2], yaw: S.cam.yaw, pitch: S.cam.pitch };
          S.needsSort = false;
        }
      }
      gl.useProgram(S.program);
      gl.uniformMatrix4fv(S.u.projection, false, proj.m);
      gl.uniformMatrix4fv(S.u.view, false, view);
      gl.uniform2f(S.u.focal, proj.fx, proj.fy);
      gl.uniform2f(S.u.viewport, w, h);
      gl.uniform1f(S.u.bright, S.exposure || 1.0);
      gl.uniform1f(S.u.maxpx, S.sharp ? Math.min(S.maxPx || 40, 20.0) : (S.maxPx || 40));
      gl.uniform1f(S.u.sizemul, S.sizeMul || 0.55);
      gl.uniform1f(S.u.sharp, S.sharp ? 1.0 : 0.0);
      // Full SH3 view-dependent: bind centroid texture to TEXTURE1
      if (S.shTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, S.shTex);
        gl.activeTexture(gl.TEXTURE0); // restore
        gl.uniform1i(S.u.hasSh, 1);
      } else {
        gl.uniform1i(S.u.hasSh, 0);
      }
      // camPos is now derived in shader from view matrix
      if (S.count > 0) gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, S.count);
    }
    if (S._recOff) captureFrame();
    updateMarkers(vp);
    // v1148: the minimap is a 2D-canvas redraw; throttle to ~15 fps so it never competes
    // with the splat render for main-thread time on large scenes.
    if (!S._mmT || (_now - S._mmT) > 66) { drawMinimap(); S._mmT = _now; }
    S.raf = requestAnimationFrame(frame);
  }

  function applyKeys() {
    var dt = S.dt || 0.016;
    var anyKey = S.keys['w'] || S.keys['a'] || S.keys['s'] || S.keys['d'] || S.keys['q'] || S.keys['e'];
    if (anyKey) { S.tween = null; cancelTour(); }
    var fwd = forwardVec();
    var wup = [0, S.cam.upSign, 0];
    var right = normalize(cross(wup, fwd));
    if (S.walk) {
      fwd = normalize([fwd[0], 0, fwd[2]]);
      right = normalize([right[0], 0, right[2]]);
    }
    var dir = [0, 0, 0];
    if (S.keys['w']) { dir[0] += fwd[0]; dir[1] += fwd[1]; dir[2] += fwd[2]; }
    if (S.keys['s']) { dir[0] -= fwd[0]; dir[1] -= fwd[1]; dir[2] -= fwd[2]; }
    if (S.keys['d']) { dir[0] += right[0]; dir[1] += right[1]; dir[2] += right[2]; }
    if (S.keys['a']) { dir[0] -= right[0]; dir[1] -= right[1]; dir[2] -= right[2]; }
    if (!S.walk) { if (S.keys['q']) dir[1] += 1; if (S.keys['e']) dir[1] -= 1; }
    var dl = Math.hypot(dir[0], dir[1], dir[2]);
    var boost = S.keys['shift'] ? 2.4 : 1;
    var speed = (S.moveSpeed || (S.step * 14)) * boost;
    var target = dl > 1e-6 ? [dir[0] / dl * speed, dir[1] / dl * speed, dir[2] / dl * speed] : [0, 0, 0];
    var rate = dl > 1e-6 ? 9 : 7;
    S.vel = stepVelocity(S.vel, target, rate, dt);
    var vlen = Math.hypot(S.vel[0], S.vel[1], S.vel[2]);
    if (S.walk) {
      // First-person avatar: horizontal move with wall-sliding, then gravity/jump on Y.
      var moved = false;
      if (vlen >= speed * 0.003) {
        var _pfx = S.cam.eye[0], _pfz = S.cam.eye[2];
        S.cam.eye[0] += S.vel[0] * dt; S.cam.eye[2] += S.vel[2] * dt;
        if (S.collision) {
          var _ey = S.cam.eye[1], _eh = S.eyeH || 1.6;
          var _r = resolveWalk(S.collision, _pfx, _pfz, S.cam.eye[0], S.cam.eye[2], _ey - _eh + 0.35, _ey - 0.1, S.playerRadius || 0.28);
          S.cam.eye[0] = _r[0]; S.cam.eye[2] = _r[1];
        }
        moved = true;
      } else { S.vel[0] = 0; S.vel[2] = 0; }
      S.vel[1] = 0;
      if (!S.tween && !S.tourActive) { var _by = S.cam.eye[1]; walkVertical(dt); if (Math.abs(S.cam.eye[1] - _by) > 1e-5) moved = true; }
      if (moved) S.needsSort = true;
      return;
    }
    if (vlen < speed * 0.003) { S.vel = [0, 0, 0]; return; }
    S.cam.eye[0] += S.vel[0] * dt; S.cam.eye[1] += S.vel[1] * dt; S.cam.eye[2] += S.vel[2] * dt;
    S.needsSort = true;
  }
  // v1147: avatar gravity/jump/ground-follow. Runs each frame in walk mode (even when
  // standing still) so the player is pulled to the floor and can jump (Space) / run (Shift).
  function walkVertical(dt) {
    var g = S.collision, eh = S.eyeH || 1.6;
    var foot = S.cam.eye[1] - eh;
    var gnd = g ? groundY(g, S.cam.eye[0], S.cam.eye[2], foot + WALK_STEP_UP) : null;
    var r = integrateFall(foot, S.velY || 0, dt, gnd, !!S.keys['jump'], !!S.onGround);
    var nf = r.foot; S.velY = r.velY; S.onGround = r.onGround;
    if (gnd == null && g && nf < g.oy) { nf = g.oy; S.velY = 0; S.onGround = true; }
    // stop the head from punching up through a ceiling
    if (g && S.velY > 0) {
      var head = nf + eh;
      if (worldBlocked(g, S.cam.eye[0], S.cam.eye[2], head - 0.05, head + 0.05, (S.playerRadius || 0.28) * 0.5)) { S.velY = 0; nf = foot; }
    }
    S.cam.eye[1] = nf + eh;
    S.lockY = S.cam.eye[1];
  }

  // ---------- camera tweening, picking & tour stations ----------
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function angleLerp(a, b, t) { var d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }
  function anglesFromDir(dir) { var d = normalize(dir); var pitch = Math.asin(Math.max(-1, Math.min(1, d[1]))); var yaw = Math.atan2(d[0], d[2]); return { yaw: yaw, pitch: pitch }; }
  function forwardVecOf(cam) { var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch); return normalize([cp * Math.sin(cam.yaw), sp, cp * Math.cos(cam.yaw)]); }
  function d2(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return dx * dx + dy * dy + dz * dz; }

  // Screen pixel -> world-space ray direction (matches projMatrix fov/aspect convention)
  function screenRayDir(mx, my, vw, vh, cam, fov) {
    var ndcX = (2 * mx / vw) - 1;
    var ndcY = (2 * my / vh) - 1;
    var t = Math.tan((fov || 1.1) / 2);
    var aspect = vw / vh;
    var dcx = ndcX * aspect * t;
    var dcy = -ndcY * t;
    var fwd = forwardVecOf(cam);
    var wup = [0, cam.upSign, 0];
    var right = normalize(cross(wup, fwd));
    var up = cross(fwd, right);
    return normalize([
      right[0] * dcx + up[0] * dcy + fwd[0],
      right[1] * dcx + up[1] * dcy + fwd[1],
      right[2] * dcx + up[2] * dcy + fwd[2]
    ]);
  }

  // Nearest splat along a ray using an angular cone test. Returns {index,t,point} or null.
  function raycastNearest(buf, count, eye, dir, angTan) {
    angTan = angTan || 0.02;
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    var best = -1, bestT = Infinity;
    for (var i = 0; i < count; i++) {
      var px = f[i * 8] - eye[0], py = f[i * 8 + 1] - eye[1], pz = f[i * 8 + 2] - eye[2];
      var t = px * dir[0] + py * dir[1] + pz * dir[2];
      if (t <= 0 || t >= bestT) continue;
      var perp2 = (px * px + py * py + pz * pz) - t * t;
      var lim = t * angTan;
      if (perp2 <= lim * lim) { bestT = t; best = i; }
    }
    if (best < 0) return null;
    return { index: best, t: bestT, point: [f[best * 8], f[best * 8 + 1], f[best * 8 + 2]] };
  }

  // Farthest-point sampling of k well-separated tour stations from a subsample of splats.
  function computeStations(buf, count, k, bounds) {
    k = k || 8;
    if (!count) return [];
    var f = new Float32Array(buf.buffer, buf.byteOffset, count * 8);
    var m = Math.min(count, 8000);
    var stride = Math.max(1, Math.floor(count / m));
    var raw = [];
    for (var i = 0; i < count; i += stride) raw.push([f[i * 8], f[i * 8 + 1], f[i * 8 + 2]]);
    if (raw.length <= k) return raw.map(function (p) { return { pos: p }; });
    // Center + vertical extent (prefer robust bounds; fall back to sample stats).
    var cen, floorY, height;
    if (bounds && bounds.center) { cen = bounds.center; floorY = bounds.lo[1]; height = Math.max(1e-3, bounds.hi[1] - bounds.lo[1]); }
    else {
      cen = [0, 0, 0]; var miny = Infinity, maxy = -Infinity;
      for (var s = 0; s < raw.length; s++) { cen[0] += raw[s][0]; cen[1] += raw[s][1]; cen[2] += raw[s][2]; if (raw[s][1] < miny) miny = raw[s][1]; if (raw[s][1] > maxy) maxy = raw[s][1]; }
      cen[0] /= raw.length; cen[1] /= raw.length; cen[2] /= raw.length; floorY = miny; height = Math.max(1e-3, maxy - miny);
    }
    var eyeY = floorY + height * 0.45;
    // Even ground coverage: farthest-point sampling over the XZ footprint of inlier points.
    // Distributing on the floor plane (ignoring height) spreads stations evenly across the scene
    // instead of clustering by elevation; dropping the far 25% by horizontal distance removes stray edges.
    function d2xz(a, b) { var dx = a[0] - b[0], dz = a[2] - b[2]; return dx * dx + dz * dz; }
    var dxz = raw.map(function (p) { return { p: p, d: d2xz(p, cen) }; });
    var sorted = dxz.slice().sort(function (a, b) { return a.d - b.d; });
    var thr = sorted[Math.floor(0.75 * (sorted.length - 1))].d;
    var pts = [];
    for (var j = 0; j < dxz.length; j++) if (dxz[j].d <= thr) pts.push(dxz[j].p);
    if (pts.length <= k) { pts = raw.slice(); }
    var seed = 0, sd = Infinity;
    for (var q = 0; q < pts.length; q++) { var qd = d2xz(pts[q], cen); if (qd < sd) { sd = qd; seed = q; } }
    var chosen = [seed];
    var dist = new Array(pts.length);
    for (var a = 0; a < pts.length; a++) dist[a] = d2xz(pts[a], pts[seed]);
    while (chosen.length < k && chosen.length < pts.length) {
      var far = 0, fd = -1;
      for (var b = 0; b < pts.length; b++) { if (dist[b] > fd) { fd = dist[b]; far = b; } }
      chosen.push(far);
      for (var c = 0; c < pts.length; c++) { var dd = d2xz(pts[c], pts[far]); if (dd < dist[c]) dist[c] = dd; }
    }
    // Precise per-station height: snap each station to its LOCAL floor (sample nearby points),
    // so markers sit on the geometry instead of floating on one mid-height plane ("этажами").
    var neighR2 = thr * 0.09;
    var eyeOff = height * 0.08;
    return chosen.map(function (idx) {
      var cxp = pts[idx][0], czp = pts[idx][2], ys = [];
      for (var u = 0; u < raw.length; u++) { var ex = raw[u][0] - cxp, ez = raw[u][2] - czp; if (ex * ex + ez * ez <= neighR2) ys.push(raw[u][1]); }
      var gy;
      if (ys.length >= 4) { ys.sort(function (a2, b2) { return a2 - b2; }); gy = ys[Math.floor(0.12 * (ys.length - 1))] + eyeOff; }
      else { gy = eyeY; }
      return { pos: [cxp, gy, czp] };
    });
  }

  function startTween(toEye, toYaw, toPitch, dur, onDone) {
    S.vel = [0, 0, 0];
    S.zoomVel = 0;
    S.tween = {
      fromEye: S.cam.eye.slice(), toEye: toEye,
      fromYaw: S.cam.yaw, toYaw: toYaw,
      fromPitch: S.cam.pitch, toPitch: toPitch,
      t0: nowMs(), dur: dur || 800, onDone: onDone || null
    };
  }
  function updateTween() {
    if (!S.tween) return;
    var tw = S.tween;
    var k = Math.min(1, (nowMs() - tw.t0) / tw.dur);
    var e = easeInOut(k);
    S.cam.eye = lerp3(tw.fromEye, tw.toEye, e);
    S.cam.yaw = angleLerp(tw.fromYaw, tw.toYaw, e);
    S.cam.pitch = tw.fromPitch + (tw.toPitch - tw.fromPitch) * e;
    S.needsSort = true;
    if (k >= 1) { var cb = tw.onDone; S.tween = null; if (cb) cb(); }
  }
  function updateTour() {
    if (!S.tourActive) return;
    if (S.tween) { S._dwellSet = false; return; }
    if (!S._dwellSet) { S.tourNextAt = nowMs() + (S.dwellMs || 2600); S._dwellSet = true; return; }
    if (nowMs() >= S.tourNextAt) {
      S._dwellSet = false;
      var next = S.tourIndex + 1;
      if (!S.tourLoop && next >= S.stations.length) { setTour(false); toast('Тур завершён'); return; }
      goToStation(next);
    }
  }
  function teleportTo(point, dir) {
    if (!S.bounds) return;
    if (S.walk) {
      var _tg = S.collision ? groundY(S.collision, point[0], point[2], S.bounds.hi[1]) : null;
      var _ty = (_tg != null) ? _tg + (S.eyeH || 1.6) : S.cam.eye[1];
      startTween([point[0], _ty, point[2]], S.cam.yaw, S.cam.pitch, 650);
      return;
    }
    var standoff = Math.max(S.bounds.radius * 0.12, 1e-3);
    var toEye = [point[0] - dir[0] * standoff, point[1] - dir[1] * standoff, point[2] - dir[2] * standoff];
    startTween(toEye, S.cam.yaw, S.cam.pitch, 650);
  }
  function goToStation(i) {
    if (!S.stations || !S.stations.length || !S.bounds) return;
    var n = S.stations.length;
    S.tourIndex = ((i % n) + n) % n;
    var st = S.stations[S.tourIndex];
    var hasAngle = typeof st.yaw === 'number' && isFinite(st.yaw);
    var c = S.bounds.center;
    if (S.walk) {
      var yaw = hasAngle ? st.yaw : anglesFromDir(normalize([c[0] - st.pos[0], 0, c[2] - st.pos[2]])).yaw;
      var _sg = S.collision ? groundY(S.collision, st.pos[0], st.pos[2], S.bounds.hi[1]) : null;
      var _sy = (_sg != null) ? _sg + (S.eyeH || 1.6) : S.cam.eye[1];
      startTween([st.pos[0], _sy, st.pos[2]], yaw, 0, (S.moveDurMs || 900));
      return;
    }
    if (hasAngle) {
      var pitch = (typeof st.pitch === 'number' && isFinite(st.pitch)) ? st.pitch : 0;
      startTween([st.pos[0], st.pos[1], st.pos[2]], st.yaw, pitch, (S.moveDurMs || 900));
      return;
    }
    var toCenter = normalize([c[0] - st.pos[0], c[1] - st.pos[1], c[2] - st.pos[2]]);
    var inset = S.bounds.radius * 0.08;
    var eye = [st.pos[0] + toCenter[0] * inset, st.pos[1] + toCenter[1] * inset, st.pos[2] + toCenter[2] * inset];
    var ang = anglesFromDir(toCenter);
    startTween(eye, ang.yaw, ang.pitch, (S.moveDurMs || 900));
  }
  function nextStation() { if (S.stations && S.stations.length) goToStation(S.tourIndex + 1); }
  function overview() {
    var b = S.bounds; if (!b) return;
    startTween([b.center[0], b.center[1], b.center[2] - b.radius * 1.4], 0, 0, 800);
  }
  function setTour(on) {
    S.tourActive = !!on;
    if (S.tourBtn) setBtn(S.tourBtn, S.tourActive ? 'pause' : 'play', 'Тур');
    if (S.tourActive) { S._dwellSet = false; startTourIntro(); }
  }
  function startTourIntro() {
    if (!S.bounds || !S.stations || !S.stations.length) return;
    var n = S.stations.length;
    var idx = (((S.tourIndex || 0) % n) + n) % n;
    if (S.walk) { goToStation(idx); return; }
    var st = S.stations[idx];
    var up = S.cam.upSign;
    var lift = S.bounds.radius * 0.25;
    var mid = [
      (S.cam.eye[0] + st.pos[0]) / 2,
      Math.max(S.cam.eye[1], st.pos[1]) + up * lift,
      (S.cam.eye[2] + st.pos[2]) / 2
    ];
    var look = anglesFromDir([st.pos[0] - mid[0], st.pos[1] - mid[1], st.pos[2] - mid[2]]);
    startTween(mid, look.yaw, look.pitch, Math.round((S.moveDurMs || 900) * 0.78), function () { if (S.tourActive) goToStation(idx); });
  }
  function cancelTour() { if (S.tourActive) setTour(false); }

  // ---------- walk mode (eye-height, floor-locked) ----------
  function floorLevel() { return S.cam.upSign > 0 ? S.bounds.lo[1] : S.bounds.hi[1]; }
  function computeLockY() { return floorLevel() + S.cam.upSign * S.walkH; }
  function setWalk(on) {
    if (!S.bounds) return;
    S.walk = !!on;
    if (S.walkBtn) S.walkBtn.style.background = S.walk ? '#2563eb' : '#2a2f3a';
    if (S.walk) {
      // Entering avatar mode: drop onto the local floor at eye height, reset fall state.
      S.velY = 0; S.onGround = false;
      var fy = S.collision ? groundY(S.collision, S.cam.eye[0], S.cam.eye[2], S.cam.eye[1] + WALK_STEP_UP) : null;
      if (fy == null && S.collision) fy = groundY(S.collision, S.cam.eye[0], S.cam.eye[2], S.bounds.hi[1]);
      var ey = (fy != null) ? fy + (S.eyeH || 1.6) : S.cam.eye[1];
      S.lockY = ey;
      startTween([S.cam.eye[0], ey, S.cam.eye[2]], S.cam.yaw, 0, 400);
    }
  }

  // ---------- 3D->screen projection + tour markers ----------
  function projectPoint(p, vp) {
    var x = p[0], y = p[1], z = p[2];
    var cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    var cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    var cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 1e-6) return null;
    return { x: cx / cw, y: cy / cw, w: cw };
  }
  function miniBtn(t) {
    var b = document.createElement('button');
    b.textContent = t;
    b.style.cssText = 'flex:none;width:22px;height:22px;background:#2a2f3a;border:1px solid #7fb6ff;border-radius:4px;color:#fff;cursor:pointer;font:12px sans-serif;padding:0';
    return b;
  }
  function moveStation(from, to) {
    S.stations = withStationMoved(S.stations, from, to);
    if (S.tourIndex === from) S.tourIndex = to; else if (S.tourIndex === to) S.tourIndex = from;
    buildMarkers();
  }
  function renderStationList() {
    var body = S.listBody; if (!body) return;
    body.innerHTML = '';
    var sts = S.stations || [];
    if (!sts.length) {
      var empty = document.createElement('div');
      empty.textContent = 'Нет точек. Добавьте кнопкой ➕ Точка.';
      empty.style.cssText = 'opacity:.6;padding:6px 2px;font-size:12px';
      body.appendChild(empty); return;
    }
    for (var i = 0; i < sts.length; i++) {
      (function (idx) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:3px 0;border-top:1px solid rgba(127,182,255,.12)';
        var num = document.createElement('span'); num.textContent = (idx + 1) + '.'; num.style.cssText = 'opacity:.7;width:18px;flex:none;text-align:right';
        var nameBtn = document.createElement('button');
        nameBtn.textContent = sts[idx].name || ('Точка ' + (idx + 1));
        nameBtn.title = 'Перейти к точке';
        nameBtn.style.cssText = 'flex:1;min-width:0;text-align:left;background:transparent;border:none;color:#e6edf3;cursor:pointer;font:13px sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 2px';
        nameBtn.onclick = function () { cancelTour(); S.tourIndex = idx; goToStation(idx); };
        var upB = miniBtn('↑'); upB.onclick = function () { moveStation(idx, idx - 1); };
        var dnB = miniBtn('↓'); dnB.onclick = function () { moveStation(idx, idx + 1); };
        var delB = miniBtn('✕'); delB.style.background = '#a33'; delB.onclick = function () { S.stations = withStationRemoved(S.stations, idx); if (S.tourIndex >= S.stations.length) S.tourIndex = 0; buildMarkers(); };
        row.appendChild(num); row.appendChild(nameBtn); row.appendChild(upB); row.appendChild(dnB); row.appendChild(delB);
        body.appendChild(row);
      })(i);
    }
  }

  function closeStationMenu() {
    if (S.ctxMenu && S.ctxMenu.parentNode) S.ctxMenu.parentNode.removeChild(S.ctxMenu);
    S.ctxMenu = null;
    if (S._ctxOutside) { document.removeEventListener('mousedown', S._ctxOutside, true); S._ctxOutside = null; }
  }
  function showStationMenu(idx, clientX, clientY) {
    closeStationMenu();
    if (!S.stations || !S.stations[idx] || !S.wrap) return;
    var r = S.wrap.getBoundingClientRect();
    var menu = document.createElement('div');
    menu.style.cssText = 'position:absolute;z-index:60;min-width:180px;background:rgba(16,20,28,.97);border:1px solid rgba(127,182,255,.4);border-radius:9px;padding:5px;box-shadow:0 6px 22px rgba(0,0,0,.6);font:13px sans-serif;color:#e6edf3;pointer-events:auto';
    var nm0 = S.stations[idx].name || ('\u0422\u043e\u0447\u043a\u0430 ' + (idx + 1));
    var hdr = document.createElement('div');
    hdr.textContent = nm0;
    hdr.style.cssText = 'font-weight:700;padding:4px 8px 6px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px';
    menu.appendChild(hdr);
    function item(label, danger, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'display:block;width:100%;text-align:left;background:transparent;border:none;border-radius:6px;color:' + (danger ? '#ff8080' : '#e6edf3') + ';cursor:pointer;font:13px sans-serif;padding:7px 8px';
      b.onmouseenter = function () { b.style.background = danger ? 'rgba(220,60,60,.18)' : 'rgba(127,182,255,.16)'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = function (ev) { ev.stopPropagation(); closeStationMenu(); fn(); };
      menu.appendChild(b);
    }
    item('\u25b6  \u041f\u0435\u0440\u0435\u0439\u0442\u0438 \u0441\u044e\u0434\u0430', false, function () { cancelTour(); S.tourIndex = idx; goToStation(idx); });
    item('\u270f  \u041f\u0435\u0440\u0435\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u0442\u044c', false, function () {
      promptModal('\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0442\u043e\u0447\u043a\u0438:', nm0).then(function (nm) {
        if (nm === null) return;
        if (nm.trim() === '') { S.stations = withStationRemoved(S.stations, idx); if (S.tourIndex >= S.stations.length) S.tourIndex = 0; toast('\u0422\u043e\u0447\u043a\u0430 \u0443\u0434\u0430\u043b\u0435\u043d\u0430'); }
        else { S.stations = withStationRenamed(S.stations, idx, nm.trim()); toast('\u041f\u0435\u0440\u0435\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u043e'); }
        buildMarkers();
      });
    });
    item('\ud83d\uddd1  \u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0442\u043e\u0447\u043a\u0443', true, function () {
      S.stations = withStationRemoved(S.stations, idx);
      if (S.tourIndex >= S.stations.length) S.tourIndex = 0;
      buildMarkers();
      toast('\u0422\u043e\u0447\u043a\u0430 \u0443\u0434\u0430\u043b\u0435\u043d\u0430');
    });
    menu.style.left = Math.max(4, Math.min(clientX - r.left, r.width - 190)) + 'px';
    menu.style.top = Math.max(4, Math.min(clientY - r.top, r.height - 160)) + 'px';
    S.wrap.appendChild(menu);
    S.ctxMenu = menu;
    S._ctxOutside = function (ev) { if (S.ctxMenu && !S.ctxMenu.contains(ev.target)) closeStationMenu(); };
    setTimeout(function () { document.addEventListener('mousedown', S._ctxOutside, true); }, 0);
  }

  function buildMarkers() {
    if (!S.markerWrap) return;
    closeStationMenu();
    S.markerWrap.innerHTML = '';
    S.markerEls = [];
    if (!S.stations) return;
    for (var i = 0; i < S.stations.length; i++) {
      (function (idx) {
        var el = document.createElement('button');
        el.textContent = String(idx + 1);
        el.title = (S.stations[idx] && S.stations[idx].name) ? S.stations[idx].name : ('Точка ' + (idx + 1));
        el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;border:2px solid #fff;background:rgba(20,110,220,.85);color:#fff;font:bold 12px sans-serif;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.5);display:none;padding:0';
        el.onclick = function (ev) { ev.stopPropagation(); if (S.editMode) { editStationPrompt(idx); } else { cancelTour(); goToStation(idx); } };
        el.oncontextmenu = function (ev) { ev.preventDefault(); ev.stopPropagation(); showStationMenu(idx, ev.clientX, ev.clientY); };
        S.markerWrap.appendChild(el);
        S.markerEls.push(el);
      })(i);
    }
    if (S.listPanel) renderStationList();
    persistStations();
  }
  function updateMarkers(vp) {
    if (!S.markerEls || !S.markerWrap || !S.stations) return;
    var cw = S.wrap.clientWidth, ch = S.wrap.clientHeight;
    var eye = (S.cam && S.cam.eye) ? S.cam.eye : [0, 0, 0];
    var ref = (S.bounds && S.bounds.radius) ? S.bounds.radius : 10;
    var topBand = 54;   // keep markers below the HUD toolbar strip so they never spill onto it
    var pts = [];
    for (var i = 0; i < S.markerEls.length; i++) {
      var el = S.markerEls[i], st = S.stations[i];
      var pr = projectPoint(st.pos, vp);
      // behind the camera -> not visible
      if (!pr || pr.w <= 0) { el.style.display = 'none'; pts.push(null); continue; }
      var sx = (pr.x * 0.5 + 0.5) * cw;
      var sy = (0.5 - pr.y * 0.5) * ch;
      pts.push({ x: sx, y: sy });
      // off-screen or inside the toolbar band -> hide (no bleeding onto the UI)
      if (sx < -40 || sx > cw + 40 || sy < topBand || sy > ch + 40) { el.style.display = 'none'; continue; }
      // distance from camera: scale + fade like pro tour viewers (Matterport uses size ~ 1/distance),
      // so far markers / markers on other floors shrink and fade instead of stacking in layers.
      var dx = st.pos[0] - eye[0], dy = st.pos[1] - eye[1], dz = st.pos[2] - eye[2];
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      if (dist > ref * 6) { el.style.display = 'none'; continue; }   // far/other-floor clutter
      var t = ref / dist;
      var size = Math.max(12, Math.min(30, 22 * Math.sqrt(t)));
      var op = Math.max(0.3, Math.min(1, 0.35 + 0.9 * t));
      el.style.display = 'block';
      el.style.left = sx + 'px';
      el.style.top = sy + 'px';
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.fontSize = Math.max(9, size * 0.46) + 'px';
      el.style.opacity = String(op);
      el.style.zIndex = String(2000 - Math.round(dist * 4));   // nearer markers paint on top
      el.style.background = (i === S.tourIndex && S.tourActive) ? 'rgba(31,157,85,.92)' : 'rgba(20,110,220,.85)';
    }
    drawRoute(pts, cw, ch);
  }
  function drawRoute(pts, cw, ch) {
    var cv = S.routeCanvas; if (!cv) return;
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    var ctx = S.routeCtx; if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!S.showRoute || !pts || pts.length < 2) return;
    ctx.strokeStyle = 'rgba(255,210,63,.55)'; ctx.lineWidth = 2; ctx.setLineDash([7, 6]);
    var runs = [], cur = [];
    for (var i = 0; i < pts.length; i++) {
      if (pts[i]) { cur.push([pts[i].x, pts[i].y]); }
      else if (cur.length) { runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    var allValid = true;
    for (var a = 0; a < pts.length; a++) { if (!pts[a]) { allValid = false; break; } }
    if (S.tourLoop && allValid && pts.length > 2 && runs.length === 1) { runs[0] = runs[0].concat([[pts[0].x, pts[0].y]]); }
    for (var r = 0; r < runs.length; r++) {
      var line = (S.smoothRoute && runs[r].length > 2) ? catmullRomSpline(runs[r], 14, false) : runs[r];
      ctx.beginPath();
      for (var j = 0; j < line.length; j++) { if (j === 0) ctx.moveTo(line[j][0], line[j][1]); else ctx.lineTo(line[j][0], line[j][1]); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // ---------- inertia (smooth accel/decel) ----------
  function stepVelocity(vel, target, rate, dt) {
    var f = Math.min(1, rate * dt);
    return [
      vel[0] + (target[0] - vel[0]) * f,
      vel[1] + (target[1] - vel[1]) * f,
      vel[2] + (target[2] - vel[2]) * f
    ];
  }

  // ---------- minimap (top-down XZ) ----------
  function mmMap(x, z, b, size) {
    var pad = 0.08;
    var sx = (x - b.lo[0]) / ((b.hi[0] - b.lo[0]) || 1);
    var sz = (z - b.lo[2]) / ((b.hi[2] - b.lo[2]) || 1);
    sx = pad + sx * (1 - 2 * pad); sz = pad + sz * (1 - 2 * pad);
    return { px: sx * size, py: sz * size };
  }
  function mmInv(px, py, b, size) {
    var pad = 0.08;
    var sx = (px / size - pad) / (1 - 2 * pad);
    var sz = (py / size - pad) / (1 - 2 * pad);
    return [b.lo[0] + sx * ((b.hi[0] - b.lo[0]) || 1), b.lo[2] + sz * ((b.hi[2] - b.lo[2]) || 1)];
  }
  function mmNearestStation(stations, px, py, b, size, maxDist) {
    var best = -1, bd = (maxDist || 10); bd = bd * bd;
    for (var i = 0; i < (stations || []).length; i++) {
      var p = mmMap(stations[i].pos[0], stations[i].pos[2], b, size);
      var dx = p.px - px, dy = p.py - py; var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawMinimap() {
    var cv = S.mmCanvas; if (!cv || !S.bounds || cv.style.display === 'none') return;
    var ctx = S.mmCtx; var MM = cv.width; var b = S.bounds;
    ctx.clearRect(0, 0, MM, MM);
    ctx.fillStyle = 'rgba(10,14,20,.72)';
    roundRectPath(ctx, 0, 0, MM, MM, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(127,182,255,.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(MM * 0.08, MM * 0.08, MM * 0.84, MM * 0.84);
    if (S.stations) {
      if (S.showRoute && S.stations.length > 1) {
        var rp = routePolyline(S.stations, S.tourLoop);
        var rline = (S.smoothRoute && rp.length > 2) ? catmullRomSpline(rp, 14, false) : rp;
        ctx.strokeStyle = 'rgba(255,210,63,.7)'; ctx.lineWidth = 2;
        ctx.beginPath();
        for (var rr = 0; rr < rline.length; rr++) {
          var mp = mmMap(rline[rr][0], rline[rr][1], b, MM);
          if (rr === 0) ctx.moveTo(mp.px, mp.py); else ctx.lineTo(mp.px, mp.py);
        }
        ctx.stroke();
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (var i = 0; i < S.stations.length; i++) {
        var p = mmMap(S.stations[i].pos[0], S.stations[i].pos[2], b, MM);
        ctx.beginPath(); ctx.arc(p.px, p.py, 6, 0, 6.2832);
        ctx.fillStyle = (i === S.tourIndex && S.tourActive) ? '#2563eb' : '#2a2f3a';
        ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif';
        ctx.fillText(String(i + 1), p.px, p.py);
        var nm = S.stations[i].name;
        if (nm) {
          if (nm.length > 14) nm = nm.slice(0, 13) + '…';
          ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
          var tw = ctx.measureText(nm).width;
          ctx.fillStyle = 'rgba(10,14,20,.75)';
          ctx.fillRect(p.px + 8, p.py - 6, tw + 4, 12);
          ctx.fillStyle = '#dfe7f2';
          ctx.fillText(nm, p.px + 10, p.py + 1);
          ctx.textAlign = 'center';
        }
      }
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
    var cp = mmMap(S.cam.eye[0], S.cam.eye[2], b, MM);
    var dx = Math.sin(S.cam.yaw), dz = Math.cos(S.cam.yaw);
    var flen = b.radius * 0.18;
    var ep = mmMap(S.cam.eye[0] + dx * flen, S.cam.eye[2] + dz * flen, b, MM);
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cp.px, cp.py); ctx.lineTo(ep.px, ep.py); ctx.stroke();
    ctx.beginPath(); ctx.arc(cp.px, cp.py, 4.5, 0, 6.2832);
    ctx.fillStyle = '#ffd23f'; ctx.fill();
    ctx.strokeStyle = '#0a0d12'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  // ---------- zoom inertia ----------
  function updateZoom(dt) {
    if (!S.zoomVel) return;
    var fwd = forwardVec();
    if (S.walk) fwd = normalize([fwd[0], 0, fwd[2]]);
    var _zx = S.cam.eye[0], _zz = S.cam.eye[2];
    S.cam.eye[0] += fwd[0] * S.zoomVel * dt;
    S.cam.eye[1] += fwd[1] * S.zoomVel * dt;
    S.cam.eye[2] += fwd[2] * S.zoomVel * dt;
    if (S.walk) {
      S.cam.eye[1] = S.lockY; // Y is owned by the avatar physics (walkVertical); scroll only dollies on XZ
      if (S.collision) {
        var _zey = S.lockY, _zeh = S.eyeH || 1.6;
        var _zr = resolveWalk(S.collision, _zx, _zz, S.cam.eye[0], S.cam.eye[2], _zey - _zeh + 0.35, _zey - 0.1, S.playerRadius || 0.28);
        S.cam.eye[0] = _zr[0]; S.cam.eye[2] = _zr[1];
      }
    }
    S.zoomVel *= Math.exp(-dt * 7);
    if (Math.abs(S.zoomVel) < S.step * 0.5) S.zoomVel = 0;
    S.needsSort = true;
  }

  // ---------- station model + editor (pure helpers) ----------
  function makeStation(pos, name, yaw, pitch) {
    var s = { pos: [+pos[0], +pos[1], +pos[2]] };
    if (name != null && String(name) !== '') s.name = String(name);
    if (typeof yaw === 'number' && isFinite(yaw)) s.yaw = yaw;
    if (typeof pitch === 'number' && isFinite(pitch)) s.pitch = pitch;
    return s;
  }
  function withStationAdded(stations, station) { return (stations || []).concat([station]); }
  function withStationRemoved(stations, idx) {
    var out = []; for (var i = 0; i < (stations || []).length; i++) if (i !== idx) out.push(stations[i]); return out;
  }
  function withStationRenamed(stations, idx, name) {
    return (stations || []).map(function (s, i) { return i === idx ? makeStation(s.pos, name, s.yaw, s.pitch) : s; });
  }
  function withStationMoved(stations, from, to) {
    var arr = (stations || []).slice();
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr;
    var item = arr.splice(from, 1)[0];
    arr.splice(to, 0, item);
    return arr;
  }
  function routePolyline(stations, loop) {
    var s = stations || []; var pts = [];
    for (var i = 0; i < s.length; i++) pts.push([s[i].pos[0], s[i].pos[2]]);
    if (loop && s.length > 2) pts.push([s[0].pos[0], s[0].pos[2]]);
    return pts;
  }
  function estimateTourDurationMs(n, moveDurMs, dwellMs) {
    n = n || 0; var move = moveDurMs || 900; var dwell = dwellMs || 2600;
    return Math.round(move * 0.78) + n * (move + dwell);
  }
  function catmullRomPoint(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t; var res = [];
    for (var d = 0; d < p1.length; d++) {
      res.push(0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3));
    }
    return res;
  }
  function catmullRomSpline(pts, segments, closed) {
    var n = (pts || []).length;
    if (n < 3) return (pts || []).map(function (p) { return p.slice(); });
    segments = segments || 12;
    var out = []; var last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var p0 = closed ? pts[(i - 1 + n) % n] : pts[i === 0 ? 0 : i - 1];
      var p1 = pts[i % n];
      var p2 = pts[(i + 1) % n];
      var p3 = closed ? pts[(i + 2) % n] : pts[(i + 2 < n) ? i + 2 : n - 1];
      for (var s = 0; s < segments; s++) { out.push(catmullRomPoint(p0, p1, p2, p3, s / segments)); }
    }
    out.push((closed ? pts[0] : pts[n - 1]).slice());
    return out;
  }
  function stationCaption(stations, idx) {
    var s = (stations || [])[idx]; if (!s) return '';
    return (idx + 1) + '. ' + (s.name || ('Точка ' + (idx + 1)));
  }
  function approachAlpha(current, target, dtMs, fadeMs) {
    if (!fadeMs || fadeMs <= 0) return target;
    var step = dtMs / fadeMs;
    if (current < target) return Math.min(target, current + step);
    return Math.max(target, current - step);
  }
  function subtitleText(subtitle, showDate, dateStr) {
    var parts = [];
    if (subtitle) parts.push(subtitle);
    if (showDate && dateStr) parts.push(dateStr);
    return parts.join('  \u2022  ');
  }

  // ---------- tour route serialization ----------
  function serializeTour(stations) {
    return JSON.stringify({
      version: 1, type: 'bimtwin-tour', stations: (stations || []).map(function (s) {
        var o = { pos: [s.pos[0], s.pos[1], s.pos[2]] };
        if (s.name != null && s.name !== '') o.name = String(s.name);
        if (typeof s.yaw === 'number' && isFinite(s.yaw)) o.yaw = s.yaw;
        if (typeof s.pitch === 'number' && isFinite(s.pitch)) o.pitch = s.pitch;
        return o;
      })
    });
  }
  function deserializeTour(str) {
    var obj = typeof str === 'string' ? JSON.parse(str) : str;
    if (!obj || !Array.isArray(obj.stations)) throw new Error('нет списка точек');
    var out = [];
    for (var i = 0; i < obj.stations.length; i++) {
      var s = obj.stations[i]; var p = s && s.pos;
      if (!p || p.length < 3) continue;
      out.push(makeStation([+p[0], +p[1], +p[2]], s.name, typeof s.yaw === 'number' ? s.yaw : undefined, typeof s.pitch === 'number' ? s.pitch : undefined));
    }
    if (!out.length) throw new Error('в файле нет точек');
    return out;
  }
  function persistStations() {
    try {
      if (S._suppressPersist || !S.sceneKey || typeof localStorage === 'undefined') return;
      if (S.stations && S.stations.length) localStorage.setItem(S.sceneKey, serializeTour(S.stations));
      else localStorage.removeItem(S.sceneKey);
    } catch (e) {}
  }
  function loadPersistedStations() {
    try {
      if (!S.sceneKey || typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(S.sceneKey);
      if (!raw) return null;
      return deserializeTour(raw);
    } catch (e) { return null; }
  }
  function saveToProject() {
    if (!S.sceneKey) { toast('Сначала загрузите сцену'); return; }
    var prev = S._suppressPersist; S._suppressPersist = false; persistStations(); S._suppressPersist = prev;
    toast((S.stations ? S.stations.length : 0) + ' \u0442\u043e\u0447\u0435\u043a \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e \u0432 \u043f\u0440\u043e\u0435\u043a\u0442\u0435 \u2014 \u043e\u0442\u043a\u0440\u043e\u044e\u0442\u0441\u044f \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u0438');
  }
  function exportTour() {
    if (!S.stations || !S.stations.length) { toast('Нет точек для экспорта'); return; }
    try {
      var blob = new Blob([serializeTour(S.stations)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'bimtwin-tour.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      toast('Маршрут сохранён: ' + S.stations.length + ' точек');
    } catch (e) { toast('Не удалось сохранить: ' + e.message); }
  }
  function applyImportedTour(str) {
    try {
      var st = deserializeTour(str);
      S.stations = st; S.tourIndex = 0; S.tourActive = false; S._dwellSet = false;
      if (S.tourBtn) setBtn(S.tourBtn, 'play', 'Тур');
      buildMarkers();
      toast('Маршрут загружен: ' + st.length + ' точек');
    } catch (e) { toast('Ошибка загрузки: ' + e.message); }
  }

  function exportTourVideo() {
    if (!S.canvas || !S.stations || !S.stations.length) { toast('Нет точек для облёта'); return; }
    if (typeof MediaRecorder === 'undefined' || !S.canvas.captureStream) { toast('Запись видео не поддерживается'); return; }
    if (S._recording) return;
    var mime = '';
    var cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < cands.length; i++) { if (MediaRecorder.isTypeSupported(cands[i])) { mime = cands[i]; break; } }
    var srcW = S.canvas.width || 1280, srcH = S.canvas.height || 720;
    var targetH = (S.recRes | 0);
    // v1146: cap capture height to ≤1080 by default so the encoder isn't choked by a
    // 4K/hi-DPI source canvas — the main cause of the recording hitching AND the choppy
    // output video. Downscaling on an offscreen canvas keeps a steady 30fps stream.
    var needOff = targetH > 0 || !!S.recTitles || srcH > 1080;
    var stream;
    if (needOff) {
      var offCv = document.createElement('canvas');
      var th = targetH > 0 ? targetH : Math.min(srcH, 1080);
      var ar = srcW / srcH;
      offCv.height = th; offCv.width = Math.max(2, Math.round(th * ar));
      S._recOff = offCv; S._recOffCtx = offCv.getContext('2d');
      stream = offCv.captureStream(30);
    } else {
      S._recOff = null; S._recOffCtx = null;
      stream = S.canvas.captureStream(30);
    }
    var opts = {};
    if (mime) opts.mimeType = mime;
    if (S.recBitrate) opts.videoBitsPerSecond = (S.recBitrate | 0) * 1000000;
    var rec;
    try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      var blob = new Blob(chunks, { type: mime || 'video/webm' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'bimtwin-flythrough.webm';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
      S._recording = false; S._recorder = null; S._recOff = null; S._recOffCtx = null;
      if (S.recBtn) { setBtn(S.recBtn, 'video', 'Видео'); S.recBtn.style.background = '#2a2f3a'; }
      toast('Видео облёта сохранено');
    };
    S._recording = true; S._recorder = rec;
    if (S.recBtn) { setBtn(S.recBtn, 'stop', 'Стоп'); S.recBtn.style.background = '#dc2626'; }
    S._recDateStr = new Date().toLocaleDateString('ru-RU'); S._capAlpha = 0;
    rec.start();
    var wasLoop = S.tourLoop; S.tourLoop = false;
    S.tourIndex = 0; setTour(true);
    var total = estimateTourDurationMs(S.stations.length, S.moveDurMs, S.dwellMs) + 700;
    S._recTimer = setTimeout(function () { S.tourLoop = wasLoop; stopTourVideo(); }, total);
    var lab = (targetH > 0 ? (targetH + 'p') : 'исходное') + ', ' + (S.recBitrate || 16) + ' Мбит/с';
    toast('Запись облёта (' + lab + ', ~' + Math.round(total / 1000) + ' с)');
  }
  function stopTourVideo() {
    if (S._recTimer) { clearTimeout(S._recTimer); S._recTimer = null; }
    if (S.tourActive) setTour(false);
    if (S._recording && S._recorder) { try { S._recorder.stop(); } catch (e) { S._recording = false; S._recOff = null; S._recOffCtx = null; } }
  }
  function captureFrame() {
    var off = S._recOff, octx = S._recOffCtx; if (!off || !octx) return;
    var ow = off.width, oh = off.height;
    try { octx.drawImage(S.canvas, 0, 0, ow, oh); } catch (e) { return; }
    if (!S.recTitles) return;
    var pad = Math.round(oh * 0.02);
    var capTarget = (S.tourActive && !S.tween) ? 1 : 0;
    S._capAlpha = approachAlpha(typeof S._capAlpha === 'number' ? S._capAlpha : 0, capTarget, (S.dt || 0.016) * 1000, S.capFadeMs || 450);
    var cap = S.tourActive ? stationCaption(S.stations, S.tourIndex) : '';
    if (cap && S._capAlpha > 0.01) {
      var fs = Math.max(11, Math.round(oh * 0.035));
      var sfs = Math.max(9, Math.round(oh * 0.024));
      octx.textBaseline = 'middle'; octx.textAlign = 'left';
      octx.font = 'bold ' + fs + 'px sans-serif';
      var tw = octx.measureText(cap).width;
      var sub = subtitleText(S.recSubtitle, S.recShowDate, S._recDateStr);
      var subW = 0;
      if (sub) { octx.font = sfs + 'px sans-serif'; subW = octx.measureText(sub).width; }
      var boxW = Math.max(tw, subW) + fs;
      var lineH = Math.round(fs * 1.5);
      var subH = sub ? Math.round(sfs * 1.5) : 0;
      var bh = lineH + subH + (sub ? Math.round(oh * 0.008) : 0);
      var by = oh - pad - bh;
      octx.globalAlpha = S._capAlpha;
      octx.fillStyle = 'rgba(10,14,20,.55)';
      octx.fillRect(pad, by, boxW, bh);
      octx.fillStyle = '#ffd23f';
      octx.font = 'bold ' + fs + 'px sans-serif';
      octx.fillText(cap, pad + fs * 0.5, by + lineH / 2);
      if (sub) {
        octx.fillStyle = 'rgba(230,237,243,.95)';
        octx.font = sfs + 'px sans-serif';
        octx.fillText(sub, pad + fs * 0.5, by + lineH + subH / 2);
      }
      octx.globalAlpha = 1;
    }
    var lp = pad;
    if (S.recLogoImg && S.recLogoImg.complete && S.recLogoImg.naturalWidth) {
      var lh = Math.round(oh * 0.09);
      var lw2 = Math.round(lh * (S.recLogoImg.naturalWidth / S.recLogoImg.naturalHeight));
      try { octx.drawImage(S.recLogoImg, ow - lw2 - lp, lp, lw2, lh); } catch (e) {}
    } else {
      var lfs = Math.max(10, Math.round(oh * 0.03));
      octx.font = 'bold ' + lfs + 'px sans-serif';
      octx.textBaseline = 'top'; octx.textAlign = 'left';
      var logo = 'BIM Twin';
      var lw = octx.measureText(logo).width;
      octx.fillStyle = 'rgba(0,0,0,.35)';
      octx.fillRect(ow - lw - lp * 1.6, lp * 0.7, lw + lp, lfs * 1.5);
      octx.fillStyle = 'rgba(255,255,255,.9)';
      octx.fillText(logo, ow - lw - lp, lp);
    }
  }

  function addStationHere() {
    if (!S.bounds) { toast('Сначала загрузите сцену'); return; }
    var n = S.stations ? S.stations.length : 0;
    var st = makeStation(S.cam.eye.slice(), 'Точка ' + (n + 1), S.cam.yaw, S.cam.pitch);
    S.stations = withStationAdded(S.stations, st);
    buildMarkers();
    toast('Добавлена точка ' + (n + 1) + ' (всего ' + S.stations.length + ')');
  }
  // v1042: Electron блокирует window.prompt — свой DOM-модал (Promise, Enter/Esc, клик мимо = Отмена).
  function promptModal(message, defVal) {
    return new Promise(function (resolve) {
      try {
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'min-width:320px;max-width:90vw;background:#1e1f24;color:#eee;border:1px solid #3a3d44;border-radius:10px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px system-ui,Segoe UI,sans-serif;';
        var lab = document.createElement('div'); lab.textContent = message || ''; lab.style.cssText = 'margin-bottom:10px;white-space:pre-wrap;';
        var inp = document.createElement('input'); inp.type = 'text'; inp.value = (defVal == null ? '' : String(defVal));
        inp.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid #4a4d55;background:#0f1013;color:#fff;outline:none;';
        var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
        var cancel = document.createElement('button'); cancel.textContent = 'Отмена';
        var ok = document.createElement('button'); ok.textContent = 'OK';
        var bs = 'padding:7px 14px;border-radius:6px;border:1px solid #4a4d55;cursor:pointer;font:inherit;';
        cancel.style.cssText = bs + 'background:#26272d;color:#ddd;';
        ok.style.cssText = bs + 'background:#2f6fed;color:#fff;border-color:#2f6fed;';
        function done(v) { try { document.removeEventListener('keydown', onKey, true); } catch (_) {} try { ov.remove(); } catch (_) {} resolve(v); }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(null); } else if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } }
        cancel.onclick = function () { done(null); };
        ok.onclick = function () { done(inp.value); };
        ov.onmousedown = function (e) { if (e.target === ov) done(null); };
        document.addEventListener('keydown', onKey, true);
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(lab); box.appendChild(inp); box.appendChild(row);
        ov.appendChild(box); (document.body || document.documentElement).appendChild(ov);
        setTimeout(function () { try { inp.focus(); inp.select(); } catch (_) {} }, 30);
      } catch (e) { resolve(null); }
    });
  }
  function editStationPrompt(idx) {
    if (!S.stations || !S.stations[idx]) return;
    var cur = S.stations[idx].name || ('Точка ' + (idx + 1));
    promptModal('Название точки (пусто — удалить):', cur).then(function (name) {
      if (name === null) return;
      if (name.trim() === '') {
        S.stations = withStationRemoved(S.stations, idx);
        if (S.tourIndex >= S.stations.length) S.tourIndex = 0;
        toast('Точка удалена');
      } else {
        S.stations = withStationRenamed(S.stations, idx, name.trim());
        toast('Переименовано: ' + name.trim());
      }
      buildMarkers();
    });
  }
  function setEdit(on) {
    S.editMode = !!on;
    if (S.editBtn) S.editBtn.style.background = S.editMode ? '#2563eb' : '#2a2f3a';
    toast(S.editMode ? 'Правка точек: клик по маркеру — переименовать/удалить' : 'Правка выключена');
  }

  function doPick(e) {
    if (!S.open || !S.buf || !S.canvas) return;
    var rect = S.canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return;
    var dir = screenRayDir(mx, my, rect.width, rect.height, S.cam, 1.1);
    var hit = raycastNearest(S.buf, S.count, S.cam.eye, dir, 0.02);
    if (!hit) hit = raycastNearest(S.buf, S.count, S.cam.eye, dir, 0.05);
    if (hit) { cancelTour(); teleportTo(hit.point, dir); }
  }

  function buildDom() {
    var wrap = document.createElement('div');
    wrap.id = 'splatWrap';
    wrap.style.cssText = 'position:absolute;inset:0;z-index:45;display:none;background:#0a0d12';
    var canvas = document.createElement('canvas');
    canvas.id = 'splatCanvas';
    canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;outline:none';
    canvas.tabIndex = 0;
    wrap.appendChild(canvas);
    var routeCv = document.createElement('canvas');
    routeCv.id = 'splatRoute';
    routeCv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    wrap.appendChild(routeCv);
    S.routeCanvas = routeCv; S.routeCtx = routeCv.getContext('2d');
    var markerWrap = document.createElement('div');
    markerWrap.id = 'splatMarkers';
    markerWrap.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    wrap.appendChild(markerWrap);
    S.markerWrap = markerWrap;
    var mm = document.createElement('canvas');
    mm.id = 'splatMinimap';
    mm.width = 170; mm.height = 170;
    mm.title = 'Мини-карта · клик — телепорт';
    mm.style.cssText = 'position:absolute;right:12px;bottom:12px;width:170px;height:170px;border-radius:10px;border:1px solid rgba(127,182,255,.35);cursor:crosshair;pointer-events:auto;box-shadow:0 2px 10px rgba(0,0,0,.5);display:none';
    var mmDragIdx = -1, mmDown = false, mmMoved = 0;
    function mmToPix(ev) {
      var rect = mm.getBoundingClientRect();
      return { px: (ev.clientX - rect.left) * (mm.width / rect.width), py: (ev.clientY - rect.top) * (mm.height / rect.height) };
    }
    mm.addEventListener('mousedown', function (e) {
      if (!S.bounds) return;
      e.preventDefault(); e.stopPropagation();
      var q = mmToPix(e); mmDown = true; mmMoved = 0;
      mmDragIdx = mmNearestStation(S.stations, q.px, q.py, S.bounds, mm.width, 10);
    });
    window.addEventListener('mousemove', function (e) {
      if (!mmDown || !S.bounds) return;
      mmMoved++;
      if (mmDragIdx >= 0 && S.stations && S.stations[mmDragIdx]) {
        var q = mmToPix(e);
        var w = mmInv(q.px, q.py, S.bounds, mm.width);
        var st = S.stations[mmDragIdx];
        st.pos = [w[0], st.pos[1], w[1]];
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (!mmDown) return;
      mmDown = false;
      if (mmDragIdx >= 0 && mmMoved > 2) {
        buildMarkers();
        toast('Точка ' + (mmDragIdx + 1) + ' перемещена');
      } else {
        var rect = mm.getBoundingClientRect();
        var inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (inside && mmMoved <= 2) {
          var q = mmToPix(e);
          var w = mmInv(q.px, q.py, S.bounds, mm.width);
          cancelTour();
          var ty = S.walk ? S.lockY : S.cam.eye[1];
          startTween([w[0], ty, w[1]], S.cam.yaw, S.cam.pitch, 650);
        }
      }
      mmDragIdx = -1;
    });
    wrap.appendChild(mm);
    S.mmCanvas = mm; S.mmCtx = mm.getContext('2d');
    var fileIn = document.createElement('input');
    fileIn.type = 'file'; fileIn.accept = '.json,application/json'; fileIn.style.display = 'none';
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { applyImportedTour(String(rd.result)); fileIn.value = ''; };
      rd.readAsText(f);
    });
    wrap.appendChild(fileIn);
    S.tourFileInput = fileIn;
    // station list + tour settings panel
    var listPanel = document.createElement('div');
    listPanel.id = 'splatStationList';
    listPanel.style.cssText = 'position:absolute;left:12px;bottom:12px;width:236px;max-height:46%;overflow:auto;background:rgba(10,14,20,.85);border:1px solid rgba(127,182,255,.35);border-radius:10px;padding:8px 10px;font:13px sans-serif;color:#e6edf3;pointer-events:auto;box-shadow:0 2px 10px rgba(0,0,0,.5);display:none';
    var lpTitle = document.createElement('div');
    lpTitle.textContent = 'Точки тура';
    lpTitle.style.cssText = 'font-weight:bold;margin-bottom:6px';
    listPanel.appendChild(lpTitle);
    var dwellRow = document.createElement('label');
    dwellRow.style.cssText = 'display:block;margin:4px 0;opacity:.9;font-size:12px';
    var dwellLab = document.createElement('span'); dwellLab.textContent = 'Задержка: ' + (S.dwellMs / 1000).toFixed(1) + ' с';
    var dwell = document.createElement('input'); dwell.type = 'range'; dwell.min = '800'; dwell.max = '6000'; dwell.step = '100'; dwell.value = String(S.dwellMs); dwell.style.cssText = 'width:100%';
    dwell.oninput = function () { S.dwellMs = +dwell.value; dwellLab.textContent = 'Задержка: ' + (S.dwellMs / 1000).toFixed(1) + ' с'; };
    dwellRow.appendChild(dwellLab); dwellRow.appendChild(dwell);
    var spdRow = document.createElement('label');
    spdRow.style.cssText = 'display:block;margin:4px 0;opacity:.9;font-size:12px';
    var spdLab = document.createElement('span'); spdLab.textContent = 'Переход: ' + (S.moveDurMs / 1000).toFixed(1) + ' с';
    var spd = document.createElement('input'); spd.type = 'range'; spd.min = '400'; spd.max = '2000'; spd.step = '50'; spd.value = String(S.moveDurMs); spd.style.cssText = 'width:100%';
    spd.oninput = function () { S.moveDurMs = +spd.value; spdLab.textContent = 'Переход: ' + (S.moveDurMs / 1000).toFixed(1) + ' с'; };
    spdRow.appendChild(spdLab); spdRow.appendChild(spd);
    listPanel.appendChild(dwellRow); listPanel.appendChild(spdRow);
    var loopRow = document.createElement('label');
    loopRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;cursor:pointer';
    var loopCb = document.createElement('input'); loopCb.type = 'checkbox'; loopCb.checked = !!S.tourLoop;
    loopCb.onchange = function () { S.tourLoop = loopCb.checked; };
    var loopTx = document.createElement('span'); loopTx.textContent = 'Зациклить тур';
    loopRow.appendChild(loopCb); loopRow.appendChild(loopTx);
    var routeRow = document.createElement('label');
    routeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;cursor:pointer';
    var routeCb = document.createElement('input'); routeCb.type = 'checkbox'; routeCb.checked = !!S.showRoute;
    routeCb.onchange = function () { S.showRoute = routeCb.checked; };
    var routeTx = document.createElement('span'); routeTx.textContent = 'Линия маршрута';
    routeRow.appendChild(routeCb); routeRow.appendChild(routeTx);
    listPanel.appendChild(loopRow); listPanel.appendChild(routeRow);
    var smoothRow = document.createElement('label');
    smoothRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;cursor:pointer';
    var smoothCb = document.createElement('input'); smoothCb.type = 'checkbox'; smoothCb.checked = !!S.smoothRoute;
    smoothCb.onchange = function () { S.smoothRoute = smoothCb.checked; };
    var smoothTx = document.createElement('span'); smoothTx.textContent = 'Сглаживать маршрут';
    smoothRow.appendChild(smoothCb); smoothRow.appendChild(smoothTx);
    listPanel.appendChild(smoothRow);
    var vidHdr = document.createElement('div');
    vidHdr.textContent = 'Видео-облёт';
    vidHdr.style.cssText = 'font-weight:bold;margin:8px 0 3px;border-top:1px solid rgba(127,182,255,.18);padding-top:6px';
    listPanel.appendChild(vidHdr);
    function mkSelect(labelText, options, current, onPick) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin:3px 0;font-size:12px';
      var tx = document.createElement('span'); tx.textContent = labelText;
      var sel = document.createElement('select');
      sel.style.cssText = 'background:#0d1420;color:#e6edf3;border:1px solid rgba(127,182,255,.35);border-radius:4px;padding:2px 4px;font:12px sans-serif';
      for (var o = 0; o < options.length; o++) {
        var opt = document.createElement('option'); opt.value = String(options[o].v); opt.textContent = options[o].t;
        if (options[o].v === current) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = function () { onPick(+sel.value); };
      row.appendChild(tx); row.appendChild(sel); return row;
    }
    listPanel.appendChild(mkSelect('Разрешение', [{ v: 0, t: 'Исходное' }, { v: 720, t: '720p' }, { v: 1080, t: '1080p' }, { v: 1440, t: '1440p' }], S.recRes, function (v) { S.recRes = v; }));
    listPanel.appendChild(mkSelect('Битрейт', [{ v: 8, t: 'Низкий' }, { v: 16, t: 'Средний' }, { v: 40, t: 'Высокий' }], S.recBitrate, function (v) { S.recBitrate = v; }));
    var titlesRow = document.createElement('label');
    titlesRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;cursor:pointer';
    var titlesCb = document.createElement('input'); titlesCb.type = 'checkbox'; titlesCb.checked = !!S.recTitles;
    titlesCb.onchange = function () { S.recTitles = titlesCb.checked; };
    var titlesTx = document.createElement('span'); titlesTx.textContent = 'Титры на видео';
    titlesRow.appendChild(titlesCb); titlesRow.appendChild(titlesTx);
    listPanel.appendChild(titlesRow);
    var subRow = document.createElement('label');
    subRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin:3px 0;font-size:12px';
    var subTx = document.createElement('span'); subTx.textContent = 'Подзаголовок';
    var subIn = document.createElement('input'); subIn.type = 'text'; subIn.value = S.recSubtitle || '';
    subIn.placeholder = 'Проект / клиент';
    subIn.style.cssText = 'flex:1;min-width:0;width:120px;background:#0d1420;color:#e6edf3;border:1px solid rgba(127,182,255,.35);border-radius:4px;padding:2px 6px;font:12px sans-serif';
    subIn.oninput = function () { S.recSubtitle = subIn.value; };
    subRow.appendChild(subTx); subRow.appendChild(subIn);
    listPanel.appendChild(subRow);
    var dateRow = document.createElement('label');
    dateRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;cursor:pointer';
    var dateCb = document.createElement('input'); dateCb.type = 'checkbox'; dateCb.checked = !!S.recShowDate;
    dateCb.onchange = function () { S.recShowDate = dateCb.checked; };
    var dateTx = document.createElement('span'); dateTx.textContent = 'Дата на видео';
    dateRow.appendChild(dateCb); dateRow.appendChild(dateTx);
    listPanel.appendChild(dateRow);
    var logoRow = document.createElement('div');
    logoRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin:4px 0;font-size:12px';
    var logoTx = document.createElement('span'); logoTx.textContent = 'Логотип';
    var logoWrap = document.createElement('span'); logoWrap.style.cssText = 'display:flex;gap:4px;align-items:center';
    var logoBtn = document.createElement('button'); logoBtn.type = 'button'; logoBtn.textContent = S.recLogoImg ? 'Заменить' : 'Загрузить';
    logoBtn.style.cssText = 'background:#2a2f3a;color:#fff;border:0;border-radius:4px;padding:2px 8px;font:12px sans-serif;cursor:pointer';
    var logoClear = document.createElement('button'); logoClear.type = 'button'; logoClear.textContent = '✕';
    logoClear.style.cssText = 'background:#a33;color:#fff;border:0;border-radius:4px;padding:2px 6px;font:12px sans-serif;cursor:pointer;' + (S.recLogoImg ? '' : 'display:none');
    var logoInput = document.createElement('input'); logoInput.type = 'file'; logoInput.accept = 'image/*'; logoInput.style.display = 'none';
    logoInput.onchange = function () {
      var f = logoInput.files && logoInput.files[0]; if (!f) return;
      if (S.recLogoUrl) { try { URL.revokeObjectURL(S.recLogoUrl); } catch (e) {} }
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () { S.recLogoImg = img; S.recLogoUrl = url; logoBtn.textContent = 'Заменить'; logoClear.style.display = ''; toast('Логотип загружен'); };
      img.onerror = function () { toast('Не удалось загрузить логотип'); };
      img.src = url;
    };
    logoBtn.onclick = function () { logoInput.click(); };
    logoClear.onclick = function () {
      if (S.recLogoUrl) { try { URL.revokeObjectURL(S.recLogoUrl); } catch (e) {} }
      S.recLogoImg = null; S.recLogoUrl = ''; logoInput.value = ''; logoBtn.textContent = 'Загрузить'; logoClear.style.display = 'none'; toast('Логотип сброшен');
    };
    logoWrap.appendChild(logoBtn); logoWrap.appendChild(logoClear); logoWrap.appendChild(logoInput);
    logoRow.appendChild(logoTx); logoRow.appendChild(logoWrap);
    listPanel.appendChild(logoRow);
    var lpBody = document.createElement('div'); lpBody.style.cssText = 'margin-top:4px';
    listPanel.appendChild(lpBody);
    wrap.appendChild(listPanel);
    S.listPanel = listPanel; S.listBody = lpBody;
    // HUD
    var hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;top:10px;left:10px;right:10px;display:flex;gap:8px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;pointer-events:none;font:13px sans-serif;color:#e6edf3';
    var left = document.createElement('div');
    left.style.cssText = 'display:flex;gap:10px;align-items:center;background:rgba(10,14,20,.7);padding:6px 10px;border-radius:8px;pointer-events:auto';
    var title = document.createElement('span'); title.textContent = '3DGS';
    var cnt = document.createElement('span'); cnt.style.opacity = '.7'; cnt.textContent = '';
    left.appendChild(title); left.appendChild(cnt);
    var brWrap = document.createElement('label');
    brWrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.92;margin-left:4px';
    brWrap.appendChild(document.createTextNode('Свет'));
    var brIn = document.createElement('input'); brIn.type = 'range'; brIn.min = '0.5'; brIn.max = '5'; brIn.step = '0.1'; brIn.value = String(S.exposure); brIn.title = 'Яркость сцены'; brIn.style.cssText = 'width:82px;accent-color:#2563eb';
    brIn.oninput = function () { S.exposure = +brIn.value; };
    brWrap.appendChild(brIn); left.appendChild(brWrap);
    var psWrap = document.createElement('label');
    psWrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.92;margin-left:4px';
    psWrap.appendChild(document.createTextNode('Точки'));
    var psIn = document.createElement('input'); psIn.type = 'range'; psIn.min = '0.15'; psIn.max = '2'; psIn.step = '0.05'; psIn.value = String(S.sizeMul); psIn.title = 'Размер точек: меньше — резче, больше — плотнее (без дыр)'; psIn.style.cssText = 'width:82px;accent-color:#2563eb';
    psIn.oninput = function () { S.sizeMul = +psIn.value; };
    psWrap.appendChild(psIn); left.appendChild(psWrap);
    var shWrap = document.createElement('label');
    shWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.92;margin-left:6px;cursor:pointer';
    var shCb = document.createElement('input'); shCb.type = 'checkbox'; shCb.checked = !!S.sharp; shCb.title = 'Чёткие непрозрачные точки (без размытия, легче)'; shCb.style.cssText = 'accent-color:#2563eb';
    shCb.onchange = function () { S.sharp = shCb.checked; S.needsSort = true; };
    S.sharpCb = shCb;
    shWrap.appendChild(shCb); shWrap.appendChild(document.createTextNode('Чёткие'));
    left.appendChild(shWrap);
    var right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:100%;pointer-events:auto';
    var hint = document.createElement('span');
    hint.style.cssText = 'opacity:.7;background:rgba(10,14,20,.7);padding:6px 10px;border-radius:8px';
    hint.textContent = 'ЛКМ — телепорт · WASD — ход · Shift — бег · Space — прыжок · Q/E — полёт вверх/вниз · «Ходьба» — аватар';
    var tourBtn = document.createElement('button');
    setBtn(tourBtn, 'play', 'Тур');
    tourBtn.title = 'Авто-тур по точкам сцены';
    tourBtn.style.cssText = btnCss();
    tourBtn.onclick = function () { setTour(!S.tourActive); };
    var nextBtn = document.createElement('button');
    setBtn(nextBtn, 'next', '');
    nextBtn.title = 'Следующая точка';
    nextBtn.style.cssText = btnCss();
    nextBtn.onclick = function () { cancelTour(); nextStation(); };
    var overBtn = document.createElement('button');
    setBtn(overBtn, 'frame', 'Обзор');
    overBtn.title = 'Вернуться к общему виду';
    overBtn.style.cssText = btnCss();
    overBtn.onclick = function () { cancelTour(); overview(); };
    var walkBtn = document.createElement('button');
    setBtn(walkBtn, 'walk', 'Ходьба');
    walkBtn.title = 'Режим ходьбы: камера на уровне глаз, движение по полу';
    walkBtn.style.cssText = btnCss();
    walkBtn.onclick = function () { setWalk(!S.walk); };
    S.walkBtn = walkBtn;
    var mapBtn = document.createElement('button');
    setBtn(mapBtn, 'map', 'Карта');
    mapBtn.title = 'Показать/скрыть мини-карту';
    mapBtn.style.cssText = btnCss();
    mapBtn.onclick = function () { if (S.mmCanvas) S.mmCanvas.style.display = (S.mmCanvas.style.display === 'none' ? 'block' : 'none'); };
    S.mapBtn = mapBtn;
    var saveBtn = document.createElement('button');
    setBtn(saveBtn, 'save', '');
    saveBtn.title = 'Сохранить координаты точек в проекте (откроются автоматически при следующем открытии этой сцены)';
    saveBtn.style.cssText = btnCss();
    saveBtn.onclick = function () { saveToProject(); };
    var expBtn = document.createElement('button');
    setBtn(expBtn, 'download', '');
    expBtn.title = 'Экспортировать координаты точек в файл .json';
    expBtn.style.cssText = btnCss();
    expBtn.onclick = function () { exportTour(); };
    var openBtn2 = document.createElement('button');
    setBtn(openBtn2, 'folder', '');
    openBtn2.title = 'Загрузить маршрут тура из файла';
    openBtn2.style.cssText = btnCss();
    openBtn2.onclick = function () { if (S.tourFileInput) S.tourFileInput.click(); };
    var addBtn = document.createElement('button');
    setBtn(addBtn, 'pin', 'Точка');
    addBtn.title = 'Добавить точку тура в текущей позиции и ракурсе камеры';
    addBtn.style.cssText = btnCss();
    addBtn.onclick = function () { addStationHere(); };
    var editBtn = document.createElement('button');
    setBtn(editBtn, 'pencil', 'Правка');
    editBtn.title = 'Режим правки: клик по маркеру — переименовать или удалить';
    editBtn.style.cssText = btnCss();
    editBtn.onclick = function () { setEdit(!S.editMode); };
    S.editBtn = editBtn;
    var listBtn = document.createElement('button');
    setBtn(listBtn, 'list', 'Список');
    listBtn.title = 'Показать/скрыть список точек и настройки тура';
    listBtn.style.cssText = btnCss();
    listBtn.onclick = function () { if (S.listPanel) { var vis = S.listPanel.style.display === 'none'; S.listPanel.style.display = vis ? 'block' : 'none'; if (vis) renderStationList(); } };
    var recBtn = document.createElement('button');
    setBtn(recBtn, 'video', 'Видео');
    recBtn.title = 'Записать видео-облёт по точкам тура (WebM)';
    recBtn.style.cssText = btnCss();
    recBtn.onclick = function () { if (S._recording) stopTourVideo(); else exportTourVideo(); };
    S.recBtn = recBtn;
    var flip = document.createElement('button');
    setBtn(flip, 'flip', 'Перевернуть');
    flip.style.cssText = btnCss();
    flip.onclick = function () { S.cam.upSign *= -1; S.cam.pitch = -S.cam.pitch; S.needsSort = true; try { localStorage.setItem('splat_up', String(S.cam.upSign)); } catch (e) {} };
    var exit = document.createElement('button');
    setBtn(exit, 'exit', 'Выйти');
    exit.style.cssText = btnCss() + ';background:#b3402f;border-color:rgba(255,180,170,.45)';
    exit.title = 'Закрыть 3DGS-тур и вернуться к облаку точек (или клавиша Esc)';
    exit.onclick = function () { api.exit(); };
    S.tourBtn = tourBtn;
    right.appendChild(hint); right.appendChild(tourBtn); right.appendChild(nextBtn);
    right.appendChild(overBtn); right.appendChild(walkBtn); right.appendChild(mapBtn); right.appendChild(saveBtn); right.appendChild(expBtn); right.appendChild(openBtn2); right.appendChild(addBtn); right.appendChild(editBtn); right.appendChild(listBtn); right.appendChild(recBtn); right.appendChild(flip); right.appendChild(exit);
    hud.appendChild(left); hud.appendChild(right);
    wrap.appendChild(hud);
    S.wrap = wrap; S.canvas = canvas; S.hud = hud; S.titleEl = title; S.countEl = cnt;
    bindControls();
  }
  var SV_ICONS = {
    play: "<polygon points='6 4 20 12 6 20'/>",
    pause: "<rect x='6' y='5' width='4' height='14' rx='1'/><rect x='14' y='5' width='4' height='14' rx='1'/>",
    next: "<polygon points='5 4 15 12 5 20'/><line x1='19' y1='5' x2='19' y2='19'/>",
    frame: "<path d='M8 3H5a2 2 0 0 0-2 2v3'/><path d='M21 8V5a2 2 0 0 0-2-2h-3'/><path d='M3 16v3a2 2 0 0 0 2 2h3'/><path d='M16 21h3a2 2 0 0 0 2-2v-3'/>",
    walk: "<circle cx='12' cy='4' r='1.6'/><path d='m9 20 3-6 3 6'/><path d='m6 9 6 2 6-2'/><path d='M12 11v3'/>",
    map: "<polygon points='3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6'/><line x1='9' y1='3' x2='9' y2='18'/><line x1='15' y1='6' x2='15' y2='21'/>",
    save: "<path d='M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z'/><polyline points='17 21 17 13 7 13 7 21'/><polyline points='7 3 7 8 15 8'/>",
    folder: "<path d='M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z'/>",
    download: "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='7 10 12 15 17 10'/><line x1='12' y1='15' x2='12' y2='3'/>",
    pin: "<path d='M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z'/><circle cx='12' cy='10' r='3'/>",
    pencil: "<path d='M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z'/><path d='m15 5 4 4'/>",
    list: "<line x1='8' y1='6' x2='21' y2='6'/><line x1='8' y1='12' x2='21' y2='12'/><line x1='8' y1='18' x2='21' y2='18'/><line x1='3' y1='6' x2='3.01' y2='6'/><line x1='3' y1='12' x2='3.01' y2='12'/><line x1='3' y1='18' x2='3.01' y2='18'/>",
    video: "<path d='m22 8-6 4 6 4V8Z'/><rect x='2' y='6' width='14' height='12' rx='2'/>",
    stop: "<rect x='6' y='6' width='12' height='12' rx='2'/>",
    flip: "<path d='m17 3 4 4-4 4'/><path d='M21 7H9a4 4 0 0 0-4 4'/><path d='m7 21-4-4 4-4'/><path d='M3 17h12a4 4 0 0 0 4-4'/>",
    exit: "<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'/><polyline points='16 17 21 12 16 7'/><line x1='21' y1='12' x2='9' y2='12'/>"
  };
  function svgIcon(name) {
    var p = SV_ICONS[name] || '';
    return "<svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' style='flex:none;pointer-events:none'>" + p + "</svg>";
  }
  function setBtn(btn, name, label) {
    btn.innerHTML = svgIcon(name) + (label ? ("<span>" + label + "</span>") : "");
  }
  function btnCss() {
    return 'display:inline-flex;align-items:center;gap:6px;background:#2a2f3a;color:#eef2f7;border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:6px 10px;font:600 12.5px system-ui,-apple-system,sans-serif;cursor:pointer;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)';
  }

  function bindControls() {
    var c = S.canvas, dragging = false, lx = 0, ly = 0, movedDist = 0, downT = 0;
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    c.addEventListener('mousedown', function (e) {
      dragging = true; lx = e.clientX; ly = e.clientY;
      movedDist = 0; downT = nowMs(); c.style.cursor = 'grabbing'; c.focus();
    });
    window.addEventListener('mouseup', function (e) {
      if (dragging && movedDist < 6 && (nowMs() - downT) < 600) doPick(e);
      dragging = false; if (S.canvas) S.canvas.style.cursor = 'grab';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging || !S.open) return;
      var dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      movedDist += Math.abs(dx) + Math.abs(dy);
      if (movedDist > 6) { S.tween = null; cancelTour(); }
      S.cam.yaw -= dx * 0.004 * S.cam.upSign;
      S.cam.pitch -= dy * 0.004;
      var lim = 1.55; if (S.cam.pitch > lim) S.cam.pitch = lim; if (S.cam.pitch < -lim) S.cam.pitch = -lim;
      S.needsSort = true;
    });
    c.addEventListener('wheel', function (e) {
      e.preventDefault(); S.tween = null; cancelTour();
      S.zoomVel += (e.deltaY > 0 ? -1 : 1) * S.step * 14;
    }, { passive: false });
    var keyName = function (e) {
      var c = e.code || '';
      if (c.indexOf('Key') === 0) return c.slice(3).toLowerCase();   // KeyW -> w (independent of RU/UA layout)
      if (c === 'ShiftLeft' || c === 'ShiftRight') return 'shift';
      if (c === 'Space') return 'jump';
      if (c === 'ArrowUp') return 'w';
      if (c === 'ArrowDown') return 's';
      if (c === 'ArrowLeft') return 'a';
      if (c === 'ArrowRight') return 'd';
      return (e.key || '').toLowerCase();
    };
    window.addEventListener('keydown', function (e) { if (!S.open) return; var kn = keyName(e); if (kn === 'jump' && S.walk) e.preventDefault(); S.keys[kn] = true; });
    window.addEventListener('keyup', function (e) { S.keys[keyName(e)] = false; if (e.key === 'Escape' && S.open) api.exit(); });
  }

  function toast(msg) { if (typeof window !== 'undefined' && typeof window.toast === 'function') window.toast(msg); }

  // ---------- public API ----------
  var api = {
    mount: function (host) {
      if (S.wrap) return;
      S.host = host || document.querySelector('.stage') || document.body;
      buildDom();
      S.host.appendChild(S.wrap);
    },
    load: function (arrayBuffer, name, _shOpts) {
      if (!S.wrap) api.mount();
      var parsed;
      try { parsed = detectAndParse(arrayBuffer, name || ''); }
      catch (err) { toast('Не удалось прочитать файл: ' + err.message); throw err; }
      if (!parsed.count) { toast('В файле нет сплэтов'); return; }
      S.buf = parsed.buffer; S.count = parsed.count; S.sh1 = null; // SH data: from direct opts, or from window.__lcc2SH (set by lcc2-loader before _bimOpenSplat), or parsed
      var _extSH = (typeof window !== 'undefined' && window.__lcc2SH) || null;
      if (_extSH) { try { window.__lcc2SH = null; } catch(e){} }
      S.vqLabels = (_shOpts && _shOpts.vqLabels) || (_extSH && _extSH.vqLabels) || parsed.vqLabels || null;
      S.shCentroids = (_shOpts && _shOpts.shCentroids) || (_extSH && _extSH.shCentroids) || parsed.shCentroids || null;
      S.renderBuf = parsed.renderBuffer || null; S.renderCount = parsed.renderCount || parsed.count;
      S.kind = parsed.kind || 'gaussian';
      S.sharp = (S.kind === 'points');
      if (S.sharpCb) S.sharpCb.checked = S.sharp;
      S.sceneKey = 'bimtwin.tour.v1.' + (name || 'scene') + '.' + parsed.count;
      // robust framing + outlier pruning (stray floaters otherwise blow up bounds ~1000x)
      var rb = robustBounds(S.buf, S.count);
      var pruned = pruneOutliers(S.buf, S.count, rb, 2.5, S.vqLabels);
      S._pruned = 0;
      if (pruned.count > 0 && pruned.count < S.count) {
        S._pruned = S.count - pruned.count;
        S.buf = pruned.buffer; S.count = pruned.count;
        if (pruned.vqLabels) S.vqLabels = pruned.vqLabels; // keep SH labels in sync with pruned splats
        rb = robustBounds(S.buf, S.count);
      }
      S.bounds = rb;
      S.step = Math.max(0.01, rb.radius * 0.02);
      var savedTour = loadPersistedStations();
      S.stations = (savedTour && savedTour.length) ? savedTour : computeStations(S.buf, S.count, 8, rb);
      S.tourIndex = 0; S.tourActive = false; S.tween = null; S._dwellSet = false; S.editMode = false;
      if (S.editBtn) S.editBtn.style.background = '#2a2f3a';
      if (S.tourBtn) S.tourBtn.textContent = '▶ Тур';
      // v1147: default is FREE FLIGHT (fly anywhere for overview); the "Ходьба" button
      // switches to the first-person avatar (gravity, jump, run, wall collision).
      var eyeH = Math.min(1.7, Math.max(0.8, (rb.hi[1] - rb.lo[1]) * 0.28));
      S.eyeH = eyeH; S.walkH = eyeH;
      S.playerRadius = 0.28;
      S.velY = 0; S.onGround = false;
      // v1148: camera view orientation only. Spawn/walk physics use absolute world Y and
      // are independent of this, so upSign only flips the RENDER. Default -1 renders this
      // Z-up->Y-up scan right-side up; remember the user's manual "Перевернуть" across sessions.
      var _su = -1; try { var _sv = (typeof localStorage !== 'undefined') ? localStorage.getItem('splat_up') : null; if (_sv === '1' || _sv === '-1') _su = parseInt(_sv, 10); } catch (e) {}
      S.cam.upSign = _su;
      // Collision voxels: finer vertical layers (0.35 m) for smoother floor-following & jumps.
      try { S.collision = buildCollisionGrid(S.buf, S.count, rb, { layerH: 0.35 }); } catch (e) { S.collision = null; }
      S.walk = false;
      if (S.walkBtn) S.walkBtn.style.background = '#2a2f3a';
      S._suppressPersist = true; buildMarkers(); S._suppressPersist = false;
      S.moveSpeed = S.step * 14;
      S.vel = [0, 0, 0]; S.zoomVel = 0;
      if (S.mmCanvas) S.mmCanvas.style.display = 'block';
      // Spawn INSIDE at the initial position (like LCC Studio): stand on the local floor
      // at eye height in the most central tour station, facing the room.
      var b = rb;
      var _sp = pickSpawn(S.stations, rb, S.collision, S.eyeH);
      S.cam.eye = [_sp.eye[0], _sp.eye[1], _sp.eye[2]];
      S.lockY = _sp.eye[1];
      S.cam.yaw = _sp.yaw; S.cam.pitch = 0;
      var unit = S.kind === 'points' ? ' точек' : ' сплэтов';
      var dispCount = S.kind === 'points' ? S.renderCount : S.count;
      if (S.titleEl) S.titleEl.textContent = (name || '3DGS') + (S.kind === 'points' ? '  ·  облако точек' : '');
      if (S.countEl) S.countEl.textContent = dispCount.toLocaleString('ru-RU') + unit + (parsed.stride > 1 ? ' (прорежено 1:' + parsed.stride + ' из ' + parsed.totalVertices.toLocaleString('ru-RU') + ')' : '');
      if (!S.gl) { try { initGL(); } catch (err) { toast(err.message); throw err; } }
      uploadScene();
      api.enter();
      if (S.kind === 'points') {
        toast('Облако точек. Показываю: ' + S.renderCount.toLocaleString('ru-RU') + ' точек' + (parsed.stride > 1 ? ' (прорежено 1:' + parsed.stride + ')' : ' — полная плотность'));
      } else {
        toast('3DGS загружен: ' + S.count.toLocaleString('ru-RU') + ' сплэтов');
      }
    },
    enter: function () {
      if (!S.wrap) return;
      S.wrap.style.display = 'block';
      S.open = true;
      resize();
      if (S.canvas) S.canvas.focus();
      cancelAnimationFrame(S.raf);
      S.raf = requestAnimationFrame(frame);
    },
    exit: function () {
      S.open = false;
      cancelAnimationFrame(S.raf);
      if (S.wrap) S.wrap.style.display = 'none';
      S.keys = {};
    },
    isOpen: function () { return !!S.open; },
    setExposure: function (v) { S.exposure = Math.max(0.3, Math.min(6, +v || 1)); },
    getExposure: function () { return S.exposure; },
    setPointScale: function (v) { S.sizeMul = Math.max(0.1, Math.min(3, +v || 1)); return S.sizeMul; },
    getPointScale: function () { return S.sizeMul; },
    setMaxPx: function (v) { S.maxPx = Math.max(4, Math.min(200, +v || 50)); return S.maxPx; },
    getMaxPx: function () { return S.maxPx; },
    // exposed for tests
    _buildCollisionGrid: buildCollisionGrid,
    _worldBlocked: worldBlocked,
    _resolveWalk: resolveWalk,
    _pickSpawn: pickSpawn,
    _sortIntervalMs: sortIntervalMs,
    _groundY: groundY,
    _integrateFall: integrateFall,
    _parsePly: parsePly,
    _parseSplat: parseSplat,
    _floatToHalf: floatToHalf,
    _computeBounds: computeBounds,
    _robustBounds: robustBounds,
    _pruneOutliers: pruneOutliers,
    _screenRayDir: screenRayDir,
    _raycastNearest: raycastNearest,
    _computeStations: computeStations,
    _anglesFromDir: anglesFromDir,
    _projectPoint: projectPoint,
    _stepVelocity: stepVelocity,
    _mmMap: mmMap,
    _mmInv: mmInv,
    _serializeTour: serializeTour,
    _deserializeTour: deserializeTour,
    _makeStation: makeStation,
    _withStationAdded: withStationAdded,
    _withStationRemoved: withStationRemoved,
    _withStationRenamed: withStationRenamed,
    _withStationMoved: withStationMoved,
    _mmNearestStation: mmNearestStation,
    _routePolyline: routePolyline,
    _estimateTourDurationMs: estimateTourDurationMs,
    _catmullRomSpline: catmullRomSpline,
    _stationCaption: stationCaption,
    _approachAlpha: approachAlpha,
    _subtitleText: subtitleText
  };

  if (typeof window !== 'undefined') window.SplatViewer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
