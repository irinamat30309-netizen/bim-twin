/*
 * snap.js — чистый движок привязок для черчения (2D в координатах плоскости проекции).
 * Привязка к: вершинам/концам, пересечениям, серединам, сетке; орто/угловое ограничение.
 * window.Snap + module.exports (для тестов).
 */
(function () {
  'use strict';
  function dist2(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

  // пересечение двух отрезков (собственное, в пределах обоих) — точка или null
  function segInt(p1, p2, p3, p4) {
    var d1x = p2[0] - p1[0], d1y = p2[1] - p1[1], d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
    var den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return null;
    var t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
    var u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return [p1[0] + t * d1x, p1[1] + t * d1y];
  }

  function collectVertices(ents) {
    var vs = [];
    ents.forEach(function (e) {
      if (e.type === 'line') { vs.push(e.a, e.b); }
      else if (e.type === 'polyline') { (e.points || []).forEach(function (p) { vs.push(p); }); }
      else if (e.type === 'point') { vs.push(e.p); }
      else if (e.type === 'circle') { vs.push(e.c); }
      else if (e.type === 'dim') { vs.push(e.a, e.b); }
    });
    return vs;
  }
  function collectSegments(ents) {
    var segs = [];
    ents.forEach(function (e) {
      if (e.type === 'line' || e.type === 'dim') segs.push([e.a, e.b]);
      else if (e.type === 'polyline') {
        var P = e.points || [];
        for (var i = 0; i < P.length - 1; i++) segs.push([P[i], P[i + 1]]);
        if (e.closed && P.length > 2) segs.push([P[P.length - 1], P[0]]);
      }
    });
    return segs;
  }
  function midpoints(segs) { return segs.map(function (s) { return mid(s[0], s[1]); }); }
  function allIntersections(segs) {
    var out = [];
    for (var i = 0; i < segs.length; i++) for (var j = i + 1; j < segs.length; j++) {
      var p = segInt(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (p) out.push(p);
    }
    return out;
  }

  // Привязка курсора (2D в плоскости) к ближайшей геометрической особенности.
  // opts: { tol, vertex, intersection, midpoint, grid, extraPoints }. Приоритет: vertex > intersection > midpoint > grid.
  function snap(cursor, ents, opts) {
    opts = opts || {};
    var tol = opts.tol != null ? opts.tol : 0.25;
    var tol2 = tol * tol;
    var rank = { vertex: 3, intersection: 2, midpoint: 1, grid: 0, point: 3 };
    var best = null, bestScore = -1, bestd = tol2;
    function consider(p, type) {
      var d = dist2(cursor, p);
      if (d > tol2) return;
      var r = rank[type] != null ? rank[type] : 0;
      // выбираем по приоритету, при равенстве — по близости
      if (r > bestScore || (r === bestScore && d < bestd)) {
        best = { point: [p[0], p[1]], type: type, dist: Math.sqrt(d) };
        bestScore = r; bestd = d;
      }
    }
    if (opts.extraPoints) opts.extraPoints.forEach(function (p) { consider(p, 'point'); });
    if (opts.vertex !== false) collectVertices(ents).forEach(function (p) { consider(p, 'vertex'); });
    var segs = null;
    if (opts.intersection !== false) { segs = collectSegments(ents); allIntersections(segs).forEach(function (p) { consider(p, 'intersection'); }); }
    if (opts.midpoint) { if (!segs) segs = collectSegments(ents); midpoints(segs).forEach(function (p) { consider(p, 'midpoint'); }); }
    if (opts.grid) { var g = opts.grid; consider([Math.round(cursor[0] / g) * g, Math.round(cursor[1] / g) * g], 'grid'); }
    return best;
  }

  // Ограничение направления от base к cur по шагу угла (по умолчанию 90° = орто).
  function orthoConstrain(base, cur, opts) {
    opts = opts || {};
    var step = (opts.angleStep || 90) * Math.PI / 180;
    var dx = cur[0] - base[0], dy = cur[1] - base[1];
    var len = Math.hypot(dx, dy);
    if (len < 1e-9) return [cur[0], cur[1]];
    var ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return [base[0] + Math.cos(ang) * len, base[1] + Math.sin(ang) * len];
  }

  var Snap = { dist2: dist2, mid: mid, segInt: segInt, collectVertices: collectVertices, collectSegments: collectSegments, midpoints: midpoints, allIntersections: allIntersections, snap: snap, orthoConstrain: orthoConstrain };
  if (typeof window !== 'undefined') window.Snap = Snap;
  if (typeof module !== 'undefined' && module.exports) module.exports = Snap;
})();
