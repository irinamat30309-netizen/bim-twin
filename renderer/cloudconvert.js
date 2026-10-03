/*
 * cloudconvert.js — offline point-cloud -> 3DGS (gaussian splat) converter for BIM Twin.
 *
 * Turns an xyz(+rgb) point cloud into a binary gaussian-splat PLY where every voxel
 * becomes an overlapping oriented gaussian (surfel). The overlapping splats fill the
 * black gaps between discrete points, so the scene looks solid / photo-like instead of
 * "round dots on black". The result plugs straight into the tour (window.SplatViewer /
 * PCSplat) via SplatViewer.load(buffer, name).
 *
 * Runs fully in-app (pure JS) — no Python, no Open3D, no external converter.
 * NOTE: this is NOT trained 3DGS-from-photos; it is a surfel-splat rebake of the cloud,
 * which is the best "solid" look achievable from raw xyz+rgb without source imagery.
 *
 * Pure function exported for node tests: pointsToSplat.
 * API: window.CloudConvert = { pointsToSplat }
 */
(function () {
  'use strict';

  var SH_C0 = 0.28209479177387814;
  function invSigmoid(p) { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(p / (1 - p)); }
  function isNum(v) { return v === v && v !== Infinity && v !== -Infinity; }

  // Detect the 0..1 (float) vs 0..255 (byte) color convention by sampling.
  function detectColMul(col, n, stride) {
    if (!col || !stride) return 1;
    var max = 0, lim = Math.min(n, 10000);
    for (var i = 0; i < lim; i++) {
      var b = i * stride;
      var r = col[b], g = col[b + 1], bl = col[b + 2];
      if (r > max) max = r; if (g > max) max = g; if (bl > max) max = bl;
    }
    return (max <= 1.0001) ? 255 : 1;
  }

  /*
   * pos: Float32Array|Array of xyz, length = 3*N
   * col: Uint8Array|Float32Array|Array of rgb/rgba, or null
   * opts: { targetSplats, voxel, scaleMul, opacity, colStride, maxInput }
   * returns { buffer: ArrayBuffer (gaussian PLY), count, voxel }
   */
  function pointsToSplat(pos, col, opts) {
    opts = opts || {};
    if (!pos || pos.length < 3) throw new Error('\u043f\u0443\u0441\u0442\u043e\u0435 \u043e\u0431\u043b\u0430\u043a\u043e');
    var nAll = Math.floor(pos.length / 3);

    // Bound runtime on very large clouds by stride-sampling the input.
    var maxInput = opts.maxInput || 40000000;
    var inStride = (nAll > maxInput) ? Math.ceil(nAll / maxInput) : 1;

    var colStride = opts.colStride || (col && col.length ? Math.round(col.length / nAll) : 0);
    if (colStride !== 3 && colStride !== 4) colStride = (col && col.length) ? 3 : 0;
    var colMul = detectColMul(col, nAll, colStride);

    // Bounds from the sampled set.
    var minx = Infinity, miny = Infinity, minz = Infinity;
    var maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    var i, b, x, y, z;
    for (i = 0; i < nAll; i += inStride) {
      b = i * 3; x = pos[b]; y = pos[b + 1]; z = pos[b + 2];
      if (!isNum(x) || !isNum(y) || !isNum(z)) continue;
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
    }
    if (!(minx <= maxx)) throw new Error('\u043d\u0435\u0442 \u0432\u0430\u043b\u0438\u0434\u043d\u044b\u0445 \u0442\u043e\u0447\u0435\u043a');
    var dx = maxx - minx, dy = maxy - miny, dz = maxz - minz;
    var diag = Math.hypot(dx, dy, dz) || 1;
    var target = opts.targetSplats || 2500000;

    // Adaptive voxel size so occupied voxels stay <= target.
    var voxel = opts.voxel || (diag / 900);
    var minVoxel = diag / 8000;
    if (voxel < minVoxel) voxel = minVoxel;

    var KY = 2048, KZ = 2048; // key packing multipliers
    var map = null, tries = 0;
    while (true) {
      var inv = 1 / voxel;
      var nx = Math.floor(dx * inv) + 1, ny = Math.floor(dy * inv) + 1, nz = Math.floor(dz * inv) + 1;
      if (nx >= 2048 || ny >= KY || nz >= KZ) { voxel *= 1.7; if (++tries > 60) throw new Error('\u0441\u043b\u0438\u0448\u043a\u043e\u043c \u0431\u043e\u043b\u044c\u0448\u0430\u044f \u0441\u0435\u0442\u043a\u0430'); continue; }
      map = new Map();
      for (i = 0; i < nAll; i += inStride) {
        b = i * 3; x = pos[b]; y = pos[b + 1]; z = pos[b + 2];
        if (!isNum(x) || !isNum(y) || !isNum(z)) continue;
        var gx = Math.floor((x - minx) * inv);
        var gy = Math.floor((y - miny) * inv);
        var gz = Math.floor((z - minz) * inv);
        var key = (gx * KY + gy) * KZ + gz;
        var cr, cg, cb;
        if (colStride) { var cbi = i * colStride; cr = col[cbi] * colMul; cg = col[cbi + 1] * colMul; cb = col[cbi + 2] * colMul; }
        else { cr = 180; cg = 180; cb = 180; }
        var e = map.get(key);
        if (e === undefined) map.set(key, [x, y, z, cr, cg, cb, 1]);
        else { e[0] += x; e[1] += y; e[2] += z; e[3] += cr; e[4] += cg; e[5] += cb; e[6]++; }
      }
      if (map.size <= target || voxel >= diag / 30) break;
      voxel *= Math.cbrt(map.size / target) * 1.06;
      if (++tries > 60) break;
    }

    var m = map.size;
    if (!m) throw new Error('\u043d\u0435\u0442 \u0442\u043e\u0447\u0435\u043a \u043f\u043e\u0441\u043b\u0435 \u0432\u043e\u043a\u0441\u0435\u043b\u0438\u0437\u0430\u0446\u0438\u0438');

    var header =
      'ply\n' +
      'format binary_little_endian 1.0\n' +
      'element vertex ' + m + '\n' +
      'property float x\nproperty float y\nproperty float z\n' +
      'property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n' +
      'property float opacity\n' +
      'property float scale_0\nproperty float scale_1\nproperty float scale_2\n' +
      'property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n' +
      'end_header\n';
    var enc;
    if (typeof TextEncoder !== 'undefined') enc = new TextEncoder().encode(header);
    else { enc = new Uint8Array(header.length); for (var k = 0; k < header.length; k++) enc[k] = header.charCodeAt(k) & 255; }

    var REC = 14 * 4; // 14 float32 per splat
    var out = new ArrayBuffer(enc.length + m * REC);
    new Uint8Array(out).set(enc, 0);
    var dv = new DataView(out);
    var off = enc.length;

    var scaleMul = (opts.scaleMul != null) ? opts.scaleMul : 0.6;
    var sigma = voxel * scaleMul; if (!(sigma > 0)) sigma = voxel || 1e-4;
    var logScale = Math.log(sigma);
    var opac = invSigmoid((opts.opacity != null) ? opts.opacity : 0.92);

    var it = map.values(), r;
    while (!(r = it.next()).done) {
      var v = r.value, c = v[6] || 1;
      dv.setFloat32(off, v[0] / c, true); off += 4;
      dv.setFloat32(off, v[1] / c, true); off += 4;
      dv.setFloat32(off, v[2] / c, true); off += 4;
      var rr = (v[3] / c) / 255, gg = (v[4] / c) / 255, bb = (v[5] / c) / 255;
      dv.setFloat32(off, (rr - 0.5) / SH_C0, true); off += 4;
      dv.setFloat32(off, (gg - 0.5) / SH_C0, true); off += 4;
      dv.setFloat32(off, (bb - 0.5) / SH_C0, true); off += 4;
      dv.setFloat32(off, opac, true); off += 4;
      dv.setFloat32(off, logScale, true); off += 4;
      dv.setFloat32(off, logScale, true); off += 4;
      dv.setFloat32(off, logScale, true); off += 4;
      dv.setFloat32(off, 1, true); off += 4; // rot_0 (w) = identity; isotropic scale => rotation irrelevant
      dv.setFloat32(off, 0, true); off += 4;
      dv.setFloat32(off, 0, true); off += 4;
      dv.setFloat32(off, 0, true); off += 4;
    }
    return { buffer: out, count: m, voxel: voxel };
  }

  var apiObj = { pointsToSplat: pointsToSplat };
  if (typeof window !== 'undefined') window.CloudConvert = apiObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
})();
