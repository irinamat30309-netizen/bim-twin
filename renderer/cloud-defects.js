/*
 * cloud-defects.js — выравнивание облака по стенам, местные дефекты пола и стен, проёмы с высотами (ревизия 32).
 *
 * Выравнивание: мобильный сканер может быть наклонён на доли градуса (дрейф датчика наклона). Для вертикальной стены с нормалью n
 * наклон облака t (мм/м, на сколько верх смещён относительно низа на метр высоты) даёт кажущийся завал c = t·n. По всем стенам
 * t находится взвешенным МНК с весами Хьюбера (вес — длина × высота × покрытие; грани с завалом больше 15 мм/м — не стены).
 * Стены в одном направлении задают только составляющую вдоль своей нормали — вторая тогда не меняется. Поправка: завал стены
 * c − t·n, высота пола z + t·(u, v) (поворот облака малый, плоскости остаются плоскостями).
 * Дефекты: отклонение клетки (10 см) от местной средней в окне 1 м (две итерации, выступы и впадины не тянут среднюю), связные
 * области больше допуска и площади — бугры и впадины пола, выступы и впадины стен; на стенах — по сглаженной карте остатков.
 * Проёмы: по каждому проёму плана — сетка «вдоль × высота» точек в плоскости стены; пустые строки снизу — дверь (высота — до первой
 * заполненной строки сверху), пустые строки выше заполненных — окно (подоконник и верх), без заполненных строк над проёмом —
 * проём до верха проверки, без пустых строк — закрыт (дверь, стекло).
 *
 *   levelFromWalls(walls) → { u, v, mm, deg, az, n, se, ok, significant }   applyLevelWalls(wallRep, t, tol) · levelFloorGrid(grid, t)
 *   defectsGrid(values, nx, ny, { cell, win, tol, minArea }) → { list }
 *   floorDefects(grid, { tol, sec, rooms }) · wallDefects(wall, sm, { tol }) · openingFaces(openings) · openingReport(acc, opts)
 * Чистые функции (UMD: window.CloudDefects, module.exports).
 */
(function (root, factory) {
  'use strict';
  var CI = root && root.CloudInspect ? root.CloudInspect : (typeof require === 'function' ? require('./cloud-inspect.js') : null);
  var api = factory(CI);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudDefects = api;
})(typeof window !== 'undefined' ? window : null, function (CI) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function median(a) { if (!a.length) return NaN; var s = Float64Array.from(a).sort(); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

  // ------------------------------------------------------------------ выравнивание по стенам
  function levelFromWalls(walls, o) {
    o = o || {};
    var L = [], maxC = o.maxPlumb || 15;
    (walls || []).forEach(function (w) {
      if (!(w.plumbS === w.plumbS) || !w.n || Math.abs(w.plumbS) > maxC || !(w.length > 0) || !(w.height > 0)) return;
      L.push({ c: w.plumbS, nx: w.n[0], ny: w.n[1], w: w.length * w.height * clamp(w.cover || 1, 0.2, 1) });
    });
    var res = { u: 0, v: 0, mm: 0, deg: 0, az: NaN, n: L.length, se: NaN, ok: false, significant: false, dirs: 0 };
    if (L.length < (o.minWalls || 6)) { res.message = 'мало стен для выравнивания'; return res; }
    // направления: собственные числа Σ w n nᵀ
    var Sxx = 0, Sxy = 0, Syy = 0, SW = 0;
    L.forEach(function (x) { Sxx += x.w * x.nx * x.nx; Sxy += x.w * x.nx * x.ny; Syy += x.w * x.ny * x.ny; SW += x.w; });
    var tr = Sxx + Syy, det = Sxx * Syy - Sxy * Sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det)), l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    var e1 = Math.abs(Sxy) > 1e-12 ? [l1 - Syy, Sxy] : (Sxx >= Syy ? [1, 0] : [0, 1]), e1n = Math.hypot(e1[0], e1[1]); e1 = [e1[0] / e1n, e1[1] / e1n];
    var e2 = [-e1[1], e1[0]], two = l2 / Math.max(1e-12, l1) >= (o.minRatio || 0.08);
    res.dirs = two ? 2 : 1;
    // IRLS Хьюбера в базисе (e1, e2); при одном направлении — только вдоль e1
    var a1 = 0, a2 = 0, k = o.huber || 1.5;
    for (var it = 0; it < 8; it++) {
      var A11 = 0, A12 = 0, A22 = 0, B1 = 0, B2 = 0;
      L.forEach(function (x) {
        var p1 = x.nx * e1[0] + x.ny * e1[1], p2 = x.nx * e2[0] + x.ny * e2[1], r = x.c - (a1 * p1 + (two ? a2 * p2 : 0)), hw = Math.abs(r) <= k ? 1 : k / Math.abs(r), ww = x.w * hw;
        A11 += ww * p1 * p1; A12 += ww * p1 * p2; A22 += ww * p2 * p2; B1 += ww * p1 * x.c; B2 += ww * p2 * x.c;
      });
      if (two) { var D = A11 * A22 - A12 * A12; if (Math.abs(D) < 1e-12) break; a1 = (B1 * A22 - B2 * A12) / D; a2 = (A11 * B2 - A12 * B1) / D; }
      else { if (A11 < 1e-12) break; a1 = B1 / A11; a2 = 0; }
    }
    var u = a1 * e1[0] + a2 * e2[0], v = a1 * e1[1] + a2 * e2[1];
    // разброс остатков → погрешность (эффективное число стен по весам)
    var rr = [], W2 = 0; L.forEach(function (x) { rr.push(Math.abs(x.c - (u * x.nx + v * x.ny))); W2 += x.w * x.w; });
    var nEff = SW * SW / Math.max(1e-12, W2), sd = 1.4826 * median(rr);
    res.u = u; res.v = v; res.mm = Math.hypot(u, v); res.deg = Math.atan(res.mm / 1000) * 180 / Math.PI;
    res.az = res.mm > 0 ? Math.atan2(v, u) * 180 / Math.PI : NaN; res.se = sd / Math.sqrt(Math.max(1, nEff)) * (two ? 1.4142 : 1);
    res.spread = sd; res.ok = true; res.significant = res.mm >= Math.max(o.minTilt || 0.3, 2 * res.se);
    return res;
  }
  // поправка стен: завал c − t·n; модуль, «на высоту», «в помещение / наружу», допуски
  function applyLevelWalls(wr, t, tol) {
    if (!wr || !wr.walls || !t) return wr;
    tol = tol || wr.tol || {};
    var tolM = tol.plumbPerM != null ? tol.plumbPerM : 2, tolH = tol.plumbMax != null ? tol.plumbMax : 10;
    wr.walls.forEach(function (w) {
      if (!(w.plumbS === w.plumbS) || !w.n) return;
      if (w.plumbRaw == null) w.plumbRaw = w.plumbS;
      var c = w.plumbRaw - (t.u * w.n[0] + t.v * w.n[1]);
      w.plumbS = c; w.plumb = Math.abs(c); w.lean = Math.abs(c) * w.height;
      if (w.side) w.toward = w.side * c > 0 ? 'room' : 'out';
      w.okPlumb = w.plumb <= tolM && w.lean <= tolH; w.ok = w.okPlumb && w.okRail;
    });
    wr.bad = wr.walls.filter(function (w) { return !w.ok; }).length;
    wr.leveled = { u: t.u, v: t.v, mm: Math.hypot(t.u, t.v) };
    return wr;
  }
  // поправка сетки высот пола: z + t·(p − центр), мм/м → м/м
  function levelFloorGrid(g, t) {
    if (!g || !t) return g;
    var uc = g.u0 + g.nx * g.cell / 2, vc = g.v0 + g.ny * g.cell / 2, au = t.u / 1000, av = t.v / 1000;
    for (var y = 0; y < g.ny; y++) for (var x = 0; x < g.nx; x++) {
      var k = y * g.nx + x; if (g.z[k] !== g.z[k]) continue;
      g.z[k] += au * (g.u0 + (x + 0.5) * g.cell - uc) + av * (g.v0 + (y + 0.5) * g.cell - vc);
    }
    g.leveled = { u: t.u, v: t.v };
    return g;
  }

  // ------------------------------------------------------------------ местные дефекты по сетке
  function boxMean(val, use, nx, ny, R) {
    var W1 = nx + 1, S = new Float64Array(W1 * (ny + 1)), C = new Int32Array(W1 * (ny + 1)), out = new Float32Array(nx * ny).fill(NaN);
    for (var y = 0; y < ny; y++) {
      var rs = 0, rc = 0;
      for (var x = 0; x < nx; x++) {
        var k = y * nx + x; if (use[k]) { rs += val[k]; rc++; }
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs; C[(y + 1) * W1 + x + 1] = C[y * W1 + x + 1] + rc;
      }
    }
    for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
      var x0 = Math.max(0, x - R), x1 = Math.min(nx, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(ny, y + R + 1);
      var c = C[y1 * W1 + x1] - C[y0 * W1 + x1] - C[y1 * W1 + x0] + C[y0 * W1 + x0];
      if (c >= Math.max(4, (2 * R + 1) * (2 * R + 1) * 0.15)) out[y * nx + x] = (S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0]) / c;
    }
    return out;
  }
  function defectsGrid(val, nx, ny, o) {
    o = o || {};
    var N = nx * ny, cell = o.cell || 0.1, R = Math.max(2, Math.round((o.win || 1) / cell / 2)), tol = o.tol || 5, minCells = Math.max(2, Math.ceil((o.minArea || 0.04) / (cell * cell)));
    var use = new Uint8Array(N), k;
    for (k = 0; k < N; k++) use[k] = val[k] === val[k] ? 1 : 0;
    var ref = boxMean(val, use, nx, ny, R);
    for (k = 0; k < N; k++) if (use[k] && ref[k] === ref[k] && Math.abs(val[k] - ref[k]) > tol * 0.7) use[k] = 0;
    ref = boxMean(val, use, nx, ny, R);
    var dev = new Float32Array(N).fill(NaN), over = 0, valid = 0;
    for (k = 0; k < N; k++) if (val[k] === val[k] && ref[k] === ref[k]) { dev[k] = val[k] - ref[k]; valid++; if (Math.abs(dev[k]) > tol) over++; }
    var lab = new Int32Array(N), list = [], stack = [];
    for (k = 0; k < N; k++) {
      if (lab[k] || !(Math.abs(dev[k]) > tol)) continue;
      var sg = dev[k] > 0 ? 1 : -1, cells = 0, sx = 0, sy = 0, sw = 0, depth = 0, vol = 0, x0 = nx, x1 = -1, y0 = ny, y1 = -1, id = list.length + 1;
      stack.length = 0; stack.push(k); lab[k] = id;
      while (stack.length) {
        var q = stack.pop(), qx = q % nx, qy = (q - qx) / nx, d = Math.abs(dev[q]);
        cells++; sx += qx * d; sy += qy * d; sw += d; vol += (d - tol * 0.5) * cell * cell; if (d > depth) depth = d;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        var nb = [qx > 0 ? q - 1 : -1, qx < nx - 1 ? q + 1 : -1, qy > 0 ? q - nx : -1, qy < ny - 1 ? q + nx : -1];
        for (var j = 0; j < 4; j++) { var p = nb[j]; if (p < 0 || lab[p]) continue; if (dev[p] * sg > tol) { lab[p] = id; stack.push(p); } }
      }
      list.push({ sign: sg, cells: cells, area: cells * cell * cell, depth: depth, volume: vol * 1, cx: sx / sw, cy: sy / sw, x0: x0, x1: x1, y0: y0, y1: y1, keep: cells >= minCells });
    }
    var kept = list.filter(function (d) { return d.keep; });
    kept.forEach(function (d) { delete d.keep; });
    kept.sort(function (a, b) { return b.depth * Math.sqrt(b.area) - a.depth * Math.sqrt(a.area); });
    return { list: kept.slice(0, o.max || 200), total: kept.length, over: valid ? over / valid : 0, valid: valid, tol: tol, win: R * 2 * cell + cell };
  }

  // пол: значения — высоты клеток пола (мм), предметы (flag 2) не участвуют
  function floorDefects(g, o) {
    o = o || {};
    var N = g.nx * g.ny, val = new Float32Array(N).fill(NaN), nx = g.nx, ny = g.ny;
    // клетки пола без предметов рядом: край предмета (провод, коврик, мусор) поднимает соседние клетки и выглядит как бугор
    for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
      var k = y * nx + x; if (g.flag[k] !== 1) continue; var near = false;
      for (var dy = -1; dy <= 1 && !near; dy++) for (var dx = -1; dx <= 1; dx++) { var X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < nx && Y < ny && g.flag[Y * nx + X] === 2) { near = true; break; } }
      if (!near) val[k] = g.z[k] * 1000;
    }
    var r = defectsGrid(val, g.nx, g.ny, { cell: g.cell, win: o.win || 1, tol: o.tol || 5, minArea: o.minArea || 0.04, max: o.max || 150 });
    var sec = o.sec || null, rooms = o.rooms || [];
    r.list.forEach(function (d) {
      d.u = g.u0 + (d.cx + 0.5) * g.cell; d.v = g.v0 + (d.cy + 0.5) * g.cell;
      // выше objTol (15 мм) над местной средней — скорее предмет на полу, чем бугор стяжки
      d.kind = d.sign > 0 ? (d.depth > (o.objMax || 15) ? 'object' : 'bump') : 'dip';
      if (sec) { var id = sec[Math.round(d.cy) * g.nx + Math.round(d.cx)]; if (id > 0 && rooms[id - 1]) d.room = rooms[id - 1].name; }
      d.size = [(d.x1 - d.x0 + 1) * g.cell, (d.y1 - d.y0 + 1) * g.cell];
    });
    var objs = r.list.filter(function (d) { return d.kind === 'object'; });
    r.list = r.list.filter(function (d) { return d.kind !== 'object'; });
    r.objects = objs.length; r.total -= objs.length;
    return r;
  }
  // стена: сглаженные остатки от плоскости (мм, вдоль нормали грани); выступ — в сторону помещения (если сторона известна)
  function wallDefects(w, sm, o) {
    o = o || {};
    var G = w.grid, nt = G.nt, nh = G.nh, val = new Float32Array(nt * nh).fill(NaN);
    // сетка стены хранится «столбец за столбцом» (it·nh + ih) — переставляем в строки (ih·nt + it)
    for (var it = 0; it < nt; it++) for (var ih = 0; ih < nh; ih++) { var q = sm[it * nh + ih]; if (q === q) val[ih * nt + it] = q; }
    var r = defectsGrid(val, nt, nh, { cell: G.cellT, win: o.win || 1, tol: o.tol || 5, minArea: o.minArea || 0.04, max: o.max || 30 });
    var L = w.length, dx = (w.b[0] - w.a[0]) / L, dy = (w.b[1] - w.a[1]) / L;
    r.list.forEach(function (d) {
      d.t = (d.cx + 0.5) * G.cellT; d.h = (d.cy + 0.5) * G.cellH;
      d.u = w.a[0] + dx * d.t; d.v = w.a[1] + dy * d.t;
      d.kind = w.side ? (d.sign * w.side > 0 ? 'bulge' : 'dip') : 'uneven';
      d.size = [(d.x1 - d.x0 + 1) * G.cellT, (d.y1 - d.y0 + 1) * G.cellH];
    });
    return r;
  }

  // ------------------------------------------------------------------ проёмы с высотами
  function openingFaces(openings, o) {
    o = o || {};
    return (openings || []).map(function (p) {
      var L = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]); if (!(L >= (o.minWidth || 0.4))) return null;
      return { a: p.a, b: p.b, width: p.width || L, length: L };
    }).filter(Boolean);
  }
  function openingReport(acc, o) {
    o = o || {};
    if (!acc || !acc.faces) return { ok: false, list: [] };
    var nh = acc.nh, nb = acc.nb, cH = acc.cellH, pk = { pos: 0, sd: 0, n: 0 }, out = [];
    var peak = CI && CI._peak;
    acc.faces.forEach(function (f) {
      var nt = f.nt, a0 = nt >= 4 ? 1 : 0, a1 = nt >= 4 ? nt - 1 : nt, inner = a1 - a0, fill = new Float32Array(nh);
      for (var ih = 0; ih < nh; ih++) {
        var c = 0; for (var it = a0; it < a1; it++) if (peak(acc.bins, f.off + (it * nh + ih) * nb, nb, 0, o.minPts || 4, pk)) c++;
        fill[ih] = inner ? c / inner : 0;
      }
      var empty = function (i) { return fill[i] < (o.emptyFill || 0.35); }, full = function (i) { return fill[i] >= (o.fullFill || 0.7); };
      // строка 0 (0–10 см) не участвует: край пола и порог часто пусты и у окон
      var e0 = -1; for (ih = 1; ih < nh; ih++) if (empty(ih)) { e0 = ih; break; }
      var rec = { face: f.i, a: f.a, b: f.b, width: f.L, fill: Array.from(fill, function (x) { return Math.round(x * 100) / 100; }) };
      if (e0 < 0) { rec.kind = 'closed'; out.push(rec); return; }
      var e1 = -1; for (ih = e0 + 1; ih < nh; ih++) if (full(ih) && (ih + 1 >= nh || full(ih + 1))) { e1 = ih; break; }
      var bottom = e0 * cH, door = bottom <= (o.doorSill || 0.25);
      rec.kind = door ? 'door' : 'window';
      rec.sill = door ? 0 : bottom;
      rec.head = e1 >= 0 ? e1 * cH : null;
      rec.height = rec.head != null ? rec.head - rec.sill : null;
      if (rec.head == null) rec.open = true;   // над проёмом нет стены до верха проверки (арка, проход, не снят)
      out.push(rec);
    });
    return { ok: true, list: out, doors: out.filter(function (x) { return x.kind === 'door'; }).length, windows: out.filter(function (x) { return x.kind === 'window'; }).length };
  }

  return { levelFromWalls: levelFromWalls, applyLevelWalls: applyLevelWalls, levelFloorGrid: levelFloorGrid, defectsGrid: defectsGrid, floorDefects: floorDefects,
    wallDefects: wallDefects, openingFaces: openingFaces, openingReport: openingReport, _boxMean: boxMean };
});
