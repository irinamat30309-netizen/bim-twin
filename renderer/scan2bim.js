/*
 * scan2bim.js — v1231
 * Scan-to-BIM: высокоточная (1:1) реконструкция BIM-модели из облака точек.
 * Чистый геометрический движок без внешних зависимостей (window.Scan2BIM + module.exports).
 *
 * Конвенция координат приложения: Y — вертикаль (вверх), план — (X, Z).
 * При экспорте в IFC оси переводятся в (X, Y_план=Z, Z_вверх=Y).
 *
 * Конвейер:
 *   1) voxel-прореживание → стабильная плотность;
 *   2) поиск пола/потолка (горизонтальные уровни) → высота этажа;
 *   3) детекция стен (RANSAC-линии по среднему срезу, детерминированный ГПСЧ);
 *   4) ОБЪЕДИНЕНИЕ параллельных/совпадающих граней в ОДНУ стену (v1160: убирает «слои»);
 *   5) детекция проёмов (двери/окна) по разрывам плотности вдоль стены (v1160);
 *   6) детекция труб/MEP под потолком (тонкие вытянутые кластеры → цилиндры) (v1160);
 *   7) замыкание/продление углов (в т.ч. T-стыки);
 *   8) колонны (IFCCOLUMN) и балки (IFCBEAM); плиты, экспорт IFC4 / OBJ / DXF.
 */
(function () {
  'use strict';

  // ---------- вход ----------
  function toPts(input, colors) {
    if (!input) return [];
    var out;
    if (ArrayBuffer.isView(input) || (input.length && typeof input[0] === 'number')) {
      out = []; for (var i = 0; i + 2 < input.length; i += 3) out.push([input[i], input[i + 1], input[i + 2]]);
    } else { out = input; }
    // v1178: carry RGB per point when a parallel colors array is provided (0-1 or 0-255)
    if (colors && colors.length) {
      var norm = 1; for (var c = 0; c < Math.min(colors.length, 300); c++) { if (colors[c] > 1.5) { norm = 1 / 255; break; } }
      var mm = Math.min(out.length, Math.floor(colors.length / 3));
      for (var k = 0; k < mm; k++) { var p = out[k]; if (p && p.length >= 3) { p[3] = colors[k * 3] * norm; p[4] = colors[k * 3 + 1] * norm; p[5] = colors[k * 3 + 2] * norm; } }
    }
    return out;
  }
  function sortedNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function percentile(sorted, p) { if (!sorted.length) return 0; var i = Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))); return sorted[i]; }
  function seededRng(seed) { var s = (seed || 12345) >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  // ---------- voxel-прореживание ----------
  function voxelDownsample(pts, vox) {
    if (!(vox > 0)) return pts;
    var seen = Object.create(null), out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var key = Math.round(p[0] / vox) + '_' + Math.round(p[1] / vox) + '_' + Math.round(p[2] / vox);
      if (seen[key] === undefined) { seen[key] = 1; out.push(p); }
    }
    return out;
  }

  // ---------- уровни пола/потолка (Y вверх) ----------
  function refineLevel(pts, y0, tol) {
    var s = 0, ss = 0, n = 0; for (var i = 0; i < pts.length; i++) { var y = pts[i][1]; if (Math.abs(y - y0) < tol) { s += y; ss += y * y; n++; } }
    if (!n) return { y: y0, rms: 0, count: 0 };
    var m = s / n; return { y: m, rms: Math.sqrt(Math.max(0, ss / n - m * m)), count: n };
  }
  function detectLevels(pts) {
    var ys = sortedNum(pts.map(function (p) { return p[1]; }));
    // v1164: устойчивое определение пола/потолка по пикам гистограммы высоты
    // (горизонтальные плоскости = самые плотные тонкие Y-слои), чтобы выбросы не завышали высоту.
    var lo = percentile(ys, 0.005), hi = percentile(ys, 0.995);
    var hspan = (hi - lo) || 1;
    var nb = Math.max(24, Math.min(400, Math.round(hspan / 0.05)));
    var bin = hspan / nb, hist = new Array(nb);
    for (var b = 0; b < nb; b++) hist[b] = 0;
    for (var i = 0; i < ys.length; i++) { var k = Math.floor((ys[i] - lo) / bin); if (k < 0) k = 0; if (k >= nb) k = nb - 1; hist[k]++; }
    var lowEnd = Math.max(1, Math.floor(nb * 0.4)), highStart = Math.min(nb - 1, Math.ceil(nb * 0.6));
    var fb = 0, fcnt = -1; for (var bf = 0; bf < lowEnd; bf++) if (hist[bf] > fcnt) { fcnt = hist[bf]; fb = bf; }
    var cbn = nb - 1, ccnt = -1; for (var bc = nb - 1; bc >= highStart; bc--) if (hist[bc] > ccnt) { ccnt = hist[bc]; cbn = bc; }
    var f0 = lo + (fb + 0.5) * bin, c0 = lo + (cbn + 0.5) * bin;
    if (!(c0 - f0 > 0.3)) { f0 = percentile(ys, 0.01); c0 = percentile(ys, 0.99); }
    var span = (c0 - f0) || 1;
    var tol = Math.max(0.05, span * 0.03);
    var f = refineLevel(pts, f0, tol), c = refineLevel(pts, c0, tol);
    return { floorY: f.y, ceilY: c.y, height: c.y - f.y, floorRms: f.rms, ceilRms: c.rms };
  }

  // ---------- 2D RANSAC-линия (план X,Z) ----------
  function norm2(v) { var l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
  function ransacLine2(pts, idx, thr, iters, minLen, rng) {
    var m = idx.length; if (m < 2) return null;
    var best = null, bestCnt = 0;
    for (var it = 0; it < iters; it++) {
      var ia = idx[Math.floor(rng() * m)], ib = idx[Math.floor(rng() * m)];
      var a = pts[ia], b = pts[ib];
      var dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      var ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
      var cnt = 0;
      for (var k = 0; k < m; k++) { var p = pts[idx[k]]; var d = (p[0] - a[0]) * nx + (p[1] - a[1]) * nz; if (d < 0 ? -d < thr : d < thr) cnt++; }
      if (cnt > bestCnt) { bestCnt = cnt; best = { a: a, b: b, dir: [ux, uz], nrm: [nx, nz] }; }
    }
    if (!best) return null;
    // инлайеры + уточнение направления через PCA и протяжённость
    var inl = [];
    for (var k2 = 0; k2 < m; k2++) { var p2 = pts[idx[k2]]; var d2 = (p2[0] - best.a[0]) * best.nrm[0] + (p2[1] - best.a[1]) * best.nrm[1]; if (Math.abs(d2) < thr) inl.push(idx[k2]); }
    if (inl.length < 2) return null;
    var cx = 0, cz = 0; for (var q = 0; q < inl.length; q++) { cx += pts[inl[q]][0]; cz += pts[inl[q]][1]; } cx /= inl.length; cz /= inl.length;
    var sxx = 0, sxz = 0, szz = 0; for (var q2 = 0; q2 < inl.length; q2++) { var ex = pts[inl[q2]][0] - cx, ez = pts[inl[q2]][1] - cz; sxx += ex * ex; sxz += ex * ez; szz += ez * ez; }
    // главная ось 2x2
    var tr = sxx + szz, det = sxx * szz - sxz * sxz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det)), l1 = tr / 2 + disc;
    var dir = Math.abs(sxz) > 1e-12 ? norm2([l1 - szz, sxz]) : (sxx >= szz ? [1, 0] : [0, 1]);
    var nrm = [-dir[1], dir[0]];
    var tmin = Infinity, tmax = -Infinity, perp = [];
    for (var q3 = 0; q3 < inl.length; q3++) { var wx = pts[inl[q3]][0] - cx, wz = pts[inl[q3]][1] - cz; var t = wx * dir[0] + wz * dir[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; perp.push(Math.abs(wx * nrm[0] + wz * nrm[1])); }
    var len = tmax - tmin; if (len < minLen) return { reject: true, inl: inl };
    perp.sort(function (a1, b1) { return a1 - b1; });
    var rms = 0; for (var r = 0; r < perp.length; r++) rms += perp[r] * perp[r]; rms = Math.sqrt(rms / perp.length);
    var off = cx * nrm[0] + cz * nrm[1];
    return {
      a: [cx + dir[0] * tmin, cz + dir[1] * tmin], b: [cx + dir[0] * tmax, cz + dir[1] * tmax],
      c: [cx, cz], dir: dir, nrm: nrm, off: off, length: len, inl: inl, inlierCount: inl.length,
      rms: rms, angle: Math.atan2(dir[1], dir[0])
    };
  }
  function detectLines(pts2, o) {
    var rng = seededRng(o.seed);
    var remain = []; for (var i = 0; i < pts2.length; i++) remain.push(i);
    var lines = [], guard = 0;
    while (remain.length >= o.minInliers && lines.length < o.maxWalls && guard++ < o.maxWalls * 3) {
      var w = ransacLine2(pts2, remain, o.threshold, o.iters, o.minLen, rng);
      if (!w) break;
      if (w.reject || w.inlierCount < o.minInliers) { // убираем мелкий кластер, чтобы не зациклиться
        if (w.inl && w.inl.length) { var drop0 = {}; for (var d0 = 0; d0 < w.inl.length; d0++) drop0[w.inl[d0]] = 1; remain = remain.filter(function (ix) { return !drop0[ix]; }); continue; }
        break;
      }
      lines.push(w);
      var drop = {}; for (var d = 0; d < w.inl.length; d++) drop[w.inl[d]] = 1;
      remain = remain.filter(function (ix) { return !drop[ix]; });
    }
    return lines;
  }

  // ---------- сборка стен (парные грани → толщина) ----------
  function angDiff(a, b) { var d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }
  function overlap1d(a0, a1, b0, b1) { return Math.min(a1, b1) - Math.max(a0, b0); }
  function projRange(w) { var t0 = w.a[0] * w.dir[0] + w.a[1] * w.dir[1], t1 = w.b[0] * w.dir[0] + w.b[1] * w.dir[1]; return t0 < t1 ? [t0, t1] : [t1, t0]; }
  function buildWalls(lines, o) {
    var used = new Array(lines.length); var walls = [];
    for (var i = 0; i < lines.length; i++) {
      if (used[i]) continue;
      var li = lines[i], mate = -1, bestGap = Infinity;
      for (var j = i + 1; j < lines.length; j++) {
        if (used[j]) continue; var lj = lines[j];
        if (angDiff(li.angle, lj.angle) > 8 * Math.PI / 180) continue;
        var ri = projRange(li), rj = projRange(lj);
        if (overlap1d(ri[0], ri[1], rj[0], rj[1]) < 0.2 * Math.min(li.length, lj.length)) continue;
        // Perpendicular distance between the fitted line centres, independent
        // of their normal orientation. Comparing absolute offsets to the global
        // origin pairs distinct symmetric walls as if they were opposite faces.
        var dcx = lj.c[0] - li.c[0], dcz = lj.c[1] - li.c[1];
        var g = Math.abs(dcx * li.nrm[0] + dcz * li.nrm[1]);
        if (g >= 0.04 && g <= o.maxThickness && g < bestGap) { bestGap = g; mate = j; }
      }
      var wall;
      if (mate >= 0) {
        var lm = lines[mate]; used[mate] = 1;
        // осевая линия = среднее двух граней
        var mid = midLine(li, lm);
        wall = { a: mid.a, b: mid.b, dir: mid.dir, thickness: bestGap, faces: 2, rms: (li.rms + lm.rms) / 2, inlierCount: li.inlierCount + lm.inlierCount };
      } else {
        wall = { a: li.a.slice(), b: li.b.slice(), dir: li.dir.slice(), thickness: o.defaultThickness, faces: 1, rms: li.rms, inlierCount: li.inlierCount };
      }
      used[i] = 1;
      wall.length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
      wall.angleDeg = Math.atan2(wall.dir[1], wall.dir[0]) * 180 / Math.PI;
      wall.base = o.floorY; wall.top = o.ceilY; wall.height = o.height;
      walls.push(wall);
    }
    // v1164: СНАЧАЛА выравниваем каждую грань к доминантной сетке (0/90°), потом схлопываем —
    // иначе косой мёрж даёт диагональные стены.
    if (o.snapAngles) snapWallAngles(walls);
    walls = mergeColinearWalls(walls, o);
    if (o.snapAngles) snapWallAngles(walls);
    if (o.closeCorners) closeCorners(walls);
    for (var w2 = 0; w2 < walls.length; w2++) { walls[w2].length = Math.hypot(walls[w2].b[0] - walls[w2].a[0], walls[w2].b[1] - walls[w2].a[1]); }
    return walls;
  }
  function midLine(li, lj) {
    // проецируем концы обеих граней на общее направление, берём среднюю ось
    var dir = li.dir;
    var cx = (li.c[0] + lj.c[0]) / 2, cz = (li.c[1] + lj.c[1]) / 2;
    var pts = [li.a, li.b, lj.a, lj.b], tmin = Infinity, tmax = -Infinity;
    for (var i = 0; i < 4; i++) { var t = (pts[i][0] - cx) * dir[0] + (pts[i][1] - cz) * dir[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    return { a: [cx + dir[0] * tmin, cz + dir[1] * tmin], b: [cx + dir[0] * tmax, cz + dir[1] * tmax], dir: dir.slice() };
  }

  // v1160: объединение почти-параллельных и почти-совпадающих стен в одну (убирает дубликаты/слои).
  function projOn(w, dir) { var t0 = w.a[0] * dir[0] + w.a[1] * dir[1], t1 = w.b[0] * dir[0] + w.b[1] * dir[1]; return t0 < t1 ? [t0, t1] : [t1, t0]; }
  function mergeTwoWalls(wi, wj, dir, o) {
    var wI = wi.inlierCount || 1, wJ = wj.inlierCount || 1, tot = wI + wJ;
    var mi = [(wi.a[0] + wi.b[0]) / 2, (wi.a[1] + wi.b[1]) / 2];
    var mj = [(wj.a[0] + wj.b[0]) / 2, (wj.a[1] + wj.b[1]) / 2];
    var c = [(mi[0] * wI + mj[0] * wJ) / tot, (mi[1] * wI + mj[1] * wJ) / tot];
    var nrm = [-dir[1], dir[0]];
    var pts = [wi.a, wi.b, wj.a, wj.b], tmin = Infinity, tmax = -Infinity, pmin = Infinity, pmax = -Infinity;
    for (var k = 0; k < 4; k++) {
      var t = (pts[k][0] - c[0]) * dir[0] + (pts[k][1] - c[1]) * dir[1];
      if (t < tmin) tmin = t; if (t > tmax) tmax = t;
      var pp = (pts[k][0] - c[0]) * nrm[0] + (pts[k][1] - c[1]) * nrm[1];
      if (pp < pmin) pmin = pp; if (pp > pmax) pmax = pp;
    }
    var thk = Math.max(wi.thickness || 0, wj.thickness || 0, pmax - pmin);
    thk = Math.max(0.05, Math.min(o.maxThickness || 0.6, thk));
    var a = [c[0] + dir[0] * tmin, c[1] + dir[1] * tmin], b = [c[0] + dir[0] * tmax, c[1] + dir[1] * tmax];
    return {
      a: a, b: b, dir: dir.slice(), thickness: thk, faces: 2,
      rms: ((wi.rms || 0) * wI + (wj.rms || 0) * wJ) / tot, inlierCount: tot,
      length: Math.hypot(b[0] - a[0], b[1] - a[1]), angleDeg: Math.atan2(dir[1], dir[0]) * 180 / Math.PI,
      base: wi.base, top: wi.top, height: wi.height
    };
  }
  function mergeColinearWalls(walls, o) {
    var mergeDist = Math.max(o.maxThickness || 0.6, 0.45);
    var changed = true, guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (var i = 0; i < walls.length && !changed; i++) {
        for (var j = i + 1; j < walls.length; j++) {
          var wi = walls[i], wj = walls[j];
          if (angDiff(wi.angleDeg * Math.PI / 180, wj.angleDeg * Math.PI / 180) > 12 * Math.PI / 180) continue;
          var dir = norm2(wi.dir), nrm = [-dir[1], dir[0]];
          var mi = [(wi.a[0] + wi.b[0]) / 2, (wi.a[1] + wi.b[1]) / 2];
          var mj = [(wj.a[0] + wj.b[0]) / 2, (wj.a[1] + wj.b[1]) / 2];
          var perp = Math.abs((mj[0] - mi[0]) * nrm[0] + (mj[1] - mi[1]) * nrm[1]);
          if (perp > mergeDist) continue; // параллельные, но далеко — это разные стены
          var ti = projOn(wi, dir), tj = projOn(wj, dir);
          var ov = Math.min(ti[1], tj[1]) - Math.max(ti[0], tj[0]);
          var shorter = Math.min(wi.length, wj.length) || 1;
          if (ov < -0.3 * shorter) continue; // не перекрываются и не смежны
          walls[i] = mergeTwoWalls(wi, wj, dir, o);
          walls.splice(j, 1);
          changed = true; break;
        }
      }
    }
    return walls;
  }

  function snapWallAngles(walls) {
    if (!walls.length) return;
    // доминантный угол (по самой длинной стене), выравнивание к 0/90° относительно него
    var base = walls.slice().sort(function (a, b) { return b.length - a.length; })[0].angleDeg * Math.PI / 180;
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i], ang = w.angleDeg * Math.PI / 180;
      var rel = ang - base, k = Math.round(rel / (Math.PI / 2)), snapped = base + k * Math.PI / 2;
      // v1164: широкий допуск (до ~22°) выпрямляет косые грани; концы перепроецируем на новую ось.
      if (angDiff(ang, snapped) <= 22 * Math.PI / 180) {
        var mx = (w.a[0] + w.b[0]) / 2, mz = (w.a[1] + w.b[1]) / 2;
        var d = [Math.cos(snapped), Math.sin(snapped)];
        var ta = (w.a[0] - mx) * d[0] + (w.a[1] - mz) * d[1];
        var tb = (w.b[0] - mx) * d[0] + (w.b[1] - mz) * d[1];
        w.a = [mx + d[0] * ta, mz + d[1] * ta]; w.b = [mx + d[0] * tb, mz + d[1] * tb];
        w.dir = d; w.angleDeg = snapped * 180 / Math.PI;
        w.length = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      }
    }
  }
  function intersect2(a1, a2, b1, b2) {
    var r = [a2[0] - a1[0], a2[1] - a1[1]], s = [b2[0] - b1[0], b2[1] - b1[1]];
    var d = r[0] * s[1] - r[1] * s[0]; if (Math.abs(d) < 1e-9) return null;
    var t = ((b1[0] - a1[0]) * s[1] - (b1[1] - a1[1]) * s[0]) / d;
    return [a1[0] + t * r[0], a1[1] + t * r[1]];
  }
  function refreshWall(w) {
    w.dir = norm2([w.b[0] - w.a[0], w.b[1] - w.a[1]]);
    w.length = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    w.angleDeg = Math.atan2(w.dir[1], w.dir[0]) * 180 / Math.PI;
  }
  function snapEndToward(w, X, reach) {
    var da = Math.hypot(w.a[0] - X[0], w.a[1] - X[1]);
    var db = Math.hypot(w.b[0] - X[0], w.b[1] - X[1]);
    var end = da <= db ? 'a' : 'b';
    if (Math.min(da, db) <= reach) { w[end] = X.slice(); refreshWall(w); }
  }
  // v1161: замыкание/продление углов и T-стыков
  function closeCorners(walls) {
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < walls.length; i++) for (var j = i + 1; j < walls.length; j++) {
        var wi = walls[i], wj = walls[j];
        if (angDiff(wi.angleDeg * Math.PI / 180, wj.angleDeg * Math.PI / 180) < 20 * Math.PI / 180) continue;
        var X = intersect2(wi.a, wi.b, wj.a, wj.b); if (!X) continue;
        var reach = Math.max(0.6, (wi.thickness || 0.15) + (wj.thickness || 0.15) + 0.25);
        snapEndToward(wi, X, reach);
        snapEndToward(wj, X, reach);
      }
    }
  }

  // v1160: детекция проёмов (двери/окна) — разрывы плотности вдоль осевой стены.
  // v1176: obrezka steny do protyazhonnosti, podtverzhdyonnoy oblakom tochek.
  function trimWallsToSupport(walls, pd, lv) {
    if (!walls || !walls.length || !pd || !pd.length || !lv) return;
    var ylo = lv.floorY + 0.2, yhi = lv.ceilY - 0.2;
    if (yhi <= ylo) { ylo = lv.floorY; yhi = lv.ceilY; }
    for (var w = 0; w < walls.length; w++) {
      var wl = walls[w], a = wl.a, dir = norm2(wl.dir), nrm = [-dir[1], dir[0]];
      var L = Math.hypot(wl.b[0] - a[0], wl.b[1] - a[1]); if (L < 1.2) continue;
      var half = (wl.thickness || 0.15) / 2 + 0.08;
      var bin = 0.25, nb = Math.max(4, Math.ceil(L / bin));
      var occ = new Float64Array(nb);
      for (var i = 0; i < pd.length; i++) {
        var y = pd[i][1]; if (y < ylo || y > yhi) continue;
        var px = pd[i][0] - a[0], pz = pd[i][2] - a[1];
        var perp = px * nrm[0] + pz * nrm[1]; if (perp < 0 ? -perp > half : perp > half) continue;
        var t = px * dir[0] + pz * dir[1]; if (t < 0 || t > L) continue;
        occ[Math.min(nb - 1, Math.floor(t / bin))]++;
      }
      var vals = []; for (var b0 = 0; b0 < nb; b0++) if (occ[b0] > 0) vals.push(occ[b0]);
      if (!vals.length) continue;
      vals.sort(function (x, y2) { return x - y2; });
      var med = vals[Math.floor(vals.length / 2)] || 1, thrOcc = Math.max(2, med * 0.15);
      var occBins = 0, first = -1, last = -1;
      for (var b1 = 0; b1 < nb; b1++) { if (occ[b1] >= thrOcc) { occBins++; if (first < 0) first = b1; last = b1; } }
      if (first < 0) continue;
      if (occBins / nb >= 0.75) continue;
      var leadEmpty = first * bin, trailEmpty = (nb - 1 - last) * bin;
      var nA0 = a[0], nA1 = a[1], nB0 = wl.b[0], nB1 = wl.b[1], changed = false;
      if (leadEmpty >= 0.75) { nA0 = a[0] + dir[0] * (first * bin); nA1 = a[1] + dir[1] * (first * bin); changed = true; }
      if (trailEmpty >= 0.75) { nB0 = a[0] + dir[0] * ((last + 1) * bin); nB1 = a[1] + dir[1] * ((last + 1) * bin); changed = true; }
      if (!changed) continue;
      var nl = Math.hypot(nB0 - nA0, nB1 - nA1); if (nl < 0.8) continue;
      wl.a = [nA0, nA1]; wl.b = [nB0, nB1]; wl.length = nl;
      wl.dir = norm2([nB0 - nA0, nB1 - nA1]); wl.angleDeg = Math.atan2(wl.dir[1], wl.dir[0]) * 180 / Math.PI; wl.trimmed = true;
    }
  }

  function detectWallOpenings(w, band, thr) {
    w.openings = [];
    var L = w.length; if (L < 1.2) return;
    var dir = norm2(w.dir), nrm = [-dir[1], dir[0]], a = w.a;
    var band2 = Math.max(thr * 2.5, 0.09);
    var bin = 0.12, nb = Math.max(4, Math.ceil(L / bin));
    var occ = new Float64Array(nb);
    for (var i = 0; i < band.length; i++) {
      var px = band[i][0] - a[0], pz = band[i][1] - a[1];
      var perp = px * nrm[0] + pz * nrm[1]; if (perp < 0 ? -perp > band2 : perp > band2) continue;
      var t = px * dir[0] + pz * dir[1]; if (t < 0 || t > L) continue;
      occ[Math.min(nb - 1, Math.floor(t / bin))]++;
    }
    var vals = []; for (var b0 = 0; b0 < nb; b0++) if (occ[b0] > 0) vals.push(occ[b0]);
    if (vals.length < nb * 0.30) return; // v1180: dopuskaem okklyudirovannye MEP-om steny; dvernaya polosa empty ot pola do 2.2m otsekaet okklyuziyu. // слишком разреженно — не доверяем геометрии проёмов
    vals.sort(function (x, y) { return x - y; });
    var med = vals[Math.floor(vals.length / 2)] || 1;
    var thrOcc = Math.max(1, med * 0.22);
    var strongThr = med * 0.5; // v1181: silnaya opora steny ryadom s proyomom (dostovernost)
    function flankMax(from, to) { var mx = 0; for (var k = from; k < to; k++) { if (k >= 0 && k < nb && occ[k] > mx) mx = occ[k]; } return mx; }
    var run = -1;
    for (var b1 = 0; b1 <= nb; b1++) {
      var empty = b1 < nb ? occ[b1] < thrOcc : true;
      if (empty && run < 0) run = b1;
      else if (!empty && run >= 0) {
        var wlen = (b1 - run) * bin;
        // v1181: proyom = pustoy uchastok dvernoy polosy. Otstup ot uglov 0.35m ubiraet ugolnye artefakty.
        if (run * bin >= 0.35 && (nb - b1) * bin >= 0.35 && wlen >= 0.6 && wlen <= 3.0) {
          var leftS = flankMax(run - 3, run) >= strongThr;
          var rightS = flankMax(b1, b1 + 3) >= strongThr;
          // v1181: slabaya opora steny s odnoy storony ILI shirina > 2.6m => proyom pomechaetsya "pod voprosom" (uncertain).
          var uncertain = !(leftS && rightS) || wlen > 2.6;
          // v1181: shirokiy razryv bez opory steny s obeih storon = okklyuziya (ten ot MEP), a ne proyom -> otbrasyvaem.
          if (!(wlen > 2.6 && !leftS && !rightS)) {
            w.openings.push({ along: run * bin, width: wlen, kind: wlen <= 1.4 ? 'door' : 'opening', uncertain: uncertain });
          }
        }
        run = -1;
      }
    }
  }

  // v1160: детекция труб/MEP под потолком — тонкие вытянутые кластеры, не принадлежащие стенам/плитам.
  function nearAnyWall(x, z, walls, margin) {
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i], dir = norm2(w.dir), nrm = [-dir[1], dir[0]];
      var t = (x - w.a[0]) * dir[0] + (z - w.a[1]) * dir[1];
      if (t < -0.3 || t > w.length + 0.3) continue;
      var perp = Math.abs((x - w.a[0]) * nrm[0] + (z - w.a[1]) * nrm[1]);
      if (perp <= (w.thickness / 2 + margin)) return true;
    }
    return false;
  }
  function detectPipes(pd, lv, walls, o) {
    if (o.detectPipes === false) return [];
    var top = lv.ceilY, h = lv.height > 0 ? lv.height : 3;
    var zhi = top - Math.max(0.15, h * 0.04);          // v1170: исключаем припотолочную зону (плита/дека/лотки) — меньше ложных «труб»
    var zlo = top - Math.min(1.4, h * 0.42);           // полоса под потолком (ловим висящие трубы)
    var band = [];
    for (var i = 0; i < pd.length; i++) {
      var p = pd[i], y = p[1];
      if (y > zhi || y < zlo) continue;
      if (nearAnyWall(p[0], p[2], walls, 0.08)) continue; // отсекаем только точки самой стены; трубы вдоль стены сохраняем
      band.push(p);
    }
    if (band.length < 30) return [];
    var pts2 = []; for (var k = 0; k < band.length; k++) pts2.push([band[k][0], band[k][2]]);
    var rng = seededRng((o.seed || 12345) + 7);
    var remain = []; for (var q = 0; q < pts2.length; q++) remain.push(q);
    var pipes = [], guard = 0;
    var thr = Math.max(0.025, (o.voxel || 0.03) * 1.5);
    var maxPipes = o.maxPipes || 60;
    while (remain.length > 24 && pipes.length < maxPipes && guard++ < 160) {
      var w = ransacLine2(pts2, remain, thr, 250, 0.6, rng);
      if (!w) break;
      var inl = w.inl || []; if (!inl.length) break;
      if (w.reject || !w.dir) { var dq = {}; for (var dd = 0; dd < inl.length; dd++) dq[inl[dd]] = 1; remain = remain.filter(function (ix) { return !dq[ix]; }); continue; }
      var nrm = w.nrm || [-w.dir[1], w.dir[0]], cc = w.c || [pts2[inl[0]][0], pts2[inl[0]][1]];
      var pmin = Infinity, pmax = -Infinity, yavg = 0, ylo = Infinity, yhi = -Infinity;
      for (var r = 0; r < inl.length; r++) {
        var pp = (pts2[inl[r]][0] - cc[0]) * nrm[0] + (pts2[inl[r]][1] - cc[1]) * nrm[1];
        if (pp < pmin) pmin = pp; if (pp > pmax) pmax = pp;
        var yy = band[inl[r]][1]; yavg += yy; if (yy < ylo) ylo = yy; if (yy > yhi) yhi = yy;
      }
      yavg /= inl.length;
      var width = pmax - pmin, len = w.length || 0, vext = yhi - ylo;
      var drop = {}; for (var d = 0; d < inl.length; d++) drop[inl[d]] = 1;
      remain = remain.filter(function (ix) { return !drop[ix]; });
      // v1170: труба идёт как узкая линия в плане (XZ). Отсекаем всё толстое/короткое (стены, плоскости).
      if (w.reject || len < 1.0 || width > 0.30) continue;
      if (vext <= 0.35) {
        // одиночная горизонтальная труба: компактное круглое сечение.
        if (inl.length >= 24) pipes.push({ a: [w.a[0], w.a[1]], b: [w.b[0], w.b[1]], radius: Math.max(0.02, Math.min(0.12, Math.max(width, vext) / 2 || 0.04)), y: yavg, length: len });
      } else if (len >= 2.0 && inl.length >= 60) {
        // v1176: MEP/pipe-rack along corridor. Cross-section points (perp,Y) are clustered
        // and FLAT slabs/decks/trays (wide horizontal sheets) are rejected -> no dozens of fake pipes.
        var cell = 0.08;
        var grid = {}, rowCells = {};
        for (var s = 0; s < inl.length; s++) {
          var pv = (pts2[inl[s]][0] - cc[0]) * nrm[0] + (pts2[inl[s]][1] - cc[1]) * nrm[1];
          var yv = band[inl[s]][1];
          var ci = Math.round(pv / cell), cj = Math.round(yv / cell), key = ci + '|' + cj;
          var e = grid[key] || (grid[key] = { ci: ci, cj: cj, n: 0, ps: 0, ys: 0 });
          e.n++; e.ps += pv; e.ys += yv;
          (rowCells[cj] || (rowCells[cj] = {}))[ci] = 1;
        }
        var slabRow = {};
        for (var rk in rowCells) {
          var cis = Object.keys(rowCells[rk]).map(Number).sort(function (a, b) { return a - b; });
          var run = 1, mrun = 1;
          for (var t = 1; t < cis.length; t++) { if (cis[t] - cis[t - 1] === 1) { run++; if (run > mrun) mrun = run; } else run = 1; }
          if (mrun * cell > 0.55) slabRow[rk] = 1;
        }
        var visited = {}, gkeys = Object.keys(grid);
        var need2 = Math.max(24, Math.round(inl.length * 0.03));
        for (var gk = 0; gk < gkeys.length; gk++) {
          if (visited[gkeys[gk]]) continue;
          var stack = [gkeys[gk]], comp = []; visited[gkeys[gk]] = 1;
          while (stack.length) {
            var ck = stack.pop(), cg = grid[ck]; comp.push(cg);
            for (var da = -1; da <= 1; da++) for (var db = -1; db <= 1; db++) {
              if (!da && !db) continue;
              var nk = (cg.ci + da) + '|' + (cg.cj + db);
              if (grid[nk] && !visited[nk]) { visited[nk] = 1; stack.push(nk); }
            }
          }
          var np = 0, psum = 0, ysum = 0, pmn = Infinity, pmx2 = -Infinity, ymn = Infinity, ymx = -Infinity, slabC = 0;
          for (var c2 = 0; c2 < comp.length; c2++) {
            var g2 = comp[c2]; np += g2.n; psum += g2.ps; ysum += g2.ys;
            var pcc = g2.ci * cell, ycc = g2.cj * cell;
            if (pcc < pmn) pmn = pcc; if (pcc > pmx2) pmx2 = pcc;
            if (ycc < ymn) ymn = ycc; if (ycc > ymx) ymx = ycc;
            if (slabRow[g2.cj]) slabC++;
          }
          var pext = pmx2 - pmn + cell, yext = ymx - ymn + cell;
          if (np < need2) continue;
          if (slabC > comp.length * 0.5) continue;
          if (pext > 0.40) continue;
          if (yext > 0.45) continue;
          var perpC = psum / np, yC = ysum / np;
          var rad = Math.max(0.03, Math.min(0.14, Math.max(pext, yext) / 2));
          pipes.push({
            a: [w.a[0] + nrm[0] * perpC, w.a[1] + nrm[1] * perpC],
            b: [w.b[0] + nrm[0] * perpC, w.b[1] + nrm[1] * perpC],
            radius: rad, y: yC, length: len
          });
        }
      }
    }
    // v1170: дедупликация — повторные проходы RANSAC дают близкие параллельные линии по одной трубе. Сливаем их.
    var merged = [];
    for (var pi = 0; pi < pipes.length; pi++) {
      var p = pipes[pi], pa = p.a, pb = p.b, pdx = pb[0] - pa[0], pdz = pb[1] - pa[1], pl = Math.hypot(pdx, pdz) || 1;
      var pux = pdx / pl, puz = pdz / pl, dup = false;
      for (var mj = 0; mj < merged.length; mj++) {
        var q = merged[mj];
        if (Math.abs(p.y - q.y) > 0.12) continue;
        var qdx = q.b[0] - q.a[0], qdz = q.b[1] - q.a[1], ql = Math.hypot(qdx, qdz) || 1;
        var cross = Math.abs(pux * (qdz / ql) - puz * (qdx / ql));
        if (cross > 0.2) continue;                        // не параллельны
        var perp = Math.abs((pa[0] - q.a[0]) * (-puz) + (pa[1] - q.a[1]) * pux);
        if (perp > 0.18) continue;                        // разные трубы по горизонтали
        if (pl > ql) { q.a = p.a; q.b = p.b; }             // оставляем более длинную
        q.radius = Math.max(q.radius, p.radius); dup = true; break;
      }
      if (!dup) merged.push(p);
    }
    return merged;
  }

  // v1161: детекция балок под потолком — широкие вытянутые горизонтальные кластеры (шире труб).
  function detectBeams(pd, lv, walls, o) {
    if (o.detectBeams === false) return [];
    var top = lv.ceilY, h = lv.height > 0 ? lv.height : 3;
    var zhi = top - Math.max(0.03, h * 0.01);
    var zlo = top - Math.min(0.7, h * 0.22);
    var band = [];
    for (var i = 0; i < pd.length; i++) {
      var p = pd[i], y = p[1];
      if (y > zhi || y < zlo) continue;
      if (nearAnyWall(p[0], p[2], walls, 0.05)) continue;
      band.push(p);
    }
    if (band.length < 40) return [];
    var pts2 = []; for (var k = 0; k < band.length; k++) pts2.push([band[k][0], band[k][2]]);
    var rng = seededRng((o.seed || 12345) + 13);
    var remain = []; for (var q = 0; q < pts2.length; q++) remain.push(q);
    var beams = [], guard = 0, maxB = o.maxBeams || 30;
    var thr = 0.25;
    while (remain.length > 30 && beams.length < maxB && guard++ < 160) {
      var w = ransacLine2(pts2, remain, thr, 250, 1.2, rng);
      if (!w) break;
      var inl = w.inl || []; if (!inl.length) break;
      if (w.reject || !w.dir) { var dq = {}; for (var dd = 0; dd < inl.length; dd++) dq[inl[dd]] = 1; remain = remain.filter(function (ix) { return !dq[ix]; }); continue; }
      var nrm = w.nrm || [-w.dir[1], w.dir[0]], cc = w.c || [pts2[inl[0]][0], pts2[inl[0]][1]];
      var pmin = Infinity, pmax = -Infinity, yavg = 0, ylo = Infinity, yhi = -Infinity;
      for (var r = 0; r < inl.length; r++) {
        var pp = (pts2[inl[r]][0] - cc[0]) * nrm[0] + (pts2[inl[r]][1] - cc[1]) * nrm[1];
        if (pp < pmin) pmin = pp; if (pp > pmax) pmax = pp;
        var yy = band[inl[r]][1]; yavg += yy; if (yy < ylo) ylo = yy; if (yy > yhi) yhi = yy;
      }
      yavg /= inl.length;
      var width = pmax - pmin, len = w.length || 0, depth = Math.max(0.15, Math.min(0.6, (yhi - ylo) || h * 0.12));
      var isBeam = !w.reject && len >= 1.2 && width >= 0.15 && width <= 0.8 && inl.length >= 24;
      var drop = {}; for (var d = 0; d < inl.length; d++) drop[inl[d]] = 1;
      remain = remain.filter(function (ix) { return !drop[ix]; });
      if (isBeam) {
        // v1170: не дублируем раку труб — если рядом идёт >=3 параллельных труб на близкой высоте, это трубы/лотки, а не балка.
        var bdx = w.b[0] - w.a[0], bdz = w.b[1] - w.a[1], bl = Math.hypot(bdx, bdz) || 1, bux = bdx / bl, buz = bdz / bl;
        var nearPipes = 0, pplist = o.pipes || [];
        for (var pk = 0; pk < pplist.length; pk++) {
          var pp2 = pplist[pk]; if (Math.abs((pp2.y || 0) - yavg) > 0.6) continue;
          var qdx = pp2.b[0] - pp2.a[0], qdz = pp2.b[1] - pp2.a[1], ql2 = Math.hypot(qdx, qdz) || 1;
          if (Math.abs(bux * (qdz / ql2) - buz * (qdx / ql2)) > 0.25) continue; // не параллельны
          if (Math.abs((pp2.a[0] - w.a[0]) * (-buz) + (pp2.a[1] - w.a[1]) * bux) < 1.0) nearPipes++;
        }
        // v1181: strukturnaya balka idet parallelno stenam. Diagonalnyy korotkiy segment (naprimer v uglu u torca) = shum ot potolochnogo hlama, a ne balka.
        var bAngle = Math.atan2(bdz, bdx), parWall = !(walls && walls.length);
        for (var wq = 0; wq < (walls || []).length; wq++) { var wdd = walls[wq].dir; if (angDiff(bAngle, Math.atan2(wdd[1], wdd[0])) <= 18 * Math.PI / 180) { parWall = true; break; } }
        if (nearPipes < 3 && parWall) beams.push({ a: [w.a[0], w.a[1]], b: [w.b[0], w.b[1]], width: Math.max(0.1, Math.min(0.8, width)), depth: depth, y: yavg, length: len });
      }
    }
    // v1180: pipe-rack rejection - esli >=4 balok pochti-parallelny (rack konduitov/trub v MEP-zone), eto ne balki
    if (beams.length >= 4) {
      var bAng = function (bb) { var dx = bb.b[0] - bb.a[0], dz = bb.b[1] - bb.a[1]; return Math.atan2(dz, dx); };
      var kept = [];
      for (var bi = 0; bi < beams.length; bi++) { var par = 0; for (var bj = 0; bj < beams.length; bj++) { if (angDiff(bAng(beams[bi]), bAng(beams[bj])) <= 20 * Math.PI / 180) par++; } if (par < 4) kept.push(beams[bi]); }
      beams = kept;
    }
    return beams;
  }

  // v1230: не экспортируем линейный шум внутри подтверждённой балки как MEP-трубу.
  // RANSAC по плану может принять продольные рёбра прямоугольной балки за отдельные трубы.
  function suppressPipeCandidatesCoveredByBeams(pipes, beams) {
    var kept = [], suppressed = 0;
    pipes = pipes || []; beams = beams || [];
    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i], pdx = p.b[0] - p.a[0], pdz = p.b[1] - p.a[1];
      var plen = Math.hypot(pdx, pdz);
      var rejected = false;
      if (plen >= 0.6) {
        var pang = Math.atan2(pdz, pdx);
        for (var j = 0; j < beams.length; j++) {
          var b = beams[j], bdx = b.b[0] - b.a[0], bdz = b.b[1] - b.a[1];
          var blen = Math.hypot(bdx, bdz);
          if (blen < 1.0 || angDiff(pang, Math.atan2(bdz, bdx)) > 15 * Math.PI / 180) continue;
          var ux = bdx / blen, uz = bdz / blen, nx = -uz, nz = ux;
          var d0 = Math.abs((p.a[0] - b.a[0]) * nx + (p.a[1] - b.a[1]) * nz);
          var d1 = Math.abs((p.b[0] - b.a[0]) * nx + (p.b[1] - b.a[1]) * nz);
          var radius = Math.max(0.02, Number(p.radius) || 0.04);
          var beamHalfWidth = Math.max(0.1, Number(b.width) || 0.3) / 2;
          if (d0 > beamHalfWidth + radius + 0.05 || d1 > beamHalfWidth + radius + 0.05) continue;
          var t0 = (p.a[0] - b.a[0]) * ux + (p.a[1] - b.a[1]) * uz;
          var t1 = (p.b[0] - b.a[0]) * ux + (p.b[1] - b.a[1]) * uz;
          var overlap = Math.max(0, Math.min(Math.max(t0, t1), blen) - Math.max(Math.min(t0, t1), 0));
          if (overlap < Math.min(plen, blen) * 0.5) continue;
          var verticalTol = Math.max(0.1, Number(b.depth) || 0.15) / 2 + radius + 0.05;
          if (Math.abs((Number(p.y) || 0) - (Number(b.y) || 0)) > verticalTol) continue;
          rejected = true;
          break;
        }
      }
      if (rejected) suppressed++;
      else kept.push(p);
    }
    return { pipes: kept, suppressed: suppressed };
  }

  // ---------- выпуклая оболочка (контур пола) ----------
  // v1164: устойчивый контур этажа — ориентируем по доминирующей стене, отсекаем выбросы
  // и строим прямоугольный (Manhattan) контур вместо «косой» выпуклой оболочки.
  function footprint2d(band, walls, useHull) {
    if (band.length < 4) return hull2d(band);
    if (useHull) return hull2d(band);
    var ang = 0, haveAng = false;
    if (walls && walls.length) {
      var best = null; for (var i = 0; i < walls.length; i++) { if (walls[i] && walls[i].dir && (!best || walls[i].length > best.length)) best = walls[i]; }
      if (best && best.dir) { ang = Math.atan2(best.dir[1], best.dir[0]); haveAng = true; }
    }
    if (!haveAng) {
      var cx = 0, cz = 0; for (var j = 0; j < band.length; j++) { cx += band[j][0]; cz += band[j][1]; } cx /= band.length; cz /= band.length;
      var sxx = 0, sxz = 0, szz = 0; for (var j2 = 0; j2 < band.length; j2++) { var ex = band[j2][0] - cx, ez = band[j2][1] - cz; sxx += ex * ex; sxz += ex * ez; szz += ez * ez; }
      var tr = sxx + szz, det = sxx * szz - sxz * sxz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det)), l1 = tr / 2 + disc;
      var dir = Math.abs(sxz) > 1e-12 ? norm2([l1 - szz, sxz]) : (sxx >= szz ? [1, 0] : [0, 1]);
      ang = Math.atan2(dir[1], dir[0]);
    }
    var ca = Math.cos(-ang), sa = Math.sin(-ang);
    var us = [], vs = [];
    for (var m = 0; m < band.length; m++) { var x = band[m][0], z = band[m][1]; us.push(x * ca - z * sa); vs.push(x * sa + z * ca); }
    var su = sortedNum(us), sv = sortedNum(vs);
    var u0 = percentile(su, 0.01), u1 = percentile(su, 0.99), v0 = percentile(sv, 0.01), v1 = percentile(sv, 0.99);
    var corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    var cb2 = Math.cos(ang), sb2 = Math.sin(ang), out = [];
    for (var c = 0; c < 4; c++) { var u = corners[c][0], v = corners[c][1]; out.push([u * cb2 - v * sb2, u * sb2 + v * cb2]); }
    return out;
  }
  function hull2d(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cross = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    var lower = [];
    for (var i = 0; i < p.length; i++) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop(); lower.push(p[i]); }
    var upper = [];
    for (var k = p.length - 1; k >= 0; k--) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[k]) <= 0) upper.pop(); upper.push(p[k]); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  function polyArea(poly) { var s = 0; for (var i = 0; i < poly.length; i++) { var a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }

  // ---------- v1160: сетка вертикальной плотности → доказательства стен (внутренние стены + дедуп) ----------
  function wallEvidence(pd, lv, o) {
    var floorY = lv.floorY, ceilY = lv.ceilY, h = (ceilY - floorY) || 3;
    var pad = Math.max(0.08, h * 0.12), lo = floorY + pad, hi = ceilY - pad;
    var cell = Math.max((o.voxel || 0.03) * 2, 0.05);
    var hb = Math.max(0.15, h * 0.05), nhb = Math.max(3, Math.ceil(h / hb));
    var grid = Object.create(null), keys = [];
    for (var i = 0; i < pd.length; i++) {
      var p = pd[i], y = p[1]; if (y < lo || y > hi) continue;
      var gx = Math.round(p[0] / cell), gz = Math.round(p[2] / cell), key = gx + '_' + gz;
      var e = grid[key]; if (!e) { e = grid[key] = { sx: 0, sz: 0, n: 0, bins: Object.create(null), nb: 0 }; keys.push(key); }
      e.sx += p[0]; e.sz += p[2]; e.n++;
      var bi = Math.floor((y - floorY) / hb); if (!e.bins[bi]) { e.bins[bi] = 1; e.nb++; }
    }
    var covThr = Math.max(3, Math.floor(nhb * 0.35)), cells = [];
    for (var k = 0; k < keys.length; k++) { var g = grid[keys[k]]; if (g.nb >= covThr) cells.push([g.sx / g.n, g.sz / g.n, g.n]); }
    return { cells: cells, cell: cell };
  }

  // ---------- v1160: кластеризация внутренних объектов (оборудование/колонны) → bbox-прокси ----------
  function detectObjects(pd, lv, walls, o) {
    if (o.detectObjects === false) return [];
    var floorY = lv.floorY, ceilY = lv.ceilY, h = (ceilY - floorY) || 3;
    var lo = floorY + Math.max(0.06, h * 0.03), hi = ceilY - Math.max(0.1, h * 0.06);
    var res = [];
    for (var i = 0; i < pd.length; i++) {
      var p = pd[i], y = p[1]; if (y < lo || y > hi) continue;
      if (nearAnyWall(p[0], p[2], walls, 0.15)) continue;
      res.push(p);
    }
    if (res.length < 40) return [];
    var vc = Math.max((o.voxel || 0.03) * 3, 0.12);
    var grid = Object.create(null), order = [];
    for (var j = 0; j < res.length; j++) {
      var q = res[j], gx = Math.round(q[0] / vc), gy = Math.round(q[1] / vc), gz = Math.round(q[2] / vc), key = gx + '_' + gy + '_' + gz;
      var c = grid[key]; if (!c) { c = grid[key] = { gx: gx, gy: gy, gz: gz, pts: [], seen: false }; order.push(key); }
      c.pts.push(q);
    }
    var minPts = o.minObjPts || 50, roomArea = o.roomArea || 1e9, maxObjects = o.maxObjects || 12, objects = [];
    for (var oi = 0; oi < order.length; oi++) {
      var startc = grid[order[oi]]; if (startc.seen) continue;
      var stack = [startc]; startc.seen = true; var mem = [];
      while (stack.length) {
        var cc = stack.pop(); mem.push(cc);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          var nb = grid[(cc.gx + dx) + '_' + (cc.gy + dy) + '_' + (cc.gz + dz)];
          if (nb && !nb.seen) { nb.seen = true; stack.push(nb); }
        }
      }
      var np = 0, minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
      for (var m = 0; m < mem.length; m++) { var ps = mem[m].pts; for (var t = 0; t < ps.length; t++) { var pt = ps[t]; np++; if (pt[0] < minx) minx = pt[0]; if (pt[0] > maxx) maxx = pt[0]; if (pt[1] < miny) miny = pt[1]; if (pt[1] > maxy) maxy = pt[1]; if (pt[2] < minz) minz = pt[2]; if (pt[2] > maxz) maxz = pt[2]; } }
      if (np < minPts) continue;
      var dx2 = maxx - minx, dy2 = maxy - miny, dz2 = maxz - minz;
      if (dy2 < 0.3) continue;                    // v1170: низкое (<0.3м) — это мусор/хлам на полу, не оборудование
      if (dx2 * dz2 > roomArea * 0.45) continue;   // слишком большое — это структура, не отдельный объект
      if (dx2 * dy2 * dz2 < 0.02) continue;        // v1170: слишком малый объём — шум/мелкий мусор
      if (miny > floorY + h * 0.5) continue;        // v1179: korobka celikom v verkhney MEP-zone (ne kasaetsya pola) -> eto truby/kabeli/potolochnyy hlam, ne oborudovanie
      var _foot = Math.max(dx2, dz2);
      // v1181: korobka ohvatyvaet pochti vsyu vysotu ot pola do potolka (>=85%) i shire kolonny -> eto stena/struktura (nedosmodelirovannaya stena), a ne oborudovanie. Ubiraem fantomnuyu stenu iz obyektov.
      if (dy2 >= h * 0.85 && _foot > 0.85) continue;
      var _kind = (dy2 >= h * 0.6 && _foot <= 0.85 && dx2 * dz2 <= 0.85) ? 'column' : 'equipment';
      objects.push({ cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, cz: (minz + maxz) / 2, hx: Math.max(dx2 / 2, 0.02), hy: Math.max(dy2 / 2, 0.02), hz: Math.max(dz2 / 2, 0.02), points: np, kind: _kind });
    }
    // v1170: оставляем только самые крупные (по числу точек) объекты — меньше ложного хлама.
    if (objects.length > maxObjects) { objects.sort(function (x, y2) { return y2.points - x.points; }); objects = objects.slice(0, maxObjects); }
    return objects;
  }

  // v1164: притягиваем периметральные стены к рёбрам контура (footprint).
  // Скан часто недосканирует дальнюю/окклюдированную стену — тогда RANSAC ловит более плотную
  // внутреннюю плоскость, и стена «уезжает» внутрь. Контур же строится по крайним точкам и точнее.
  function alignWallsToFootprint(walls, foot, reach) {
    if (!walls || !walls.length || !foot || foot.length < 3) return;
    reach = reach || 1.6;
    for (var i = 0; i < foot.length; i++) {
      var p = foot[i], q = foot[(i + 1) % foot.length];
      var d = norm2([q[0] - p[0], q[1] - p[1]]);
      var len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.3) continue;
      var nrm = [-d[1], d[0]], ea = Math.atan2(d[1], d[0]);
      var best = -1, bestPerp = Infinity;
      for (var w = 0; w < walls.length; w++) {
        var wall = walls[w];
        if (wall.alignedToFootprint) continue;
        var wd = norm2(wall.dir);
        if (angDiff(Math.atan2(wd[1], wd[0]), ea) > 15 * Math.PI / 180) continue;
        var mid = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
        var t = (mid[0] - p[0]) * d[0] + (mid[1] - p[1]) * d[1];
        if (t < -0.5 || t > len + 0.5) continue;                 // середина вне протяжённости ребра
        var perp = Math.abs((mid[0] - p[0]) * nrm[0] + (mid[1] - p[1]) * nrm[1]);
        if (perp < bestPerp) { bestPerp = perp; best = w; }
      }
      if (best >= 0 && bestPerp <= reach) {
        var wl = walls[best];
        wl.a = p.slice(); wl.b = q.slice();                      // периметральная стена = ребро контура
        if (wl.thickness > 0.4) wl.thickness = 0.25; // v1180: cap nerealno tolstyh perimetralnyh sten
        refreshWall(wl); wl.alignedToFootprint = true;
      }
    }
  }

  // ---------- главная функция ----------
  // v1178: klassifikatsiya materiala steny po RGB (kirpich/metall/beton/blok).
  function matName(rgb) {
    var r = rgb[0], g = rgb[1], b = rgb[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = (mx - mn) / (mx + 1e-6), val = mx;
    if (r > g * 1.10 && r > b * 1.12 && r > 0.28) return 'brick';
    if (sat < 0.10 && val > 0.55) return 'metal';
    if (sat < 0.16) return 'concrete';
    if (r >= g && g >= b) return 'block';
    return 'other';
  }
  var MAT_COLOR = { brick: [0.62, 0.32, 0.24], metal: [0.72, 0.74, 0.78], concrete: [0.68, 0.68, 0.66], block: [0.80, 0.76, 0.68], other: [0.75, 0.75, 0.75], unknown: [0.80, 0.80, 0.82] };
  function classifyMaterial(walls, pd, lv) {
    if (!walls || !walls.length || !pd || !pd.length || !lv) return;
    var hasColor = pd[0] && pd[0].length >= 6;
    var ylo = lv.floorY + 0.2, yhi = lv.ceilY - 0.3; if (yhi <= ylo) { ylo = lv.floorY; yhi = lv.ceilY; }
    for (var w = 0; w < walls.length; w++) {
      var wl = walls[w], a = wl.a, dir = norm2(wl.dir), nrm = [-dir[1], dir[0]], L = wl.length;
      if (!hasColor) { wl.material = 'unknown'; wl.color = MAT_COLOR.unknown.slice(); continue; }
      var half = (wl.thickness || 0.15) / 2 + 0.06, sr = 0, sg = 0, sb = 0, n = 0;
      for (var i = 0; i < pd.length; i++) { var p = pd[i]; if (p.length < 6) continue; var y = p[1]; if (y < ylo || y > yhi) continue; var px = p[0] - a[0], pz = p[2] - a[1], t = px * dir[0] + pz * dir[1]; if (t < 0 || t > L) continue; var perp = px * nrm[0] + pz * nrm[1]; if (perp < 0 ? -perp > half : perp > half) continue; sr += p[3]; sg += p[4]; sb += p[5]; n++; }
      if (n < 30) { wl.material = 'unknown'; wl.color = MAT_COLOR.unknown.slice(); continue; }
      var rgb = [sr / n, sg / n, sb / n]; wl.material = matName(rgb); wl.color = [Math.round(rgb[0] * 1000) / 1000, Math.round(rgb[1] * 1000) / 1000, Math.round(rgb[2] * 1000) / 1000]; wl.materialSamples = n;
    }
  }

  // v1178: tonkie svisayushchie provoda (cables) - tonkie kruglye niti, provisayushchie ot potolka.
  // v1179: sredniy tsvet tochek v bbox (dlya materiala trub/balok/obyektov)
  function avgColorInBox(pd, cx, cy, cz, hx, hy, hz) {
    var sr = 0, sg = 0, sb = 0, n = 0, ex = hx + 0.05, ey = hy + 0.05, ez = hz + 0.05;
    for (var i = 0; i < pd.length; i++) { var p = pd[i]; if (p.length < 6) continue; if (Math.abs(p[0] - cx) > ex || Math.abs(p[1] - cy) > ey || Math.abs(p[2] - cz) > ez) continue; sr += p[3]; sg += p[4]; sb += p[5]; n++; }
    if (n < 8) return null; return [Math.round(sr / n * 1000) / 1000, Math.round(sg / n * 1000) / 1000, Math.round(sb / n * 1000) / 1000];
  }
  function colorElements(pd, lv, pipes, beams, objects) {
    if (!pd || !pd.length || !(pd[0] && pd[0].length >= 6)) return;
    for (var i = 0; i < pipes.length; i++) { var p = pipes[i], cx = (p.a[0] + p.b[0]) / 2, cz = (p.a[1] + p.b[1]) / 2, hxp = Math.abs(p.b[0] - p.a[0]) / 2 + p.radius + 0.05, hzp = Math.abs(p.b[1] - p.a[1]) / 2 + p.radius + 0.05, c = avgColorInBox(pd, cx, p.y, cz, hxp, p.radius + 0.12, hzp); if (c) { p.color = c; p.material = matName(c); } }
    for (var j = 0; j < beams.length; j++) { var b = beams[j], bx = (b.a[0] + b.b[0]) / 2, bz = (b.a[1] + b.b[1]) / 2, hxb = Math.abs(b.b[0] - b.a[0]) / 2 + 0.05, hzb = Math.abs(b.b[1] - b.a[1]) / 2 + 0.05, cc = avgColorInBox(pd, bx, b.y, bz, hxb, (b.depth || 0.1) / 2 + 0.05, hzb); if (cc) { b.color = cc; b.material = matName(cc); } }
    for (var k = 0; k < objects.length; k++) { var o = objects[k], oc = avgColorInBox(pd, o.cx, o.cy, o.cz, o.hx, o.hy, o.hz); if (oc) { o.color = oc; o.material = matName(oc); } }
  }

  // v1181: klassifikatsiya trub po diametru i materialu (RGB).
  function pipeMaterialName(rgb) {
    if (!rgb) return 'unknown';
    var r = rgb[0], g = rgb[1], b = rgb[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = (mx - mn) / (mx + 1e-6), val = mx;
    if (r > g * 1.12 && r > b * 1.15 && sat > 0.14) return 'copper';   // med / ryzhaya izolyatsiya
    if (sat < 0.12 && val > 0.72) return 'plastic';                   // beliy PVH/PP
    if (sat < 0.12) return 'steel';                                   // seryy stalnoy
    if (g >= r && g >= b && sat > 0.16) return 'painted';             // okrashennaya
    return 'other';
  }
  var PIPE_STD_DN = [15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300];
  function classifyPipes(pipes) {
    if (!pipes) return;
    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];
      var dmm = Math.round(p.radius * 2 * 1000);
      p.diameter = Math.round(p.radius * 2 * 1000) / 1000; // metry
      p.diameterMm = dmm;
      var dn = PIPE_STD_DN[0];
      for (var s = 0; s < PIPE_STD_DN.length; s++) if (Math.abs(PIPE_STD_DN[s] - dmm) < Math.abs(dn - dmm)) dn = PIPE_STD_DN[s];
      p.dn = 'DN' + dn;
      p.sizeClass = dmm <= 50 ? 'small' : dmm <= 150 ? 'medium' : 'large';
      p.material = p.color ? pipeMaterialName(p.color) : (p.material || 'unknown');
    }
  }
  // v1181: svodka trub po (diametr x material)
  function pipeGroupsOf(pipes) {
    var groups = {};
    for (var i = 0; i < (pipes || []).length; i++) {
      var p = pipes[i], key = (p.dn || '?') + ' \u00b7 ' + (p.material || 'other');
      var g = groups[key] || (groups[key] = { dn: p.dn, diameterMm: p.diameterMm, material: p.material, sizeClass: p.sizeClass, count: 0, totalLength: 0 });
      g.count++; g.totalLength += p.length || 0;
    }
    return Object.keys(groups).map(function (k) { var g = groups[k]; g.totalLength = Math.round(g.totalLength * 100) / 100; return g; }).sort(function (a, b) { return b.count - a.count || b.diameterMm - a.diameterMm; });
  }

  function detectCables(pd, lv, walls, o) {
    var cables = []; if (o && o.detectCables === false) return cables;
    if (!pd || !pd.length || !lv) return cables;
    var h = lv.ceilY - lv.floorY; if (!(h > 0.5)) return cables;
    var zlo = lv.floorY + h * 0.45, zhi = lv.ceilY - 0.05, cell = 0.12;
    var objects = o && o.objects || [];
    function insideColumn(x, z) {
      for (var ci = 0; ci < objects.length; ci++) {
        var ob = objects[ci];
        if (!ob || ob.kind !== 'column') continue;
        if (Math.abs(x - ob.cx) <= (ob.hx || 0) + 0.15 &&
            Math.abs(z - ob.cz) <= (ob.hz || 0) + 0.15) return true;
      }
      return false;
    }
    function wallDist(x, z) { var best = 1e9; for (var w = 0; w < walls.length; w++) { var a = walls[w].a, b = walls[w].b, dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz; if (L2 < 1e-9) continue; var t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; var px = a[0] + dx * t, pz = a[1] + dz * t, d = Math.hypot(x - px, z - pz); if (d < best) best = d; } return best; }
    var cells = Object.create(null), keys = [];
    for (var i = 0; i < pd.length; i++) { var p = pd[i], y = p[1]; if (y < zlo || y > zhi) continue; if (wallDist(p[0], p[2]) < 0.5) continue; var gi = Math.floor(p[0] / cell), gj = Math.floor(p[2] / cell), key = gi + '_' + gj; var c = cells[key]; if (!c) { c = cells[key] = { gi: gi, gj: gj, pts: [] }; keys.push(key); } c.pts.push(p); }
    var cand = Object.create(null), ckeys = [];
    for (var k = 0; k < keys.length; k++) {
      var cc = cells[keys[k]], ps = cc.pts;
      if (ps.length < 3 || ps.length > 45) continue;
      var miny = Infinity, maxy = -Infinity, yBins = Object.create(null), yBinCount = 0;
      for (var j = 0; j < ps.length; j++) {
        var yy = ps[j][1];
        if (yy < miny) miny = yy; if (yy > maxy) maxy = yy;
        var yb = Math.floor(yy / cell);
        if (!yBins[yb]) { yBins[yb] = 1; yBinCount++; }
      }
      if (miny >= lv.ceilY - 0.75 || maxy - miny <= 0.5 || maxy < lv.ceilY - 0.3) continue;
      // A cable drop must have a supported, near-continuous vertical trace.
      // Isolated interior points plus floor/ceiling returns are not a cable.
      var yKeys = Object.keys(yBins).map(Number).sort(function (a, b) { return a - b; });
      if (yBinCount < 4) continue;
      var maxEmptyBins = 0;
      for (var yk = 1; yk < yKeys.length; yk++) {
        maxEmptyBins = Math.max(maxEmptyBins, yKeys[yk] - yKeys[yk - 1] - 1);
      }
      if (maxEmptyBins > 2 || yBinCount / (yKeys[yKeys.length - 1] - yKeys[0] + 1) < 0.45) continue;
      var fxmin = Infinity, fxmax = -Infinity, fzmin = Infinity, fzmax = -Infinity, lowN = 0, lowT = miny + 0.4;
      for (var j2 = 0; j2 < ps.length; j2++) {
        if (ps[j2][1] < lowT) {
          var xx = ps[j2][0], zz = ps[j2][2];
          if (xx < fxmin) fxmin = xx; if (xx > fxmax) fxmax = xx;
          if (zz < fzmin) fzmin = zz; if (zz > fzmax) fzmax = zz;
          lowN++;
        }
      }
      if (lowN < 1) continue;
      var foot = Math.max(fxmax - fxmin, fzmax - fzmin);
      if (foot >= 0.18 || insideColumn(cc.gi * cell + cell / 2, cc.gj * cell + cell / 2)) continue;
      var kk = cc.gi + '_' + cc.gj;
      cand[kk] = { gi: cc.gi, gj: cc.gj, miny: miny, maxy: maxy };
      ckeys.push(kk);
    }
    var seen = Object.create(null);
    for (var q = 0; q < ckeys.length; q++) { var sk = ckeys[q]; if (seen[sk]) continue; var stack = [cand[sk]]; seen[sk] = 1; var grp = []; while (stack.length) { var g0 = stack.pop(); grp.push(g0); for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) { var nk = (g0.gi + dx) + '_' + (g0.gj + dy); if (cand[nk] && !seen[nk]) { seen[nk] = 1; stack.push(cand[nk]); } } } if (grp.length < 1 || grp.length > 14) continue; var cx = 0, cz = 0, ymin = Infinity, ymax = -Infinity; for (var gg = 0; gg < grp.length; gg++) { cx += grp[gg].gi * cell + cell / 2; cz += grp[gg].gj * cell + cell / 2; if (grp[gg].miny < ymin) ymin = grp[gg].miny; if (grp[gg].maxy > ymax) ymax = grp[gg].maxy; } cx /= grp.length; cz /= grp.length; if (ymax - ymin < 0.7) continue; cables.push({ x: cx, z: cz, yTop: lv.ceilY, yBot: ymin, radius: 0.012, drop: ymax - ymin, cells: grp.length, kind: 'cable' }); }
    // v1178: sliyanie blizkih provodov v odin puchok (v predelah 0.4m po X-Z)
    cables.sort(function (a, b) { return (b.yTop - b.yBot) - (a.yTop - a.yBot); });
    var merged = [];
    for (var mi = 0; mi < cables.length; mi++) { var cb = cables[mi], dup = false; for (var mj = 0; mj < merged.length; mj++) { if (Math.hypot(cb.x - merged[mj].x, cb.z - merged[mj].z) < 0.4) { if (cb.yBot < merged[mj].yBot) merged[mj].yBot = cb.yBot; merged[mj].drop = merged[mj].yTop - merged[mj].yBot; dup = true; break; } } if (!dup) merged.push(cb); }
    cables = merged;
    var maxC = (o && o.maxCables) || 24; if (cables.length > maxC) cables = cables.slice(0, maxC);
    return cables;
  }

  function reconstruct(input, opts) {
    opts = opts || {};
    var pts = toPts(input, opts.colors);
    if (pts.length < 20) return { ok: false, error: 'Слишком мало точек для реконструкции', walls: [], slabs: [], storey: null };
    var vox = opts.voxel != null ? opts.voxel : 0.03;
    var pd = voxelDownsample(pts, vox);
    var lv = detectLevels(pd);
    var h = lv.height > 0.3 ? lv.height : (lv.height || 3);
    var pad = Math.max(0.1, h * 0.2);
    var band = [];
    for (var i = 0; i < pd.length; i++) { var y = pd[i][1]; if (y >= lv.floorY + pad && y <= lv.ceilY - pad) band.push([pd[i][0], pd[i][2]]); }
    if (band.length < 10) band = pd.map(function (p) { return [p[0], p[2]]; });
    // v1176: отдельная полоса высотой двери (0.15..~2.2м) для поиска проёмов —
    // в среднем срезе (~3.7м) двери всегда перекрыты стеной сверху => двери не находились.
    var doorHi = lv.floorY + Math.min(2.2, h * 0.7);
    var doorBand = [];
    for (var di = 0; di < pd.length; di++) { var dy = pd[di][1]; if (dy >= lv.floorY + 0.15 && dy <= doorHi) doorBand.push([pd[di][0], pd[di][2]]); }
    if (doorBand.length < 10) doorBand = band;
    // v1160: стены — по сетке вертикальной плотности (ловит внутренние стены, убирает дубли), а не по «сырому» срезу
    var ev = wallEvidence(pd, lv, { voxel: vox });
    var wallInput = ev.cells.length >= 8 ? ev.cells : band;
    var thr = opts.wallThreshold != null ? opts.wallThreshold : Math.max(0.03, ev.cell * 1.2);
    var minLen = opts.minWallLen != null ? opts.minWallLen : 0.4;
    var lines = detectLines(wallInput, {
      threshold: thr, iters: opts.iters || 600, minLen: minLen,
      minInliers: opts.minInliers || Math.max(5, Math.floor(wallInput.length * 0.02)),
      maxWalls: opts.maxWalls || 80, seed: opts.seed || 12345
    });
    var walls = buildWalls(lines, {
      defaultThickness: opts.defaultThickness != null ? opts.defaultThickness : 0.15,
      maxThickness: opts.maxThickness != null ? opts.maxThickness : 0.6,
      floorY: lv.floorY, ceilY: lv.ceilY, height: h,
      snapAngles: opts.snapAngles !== false, closeCorners: opts.closeCorners !== false
    });
    // v1160: проёмы (двери/окна) по каждой стене
    var openingCount = 0; // v1176: openings computed AFTER wall trim/align
    // v1160: трубы/MEP под потолком
    var pipes = detectPipes(pd, lv, walls, {
      voxel: vox, seed: opts.seed || 12345,
      detectPipes: opts.detectPipes, maxPipes: opts.maxPipes
    });
    var hull = footprint2d(band, walls, opts.footprint === 'hull');
    // v1164: притягиваем периметр к контуру и заново замыкаем углы
    // v1180: vsegda prityagivaem perimetr k konturu (ubiraem diagonalnye steny), nezavisimo ot snapAngles
    alignWallsToFootprint(walls, hull); if (opts.closeCorners !== false) closeCorners(walls);
    // v1176: obrezaem steny do realno podderzhannoy tochkami protyazhonnosti (ubiraem vydumannye khvosty)
    trimWallsToSupport(walls, pd, lv);
    // v1176: proyomy schitaem po FINALNOY geometrii sten
    if (opts.detectOpenings !== false) {
      for (var wi = 0; wi < walls.length; wi++) {
        // v1180: proyomy tolko po dvernoy polose (0.15..2.2m). Srednij srez daval lozhnye dveri na razrezhennyh/okklyudirovannyh stenah (naprimer lozhnaya dver na w5).
        detectWallOpenings(walls[wi], doorBand, thr);
        walls[wi].openings = (walls[wi].openings || []); openingCount += walls[wi].openings.length;
      }
    }
    // v1178: materialy sten (kirpich/metall/beton) po RGB
    classifyMaterial(walls, pd, lv);
    var slabThk = opts.slabThickness != null ? opts.slabThickness : 0.2;
    var area = polyArea(hull);
    // v1160: внутренние объекты (оборудование/колонны) → bbox-прокси
    var objects = detectObjects(pd, lv, walls, {
      voxel: vox, detectObjects: opts.detectObjects, minObjPts: opts.minObjPts, roomArea: area
    });
    // v1230: известная колонна не должна повторно классифицироваться как вертикальный кабель.
    var cables = detectCables(pd, lv, walls, {
      detectCables: opts.detectCables, maxCables: opts.maxCables, objects: objects
    });
    // v1161: балки под потолком
    var beams = detectBeams(pd, lv, walls, {
      voxel: vox, seed: opts.seed || 12345, detectBeams: opts.detectBeams, maxBeams: opts.maxBeams, pipes: pipes
    });
    // v1230: pipe detection sees long beam edges as thin traces; suppress only
    // candidates contained in a same-height, parallel structural beam.
    var pipeSuppression = suppressPipeCandidatesCoveredByBeams(pipes, beams);
    pipes = pipeSuppression.pipes;
    var columnCount = 0; for (var _oc = 0; _oc < objects.length; _oc++) if (objects[_oc].kind === 'column') columnCount++;
    var slabs = [
      { type: 'floor', level: lv.floorY, polygon: hull, thickness: slabThk, area: area },
      { type: 'ceiling', level: lv.ceilY, polygon: hull, thickness: slabThk, area: area }
    ];
    // v1179: krasim truby/balki/obyekty realnym tsvetom tochek
    colorElements(pd, lv, pipes, beams, objects);
    // v1181: klassifikatsiya trub po diametru i materialu + svodka
    classifyPipes(pipes);
    var pipeGroups = pipeGroupsOf(pipes);
    var openingUncertainCount = 0;
    for (var _w = 0; _w < walls.length; _w++) { var _ops = walls[_w].openings || []; for (var _o = 0; _o < _ops.length; _o++) if (_ops[_o].uncertain) openingUncertainCount++; }
    var totalLen = 0, meanRms = 0; for (var w = 0; w < walls.length; w++) { totalLen += walls[w].length; meanRms += walls[w].rms || 0; }
    meanRms = walls.length ? meanRms / walls.length : 0;
    return {
      ok: true, units: 'm',
      storey: { floorY: lv.floorY, ceilY: lv.ceilY, height: h, floorRms: lv.floorRms, ceilRms: lv.ceilRms },
      walls: walls, slabs: slabs, pipes: pipes, cables: cables, beams: beams, objects: objects, footprint: hull,
      pipeGroups: pipeGroups,
      stats: { pointsIn: pts.length, pointsUsed: pd.length, bandPoints: band.length, wallCount: walls.length, openingCount: openingCount, openingUncertainCount: openingUncertainCount, pipeCount: pipes.length, pipeGroupCount: pipeGroups.length, pipeSuppressedByBeamCount: pipeSuppression.suppressed, cableCount: cables.length, beamCount: beams.length, objectCount: objects.length, columnCount: columnCount, totalWallLength: totalLen, floorArea: area, meanWallRms: meanRms }
    };
  }

  // v1231: общие вертикальные границы окна/двери для wall body и IFC void.
  function wallOpeningVerticalBounds(w, o) {
    var base = Number(w && w.base) || 0;
    var H = Number(w && w.height) || 0;
    var head = o && o.kind === 'opening'
      ? Math.min(H - 0.05, base + Math.max(1.2, H * 0.6)) - base
      : Math.min(H - 0.05, 2.1);
    var sill = o && o.kind === 'opening' ? Math.min(head - 0.3, 0.9) : 0;
    if (!isFinite(head) || !isFinite(sill)) return { head: 0, sill: 0 };
    head = Math.max(0, Math.min(H, head));
    sill = Math.max(0, Math.min(head, sill));
    return { head: head, sill: sill };
  }

  // v1160: сегменты стены с учётом проёмов (простенки + перемычка над дверью). Общее для OBJ и IFC.
  function wallSegments(w) {
    var dir = norm2(w.dir), L = w.length, base = w.base, H = w.height, thk = w.thickness;
    function seg(t0, t1, sb, sh) {
      var cx = w.a[0] + dir[0] * (t0 + t1) / 2, cz = w.a[1] + dir[1] * (t0 + t1) / 2;
      return { cx: cx, cz: cz, dir: dir, hlen: (t1 - t0) / 2, base: sb, height: sh, thk: thk };
    }
    var ops = (w.openings || []).slice().sort(function (p, q) { return p.along - q.along; });
    if (!ops.length) return [seg(0, L, base, H)];
    var out = [], cur = 0;
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i], s = Math.max(0, o.along), e = Math.min(L, o.along + o.width);
      if (e <= s) continue;
      var vertical = wallOpeningVerticalBounds(w, o), head = vertical.head, sill = vertical.sill;
      if (s > cur + 0.01) out.push(seg(cur, s, base, H));       // простенок слева
      if (sill > 0.01) out.push(seg(s, e, base, sill));          // подоконная часть (только окно)
      if (head < H) out.push(seg(s, e, base + head, H - head));  // перемычка над проёмом
      cur = e;
    }
    if (cur < L - 0.01) out.push(seg(cur, L, base, H));          // простенок справа
    return out;
  }

  // ---------- IFC4-экспорт ----------
  function fnum(x) { if (!isFinite(x)) x = 0; var s = (Math.round(x * 1e6) / 1e6).toString(); if (s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0) s += '.'; return s; }
  function ifcGuid(n) {
    var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    var x = ((n + 1) * 2654435761) >>> 0, s = '';
    for (var i = 0; i < 22; i++) {
      // Берём СТАРШИЕ 6 бит состояния ГПСЧ, а не младшие: у классического
      // LCG (x = a*x+c mod 2^32) младшие биты имеют короткий период и почти
      // не меняются — младшими битами почти все символы вырождались в '0'
      // (в старой версии >90% символов сгенерированных GUID были '0').
      var idx = (x >>> 26) % 64;
      // Спец. IFC (base64-вариант, 22 симв.): 128 бит = 21*6 + 2, поэтому
      // первый символ несёт только 2 бита и обязан быть '0'..'3' —
      // buildingSMART: "the first character must be either a 0, 1, 2, or 3".
      s += chars[i === 0 ? (idx % 4) : idx];
      x = (x * 1103515245 + 12345) >>> 0;
    }
    return s;
  }
  function toIFC(model, meta) {
    meta = meta || {}; model = model || {};
    if (typeof window !== 'undefined' && window.__pcTools) {
      var sourceTools = window.__pcTools;
      try {
        if (meta.sourceTransform === undefined && typeof sourceTools.getSourceTransform === 'function') meta.sourceTransform = sourceTools.getSourceTransform();
        if (meta.crsWkt === undefined && typeof sourceTools.getSourceCrs === 'function') meta.crsWkt = sourceTools.getSourceCrs();
      } catch (e) {}
    }
    var walls = model.walls || [], slabs = model.slabs || [];
    var pipes = meta.includePipes === false ? [] : (model.pipes || []);
    var beams = meta.includeBeams === false ? [] : (model.beams || []);
    var st = model.storey || { floorY: 0, ceilY: 3, height: 3 };
    var sourceTransform = meta.sourceTransform || null;
    var sourceT = sourceTransform && sourceTransform.t && sourceTransform.t.length >= 3 ? sourceTransform.t : [0, 0, 0];
    function sourceOffset(i) { var v = Number(sourceT[i]); return isFinite(v) ? v : 0; }
    function planPoint(x, z) {
      if (sourceTransform && sourceTransform.axis === 'zup') return [x + sourceOffset(0), -z + sourceOffset(1)];
      if (sourceTransform && sourceTransform.axis === 'yup') return [x + sourceOffset(0), z + sourceOffset(2)];
      return [x, z];
    }
    function planVector(x, z) { return [x, sourceTransform && sourceTransform.axis === 'zup' ? -z : z]; }
    function vertical(y) {
      if (sourceTransform && sourceTransform.axis === 'zup') return y + sourceOffset(2);
      if (sourceTransform && sourceTransform.axis === 'yup') return y + sourceOffset(1);
      return y;
    }
    function polygonPoints(poly) {
      var out = poly.map(function (p) { return planPoint(p[0], p[1]); });
      var area = 0;
      for (var i = 0; i < out.length; i++) { var a = out[i], b = out[(i + 1) % out.length]; area += a[0] * b[1] - b[0] * a[1]; }
      if (area < 0) out.reverse();
      return out;
    }
    function stepString(s) { return "'" + String(s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ') + "'"; }
    var L = [], id = 0, gc = 0;
    function add(body) { id++; L.push('#' + id + '=' + body + ';'); return '#' + id; }
    function G() { return '\'' + ifcGuid(gc++) + '\''; }
    function pt2(x, y) { return add('IFCCARTESIANPOINT((' + fnum(x) + ',' + fnum(y) + '))'); }
    function pt3(x, y, z) { return add('IFCCARTESIANPOINT((' + fnum(x) + ',' + fnum(y) + ',' + fnum(z) + '))'); }
    function dir3(x, y, z) { return add('IFCDIRECTION((' + fnum(x) + ',' + fnum(y) + ',' + fnum(z) + '))'); }
    function dir2(x, y) { return add('IFCDIRECTION((' + fnum(x) + ',' + fnum(y) + '))'); }

    // контекст и единицы
    var O = pt3(0, 0, 0), ZDIR = dir3(0, 0, 1), XDIR = dir3(1, 0, 0);
    var wcs = add('IFCAXIS2PLACEMENT3D(' + O + ',' + ZDIR + ',' + XDIR + ')');
    var ctx = add('IFCGEOMETRICREPRESENTATIONCONTEXT($,\'Model\',3,1.0E-5,' + wcs + ',$)');
    var uLen = add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
    var uAng = add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
    var uArea = add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
    var units = add('IFCUNITASSIGNMENT((' + uLen + ',' + uAng + ',' + uArea + '))');
    // The geometry below is already emitted in source/map coordinates when a
    // source frame is provided; use an identity map conversion and retain the
    // CRS label/WKT rather than silently dropping georeferencing.
    if (sourceTransform && meta.crsWkt) {
      var wkt = String(meta.crsWkt), epsg = wkt.match(/(?:ID|AUTHORITY)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)/i);
      var crsName = meta.crsName || (epsg ? 'EPSG:' + epsg[1] : 'WKT-defined CRS');
      var projectedCrs = add('IFCPROJECTEDCRS(' + stepString(crsName) + ',' + stepString(wkt) + ',$,$,$,$,#' + uLen + ')');
      add('IFCMAPCONVERSION(' + ctx + ',' + projectedCrs + ',0.,0.,0.,1.,0.,1.)');
    }
    var project = add('IFCPROJECT(' + G() + ',$,\'' + (meta.project || 'Scan2BIM') + '\',$,$,$,$,(' + ctx + '),' + units + ')');
    var siteLP = add('IFCLOCALPLACEMENT($,' + wcs + ')');
    var site = add('IFCSITE(' + G() + ',$,\'Site\',$,$,' + siteLP + ',$,$,.ELEMENT.,$,$,$,$,$)');
    var bLP = add('IFCLOCALPLACEMENT(' + siteLP + ',' + wcs + ')');
    var building = add('IFCBUILDING(' + G() + ',$,\'Building\',$,$,' + bLP + ',$,$,.ELEMENT.,$,$,$)');
    var sLP = add('IFCLOCALPLACEMENT(' + bLP + ',' + wcs + ')');
    var storey = add('IFCBUILDINGSTOREY(' + G() + ',$,\'Storey\',$,$,' + sLP + ',$,$,.ELEMENT.,' + fnum(vertical(st.floorY)) + ')');
    add('IFCRELAGGREGATES(' + G() + ',$,$,$,' + project + ',(' + site + '))');
    add('IFCRELAGGREGATES(' + G() + ',$,$,$,' + site + ',(' + building + '))');
    add('IFCRELAGGREGATES(' + G() + ',$,$,$,' + building + ',(' + storey + '))');

    var products = [];
    // стены (план X,Z → IFC X,Y; высота Y → IFC Z). v1160: одна стена = несколько тел (проёмы).
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      var segs = wallSegments(w);
      var solidRefs = [];
      for (var sgi = 0; sgi < segs.length; sgi++) {
        var sg = segs[sgi]; if (sg.hlen <= 1e-4 || sg.height <= 1e-4) continue;
        var d0 = norm2(sg.dir), d = norm2(planVector(d0[0], d0[1])), p0 = planPoint(sg.cx, sg.cz);
        var profPlc = add('IFCAXIS2PLACEMENT2D(' + pt2(0, 0) + ',' + dir2(1, 0) + ')');
        var prof = add('IFCRECTANGLEPROFILEDEF(.AREA.,$,' + profPlc + ',' + fnum(Math.max(sg.hlen * 2, 1e-3)) + ',' + fnum(Math.max(sg.thk, 1e-3)) + ')');
        var solidPlc = add('IFCAXIS2PLACEMENT3D(' + pt3(p0[0], p0[1], vertical(sg.base)) + ',' + dir3(0, 0, 1) + ',' + dir3(d[0], d[1], 0) + ')');
        var solid = add('IFCEXTRUDEDAREASOLID(' + prof + ',' + solidPlc + ',' + dir3(0, 0, 1) + ',' + fnum(Math.max(sg.height, 1e-3)) + ')');
        solidRefs.push(solid);
      }
      if (!solidRefs.length) continue;
      var shp = add('IFCSHAPEREPRESENTATION(' + ctx + ',\'Body\',\'SweptSolid\',(' + solidRefs.join(',') + '))');
      var pds = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + shp + '))');
      var wLP = add('IFCLOCALPLACEMENT(' + sLP + ',' + wcs + ')');
      var wall = add('IFCWALLSTANDARDCASE(' + G() + ',$,\'Стена ' + (i + 1) + '\',$,$,' + wLP + ',' + pds + ',$,$)');
      products.push(wall);
      // v1231: сохраняем каждый распознанный проём отдельным IFC feature и
      // связываем его со стеной через IfcRelVoidsElement. Геометрия стены
      // остаётся разбитой на сегменты вокруг проёма для совместимости readers.
      var wallOps = w.openings || [];
      var wallDir = norm2(w.dir);
      var openingAxis = norm2(planVector(wallDir[0], wallDir[1]));
      for (var oi = 0; oi < wallOps.length; oi++) {
        var op = wallOps[oi];
        var os = Math.max(0, Number(op.along) || 0);
        var oe = Math.min(w.length, os + Math.max(0, Number(op.width) || 0));
        var vb = wallOpeningVerticalBounds(w, op);
        if (oe <= os + 1e-4 || vb.head <= vb.sill + 1e-4) continue;
        var centerAlong = (os + oe) / 2;
        var centerX = w.a[0] + wallDir[0] * centerAlong;
        var centerZ = w.a[1] + wallDir[1] * centerAlong;
        var openingPlan = planPoint(centerX, centerZ);
        var openingRelativePlacement = add('IFCAXIS2PLACEMENT3D(' +
          pt3(openingPlan[0], openingPlan[1], vertical(w.base + vb.sill)) + ',' +
          ZDIR + ',' + dir3(openingAxis[0], openingAxis[1], 0) + ')');
        var openingLP = add('IFCLOCALPLACEMENT(' + sLP + ',' + openingRelativePlacement + ')');
        var openingProfilePlace = add('IFCAXIS2PLACEMENT2D(' + pt2(0, 0) + ',' + dir2(1, 0) + ')');
        var wallThickness = Math.max(Number(w.thickness) || 0, 1e-3);
        var openingProfile = add('IFCRECTANGLEPROFILEDEF(.AREA.,$,' + openingProfilePlace + ',' +
          fnum(oe - os) + ',' + fnum(wallThickness + Math.max(0.002, wallThickness * 0.02)) + ')');
        var openingSolidPlace = add('IFCAXIS2PLACEMENT3D(' + pt3(0, 0, 0) + ',' + ZDIR + ',' + XDIR + ')');
        var openingSolid = add('IFCEXTRUDEDAREASOLID(' + openingProfile + ',' + openingSolidPlace + ',' +
          ZDIR + ',' + fnum(vb.head - vb.sill) + ')');
        var openingShape = add('IFCSHAPEREPRESENTATION(' + ctx + ',\'Body\',\'SweptSolid\',(' + openingSolid + '))');
        var openingPds = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + openingShape + '))');
        var openingKind = op.kind === 'door' ? 'дверной' : (op.kind === 'opening' ? 'оконный' : 'неуточнённый');
        var opening = add('IFCOPENINGELEMENT(' + G() + ',$,' +
          stepString('Проём ' + (oi + 1) + ' (' + openingKind + ')') +
          ',$,$,' + openingLP + ',' + openingPds + ',$,.OPENING.)');
        add('IFCRELVOIDSELEMENT(' + G() + ',$,$,$,' + wall + ',' + opening + ')');
        products.push(opening);
      }
    }
    // плиты пола/потолка
    for (var s = 0; s < slabs.length; s++) {
      var sl = slabs[s], poly = sl.polygon || [];
      if (poly.length < 3) continue;
      var ptsRefs = [];
      var mappedPoly = polygonPoints(poly);
      for (var pi = 0; pi < mappedPoly.length; pi++) ptsRefs.push(pt2(mappedPoly[pi][0], mappedPoly[pi][1]));
      ptsRefs.push(ptsRefs[0]);
      var pl = add('IFCPOLYLINE((' + ptsRefs.join(',') + '))');
      var prof2 = add('IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,' + pl + ')');
      var z0 = sl.type === 'ceiling' ? vertical(sl.level) : (vertical(sl.level) - sl.thickness);
      var sPlc = add('IFCAXIS2PLACEMENT3D(' + pt3(0, 0, z0) + ',' + dir3(0, 0, 1) + ',' + dir3(1, 0, 0) + ')');
      var sSolid = add('IFCEXTRUDEDAREASOLID(' + prof2 + ',' + sPlc + ',' + dir3(0, 0, 1) + ',' + fnum(sl.thickness) + ')');
      var sShp = add('IFCSHAPEREPRESENTATION(' + ctx + ',\'Body\',\'SweptSolid\',(' + sSolid + '))');
      var sPds = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + sShp + '))');
      var slLP = add('IFCLOCALPLACEMENT(' + sLP + ',' + wcs + ')');
      var predefined = sl.type === 'ceiling' ? '.ROOF.' : '.FLOOR.';
      var slab = add('IFCSLAB(' + G() + ',$,\'' + (sl.type === 'ceiling' ? 'Потолок' : 'Пол') + '\',$,$,' + slLP + ',' + sPds + ',$,' + predefined + ')');
      products.push(slab);
    }
    // трубы/MEP (v1160) — круглый профиль, экструзия вдоль оси; IfcPipeSegment.
    for (var pp = 0; pp < pipes.length; pp++) {
      var pipe = pipes[pp];
      var pipeA = planPoint(pipe.a[0], pipe.a[1]), pipeB = planPoint(pipe.b[0], pipe.b[1]);
      var pax = pipeB[0] - pipeA[0], paz = pipeB[1] - pipeA[1], plen = Math.hypot(pax, paz) || 1e-3;
      var pdir = [pax / plen, paz / plen];
      var cProfPlc = add('IFCAXIS2PLACEMENT2D(' + pt2(0, 0) + ',' + dir2(1, 0) + ')');
      var cProf = add('IFCCIRCLEPROFILEDEF(.AREA.,$,' + cProfPlc + ',' + fnum(Math.max(pipe.radius, 1e-3)) + ')');
      // ось экструзии в плане (IFC X,Y), труба горизонтальна на высоте pipe.y
      var pPlc = add('IFCAXIS2PLACEMENT3D(' + pt3(pipeA[0], pipeA[1], vertical(pipe.y)) + ',' + dir3(pdir[0], pdir[1], 0) + ',' + dir3(0, 0, 1) + ')');
      var pSolid = add('IFCEXTRUDEDAREASOLID(' + cProf + ',' + pPlc + ',' + dir3(0, 0, 1) + ',' + fnum(plen) + ')');
      var pShp = add('IFCSHAPEREPRESENTATION(' + ctx + ',\'Body\',\'SweptSolid\',(' + pSolid + '))');
      var pPds = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + pShp + '))');
      var pLP = add('IFCLOCALPLACEMENT(' + sLP + ',' + wcs + ')');
      var pipeName = 'Труба ' + (pp + 1) + (pipe.dn ? ' ' + pipe.dn : '') + (pipe.material ? ' (' + pipe.material + ')' : '');
      var pipeProd = add('IFCPIPESEGMENT(' + G() + ',$,\'' + pipeName + '\',$,$,' + pLP + ',' + pPds + ',$,$)');
      products.push(pipeProd);
    }
    // балки (v1161) — прямоугольный профиль, экструзия вдоль оси; IfcBeam.
    for (var bm = 0; bm < beams.length; bm++) {
      var bmw = beams[bm];
      var beamA = planPoint(bmw.a[0], bmw.a[1]), beamB = planPoint(bmw.b[0], bmw.b[1]);
      var bax = beamB[0] - beamA[0], baz = beamB[1] - beamA[1], blen = Math.hypot(bax, baz) || 1e-3;
      var bdir = [bax / blen, baz / blen];
      var bProfPlc = add('IFCAXIS2PLACEMENT2D(' + pt2(0, 0) + ',' + dir2(1, 0) + ')');
      var bProf = add('IFCRECTANGLEPROFILEDEF(.AREA.,$,' + bProfPlc + ',' + fnum(Math.max(bmw.depth, 1e-3)) + ',' + fnum(Math.max(bmw.width, 1e-3)) + ')');
      var bPlc = add('IFCAXIS2PLACEMENT3D(' + pt3(beamA[0], beamA[1], vertical(bmw.y)) + ',' + dir3(bdir[0], bdir[1], 0) + ',' + dir3(0, 0, 1) + ')');
      var bSolid = add('IFCEXTRUDEDAREASOLID(' + bProf + ',' + bPlc + ',' + dir3(0, 0, 1) + ',' + fnum(blen) + ')');
      var bShp = add('IFCSHAPEREPRESENTATION(' + ctx + ',\'Body\',\'SweptSolid\',(' + bSolid + '))');
      var bPds = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + bShp + '))');
      var bLP = add('IFCLOCALPLACEMENT(' + sLP + ',' + wcs + ')');
      var beamProd = add('IFCBEAM(' + G() + ',$,\'Балка ' + (bm + 1) + '\',$,$,' + bLP + ',' + bPds + ',$,$)');
      products.push(beamProd);
    }
    // объекты/оборудование (v1160) — прокси-параллелепипеды IfcBuildingElementProxy
    var objects = model.objects || [];
    for (var ob = 0; ob < objects.length; ob++) {
      var obj = objects[ob];
      var objectPlan = planPoint(obj.cx, obj.cz);
      var oProfPlc = add('IFCAXIS2PLACEMENT2D(' + pt2(0, 0) + ',' + dir2(1, 0) + ')');
      var oProf = add('IFCRECTANGLEPROFILEDEF(.AREA.,$,' + oProfPlc + ',' + fnum(Math.max(obj.hx * 2, 1e-3)) + ',' + fnum(Math.max(obj.hz * 2, 1e-3)) + ')');
      var oPlc = add('IFCAXIS2PLACEMENT3D(' + pt3(objectPlan[0], objectPlan[1], vertical(obj.cy - obj.hy)) + ',' + dir3(0, 0, 1) + ',' + dir3(1, 0, 0) + ')');
      var oSolid = add('IFCEXTRUDEDAREASOLID(' + oProf + ',' + oPlc + ',' + dir3(0, 0, 1) + ',' + fnum(Math.max(obj.hy * 2, 1e-3)) + ')');
      var oShp = add('IFCSHAPEREPRESENTATION(' + ctx + ',\'Body\',\'SweptSolid\',(' + oSolid + '))');
      var oPds = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + oShp + '))');
      var oLP = add('IFCLOCALPLACEMENT(' + sLP + ',' + wcs + ')');
      var oprod;
      if (obj.kind === 'column') oprod = add('IFCCOLUMN(' + G() + ',$,\'Колонна ' + (ob + 1) + '\',$,$,' + oLP + ',' + oPds + ',$,$)');
      else oprod = add('IFCBUILDINGELEMENTPROXY(' + G() + ',$,\'Объект ' + (ob + 1) + '\',$,$,' + oLP + ',' + oPds + ',$,.NOTDEFINED.)');
      products.push(oprod);
    }
    if (products.length) add('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + G() + ',$,$,$,(' + products.join(',') + '),' + storey + ')');

    var now = new Date().toISOString();
    var header = [
      'ISO-10303-21;', 'HEADER;',
      "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
      "FILE_NAME('" + (meta.name || 'scan2bim.ifc') + "','" + now + "',(''),(''),'BIM-Twin Scan2BIM v1164','BIM-Twin','');",
      "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;'
    ].join('\n');
    return header + '\n' + L.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  // ---------- OBJ (быстрый просмотр) ----------
  function toOBJ(model) {
    model = model || {}; var V = [], F = [], base = 1;
    function box(cx, cy, cz, ax, ay, hx, hy, hz) {
      // локальные оси: along=(ax,0,ay), up=(0,1,0), norm=(-ay,0,ax)
      var nx = -ay, nz = ax;
      var corners = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
      for (var c = 0; c < 8; c++) {
        var sxx = corners[c][0] * hx, syy = corners[c][1] * hy, szz = corners[c][2] * hz;
        var x = cx + ax * sxx + nx * szz, y = cy + syy, z = cz + ay * sxx + nz * szz;
        V.push('v ' + x.toFixed(5) + ' ' + y.toFixed(5) + ' ' + z.toFixed(5));
      }
      var q = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];
      for (var f = 0; f < q.length; f++) { var a = q[f]; F.push('f ' + (base + a[0]) + ' ' + (base + a[1]) + ' ' + (base + a[2])); F.push('f ' + (base + a[0]) + ' ' + (base + a[2]) + ' ' + (base + a[3])); }
      base += 8;
    }
    // v1160: прямой призма-цилиндр (труба) между двумя 3D-точками
    function tube(a3, b3, r, sides) {
      sides = sides || 8;
      var ax = b3[0] - a3[0], ay = b3[1] - a3[1], az = b3[2] - a3[2], len = Math.hypot(ax, ay, az) || 1e-6;
      var ux = ax / len, uy = ay / len, uz = az / len;
      // два перпендикуляра к оси
      var ref = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      var e1x = uy * ref[2] - uz * ref[1], e1y = uz * ref[0] - ux * ref[2], e1z = ux * ref[1] - uy * ref[0];
      var e1l = Math.hypot(e1x, e1y, e1z) || 1; e1x /= e1l; e1y /= e1l; e1z /= e1l;
      var e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
      var ring = base;
      for (var end = 0; end < 2; end++) {
        var ctr = end === 0 ? a3 : b3;
        for (var s = 0; s < sides; s++) {
          var th = (s / sides) * Math.PI * 2, cs = Math.cos(th) * r, sn = Math.sin(th) * r;
          V.push('v ' + (ctr[0] + e1x * cs + e2x * sn).toFixed(5) + ' ' + (ctr[1] + e1y * cs + e2y * sn).toFixed(5) + ' ' + (ctr[2] + e1z * cs + e2z * sn).toFixed(5));
        }
      }
      for (var s2 = 0; s2 < sides; s2++) {
        var n2 = (s2 + 1) % sides;
        var p0 = ring + s2, p1 = ring + n2, p2 = ring + sides + n2, p3 = ring + sides + s2;
        F.push('f ' + p0 + ' ' + p1 + ' ' + p2); F.push('f ' + p0 + ' ' + p2 + ' ' + p3);
      }
      base += sides * 2;
    }
    var walls = model.walls || [];
    for (var i = 0; i < walls.length; i++) {
      var segs = wallSegments(walls[i]);
      for (var sgi = 0; sgi < segs.length; sgi++) {
        var sg = segs[sgi]; if (sg.hlen <= 1e-4 || sg.height <= 1e-4) continue;
        var d = norm2(sg.dir);
        box(sg.cx, sg.base + sg.height / 2, sg.cz, d[0], d[1], sg.hlen, sg.height / 2, sg.thk / 2);
      }
    }
    var slabs = model.slabs || [];
    for (var s = 0; s < slabs.length; s++) {
      var sl = slabs[s], poly = sl.polygon || []; if (poly.length < 3) continue;
      var minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (var p = 0; p < poly.length; p++) { minx = Math.min(minx, poly[p][0]); maxx = Math.max(maxx, poly[p][0]); minz = Math.min(minz, poly[p][1]); maxz = Math.max(maxz, poly[p][1]); }
      var cy = sl.type === 'ceiling' ? sl.level + sl.thickness / 2 : sl.level - sl.thickness / 2;
      box((minx + maxx) / 2, cy, (minz + maxz) / 2, 1, 0, (maxx - minx) / 2, sl.thickness / 2, (maxz - minz) / 2);
    }
    var pipes = model.pipes || [];
    for (var pp = 0; pp < pipes.length; pp++) {
      var pi2 = pipes[pp];
      tube([pi2.a[0], pi2.y, pi2.a[1]], [pi2.b[0], pi2.y, pi2.b[1]], pi2.radius, 8);
    }
    // v1178: kabeli - tonkie kruglye tuby, svisayut vertikalno ot potolka
    var cables = model.cables || [];
    for (var cbi = 0; cbi < cables.length; cbi++) {
      var cbl = cables[cbi];
      tube([cbl.x, cbl.yTop, cbl.z], [cbl.x, cbl.yBot, cbl.z], cbl.radius || 0.012, 6);
    }
    // v1161: балки — прямоугольные короба вдоль оси
    var beams = model.beams || [];
    for (var bm = 0; bm < beams.length; bm++) {
      var bmw = beams[bm];
      var bax = bmw.b[0] - bmw.a[0], baz = bmw.b[1] - bmw.a[1], blen = Math.hypot(bax, baz) || 1e-6;
      var bdir = [bax / blen, baz / blen];
      box((bmw.a[0] + bmw.b[0]) / 2, bmw.y, (bmw.a[1] + bmw.b[1]) / 2, bdir[0], bdir[1], blen / 2, bmw.depth / 2, bmw.width / 2);
    }
    // v1160: объекты/оборудование — прокси-параллелепипеды
    var objects = model.objects || [];
    for (var oo = 0; oo < objects.length; oo++) {
      var ob = objects[oo];
      box(ob.cx, ob.cy, ob.cz, 1, 0, ob.hx, ob.hy, ob.hz);
    }
    return '# BIM-Twin Scan2BIM v1164\n' + V.join('\n') + '\n' + F.join('\n') + '\n';
  }

  // ---------- DXF (план) ----------
  function toDXF(model, options) {
    model = model || {}; options = options || {};
    var walls = model.walls || [], foot = model.footprint || [], pipes = model.pipes || [], beams = model.beams || [];
    // v1217: таблица слоёв с ACI-цветами (как у профильных DXF-экспортёров) —
    // без неё все слои открываются в CAD одним и тем же цветом по умолчанию.
    // Формат — минимальный R12-совместимый (без handle/subclass из R13+),
    // соответствует остальной части файла, где HEADER/TABLES не требуются
    // (Autodesk DXF Reference: неопределённые слои иначе создаются автоматически
    // с цветом 7 и типом линии CONTINUOUS).
    var LAYER_ACI = { WALLS: 7, OPENINGS: 2, PIPES: 5, CABLES: 6, BEAMS: 1, OBJECTS: 3, FOOTPRINT: 4 };
    var planOnly = options.planOnly === true;
    var includeCandidates = options.includeCandidates !== false;
    var layerNames = planOnly ? ['WALLS', 'OPENINGS', 'OBJECTS', 'FOOTPRINT'] : Object.keys(LAYER_ACI);
    var L = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layerNames.length)];
    layerNames.forEach(function (nm) {
      L.push('0', 'LAYER', '2', nm, '70', '64', '62', String(LAYER_ACI[nm]), '6', 'CONTINUOUS');
    });
    L.push('0', 'ENDTAB', '0', 'ENDSEC');
    L.push('0', 'SECTION', '2', 'ENTITIES');
    function mapPlan(p) {
      if (typeof options.planTransform !== 'function') return p;
      var q = options.planTransform(p.slice());
      if (!q || !isFinite(q[0]) || !isFinite(q[1])) throw new Error('Некорректное преобразование плановых координат DXF');
      return q;
    }
    function pushLine(layer, a, b) {
      var pa = mapPlan(a), pb = mapPlan(b);
      L.push('0', 'LINE', '8', layer, '10', pa[0].toFixed(4), '20', pa[1].toFixed(4), '30', '0.0',
        '11', pb[0].toFixed(4), '21', pb[1].toFixed(4), '31', '0.0');
    }
    function pushPoint(layer, p) {
      var q = mapPlan(p);
      L.push('0', 'POINT', '8', layer, '10', q[0].toFixed(4), '20', q[1].toFixed(4), '30', '0.0');
    }
    walls.forEach(function (w) {
      pushLine('WALLS', w.a, w.b);
    });
    // v1160: проёмы (двери/окна) отдельным слоём
    walls.forEach(function (w) {
      var dir = norm2(w.dir), ops = w.openings || [];
      ops.forEach(function (o) {
        var s = o.along, e = o.along + o.width;
        var ax = w.a[0] + dir[0] * s, az = w.a[1] + dir[1] * s, bx = w.a[0] + dir[0] * e, bz = w.a[1] + dir[1] * e;
        pushLine('OPENINGS', [ax, az], [bx, bz]);
      });
    });
    if (!planOnly && includeCandidates) {
      pipes.forEach(function (p) { pushLine('PIPES', p.a, p.b); });
      (model.cables || []).forEach(function (c) { pushPoint('CABLES', [c.x, c.z]); });
      beams.forEach(function (b) { pushLine('BEAMS', b.a, b.b); });
    }
    (model.objects || []).forEach(function (ob) {
      var x0 = ob.cx - ob.hx, x1 = ob.cx + ob.hx, z0 = ob.cz - ob.hz, z1 = ob.cz + ob.hz;
      var r = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      for (var i = 0; i < 4; i++) pushLine('OBJECTS', r[i], r[(i + 1) % 4]);
    });
    for (var i = 0; i < foot.length; i++) {
      var a = foot[i], b = foot[(i + 1) % foot.length];
      pushLine('FOOTPRINT', a, b);
    }
    L.push('0', 'ENDSEC', '0', 'EOF');
    return L.join('\n');
  }

  var API = {
    reconstruct: reconstruct, toIFC: toIFC, toOBJ: toOBJ, toDXF: toDXF,
    voxelDownsample: voxelDownsample, detectLevels: detectLevels, hull2d: hull2d, polyArea: polyArea,
    version: '1231'
  };
  if (typeof window !== 'undefined') window.Scan2BIM = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
