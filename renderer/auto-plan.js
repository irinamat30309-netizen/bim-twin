/*
 * auto-plan.js — автоматический обмерный план по облаку точек (ревизии 27–29).
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
 * Ревизия 29:
 *   - местный порог занятости по плиткам 1 м с гистерезисом (грань начинается выше порога, продолжается от трети порога) — стены дальних
 *     комнат, видимых через дверь, в десятки раз реже стен у маршрута сканера и не теряются;
 *   - прямая грани — по точкам (три прохода, полоса 3 → 1,5 см); стена под своим углом (доли градуса к остальным) ищется повторно
 *     в направлении своего угла и выходит одной гранью; столбик точек поперечной грани за щелью не удлиняет грань;
 *   - помещения замыкаются по масштабам (щели до ~2,8 м: недоснятые углы, торцы коридоров) и делятся водоразделом по расстоянию до стен;
 *     узкие полости (между гранями одной стены) не входят в площадь; коридоры — отдельный вид с отдельной нумерацией;
 *   - второй, верхний срез (opts.uvHigh, у потолка): грань без точек над собой — мебель или стеллаж, уходит из стен в plan.low
 *     (слой DXF A-FURN), откосы проёмов и торцы стен остаются.
 *
 *   AutoPlan.extract(uv, { uvHigh, scales, ... }) → { ok, faces, openings, walls, rooms, low, dims, frame, stats }
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

  // местный порог занятости (ревизия 29): у маршрута сканера и в дальних комнатах плотность точек различается в десятки раз, общий порог
  // теряет стены комнат, видимых только через дверь. Порог — по плиткам 1 м: 90-й процентиль занятых клеток плитки и соседних × 0,06,
  // не выше общего и не ниже 1 точки
  function localThr(G, o) {
    var tc = Math.max(4, Math.round((o.tile || 1.0) / G.cell)), tnx = Math.ceil(G.nx / tc), tny = Math.ceil(G.ny / tc), NT = tnx * tny;
    var cnt = G.cnt, nx = G.nx, ny = G.ny, x, y, t, tr, row, c;
    var colT = new Int32Array(nx); for (x = 0; x < nx; x++) colT[x] = Math.floor(x / tc);
    var num = new Int32Array(NT + 1);
    for (y = 0; y < ny; y++) { tr = Math.floor(y / tc) * tnx; row = y * nx; for (x = 0; x < nx; x++) if (cnt[row + x]) num[tr + colT[x] + 1]++; }
    for (t = 0; t < NT; t++) num[t + 1] += num[t];
    var vals = new Uint16Array(Math.max(1, num[NT])), pos = Int32Array.from(num.subarray(0, NT));
    for (y = 0; y < ny; y++) { tr = Math.floor(y / tc) * tnx; row = y * nx; for (x = 0; x < nx; x++) { c = cnt[row + x]; if (c) vals[pos[tr + colT[x]]++] = c; } }
    var p90 = new Float32Array(NT);
    for (t = 0; t < NT; t++) { var a = num[t], b = num[t + 1]; if (b > a) { var sub = vals.subarray(a, b); sub.sort(); p90[t] = sub[Math.min(b - a - 1, Math.floor((b - a) * 0.9))]; } }
    var T = new Uint16Array(NT), lo = o.minThr || 1;
    for (y = 0; y < tny; y++) for (x = 0; x < tnx; x++) {
      var best = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= tnx || Y >= tny) continue; if (p90[Y * tnx + X] > best) best = p90[Y * tnx + X]; }
      T[y * tnx + x] = Math.max(lo, Math.min(o.thr, Math.round(best * 0.06)));
    }
    return { tc: tc, tnx: tnx, T: T, colT: colT };
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
    var cell = o.cell, G = grid(uv, n, cell, bb, phi), nx = G.nx, ny = G.ny, cnt = G.cnt;
    var LT = o.localThr === false ? null : localThr(G, o), T = LT ? LT.T : null, colT = LT ? LT.colT : null, trow = 0, thr = o.thr, weak = o.weak || 0.34;
    var gapC = Math.max(1, Math.round(o.gap / cell)), minC = Math.max(2, Math.round(o.minLen / cell)), maxRows = Math.max(2, Math.round(o.maxFace / cell));
    var clusters = [], active = [];
    for (var y = 0; y < ny; y++) {
      var runs = [], x = 0, row = y * nx;
      if (LT) trow = Math.floor(y / LT.tc) * LT.tnx;
      var pe = -1;
      while (x < nx) {
        if (cnt[row + x] < (T ? T[trow + colT[x]] : thr)) { x++; continue; }
        var s = x, e = x, miss = 0; x++;
        if (T) {
          // ревизия 29: гистерезис — грань начинается с клетки выше местного порога, а продолжается по клеткам от трети порога
          // (редкая грань в 12 см от плотной: плитка берёт порог плотной). Начало догоняется назад по тем же клеткам
          while (x < nx) { if (cnt[row + x] >= Math.max(1, Math.round(T[trow + colT[x]] * weak))) { e = x; miss = 0; } else if (++miss > gapC) break; x++; }
          for (var xb = s - 1, mb = 0; xb > pe; xb--) { if (cnt[row + xb] >= Math.max(1, Math.round(T[trow + colT[xb]] * weak))) { s = xb; mb = 0; } else if (++mb > gapC) break; }
        } else {
          while (x < nx) { if (cnt[row + x] >= thr) { e = x; miss = 0; } else if (++miss > gapC) break; x++; }
        }
        pe = e;
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
    // «толстый» кластер (до 4 толщин грани) — стена со слипшимся предметом рядом: грань ищется по самой плотной полосе внутри
    clusters.forEach(function (c, ci) {
      if (c.rows > maxRows * 4) return;
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
    var slopes = [], tilted = [];
    var stepOf = function (sx) {
      // шаг точек вдоль грани (разности > 5 мм — точки одного «столбика» по высоте не считаются)
      var dd = [], stp = Math.max(1, Math.floor(sx.length / 4000));
      for (var k = stp; k < sx.length; k += stp) { var df = sx[k] - sx[k - stp]; if (df > 0.005 && df < 0.2) dd.push(df); }
      dd.sort(function (a, b) { return a - b; });
      return dd.length >= 8 ? dd[Math.floor(dd.length / 2)] : 0;
    };
    // конец грани: столбик точек соседней поперечной грани за щелью (торец стены другой комнаты в 10 см) — не продолжение грани
    var trimEnds = function (sx, step) {
      var m = sx.length, ia = 0, ib = m - 1, g = Math.max(0.06, 4 * (step || 0)), k;
      for (k = 1; k < m && sx[k - 1] - sx[0] < 0.04; k++) if (sx[k] - sx[k - 1] > g) ia = k;
      for (k = m - 2; k >= 0 && sx[m - 1] - sx[k + 1] < 0.04; k--) if (sx[k + 1] - sx[k] > g) ib = k;
      return ib - ia > 8 ? [ia, ib] : [0, m - 1];
    };
    good.forEach(function (ci) {
      var Ys = ys[ci], Xs = xs[ci], m0 = Ys.length, k, thick = clusters[ci].rows > maxRows; if (m0 < 8) return;
      var sy = Float64Array.from(Ys).sort(), sx = Float64Array.from(Xs).sort();
      var med = sy[Math.floor(m0 / 2)];
      if (thick) {
        // самая плотная полоса 1 см
        var hb = {}, bestB = 0, bestN = 0; for (k = 0; k < m0; k++) { var bk = Math.floor(Ys[k] / 0.01); hb[bk] = (hb[bk] || 0) + 1; }
        Object.keys(hb).forEach(function (key) { var c3 = hb[key] + (hb[+key - 1] || 0) + (hb[+key + 1] || 0); if (c3 > bestN) { bestN = c3; bestB = +key; } });
        med = (bestB + 0.5) * 0.01;
      }
      // прямая по точкам грани (ревизия 29): полоса 3 → 1,5 см, три прохода. Стена может отклоняться от общего направления на доли
      // градуса — такая грань строится по своему углу (иначе её строки расходятся и грань теряется)
      var la = med, lb = 0, xm = sx[Math.floor(m0 / 2)], vxN = 0;
      for (var it = 0; it < 3; it++) {
        var band = it ? 0.015 : 0.03, S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
        for (k = 0; k < m0; k++) { var dx = Xs[k] - xm, r0 = Ys[k] - la - lb * dx; if (r0 > band || r0 < -band) continue; S0++; S1 += dx; S2 += Ys[k]; S3 += dx * dx; S4 += dx * Ys[k]; }
        if (S0 < 8) break;
        var mdx = S1 / S0, vx = S3 / S0 - mdx * mdx;
        lb = vx > 1e-6 ? Math.max(-0.05, Math.min(0.05, (S4 / S0 - mdx * (S2 / S0)) / vx)) : 0;
        la = S2 / S0 - lb * mdx; vxN = vx * S0;
      }
      var nin = 0;
      for (k = 0; k < m0; k++) { var r1 = Ys[k] - la - lb * (Xs[k] - xm); if (r1 <= 0.015 && r1 >= -0.015) nin++; }
      // точки не ложатся на прямую (полоса пересекает чужие грани под углом, мебель, люди) — не грань
      if (o.inlier !== false && nin < (thick ? 0.5 : (o.inlier || 0.7)) * m0) return;
      if (thick) {
        // дальше — только точки полосы (предмет рядом не удлиняет и не сдвигает грань)
        var Xi = [], Yi = [];
        for (k = 0; k < m0; k++) { var r3 = Ys[k] - la - lb * (Xs[k] - xm); if (r3 <= 0.015 && r3 >= -0.015) { Xi.push(Xs[k]); Yi.push(Ys[k]); } }
        Xs = Xi; Ys = Yi; m0 = Xs.length; sy = Float64Array.from(Ys).sort(); sx = Float64Array.from(Xs).sort(); med = la + lb * (sx[Math.floor(m0 / 2)] - xm);
      }
      if (vxN > 0 && sx[m0 - 1] - sx[0] >= o.minLen) slopes.push([lb, vxN]);
      // заметный наклон: за длину грани уход больше 2,5 см (меньший — соосные куски сливаются как раньше, проёмы между ними сохраняются)
      if (Math.abs(lb) * (sx[m0 - 1] - sx[0]) > (o.tiltDrift || 0.025)) {
        if (sx[m0 - 1] - sx[0] < o.minLen) return;
        var ang = Math.atan(lb), c2 = Math.cos(ang), s2 = Math.sin(ang), XX = [], YY = 0;
        for (k = 0; k < m0; k++) { var r2 = Ys[k] - la - lb * (Xs[k] - xm); if (r2 > 0.015 || r2 < -0.015) continue; XX.push(Xs[k] * c2 + Ys[k] * s2); YY += -Xs[k] * s2 + Ys[k] * c2; }
        var sxx2 = Float64Array.from(XX).sort(), kq2 = Math.min(2, Math.floor(sxx2.length * 0.005)), e2 = trimEnds(sxx2, stepOf(sxx2));
        var xa2 = sxx2[e2[0] + kq2], xb2 = sxx2[e2[1] - kq2];
        if (xb2 - xa2 >= o.minLen) tilted.push({ phi: phi + ang, y: YY / XX.length, x0: xa2, x1: xb2, n: XX.length, spread: 0, step: stepOf(sxx2), tilt: ang });
        return;
      }
      // уточнение: среднее точек в ±1,5 см от медианы (шум сканера симметричен)
      var s1 = 0, m1 = 0; for (k = 0; k < m0; k++) if (Math.abs(Ys[k] - med) <= 0.015) { s1 += Ys[k]; m1++; }
      var yv = m1 ? s1 / m1 : med;
      // концы: третья точка от края (не доля длины — иначе у длинной грани срезаются сантиметры)
      var kq = Math.min(2, Math.floor(sx.length * 0.005)), e1 = trimEnds(sx, stepOf(sx));
      var xa = sx[e1[0] + kq], xb = sx[e1[1] - kq];
      if (xb - xa < o.minLen) return;
      var spread = sy[Math.floor(sy.length * 0.9)] - sy[Math.floor(sy.length * 0.1)];
      out.push({ phi: phi, y: yv, x0: xa, x1: xb, n: m0, spread: spread, step: stepOf(sx) });
    });
    out.tilted = tilted;
    // общий наклон граней направления (для уточнения угла): взвешенная медиана, затем среднее в ±0,1° от неё — отдельные
    // непараллельные стены не сбивают направление остальных
    out.slope = 0;
    if (slopes.length) {
      slopes.sort(function (a, b) { return a[0] - b[0]; });
      var W = 0, acc = 0, wm = slopes[0][0], j; for (j = 0; j < slopes.length; j++) W += slopes[j][1];
      for (j = 0; j < slopes.length; j++) { acc += slopes[j][1]; if (acc >= W / 2) { wm = slopes[j][0]; break; } }
      var sw = 0, sl = 0; for (j = 0; j < slopes.length; j++) if (Math.abs(slopes[j][0] - wm) <= 0.0017) { sw += slopes[j][1]; sl += slopes[j][0] * slopes[j][1]; }
      out.slope = sw > 0 ? sl / sw : wm;
    }
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
        // редкая грань: концы — третья точка от края, щель между кусками растёт на шаги точек
        if (cur && f.x0 - cur.x1 <= o.join + 2 * Math.min(0.05, (cur.step || 0) + (f.step || 0))) { cur.x1 = Math.max(cur.x1, f.x1); cur.y = (cur.y * cur.n + f.y * f.n) / (cur.n + f.n); cur.step = Math.max(cur.step || 0, f.step || 0); cur.n += f.n; return; }
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
    var i, j, best = {};
    var cand = function (k, e, X, sc) { var key = k + e; if (!best[key] || sc < best[key].s) best[key] = { i: k, e: e, X: X.slice(), s: sc }; };
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
        var dB = tb > 0 && tb < 1 ? 0 : distB, dA = ta > 0 && ta < 1 ? 0 : distA;
        if (distA <= snap && (distB <= snap || dB === 0)) cand(i, ea, X, distA + dB);
        if (distB <= snap && (distA <= snap || dA === 0)) cand(j, eb, X, distB + dA);
      }
    }
    // ревизия 29: у конца — ближайший угол (сумма расстояний от концов обеих граней), а не последний найденный: иначе конец
    // уходит к соседней стене за толщиной (две грани одной стены рядом)
    Object.keys(best).forEach(function (key) { var b = best[key]; segs[b.i][b.e] = b.X; });
  }

  // Точное евклидово расстояние до стен (Felzenszwalb–Huttenlocher, два прохода), в клетках
  function edt(wall, nx, ny) {
    var N = nx * ny, D = new Float32Array(N), INF = 1e20, m = Math.max(nx, ny);
    var f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1), x, y, k, q;
    function pass(len) {
      k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (q = 1; q < len; q++) {
        var sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (sv <= z[k]) { k--; sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = sv; z[k + 1] = INF;
      }
      k = 0;
      for (q = 0; q < len; q++) { while (z[k + 1] < q) k++; var dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
    }
    for (x = 0; x < nx; x++) { for (y = 0; y < ny; y++) f[y] = wall[y * nx + x] ? 0 : INF; pass(ny); for (y = 0; y < ny; y++) D[y * nx + x] = d[y]; }
    for (y = 0; y < ny; y++) { var row = y * nx; for (x = 0; x < nx; x++) f[x] = D[row + x]; pass(nx); for (x = 0; x < nx; x++) D[row + x] = Math.sqrt(Math.min(d[x], 1e12)); }
    return D;
  }

  // Помещения (ревизия 29). Стены и закрытые проёмы — на сетку, расстояние до ближайшей стены D. Щели между гранями (недоснятые куски
  // стен, двери без найденного проёма, торцы коридоров) закрываются по масштабам r = 0; 0,2; 0,4; 0,7; 1,0; 1,4 м: область D > r, не
  // касающаяся края сетки и не содержащая ядер прежних масштабов, — ядро нового помещения. Затем «заливка по убыванию D» (водораздел) от
  // ядер помещений и внешнего ядра: щель делится по самому узкому месту. Площадь — клетки + половина пограничных со стеной.
  function rooms(segs, openSegs, bb, o) {
    if (!segs.length) return [];
    var scales = (o.scales || [0, 0.2, 0.4, 0.7, 1.0, 1.4]).slice().sort(function (p, q2) { return p - q2; }), rMax = scales[scales.length - 1];
    var M = rMax + 0.6, W0 = bb.u1 - bb.u0 + 2 * M, H0 = bb.v1 - bb.v0 + 2 * M, cell = Math.max(0.02, Math.sqrt(W0 * H0 / (o.maxCells || 12e6)));
    var u0 = bb.u0 - M, v0 = bb.v0 - M, nx = Math.ceil(W0 / cell) + 1, ny = Math.ceil(H0 / cell) + 1, N = nx * ny;
    var wall = new Uint8Array(N);
    function rast(a, b) {
      var L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(L / (cell * 0.4)));
      for (var s = 0; s <= k; s++) {
        var x = Math.floor((a[0] + (b[0] - a[0]) * s / k - u0) / cell), y = Math.floor((a[1] + (b[1] - a[1]) * s / k - v0) / cell);
        if (x >= 0 && y >= 0 && x < nx && y < ny) wall[y * nx + x] = 1;
      }
    }
    segs.forEach(function (s) { rast(s.a, s.b); });
    openSegs.forEach(function (s) { rast(s.a, s.b); });
    var D = edt(wall, nx, ny);
    var lab = new Int32Array(N), mark = new Int32Array(N), q = new Int32Array(N), seeds = [], OUT = -1, k, i;
    // ядра по масштабам
    for (var si = 0; si < scales.length; si++) {
      var rc = scales[si] / cell, stamp = si + 1, last = si === scales.length - 1;
      for (k = 0; k < N; k++) {
        if (wall[k] || mark[k] === stamp || !(D[k] > rc)) continue;
        var h = 0, t = 0, edge = false, prior = false, x, y; q[t++] = k; mark[k] = stamp;
        while (h < t) {
          var c = q[h++]; x = c % nx; y = (c - x) / nx;
          if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) edge = true;
          if (lab[c] !== 0) prior = true;
          if (x > 0) { var m1 = c - 1; if (!wall[m1] && mark[m1] !== stamp && D[m1] > rc) { mark[m1] = stamp; q[t++] = m1; } }
          if (x < nx - 1) { var m2 = c + 1; if (!wall[m2] && mark[m2] !== stamp && D[m2] > rc) { mark[m2] = stamp; q[t++] = m2; } }
          if (y > 0) { var m3 = c - nx; if (!wall[m3] && mark[m3] !== stamp && D[m3] > rc) { mark[m3] = stamp; q[t++] = m3; } }
          if (y < ny - 1) { var m4 = c + nx; if (!wall[m4] && mark[m4] !== stamp && D[m4] > rc) { mark[m4] = stamp; q[t++] = m4; } }
        }
        if (edge) { if (last) for (i = 0; i < t; i++) if (!lab[q[i]]) lab[q[i]] = OUT; continue; }
        if (prior) continue;
        var id = seeds.length + 1; seeds.push({ id: id, scale: scales[si] });
        for (i = 0; i < t; i++) lab[q[i]] = id;
      }
    }
    mark = null;
    if (!seeds.length) return [];
    // водораздел: очередь по уровням D (целые клетки), внутри уровня — по порядку поступления
    var maxL = 0; for (k = 0; k < N; k++) if (!wall[k] && D[k] > maxL) maxL = D[k];
    var NL = Math.floor(maxL) + 1, head = new Int32Array(NL).fill(-1), tail = new Int32Array(NL).fill(-1), next = q; q = null;
    var push = function (c, lv) { next[c] = -1; if (tail[lv] < 0) head[lv] = c; else next[tail[lv]] = c; tail[lv] = c; };
    for (k = 0; k < N; k++) if (lab[k] !== 0) push(k, Math.floor(D[k]));
    for (var lv = NL - 1; lv >= 0;) {
      var c2 = head[lv]; if (c2 < 0) { lv--; continue; }
      head[lv] = next[c2]; if (head[lv] < 0) tail[lv] = -1;
      var L2 = lab[c2], x2 = c2 % nx, nbs = [x2 > 0 ? c2 - 1 : -1, x2 < nx - 1 ? c2 + 1 : -1, c2 >= nx ? c2 - nx : -1, c2 + nx < N ? c2 + nx : -1];
      for (var z = 0; z < 4; z++) {
        var mm = nbs[z]; if (mm < 0 || wall[mm] || lab[mm] !== 0) continue;
        lab[mm] = L2; var pl = Math.floor(D[mm]); push(mm, pl < lv ? pl : lv);
      }
    }
    next = null;
    // ревизия 29: узкие полости (между двумя гранями одной стены, щели за мебелью) уже 2·r0 — не площадь помещения, хотя заливка
    // в них заходит. Морфологическое открытие диском r0: клетка в помещении, если до области D ≥ r0 не дальше r0
    var r0 = (o.minGap != null ? o.minGap : 0.15) / cell, thin = null;
    if (r0 > 0.5) {
      var core = new Uint8Array(N); for (k = 0; k < N; k++) core[k] = !wall[k] && D[k] >= r0 ? 1 : 0;
      var E = edt(core, nx, ny); core = null; thin = new Uint8Array(N);
      for (k = 0; k < N; k++) if (lab[k] > 0 && E[k] > r0 + 0.5) thin[k] = 1;
      E = null;
    }
    // один проход: клетки, пограничные со стеной, центр (самая удалённая от стен клетка), габарит вдоль главного направления
    var S = seeds.length + 1, cnt = new Float64Array(S), brd = new Float64Array(S), sumD = new Float64Array(S), best = new Float32Array(S), bestK = new Int32Array(S).fill(-1);
    var cs = Math.cos(o.mainPhi), sn = Math.sin(o.mainPhi), ex = [new Float64Array(S).fill(Infinity), new Float64Array(S).fill(-Infinity), new Float64Array(S).fill(Infinity), new Float64Array(S).fill(-Infinity)];
    var adj = {};
    for (var yy = 0; yy < ny; yy++) {
      var Vc = v0 + (yy + 0.5) * cell;
      for (var xx = 0; xx < nx; xx++) {
        k = yy * nx + xx; var L = lab[k]; if (L <= 0) continue;
        if (!thin || !thin[k]) {
          cnt[L]++; sumD[L] += D[k];
          if (xx > 0 && wall[k - 1]) brd[L]++; if (xx < nx - 1 && wall[k + 1]) brd[L]++; if (yy > 0 && wall[k - nx]) brd[L]++; if (yy < ny - 1 && wall[k + nx]) brd[L]++;
        }
        if (D[k] > best[L]) { best[L] = D[k]; bestK[L] = k; }
        var Uc = u0 + (xx + 0.5) * cell, X = Uc * cs + Vc * sn, Y = -Uc * sn + Vc * cs;
        if (X < ex[0][L]) ex[0][L] = X; if (X > ex[1][L]) ex[1][L] = X; if (Y < ex[2][L]) ex[2][L] = Y; if (Y > ex[3][L]) ex[3][L] = Y;
        // условные границы между помещениями (щель без стены): соседние клетки разных помещений
        if (xx < nx - 1) { var R = lab[k + 1]; if (R !== L && R !== 0) { var key = L < R ? L + ':' + R : R + ':' + L; adj[key] = (adj[key] || 0) + 1; } }
        if (yy < ny - 1) { var B = lab[k + nx]; if (B !== L && B !== 0) { var key2 = L < B ? L + ':' + B : B + ':' + L; adj[key2] = (adj[key2] || 0) + 1; } }
      }
    }
    var minW = o.minWidth || 0.6, list = [];
    seeds.forEach(function (sd) {
      var L = sd.id; if (!cnt[L] || bestK[L] < 0) return;
      var A = (cnt[L] + brd[L] * 0.5) * cell * cell, width = 2 * best[L] * cell;
      if (A < o.minRoom || width < minW) return;
      var kx = bestK[L] % nx, ky = (bestK[L] - kx) / nx;
      // ширина «по средней удалённости от стен»: у полосы ширины w средняя удалённость w/4 (у квадрата — сторона/6)
      var rm = { id: L, area: A, center: [u0 + (kx + 0.5) * cell, v0 + (ky + 0.5) * cell], width: width, typWidth: 4 * sumD[L] / cnt[L] * cell, scale: sd.scale, links: 0, outside: false };
      // стороны помещения — по ближайшим параллельным граням (клетки дают ступеньку в одну клетку)
      var lim = [ex[0][L] - cell / 2, ex[1][L] + cell / 2, ex[2][L] - cell / 2, ex[3][L] + cell / 2], bd = [Infinity, Infinity, Infinity, Infinity], tol = cell * 2.5;
      o.segs.forEach(function (sg) {
        var mxs = (sg.a[0] + sg.b[0]) / 2, mys = (sg.a[1] + sg.b[1]) / 2, X = mxs * cs + mys * sn, Y = -mxs * sn + mys * cs;
        var ad = angDiff(sg.phi, o.mainPhi);
        if (ad < 3 * DEG) { [2, 3].forEach(function (qq) { var dd = Math.abs(Y - lim[qq]); if (dd < tol && dd < bd[qq]) { bd[qq] = dd; lim[qq + 4] = Y; } }); }
        else if (Math.abs(ad - Math.PI / 2) < 3 * DEG) { [0, 1].forEach(function (qq) { var dd = Math.abs(X - lim[qq]); if (dd < tol && dd < bd[qq]) { bd[qq] = dd; lim[qq + 4] = X; } }); }
      });
      var L0 = lim[4] != null ? lim[4] : lim[0], L1 = lim[5] != null ? lim[5] : lim[1], L2 = lim[6] != null ? lim[6] : lim[2], L3 = lim[7] != null ? lim[7] : lim[3];
      rm.size = [L1 - L0, L3 - L2];
      list.push(rm);
    });
    // связи: условные границы длиной от 0,4 м (между помещениями и с наружной областью)
    var byId = {}; list.forEach(function (r) { byId[r.id] = r; });
    Object.keys(adj).forEach(function (key) {
      var pr = key.split(':'), a1 = +pr[0], b1 = +pr[1], len = adj[key] * cell; if (len < 0.4) return;
      if (a1 === OUT || b1 === OUT) { var r0 = byId[a1 === OUT ? b1 : a1]; if (r0) r0.outside = true; return; }
      if (byId[a1]) byId[a1].links++; if (byId[b1]) byId[b1].links++;
    });
    // коридор: узкое (типичная ширина 0,9–4 м) и вытянутое помещение (площадь ≥ 4 ширины², не меньше 6 м²)
    list.forEach(function (r) { var w = r.typWidth; r.kind = w >= 0.9 && w <= (o.corridorWidth || 4.0) && r.area >= 6 && r.area >= 4 * w * w ? 'corridor' : 'room'; });
    list.sort(function (p, q2) { return q2.area - p.area; });
    var nr = 0, nc = 0;
    list.forEach(function (rm) { rm.name = rm.kind === 'corridor' ? 'Коридор ' + (++nc) : 'Пом. ' + (++nr); });
    if (o.debug) o.debug.grid = { lab: lab, nx: nx, ny: ny, u0: u0, v0: v0, cell: cell };
    return list;
  }

  // Доля длины каждой грани, у которой во втором (верхнем) срезе есть точки в ±6 см от линии. Срез ненадёжен (мало точек на длинных
  // гранях: высота выбрана выше потолка, срез пуст) — проверка не применяется
  function lowCover(segs, uvH, bb, o) {
    var nH = uvH.length >> 1, pad = 0.5, W0 = bb.u1 - bb.u0 + 2 * pad, H0 = bb.v1 - bb.v0 + 2 * pad;
    var cell = Math.max(0.03, Math.sqrt(W0 * H0 / 40e6)), x0 = bb.u0 - pad, y0 = bb.v0 - pad, nx = Math.ceil(W0 / cell) + 1, ny = Math.ceil(H0 / cell) + 1;
    var occ = new Uint8Array(nx * ny), i;
    for (i = 0; i < nH; i++) { var gx = Math.floor((uvH[i * 2] - x0) / cell), gy = Math.floor((uvH[i * 2 + 1] - y0) / cell); if (gx >= 0 && gy >= 0 && gx < nx && gy < ny) occ[gy * nx + gx] = 1; }
    var tol = Math.max(1, Math.round((o.lowTol || 0.06) / cell));
    var hitAt = function (px, py) {
      var cx = Math.floor((px - x0) / cell), cy = Math.floor((py - y0) / cell);
      for (var dy = -tol; dy <= tol; dy++) { var yy = cy + dy; if (yy < 0 || yy >= ny) continue; for (var dx = -tol; dx <= tol; dx++) { var xx = cx + dx; if (xx >= 0 && xx < nx && occ[yy * nx + xx]) return true; } }
      return false;
    };
    var cov = segs.map(function (sg) {
      var L = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]), nb = Math.max(1, Math.round(L / 0.1)), hit = 0;
      for (var b = 0; b < nb; b++) {
        for (var t = 0; t < 3; t++) { var f = (b + (t + 0.5) / 3) / nb; if (hitAt(sg.a[0] + (sg.b[0] - sg.a[0]) * f, sg.a[1] + (sg.b[1] - sg.a[1]) * f)) { hit++; break; } }
      }
      return hit / nb;
    });
    var longC = []; segs.forEach(function (sg, j) { if (Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) >= 2) longC.push(cov[j]); });
    longC.sort(function (p, q2) { return p - q2; });
    var med = longC.length ? longC[Math.floor(longC.length / 2)] : 0;
    return { cov: cov, median: med, ok: longC.length >= 3 && med >= 0.5 };
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
      snap: opts.snap || 0.3, minRoom: opts.minRoom || 1.0,
      localThr: opts.localThr, tile: opts.tile, minThr: opts.minThr, inlier: opts.inlier, tiltDrift: opts.tiltDrift, weak: opts.weak
    };
    // клетка по плотности: в средней занятой клетке должно быть не меньше 3 точек (редкий срез — клетка крупнее, до 6 см)
    var G0 = grid(uv, n, o.cell, bb, 0);
    for (var tries = 0; tries < 4 && medianNZ(G0.cnt) < 3 && o.cell < 0.06; tries++) { o.cell = Math.min(0.06, o.cell * 1.5); G0 = grid(uv, n, o.cell, bb, 0); }
    o.thr = threshold(G0.cnt);
    G0 = null;
    var dirs = directions(uv, n, opts.ortho === true ? 1 : (opts.maxDirs || 6));
    if (opts.ortho === true) dirs = [dirs[0], (dirs[0] + Math.PI / 2) % Math.PI];
    var faces = [], openings = [], refined = [], tiltAll = [];
    dirs.forEach(function (phi) {
      var f = facesForDirection(uv, n, phi, o, bb);
      // уточнение направления: общий наклон точек всех граней этого направления (метод наименьших квадратов), два прохода
      for (var it = 0; it < 2 && (f.length || f.tilted.length) && Math.abs(f.slope) > 1e-6 && Math.abs(f.slope) < 0.02; it++) { phi += Math.atan(f.slope); f = facesForDirection(uv, n, phi, o, bb); }
      refined.push(phi);
      var m = mergeCollinear(f, o);
      faces = faces.concat(m.faces); openings = openings.concat(m.openings); tiltAll = tiltAll.concat(f.tilted);
    });
    // ревизия 29: стена под своим углом (доли градуса к общему направлению) в общей сетке распадается на куски-ступеньки.
    // Повторный поиск в направлении её угла находит её целиком; куски заменяются найденной гранью (и проёмами на её линии)
    var tg = [];
    tiltAll.forEach(function (t) {
      var g = null; for (var q = 0; q < tg.length && !g; q++) if (angDiff(tg[q].phi, t.phi) < 0.15 * DEG) g = tg[q];
      if (!g) { g = { phi: t.phi, w: 0, items: [] }; tg.push(g); }
      g.items.push(t); g.phi = (g.phi * g.w + t.phi * t.n) / (g.w + t.n); g.w += t.n;
    });
    tg.sort(function (p, q) { return q.w - p.w; });
    tg.slice(0, opts.maxTilt || 8).forEach(function (g) {
      var cs = Math.cos(g.phi), sn = Math.sin(g.phi), used = [];
      var inFrame = function (t) { var sg = faceSeg(t); return [sg.a[0] * cs + sg.a[1] * sn, -sg.a[0] * sn + sg.a[1] * cs, sg.b[0] * cs + sg.b[1] * sn, -sg.b[0] * sn + sg.b[1] * cs]; };
      // только точки у линий кусков (±0,2 м поперёк, 1,5 м за концами) — повторный поиск быстрый и на облаке в миллионы точек
      var box = g.items.map(function (t) { var q = inFrame(t); return [Math.min(q[0], q[2]) - 1.5, Math.max(q[0], q[2]) + 1.5, (q[1] + q[3]) / 2 - 0.2, (q[1] + q[3]) / 2 + 0.2]; });
      var sub = [], bu0 = Infinity, bu1 = -Infinity, bv0 = Infinity, bv1 = -Infinity;
      for (var pi = 0; pi < n; pi++) {
        var pu = uv[pi * 2], pv = uv[pi * 2 + 1], PX = pu * cs + pv * sn, PY = -pu * sn + pv * cs;
        for (var bi = 0; bi < box.length; bi++) {
          var bx = box[bi]; if (PX < bx[0] || PX > bx[1] || PY < bx[2] || PY > bx[3]) continue;
          sub.push(pu, pv); if (pu < bu0) bu0 = pu; if (pu > bu1) bu1 = pu; if (pv < bv0) bv0 = pv; if (pv > bv1) bv1 = pv; break;
        }
      }
      if (sub.length < 100) return;
      sub = Float64Array.from(sub);
      var f2 = facesForDirection(sub, sub.length >> 1, g.phi, o, { u0: bu0 - 0.1, u1: bu1 + 0.1, v0: bv0 - 0.1, v1: bv1 + 0.1 }), m2 = mergeCollinear(f2, o);
      var lines = [];
      m2.faces.forEach(function (F) {
        var hit = g.items.filter(function (t) {
          if (used.indexOf(t) >= 0) return false;
          var q = inFrame(t), lo = Math.min(q[0], q[2]), hi = Math.max(q[0], q[2]);
          return Math.abs(q[1] - F.y) < 0.03 && Math.abs(q[3] - F.y) < 0.03 && hi > F.x0 - 0.05 && lo < F.x1 + 0.05;
        });
        if (!hit.length) return;
        used = used.concat(hit); faces.push(F); lines.push(F.y);
      });
      // соседние куски той же линии (между ними проём) — тоже из повторного поиска
      m2.faces.forEach(function (F) { if (faces.indexOf(F) < 0 && lines.some(function (y) { return Math.abs(y - F.y) <= o.collinear; })) faces.push(F); });
      m2.openings.forEach(function (op) { if (lines.some(function (y) { return Math.abs(y - op.y) <= o.collinear; })) openings.push(op); });
      g.items = g.items.filter(function (t) { return used.indexOf(t) < 0; });
    });
    tg.forEach(function (g) { faces = faces.concat(g.items); });
    // грань, попавшая в два близких направления (пики в 1–3° друг от друга), остаётся одна — более длинная
    faces.sort(function (a, b) { return (b.x1 - b.x0) - (a.x1 - a.x0); });
    var segs = [];
    faces.forEach(function (f) {
      var s = faceSeg(f), mid = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
      var dup = segs.some(function (t) {
        var ad = angDiff(t.phi, f.phi); if (ad > 4 * DEG) return false;
        var d = [t.b[0] - t.a[0], t.b[1] - t.a[1]], L = Math.hypot(d[0], d[1]), u = [d[0] / L, d[1] / L];
        var dist = Math.abs((mid[0] - t.a[0]) * d[1] - (mid[1] - t.a[1]) * d[0]) / L, tt = ((mid[0] - t.a[0]) * d[0] + (mid[1] - t.a[1]) * d[1]) / (L * L);
        var inside = dist < 0.04 && tt > 0 && tt < 1;
        // ревизия 29: соосный кусок той же стены (наклонные куски, соседние направления) — продолжает более длинную грань
        if (ad > 1.5 * DEG) return inside;
        var pa = (s.a[0] - t.a[0]) * u[0] + (s.a[1] - t.a[1]) * u[1], pb = (s.b[0] - t.a[0]) * u[0] + (s.b[1] - t.a[1]) * u[1];
        var qa = Math.abs((s.a[0] - t.a[0]) * u[1] - (s.a[1] - t.a[1]) * u[0]), qb = Math.abs((s.b[0] - t.a[0]) * u[1] - (s.b[1] - t.a[1]) * u[0]);
        var lo = Math.min(pa, pb), hi = Math.max(pa, pb), lim = inside ? 0.04 : 0.03;
        if (qa > lim || qb > lim || lo > L + o.join || hi < -o.join) return inside;
        var A0 = t.a.slice();
        if (lo < -0.05) t.a = [A0[0] + u[0] * lo, A0[1] + u[1] * lo];
        if (hi > L + 0.05) t.b = [A0[0] + u[0] * hi, A0[1] + u[1] * hi];
        return true;
      });
      if (!dup) segs.push({ a: s.a, b: s.b, phi: f.phi, y: f.y, n: f.n });
    });
    closeCorners(segs, o.snap);
    segs.forEach(function (s) { s.length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); });
    segs = segs.filter(function (s) { return s.length >= o.minLen; });
    // мусор реальных сканов: короткие (< 0,8 м) грани, рядом с концами которых нет других граней (мебель, люди, предметы в срезе)
    var clutter = 0;
    if (opts.clutter !== false && segs.length > 8) {
      var near = function (p, t) { var dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1], L2 = dx * dx + dy * dy || 1, k = Math.max(0, Math.min(1, ((p[0] - t.a[0]) * dx + (p[1] - t.a[1]) * dy) / L2)); return Math.hypot(p[0] - t.a[0] - k * dx, p[1] - t.a[1] - k * dy); };
      var keep = segs.filter(function (sg) {
        if (sg.length >= (opts.clutterLen || 0.8)) return true;
        return segs.some(function (t) { return t !== sg && (near(sg.a, t) < 0.3 || near(sg.b, t) < 0.3 || near(t.a, sg) < 0.3 || near(t.b, sg) < 0.3); });
      });
      clutter = segs.length - keep.length; segs = keep;
    }
    var openSegs = openings.map(function (p) { return { a: toWorld(p.phi, p.x0, p.y), b: toWorld(p.phi, p.x1, p.y), width: p.width, phi: p.phi }; });
    // ревизия 29: мебель и стеллажи у стен — грань в срезе есть, а у потолка (второй срез opts.uvHigh) точек на её линии нет
    var low = [], lowInfo = null;
    if (opts.uvHigh && opts.uvHigh.length >= 400 && opts.lowFilter !== false && segs.length) {
      var LH = lowCover(segs, opts.uvHigh, bb, o);
      lowInfo = { checked: LH.ok, median: LH.median, points: opts.uvHigh.length >> 1 };
      if (LH.ok) {
        var tall = [], cand = [], dEnd = function (p, t) { var dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1], L2 = dx * dx + dy * dy || 1, k = Math.max(0, Math.min(1, ((p[0] - t.a[0]) * dx + (p[1] - t.a[1]) * dy) / L2)); return Math.hypot(p[0] - t.a[0] - k * dx, p[1] - t.a[1] - k * dy); };
        segs.forEach(function (sg, i) { sg.cover = LH.cov[i]; (LH.cov[i] < (opts.lowCover || 0.35) ? cand : tall).push(sg); });
        // откос проёма и торец стены (короткая грань поперёк высокой, от её конца): над дверью откоса нет, но это часть стены
        cand.forEach(function (sg) {
          var touch = function (p) { return tall.some(function (t) { return dEnd(p, t) < 0.12 && angDiff(t.phi, sg.phi) > 60 * DEG; }); };
          var cap = sg.length <= 0.8 && (touch(sg.a) || touch(sg.b));
          (cap ? tall : low).push(sg);
        });
        segs = segs.filter(function (sg) { return low.indexOf(sg) < 0; });
        // проём у убранной грани: концы проёма должны лежать у оставшихся граней
        if (low.length) {
          var dSeg = function (p, t) { var dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1], L2 = dx * dx + dy * dy || 1, k = Math.max(0, Math.min(1, ((p[0] - t.a[0]) * dx + (p[1] - t.a[1]) * dy) / L2)); return Math.hypot(p[0] - t.a[0] - k * dx, p[1] - t.a[1] - k * dy); };
          openSegs = openSegs.filter(function (op) { return segs.some(function (t) { return dSeg(op.a, t) < 0.1; }) && segs.some(function (t) { return dSeg(op.b, t) < 0.1; }); });
        }
      }
    }
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
    var rms = opts.rooms === false ? [] : rooms(segs, openSegs, bb, { minRoom: o.minRoom, mainPhi: dirs[0], segs: segs, scales: opts.scales, minWidth: opts.minWidth, maxCells: opts.maxCells, corridorWidth: opts.corridorWidth, debug: opts.debugRooms });
    var total = segs.reduce(function (s, x) { return s + x.length; }, 0);
    var corridors = rms.filter(function (r) { return r.kind === 'corridor'; }).length;
    return { ok: true, faces: segs, openings: openSegs, walls: walls, rooms: rms, low: low, directions: dirs.map(function (d) { return d / DEG; }), bbox: bb,
      stats: { points: n, cell: o.cell, threshold: o.thr, clutter: clutter, faces: segs.length, openings: openSegs.length, walls: walls.length, rooms: rms.length,
        corridors: corridors, low: low.length, lowCheck: lowInfo, faceLength: total } };
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

  // Чертёж в DXF R12. plan — план одного этажа или массив [{ plan, title, subtitle, layerPrefix }] (несколько этажей).
  // Размеры — настоящие объекты DIMENSION (выровненные) с блоком геометрии *Dn (o.dims === 'lines' — прежние линии и текст).
  function toDXF(plan, o) {
    o = o || {};
    var units = o.units === 'm' ? 'm' : 'mm', k = units === 'mm' ? 1000 : 1;
    var asDims = o.dims !== 'lines';
    var items = Array.isArray(plan) ? plan.filter(function (it) { return it && it.plan; }) : [{ plan: plan, title: o.title, subtitle: o.subtitle }];
    var multi = Array.isArray(plan);
    var ents = [], blocks = [], ext = { a: Infinity, b: Infinity, c: -Infinity, d: -Infinity }, layerSet = {}, layerOrder = [];
    var nDim = 0, dimCount = 0;
    var baseLayers = [['A-WALL', 7], ['A-OPEN', 3], ['A-DIMS', 2], ['A-THK', 8], ['A-ROOM', 4], ['A-ROUTE', 1], ['A-INFO', 7], ['A-FURN', 8]];
    function addLayer(name, color) { if (!layerSet[name]) { layerSet[name] = 1; layerOrder.push([name, color]); } }
    addLayer('0', 7);
    function grow(q) { if (q[0] < ext.a) ext.a = q[0]; if (q[0] > ext.c) ext.c = q[0]; if (q[1] < ext.b) ext.b = q[1]; if (q[1] > ext.d) ext.d = q[1]; }
    var shiftX = 0;   // для нескольких этажей в местных координатах — этажи рядом слева направо
    items.forEach(function (it, idx) {
      var pl = it.plan, pre = multi ? (it.layerPrefix || ('F' + (idx + 1) + '-')) : '';
      baseLayers.forEach(function (l) { addLayer(pre + l[0], l[1]); });
      var ox = 0, oy = 0;
      if (o.origin === 'world' && o.world) { ox = o.world.cx || 0; oy = o.world.cy || 0; }
      else if (pl.bbox) { ox = -Math.floor(pl.bbox.u0) + shiftX; oy = -Math.floor(pl.bbox.v0); }   // местные: от угла плана, целые метры
      var P = function (p) { return [(p[0] + ox) * k, (p[1] + oy) * k]; };
      var lext = { a: Infinity, b: Infinity, c: -Infinity, d: -Infinity };
      function g2(q) { grow(q); if (q[0] < lext.a) lext.a = q[0]; if (q[0] > lext.c) lext.c = q[0]; if (q[1] < lext.b) lext.b = q[1]; if (q[1] > lext.d) lext.d = q[1]; }
      function lineS(layer, A, B, color) { return '0\nLINE\n8\n' + layer + '\n' + (color != null ? '62\n' + color + '\n' : '') + '10\n' + num(A[0]) + '\n20\n' + num(A[1]) + '\n30\n0.0\n11\n' + num(B[0]) + '\n21\n' + num(B[1]) + '\n31\n0.0\n'; }
      function textS(layer, A, H, s, rot, center) {
        var t = '0\nTEXT\n8\n' + layer + '\n10\n' + num(A[0]) + '\n20\n' + num(A[1]) + '\n30\n0.0\n40\n' + num(H) + '\n1\n' + esc(s) + '\n';
        if (rot) t += '50\n' + num(rot) + '\n';
        if (center) t += '72\n1\n11\n' + num(A[0]) + '\n21\n' + num(A[1]) + '\n31\n0.0\n';
        return t;
      }
      function line(layer, a, b, color) { var A = P(a), B = P(b); g2(A); g2(B); ents.push(lineS(pre + layer, A, B, color)); }
      function text(layer, p, h, s, rot, center) { var A = P(p); g2(A); ents.push(textS(pre + layer, A, h * k, s, rot, center)); }
      function pline(layer, pts, closed) {
        var L = pre + layer, t = '0\nPOLYLINE\n8\n' + L + '\n66\n1\n70\n' + (closed ? 1 : 0) + '\n';
        pts.forEach(function (p) { var A = P(p); g2(A); t += '0\nVERTEX\n8\n' + L + '\n10\n' + num(A[0]) + '\n20\n' + num(A[1]) + '\n30\n0.0\n'; });
        ents.push(t + '0\nSEQEND\n8\n' + L + '\n');
      }
      // размер: выносные линии, размерная линия с засечками 45°, текст над ней (длина в мм или м)
      function dim(a, b, off, label, th) {
        var d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(d[0], d[1]); if (L < 1e-6) return;
        var nrm = [-d[1] / L, d[0] / L], A2 = [a[0] + nrm[0] * off, a[1] + nrm[1] * off], B2 = [b[0] + nrm[0] * off, b[1] + nrm[1] * off];
        var e1 = off > 0 ? 1 : -1, tk = 0.06, u = [d[0] / L, d[1] / L], s45 = [(u[0] + nrm[0]) * tk, (u[1] + nrm[1]) * tk];
        var ang = Math.atan2(d[1], d[0]) / DEG; if (ang > 90.01) ang -= 180; if (ang <= -90.01) ang += 180;
        var mid = [(A2[0] + B2[0]) / 2 + nrm[0] * 0.04 * e1, (A2[1] + B2[1]) / 2 + nrm[1] * 0.04 * e1];
        var segs = [
          [[a[0] + nrm[0] * 0.05 * e1, a[1] + nrm[1] * 0.05 * e1], [A2[0] + nrm[0] * 0.08 * e1, A2[1] + nrm[1] * 0.08 * e1]],
          [[b[0] + nrm[0] * 0.05 * e1, b[1] + nrm[1] * 0.05 * e1], [B2[0] + nrm[0] * 0.08 * e1, B2[1] + nrm[1] * 0.08 * e1]],
          [A2, B2],
          [[A2[0] - s45[0], A2[1] - s45[1]], [A2[0] + s45[0], A2[1] + s45[1]]],
          [[B2[0] - s45[0], B2[1] - s45[1]], [B2[0] + s45[0], B2[1] + s45[1]]]];
        dimCount++;
        if (!asDims) { segs.forEach(function (sg) { line('A-DIMS', sg[0], sg[1]); }); text('A-DIMS', mid, th || 0.12, label, ang, true); return; }
        // DIMENSION (выровненный, 70 = 1 + 128: текст в заданной точке) + анонимный блок *Dn с отрисовкой
        var name = '*D' + (++nDim), Ly = pre + 'A-DIMS', body = '';
        segs.forEach(function (sg) { var S0 = P(sg[0]), S1 = P(sg[1]); g2(S0); g2(S1); body += lineS(Ly, S0, S1); });
        var M = P(mid); g2(M);
        body += textS(Ly, M, (th || 0.12) * k, label, ang, true);
        [P(a), P(b), P(B2)].forEach(function (q) { body += '0\nPOINT\n8\nDEFPOINTS\n10\n' + num(q[0]) + '\n20\n' + num(q[1]) + '\n30\n0.0\n'; });
        blocks.push('0\nBLOCK\n8\n0\n2\n' + name + '\n70\n1\n10\n0.0\n20\n0.0\n30\n0.0\n3\n' + name + '\n' + body + '0\nENDBLK\n8\n0\n');
        var D10 = P(B2), A13 = P(a), B14 = P(b);
        ents.push('0\nDIMENSION\n8\n' + Ly + '\n2\n' + name + '\n3\nSTANDARD\n10\n' + num(D10[0]) + '\n20\n' + num(D10[1]) + '\n30\n0.0\n11\n' + num(M[0]) + '\n21\n' + num(M[1]) + '\n31\n0.0\n70\n129\n' +
          (units === 'm' ? '1\n' + esc(label) + '\n' : '') + '13\n' + num(A13[0]) + '\n23\n' + num(A13[1]) + '\n33\n0.0\n14\n' + num(B14[0]) + '\n24\n' + num(B14[1]) + '\n34\n0.0\n');
      }
      var faces = pl.faces || [];
      faces.forEach(function (s) { line('A-WALL', s.a, s.b); });
      // ревизия 29: мебель и стеллажи у стен (нет точек во втором, верхнем срезе) — отдельным серым слоем, без размеров
      (pl.low || []).forEach(function (s) { line('A-FURN', s.a, s.b); });
      (pl.openings || []).forEach(function (p) { line('A-OPEN', p.a, p.b); });
      // размеры граней — внутрь помещения (сторона, где ближе центр помещения), длинные грани
      var centers = (pl.rooms || []).map(function (r) { return r.center; });
      var midOf = function (s) { return [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]; };
      // у двух граней одной стены (перегородки) размеры расходятся наружу — иначе тексты ложатся друг на друга
      var partner = {};
      (pl.walls || []).forEach(function (w) { if (faces[w.i] && faces[w.j]) { partner[w.i] = faces[w.j]; partner[w.j] = faces[w.i]; } });
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
      var ops = pl.openings || [];
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
      (pl.walls || []).forEach(function (w) {
        var A = faces[w.i], B = faces[w.j]; if (!A || !B) return;
        var m = [(A.a[0] + A.b[0] + B.a[0] + B.b[0]) / 4, (A.a[1] + A.b[1] + B.a[1] + B.b[1]) / 4];
        text('A-THK', m, 0.08, fmtLen(w.thickness, units), 0, true);
      });
      (pl.rooms || []).forEach(function (r) {
        text('A-ROOM', [r.center[0], r.center[1] + 0.2], 0.22, r.name, 0, true);
        text('A-ROOM', [r.center[0], r.center[1] - 0.15], 0.18, (Math.round(r.area * 10) / 10).toFixed(1).replace('.', ',') + ' м²', 0, true);
        if (r.size) text('A-ROOM', [r.center[0], r.center[1] - 0.45], 0.12, fmtLen(r.size[0], units) + ' x ' + fmtLen(r.size[1], units), 0, true);
      });
      // габаритные размеры (вдоль главного направления) — снаружи плана
      if (faces.length && pl.directions && pl.directions.length) {
        var phi = pl.directions[0] * DEG, cs = Math.cos(phi), sn = Math.sin(phi), xa = Infinity, ya = Infinity, xb = -Infinity, yb = -Infinity;
        faces.forEach(function (s) { [s.a, s.b].forEach(function (p) { var X = p[0] * cs + p[1] * sn, Y = -p[0] * sn + p[1] * cs; if (X < xa) xa = X; if (X > xb) xb = X; if (Y < ya) ya = Y; if (Y > yb) yb = Y; }); });
        dim(toWorld(phi, xa, ya), toWorld(phi, xb, ya), -1.0, fmtLen(xb - xa, units), 0.18);
        dim(toWorld(phi, xa, yb), toWorld(phi, xa, ya), -1.0, fmtLen(yb - ya, units), 0.18);
      }
      var route = it.route || (!multi ? o.route : null);
      if (route && route.length >= 8) {
        var rp = []; for (var i = 0; i < route.length; i += 4) rp.push([route[i], route[i + 1]]);
        pline('A-ROUTE', rp, false);
      }
      if (lext.a < Infinity) {
        var tl = [(lext.a / k) - ox, (lext.b / k) - oy - 1.6];
        text('A-INFO', tl, 0.25, it.title || o.title || 'Обмерный план по облаку точек', 0, false);
        text('A-INFO', [tl[0], tl[1] - 0.4], 0.14, 'Единицы: ' + (units === 'mm' ? 'миллиметры' : 'метры') + '. ' + (it.subtitle || o.subtitle || ''), 0, false);
        shiftX += (lext.c - lext.a) / k + 4;
      }
    });
    if (asDims && nDim) addLayer('DEFPOINTS', 7);
    var tk = asDims ? '0.06' : '0.0', H12 = function (v) { return num(v * k); };
    var h = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$DWGCODEPAGE\n3\nANSI_1251\n9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0\n9\n$EXTMIN\n10\n' + num(ext.a) + '\n20\n' + num(ext.b) + '\n30\n0.0\n9\n$EXTMAX\n10\n' + num(ext.c) + '\n20\n' + num(ext.d) + '\n30\n0.0\n9\n$LUNITS\n70\n2\n9\n$LUPREC\n70\n' + (units === 'mm' ? 0 : 3) +
      '\n9\n$DIMSTYLE\n2\nSTANDARD\n9\n$DIMTXT\n40\n' + H12(0.12) + '\n9\n$DIMTSZ\n40\n' + H12(+tk) + '\n9\n$DIMEXO\n40\n' + H12(0.05) + '\n9\n$DIMEXE\n40\n' + H12(0.08) + '\n9\n$DIMGAP\n40\n' + H12(0.03) + '\n9\n$DIMTAD\n70\n1\n9\n$DIMTIH\n70\n0\n9\n$DIMTOH\n70\n0\n9\n$DIMZIN\n70\n8\n0\nENDSEC\n';
    var t = '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLTYPE\n70\n1\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB\n0\nTABLE\n2\nLAYER\n70\n' + layerOrder.length + '\n';
    layerOrder.forEach(function (l) { t += '0\nLAYER\n2\n' + l[0] + '\n70\n0\n62\n' + l[1] + '\n6\nCONTINUOUS\n'; });
    t += '0\nENDTAB\n0\nTABLE\n2\nSTYLE\n70\n1\n0\nSTYLE\n2\nSTANDARD\n70\n0\n40\n0.0\n41\n1.0\n50\n0.0\n71\n0\n42\n2.5\n3\ntxt\n4\n\n0\nENDTAB\n';
    t += '0\nTABLE\n2\nAPPID\n70\n1\n0\nAPPID\n2\nACAD\n70\n0\n0\nENDTAB\n';
    t += '0\nTABLE\n2\nDIMSTYLE\n70\n1\n0\nDIMSTYLE\n2\nSTANDARD\n70\n0\n3\n\n4\n\n5\n\n6\n\n7\n\n40\n1.0\n41\n' + H12(0.06) + '\n42\n' + H12(0.05) + '\n43\n' + H12(0.38) + '\n44\n' + H12(0.08) + '\n45\n0.0\n46\n0.0\n47\n0.0\n48\n0.0\n140\n' + H12(0.12) +
      '\n141\n0.0\n142\n' + H12(+tk) + '\n143\n25.4\n144\n1.0\n145\n0.0\n146\n1.0\n147\n' + H12(0.03) + '\n71\n0\n72\n0\n73\n0\n74\n0\n75\n0\n76\n0\n77\n1\n78\n8\n170\n0\n171\n2\n172\n0\n173\n0\n174\n0\n175\n0\n176\n0\n177\n0\n178\n0\n0\nENDTAB\n0\nENDSEC\n';
    var b = '0\nSECTION\n2\nBLOCKS\n' + blocks.join('') + '0\nENDSEC\n';
    return h + t + b + '0\nSECTION\n2\nENTITIES\n' + ents.join('') + '0\nENDSEC\n0\nEOF\n';
  }

  return { extract: extract, toDXF: toDXF, directions: directions, angDiff: angDiff, _esc: esc };
});
