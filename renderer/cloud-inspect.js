/*
 * cloud-inspect.js — контроль геометрии по облаку точек (ревизия 31).
 *
 * Пол: сетка высот 10 см по всем точкам слоя у пола (в каждой клетке — нижний плотный пик гистограммы высот 2,5 мм, предметы на полу
 * отсеиваются по местной медиане), уклон (плоскость по МНК с отсевом), числа ровности FF и горизонтальности FL по методу ASTM E1155
 * (отсчёты через 12″ = 304,8 мм по линиям в двух направлениях вдоль осей здания, FF = 4,57″/(3·Sq + |q̄|), FL = 12,5″/(3·Sz + |z̄|),
 * z — перепад на 10 футов = 3,048 м), просвет под двухметровой рейкой (рейка ложится на выступы профиля — верхняя выпуклая оболочка),
 * то же по помещениям. Шум скана оценивается по разбросу точек в клетке: FF, ограниченное шумом, и поправка Sq² − 6σ².
 * Стены: по каждой грани плана — сетка 10 × 10 см «вдоль × высота» смещений точек от линии грани (окно ±6 см, гистограмма 2,5 мм,
 * пик ближе всего к линии), плоскость смещение = a + b·t + c·h по МНК с отсевом: c — отклонение от вертикали (мм/м и мм на высоту),
 * остатки — неровность плоскости (СКО, размах), просвет под рейкой 2 м по вертикали и горизонтали. Углы между гранями — от 90°.
 * План против проекта: линии DXF (LINE, LWPOLYLINE, POLYLINE), единицы и положение подбираются сами (повороты по главному
 * направлению, перебор сдвига по «расстоянию до точек», уточнение ICP) или берутся «как в облаке»; отклонения точек среза от
 * ближайшей линии проекта, по каждой линии — среднее смещение, наибольшее, доля длины, подтверждённая облаком.
 *
 *   floorAcc({ u0, v0, u1, v1, h0, h1, cell }) → { add(u, v, h), ... }      floorGrid(acc) → сетка высот
 *   planeFit(grid) · floorMaps(grid, plane) · fNumbers(grid, opts) · straightedge(grid, opts) · floorReport(grid, opts)
 *   wallAcc(faces, { floor, top, minLen }) → { add(u, v, h) }                wallReport(acc, opts)
 *   corners(faces) · dxfSegments(entities) · compareDxf(segments, uv, opts)
 * Чистые функции (UMD: window.CloudInspect, module.exports): поток карты облака (Node) и окно (canvas, отчёт).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudInspect = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var BIN = 0.0025;                         // шаг гистограммы высот / смещений, м
  var FT = 0.3048;                          // 12″ — шаг отсчётов ASTM E1155
  var KF = 4.57 * 25.4, KL = 12.5 * 25.4;   // постоянные FF и FL в миллиметрах

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function median(a) { if (!a.length) return NaN; var s = Float64Array.from(a).sort(); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function quant(sorted, p) { if (!sorted.length) return NaN; var x = clamp(p, 0, 1) * (sorted.length - 1), i = Math.floor(x), f = x - i; return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i]; }
  function stats(arr) {
    var n = arr.length; if (!n) return { n: 0, mean: NaN, sd: NaN };
    var s = 0, i; for (i = 0; i < n; i++) s += arr[i];
    var m = s / n, v = 0; for (i = 0; i < n; i++) v += (arr[i] - m) * (arr[i] - m);
    return { n: n, mean: m, sd: n > 1 ? Math.sqrt(v / (n - 1)) : 0 };
  }

  // пик гистограммы c[off .. off+nb): нижний (pick < 0), ближайший к центру (pick = 0) — среднее и разброс в окне вокруг пика
  function peak(c, off, nb, pick, minPts, out) {
    var tot = 0, k, M = 0, s;
    for (k = 0; k < nb; k++) tot += c[off + k];
    if (tot < minPts) return false;
    var sm = function (j) { return (j > 0 ? c[off + j - 1] : 0) + 2 * c[off + j] + (j + 1 < nb ? c[off + j + 1] : 0); };
    for (k = 0; k < nb; k++) { s = sm(k); if (s > M) M = s; }
    var best = -1, bestD = Infinity, mid = (nb - 1) / 2;
    for (k = 0; k < nb; k++) {
      s = sm(k); if (s < 0.3 * M) continue;
      if ((k > 0 && sm(k - 1) > s) || (k + 1 < nb && sm(k + 1) > s)) continue;
      if (pick < 0) { best = k; break; }
      var d = Math.abs(k - mid); if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) return false;
    var m = best, sd = 0, n = 0;
    for (var it = 0; it < 2; it++) {
      var w = it === 0 ? 6 : clamp(Math.round(2.5 * sd / BIN), 4, 10), c0 = Math.round(m), a = Math.max(0, c0 - w), b = Math.min(nb - 1, c0 + w), sw = 0, sx = 0, sxx = 0;
      for (k = a; k <= b; k++) { var q = c[off + k]; sw += q; sx += q * k; sxx += q * k * k; }
      if (!sw) return false;
      m = sx / sw; sd = Math.sqrt(Math.max(0, sxx / sw - m * m - 1 / 12)) * BIN; n = sw;
    }
    out.pos = (m + 0.5) * BIN; out.sd = Math.max(sd, BIN * 0.3); out.n = n;
    return true;
  }

  // ------------------------------------------------------------------ пол
  function floorAcc(o) {
    var cell = o.cell || 0.1, u0 = o.u0, v0 = o.v0, h0 = o.h0, nb = Math.max(8, Math.ceil((o.h1 - o.h0) / BIN));
    var nx = Math.max(1, Math.ceil((o.u1 - o.u0) / cell)), ny = Math.max(1, Math.ceil((o.v1 - o.v0) / cell));
    while (nx * ny * nb > (o.maxBins || 80e6)) { cell *= 1.25; nx = Math.max(1, Math.ceil((o.u1 - o.u0) / cell)); ny = Math.max(1, Math.ceil((o.v1 - o.v0) / cell)); }
    var bins = new Uint16Array(nx * ny * nb), added = 0;
    return {
      u0: u0, v0: v0, cell: cell, nx: nx, ny: ny, h0: h0, nb: nb, bins: bins,
      add: function (u, v, h) {
        var gx = Math.floor((u - u0) / cell), gy = Math.floor((v - v0) / cell); if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return;
        var b = Math.floor((h - h0) / BIN); if (b < 0 || b >= nb) return;
        var k = (gy * nx + gx) * nb + b; if (bins[k] < 65535) bins[k]++; added++;
      },
      count: function () { return added; }
    };
  }

  // distance transform (chamfer 3-4) до ближайшей недействительной клетки, в клетках
  function edgeDist(valid, nx, ny) {
    var N = nx * ny, d = new Float32Array(N), BIG = 1e9, x, y, k;
    for (k = 0; k < N; k++) d[k] = valid[k] ? BIG : 0;
    for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
      k = y * nx + x; if (!d[k]) continue;
      if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) { d[k] = 1; continue; }
      d[k] = Math.min(d[k], d[k - 1] + 1, d[k - nx] + 1, d[k - nx - 1] + 1.4142, d[k - nx + 1] + 1.4142);
    }
    for (y = ny - 1; y >= 0; y--) for (x = nx - 1; x >= 0; x--) {
      k = y * nx + x; if (!d[k]) continue;
      if (x < nx - 1) d[k] = Math.min(d[k], d[k + 1] + 1);
      if (y < ny - 1) { d[k] = Math.min(d[k], d[k + nx] + 1); if (x < nx - 1) d[k] = Math.min(d[k], d[k + nx + 1] + 1.4142); if (x > 0) d[k] = Math.min(d[k], d[k + nx - 1] + 1.4142); }
    }
    return d;
  }

  // сетка высот пола: z (м, NaN — нет), n (точек), sd (разброс точек, м), flag: 0 нет, 1 пол, 2 предмет / выброс
  function floorGrid(acc, o) {
    o = o || {};
    var nx = acc.nx, ny = acc.ny, nb = acc.nb, N = nx * ny, z = new Float32Array(N).fill(NaN), n = new Uint16Array(N), sd = new Float32Array(N), flag = new Uint8Array(N);
    var pk = { pos: 0, sd: 0, n: 0 }, k, minPts = o.minPts || 6;
    for (k = 0; k < N; k++) if (peak(acc.bins, k * nb, nb, -1, minPts, pk)) { z[k] = acc.h0 + pk.pos; n[k] = Math.min(65535, pk.n); sd[k] = pk.sd; flag[k] = 1; }
    // предметы на полу и выбросы: отличие от местной медианы (окно objWin, по умолчанию 0,7 м) больше objTol (15 мм)
    var R = Math.max(2, Math.round((o.objWin || 0.7) / acc.cell / 2)), tol = o.objTol || 0.015, buf = [], objects = 0;
    var med = new Float32Array(N).fill(NaN);
    for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
      k = y * nx + x; if (flag[k] !== 1) continue; buf.length = 0;
      for (var yy = Math.max(0, y - R); yy <= Math.min(ny - 1, y + R); yy += 1) for (var xx = Math.max(0, x - R); xx <= Math.min(nx - 1, x + R); xx += 1) { var kk = yy * nx + xx; if (flag[kk] === 1) buf.push(z[kk]); }
      med[k] = buf.length >= 5 ? median(buf) : z[k];
    }
    for (k = 0; k < N; k++) if (flag[k] === 1 && Math.abs(z[k] - med[k]) > tol) { flag[k] = 2; objects++; }
    // одиночные клетки (меньше 3 соседей-пола из 8) — край съёмки, не пол
    for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
      k = y * nx + x; if (flag[k] !== 1) continue; var nb8 = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; var X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < nx && Y < ny && flag[Y * nx + X] === 1) nb8++; }
      if (nb8 < 3) flag[k] = 2;
    }
    var valid = new Uint8Array(N), cells = 0; for (k = 0; k < N; k++) if (flag[k] === 1) { valid[k] = 1; cells++; }
    return { u0: acc.u0, v0: acc.v0, cell: acc.cell, nx: nx, ny: ny, z: z, n: n, sd: sd, flag: flag, dist: edgeDist(valid, nx, ny), cells: cells, objects: objects };
  }

  // плоскость z = a + b·u + c·v по клеткам пола (или по клеткам одного помещения: sec, id), МНК с отсевом по 3·MAD
  function planeFit(g, sec, id) {
    var cw = g.cell, us = [], vs = [], zs = [], k, step = Math.max(1, Math.floor(g.cells / 300000));
    var u0 = g.u0, v0 = g.v0, cnt = 0;
    for (k = 0; k < g.nx * g.ny; k++) {
      if (g.flag[k] !== 1 || (sec && sec[k] !== id)) continue;
      if ((cnt++ % step)) continue;
      var x = k % g.nx, y = (k - x) / g.nx; us.push(u0 + (x + 0.5) * cw); vs.push(v0 + (y + 0.5) * cw); zs.push(g.z[k]);
    }
    if (us.length < 10) return null;
    var mu = 0, mv = 0; for (k = 0; k < us.length; k++) { mu += us[k]; mv += vs[k]; } mu /= us.length; mv /= us.length;
    var w = new Float64Array(us.length).fill(1), P = null;
    for (var it = 0; it < 4; it++) {
      var S = [0, 0, 0, 0, 0, 0, 0, 0, 0], B = [0, 0, 0];
      for (k = 0; k < us.length; k++) {
        if (!w[k]) continue; var a = 1, b = us[k] - mu, c = vs[k] - mv, zz = zs[k];
        S[0] += a; S[1] += b; S[2] += c; S[4] += b * b; S[5] += b * c; S[8] += c * c; B[0] += zz; B[1] += b * zz; B[2] += c * zz;
      }
      S[3] = S[1]; S[6] = S[2]; S[7] = S[5];
      var sol = solve3(S, B); if (!sol) break;
      P = { a: sol[0] - sol[1] * mu - sol[2] * mv, b: sol[1], c: sol[2] };
      var res = []; for (k = 0; k < us.length; k++) res.push(Math.abs(zs[k] - (P.a + P.b * us[k] + P.c * vs[k])));
      var mad = median(res) * 1.4826, lim = Math.max(0.002, 3 * mad);
      for (k = 0; k < us.length; k++) w[k] = res[k] <= lim ? 1 : 0;
    }
    if (!P) return null;
    var slope = Math.hypot(P.b, P.c);
    // направление падения (вниз по уклону) — азимут от оси u (восток) против часовой
    return { a: P.a, b: P.b, c: P.c, slope: slope, mmPerM: slope * 1000, deg: Math.atan(slope) * 180 / Math.PI, downDir: Math.atan2(-P.c, -P.b) * 180 / Math.PI, cells: us.length };
  }
  function solve3(S, B) {
    var a = S[0], b = S[1], c = S[2], d = S[3], e = S[4], f = S[5], g = S[6], h = S[7], i = S[8];
    var det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g); if (!(Math.abs(det) > 1e-12)) return null;
    return [
      (B[0] * (e * i - f * h) - b * (B[1] * i - f * B[2]) + c * (B[1] * h - e * B[2])) / det,
      (a * (B[1] * i - f * B[2]) - B[0] * (d * i - f * g) + c * (d * B[2] - B[1] * g)) / det,
      (a * (e * B[2] - B[1] * h) - b * (d * B[2] - B[1] * g) + B[0] * (d * h - e * g)) / det
    ];
  }

  // карты отклонений (мм): от плоскости (ровность) и от горизонтали на средней отметке (горизонтальность)
  function floorMaps(g, P) {
    var N = g.nx * g.ny, dp = new Float32Array(N).fill(NaN), dl = new Float32Array(N).fill(NaN), zs = [], k;
    for (k = 0; k < N; k++) if (g.flag[k] === 1) zs.push(g.z[k]);
    var ref = median(zs);
    for (k = 0; k < N; k++) {
      if (g.flag[k] !== 1) continue; var x = k % g.nx, y = (k - x) / g.nx, u = g.u0 + (x + 0.5) * g.cell, v = g.v0 + (y + 0.5) * g.cell;
      dl[k] = (g.z[k] - ref) * 1000; if (P) dp[k] = (g.z[k] - (P.a + P.b * u + P.c * v)) * 1000;
    }
    return { plane: dp, level: dl, ref: ref };
  }

  // значение сетки в точке (билинейно по четырём клеткам пола; edge — не ближе к краю, м)
  function sampler(g, edge) {
    var cw = g.cell, ed = (edge || 0) / cw;
    return function (u, v) {
      var fx = (u - g.u0) / cw - 0.5, fy = (v - g.v0) / cw - 0.5, x = Math.floor(fx), y = Math.floor(fy);
      if (x < 0 || y < 0 || x + 1 >= g.nx || y + 1 >= g.ny) return NaN;
      var k = y * g.nx + x, f = g.flag;
      if (f[k] !== 1 || f[k + 1] !== 1 || f[k + g.nx] !== 1 || f[k + g.nx + 1] !== 1) return NaN;
      var kc = Math.round(fy) * g.nx + Math.round(fx); if (ed > 0 && !(g.dist[kc] >= ed)) return NaN;
      var tx = fx - x, ty = fy - y, z = g.z;
      return (z[k] * (1 - tx) + z[k + 1] * tx) * (1 - ty) + (z[k + g.nx] * (1 - tx) + z[k + g.nx + 1] * tx) * ty;
    };
  }
  // линии отсчётов в двух направлениях (phi и phi + 90°) через gap м с шагом step: fn(dir, [{u, v, z}...] — непрерывный участок)
  function sampleLines(g, o, fn) {
    var phi = o.phi || 0, gap = o.gap || 0.6, step = o.step || FT, S = sampler(g, o.edge), pad = g.cell;
    var cu = [g.u0, g.u0 + g.nx * g.cell], cv = [g.v0, g.v0 + g.ny * g.cell];
    for (var di = 0; di < (o.oneDir ? 1 : 2); di++) {
      var a = phi + di * Math.PI / 2, dx = Math.cos(a), dy = Math.sin(a), nxv = -dy, nyv = dx;
      var al = Infinity, ah = -Infinity, ol = Infinity, oh = -Infinity;
      [[cu[0], cv[0]], [cu[1], cv[0]], [cu[0], cv[1]], [cu[1], cv[1]]].forEach(function (p) { var s = p[0] * dx + p[1] * dy, t = p[0] * nxv + p[1] * nyv; al = Math.min(al, s); ah = Math.max(ah, s); ol = Math.min(ol, t); oh = Math.max(oh, t); });
      for (var off = ol + gap / 2; off <= oh; off += gap) {
        var run = [];
        for (var s = al + pad; s <= ah; s += step) {
          var u = s * dx + off * nxv, v = s * dy + off * nyv, z = S(u, v);
          if (z === z) run.push({ u: u, v: v, z: z, s: s });
          else if (run.length) { fn(di, run); run = []; }
        }
        if (run.length) fn(di, run);
      }
    }
  }
  function fnum(arr, K) { var st = stats(arr); return st.n ? { n: st.n, mean: st.mean, sd: st.sd, F: K / (3 * st.sd + Math.abs(st.mean)) } : { n: 0, F: NaN }; }
  // числа FF / FL (ASTM E1155): q — разность соседних перепадов на 12″, z — перепад на 10 футов (мм); по помещениям sec / ids
  function fNumbers(g, o) {
    o = o || {};
    var sec = o.sec || null, groups = {}, sig = [];
    var G = function (id) { return groups[id] || (groups[id] = { q: [], z: [], readings: 0 }); };
    var cellOf = function (u, v) { var x = Math.floor((u - g.u0) / g.cell), y = Math.floor((v - g.v0) / g.cell); return y * g.nx + x; };
    sampleLines(g, { phi: o.phi, gap: o.gap || 0.6, step: FT, edge: o.edge != null ? o.edge : 0.61, oneDir: o.oneDir }, function (di, run) {
      for (var i = 0; i < run.length; i++) {
        var kc = cellOf(run[i].u, run[i].v), id = sec ? sec[kc] : 0, A = G('all'), R = id > 0 ? G(id) : null;
        A.readings++; if (R) R.readings++;
        if (g.n[kc] > 0 && (i % 4 === 0)) sig.push(g.sd[kc] / Math.sqrt(g.n[kc]) * 2 / 3);   // билинейный отсчёт по 4 клеткам: СКО × ≈2/3
        if (i >= 2) { var q = ((run[i].z - run[i - 1].z) - (run[i - 1].z - run[i - 2].z)) * 1000; A.q.push(q); var k1 = cellOf(run[i - 1].u, run[i - 1].v), id1 = sec ? sec[k1] : 0; if (id1 > 0) G(id1).q.push(q); }
        if (i >= 10) { var dz = (run[i].z - run[i - 10].z) * 1000; A.z.push(dz); var k5 = cellOf(run[i - 5].u, run[i - 5].v), id5 = sec ? sec[k5] : 0; if (id5 > 0) G(id5).z.push(dz); }
      }
    });
    var sigma = sig.length ? median(sig) * 1000 : NaN;   // СКО отсчёта от шума скана, мм
    var out = {};
    Object.keys(groups).forEach(function (id) {
      var gr = groups[id], FF = fnum(gr.q, KF), FL = fnum(gr.z, KL);
      var sqc = FF.n ? Math.sqrt(Math.max(0, FF.sd * FF.sd - 6 * sigma * sigma)) : NaN;
      out[id] = { readings: gr.readings, FF: FF.F, FL: FL.F, nq: FF.n, nz: FL.n, qMean: FF.mean, qSd: FF.sd, zMean: FL.mean, zSd: FL.sd,
        FFcorr: FF.n && sigma === sigma ? KF / (3 * sqc + Math.abs(FF.mean)) : NaN, enough: FF.n >= 30 && FL.n >= 10 };
    });
    return { all: out.all || { readings: 0, FF: NaN, FL: NaN, nq: 0, nz: 0, enough: false }, sections: out, sigma: sigma, FFnoise: sigma > 0 ? KF / (3 * Math.sqrt(6) * sigma) : Infinity };
  }

  // просвет под рейкой: рейка ложится на выступы профиля — верхняя выпуклая оболочка точек окна; просвет — наибольшее расстояние
  function railGap(xs, zs, a, b) {
    var H = [], i;
    for (i = a; i <= b; i++) {
      while (H.length >= 2) { var p = H[H.length - 2], q = H[H.length - 1]; if ((xs[q] - xs[p]) * (zs[i] - zs[p]) - (zs[q] - zs[p]) * (xs[i] - xs[p]) >= 0) H.pop(); else break; }
      H.push(i);
    }
    var gmax = 0, at = a, j = 0;
    for (i = a; i <= b; i++) {
      while (j + 1 < H.length && xs[H[j + 1]] < xs[i]) j++;
      var p0 = H[j], p1 = H[Math.min(H.length - 1, j + 1)], zt = p1 === p0 ? zs[p0] : zs[p0] + (zs[p1] - zs[p0]) * (xs[i] - xs[p0]) / (xs[p1] - xs[p0]);
      var gp = zt - zs[i]; if (gp > gmax) { gmax = gp; at = i; }
    }
    return { gap: gmax, at: at };
  }
  // двухметровая рейка по линиям через 0,6 м в двух направлениях, рейка переставляется через 0,5 м: { list: [{ u, v, gap (мм), dir, sec }], max, p95, over }
  function straightedge(g, o) {
    o = o || {};
    var len = o.len || 2.0, step = g.cell, K = Math.round(len / step), slide = Math.max(1, Math.round((o.slide || 0.5) / step)), tol = o.tol || 4, list = [], sec = o.sec || null;
    sampleLines(g, { phi: o.phi, gap: o.gap || 0.6, step: step, edge: o.edge != null ? o.edge : 0.3 }, function (di, run) {
      if (run.length < K + 1) return;
      var xs = run.map(function (r) { return r.s; }), zs = run.map(function (r) { return r.z; });
      for (var a = 0; a + K < run.length; a += slide) {
        var r = railGap(xs, zs, a, a + K), m = run[a + (K >> 1)], kc = Math.floor((m.v - g.v0) / g.cell) * g.nx + Math.floor((m.u - g.u0) / g.cell);
        list.push({ u: run[r.at].u, v: run[r.at].v, gap: r.gap * 1000, dir: di, sec: sec ? sec[kc] : 0 });
      }
    });
    return Object.assign({ list: list, tol: tol, len: len }, gapStats(list, tol));
  }
  function gapStats(list, tol) {
    if (!list.length) return { n: 0, max: NaN, p95: NaN, over: NaN, mean: NaN };
    var s = Float64Array.from(list.map(function (x) { return x.gap; })).sort(), over = 0;
    for (var i = 0; i < s.length; i++) if (s[i] > tol) over++;
    return { n: s.length, max: s[s.length - 1], p95: quant(s, 0.95), mean: stats(s).mean, over: over / s.length };
  }

  // помещения плана → номер помещения каждой клетки сетки пола (по сетке разметки auto-plan: lab, u0, v0, cell, nx, ny)
  function sectionsFrom(g, lab, rooms) {
    if (!lab || !rooms || !rooms.length) return null;
    var ids = {}; rooms.forEach(function (r, i) { ids[r.id] = i + 1; });
    var sec = new Int32Array(g.nx * g.ny);
    for (var y = 0; y < g.ny; y++) for (var x = 0; x < g.nx; x++) {
      var u = g.u0 + (x + 0.5) * g.cell, v = g.v0 + (y + 0.5) * g.cell, lx = Math.floor((u - lab.u0) / lab.cell), ly = Math.floor((v - lab.v0) / lab.cell);
      if (lx < 0 || ly < 0 || lx >= lab.nx || ly >= lab.ny) continue;
      var L = lab.lab[ly * lab.nx + lx]; if (L > 0 && ids[L]) sec[y * g.nx + x] = ids[L];
    }
    return sec;
  }

  // сводка по полу: уклон, FF/FL, рейка, размах отклонений; по помещениям — то же
  function floorReport(g, o) {
    o = o || {};
    var P = planeFit(g), maps = floorMaps(g, P), sec = o.sec || null, rooms = o.rooms || [];
    var F = fNumbers(g, { phi: o.phi, sec: sec, gap: o.gap }), R = straightedge(g, { phi: o.phi, sec: sec, tol: o.tol || 4, len: o.railLen || 2 });
    var spread = function (arr) { var s = Float64Array.from(arr.filter(function (x) { return x === x; })).sort(); return s.length ? { p1: quant(s, 0.01), p99: quant(s, 0.99), min: s[0], max: s[s.length - 1] } : null; };
    var res = {
      ok: g.cells >= 50, cells: g.cells, area: g.cells * g.cell * g.cell, objects: g.objects, cell: g.cell, plane: P, ref: maps.ref,
      flat: spread(Array.from(maps.plane)), level: spread(Array.from(maps.level)), F: F.all, sigma: F.sigma, FFnoise: F.FFnoise,
      rail: { n: R.n, max: R.max, p95: R.p95, mean: R.mean, over: R.over, tol: R.tol, len: R.len, worst: R.list.slice().sort(function (a, b) { return b.gap - a.gap; }).slice(0, 200) },
      rooms: [], maps: maps
    };
    if (sec) rooms.forEach(function (rm, i) {
      var id = i + 1, Pi = planeFit(g, sec, id), fs = F.sections[id], rl = R.list.filter(function (x) { return x.sec === id; }), gs = gapStats(rl, R.tol), cells = 0, dev = [];
      for (var k = 0; k < g.nx * g.ny; k++) if (sec[k] === id && g.flag[k] === 1) { cells++; dev.push(maps.plane[k]); }
      if (cells < 50) return;
      var sp = spread(dev);
      res.rooms.push({ name: rm.name, kind: rm.kind, area: cells * g.cell * g.cell, roomArea: rm.area, center: rm.center, tilt: Pi ? Pi.mmPerM : NaN,
        FF: fs ? fs.FF : NaN, FL: fs ? fs.FL : NaN, FFcorr: fs ? fs.FFcorr : NaN, nq: fs ? fs.nq : 0, nz: fs ? fs.nz : 0, enough: !!(fs && fs.enough),
        railMax: gs.max, railOver: gs.over, railN: gs.n, p2v: sp ? sp.p99 - sp.p1 : NaN });
    });
    return res;
  }

  // ------------------------------------------------------------------ стены
  function wallAcc(faces, o) {
    o = o || {};
    var floor = o.floor, top = o.top, cT = o.cellT || 0.1, cH = o.cellH || 0.1, win = o.win || 0.06, nb = Math.round(2 * win / BIN), minLen = o.minLen || 1.0;
    var F = [], total = 0;
    (faces || []).forEach(function (f, i) {
      var L = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]); if (L < minLen) return;
      var dx = (f.b[0] - f.a[0]) / L, dy = (f.b[1] - f.a[1]) / L;
      F.push({ i: i, a: f.a, b: f.b, L: L, dx: dx, dy: dy, nx: -dy, ny: dx, nt: Math.ceil(L / cT), off: 0 });
    });
    var nh = Math.max(1, Math.ceil((top - floor) / cH));
    F.forEach(function (f) { f.off = total; total += f.nt * nh * nb; });
    if (total > (o.maxBins || 120e6)) return null;
    var bins = new Uint16Array(Math.max(1, total));
    // указатель: клетки 0,5 м → грани, проходящие ближе win + 0,35 м
    var ic = 0.5, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    F.forEach(function (f) { bx0 = Math.min(bx0, f.a[0], f.b[0]); by0 = Math.min(by0, f.a[1], f.b[1]); bx1 = Math.max(bx1, f.a[0], f.b[0]); by1 = Math.max(by1, f.a[1], f.b[1]); });
    if (!F.length) return { faces: F, add: function () {}, nh: nh, floor: floor, top: top, cellT: cT, cellH: cH, win: win, nb: nb, bins: bins };
    bx0 -= 1; by0 -= 1; var gnx = Math.ceil((bx1 - bx0 + 1) / ic) + 1, gny = Math.ceil((by1 - by0 + 1) / ic) + 1, lists = new Array(gnx * gny);
    F.forEach(function (f, fi) {
      var k = Math.max(1, Math.ceil(f.L / 0.2));
      for (var s = 0; s <= k; s++) {
        var x = Math.floor((f.a[0] + (f.b[0] - f.a[0]) * s / k - bx0) / ic), y = Math.floor((f.a[1] + (f.b[1] - f.a[1]) * s / k - by0) / ic);
        for (var yy = y - 1; yy <= y + 1; yy++) for (var xx = x - 1; xx <= x + 1; xx++) {
          if (xx < 0 || yy < 0 || xx >= gnx || yy >= gny) continue; var c = yy * gnx + xx, l = lists[c] || (lists[c] = []);
          if (l[l.length - 1] !== fi) l.push(fi);
        }
      }
    });
    var added = 0, h0 = floor + (o.skipBottom != null ? o.skipBottom : 0.15), h1 = top;   // плинтус (до 15 см) — не стена
    return {
      faces: F, nh: nh, floor: floor, top: top, cellT: cT, cellH: cH, win: win, nb: nb, bins: bins,
      add: function (u, v, h) {
        if (h < h0 || h > h1) return;
        var gx = Math.floor((u - bx0) / ic), gy = Math.floor((v - by0) / ic); if (gx < 0 || gy < 0 || gx >= gnx || gy >= gny) return;
        var l = lists[gy * gnx + gx]; if (!l) return;
        for (var j = 0; j < l.length; j++) {
          var f = F[l[j]], du = u - f.a[0], dv = v - f.a[1], t = du * f.dx + dv * f.dy; if (t < 0.05 || t > f.L - 0.05) continue;
          var off = du * f.nx + dv * f.ny; if (off <= -win || off >= win) continue;
          var it = Math.min(f.nt - 1, Math.floor(t / cT)), ih = Math.min(nh - 1, Math.floor((h - floor) / cH)), b = Math.floor((off + win) / BIN);
          var k = f.off + (it * nh + ih) * nb + b; if (bins[k] < 65535) bins[k]++; added++;
        }
      },
      count: function () { return added; }
    };
  }
  // плоскость off = a + b·t + c·h по клеткам с отсевом; side — сторона помещения (+1 / −1 / 0 — неизвестна)
  function fitWall(ts, hs, os) {
    var n = ts.length, w = new Uint8Array(n).fill(1), P = null, res = new Float64Array(n);
    var mt = 0, mh = 0; for (var k = 0; k < n; k++) { mt += ts[k]; mh += hs[k]; } mt /= n; mh /= n;
    for (var it = 0; it < 4; it++) {
      var S = [0, 0, 0, 0, 0, 0, 0, 0, 0], B = [0, 0, 0];
      for (k = 0; k < n; k++) { if (!w[k]) continue; var b = ts[k] - mt, c = hs[k] - mh, o = os[k]; S[0]++; S[1] += b; S[2] += c; S[4] += b * b; S[5] += b * c; S[8] += c * c; B[0] += o; B[1] += b * o; B[2] += c * o; }
      S[3] = S[1]; S[6] = S[2]; S[7] = S[5];
      var sol = solve3(S, B); if (!sol) break;
      P = { a: sol[0] - sol[1] * mt - sol[2] * mh, b: sol[1], c: sol[2] };
      var ab = []; for (k = 0; k < n; k++) { res[k] = os[k] - (P.a + P.b * ts[k] + P.c * hs[k]); ab.push(Math.abs(res[k])); }
      var lim = Math.max(0.004, Math.min(0.02, 3 * 1.4826 * median(ab)));
      for (k = 0; k < n; k++) w[k] = Math.abs(res[k]) <= lim ? 1 : 0;
    }
    return P ? { P: P, res: res, w: w } : null;
  }
  function wallReport(acc, o) {
    o = o || {};
    if (!acc) return { ok: false, message: 'слишком много граней для проверки', walls: [] };
    var nh = acc.nh, nb = acc.nb, cT = acc.cellT, cH = acc.cellH, pk = { pos: 0, sd: 0, n: 0 }, out = [];
    var tolM = o.plumbPerM != null ? o.plumbPerM : 2, tolH = o.plumbMax != null ? o.plumbMax : 10, tolR = o.tol != null ? o.tol : 3, side = o.side || {};
    acc.faces.forEach(function (f) {
      var nt = f.nt, N = nt * nh, off = new Float32Array(N).fill(NaN), ts = [], hs = [], os = [], idx = [], rowCnt = new Int32Array(nh);
      for (var it = 0; it < nt; it++) for (var ih = 0; ih < nh; ih++) {
        var c = it * nh + ih;
        if (peak(acc.bins, f.off + c * nb, nb, 0, o.minPts || 5, pk)) { off[c] = pk.pos - acc.win; ts.push((it + 0.5) * cT); hs.push((ih + 0.5) * cH); os.push(off[c]); idx.push(c); rowCnt[ih]++; }
      }
      if (ts.length < 30) return;
      var fw = fitWall(ts, hs, os); if (!fw) return;
      var rows = []; for (var r = 0; r < nh; r++) if (rowCnt[r] >= Math.max(3, 0.25 * nt)) rows.push(r);
      if (rows.length < 5) return;
      var hLo = rows[0] * cH, hHi = (rows[rows.length - 1] + 1) * cH, H = hHi - hLo;
      var res = new Float32Array(N).fill(NaN), ok = [], k;
      // плоскость — по клеткам без выбросов; в карту и неровность — все клетки ближе objTol (15 мм) к плоскости (дальше — предметы у стены)
      var objTol = o.objTol || 0.015;
      for (k = 0; k < idx.length; k++) if (Math.abs(fw.res[k]) <= objTol) { res[idx[k]] = fw.res[k] * 1000; ok.push(fw.res[k] * 1000); }
      var sres = Float64Array.from(ok).sort(), rms = Math.sqrt(ok.reduce(function (s, x) { return s + x * x; }, 0) / Math.max(1, ok.length));
      // рейка 2 м: по столбцам (вертикаль) и строкам (горизонталь) остатков; рейка прижата к выступам со стороны помещения
      var sd = side[f.i] || 0, gaps = [], K = Math.round(2 / cH), KT = Math.round(2 / cT);
      var rail = function (vals, K2) {
        var xs = [], zs = [], i2, run = function () { if (xs.length > K2) for (var a = 0; a + K2 < xs.length; a += Math.max(1, K2 >> 2)) gaps.push(oneGap(xs, zs, a, a + K2)); xs = []; zs = []; };
        for (i2 = 0; i2 < vals.length; i2++) { var z = vals[i2]; if (z === z) { xs.push(i2); zs.push(z); } else run(); }
        run();
      };
      var oneGap = function (xs, zs, a, b) {
        if (sd) return railGap(xs, zs.map(function (z) { return sd * z; }), a, b).gap;
        var g1 = railGap(xs, zs, a, b).gap, g2 = railGap(xs, zs.map(function (z) { return -z; }), a, b).gap; return Math.max(g1, g2);   // сторона неизвестна — наибольший просвет
      };
      // шум клеток (вторые разности по высоте) и сглаживание медианой 3×3 (30×30 см): рейка ложится на поверхность, а не на шум сканера,
      // розетки и выключатели; неровности шире 20–30 см остаются
      var d2 = [];
      for (var ia = 0; ia < nt; ia++) for (var ib = 1; ib + 1 < nh; ib++) { var r0 = res[ia * nh + ib - 1], r1 = res[ia * nh + ib], r2 = res[ia * nh + ib + 1]; if (r0 === r0 && r1 === r1 && r2 === r2) d2.push(Math.abs(r0 - 2 * r1 + r2)); }
      var noise = d2.length ? median(d2) * 1.4826 / Math.sqrt(6) : NaN, sm = res;
      if (o.smooth !== false) {
        sm = new Float32Array(N).fill(NaN); var nb9 = [];
        for (var ic = 0; ic < nt; ic++) for (var jh = 0; jh < nh; jh++) {
          if (res[ic * nh + jh] !== res[ic * nh + jh]) continue; nb9.length = 0;
          for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) { var X = ic + di, Y = jh + dj; if (X >= 0 && Y >= 0 && X < nt && Y < nh) { var q = res[X * nh + Y]; if (q === q) nb9.push(q); } }
          sm[ic * nh + jh] = nb9.length >= 5 ? median(nb9) : res[ic * nh + jh];
        }
      }
      var col = new Float32Array(nh), row = new Float32Array(nt);
      for (var it2 = 0; it2 < nt; it2++) { for (var ih2 = 0; ih2 < nh; ih2++) col[ih2] = sm[it2 * nh + ih2]; rail(col, K); }
      for (var ih3 = 0; ih3 < nh; ih3++) { for (var it3 = 0; it3 < nt; it3++) row[it3] = sm[it3 * nh + ih3]; rail(row, KT); }
      var gs = gaps.length ? Float64Array.from(gaps).sort() : null, plumb = fw.P.c * 1000, lean = Math.abs(fw.P.c) * H * 1000;
      out.push({ face: f.i, a: f.a, b: f.b, length: f.L, height: H, hFrom: hLo, cover: idx.length / (nt * rows.length),
        plumb: Math.abs(plumb), plumbS: plumb, n: [f.nx, f.ny], lean: lean, toward: sd ? (sd * fw.P.c > 0 ? 'room' : 'out') : '', side: sd, rms: rms, noise: noise, p2v: sres.length ? quant(sres, 0.99) - quant(sres, 0.01) : NaN,
        rail: gs ? gs[gs.length - 1] : NaN, railP95: gs ? quant(gs, 0.95) : NaN, railN: gaps.length,
        okPlumb: Math.abs(plumb) <= tolM && lean <= tolH, okRail: !gs || gs[gs.length - 1] <= tolR,
        grid: { nt: nt, nh: nh, cellT: cT, cellH: cH, res: res }, _sm: o.keepSmooth ? sm : undefined });
    });
    out.forEach(function (w) { w.ok = w.okPlumb && w.okRail; });
    var bad = out.filter(function (w) { return !w.ok; }).length;
    return { ok: true, walls: out, checked: out.length, bad: bad, tol: { plumbPerM: tolM, plumbMax: tolH, rail: tolR } };
  }

  // сторона помещения у грани стены по маршруту сканера: точки маршрута ближе radius (10 м), из которых грань видна
  // (отрезок до грани не пересекает другие грани), голосуют за сторону нормали (−dy, dx); 75 % голосов — сторона известна
  function sidesFromRoute(faces, route, o) {
    o = o || {};
    var out = {}, R = o.radius || 10, minLen = o.minLen || 1, step = o.step || 0.5, maxC = o.maxCand || 24;
    if (!route || route.length < 8 || !faces || !faces.length) return out;
    var P = [], lu = Infinity, lv = Infinity, j, m = route.length >> 2;
    for (j = 0; j < m; j++) { var u = route[j * 4], v = route[j * 4 + 1]; if (u === u && v === v && Math.hypot(u - lu, v - lv) >= step) { P.push(u, v); lu = u; lv = v; } }
    var np = P.length >> 1, gc = Math.max(1, R / 4), gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (j = 0; j < np; j++) { gx0 = Math.min(gx0, P[j * 2]); gy0 = Math.min(gy0, P[j * 2 + 1]); gx1 = Math.max(gx1, P[j * 2]); gy1 = Math.max(gy1, P[j * 2 + 1]); }
    if (!np) return out;
    var gnx = Math.floor((gx1 - gx0) / gc) + 1, gny = Math.floor((gy1 - gy0) / gc) + 1, cellsOf = {};
    for (j = 0; j < np; j++) { var key = Math.floor((P[j * 2 + 1] - gy0) / gc) * gnx + Math.floor((P[j * 2] - gx0) / gc); (cellsOf[key] || (cellsOf[key] = [])).push(j); }
    var box = faces.map(function (f) { return [Math.min(f.a[0], f.b[0]), Math.min(f.a[1], f.b[1]), Math.max(f.a[0], f.b[0]), Math.max(f.a[1], f.b[1])]; });
    var cross = function (ax, ay, bx, by, f) {
      var cx = f.a[0], cy = f.a[1], dx = f.b[0], dy = f.b[1];
      var d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      if (d1 * d2 > 0) return false;
      var d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
      return d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
    };
    var visible = function (px, py, tx, ty, skip) {
      var x0 = Math.min(px, tx), y0 = Math.min(py, ty), x1 = Math.max(px, tx), y1 = Math.max(py, ty);
      for (var k = 0; k < faces.length; k++) {
        if (k === skip) continue; var b = box[k]; if (b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0) continue;
        if (cross(px, py, tx, ty, faces[k])) return false;
      }
      return true;
    };
    faces.forEach(function (f, i) {
      var L = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]); if (L < minLen) return;
      var dx = (f.b[0] - f.a[0]) / L, dy = (f.b[1] - f.a[1]) / L, nx = -dy, ny = dx, pos = 0, neg = 0;
      [0.25, 0.5, 0.75].forEach(function (q) {
        var mx = f.a[0] + (f.b[0] - f.a[0]) * q, my = f.a[1] + (f.b[1] - f.a[1]) * q, cand = [];
        var cx0 = Math.max(0, Math.floor((mx - R - gx0) / gc)), cx1 = Math.min(gnx - 1, Math.floor((mx + R - gx0) / gc));
        var cy0 = Math.max(0, Math.floor((my - R - gy0) / gc)), cy1 = Math.min(gny - 1, Math.floor((my + R - gy0) / gc));
        for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
          var l = cellsOf[cy * gnx + cx]; if (!l) continue;
          for (var t = 0; t < l.length; t++) { var pj = l[t], d = Math.hypot(P[pj * 2] - mx, P[pj * 2 + 1] - my); if (d <= R) cand.push([d, pj]); }
        }
        cand.sort(function (a, b) { return a[0] - b[0]; });
        for (var c = 0; c < Math.min(maxC, cand.length); c++) {
          var px = P[cand[c][1] * 2], py = P[cand[c][1] * 2 + 1], s = (px - mx) * nx + (py - my) * ny; if (Math.abs(s) < 0.2) continue;
          var sg = s > 0 ? 1 : -1;
          if (visible(px, py, mx + nx * sg * 0.03, my + ny * sg * 0.03, i)) { if (sg > 0) pos++; else neg++; }
        }
      });
      var tot = pos + neg; if (tot < 2) return;
      if (pos >= 0.75 * tot) out[i] = 1; else if (neg >= 0.75 * tot) out[i] = -1;
    });
    return out;
  }

  // углы между гранями, сходящимися в одной точке (80–100°): отклонение от 90° в градусах и мм на 1 м
  function corners(faces) {
    var out = [], d = function (p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); };
    for (var i = 0; i < faces.length; i++) for (var j = i + 1; j < faces.length; j++) {
      var A = faces[i], B = faces[j], at = null;
      [[A.a, B.a], [A.a, B.b], [A.b, B.a], [A.b, B.b]].forEach(function (pr) { if (!at && d(pr[0], pr[1]) < 0.15) at = pr[0]; });
      if (!at || Math.min(A.length || d(A.a, A.b), B.length || d(B.a, B.b)) < 0.5) continue;
      var a1 = Math.atan2(A.b[1] - A.a[1], A.b[0] - A.a[0]), a2 = Math.atan2(B.b[1] - B.a[1], B.b[0] - B.a[0]);
      var ang = Math.abs(((a1 - a2) % Math.PI + Math.PI) % Math.PI) * 180 / Math.PI; if (ang < 80 || ang > 100) continue;
      var dev = Math.abs(ang - 90); out.push({ i: i, j: j, at: at, angle: ang, dev: dev, mmPerM: Math.tan(dev * Math.PI / 180) * 1000 });
    }
    return out;
  }

  // ------------------------------------------------------------------ план против проекта (DXF)
  var SKIP_LAYER = /DIM|TEXT|ANNO|ROUTE|AREA|ROOM|FURN|TITLE|SCAN|HATCH|GRID|AXIS|OPEN|DOOR|GLAZ|WIND|ОСИ|РАЗМЕР|ТЕКСТ|ДВЕР|ОКН|ПРОЁМ|ПРОЕМ|МЕБЕЛ/i;
  function dxfSegments(ents, o) {
    o = o || {};
    var out = [], skip = o.skipLayers === false ? null : SKIP_LAYER;
    (ents || []).forEach(function (e) {
      if (skip && skip.test(e.layer || '')) return;
      if (e.type === 'line') out.push({ a: [e.a[0], e.a[1]], b: [e.b[0], e.b[1]], layer: e.layer });
      else if (e.type === 'polyline' && e.points && e.points.length > 1) {
        for (var i = 0; i + 1 < e.points.length; i++) out.push({ a: [e.points[i][0], e.points[i][1]], b: [e.points[i + 1][0], e.points[i + 1][1]], layer: e.layer });
        if (e.closed && e.points.length > 2) { var p = e.points[e.points.length - 1], q = e.points[0]; out.push({ a: [p[0], p[1]], b: [q[0], q[1]], layer: e.layer }); }
      }
    });
    return out.filter(function (s) { return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 1e-9; });
  }
  function segBox(segs) { var b = [Infinity, Infinity, -Infinity, -Infinity]; segs.forEach(function (s) { [s.a, s.b].forEach(function (p) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }); }); return b; }
  function mainDir(segs) {
    var H = new Float64Array(90);
    segs.forEach(function (s) { var L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), a = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180 / Math.PI; H[((Math.round(a) % 90) + 90) % 90] += L; });
    var best = 0; for (var i = 1; i < 90; i++) if (H[i] > H[best]) best = i;
    // уточнение: среднее по ±2° (взвешенное длиной) вокруг пика
    var sx = 0, sy = 0; segs.forEach(function (s) { var L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), a = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 4; var d = Math.abs((((a / 4 * 180 / Math.PI) - best) % 90 + 135) % 90 - 45); if (d <= 2) { sx += L * Math.cos(a); sy += L * Math.sin(a); } });
    return Math.atan2(sy, sx) / 4;
  }
  // главное направление стен по точкам среза: проекции на направление a и a + 90° (клетки 5 см) — резче всего при a вдоль стен
  function cloudDir(uv, n) {
    var step = Math.max(1, Math.floor(n / 60000)), xs = [], ys = [], i;
    for (i = 0; i < n; i += step) { xs.push(uv[i * 2]); ys.push(uv[i * 2 + 1]); }
    var cx = stats(xs).mean, cy = stats(ys).mean, R = 0;
    for (i = 0; i < xs.length; i++) { xs[i] -= cx; ys[i] -= cy; R = Math.max(R, Math.abs(xs[i]), Math.abs(ys[i])); }
    var cell = 0.05, nb = Math.ceil(2 * R * 1.5 / cell) + 2, H = new Float64Array(nb);
    var sharp = function (a) {
      var c = Math.cos(a), s = Math.sin(a), tot = 0;
      for (var pass = 0; pass < 2; pass++) {
        H.fill(0);
        for (var j = 0; j < xs.length; j++) { var p = pass ? -s * xs[j] + c * ys[j] : c * xs[j] + s * ys[j]; H[Math.floor((p + R * 1.5) / cell)]++; }
        for (var k = 0; k < nb; k++) tot += H[k] * H[k];
      }
      return tot;
    };
    var best = 0, bs = -1, a;
    for (a = 0; a < 90; a += 1) { var v = sharp(a * Math.PI / 180); if (v > bs) { bs = v; best = a; } }
    var fine = best;
    for (a = best - 1; a <= best + 1.0001; a += 0.1) { var v2 = sharp(a * Math.PI / 180); if (v2 > bs) { bs = v2; fine = a; } }
    return fine * Math.PI / 180;
  }
  function xform(T, p) { var c = Math.cos(T.rot), s = Math.sin(T.rot); return [T.s * (c * p[0] - s * p[1]) + T.tx, T.s * (s * p[0] + c * p[1]) + T.ty]; }
  // сетка точек среза: занятость и расстояние до ближайшей занятой клетки (в клетках)
  function pointGrid(uv, n, cell, pad) {
    var b = [Infinity, Infinity, -Infinity, -Infinity], i;
    for (i = 0; i < n; i++) { var u = uv[i * 2], v = uv[i * 2 + 1]; if (u < b[0]) b[0] = u; if (u > b[2]) b[2] = u; if (v < b[1]) b[1] = v; if (v > b[3]) b[3] = v; }
    var u0 = b[0] - pad, v0 = b[1] - pad, nx = Math.ceil((b[2] - b[0] + 2 * pad) / cell) + 1, ny = Math.ceil((b[3] - b[1] + 2 * pad) / cell) + 1, cnt = new Uint16Array(nx * ny);
    for (i = 0; i < n; i++) { var k = Math.floor((uv[i * 2 + 1] - v0) / cell) * nx + Math.floor((uv[i * 2] - u0) / cell); if (cnt[k] < 65535) cnt[k]++; }
    var occ = new Uint8Array(nx * ny); for (i = 0; i < nx * ny; i++) occ[i] = cnt[i] >= 2 ? 0 : 1;   // edgeDist: расстояние от «пустых» до занятых
    return { u0: u0, v0: v0, cell: cell, nx: nx, ny: ny, cnt: cnt, D: edgeDist(occ, nx, ny) };
  }
  function samplesOf(segs, step) {
    var pts = [];
    segs.forEach(function (s, si) { var L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), k = Math.max(1, Math.round(L / step)); for (var j = 0; j <= k; j++) pts.push([s.a[0] + (s.b[0] - s.a[0]) * j / k, s.a[1] + (s.b[1] - s.a[1]) * j / k, si]); });
    return pts;
  }
  function chamfer(PG, pts, T, cap) {
    var s = 0, c = Math.cos(T.rot), sn = Math.sin(T.rot);
    for (var i = 0; i < pts.length; i++) {
      var x = T.s * (c * pts[i][0] - sn * pts[i][1]) + T.tx, y = T.s * (sn * pts[i][0] + c * pts[i][1]) + T.ty;
      var gx = Math.floor((x - PG.u0) / PG.cell), gy = Math.floor((y - PG.v0) / PG.cell);
      s += gx < 0 || gy < 0 || gx >= PG.nx || gy >= PG.ny ? cap : Math.min(cap, PG.D[gy * PG.nx + gx]);
    }
    return s / Math.max(1, pts.length);
  }
  // подбор положения проекта: поворот (главные направления + k·90°), сдвиг перебором (клетки 0,5 → 0,1 м), ICP точка-точка
  function alignDxf(segs, uv, o) {
    var n = uv.length >> 1, step = Math.max(1, Math.floor(n / 150000)), sub = new Float32Array(Math.ceil(n / step) * 2), m = 0, i;
    for (i = 0; i < n; i += step) { sub[m * 2] = uv[i * 2]; sub[m * 2 + 1] = uv[i * 2 + 1]; m++; }
    sub = sub.subarray(0, m * 2);
    var sc = o.scale, pdir = o.phi != null ? o.phi : null;
    var cx = 0, cy = 0; for (i = 0; i < m; i++) { cx += sub[i * 2]; cy += sub[i * 2 + 1]; } cx /= m; cy /= m;
    var dsegs = segs.map(function (s) { return { a: [s.a[0] * sc, s.a[1] * sc], b: [s.b[0] * sc, s.b[1] * sc] }; }), db = segBox(dsegs), dcx = (db[0] + db[2]) / 2, dcy = (db[1] + db[3]) / 2;
    var pts = samplesOf(dsegs, 0.25).map(function (p) { return [p[0] - dcx, p[1] - dcy, p[2]]; });
    var thin = pts.length > 4000 ? pts.filter(function (_, j) { return j % Math.ceil(pts.length / 4000) === 0; }) : pts;
    var rough = pointGrid(sub, m, 1.0, 30), coarse = pointGrid(sub, m, 0.5, 30), fine = pointGrid(sub, m, 0.1, 6);
    var few = thin.length > 1500 ? thin.filter(function (_, j) { return j % Math.ceil(thin.length / 1500) === 0; }) : thin;
    var cd = mainDir(dsegs), rots = [];
    if (pdir == null) pdir = cloudDir(sub, m);   // направление стен облака (не проекта): иначе повёрнутый проект не выровнять
    for (var kq = 0; kq < 4; kq++) rots.push(pdir - cd + kq * Math.PI / 2);
    var best = null;
    var ext = Math.max(db[2] - db[0], db[3] - db[1]) / 2 + 10;
    rots.forEach(function (rot) {
      // перебор сдвига: шаг 1 м по сетке 1 м (лучшие 3 места), затем 0,5 м рядом с каждым — в 8 раз быстрее сплошного перебора 0,5 м
      var T = { rot: rot, s: 1, tx: cx, ty: cy }, bb = null, bs = Infinity, top3 = [];
      for (var dx = -ext; dx <= ext; dx += 1) for (var dy = -ext; dy <= ext; dy += 1) {
        var sc1 = chamfer(rough, few, { rot: rot, s: 1, tx: cx + dx, ty: cy + dy }, 6);
        if (top3.length < 3 || sc1 < top3[top3.length - 1][0]) { top3.push([sc1, dx, dy]); top3.sort(function (p, q) { return p[0] - q[0]; }); if (top3.length > 3) top3.pop(); }
      }
      top3.forEach(function (c0) {
        for (var ddx = -1.5; ddx <= 1.5001; ddx += 0.5) for (var ddy = -1.5; ddy <= 1.5001; ddy += 0.5) {
          var sc2 = chamfer(coarse, thin, { rot: rot, s: 1, tx: cx + c0[1] + ddx, ty: cy + c0[2] + ddy }, 6); if (sc2 < bs) { bs = sc2; bb = [c0[1] + ddx, c0[2] + ddy]; }
        }
      });
      T.tx = cx + bb[0]; T.ty = cy + bb[1];
      var bs2 = Infinity, b2 = [0, 0];
      for (var ex = -0.6; ex <= 0.6001; ex += 0.1) for (var ey = -0.6; ey <= 0.6001; ey += 0.1) { var s3 = chamfer(fine, thin, { rot: rot, s: 1, tx: T.tx + ex, ty: T.ty + ey }, 10); if (s3 < bs2) { bs2 = s3; b2 = [ex, ey]; } }
      T.tx += b2[0]; T.ty += b2[1];
      var sAll = chamfer(fine, pts, T, 10);
      if (!best || sAll < best.score) best = { T: T, score: sAll };
    });
    // ICP: образцы линий проекта → ближайшая точка среза (сетка 5 см), порог 0,3 → 0,03 м, поворот + сдвиг (Прокруст)
    var T = best.T, PG = icpGrid(sub, m, 0.05);
    for (var it = 0; it < 30; it++) {
      var thr = Math.max(0.03, 0.3 * Math.pow(0.85, it)), A = [], B = [];
      for (i = 0; i < pts.length; i++) {
        var p = xform(T, pts[i]), q = nearest(PG, p[0], p[1], thr); if (q) { A.push(pts[i]); B.push(q); }
      }
      if (A.length < 20) break;
      var R = procrustes(A, B); if (!R) break;
      var moved = Math.abs(R.rot - T.rot) * 10 + Math.hypot(R.tx - T.tx, R.ty - T.ty); T = { rot: R.rot, s: 1, tx: R.tx, ty: R.ty };
      if (moved < 1e-5 && thr <= 0.031) break;
    }
    // устойчивое уточнение сдвига: невязки вдоль нормалей двух главных направлений, сдвиг — по моде (а не по среднему),
    // чтобы смещённые стены проекта не тянули совмещение на себя: совпадает большинство линий, а не «в среднем все»
    var dense = samplesOf(dsegs, 0.05).map(function (p) { return [p[0] - dcx, p[1] - dcy, p[2]]; });
    if (dense.length > 40000) dense = dense.filter(function (_, j) { return j % Math.ceil(dense.length / 40000) === 0; });
    var nrm = dsegs.map(function (g) { var L = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1; return [-(g.b[1] - g.a[1]) / L, (g.b[0] - g.a[0]) / L]; });
    for (var pass2 = 0; pass2 < 3; pass2++) {
      var cr = Math.cos(T.rot), sr = Math.sin(T.rot), c1 = [Math.cos(T.rot + cd + Math.PI / 2), Math.sin(T.rot + cd + Math.PI / 2)], c2 = [-c1[1], c1[0]];
      var H1 = new Float64Array(121), H2 = new Float64Array(121), n1 = 0, n2 = 0;
      for (i = 0; i < dense.length; i++) {
        var pd = xform(T, dense[i]), qd = nearest(PG, pd[0], pd[1], 0.06); if (!qd) continue;
        var nl = nrm[dense[i][2]], nw = [cr * nl[0] - sr * nl[1], sr * nl[0] + cr * nl[1]], d1 = nw[0] * c1[0] + nw[1] * c1[1], d2 = nw[0] * c2[0] + nw[1] * c2[1];
        var rx = qd[0] - pd[0], ry = qd[1] - pd[1];
        if (Math.abs(d1) > 0.97) { var e1 = rx * c1[0] + ry * c1[1], b1 = Math.round(e1 * 1000) + 60; if (b1 >= 0 && b1 <= 120) { H1[b1]++; n1++; } }
        else if (Math.abs(d2) > 0.97) { var e2 = rx * c2[0] + ry * c2[1], b2 = Math.round(e2 * 1000) + 60; if (b2 >= 0 && b2 <= 120) { H2[b2]++; n2++; } }
      }
      var mode = function (H) { var bb = 60, bv = -1; for (var k = 0; k <= 120; k++) { var v = 0; for (var q = -5; q <= 5; q++) if (k + q >= 0 && k + q <= 120) v += H[k + q] * (6 - Math.abs(q)); if (v > bv) { bv = v; bb = k; } } return (bb - 60) / 1000; };
      var m1 = n1 >= 50 ? mode(H1) : 0, m2 = n2 >= 50 ? mode(H2) : 0;
      if (Math.abs(m1) < 0.0005 && Math.abs(m2) < 0.0005) break;
      T = { rot: T.rot, s: 1, tx: T.tx + m1 * c1[0] + m2 * c2[0], ty: T.ty + m1 * c1[1] + m2 * c2[1] };
    }
    // итог в координатах исходного DXF: p_map = R·(s·p − dc) + t
    var c = Math.cos(T.rot), s = Math.sin(T.rot);
    var full = { rot: T.rot, s: sc, tx: T.tx - (c * dcx - s * dcy), ty: T.ty - (s * dcx + c * dcy) };
    return { T: full, score: best.score };
  }
  function icpGrid(uv, n, cell) {
    var G = pointGrid(uv, n, cell, 1), start = new Int32Array(G.nx * G.ny + 1), i;
    for (i = 0; i < n; i++) { var k = Math.floor((uv[i * 2 + 1] - G.v0) / cell) * G.nx + Math.floor((uv[i * 2] - G.u0) / cell); start[k + 1]++; }
    for (i = 0; i < G.nx * G.ny; i++) start[i + 1] += start[i];
    var fill = start.slice(0, G.nx * G.ny), idx = new Int32Array(n);
    for (i = 0; i < n; i++) { var k2 = Math.floor((uv[i * 2 + 1] - G.v0) / cell) * G.nx + Math.floor((uv[i * 2] - G.u0) / cell); idx[fill[k2]++] = i; }
    G.start = start; G.idx = idx; G.uv = uv; return G;
  }
  function nearest(G, x, y, r) {
    var gx = Math.floor((x - G.u0) / G.cell), gy = Math.floor((y - G.v0) / G.cell), R = Math.ceil(r / G.cell), best = null, bd = r * r;
    for (var yy = gy - R; yy <= gy + R; yy++) { if (yy < 0 || yy >= G.ny) continue; for (var xx = gx - R; xx <= gx + R; xx++) {
      if (xx < 0 || xx >= G.nx) continue; var k = yy * G.nx + xx;
      for (var j = G.start[k]; j < G.start[k + 1]; j++) { var i = G.idx[j], dx = G.uv[i * 2] - x, dy = G.uv[i * 2 + 1] - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [G.uv[i * 2], G.uv[i * 2 + 1]]; } }
    } }
    return best;
  }
  function procrustes(A, B) {
    var n = A.length, ax = 0, ay = 0, bx = 0, by = 0, i;
    for (i = 0; i < n; i++) { ax += A[i][0]; ay += A[i][1]; bx += B[i][0]; by += B[i][1]; }
    ax /= n; ay /= n; bx /= n; by /= n;
    var sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) { var x1 = A[i][0] - ax, y1 = A[i][1] - ay, x2 = B[i][0] - bx, y2 = B[i][1] - by; sxx += x1 * x2 + y1 * y2; sxy += x1 * y2 - y1 * x2; }
    var rot = Math.atan2(sxy, sxx), c = Math.cos(rot), s = Math.sin(rot);
    return { rot: rot, tx: bx - (c * ax - s * ay), ty: by - (s * ax + c * ay) };
  }
  function unitsScale(segs, uv, o) {
    if (o.units === 'm') return 1; if (o.units === 'mm') return 0.001; if (o.units === 'cm') return 0.01;
    var db = segBox(segs), dd = Math.hypot(db[2] - db[0], db[3] - db[1]), n = uv.length >> 1, us = [], vs = [];
    for (var i = 0; i < n; i += Math.max(1, Math.floor(n / 20000))) { us.push(uv[i * 2]); vs.push(uv[i * 2 + 1]); }
    us.sort(function (a, b) { return a - b; }); vs.sort(function (a, b) { return a - b; });
    var cd = Math.hypot(quant(us, 0.99) - quant(us, 0.01), quant(vs, 0.99) - quant(vs, 0.01)), ratio = cd / Math.max(1e-9, dd), best = 1, bd = Infinity;
    [1, 0.001, 0.01, 0.0254, 0.3048].forEach(function (s) { var d = Math.abs(Math.log(ratio / s)); if (d < bd) { bd = d; best = s; } });
    return best;
  }
  // сравнение: uv — точки среза (м, координаты карты); segs — линии проекта; o: { units, align: 'auto'|'world', world: { cx, cy }, tol, phi }
  function compareDxf(segs, uv, o) {
    o = o || {};
    var n = uv.length >> 1; if (!segs.length) return { ok: false, message: 'в DXF нет линий стен (LINE, LWPOLYLINE, POLYLINE)' };
    if (n < 100) return { ok: false, message: 'в срезе мало точек' };
    var sc = unitsScale(segs, uv, o), tol = o.tol || 0.02, T, score = NaN;
    if (o.align === 'world' && o.world) T = { rot: 0, s: sc, tx: -o.world.cx, ty: -o.world.cy };
    else if (o.align === 'none') T = { rot: 0, s: sc, tx: 0, ty: 0 };
    else { var al = alignDxf(segs, uv, { scale: sc, phi: o.phi }); T = al.T; score = al.score; }
    var L = segs.map(function (s) { var a = xform(T, s.a), b = xform(T, s.b); return { a: a, b: b, L: Math.hypot(b[0] - a[0], b[1] - a[1]), layer: s.layer }; });
    // указатель линий: клетки 0,5 м
    var ic = 0.5, bb = segBox(L), x0 = bb[0] - 1, y0 = bb[1] - 1, gnx = Math.ceil((bb[2] - bb[0] + 2) / ic) + 1, gny = Math.ceil((bb[3] - bb[1] + 2) / ic) + 1, lists = new Array(gnx * gny), R = o.reach || 0.3;
    L.forEach(function (s, si) {
      var k = Math.max(1, Math.ceil(s.L / 0.25));
      for (var j = 0; j <= k; j++) { var x = Math.floor((s.a[0] + (s.b[0] - s.a[0]) * j / k - x0) / ic), y = Math.floor((s.a[1] + (s.b[1] - s.a[1]) * j / k - y0) / ic);
        for (var yy = y - 1; yy <= y + 1; yy++) for (var xx = x - 1; xx <= x + 1; xx++) { if (xx < 0 || yy < 0 || xx >= gnx || yy >= gny) continue; var c = yy * gnx + xx, l = lists[c] || (lists[c] = []); if (l[l.length - 1] !== si) l.push(si); } }
    });
    var dev = new Float32Array(n).fill(NaN), near = new Int32Array(n).fill(-1), per = L.map(function (s) { return { sum: 0, n: 0, max: 0, bins: new Uint8Array(Math.max(1, Math.ceil(s.L / 0.1))) }; });
    var within = 0, cnt = 0, absAll = [];
    for (var i = 0; i < n; i++) {
      var u = uv[i * 2], v = uv[i * 2 + 1], gx = Math.floor((u - x0) / ic), gy = Math.floor((v - y0) / ic); if (gx < 0 || gy < 0 || gx >= gnx || gy >= gny) continue;
      var l2 = lists[gy * gnx + gx]; if (!l2) continue;
      var bd = R, bi = -1, bsg = 0, bt = 0;
      for (var j2 = 0; j2 < l2.length; j2++) {
        var s2 = L[l2[j2]], dx = s2.b[0] - s2.a[0], dy = s2.b[1] - s2.a[1], t = ((u - s2.a[0]) * dx + (v - s2.a[1]) * dy) / (s2.L * s2.L);
        if (t < 0 || t > 1) continue;
        var sg = ((u - s2.a[0]) * dy - (v - s2.a[1]) * dx) / s2.L, d = Math.abs(sg);
        if (d < bd) { bd = d; bi = l2[j2]; bsg = sg; bt = t; }
      }
      if (bi < 0) continue;
      dev[i] = bsg * 1000; near[i] = bi; cnt++; absAll.push(bd * 1000); if (bd <= tol) within++;
      var P = per[bi]; P.sum += bsg; P.n++; if (bd > P.max) P.max = bd; if (bd <= Math.max(tol * 3, 0.05)) P.bins[Math.min(P.bins.length - 1, Math.floor(bt * P.bins.length))] = 1;
    }
    var lines = L.map(function (s, si) {
      var P = per[si], cov = 0; for (var b = 0; b < P.bins.length; b++) cov += P.bins[b];
      return { a: s.a, b: s.b, length: s.L, layer: s.layer, points: P.n, offset: P.n ? P.sum / P.n * 1000 : NaN, max: P.max * 1000, cover: cov / P.bins.length };
    });
    var sAbs = Float64Array.from(absAll).sort();
    var long = lines.filter(function (x) { return x.length >= 0.5; });
    return { ok: true, transform: { rot: T.rot * 180 / Math.PI, scale: T.s, tx: T.tx, ty: T.ty, mode: o.align || 'auto', score: score }, units: sc === 1 ? 'm' : sc === 0.001 ? 'mm' : sc === 0.01 ? 'cm' : sc === 0.0254 ? 'in' : 'ft',
      tol: tol, points: cnt, total: n, within: cnt ? within / cnt : NaN, mean: sAbs.length ? stats(sAbs).mean : NaN, p95: quant(sAbs, 0.95), median: quant(sAbs, 0.5),
      lines: lines, missing: long.filter(function (x) { return x.cover < 0.3; }).length, shifted: long.filter(function (x) { return x.cover >= 0.3 && x.points >= 20 && Math.abs(x.offset) > tol * 1000; }).length,
      dev: dev, near: near, segs: L };
  }

  return { floorAcc: floorAcc, floorGrid: floorGrid, planeFit: planeFit, floorMaps: floorMaps, fNumbers: fNumbers, straightedge: straightedge, railGap: railGap,
    sectionsFrom: sectionsFrom, floorReport: floorReport, wallAcc: wallAcc, wallReport: wallReport, corners: corners, sidesFromRoute: sidesFromRoute,
    dxfSegments: dxfSegments, compareDxf: compareDxf, alignDxf: alignDxf, cloudDir: cloudDir, unitsScale: unitsScale, edgeDist: edgeDist, _peak: peak, BIN: BIN, FT: FT, KF: KF, KL: KL };
});
