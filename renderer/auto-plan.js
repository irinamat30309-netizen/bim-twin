/*
 * auto-plan.js — автоматический обмерный план по облаку точек (ревизия 27).
 *
 * Вход — горизонтальный срез облака (точки u, v в метрах, обычно полоса 1,15–1,25 м над полом), выход — грани стен, проёмы, толщины стен,
 * помещения с площадями и размеры, и файл DXF (AutoCAD R12) с отдельными слоями.
 *
 * Как считается (без нейросетей, только геометрия):
 *   1) сетка занятости 2 см (в редком срезе — крупнее); направления стен — пики «резкости» проекции точек на нормаль (до 0,002°);
 *   2) для каждого направления точки поворачиваются так, чтобы стены этого направления стали горизонтальными; в строках сетки ищутся
 *      непрерывные отрезки (разрыв ≤ 10 см), соседние строки сливаются в «грань» (не толще 8 см);
 *   3) положение грани — медиана координаты ВСЕХ её точек (не центров клеток), концы — 0,5 % / 99,5 % по длине: точность — миллиметры
 *      при шуме сканера в 2–5 мм;
 *   4) соосные грани с разрывом 0,5–2,6 м — проём; грани сливаются, концы смыкаются в углах по пересечению линий;
 *   5) параллельные грани на расстоянии 5–60 см с перекрытием — стена, её толщина;
 *   6) помещения — заливка свободного пространства внутри граней (проёмы закрываются), площадь — по клеткам 2 см с поправкой на границу.
 *
 *   AutoPlan.extract(uv, opts) → { ok, faces, openings, walls, rooms, dims, frame, stats }
 *   AutoPlan.toDXF(plan, { units:'mm'|'m', origin:'local'|'world', world:{cx,cy}, route, title }) → строка DXF R12
 * window.AutoPlan + module.exports (тесты и поток карты облака).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoPlan = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEG = Math.PI / 180;

  function bounds(uv, n) {
    var a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (var i = 0; i < n; i++) { var u = uv[i * 2], v = uv[i * 2 + 1]; if (u < a) a = u; if (u > c) c = u; if (v < b) b = v; if (v > d) d = v; }
    return { u0: a, v0: b, u1: c, v1: d };
  }
  function grid(uv, n, cell, bb, rot) {
    var cs = rot ? Math.cos(rot) : 1, sn = rot ? Math.sin(rot) : 0;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i, x, y;
    if (rot) {
      for (i = 0; i < n; i++) { x = uv[i * 2] * cs + uv[i * 2 + 1] * sn; y = -uv[i * 2] * sn + uv[i * 2 + 1] * cs; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    } else { x0 = bb.u0; y0 = bb.v0; x1 = bb.u1; y1 = bb.v1; }
    x0 -= cell * 2; y0 -= cell * 2;
    var nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 3), ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 3);
    var cnt = new Uint16Array(nx * ny);
    for (i = 0; i < n; i++) {
      x = rot ? uv[i * 2] * cs + uv[i * 2 + 1] * sn : uv[i * 2]; y = rot ? -uv[i * 2] * sn + uv[i * 2 + 1] * cs : uv[i * 2 + 1];
      var gx = Math.floor((x - x0) / cell), gy = Math.floor((y - y0) / cell), k = gy * nx + gx;
      if (cnt[k] < 65535) cnt[k]++;
    }
    return { x0: x0, y0: y0, nx: nx, ny: ny, cell: cell, cnt: cnt, cs: cs, sn: sn };
  }
  function medianNZ(cnt) {
    var vals = [], step = Math.max(1, Math.floor(cnt.length / 2000000));
    for (var i = 0; i < cnt.length; i += step) if (cnt[i]) vals.push(cnt[i]);
    if (!vals.length) return 0;
    vals.sort(function (a, b) { return a - b; });
    return vals[Math.floor(vals.length / 2)];
  }
  function threshold(cnt) {
    var vals = [], step = Math.max(1, Math.floor(cnt.length / 2000000));
    for (var i = 0; i < cnt.length; i += step) if (cnt[i]) vals.push(cnt[i]);
    if (!vals.length) return 1;
    vals.sort(function (a, b) { return a - b; });
    var p90 = vals[Math.floor(vals.length * 0.9)];
    return Math.max(2, Math.round(p90 * 0.06));
  }

  // направления стен: «резкость» проекции точек на нормаль (сумма квадратов гистограммы 2 см). Когда направление совпадает со стенами,
  // точки каждой стены падают в одну-две ячейки и сумма квадратов максимальна. Грубо — шаг 0,25°, затем уточнение до 0,01°.
  function sharpness(sub, m, th, bin) {
    var c = Math.cos(th), s = Math.sin(th), mn = Infinity, mx = -Infinity, i, r;
    var rho = new Float64Array(m);
    for (i = 0; i < m; i++) { r = -sub[i * 2] * s + sub[i * 2 + 1] * c; rho[i] = r; if (r < mn) mn = r; if (r > mx) mx = r; }
    var nb = Math.min(4000000, Math.floor((mx - mn) / bin) + 2), h = new Uint32Array(nb), sum = 0;
    for (i = 0; i < m; i++) h[Math.floor((rho[i] - mn) / bin)]++;
    for (i = 0; i < nb; i++) if (h[i] > 1) sum += h[i] * h[i];
    return sum / m;
  }
  function directions(uv, n, maxDirs) {
    var m = Math.min(n, 80000), step = n / m, sub = new Float64Array(m * 2), i, k;
    for (i = 0; i < m; i++) { k = Math.floor(i * step); sub[i * 2] = uv[k * 2]; sub[i * 2 + 1] = uv[k * 2 + 1]; }
    var NA = 720, S = new Float64Array(NA);
    for (i = 0; i < NA; i++) S[i] = sharpness(sub, m, i * Math.PI / NA, 0.02);
    var sorted = Array.from(S).sort(function (a, b) { return a - b; }), base = sorted[Math.floor(NA / 2)], top = sorted[NA - 1];
    var peaks = [];
    for (i = 0; i < NA; i++) {
      var isMax = true; for (k = -20; k <= 20 && isMax; k++) if (k && S[(i + k + NA) % NA] > S[i]) isMax = false;   // ±5°
      if (isMax && S[i] - base >= (top - base) * 0.12) peaks.push({ a: i * Math.PI / NA, w: S[i] });
    }
    peaks.sort(function (p, q) { return q.w - p.w; });
    var dirs = peaks.slice(0, maxDirs || 6).map(function (p) {
      // уточнение: поиск по сетке ±0,3° шагом 0,02°, затем ±0,02° шагом 0,002°
      var best = p.a, bw = -1, a, w;
      for (a = p.a - 0.3 * DEG; a <= p.a + 0.3 * DEG; a += 0.02 * DEG) { w = sharpness(sub, m, a, 0.01); if (w > bw) { bw = w; best = a; } }
      var c0 = best;
      for (a = c0 - 0.02 * DEG; a <= c0 + 0.02 * DEG; a += 0.002 * DEG) { w = sharpness(sub, m, a, 0.005); if (w > bw) { bw = w; best = a; } }
      return ((best % Math.PI) + Math.PI) % Math.PI;
    });
    if (!dirs.length) dirs = [0];
    var main = dirs[0], perp = (main + Math.PI / 2) % Math.PI;
    if (!dirs.some(function (d) { return angDiff(d, perp) < 3 * DEG; })) dirs.push(perp);
    return dirs;
  }
  function angDiff(a, b) { var d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }

  // грани одного направления: в повёрнутой сетке стены этого направления — горизонтальные строки
  function facesForDirection(uv, n, phi, o, bb) {
    var cell = o.cell, G = grid(uv, n, cell, bb, phi), nx = G.nx, ny = G.ny, cnt = G.cnt, thr = o.thr;
    var gapC = Math.max(1, Math.round(o.gap / cell)), minC = Math.max(2, Math.round(o.minLen / cell)), maxRows = Math.max(2, Math.round(o.maxFace / cell));
    var clusters = [], active = [];
    for (var y = 0; y < ny; y++) {
      var runs = [], x = 0, row = y * nx;
      while (x < nx) {
        if (cnt[row + x] < thr) { x++; continue; }
        var s = x, e = x, miss = 0; x++;
        while (x < nx) { if (cnt[row + x] >= thr) { e = x; miss = 0; } else if (++miss > gapC) break; x++; }
        if (e - s + 1 >= minC) runs.push([s, e]);
      }
      var next = [];
      for (var r = 0; r < runs.length; r++) {
        var a = runs[r][0], b = runs[r][1], hit = null;
        for (var q = 0; q < active.length; q++) {
          var c = active[q], ov = Math.min(b, c.e) - Math.max(a, c.s);
          if (ov > 0.5 * Math.min(b - a, c.e - c.s)) { hit = c; break; }
        }
        if (hit && hit.lastRow === y - 1) { hit.s = Math.min(hit.s, a); hit.e = Math.max(hit.e, b); hit.lastRow = y; hit.rows++; if (next.indexOf(hit) < 0) next.push(hit); }
        else { var nc = { s: a, e: b, firstRow: y, lastRow: y, rows: 1 }; clusters.push(nc); next.push(nc); }
      }
      active = next;
    }
    var cs = Math.cos(phi), sn = Math.sin(phi), out = [];
    // точки каждой грани: проход по точкам, клетка → грань (карта клеток)
    var owner = new Int32Array(nx * ny).fill(-1), good = [];
    clusters.forEach(function (c, ci) {
      if (c.rows > maxRows) return;
      good.push(ci);
      for (var yy = Math.max(0, c.firstRow - 1); yy <= Math.min(ny - 1, c.lastRow + 1); yy++) for (var xx = c.s; xx <= c.e; xx++) if (owner[yy * nx + xx] < 0) owner[yy * nx + xx] = ci;
    });
    if (!good.length) return out;
    var ys = {}, xs = {};
    good.forEach(function (ci) { ys[ci] = []; xs[ci] = []; });
    for (var i = 0; i < n; i++) {
      var X = uv[i * 2] * cs + uv[i * 2 + 1] * sn, Y = -uv[i * 2] * sn + uv[i * 2 + 1] * cs;
      var gx = Math.floor((X - G.x0) / cell), gy = Math.floor((Y - G.y0) / cell);
      if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue;
      var ow = owner[gy * nx + gx]; if (ow < 0) continue;
      ys[ow].push(Y); xs[ow].push(X);
    }
    var sxy = 0, sxx = 0;
    good.forEach(function (ci) {
      var Ys = ys[ci], Xs = xs[ci]; if (Ys.length < 8) return;
      var sy = Float64Array.from(Ys).sort(), sx = Float64Array.from(Xs).sort();
      var med = sy[Math.floor(sy.length / 2)];
      // уточнение: среднее точек в ±1,5 см от медианы (шум сканера симметричен)
      var s1 = 0, m1 = 0; for (var k = 0; k < Ys.length; k++) if (Math.abs(Ys[k] - med) <= 0.015) { s1 += Ys[k]; m1++; }
      var yv = m1 ? s1 / m1 : med;
      // концы: третья точка от края (не доля длины — иначе у длинной грани срезаются сантиметры)
      var kq = Math.min(2, Math.floor(sx.length * 0.005));
      var xa = sx[kq], xb = sx[sx.length - 1 - kq];
      // наклон точек грани относительно оси (для уточнения направления по всем граням сразу)
      var mx = 0, my = 0, mm = 0;
      for (k = 0; k < Ys.length; k++) if (Math.abs(Ys[k] - med) <= 0.015) { mx += Xs[k]; my += Ys[k]; mm++; }
      if (mm > 8 && xb - xa >= o.minLen) {
        mx /= mm; my /= mm;
        for (k = 0; k < Ys.length; k++) if (Math.abs(Ys[k] - med) <= 0.015) { sxy += (Xs[k] - mx) * (Ys[k] - my); sxx += (Xs[k] - mx) * (Xs[k] - mx); }
      }
      var spread = sy[Math.floor(sy.length * 0.9)] - sy[Math.floor(sy.length * 0.1)];
      if (xb - xa < o.minLen) return;
      // шаг точек вдоль грани (разности > 5 мм — точки одного «столбика» по высоте не считаются)
      var dd = [], stp = Math.max(1, Math.floor(sx.length / 4000));
      for (k = stp; k < sx.length; k += stp) { var df = sx[k] - sx[k - stp]; if (df > 0.005 && df < 0.2) dd.push(df); }
      dd.sort(function (a, b) { return a - b; });
      var step = dd.length >= 8 ? dd[Math.floor(dd.length / 2)] : 0;
      out.push({ phi: phi, y: yv, x0: xa, x1: xb, n: Ys.length, spread: spread, step: step });
    });
    out.slope = sxx > 0 ? sxy / sxx : 0;
    return out;
  }

  // слияние соосных граней одного направления + проёмы между ними
  function mergeCollinear(faces, o) {
    faces.sort(function (a, b) { return a.y - b.y || a.x0 - b.x0; });
    var groups = [];
    faces.forEach(function (f) {
      var g = null;
      for (var i = groups.length - 1; i >= 0 && !g; i--) if (Math.abs(groups[i].y - f.y) <= o.collinear) g = groups[i];
      if (!g) { g = { y: f.y, items: [], w: 0 }; groups.push(g); }
      g.items.push(f); g.y = (g.y * g.w + f.y * f.n) / (g.w + f.n); g.w += f.n;
    });
    var merged = [], openings = [];
    groups.forEach(function (g) {
      g.items.sort(function (a, b) { return a.x0 - b.x0; });
      var cur = null;
      g.items.forEach(function (f) {
        if (cur && f.x0 - cur.x1 <= o.join) { cur.x1 = Math.max(cur.x1, f.x1); cur.y = (cur.y * cur.n + f.y * f.n) / (cur.n + f.n); cur.step = Math.max(cur.step || 0, f.step || 0); cur.n += f.n; return; }
        if (cur) {
          var gap = f.x0 - cur.x1;
          if (gap >= o.openMin && gap <= o.openMax) {
            // край проёма лежит за последней точкой стены: в среднем на долю шага точек с каждой стороны.
            // Поправка 0,75 шага на проём (не больше 3 см) — грани у проёма доводятся до оценки края
            var c = Math.min(0.03, 0.375 * ((cur.step || 0) + (f.step || 0)), gap * 0.05);
            cur.x1 += c / 2; f = Object.assign({}, f, { x0: f.x0 - c / 2 });
            openings.push({ phi: f.phi, y: (cur.y + f.y) / 2, x0: cur.x1, x1: f.x0, width: f.x0 - cur.x1 });
          }
          merged.push(cur);
        }
        cur = { phi: f.phi, y: f.y, x0: f.x0, x1: f.x1, n: f.n, step: f.step };
      });
      if (cur) merged.push(cur);
    });
    return { faces: merged, openings: openings };
  }

  function toWorld(phi, x, y) { var c = Math.cos(phi), s = Math.sin(phi); return [x * c - y * s, x * s + y * c]; }
  function faceSeg(f) { return { a: toWorld(f.phi, f.x0, f.y), b: toWorld(f.phi, f.x1, f.y) }; }
  function lineInter(p, d, q, e) {
    var den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-9) return null;
    var t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
    return [p[0] + d[0] * t, p[1] + d[1] * t];
  }
  // углы: конец грани у другой непараллельной грани → оба доводятся до пересечения линий (не дальше snap)
  function closeCorners(segs, snap) {
    var i, j;
    for (i = 0; i < segs.length; i++) {
      var A = segs[i], da = [A.b[0] - A.a[0], A.b[1] - A.a[1]], La = Math.hypot(da[0], da[1]); if (!La) continue;
      for (j = 0; j < segs.length; j++) {
        if (i === j) continue;
        var B = segs[j], db = [B.b[0] - B.a[0], B.b[1] - B.a[1]], Lb = Math.hypot(db[0], db[1]); if (!Lb) continue;
        if (Math.abs((da[0] * db[0] + da[1] * db[1]) / (La * Lb)) > 0.94) continue;   // почти параллельны
        var X = lineInter(A.a, da, B.a, db); if (!X) continue;
        var ta = ((X[0] - A.a[0]) * da[0] + (X[1] - A.a[1]) * da[1]) / (La * La), tb = ((X[0] - B.a[0]) * db[0] + (X[1] - B.a[1]) * db[1]) / (Lb * Lb);
        var ea = ta < 0.5 ? 'a' : 'b', eb = tb < 0.5 ? 'a' : 'b';
        var distA = Math.hypot(A[ea][0] - X[0], A[ea][1] - X[1]), distB = Math.hypot(B[eb][0] - X[0], B[eb][1] - X[1]);
        var inA = ta > -snap / La && ta < 1 + snap / La, inB = tb > -snap / Lb && tb < 1 + snap / Lb;
        if (!inA || !inB) continue;
        if (distA <= snap && (distB <= snap || (tb > 0 && tb < 1))) A[ea] = X.slice();
        if (distB <= snap && (distA <= snap || (ta > 0 && ta < 1))) B[eb] = X.slice();
      }
    }
  }

  // помещения: заливка свободных клеток, ограниченных гранями и закрытыми проёмами
  function rooms(segs, openSegs, bb, o) {
    var area = (bb.u1 - bb.u0) * (bb.v1 - bb.v0), cell = Math.max(0.02, Math.sqrt(area / 12e6));
    var u0 = bb.u0 - 0.5, v0 = bb.v0 - 0.5, nx = Math.ceil((bb.u1 - bb.u0 + 1) / cell) + 1, ny = Math.ceil((bb.v1 - bb.v0 + 1) / cell) + 1;
    var wall = new Uint8Array(nx * ny);
    function rast(a, b) {
      var L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(L / (cell * 0.4)));
      for (var s = 0; s <= k; s++) {
        var x = Math.floor((a[0] + (b[0] - a[0]) * s / k - u0) / cell), y = Math.floor((a[1] + (b[1] - a[1]) * s / k - v0) / cell);
        if (x >= 0 && y >= 0 && x < nx && y < ny) wall[y * nx + x] = 1;
      }
    }
    segs.forEach(function (s) { rast(s.a, s.b); });
    openSegs.forEach(function (s) { rast(s.a, s.b); });
    var lab = new Int32Array(nx * ny), q = new Int32Array(nx * ny), id = 0, list = [];
    function fill(start, L) {
      var h = 0, t = 0, c = 0, sx = 0, sy = 0, edge = false, border = 0; q[t++] = start; lab[start] = L;
      while (h < t) {
        var k = q[h++], x = k % nx, y = (k - x) / nx; c++; sx += x; sy += y;
        if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) edge = true;
        var nb = [k - 1, k + 1, k - nx, k + nx];
        for (var z = 0; z < 4; z++) {
          var m = nb[z]; if (m < 0 || m >= nx * ny) continue;
          if ((z === 0 && x === 0) || (z === 1 && x === nx - 1)) continue;
          if (wall[m]) { border++; continue; }
          if (!lab[m]) { lab[m] = L; q[t++] = m; }
        }
      }
      return { cells: c, edge: edge, cx: sx / Math.max(1, c), cy: sy / Math.max(1, c), border: border };
    }
    for (var k = 0; k < nx * ny; k++) {
      if (wall[k] || lab[k]) continue;
      var r = fill(k, ++id);
      if (r.edge) continue;
      // площадь: свободные клетки + половина пограничных (линия грани проходит через середину своей клетки в среднем)
      var A = (r.cells + r.border * 0.5) * cell * cell;
      if (A < o.minRoom) continue;
      list.push({ id: id, area: A, center: [u0 + (r.cx + 0.5) * cell, v0 + (r.cy + 0.5) * cell] });
    }
    // размеры помещения вдоль главного направления
    list.forEach(function (rm) {
      var cs = Math.cos(o.mainPhi), sn = Math.sin(o.mainPhi), a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
        if (lab[y * nx + x] !== rm.id) continue;
        var U = u0 + (x + 0.5) * cell, V = v0 + (y + 0.5) * cell, X = U * cs + V * sn, Y = -U * sn + V * cs;
        if (X < a) a = X; if (X > c) c = X; if (Y < b) b = Y; if (Y > d) d = Y;
      }
      // стороны помещения — по ближайшим параллельным граням (клетки дают ступеньку в одну клетку)
      var lim = [a - cell / 2, c + cell / 2, b - cell / 2, d + cell / 2], best = [Infinity, Infinity, Infinity, Infinity], tol = cell * 2.5;
      o.segs.forEach(function (sg) {
        var mxs = (sg.a[0] + sg.b[0]) / 2, mys = (sg.a[1] + sg.b[1]) / 2, X = mxs * cs + mys * sn, Y = -mxs * sn + mys * cs;
        var ad = angDiff(sg.phi, o.mainPhi);
        if (ad < 3 * DEG) { [2, 3].forEach(function (q) { var dd = Math.abs(Y - lim[q]); if (dd < tol && dd < best[q]) { best[q] = dd; lim[q + 4] = Y; } }); }
        else if (Math.abs(ad - Math.PI / 2) < 3 * DEG) { [0, 1].forEach(function (q) { var dd = Math.abs(X - lim[q]); if (dd < tol && dd < best[q]) { best[q] = dd; lim[q + 4] = X; } }); }
      });
      var L0 = lim[4] != null ? lim[4] : lim[0], L1 = lim[5] != null ? lim[5] : lim[1], L2 = lim[6] != null ? lim[6] : lim[2], L3 = lim[7] != null ? lim[7] : lim[3];
      rm.size = [L1 - L0, L3 - L2];
    });
    list.sort(function (p, q2) { return q2.area - p.area; });
    list.forEach(function (rm, i) { rm.name = 'Пом. ' + (i + 1); });
    return list;
  }

  function extract(uv, opts) {
    opts = opts || {};
    var n = Math.floor((uv && uv.length || 0) / 2);
    if (n < 50) return { ok: false, message: 'в срезе слишком мало точек — выберите другую высоту или этаж' };
    var bb = bounds(uv, n), area = (bb.u1 - bb.u0) * (bb.v1 - bb.v0);
    var o = {
      cell: Math.max(Number(opts.cell) || 0.02, Math.sqrt(area / 25e6)),
      gap: opts.gap || 0.1, minLen: opts.minLen || 0.25, maxFace: opts.maxFace || 0.08,
      collinear: opts.collinear || 0.03, join: opts.join || 0.12, openMin: opts.openMin || 0.5, openMax: opts.openMax || 2.6,
      snap: opts.snap || 0.3, minRoom: opts.minRoom || 1.0
    };
    // клетка по плотности: в средней занятой клетке должно быть не меньше 3 точек (редкий срез — клетка крупнее, до 6 см)
    var G0 = grid(uv, n, o.cell, bb, 0);
    for (var tries = 0; tries < 4 && medianNZ(G0.cnt) < 3 && o.cell < 0.06; tries++) { o.cell = Math.min(0.06, o.cell * 1.5); G0 = grid(uv, n, o.cell, bb, 0); }
    o.thr = threshold(G0.cnt);
    G0 = null;
    var dirs = directions(uv, n, opts.ortho === true ? 1 : (opts.maxDirs || 6));
    if (opts.ortho === true) dirs = [dirs[0], (dirs[0] + Math.PI / 2) % Math.PI];
    var faces = [], openings = [], refined = [];
    dirs.forEach(function (phi) {
      var f = facesForDirection(uv, n, phi, o, bb);
      // уточнение направления: общий наклон точек всех граней этого направления (метод наименьших квадратов), два прохода
      for (var it = 0; it < 2 && f.length && Math.abs(f.slope) > 1e-6 && Math.abs(f.slope) < 0.02; it++) { phi += Math.atan(f.slope); f = facesForDirection(uv, n, phi, o, bb); }
      refined.push(phi);
      var m = mergeCollinear(f, o);
      faces = faces.concat(m.faces); openings = openings.concat(m.openings);
    });
    // грань, попавшая в два близких направления (пики в 1–3° друг от друга), остаётся одна — более длинная
    faces.sort(function (a, b) { return (b.x1 - b.x0) - (a.x1 - a.x0); });
    var segs = [];
    faces.forEach(function (f) {
      var s = faceSeg(f), mid = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
      var dup = segs.some(function (t) {
        if (angDiff(t.phi, f.phi) > 4 * DEG) return false;
        var d = [t.b[0] - t.a[0], t.b[1] - t.a[1]], L = Math.hypot(d[0], d[1]);
        var dist = Math.abs((mid[0] - t.a[0]) * d[1] - (mid[1] - t.a[1]) * d[0]) / L, tt = ((mid[0] - t.a[0]) * d[0] + (mid[1] - t.a[1]) * d[1]) / (L * L);
        return dist < 0.04 && tt > 0 && tt < 1;
      });
      if (!dup) segs.push({ a: s.a, b: s.b, phi: f.phi, y: f.y, n: f.n });
    });
    closeCorners(segs, o.snap);
    segs.forEach(function (s) { s.length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); });
    segs = segs.filter(function (s) { return s.length >= o.minLen; });
    var openSegs = openings.map(function (p) { return { a: toWorld(p.phi, p.x0, p.y), b: toWorld(p.phi, p.x1, p.y), width: p.width, phi: p.phi }; });
    // стены: пары параллельных граней 5–60 см с перекрытием
    var walls = [];
    for (var i = 0; i < segs.length; i++) for (var j = i + 1; j < segs.length; j++) {
      var A = segs[i], B = segs[j]; if (angDiff(A.phi, B.phi) > 2 * DEG) continue;
      var dA = [A.b[0] - A.a[0], A.b[1] - A.a[1]], L = A.length;
      var dist = Math.abs(((B.a[0] + B.b[0]) / 2 - A.a[0]) * dA[1] - ((B.a[1] + B.b[1]) / 2 - A.a[1]) * dA[0]) / L;
      if (dist < 0.05 || dist > 0.6) continue;
      var t0 = ((B.a[0] - A.a[0]) * dA[0] + (B.a[1] - A.a[1]) * dA[1]) / L, t1 = ((B.b[0] - A.a[0]) * dA[0] + (B.b[1] - A.a[1]) * dA[1]) / L;
      var ov = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (ov < 0.4 * Math.min(L, B.length)) continue;
      walls.push({ i: i, j: j, thickness: dist, overlap: ov });
    }
    // у каждой грани — одна (самая тонкая) стена
    walls.sort(function (p, q) { return p.thickness - q.thickness; });
    var used = {}; walls = walls.filter(function (w) { if (used[w.i] || used[w.j]) return false; used[w.i] = used[w.j] = 1; return true; });
    dirs = refined;
    var rms = opts.rooms === false ? [] : rooms(segs, openSegs, bb, { minRoom: o.minRoom, mainPhi: dirs[0], segs: segs });
    var total = segs.reduce(function (s, x) { return s + x.length; }, 0);
    return { ok: true, faces: segs, openings: openSegs, walls: walls, rooms: rms, directions: dirs.map(function (d) { return d / DEG; }), bbox: bb,
      stats: { points: n, cell: o.cell, threshold: o.thr, faces: segs.length, openings: openSegs.length, walls: walls.length, rooms: rms.length, faceLength: total } };
  }

  // ------------------------------------------------------------------ DXF R12
  function esc(s) {
    var out = '';
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out += c < 128 ? s.charAt(i) : '\\U+' + ('0000' + c.toString(16).toUpperCase()).slice(-4); }
    return out;
  }
  function num(v) { if (!isFinite(v)) v = 0; var s = (+v).toFixed(4); return s.replace(/0+$/, '').replace(/\.$/, '.0'); }
  function fmtLen(m, units) { return units === 'm' ? (Math.round(m * 1000) / 1000).toFixed(3).replace('.', ',') : String(Math.round(m * 1000)); }

  function toDXF(plan, o) {
    o = o || {};
    var units = o.units === 'm' ? 'm' : 'mm', k = units === 'mm' ? 1000 : 1;
    var ox = 0, oy = 0;
    if (o.origin === 'world' && o.world) { ox = o.world.cx || 0; oy = o.world.cy || 0; }
    else if (plan.bbox) { ox = -Math.floor(plan.bbox.u0); oy = -Math.floor(plan.bbox.v0); }   // местные: от угла плана, целые метры
    var P = function (p) { return [(p[0] + ox) * k, (p[1] + oy) * k]; };
    var ents = [], ext = { a: Infinity, b: Infinity, c: -Infinity, d: -Infinity };
    function grow(q) { if (q[0] < ext.a) ext.a = q[0]; if (q[0] > ext.c) ext.c = q[0]; if (q[1] < ext.b) ext.b = q[1]; if (q[1] > ext.d) ext.d = q[1]; }
    function line(layer, a, b, color) { var A = P(a), B = P(b); grow(A); grow(B); ents.push('0\nLINE\n8\n' + layer + '\n' + (color != null ? '62\n' + color + '\n' : '') + '10\n' + num(A[0]) + '\n20\n' + num(A[1]) + '\n30\n0.0\n11\n' + num(B[0]) + '\n21\n' + num(B[1]) + '\n31\n0.0\n'); }
    function text(layer, p, h, s, rot, center) {
      var A = P(p); grow(A);
      var t = '0\nTEXT\n8\n' + layer + '\n10\n' + num(A[0]) + '\n20\n' + num(A[1]) + '\n30\n0.0\n40\n' + num(h * k) + '\n1\n' + esc(s) + '\n';
      if (rot) t += '50\n' + num(rot) + '\n';
      if (center) t += '72\n1\n11\n' + num(A[0]) + '\n21\n' + num(A[1]) + '\n31\n0.0\n';
      ents.push(t);
    }
    function pline(layer, pts, closed) {
      var t = '0\nPOLYLINE\n8\n' + layer + '\n66\n1\n70\n' + (closed ? 1 : 0) + '\n';
      pts.forEach(function (p) { var A = P(p); grow(A); t += '0\nVERTEX\n8\n' + layer + '\n10\n' + num(A[0]) + '\n20\n' + num(A[1]) + '\n30\n0.0\n'; });
      ents.push(t + '0\nSEQEND\n8\n' + layer + '\n');
    }
    // размер: выносные линии, размерная линия с засечками 45°, текст над ней (длина в мм или м)
    function dim(a, b, off, label, th) {
      var d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(d[0], d[1]); if (L < 1e-6) return;
      var nrm = [-d[1] / L, d[0] / L], A2 = [a[0] + nrm[0] * off, a[1] + nrm[1] * off], B2 = [b[0] + nrm[0] * off, b[1] + nrm[1] * off];
      var ext1 = off > 0 ? 1 : -1;
      line('A-DIMS', [a[0] + nrm[0] * 0.05 * ext1, a[1] + nrm[1] * 0.05 * ext1], [A2[0] + nrm[0] * 0.08 * ext1, A2[1] + nrm[1] * 0.08 * ext1]);
      line('A-DIMS', [b[0] + nrm[0] * 0.05 * ext1, b[1] + nrm[1] * 0.05 * ext1], [B2[0] + nrm[0] * 0.08 * ext1, B2[1] + nrm[1] * 0.08 * ext1]);
      line('A-DIMS', A2, B2);
      var tk = 0.06, u = [d[0] / L, d[1] / L], s45 = [(u[0] + nrm[0]) * tk, (u[1] + nrm[1]) * tk];
      line('A-DIMS', [A2[0] - s45[0], A2[1] - s45[1]], [A2[0] + s45[0], A2[1] + s45[1]]);
      line('A-DIMS', [B2[0] - s45[0], B2[1] - s45[1]], [B2[0] + s45[0], B2[1] + s45[1]]);
      var ang = Math.atan2(d[1], d[0]) / DEG; if (ang > 90.01) ang -= 180; if (ang <= -90.01) ang += 180;
      var mid = [(A2[0] + B2[0]) / 2 + nrm[0] * 0.04 * (off >= 0 ? 1 : -1), (A2[1] + B2[1]) / 2 + nrm[1] * 0.04 * (off >= 0 ? 1 : -1)];
      text('A-DIMS', mid, th || 0.12, label, ang, true);
    }
    var faces = plan.faces || [];
    faces.forEach(function (s) { line('A-WALL', s.a, s.b); });
    (plan.openings || []).forEach(function (p) { line('A-OPEN', p.a, p.b); });
    // размеры граней — внутрь помещения (сторона, где ближе центр помещения), длинные грани
    var centers = (plan.rooms || []).map(function (r) { return r.center; });
    var midOf = function (s) { return [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]; };
    // у двух граней одной стены (перегородки) размеры расходятся наружу — иначе тексты ложатся друг на друга
    var partner = {};
    (plan.walls || []).forEach(function (w) { if (faces[w.i] && faces[w.j]) { partner[w.i] = faces[w.j]; partner[w.j] = faces[w.i]; } });
    var awayFrom = function (mid, nrm, other) { var m = midOf(other); return ((m[0] - mid[0]) * nrm[0] + (m[1] - mid[1]) * nrm[1]) >= 0 ? -1 : 1; };
    faces.forEach(function (s, fi) {
      if (s.length < (o.minDim || 0.4)) return;
      var d = [s.b[0] - s.a[0], s.b[1] - s.a[1]], L = s.length, nrm = [-d[1] / L, d[0] / L], mid = midOf(s);
      var side = 1;
      if (partner[fi]) side = awayFrom(mid, nrm, partner[fi]);
      else if (centers.length) {
        var best = Infinity; centers.forEach(function (c) { var dd = Math.hypot(c[0] - mid[0], c[1] - mid[1]); if (dd < best) { best = dd; side = ((c[0] - mid[0]) * nrm[0] + (c[1] - mid[1]) * nrm[1]) >= 0 ? 1 : -1; } });
      }
      dim(s.a, s.b, 0.35 * side, fmtLen(L, units));
    });
    var ops = plan.openings || [];
    ops.forEach(function (p, pi) {
      var d = [p.b[0] - p.a[0], p.b[1] - p.a[1]], L = Math.hypot(d[0], d[1]) || 1, nrm = [-d[1] / L, d[0] / L], mid = midOf(p), side = -1;
      // тот же проём, видимый с другой грани стены (дверь в перегородке), — размер по другую сторону
      ops.forEach(function (q, qi) {
        if (qi === pi) return; var m = midOf(q), dd = Math.hypot(m[0] - mid[0], m[1] - mid[1]);
        var dq = [q.b[0] - q.a[0], q.b[1] - q.a[1]], cr = Math.abs(d[0] * dq[1] - d[1] * dq[0]) / (L * (Math.hypot(dq[0], dq[1]) || 1));
        if (dd < 0.5 && cr < 0.05) side = awayFrom(mid, nrm, q);
      });
      dim(p.a, p.b, 0.25 * side, fmtLen(p.width, units), 0.1);
    });
    (plan.walls || []).forEach(function (w) {
      var A = faces[w.i], B = faces[w.j]; if (!A || !B) return;
      var m = [(A.a[0] + A.b[0] + B.a[0] + B.b[0]) / 4, (A.a[1] + A.b[1] + B.a[1] + B.b[1]) / 4];
      text('A-THK', m, 0.08, fmtLen(w.thickness, units), 0, true);
    });
    (plan.rooms || []).forEach(function (r) {
      text('A-ROOM', [r.center[0], r.center[1] + 0.2], 0.22, r.name, 0, true);
      text('A-ROOM', [r.center[0], r.center[1] - 0.15], 0.18, (Math.round(r.area * 10) / 10).toFixed(1).replace('.', ',') + ' м²', 0, true);
      if (r.size) text('A-ROOM', [r.center[0], r.center[1] - 0.45], 0.12, fmtLen(r.size[0], units) + ' x ' + fmtLen(r.size[1], units), 0, true);
    });
    // габаритные размеры (вдоль главного направления) — снаружи плана
    if (faces.length && plan.directions && plan.directions.length) {
      var phi = plan.directions[0] * DEG, cs = Math.cos(phi), sn = Math.sin(phi), xa = Infinity, ya = Infinity, xb = -Infinity, yb = -Infinity;
      faces.forEach(function (s) { [s.a, s.b].forEach(function (p) { var X = p[0] * cs + p[1] * sn, Y = -p[0] * sn + p[1] * cs; if (X < xa) xa = X; if (X > xb) xb = X; if (Y < ya) ya = Y; if (Y > yb) yb = Y; }); });
      dim(toWorld(phi, xa, ya), toWorld(phi, xb, ya), -1.0, fmtLen(xb - xa, units), 0.18);
      dim(toWorld(phi, xa, yb), toWorld(phi, xa, ya), -1.0, fmtLen(yb - ya, units), 0.18);
    }
    if (o.route && o.route.length >= 8) {
      var rp = []; for (var i = 0; i < o.route.length; i += 4) rp.push([o.route[i], o.route[i + 1]]);
      pline('A-ROUTE', rp, false);
    }
    if (ext.a < Infinity) {
      var tl = [(ext.a / k) - ox, (ext.b / k) - oy - 1.6];
      text('A-INFO', tl, 0.25, o.title || 'Обмерный план по облаку точек', 0, false);
      text('A-INFO', [tl[0], tl[1] - 0.4], 0.14, 'Единицы: ' + (units === 'mm' ? 'миллиметры' : 'метры') + '. ' + (o.subtitle || ''), 0, false);
    }
    var layers = [['0', 7], ['A-WALL', 7], ['A-OPEN', 3], ['A-DIMS', 2], ['A-THK', 8], ['A-ROOM', 4], ['A-ROUTE', 1], ['A-INFO', 7]];
    var h = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$DWGCODEPAGE\n3\nANSI_1251\n9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0\n9\n$EXTMIN\n10\n' + num(ext.a) + '\n20\n' + num(ext.b) + '\n30\n0.0\n9\n$EXTMAX\n10\n' + num(ext.c) + '\n20\n' + num(ext.d) + '\n30\n0.0\n9\n$LUNITS\n70\n2\n9\n$LUPREC\n70\n' + (units === 'mm' ? 0 : 3) + '\n0\nENDSEC\n';
    var t = '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLTYPE\n70\n1\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB\n0\nTABLE\n2\nLAYER\n70\n' + layers.length + '\n';
    layers.forEach(function (l) { t += '0\nLAYER\n2\n' + l[0] + '\n70\n0\n62\n' + l[1] + '\n6\nCONTINUOUS\n'; });
    t += '0\nENDTAB\n0\nTABLE\n2\nSTYLE\n70\n1\n0\nSTYLE\n2\nSTANDARD\n70\n0\n40\n0.0\n41\n1.0\n50\n0.0\n71\n0\n42\n2.5\n3\ntxt\n4\n\n0\nENDTAB\n0\nENDSEC\n';
    return h + t + '0\nSECTION\n2\nENTITIES\n' + ents.join('') + '0\nENDSEC\n0\nEOF\n';
  }

  return { extract: extract, toDXF: toDXF, directions: directions, angDiff: angDiff, _esc: esc };
});
