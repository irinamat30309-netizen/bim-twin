/*
 * element-identify.js — «Что это?» (ревизия 42): что за элемент под курсором, его размеры, качество и проверка по нормам и документам.
 * UMD без DOM: окно приложения (window.ElementIdentify) и Node (тесты). Ось «вверх» — Y, единицы — метры (как во всём приложении).
 *
 * Как работает (без нейросети, по геометрии облака вокруг точки клика):
 *   1. crop() — точки в рамке ±6 м по горизонтали и ±3,5 м по высоте вокруг клика (прореживание до 600 тыс.).
 *   2. Локальная плоскость в точке клика (метод главных компонент). Плоская — растёт по облаку: точки в полосе плоскости → растр 5 см
 *      в её координатах → связная область от клика; плоскость уточняется МНК по области (2 итерации с отбраковкой выбросов).
 *   3. Тип по нормали и окружению: пол / потолок / перекрытие, стена, узкая грань (колонна, пилон, простенок), горизонтальная
 *      поверхность над полом (стол, ступень, подоконник), наклонная поверхность (пандус, скат, марш). Неплоская — труба, воздуховод,
 *      проём по renderer/auto-measure.js (окружность и плоскости с ±σ) или отдельный предмет (габарит связного облака).
 *   4. Размеры: длина, высота, площадь, толщина (по второй стороне), проёмы в стене, отклонение от вертикали / уклон, СКО от плоскости,
 *      просвет под рейкой 2 м, высота в свету, Ø и DN трубы, высота над полом; объём выравнивающего слоя (штукатурка / стяжка) — оценка.
 *   5. checks — сравнение с допусками встроенной базы норм (СП 70, СП 71, СП 54; класс отделки — opts.finish), queries — что искать
 *      в документах пользователя, docCompare() — сверка размеров с числами, найденными в документах (только как подсказка: применимость
 *      требования к элементу подтверждает человек).
 * identify(pos, click, opts) → { ok, kind, title, dims[], checks[], notes[], queries[], plane, info } ; describe(res) → текст карточки;
 * toTool(res) → краткий JSON для ассистента (get_picked).
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ElementIdentify = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  function AM() {
    if (W && W.AutoMeasure) return W.AutoMeasure;
    if (typeof module === 'object' && typeof require === 'function') { try { return require('../renderer/auto-measure.js'); } catch (_) {} }
    return null;
  }
  var DEG = Math.PI / 180;
  function r2(x, d) { var k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; }
  function fmt(x, d) { if (x == null || !isFinite(x)) return '—'; var v = r2(x, d); if (v === 0) v = 0; return v.toLocaleString('ru-RU', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function pct(arr, p) { if (!arr.length) return NaN; var s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))]; }

  // ------------------------------------------------------------------ собственные векторы симметричной 3×3 (Якоби)
  function eig3(m) {
    var a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var it = 0; it < 30; it++) {
      var p = 0, q = 1, mx = Math.abs(a[0][1]);
      if (Math.abs(a[0][2]) > mx) { p = 0; q = 2; mx = Math.abs(a[0][2]); }
      if (Math.abs(a[1][2]) > mx) { p = 1; q = 2; mx = Math.abs(a[1][2]); }
      if (mx < 1e-15) break;
      var th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (var k = 0; k < 3; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (k = 0; k < 3; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (k = 0; k < 3; k++) { var vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
    var L = [{ l: a[0][0], v: [v[0][0], v[1][0], v[2][0]] }, { l: a[1][1], v: [v[0][1], v[1][1], v[2][1]] }, { l: a[2][2], v: [v[0][2], v[1][2], v[2][2]] }];
    L.sort(function (x, y) { return y.l - x.l; });
    return L;
  }
  // PCA по списку индексов: центр, нормаль (наименьший), собственные значения
  function pca(P, idx) {
    var n = idx.length, cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < n; i++) { var j = idx[i] * 3; cx += P[j]; cy += P[j + 1]; cz += P[j + 2]; }
    cx /= n; cy /= n; cz /= n;
    var m = [0, 0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) { var o = idx[i] * 3, x = P[o] - cx, y = P[o + 1] - cy, z = P[o + 2] - cz; m[0] += x * x; m[1] += x * y; m[2] += x * z; m[3] += y * y; m[4] += y * z; m[5] += z * z; }
    for (i = 0; i < 6; i++) m[i] /= Math.max(1, n);
    var E = eig3(m);
    return { c: [cx, cy, cz], n: norm(E[2].v), e1: norm(E[0].v), l: [Math.max(0, E[0].l), Math.max(0, E[1].l), Math.max(0, E[2].l)], count: n };
  }

  // ------------------------------------------------------------------ точки вокруг клика
  function crop(pos, count, click, opts) {
    opts = opts || {};
    var R = opts.radius || 6, H = opts.height || 3.5, maxP = opts.maxPoints || 600000, n = count == null ? Math.floor(pos.length / 3) : count;
    var cx = click[0], cy = click[1], cz = click[2], k = 0, i;
    for (i = 0; i < n; i++) { var o = i * 3, dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz; if (dx <= R && dx >= -R && dz <= R && dz >= -R && dy <= H && dy >= -H) k++; }
    var step = Math.max(1, Math.ceil(k / maxP)), out = new Float32Array(Math.ceil(k / step) * 3), m = 0, c = 0;
    for (i = 0; i < n; i++) {
      var q = i * 3, ex = pos[q] - cx, ey = pos[q + 1] - cy, ez = pos[q + 2] - cz;
      if (ex <= R && ex >= -R && ez <= R && ez >= -R && ey <= H && ey >= -H) { if (c++ % step === 0 && m * 3 < out.length) { out[m * 3] = pos[q]; out[m * 3 + 1] = pos[q + 1]; out[m * 3 + 2] = pos[q + 2]; m++; } }
    }
    return { pos: out.subarray(0, m * 3), count: m, total: k, step: step, box: [cx - R, cx + R, cz - R, cz + R], radius: R };
  }

  // ------------------------------------------------------------------ сетка соседей (плотная, CSR)
  function Grid(P, n, g) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], i, a;
    for (i = 0; i < n; i++) for (a = 0; a < 3; a++) { var v = P[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
    var d = [0, 0, 0];
    for (;;) { for (a = 0; a < 3; a++) d[a] = Math.max(1, Math.floor((mx[a] - mn[a]) / g) + 1); if (d[0] * d[1] * d[2] <= 4e6) break; g *= 1.5; }
    var cnt = new Int32Array(d[0] * d[1] * d[2] + 1), cell = new Int32Array(n);
    for (i = 0; i < n; i++) {
      var ix = Math.min(d[0] - 1, Math.floor((P[i * 3] - mn[0]) / g)), iy = Math.min(d[1] - 1, Math.floor((P[i * 3 + 1] - mn[1]) / g)), iz = Math.min(d[2] - 1, Math.floor((P[i * 3 + 2] - mn[2]) / g));
      cell[i] = (ix * d[1] + iy) * d[2] + iz; cnt[cell[i] + 1]++;
    }
    for (i = 1; i < cnt.length; i++) cnt[i] += cnt[i - 1];
    var ord = new Int32Array(n), fill = cnt.slice(0, cnt.length - 1);
    for (i = 0; i < n; i++) ord[fill[cell[i]]++] = i;
    this.P = P; this.n = n; this.g = g; this.mn = mn; this.d = d; this.start = cnt; this.ord = ord;
  }
  Grid.prototype.near = function (c, r, cb) {
    var g = this.g, d = this.d, mn = this.mn, P = this.P, r2q = r * r;
    var x0 = Math.max(0, Math.floor((c[0] - r - mn[0]) / g)), x1 = Math.min(d[0] - 1, Math.floor((c[0] + r - mn[0]) / g));
    var y0 = Math.max(0, Math.floor((c[1] - r - mn[1]) / g)), y1 = Math.min(d[1] - 1, Math.floor((c[1] + r - mn[1]) / g));
    var z0 = Math.max(0, Math.floor((c[2] - r - mn[2]) / g)), z1 = Math.min(d[2] - 1, Math.floor((c[2] + r - mn[2]) / g));
    for (var ix = x0; ix <= x1; ix++) for (var iy = y0; iy <= y1; iy++) for (var iz = z0; iz <= z1; iz++) {
      var id = (ix * d[1] + iy) * d[2] + iz;
      for (var t = this.start[id]; t < this.start[id + 1]; t++) {
        var i = this.ord[t], dx = P[i * 3] - c[0], dy = P[i * 3 + 1] - c[1], dz = P[i * 3 + 2] - c[2], q = dx * dx + dy * dy + dz * dz;
        if (q <= r2q) cb(i, q);
      }
    }
  };
  Grid.prototype.list = function (c, r) { var L = []; this.near(c, r, function (i) { L.push(i); }); return L; };

  // ------------------------------------------------------------------ уровни пола и потолка (пики гистограммы высот)
  function levels(P, n) {
    var y0 = Infinity, y1 = -Infinity, i;
    for (i = 0; i < n; i++) { var y = P[i * 3 + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    var b = 0.02, nb = Math.max(1, Math.floor((y1 - y0) / b) + 1), h = new Float64Array(nb);
    for (i = 0; i < n; i++) h[Math.min(nb - 1, Math.floor((P[i * 3 + 1] - y0) / b))]++;
    var avg = n / nb, lo = -1, hi = -1, cut = Math.floor(nb * 0.4);
    for (i = 0; i < nb; i++) {
      var v = h[i] + (i > 0 ? h[i - 1] : 0) * 0.5 + (i < nb - 1 ? h[i + 1] : 0) * 0.5;
      if (i < cut && v > 3 * avg && (lo < 0 || v > h[lo] * 1.0001 + (h[lo - 1] || 0) * 0.5 + (h[lo + 1] || 0) * 0.5)) lo = i;
      if (i >= nb - cut && v > 3 * avg && (hi < 0 || v > h[hi] + (h[hi - 1] || 0) * 0.5 + (h[hi + 1] || 0) * 0.5)) hi = i;
    }
    return { floor: lo >= 0 ? y0 + (lo + 0.5) * b : null, ceiling: hi >= 0 ? y0 + (hi + 0.5) * b : null, y0: y0, y1: y1 };
  }

  // ------------------------------------------------------------------ рейка 2 м по растру отклонений (верхняя огибающая окна)
  // vals[i] — отклонение клетки в сторону «наружу» (к рейке), NaN — нет данных; возвращает наибольший просвет и 95-й процентиль
  function railRow(vals, cell, out) {
    var win = Math.max(3, Math.round(2 / cell)), n = vals.length;
    for (var s = 0; s + win <= n; s += Math.max(1, win >> 2)) {
      var pts = [];
      for (var i = s; i < s + win; i++) if (vals[i] === vals[i]) pts.push([i, vals[i]]);
      if (pts.length < win * 0.6) continue;
      // верхняя выпуклая оболочка — по ней лежит рейка; просвет — расстояние до оболочки
      var hull = [];
      for (var k = 0; k < pts.length; k++) {
        while (hull.length >= 2) { var A = hull[hull.length - 2], B = hull[hull.length - 1], C = pts[k]; if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) >= 0) hull.pop(); else break; }
        hull.push(pts[k]);
      }
      var gap = 0, h = 0;
      for (k = 0; k < pts.length; k++) {
        while (h < hull.length - 2 && hull[h + 1][0] < pts[k][0]) h++;
        var P0 = hull[h], P1 = hull[Math.min(h + 1, hull.length - 1)], y = P1[0] === P0[0] ? P0[1] : P0[1] + (P1[1] - P0[1]) * (pts[k][0] - P0[0]) / (P1[0] - P0[0]);
        if (y - pts[k][1] > gap) gap = y - pts[k][1];
      }
      out.push(gap);
    }
  }

  // ------------------------------------------------------------------ рост плоской области
  function growPlane(G, P, n, seed, n0, c0, o) {
    var nrm = n0.slice(), ctr = c0.slice(), band = o.band, cell = o.cell, res = null;
    for (var it = 0; it < 3; it++) {
      var up = Math.abs(nrm[1]) > 0.7, u, w;
      if (up) { u = norm(cross([0, 0, 1], nrm)); if (!isFinite(u[0]) || Math.hypot(u[0], u[1], u[2]) < 0.5) u = [1, 0, 0]; w = norm(cross(nrm, u)); }
      else { u = norm(cross([0, 1, 0], nrm)); w = norm(cross(nrm, u)); if (w[1] < 0) w = [-w[0], -w[1], -w[2]]; }
      // точки в полосе → растр
      var uu = [], ww = [], ids = [], umin = Infinity, umax = -Infinity, wmin = Infinity, wmax = -Infinity, i;
      for (i = 0; i < n; i++) {
        var x = P[i * 3] - ctr[0], y = P[i * 3 + 1] - ctr[1], z = P[i * 3 + 2] - ctr[2], d = x * nrm[0] + y * nrm[1] + z * nrm[2];
        if (d > band || d < -band) continue;
        var a = x * u[0] + y * u[1] + z * u[2], b = x * w[0] + y * w[1] + z * w[2];
        uu.push(a); ww.push(b); ids.push(i);
        if (a < umin) umin = a; if (a > umax) umax = a; if (b < wmin) wmin = b; if (b > wmax) wmax = b;
      }
      if (ids.length < 50) return res;
      var NU = Math.floor((umax - umin) / cell) + 1, NW = Math.floor((wmax - wmin) / cell) + 1;
      if (NU * NW > 8e6) return res;
      var occ = new Int32Array(NU * NW), sd1 = new Float32Array(NU * NW), sd2 = new Float32Array(NU * NW);
      for (i = 0; i < ids.length; i++) {
        var ck = Math.floor((uu[i] - umin) / cell) * NW + Math.floor((ww[i] - wmin) / cell), q0 = ids[i] * 3;
        var dq = (P[q0] - ctr[0]) * nrm[0] + (P[q0 + 1] - ctr[1]) * nrm[1] + (P[q0 + 2] - ctr[2]) * nrm[2];
        occ[ck]++; sd1[ck] += dq; sd2[ck] += dq * dq;
      }
      // клетка, где точки разбросаны по всей толщине полосы, — это поперечная поверхность (пол, соседняя грань), а не наша плоскость
      var sdMax = 0.33 * band;
      for (i = 0; i < occ.length; i++) if (occ[i] >= 3) { var mq = sd1[i] / occ[i], vq = sd2[i] / occ[i] - mq * mq; if (vq > sdMax * sdMax) occ[i] = -occ[i]; }
      // заливка от клетки клика (8-связность); клетка с 1 точкой — только если рядом есть плотные
      var sx = Math.floor((dot([P[seed * 3] - ctr[0], P[seed * 3 + 1] - ctr[1], P[seed * 3 + 2] - ctr[2]], u) - umin) / cell);
      var sw = Math.floor((dot([P[seed * 3] - ctr[0], P[seed * 3 + 1] - ctr[1], P[seed * 3 + 2] - ctr[2]], w) - wmin) / cell);
      if (sx < 0 || sx >= NU || sw < 0 || sw >= NW || occ[sx * NW + sw] <= 0) {
        var bestD = Infinity, bx = sx, bw = sw; for (var q1 = Math.max(0, sx - 3); q1 <= Math.min(NU - 1, sx + 3); q1++) for (var q2 = Math.max(0, sw - 3); q2 <= Math.min(NW - 1, sw + 3); q2++) if (occ[q1 * NW + q2] > 0 && (q1 - sx) * (q1 - sx) + (q2 - sw) * (q2 - sw) < bestD) { bestD = (q1 - sx) * (q1 - sx) + (q2 - sw) * (q2 - sw); bx = q1; bw = q2; }
        if (!(bestD < Infinity)) return res; sx = bx; sw = bw;
      }
      var lab = new Uint8Array(NU * NW), st = [sx * NW + sw], cells = 0; lab[st[0]] = 1;
      var minOcc = o.minOcc || 2;
      while (st.length) {
        var id = st.pop(), ci = (id / NW) | 0, cj = id - ci * NW; cells++;
        for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
          var ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= NU || nj >= NW) continue;
          var nid = ni * NW + nj; if (lab[nid] || occ[nid] < minOcc) continue; lab[nid] = 1; st.push(nid);
        }
      }
      var mem = [];
      for (i = 0; i < ids.length; i++) if (lab[Math.floor((uu[i] - umin) / cell) * NW + Math.floor((ww[i] - wmin) / cell)]) mem.push(ids[i]);
      if (mem.length < 30) return res;
      var f = pca(P, mem);
      // отбраковка выбросов 2,5σ и повторная подгонка
      var rs = Math.sqrt(f.l[2]) || 1e-4, mem2 = [];
      for (i = 0; i < mem.length; i++) { var o3 = mem[i] * 3, dd = (P[o3] - f.c[0]) * f.n[0] + (P[o3 + 1] - f.c[1]) * f.n[1] + (P[o3 + 2] - f.c[2]) * f.n[2]; if (Math.abs(dd) <= 2.5 * rs) mem2.push(mem[i]); }
      if (mem2.length > 30) f = pca(P, mem2);
      if (dot(f.n, nrm) < 0) f.n = [-f.n[0], -f.n[1], -f.n[2]];
      var mixed = new Uint8Array(NU * NW); for (i = 0; i < occ.length; i++) if (occ[i] < 0) mixed[i] = 1;
      res = { n: f.n, c: f.c, rms: Math.sqrt(f.l[2]), mem: mem, u: u, w: w, umin: umin, wmin: wmin, NU: NU, NW: NW, lab: lab, mixed: mixed, cells: cells, cell: cell, uu: null };
      var ang = Math.acos(Math.min(1, Math.abs(dot(f.n, nrm))));
      nrm = f.n; ctr = f.c; band = Math.max(o.band * 0.8, Math.min(o.band * 1.5, 4 * res.rms + 0.01));
      if (ang < 0.2 * DEG && it > 0) break;
    }
    return res;
  }

  // базис и растр отклонений области: по клеткам cell; side — направление «наружу» (к помещению)
  function surfaceStats(P, R, side, vertical) {
    var u = vertical ? norm(cross([0, 1, 0], R.n)) : R.u, w = vertical ? [0, 1, 0] : norm(cross(R.n, u));
    var n0 = vertical ? norm([R.n[0], 0, R.n[2]]) : [0, 1, 0];       // истинная вертикаль / горизонталь — для объёмов
    if (dot(n0, side) < 0) n0 = [-n0[0], -n0[1], -n0[2]];
    var nn = dot(R.n, side) < 0 ? [-R.n[0], -R.n[1], -R.n[2]] : R.n;
    var a = [], b = [], dv = [], d0 = [], i;
    for (i = 0; i < R.mem.length; i++) {
      var o = R.mem[i] * 3, x = P[o] - R.c[0], y = P[o + 1] - R.c[1], z = P[o + 2] - R.c[2];
      a.push(x * u[0] + y * u[1] + z * u[2]); b.push(x * w[0] + y * w[1] + z * w[2]); dv.push(x * nn[0] + y * nn[1] + z * nn[2]); d0.push(x * n0[0] + y * n0[1] + z * n0[2]);
    }
    var u0 = pct(a, 0.005), u1 = pct(a, 0.995), w0 = pct(b, 0.005), w1 = pct(b, 0.995);
    var c = 0.1, NU = Math.max(1, Math.floor((u1 - u0) / c) + 1), NW = Math.max(1, Math.floor((w1 - w0) / c) + 1);
    var S = new Float64Array(NU * NW), S0 = new Float64Array(NU * NW), C = new Int32Array(NU * NW);
    for (i = 0; i < a.length; i++) {
      var iu = Math.floor((a[i] - u0) / c), iw = Math.floor((b[i] - w0) / c); if (iu < 0 || iw < 0 || iu >= NU || iw >= NW) continue;
      var id = iu * NW + iw; S[id] += dv[i]; S0[id] += d0[i]; C[id]++;
    }
    var grid = new Float64Array(NU * NW), g0 = [], occ = 0;
    for (i = 0; i < NU * NW; i++) { if (C[i] >= 2) { grid[i] = S[i] / C[i]; g0.push(S0[i] / C[i]); occ++; } else grid[i] = NaN; }
    // рейка 2 м: по рядам и по столбцам растра
    var gaps = [], row, j;
    for (j = 0; j < NW; j++) { row = []; for (i = 0; i < NU; i++) row.push(grid[i * NW + j]); railRow(row, c, gaps); }
    for (i = 0; i < NU; i++) { row = []; for (j = 0; j < NW; j++) row.push(grid[i * NW + j]); railRow(row, c, gaps); }
    // выравнивающий слой до истинной вертикали / горизонтали по самому выступающему месту (99,5 %)
    var top = pct(g0, 0.995), vol = 0, cnt = 0;
    for (i = 0; i < g0.length; i++) { if (g0[i] < top) vol += (top - g0[i]) * c * c; cnt++; }
    var dvs = dv.filter(function (x) { return x === x; });
    return { u0: u0, u1: u1, w0: w0, w1: w1, u: u, w: w, nn: nn, cell: c, NU: NU, NW: NW, grid: grid, occ: occ, area: occ * c * c,
      rail: gaps.length ? Math.max.apply(null, gaps) : null, rail95: gaps.length ? pct(gaps, 0.95) : null, railN: gaps.length,
      dev: { p01: pct(dvs, 0.01), p99: pct(dvs, 0.99) }, levelVol: vol, levelArea: cnt * c * c, levelMean: cnt ? vol / (cnt * c * c) : 0 };
  }

  // проёмы в стене: пустые связные области растра заливки (не касаются края), шире 0,4 м
  function wallHoles(R, floorY) {
    var NU = R.NU, NW = R.NW, lab = R.lab, mx = R.mixed || new Uint8Array(NU * NW), seen = new Uint8Array(NU * NW), out = [], i, j;
    for (i = 0; i < NU; i++) for (j = 0; j < NW; j++) {
      var id0 = i * NW + j; if (lab[id0] || mx[id0] || seen[id0]) continue;
      var st = [id0], cells = [], edge = false; seen[id0] = 1;
      while (st.length) {
        var id = st.pop(), ci = (id / NW) | 0, cj = id - ci * NW; cells.push(id);
        if (ci === 0 || cj === 0 || ci === NU - 1 || cj === NW - 1) edge = true;
        for (var d = 0; d < 4; d++) { var ni = ci + (d === 0 ? 1 : d === 1 ? -1 : 0), nj = cj + (d === 2 ? 1 : d === 3 ? -1 : 0); if (ni < 0 || nj < 0 || ni >= NU || nj >= NW) continue; var nid = ni * NW + nj; if (lab[nid] || mx[nid] || seen[nid]) continue; seen[nid] = 1; st.push(nid); }
        if (cells.length > 200000) break;
      }
      var i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1;
      cells.forEach(function (id) { var a = (id / NW) | 0, b = id - a * NW; if (a < i0) i0 = a; if (a > i1) i1 = a; if (b < j0) j0 = b; if (b > j1) j1 = b; });
      var wd = (i1 - i0 + 1) * R.cell, ht = (j1 - j0 + 1) * R.cell, fill = cells.length / ((i1 - i0 + 1) * (j1 - j0 + 1));
      // дверь доходит до пола — касание нижнего края растра допустимо
      var bottomY = R.c[1] + (R.wmin + j0 * R.cell) * R.w[1];
      var door = floorY != null && Math.abs(bottomY - floorY) < 0.12 && j0 === 0;
      if ((edge && !door) || wd < 0.4 || ht < 0.4 || fill < 0.55) continue;
      out.push({ kind: door || (floorY != null && bottomY - floorY < 0.12) ? 'door' : 'window', width: wd, height: ht, sill: floorY != null ? bottomY - floorY : null, u: R.umin + (i0 + i1 + 1) / 2 * R.cell });
    }
    return out.sort(function (a, b) { return a.u - b.u; });
  }

  // вторая сторона: точки за плоскостью (в рамке области) — пик расстояний 4–80 см
  function thickness(P, n, R, S, nn) {
    var h = new Float64Array(81), tot = 0, i;
    for (i = 0; i < n; i++) {
      var o = i * 3, x = P[o] - R.c[0], y = P[o + 1] - R.c[1], z = P[o + 2] - R.c[2], d = -(x * nn[0] + y * nn[1] + z * nn[2]);
      if (d < 0.04 || d > 0.8) continue;
      var a = x * S.u[0] + y * S.u[1] + z * S.u[2], b = x * S.w[0] + y * S.w[1] + z * S.w[2];
      if (a < S.u0 || a > S.u1 || b < S.w0 || b > S.w1) continue;
      h[Math.round(d * 100)]++; tot++;
    }
    var best = -1, bv = 0;
    for (i = 4; i <= 80; i++) { var v = h[i] + 0.5 * ((h[i - 1] || 0) + (h[i + 1] || 0)); if (v > bv) { bv = v; best = i; } }
    if (best < 0 || bv < Math.max(40, 0.05 * R.mem.length)) return null;
    // уточнение: среднее по пику ±1 см
    var s = 0, w = 0; for (i = best - 1; i <= Math.min(80, best + 1); i++) { s += i * h[i]; w += h[i]; }
    if (!(w > 0)) return null;
    return { value: s / w / 100, support: bv / R.mem.length };
  }

  // ------------------------------------------------------------------ допуски встроенной базы
  var FINISH = { simple: { k: 3, cap: 15, rail: 5, name: 'простая' }, improved: { k: 2, cap: 10, rail: 3, name: 'улучшенная' }, high: { k: 1, cap: 5, rail: 2, name: 'высококачественная' } };
  var STD_D = [[21.3, 15], [26.8, 20], [33.5, 25], [42.3, 32], [48, 40], [57, 50], [60, 50], [75.5, 65], [76, 65], [88.5, 80], [89, 80], [108, 100], [114, 100], [133, 125], [159, 150], [219, 200], [273, 250], [325, 300], [377, 350], [426, 400]];
  function dnOf(dMm) { var best = null; STD_D.forEach(function (s) { var e = Math.abs(s[0] - dMm) / s[0]; if (!best || e < best.e) best = { d: s[0], dn: s[1], e: e }; }); return best && best.e <= 0.08 ? best : null; }
  function chk(label, value, limit, unit, cite, note, less) {
    var ok = value == null ? null : (less === false ? value >= limit : value <= limit);
    return { label: label, value: value == null ? null : r2(value, unit === 'м' ? 2 : 1), limit: limit, unit: unit, ok: ok, cite: cite, note: note || '' };
  }

  // ------------------------------------------------------------------ главное
  function identify(pos, click, opts) {
    opts = opts || {};
    var t0 = Date.now(), n = Math.floor(pos.length / 3), info = { points: n };
    if (n < 100 || !click) return { ok: false, error: 'Рядом с точкой слишком мало точек облака.', info: info };
    var G = new Grid(pos, n, 0.1), P = pos;
    // ближайшая точка к клику
    var seed = -1, bd = Infinity;
    G.near(click, 0.2, function (i, q) { if (q < bd) { bd = q; seed = i; } });
    if (seed < 0) return { ok: false, error: 'В точке клика нет точек облака (ближе 20 см).', info: info };
    var sp0 = [P[seed * 3], P[seed * 3 + 1], P[seed * 3 + 2]];
    var k10 = G.list(sp0, 0.1).length, spacing = Math.max(0.002, Math.sqrt(Math.PI * 0.01 / Math.max(1, k10)));
    info.spacing = spacing;
    var L = levels(P, n); info.floor = L.floor; info.ceiling = L.ceiling;
    var r1 = Math.min(0.2, Math.max(0.06, 8 * spacing)), nb = G.list(sp0, r1);
    var loc = nb.length >= 12 ? pca(P, nb) : null;
    var planar = loc && loc.l[2] < 0.04 * loc.l[1] && Math.sqrt(loc.l[2]) < Math.max(0.006, 1.5 * spacing);
    var res = null;
    if (planar) {
      var big = pca(P, G.list(sp0, 0.4).filter(function (i) { var o = i * 3; return Math.abs((P[o] - loc.c[0]) * loc.n[0] + (P[o + 1] - loc.c[1]) * loc.n[1] + (P[o + 2] - loc.c[2]) * loc.n[2]) < 0.03; }));
      if (dot(big.n, loc.n) < 0) big.n = [-big.n[0], -big.n[1], -big.n[2]];
      var band = Math.max(0.02, Math.min(0.05, 4 * Math.sqrt(big.l[2]) + 0.008));
      var R = growPlane(G, P, n, seed, big.n, big.c, { band: band, cell: spacing > 0.02 ? 0.1 : 0.05, minOcc: spacing > 0.02 ? 1 : 2 });
      if (R && R.mem.length >= 80) { res = planeElement(P, n, R, L, opts, sp0); if (res) res._hi = R.mem; }
    }
    if (!res) res = solidElement(P, n, G, sp0, L, opts, spacing);
    res.info = Object.assign(info, res.info || {}, { ms: Date.now() - t0 });
    res.point = sp0;
    res.queries = queriesFor(res);
    // точки найденного элемента — для подсветки на сцене (не больше 60 тыс.)
    if (res.ok && res._hi && res._hi.length) {
      var hi = res._hi, st = Math.max(1, Math.ceil(hi.length / 60000)), m = Math.ceil(hi.length / st), H = new Float32Array(m * 3), w = 0;
      for (var hq = 0; hq < hi.length; hq += st) { var o3 = hi[hq] * 3; H[w++] = P[o3]; H[w++] = P[o3 + 1]; H[w++] = P[o3 + 2]; }
      Object.defineProperty(res, 'highlight', { value: H.subarray(0, w), enumerable: false });
    }
    delete res._hi;
    return res;
  }

  function planeElement(P, n, R, L, opts, sp0) {
    var ny = Math.abs(R.n[1]), dims = [], checks = [], notes = [], kind, title, fin = FINISH[opts.finish] || FINISH.improved;
    // сторона «помещения»: куда больше точек вне плоскости (там стоял сканер и всё остальное)
    var pos = 0, neg = 0, i;
    for (i = 0; i < n; i += 7) { var o = i * 3, d = (P[o] - R.c[0]) * R.n[0] + (P[o + 1] - R.c[1]) * R.n[1] + (P[o + 2] - R.c[2]) * R.n[2]; if (d > 0.15) pos++; else if (d < -0.15) neg++; }
    var side = pos >= neg ? R.n : [-R.n[0], -R.n[1], -R.n[2]];
    var floorY = L.floor, ceilY = L.ceiling;
    if (ny > 0.966) {
      var vertical = false, S = surfaceStats(P, R, side, vertical), y = R.c[1];
      var up = side[1] > 0;   // помещение над плоскостью → пол
      var lenA = S.u1 - S.u0, lenB = S.w1 - S.w0, slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / ny * 1000;
      if (up && floorY != null && Math.abs(y - floorY) > 0.25 && S.area < 3) { kind = 'surface'; title = 'Горизонтальная поверхность над полом (стол, ступень, подоконник, оборудование)'; }
      else if (up) { kind = 'floor'; title = 'Пол'; }
      else if (!up && ceilY != null && Math.abs(y - ceilY) > 0.3 && S.area < 3) { kind = 'soffit'; title = 'Низ элемента под потолком (балка, короб, лоток)'; }
      else { kind = 'ceiling'; title = 'Потолок'; }
      dims.push({ key: 'size', label: 'Размер в плане (по найденной области)', value: [r2(Math.max(lenA, lenB), 2), r2(Math.min(lenA, lenB), 2)], unit: 'м', text: fmt(Math.max(lenA, lenB), 2) + ' × ' + fmt(Math.min(lenA, lenB), 2) + ' м' });
      dims.push({ key: 'area', label: 'Площадь (только снятая часть)', value: r2(S.area, 2), unit: 'м²', text: fmt(S.area, 1) + ' м²' });
      dims.push({ key: 'level', label: 'Отметка (Y)', value: r2(y, 3), unit: 'м', text: fmt(y, 3) + ' м' });
      if (kind === 'floor' && ceilY != null && ceilY - y > 1.5) dims.push({ key: 'clear', label: 'Высота до потолка', value: r2(ceilY - y, 2), unit: 'м', text: fmt(ceilY - y, 2) + ' м' });
      if ((kind === 'ceiling' || kind === 'soffit') && floorY != null && y - floorY > 1) dims.push({ key: 'clear', label: kind === 'soffit' ? 'Высота в свету под элементом' : 'Высота помещения (от пола)', value: r2(y - floorY, 2), unit: 'м', text: fmt(y - floorY, 2) + ' м' });
      if (kind === 'surface' && floorY != null) dims.push({ key: 'above', label: 'Высота над полом', value: r2(y - floorY, 2), unit: 'м', text: fmt(y - floorY, 2) + ' м' });
      dims.push({ key: 'slope', label: 'Уклон', value: r2(slope, 2), unit: 'мм/м', text: fmt(slope, 2) + ' мм/м (' + fmt(slope / 10, 2) + ' %)' });
      dims.push({ key: 'rms', label: 'СКО от плоскости', value: r2(R.rms * 1000, 1), unit: 'мм', text: fmt(R.rms * 1000, 1) + ' мм' });
      if (S.rail != null) dims.push({ key: 'rail', label: 'Просвет под рейкой 2 м (наибольший / 95 %)', value: r2(S.rail * 1000, 1), unit: 'мм', text: fmt(S.rail * 1000, 1) + ' / ' + fmt(S.rail95 * 1000, 1) + ' мм' });
      if (kind === 'floor') {
        dims.push({ key: 'level_vol', label: 'Стяжка до горизонта по высшей точке (оценка)', value: r2(S.levelVol, 3), unit: 'м³', text: fmt(S.levelVol, 2) + ' м³, средняя толщина ' + fmt(S.levelMean * 1000, 0) + ' мм' });
        if (S.rail != null) { checks.push(chk('Ровность под ламинат, паркет, линолеум (рейка 2 м)', S.rail95 * 1000, 2, 'мм', 'СП 71.13330.2017, разд. 8 (встроенная база)')); checks.push(chk('Ровность под плитку (рейка 2 м)', S.rail95 * 1000, 4, 'мм', 'СП 71.13330.2017, разд. 8 (встроенная база)')); }
        checks.push(chk('Отклонение от горизонтали (0,2 % размера помещения)', slope, 2, 'мм/м', 'СП 71.13330.2017, разд. 8 (встроенная база)', 'на ' + fmt(Math.max(lenA, lenB), 1) + ' м это ' + fmt(slope * Math.max(lenA, lenB), 0) + ' мм перепада'));
      }
      if (kind === 'ceiling' && floorY != null && y - floorY > 1) checks.push(chk('Высота жилой комнаты, кухни (не менее)', y - floorY, 2.5, 'м', 'СП 54.13330.2022, разд. 5 (встроенная база)', 'для коридоров и холлов квартир — не менее 2,1 м', false));
      if ((kind === 'ceiling' || kind === 'soffit') && S.rail != null) checks.push(chk('Местные неровности бетона (рейка 2 м)', S.rail95 * 1000, 5, 'мм', 'СП 70.13330.2012, табл. 5.10 (встроенная база)'));
    } else if (ny < 0.26) {
      var S2 = surfaceStats(P, R, side, true), len = S2.u1 - S2.u0;
      var bot = R.c[1] + S2.w0, topY = R.c[1] + S2.w1, H = topY - bot;
      var tilt = Math.asin(Math.min(1, ny)), mmPerM = Math.tan(tilt) * 1000, lean = H * Math.tan(tilt) * 1000;
      var topToRoom = (R.n[1] * (dot(R.n, side) > 0 ? 1 : -1)) < 0;   // нормаль к помещению смотрит вниз → верх наклонён к помещению
      if (len >= 1.2 || H < 1.5) { kind = 'wall'; title = 'Стена'; }
      else { kind = 'column'; title = 'Узкая вертикальная грань: колонна, пилон или простенок'; }
      if (H < 1.0 && floorY != null && bot - floorY > 0.3) { kind = 'vertical'; title = 'Вертикальная поверхность (шкаф, оборудование, ограждение)'; }
      dims.push({ key: 'length', label: kind === 'column' ? 'Ширина грани' : 'Длина', value: r2(len, 2), unit: 'м', text: fmt(len, 2) + ' м' });
      dims.push({ key: 'height', label: 'Высота (снятая часть)', value: r2(H, 2), unit: 'м', text: fmt(H, 2) + ' м' + (floorY != null ? ' (низ ' + fmt(bot - floorY, 2) + ' м от пола)' : '') });
      dims.push({ key: 'area', label: 'Площадь (без проёмов, только снятая часть)', value: r2(S2.area, 2), unit: 'м²', text: fmt(S2.area, 1) + ' м²' });
      var holes = kind === 'wall' ? wallHoles(R, floorY) : [];
      if (holes.length) dims.push({ key: 'openings', label: 'Проёмы в стене', value: holes.length, unit: 'шт', text: holes.map(function (h) { return (h.kind === 'door' ? 'дверь ' : 'окно ') + fmt(h.width, 2) + ' × ' + fmt(h.height, 2) + ' м' + (h.kind === 'window' && h.sill != null ? ', подоконник ' + fmt(h.sill, 2) + ' м' : ''); }).join('; '), list: holes.map(function (h) { return { kind: h.kind, width: r2(h.width, 2), height: r2(h.height, 2), sill: h.sill != null ? r2(h.sill, 2) : null }; }) });
      var th = thickness(P, n, R, S2, S2.nn);
      if (kind === 'column') { var th2 = thickness(P, n, R, S2, S2.nn.map(function (x) { return -x; })); if (th2 && (!th || th2.value < th.value)) th = th2; }
      if (th && kind === 'column') dims.push({ key: 'section', label: 'Сечение (ширина грани × глубина до противоположной грани)', value: [r2(len, 2), r2(th.value, 2)], unit: 'м', text: fmt(len * 1000, 0) + ' × ' + fmt(th.value * 1000, 0) + ' мм' });
      else if (th) dims.push({ key: 'thickness', label: 'Толщина (по второй стороне)', value: r2(th.value, 3), unit: 'м', text: fmt(th.value * 1000, 0) + ' мм' });
      else notes.push(kind === 'column' ? 'Глубина сечения не определена: противоположная грань не снята.' : 'Толщина не определена: вторая сторона стены не снята или закрыта.');
      dims.push({ key: 'plumb', label: 'Отклонение от вертикали', value: r2(lean, 1), unit: 'мм', text: fmt(lean, 1) + ' мм на высоту ' + fmt(H, 2) + ' м (' + fmt(mmPerM, 2) + ' мм/м), верх наклонён ' + (topToRoom ? 'в сторону помещения' : 'от помещения') });
      dims.push({ key: 'rms', label: 'СКО от плоскости', value: r2(R.rms * 1000, 1), unit: 'мм', text: fmt(R.rms * 1000, 1) + ' мм' });
      if (S2.rail != null) dims.push({ key: 'rail', label: 'Просвет под рейкой 2 м (наибольший / 95 %)', value: r2(S2.rail * 1000, 1), unit: 'мм', text: fmt(S2.rail * 1000, 1) + ' / ' + fmt(S2.rail95 * 1000, 1) + ' мм' });
      if (kind === 'wall') dims.push({ key: 'level_vol', label: 'Штукатурка до вертикали по самому выступающему месту (оценка)', value: r2(S2.levelVol, 3), unit: 'м³', text: fmt(S2.levelVol, 2) + ' м³, средний слой ' + fmt(S2.levelMean * 1000, 0) + ' мм' });
      var lim = Math.min(fin.k * H, fin.cap);
      checks.push(chk('Вертикаль под штукатурку (' + fin.name + ')', lean, r2(lim, 1), 'мм', 'СП 71.13330.2017, разд. 7 (встроенная база)', fin.k + ' мм на 1 м, не более ' + fin.cap + ' мм на высоту'));
      checks.push(chk('Вертикаль монолитной стены, колонны (на всю высоту)', lean, 15, 'мм', 'СП 70.13330.2012, табл. 5.10 (встроенная база)', 'если конструкция монолитная и несёт монолитное перекрытие'));
      checks.push(chk('Вертикаль кладки (на этаж)', lean, 10, 'мм', 'СП 70.13330.2012, разд. 9 (встроенная база)', 'если стена из кирпича или блоков'));
      if (S2.rail != null) { checks.push(chk('Неровности бетона (рейка 2 м)', S2.rail95 * 1000, 5, 'мм', 'СП 70.13330.2012, табл. 5.10 (встроенная база)')); checks.push(chk('Неровности кладки (рейка 2 м)', S2.rail95 * 1000, 10, 'мм', 'СП 70.13330.2012, разд. 9 (встроенная база)')); }
      if (th && kind !== 'column') checks.push({ label: 'Толщина — сверьте с проектом', value: r2(th.value * 1000, 0), limit: null, unit: 'мм', ok: null, cite: 'проект', note: 'кладка: допуск толщины ±15 мм (СП 70, разд. 9)' });
    } else {
      var ang = Math.acos(Math.min(1, ny)) / DEG, S3 = surfaceStats(P, R, side, false);
      kind = 'inclined'; title = 'Наклонная поверхность (пандус, скат кровли, лестничный марш, откос)';
      dims.push({ key: 'angle', label: 'Угол к горизонту', value: r2(ang, 1), unit: '°', text: fmt(ang, 1) + '° (уклон ' + fmt(Math.tan(ang * DEG) * 100, 1) + ' %)' });
      dims.push({ key: 'area', label: 'Площадь (снятая часть)', value: r2(S3.area, 2), unit: 'м²', text: fmt(S3.area, 1) + ' м²' });
      dims.push({ key: 'rms', label: 'СКО от плоскости', value: r2(R.rms * 1000, 1), unit: 'мм', text: fmt(R.rms * 1000, 1) + ' мм' });
      if (Math.tan(ang * DEG) * 100 <= 12) checks.push(chk('Уклон пандуса для МГН (не более)', Math.tan(ang * DEG) * 100, 5, '%', 'СП 59.13330.2020 (встроенная база)', 'если это пандус для маломобильных групп', true));
    }
    if (R.rms > 0.012) notes.push('Поверхность шумная или неровная (СКО ' + fmt(R.rms * 1000, 0) + ' мм) — неровность может быть завышена шумом сканера.');
    var bx = opts.box, edge = false;
    if (bx) { for (i = 0; i < R.mem.length && !edge; i += 3) { var q3 = R.mem[i] * 3; if (P[q3] - bx[0] < 0.12 || bx[1] - P[q3] < 0.12 || P[q3 + 2] - bx[2] < 0.12 || bx[3] - P[q3 + 2] < 0.12) edge = true; } }
    if (edge) notes.unshift('Элемент продолжается за пределы области анализа (±' + fmt((bx[1] - bx[0]) / 2, 0) + ' м от точки щелчка) — длина и площадь могут быть больше; щёлкните ближе к середине элемента.');
    notes.push('Размеры — по снятой части' + (bx ? ' в рамке ±' + fmt((bx[1] - bx[0]) / 2, 0) + ' м вокруг точки' : '') + '; закрытое мебелью и тени сканера не учтены.');
    return { ok: true, kind: kind, title: title, dims: dims, checks: checks, notes: notes, plane: { n: R.n.map(function (x) { return r2(x, 4); }), c: R.c.map(function (x) { return r2(x, 3); }), rms: r2(R.rms, 4) }, info: { members: R.mem.length } };
  }

  function solidElement(P, n, G, sp0, L, opts, spacing) {
    var A = AM(), dims = [], notes = [], checks = [], floorY = L.floor;
    if (A && A.analyze) {
      var ids = G.list(sp0, 1.5), m = Math.min(ids.length, 150000), step = ids.length / Math.max(1, m), sub = new Float32Array(m * 3);
      for (var k = 0; k < m; k++) { var j = ids[Math.floor(k * step)] * 3; sub[k * 3] = P[j]; sub[k * 3 + 1] = P[j + 1]; sub[k * 3 + 2] = P[j + 2]; }
      var res = null; try { res = A.analyze(sub, { focus: sp0 }); } catch (_) { res = null; }
      var obs = res && res.ok ? (res.objects || []).filter(function (o) { return o.focusDist != null && o.focusDist <= 0.3 && o.type !== 'pair'; }) : [];
      obs.sort(function (a, b) { return a.focusDist - b.focusDist || b.score - a.score; });
      var ob = obs[0];
      if (ob) {
        var kind = ob.type === 'cylinder' ? 'pipe' : ob.type === 'duct' ? 'duct' : ob.type === 'opening' ? 'opening' : ob.type === 'pipes' ? 'pipes' : 'object';
        var title = ob.title || 'Объект';
        var dSig = null;
        (ob.dims || []).forEach(function (d) {
          if (ob.cylinder && d && /diam|slope/i.test(String(d.dimension || d.key || ''))) { if (/diam/i.test(String(d.dimension || d.key)) && d.sigma) dSig = d.sigma; return; }   // свои строки диаметра и уклона ниже
          if (d && d.value != null && isFinite(d.value)) dims.push({ key: d.key || d.dimension, label: d.label, value: r2(d.value, 3), unit: d.dimension === 'slope' ? '%' : 'м', text: (d.dimension === 'slope' ? fmt(d.value, 2) + ' %' : fmt(d.value * 1000, 0) + ' мм') + (d.sigma ? ' ±' + fmt(d.sigma * 1000, 0) + ' мм' : '') + (d.level ? ' (' + d.level + ')' : '') }); });
        var hiIdx = null;
        if (ob.cylinder) {
          var cy = ob.cylinder, D = 2 * cy.r * 1000, std = dnOf(D), vert = Math.abs(cy.a[1]) > 0.9;
          if (vert && D > 250) { kind = 'column'; title = 'Круглая колонна Ø' + fmt(D, 0) + ' мм'; }
          else title = (vert ? 'Вертикальная труба (стояк) Ø' : 'Труба Ø') + fmt(D, 0) + ' мм';
          dims.unshift({ key: 'diameter', label: 'Наружный диаметр', value: r2(D / 1000, 3), unit: 'м', text: fmt(D, 0) + ' мм' + (dSig ? ' ±' + fmt(dSig * 1000, 0) + ' мм' : '') + (std ? ' ≈ ' + std.d + ' мм, DN' + std.dn : '') });
          var ca = norm(cy.a), tolR = Math.max(0.01, 0.2 * cy.r); hiIdx = [];
          // r42: вся видимая длина трубы в области анализа — точки на поверхности цилиндра, непрерывный участок вдоль оси (разрывы до 0,4 м)
          var t0c = (sp0[0] - cy.c[0]) * ca[0] + (sp0[1] - cy.c[1]) * ca[1] + (sp0[2] - cy.c[2]) * ca[2], BIN = 0.05, bins = {}, onS = [];
          for (var pi = 0; pi < n; pi++) { var o = pi * 3, x = P[o] - cy.c[0], y = P[o + 1] - cy.c[1], z = P[o + 2] - cy.c[2], t = x * ca[0] + y * ca[1] + z * ca[2], dx = x - t * ca[0], dy = y - t * ca[1], dz = z - t * ca[2];
            if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - cy.r) < tolR) { var b = Math.floor((t - t0c) / BIN); bins[b] = (bins[b] || 0) + 1; onS.push(pi, b); } }
          var minB = Math.max(3, 0.002 * onS.length / 2), lo = 0, hi = 0, gap = 0, bb;
          for (bb = 1, gap = 0; gap * BIN <= 0.4 && bb < 4000; bb++) { if ((bins[bb] || 0) >= minB) { hi = bb; gap = 0; } else gap++; }
          for (bb = -1, gap = 0; gap * BIN <= 0.4 && bb > -4000; bb--) { if ((bins[bb] || 0) >= minB) { lo = bb; gap = 0; } else gap++; }
          for (var hk = 0; hk < onS.length; hk += 2) if (onS[hk + 1] >= lo && onS[hk + 1] <= hi) hiIdx.push(onS[hk]);
          var vis = (hi - lo + 1) * BIN;
          dims = dims.filter(function (d) { return d.key !== 'length'; });
          if (vis > 0.2) dims.push({ key: 'length', label: 'Длина видимого участка', value: r2(vis, 2), unit: 'м', text: fmt(vis, 2) + ' м' });
          var hor = Math.hypot(cy.a[0], cy.a[2]);
          if (!vert) dims.push({ key: 'slope', label: 'Уклон оси', value: r2(Math.abs(cy.a[1]) / Math.max(1e-6, hor) * 100, 2), unit: '%', text: fmt(Math.abs(cy.a[1]) / Math.max(1e-6, hor) * 1000, 1) + ' мм/м' });
          if (!vert && floorY != null) dims.push({ key: 'clear', label: 'Низ трубы над полом (высота в свету)', value: r2(cy.c[1] - cy.r - floorY, 2), unit: 'м', text: fmt(cy.c[1] - cy.r - floorY, 2) + ' м' });
          if (std) notes.push('DN — по ближайшему стандартному наружному диаметру (ГОСТ 3262, ГОСТ 10704); толщину стенки по облаку не определить.');
        } else if (ob.center && floorY != null) dims.push({ key: 'above', label: 'Центр над полом', value: r2(ob.center[1] - floorY, 2), unit: 'м', text: fmt(ob.center[1] - floorY, 2) + ' м' });
        return { ok: true, kind: kind, title: title, dims: dims, checks: checks, notes: notes.concat(ob.notes || []).slice(0, 6), info: { method: 'auto-measure', confidence: ob.score != null ? r2(ob.score, 2) : null }, _hi: hiIdx };
      }
    }
    // отдельный предмет: связное облако вокруг клика без пола и потолка — габарит
    var vox = Math.max(0.03, 3 * spacing), seen = {}, q = [sp0], pts = [], cnt = 0;
    var key = function (p) { return Math.floor(p[0] / vox) + ',' + Math.floor(p[1] / vox) + ',' + Math.floor(p[2] / vox); };
    var cells = {};
    G.near(sp0, 1.5, function (i) { var y = P[i * 3 + 1]; if ((floorY != null && y - floorY < 0.03) || (L.ceiling != null && L.ceiling - y < 0.03)) return; var kk = key([P[i * 3], y, P[i * 3 + 2]]); (cells[kk] = cells[kk] || []).push(i); });
    var start = key(sp0); if (!cells[start]) return { ok: false, error: 'Не удалось выделить элемент у точки клика.', info: {} };
    var st = [start]; seen[start] = 1;
    while (st.length && cnt < 400000) {
      var c = st.pop(), arr = cells[c]; cnt += arr.length; for (var t = 0; t < arr.length; t++) pts.push(arr[t]);
      var a3 = c.split(',').map(Number);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) { var nk = (a3[0] + dx) + ',' + (a3[1] + dy) + ',' + (a3[2] + dz); if (!seen[nk] && cells[nk]) { seen[nk] = 1; st.push(nk); } }
    }
    var f = pca(P, pts), ex = [f.e1[0], 0, f.e1[2]]; ex = norm(Math.hypot(ex[0], ex[2]) > 1e-6 ? ex : [1, 0, 0]);
    var ez = [-ex[2], 0, ex[0]], a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach(function (i) { var o = i * 3, a = P[o] * ex[0] + P[o + 2] * ex[2], b = P[o] * ez[0] + P[o + 2] * ez[2]; if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; if (P[o + 1] < y0) y0 = P[o + 1]; if (P[o + 1] > y1) y1 = P[o + 1]; });
    dims.push({ key: 'bbox', label: 'Габарит (длина × ширина × высота)', value: [r2(a1 - a0, 2), r2(b1 - b0, 2), r2(y1 - y0, 2)], unit: 'м', text: fmt(a1 - a0, 2) + ' × ' + fmt(b1 - b0, 2) + ' × ' + fmt(y1 - y0, 2) + ' м' });
    if (floorY != null) dims.push({ key: 'above', label: 'Низ над полом', value: r2(y0 - floorY, 2), unit: 'м', text: fmt(y0 - floorY, 2) + ' м' });
    notes.push('Габарит — по связному облаку в радиусе 1,5 м (без пола и потолка); предмет мог срастись с соседними.');
    return { ok: true, kind: 'object', title: 'Предмет или оборудование', dims: dims, checks: checks, notes: notes, info: { method: 'bbox', members: pts.length }, _hi: pts };
  }

  // ------------------------------------------------------------------ документы: что искать и сверка чисел
  var Q = {
    wall: ['толщина стены', 'отклонение от вертикали стен', 'высота помещения', 'материал стен'], column: ['сечение колонны', 'отклонение колонн от вертикали'],
    floor: ['ровность пола рейка 2 м', 'отметка чистого пола', 'толщина стяжки', 'покрытие пола'], ceiling: ['высота помещения', 'отметка потолка', 'ровность потолка'],
    soffit: ['высота в свету', 'низ балки'], pipe: ['диаметр трубопровода', 'высота прокладки трубопровода', 'уклон трубопровода'], duct: ['сечение воздуховода', 'высота прокладки воздуховода'],
    opening: ['ширина дверного проёма', 'размер оконного проёма'], inclined: ['уклон пандуса', 'уклон кровли'], surface: ['высота подоконника', 'высота столешницы'], object: ['оборудование габариты'], vertical: ['ограждение высота'], pipes: ['расстояние между трубопроводами']
  };
  function queriesFor(res) { return (Q[res.kind] || []).slice(); }
  // ключевые слова размера → ключ размера элемента
  var DIM_WORDS = [
    { key: 'thickness', re: /толщин\S*/i }, { key: 'height', re: /высот\S*\s+(стен|этаж)/i }, { key: 'clear', re: /(высот\S*(\s+помещен\S*|\s+в\s+свету|\s+потолк\S*)?)/i },
    { key: 'diameter', re: /(диаметр\S*|Ø|DN|Ду)/i }, { key: 'length', re: /длин\S*/i }, { key: 'rail', re: /(рейк\S*|ровност\S*|просвет\S*)/i }, { key: 'plumb', re: /(вертикал\S*)/i }
  ];
  function toMeters(v, unit) { unit = String(unit || '').toLowerCase(); return unit === 'мм' || unit === 'mm' ? v / 1000 : unit === 'см' || unit === 'cm' ? v / 100 : v; }
  function docCompare(res, hits) {
    var out = [];
    if (!res || !res.ok) return out;
    var dimsBy = {}; (res.dims || []).forEach(function (d) { if (typeof d.value === 'number') dimsBy[d.key] = d; });
    (hits || []).forEach(function (h) {
      if (!h || h.source === 'встроенная база') return;
      var text = String(h.text || '');
      text.split(/(?<=[.;\n])/).forEach(function (sent) {
        DIM_WORDS.forEach(function (w) {
          var d = dimsBy[w.key]; if (!d || !w.re.test(sent)) return;
          var re = /(\d+(?:[.,]\d+)?)\s*(мм|см|м)(?![²³а-яё])/gi, m;
          while ((m = re.exec(sent))) {
            var v = toMeters(parseFloat(m[1].replace(',', '.')), m[2]);
            var meas = d.unit === 'м' ? d.value : d.unit === 'мм' ? d.value / 1000 : null;
            if (meas == null || !(v > 0)) continue;
            if (w.key === 'diameter' && /DN|Ду/i.test(sent)) continue;   // DN — условный проход, не наружный диаметр
            var isLimit = /(не более|не менее|допуск|отклонени|не выше|не ниже|до\s+\d)/i.test(sent);
            var delta = meas - v, tolA = w.key === 'thickness' ? 0.015 : w.key === 'diameter' ? Math.max(0.005, 0.06 * v) : w.key === 'rail' || w.key === 'plumb' ? 0 : 0.03;
            var status = isLimit ? (/не менее|не ниже/i.test(sent) ? (meas >= v ? 'в пределах' : 'меньше требования') : (meas <= v ? 'в пределах' : 'больше допуска')) : (Math.abs(delta) <= tolA ? 'совпадает' : 'отличается');
            out.push({ key: w.key, label: d.label, measured: meas, doc: v, delta: delta, status: status, limit: isLimit, cite: h.cite || h.source || '', quote: sent.trim().slice(0, 220) });
            break;
          }
        });
      });
    });
    // один лучший результат на размер и источник
    var seen = {}; return out.filter(function (x) { var k = x.key + '|' + x.cite; if (seen[k]) return false; seen[k] = 1; return true; }).slice(0, 8);
  }

  // ------------------------------------------------------------------ текст карточки и краткий JSON для ассистента
  function describe(res, cmp) {
    if (!res || !res.ok) return (res && res.error) || 'Не удалось определить элемент.';
    var L = ['**' + res.title + '**'];
    res.dims.forEach(function (d) { L.push('- ' + d.label + ': ' + d.text); });
    var ch = (res.checks || []).filter(function (c) { return c.limit != null; });
    if (ch.length) { L.push('', '**Проверка по встроенной базе норм** (сверьте с действующей редакцией и проектом):'); ch.forEach(function (c) { L.push('- ' + c.label + ': ' + fmt(c.value, c.unit === 'м' ? 2 : 1) + ' ' + c.unit + ' при ' + (c.ok === null ? 'норме' : 'допуске') + ' ' + fmt(c.limit, c.unit === 'м' ? 2 : 1) + ' ' + c.unit + ' — ' + (c.ok === true ? 'в норме' : c.ok === false ? 'вне нормы' : 'нет данных') + (c.note ? ' (' + c.note + ')' : '') + '; ' + c.cite); }); }
    if (cmp && cmp.length) { L.push('', '**В документах:**'); cmp.forEach(function (x) { L.push('- ' + x.label + ': замер ' + fmt(x.measured * 1000, 0) + ' мм, в документе ' + fmt(x.doc * 1000, 0) + ' мм — ' + x.status + ' (' + x.cite + '; «' + x.quote + '»). Проверьте, что требование относится к этому элементу.'); }); }
    if (res.notes && res.notes.length) { L.push(''); res.notes.forEach(function (t) { L.push('_' + t + '_'); }); }
    return L.join('\n');
  }
  function toTool(res, cmp) {
    if (!res) return { ok: false, message: 'Элемент не выбран: нажмите «Что это?» и щёлкните по облаку.' };
    if (!res.ok) return { ok: false, message: res.error };
    return { ok: true, kind: res.kind, title: res.title, point: res.point && res.point.map(function (x) { return r2(x, 3); }),
      dimensions: res.dims.map(function (d) { return { label: d.label, value: d.value, unit: d.unit, text: d.text }; }),
      checks: (res.checks || []).map(function (c) { return { label: c.label, value: c.value, limit: c.limit, unit: c.unit, ok: c.ok, source: c.cite, note: c.note || undefined }; }),
      documents: (cmp || []).map(function (x) { return { label: x.label, measured_mm: r2(x.measured * 1000, 0), document_mm: r2(x.doc * 1000, 0), status: x.status, source: x.cite, quote: x.quote }; }),
      notes: res.notes, search_queries: res.queries };
  }

  return { identify: identify, crop: crop, describe: describe, toTool: toTool, docCompare: docCompare, queriesFor: queriesFor, dnOf: dnOf, FINISH: FINISH,
    _levels: levels, _railRow: railRow, _pca: pca, _eig3: eig3 };
});
