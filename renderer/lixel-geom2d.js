/* lixel-geom2d.js — v1150
 * Чистая 2D-геометрия для инструментов «Рисование плоскости»:
 * дуга по 3 точкам, символы двери/окна, булевы/редакторские операции над
 * отрезками (Расширить/Разделить/Пересечение/Копирование) и извлечение линий
 * (AI-извлечение) из точек сечения через RANSAC. Без внешних зависимостей.
 * Экспорт: window.LxGeom2D и module.exports (для юнит-тестов node --test).
 */
(function () {
  'use strict';

  function _sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function _len(a) { return Math.hypot(a[0], a[1]); }
  function _dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  // Дуга по 3 точкам: центр, радиус, углы и полилиния сегментов.
  function arcFrom3Points(a, b, c, opts) {
    opts = opts || {};
    var ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return null; // коллинеарны
    var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    var center = [ux, uy];
    var r = _dist(center, a);
    var a0 = Math.atan2(ay - uy, ax - ux);
    var a1 = Math.atan2(cy - uy, cx - ux);
    var am = Math.atan2(by - uy, bx - ux);
    // выбираем направление обхода, включающее среднюю точку
    function norm(t) { while (t < 0) t += Math.PI * 2; while (t >= Math.PI * 2) t -= Math.PI * 2; return t; }
    var s = norm(a0), e = norm(a1), mid = norm(am);
    var ccw = true;
    var spanCCW = norm(e - s);
    var midCCW = norm(mid - s);
    if (!(midCCW <= spanCCW)) { ccw = false; }
    var steps = Math.max(6, opts.segments || 32);
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var ang;
      if (ccw) ang = s + spanCCW * t;
      else { var spanCW = Math.PI * 2 - spanCCW; ang = s - spanCW * t; }
      pts.push([ux + r * Math.cos(ang), uy + r * Math.sin(ang)]);
    }
    return { center: center, radius: r, startAngle: a0, endAngle: a1, ccw: ccw, points: pts };
  }

  // Пересечение двух отрезков p1p2 и p3p4. Возвращает точку или null.
  function segIntersect(p1, p2, p3, p4, opts) {
    opts = opts || {};
    var infinite = !!opts.infinite; // трактовать как бесконечные прямые
    var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    var x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-12) return null; // параллельны
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    var u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
    if (!infinite) { if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null; }
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }

  // Расширить: продлить отрезок seg до пересечения с целевой прямой target.
  // movingEnd = 1 двигает конец, 0 — начало.
  function extendSegment(seg, target, movingEnd) {
    var hit = segIntersect(seg[0], seg[1], target[0], target[1], { infinite: true });
    if (!hit) return null;
    var out = [seg[0].slice(), seg[1].slice()];
    out[movingEnd ? 1 : 0] = hit;
    return out;
  }

  // Разделить полилинию по индексу вершины: две полилинии, делящие эту вершину.
  function splitPolyline(pts, index) {
    if (!pts || index <= 0 || index >= pts.length - 1) return null;
    var a = pts.slice(0, index + 1);
    var b = pts.slice(index);
    return [a, b];
  }

  // Копирование со сдвигом (dx,dy).
  function copyEntity(pts, dx, dy) {
    return (pts || []).map(function (p) { return [p[0] + dx, p[1] + dy]; });
  }

  // Символ двери: косяк (отрезок) + створка + дуга поворота 90°.
  function doorSymbol(p0, p1, opts) {
    opts = opts || {};
    var hinge = opts.hinge === 'end' ? p1 : p0;
    var far = hinge === p0 ? p1 : p0;
    var w = _dist(p0, p1);
    var dir = [(far[0] - hinge[0]) / (w || 1), (far[1] - hinge[1]) / (w || 1)];
    var sign = opts.swing === 'cw' ? -1 : 1;
    var perp = [-dir[1] * sign, dir[0] * sign];
    var leafEnd = [hinge[0] + perp[0] * w, hinge[1] + perp[1] * w];
    var steps = opts.segments || 24;
    var arc = [];
    var a0 = Math.atan2(far[1] - hinge[1], far[0] - hinge[0]);
    for (var i = 0; i <= steps; i++) {
      var ang = a0 + sign * (Math.PI / 2) * (i / steps);
      arc.push([hinge[0] + w * Math.cos(ang), hinge[1] + w * Math.sin(ang)]);
    }
    return { jamb: [p0, p1], leaf: [hinge, leafEnd], swing: arc, width: w };
  }

  // Символ окна: два параллельных отрезка (рама) толщиной t.
  function windowSymbol(p0, p1, opts) {
    opts = opts || {};
    var t = opts.thickness != null ? opts.thickness : _dist(p0, p1) * 0.12;
    var d = _sub(p1, p0); var L = _len(d) || 1; var perp = [-d[1] / L, d[0] / L];
    var h = t / 2;
    return {
      outer: [p0, p1],
      side1: [[p0[0] + perp[0] * h, p0[1] + perp[1] * h], [p1[0] + perp[0] * h, p1[1] + perp[1] * h]],
      side2: [[p0[0] - perp[0] * h, p0[1] - perp[1] * h], [p1[0] - perp[0] * h, p1[1] - perp[1] * h]],
      thickness: t
    };
  }

  // Площадь замкнутого многоугольника (формула шнуровки).
  function polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    var s = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  // AI-извлечение: RANSAC-извлечение прямолинейных отрезков из набора 2D-точек
  // (например точек сечения). Возвращает массив отрезков [[x,y],[x,y]].
  function ransacLines(points, opts) {
    opts = opts || {};
    var pts = (points || []).map(function (p) { return [p[0], p[1]]; });
    var n = pts.length;
    if (n < 2) return [];
    // масштаб для допуска
    var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (var i = 0; i < n; i++) { var p = pts[i]; if (p[0] < mnx) mnx = p[0]; if (p[1] < mny) mny = p[1]; if (p[0] > mxx) mxx = p[0]; if (p[1] > mxy) mxy = p[1]; }
    var diag = Math.hypot(mxx - mnx, mxy - mny) || 1;
    var tol = opts.tol != null ? opts.tol : diag * 0.01;
    var minInliers = opts.minInliers != null ? opts.minInliers : Math.max(2, Math.floor(n * 0.05));
    var iters = opts.iters != null ? opts.iters : 200;
    var maxLines = opts.maxLines != null ? opts.maxLines : 12;
    var seed = (opts.seed != null ? opts.seed : 12345) >>> 0;
    function rng() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    var used = new Uint8Array(n);
    var remaining = n;
    var segs = [];
    while (segs.length < maxLines && remaining >= minInliers) {
      var bestCnt = 0, bestLine = null, bestInl = null;
      for (var it = 0; it < iters; it++) {
        var i0 = (rng() * n) | 0, i1 = (rng() * n) | 0;
        if (i0 === i1 || used[i0] || used[i1]) continue;
        var a = pts[i0], b = pts[i1];
        var dx = b[0] - a[0], dy = b[1] - a[1]; var L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        var nx = -dy / L, ny = dx / L; var c = -(nx * a[0] + ny * a[1]);
        var cnt = 0; var inl = [];
        for (var k = 0; k < n; k++) {
          if (used[k]) continue;
          var d2 = Math.abs(nx * pts[k][0] + ny * pts[k][1] + c);
          if (d2 <= tol) { cnt++; inl.push(k); }
        }
        if (cnt > bestCnt) { bestCnt = cnt; bestLine = [nx, ny, c, dx / L, dy / L, a]; bestInl = inl; }
      }
      if (!bestLine || bestCnt < minInliers) break;
      // проекция инлайеров на направление -> крайние точки отрезка
      var dirx = bestLine[3], diry = bestLine[4], base = bestLine[5];
      var tmin = Infinity, tmax = -Infinity;
      for (var q = 0; q < bestInl.length; q++) {
        var idx = bestInl[q]; used[idx] = 1;
        var tp = (pts[idx][0] - base[0]) * dirx + (pts[idx][1] - base[1]) * diry;
        if (tp < tmin) tmin = tp; if (tp > tmax) tmax = tp;
      }
      remaining -= bestInl.length;
      segs.push([[base[0] + dirx * tmin, base[1] + diry * tmin], [base[0] + dirx * tmax, base[1] + diry * tmax]]);
    }
    return segs;
  }

  var API = {
    arcFrom3Points: arcFrom3Points,
    segIntersect: segIntersect,
    extendSegment: extendSegment,
    splitPolyline: splitPolyline,
    copyEntity: copyEntity,
    doorSymbol: doorSymbol,
    windowSymbol: windowSymbol,
    polygonArea: polygonArea,
    ransacLines: ransacLines
  };
  if (typeof window !== 'undefined') window.LxGeom2D = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
