/*
 * pointcloud-octree.js — in-memory LOD (уровни детализации) для больших облаков точек.
 *
 * Подход (упрощённый Potree): 2 уровня.
 *   1) coarse — равномерная подвыборка всего облака (всегда рисуется — нет дыр вдали).
 *   2) cells — равномерная 3D-сетка октантов; каждая ячейка хранит ВСЕ свои точки.
 * Рендерер каждый кадр рисует coarse + ближайшие видимые ячейки на полной детали
 * в пределах бюджета точек — близко чётко, вдали экономно, FPS стабилен.
 *
 *   build(pos:Float32Array, col:Float32Array|null, opts?) ->
 *     { cells:[{mn,mx,pos,col}], coarse:{pos,col}, bbox:{mn,mx}, dim, cellCount, total }
 *
 * Чистый JS/TypedArray — без GPU, покрыт unit-тестами (test/octree.test.js).
 */
(function () {
  'use strict';

  function build(pos, col, opts) {
    opts = opts || {};
    var n = (pos.length / 3) | 0;
    var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (var i = 0; i < pos.length; i += 3) {
      var x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    if (!isFinite(mnx)) { mnx = mny = mnz = 0; mxx = mxy = mxz = 1; }
    var ext = [Math.max(1e-6, mxx - mnx), Math.max(1e-6, mxy - mny), Math.max(1e-6, mxz - mnz)];

    var pointsPerCell = opts.pointsPerCell || 120000;
    var dim = Math.round(Math.cbrt(n / pointsPerCell));
    if (!(dim >= 2)) dim = 2; if (dim > 12) dim = 12;
    var cw = ext[0] / dim, ch = ext[1] / dim, cd = ext[2] / dim;
    var ncell = dim * dim * dim;

    function idxOf(x, y, z) {
      var cx = Math.floor((x - mnx) / cw); if (cx < 0) cx = 0; if (cx >= dim) cx = dim - 1;
      var cy = Math.floor((y - mny) / ch); if (cy < 0) cy = 0; if (cy >= dim) cy = dim - 1;
      var cz = Math.floor((z - mnz) / cd); if (cz < 0) cz = 0; if (cz >= dim) cz = dim - 1;
      return (cx * dim + cy) * dim + cz;
    }

    var counts = new Int32Array(ncell);
    for (var p = 0; p < pos.length; p += 3) counts[idxOf(pos[p], pos[p + 1], pos[p + 2])]++;

    var cellMap = new Map();
    for (var k = 0; k < ncell; k++) {
      if (counts[k] > 0) cellMap.set(k, {
        pos: new Float32Array(counts[k] * 3),
        col: col ? new Float32Array(counts[k] * 3) : null,
        w: 0, mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity]
      });
    }

    for (var q = 0; q < n; q++) {
      var bx = pos[q * 3], by = pos[q * 3 + 1], bz = pos[q * 3 + 2];
      var c = cellMap.get(idxOf(bx, by, bz)); var w = c.w;
      c.pos[w * 3] = bx; c.pos[w * 3 + 1] = by; c.pos[w * 3 + 2] = bz;
      if (col && c.col) { c.col[w * 3] = col[q * 3]; c.col[w * 3 + 1] = col[q * 3 + 1]; c.col[w * 3 + 2] = col[q * 3 + 2]; }
      if (bx < c.mn[0]) c.mn[0] = bx; if (by < c.mn[1]) c.mn[1] = by; if (bz < c.mn[2]) c.mn[2] = bz;
      if (bx > c.mx[0]) c.mx[0] = bx; if (by > c.mx[1]) c.mx[1] = by; if (bz > c.mx[2]) c.mx[2] = bz;
      c.w++;
    }

    var cells = [];
    cellMap.forEach(function (c) { cells.push({ mn: c.mn, mx: c.mx, pos: c.pos, col: c.col }); });

    var coarseBudget = opts.coarseBudget || 5000000;
    var stride = n > coarseBudget ? Math.ceil(n / coarseBudget) : 1;
    var cc = 0; for (var s = 0; s < n; s += stride) cc++;
    var cpos = new Float32Array(cc * 3); var ccol = col ? new Float32Array(cc * 3) : null; var oi = 0;
    for (var j = 0; j < n; j += stride) {
      cpos[oi * 3] = pos[j * 3]; cpos[oi * 3 + 1] = pos[j * 3 + 1]; cpos[oi * 3 + 2] = pos[j * 3 + 2];
      if (col && ccol) { ccol[oi * 3] = col[j * 3]; ccol[oi * 3 + 1] = col[j * 3 + 1]; ccol[oi * 3 + 2] = col[j * 3 + 2]; }
      oi++;
    }

    return {
      cells: cells,
      coarse: { pos: cpos, col: ccol },
      bbox: { mn: [mnx, mny, mnz], mx: [mxx, mxy, mxz] },
      dim: dim, cellCount: cells.length, total: n
    };
  }

  var api = { build: build };
  if (typeof window !== 'undefined') window.PCLod = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
