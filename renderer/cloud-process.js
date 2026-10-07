/* cloud-process.js — v1160
 * Обработка облаков точек «как в Lixel»: сглаживание, выравнивание поверхностей, подавление шума, ресэмплирование.
 * Чистые функции над типизированными массивами; работают и в окне, и в Web Worker (UMD: window/self.CloudProcess, module.exports).
 * Все алгоритмы линейные по числу точек: сетка ячеек (плотный массив или хеш с открытой адресацией), моменты по ячейкам,
 * плоскость по 3x3x3 соседям. Никаких Map со строковыми ключами и вложенных массивов — на десятках миллионов точек это не работает.
 * Прогресс: ctl.progress(доля 0..1, подпись). Отмена — terminate() воркера (см. cloud-process-worker.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CloudProcess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DENSE_LIMIT = 24e6;          // ячеек в плотной сетке (Int32 = 96 МБ); больше — хеш
  var TWO_PI_3 = 2.0943951023931953;

  function prog(ctl, f, l) { if (ctl && typeof ctl.progress === 'function') ctl.progress(f, l); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function bounds(pos, n) {
    var a = Infinity, b = Infinity, c = Infinity, d = -Infinity, e = -Infinity, f = -Infinity, ok = 0;
    for (var i = 0, j = 0; i < n; i++, j += 3) {
      var x = pos[j], y = pos[j + 1], z = pos[j + 2];
      if ((x - x) + (y - y) + (z - z) !== 0) continue;
      ok++;
      if (x < a) a = x; if (x > d) d = x;
      if (y < b) b = y; if (y > e) e = y;
      if (z < c) c = z; if (z > f) f = z;
    }
    if (!ok) return null;
    return { mn: [a, b, c], mx: [d, e, f], valid: ok };
  }

  function hash3(ix, iy, iz) {
    var h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return h;
  }

  /** Сетка ячеек со стороной h. cellId[i] — номер ячейки точки (или -1 для нечисловых координат). */
  function buildGrid(pos, n, h, bb, ctl, p0, p1, label) {
    var inv = 1 / h, mn0 = bb.mn[0], mn1 = bb.mn[1], mn2 = bb.mn[2];
    var nx = Math.floor((bb.mx[0] - mn0) * inv) + 1, ny = Math.floor((bb.mx[1] - mn1) * inv) + 1, nz = Math.floor((bb.mx[2] - mn2) * inv) + 1;
    var total = nx * ny * nz;
    if (!(total < 9e15)) throw new Error('Слишком мелкая сетка для такого размера сцены — увеличьте радиус/шаг (в облаке могут быть далёкие точки-выбросы)');
    var dense = total <= DENSE_LIMIT ? new Int32Array(total) : null;
    var cap = 1 << 16, mask = cap - 1, hkeys = null, hids = null;
    if (!dense) { hkeys = new Float64Array(cap).fill(-1); hids = new Int32Array(cap); }
    var ccap = 1 << 14, cx = new Int32Array(ccap), cy = new Int32Array(ccap), cz = new Int32Array(ccap), cells = 0;
    var cellId = new Int32Array(n), lastKey = -1, lastId = -1;
    function growCells() {
      ccap *= 2; var a = new Int32Array(ccap), b = new Int32Array(ccap), c = new Int32Array(ccap);
      a.set(cx); b.set(cy); c.set(cz); cx = a; cy = b; cz = c;
    }
    function growHash() {
      var ncap = cap * 2, nmask = ncap - 1, nk = new Float64Array(ncap).fill(-1), ni = new Int32Array(ncap);
      for (var id = 0; id < cells; id++) {
        var ix = cx[id], iy = cy[id], iz = cz[id], key = (ix * ny + iy) * nz + iz, s = hash3(ix, iy, iz) & nmask;
        while (nk[s] !== -1) s = (s + 1) & nmask;
        nk[s] = key; ni[s] = id;
      }
      cap = ncap; mask = nmask; hkeys = nk; hids = ni;
    }
    var CH = 1 << 20;
    for (var i = 0, j = 0; i < n; i++, j += 3) {
      if ((i & (CH - 1)) === 0 && i) prog(ctl, p0 + (p1 - p0) * (i / n), label);
      var x = pos[j] - mn0, y = pos[j + 1] - mn1, z = pos[j + 2] - mn2;
      if ((x - x) + (y - y) + (z - z) !== 0) { cellId[i] = -1; continue; }
      var ix = (x * inv) | 0, iy = (y * inv) | 0, iz = (z * inv) | 0;
      var key = (ix * ny + iy) * nz + iz, id;
      if (key === lastKey) id = lastId;
      else {
        if (dense) {
          id = dense[key] - 1;
          if (id < 0) { id = cells++; if (id >= ccap) growCells(); cx[id] = ix; cy[id] = iy; cz[id] = iz; dense[key] = id + 1; }
        } else {
          var s = hash3(ix, iy, iz) & mask;
          for (;;) {
            var k = hkeys[s];
            if (k === key) { id = hids[s]; break; }
            if (k === -1) {
              id = cells++; if (id >= ccap) growCells();
              cx[id] = ix; cy[id] = iy; cz[id] = iz; hkeys[s] = key; hids[s] = id;
              if (cells * 2 > cap) growHash();
              break;
            }
            s = (s + 1) & mask;
          }
        }
        lastKey = key; lastId = id;
      }
      cellId[i] = id;
    }
    return { h: h, inv: inv, mn: [mn0, mn1, mn2], nx: nx, ny: ny, nz: nz, cells: cells, cx: cx, cy: cy, cz: cz, cellId: cellId,
      dense: dense, hkeys: hkeys, hids: hids, mask: mask };
  }

  function lookup(G, ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= G.nx || iy >= G.ny || iz >= G.nz) return -1;
    var key = (ix * G.ny + iy) * G.nz + iz;
    if (G.dense) return G.dense[key] - 1;
    var mask = G.mask, hk = G.hkeys, s = hash3(ix, iy, iz) & mask;
    for (;;) {
      var k = hk[s];
      if (k === key) return G.hids[s];
      if (k === -1) return -1;
      s = (s + 1) & mask;
    }
  }

  /** Точки по ячейкам: start[c]..start[c+1] в массиве order. */
  function groupPoints(G, n) {
    var cells = G.cells, cellId = G.cellId, start = new Int32Array(cells + 1), i, id;
    for (i = 0; i < n; i++) { id = cellId[i]; if (id >= 0) start[id + 1]++; }
    for (i = 0; i < cells; i++) start[i + 1] += start[i];
    var fill = new Int32Array(cells), order = new Int32Array(start[cells]);
    for (i = 0; i < n; i++) { id = cellId[i]; if (id >= 0) order[start[id] + fill[id]++] = i; }
    return { start: start, order: order };
  }

  /** Моменты точек по ячейкам относительно угла ячейки: N, Sx, Sy, Sz, Sxx, Sxy, Sxz, Syy, Syz, Szz. */
  function cellMoments(G, pos, n) {
    var M = new Float64Array(G.cells * 10), h = G.h, cellId = G.cellId, cx = G.cx, cy = G.cy, cz = G.cz;
    var m0 = G.mn[0], m1 = G.mn[1], m2 = G.mn[2];
    for (var i = 0, j = 0; i < n; i++, j += 3) {
      var id = cellId[i]; if (id < 0) continue;
      var b = id * 10, x = pos[j] - m0 - cx[id] * h, y = pos[j + 1] - m1 - cy[id] * h, z = pos[j + 2] - m2 - cz[id] * h;
      M[b]++; M[b + 1] += x; M[b + 2] += y; M[b + 3] += z;
      M[b + 4] += x * x; M[b + 5] += x * y; M[b + 6] += x * z; M[b + 7] += y * y; M[b + 8] += y * z; M[b + 9] += z * z;
    }
    return M;
  }

  function addShifted(A, M, b, w, dx, dy, dz) {
    var N = M[b], sx = M[b + 1], sy = M[b + 2], sz = M[b + 3];
    A[0] += w * N; A[1] += w * (sx + N * dx); A[2] += w * (sy + N * dy); A[3] += w * (sz + N * dz);
    A[4] += w * (M[b + 4] + 2 * dx * sx + N * dx * dx);
    A[5] += w * (M[b + 5] + dx * sy + dy * sx + N * dx * dy);
    A[6] += w * (M[b + 6] + dx * sz + dz * sx + N * dx * dz);
    A[7] += w * (M[b + 7] + 2 * dy * sy + N * dy * dy);
    A[8] += w * (M[b + 8] + dy * sz + dz * sy + N * dy * dz);
    A[9] += w * (M[b + 9] + 2 * dz * sz + N * dz * dz);
  }

  /** Собственные значения (по возрастанию в E[0..2]) и вектор наименьшего в E[3..5] симметричной матрицы [[a,b,c],[b,d,e],[c,e,f]]. */
  function eig3(a, b, c, d, e, f, E) {
    var p1 = b * b + c * c + e * e, tr = (a + d + f) / 3;
    var p2 = (a - tr) * (a - tr) + (d - tr) * (d - tr) + (f - tr) * (f - tr) + 2 * p1;
    if (p2 <= 1e-30) { E[0] = E[1] = E[2] = tr; E[3] = 0; E[4] = 0; E[5] = 1; return; }
    var p = Math.sqrt(p2 / 6), ba = (a - tr) / p, bd = (d - tr) / p, bf = (f - tr) / p, bb = b / p, bc = c / p, be = e / p;
    var r = (ba * (bd * bf - be * be) - bb * (bb * bf - be * bc) + bc * (bb * be - bd * bc)) / 2;
    r = r < -1 ? -1 : (r > 1 ? 1 : r);
    var phi = Math.acos(r) / 3;
    var l1 = tr + 2 * p * Math.cos(phi), l3 = tr + 2 * p * Math.cos(phi + TWO_PI_3), l2 = 3 * tr - l1 - l3;
    E[0] = l3 < 0 ? 0 : l3; E[1] = l2; E[2] = l1;
    var m00 = a - l3, m11 = d - l3, m22 = f - l3;
    var x0 = b * e - c * m11, y0 = c * b - m00 * e, z0 = m00 * m11 - b * b, n0 = x0 * x0 + y0 * y0 + z0 * z0;
    var x1 = b * m22 - c * e, y1 = c * c - m00 * m22, z1 = m00 * e - b * c, n1 = x1 * x1 + y1 * y1 + z1 * z1;
    var x2 = m11 * m22 - e * e, y2 = e * c - b * m22, z2 = b * e - m11 * c, n2 = x2 * x2 + y2 * y2 + z2 * z2;
    var vx = x0, vy = y0, vz = z0, nn = n0;
    if (n1 > nn) { vx = x1; vy = y1; vz = z1; nn = n1; }
    if (n2 > nn) { vx = x2; vy = y2; vz = z2; nn = n2; }
    if (nn < 1e-60) { E[3] = 0; E[4] = 0; E[5] = 1; return; }
    var inv = 1 / Math.sqrt(nn); E[3] = vx * inv; E[4] = vy * inv; E[5] = vz * inv;
  }

  /** Плоскость по моментам A: out = [nx,ny,nz, mx,my,mz, rms, sqrt(λ2), N]; false, если точек мало. */
  var _E = new Float64Array(6);
  function fitMoments(A, out) {
    var N = A[0]; if (!(N >= 3)) return false;
    var mx = A[1] / N, my = A[2] / N, mz = A[3] / N;
    eig3(A[4] / N - mx * mx, A[5] / N - mx * my, A[6] / N - mx * mz, A[7] / N - my * my, A[8] / N - my * mz, A[9] / N - mz * mz, _E);
    out[0] = _E[3]; out[1] = _E[4]; out[2] = _E[5]; out[3] = mx; out[4] = my; out[5] = mz;
    out[6] = Math.sqrt(_E[0]); out[7] = Math.sqrt(_E[1] > 0 ? _E[1] : 0); out[8] = N;
    return true;
  }

  function percentile(arr, count, q) {
    if (!count) return 0;
    var sub = arr;
    if (count > 40000) { var st = Math.ceil(count / 40000), m = Math.ceil(count / st); sub = new Float32Array(m); for (var i = 0, k = 0; i < count; i += st) sub[k++] = arr[i]; count = k; sub = sub.subarray(0, count); }
    else sub = arr.slice(0, count);
    sub.sort();
    return sub[Math.min(count - 1, Math.floor(count * q))];
  }

  // ---------------------------------------------------------------- оценки
  /** Грубая оценка шага точек по случайной подвыборке (≈ медиана расстояния до ближайшей, пересчитанная на полное число точек). */
  function estimate(pos, n, ctl) {
    n = n | 0;
    var m = Math.min(n, 20000), st = n / m, sample = new Float32Array(m * 3), i, k;
    for (i = 0, k = 0; i < m; i++) { var s = Math.min(n - 1, Math.floor(i * st)) * 3; var x = pos[s], y = pos[s + 1], z = pos[s + 2]; if ((x - x) + (y - y) + (z - z) !== 0) continue; sample[k * 3] = x; sample[k * 3 + 1] = y; sample[k * 3 + 2] = z; k++; }
    m = k; if (m < 10) return { spacing: 0.02, diag: 1, n: n };
    var q = Math.min(m, 1200), qs = m / q, ds = new Float32Array(q), cnt = 0;
    for (i = 0; i < q; i++) {
      var a = Math.min(m - 1, Math.floor(i * qs)) * 3, ax = sample[a], ay = sample[a + 1], az = sample[a + 2], best = Infinity;
      for (var j = 0; j < m * 3; j += 3) { if (j === a) continue; var dx = sample[j] - ax, dy = sample[j + 1] - ay, dz = sample[j + 2] - az, d = dx * dx + dy * dy + dz * dz; if (d < best && d > 1e-14) best = d; }
      if (best < Infinity) ds[cnt++] = Math.sqrt(best);
    }
    var med = percentile(ds, cnt, 0.5) || 0.02;
    var bb = bounds(sample, m), diag = bb ? Math.hypot(bb.mx[0] - bb.mn[0], bb.mx[1] - bb.mn[1], bb.mx[2] - bb.mn[2]) : 1;
    return { spacing: med * Math.sqrt(m / n), diag: diag, n: n };
  }

  /** Значения по умолчанию для диалогов (шаг округляется до миллиметров). */
  function defaults(est) {
    var sp = est && est.spacing > 0 ? est.spacing : 0.02;
    function r(v, q) { return Math.round(v / q) * q; }
    return {
      spacing: sp,
      smoothRadius: clamp(r(8 * sp, 0.005), 0.03, 0.15),
      flattenTol: 0.03,
      denoiseRadius: clamp(r(16 * sp, 0.05), 0.2, 1),
      denoiseNeighbors: 30,
      voxel: clamp(r(3 * sp, 0.005), 0.005, 0.5)
    };
  }

  // ---------------------------------------------------------------- сглаживание
  var W3 = [1, 0.5, 0.5];   // вес ячейки по |смещению| вдоль оси: 0 → 1; ±1 → 0.5
  /**
   * Сглаживание (подавление шума по поверхности). Каждая точка проецируется на локальную плоскость, подобранную по
   * ячейке радиуса `radius` и её соседям; ячейки с кривизной (рёбра, трубы, углы) не трогаются при protect=true.
   * opt: radius (м), strength 0..1, protect (по умолч. true), inPlace.
   */
  function smooth(pos, n, opt, ctl) {
    opt = opt || {};
    var radius = +opt.radius; if (!(radius > 0)) throw new Error('Радиус поиска должен быть больше нуля');
    var strength = opt.strength == null ? 1 : clamp(+opt.strength, 0, 1), protect = opt.protect !== false;
    var bb = bounds(pos, n); if (!bb) return { pos: pos, moved: 0, count: n, planarCells: 0, cells: 0 };
    prog(ctl, 0.02, 'Разбиение на ячейки…');
    var G = buildGrid(pos, n, radius, bb, ctl, 0.02, 0.3, 'Разбиение на ячейки…');
    prog(ctl, 0.3, 'Моменты ячеек…');
    var M = cellMoments(G, pos, n), cells = G.cells, h = G.h;
    var pl = new Float32Array(cells * 3), pc = new Float64Array(cells * 3), flag = new Uint8Array(cells), rmsA = new Float32Array(cells);
    var A = new Float64Array(10), out = new Float64Array(9), c, nvalid = 0, dx, dy, dz;
    var tmpRms = new Float32Array(cells);
    for (c = 0; c < cells; c++) {
      if ((c & 8191) === 0 && c) prog(ctl, 0.3 + 0.3 * (c / cells), 'Локальные плоскости…');
      A.fill(0);
      var ix = G.cx[c], iy = G.cy[c], iz = G.cz[c];
      for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) {
        var id = (dx | dy | dz) === 0 ? c : lookup(G, ix + dx, iy + dy, iz + dz);
        if (id < 0) continue;
        addShifted(A, M, id * 10, W3[dx < 0 ? -dx : dx] * W3[dy < 0 ? -dy : dy] * W3[dz < 0 ? -dz : dz], dx * h, dy * h, dz * h);
      }
      if (A[0] < 6 || !fitMoments(A, out) || out[7] < 0.2 * h) { flag[c] = 0; continue; }
      pl[c * 3] = out[0]; pl[c * 3 + 1] = out[1]; pl[c * 3 + 2] = out[2];
      pc[c * 3] = ix * h + out[3]; pc[c * 3 + 1] = iy * h + out[4]; pc[c * 3 + 2] = iz * h + out[5];
      rmsA[c] = out[6]; flag[c] = 1; tmpRms[nvalid++] = out[6];
    }
    var sigma = percentile(tmpRms, nvalid, 0.4), thr = protect ? Math.max(2 * sigma, 0.0003) : Infinity, planar = 0;
    for (c = 0; c < cells; c++) if (flag[c]) { if (rmsA[c] <= thr) planar++; else flag[c] = 0; }
    // Проверка выпуклости/вогнутости: у плоской поверхности точки самой ячейки лежат на плоскости соседства в среднем без смещения,
    // у трубы или купола центр ячейки систематически выше (ниже) плоскости. Статистически значимое смещение — ячейка не трогается.
    if (protect) {
      prog(ctl, 0.6, 'Проверка кривизны…');
      var cs = new Float64Array(cells * 3);
      for (var i1 = 0, j1 = 0; i1 < n; i1++, j1 += 3) {
        var c1 = G.cellId[i1]; if (c1 < 0 || !flag[c1]) continue;
        var b1 = c1 * 3, d1 = ((pos[j1] - bb.mn[0]) - pc[b1]) * pl[b1] + ((pos[j1 + 1] - bb.mn[1]) - pc[b1 + 1]) * pl[b1 + 1] + ((pos[j1 + 2] - bb.mn[2]) - pc[b1 + 2]) * pl[b1 + 2];
        cs[b1]++; cs[b1 + 1] += d1; cs[b1 + 2] += d1 * d1;
      }
      for (c = 0; c < cells; c++) {
        if (!flag[c] || cs[c * 3] < 4) continue;
        var cnt1 = cs[c * 3], mean1 = cs[c * 3 + 1] / cnt1, sd1 = Math.sqrt(Math.max(0, cs[c * 3 + 2] / cnt1 - mean1 * mean1));
        if (Math.abs(mean1) > 3 * Math.max(sd1, 0.5 * sigma) / Math.sqrt(cnt1) + 0.1 * sigma) { flag[c] = 0; planar--; }
      }
    }
    // Ячейки у рёбер и углов не плоские целиком: их точки, лежащие в пределах 2,5 sigma от плоскости соседней плоской ячейки, притягиваются к ней —
    // так рёбра остаются острыми, а шум у краёв стен подавляется так же, как в середине.
    prog(ctl, 0.62, 'Края и углы…');
    var CS = 4, snap = Math.max(2.5 * sigma, 0.0005), cand = new Int32Array(cells * CS).fill(-1), offs = [];
    for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) if (dx | dy | dz) offs.push([dx, dy, dz, dx * dx + dy * dy + dz * dz]);
    offs.sort(function (a, b) { return a[3] - b[3]; });
    for (c = 0; c < cells; c++) {
      if (flag[c]) continue;
      var ncand = 0, cix = G.cx[c], ciy = G.cy[c], ciz = G.cz[c];
      for (var q = 0; q < 26 && ncand < CS; q++) {
        var t = lookup(G, cix + offs[q][0], ciy + offs[q][1], ciz + offs[q][2]);
        if (t < 0 || !flag[t]) continue;
        var dup = false;
        for (var e = 0; e < ncand && !dup; e++) {
          var u = cand[c * CS + e] * 3, v = t * 3;
          var dt = pl[u] * pl[v] + pl[u + 1] * pl[v + 1] + pl[u + 2] * pl[v + 2]; if (dt < 0) dt = -dt;
          var off = (pc[v] - pc[u]) * pl[u] + (pc[v + 1] - pc[u + 1]) * pl[u + 1] + (pc[v + 2] - pc[u + 2]) * pl[u + 2];
          if (dt > 0.995 && Math.abs(off) < 0.5 * snap) dup = true;
        }
        if (!dup) cand[c * CS + ncand++] = t;
      }
    }
    prog(ctl, 0.65, 'Проекция точек…');
    var res = opt.inPlace ? pos : new Float32Array(pos), cellId = G.cellId, m0 = bb.mn[0], m1 = bb.mn[1], m2 = bb.mn[2];
    var moved = 0, sumSq = 0, maxShift = 0;
    for (var i = 0, j = 0; i < n; i++, j += 3) {
      var id2 = cellId[i]; if (id2 < 0) continue;
      if ((i & 0xFFFFF) === 0 && i) prog(ctl, 0.65 + 0.33 * (i / n), 'Проекция точек…');
      var pcell = id2, d, b3, nx, ny, nz;
      if (flag[id2]) {
        b3 = id2 * 3; nx = pl[b3]; ny = pl[b3 + 1]; nz = pl[b3 + 2];
        d = ((pos[j] - m0) - pc[b3]) * nx + ((pos[j + 1] - m1) - pc[b3 + 1]) * ny + ((pos[j + 2] - m2) - pc[b3 + 2]) * nz;
      } else {
        var bestK = -1, bestAbs = snap, bestD = 0;
        for (var sl = 0; sl < CS; sl++) {
          var kk = cand[id2 * CS + sl]; if (kk < 0) break;
          var k3 = kk * 3, dd = ((pos[j] - m0) - pc[k3]) * pl[k3] + ((pos[j + 1] - m1) - pc[k3 + 1]) * pl[k3 + 1] + ((pos[j + 2] - m2) - pc[k3 + 2]) * pl[k3 + 2], ad0 = dd < 0 ? -dd : dd;
          if (ad0 <= bestAbs) { bestAbs = ad0; bestK = kk; bestD = dd; }
        }
        if (bestK < 0) continue;
        b3 = bestK * 3; nx = pl[b3]; ny = pl[b3 + 1]; nz = pl[b3 + 2]; d = bestD;
      }
      var sh = strength * d;
      res[j] = pos[j] - sh * nx; res[j + 1] = pos[j + 1] - sh * ny; res[j + 2] = pos[j + 2] - sh * nz;
      var as = sh < 0 ? -sh : sh; moved++; sumSq += sh * sh; if (as > maxShift) maxShift = as;
    }
    prog(ctl, 1, 'Готово');
    return { pos: res, count: n, moved: moved, rmsShift: moved ? Math.sqrt(sumSq / moved) : 0, maxShift: maxShift, planarCells: planar, cells: cells, noiseSigma: sigma, threshold: thr === Infinity ? null : thr };
  }

  // ---------------------------------------------------------------- выравнивание поверхностей
  /**
   * «Выровнять поверхности»: находит протяжённые плоские участки (стены, пол, потолок), склеивает двойные слои и
   * укладывает точки в пределах допуска tol на одну плоскость. Всё, что дальше tol от плоскостей, не меняется.
   * opt: tol (м, по умолч. 0.03), strength 0..1, cell (размер участка, м), inPlace.
   */
  function flatten(pos, n, opt, ctl) {
    opt = opt || {};
    var tol = opt.tol > 0 ? +opt.tol : 0.03, strength = opt.strength == null ? 1 : clamp(+opt.strength, 0, 1);
    var g = opt.cell > 0 ? +opt.cell : clamp(opt.spacing > 0 ? 15 * opt.spacing : 0.2, 0.15, 0.6);
    var bb = bounds(pos, n); if (!bb) return { pos: pos, moved: 0, count: n, planes: 0 };
    prog(ctl, 0.02, 'Разбиение на участки…');
    var G = buildGrid(pos, n, g, bb, ctl, 0.02, 0.28, 'Разбиение на участки…');
    prog(ctl, 0.28, 'Моменты участков…');
    var M = cellMoments(G, pos, n), cells = G.cells, c, k;
    var cn = new Float32Array(cells * 3), cc = new Float64Array(cells * 3), pflag = new Uint8Array(cells);
    var A = new Float64Array(10), out = new Float64Array(9), nplanar = 0;
    var rmsMax = 0.5 * tol + 0.0005, minPts = Math.max(8, opt.minPoints | 0);
    for (c = 0; c < cells; c++) {
      var b = c * 10; if (M[b] < minPts) continue;
      for (k = 0; k < 10; k++) A[k] = M[b + k];
      if (!fitMoments(A, out) || out[6] > rmsMax || out[7] < 0.2 * g) continue;
      cn[c * 3] = out[0]; cn[c * 3 + 1] = out[1]; cn[c * 3 + 2] = out[2];
      cc[c * 3] = G.cx[c] * g + out[3]; cc[c * 3 + 1] = G.cy[c] * g + out[4]; cc[c * 3 + 2] = G.cz[c] * g + out[5];
      pflag[c] = 1; nplanar++;
    }
    // Проверка кривизны внутри участка: у плоской стены средние отклонения от плоскости по 9 подобластям и 3 кольцам участка ≈ 0, у трубы/купола — нет.
    prog(ctl, 0.34, 'Проверка кривизны…');
    var pmap = new Int32Array(cells).fill(-1), pcount = 0;
    for (c = 0; c < cells; c++) if (pflag[c]) pmap[c] = pcount++;
    var BN = 12, bins = new Float64Array(pcount * BN * 3), pe = new Float32Array(pcount * 6);
    for (c = 0; c < cells; c++) {
      var pm = pmap[c]; if (pm < 0) continue;
      var nx0 = cn[c * 3], ny0 = cn[c * 3 + 1], nz0 = cn[c * 3 + 2];
      var ax = Math.abs(nx0) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
      var dd = ax * nx0 + ay * ny0, e1x = ax - dd * nx0, e1y = ay - dd * ny0, e1z = -dd * nz0, el = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      e1x /= el; e1y /= el; e1z /= el;
      pe[pm * 6] = e1x; pe[pm * 6 + 1] = e1y; pe[pm * 6 + 2] = e1z;
      pe[pm * 6 + 3] = ny0 * e1z - nz0 * e1y; pe[pm * 6 + 4] = nz0 * e1x - nx0 * e1z; pe[pm * 6 + 5] = nx0 * e1y - ny0 * e1x;
    }
    var gcell = G.cellId, mm0 = bb.mn[0], mm1 = bb.mn[1], mm2 = bb.mn[2], third = g / 3, halfg = g / 2;
    for (var i0 = 0, j0 = 0; i0 < n; i0++, j0 += 3) {
      var cid0 = gcell[i0]; if (cid0 < 0) continue; var pm0 = pmap[cid0]; if (pm0 < 0) continue;
      var qx = pos[j0] - mm0 - cc[cid0 * 3], qy = pos[j0 + 1] - mm1 - cc[cid0 * 3 + 1], qz = pos[j0 + 2] - mm2 - cc[cid0 * 3 + 2];
      var dn = qx * cn[cid0 * 3] + qy * cn[cid0 * 3 + 1] + qz * cn[cid0 * 3 + 2];
      var u = qx * pe[pm0 * 6] + qy * pe[pm0 * 6 + 1] + qz * pe[pm0 * 6 + 2], v = qx * pe[pm0 * 6 + 3] + qy * pe[pm0 * 6 + 4] + qz * pe[pm0 * 6 + 5];
      var bu = Math.floor((u + halfg) / third), bv = Math.floor((v + halfg) / third);
      bu = bu < 0 ? 0 : (bu > 2 ? 2 : bu); bv = bv < 0 ? 0 : (bv > 2 ? 2 : bv);
      var bo = pm0 * BN * 3 + (bu * 3 + bv) * 3; bins[bo]++; bins[bo + 1] += dn; bins[bo + 2] += dn * dn;
      var rr = Math.sqrt(u * u + v * v), ring = rr < g * 0.25 ? 0 : (rr < g * 0.5 ? 1 : 2);
      bo = pm0 * BN * 3 + (9 + ring) * 3; bins[bo]++; bins[bo + 1] += dn; bins[bo + 2] += dn * dn;
    }
    var curved = 0, curvMax = 0.12 * tol;
    for (c = 0; c < cells; c++) {
      var pm1 = pmap[c]; if (pm1 < 0) continue;
      for (k = 0; k < BN; k++) {
        var bo2 = pm1 * BN * 3 + k * 3, nb = bins[bo2]; if (nb < 6) continue;
        var mean = bins[bo2 + 1] / nb, rmsb = Math.sqrt(Math.max(0, bins[bo2 + 2] / nb - mean * mean));
        if (Math.abs(mean) > curvMax + 3 * rmsb / Math.sqrt(nb)) { pflag[c] = 0; nplanar--; curved++; break; }
      }
    }
    prog(ctl, 0.4, 'Склейка плоских участков…');
    var parent = new Int32Array(cells); for (c = 0; c < cells; c++) parent[c] = c;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    var cosMax = Math.cos((opt.angleDeg > 0 ? +opt.angleDeg : 5) * Math.PI / 180), dTol = 0.5 * tol;
    var offs = []; for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) for (var oz = -1; oz <= 1; oz++) {
      if (ox > 0 || (ox === 0 && (oy > 0 || (oy === 0 && oz > 0)))) offs.push([ox, oy, oz]);
    }
    for (c = 0; c < cells; c++) {
      if (!pflag[c]) continue;
      for (var q = 0; q < offs.length; q++) {
        var c2 = lookup(G, G.cx[c] + offs[q][0], G.cy[c] + offs[q][1], G.cz[c] + offs[q][2]);
        if (c2 < 0 || !pflag[c2]) continue;
        var a3 = c * 3, b3 = c2 * 3;
        var dot = cn[a3] * cn[b3] + cn[a3 + 1] * cn[b3 + 1] + cn[a3 + 2] * cn[b3 + 2]; if (dot < 0) dot = -dot;
        if (dot < cosMax) continue;
        var ex = cc[b3] - cc[a3], ey = cc[b3 + 1] - cc[a3 + 1], ez = cc[b3 + 2] - cc[a3 + 2];
        var d1 = ex * cn[a3] + ey * cn[a3 + 1] + ez * cn[a3 + 2], d2 = ex * cn[b3] + ey * cn[b3 + 1] + ez * cn[b3 + 2];
        if ((d1 < 0 ? -d1 : d1) > dTol || (d2 < 0 ? -d2 : d2) > dTol) continue;
        var r1 = find(c), r2 = find(c2); if (r1 !== r2) parent[r2] = r1;
      }
    }
    // агрегированная плоскость каждой компоненты
    prog(ctl, 0.5, 'Подбор плоскостей…');
    var compOf = new Int32Array(cells).fill(-1), roots = [], Aall = [];
    for (c = 0; c < cells; c++) {
      if (!pflag[c]) continue;
      var r = find(c), idx = compOf[r];
      if (idx < 0) { idx = roots.length; compOf[r] = idx; roots.push(r); Aall.push(new Float64Array(11)); }
      var T = Aall[idx], tmp = A; tmp.fill(0);
      addShifted(tmp, M, c * 10, 1, (G.cx[c] - G.cx[r]) * g, (G.cy[c] - G.cy[r]) * g, (G.cz[c] - G.cz[r]) * g);
      for (k = 0; k < 10; k++) T[k] += tmp[k];
      T[10]++;
    }
    var planeOfRoot = new Int32Array(cells).fill(-1), P = 0, pn = [], pcn = [];
    var minCells = opt.minCells > 0 ? opt.minCells | 0 : 3, rmsComp = 0.7 * tol + 0.0005;
    for (var ci = 0; ci < roots.length; ci++) {
      var T2 = Aall[ci], rr = roots[ci];
      if (T2[10] < minCells || !fitMoments(T2, out) || out[6] > rmsComp || out[7] < 0.5 * g) continue;   // полоса в одну ячейку (труба, балка) плоскостью не считается
      planeOfRoot[rr] = P++;
      pn.push(out[0], out[1], out[2]);
      pcn.push(G.cx[rr] * g + out[3], G.cy[rr] * g + out[4], G.cz[rr] * g + out[5]);
    }
    if (!P) { prog(ctl, 1, 'Готово'); return { pos: pos, count: n, moved: 0, planes: 0, planarCells: nplanar, cells: cells }; }
    // кандидаты-плоскости для каждой ячейки (из 27 соседей)
    prog(ctl, 0.6, 'Привязка точек к плоскостям…');
    var SL = 6, cand = new Int32Array(cells * SL).fill(-1);
    for (c = 0; c < cells; c++) {
      if (!pflag[c]) continue;
      var pi = planeOfRoot[find(c)]; if (pi < 0) continue;
      var ix = G.cx[c], iy = G.cy[c], iz = G.cz[c];
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var t = (dx | dy | dz) === 0 ? c : lookup(G, ix + dx, iy + dy, iz + dz); if (t < 0) continue;
        var o = t * SL, s = 0;
        for (; s < SL; s++) { if (cand[o + s] === pi) break; if (cand[o + s] < 0) { cand[o + s] = pi; break; } }
      }
    }
    var res = opt.inPlace ? pos : new Float32Array(pos), cellId = G.cellId, m0 = bb.mn[0], m1 = bb.mn[1], m2 = bb.mn[2];
    var moved = 0, sumSq = 0, maxShift = 0, used = new Uint8Array(P);
    // «волосы»: редкие точки в полосе (допуск … hairBand) рядом с плоскостью. Плотные скопления (трубы, рейки, второй слой стены) не трогаются:
    // точка считается волосом, только если таких точек в ячейке не больше hairRatio от числа точек на самой плоскости.
    var hairBand = opt.hairBand > 0 ? Math.max(+opt.hairBand, tol * 1.5) : 0, hairRatio = opt.hairRatio > 0 ? +opt.hairRatio : 0.12;
    var offMark = hairBand ? new Uint8Array(n) : null, inCnt = hairBand ? new Uint32Array(cells) : null, offCnt = hairBand ? new Uint32Array(cells) : null;
    for (var i = 0, j = 0; i < n; i++, j += 3) {
      var id = cellId[i]; if (id < 0) continue;
      if ((i & 0xFFFFF) === 0 && i) prog(ctl, 0.65 + 0.33 * (i / n), 'Выравнивание точек…');
      var x = pos[j] - m0, y = pos[j + 1] - m1, z = pos[j + 2] - m2, best = -1, bd = tol, bsd = 0, o2 = id * SL, bdAny = Infinity;
      for (var s2 = 0; s2 < SL; s2++) {
        var pp = cand[o2 + s2]; if (pp < 0) break;
        var p3 = pp * 3, d = (x - pcn[p3]) * pn[p3] + (y - pcn[p3 + 1]) * pn[p3 + 1] + (z - pcn[p3 + 2]) * pn[p3 + 2], ad = d < 0 ? -d : d;
        if (ad <= bd) { bd = ad; best = pp; bsd = d; }
        if (ad < bdAny) bdAny = ad;
      }
      if (best < 0) { if (hairBand && bdAny <= hairBand) { offMark[i] = 1; offCnt[id]++; } continue; }
      if (hairBand) inCnt[id]++;
      var sh = strength * bsd, b4 = best * 3;
      res[j] = pos[j] - sh * pn[b4]; res[j + 1] = pos[j + 1] - sh * pn[b4 + 1]; res[j + 2] = pos[j + 2] - sh * pn[b4 + 2];
      used[best] = 1; moved++; sumSq += sh * sh; var as = sh < 0 ? -sh : sh; if (as > maxShift) maxShift = as;
    }
    var usedN = 0; for (k = 0; k < P; k++) usedN += used[k];
    var hair = null;
    if (hairBand) {
      var hc = 0, hi;
      for (hi = 0; hi < n; hi++) if (offMark[hi]) { var hid = cellId[hi]; if (inCnt[hid] >= 20 && offCnt[hid] <= hairRatio * inCnt[hid]) hc++; else offMark[hi] = 0; }
      hair = new Uint32Array(hc); hc = 0;
      for (hi = 0; hi < n; hi++) if (offMark[hi]) hair[hc++] = hi;
    }
    prog(ctl, 1, 'Готово');
    return { pos: res, count: n, hair: hair, moved: moved, rmsShift: moved ? Math.sqrt(sumSq / moved) : 0, maxShift: maxShift, planes: usedN, planarCells: nplanar, curvedCells: curved, cells: cells };
  }

  // ---------------------------------------------------------------- подавление шума
  /** Радиусный фильтр: точка удаляется, если в радиусе R меньше K соседей. Возвращает keep — индексы оставшихся точек. */
  function denoise(pos, n, opt, ctl) {
    opt = opt || {};
    var R = +opt.radius, K = opt.neighbors | 0;
    if (!(R > 0)) throw new Error('Радиус поиска должен быть больше нуля');
    if (K < 1) K = 1;
    var bb = bounds(pos, n); if (!bb) return { keep: new Uint32Array(0), removed: n, count: n };
    var c = R / Math.sqrt(3), R2 = R * R;     // диагональ ячейки = R: все точки одной ячейки — соседи друг друга
    prog(ctl, 0.02, 'Разбиение на ячейки…');
    var G = buildGrid(pos, n, c, bb, ctl, 0.02, 0.3, 'Разбиение на ячейки…');
    prog(ctl, 0.3, 'Группировка точек…');
    var grp = groupPoints(G, n), start = grp.start, order = grp.order, cells = G.cells;
    var offs = [], reach = Math.ceil(R / c);
    for (var ox = -reach; ox <= reach; ox++) for (var oy = -reach; oy <= reach; oy++) for (var oz = -reach; oz <= reach; oz++) {
      if (!(ox | oy | oz)) continue;
      var gx = Math.max(0, Math.abs(ox) - 1) * c, gy = Math.max(0, Math.abs(oy) - 1) * c, gz = Math.max(0, Math.abs(oz) - 1) * c;
      if (gx * gx + gy * gy + gz * gz <= R2) offs.push(ox, oy, oz);
    }
    var mask = new Uint8Array(n), cl = new Int32Array(offs.length / 3 + 1), cid, kept = 0;
    for (cid = 0; cid < cells; cid++) {
      if ((cid & 4095) === 0 && cid) prog(ctl, 0.35 + 0.6 * (cid / cells), 'Проверка соседей…');
      var s0 = start[cid], s1 = start[cid + 1], cnt = s1 - s0, q;
      if (cnt - 1 >= K) { for (q = s0; q < s1; q++) mask[order[q]] = 1; kept += cnt; continue; }
      var ix = G.cx[cid], iy = G.cy[cid], iz = G.cz[cid], U = cnt - 1, nc = 0;
      for (var t = 0; t < offs.length; t += 3) {
        var id2 = lookup(G, ix + offs[t], iy + offs[t + 1], iz + offs[t + 2]);
        if (id2 < 0) continue; cl[nc++] = id2; U += start[id2 + 1] - start[id2];
      }
      if (U < K) continue;               // даже все точки блока не дают K соседей — выбросы
      for (q = s0; q < s1; q++) {
        var pi = order[q], px = pos[pi * 3], py = pos[pi * 3 + 1], pz = pos[pi * 3 + 2], cntn = cnt - 1;
        for (var u = 0; u < nc && cntn < K; u++) {
          var cc2 = cl[u];
          for (var w = start[cc2], we = start[cc2 + 1]; w < we; w++) {
            var pj = order[w] * 3, ddx = pos[pj] - px, ddy = pos[pj + 1] - py, ddz = pos[pj + 2] - pz;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= R2 && ++cntn >= K) break;
          }
        }
        if (cntn >= K) { mask[pi] = 1; kept++; }
      }
    }
    var keep = new Uint32Array(kept), k2 = 0;
    for (var i = 0; i < n; i++) if (mask[i]) keep[k2++] = i;
    prog(ctl, 1, 'Готово');
    return { keep: keep, count: n, removed: n - kept };
  }

  // ---------------------------------------------------------------- ресэмплирование
  function rng(seed) { var s = (seed >>> 0) || 0x9E3779B9; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  /** Случайное прореживание: по одной случайной точке на каждое «окно» длиной 1/share. Остаётся ровно ≈ share·n точек. */
  function resampleRandom(n, share, seed) {
    if (!(share > 0)) share = 1e-9; if (share >= 1) return null;
    var s = 1 / share, cap = Math.ceil(n * share) + 2, keep = new Uint32Array(cap), k = 0, rnd = rng(seed || 20240607);
    for (var w = 0; ; w++) {
      var a = Math.ceil(w * s); if (a >= n) break;
      var b = Math.min(n, Math.ceil((w + 1) * s)); if (b <= a) b = a + 1;
      keep[k++] = a + Math.floor(rnd() * (b - a));
    }
    return keep.subarray(0, k);
  }

  /**
   * ресэмплирование. opt: mode 'random' (percent 0..100) | 'voxel' (voxel, м). Результат — keep (индексы реальных точек).
   * В режиме voxel в каждом вокселе остаётся одна настоящая точка — ближайшая к центру вокселя.
   */
  function resample(pos, n, opt, ctl) {
    opt = opt || {};
    if (opt.mode === 'voxel') {
      var v = +opt.voxel; if (!(v > 0)) throw new Error('Шаг ресэмплирования должен быть больше нуля');
      var bb = bounds(pos, n); if (!bb) return { keep: new Uint32Array(0), count: n, removed: n };
      var G = buildGrid(pos, n, v, bb, ctl, 0.02, 0.6, 'Разбиение на воксели…'), cells = G.cells, h = G.h, half = h / 2;
      var best = new Int32Array(cells).fill(-1), bd = new Float32Array(cells).fill(Infinity), cellId = G.cellId;
      for (var i = 0, j = 0; i < n; i++, j += 3) {
        var id = cellId[i]; if (id < 0) continue;
        var dx = pos[j] - bb.mn[0] - G.cx[id] * h - half, dy = pos[j + 1] - bb.mn[1] - G.cy[id] * h - half, dz = pos[j + 2] - bb.mn[2] - G.cz[id] * h - half, d = dx * dx + dy * dy + dz * dz;
        if (d < bd[id]) { bd[id] = d; best[id] = i; }
        if ((i & 0xFFFFF) === 0 && i) prog(ctl, 0.6 + 0.3 * (i / n), 'Выбор точек…');
      }
      var keep = new Uint32Array(cells), k = 0;
      for (i = 0; i < n; i++) { var c2 = cellId[i]; if (c2 >= 0 && best[c2] === i) keep[k++] = i; }
      prog(ctl, 1, 'Готово');
      return { keep: keep.subarray(0, k), count: n, removed: n - k };
    }
    var pct = +opt.percent; if (!(pct > 0 && pct <= 100)) throw new Error('Частота дискретизации должна быть от 0 до 100 %');
    var kp = resampleRandom(n, pct / 100, opt.seed);
    prog(ctl, 1, 'Готово');
    if (!kp) { var all = new Uint32Array(n); for (var t = 0; t < n; t++) all[t] = t; return { keep: all, count: n, removed: 0 }; }
    return { keep: kp, count: n, removed: n - kp.length };
  }

  /** Выбор значений по индексам keep (для pos/col/intensity/classification), stride — число компонент на точку. */
  function gather(src, keep, stride) {
    if (!src || !src.length) return src || null;
    var out = new src.constructor(keep.length * stride), i, j;
    if (stride === 3) { for (i = 0; i < keep.length; i++) { var s = keep[i] * 3, o = i * 3; out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; } }
    else if (stride === 1) { for (i = 0; i < keep.length; i++) out[i] = src[keep[i]]; }
    else { for (i = 0; i < keep.length; i++) for (j = 0; j < stride; j++) out[i * stride + j] = src[keep[i] * stride + j]; }
    return out;
  }

  /** Единая точка входа для воркера. */
  function run(op, pos, params, ctl) {
    var n = (pos.length / 3) | 0;
    if (op === 'smooth') return smooth(pos, n, Object.assign({ inPlace: true }, params), ctl);
    if (op === 'flatten') return flatten(pos, n, Object.assign({ inPlace: true }, params), ctl);
    if (op === 'denoise') return denoise(pos, n, params, ctl);
    if (op === 'resample') return resample(pos, n, params, ctl);
    if (op === 'estimate') return estimate(pos, n, ctl);
    throw new Error('Неизвестная операция: ' + op);
  }

  return { smooth: smooth, flatten: flatten, denoise: denoise, resample: resample, resampleRandom: resampleRandom, estimate: estimate, defaults: defaults,
    gather: gather, run: run, _internal: { buildGrid: buildGrid, lookup: lookup, eig3: eig3, bounds: bounds } };
});
