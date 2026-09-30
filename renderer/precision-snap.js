/*
 * precision-snap.js — точный захват точек облака: угол, ребро, плоскость, точка.
 *
 * Зачем. Клик «на глаз» по плотному облаку почти всегда попадает в шум: лазер мог лечь на пару миллиметров в сторону
 * от настоящего угла. Профессиональные программы (Lixel, CloudCompare, Leica Cyclone) поэтому меряют не по одиночной
 * точке, а по геометрии, вписанной в облако: плоскость по методу наименьших квадратов, ребро как пересечение двух
 * плоскостей, угол как пересечение трёх. Здесь то же самое, но автоматически: курсор около угла даёт координату угла
 * с точностью до шума вписанных плоскостей, а не до положения случайной точки.
 *
 * Правила (чтобы результат был одинаковым при одинаковом клике):
 *   • всё детерминировано: генератор случайных чисел зависит только от координат клика и числа точек;
 *   • масштаб не привязан к метрам: допуски считаются от расстояния между точками облака (spacing);
 *   • одна плоскость не превращается в «ребро»: для ребра и угла нужны плоскости с реальной поверхностью и
 *     заметным углом между ними, поддержанные точками рядом с самой линией/точкой.
 *
 * Экспорт: window.PrecisionSnap и module.exports (для тестов). Чистые функции, без DOM.
 * Плоскость: n·x + d = 0, |n| = 1.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.PrecisionSnap = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var MIN_EDGE_SIN = Math.sin(18 * DEG);       // плоскости под углом меньше 18° ребром не считаем
  var PARALLEL_COS = Math.cos(3 * DEG);        // параллельными считаем плоскости/рёбра в пределах 3°

  /* ---------- Малые помощники ---------- */
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function unit(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFor(p, n) {
    var h = 2166136261 >>> 0;
    for (var k = 0; k < 3; k++) { h ^= (Math.round(p[k] * 1000) | 0) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
    h ^= (n | 0) >>> 0; h = Math.imul(h, 16777619) >>> 0;
    return h >>> 0;
  }

  /* Наименьший собственный вектор симметричной 3×3 (Якоби). m = [xx, xy, xz, yy, yz, zz]. */
  function smallestEigenvector(m) {
    var a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 24; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-18) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        var t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        var c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (var k = 0; k < 3; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (k = 0; k < 3; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (k = 0; k < 3; k++) { var vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    var best = 0;
    for (var i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
    return { normal: unit([v[0][best], v[1][best], v[2][best]]), values: [a[0][0], a[1][1], a[2][2]] };
  }

  /* ---------- Пространственный индекс (равномерная сетка) ---------- */
  function buildIndex(pos, opts) {
    opts = opts || {};
    var n = opts.count != null ? Math.min(opts.count, Math.floor(pos.length / 3)) : Math.floor(pos.length / 3);
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < n; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
      if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
      if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
    }
    if (!n || !isFinite(mn[0])) return { n: 0, pos: pos, spacing: 0, query: function () { return new Int32Array(0); }, nearest: function () { return -1; } };
    var ex = Math.max(mx[0] - mn[0], 1e-9), ey = Math.max(mx[1] - mn[1], 1e-9), ez = Math.max(mx[2] - mn[2], 1e-9);
    // ячейка: около 8 точек на ячейку при равномерном заполнении объёма; не больше 8 млн ячеек
    var cell = opts.cell || Math.cbrt((ex * ey * ez) / Math.max(1, n / 8));
    var minCell = Math.cbrt((ex * ey * ez) / 8e6);
    cell = Math.max(cell, minCell, Math.max(ex, ey, ez) / 4096);
    var dx = Math.max(1, Math.ceil(ex / cell)), dy = Math.max(1, Math.ceil(ey / cell)), dz = Math.max(1, Math.ceil(ez / cell));
    while (dx * dy * dz > 8e6) { cell *= 1.25; dx = Math.max(1, Math.ceil(ex / cell)); dy = Math.max(1, Math.ceil(ey / cell)); dz = Math.max(1, Math.ceil(ez / cell)); }
    var cells = dx * dy * dz, inv = 1 / cell;
    var start = new Int32Array(cells + 1), key = new Int32Array(n);
    for (i = 0; i < n; i++) {
      var ix = Math.min(dx - 1, ((pos[i * 3] - mn[0]) * inv) | 0), iy = Math.min(dy - 1, ((pos[i * 3 + 1] - mn[1]) * inv) | 0), iz = Math.min(dz - 1, ((pos[i * 3 + 2] - mn[2]) * inv) | 0);
      var kk = (iz * dy + iy) * dx + ix; key[i] = kk; start[kk + 1]++;
    }
    for (i = 0; i < cells; i++) start[i + 1] += start[i];
    var fill = start.slice(0, cells), order = new Int32Array(n);
    for (i = 0; i < n; i++) order[fill[key[i]]++] = i;
    var idx = { n: n, pos: pos, mn: mn, mx: mx, cell: cell, dims: [dx, dy, dz], start: start, order: order, spacing: 0 };
    idx.query = function (cx, cy, cz, r, cap) { return queryIndex(idx, cx, cy, cz, r, cap); };
    idx.nearest = function (cx, cy, cz, r) { return nearestIndex(idx, cx, cy, cz, r); };
    idx.spacing = estimateSpacing(idx);
    return idx;
  }

  function cellRange(idx, c, r, axis) {
    var lo = Math.floor((c - r - idx.mn[axis]) / idx.cell), hi = Math.floor((c + r - idx.mn[axis]) / idx.cell);
    return [Math.max(0, lo), Math.min(idx.dims[axis] - 1, hi)];
  }
  function queryIndex(idx, cx, cy, cz, r, cap) {
    if (!idx.n) return new Int32Array(0);
    var rx = cellRange(idx, cx, r, 0), ry = cellRange(idx, cy, r, 1), rz = cellRange(idx, cz, r, 2);
    var P = idx.pos, r2 = r * r, out = [], dx = idx.dims[0], dy = idx.dims[1];
    for (var iz = rz[0]; iz <= rz[1]; iz++) for (var iy = ry[0]; iy <= ry[1]; iy++) {
      var row = (iz * dy + iy) * dx;
      var s = idx.start[row + rx[0]], e = idx.start[row + rx[1] + 1];
      for (var k = s; k < e; k++) {
        var i = idx.order[k], ax = P[i * 3] - cx, ay = P[i * 3 + 1] - cy, az = P[i * 3 + 2] - cz;
        if (ax * ax + ay * ay + az * az <= r2) out.push(i);
      }
    }
    if (cap && out.length > cap) {
      var step = out.length / cap, thin = new Int32Array(cap);
      for (var j = 0; j < cap; j++) thin[j] = out[Math.floor(j * step)];
      return thin;
    }
    return Int32Array.from(out);
  }
  function nearestIndex(idx, cx, cy, cz, r) {
    var ids = queryIndex(idx, cx, cy, cz, r, 0), best = -1, bd = Infinity, P = idx.pos;
    for (var k = 0; k < ids.length; k++) {
      var i = ids[k], ax = P[i * 3] - cx, ay = P[i * 3 + 1] - cy, az = P[i * 3 + 2] - cz, d = ax * ax + ay * ay + az * az;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  /* Типичное расстояние до ближайшего соседа: медиана по ~300 точкам. */
  function estimateSpacing(idx) {
    var n = idx.n, sample = Math.min(300, n), step = Math.max(1, Math.floor(n / sample)), ds = [], P = idx.pos;
    for (var s = 0; s < n && ds.length < sample; s += step) {
      var cx = P[s * 3], cy = P[s * 3 + 1], cz = P[s * 3 + 2];
      var ids = queryIndex(idx, cx, cy, cz, idx.cell, 400), bd = Infinity;
      for (var k = 0; k < ids.length; k++) {
        var i = ids[k]; if (i === s) continue;
        var ax = P[i * 3] - cx, ay = P[i * 3 + 1] - cy, az = P[i * 3 + 2] - cz, d = ax * ax + ay * ay + az * az;
        if (d > 0 && d < bd) bd = d;
      }
      if (isFinite(bd)) ds.push(Math.sqrt(bd));
    }
    if (!ds.length) return idx.cell / 4;
    ds.sort(function (a, b) { return a - b; });
    return ds[ds.length >> 1];
  }

  /* ---------- Плоскости в окрестности точки ---------- */
  function fitLSQ(Q, ids, count) {
    var cx = 0, cy = 0, cz = 0, i, k;
    for (k = 0; k < count; k++) { i = ids[k] * 3; cx += Q[i]; cy += Q[i + 1]; cz += Q[i + 2]; }
    cx /= count; cy /= count; cz /= count;
    var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (k = 0; k < count; k++) {
      i = ids[k] * 3; var x = Q[i] - cx, y = Q[i + 1] - cy, z = Q[i + 2] - cz;
      xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
    }
    var e = smallestEigenvector([xx / count, xy / count, xz / count, yy / count, yz / count, zz / count]);
    var nrm = e.normal, lam = e.values.slice().sort(function (a, b) { return a - b; });
    return { normal: nrm, d: -(nrm[0] * cx + nrm[1] * cy + nrm[2] * cz), centroid: [cx, cy, cz], lam: lam };
  }
  function planeDist(p, Q, i) { return p.normal[0] * Q[i * 3] + p.normal[1] * Q[i * 3 + 1] + p.normal[2] * Q[i * 3 + 2] + p.d; }

  /* Последовательный RANSAC с уточнением по методу наименьших квадратов.
   * Q — координаты соседей относительно точки клика (Float64Array, m точек). */
  function detectPlanes(Q, m, o) {
    var spacing = o.spacing, maxPlanes = o.maxPlanes || 4, iters = o.iters || 130;
    var minSupport = Math.max(20, Math.round(m * (o.minShare != null ? o.minShare : 0.07)));
    var rnd = mulberry32(o.seed >>> 0);
    var tauLo = 0.25 * spacing, tauHi = o.tauMax || 1.6 * spacing, tau0 = 0.6 * spacing;
    var avail = new Uint8Array(m).fill(1), remaining = m, planes = [];
    var minArea2 = 0.3 * spacing * spacing;
    for (var round = 0; round < maxPlanes + 2 && planes.length < maxPlanes; round++) {
      if (remaining < minSupport) break;
      var pool = new Int32Array(remaining), c = 0, i, k;
      for (i = 0; i < m; i++) if (avail[i]) pool[c++] = i;
      var bestCnt = 0, bn = null, bd = 0;
      for (var it = 0; it < iters; it++) {
        var a = pool[(rnd() * remaining) | 0], b = pool[(rnd() * remaining) | 0], d3 = pool[(rnd() * remaining) | 0];
        if (a === b || b === d3 || a === d3) continue;
        var ux = Q[b * 3] - Q[a * 3], uy = Q[b * 3 + 1] - Q[a * 3 + 1], uz = Q[b * 3 + 2] - Q[a * 3 + 2];
        var vx = Q[d3 * 3] - Q[a * 3], vy = Q[d3 * 3 + 1] - Q[a * 3 + 1], vz = Q[d3 * 3 + 2] - Q[a * 3 + 2];
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (l < minArea2) continue;
        nx /= l; ny /= l; nz /= l;
        var dd = -(nx * Q[a * 3] + ny * Q[a * 3 + 1] + nz * Q[a * 3 + 2]), cnt = 0;
        for (k = 0; k < remaining; k++) { i = pool[k] * 3; var e = nx * Q[i] + ny * Q[i + 1] + nz * Q[i + 2] + dd; if (e < tau0 && e > -tau0) cnt++; }
        if (cnt > bestCnt) { bestCnt = cnt; bn = [nx, ny, nz]; bd = dd; }
        if (cnt > 0.9 * remaining) break;
      }
      if (!bn || bestCnt < minSupport) break;
      var plane = { normal: bn, d: bd }, inl = new Int32Array(remaining), ic = 0, tau = tau0, sigma = tau0 / 3;
      for (var pass = 0; pass < 4; pass++) {
        ic = 0;
        for (k = 0; k < remaining; k++) { i = pool[k]; var ee = planeDist(plane, Q, i); if (ee < tau && ee > -tau) inl[ic++] = i; }
        if (ic < 6) break;
        var f = fitLSQ(Q, inl, ic); plane = { normal: f.normal, d: f.d, centroid: f.centroid, lam: f.lam };
        var res = new Float64Array(ic);
        for (k = 0; k < ic; k++) res[k] = Math.abs(planeDist(plane, Q, inl[k]));
        res.sort();
        sigma = 1.4826 * res[ic >> 1];
        tau = clamp(3 * sigma, tauLo, tauHi);
      }
      ic = 0;
      for (k = 0; k < remaining; k++) { i = pool[k]; var e2 = planeDist(plane, Q, i); if (e2 < tau && e2 > -tau) inl[ic++] = i; }
      if (ic < minSupport) { for (k = 0; k < ic; k++) avail[inl[k]] = 0; remaining -= ic; continue; }
      var fin = fitLSQ(Q, inl, ic); plane = { normal: fin.normal, d: fin.d, centroid: fin.centroid, lam: fin.lam };
      var ss = 0; for (k = 0; k < ic; k++) { var r = planeDist(plane, Q, inl[k]); ss += r * r; }
      plane.rms = Math.sqrt(ss / ic); plane.count = ic; plane.tau = tau; plane.inliers = Int32Array.from(inl.subarray(0, ic));
      // размах плоскости: без него «плоскостью» может оказаться узкая полоска на трубе
      var s1 = null, mn1 = Infinity, mx1 = -Infinity, mn2 = Infinity, mx2 = -Infinity;
      s1 = unit(cross(plane.normal, Math.abs(plane.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); var s2 = cross(plane.normal, s1);
      for (k = 0; k < ic; k++) { i = inl[k] * 3; var t1 = Q[i] * s1[0] + Q[i + 1] * s1[1] + Q[i + 2] * s1[2], t2 = Q[i] * s2[0] + Q[i + 1] * s2[1] + Q[i + 2] * s2[2]; if (t1 < mn1) mn1 = t1; if (t1 > mx1) mx1 = t1; if (t2 < mn2) mn2 = t2; if (t2 > mx2) mx2 = t2; }
      plane.span = Math.min(mx1 - mn1, mx2 - mn2);
      // те же точки нельзя использовать снова; почти совпадающую плоскость (остаток шумной поверхности) отбрасываем
      for (k = 0; k < ic; k++) avail[inl[k]] = 0;
      remaining -= ic;
      var dup = false;
      for (var q = 0; q < planes.length; q++) {
        var pp = planes[q], cs = Math.abs(dot(pp.normal, plane.normal));
        if (cs > Math.cos(4 * DEG) && Math.abs(dot(pp.normal, plane.centroid) + pp.d) < 2.5 * Math.max(pp.tau, plane.tau)) { dup = true; break; }
      }
      if (!dup) planes.push(plane);
    }
    return planes;
  }

  /* Совместное уточнение: у ребра точки полосы шириной в допуск подходят сразу двум плоскостям, и последовательный
   * поиск отдаёт их той, что найдена раньше, — плоскость «тянет» к соседней стене на пару миллиметров.
   * Здесь каждая точка достаётся ближайшей плоскости, спорные точки у самого ребра не берём вообще. */
  function refineJoint(Q, m, planes, spacing, tauMax) {
    if (planes.length < 2) return planes;
    var tauLo = 0.25 * spacing, tauHi = tauMax || 1.6 * spacing;
    for (var pass = 0; pass < 3; pass++) {
      var owner = new Int8Array(m).fill(-1), counts = new Int32Array(planes.length), i, k, q;
      for (i = 0; i < m; i++) {
        var best = -1, bd = Infinity, second = Infinity;
        for (q = 0; q < planes.length; q++) {
          var e = Math.abs(planeDist(planes[q], Q, i));
          if (e < bd) { second = bd; bd = e; best = q; } else if (e < second) second = e;
        }
        if (best < 0 || bd > planes[best].tau) continue;
        if (second < planes[best].tau && second < 2.2 * bd + 0.25 * spacing) continue;   // спорная точка у ребра
        owner[i] = best; counts[best]++;
      }
      var changed = false;
      for (q = 0; q < planes.length; q++) {
        if (counts[q] < 12) continue;
        var ids = new Int32Array(counts[q]), c = 0;
        for (i = 0; i < m; i++) if (owner[i] === q) ids[c++] = i;
        var f = fitLSQ(Q, ids, c), pl = planes[q], np = { normal: f.normal, d: f.d, centroid: f.centroid, lam: f.lam };
        var res = new Float64Array(c), ss = 0;
        for (k = 0; k < c; k++) { var r = planeDist(np, Q, ids[k]); res[k] = Math.abs(r); ss += r * r; }
        res.sort();
        np.rms = Math.sqrt(ss / c); np.count = c; np.tau = clamp(3 * 1.4826 * res[c >> 1], tauLo, tauHi); np.inliers = ids; np.span = pl.span;
        if (Math.abs(dot(np.normal, pl.normal)) < 0.9998 || Math.abs(np.d - pl.d) > 1e-4 * spacing) changed = true;
        planes[q] = np;
      }
      if (!changed) break;
    }
    return planes;
  }

  /* ---------- Пересечения ---------- */
  function intersect2(p1, p2) {
    var u = cross(p1.normal, p2.normal), uu = dot(u, u);
    if (uu < MIN_EDGE_SIN * MIN_EDGE_SIN) return null;
    var pt = mul(add(mul(cross(p2.normal, u), -p1.d), mul(cross(u, p1.normal), -p2.d)), 1 / uu);
    return { point: pt, dir: unit(u) };
  }
  function intersect3(p1, p2, p3) {
    var det = dot(p1.normal, cross(p2.normal, p3.normal));
    if (Math.abs(det) < 0.16) return null;   // около 9° «раскрытия»: система плохо обусловлена
    var pt = mul(add(add(mul(cross(p2.normal, p3.normal), -p1.d), mul(cross(p3.normal, p1.normal), -p2.d)), mul(cross(p1.normal, p2.normal), -p3.d)), 1 / det);
    return { point: pt, det: det };
  }
  function nearOnPlane(Q, plane, p, r) {   // сколько точек плоскости лежит рядом с p
    var r2 = r * r, c = 0, ids = plane.inliers;
    for (var k = 0; k < ids.length; k++) { var i = ids[k] * 3, ax = Q[i] - p[0], ay = Q[i + 1] - p[1], az = Q[i + 2] - p[2]; if (ax * ax + ay * ay + az * az <= r2) c++; }
    return c;
  }


  /* ---------- Рост плоскости по всей поверхности ---------- */
  /* Плоскость по окрестности в 20 см ошибается по наклону на несколько тысячных: на расстоянии в 3 м это уже сантиметры.
   * Поэтому после захвата плоскость «растёт» по связной поверхности (пол, стена, откос): собираем все точки в пределах
   * допуска, уточняем плоскость, повторяем. Так меряют по всей стене, а не по клочку возле курсора. */
  function collectPlanePoints(index, pl, foot, tau, cap, r0, sibs, rmax) {
    var P = index.pos, dims = index.dims, dx = dims[0], dy = dims[1], dz = dims[2], cell = index.cell, mn = index.mn;
    var nx = pl.normal[0], ny = pl.normal[1], nz = pl.normal[2], d = pl.d;
    var nsib = sibs ? sibs.length : 0, gap = 0.25 * (index.spacing || cell / 4);
    var cells = dx * dy * dz;
    if (!index._stamp || index._stamp.length !== cells) { index._stamp = new Uint32Array(cells); index._gen = 0; }
    var stamp = index._stamp, gen = ++index._gen;
    if (gen >= 4294967290) { stamp.fill(0); gen = index._gen = 1; }
    var out = [], queue = [], head = 0, inv = 1 / cell, reach = cell * 0.87 + tau;
    var lim = rmax > 0 ? (rmax + cell) * (rmax + cell) : Infinity;   // рост ограничен окрестностью: пол/стена не идеально ровные, «плоскость на всё здание» ошибается на миллиметры
    // Ячейка принимается, если поверхность занимает большую её часть: узкие полосы, где плоскость лишь пересекает
    // пол, потолок или дальнюю стену, не имеют «обратной связи» и держат подгонку в том наклоне, с которого она начала.
    function scan(cid) {
      var s = index.start[cid], e = index.start[cid + 1], hit = false, before = out.length;
      for (var k = s; k < e; k++) {
        var i = index.order[k] * 3, v = nx * P[i] + ny * P[i + 1] + nz * P[i + 2] + d;
        if (v < tau && v > -tau) {
          var skip = false, av = v < 0 ? -v : v;
          for (var q = 0; q < nsib; q++) {   // точки у ребра, которые могут принадлежать соседней плоскости, не берём
            var o = sibs[q], vo = o.normal[0] * P[i] + o.normal[1] * P[i + 1] + o.normal[2] * P[i + 2] + o.d, ao = vo < 0 ? -vo : vo;
            if (ao < o.tau && (ao <= av || ao < 2.2 * av + gap)) { skip = true; break; }
          }
          if (!skip) { out.push(i / 3); hit = true; }
        }
      }
      if (hit && out.length - before < 0.45 * (e - s)) { out.length = before; return false; }
      return hit;
    }
    var cx = Math.floor((foot[0] - mn[0]) * inv), cy = Math.floor((foot[1] - mn[1]) * inv), cz = Math.floor((foot[2] - mn[2]) * inv);
    var rc = Math.max(1, Math.ceil(r0 * inv));
    var x0 = Math.max(0, cx - rc), x1 = Math.min(dx - 1, cx + rc), y0 = Math.max(0, cy - rc), y1 = Math.min(dy - 1, cy + rc), z0 = Math.max(0, cz - rc), z1 = Math.min(dz - 1, cz + rc);
    var ix, iy, iz;
    for (iz = z0; iz <= z1; iz++) for (iy = y0; iy <= y1; iy++) for (ix = x0; ix <= x1; ix++) {
      var cid = (iz * dy + iy) * dx + ix; if (stamp[cid] === gen) continue; stamp[cid] = gen;
      if (scan(cid)) queue.push(cid);
    }
    while (head < queue.length && out.length < cap) {
      var c = queue[head++], ci = c % dx, cj = ((c / dx) | 0) % dy, ck = (c / (dx * dy)) | 0;
      for (var oz = -1; oz <= 1; oz++) for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        if (!ox && !oy && !oz) continue;
        var ax = ci + ox, ay = cj + oy, az = ck + oz;
        if (ax < 0 || ay < 0 || az < 0 || ax >= dx || ay >= dy || az >= dz) continue;
        var nid = (az * dy + ay) * dx + ax; if (stamp[nid] === gen) continue;
        stamp[nid] = gen;
        var qx = mn[0] + (ax + 0.5) * cell, qy = mn[1] + (ay + 0.5) * cell, qz = mn[2] + (az + 0.5) * cell;
        var dv = nx * qx + ny * qy + nz * qz + d;
        if (dv > reach || dv < -reach) continue;
        if (lim !== Infinity) { var fx = qx - foot[0], fy = qy - foot[1], fz = qz - foot[2]; if (fx * fx + fy * fy + fz * fz > lim) continue; }
        if (scan(nid)) queue.push(nid);
      }
    }
    return Int32Array.from(out);
  }

  /* Абсолютная плоскость {normal, d, tau, count} → плоскость по всей связной поверхности.
   * opts.siblings — соседние плоскости у того же ребра/угла: их точки и спорные точки у самого ребра не берём.
   * Возвращает ту же плоскость, если рост не удался (мало точек, плоскость «поплыла»). */
  function growPlane(index, pl, opts) {
    opts = opts || {};
    var sp = index.spacing || index.cell / 4, cap = opts.cap || 700000, P = index.pos;
    var tauCap = opts.tauMax || 1.6 * sp, sibs = opts.siblings && opts.siblings.length ? opts.siblings : null;
    var cur = { normal: pl.normal.slice(), d: pl.d, tau: clamp(pl.tau || 1.5 * sp, 0.5 * sp, tauCap) };
    var foot = opts.foot || pl.centroid, r0 = opts.r0 || 6 * sp, last = 0, best = null, n0 = pl.normal, passes = opts.passes || 7, rmax = opts.rmax || 110 * sp;
    for (var pass = 0; pass < passes; pass++) {
      var ids = collectPlanePoints(index, cur, foot, cur.tau, cap, r0, sibs, rmax);
      if (ids.length < Math.max(24, (pl.count || 0) * 0.6)) break;
      var f = fitLSQ(P, ids, ids.length);
      var nrm = f.normal, dd = f.d, res = new Float64Array(ids.length), ss = 0;
      if (dot(nrm, n0) < 0) { nrm = mul(nrm, -1); dd = -dd; }
      for (var k = 0; k < ids.length; k++) { var i = ids[k] * 3, r = nrm[0] * P[i] + nrm[1] * P[i + 1] + nrm[2] * P[i + 2] + dd; res[k] = r < 0 ? -r : r; ss += r * r; }
      var sorted = Float64Array.from(res).sort(), sigma = sorted[Math.floor(sorted.length * 0.35)] / 0.4538;   // по нижней трети остатков: полосы на стыках с другими поверхностями не искажают оценку
      var tauNew = clamp(2.8 * sigma, 0.25 * sp, tauCap), rmsNew = Math.sqrt(ss / ids.length);
      if (dot(nrm, n0) < Math.cos(8 * DEG) || (best && rmsNew > 2.2 * best.rms + 0.3 * sp)) break;   // плоскость «уплыла» на соседнюю поверхность
      var moved = best ? Math.max(Math.acos(clamp(dot(nrm, best.normal), -1, 1)) * (best.spread || 1), Math.abs(dd - best.d)) : Infinity;
      best = { normal: nrm, d: dd, centroid: f.centroid, rms: rmsNew, count: ids.length, tau: tauNew, span: pl.span, grown: true,
               spread: Math.sqrt(Math.max(f.lam[2], 1e-12)), spreadMin: Math.sqrt(Math.max(f.lam[1], 1e-12)) };
      var grew = ids.length > last * 1.02;
      last = ids.length; cur = { normal: nrm, d: dd, tau: tauNew };
      if (pass > 0 && (moved < 0.02 * sp || !grew)) break;
    }
    return best || pl;
  }

  /* Стандартная ошибка положения плоскости в точке pt (мм не подразумеваются: единицы облака). */
  function planeSigmaAt(pl, pt) {
    var n = pl.count || 0;
    if (n < 4) return pl.rms || 0;
    var rms = pl.rms || 0, dvec = sub(pt, pl.centroid), off = dot(dvec, pl.normal), inpl = sub(dvec, mul(pl.normal, off));
    var sd = pl.spreadMin || pl.spread || 0;
    var ext = sd > 1e-9 ? dot(inpl, inpl) / (n * sd * sd) : 0;
    return rms * Math.sqrt(1 / n + ext + 0.08);   // 0,08·rms² — запас на неровность поверхности: настоящая стена не идеальная плоскость; по сверке на реальном облаке (66 размеров, 154 привязки) это даёт покрытие ±1σ/±2σ/±3σ ≈ 68/94/98 %
  }

  /* Ядро ребра/угла. У настоящих кромок поверхность скруглена или сколота на сантиметр-два (штукатурка, уголки, «мягкие» кромки скана):
   * точки у самой кромки тянут плоскость набок, а иногда из них собирается целая «наклонная плоскость». Поэтому плоскости ищем заново
   * по точкам, что дальше rho от всех кромок, а положение ребра/угла — по пересечению этих «чистых» плоскостей. */
  function coreDetect(Q, m, w, sp, radius, snapDist, opts) {
    var pl = w.planes, lines = [], i, j, k;
    for (i = 0; i < pl.length; i++) for (j = i + 1; j < pl.length; j++) { var x2 = intersect2(pl[i], pl[j]); if (x2) lines.push(x2); }
    if (!lines.length) return null;
    var rho = clamp(0.3 * radius, 3 * sp, 0.5 * radius), rho2 = rho * rho, keep = new Int32Array(m), c = 0;
    for (i = 0; i < m; i++) {
      var ok = true, qx = Q[i * 3], qy = Q[i * 3 + 1], qz = Q[i * 3 + 2];
      for (j = 0; j < lines.length; j++) {
        var L = lines[j], rx = qx - L.point[0], ry = qy - L.point[1], rz = qz - L.point[2], t = rx * L.dir[0] + ry * L.dir[1] + rz * L.dir[2];
        rx -= t * L.dir[0]; ry -= t * L.dir[1]; rz -= t * L.dir[2];
        if (rx * rx + ry * ry + rz * rz < rho2) { ok = false; break; }
      }
      if (ok) keep[c++] = i;
    }
    if (c < 40) return null;
    var Q2 = new Float64Array(c * 3);
    for (k = 0; k < c; k++) { Q2[k * 3] = Q[keep[k] * 3]; Q2[k * 3 + 1] = Q[keep[k] * 3 + 1]; Q2[k * 3 + 2] = Q[keep[k] * 3 + 2]; }
    var pl2 = detectPlanes(Q2, c, { spacing: sp, seed: (seedFor([Q2[0], Q2[1], Q2[2]], c) + 977) >>> 0, maxPlanes: 5, tauMax: opts.tauMax });
    var mapped = [], used = {};
    for (i = 0; i < pl.length; i++) {
      var best = -1, bs = Math.cos(28 * DEG);
      for (j = 0; j < pl2.length; j++) {
        if (used[j] || pl2[j].span < 3 * sp || pl2[j].count < 14) continue;
        var cs = Math.abs(dot(pl[i].normal, pl2[j].normal));
        if (cs > bs) { bs = cs; best = j; }
      }
      if (best < 0) return null;
      used[best] = 1; mapped.push(pl2[best]);
    }
    var np, dir = null, zero = [0, 0, 0];
    if (w.kind === 'corner') { var x3 = intersect3(mapped[0], mapped[1], mapped[2]); if (!x3) return null; np = x3.point; }
    else { var e2 = intersect2(mapped[0], mapped[1]); if (!e2) return null; var t2 = -dot(e2.point, e2.dir); np = add(e2.point, mul(e2.dir, t2)); dir = e2.dir; }
    if (len(sub(np, w.point)) > 1.3 * snapDist) return null;
    return { kind: w.kind, tier: w.tier, cost: len(sub(np, zero)) * (w.kind === 'corner' ? 0.5 : 0.8), point: np, dir: dir || w.dir, planes: mapped, cored: true };
  }

  /* Кромка поверхности: край проёма или другого разрыва в облаке. Дверь в стене без откосов не даёт ни ребра из двух плоскостей,
   * ни угла — там есть только граница набора точек плоскости. Границу ищем по грубой сетке (направление), затем уточняем по самим точкам:
   * крайние точки полосы вдоль кромки → прямая → сдвиг наружу на среднюю щель между точками (крайняя точка всегда лежит внутри кромки). */
  function contourEdgeTau(index, pl, seed, snapDist, tauK) {
    var sp = index.spacing || index.cell / 4, P = index.pos, n = pl.normal, tau = tauK * Math.max(pl.tau || 0, 0.5 * sp);   // у кромки поверхность обычно скруглена: допуск шире, чем у плоской части (tauK = 2,2; если так край не находится — 1)
    var e0 = dot(n, seed) + pl.d, foot = sub(seed, mul(n, e0));
    var Rw = clamp(5 * snapDist, 25 * sp, 70 * sp);
    var ids = index.query(foot[0], foot[1], foot[2], Rw, 16000);
    var ux = unit(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), vx = cross(n, ux);
    var A = [], B = [], k, i;
    for (k = 0; k < ids.length; k++) {
      i = ids[k] * 3; var d = n[0] * P[i] + n[1] * P[i + 1] + n[2] * P[i + 2] + pl.d;
      if (d > tau || d < -tau) continue;
      var rx = P[i] - foot[0], ry = P[i + 1] - foot[1], rz = P[i + 2] - foot[2];
      A.push(rx * ux[0] + ry * ux[1] + rz * ux[2]); B.push(rx * vx[0] + ry * vx[1] + rz * vx[2]);
    }
    var cnt = A.length; if (cnt < 80) return null;
    // грубая сетка: ячейка ~ 4 шага, «заполнена», если в ней есть заметная доля типичной плотности
    var h = 4 * sp, G, cells, counts, tries = 0, med = 0;
    for (;;) {
      G = Math.ceil(2 * Rw / h) + 1; counts = new Int32Array(G * G);
      for (k = 0; k < cnt; k++) { var ca = Math.floor((A[k] + Rw) / h), cb = Math.floor((B[k] + Rw) / h); if (ca >= 0 && cb >= 0 && ca < G && cb < G) counts[cb * G + ca]++; }
      var nz = []; for (k = 0; k < counts.length; k++) if (counts[k] > 0) nz.push(counts[k]);
      nz.sort(function (x, y) { return x - y; }); med = nz.length ? nz[nz.length >> 1] : 0;
      if (med >= 4 || tries >= 2) break; h *= 1.6; tries++;
    }
    var thr = Math.max(1, Math.round(0.25 * med));
    function filled(ia, ib) { return counts[ib * G + ia] >= thr; }
    function inside(ia, ib) { var ca = (ia + 0.5) * h - Rw, cb = (ib + 0.5) * h - Rw; return ia >= 0 && ib >= 0 && ia < G && ib < G && ca * ca + cb * cb <= (Rw - h) * (Rw - h); }
    var bcells = [], nb4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var ib = 0; ib < G; ib++) for (var ia = 0; ia < G; ia++) {
      if (!inside(ia, ib) || !filled(ia, ib)) continue;
      var ex = 0, ey = 0, ne = 0;
      for (k = 0; k < 4; k++) { var ja = ia + nb4[k][0], jb = ib + nb4[k][1]; if (inside(ja, jb) && !filled(ja, jb)) { ex += nb4[k][0]; ey += nb4[k][1]; ne++; } }
      if (ne) bcells.push({ a: (ia + 0.5) * h - Rw, b: (ib + 0.5) * h - Rw, ex: ex, ey: ey });
    }
    if (bcells.length < 3) return null;
    // ближайшая к курсору граничная ячейка
    var c0 = null, bd = Infinity;
    for (k = 0; k < bcells.length; k++) { var dd = Math.hypot(bcells[k].a, bcells[k].b); if (dd < bd) { bd = dd; c0 = bcells[k]; } }
    if (bd > snapDist + 1.2 * h) return null;
    var dirT = null, loc = null;
    for (var rr = 3.2; rr >= 2.0; rr -= 0.6) {
      loc = bcells.filter(function (c) { return Math.hypot(c.a - c0.a, c.b - c0.b) <= rr * h; });
      if (loc.length < 3) continue;
      var ma = 0, mb = 0; loc.forEach(function (c) { ma += c.a; mb += c.b; }); ma /= loc.length; mb /= loc.length;
      var saa = 0, sab = 0, sbb = 0; loc.forEach(function (c) { saa += (c.a - ma) * (c.a - ma); sab += (c.a - ma) * (c.b - mb); sbb += (c.b - mb) * (c.b - mb); });
      var tr = saa + sbb, det = saa * sbb - sab * sab, disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0)), l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1e-12);
      if (Math.sqrt(l1 / l2) < 3) continue;   // не прямая: угол проёма или рваный край — кромкой не считаем
      var ta = Math.abs(sab) > 1e-12 ? l1 - sbb : (saa >= sbb ? 1 : 0), tb = Math.abs(sab) > 1e-12 ? sab : (saa >= sbb ? 0 : 1), tl = Math.hypot(ta, tb) || 1;
      dirT = { ta: ta / tl, tb: tb / tl, ma: ma, mb: mb }; break;
    }
    if (!dirT) return null;
    var ta2 = dirT.ta, tb2 = dirT.tb, na2 = -tb2, nb2 = ta2;                 // нормаль к кромке в плоскости
    var oe = 0; loc.forEach(function (c) { oe += (c.ex * na2 + c.ey * nb2); });
    if (oe < 0) { na2 = -na2; nb2 = -nb2; }                                   // наружу — в сторону пустоты
    // положение по крайним точкам полосы вдоль кромки (t = 0 — проекция курсора на кромку)
    var mB = dirT.ma * na2 + dirT.mb * nb2, half = 3.2 * h, w = Math.max(2 * sp, 0.4 * h), nbins = Math.max(4, Math.floor(2 * half / w));
    var tb0 = -half, best = new Float64Array(nbins).fill(-Infinity), cntBin = new Int32Array(nbins), inStrip = 0;
    for (k = 0; k < cnt; k++) {
      var tt = A[k] * ta2 + B[k] * tb2, mm = A[k] * na2 + B[k] * nb2;
      if (tt < tb0 || tt >= half || mm < mB - 2.5 * h || mm > mB + 1.2 * h) continue;
      var bi = Math.min(nbins - 1, Math.floor((tt - tb0) / w)); cntBin[bi]++; inStrip++;
      if (mm > best[bi]) best[bi] = mm;
    }
    var xs = [], ys = [];
    for (k = 0; k < nbins; k++) if (cntBin[k] >= 2 && best[k] > -Infinity) { xs.push(tb0 + (k + 0.5) * w); ys.push(best[k]); }
    if (xs.length < 4) return null;
    // робастная прямая m = a + b·t по максимумам полос (усечение по остаткам)
    var keepX = xs.slice(), keepY = ys.slice(), a1 = 0, b1 = 0, rms = 0;
    for (var pass = 0; pass < 3; pass++) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, m1 = keepX.length;
      for (k = 0; k < m1; k++) { sx += keepX[k]; sy += keepY[k]; sxx += keepX[k] * keepX[k]; sxy += keepX[k] * keepY[k]; }
      var den = m1 * sxx - sx * sx; b1 = Math.abs(den) > 1e-18 ? (m1 * sxy - sx * sy) / den : 0; a1 = (sy - b1 * sx) / m1;
      var res = keepX.map(function (x, q) { return keepY[q] - (a1 + b1 * x); }), ss = 0; res.forEach(function (r) { ss += r * r; });
      rms = Math.sqrt(ss / m1);
      var lim = Math.max(2.2 * rms, 0.8 * sp), nx2 = [], ny2 = [];
      for (k = 0; k < m1; k++) if (Math.abs(res[k]) <= lim) { nx2.push(keepX[k]); ny2.push(keepY[k]); }
      if (nx2.length < 4 || nx2.length === m1) { if (nx2.length >= 4) { keepX = nx2; keepY = ny2; } break; }
      keepX = nx2; keepY = ny2;
    }
    if (keepX.length < 4) return null;
    // Положение самой кромки — по порядковым статистикам: j-я от края точка лежит в среднем на j / (линейная плотность) внутри кромки.
    // Плотность берём в полосе, заведомо лежащей внутри поверхности; от того, как легли крайние точки (сетка или случайно), оценка не зависит.
    var skip = 1.5 * sp, wref = 6 * sp, nref = 0, top = [], JJ = 2;
    for (k = 0; k < cnt; k++) {
      var t3 = A[k] * ta2 + B[k] * tb2; if (t3 < tb0 || t3 >= half) continue;
      var r3 = A[k] * na2 + B[k] * nb2 - (a1 + b1 * t3);
      if (r3 <= -skip) { if (r3 > -skip - wref) nref++; }
      else if (r3 <= 3 * sp) top.push(r3);
    }
    top.sort(function (x, y) { return y - x; });
    var gapE, mass = false, sigMass = 0;
    if (nref >= 24 && top.length >= JJ + 2) {
      var rhoLine = nref / wref;
      gapE = clamp(top[JJ - 1] + JJ / rhoLine, -0.5 * sp, 1.6 * sp); mass = true;
      sigMass = Math.sqrt(JJ) / rhoLine;
    } else {      // мало точек: крайняя точка полосы + средняя щель 1 / (плотность · ширина полосы)
      var dens = 0, strip = 0;
      for (k = 0; k < cnt; k++) { var t4 = A[k] * ta2 + B[k] * tb2, m4 = A[k] * na2 + B[k] * nb2; if (t4 >= tb0 && t4 < half) { var lineM = a1 + b1 * t4; if (m4 <= lineM + 0.2 * sp && m4 >= lineM - 3 * w) strip++; } }
      dens = strip / (2 * half * 3 * w);
      gapE = dens > 0 ? clamp(1 / (dens * w), 0.1 * sp, 1.0 * sp) : 0.5 * sp;
    }
    var mEdge = a1 + gapE;                                                    // на t = 0
    var pa = mEdge * na2, pb = mEdge * nb2;                                   // (a,b) точки на кромке
    var pt = add(add(foot, mul(ux, pa)), mul(vx, pb));
    var d2 = unit([ta2 + b1 * na2, tb2 + b1 * nb2]), dir3 = unit(add(mul(ux, d2[0]), mul(vx, d2[1])));
    var sig = Math.sqrt(Math.pow(rms / Math.sqrt(keepX.length), 2) + (mass ? sigMass * sigMass : Math.pow(0.5 * gapE, 2)) + 0.36 * sp * sp);   // 0,6·шаг — шероховатость и скругление кромки (по сверке с полными данными)
    return { point: pt, dir: dir3, sigma: sig, rms: rms, count: inStrip, gap: gapE, cell: h, bins: keepX.length, mass: mass, nref: nref, top: top.slice(0, 4), a1: a1, dist: Math.hypot(pa, pb) };
  }

  function contourEdge(index, pl, seed, snapDist) {
    var c = null;
    try { c = contourEdgeTau(index, pl, seed, snapDist, 2.2); } catch (e) { c = null; }
    if (!c) { try { c = contourEdgeTau(index, pl, seed, snapDist, 1); } catch (e2) { c = null; } }
    return c;
  }

  /* Направление кромки по одному окну (±6 шагов) определено грубо: 0,5–1° дают 7–14 мм на метр. Поэтому кромку «протягиваем»:
   * то же окно ставим на расстоянии step вдоль кромки в обе стороны, положения кромки в трёх окнах — одна прямая с базой около метра. */
  function trackContour(index, pl, c0, snapDist) {
    var sp = index.spacing || index.cell / 4, step = clamp(50 * sp, 6 * snapDist, 16 * snapDist), T = c0.dir, k, sgn, cand = [];
    var tol = 0.02 * step + 2 * sp;
    for (sgn = -1; sgn <= 1; sgn += 2) {
      var c = null;
      try { c = contourEdge(index, pl, add(c0.point, mul(T, sgn * step)), snapDist); } catch (e) { c = null; }
      if (!c || c.dist > 0.6 * snapDist) continue;
      var dv = sub(c.point, c0.point), al = dot(dv, T), pr = sub(dv, mul(T, al));
      if (len(pr) > tol || Math.abs(al) < 0.5 * step) continue;    // не на той же прямой (угол проёма, арка, рваный край)
      cand.push({ c: c, sgn: sgn });
    }
    // окно, в котором край «рваный» заметно сильнее остальных (угол проёма попал в окно), в протяжку не берём
    var rmsAll = [c0.rms].concat(cand.map(function (q) { return q.c.rms; })).sort(function (x, y) { return x - y; }), med = rmsAll[rmsAll.length >> 1];
    cand = cand.filter(function (q) { return q.c.rms <= 1.6 * med + 0.15 * sp; });
    if (cand.length === 2) {       // три окна должны лежать на одной прямой
      var chord = add(cand[0].c.point, mul(sub(cand[1].c.point, cand[0].c.point), 0.5)), dev = len(sub(chord, c0.point));
      if (dev > 0.6 * sp + 2 * c0.sigma) cand = [cand[0].c.rms <= cand[1].c.rms ? cand[0] : cand[1]];
    }
    if (!cand.length) return null;
    var pts = [c0.point];
    if (cand.length === 2) pts = [cand[0].c.point, c0.point, cand[1].c.point]; else pts.push(cand[0].c.point);
    var M = [0, 0, 0]; for (k = 0; k < pts.length; k++) M = add(M, pts[k]); M = mul(M, 1 / pts.length);
    var D = pts.length === 3 ? unit(sub(pts[2], pts[0])) : unit(sub(pts[1], pts[0]));
    if (dot(D, T) < 0) D = mul(D, -1);
    var base = pts.length === 3 ? 2 * step : step, sAnchor = Math.max(c0.sigma || 0, 0.5 * sp);
    var point = add(M, mul(D, dot(sub(c0.point, M), D)));
    return { point: point, dir: D, dirSigma: sAnchor * Math.SQRT2 / base, anchors: pts.length - 1, step: step, shift: len(sub(point, c0.point)) };
  }

  /* ---------- Захват ---------- */
  /* seed — точка под курсором (координаты облака). index — buildIndex(...).
   * opts.snapDist — насколько далеко от seed искать угол/ребро (в единицах облака);
   * opts.radius — радиус окрестности для подгонки плоскостей. Оба по умолчанию считаются от spacing. */
  function snap(seed, index, opts) {
    opts = opts || {};
    var raw = [seed[0], seed[1], seed[2]];
    var out = { point: raw.slice(), raw: raw, kind: 'raw', refined: false, shift: 0, rms: 0, count: 0, planes: [] };
    if (!index || !index.n) return out;
    var sp = index.spacing || index.cell / 4;
    var snapDist = clamp(opts.snapDist || 6 * sp, 2.5 * sp, 40 * sp);
    var radius = clamp(opts.radius || 2.4 * snapDist, 10 * sp, 60 * sp);
    var ids = index.query(seed[0], seed[1], seed[2], radius, opts.cap || 3200);
    var m = ids.length;
    out.radius = radius; out.snapDist = snapDist; out.spacing = sp; out.neighbours = m;
    if (m < 12) {   // почти пусто: берём ближайшую настоящую точку
      var nn = index.nearest(seed[0], seed[1], seed[2], radius * 2);
      if (nn >= 0) { out.point = [index.pos[nn * 3], index.pos[nn * 3 + 1], index.pos[nn * 3 + 2]]; out.kind = 'point'; out.shift = len(sub(out.point, raw)); }
      return out;
    }
    var P = index.pos, Q = new Float64Array(m * 3);
    for (var k = 0; k < m; k++) { var i = ids[k]; Q[k * 3] = P[i * 3] - seed[0]; Q[k * 3 + 1] = P[i * 3 + 1] - seed[1]; Q[k * 3 + 2] = P[i * 3 + 2] - seed[2]; }
    var planes = detectPlanes(Q, m, { spacing: sp, seed: seedFor(raw, index.n), maxPlanes: opts.maxPlanes || 4, tauMax: opts.tauMax });
    // допустимые плоскости: настоящая поверхность (достаточный размах) и проходит недалеко от курсора
    planes = refineJoint(Q, m, planes, sp, opts.tauMax);
    // «плоскость» из полоски точек вдоль кромки (смешанные пиксели лазера) настоящей поверхностью не считаем: у неё нет ширины
    var good = planes.filter(function (p) { return p.span >= 3.5 * sp && Math.abs(p.d) <= radius * 0.9 && (!p.lam || Math.sqrt(Math.max(p.lam[1], 0)) >= 1.5 * sp); });
    // местный шаг точек: у откосов, кромок и на косых поверхностях облако реже, чем в среднем — опору для ребра/угла ищем с запасом
    var lsp = clamp(Math.sqrt(Math.PI * radius * radius / m), sp, 3 * sp);
    var cands = [], supportR = 3.5 * lsp, a, b, c2;
    out.localSpacing = lsp;
    var zero = [0, 0, 0];
    // углы
    for (a = 0; a < good.length; a++) for (b = a + 1; b < good.length; b++) for (c2 = b + 1; c2 < good.length; c2++) {
      var x3 = intersect3(good[a], good[b], good[c2]); if (!x3) continue;
      var dc = len(sub(x3.point, zero)); if (dc > snapDist) continue;
      if (nearOnPlane(Q, good[a], x3.point, supportR * 1.3) < 3 || nearOnPlane(Q, good[b], x3.point, supportR * 1.3) < 3 || nearOnPlane(Q, good[c2], x3.point, supportR * 1.3) < 3) continue;
      cands.push({ kind: 'corner', tier: 0, cost: dc * 0.5, point: x3.point, planes: [good[a], good[b], good[c2]] });
    }
    // рёбра
    for (a = 0; a < good.length; a++) for (b = a + 1; b < good.length; b++) {
      var x2 = intersect2(good[a], good[b]); if (!x2) continue;
      var t = -dot(x2.point, x2.dir), foot = add(x2.point, mul(x2.dir, t)), de = len(foot);
      if (de > snapDist) continue;
      if (nearOnPlane(Q, good[a], foot, supportR) < 3 || nearOnPlane(Q, good[b], foot, supportR) < 3) continue;
      cands.push({ kind: 'edge', tier: 1, cost: de * 0.8, point: foot, dir: x2.dir, planes: [good[a], good[b]] });
    }
    // плоскости
    good.forEach(function (p) {
      var e = p.d, foot = [-p.normal[0] * e, -p.normal[1] * e, -p.normal[2] * e];
      if (Math.abs(e) > snapDist) return;
      if (nearOnPlane(Q, p, foot, supportR * 1.5) < 4) return;
      cands.push({ kind: 'plane', tier: 2, cost: Math.abs(e), point: foot, planes: [p] });
    });
    if (!cands.length) {
      var nn2 = index.nearest(seed[0], seed[1], seed[2], radius);
      if (nn2 >= 0) { out.point = [P[nn2 * 3], P[nn2 * 3 + 1], P[nn2 * 3 + 2]]; out.kind = 'point'; out.shift = len(sub(out.point, raw)); }
      return out;
    }
    // как «конечная точка» в САПР: угол в ближней зоне (0,6 радиуса захвата) важнее ребра, ребро и дальний угол — важнее плоскости
    // (курсор всегда лежит на какой-то плоскости, её проекция всегда «ближе»)
    cands.sort(function (x, y) { return (x.tier || 0) - (y.tier || 0) || x.cost - y.cost; });
    var w = cands[0];
    if (w.kind === 'edge' && opts.core !== false) { var cw = coreDetect(Q, m, w, sp, radius, snapDist, opts); if (cw) w = cw; }
    if (opts.debug) out.debug = { planes: good.map(function (p) { return { n: p.normal.slice(), d: p.d, count: p.count, span: p.span }; }),
      cands: cands.map(function (c) { return { kind: c.kind, tier: c.tier, cost: c.cost, n: c.planes.map(function (p) { return p.normal.map(function (v) { return +v.toFixed(2); }); }) }; }) };
    var abs = w.planes.map(function (p) {   // n·(seed + q) + d' = 0, где n·q + d = 0
      return { normal: p.normal.slice(), d: p.d - dot(p.normal, seed), centroid: add(p.centroid, seed), rms: p.rms, count: p.count,
               span: p.span, tau: p.tau, spread: Math.sqrt(Math.max(p.lam ? p.lam[2] : 0, 1e-12)), spreadMin: Math.sqrt(Math.max(p.lam ? p.lam[1] : 0, 1e-12)) };
    });
    var pt = add(w.point, seed), dir = w.dir ? w.dir.slice() : null;
    if (opts.grow) {
      var g = abs;
      for (var round = 0; round < 2; round++) {
        g = g.map(function (p, i) {
          var e0 = dot(p.normal, pt) + p.d;
          return growPlane(index, p, { foot: sub(pt, mul(p.normal, e0)), r0: 6 * sp, tauMax: opts.tauMax, passes: round ? 3 : 7,
                                       siblings: g.filter(function (_, j) { return j !== i; }) });
        });
      }
      var np = null, dirG = dir;
      if (w.kind === 'corner') { var c3 = intersect3(g[0], g[1], g[2]); if (c3) np = c3.point; }
      else if (w.kind === 'edge') {
        var e2 = intersect2(g[0], g[1]);
        if (e2) { np = add(e2.point, mul(e2.dir, dot(sub(raw, e2.point), e2.dir))); dirG = e2.dir; }
      } else { np = sub(raw, mul(g[0].normal, dot(g[0].normal, raw) + g[0].d)); }
      if (np && len(sub(np, pt)) <= 1.6 * snapDist) { pt = np; abs = g; dir = dirG; }
    }
    var contour = null;
    if (opts.grow && w.kind === 'plane' && opts.contour !== false && abs[0] && abs[0].grown) {
      try { contour = contourEdge(index, abs[0], raw, snapDist); } catch (e) { contour = null; }
      if (contour && contour.dist > snapDist) contour = null;
      if (contour && opts.track !== false) {
        var tr = null; try { tr = trackContour(index, abs[0], contour, snapDist); } catch (e2) { tr = null; }
        if (tr && tr.shift <= 1.5 * sp + contour.sigma) { contour.point = tr.point; contour.dir = tr.dir; contour.dirSigma = tr.dirSigma; contour.anchors = tr.anchors; }
      }
    }
    var rms = 0, cnt = Infinity, sig2 = 0;
    out.planes = abs.map(function (p) {
      var sg = planeSigmaAt(p, pt);
      rms = Math.max(rms, p.rms); cnt = Math.min(cnt, p.count); sig2 += sg * sg;
      return { normal: p.normal.slice(), d: p.d, centroid: p.centroid.slice(), rms: p.rms, count: p.count, span: p.span, sigma: sg, grown: !!p.grown,
               spread: p.spread, spreadMin: p.spreadMin, tau: p.tau };
    });
    out.point = pt; out.kind = w.kind; out.refined = true; out.shift = len(sub(pt, raw)); out.cored = !!w.cored;
    if (contour) { out.point = contour.point; out.kind = 'edge'; out.contour = true; out.shift = len(sub(contour.point, raw)); dir = contour.dir; out.contourInfo = { anchors: contour.anchors || 0, dirSigma: contour.dirSigma, gap: contour.gap, cell: contour.cell, bins: contour.bins, rms: contour.rms, mass: contour.mass, nref: contour.nref, top: contour.top, a1: contour.a1 }; }
    out.grown = out.planes.some(function (p) { return p.grown; });
    out.rms = rms; out.count = cnt === Infinity ? 0 : cnt;
    out.sigma = contour ? Math.sqrt(sig2 + contour.sigma * contour.sigma) : Math.sqrt(sig2) * (w.kind === 'plane' ? 1 : 1.25);
    // запас на скругления и фаски: по сверке на реальном облаке ребро/угол ошибаются заметно сильнее, чем говорит статистика по точкам
    if (!contour && w.kind !== 'plane') { var fk = (w.kind === 'corner' ? 0.75 : out.cored ? 0.25 : 0.12) * sp; out.sigma = Math.sqrt(out.sigma * out.sigma + fk * fk); }
    // угол по «плоскости» из пары десятков точек (полоска откоса, скругление): положение плавает на сантиметры — не выдаём его за точное
    if (w.kind === 'corner' && out.count < 64) { var wk = 2.5 * sp; out.sigma = Math.sqrt(out.sigma * out.sigma + wk * wk); out.weak = true; }
    if (dir) out.dir = dir;
    if (contour) out.dirSigma = contour.dirSigma != null ? contour.dirSigma : 0.012;   // рад: грубое направление по одному окну
    out.quality = out.rms <= 0.55 * sp && out.count >= 60 ? 'high' : out.rms <= 1.1 * sp && out.count >= 25 ? 'medium' : 'low';
    if (out.cored && out.quality === 'high') out.quality = 'medium';          // края скруглены или сколоты: плоскости пришлось искать заново вдали от кромки
    if (out.weak) out.quality = 'low';
    if (contour && out.quality === 'high') out.quality = 'medium';      // положение кромки — оценка по плотности точек, а не подгонка плоскостей
    return out;
  }

  /* ---------- Расстояние между двумя захваченными точками ---------- */
  /* Плоскость–плоскость (стена–стена, пол–потолок): расстояние по нормали, не зависит от того, где именно кликнули.
   * Ребро–ребро (проём, колонна): расстояние между параллельными линиями. Точка–плоскость: расстояние по нормали. */
  function pairGap(a, b) {
    if (!a || !b || !a.point || !b.point) return null;
    var pa = a.point, pb = b.point, dv = sub(pb, pa);
    var ua = a.kind === 'edge' ? a.dir : null, ub = b.kind === 'edge' ? b.dir : null;
    var na = a.kind === 'plane' && a.planes && a.planes[0] ? a.planes[0].normal : null, nb = b.kind === 'plane' && b.planes && b.planes[0] ? b.planes[0].normal : null;
    var unc = function () { return Math.sqrt(Math.pow(a.sigma != null ? a.sigma : (a.rms || 0), 2) + Math.pow(b.sigma != null ? b.sigma : (b.rms || 0), 2)); };
    if (na && nb) {
      if (Math.abs(dot(na, nb)) < PARALLEL_COS) return null;   // непараллельные плоскости: расстояние между ними не определено
      var s = dot(na, nb) >= 0 ? 1 : -1, nn = unit(add(na, mul(nb, s)));
      return { kind: 'planes', value: Math.abs(dot(nn, dv)), normal: nn, uncertainty: unc() };
    }
    if (ua && ub && Math.abs(dot(ua, ub)) >= PARALLEL_COS) {
      var sg = dot(ua, ub) >= 0 ? 1 : -1, uu = unit(add(ua, mul(ub, sg))), along = dot(dv, uu), perp = sub(dv, mul(uu, along));
      var ds = Math.hypot(a.dirSigma || 0, b.dirSigma || 0), ue = unc();   // неточность направления кромок сказывается на разнесённых по высоте точках
      return { kind: 'edges', value: len(perp), along: Math.abs(along), dir: uu, uncertainty: Math.sqrt(ue * ue + Math.pow(Math.abs(along) * ds, 2)) };
    }
    // кромка лежит в этой же плоскости (край проёма и сама стена): расстояние «точка — плоскость» ≈ 0 и смысла не имеет — пусть считается 3D
    var inPlane = function (n0, u0, v0) { return u0 && Math.abs(dot(n0, u0)) < 0.05 && v0 < 3 * unc(); };
    if (na && !nb) { var vA = Math.abs(dot(na, dv)); return inPlane(na, ub, vA) ? null : { kind: 'point-plane', value: vA, normal: na.slice(), uncertainty: unc() }; }
    if (nb && !na) { var vB = Math.abs(dot(nb, dv)); return inPlane(nb, ua, vB) ? null : { kind: 'point-plane', value: vB, normal: nb.slice(), uncertainty: unc() }; }
    return null;
  }

  return {
    buildIndex: buildIndex, snap: snap, pairGap: pairGap, detectPlanes: detectPlanes, fitLSQ: fitLSQ,
    growPlane: growPlane, collectPlanePoints: collectPlanePoints, planeSigmaAt: planeSigmaAt,
    intersect2: intersect2, intersect3: intersect3, refineJoint: refineJoint, estimateSpacing: estimateSpacing, seedFor: seedFor,
    contourEdge: contourEdge, trackContour: trackContour
  };
});
