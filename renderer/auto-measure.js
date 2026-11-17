/*
 * auto-measure.js — автоматический замер выделенного объекта по облаку точек.
 *
 * Зачем. В «Инспекторе объекта» человек обводит дверь, колонну или трубу рамкой, а дальше должен сам ставить точки на гранях.
 * Здесь размеры находятся сами — так, как это делает опытный геодезист: не по одиночным точкам, а по геометрии, вписанной в облако.
 *   1. Облако прореживается, оценивается шаг точек и шум; для выборки точек считаются локальные нормали (метод главных компонент).
 *   2. Нормали собираются в направления (стена, пол, откос…); для каждого направления по гистограмме смещений находятся плоскости;
 *      каждая плоскость уточняется по методу наименьших квадратов с отбраковкой выбросов; у неё есть шум (rms), число точек и контур-«след».
 *   3. Из плоскостей собираются осмысленные размеры — проём (откос–откос, перемычка–пол, дыра в стене), помещение/панель (пара параллельных
 *      плоскостей с совпадающими «следами»), цилиндр (труба, круглая колонна: ось по нормалям и окружность), габариты (ориентированная коробка).
 *   4. У каждого размера есть погрешность ±σ, способ (по плоскостям / по рёбрам / по окружности / по габариту) и уровень уверенности.
 *      Если размер можно получить двумя независимыми способами (например, ширина проёма по откосам и по краям дыры в стене),
 *      способы сверяются: расхождение понижает уверенность и показывается — а не прячется.
 *
 * Принципы (как и в precision-snap.js):
 *   • всё детерминировано: никаких случайных чисел, одинаковое облако даёт одинаковый ответ;
 *   • допуски считаются от шага и шума облака, а не от «метров»;
 *   • честность: ничего не выдумывается — если опоры нет (нет второй грани, объект обрезан рамкой), размер помечается как «по габариту»
 *     с низкой уверенностью или не возвращается совсем;
 *   • чистые функции без DOM: работает и в окне приложения, и в Node (тесты, сверка с эталоном).
 *
 * Экспорт: window.AutoMeasure и module.exports.  Ось «вверх» — Y (как во всём приложении); единицы — метры.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.AutoMeasure = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEG = Math.PI / 180;
  var COS_PAR = Math.cos(4 * DEG);          // параллельными считаем плоскости в пределах 4°
  var UP = [0, 1, 0];

  /* ---------- Малые помощники ---------- */
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function unit(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function median(arr) { if (!arr.length) return 0; var s = Float64Array.from(arr).sort(); var m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); }
  function quantile(sorted, q) { if (!sorted.length) return 0; var p = clamp(q, 0, 1) * (sorted.length - 1), i = Math.floor(p), f = p - i; return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i]; }
  function angleBetween(a, b) { return Math.acos(clamp(Math.abs(dot(a, b)), 0, 1)); }   // угол между направлениями без учёта знака

  /* Собственные пары симметричной 3×3 (Якоби). m = [xx, xy, xz, yy, yz, zz]. Возвращает значения по возрастанию и векторы-столбцы. */
  function eig3(m) {
    var a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 24; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-24) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        var t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        var c = 1 / Math.sqrt(t * t + 1), s = t * c, k;
        for (k = 0; k < 3; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (k = 0; k < 3; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (k = 0; k < 3; k++) { var vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    var order = [0, 1, 2].sort(function (i, j) { return a[i][i] - a[j][j]; });
    return {
      values: order.map(function (i) { return a[i][i]; }),
      vectors: order.map(function (i) { return unit([v[0][i], v[1][i], v[2][i]]); })
    };
  }

  /* ---------- Подготовка облака ---------- */
  /* Прореживание шагом (детерминированно) и перенос в двойную точность относительно центра: так суммы по миллионам точек не теряют миллиметры. */
  function hash32(b) { var h = Math.imul(b ^ 0x9E3779B9, 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16; return h >>> 0; }
  function prepare(pos, maxPoints) {
    var total = Math.floor(pos.length / 3), stride = Math.max(1, Math.ceil(total / maxPoints));
    var cnt = 0, i, x, y, z, nb = Math.ceil(total / stride);
    var P = new Float64Array(nb * 3);
    var cx = 0, cy = 0, cz = 0;
    // из каждого блока по stride точек берём одну — со «случайным» (детерминированным) смещением: шаг по порядку записи не даёт муара на регулярных сканах
    for (var b = 0; b < nb; b++) {
      i = stride === 1 ? b : b * stride + (hash32(b) % stride);
      if (i >= total) continue;
      x = pos[i * 3]; y = pos[i * 3 + 1]; z = pos[i * 3 + 2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      P[cnt * 3] = x; P[cnt * 3 + 1] = y; P[cnt * 3 + 2] = z; cx += x; cy += y; cz += z; cnt++;
    }
    if (!cnt) return { n: 0, P: P, c0: [0, 0, 0], total: total, stride: stride };
    cx /= cnt; cy /= cnt; cz /= cnt;
    for (i = 0; i < cnt; i++) { P[i * 3] -= cx; P[i * 3 + 1] -= cy; P[i * 3 + 2] -= cz; }
    return { n: cnt, P: P.subarray(0, cnt * 3), c0: [cx, cy, cz], total: total, stride: stride };
  }

  /* ---------- Пространственная сетка ---------- */
  function buildGrid(P, n, cell) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], i, k;
    for (i = 0; i < n; i++) for (k = 0; k < 3; k++) { var v = P[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    var ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    cell = Math.max(cell, Math.max(ext[0], ext[1], ext[2]) / 200, 1e-6);
    var d = [Math.max(1, Math.ceil(ext[0] / cell) + 1), Math.max(1, Math.ceil(ext[1] / cell) + 1), Math.max(1, Math.ceil(ext[2] / cell) + 1)];
    var cells = d[0] * d[1] * d[2], inv = 1 / cell;
    var start = new Int32Array(cells + 1), key = new Int32Array(n);
    for (i = 0; i < n; i++) {
      var kk = (((P[i * 3 + 2] - mn[2]) * inv) | 0) * d[1] * d[0] + (((P[i * 3 + 1] - mn[1]) * inv) | 0) * d[0] + (((P[i * 3] - mn[0]) * inv) | 0);
      key[i] = kk; start[kk + 1]++;
    }
    for (i = 0; i < cells; i++) start[i + 1] += start[i];
    var fill = start.slice(0, cells), order = new Int32Array(n);
    for (i = 0; i < n; i++) order[fill[key[i]]++] = i;
    return { P: P, n: n, mn: mn, mx: mx, ext: ext, cell: cell, inv: inv, d: d, start: start, order: order };
  }
  /* Соседи точки (x,y,z) в радиусе r ≤ cell; результат в out (Int32Array), возвращает число. */
  function neighbors(g, x, y, z, r, out, cap) {
    var P = g.P, inv = g.inv, d = g.d, r2 = r * r, cnt = 0;
    var ix = ((x - g.mn[0]) * inv) | 0, iy = ((y - g.mn[1]) * inv) | 0, iz = ((z - g.mn[2]) * inv) | 0;
    var x0 = Math.max(0, ix - 1), x1 = Math.min(d[0] - 1, ix + 1), y0 = Math.max(0, iy - 1), y1 = Math.min(d[1] - 1, iy + 1), z0 = Math.max(0, iz - 1), z1 = Math.min(d[2] - 1, iz + 1);
    for (var cz = z0; cz <= z1; cz++) for (var cy = y0; cy <= y1; cy++) {
      var row = (cz * d[1] + cy) * d[0];
      for (var k = g.start[row + x0], e = g.start[row + x1 + 1]; k < e; k++) {
        var i = g.order[k], ax = P[i * 3] - x, ay = P[i * 3 + 1] - y, az = P[i * 3 + 2] - z;
        if (ax * ax + ay * ay + az * az <= r2) { if (cnt < cap) out[cnt] = i; cnt++; }
      }
    }
    return Math.min(cnt, cap);
  }
  /* Шаг облака — медианное расстояние до ближайшего соседа (как в precision-snap.js). */
  function estimateSpacing(g) {
    var n = g.n, sample = Math.min(500, n), step = Math.max(1, Math.floor(n / sample)), ds = [], P = g.P, buf = new Int32Array(4000);
    for (var s = 0; s < n && ds.length < sample; s += step) {
      var cx = P[s * 3], cy = P[s * 3 + 1], cz = P[s * 3 + 2], bd = Infinity;
      var m = neighbors(g, cx, cy, cz, g.cell, buf, buf.length);
      for (var k = 0; k < m; k++) {
        var i = buf[k]; if (i === s) continue;
        var ax = P[i * 3] - cx, ay = P[i * 3 + 1] - cy, az = P[i * 3 + 2] - cz, dd = ax * ax + ay * ay + az * az;
        if (dd > 0 && dd < bd) bd = dd;
      }
      if (isFinite(bd)) ds.push(Math.sqrt(bd));
    }
    return ds.length ? median(ds) : g.cell / 4;
  }

  /* ---------- Локальные нормали ---------- */
  /* Для выборки точек: соседи в радиусе R → ковариация → нормаль (наименьшее собственное значение). Возвращает массивы по выборке. */
  function localNormals(g, R, maxSample) {
    var P = g.P, n = g.n, step = Math.max(1, Math.floor(n / maxSample)), m = Math.floor((n + step - 1) / step);
    var ids = new Int32Array(m), N = new Float32Array(m * 3), L0 = new Float32Array(m), L1 = new Float32Array(m), L2 = new Float32Array(m), K = new Int32Array(m);
    var buf = new Int32Array(600), c = 0;
    for (var s = 0; s < n; s += step) {
      var x = P[s * 3], y = P[s * 3 + 1], z = P[s * 3 + 2];
      var cnt = neighbors(g, x, y, z, R, buf, buf.length);
      ids[c] = s; K[c] = cnt;
      if (cnt < 8) { L0[c] = L1[c] = L2[c] = -1; c++; continue; }
      var mx = 0, my = 0, mz = 0, k, i;
      for (k = 0; k < cnt; k++) { i = buf[k] * 3; mx += P[i]; my += P[i + 1]; mz += P[i + 2]; }
      mx /= cnt; my /= cnt; mz /= cnt;
      var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (k = 0; k < cnt; k++) { i = buf[k] * 3; var ax = P[i] - mx, ay = P[i + 1] - my, az = P[i + 2] - mz; xx += ax * ax; xy += ax * ay; xz += ax * az; yy += ay * ay; yz += ay * az; zz += az * az; }
      var e = eig3([xx / cnt, xy / cnt, xz / cnt, yy / cnt, yz / cnt, zz / cnt]);
      N[c * 3] = e.vectors[0][0]; N[c * 3 + 1] = e.vectors[0][1]; N[c * 3 + 2] = e.vectors[0][2];
      L0[c] = Math.max(0, e.values[0]); L1[c] = e.values[1]; L2[c] = e.values[2];
      c++;
    }
    return { m: c, ids: ids, N: N, L0: L0, L1: L1, L2: L2, K: K };
  }

  /* ---------- Направления плоскостей ---------- */
  /* Нормали плоских окрестностей голосуют в трёхмерной гистограмме (и за n, и за −n: знак нормали произволен). Пик → среднее направление
   * внутри конуса → участники → исключаем и ищем следующий. Так находятся стены, пол, откосы, даже если их мало (1–2 % точек). */
  function clusterDirections(ln, flat, o) {
    o = o || {};
    var BIN = 0.04, NB = Math.ceil(2 / BIN) + 1, hist = new Int32Array(NB * NB * NB);
    var alive = [], i;
    for (i = 0; i < ln.m; i++) if (flat[i]) alive.push(i);
    var minMembers = Math.max(o.minMembers || 25, Math.round(alive.length * (o.minShare || 0.006)));
    var dirs = [], cone = Math.cos((o.coneDeg || 7) * DEG), N = ln.N;
    function bin(v) { return clamp(Math.floor((v + 1) / BIN), 0, NB - 1); }
    function key(x, y, z) { return (bin(x) * NB + bin(y)) * NB + bin(z); }
    for (var round = 0; round < (o.maxDirs || 12); round++) {
      hist.fill(0);
      for (i = 0; i < alive.length; i++) { var a = alive[i] * 3; hist[key(N[a], N[a + 1], N[a + 2])]++; hist[key(-N[a], -N[a + 1], -N[a + 2])]++; }
      // сглаженный максимум по кубу 3×3×3 — только по занятым ячейкам
      var bestKey = -1, bestV = 0, seen = new Set();
      for (i = 0; i < alive.length; i++) {
        var b = alive[i] * 3;
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          var kx = bin(sgn * N[b]), ky = bin(sgn * N[b + 1]), kz = bin(sgn * N[b + 2]), kk = (kx * NB + ky) * NB + kz;
          if (seen.has(kk)) continue; seen.add(kk);
          var sum = 0;
          for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
            var ax = kx + dx, ay = ky + dy, az = kz + dz;
            if (ax < 0 || ay < 0 || az < 0 || ax >= NB || ay >= NB || az >= NB) continue;
            sum += hist[(ax * NB + ay) * NB + az];
          }
          if (sum > bestV) { bestV = sum; bestKey = kk; }
        }
      }
      if (bestKey < 0 || bestV / 2 < minMembers * 0.8) break;
      // центр ячейки → среднее по конусу (3 прохода)
      var cz0 = bestKey % NB, cy0 = Math.floor(bestKey / NB) % NB, cx0 = Math.floor(bestKey / (NB * NB));
      var dir = unit([-1 + (cx0 + 0.5) * BIN, -1 + (cy0 + 0.5) * BIN, -1 + (cz0 + 0.5) * BIN]);
      for (var it = 0; it < 4; it++) {
        var sx = 0, sy = 0, sz = 0, cnt = 0;
        for (i = 0; i < alive.length; i++) {
          var q = alive[i] * 3, dd = N[q] * dir[0] + N[q + 1] * dir[1] + N[q + 2] * dir[2];
          if (Math.abs(dd) >= cone) { var sg = dd >= 0 ? 1 : -1; sx += sg * N[q]; sy += sg * N[q + 1]; sz += sg * N[q + 2]; cnt++; }
        }
        if (!cnt) break;
        dir = unit([sx, sy, sz]);
      }
      var members = [], rest = [];
      for (i = 0; i < alive.length; i++) {
        var w = alive[i] * 3;
        if (Math.abs(N[w] * dir[0] + N[w + 1] * dir[1] + N[w + 2] * dir[2]) >= cone) members.push(alive[i]); else rest.push(alive[i]);
      }
      if (members.length < minMembers) { // слишком мало — убираем этот пик из голосования, чтобы он не мешал, и идём дальше
        alive = rest; continue;
      }
      // знак: ось «вверх» предпочитаем со знаком +, иначе — наибольшая по модулю компонента положительна
      var big = 0; for (i = 1; i < 3; i++) if (Math.abs(dir[i]) > Math.abs(dir[big])) big = i;
      if (dir[big] < 0) dir = mul(dir, -1);
      dirs.push({ dir: dir, members: members });
      alive = rest;
    }
    return dirs;
  }

  /* ---------- Плоскости ---------- */
  /* Метод наименьших квадратов по индексам (ids в P, count штук). Возвращает нормаль, смещение (n·x = d), центроид, rms, собственные значения. */
  function fitPlane(P, ids, count, ref) {
    var cx = 0, cy = 0, cz = 0, k, i;
    for (k = 0; k < count; k++) { i = ids[k] * 3; cx += P[i]; cy += P[i + 1]; cz += P[i + 2]; }
    cx /= count; cy /= count; cz /= count;
    var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (k = 0; k < count; k++) {
      i = ids[k] * 3; var x = P[i] - cx, y = P[i + 1] - cy, z = P[i + 2] - cz;
      xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
    }
    var e = eig3([xx / count, xy / count, xz / count, yy / count, yz / count, zz / count]);
    var nrm = e.vectors[0];
    if (ref && dot(nrm, ref) < 0) nrm = mul(nrm, -1);
    return { n: nrm, d: nrm[0] * cx + nrm[1] * cy + nrm[2] * cz, c: [cx, cy, cz], lam: e.values, ax: e.vectors };
  }

  /* По направлению dir и выборке участников — смещения → пик → плоскость; плоскость уточняется по плоским выборкам, затем по всем точкам.
   * Найденная плоскость вычитается из выборки, и поиск идёт дальше: так не появляются «двойники» одной и той же стены. */
  function planesFromDirection(G, ln, flat, dirInfo, o) {
    var P = G.P, n = G.n, dir = dirInfo.dir, planes = [], i, k, q;
    var rem = dirInfo.members.slice();
    var minCnt = Math.max(o.minPlaneSamples || 18, Math.round(dirInfo.members.length * 0.012));
    var N = ln.N, cosA = Math.cos(5 * DEG);   // нормали посчитаны для ВСЕХ точек: ln.ids[i] === i
    for (var round = 0; round < 14 && rem.length >= minCnt; round++) {
      // 1. пик гистограммы смещений вдоль направления
      var off = new Float64Array(rem.length), lo = Infinity, hi = -Infinity;
      for (i = 0; i < rem.length; i++) { q = ln.ids[rem[i]] * 3; var of = dir[0] * P[q] + dir[1] * P[q + 1] + dir[2] * P[q + 2]; off[i] = of; if (of < lo) lo = of; if (of > hi) hi = of; }
      var BW = 0.001, nb = Math.min(40000, Math.ceil((hi - lo) / BW) + 7), hist = new Float64Array(nb);
      for (i = 0; i < off.length; i++) hist[Math.min(nb - 1, ((off[i] - lo) / BW + 3) | 0)]++;
      var sm = new Float64Array(nb), sig = 2.5, rad = 7;
      for (i = 0; i < nb; i++) { if (!hist[i]) continue; for (k = -rad; k <= rad; k++) { var j = i + k; if (j >= 0 && j < nb) sm[j] += hist[i] * Math.exp(-0.5 * k * k / (sig * sig)); } }
      var bi = 0, bv = 0; for (i = 0; i < nb; i++) if (sm[i] > bv) { bv = sm[i]; bi = i; }
      var l = bi, r = bi; while (l > 0 && sm[l - 1] > 0.5 * bv) l--; while (r < nb - 1 && sm[r + 1] > 0.5 * bv) r++;
      var center = lo + (bi - 3 + 0.5) * BW, hw0 = Math.max(0.004, (r - l + 1) * BW);
      // 2. участники пика и уточнение по ним (по плоским выборкам, нормаль которых согласована с плоскостью)
      var cand = [];
      for (i = 0; i < rem.length; i++) if (Math.abs(off[i] - center) <= hw0) cand.push(rem[i]);
      if (cand.length < minCnt) { rem = rem.filter(function (s, idx) { return Math.abs(off[idx] - center) > hw0; }); continue; }
      var pl = null, band = hw0;
      for (var pass = 0; pass < 6; pass++) {
        var idsP = new Int32Array(cand.length); for (k = 0; k < cand.length; k++) idsP[k] = ln.ids[cand[k]];
        var f = fitPlane(P, idsP, idsP.length, pl ? pl.n : dir);
        var res = new Float64Array(cand.length); for (k = 0; k < cand.length; k++) { q = idsP[k] * 3; res[k] = Math.abs(f.n[0] * P[q] + f.n[1] * P[q + 1] + f.n[2] * P[q + 2] - f.d); }
        var rs = Float64Array.from(res).sort(), sg = Math.max(0.0004, 1.4826 * rs[rs.length >> 1]);
        band = clamp(3 * sg, 0.002, 0.02);
        pl = { n: f.n, d: f.d, sigma: sg };
        var next = [];
        for (i = 0; i < rem.length; i++) {
          q = ln.ids[rem[i]] * 3;
          var e = f.n[0] * P[q] + f.n[1] * P[q + 1] + f.n[2] * P[q + 2] - f.d;
          if (e < band && e > -band && Math.abs(N[rem[i] * 3] * f.n[0] + N[rem[i] * 3 + 1] * f.n[1] + N[rem[i] * 3 + 2] * f.n[2]) >= cosA) next.push(rem[i]);
        }
        var same = next.length === cand.length && next.every(function (v, idx) { return v === cand[idx]; });
        cand = next;
        if (same || cand.length < minCnt) break;
      }
      if (!pl || cand.length < minCnt) { rem = rem.filter(function (s) { return cand.indexOf(s) < 0; }); if (!cand.length) break; continue; }
      // 3. окончательно — по всем плоским точкам облака в коридоре плоскости (нормаль согласована: перпендикулярные стены, пересекающие коридор, не мешают)
      var nrm = pl.n, dd = pl.d, hw = clamp(3 * pl.sigma, 0.002, 0.02), fin = null, ff = null, rmsF = 0;
      for (var p2 = 0; p2 < 3; p2++) {
        fin = [];
        for (i = 0; i < n; i++) {
          if (!flat[i]) continue; q = i * 3;
          var ee = nrm[0] * P[q] + nrm[1] * P[q + 1] + nrm[2] * P[q + 2] - dd;
          if (ee < hw && ee > -hw && Math.abs(N[q] * nrm[0] + N[q + 1] * nrm[1] + N[q + 2] * nrm[2]) >= cosA) fin.push(i);
        }
        if (fin.length < 12) { ff = null; break; }
        ff = fitPlane(P, fin, fin.length, nrm);
        var ss = 0; for (k = 0; k < fin.length; k++) { q = fin[k] * 3; var e2 = ff.n[0] * P[q] + ff.n[1] * P[q + 1] + ff.n[2] * P[q + 2] - ff.d; ss += e2 * e2; }
        rmsF = Math.sqrt(ss / fin.length);
        var moved = Math.abs(ff.d - dd) + Math.abs(angleBetween(ff.n, nrm)) * 0.5;
        nrm = ff.n; dd = ff.d; hw = clamp(3.2 * rmsF, 0.002, 0.02);
        if (moved < 0.0002) break;
      }
      // вычитаем найденную плоскость из выборки
      var gone = new Set(cand); rem = rem.filter(function (s) { return !gone.has(s); });
      if (!ff) continue;
      planes.push({ n: ff.n, d: ff.d, c: ff.c, rms: rmsF, count: fin.length, hw: hw, inl: Int32Array.from(fin), lam: ff.lam, ax: ff.ax, samples: cand.length });
    }
    return planes;
  }

  /* Слияние двойников: почти одинаковые нормали и расстояние между плоскостями меньше коридора. */
  function mergePlanes(P, planes) {
    var out = [];
    planes.slice().sort(function (a, b) { return b.count - a.count; }).forEach(function (p) {
      for (var j = 0; j < out.length; j++) {
        var q = out[j];
        if (angleBetween(p.n, q.n) > 2 * DEG) continue;
        var s = dot(p.n, q.n) >= 0 ? 1 : -1;
        var gap = Math.abs(dot(q.n, sub(p.c, q.c)));
        if (gap > Math.max(0.004, 1.2 * (p.hw + q.hw) / 2)) continue;
        // сливаем: объединяем точки, пересчитываем
        var set = new Set(q.inl); var ids = Array.prototype.slice.call(q.inl);
        for (var k = 0; k < p.inl.length; k++) if (!set.has(p.inl[k])) ids.push(p.inl[k]);
        var f = fitPlane(P, ids, ids.length, q.n), ss = 0;
        for (k = 0; k < ids.length; k++) { var u = ids[k] * 3, e = f.n[0] * P[u] + f.n[1] * P[u + 1] + f.n[2] * P[u + 2] - f.d; ss += e * e; }
        out[j] = { n: f.n, d: f.d, c: f.c, rms: Math.sqrt(ss / ids.length), count: ids.length, hw: Math.max(p.hw, q.hw), inl: Int32Array.from(ids), lam: f.lam, ax: f.ax, samples: (p.samples || 0) + (q.samples || 0) };
        return;
      }
      out.push(p);
    });
    return out;
  }

  /* ---------- Куски плоскостей (связные участки) ---------- */
  function planeBasis(nrm) {
    var ay = Math.abs(nrm[1]), u, v;
    if (ay > 0.9) { u = unit(sub([1, 0, 0], mul(nrm, nrm[0]))); v = cross(nrm, u); }
    else { u = unit(cross(UP, nrm)); v = cross(nrm, u); if (v[1] < 0) { v = mul(v, -1); u = mul(u, -1); } }
    return { u: u, v: v };
  }
  /* Разбиваем точки плоскости на связные куски: растр в (u,v), ячейка cs, соседство через одну пустую ячейку. */
  function splitPatches(P, ids, nrm, cs, minPts) {
    var bs = planeBasis(nrm), u = bs.u, v = bs.v, m = ids.length, i;
    var U = new Float64Array(m), V = new Float64Array(m), umin = Infinity, vmin = Infinity, umax = -Infinity, vmax = -Infinity;
    for (i = 0; i < m; i++) {
      var q = ids[i] * 3, x = P[q], y = P[q + 1], z = P[q + 2];
      var a = x * u[0] + y * u[1] + z * u[2], b = x * v[0] + y * v[1] + z * v[2];
      U[i] = a; V[i] = b; if (a < umin) umin = a; if (a > umax) umax = a; if (b < vmin) vmin = b; if (b > vmax) vmax = b;
    }
    var W = Math.floor((umax - umin) / cs) + 1, H = Math.floor((vmax - vmin) / cs) + 1;
    if (W * H > 4e6) { var k2 = Math.sqrt(W * H / 4e6); cs *= k2; W = Math.floor((umax - umin) / cs) + 1; H = Math.floor((vmax - vmin) / cs) + 1; }
    var cell = new Int32Array(m), occ = new Uint8Array(W * H);
    for (i = 0; i < m; i++) { var cx = ((U[i] - umin) / cs) | 0, cy = ((V[i] - vmin) / cs) | 0; cell[i] = cy * W + cx; occ[cy * W + cx] = 1; }
    var lab = new Int32Array(W * H), nl = 0, stack = [];
    for (var s0 = 0; s0 < W * H; s0++) {
      if (!occ[s0] || lab[s0]) continue;
      nl++; lab[s0] = nl; stack.length = 0; stack.push(s0);
      while (stack.length) {
        var c = stack.pop(), x0 = c % W, y0 = (c - x0) / W;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
          var nx = x0 + dx, ny = y0 + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var cc = ny * W + nx; if (occ[cc] && !lab[cc]) { lab[cc] = nl; stack.push(cc); }
        }
      }
    }
    var groups = []; for (var l = 0; l <= nl; l++) groups.push([]);
    for (i = 0; i < m; i++) groups[lab[cell[i]]].push(ids[i]);
    var out = [];
    for (l = 1; l <= nl; l++) if (groups[l].length >= minPts) out.push(groups[l]);
    return out;
  }

  /* Всё облако → плоскости → куски. Возвращает {planes, patches, info}. */
  function detectSurfaces(pre, o) {
    o = o || {};
    var P = pre.P, n = pre.n, t0 = Date.now();
    var g0 = buildGrid(P, n, 0.05), sp = estimateSpacing(g0);
    var R = clamp(4.8 * sp, 0.022, 0.07);
    var G = buildGrid(P, n, R);
    var ln = localNormals(G, R, n);
    var flat = new Uint8Array(ln.m), nflat = 0, sds = [], i;
    for (i = 0; i < ln.m; i++) {
      if (ln.L0[i] < 0 || ln.K[i] < 10) continue;
      if (ln.L0[i] / Math.max(ln.L1[i], 1e-14) < 0.05 && Math.sqrt(ln.L0[i]) < 0.12 * R) { flat[i] = 1; nflat++; sds.push(Math.sqrt(ln.L0[i])); }
    }
    var noise = median(sds);
    var dirs = clusterDirections(ln, flat, o), raw = [];
    for (i = 0; i < dirs.length; i++) raw = raw.concat(planesFromDirection(G, ln, flat, dirs[i], o));
    raw = mergePlanes(P, raw);
    return { P: P, n: n, G: G, ln: ln, flat: flat, nflat: nflat, spacing: sp, R: R, noise: noise, dirs: dirs, rawPlanes: raw, ms: Date.now() - t0 };
  }

  /* ---------- Поверхности: куски плоскостей с растром «следа» ---------- */
  function buildSurfaces(S, o) {
    o = o || {};
    var P = S.P, n = S.n, cs = clamp(3 * S.spacing, 0.015, 0.05), minPts = Math.max(30, Math.round(0.002 * n)), out = [], pi, k, i;
    // «Рост» до настоящих краёв: плоские окрестности обрываются за радиус нормали от угла/края, а сами точки лежат на плоскости.
    // Добавляем к плоскости все ещё ничьи точки в её коридоре — так откосы, перемычки и стены доходят до рёбер.
    var owner = new Int32Array(n).fill(-1);
    S.rawPlanes.forEach(function (pl, idx) { for (var t = 0; t < pl.inl.length; t++) owner[pl.inl[t]] = idx; });
    for (pi = 0; pi < S.rawPlanes.length; pi++) {
      var pl = S.rawPlanes[pi], base = pl.inl, grow = [];
      for (i = 0; i < n; i++) {
        if (owner[i] !== -1) continue;
        var g3 = i * 3, eg = pl.n[0] * P[g3] + pl.n[1] * P[g3 + 1] + pl.n[2] * P[g3 + 2] - pl.d;
        if (eg <= pl.hw && eg >= -pl.hw) grow.push(i);
      }
      var ids0 = base;
      if (grow.length) { ids0 = new Int32Array(base.length + grow.length); ids0.set(base, 0); ids0.set(grow, base.length); for (k = 0; k < grow.length; k++) owner[grow[k]] = pi; }
      var groups = splitPatches(P, ids0, pl.n, cs, minPts);
      for (var gi = 0; gi < groups.length; gi++) {
        var ids = groups[gi], f = fitPlane(P, ids, ids.length, pl.n), ss = 0;
        for (k = 0; k < ids.length; k++) { var q = ids[k] * 3, e = f.n[0] * P[q] + f.n[1] * P[q + 1] + f.n[2] * P[q + 2] - f.d; ss += e * e; }
        var rms = Math.sqrt(ss / ids.length), ay = Math.abs(f.n[1]);
        var kind = ay >= Math.cos(8 * DEG) ? 'H' : ay <= Math.sin(8 * DEG) ? 'V' : 'I';
        var bs = planeBasis(f.n), u = bs.u, v = bs.v, U = new Float64Array(ids.length), V = new Float64Array(ids.length);
        var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
        for (k = 0; k < ids.length; k++) {
          q = ids[k] * 3; var a = P[q] * u[0] + P[q + 1] * u[1] + P[q + 2] * u[2], b = P[q] * v[0] + P[q + 1] * v[1] + P[q + 2] * v[2];
          U[k] = a; V[k] = b; if (a < umin) umin = a; if (a > umax) umax = a; if (b < vmin) vmin = b; if (b > vmax) vmax = b;
        }
        var W = Math.floor((umax - umin) / cs) + 1, H = Math.floor((vmax - vmin) / cs) + 1, csu = cs;
        if (W * H > 4e6) { csu = cs * Math.sqrt(W * H / 4e6); W = Math.floor((umax - umin) / csu) + 1; H = Math.floor((vmax - vmin) / csu) + 1; }
        var occ = new Uint8Array(W * H), cells = 0;
        for (k = 0; k < ids.length; k++) { var ci = (((V[k] - vmin) / csu) | 0) * W + (((U[k] - umin) / csu) | 0); if (!occ[ci]) { occ[ci] = 1; cells++; } }
        var area = cells * csu * csu, neff = Math.max(4, Math.min(ids.length, area / 0.0025));
        // истинная ширина куска (по главным осям, не по осям растра): полосы-касательные на трубах узкие при любом наклоне оси
        var mu = 0, mv = 0, cuu = 0, cuv = 0, cvv = 0;
        for (k = 0; k < ids.length; k++) { mu += U[k]; mv += V[k]; } mu /= ids.length; mv /= ids.length;
        for (k = 0; k < ids.length; k++) { var du = U[k] - mu, dv = V[k] - mv; cuu += du * du; cuv += du * dv; cvv += dv * dv; }
        var th = 0.5 * Math.atan2(2 * cuv, cuu - cvv), cmaj = Math.cos(th), smaj = Math.sin(th), pmn = new Float64Array(ids.length), pmj = new Float64Array(ids.length);
        for (k = 0; k < ids.length; k++) { var du2 = U[k] - mu, dv2 = V[k] - mv; pmj[k] = du2 * cmaj + dv2 * smaj; pmn[k] = -du2 * smaj + dv2 * cmaj; }
        pmn.sort(); pmj.sort();
        var minW = quantile(pmn, 0.995) - quantile(pmn, 0.005), majW = quantile(pmj, 0.995) - quantile(pmj, 0.005);
        out.push({
          id: out.length, planeId: pi, n: f.n, d: f.d, c: f.c, rms: rms, count: ids.length, ids: ids, kind: kind,
          u: u, v: v, U: U, V: V, ext: { u0: umin, u1: umax, v0: vmin, v1: vmax }, minW: minW, majW: majW, W: W, H: H, cs: csu, occ: occ, cells: cells, area: area,
          sigma: rms * Math.sqrt(1 / neff + 0.08), lam: f.lam
        });
      }
    }
    out.sort(function (a, b) { return b.count - a.count; });
    out.forEach(function (s2, idx) { s2.id = idx; });
    return out;
  }

  /* Базис для «следа» пары: e1 — вверх (для вертикальных пар) или X (для горизонтальных), e2 — вторая ось ⟂ m. */
  function footBasis(m) {
    var e1, e2;
    if (Math.abs(m[1]) > 0.9) { e1 = unit(sub([1, 0, 0], mul(m, m[0]))); e2 = cross(m, e1); }
    else { e1 = unit(sub(UP, mul(m, m[1]))); e2 = cross(m, e1); }
    return { e1: e1, e2: e2 };
  }
  function planeT(pl, x0, m) { return (pl.d - dot(pl.n, x0)) / dot(pl.n, m); }   // параметр t: x0 + t·m лежит на плоскости

  /* Пара почти параллельных кусков: расстояние между плоскостями в центре общего «следа», перекрытие следов, разброс расстояния по следу. */
  function pairInfo(A, B, P, o) {
    o = o || {};
    var cosang = dot(A.n, B.n);
    if (Math.abs(cosang) < COS_PAR) return null;
    var sg = cosang >= 0 ? 1 : -1, m = unit(add(A.n, mul(B.n, sg))), bs = footBasis(m), e1 = bs.e1, e2 = bs.e2;
    var cs = Math.max(A.cs, B.cs), k, q;
    function proj(S2) {
      var a = new Float64Array(S2.ids.length), b = new Float64Array(S2.ids.length);
      for (k = 0; k < S2.ids.length; k++) { q = S2.ids[k] * 3; a[k] = P[q] * e1[0] + P[q + 1] * e1[1] + P[q + 2] * e1[2]; b[k] = P[q] * e2[0] + P[q + 1] * e2[1] + P[q + 2] * e2[2]; }
      return { a: a, b: b };
    }
    var pa = proj(A), pb = proj(B), a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    [pa, pb].forEach(function (pp) { for (var i = 0; i < pp.a.length; i++) { if (pp.a[i] < a0) a0 = pp.a[i]; if (pp.a[i] > a1) a1 = pp.a[i]; if (pp.b[i] < b0) b0 = pp.b[i]; if (pp.b[i] > b1) b1 = pp.b[i]; } });
    var W = Math.floor((a1 - a0) / cs) + 1, H = Math.floor((b1 - b0) / cs) + 1;
    while (W * H > 1.5e6) { cs *= 1.5; W = Math.floor((a1 - a0) / cs) + 1; H = Math.floor((b1 - b0) / cs) + 1; }
    var gA = new Uint8Array(W * H), gB = new Uint8Array(W * H), nA = 0, nB = 0, i;
    for (i = 0; i < pa.a.length; i++) { var ca = (((pa.b[i] - b0) / cs) | 0) * W + (((pa.a[i] - a0) / cs) | 0); if (!gA[ca]) { gA[ca] = 1; nA++; } }
    for (i = 0; i < pb.a.length; i++) { var cb = (((pb.b[i] - b0) / cs) | 0) * W + (((pb.a[i] - a0) / cs) | 0); if (!gB[cb]) { gB[cb] = 1; nB++; } }
    var nBoth = 0, sa = 0, sb = 0, oa0 = Infinity, oa1 = -Infinity, ob0 = Infinity, ob1 = -Infinity;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var c = y * W + x;
      if (gA[c] && gB[c]) {
        nBoth++; var ax = a0 + (x + 0.5) * cs, by = b0 + (y + 0.5) * cs; sa += ax; sb += by;
        if (ax < oa0) oa0 = ax; if (ax > oa1) oa1 = ax; if (by < ob0) ob0 = by; if (by > ob1) ob1 = by;
      }
    }
    var info = { A: A, B: B, m: m, e1: e1, e2: e2, cs: cs, nA: nA, nB: nB, nBoth: nBoth, tilt: Math.acos(clamp(Math.abs(cosang), 0, 1)), sign: sg };
    info.iou = nBoth / Math.max(1, nA + nB - nBoth); info.covA = nBoth / Math.max(1, nA); info.covB = nBoth / Math.max(1, nB);
    if (!nBoth) { info.gap = null; return info; }
    var ac = sa / nBoth, bc = sb / nBoth, x0 = add(mul(e1, ac), mul(e2, bc));
    var tA = planeT(A, x0, m), tB = planeT(B, x0, m);
    info.center = x0; info.a = add(x0, mul(m, tA)); info.b = add(x0, mul(m, tB)); info.gap = Math.abs(tB - tA);
    info.ov = { a0: oa0 - cs / 2, a1: oa1 + cs / 2, b0: ob0 - cs / 2, b1: ob1 + cs / 2 };   // габарит общего следа в (e1,e2)
    var gs = [];
    [[info.ov.a0, info.ov.b0], [info.ov.a1, info.ov.b0], [info.ov.a0, info.ov.b1], [info.ov.a1, info.ov.b1]].forEach(function (pt) {
      var xx = add(mul(e1, pt[0]), mul(e2, pt[1])); gs.push(Math.abs(planeT(B, xx, m) - planeT(A, xx, m)));
    });
    info.gapMin = Math.min.apply(null, gs); info.gapMax = Math.max.apply(null, gs);
    return info;
  }

  /* ---------- Размеры ---------- */
  /* Погрешность положения плоскости в точке pt: rms·√(1/n + (отступ от центра)²/(n·разброс²) + 0,08) — тот же запас на неровность, что и в precision-snap.js */
  function sigmaAt(sf, pt) {
    var dv = sub(pt, sf.c), off = dot(dv, sf.n), inpl = sub(dv, mul(sf.n, off));
    var neff = Math.max(4, Math.min(sf.count, sf.area / 0.0025)), sd = Math.sqrt(Math.max(sf.lam ? sf.lam[1] : 0, 1e-10));
    return sf.rms * Math.sqrt(1 / neff + dot(inpl, inpl) / (neff * sd * sd) + 0.08);
  }
  var SIGMA_SYS = 0.0005;   // 0,5 мм — запас на систематику (калибровка, дрейф, шероховатость)

  function level(conf) { return conf >= 0.75 ? 'high' : conf >= 0.5 ? 'medium' : 'low'; }
  function makeDim(o) {
    var d = {
      key: o.key, label: o.label, dimension: o.dimension || null, value: o.value, sigma: o.sigma, method: o.method, how: o.how || '', confidence: clamp(o.confidence, 0, 1),
      a: o.a || null, b: o.b || null, group: o.group || null, tilt: o.tilt != null ? o.tilt : null, range: o.range || null, notes: o.notes || [],
      evidence: o.evidence || null, kind: o.kind || 'linear', checks: o.checks || null,
      ref: !!o.ref   // «привязка к окружению» (расстояние до пола и т. п.): это не размер самого объекта — не сохраняется автоматически
    };
    d.level = level(d.confidence);
    return d;
  }
  /* Уверенность размера «между двумя плоскостями»: чем больше точек, ровнее поверхности и лучше совпадают «следы», тем выше. */
  function pairConfidence(pi, A, B, extra) {
    var c = 0.92;
    var small = Math.min(A.count, B.count);
    if (small < 80) c -= 0.25; else if (small < 200) c -= 0.1;
    var rms = Math.max(A.rms, B.rms);
    if (rms > 0.006) c -= 0.2; else if (rms > 0.003) c -= 0.08;
    var cov = Math.max(pi.iou, Math.min(pi.covA, pi.covB));
    if (cov < 0.2) c -= 0.2; else if (cov < 0.4) c -= 0.1;
    var tiltDeg = pi.tilt / DEG;
    if (tiltDeg > 3) c -= 0.2; else if (tiltDeg > 1.5) c -= 0.08;
    if (pi.gapMax - pi.gapMin > Math.max(0.01, 0.01 * pi.gap)) c -= 0.1;
    return clamp(c + (extra || 0), 0.05, 0.98);
  }
  function gapSigma(pi) {
    var A = pi.A, B = pi.B, sa = sigmaAt(A, pi.a), sb = sigmaAt(B, pi.b);
    return Math.sqrt(sa * sa + sb * sb + SIGMA_SYS * SIGMA_SYS + Math.pow(0.0002 * pi.gap, 2));
  }

  /* Расстояние между кусками на заданной высоте/глубине (a,b — координаты в базисе пары). */
  function gapAtAB(pi, a, b) {
    var x = add(mul(pi.e1, a), mul(pi.e2, b));
    var tA = planeT(pi.A, x, pi.m), tB = planeT(pi.B, x, pi.m);
    return { gap: Math.abs(tB - tA), pa: add(x, mul(pi.m, tA)), pb: add(x, mul(pi.m, tB)) };
  }

  /* ---------- Дыры в плоскости (проём в стене) ---------- */
  /* Растр куска → связные пустые области (4-соседство), которые не прилегают к границе растра с двух сторон и больше 0,06 м².
   * Прилегание к нижней границе допустимо — это дверной проём, дальше ограниченный полом. */
  function detectHoles(H, o) {
    o = o || {};
    var W = H.W, Hh = H.H, occ = H.occ, cs = H.cs, lab = new Int32Array(W * Hh), out = [], stack = [], nl = 0;
    for (var s0 = 0; s0 < W * Hh; s0++) {
      if (occ[s0] || lab[s0]) continue;
      nl++; lab[s0] = nl; stack.length = 0; stack.push(s0);
      var cnt = 0, x0 = W, x1 = -1, y0 = Hh, y1 = -1, tl = false, tr = false, tb = false, tt = false;
      while (stack.length) {
        var c = stack.pop(), cx = c % W, cy = (c - cx) / W; cnt++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        if (cx === 0) tl = true; if (cx === W - 1) tr = true; if (cy === 0) tb = true; if (cy === Hh - 1) tt = true;
        if (cx > 0 && !occ[c - 1] && !lab[c - 1]) { lab[c - 1] = nl; stack.push(c - 1); }
        if (cx < W - 1 && !occ[c + 1] && !lab[c + 1]) { lab[c + 1] = nl; stack.push(c + 1); }
        if (cy > 0 && !occ[c - W] && !lab[c - W]) { lab[c - W] = nl; stack.push(c - W); }
        if (cy < Hh - 1 && !occ[c + W] && !lab[c + W]) { lab[c + W] = nl; stack.push(c + W); }
      }
      var area = cnt * cs * cs, w = (x1 - x0 + 1) * cs, h = (y1 - y0 + 1) * cs;
      if (area < 0.06 || w < 0.2 || h < 0.3) continue;
      var sides = (tl ? 1 : 0) + (tr ? 1 : 0) + (tb ? 1 : 0) + (tt ? 1 : 0);
      if (sides > 1) continue;                                // область снаружи куска или обрезанная рамкой
      var fill = cnt / ((x1 - x0 + 1) * (y1 - y0 + 1));
      if (fill < 0.7) continue;                               // не прямоугольник (пятно, тень от предмета)
      out.push({ x0: x0, x1: x1, y0: y0, y1: y1, cells: cnt, area: area, w: w, h: h, touches: { l: tl, r: tr, b: tb, t: tt }, label: nl });
    }
    return out;
  }

  /* Устойчивая прямая y(x) по точкам (МНК с отбраковкой выбросов). */
  function robustLine(xs, ys, iters) {
    var n = xs.length; if (n < 3) return null;
    var keep = new Uint8Array(n).fill(1), a = 0, b = 0;
    for (var it = 0; it < (iters || 3); it++) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, c = 0;
      for (var i = 0; i < n; i++) if (keep[i]) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; c++; }
      if (c < 3) return null;
      var den = c * sxx - sx * sx;
      b = Math.abs(den) > 1e-12 ? (c * sxy - sx * sy) / den : 0; a = (sy - b * sx) / c;
      var res = [];
      for (i = 0; i < n; i++) res.push(Math.abs(ys[i] - (a + b * xs[i])));
      var mad = median(res) * 1.4826, thr = Math.max(0.0015, 2.5 * mad);
      for (i = 0; i < n; i++) keep[i] = Math.abs(ys[i] - (a + b * xs[i])) <= thr ? 1 : 0;
    }
    var used = 0, ss = 0; for (i = 0; i < n; i++) if (keep[i]) { used++; var r = ys[i] - (a + b * xs[i]); ss += r * r; }
    return { a: a, b: b, n: used, total: n, rms: used ? Math.sqrt(ss / used) : 0 };
  }
  /* ---------- Проём как «дыра в стене» (запасной путь, когда откосов в кадре нет или они видны под скользящим углом) ---------- */
  /* «Силуэт» слоя стены: все точки облака в слое ±0,30 м от плоскости стены ложатся на её плоскость (u,v). Откосы, наличники, дверная коробка
   * попадают в слой и закрывают край дыры, а то, что видно через проём (дальняя стена, пол соседней комнаты), — нет. Пустая связная область
   * растра — проём; её края уточняются по крайним точкам полос (прямая u(v) с отбраковкой выбросов) и поправкой на разрежение точек. */
  function slabSilhouette(P, n, W, spacing, depth) {
    // ячейка растра: не меньше 2,5 шагов точек и не меньше, чем нужно, чтобы в ячейке стены в среднем было ~6 точек
    // (иначе на разреженном облаке случайные пустые ячейки сливаются с дырой и раздувают её)
    var dens = W.count / Math.max(W.area || 0, 0.5), cs = clamp(Math.max(2.5 * spacing, Math.sqrt(6 / Math.max(dens, 1))), 0.012, 0.09), u = W.u, v = W.v, nn = W.n, d = W.d, U = [], V = [], i;
    var du0 = W.ext.u0 - 0.15, du1 = W.ext.u1 + 0.15, dv0 = W.ext.v0 - 0.15, dv1 = W.ext.v1 + 0.15, E = [];
    for (i = 0; i < n; i++) {
      var q = i * 3, x = P[q], y = P[q + 1], z = P[q + 2], e = nn[0] * x + nn[1] * y + nn[2] * z - d;
      if (e > depth || e < -depth) continue;
      var a = x * u[0] + y * u[1] + z * u[2], b = x * v[0] + y * v[1] + z * v[2];
      if (a < du0 || a > du1 || b < dv0 || b > dv1) continue;
      U.push(a); V.push(b); E.push(e);
    }
    var m = U.length, Wd = Math.floor((du1 - du0) / cs) + 1, Hd = Math.floor((dv1 - dv0) / cs) + 1;
    if (Wd * Hd > 4e6) { var k2 = Math.sqrt(Wd * Hd / 4e6); cs *= k2; Wd = Math.floor((du1 - du0) / cs) + 1; Hd = Math.floor((dv1 - dv0) / cs) + 1; }
    var occ = new Uint8Array(Wd * Hd);
    for (i = 0; i < m; i++) occ[(((V[i] - dv0) / cs) | 0) * Wd + (((U[i] - du0) / cs) | 0)] = 1;
    // закрываем единичные «дырочки» (пропуски съёмки): ячейка пуста, а 7 из 8 соседей заняты
    var occ2 = occ.slice();
    for (var y2 = 1; y2 < Hd - 1; y2++) for (var x2 = 1; x2 < Wd - 1; x2++) {
      var c = y2 * Wd + x2; if (occ[c]) continue;
      var s8 = occ[c - 1] + occ[c + 1] + occ[c - Wd] + occ[c + Wd] + occ[c - Wd - 1] + occ[c - Wd + 1] + occ[c + Wd - 1] + occ[c + Wd + 1];
      if (s8 >= 7) occ2[c] = 1;
    }
    return { U: Float64Array.from(U), V: Float64Array.from(V), E: Float64Array.from(E), W: Wd, H: Hd, cs: cs, occ: occ2, ext: { u0: du0, v0: dv0 } };
  }

  /* Плоскость, почти параллельная осям: w = a + b·x + c·y, МНК с отбраковкой выбросов (допуск сужается до 2,8·1,48·MAD). */
  function fitTilted(Wv, X, Y, idx, tol0) {
    var keep = idx, tol = tol0, a = 0, b = 0, c = 0, rms = 0, it, k;
    for (it = 0; it < 8; it++) {
      var n = keep.length; if (n < 12) return null;
      var sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sw = 0, sxw = 0, syw = 0;
      for (k = 0; k < n; k++) { var i = keep[k], x = X[i], y = Y[i], w = Wv[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; sw += w; sxw += x * w; syw += y * w; }
      var sol = solveLinear([[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], [sw, sxw, syw], 3); if (!sol) return null;
      a = sol[0]; b = sol[1]; c = sol[2];
      var res = new Float64Array(idx.length);
      for (k = 0; k < idx.length; k++) { var j = idx[k]; res[k] = Math.abs(Wv[j] - (a + b * X[j] + c * Y[j])); }
      var srt = Float64Array.from(res).sort(), mad = 1.4826 * srt[srt.length >> 1];
      tol = clamp(2.8 * mad, 0.002, tol0);
      var nk = []; for (k = 0; k < idx.length; k++) if (res[k] <= tol) nk.push(idx[k]);
      var same = nk.length === keep.length && it > 1; keep = nk; if (same) break;
    }
    var ss = 0; for (k = 0; k < keep.length; k++) { var jj = keep[k], e = Wv[jj] - (a + b * X[jj] + c * Y[jj]); ss += e * e; }
    rms = keep.length ? Math.sqrt(ss / keep.length) : 0;
    return { a: a, b: b, c: c, n: keep.length, rms: rms, keep: keep };
  }

  function holeEdges(Sil, hole) {
    var cs = Sil.cs, U = Sil.U, V = Sil.V, m = U.length, u0 = Sil.ext.u0, v0 = Sil.ext.v0, i;
    var uL = u0 + hole.x0 * cs, uR = u0 + (hole.x1 + 1) * cs, vB = v0 + hole.y0 * cs, vT = v0 + (hole.y1 + 1) * cs;
    var h = vT - vB, w = uR - uL, uc = 0.5 * (uL + uR), vlo = vB + (hole.touches.b ? 0.05 : 0.12) * h, vhi = vT - 0.12 * h, ulo = uL + 0.12 * w, uhi = uR - 0.12 * w, band = cs;
    // левый/правый край: полосы по высоте; берём крайнюю точку слоя у границы дыры
    var Lx = [], Ly = [], Rx = [], Ry = [], cntL = 0, cntR = 0, bandsN = 0;
    for (var v = vlo; v + band <= vhi + 1e-9; v += band) {
      var mxL = -Infinity, mnR = Infinity;
      for (i = 0; i < m; i++) {
        var vi = V[i]; if (vi < v || vi >= v + band) continue;
        var ui = U[i];
        if (ui >= uL - 3 * cs && ui <= uL + 1.0 * cs && ui < uc) { if (ui > mxL) mxL = ui; }
        else if (ui >= uR - 1.0 * cs && ui <= uR + 3 * cs && ui > uc) { if (ui < mnR) mnR = ui; }
        if (ui >= uL - 8 * cs && ui < uL - 0.5 * cs) cntL++; else if (ui > uR + 0.5 * cs && ui <= uR + 8 * cs) cntR++;
      }
      bandsN++;
      if (isFinite(mxL)) { Lx.push(v + band / 2); Ly.push(mxL); }
      if (isFinite(mnR)) { Rx.push(v + band / 2); Ry.push(mnR); }
    }
    var left = robustLine(Lx, Ly), right = robustLine(Rx, Ry), vm = 0.5 * (vlo + vhi);
    // плотность точек у края (шт/м²): для поправки «крайняя точка → настоящий край» ≈ 1/(плотность·высота полосы)
    var stripeH = Math.max(band, bandsN * band), denL = cntL / (7.5 * cs * stripeH), denR = cntR / (7.5 * cs * stripeH);
    var top = null, bottom = null, topDen = 0;
    if (!hole.touches.t) {
      var Tx = [], Ty = [], cntT = 0;
      for (var uu = ulo; uu + band <= uhi + 1e-9; uu += band) {
        var mnT = Infinity;
        for (i = 0; i < m; i++) {
          var uj = U[i]; if (uj < uu || uj >= uu + band) continue;
          var vj = V[i];
          if (vj >= vT - 0.5 * cs && vj <= vT + 3 * cs) { if (vj < mnT) mnT = vj; }
          if (vj > vT + 0.5 * cs && vj <= vT + 8 * cs) cntT++;
        }
        if (isFinite(mnT)) { Tx.push(uu + band / 2); Ty.push(mnT); }
      }
      top = Tx.length ? robustLine(Tx, Ty) : null;
      topDen = cntT / (7.5 * cs * Math.max(band, (uhi - ulo)));
    }
    if (!hole.touches.b) {
      var Bx = [], By = [];
      for (uu = ulo; uu + band <= uhi + 1e-9; uu += band) {
        var mxB = -Infinity;
        for (i = 0; i < m; i++) { var uk = U[i]; if (uk < uu || uk >= uu + band) continue; var vk = V[i]; if (vk <= vB + 0.5 * cs && vk >= vB - 3 * cs && vk > mxB) mxB = vk; }
        if (isFinite(mxB)) { Bx.push(uu + band / 2); By.push(mxB); }
      }
      bottom = Bx.length ? robustLine(Bx, By) : null;
    }
    return { left: left, right: right, top: top, bottom: bottom, vm: vm, band: band, denL: denL, denR: denR, topDen: topDen, uL: uL, uR: uR, vB: vB, vT: vT, bands: bandsN };
  }

  /* Откосы по краям дыры: точки слоя рядом с найденным краем, лежащие «за» плоскостью стены (глубина 1,5–50 см), → плоскость u = a + b·глубина + c·высота.
   * «Сильный» откос — не менее 60 точек; если сильный только один, второй откос закрыт стеной (косой вид). */
  function guidedJambs(Sil, E, hole) {
    var U = Sil.U, V = Sil.V, D = Sil.E, m = U.length, h = E.vT - E.vB;
    var vlo = E.vB + (hole.touches.b ? 0.05 : 0.12) * h, vhi = E.vT - 0.12 * h, best = null;
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var iL = [], iR = [], i;
      for (i = 0; i < m; i++) {
        var v = V[i]; if (v < vlo || v > vhi) continue;
        var e = D[i] * sgn; if (e < 0.015 || e > 0.5) continue;
        if (Math.abs(U[i] - (E.left.a + E.left.b * v)) <= 0.04) iL.push(i);
        else if (Math.abs(U[i] - (E.right.a + E.right.b * v)) <= 0.04) iR.push(i);
      }
      var fL = iL.length >= 15 ? fitTilted(U, D, V, iL, 0.012) : null, fR = iR.length >= 15 ? fitTilted(U, D, V, iR, 0.012) : null;
      if (fL && fL.n < 60) fL = fL.n >= 15 ? { weak: true, n: fL.n, rms: fL.rms, a: fL.a, b: fL.b, c: fL.c, keep: fL.keep } : null;
      if (fR && fR.n < 60) fR = fR.n >= 15 ? { weak: true, n: fR.n, rms: fR.rms, a: fR.a, b: fR.b, c: fR.c, keep: fR.keep } : null;
      var sL = fL && !fL.weak, sR = fR && !fR.weak;
      if (!sL && !sR) continue;
      var score = sL && sR ? 2 * Math.min(fL.n, fR.n) : sL ? fL.n : fR.n;
      if (!best || score > best.score) best = { sgn: sgn, fL: fL, fR: fR, sL: !!sL, sR: !!sR, score: score };
    }
    if (!best) return null;
    var es = [];
    if (best.sL) best.fL.keep.forEach(function (i) { es.push(D[i] * best.sgn); });
    if (best.sR) best.fR.keep.forEach(function (i) { es.push(D[i] * best.sgn); });
    es.sort(function (a, b) { return a - b; });
    best.e0 = quantile(es, 0.01); best.e1 = quantile(es, 0.99); best.eMid = 0.5 * (best.e0 + best.e1); best.depth = best.e1 - best.e0;
    best.both = best.sL && best.sR;
    return best;
  }

  function holeOpenings(ctx) {
    var S = ctx.surfaces, P = ctx.P, n = ctx.S.n, out = [];
    var walls = S.filter(function (s) { return s.kind === 'V' && s.minW >= 0.6 && s.area >= 0.8; }).slice(0, 4);
    walls.forEach(function (W) {
      var Sil = slabSilhouette(P, n, W, ctx.S.spacing, 0.30);
      var holes = detectHoles({ W: Sil.W, H: Sil.H, occ: Sil.occ, cs: Sil.cs }, {});
      holes.forEach(function (hole) {
        var E = holeEdges(Sil, hole);
        if (!E.left || !E.right || E.left.n < 5 || E.right.n < 5) return;
        var J = guidedJambs(Sil, E, hole);
        out.push({ type: 'hole', wall: W, hole: hole, E: E, J: J, vm: E.vm, Sil: Sil });
      });
    });
    return out;
  }

  function holeObject(ho, ctx) {
    var W = ho.wall, E = ho.E, J = ho.J, u = W.u, v = W.v, nn = W.n, dims = [], notes = [], vm = ho.vm;
    function pt(uu, vv, e) { return add(add(add(mul(u, uu), mul(v, vv)), mul(nn, W.d)), mul(nn, e || 0)); }
    var wdim, uMid, eMid = 0, sp = ctx.S.spacing;
    var uLs = E.left.a + E.left.b * vm, uRs = E.right.a + E.right.b * vm;
    if (J && J.both) {
      // ширина «по плоскостям откосов» — на середине глубины и высоты, как и в основном способе
      var eloc = J.eMid * J.sgn;   // координата глубины в системе плоскости стены (знак восстановлен)
      eMid = eloc;
      var uL = J.fL.a + J.fL.b * eloc + J.fL.c * vm, uR = J.fR.a + J.fR.b * eloc + J.fR.c * vm, width = uR - uL;
      uMid = 0.5 * (uL + uR);
      var rmsJ = Math.max(J.fL.rms, J.fR.rms), nJ = Math.min(J.fL.n, J.fR.n), conf = 0.7;
      if (nJ < 100) conf -= 0.05;
      if (rmsJ > 0.004) conf -= 0.12; else if (rmsJ > 0.0025) conf -= 0.05;
      var tiltJ = Math.abs(Math.atan(J.fL.c) - Math.atan(J.fR.c));
      if (tiltJ > 1.5 * DEG) conf -= 0.1;
      if (J.depth < 0.1) conf -= 0.1;
      var sgJ = Math.sqrt(Math.pow(rmsJ * Math.sqrt(1 / Math.max(4, Math.min(nJ, 150)) + 0.08), 2) * 2 + Math.pow(0.5 * sp, 2) + SIGMA_SYS * SIGMA_SYS);
      wdim = makeDim({
        key: 'width', dimension: 'width', label: 'Ширина проёма', value: width, sigma: sgJ, method: 'planes', how: 'по откосам, найденным у края дыры', confidence: clamp(conf, 0.1, 0.8),
        a: pt(uL, vm, eloc), b: pt(uR, vm, eloc), tilt: tiltJ,
        notes: ['Откосы в кадре видны под скользящим углом (мало точек), поэтому они найдены «по краям дыры» в стене — точность ниже, чем при обычном замере откосов.'],
        evidence: { pointsA: J.fL.n, pointsB: J.fR.n, rmsA: J.fL.rms, rmsB: J.fR.rms }
      });
    } else if (J) {
      // виден один откос (второй закрыт стеной): ширина на плоскости стены = откос − край стены с другой стороны
      var fs = J.sL ? J.fL : J.fR, near = J.sL ? uRs : uLs, uFar = fs.a + fs.c * vm, wd0 = Math.abs(near - uFar);
      uMid = 0.5 * (near + uFar); eMid = J.eMid * J.sgn;
      var cJ = 0.48 - (fs.rms > 0.004 ? 0.1 : 0);
      wdim = makeDim({
        key: 'width', dimension: 'width', label: 'Ширина проёма', value: wd0, sigma: Math.sqrt(0.015 * 0.015 + fs.rms * fs.rms + SIGMA_SYS * SIGMA_SYS + Math.pow(0.5 * sp, 2)), method: 'edges', how: 'один откос + край стены (второй откос закрыт стеной)', confidence: clamp(cJ, 0.1, 0.5),
        a: pt(Math.min(near, uFar), vm, 0), b: pt(Math.max(near, uFar), vm, 0),
        notes: ['В кадре виден только один откос: ширина измерена на плоскости стены (у лицевой кромки). По середине глубины она может быть меньше (на 0–1 см), а на косом виде расхождение с настоящим размером достигало 4 см. Обведите проём спереди, чтобы были видны оба откоса.'],
        evidence: { pointsA: fs.n, rmsA: fs.rms }
      });
    } else {
      var width2 = uRs - uLs;
      uMid = 0.5 * (uLs + uRs);
      var rmsE = Math.max(E.left.rms, E.right.rms), c2 = 0.45;
      if (Math.min(E.left.n, E.right.n) < 10) c2 -= 0.1; if (rmsE > 0.004) c2 -= 0.1;
      wdim = makeDim({
        key: 'width', dimension: 'width', label: 'Ширина проёма', value: width2, sigma: Math.sqrt(0.015 * 0.015 + rmsE * rmsE + SIGMA_SYS * SIGMA_SYS), method: 'edges', how: 'по краям дыры в стене (узкое место)', confidence: clamp(c2, 0.1, 0.5),
        a: pt(uLs, vm, 0), b: pt(uRs, vm, 0), tilt: Math.abs(Math.atan(E.left.b) - Math.atan(E.right.b)),
        notes: ['Откосов в кадре нет: ширина взята по краям дыры в стене. Она зависит от того, насколько ровные и перпендикулярные откосы (разброс ±1–2 см, на косом виде до 4 см). Для точного значения обведите проём так, чтобы были видны боковые грани, или поставьте точки вручную.'],
        evidence: { rmsEdge: rmsE }
      });
    }
    dims.push(wdim);
    // глубина по откосам
    if (J && J.depth >= 0.05 && J.depth <= 1.5) {
      dims.push(makeDim({ key: 'depth', dimension: 'thickness', label: 'Глубина проёма (толщина стены)', value: J.depth, sigma: Math.sqrt(4 * sp * sp + SIGMA_SYS * SIGMA_SYS), method: 'extent', how: 'по длине откосов вдоль стены', confidence: 0.45, a: pt(uMid, vm, J.sgn * J.e0), b: pt(uMid, vm, J.sgn * J.e1), notes: ['Глубина равна толщине стены вместе с отделкой, если рамка охватила оба края откоса.'] }));
    }
    // высота: перемычка — пол
    var top = E.top;
    if (top && top.n >= 5) {
      var vTop = top.a + top.b * uMid, hconf = 0.42, how = 'верхний край дыры — пол', hs0 = Math.sqrt(Math.pow(top.rms / Math.sqrt(Math.max(4, top.n / 2)), 2) + 0.015 * 0.015 + SIGMA_SYS * SIGMA_SYS);
      // перемычка по плоскости: точки у верхнего края «за» плоскостью стены
      if (J) {
        var U = ho.Sil.U, V = ho.Sil.V, D = ho.Sil.E, idx = [], halfW = 0.5 * wdim.value * 0.85;
        for (var i = 0; i < U.length; i++) {
          var e = D[i] * J.sgn; if (e < 0.015 || e > 0.5) continue;
          if (U[i] < uMid - halfW || U[i] > uMid + halfW) continue;
          if (Math.abs(V[i] - (top.a + top.b * U[i])) <= 0.04) idx.push(i);
        }
        var fH = idx.length >= 15 ? fitTilted(V, D, U, idx, 0.012) : null;
        if (fH && fH.n >= 15) { vTop = fH.a + fH.b * eMid + fH.c * uMid; hconf = 0.62; how = 'перемычка (плоскость у края дыры) — пол'; hs0 = Math.sqrt(Math.pow(fH.rms * Math.sqrt(1 / Math.max(4, Math.min(fH.n, 150)) + 0.08), 2) + Math.pow(0.5 * sp, 2) + SIGMA_SYS * SIGMA_SYS); }
      }
      var vBot = null;
      var botEdge = false;
      if (E.bottom && E.bottom.n >= 5) {
        vBot = E.bottom.a + E.bottom.b * uMid; how = how.replace('пол', 'нижний край дыры'); botEdge = true;
        // Нижний край — линия по краю занятых ячеек растра: погрешность не меньше четверти ячейки плюс разброс точек (на разреженном или косом виде это сантиметр);
        // на реальном скане по косым видам расхождение с эталоном достигало 11 мм, поэтому «средней» уверенности такая высота достойна, только если ±σ невелика.
        var sBot = Math.sqrt(Math.pow(0.25 * ho.Sil.cs, 2) + E.bottom.rms * E.bottom.rms + 0.006 * 0.006);
        hs0 = Math.sqrt(hs0 * hs0 + sBot * sBot); hconf = Math.min(hconf, hs0 > 0.012 ? 0.45 : 0.58);
      }
      else if (ctx.floor && Math.abs(ctx.floor.n[1]) > 0.99) { var wp = pt(uMid, vTop, eMid), tf = planeT(ctx.floor, wp, v); vBot = vTop + tf; hconf += 0.05; }
      if (vBot != null && vTop - vBot > 0.3) {
        var hh = vTop - vBot;
        if (top.n < 10) hconf -= 0.1; if (top.rms > 0.004) hconf -= 0.1;
        dims.push(makeDim({ key: 'height', dimension: 'height', label: 'Высота проёма', value: hh, sigma: hs0, method: J && !botEdge ? 'planes' : 'edges', how: how, confidence: clamp(hconf, 0.1, 0.78), a: pt(uMid, vBot, eMid), b: pt(uMid, vTop, eMid) }));
      } else notes.push('Пол/нижний край проёма не определён — высота не вычислена (захватите пол).');
    } else notes.push('Верхний край проёма не попал в рамку — высота не определена.');
    return { type: 'opening', guess: 'opening', source: 'hole', title: 'Проём в стене', dims: dims, notes: notes, center: pt(uMid, vm, eMid), pointsUsed: W.count, score: 0.45 + 0.2 * wdim.confidence, raw: { A: { id: 'h' + W.id }, B: { id: 'h' + W.id } }, hole: { w: wdim.value } };
  }

  /* ---------- Проёмы: откосы + перемычка + пол (+ дыра в стене) ---------- */
  function findOpenings(ctx) {
    var S = ctx.surfaces, P = ctx.P, out = [], i, j, k;
    var Vs = S.filter(function (s) { return s.kind === 'V' && s.count >= 40; });
    var Hs = S.filter(function (s) { return s.kind === 'H' && s.count >= 40; });
    for (i = 0; i < Vs.length; i++) for (j = i + 1; j < Vs.length; j++) {
      var pi = pairInfo(Vs[i], Vs[j], P);
      if (!pi || pi.gap == null) continue;
      var hOv = pi.ov.a1 - pi.ov.a0, dOv = pi.ov.b1 - pi.ov.b0;
      if (pi.gap < 0.2 || pi.gap > 6 || hOv < 0.3 || dOv > 1.0) continue;
      if (pi.iou < 0.25 && Math.min(pi.covA, pi.covB) < 0.5) continue;
      var A = pi.A, B = pi.B, m = pi.m, e1 = pi.e1, e2 = pi.e2;
      var aMid = 0.5 * (pi.ov.a0 + pi.ov.a1), bMid = 0.5 * (pi.ov.b0 + pi.ov.b1);
      var x0 = add(mul(e1, aMid), mul(e2, bMid)), tA0 = planeT(A, x0, m), tB0 = planeT(B, x0, m), tMid = 0.5 * (tA0 + tB0);
      var xc = add(x0, mul(m, tMid));   // центр проёма в плоскости откосов (вдоль m — посередине)
      var halfGap = pi.gap / 2;
      // перемычка и пол: горизонтальные куски, которые перекрывают «окно» между откосами
      var heads = [], sills = [];
      for (k = 0; k < Hs.length; k++) {
        var X = Hs[k], cnt = 0, sy = 0;
        for (var q = 0; q < X.ids.length; q++) {
          var o3 = X.ids[q] * 3, px = P[o3], py = P[o3 + 1], pz = P[o3 + 2];
          var dm = (px - xc[0]) * m[0] + (py - xc[1]) * m[1] + (pz - xc[2]) * m[2];
          if (Math.abs(dm) > halfGap - 0.015) continue;
          var bb = px * e2[0] + py * e2[1] + pz * e2[2];
          if (bb < pi.ov.b0 - 0.04 || bb > pi.ov.b1 + 0.04) continue;
          cnt++; sy += px * e1[0] + py * e1[1] + pz * e1[2];
        }
        if (cnt < 20) continue;
        var ya = sy / cnt;   // координата вдоль «вверх»
        if (ya > aMid && ya < pi.ov.a1 + 0.6 && ya > pi.ov.a1 - 0.35) heads.push({ sf: X, y: ya, cnt: cnt });
        if (ya < aMid && ya > pi.ov.a0 - 0.6 && ya < pi.ov.a0 + 0.35) sills.push({ sf: X, y: ya, cnt: cnt });
      }
      heads.sort(function (a, b) { return a.y - b.y; });   // ближайшая к откосам сверху — перемычка
      sills.sort(function (a, b) { return b.y - a.y; });
      var head = heads.length ? heads[0] : null, sill = sills.length ? sills[0] : null;
      out.push({ type: 'opening', pi: pi, A: A, B: B, head: head, sill: sill, aMid: aMid, bMid: bMid, xc: xc, hOv: hOv, dOv: dOv });
    }
    return out;
  }


  /* ---------- Цилиндры: трубы, круглые воздуховоды, круглые колонны ---------- */
  /* Нормали окрестностей цилиндра лежат на «большом круге» (перпендикулярны оси) и при этом не одинаковы (в отличие от плоскости).
   * Поэтому ось находится по ковариации нормалей соседей: наименьшее собственное значение ↔ ось, второе значение ≫ 0 ↔ точка не на плоскости.
   * Оси всех точек голосуют в гистограмме направлений; для каждого пика ищем окружности в тонких слоях вдоль оси (слой 0,3 м: небольшая
   * ошибка наклона оси не размазывает окружность), затем собираем слои в «трек» одной трубы и уточняем цилиндр по всем её точкам (Гаусс–Ньютон). */
  var STD_DIAMETERS = {
    'сталь': [21.3, 26.9, 33.7, 42.4, 48.3, 60.3, 76.1, 88.9, 114.3, 139.7, 168.3, 219.1, 273, 323.9, 355.6, 406.4],
    'ПВХ/ПП': [16, 20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160, 200, 250, 315, 400],
    'медь': [12, 15, 18, 22, 28, 35, 42, 54]
  };
  function nearestStandard(dMeters) {
    var best = null, dm = dMeters * 1000;
    Object.keys(STD_DIAMETERS).forEach(function (fam) {
      STD_DIAMETERS[fam].forEach(function (s) { var e = Math.abs(s - dm); if (!best || e < best.delta - 1e-9) best = { d: s, delta: e, family: fam }; });
    });
    return best;
  }

  /* Решение A·x = b (n ≤ 6) методом Гаусса с выбором ведущего элемента; A меняется. Возвращает null для вырожденной системы. */
  function solveLinear(A, b, n) {
    var i, j, k, p, t;
    for (i = 0; i < n; i++) {
      p = i; for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      if (Math.abs(A[p][i]) < 1e-18) return null;
      if (p !== i) { t = A[i]; A[i] = A[p]; A[p] = t; t = b[i]; b[i] = b[p]; b[p] = t; }
      for (j = i + 1; j < n; j++) { var f = A[j][i] / A[i][i]; if (f === 0) continue; for (k = i; k < n; k++) A[j][k] -= f * A[i][k]; b[j] -= f * b[i]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = b[i]; for (j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    return x;
  }
  function invertSmall(M, n) {
    var out = [], i, j;
    for (j = 0; j < n; j++) {
      var A = M.map(function (r) { return r.slice(); }), e = new Array(n).fill(0); e[j] = 1;
      var x = solveLinear(A, e, n); if (!x) return null; out.push(x);
    }
    var R = []; for (i = 0; i < n; i++) { R.push([]); for (j = 0; j < n; j++) R[i].push(out[j][i]); }
    return R;
  }

  /* Окружность по точкам (p,q): алгебраический Касa → геометрический Гаусс–Ньютон (3 параметра) с весами Хьюбера. Индексы — в массивах F.p, F.q. */
  function fitCircle2D(F, list, cnt, c0) {
    var cx, cy, r, k, j;
    if (c0) { cx = c0.cx; cy = c0.cy; r = c0.r; }
    else {
      var sx = 0, sy = 0; for (k = 0; k < cnt; k++) { sx += F.p[list[k]]; sy += F.q[list[k]]; }
      sx /= cnt; sy /= cnt;
      var suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
      for (k = 0; k < cnt; k++) { j = list[k]; var u = F.p[j] - sx, v = F.q[j] - sy; suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
      var det = suu * svv - suv * suv; if (Math.abs(det) < 1e-18) return null;
      var b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu), uc = (b1 * svv - b2 * suv) / det, vc = (b2 * suu - b1 * suv) / det;
      cx = sx + uc; cy = sy + vc; r = Math.sqrt(Math.max(1e-12, uc * uc + vc * vc + (suu + svv) / cnt));
    }
    for (var it = 0; it < 8; it++) {
      var a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, g1 = 0, g2 = 0, g3 = 0, res = new Float64Array(cnt);
      for (k = 0; k < cnt; k++) { j = list[k]; var dx = F.p[j] - cx, dy = F.q[j] - cy, d = Math.sqrt(dx * dx + dy * dy) || 1e-9; res[k] = d - r; }
      var ra = Float64Array.from(res, Math.abs).sort(), sg = Math.max(0.0003, 1.4826 * ra[ra.length >> 1]), hub = 1.5 * sg;
      for (k = 0; k < cnt; k++) {
        j = list[k]; dx = F.p[j] - cx; dy = F.q[j] - cy; d = Math.sqrt(dx * dx + dy * dy) || 1e-9;
        var w = Math.abs(res[k]) <= hub ? 1 : hub / Math.abs(res[k]), jx = -dx / d, jy = -dy / d, e = res[k];
        a11 += w * jx * jx; a12 += w * jx * jy; a13 += w * jx * -1; a22 += w * jy * jy; a23 += w * jy * -1; a33 += w;
        g1 += w * jx * e; g2 += w * jy * e; g3 += w * -1 * e;
      }
      var sol = solveLinear([[a11 + 1e-12, a12, a13], [a12, a22 + 1e-12, a23], [a13, a23, a33 + 1e-12]], [-g1, -g2, -g3], 3);
      if (!sol) break;
      cx += sol[0]; cy += sol[1]; r += sol[2];
      if (Math.abs(sol[0]) + Math.abs(sol[1]) + Math.abs(sol[2]) < 1e-6) break;
      if (!(r > 1e-4) || r > 50) return null;
    }
    return { cx: cx, cy: cy, r: r };
  }

  /* Покрытие дуги: доля занятых секторов по 10° → угол охвата (°). */
  function arcCoverage(F, list, cnt, c) {
    var bins = new Int32Array(36), k, j;
    for (k = 0; k < cnt; k++) { j = list[k]; var ang = Math.atan2(F.q[j] - c.cy, F.p[j] - c.cx); bins[Math.min(35, Math.floor((ang + Math.PI) / (2 * Math.PI) * 36))]++; }
    var occ = 0; for (k = 0; k < 36; k++) if (bins[k] >= 2) occ++;
    // наибольший пропуск подряд
    var best = 0, run = 0; for (k = 0; k < 72; k++) { if (bins[k % 36] < 2) { run++; if (run > best) best = run; } else run = 0; }
    return { deg: occ * 10, gapDeg: Math.min(360, best * 10) };
  }

  /* Сбор участников окружности: |расстояние − r| ≤ tol и нормаль направлена к центру (в пределах acos(cosN)). */
  function circleInliers(F, alive, c, tol, cosN) {
    var out = [];
    for (var k = 0; k < alive.length; k++) {
      var j = alive[k], dx = F.p[j] - c.cx, dy = F.q[j] - c.cy, d = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(d - c.r) > tol || d < 1e-9) continue;
      if (Math.abs((dx * F.mp[j] + dy * F.mq[j]) / d) >= cosN) out.push(j);
    }
    return out;
  }

  function refineCircle(F, alive, c, o) {
    var tol = Math.max(0.006, 0.15 * c.r), cur = c, inl = null, i, k;
    for (var it = 0; it < 6; it++) {
      inl = circleInliers(F, alive, cur, tol, it < 2 ? 0.8 : 0.9);
      if (inl.length < 14) return null;
      var f = fitCircle2D(F, inl, inl.length, it === 0 ? null : cur);
      if (!f || !(f.r >= (o.rMin || 0.02) * 0.8) || f.r > (o.rMax || 0.35) * 1.3) return null;
      cur = f;
      var rs = new Float64Array(inl.length);
      for (k = 0; k < inl.length; k++) { var j = inl[k]; rs[k] = Math.abs(Math.sqrt(Math.pow(F.p[j] - f.cx, 2) + Math.pow(F.q[j] - f.cy, 2)) - f.r); }
      rs.sort();
      tol = clamp(3 * 1.4826 * rs[rs.length >> 1], 0.0025, Math.max(0.006, 0.12 * f.r));
    }
    inl = circleInliers(F, alive, cur, tol, 0.9);
    if (inl.length < 25) return null;
    var ss = 0; for (k = 0; k < inl.length; k++) { var jj = inl[k]; var e = Math.sqrt(Math.pow(F.p[jj] - cur.cx, 2) + Math.pow(F.q[jj] - cur.cy, 2)) - cur.r; ss += e * e; }
    var arc = arcCoverage(F, inl, inl.length, cur), rms = Math.sqrt(ss / inl.length);
    if (arc.deg < 50 || rms > 0.1 * cur.r) return null;
    return { cx: cur.cx, cy: cur.cy, r: cur.r, inl: inl, arc: arc.deg, gap: arc.gapDeg, rms: rms };
  }

  /* Пик в пространстве параметров (центр, радиус): каждая точка голосует за центры c = x ∓ r·m при всех радиусах. Возвращает кандидатов по убыванию. */
  function houghPeaks(F, alive, o, maxPeaks) {
    var rmin = o.rMin || 0.02, rmax = o.rMax || 0.35, f = 1.07, radii = [], r;
    for (r = rmin; r <= rmax * 1.001; r *= f) radii.push(r);
    var K = radii.length, p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity, k, i, j;
    for (i = 0; i < alive.length; i++) { j = alive[i]; if (F.p[j] < p0) p0 = F.p[j]; if (F.p[j] > p1) p1 = F.p[j]; if (F.q[j] < q0) q0 = F.q[j]; if (F.q[j] > q1) q1 = F.q[j]; }
    p0 -= rmax; q0 -= rmax; p1 += rmax; q1 += rmax;
    var cs = o.houghCell || 0.01, nx, ny;
    for (;;) { nx = Math.ceil((p1 - p0) / cs) + 1; ny = Math.ceil((q1 - q0) / cs) + 1; if (nx * ny * K <= 1.4e7) break; cs *= 1.25; }
    var acc = new Uint16Array(nx * ny * K), inv = 1 / cs, plane = nx * ny;
    for (i = 0; i < alive.length; i++) {
      j = alive[i]; var px = F.p[j], py = F.q[j], mx = F.mp[j], my = F.mq[j];
      for (var sgn = -1; sgn <= 1; sgn += 2) for (k = 0; k < K; k++) {
        var ix = ((px - sgn * radii[k] * mx - p0) * inv) | 0, iy = ((py - sgn * radii[k] * my - q0) * inv) | 0;
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
        var ci = k * plane + iy * nx + ix; if (acc[ci] < 65535) acc[ci]++;
      }
    }
    var vmax = 0; for (i = 0; i < acc.length; i++) if (acc[i] > vmax) vmax = acc[i];
    if (vmax < 8) return [];
    var thr = Math.max(8, Math.floor(0.45 * vmax)), cand = [];
    for (i = 0; i < acc.length; i++) if (acc[i] >= thr) cand.push(i);
    if (cand.length > 6000) { cand.sort(function (a, b) { return acc[b] - acc[a] || a - b; }); cand.length = 6000; }
    function sum3(ci) {
      var kz = Math.floor(ci / plane), rem = ci - kz * plane, iy = Math.floor(rem / nx), ix = rem - iy * nx, s = 0;
      for (var dk = -1; dk <= 1; dk++) { var kk = kz + dk; if (kk < 0 || kk >= K) continue; for (var dy = -1; dy <= 1; dy++) { var yy = iy + dy; if (yy < 0 || yy >= ny) continue; for (var dx = -1; dx <= 1; dx++) { var xx = ix + dx; if (xx < 0 || xx >= nx) continue; s += acc[kk * plane + yy * nx + xx]; } } }
      return s;
    }
    var scored = cand.map(function (ci) { return { ci: ci, s: sum3(ci) }; }).sort(function (a, b) { return b.s - a.s || a.ci - b.ci; });
    var peaks = [];
    for (i = 0; i < scored.length && peaks.length < (maxPeaks || 6); i++) {
      var ci2 = scored[i].ci, kz2 = Math.floor(ci2 / plane), rm2 = ci2 - kz2 * plane, iy2 = Math.floor(rm2 / nx), ix2 = rm2 - iy2 * nx, near = false;
      for (j = 0; j < peaks.length; j++) if (Math.abs(peaks[j].k - kz2) <= 3 && Math.abs(peaks[j].ix - ix2) <= 4 && Math.abs(peaks[j].iy - iy2) <= 4) { near = true; break; }
      if (near) continue;
      peaks.push({ cx: p0 + (ix2 + 0.5) * cs, cy: q0 + (iy2 + 0.5) * cs, r: radii[kz2], k: kz2, ix: ix2, iy: iy2, votes: scored[i].s });
    }
    return peaks;
  }

  /* Окружности в одном слое. */
  function slabCircles(F, list, o) {
    var out = [], alive = Array.prototype.slice.call(list), guard = 0;
    while (alive.length >= 25 && guard++ < 7) {
      var peaks = houghPeaks(F, alive, o, 5), got = null;
      for (var pi = 0; pi < peaks.length && !got; pi++) got = refineCircle(F, alive, peaks[pi], o);
      if (!got) break;
      out.push(got);
      var gone = new Set(got.inl); alive = alive.filter(function (j) { return !gone.has(j); });
    }
    return out;
  }

  /* Цилиндр по 3D-точкам: 5 параметров (смещение центра в плоскости ⟂ оси, наклон оси, радиус), Гаусс–Ньютон с весами Хьюбера. */
  function fitCylinder3D(P, ids, cnt, a0, c0, r0) {
    var bs = planeBasis(a0), e1 = bs.u, e2 = bs.v, prm = [0, 0, 0, 0, r0], it, k;
    function model(pm) {
      var a = unit([a0[0] + pm[2] * e1[0] + pm[3] * e2[0], a0[1] + pm[2] * e1[1] + pm[3] * e2[1], a0[2] + pm[2] * e1[2] + pm[3] * e2[2]]);
      var c = [c0[0] + pm[0] * e1[0] + pm[1] * e2[0], c0[1] + pm[0] * e1[1] + pm[1] * e2[1], c0[2] + pm[0] * e1[2] + pm[1] * e2[2]];
      return { a: a, c: c };
    }
    function resid(pm, out) {
      var md = model(pm), a = md.a, c = md.c;
      for (var i = 0; i < cnt; i++) {
        var q = ids[i] * 3, wx = P[q] - c[0], wy = P[q + 1] - c[1], wz = P[q + 2] - c[2], t = wx * a[0] + wy * a[1] + wz * a[2];
        var rx = wx - t * a[0], ry = wy - t * a[1], rz = wz - t * a[2];
        out[i] = Math.sqrt(rx * rx + ry * ry + rz * rz) - pm[4];
      }
    }
    var r0v = new Float64Array(cnt), r1v = new Float64Array(cnt), J = [], lam = 1e-6, cost0 = Infinity, cov = null, sgm = 0;
    for (k = 0; k < 5; k++) J.push(new Float64Array(cnt));
    for (it = 0; it < 14; it++) {
      resid(prm, r0v);
      var ra = Float64Array.from(r0v, Math.abs).sort(), sg = Math.max(0.0003, 1.4826 * ra[ra.length >> 1]), hub = 1.5 * sg, i, cost = 0;
      for (k = 0; k < 5; k++) {
        var pp = prm.slice(), h = k < 2 ? 1e-4 : k < 4 ? 1e-5 : 1e-4; pp[k] += h; resid(pp, r1v);
        for (i = 0; i < cnt; i++) J[k][i] = (r1v[i] - r0v[i]) / h;
      }
      var A = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], g = [0, 0, 0, 0, 0], wsum = 0;
      for (i = 0; i < cnt; i++) {
        var e = r0v[i], w = Math.abs(e) <= hub ? 1 : hub / Math.abs(e); wsum += w; cost += w * e * e;
        for (k = 0; k < 5; k++) { g[k] += w * J[k][i] * e; for (var l = k; l < 5; l++) A[k][l] += w * J[k][i] * J[l][i]; }
      }
      for (k = 0; k < 5; k++) for (l = 0; l < k; l++) A[k][l] = A[l][k];
      var An = A.map(function (r) { return r.slice(); });
      for (k = 0; k < 5; k++) An[k][k] += lam * (A[k][k] + 1e-9);
      var step = solveLinear(An, g.map(function (v) { return -v; }), 5);
      if (!step) return null;
      var np = prm.map(function (v, idx) { return v + step[idx]; });
      resid(np, r1v); var cost1 = 0; for (i = 0; i < cnt; i++) { var e1v = r1v[i], w1 = Math.abs(e1v) <= hub ? 1 : hub / Math.abs(e1v); cost1 += w1 * e1v * e1v; }
      if (cost1 <= cost) { prm = np; lam = Math.max(1e-9, lam * 0.3); } else { lam *= 10; if (lam > 1e6) break; }
      if (Math.abs(cost - cost1) < 1e-12 * Math.max(1, cost) && cost1 <= cost) { cost0 = cost1; break; }
      cost0 = cost1;
      var mv = Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[4]) + 20 * (Math.abs(step[2]) + Math.abs(step[3]));
      if (mv < 1e-7 && cost1 <= cost) break;
    }
    resid(prm, r0v);
    var ss = 0; for (k = 0; k < cnt; k++) ss += r0v[k] * r0v[k];
    sgm = Math.sqrt(ss / Math.max(1, cnt - 5));
    // ковариация по последнему якобиану
    for (k = 0; k < 5; k++) {
      var pq = prm.slice(), hh = k < 2 ? 1e-4 : k < 4 ? 1e-5 : 1e-4; pq[k] += hh; resid(pq, r1v);
      for (var ii = 0; ii < cnt; ii++) J[k][ii] = (r1v[ii] - r0v[ii]) / hh;
    }
    var N5 = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    for (ii = 0; ii < cnt; ii++) for (k = 0; k < 5; k++) for (var l2 = k; l2 < 5; l2++) N5[k][l2] += J[k][ii] * J[l2][ii];
    for (k = 0; k < 5; k++) for (l2 = 0; l2 < k; l2++) N5[k][l2] = N5[l2][k];
    cov = invertSmall(N5, 5);
    var md = model(prm);
    return { a: md.a, c: md.c, r: prm[4], rms: sgm, cov: cov, tiltRaw: [prm[2], prm[3]], basis: [e1, e2] };
  }


  /* ---------- Форма сечения: окружность или прямоугольник ----------
   * Труба и воздуховод на скане одинаково «похожи на цилиндр»: подгонка окружности берёт только точки у самой окружности (допуск 12 % радиуса),
   * поэтому у прямоугольного короба при шуме 8–12 мм «набирается» дуга 260° и рождается ложная труба. Здесь проверяются ВСЕ точки рядом с
   * найденной осью, в том числе отброшенные подгонкой: у настоящей трубы они лежат на окружности, у короба — на двух-четырёх прямых сторонах.
   * Возврат: { shape: 'circle'|'rect', rmsC, rmsR, extra (доля «лишних» точек), rect? } — rect: ширина и высота по сторонам и их видимость. */
  function crossSection(P, n, sel, fin, bs, t0, t1, spacing) {
    var r = fin.r, a = fin.a, c = fin.c, i, k, selMark = new Uint8Array(n), cell = Math.max(0.03, 3 * spacing), grid = new Map();
    // все точки рядом с осью (в «трубке» радиуса 2,2·r + 3 см и по длине найденного участка); от выбранных точек сращиваем СВЯЗНУЮ область: так к ним
    // добавляются и отброшенные подгонкой части короба (углы, грани), а не относящиеся к нему соседи (потолок, стена) — нет
    var dMax = 2.2 * r + 0.03, tLo = t0 - 0.02, tHi = t1 + 0.02, tube = [], R3 = [];
    function ckey(ix, iy, iz) { return ((ix + 4096) * 8192 + (iy + 4096)) * 8192 + (iz + 4096); }
    for (k = 0; k < sel.length; k++) selMark[sel[k]] = 1;
    for (i = 0; i < n; i++) {
      var q = i * 3, wx = P[q] - c[0], wy = P[q + 1] - c[1], wz = P[q + 2] - c[2], t = wx * a[0] + wy * a[1] + wz * a[2];
      if (t < tLo || t > tHi) continue;
      var rx = wx - t * a[0], ry = wy - t * a[1], rz = wz - t * a[2], d2 = rx * rx + ry * ry + rz * rz;
      if (!selMark[i] && (d2 > dMax * dMax || d2 < 0.16 * r * r)) continue;
      tube.push(i); R3.push(rx, ry, rz);
      var ck = ckey(Math.floor(P[q] / cell), Math.floor(P[q + 1] / cell), Math.floor(P[q + 2] / cell)), lst = grid.get(ck);
      if (lst) lst.push(tube.length - 1); else grid.set(ck, [tube.length - 1]);
    }
    var inSet = new Uint8Array(tube.length), qx = [], qy = [], qz = [], head = 0, seenCell = new Set();
    for (k = 0; k < tube.length; k++) if (selMark[tube[k]]) {
      inSet[k] = 1; var q1 = tube[k] * 3, ix1 = Math.floor(P[q1] / cell), iy1 = Math.floor(P[q1 + 1] / cell), iz1 = Math.floor(P[q1 + 2] / cell), ck1 = ckey(ix1, iy1, iz1);
      if (!seenCell.has(ck1)) { seenCell.add(ck1); qx.push(ix1); qy.push(iy1); qz.push(iz1); }
    }
    while (head < qx.length) {
      var cx = qx[head], cy = qy[head], cz = qz[head]; head++;
      for (var ax = -1; ax <= 1; ax++) for (var ay = -1; ay <= 1; ay++) for (var az = -1; az <= 1; az++) {
        var nk = ckey(cx + ax, cy + ay, cz + az);
        if (seenCell.has(nk)) continue;
        var lst2 = grid.get(nk); if (!lst2) continue;
        seenCell.add(nk); qx.push(cx + ax); qy.push(cy + ay); qz.push(cz + az); for (var li = 0; li < lst2.length; li++) inSet[lst2[li]] = 1;
      }
    }
    var pp = [], qq = [], isSel = [], members = [];
    for (k = 0; k < tube.length; k++) if (inSet[k]) {
      var rr3 = k * 3; pp.push(R3[rr3] * bs.u[0] + R3[rr3 + 1] * bs.u[1] + R3[rr3 + 2] * bs.u[2]); qq.push(R3[rr3] * bs.v[0] + R3[rr3 + 1] * bs.v[1] + R3[rr3 + 2] * bs.v[2]); isSel.push(selMark[tube[k]] ? 1 : 0); members.push(tube[k]);
    }
    var m = pp.length, nSel = sel.length, extra = m > 0 ? (m - nSel) / m : 0;
    if (m < 40) return { shape: 'circle', rmsC: fin.rms, rmsR: Infinity, extra: extra, n: m };
    // окружность — отклонение ВСЕХ точек от найденной окружности (с центром, пересчитанным по облаку точек сечения)
    var sx = 0, sy = 0; for (k = 0; k < m; k++) { sx += pp[k]; sy += qq[k]; }
    var ss = 0; for (k = 0; k < m; k++) { var dd = Math.hypot(pp[k], qq[k]) - r; ss += dd * dd; }
    var rmsC = Math.sqrt(ss / m);
    // окружность описывает ВСЕ точки сечения не хуже порога — это труба, прямоугольник не нужен (дешёвый выход)
    if (!(rmsC > Math.max(0.05 * r, 1.5 * fin.rms + 0.003))) return { shape: 'circle', rmsC: rmsC, rmsR: Infinity, extra: extra, n: m };
    // для подбора сторон хватает нескольких тысяч точек: берём каждую k-ю
    if (m > 6000) { var stp = Math.ceil(m / 6000), p2 = [], q2 = []; for (k = 0; k < m; k += stp) { p2.push(pp[k]); q2.push(qq[k]); } pp = p2; qq = q2; m = pp.length; }
    // прямоугольник: перебор поворота; стороны — по квантилям 1…99 % в повёрнутых осях; ошибка — расстояние до ближайшей из четырёх сторон
    function rectAt(phi) {
      var co = Math.cos(phi), si = Math.sin(phi), xs = new Float64Array(m), ys = new Float64Array(m), j, it;
      for (j = 0; j < m; j++) { xs[j] = pp[j] * co + qq[j] * si; ys[j] = -pp[j] * si + qq[j] * co; }
      var sx2 = Float64Array.from(xs).sort(), sy2 = Float64Array.from(ys).sort(), lo = Math.floor(0.01 * (m - 1)), hi = Math.ceil(0.99 * (m - 1));
      var E = [sx2[lo], sx2[hi], sy2[lo], sy2[hi]], tolr = Math.max(0.015, 0.1 * Math.min(E[1] - E[0], E[3] - E[2])), rms = 0;
      function err() { var e2 = 0; for (var jj = 0; jj < m; jj++) { var dm = Math.min(Math.abs(xs[jj] - E[0]), Math.abs(xs[jj] - E[1]), Math.abs(ys[jj] - E[2]), Math.abs(ys[jj] - E[3])); e2 += dm * dm; } return Math.sqrt(e2 / m); }
      // стороны — это не крайние точки (их выбрасывает шум наружу), а середина слоя точек на стороне: медиана точек у стороны
      for (it = 0; it < 4; it++) {
        for (var e = 0; e < 4; e++) {
          var pos = e < 2 ? xs : ys, al = e < 2 ? ys : xs, a0 = e < 2 ? E[2] : E[0], a1 = e < 2 ? E[3] : E[1], v = [], vEnd = [], mid = 0, lo2 = a0 + 0.2 * (a1 - a0), hi2 = a1 - 0.2 * (a1 - a0);
          for (j = 0; j < m; j++) {
            var dj = Math.abs(pos[j] - E[e]);
            if (dj <= tolr && al[j] >= a0 - tolr && al[j] <= a1 + tolr) { v.push(pos[j]); if (al[j] >= lo2 && al[j] <= hi2) mid++; }
            if (dj <= 3 * tolr + 0.01 && al[j] >= a0 - tolr && al[j] <= a1 + tolr) vEnd.push(pos[j]);
          }
          if (mid >= 20 && v.length >= 20) { v.sort(function (x, y) { return x - y; }); E[e] = v[v.length >> 1]; }          // грань видна: её середина — медиана слоя точек
          else if (vEnd.length >= 20) { vEnd.sort(function (x, y) { return x - y; }); E[e] = e % 2 === 0 ? vEnd[Math.floor(0.01 * (vEnd.length - 1))] : vEnd[Math.ceil(0.99 * (vEnd.length - 1))]; }   // грани нет: ребро — торцы соседних граней, у них координата без шума
        }
        rms = err(); tolr = Math.max(0.008, Math.min(tolr, 2.5 * rms));
      }
      return { phi: phi, x1: E[0], x2: E[1], y1: E[2], y2: E[3], rms: rms, xs: xs, ys: ys };
    }
    var best = null, ph;
    for (ph = 0; ph < 90; ph += 3) { var rc = rectAt(ph * DEG); if (!best || rc.rms < best.rms) best = rc; }
    var b0 = best.phi / DEG; for (ph = b0 - 3; ph <= b0 + 3; ph += 0.75) { var rc2 = rectAt(ph * DEG); if (rc2.rms < best.rms) best = rc2; }
    var rw = best.x2 - best.x1, rh = best.y2 - best.y1;
    var boxy = rmsC > Math.max(0.05 * r, 1.5 * fin.rms + 0.003) && best.rms < 0.6 * rmsC && Math.min(rw, rh) >= 0.09 && Math.max(rw, rh) <= 8 * Math.min(rw, rh);
    var out = { shape: boxy ? 'rect' : 'circle', rmsC: rmsC, rmsR: best.rms, extra: extra, n: m, members: boxy ? members : null };
    if (boxy) {
      // видимость сторон: точки в пределах допуска от стороны и их разброс вдоль стороны
      var tol = Math.max(0.008, 2.5 * best.rms), sides = [
        { name: 'x1', v: best.x1, pos: best.xs, along: best.ys, lo: best.y1, hi: best.y2 }, { name: 'x2', v: best.x2, pos: best.xs, along: best.ys, lo: best.y1, hi: best.y2 },
        { name: 'y1', v: best.y1, pos: best.ys, along: best.xs, lo: best.x1, hi: best.x2 }, { name: 'y2', v: best.y2, pos: best.ys, along: best.xs, lo: best.x1, hi: best.x2 }];
      sides.forEach(function (sd) {
        var cnt = 0, mn = Infinity, mx = -Infinity;
        for (var j = 0; j < m; j++) if (Math.abs(sd.pos[j] - sd.v) <= tol) { cnt++; var al = sd.along[j]; if (al < mn) mn = al; if (al > mx) mx = al; }
        sd.count = cnt; sd.cover = cnt > 0 ? (mx - mn) / Math.max(1e-6, sd.hi - sd.lo) : 0; sd.vis = cnt >= Math.max(25, 0.12 * m) && sd.cover >= 0.5;
      });
      var cph = Math.cos(best.phi), sph = Math.sin(best.phi);
      // углы прямоугольника обратно в плоскость сечения (p,q)
      function back2(x, y) { return [x * cph - y * sph, x * sph + y * cph]; }
      out.rect = { phi: best.phi, w: best.x2 - best.x1, h: best.y2 - best.y1, sides: sides.map(function (sd) { return { name: sd.name, vis: sd.vis, count: sd.count, cover: sd.cover }; }),
        corners: [back2(best.x1, best.y1), back2(best.x2, best.y1), back2(best.x2, best.y2), back2(best.x1, best.y2)], tol: tol,
        // ширина (по x') надёжна, если видна сторона вдоль x' (y1 или y2): её концы — углы короба; высота — аналогично, по стороне x1 или x2
        wOk: sides[2].vis || sides[3].vis, hOk: sides[0].vis || sides[1].vis };
    }
    return out;
  }

  /* Одна труба по её слоям и точкам. */
  function buildCylinder(S, F, circles, usedPts, o) {
    var P = S.P, n = S.n, a0 = F.dir, i, k;
    var wsum = 0, rr = 0;
    circles.forEach(function (c) { var w = c.inl.length; wsum += w; rr += w * c.r; c.t0 = c.tMid; });
    rr /= wsum;
    // ось по центрам слоёв: прямая в (t,p) и (t,q), взвешенно по числу точек
    var Tm = 0; circles.forEach(function (c) { Tm += c.inl.length * c.tMid; }); Tm /= wsum;
    var sp = 0, sq = 0; circles.forEach(function (c) { sp += c.inl.length * c.cx; sq += c.inl.length * c.cy; }); sp /= wsum; sq /= wsum;
    var stt = 0, stp = 0, stq = 0;
    circles.forEach(function (c) { var w = c.inl.length, dt = c.tMid - Tm; stt += w * dt * dt; stp += w * dt * (c.cx - sp); stq += w * dt * (c.cy - sq); });
    var kp = stt > 1e-9 ? stp / stt : 0, kq = stt > 1e-9 ? stq / stt : 0;
    var a1 = unit(add(a0, add(mul(F.e1, kp), mul(F.e2, kq))));
    var c1 = add(add(mul(F.e1, sp), mul(F.e2, sq)), mul(a0, Tm));
    // участники: расстояние до оси в пределах допуска, нормаль примерно к оси
    var cur = { a: a1, c: c1, r: rr }, tol = Math.max(0.006, 0.12 * rr), sel = null, fit = null, N = S.ln.N;
    for (var it = 0; it < 4; it++) {
      var ids = [];
      for (i = 0; i < n; i++) {
        if (usedPts[i]) continue;
        var q = i * 3, wx = P[q] - cur.c[0], wy = P[q + 1] - cur.c[1], wz = P[q + 2] - cur.c[2], t = wx * cur.a[0] + wy * cur.a[1] + wz * cur.a[2];
        var rx = wx - t * cur.a[0], ry = wy - t * cur.a[1], rz = wz - t * cur.a[2], d = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (Math.abs(d - cur.r) > tol) continue;
        if (Math.abs(t) > o.maxAxial) continue;
        var nn = i * 3, dn = Math.abs((N[nn] * rx + N[nn + 1] * ry + N[nn + 2] * rz) / (d || 1));
        if (dn < 0.85) continue;
        if (Math.abs(N[nn] * cur.a[0] + N[nn + 1] * cur.a[1] + N[nn + 2] * cur.a[2]) > 0.34) continue;
        ids.push(i);
      }
      if (ids.length < 30) return null;
      fit = fitCylinder3D(P, ids, ids.length, cur.a, cur.c, cur.r);
      if (!fit) return null;
      // сдвигаем опорную точку оси на середину участников — так параметры лучше обусловлены
      var tm = 0; for (k = 0; k < ids.length; k++) { var qq = ids[k] * 3; tm += (P[qq] - fit.c[0]) * fit.a[0] + (P[qq + 1] - fit.c[1]) * fit.a[1] + (P[qq + 2] - fit.c[2]) * fit.a[2]; }
      tm /= ids.length;
      cur = { a: fit.a, c: add(fit.c, mul(fit.a, tm)), r: fit.r };
      tol = clamp(3.2 * fit.rms, 0.0025, Math.max(0.006, 0.1 * fit.r));
      sel = ids;
    }
    if (!fit || !sel || sel.length < 30) return null;
    // окончательная подгонка вокруг середины
    var fin = fitCylinder3D(P, sel, sel.length, cur.a, cur.c, cur.r) || fit;
    // геометрия участников: протяжённость вдоль оси, охват дуги
    var ts = new Float64Array(sel.length), bs2 = planeBasis(fin.a), Fa = { p: new Float64Array(sel.length), q: new Float64Array(sel.length) };
    for (k = 0; k < sel.length; k++) {
      var qz = sel[k] * 3, wx2 = P[qz] - fin.c[0], wy2 = P[qz + 1] - fin.c[1], wz2 = P[qz + 2] - fin.c[2];
      ts[k] = wx2 * fin.a[0] + wy2 * fin.a[1] + wz2 * fin.a[2];
      Fa.p[k] = wx2 * bs2.u[0] + wy2 * bs2.u[1] + wz2 * bs2.u[2]; Fa.q[k] = wx2 * bs2.v[0] + wy2 * bs2.v[1] + wz2 * bs2.v[2];
    }
    var order = Array.prototype.map.call(ts, function (v, idx) { return idx; });
    var sorted = Float64Array.from(ts).sort(), t0 = quantile(sorted, 0.003), t1 = quantile(sorted, 0.997);
    var arc = arcCoverage(Fa, order, order.length, { cx: 0, cy: 0 });
    for (k = 0; k < sel.length; k++) usedPts[sel[k]] = 1;
    var big = 0; for (i = 1; i < 3; i++) if (Math.abs(fin.a[i]) > Math.abs(fin.a[big])) big = i;
    var ax = fin.a[big] < 0 ? mul(fin.a, -1) : fin.a;
    var tt0 = fin.a[big] < 0 ? -t1 : t0, tt1 = fin.a[big] < 0 ? -t0 : t1;
    // погрешность радиуса: статистика из ковариации Гаусса–Ньютона × поправка на коррелированность точек ⊕ неровность ⊕ систематика
    // «кривизна значима»: цилиндр должен описывать точки заметно лучше плоскости, иначе это слегка выпуклая стена или шум
    var pf = fitPlane(P, sel, sel.length, null), ssp = 0;
    for (k = 0; k < sel.length; k++) { var qp = sel[k] * 3, ep = pf.n[0] * P[qp] + pf.n[1] * P[qp + 1] + pf.n[2] * P[qp + 2] - pf.d; ssp += ep * ep; }
    var rmsPlane = Math.sqrt(ssp / sel.length), sag = fin.r * (1 - Math.cos(Math.min(arc.deg, 180) * DEG / 2));
    if (fin.r > 0.2 && arc.deg < 120) return null;
    if (fin.r > 0.12 && arc.deg < 90) return null;
    if (sag < Math.max(0.006, 5 * fin.rms) && rmsPlane < 2.2 * fin.rms) return null;
    var covrr = fin.cov ? Math.max(0, fin.cov[4][4]) : 0, corr = 6;
    var sigR = Math.sqrt(corr * covrr * fin.rms * fin.rms + Math.pow(0.28 * fin.rms, 2) + SIGMA_SYS * SIGMA_SYS);
    var tiltSigma = fin.cov ? Math.sqrt(corr * Math.max(0, fin.cov[2][2] + fin.cov[3][3])) * fin.rms : null;
    if (sigR / fin.r > 0.06) return null;                       // радиус не определён (дуга слишком короткая/шумная) — не выдаём «трубу» с мусорным диаметром
    // форма сечения: прямоугольный воздуховод/короб не должен становиться «трубой» с подогнанной окружностью
    var xs = crossSection(P, n, sel, fin, bs2, t0, t1, S.spacing || 0.01);
    if (xs.shape === 'rect' && xs.rect) {
      for (k = 0; k < xs.members.length; k++) usedPts[xs.members[k]] = 1;   // весь короб занят: следующие подгонки не берут его грани заново
      return { type: 'box', a: ax, c: fin.c, r: fin.r, count: sel.length, arc: arc.deg, t0: tt0, t1: tt1, length: tt1 - tt0, ids: sel, basis: bs2, section: xs, rms: fin.rms, slabs: circles.length };
    }
    return {
      type: 'cylinder', a: ax, c: fin.c, r: fin.r, sigmaR: sigR, rms: fin.rms, count: sel.length, arc: arc.deg, gapDeg: arc.gapDeg,
      t0: tt0, t1: tt1, length: tt1 - tt0, slabs: circles.length, tiltSigma: tiltSigma, ids: sel,
      rSlabs: circles.map(function (c) { return c.r; })
    };
  }

  function detectCylinders(S, surfaces, o) {
    o = o || {};
    var P = S.P, n = S.n, ln = S.ln, i, k, j;
    var inPlane = new Uint8Array(n);
    surfaces.forEach(function (s) {
      if (s.minW >= 0.15 && s.area >= 0.05) for (var t = 0; t < s.ids.length; t++) inPlane[s.ids[t]] = 1;
    });
    var R = S.R, G2 = buildGrid(P, n, 2 * R), G4 = buildGrid(P, n, 4 * R), step = Math.max(1, Math.floor(n / (o.axisSample || 25000))), buf = new Int32Array(400);
    var seeds = [], axes = [];
    function axisAt(G, rad, i) {
      var cnt = neighbors(G, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], rad, buf, buf.length), m = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (var k = 0; k < cnt; k++) {
        var j = buf[k]; if (inPlane[j] || ln.L0[j] < 0) continue;
        var nx = ln.N[j * 3], ny = ln.N[j * 3 + 1], nz = ln.N[j * 3 + 2];
        xx += nx * nx; xy += nx * ny; xz += nx * nz; yy += ny * ny; yz += ny * nz; zz += nz * nz; m++;
      }
      if (m < 14) return null;
      var e = eig3([xx / m, xy / m, xz / m, yy / m, yz / m, zz / m]);
      return { v0: e.values[0], v1: e.values[1], axis: e.vectors[0] };
    }
    for (i = 0; i < n; i += step) {
      if (inPlane[i] || ln.L0[i] < 0) continue;
      var e = axisAt(G2, 2 * R, i);
      if (!e || e.v1 < 0.03) { var e4 = axisAt(G4, 4 * R, i); if (e4 && e4.v1 >= 0.03) e = e4; }   // большая труба: за малое окно нормали ещё почти не меняются
      if (!e || e.v1 < 0.03 || e.v0 > 0.02) continue;
      seeds.push(i); axes.push(e.axis[0], e.axis[1], e.axis[2]);
    }
    var res = { cylinders: [], seeds: seeds.length, families: [] };
    if (seeds.length < 40) return res;
    var pseudo = { m: seeds.length, N: Float32Array.from(axes) }, flat = new Uint8Array(seeds.length).fill(1);
    var fams = clusterDirections(pseudo, flat, { minMembers: 30, minShare: 0.03, coneDeg: 6, maxDirs: 6 });
    var used = new Uint8Array(n), all = [], boxes = [];
    var Ls = o.slab || 0.3;
    fams.forEach(function (fam, fi) {
      var dir = fam.dir, bs = planeBasis(dir), e1 = bs.u, e2 = bs.v;
      // точки семейства: не на плоскости, нормаль ⟂ оси
      var ids = [], cos = Math.sin(10 * DEG);
      for (i = 0; i < n; i++) {
        if (inPlane[i] || ln.L0[i] < 0) continue;
        var q = i * 3;
        if (Math.abs(ln.N[q] * dir[0] + ln.N[q + 1] * dir[1] + ln.N[q + 2] * dir[2]) > cos) continue;
        ids.push(i);
      }
      if (ids.length < 60) return;
      var M = ids.length, F = { dir: dir, e1: e1, e2: e2, p: new Float64Array(M), q: new Float64Array(M), mp: new Float64Array(M), mq: new Float64Array(M), t: new Float64Array(M), gid: Int32Array.from(ids) };
      var tmin = Infinity, tmax = -Infinity;
      for (k = 0; k < M; k++) {
        var qi = ids[k] * 3, x = P[qi], y = P[qi + 1], z = P[qi + 2];
        F.p[k] = x * e1[0] + y * e1[1] + z * e1[2]; F.q[k] = x * e2[0] + y * e2[1] + z * e2[2]; F.t[k] = x * dir[0] + y * dir[1] + z * dir[2];
        var nn = ln.N[qi] * e1[0] + ln.N[qi + 1] * e1[1] + ln.N[qi + 2] * e1[2], nq = ln.N[qi] * e2[0] + ln.N[qi + 1] * e2[1] + ln.N[qi + 2] * e2[2], nl = Math.sqrt(nn * nn + nq * nq) || 1;
        F.mp[k] = nn / nl; F.mq[k] = nq / nl;
        if (F.t[k] < tmin) tmin = F.t[k]; if (F.t[k] > tmax) tmax = F.t[k];
      }
      var ns = Math.max(1, Math.ceil((tmax - tmin) / Ls)), slabs = [];
      for (k = 0; k < ns; k++) slabs.push([]);
      for (k = 0; k < M; k++) slabs[Math.min(ns - 1, Math.floor((F.t[k] - tmin) / Ls))].push(k);
      var circles = [];
      slabs.forEach(function (list, si) {
        if (list.length < 25) return;
        slabCircles(F, list, o).forEach(function (c) { c.slab = si; c.tMid = tmin + (si + 0.5) * Ls; circles.push(c); });
      });
      res.families.push({ dir: dir, points: M, slabs: ns, circles: circles.length });
      // треки: соседние слои, близкие центры (с допуском на наклон оси) и радиусы
      circles.sort(function (a, b) { return a.slab - b.slab; });
      var tracks = [];
      for (i = 0; i < circles.length; i++) {
        var c = circles[i], bestT = -1, bestD = Infinity;
        for (var ti = 0; ti < tracks.length; ti++) {
          var tr = tracks[ti], last = tr[tr.length - 1];
          if (c.slab - last.slab < 1 || c.slab - last.slab > 2) continue;
          var dcen = Math.hypot(c.cx - last.cx, c.cy - last.cy), tolc = 0.012 + 0.035 * (c.tMid - last.tMid) + 0.1 * c.r * 0.1;
          if (dcen > tolc || Math.abs(c.r - last.r) > Math.max(0.006, 0.12 * last.r)) continue;
          if (dcen < bestD) { bestD = dcen; bestT = ti; }
        }
        if (bestT < 0) tracks.push([c]); else tracks[bestT].push(c);
      }
      tracks.forEach(function (tr) { tr.score = tr.reduce(function (s, c) { return s + c.inl.length * Math.min(1, c.arc / 180); }, 0); });
      tracks.sort(function (a, b) { return b.score - a.score; });
      var S2 = { P: P, n: n, ln: ln, spacing: S.spacing };
      tracks.forEach(function (tr) {
        if (tr.score < 40) return;
        var cyl = buildCylinder(S2, F, tr, used, { maxAxial: 1e9 });
        if (cyl) { cyl.family = fi; cyl.score = tr.score; if (cyl.type === 'box') boxes.push(cyl); else all.push(cyl); }
      });
    });
    all.sort(function (a, b) { return b.count * Math.min(1, b.arc / 180) - a.count * Math.min(1, a.arc / 180); });
    // убираем «дубликаты»: та же ось и радиус
    var outC = [];
    all.forEach(function (c) {
      for (var q = 0; q < outC.length; q++) {
        var d = outC[q];
        if (angleBetween(c.a, d.a) < 3 * DEG && (Math.abs(c.r - d.r) < 0.01 || Math.abs(c.r - d.r) < 0.3 * Math.max(c.r, d.r))) {
          var w = sub(c.c, d.c), t = dot(w, d.a), rad = len(sub(w, mul(d.a, t)));
          if (rad < 0.015 || rad < 0.3 * Math.min(c.r, d.r)) return;   // одна труба: оси совпадают (две соседние трубы разнесены минимум на сумму радиусов)
        }
      }
      outC.push(c);
    });
    res.cylinders = outC;
    res.boxes = boxes;
    return res;
  }

  /* ---------- Сборка объектов и размеров ---------- */
  function rangeOf(vals) { var lo = Infinity, hi = -Infinity; vals.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; }); return [lo, hi]; }

  /* Проём: ширина по откосам, высота перемычка–пол, глубина по откосам. */
  function openingObject(op, ctx) {
    var pi = op.pi, A = op.A, B = op.B, P = ctx.P, dims = [], notes = [], m = pi.m, e1 = pi.e1, e2 = pi.e2;
    var aMid = op.aMid, bMid = op.bMid;
    if (op.head && op.sill) aMid = 0.5 * (op.head.y + op.sill.y);
    else if (op.sill) aMid = Math.max(aMid, op.sill.y + 0.5 * (pi.ov.a1 - op.sill.y));
    var g = gapAtAB(pi, aMid, bMid);
    // как меняется ширина по высоте (откосы не вертикальны или не параллельны)
    var gs = [];
    var aLo = op.sill ? op.sill.y + 0.05 : pi.ov.a0 + 0.05, aHi = op.head ? op.head.y - 0.05 : pi.ov.a1 - 0.05;
    if (aHi > aLo) for (var s = 0; s <= 4; s++) gs.push(gapAtAB(pi, aLo + (aHi - aLo) * s / 4, bMid).gap);
    var wr = gs.length ? rangeOf(gs) : [g.gap, g.gap];
    var sig = gapSigma(pi), conf = pairConfidence(pi, A, B);
    var wd = makeDim({
      key: 'width', dimension: 'width', label: 'Ширина проёма', value: g.gap, sigma: sig, method: 'planes', how: 'по откосам (плоскости)', confidence: conf,
      a: g.pa, b: g.pb, tilt: pi.tilt, range: wr[1] - wr[0] > 0.002 ? wr : null,
      evidence: { pointsA: A.count, pointsB: B.count, rmsA: A.rms, rmsB: B.rms, overlap: pi.iou }
    });
    if (wd.range) wd.notes.push('Ширина меняется по высоте от ' + wr[0].toFixed(3) + ' до ' + wr[1].toFixed(3) + ' м — откосы не параллельны.');
    dims.push(wd);
    // высота
    var hd = null;
    if (op.head && op.sill) {
      var H1 = op.head.sf, H0 = op.sill.sf, xc = op.xc;
      var t1 = planeT(H1, xc, UP), t0 = planeT(H0, xc, UP), hgt = Math.abs(t1 - t0);
      var pH = add(xc, mul(UP, t1)), pS = add(xc, mul(UP, t0));
      var sH = sigmaAt(H1, pH), sS = sigmaAt(H0, pS), hs = Math.sqrt(sH * sH + sS * sS + SIGMA_SYS * SIGMA_SYS + Math.pow(0.0002 * hgt, 2));
      var hc = 0.88;
      if (Math.min(H1.count, H0.count) < 80) hc -= 0.2; else if (Math.min(H1.count, H0.count) < 200) hc -= 0.08;
      if (Math.max(H1.rms, H0.rms) > 0.006) hc -= 0.2; else if (Math.max(H1.rms, H0.rms) > 0.003) hc -= 0.06;
      if (Math.abs(1 - Math.abs(H1.n[1])) > 1 - Math.cos(1.5 * DEG) || Math.abs(1 - Math.abs(H0.n[1])) > 1 - Math.cos(1.5 * DEG)) hc -= 0.08;
      if (op.head.cnt < 60) hc -= 0.1;
      hd = makeDim({ key: 'height', dimension: 'height', label: 'Высота проёма', value: hgt, sigma: hs, method: 'planes', how: 'перемычка — пол (плоскости)', confidence: hc, a: pS, b: pH, evidence: { pointsA: H1.count, pointsB: H0.count } });
      dims.push(hd);
    } else notes.push(op.head ? 'Пол в рамке не виден — высота проёма не определена (захватите пол).' : op.sill ? 'Перемычка не видна — высота проёма не определена (захватите верх проёма).' : 'Ни перемычка, ни пол не попали в рамку — высота проёма не определена.');
    // глубина: протяжённость откосов вдоль стены
    var ranges = [A, B].map(function (sf) {
      var bs = new Float64Array(sf.ids.length);
      for (var k = 0; k < sf.ids.length; k++) { var q = sf.ids[k] * 3; bs[k] = P[q] * e2[0] + P[q + 1] * e2[1] + P[q + 2] * e2[2]; }
      bs.sort(); return [quantile(bs, 0.003), quantile(bs, 0.997)];
    });
    var dA = ranges[0][1] - ranges[0][0], dB = ranges[1][1] - ranges[1][0], depth = Math.max(dA, dB), strong = dA >= dB ? 0 : 1;
    if (depth >= 0.05 && depth <= 1.5) {
      var amid2 = aMid, ref = ranges[strong], pa2 = add(add(mul(e1, amid2), mul(e2, ref[0])), mul(m, planeT(strong ? B : A, add(mul(e1, amid2), mul(e2, ref[0])), m)));
      var pb2 = add(add(mul(e1, amid2), mul(e2, ref[1])), mul(m, planeT(strong ? B : A, add(mul(e1, amid2), mul(e2, ref[1])), m)));
      var dc = 0.55 - (Math.abs(dA - dB) > 0.02 ? 0.12 : 0) - (Math.min(dA, dB) < 0.6 * depth ? 0.1 : 0);
      dims.push(makeDim({
        key: 'depth', dimension: 'thickness', label: 'Глубина проёма (толщина стены)', value: depth, sigma: Math.sqrt(4 * Math.pow(ctx.S.spacing, 2) + SIGMA_SYS * SIGMA_SYS), method: 'extent',
        how: 'по длине откосов вдоль стены', confidence: dc, a: pa2, b: pb2,
        notes: ['Глубина равна толщине стены вместе с отделкой, если рамка охватила оба края откоса.']
      }));
    }
    var asDoor = !!(op.sill && op.sill.sf && op.sill.sf.count > 0 && ctx.floor && Math.abs(op.sill.sf.d - ctx.floor.d) < 0.05 && Math.abs(dot(op.sill.sf.n, ctx.floor.n)) > 0.99);
    var center = add(op.xc, [0, 0, 0]);
    return { type: 'opening', guess: asDoor ? 'door' : op.sill ? 'window-or-opening' : 'opening', title: asDoor ? 'Дверной проём' : 'Проём', dims: dims, notes: notes, center: center, pointsUsed: A.count + B.count + (op.head ? op.head.cnt : 0) + (op.sill ? op.sill.cnt : 0), score: 0.6 + 0.35 * conf + (hd ? 0.2 : 0) };
  }

  /* Пары параллельных плоскостей, не вошедшие в проёмы: высота помещения, расстояние между стенами, толщина, ширина между бортами. */
  function pairObjects(ctx, usedPairs) {
    var S = ctx.surfaces, P = ctx.P, out = [], i, j;
    var big = S.filter(function (s) { return s.count >= 60 && s.area >= 0.04; });
    for (i = 0; i < big.length; i++) for (j = i + 1; j < big.length; j++) {
      var A = big[i], B = big[j];
      if (A.kind !== B.kind || A.kind === 'I') continue;
      if (usedPairs[A.id + ':' + B.id] || usedPairs[B.id + ':' + A.id]) continue;
      var pi = pairInfo(A, B, P); if (!pi || pi.gap == null) continue;
      if (pi.gap < 0.03) continue;
      var cov = Math.max(pi.iou, Math.min(pi.covA, pi.covB)); if (cov < 0.12) continue;
      var vertical = A.kind === 'H', ovA = pi.ov.a1 - pi.ov.a0, ovB = pi.ov.b1 - pi.ov.b0;
      var conf = pairConfidence(pi, A, B), sig = gapSigma(pi), gp = pi.gap, label, dimension, how, key, title, extraNotes = [];
      if (vertical) {
        if (gp > 1.2) { label = 'Высота помещения (пол — потолок)'; dimension = 'height'; key = 'room-height'; title = 'Помещение'; how = 'пол — потолок (плоскости)'; }
        else { label = 'Толщина плиты/панели'; dimension = 'thickness'; key = 'slab-thickness'; title = 'Плита/панель'; how = 'две горизонтальные грани'; }
      } else if (gp > 1.2) { label = 'Расстояние между стенами'; dimension = 'width'; key = 'room-width'; title = 'Помещение'; how = 'две стены (плоскости)'; }
      else if (Math.min(ovA, ovB) < 0.45 && gp >= 0.08) { label = 'Ширина между бортами'; dimension = 'width'; key = 'inner-width'; title = 'Лоток/короб/паз'; how = 'две грани (плоскости)'; conf = Math.min(conf, 0.7); }
      else { label = 'Толщина стены/перегородки'; dimension = 'thickness'; key = 'wall-thickness'; title = 'Стена/перегородка'; how = 'две грани (плоскости)'; conf = Math.min(conf, 0.7); extraNotes.push('Обе грани должны быть видны в рамке и принадлежать одному элементу.'); }
      var dim = makeDim({ key: key, dimension: dimension, label: label, value: gp, sigma: sig, method: 'planes', how: how, confidence: conf, a: pi.a, b: pi.b, tilt: pi.tilt, range: pi.gapMax - pi.gapMin > 0.002 ? [pi.gapMin, pi.gapMax] : null, notes: extraNotes,
        evidence: { pointsA: A.count, pointsB: B.count, rmsA: A.rms, rmsB: B.rms, overlap: cov } });
      out.push({ type: 'pair', title: title, dims: [dim], notes: [], center: pi.center, pointsUsed: A.count + B.count, score: 0.3 + 0.2 * conf + Math.min(0.15, (A.count + B.count) / 400000), surfaces: [A.id, B.id] });
    }
    return out;
  }

  /* Углы здания: «вверх» и горизонтальные направления/нормали найденных вертикальных поверхностей (если их нет — оси X, Z). */
  function buildingAxes(surfaces) {
    var axes = [UP], hs = [];
    (surfaces || []).forEach(function (s) {
      if (s.kind !== 'V' || s.count < 200) return;
      var h = unit([s.n[0], 0, s.n[2]]);
      hs.push(h, [-h[2], 0, h[0]]);
    });
    return axes.concat(hs.length ? hs.slice(0, 8) : [[1, 0, 0], [0, 0, 1]]);
  }
  function alignDeg(a, axes) {
    var best = 90; axes.forEach(function (x) { var d = angleBetween(a, x) / DEG; if (d < best) best = d; });
    return best;
  }

  /* Труба/цилиндр: диаметр, уклон оси, высота оси над полом, видимая длина. */
  /* Пол «настоящий», если он: горизонтален (до 3°), ровен (СКО до 2 см) и в радиусе rad от точки под ней есть его точки (не просто самая нижняя плоскость кадра). */
  function surfaceCoverage(sf, p, rad) {
    var a = dot(p, sf.u), b = dot(p, sf.v), r = Math.max(1, Math.ceil(rad / sf.cs)), cu = Math.floor((a - sf.ext.u0) / sf.cs), cv = Math.floor((b - sf.ext.v0) / sf.cs), tot = 0, occ = 0;
    for (var j = -r; j <= r; j++) for (var i = -r; i <= r; i++) {
      if (i * i + j * j > r * r) continue;
      tot++;
      var x = cu + i, y = cv + j;
      if (x >= 0 && y >= 0 && x < sf.W && y < sf.H && sf.occ[y * sf.W + x]) occ++;
    }
    return tot ? occ / tot : 0;
  }
  function floorIsReal(fl, p, rad) {
    if (!fl || Math.abs(fl.n[1]) < Math.cos(3 * DEG) || fl.rms > 0.02) return false;
    return surfaceCoverage(fl, p, rad) >= 0.25;
  }

  function cylinderObject(cy, idx, ctx) {
    var dims = [], notes = [], a = cy.a, c = cy.c, d = 2 * cy.r, sd = 2 * cy.sigmaR;
    var conf = 0.9;
    if (cy.arc < 90) conf -= 0.38; else if (cy.arc < 150) conf -= 0.16; else if (cy.arc < 200) conf -= 0.04;
    if (cy.slabs < 2 && cy.length > 0.4) conf -= 0.05;
    if (cy.slabs >= 3) { var rs = Float64Array.from(cy.rSlabs), mr = 0; rs.forEach(function (v) { mr += v; }); mr /= rs.length; var sv = 0; rs.forEach(function (v) { sv += Math.pow(v - mr, 2); }); sv = Math.sqrt(sv / (rs.length - 1)); if (sv / cy.r > 0.04) conf -= 0.2; else if (sv / cy.r > 0.02) conf -= 0.08; cy.rScatter = sv; }
    if (cy.rms / cy.r > 0.04) conf -= 0.15; if (cy.count < 100) conf -= 0.2; else if (cy.count < 300) conf -= 0.08;
    if (sd / d > 0.03) conf -= 0.12;
    // ось не параллельна осям здания (труба «по диагонали») — на практике это чаще мусорная подгонка (скругление, провод, рулон), чем труба
    var skew = alignDeg(a, buildingAxes(ctx.surfaces)), oblique = skew > 8;
    if (oblique) conf -= 0.15;
    conf = clamp(conf, 0.08, 0.97);
    // конечные точки диаметра: горизонтальный диаметр в середине видимой длины
    var tm = 0.5 * (cy.t0 + cy.t1), mid = add(c, mul(a, tm)), hdir = Math.abs(a[1]) > 0.9 ? [1, 0, 0] : unit(cross(UP, a));
    var pa = sub(mid, mul(hdir, cy.r)), pb = add(mid, mul(hdir, cy.r));
    var std = nearestStandard(d), dnotes = [];
    if (std && std.delta <= Math.max(1.2, 2.5 * sd * 1000)) dnotes.push('Близко к стандартному наружному Ø ' + std.d + ' мм (' + std.family + '), разница ' + std.delta.toFixed(1) + ' мм.');
    if (cy.arc < 150) dnotes.push('Виден только участок окружности (' + Math.round(cy.arc) + '°) — диаметр определяется менее надёжно; обведите трубу так, чтобы была видна большая часть окружности.');
    if (oblique) dnotes.push('Ось направлена не вдоль осей здания (отклонение ' + Math.round(skew) + '°) — это может быть не труба; проверьте на облаке.');
    dims.push(makeDim({ key: 'diameter', dimension: 'diameter', label: 'Диаметр трубы', value: d, sigma: sd, method: 'fit', how: 'по окружности (наружный)', confidence: conf, a: pa, b: pb, kind: 'diameter', notes: dnotes,
      evidence: { points: cy.count, rms: cy.rms, arcDeg: cy.arc, slabs: cy.slabs, rScatter: cy.rScatter != null ? cy.rScatter : null } }));
    // видимая длина и уклон
    if (cy.length >= 0.3) {
      var ea = add(c, mul(a, cy.t0)), eb = add(c, mul(a, cy.t1));
      dims.push(makeDim({ key: 'length', dimension: 'length', label: 'Видимая длина трубы', value: cy.length, sigma: Math.max(0.01, 4 * ctx.S.spacing), method: 'extent', how: 'по осевой линии, ограничена рамкой', confidence: 0.3, a: ea, b: eb, notes: ['Длина обрезана рамкой выделения — это длина видимого участка, а не всей трубы.'] }));
      var horiz = Math.hypot(a[0], a[2]);
      if (cy.length >= 0.6 && horiz > 0.5 && !oblique && Math.abs(a[1]) < 0.3) {
        var grade = 100 * a[1] / horiz, ts = cy.tiltSigma != null ? 100 * cy.tiltSigma : 0.1, sg = Math.sqrt(ts * ts + Math.pow(100 * SIGMA_SYS * 1.4 / cy.length, 2));
        var gc = clamp(0.7 - (cy.length < 1.2 ? 0.15 : 0) - (cy.arc < 150 ? 0.15 : 0) - (sg > 0.15 ? 0.15 : 0), 0.1, 0.7);
        dims.push(makeDim({ key: 'slope', dimension: 'slope', label: 'Уклон оси трубы', value: grade, sigma: sg, method: 'fit', how: 'по оси цилиндра', confidence: gc, a: ea, b: eb, kind: 'slope', notes: ['Знак «+»: вдоль оси от первой точки ко второй труба поднимается.', 'Уклон отсчитан от вертикали облака: если скан не выровнен по отвесу, значение смещено на угол его наклона. Прогиб трубы между опорами не учитывается, поэтому выше «средней» уверенность не ставится.'] }));
      }
    }
    // высота оси над полом — только «привязка к окружению», и только если пол настоящий: ровный, горизонтальный и лежит ПОД трубой.
    // Неровная земля, наклонная плита, полка или лоток в рамке полом не считаются (раньше именно такие «полы» давали чужие числа).
    if (ctx.floor && Math.abs(a[1]) < 0.5) {
      var fl = ctx.floor, tf = planeT(fl, mid, UP), pf = add(mid, mul(UP, tf)), hh = Math.abs(tf);
      if (hh > cy.r && tf < 0 && floorIsReal(fl, mid, Math.max(0.25, 2 * cy.r))) {
        var sf = Math.sqrt(Math.pow(sigmaAt(fl, pf), 2) + cy.sigmaR * cy.sigmaR + SIGMA_SYS * SIGMA_SYS), refNote = ['Это расстояние до плоскости пола в рамке, а не размер самой трубы: в проект автоматически не сохраняется.'];
        dims.push(makeDim({ key: 'axis-height', dimension: 'height', label: 'Высота оси над полом', value: hh, sigma: sf, method: 'fit', how: 'от оси трубы до плоскости пола', confidence: clamp(conf - 0.08, 0.1, 0.85), a: pf, b: mid, ref: true, notes: refNote.slice() }));
        dims.push(makeDim({ key: 'bottom-height', dimension: 'height', label: 'Высота низа трубы над полом', value: hh - cy.r, sigma: sf, method: 'fit', how: 'ось − радиус', confidence: clamp(conf - 0.08, 0.1, 0.85), a: pf, b: add(mid, mul(UP, -cy.r)), ref: true, notes: refNote.slice() }));
      }
    }
    return { type: 'cylinder', guess: 'pipe', title: 'Труба Ø' + Math.round(d * 1000) + ' мм', dims: dims, notes: [], center: mid, pointsUsed: cy.count, score: 0.5 + 0.3 * Math.min(1, cy.count / 1500) + 0.2 * Math.min(1, cy.arc / 270) - (oblique ? 0.2 : 0), cylinder: cy, index: idx, skew: skew };
  }


  /* Прямоугольный воздуховод (короб): размеры сечения по сторонам, а не диаметр. Ширина/высота считаются по видимым граням: размер надёжен, если
   * видна грань вдоль него (её концы — рёбра короба); иначе это лишь нижняя оценка, и уверенность снижается. */
  function ductObject(bx, idx, ctx) {
    var sec = bx.section, R = sec.rect, a = bx.a, c = bx.c, bs = bx.basis, dims = [], i;
    var cph = Math.cos(R.phi), sph = Math.sin(R.phi);
    // центр сечения в плоскости (p,q): середина прямоугольника в повёрнутых осях → обратно
    var cx = 0, cy2 = 0; R.corners.forEach(function (q) { cx += q[0] / 4; cy2 += q[1] / 4; });
    var cen = add(c, add(mul(bs.u, cx), mul(bs.v, cy2)));
    // единичные направления сторон x' и y' в 3D
    var ex = unit(add(mul(bs.u, cph), mul(bs.v, sph))), ey = unit(add(mul(bs.u, -sph), mul(bs.v, cph)));
    var tm = 0.5 * (bx.t0 + bx.t1), mid = add(cen, mul(a, tm));
    var sides = [{ dir: ex, size: R.w, ok: R.wOk }, { dir: ey, size: R.h, ok: R.hOk }];
    // «ширина» — более горизонтальная сторона, «высота» — более вертикальная (для вертикального короба — «ширина» и «глубина» по размеру)
    var vertical = Math.abs(a[1]) > 0.8;
    if (!vertical && Math.abs(sides[0].dir[1]) > Math.abs(sides[1].dir[1])) sides.reverse();
    else if (vertical && sides[1].size > sides[0].size) sides.reverse();
    var spacing = ctx.S.spacing, base = 0.82;
    var vis = R.sides.filter(function (sd) { return sd.vis; }).length;
    if (vis < 2) base -= 0.25;
    var defs = vertical ? [['duct-width', 'width', 'Ширина воздуховода'], ['duct-depth', 'depth', 'Глубина воздуховода']] : [['duct-width', 'width', 'Ширина воздуховода'], ['duct-height', 'height', 'Высота воздуховода']];
    sides.forEach(function (sd, k) {
      var half = 0.5 * sd.size, pa = sub(mid, mul(sd.dir, half)), pb = add(mid, mul(sd.dir, half)), conf = sd.ok ? base : Math.min(0.3, base - 0.3);
      var sg = Math.sqrt(Math.pow(0.5 * R.tol, 2) + Math.pow(2 * spacing, 2) + SIGMA_SYS * SIGMA_SYS), notes = [];
      if (!sd.ok) notes.push('Грань вдоль этого размера не видна целиком — значение нижняя оценка по видимой части. Обведите короб так, чтобы была видна сторона целиком.');
      if (vis < 2) notes.push('Видна только одна сторона короба: сечение по ней определяется грубо.');
      dims.push(makeDim({ key: defs[k][0], dimension: defs[k][1], label: defs[k][2], value: sd.size, sigma: sg, method: 'fit', how: 'по сторонам прямоугольного сечения', confidence: conf, a: pa, b: pb, kind: 'linear', notes: notes,
        evidence: { points: bx.count, rmsRect: sec.rmsR, rmsCircle: sec.rmsC, sidesVisible: vis } }));
    });
    if (bx.length >= 0.3) {
      var ea = add(cen, mul(a, bx.t0)), eb = add(cen, mul(a, bx.t1));
      dims.push(makeDim({ key: 'length', dimension: 'length', label: 'Видимая длина воздуховода', value: bx.length, sigma: Math.max(0.01, 4 * spacing), method: 'extent', how: 'по оси, ограничена рамкой', confidence: 0.3, a: ea, b: eb, notes: ['Длина обрезана рамкой выделения — это не длина всего воздуховода.'] }));
    }
    var mm0 = function (v) { return Math.round(v * 1000); };
    var title = 'Воздуховод ' + mm0(Math.max(sides[0].size, sides[1].size)) + '×' + mm0(Math.min(sides[0].size, sides[1].size)) + ' мм';
    var half2 = 0.5 * Math.hypot(R.w, R.h), okAll = sides[0].ok && sides[1].ok;
    return { type: 'duct', guess: 'duct', title: title, dims: dims, notes: ['Сечение прямоугольное: окружность не подгоняется (отклонение прямоугольника ' + (sec.rmsR * 1000).toFixed(1) + ' мм против ' + (sec.rmsC * 1000).toFixed(1) + ' мм у окружности).'],
      center: mid, pointsUsed: bx.count, score: 0.5 + 0.3 * Math.min(1, bx.count / 1500) + (okAll ? 0.15 : 0) - (vis < 2 ? 0.2 : 0), index: idx,
      duct: { a: a, c: cen, t0: bx.t0, t1: bx.t1, ex: ex, ey: ey, w: R.w, h: R.h, rad: half2 } };
  }

  /* Параллельные трубы: расстояние между осями и просвет. */
  function pipePairs(cyls, objs) {
    var out = [];
    for (var i = 0; i < cyls.length; i++) for (var j = i + 1; j < cyls.length; j++) {
      var A = cyls[i].cylinder, B = cyls[j].cylinder;
      if (angleBetween(A.a, B.a) > 3 * DEG) continue;
      var m = unit(add(A.a, mul(B.a, dot(A.a, B.a) >= 0 ? 1 : -1)));
      // расстояние между осями: в плоскости, перпендикулярной m, в середине общего участка
      var ca = add(A.c, mul(A.a, 0.5 * (A.t0 + A.t1))), cb = add(B.c, mul(B.a, 0.5 * (B.t0 + B.t1)));
      var w = sub(cb, ca), along = dot(w, m), perp = sub(w, mul(m, along)), dd = len(perp);
      if (dd > 1.5 || dd < A.r + B.r - 0.01) continue;
      // общий участок вдоль оси
      var aOv0 = Math.max(A.t0, dot(sub(B.c, A.c), A.a) + B.t0), aOv1 = Math.min(A.t1, dot(sub(B.c, A.c), A.a) + B.t1);
      if (aOv1 - aOv0 < 0.1) continue;
      var u = unit(perp), clear = dd - A.r - B.r, sig = Math.sqrt(A.sigmaR * A.sigmaR + B.sigmaR * B.sigmaR + SIGMA_SYS * SIGMA_SYS), confBase = Math.min(objs[i].dims[0].confidence, objs[j].dims[0].confidence);
      var pm = add(A.c, mul(A.a, 0.5 * (aOv0 + aOv1)));
      var pa = pm, pb = add(pm, perp);
      out.push({
        type: 'pipes', title: 'Две трубы: расстояния', notes: [], center: add(pa, mul(perp, 0.5)), pointsUsed: A.count + B.count, score: 0.35 + 0.1 * confBase,
        dims: [
          makeDim({ key: 'axis-gap', dimension: 'gap', label: 'Расстояние между осями труб', value: dd, sigma: sig, method: 'fit', how: 'ось — ось (по окружностям)', confidence: clamp(confBase - 0.05, 0.1, 0.9), a: pa, b: pb }),
          makeDim({ key: 'clear-gap', dimension: 'gap', label: 'Просвет между трубами', value: clear, sigma: sig, method: 'fit', how: 'ось — ось минус радиусы', confidence: clamp(confBase - 0.05, 0.1, 0.9), a: add(pa, mul(u, A.r)), b: sub(pb, mul(u, B.r)) })
        ], pair: [i, j]
      });
    }
    return out;
  }

  /* ---------- Чьи это размеры: тип, указанная точка, контур ---------- */
  /* Роль находки — что именно она измеряет. Тип, выбранный человеком, допускает ТОЛЬКО свои роли; остальное остаётся в списке «другое в рамке»
   * и никогда не становится главным результатом и не сохраняется автоматически (null = подходит любая находка). */
  var KIND_ROLES = {
    'проём': ['opening'], 'дверь': ['opening'], 'окно': ['opening'],
    'труба': ['pipe'], 'воздуховод': ['pipe'],
    'стена': ['wall', 'room-width'], 'перекрытие': ['slab', 'floor', 'ceiling'], 'пол': ['floor', 'slab', 'room-height'], 'потолок': ['ceiling', 'slab', 'room-height'],
    'колонна': ['column', 'pipe', 'wall', 'slab'], 'балка': ['beam', 'wall', 'slab'], 'лоток': ['tray', 'wall', 'slab'], 'оборудование': null
  };
  function roleOf(ob) {
    if (ob.clsRole) return ob.clsRole;   // r169: роль от классификатора (стена/колонна/балка/труба/пол…)
    if (ob.type === 'opening') return 'opening';
    if (ob.type === 'cylinder' || ob.type === 'pipes' || ob.type === 'duct') return 'pipe';
    var k = ob.dims && ob.dims[0] && ob.dims[0].key;
    return k === 'room-height' ? 'room-height' : k === 'room-width' ? 'room-width' : k === 'slab-thickness' ? 'slab' : k === 'inner-width' ? 'tray' : k === 'wall-thickness' ? 'wall' : 'other';
  }
  function matchesKind(ob, kind) {
    if (!kind) return true;
    var roles = KIND_ROLES[kind];
    if (roles === undefined || roles === null) return true;
    return roles.indexOf(ob.role) >= 0;
  }

  function distPointSegment(p, a, b) {
    var ab = sub(b, a), l2 = dot(ab, ab), t = l2 > 1e-12 ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
    return len(sub(p, add(a, mul(ab, t))));
  }
  function distPointPatch(sf, p) {
    var a = dot(p, sf.u), b = dot(p, sf.v), off = dot(sf.n, p) - sf.d;
    var du = a < sf.ext.u0 ? sf.ext.u0 - a : a > sf.ext.u1 ? a - sf.ext.u1 : 0, dv = b < sf.ext.v0 ? sf.ext.v0 - b : b > sf.ext.v1 ? b - sf.ext.v1 : 0;
    return Math.sqrt(off * off + du * du + dv * dv);
  }
  function distPointBox(p, pts, pad) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], i, k;
    pts.forEach(function (q) { if (!q) return; for (k = 0; k < 3; k++) { if (q[k] < mn[k]) mn[k] = q[k]; if (q[k] > mx[k]) mx[k] = q[k]; } });
    if (mn[0] === Infinity) return Infinity;
    var s2 = 0; for (i = 0; i < 3; i++) { var d = p[i] < mn[i] - pad ? mn[i] - pad - p[i] : p[i] > mx[i] + pad ? p[i] - mx[i] - pad : 0; s2 += d * d; }
    return Math.sqrt(s2);
  }
  /* Расстояние от точки до объекта (0 — точка на/внутри объекта): труба — до оси минус радиус, пара плоскостей — до ближайшего куска, остальное — до габарита размеров. */
  function distToObject(ob, p, ctx) {
    if (ob.cylinder) { var c = ob.cylinder; return Math.max(0, distPointSegment(p, add(c.c, mul(c.a, c.t0)), add(c.c, mul(c.a, c.t1))) - c.r); }
    if (ob.duct) { var dc = ob.duct; return Math.max(0, distPointSegment(p, add(dc.c, mul(dc.a, dc.t0)), add(dc.c, mul(dc.a, dc.t1))) - dc.rad); }
    if (ob.surfaces) {
      var best = Infinity; ob.surfaces.forEach(function (id) { var sf = ctx.surfaces[id]; if (sf) best = Math.min(best, distPointPatch(sf, p)); }); return best;
    }
    var pts = [ob.center]; ob.dims.forEach(function (d) { pts.push(d.a, d.b); });
    return distPointBox(p, pts, 0.1);
  }
  /* Множитель ранга по близости к указанной точке: на объекте — 1,6; на 0,5 м дальше — ~0,7; далеко — не ниже 0,15. */
  function focusFactor(d) { return d <= 0.05 ? 1.6 : Math.max(0.15, 1.6 * Math.exp(-(d - 0.05) / 0.6)); }

  /* Контур объекта (пары концов отрезков для gl.LINES) — чтобы человек видел, ЧТО именно измерено: труба — ось, кольца, образующие; проём — рамка; пара плоскостей — их куски. */
  function patchOutline(sf, out) {
    var e = sf.ext, k, cs = [[e.u0, e.v0], [e.u1, e.v0], [e.u1, e.v1], [e.u0, e.v1]], P3 = cs.map(function (q) { return add(add(mul(sf.u, q[0]), mul(sf.v, q[1])), mul(sf.n, sf.d)); });
    for (k = 0; k < 4; k++) out.push(P3[k], P3[(k + 1) % 4]);
  }
  function outlineOf(ob, ctx) {
    var out = [], k, j;
    if (ob.clsOutline && ob.clsOutline.length >= 2) return ob.clsOutline.slice();   // r169: контур от классификатора
    if (ob.cylinder) {
      var c = ob.cylinder, bs = planeBasis(c.a), A = add(c.c, mul(c.a, c.t0)), B = add(c.c, mul(c.a, c.t1));
      out.push(A, B);
      [c.t0, 0.5 * (c.t0 + c.t1), c.t1].forEach(function (t) {
        var m = add(c.c, mul(c.a, t)), prev = null;
        for (j = 0; j <= 24; j++) { var th = j / 24 * 2 * Math.PI, q = add(m, add(mul(bs.u, c.r * Math.cos(th)), mul(bs.v, c.r * Math.sin(th)))); if (prev) out.push(prev, q); prev = q; }
      });
      for (k = 0; k < 4; k++) { var th2 = k * Math.PI / 2, off = add(mul(bs.u, c.r * Math.cos(th2)), mul(bs.v, c.r * Math.sin(th2))); out.push(add(A, off), add(B, off)); }
    } else if (ob.duct) {
      var dd = ob.duct, hw = 0.5 * dd.w, hh = 0.5 * dd.h, ring = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      [dd.t0, 0.5 * (dd.t0 + dd.t1), dd.t1].forEach(function (t) {
        var m0 = add(dd.c, mul(dd.a, t)), cs = ring.map(function (q) { return add(m0, add(mul(dd.ex, q[0]), mul(dd.ey, q[1]))); });
        for (k = 0; k < 4; k++) out.push(cs[k], cs[(k + 1) % 4]);
      });
      ring.forEach(function (q) { var off = add(mul(dd.ex, q[0]), mul(dd.ey, q[1])); out.push(add(add(dd.c, mul(dd.a, dd.t0)), off), add(add(dd.c, mul(dd.a, dd.t1)), off)); });
    } else if (ob.surfaces) {
      ob.surfaces.forEach(function (id) { if (ctx.surfaces[id]) patchOutline(ctx.surfaces[id], out); });
    } else if (ob.type === 'opening') {
      var w = ob.dims.filter(function (d) { return d.key === 'width'; })[0], h = ob.dims.filter(function (d) { return d.key === 'height'; })[0];
      if (w && w.a && w.b && h && h.a && h.b) {
        var y0 = Math.min(h.a[1], h.b[1]), y1 = Math.max(h.a[1], h.b[1]), q0 = [w.a[0], y0, w.a[2]], q1 = [w.b[0], y0, w.b[2]], q2 = [w.b[0], y1, w.b[2]], q3 = [w.a[0], y1, w.a[2]];
        out.push(q0, q1, q1, q2, q2, q3, q3, q0);
      } else ob.dims.forEach(function (d) { if (d.a && d.b) out.push(d.a, d.b); });
    } else ob.dims.forEach(function (d) { if (d.a && d.b) out.push(d.a, d.b); });
    return out;
  }

  /* Дубликаты труб: одна труба, разбитая на два цилиндра (общая ось, тот же радиус, перекрытие вдоль оси) — оставляем сильнейший. */
  function dedupeCylinders(cobj) {
    var keep = [];
    cobj.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (ob) {
      var c = ob.cylinder;
      for (var i = 0; i < keep.length; i++) {
        var k = keep[i].cylinder;
        if (angleBetween(k.a, c.a) > 3 * DEG) continue;
        var w = sub(c.c, k.c), al = dot(w, k.a), perp = len(sub(w, mul(k.a, al)));
        if (perp > 0.35 * Math.min(k.r, c.r) || Math.abs(k.r - c.r) > 0.1 * k.r) continue;
        var o0 = Math.max(k.t0, al + c.t0), o1 = Math.min(k.t1, al + c.t1);
        if (o1 - o0 < 0.3 * Math.min(k.length, c.length)) continue;
        return;
      }
      keep.push(ob);
    });
    return keep;
  }
  /* «Призраки» в пучке параллельных труб: короткая дуга и диаметр, заметно отличающийся от медианы ≥3 надёжных соседей, — подгонка по пучку, а не труба. */
  function consensusPipes(cobj) {
    var strong = cobj.filter(function (ob) { var c = ob.cylinder; return c.arc >= 170 && c.count >= 1500 && ob.dims[0].confidence >= 0.6; }), n = 0;
    cobj.forEach(function (ob) {
      var c = ob.cylinder, mates = strong.filter(function (s) { return s !== ob && angleBetween(s.cylinder.a, c.a) <= 8 * DEG; });
      if (mates.length < 3) return;
      var R = median(mates.map(function (s) { return s.cylinder.r; }));
      if (Math.abs(c.r - R) / R > 0.12 && (c.arc < 150 || c.count < 600)) {
        var d = ob.dims[0]; d.confidence = clamp(d.confidence - 0.35, 0.05, 1); d.level = level(d.confidence);
        d.notes.push('Диаметр заметно отличается от соседних параллельных труб (медиана Ø' + Math.round(2000 * R) + ' мм) при короткой видимой дуге — это, скорее всего, подгонка по пучку, а не отдельная труба.');
        ob.score -= 0.35; ob.ghost = true; ob.ghostWhy = ['диаметр заметно отличается от соседних параллельных труб при короткой видимой дуге']; n++;
      }
    });
    return n;
  }

  /* Проверка «это действительно стенка трубы»: внутри цилиндра, вдоль его оси, не должно быть чужих точек — снаружи скан видит только оболочку.
     Если внутри полно точек (мелкие трубы пучка, грунт, оборудование), то цилиндр — подгонка по огибающей пучка или по земле, а не отдельная труба. */
  function hollowStats(cy, P, n) {
    var a = cy.a, c = cy.c, r = cy.r, inner = Math.max(0.02, 3.5 * cy.rms), rin = r - inner, inside = 0, near = 0;
    if (rin <= 0.01) return { inside: 0, near: 0, ratio: 0 };
    var t0 = cy.t0, t1 = cy.t1, ax = a[0], ay = a[1], az = a[2], rin2 = rin * rin, r2 = (r + 0.03) * (r + 0.03);
    for (var i = 0; i < n; i++) {
      var q = i * 3, wx = P[q] - c[0], wy = P[q + 1] - c[1], wz = P[q + 2] - c[2], t = wx * ax + wy * ay + wz * az;
      if (t < t0 || t > t1) continue;
      var rx = wx - t * ax, ry = wy - t * ay, rz = wz - t * az, d2 = rx * rx + ry * ry + rz * rz;
      if (d2 < rin2) inside++; else if (d2 < r2) near++;
    }
    return { inside: inside, near: near, ratio: inside / Math.max(1, cy.count) };
  }
  /* Огибающая пучка/земли: цилиндр охватывает несколько мелких надёжных параллельных труб ИЛИ внутри него много чужих точек ИЛИ радиус и невязка нереальны. */
  function implausibleCylinders(cobj, P, n) {
    var strong = cobj.filter(function (ob) { var c = ob.cylinder; return c.arc >= 150 && c.count >= 600 && ob.dims[0].confidence >= 0.5 && c.rms < 0.012; }), cnt = 0;
    cobj.forEach(function (ob) {
      var c = ob.cylinder, d = ob.dims[0], why = [], pen = 0;
      var st = hollowStats(c, P, n); c.hollow = st;
      var held = strong.filter(function (s) {
        if (s === ob) return false;
        var k = s.cylinder; if (k.r > 0.75 * c.r || angleBetween(k.a, c.a) > 8 * DEG) return false;
        var w = sub(k.c, c.c), al = dot(w, c.a), perp = len(sub(w, mul(c.a, al)));
        if (perp + k.r > 1.05 * c.r) return false;
        return Math.min(c.t1, al + k.t1) - Math.max(c.t0, al + k.t0) > 0.3 * Math.min(c.length, k.length);
      }).length;
      c.encloses = held;
      if (held >= 1) { pen += 0.5; why.push('охватывает ' + held + ' более мелк' + (held === 1 ? 'ую трубу' : 'их труб') + ' — это огибающая пучка, а не труба'); }
      if (st.ratio > 0.25 && st.inside >= 150) { pen += 0.4; why.push('внутри контура много чужих точек (' + st.inside + ' шт., ' + Math.round(100 * st.ratio) + '% от точек трубы) — у настоящей трубы внутри пусто'); }
      if (c.r > 0.25 && c.rms > 0.02) { pen += 0.3; why.push('для такого диаметра слишком велик разброс точек (СКО ' + (1000 * c.rms).toFixed(0) + ' мм)'); }
      else if (c.r > 0.25 && c.rms > 0.012 && c.arc < 220) { pen += 0.12; why.push('разброс точек (СКО ' + (1000 * c.rms).toFixed(0) + ' мм) велик для такого диаметра'); }
      if (pen > 0) {
        d.confidence = clamp(d.confidence - pen, 0.05, 1); d.level = level(d.confidence); d.notes.push('Скорее всего, это не отдельная труба: ' + why.join('; ') + '.');
        ob.score -= pen; ob.ghost = true; ob.ghostWhy = why.slice(); cnt++;
      }
    });
    return cnt;
  }

  /* =====================================================================================
   * r169. КЛАССИФИКАТОР ВЫДЕЛЕННОГО ФРАГМЕНТА.
   *
   * Зачем. До r169 тип элемента брался из готовых находок (открытия/цилиндры/плоскости), а
   * «главным» становился объект с наибольшим рангом. У цилиндра ранг был выше всех, поэтому
   * на выделении колонны/стены/балки главной оказывалась «Труба Ø…», а размеры считались по
   * подгонке окружности. Здесь тип определяется ДО выбора главного: строятся гипотезы
   *   • плоскость  — стена/перегородка (вертикальная), пол/потолок (по положению),
   *                  перекрытие/панель (пара параллельных граней или наклонная грань);
   *   • коробка    — колонна (вертикальная, квадратное сечение), балка (горизонтальная),
   *                  лоток (низкий открытый профиль) по граням вдоль 3 ортогональных осей;
   *   • цилиндр    — труба (ось преимущественно горизонтальная) или круглая колонна
   *                  (вертикальная ось): 3D-подгонка оси/радиуса по всем точкам;
   *   • проём      — существующий детектор проёмов (по откосам или дыре в стене);
   *   • ребро/угол — линейное облако (одно измерение много больше других), запасной вариант.
   * У каждой гипотезы есть доля объяснённых точек (inlier), СКО подгонки, размеры и σ.
   * Выбор — по score = приор типа × качество подгонки × доля объяснённых точек; вероятности
   * top-3 считаются softmax по score. classify() — чистые функции без DOM (Node/окно).
   * ===================================================================================== */
  var CLS_DEF = {
    wall: { ru: 'Стена', family: 'panel', role: 'wall' },
    floor: { ru: 'Пол', family: 'panel', role: 'floor' },
    ceiling: { ru: 'Потолок', family: 'panel', role: 'ceiling' },
    slab: { ru: 'Перекрытие', family: 'panel', role: 'slab' },
    panel: { ru: 'Панель', family: 'panel', role: 'other' },
    column: { ru: 'Колонна', family: 'box', role: 'column' },
    beam: { ru: 'Балка', family: 'box', role: 'beam' },
    tray: { ru: 'Лоток', family: 'box', role: 'tray' },
    pipe: { ru: 'Труба', family: 'pipe', role: 'pipe' },
    opening: { ru: 'Проём', family: 'opening', role: 'opening' },
    edge: { ru: 'Ребро/угол', family: 'edge', role: 'edge' }
  };
  var CLS_PRIOR = { wall: 1.00, floor: 0.82, ceiling: 0.74, slab: 0.88, panel: 0.56, column: 1.02, beam: 1.00, tray: 0.92, pipe: 1.06, opening: 1.08, edge: 0.42 };
  var CLS_T = 0.14;   // температура вероятностей

  function _clsClamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function _clsCentroid(P, ids) {
    var sx = 0, sy = 0, sz = 0, i, q;
    if (!ids) return [0, 0, 0];
    for (i = 0; i < ids.length; i++) { q = ids[i] * 3; sx += P[q]; sy += P[q + 1]; sz += P[q + 2]; }
    var m = ids.length || 1;
    return [sx / m, sy / m, sz / m];
  }
  /* Проекция точки/массива на ось. ids == null — все n точек. */
  function _clsProj(P, n, dir, ids) {
    var out = new Float64Array(ids ? ids.length : n), i, q;
    if (ids) for (i = 0; i < ids.length; i++) { q = ids[i] * 3; out[i] = P[q] * dir[0] + P[q + 1] * dir[1] + P[q + 2] * dir[2]; }
    else for (i = 0; i < n; i++) { q = i * 3; out[i] = P[q] * dir[0] + P[q + 1] * dir[1] + P[q + 2] * dir[2]; }
    return out;
  }
  /* min/max/размер вдоль оси; ids == null — все точки. */
  function _clsExtend(P, n, dir, ids) {
    var lo = Infinity, hi = -Infinity, i, q, v;
    if (ids) for (i = 0; i < ids.length; i++) { q = ids[i] * 3; v = P[q] * dir[0] + P[q + 1] * dir[1] + P[q + 2] * dir[2]; if (v < lo) lo = v; if (v > hi) hi = v; }
    else for (i = 0; i < n; i++) { q = i * 3; v = P[q] * dir[0] + P[q + 1] * dir[1] + P[q + 2] * dir[2]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return { lo: lo, hi: hi, size: hi - lo, mid: 0.5 * (lo + hi) };
  }
  function _clsYRange(P, n) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < n; i++) { var y = P[i * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
    return { min: lo, max: hi, size: hi - lo };
  }
  /* Пики 1D-гистограммы: позиции граней/плоскостей. Без сканирования всех точек на пик.
     minRatio — во сколько раз плотность в пике должна превышать локальный фон: у равномерного
     распределения вдоль ребра (±шум) пиков быть не должно, у грани/плоскости — должны. */
  function _clsPeaks(vals, minCount, binw, minSep, minRatio) {
    minRatio = minRatio || 1.0;
    var m = vals.length, i;
    if (m < 8) return [];
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < m; i++) { var v = vals[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi - lo > 1e-5)) return [];
    binw = Math.max(binw, (hi - lo) / 5000);
    var nb = Math.min(4000, Math.max(10, Math.ceil((hi - lo) / binw) + 5));
    var base = lo - 2 * binw, hist = new Float64Array(nb);
    for (i = 0; i < m; i++) { var k = Math.floor((vals[i] - base) / binw); if (k < 0) k = 0; if (k >= nb) k = nb - 1; hist[k]++; }
    var sm = new Float64Array(nb);
    for (i = 0; i < nb; i++) {
      var s = 0;
      for (var d = -2; d <= 2; d++) { var j = i + d; if (j < 0 || j >= nb) continue; s += hist[j] * (d === 0 ? 3 : (d === -1 || d === 1 ? 2 : 1)); }
      sm[i] = s;
    }
    var cand = [];
    for (i = 2; i < nb - 2; i++) {
      if (!(sm[i] >= sm[i - 1] && sm[i] > sm[i + 1] && sm[i] > 1.5)) continue;
      var c0 = Math.max(0, i - 2), c1 = Math.min(nb - 1, i + 2), cnt = 0, wsum = 0, wpos = 0;
      for (var j2 = c0; j2 <= c1; j2++) { cnt += hist[j2]; wsum += hist[j2]; wpos += hist[j2] * (base + (j2 + 0.5) * binw); }
      if (cnt < minCount) continue;
      // локальный фон: медиана занятых бинов в окне ±6·5 бинов, исключая сам пик
      var bg = [], sp = Math.max(6, 3 * (c1 - c0));
      for (var j3 = Math.max(0, i - sp); j3 <= Math.min(nb - 1, i + sp); j3++) if (j3 < c0 - 1 || j3 > c1 + 1) bg.push(hist[j3]);
      var baseDen = bg.length ? median(bg) : 0;
      if (minRatio > 1.01 && baseDen > 0 && cnt / (baseDen * (c1 - c0 + 1) * 1) < minRatio) continue;
      cand.push({ pos: wsum ? wpos / wsum : base + (i + 0.5) * binw, count: cnt, sm: sm[i] });
    }
    cand.sort(function (a, b) { return b.count - a.count || a.pos - b.pos; });
    var out = [];
    for (i = 0; i < cand.length; i++) {
      var ok = true;
      for (var q = 0; q < out.length; q++) if (Math.abs(cand[i].pos - out[q].pos) < minSep) { ok = false; break; }
      if (ok) out.push(cand[i]);
    }
    out.sort(function (a, b) { return a.pos - b.pos; });
    return out;
  }
  /* Уточнение положения грани: медиана координат точек в узком окне вокруг предварительного пика.
     У настоящей грани все точки лежат на ней (±шум) — медиана даёт миллиметровую точность. */
  function _clsRefineFace(P, n, axis, pos, win) {
    var vals = [];
    for (var i = 0; i < n; i++) {
      var q = i * 3, v = P[q] * axis[0] + P[q + 1] * axis[1] + P[q + 2] * axis[2];
      if (Math.abs(v - pos) <= win) vals.push(v);
    }
    if (vals.length < 20) return pos;
    return median(vals);
  }
  /* Габариты грани в её осях (u,v). Коридор плоскости ограничен габаритом куска (по ids) с
     запасом на ячейку растра (возвращаем точки, потерянные раскубировкой патчей), а сами
     габариты считаем по ЦЕНТРАЛЬНОЙ полосе второй оси: так чужая поверхность (пол/соседняя
     стена), задевающая грань по краю, не растягивает размер. */
  function _clsPlaneExtent(P, n, pl, tol) {
    var i, q, mg = Math.max(0.006, 1.5 * (pl.cs || 0.02), 3 * tol);
    var bu0 = Infinity, bu1 = -Infinity, bv0 = Infinity, bv1 = -Infinity;
    for (i = 0; i < pl.ids.length; i++) {
      q = pl.ids[i] * 3;
      var pu0 = P[q] * pl.u[0] + P[q + 1] * pl.u[1] + P[q + 2] * pl.u[2];
      var pv0 = P[q] * pl.v[0] + P[q + 1] * pl.v[1] + P[q + 2] * pl.v[2];
      if (pu0 < bu0) bu0 = pu0; if (pu0 > bu1) bu1 = pu0;
      if (pv0 < bv0) bv0 = pv0; if (pv0 > bv1) bv1 = pv0;
    }
    if (!isFinite(bu0)) return null;
    var uLo = bu0 - mg, uHi = bu1 + mg, vLo = bv0 - mg, vHi = bv1 + mg;
    var uBand = 0.10 * (bu1 - bu0), vBand = 0.10 * (bv1 - bv0);
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (i = 0; i < n; i++) {
      q = i * 3;
      var res = pl.n[0] * P[q] + pl.n[1] * P[q + 1] + pl.n[2] * P[q + 2] - pl.d;
      if (res > tol || res < -tol) continue;
      var pu = P[q] * pl.u[0] + P[q + 1] * pl.u[1] + P[q + 2] * pl.u[2];
      if (pu < uLo || pu > uHi) continue;
      var pv = P[q] * pl.v[0] + P[q + 1] * pl.v[1] + P[q + 2] * pl.v[2];
      if (pv < vLo || pv > vHi) continue;
      if (pv >= bv0 + vBand && pv <= bv1 - vBand) { if (pu < u0) u0 = pu; if (pu > u1) u1 = pu; }
      if (pu >= bu0 + uBand && pu <= bu1 - uBand) { if (pv < v0) v0 = pv; if (pv > v1) v1 = pv; }
    }
    if (!isFinite(u0)) { u0 = bu0; u1 = bu1; }
    if (!isFinite(v0)) { v0 = bv0; v1 = bv1; }
    return { u: { lo: u0, hi: u1, size: u1 - u0, mid: 0.5 * (u0 + u1) }, v: { lo: v0, hi: v1, size: v1 - v0, mid: 0.5 * (v0 + v1) } };
  }

  /* Ось по ковариации локальных нормалей: у цилиндра нормали ⟂ оси, т.е. ось — наименьшее
     собственное направление. Плоские участки (плоскости) в оценку НЕ берём: иначе у рамки
     «труба + потолок» нормали потолка задавят нормали трубы и ось будет неверной. */
  function _clsAxisFromNormals(ln, flat) {
    var i, q, nx, ny, nz;
    function collect(skipFlat) {
      var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0, m = 0;
      for (i = 0; i < ln.m; i++) {
        if (ln.L0[i] < 0 || ln.K[i] < 10) continue;
        if (skipFlat && flat && flat[i]) continue;
        q = i * 3; nx = ln.N[q]; ny = ln.N[q + 1]; nz = ln.N[q + 2];
        xx += nx * nx; xy += nx * ny; xz += nx * nz; yy += ny * ny; yz += ny * nz; zz += nz * nz; m++;
      }
      return { xx: xx, xy: xy, xz: xz, yy: yy, yz: yz, zz: zz, m: m };
    }
    var acc = collect(true);
    if (acc.m < 40) acc = collect(false);   // большая труба/колонна: локальные пятна ещё «плоские»
    if (acc.m < 40) return null;
    var e = eig3([acc.xx / acc.m, acc.xy / acc.m, acc.xz / acc.m, acc.yy / acc.m, acc.yz / acc.m, acc.zz / acc.m]);
    return { axis: e.vectors[0], iso: e.values[1] > 1e-9 ? e.values[0] / e.values[1] : 0, m: acc.m };
  }

  /* ---------- Гипотеза «плоскость»: стена / пол / потолок / перекрытие / панель ---------- */
  function _clsPlaneHyps(S, surfaces, ctx) {
    var P = S.P, n = S.n, out = [], yR = _clsYRange(P, n);
    var minPts = Math.max(150, Math.round(0.08 * n));
    var big = [], i, lim = Math.min(surfaces.length, 40);
    for (i = 0; i < lim && big.length < 10; i++) {
      var sf = surfaces[i];
      if (sf.count >= minPts && sf.minW >= 0.12 && sf.area >= 0.03) big.push(sf);
    }
    if (!big.length) return out;
    var used = {}, tol = Math.max(2.5 * (S.noise || 0.001), 1.2 * (S.spacing || 0.01), 0.004);
    var sigExt = Math.max(S.spacing || 0.01, 2 * (S.noise || 0.001), 0.002);
    big.forEach(function (A) {
      if (used[A.id]) return;
      var step = Math.max(1, Math.floor(n / 40000)), cnt = 0, tot = 0;
      for (var k = 0; k < n; k += step) { tot++; var q = k * 3; if (Math.abs(A.n[0] * P[q] + A.n[1] * P[q + 1] + A.n[2] * P[q + 2] - A.d) <= tol) cnt++; }
      var cover = tot ? cnt / tot : 0;
      if (cover < 0.15) return;
      // вторая параллельная грань (толщина) — по совпадению «следа»
      var partner = null, pinfo = null;
      for (var j = 0; j < big.length; j++) {
        var B = big[j];
        if (B.id === A.id || used[B.id]) continue;
        var pi = null;
        try { pi = pairInfo(A, B, P); } catch (e) { pi = null; }
        if (pi && pi.gap != null && pi.gap >= 0.02 && pi.gap <= 0.9 && pi.iou >= 0.18) { partner = B; pinfo = pi; break; }
      }
      var pe = _clsPlaneExtent(P, n, A, tol);
      var eu = pe ? pe.u : _clsExtend(P, n, A.u, A.ids), ev = pe ? pe.v : _clsExtend(P, n, A.v, A.ids);
      var dims = [], notes = [], type;
      if (A.kind === 'V') {
        type = 'wall';
        var cA = A.c;
        if (partner && pinfo) {
          used[A.id] = used[partner.id] = 1;
          var th = pinfo.gap, thSig = gapSigma(pinfo), thConf = pairConfidence(pinfo, A, partner);
          dims.push(makeDim({ key: 'wall-thickness', dimension: 'thickness', label: 'Толщина стены', value: th, sigma: thSig, method: 'planes', how: 'две грани (плоскости)', confidence: thConf, a: pinfo.a, b: pinfo.b, evidence: { pointsA: A.count, pointsB: partner.count, rmsA: A.rms, rmsB: partner.rms } }));
        } else {
          used[A.id] = 1;
          notes.push('Видна только одна грань стены — толщина не измеряется; нужна вторая грань в выделении.');
        }
        var mU = 0.5 * (eu.lo + eu.hi), mV = 0.5 * (ev.lo + ev.hi);
        dims.push(makeDim({ key: 'wall-length', dimension: 'length', label: 'Длина стены (видимый участок)', value: eu.size, sigma: sigExt, method: 'extent', how: 'по грани стены', confidence: clamp(Math.min(0.62, 0.35 + 0.5 * Math.min(1, cover)), 0.15, 0.7), a: add(cA, mul(A.u, -0.5 * eu.size)), b: add(cA, mul(A.u, 0.5 * eu.size)), notes: ['Края — границы видимого участка грани, а не обязательно торцы стены.'] }));
        dims.push(makeDim({ key: 'wall-height', dimension: 'height', label: 'Высота стены (видимый участок)', value: ev.size, sigma: sigExt, method: 'extent', how: 'по грани стены', confidence: clamp(Math.min(0.60, 0.35 + 0.5 * Math.min(1, cover)), 0.15, 0.68), a: add(cA, mul(A.v, -0.5 * ev.size)), b: add(cA, mul(A.v, 0.5 * ev.size)) }));
        if (thConf != null && thConf < 0.5) notes.push('Пара граней совпадает лишь частично — толщину проверьте вручную.');
      } else if (A.kind === 'H') {
        var up = A.n[1] >= 0 ? A.n : mul(A.n, -1);
        var hgt = up[0] * A.c[0] + up[1] * A.c[1] + up[2] * A.c[2];
        var rel = (hgt - yR.min) / Math.max(1e-6, yR.size || 1e-6);
        if (partner && partner.kind === 'H' && pinfo && pinfo.gap >= 0.03 && pinfo.gap <= 0.9) {
          type = 'slab'; used[A.id] = used[partner.id] = 1;
          var sth = pinfo.gap, sSig = gapSigma(pinfo), sConf = pairConfidence(pinfo, A, partner);
          dims.push(makeDim({ key: 'slab-thickness', dimension: 'thickness', label: 'Толщина плиты/перекрытия', value: sth, sigma: sSig, method: 'planes', how: 'две горизонтальные грани', confidence: sConf, a: pinfo.a, b: pinfo.b }));
        } else {
          type = (yR.size < 0.12) ? (up[1] >= 0 ? 'floor' : 'ceiling') : (rel <= 0.22 ? 'floor' : rel >= 0.78 ? 'ceiling' : 'slab');
          used[A.id] = 1;
          if (cover < 0.45) return;   // фоновая плоскость, а не объект в рамке
        }
      } else { type = 'panel'; used[A.id] = 1; }
      var qFac = clamp(1 - A.rms / (0.006 + 2 * (S.noise || 0.001)), 0, 1);
      var score = (CLS_PRIOR[type] || 0.6) * (0.28 + 0.72 * Math.min(1, cover / 0.8)) * (0.55 + 0.45 * qFac);
      if ((type === 'floor' || type === 'ceiling') && cover < 0.55) score *= 0.7;
      out.push({
        type: type, shape: 'plane', score: score, rms: A.rms, inlier: cover, center: [A.c[0], A.c[1], A.c[2]],
        points: Math.round(cover * n), dims: dims, notes: notes, planes: [A.id, partner ? partner.id : null],
        planeKind: A.kind, normal: A.n, axes: { u: A.u, v: A.v }, ext: { u: eu, v: ev }
      });
    });
    return out;
  }

  /* ---------- Гипотеза «прямоугольная коробка»: колонна / балка / лоток ---------- */
  function _clsBoxHyp(S, surfaces, ctx) {
    var P = S.P, n = S.n, sp = Math.max(S.spacing || 0.01, 0.004), yR = _clsYRange(P, n);
    var hs = [];
    function addH(nv) {
      var l = Math.hypot(nv[0], nv[2]);
      if (l < 0.1) return;
      var h = [nv[0] / l, 0, nv[2] / l];
      for (var i = 0; i < hs.length; i++) if (angleBetween(hs[i], h) < 6 * DEG) return;
      hs.push(h);
    }
    surfaces.forEach(function (sf) { if (sf.kind === 'V' && sf.count >= Math.max(50, 0.02 * n)) addH(sf.n); });
    (S.dirs || []).forEach(function (d) { if (Math.abs(d.dir[1]) < 0.5) addH(d.dir); });
    addH([1, 0, 0]); addH([0, 0, 1]);
    var minCnt = Math.max(50, Math.round(0.008 * n));
    var binw = Math.max(2.4 * sp, 0.0035), minSep = Math.max(0.03, 3.5 * sp);
    var tol = Math.max(3 * sp, 3 * (S.noise || 0.001), 0.005);
    var best = null;
    hs.forEach(function (h1) {
      var h2 = unit(cross(UP, h1)), axes = [h1, h2, UP];
      var pks = axes.map(function (ax) { return _clsPeaks(_clsProj(P, n, ax), minCnt, binw, minSep, 1.45); });
      var faces = [], faceInfo = [], refWin = Math.max(0.006, 1.4 * sp, 8 * (S.noise || 0.001));
      for (var ai = 0; ai < 3; ai++) {
        var cand = pks[ai].slice().sort(function (a, b) { return b.count - a.count || a.pos - b.pos; });
        var chosen = [];
        if (cand.length) {
          chosen.push(cand[0]);
          for (var cj = 1; cj < cand.length; cj++) {
            if (Math.abs(cand[cj].pos - chosen[0].pos) >= Math.max(minSep, 1.5 * binw)) { chosen.push(cand[cj]); break; }
          }
        }
        // уточняем позиции граней по всем точкам в узком окне
        chosen = chosen.map(function (f) { return { pos: _clsRefineFace(P, n, axes[ai], f.pos, refWin), count: f.count, axis: ai }; });
        if (chosen.length >= 2) {
          var s0 = Math.min(chosen[0].pos, chosen[1].pos), s1 = Math.max(chosen[0].pos, chosen[1].pos);
          faceInfo[ai] = { pair: true, size: s1 - s0 };
          faces.push({ axis: ai, pos: s0, count: chosen[0].count }, { axis: ai, pos: s1, count: chosen[1].count });
        } else if (chosen.length === 1) {
          faceInfo[ai] = { pair: false, size: null };
          faces.push({ axis: ai, pos: chosen[0].pos, count: chosen[0].count });
        }
      }
      var nPairs = 0, nAxis = 0;
      for (var ai2 = 0; ai2 < 3; ai2++) { if (!faceInfo[ai2]) continue; nAxis++; if (faceInfo[ai2].pair) nPairs++; }
      if (faces.length < 3 || nPairs < 1) return;
      // какая доля точек лежит на найденных гранях
      var explained = 0, ss = 0;
      for (var i2 = 0; i2 < n; i2++) {
        var q2 = i2 * 3, bd = Infinity;
        for (var f = 0; f < faces.length; f++) {
          var ax2 = axes[faces[f].axis], dd = Math.abs(P[q2] * ax2[0] + P[q2 + 1] * ax2[1] + P[q2 + 2] * ax2[2] - faces[f].pos);
          if (dd < bd) bd = dd;
        }
        if (bd <= tol) { explained++; ss += bd * bd; }
      }
      var cover = explained / n;
      if (cover < 0.42 || explained < 80) return;
      var rms = Math.sqrt(ss / explained);
      var qFac = clamp(1 - rms / (0.008 + 3 * (S.noise || 0.001)), 0, 1);
      var ext = axes.map(function (ax) { return _clsExtend(P, n, ax); });
      var hExt = [ext[0].size, ext[1].size], vExt = ext[2].size;
      // высоту точнее брать по боковым граням: их рёбра идут точно вдоль вертикали
      // (шум «гуляет» по нормали, а не по высоте), а точки снизу/сверху добавляют выбросы
      var yLo = Infinity, yHi = -Infinity, yCnt = 0;
      for (var iy = 0; iy < n; iy++) {
        var qy = iy * 3, bdy = Infinity, side = false;
        for (var fy = 0; fy < faces.length; fy++) {
          var axy = axes[faces[fy].axis], dy = Math.abs(P[qy] * axy[0] + P[qy + 1] * axy[1] + P[qy + 2] * axy[2] - faces[fy].pos);
          if (dy < bdy) { bdy = dy; side = faces[fy].axis !== 2; }
        }
        if (bdy <= tol && side) { var yy = P[qy + 1]; if (yy < yLo) yLo = yy; if (yy > yHi) yHi = yy; yCnt++; }
      }
      var vExtSide = (yCnt >= 60 && (yHi - yLo) > 0.1) ? (yHi - yLo) : vExt;
      var longA = hExt[0] >= hExt[1] ? 0 : 1, longSize = Math.max(hExt[0], hExt[1]), crossSize = Math.min(hExt[0], hExt[1]);
      var type, dims = [], notes = [];
      if (vExt >= 0.45 && vExt >= 0.75 * longSize) type = 'column';
      else if (longSize >= 0.6 && longSize >= 1.8 * Math.max(vExt, crossSize)) type = (vExt <= 0.35 && hExt[longA] >= 0.5) ? 'tray' : 'beam';
      else return;
      var pairSize = function (axIdx) { var fi = faceInfo[axIdx]; return fi && fi.pair ? fi.size : null; };
      var crossA0 = 1 - longA;
      // правдоподобие габаритов по типу: «балка 3.3×3.0 м» — это ниша/угол, а не балка
      if (type === 'column') {
        var cw0 = pairSize(0) != null ? pairSize(0) : hExt[0], cd0 = pairSize(1) != null ? pairSize(1) : hExt[1];
        if (cw0 > 1.60 || cd0 > 1.60 || cw0 < 0.05 || cd0 < 0.05 || vExtSide < 0.45) return;
      } else {
        var bw0 = pairSize(crossA0) != null ? pairSize(crossA0) : hExt[crossA0];
        var limW = type === 'tray' ? 1.30 : 1.60, limH = type === 'tray' ? 0.90 : 1.60;
        if (bw0 > limW || bw0 < 0.02 || vExtSide > limH || hExt[longA] < 0.5) return;
      }
      var sigF = Math.max(0.5 * sp, S.noise || 0.001, 0.0006);
      var sigExt = Math.max(sp, 2 * (S.noise || 0.001), 0.002);
      var cen = _clsCentroid(P, null);
      // центр по объяснённым точкам точнее (нужен для контура/фокуса)
      var sx = 0, sy = 0, sz = 0, ce = 0;
      for (var i3 = 0; i3 < n; i3++) {
        var q3 = i3 * 3, bd3 = Infinity;
        for (var f3 = 0; f3 < faces.length; f3++) { var ax3 = axes[faces[f3].axis], d3 = Math.abs(P[q3] * ax3[0] + P[q3 + 1] * ax3[1] + P[q3 + 2] * ax3[2] - faces[f3].pos); if (d3 < bd3) bd3 = d3; }
        if (bd3 <= tol) { sx += P[q3]; sy += P[q3 + 1]; sz += P[q3 + 2]; ce++; }
      }
      if (ce > 30) cen = [sx / ce, sy / ce, sz / ce];
      // размеры: у коробки две горизонтальные оси; если на оси пара граней — сечение точное
      var secA = pairSize(0), secB = pairSize(1);
      var columnW = secA != null ? secA : hExt[0];
      var columnD = secB != null ? secB : hExt[1];
      var crossA = 1 - longA;
      if (type === 'column') {
        dims.push(makeDim({ key: 'column-width', dimension: 'width', label: 'Ширина колонны (сечение)', value: columnW, sigma: secA != null ? sigF : sigExt, method: secA != null ? 'planes' : 'extent', how: secA != null ? 'две боковые грани' : 'по габариту (грань не видна)', confidence: secA != null ? 0.85 : 0.35 }));
        dims.push(makeDim({ key: 'column-depth', dimension: 'depth', label: 'Глубина колонны (сечение)', value: columnD, sigma: secB != null ? sigF : sigExt, method: secB != null ? 'planes' : 'extent', how: secB != null ? 'две боковые грани' : 'по габариту (грань не видна)', confidence: secB != null ? 0.85 : 0.35 }));
        dims.push(makeDim({ key: 'column-height', dimension: 'height', label: 'Высота колонны (видимый участок)', value: vExtSide, sigma: sigExt, method: 'extent', how: 'по боковым граням', confidence: 0.62, a: add(cen, mul(UP, -0.5 * vExtSide)), b: add(cen, mul(UP, 0.5 * vExtSide)), notes: ['Края — границы выделения, а не обязательно торцы колонны.'] }));
        notes.push('Квадратное/прямоугольное сечение: ' + Math.round(1000 * columnW) + '×' + Math.round(1000 * columnD) + ' мм по ' + (nPairs >= 2 ? 'двум парам граней' : 'видимым граням') + '.');
      } else {
        var width = pairSize(crossA) != null ? pairSize(crossA) : hExt[crossA];
        var hgt = vExtSide;
        var len = hExt[longA];
        var widthKey = type === 'tray' ? 'tray-width' : 'beam-width';
        var heightKey = type === 'tray' ? 'tray-height' : 'beam-height';
        var lengthKey = type === 'tray' ? 'tray-length' : 'beam-length';
        dims.push(makeDim({ key: widthKey, dimension: 'width', label: (type === 'tray' ? 'Ширина лотка' : 'Ширина балки') + ' (сечение)', value: width, sigma: pairSize(crossA) != null ? sigF : sigExt, method: pairSize(crossA) != null ? 'planes' : 'extent', how: pairSize(crossA) != null ? 'две грани сечения' : 'по габариту', confidence: pairSize(crossA) != null ? 0.82 : 0.35 }));
        dims.push(makeDim({ key: heightKey, dimension: 'height', label: (type === 'tray' ? 'Высота лотка' : 'Высота балки') + ' (сечение)', value: hgt, sigma: sigExt, method: 'extent', how: 'по боковым граням', confidence: 0.62 }));
        dims.push(makeDim({ key: lengthKey, dimension: 'length', label: (type === 'tray' ? 'Длина лотка' : 'Длина балки') + ' (видимый участок)', value: len, sigma: sigExt, method: 'extent', how: 'по видимой части', confidence: 0.6, a: add(cen, mul(axes[longA], -0.5 * len)), b: add(cen, mul(axes[longA], 0.5 * len)), notes: ['Края — границы видимого участка, не обязательно торцы.'] }));
        notes.push('Открытые/невидимые грани: ' + (3 - nPairs) + ' из 6 — сечение по видимым граням.');
      }
      var score = (CLS_PRIOR[type] || 0.9) * (0.42 + 0.58 * Math.min(1, cover / 0.85)) * (0.55 + 0.45 * qFac) * (1 - 0.10 * (2 - Math.min(2, nPairs)));
      var hyp = {
        type: type, shape: 'box', score: score, rms: rms, inlier: cover, center: cen, points: explained,
        dims: dims, notes: notes, axes: axes, sizes: { h: hExt, v: vExtSide }, facePairs: nPairs, faces: faces.length
      };
      if (!best || hyp.score > best.score) best = hyp;
    });
    return best;
  }

  /* ---------- Гипотеза «угол из двух смежных граней»: частично видимая колонна ----------
     Часто в рамку попадают только 1–2 грани колонны (остальные закрыты или вне кадра).
     Две смежные узкие вертикальные грани с общей вертикальной осью — это сечение колонны;
     для стен такой угол шире и его отбрасывает ограничение по ширине. */
  function _clsCornerHyp(S, surfaces, ctx) {
    var P = S.P, n = S.n, vs = [], i, j, best = null;
    surfaces.forEach(function (sf) { if (sf.kind === 'V' && sf.count >= Math.max(80, 0.02 * n)) vs.push(sf); });
    if (vs.length < 2) return null;
    var cosMax = Math.cos(70 * DEG);
    for (i = 0; i < Math.min(vs.length, 8); i++) for (j = i + 1; j < Math.min(vs.length, 8); j++) {
      var A = vs[i], B = vs[j];
      if (Math.abs(dot(A.n, B.n)) > cosMax) continue;             // грани должны быть «смежными», не параллельными
      var peA = _clsPlaneExtent(P, n, A, Math.max(3 * (S.noise || 0.001), 1.5 * (S.spacing || 0.01), 0.004));
      var peB = _clsPlaneExtent(P, n, B, Math.max(3 * (S.noise || 0.001), 1.5 * (S.spacing || 0.01), 0.004));
      var euA = peA ? peA.u : _clsExtend(P, n, A.u, A.ids), evA = peA ? peA.v : _clsExtend(P, n, A.v, A.ids);
      var euB = peB ? peB.u : _clsExtend(P, n, B.u, B.ids), evB = peB ? peB.v : _clsExtend(P, n, B.v, B.ids);
      var wA = euA.size, wB = euB.size, hA = evA.size, hB = evB.size;
      if (!(wA >= 0.10 && wA <= 1.40 && wB >= 0.10 && wB <= 1.40)) continue;   // стены — шире
      if (Math.min(hA, hB) < 0.35) continue;
      var hExt = Math.max(hA, hB), wMax = Math.max(wA, wB);
      if (hExt < 1.1 * wMax) continue;                              // колонна выше, чем шире
      // куски должны примыкать друг к другу (общая вертикальная ось угла)
      var dmin = Infinity, stp = Math.max(1, Math.floor(A.ids.length / 200));
      for (var k = 0; k < A.ids.length; k += stp) {
        var q = A.ids[k] * 3, dd = distPointPatch(B, [P[q], P[q + 1], P[q + 2]]);
        if (dd < dmin) dmin = dd;
      }
      if (!(dmin <= Math.max(0.12, 4 * (S.spacing || 0.01)))) continue;
      // общая линия угла должна быть подтверждена точками (у цилиндра «угол» из хорд —
      // фикция: на линии пересечения плоскостей-хорд точек нет)
      var edgeTol = Math.max(2 * (S.spacing || 0.01), 3 * (S.noise || 0.001), 0.004);
      var edgeNeed = Math.max(20, Math.round(0.004 * n));
      var edgeCnt = 0;
      for (var k2 = 0; k2 < n; k2++) {
        var q2 = k2 * 3;
        var rA = Math.abs(A.n[0] * P[q2] + A.n[1] * P[q2 + 1] + A.n[2] * P[q2 + 2] - A.d);
        if (rA > edgeTol) continue;
        var rB = Math.abs(B.n[0] * P[q2] + B.n[1] * P[q2 + 1] + B.n[2] * P[q2 + 2] - B.d);
        if (rB <= edgeTol) { edgeCnt++; if (edgeCnt >= edgeNeed) break; }
      }
      if (edgeCnt < edgeNeed) continue;
      var cover = (A.count + B.count) / n;
      if (cover < 0.18) continue;
      var wDif = Math.abs(wA - wB) / Math.max(1e-6, wMax);
      var rms = Math.max(A.rms, B.rms);
      var qFac = clamp(1 - rms / (0.006 + 2 * (S.noise || 0.001)), 0, 1);
      var score = CLS_PRIOR.column * (0.55 + 0.45 * Math.min(1, cover / 0.45)) * (1 - 0.20 * Math.min(1, wDif)) * (0.6 + 0.4 * qFac);
      if (best && score <= best.score) continue;
      var sig = Math.max(0.5 * (S.spacing || 0.01), S.noise || 0.001, 0.0008);
      var mg = [A.c[0], A.c[1], A.c[2]];
      var dims = [
        makeDim({ key: 'column-width', dimension: 'width', label: 'Ширина колонны (видимая грань)', value: wA, sigma: sig, method: 'extent', how: 'по видимой грани', confidence: 0.55, a: add(mg, mul(A.u, -0.5 * wA)), b: add(mg, mul(A.u, 0.5 * wA)) }),
        makeDim({ key: 'column-depth', dimension: 'depth', label: 'Глубина колонны (вторая грань)', value: wB, sigma: sig, method: 'extent', how: 'по второй видимой грани', confidence: wDif < 0.2 ? 0.55 : 0.35, a: add([B.c[0], B.c[1], B.c[2]], mul(B.u, -0.5 * wB)), b: add([B.c[0], B.c[1], B.c[2]], mul(B.u, 0.5 * wB)) }),
        makeDim({ key: 'column-height', dimension: 'height', label: 'Высота колонны (видимый участок)', value: hExt, sigma: Math.max(S.spacing || 0.01, 2 * (S.noise || 0.001), 0.002), method: 'extent', how: 'по граням', confidence: 0.55, a: add(mg, mul(UP, -0.5 * hExt)), b: add(mg, mul(UP, 0.5 * hExt)), notes: ['Края — границы выделения, не обязательно торцы колонны.'] })
      ];
      best = {
        type: 'column', shape: 'corner', score: score, rms: rms, inlier: cover, center: mg, points: A.count + B.count,
        dims: dims, notes: ['Видны две смежные грани — сечение колонны по видимым граням; для полного сечения обведите все грани.'], corner: { A: A.id, B: B.id }
      };
    }
    return best;
  }

  /* ---------- Гипотеза «цилиндр»: труба / круглая колонна ---------- */
  function _clsCylHyp(S, ctx) {
    var P = S.P, n = S.n, sp = Math.max(S.spacing || 0.01, 0.004);
    var axInfo = _clsAxisFromNormals(S.ln, S.flat);
    if (!axInfo) return null;
    var axis = axInfo.axis;
    var step = Math.max(1, Math.floor(n / 30000)), ids = [];
    for (var i = 0; i < n; i += step) ids.push(i);
    if (ids.length < 400) return null;
    var c0 = _clsCentroid(P, ids);
    var dist = new Float64Array(ids.length), dmax = 0, k;
    for (k = 0; k < ids.length; k++) {
      var q = ids[k] * 3, wx = P[q] - c0[0], wy = P[q + 1] - c0[1], wz = P[q + 2] - c0[2], t = wx * axis[0] + wy * axis[1] + wz * axis[2];
      var rx = wx - t * axis[0], ry = wy - t * axis[1], rz = wz - t * axis[2], d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      dist[k] = d; if (d > dmax) dmax = d;
    }
    if (!(dmax > 0.02)) return null;
    var rPeaks = _clsPeaks(dist, Math.max(12, Math.round(0.01 * ids.length)), Math.max(2 * sp, 0.004), Math.max(0.03, 3 * sp));
    var r0 = rPeaks.length ? rPeaks[0].pos : dmax * 0.5;
    if (!(r0 > 0.008 && r0 < 3)) return null;
    var fit = null;
    try { fit = fitCylinder3D(P, ids, ids.length, axis, c0, r0); } catch (e) { fit = null; }
    if (!fit || !(fit.r > 0.008) || fit.r > 5) return null;
    // метрики по всем точкам
    var tol = Math.max(3 * sp, 4 * (S.noise || 0.001), 0.006);
    var bs = planeBasis(fit.a), bins = new Int32Array(36), explained = 0, ss = 0, tmin = Infinity, tmax = -Infinity, rads = [];
    for (i = 0; i < n; i++) {
      q = i * 3; wx = P[q] - fit.c[0]; wy = P[q + 1] - fit.c[1]; wz = P[q + 2] - fit.c[2];
      var tt = wx * fit.a[0] + wy * fit.a[1] + wz * fit.a[2];
      var qx = wx - tt * fit.a[0], qy = wy - tt * fit.a[1], qz = wz - tt * fit.a[2];
      var dd = Math.sqrt(qx * qx + qy * qy + qz * qz), res = Math.abs(dd - fit.r);
      if (res > tol) continue;
      explained++; ss += res * res; rads.push(dd);
      if (tt < tmin) tmin = tt; if (tt > tmax) tmax = tt;
      var ang = Math.atan2(qx * bs.v[0] + qy * bs.v[1] + qz * bs.v[2], qx * bs.u[0] + qy * bs.u[1] + qz * bs.u[2]);
      var bi = Math.floor((ang + Math.PI) / (2 * Math.PI) * 36); if (bi < 0) bi = 0; if (bi > 35) bi = 35; bins[bi]++;
    }
    var cover = explained / n;
    if (explained < 250 || cover < 0.04) return null;
    var rms = Math.sqrt(ss / Math.max(1, explained)), relRms = rms / fit.r;
    if (relRms > 0.10) return null;   // квадратная колонна/стена: окружность не описывает точки
    var occ = 0; for (k = 0; k < 36; k++) if (bins[k] >= 2) occ++;
    var arc = occ * 10, length = tmax - tmin;
    if (arc < 80 || length < 0.03) return null;
    var qFac = clamp(1 - relRms / 0.07, 0, 1), arcFac = 0.55 + 0.45 * Math.min(1, arc / 300);
    var vertical = Math.abs(fit.a[1]) >= 0.75;
    var type = (vertical && fit.r >= 0.07 && length >= 0.4) ? 'column' : 'pipe';
    var sigR = Math.sqrt(Math.pow(0.5 * (S.noise || 0.001), 2) + Math.pow(0.3 * rms, 2) + Math.pow(SIGMA_SYS, 2));
    if (fit.cov) { try { sigR = Math.sqrt(Math.max(sigR * sigR, 6 * Math.max(0, fit.cov[4][4]) * rms * rms + Math.pow(0.3 * rms, 2) + SIGMA_SYS * SIGMA_SYS)); } catch (e2) { } }
    var dims = [], notes = [], d2 = 2 * fit.r;
    if (type === 'column') {
      dims.push(makeDim({ key: 'diameter', dimension: 'diameter', label: 'Диаметр круглой колонны', value: d2, sigma: 2 * sigR, method: 'fit', how: 'по окружности (наружный)', confidence: clamp(0.55 + 0.4 * qFac * Math.min(1, arc / 300), 0.2, 0.95), a: add(fit.c, mul(bs.u, -fit.r)), b: add(fit.c, mul(bs.u, fit.r)) }));
      dims.push(makeDim({ key: 'column-height', dimension: 'height', label: 'Высота колонны (видимый участок)', value: length, sigma: Math.max(sp, 2 * (S.noise || 0.001), 0.002), method: 'extent', how: 'по видимой части оси', confidence: 0.6, a: add(fit.c, mul(fit.a, tmin)), b: add(fit.c, mul(fit.a, tmax)), notes: ['Края — границы выделения, не обязательно торцы.'] }));
      notes.push('Круглое сечение: точки лежат на окружности (СКО ' + (1000 * rms).toFixed(1) + ' мм).');
    } else {
      dims.push(makeDim({ key: 'diameter', dimension: 'diameter', label: 'Диаметр трубы', value: d2, sigma: 2 * sigR, method: 'fit', how: 'по окружности (наружный)', confidence: clamp(0.55 + 0.4 * qFac * Math.min(1, arc / 300), 0.2, 0.95), a: add(fit.c, mul(bs.u, -fit.r)), b: add(fit.c, mul(bs.u, fit.r)) }));
      if (length >= 0.2) dims.push(makeDim({ key: 'length', dimension: 'length', label: 'Видимая длина трубы', value: length, sigma: Math.max(sp, 2 * (S.noise || 0.001), 0.002), method: 'extent', how: 'по видимой части оси', confidence: 0.45, a: add(fit.c, mul(fit.a, tmin)), b: add(fit.c, mul(fit.a, tmax)), notes: ['Длина — видимый участок, ограничен выделением.'] }));
      if (arc < 200) notes.push('Видна часть окружности (' + arc + '°) — диаметр менее надёжен.');
    }
    var score = (CLS_PRIOR[type] || 1) * (0.30 + 0.70 * Math.min(1, cover / 0.55)) * (0.45 + 0.55 * qFac) * arcFac;
    return {
      type: type, shape: 'cylinder', score: score, rms: rms, inlier: cover, center: add(fit.c, mul(fit.a, 0.5 * (tmin + tmax))),
      points: explained, dims: dims, notes: notes, cylinder: { a: fit.a, c: fit.c, r: fit.r, sigmaR: sigR, rms: rms, count: explained, arc: arc, t0: tmin, t1: tmax, length: length, basis: bs },
      relRms: relRms, arc: arc, length: length
    };
  }

  /* ---------- Гипотеза «проём» (используем существующий детектор) ---------- */
  function _clsOpeningHyps(ctx, evidence) {
    var objs = evidence && evidence.openings;
    if (!objs) {
      objs = [];
      try {
        var ops = findOpenings(ctx).map(function (op) { var ob = openingObject(op, ctx); ob.raw = op; return ob; });
        objs = dedupeOpenings(ops);
      } catch (e) { objs = []; }
      if (!objs.length) { try { holeOpenings(ctx).forEach(function (ho) { objs.push(holeObject(ho, ctx)); }); } catch (e2) { } }
    }
    var out = [];
    (objs || []).forEach(function (ob) {
      var dims = ob.dims || [], width = null, height = null, conf = 0.5;
      dims.forEach(function (d) {
        if (d.confidence > conf) conf = d.confidence;
        if (d.key === 'width') width = d.value;
        if (d.key === 'height') height = d.value;
      });
      // отбраковка вырожденных «проёмов» на гранях колонн/стен (ширина = толщине и т.п.)
      if (!(width >= 0.55 && width <= 5.0)) return;
      if (height != null && !(height >= 0.8 && height <= 4.5)) return;
      var score = (CLS_PRIOR.opening || 1) * (0.55 + 0.45 * conf);
      out.push({ type: 'opening', shape: 'opening', score: score, rms: null, inlier: 1, center: ob.center || [0, 0, 0], points: ob.pointsUsed || 0, dims: dims, notes: ob.notes || [], openingObj: ob });
    });
    return out;
  }

  /* ---------- Гипотеза «ребро/угол»: облако линейное (одно измерение много больше) ---------- */
  function _clsEdgeHyp(S) {
    var P = S.P, n = S.n;
    if (n < 300) return null;
    var cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < n; i++) { cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; }
    cx /= n; cy /= n; cz /= n;
    var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (i = 0; i < n; i++) { var ax = P[i * 3] - cx, ay = P[i * 3 + 1] - cy, az = P[i * 3 + 2] - cz; xx += ax * ax; xy += ax * ay; xz += ax * az; yy += ay * ay; yz += ay * az; zz += az * az; }
    var e = eig3([xx / n, xy / n, xz / n, yy / n, yz / n, zz / n]);
    var l0 = Math.sqrt(Math.max(0, e.values[0])), l1 = Math.sqrt(Math.max(0, e.values[1])), l2 = Math.sqrt(Math.max(0, e.values[2]));
    if (!(l2 > 0.10 && l2 > 3.5 * l1 && l1 < 0.6 * l2)) return null;
    var ext = _clsExtend(P, n, e.vectors[2]);
    return { type: 'edge', shape: 'edge', score: CLS_PRIOR.edge * (0.3 + 0.5 * Math.min(1, (l2 - 3.5 * l1) / l2)), rms: l1, inlier: 1, center: [cx, cy, cz], points: n, dims: [makeDim({ key: 'edge-length', dimension: 'length', label: 'Длина ребра (видимый участок)', value: ext.size, sigma: Math.max(S.spacing || 0.01, 2 * (S.noise || 0.001), 0.002), method: 'extent', how: 'по линейному облаку', confidence: 0.4, a: [cx + e.vectors[2][0] * ext.lo, cy + e.vectors[2][1] * ext.lo, cz + e.vectors[2][2] * ext.lo], b: [cx + e.vectors[2][0] * ext.hi, cy + e.vectors[2][1] * ext.hi, cz + e.vectors[2][2] * ext.hi] })], notes: ['Облако вытянуто в линию: это может быть ребро/стык, а не отдельный элемент.'] };
  }

  function _clsRuTitle(hyp) {
    var d = {};
    (hyp.dims || []).forEach(function (x) { d[x.key] = x.value; });
    var mm = function (v) { return Math.round(1000 * v); };
    switch (hyp.type) {
      case 'wall':
        return 'Стена' + (d['wall-thickness'] != null ? ' ' + mm(d['wall-thickness']) + ' мм' : '') + (d['wall-length'] != null ? ' · ' + d['wall-length'].toFixed(2) + ' м' : '') + (d['wall-height'] != null ? ' × ' + d['wall-height'].toFixed(2) + ' м' : '');
      case 'column':
        if (d['column-width'] != null) return 'Колонна ' + mm(d['column-width']) + '×' + mm(d['column-depth'] || d['column-width']) + ' мм' + (d['column-height'] != null ? ' · H ' + d['column-height'].toFixed(2) + ' м' : '');
        return 'Колонна' + (d.diameter != null ? ' Ø' + mm(d.diameter) + ' мм' : '') + (d['column-height'] != null ? ' · H ' + d['column-height'].toFixed(2) + ' м' : '');
      case 'beam': return 'Балка ' + (d['beam-width'] != null ? mm(d['beam-width']) : '?') + '×' + (d['beam-height'] != null ? mm(d['beam-height']) : '?') + ' мм' + (d['beam-length'] != null ? ' · L ' + d['beam-length'].toFixed(2) + ' м' : '');
      case 'tray': return 'Лоток ' + (d['tray-width'] != null ? mm(d['tray-width']) : '?') + '×' + (d['tray-height'] != null ? mm(d['tray-height']) : '?') + ' мм';
      case 'pipe': return 'Труба' + (d.diameter != null ? ' Ø' + mm(d.diameter) + ' мм' : '') + (d.length != null ? ' · ' + d.length.toFixed(2) + ' м' : '');
      case 'opening': return (hyp.openingObj && hyp.openingObj.title) || 'Проём';
      case 'floor': return 'Пол (плоскость)';
      case 'ceiling': return 'Потолок (плоскость)';
      case 'slab': return 'Перекрытие/плита' + (d['slab-thickness'] != null ? ' ' + mm(d['slab-thickness']) + ' мм' : '');
      case 'panel': return 'Панель/плоскость';
      case 'edge': return 'Ребро/угол' + (d['edge-length'] != null ? ' ' + d['edge-length'].toFixed(2) + ' м' : '');
      default: return CLS_DEF[hyp.type] ? CLS_DEF[hyp.type].ru : 'объект';
    }
  }
  /* Контур для показа на облаке: рамка стены/грани или рёбра коробки (пары точек). */
  function _clsOutline(hyp) {
    var out = [], k, j, q;
    var c = hyp.center || [0, 0, 0];
    if (hyp.shape === 'plane' && hyp.ext && hyp.axes) {
      var u = hyp.axes.u, v = hyp.axes.v, eu = hyp.ext.u, ev = hyp.ext.v;
      var mu = eu.mid, mv = ev.mid;
      // центр куска в координатах осей
      var pc = mul(u, mu), qv = mul(v, mv);
      var cs = [];
      [[eu.lo, ev.lo], [eu.hi, ev.lo], [eu.hi, ev.hi], [eu.lo, ev.hi]].forEach(function (uv) { cs.push(add(add(mul(u, uv[0]), mul(v, uv[1])), [c[0], c[1], c[2]])); });
      for (k = 0; k < 4; k++) { out.push(cs[k], cs[(k + 1) % 4]); }
    } else if (hyp.shape === 'box' && hyp.axes && hyp.sizes) {
      var ax = hyp.axes, hs = hyp.sizes.h, vs = hyp.sizes.v;
      var half = [0.5 * hs[0], 0.5 * hs[1], 0.5 * vs];
      var corners = [];
      for (k = 0; k < 8; k++) {
        var sg = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1];
        corners.push(add(add(add(c, mul(ax[0], sg[0] * half[0])), mul(ax[1], sg[1] * half[1])), mul(UP, sg[2] * half[2])));
      }
      var edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      edges.forEach(function (e) { out.push(corners[e[0]], corners[e[1]]); });
    } else if (hyp.shape === 'cylinder' || hyp.shape === 'opening' || hyp.shape === 'edge') {
      (hyp.dims || []).forEach(function (d) { if (d.a && d.b) out.push(d.a, d.b); });
    }
    return out;
  }
  function _clsMakeObject(hyp) {
    if (!hyp || !hyp.dims || !hyp.dims.length) return null;
    var def = CLS_DEF[hyp.type] || CLS_DEF.panel;
    var obType = hyp.type === 'wall' ? 'wall' : (hyp.type === 'column' || hyp.type === 'beam' || hyp.type === 'tray') ? 'column' : (hyp.type === 'pipe') ? 'cylinder' : (hyp.type === 'opening') ? 'opening' : 'plane';
    if (hyp.type === 'column' && hyp.shape === 'cylinder') obType = 'column';
    if (hyp.type === 'beam') obType = 'beam';
    if (hyp.type === 'tray') obType = 'tray';
    var ob = {
      type: obType, clsType: hyp.type, title: _clsRuTitle(hyp), dims: hyp.dims, notes: (hyp.notes || []).slice(),
      center: hyp.center, pointsUsed: hyp.points, score: Math.min(1.25, 0.55 + 0.65 * (hyp.prob || 0.6)),
      family: def.family, clsRole: def.role, clsShape: hyp.shape, clsOutline: _clsOutline(hyp)
    };
    if (hyp.shape === 'cylinder') ob.cylinder = hyp.cylinder;
    if (hyp.type === 'opening' && hyp.openingObj) { ob.type = 'opening'; ob.raw = hyp.openingObj.raw; }
    return ob;
  }

  /* Вероятности top-3: softmax по score + фоновая «не уверен», чтобы не выдавать 100 %.
     Гипотезы одного типа (например, колонна-коробка и колонна-угол) агрегируются: в top-3
     попадают РАЗНЫЕ типы, а их вероятности складываются. */
  function _clsProbabilities(hyps) {
    if (!hyps.length) return null;
    hyps.sort(function (a, b) { return b.score - a.score; });
    var groups = {}, types = [];
    hyps.forEach(function (h) {
      if (!groups[h.type]) { groups[h.type] = { type: h.type, best: h, score: h.score, count: 0, prob: 0, rms: h.rms, inlier: h.inlier, title: h.title }; types.push(groups[h.type]); }
      var g = groups[h.type];
      g.count++;
      g.prob += 1;
      if (h.score > g.score) { g.score = h.score; g.best = h; g.rms = h.rms; g.inlier = h.inlier; g.title = h.title; }
    });
    types.sort(function (a, b) { return b.score - a.score; });
    var maxS = types[0].score, sum = 0, i;
    for (i = 0; i < types.length; i++) { types[i]._e = Math.exp((types[i].score - maxS) / CLS_T); sum += types[i]._e; }
    var bg = Math.exp((0.30 - maxS) / CLS_T), tot = sum + bg;
    for (i = 0; i < types.length; i++) types[i].prob = types[i]._e / tot;
    // каждой гипотезе — вероятность её типа
    hyps.forEach(function (h) { var g = groups[h.type]; h.prob = g.prob; });
    types[0].best.prob = types[0].prob;
    var probs = types.slice(0, 3).map(function (g) {
      return { type: g.type, kind: (CLS_DEF[g.type] || {}).ru || g.type, probability: g.prob, score: +g.score.toFixed(4), rms: g.rms != null ? +g.rms.toFixed(5) : null, inlier: +(g.inlier || 0).toFixed(3), title: g.title || null, shapes: g.count };
    });
    return { type: types[0].type, confidence: types[0].prob, probabilities: probs, otherProbability: bg / tot, groups: groups, types: types };
  }

  /* Ядро классификации: S — подготовленное облако, surfaces — куски плоскостей,
     ctx — {P,S,surfaces,floor,c0}, opts.evidence — уже найденные объекты (в analyze). */
  function classifyCore(S, surfaces, ctx, opts) {
    opts = opts || {};
    var t0 = Date.now(), ev = opts.evidence || {}, hyps = [];
    function add(h) { if (h) { if (h.type && !h.title) h.title = _clsRuTitle(h); hyps.push(h); } }
    try { _clsPlaneHyps(S, surfaces, ctx).forEach(add); } catch (e1) { }
    try { add(_clsBoxHyp(S, surfaces, ctx)); } catch (e2) { }
    try { add(_clsCornerHyp(S, surfaces, ctx)); } catch (e6) { }
    var cylHyp = null;
    try { cylHyp = _clsCylHyp(S, ctx); add(cylHyp); } catch (e3) { }
    try { _clsOpeningHyps(ctx, ev).forEach(add); } catch (e4) { }
    try { add(_clsEdgeHyp(S)); } catch (e5) { }
    if (!hyps.length) return null;
    // сильный проём «объясняет» свои же откосы/перемычку/пол лучше, чем коробка/угол из них:
    // дверная ниша — это не «балка» и не «колонна», поэтому таким гипотезам понижаем score
    var strongOpening = null;
    hyps.forEach(function (h) {
      if (h.type !== 'opening') return;
      var wConf = 0;
      (h.dims || []).forEach(function (d) { if (d.key === 'width' && d.method === 'planes' && d.confidence > wConf) wConf = d.confidence; });
      if (wConf >= 0.70 && (!strongOpening || h.score > strongOpening.score)) strongOpening = h;
    });
    if (strongOpening) {
      hyps.forEach(function (h) { if (h.shape === 'box' || h.shape === 'corner') h.score *= 0.62; });
    }
    // dedupe: один тип/форма — несколько почти одинаковых гипотез оставляем лучшую
    var keep = [];
    hyps.sort(function (a, b) { return b.score - a.score; });
    hyps.forEach(function (h) {
      for (var i = 0; i < keep.length; i++) {
        var k = keep[i];
        if (k.type !== h.type || k.shape !== h.shape) continue;
        var dd = len(sub(k.center, h.center));
        if (k.shape === 'cylinder' && k.cylinder && h.cylinder && len(sub(k.cylinder.c, h.cylinder.c)) > 0.5) continue;
        if (dd < 0.35 || (k.type === h.type && k.shape === 'plane' && dd < 0.6)) return;
      }
      keep.push(h);
    });
    var prob = _clsProbabilities(keep);
    if (!prob) return null;
    var best = prob.types[0].best;
    best.prob = prob.probabilities[0].probability;
    var obj = _clsMakeObject(best);
    var cylValid = !!(cylHyp && cylHyp.relRms <= 0.07 && cylHyp.arc >= 160 && cylHyp.points >= 250);
    return {
      ok: true, type: best.type, kind: (CLS_DEF[best.type] || {}).ru || best.type,
      family: (CLS_DEF[best.type] || {}).family || 'panel', role: (CLS_DEF[best.type] || {}).role || 'other',
      confidence: prob.confidence, probabilities: prob.probabilities, otherProbability: prob.otherProbability,
      title: best.title, dims: best.dims, notes: best.notes || [], object: obj,
      hypotheses: keep.slice(0, 6).map(function (h) { return { type: h.type, kind: (CLS_DEF[h.type] || {}).ru || h.type, shape: h.shape, score: +h.score.toFixed(4), probability: +h.prob.toFixed(4), rms: h.rms != null ? +h.rms.toFixed(5) : null, inlier: +(h.inlier || 0).toFixed(3), points: h.points || 0 }; }),
      info: { points: S.n, spacing: S.spacing, noise: S.noise, surfaces: surfaces.length, ms: Date.now() - t0, cylinderValid: cylValid, cylinderRelRms: cylHyp ? +cylHyp.relRms.toFixed(4) : null, cylinderArc: cylHyp ? cylHyp.arc : null }
    };
  }

  /* Публичный вход: pos — Float32Array/Float64Array/Array x,y,z…; opts.kind/focus не обязательны. */
  function classify(pos, opts) {
    opts = opts || {};
    try {
      var pre = prepare(pos, opts.maxPoints || 200000);
      if (pre.n < 300) return { ok: false, error: 'В выделении слишком мало точек (' + Math.floor(pos.length / 3) + ') для классификации.', info: { points: Math.floor(pos.length / 3) } };
      var S = detectSurfaces(pre, opts), surfaces = buildSurfaces(S, opts);
      S.surfaces = surfaces;
      var floor = findFloor(surfaces, S.P, S.n);
      var ctx = { P: S.P, S: S, surfaces: surfaces, floor: floor, c0: pre.c0 };
      var res = classifyCore(S, surfaces, ctx, opts);
      if (!res) return { ok: false, error: 'Не удалось построить ни одной гипотезы формы.', info: { points: pre.n, spacing: S.spacing, noise: S.noise } };
      // координаты — обратно в систему облака
      var c0 = pre.c0;
      function back(p) { return p ? [p[0] + c0[0], p[1] + c0[1], p[2] + c0[2]] : p; }
      if (res.object) {
        res.object.center = back(res.object.center);
        res.object.dims.forEach(function (d) { d.a = back(d.a); d.b = back(d.b); });
        if (res.object.clsOutline) res.object.clsOutline = res.object.clsOutline.map(back);
        if (res.object.cylinder) res.object.cylinder.c = back(res.object.cylinder.c);
      }
      res.dims = res.object ? res.object.dims : res.dims;
      res.info.c0 = c0;
      return res;
    } catch (e) {
      return { ok: false, error: 'Классификация не удалась: ' + (e && e.message || e), stack: e && e.stack };
    }
  }

  /* ---------- Главный вход ---------- */
  /* Типы объектов из инспектора → семейство гипотез. Тип, выбранный человеком, поднимает «свои» находки и опускает чужие (но не прячет). */
  var KIND_FAMILY = { 'проём': 'opening', 'дверь': 'opening', 'окно': 'opening', 'труба': 'pipe', 'воздуховод': 'pipe', 'стена': 'panel', 'перекрытие': 'panel', 'пол': 'panel', 'потолок': 'panel', 'колонна': 'box', 'балка': 'box', 'оборудование': 'box', 'лоток': 'box' };
  function familyOf(ob) {
    if (ob.clsRole && CLS_DEF[ob.clsType]) return CLS_DEF[ob.clsType].family;
    if (ob.type === 'wall' || ob.type === 'plane') return 'panel';
    if (ob.type === 'column' || ob.type === 'beam' || ob.type === 'tray' || ob.type === 'box') return 'box';
    if (ob.type === 'edge') return 'edge';
    return ob.type === 'opening' ? 'opening' : (ob.type === 'cylinder' || ob.type === 'pipes' || ob.type === 'duct') ? 'pipe' : 'panel';
  }

  function findFloor(surfaces, P, n) {
    var ymin = Infinity, ymax = -Infinity, i;
    for (i = 0; i < n; i++) { var y = P[i * 3 + 1]; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    var best = null;
    surfaces.forEach(function (s) {
      if (s.kind !== 'H' || s.area < 1.0 || Math.min(s.ext.u1 - s.ext.u0, s.ext.v1 - s.ext.v0) < 0.8) return;
      if (s.c[1] - ymin > 0.2 * (ymax - ymin) + 0.05) return;
      if (!best || s.c[1] < best.c[1]) best = s;
    });
    return best;
  }

  /* Размер → стандартный результат «distance» приложения (+ метаданные auto): так его принимают список измерений, сверка и отчёты. */
  function toMeasurement(dim, extra) {
    var a = dim.a, b = dim.b, dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], hor = Math.hypot(dx, dz);
    var res = { mode: 'distance', a: a.slice(), b: b.slice(), d3: Math.hypot(dx, dy, dz), dx: dx, dy: dy, dz: dz, horizontal: hor, vertical: Math.abs(dy), slope: Math.atan2(dy, hor) / DEG, grade: hor > 1e-9 ? dy / hor * 100 : (dy === 0 ? 0 : Infinity) };
    if (dim.dimension === 'slope') { res.grade = dim.value; res.gradeSigma = dim.sigma; }
    else { res.perp = dim.value; res.perpKind = dim.method === 'planes' ? 'planes' : dim.method === 'edges' ? 'edges' : 'fit'; res.perpSigma = dim.sigma; res.sigma = dim.sigma; if (dim.tilt != null) res.tilt = +dim.tilt.toFixed(5); }
    res.auto = {
      dimension: dim.dimension, label: dim.label, how: dim.how, method: dim.method, confidence: +dim.confidence.toFixed(3), level: dim.level, sigma: dim.sigma, value: dim.value,
      object: extra && extra.object || null, key: dim.key, unit: dim.dimension === 'slope' ? '%' : 'm'
    };
    return res;
  }

  function dedupeOpenings(list) {
    var out = [];
    list.sort(function (a, b) { return b.score - a.score; }).forEach(function (ob) {
      var A = ob.raw.A.id, B = ob.raw.B.id;
      for (var i = 0; i < out.length; i++) { var q = out[i].raw; if (q.A.id === A || q.A.id === B || q.B.id === A || q.B.id === B) return; }
      out.push(ob);
    });
    return out;
  }

  /* Проёмы «по дыре в стене» сверяются с проёмами «по откосам»: если это один проём — второй способ идёт в заметку (независимая проверка),
   * иначе дыра — отдельная находка (откосов в кадре нет). Расхождение до ~3 см допустимо: откосы бывают неидеальными, а края дыры — это узкое место. */
  function mergeHoles(objects, holes) {
    var rest = [];
    holes.forEach(function (hb) {
      var wd = hb.dims.filter(function (d) { return d.key === 'width'; })[0];
      var twin = null;
      objects.forEach(function (ob) {
        if (ob.type !== 'opening' || ob.source === 'hole') return;
        var w0 = ob.dims.filter(function (d) { return d.key === 'width'; })[0]; if (!w0) return;
        if (len(sub(ob.center, hb.center)) < Math.max(0.5, 0.7 * w0.value) && !twin) twin = { ob: ob, w: w0 };
      });
      if (!twin || !wd) { rest.push(hb); return; }
      var dl = wd.value - twin.w.value;
      twin.w.notes.push('Независимая проверка по краям дыры в стене: ' + wd.value.toFixed(3) + ' м (' + (dl >= 0 ? '+' : '\u2212') + Math.abs(dl * 1000).toFixed(0) + ' мм к значению по откосам, способ «' + wd.how + '»).');
      twin.w.cross = { value: wd.value, delta: dl, how: wd.how, confidence: wd.confidence };
    });
    return rest;
  }

  function analyze(pos, opts) {
    opts = opts || {};
    var t0 = Date.now(), info = { points: Math.floor(pos.length / 3) };
    try {
      var pre = prepare(pos, opts.maxPoints || 200000);
      info.used = pre.n;
      if (pre.n < 300) return { ok: false, error: 'В выделении слишком мало точек (' + info.points + ') для автоматического замера — обведите объект крупнее.', objects: [], info: info };
      var S = detectSurfaces(pre, opts);
      var surfaces = buildSurfaces(S, opts);
      S.surfaces = surfaces;
      var floor = findFloor(surfaces, S.P, S.n);
      var ctx = { P: S.P, S: S, surfaces: surfaces, floor: floor, c0: pre.c0 };
      var objects = [], usedPairs = {};
      var ops = findOpenings(ctx).map(function (op) { var ob = openingObject(op, ctx); ob.raw = op; return ob; });
      dedupeOpenings(ops).forEach(function (ob) { objects.push(ob); usedPairs[ob.raw.A.id + ':' + ob.raw.B.id] = 1; });
      // проём как дыра в стене: второй, независимый способ (или единственный, если откосов в кадре нет)
      var holeObjs = [];
      if (opts.holes !== false) {
        try { holeOpenings(ctx).forEach(function (ho) { holeObjs.push(holeObject(ho, ctx)); }); } catch (eh) { info.holeError = String(eh && eh.message || eh); }
      }
      mergeHoles(objects, holeObjs).forEach(function (hb) { objects.push(hb); });
      var cy = detectCylinders(S, surfaces, opts), cobj = dedupeCylinders(cy.cylinders.map(function (c, i) { return cylinderObject(c, i, ctx); }));
      // «призраки» (огибающая пучка, подгонка по земле/стене, лишние дубли в пучке) не показываем как трубы: только счётчик и причины
      info.ghosts = consensusPipes(cobj) + implausibleCylinders(cobj, S.P, S.n);
      var rejected = cobj.filter(function (ob) { return ob.ghost; });
      cobj = cobj.filter(function (ob) { return !ob.ghost; });
      // прямоугольные воздуховоды: по одному на ось и размер (подгонка окружности дала бы ложную «трубу»)
      var dobj = [];
      (cy.boxes || []).map(function (bx, i) { return ductObject(bx, i, ctx); }).sort(function (a, b) { return b.score - a.score; }).forEach(function (ob) {
        for (var q = 0; q < dobj.length; q++) {   // тот же короб: оси почти совпадают (угол и расстояние от центра до оси другого)
          var d0 = dobj[q].duct, d1 = ob.duct, w0 = sub(ob.center, d0.c), tt = dot(w0, d0.a), perp = len(sub(w0, mul(d0.a, tt)));
          if (angleBetween(d0.a, d1.a) < 9 * DEG && perp < 0.6 * Math.max(d0.rad, d1.rad) + 0.05) return;
        }
        // «короб» внутри настоящей трубы — обрывок подгонки той же трубы, а не воздуховод
        var inPipe = cobj.some(function (cb) { var cc = cb.cylinder, w1 = sub(ob.center, cc.c), t1 = dot(w1, cc.a), pp1 = len(sub(w1, mul(cc.a, t1))); return angleBetween(cc.a, ob.duct.a) < 9 * DEG && pp1 < 0.8 * cc.r && Math.max(ob.duct.w, ob.duct.h) <= 2.6 * cc.r; });
        if (inPipe) return;
        dobj.push(ob);
      });
      // труба, ось которой лежит внутри прямоугольника воздуховода, — обрывок подгонки по его граням, а не отдельная труба
      cobj = cobj.filter(function (cb) {
        var cc = cb.cylinder;
        return !dobj.some(function (db) { var d = db.duct, w1 = sub(cc.c, d.c), t1 = dot(w1, d.a), q = sub(w1, mul(d.a, t1)); return angleBetween(cc.a, d.a) < 9 * DEG && Math.abs(dot(q, d.ex)) <= 0.5 * d.w + 0.01 && Math.abs(dot(q, d.ey)) <= 0.5 * d.h + 0.01; });
      });
      cobj.forEach(function (ob) { objects.push(ob); });
      info.ducts = dobj.length;
      dobj.forEach(function (ob) { objects.push(ob); });
      pipePairs(cobj, cobj).slice(0, 6).forEach(function (ob) { objects.push(ob); });
      pairObjects(ctx, usedPairs).sort(function (a, b) { return b.score - a.score; }).slice(0, 6).forEach(function (ob) { objects.push(ob); });
      // r169: КЛАССИФИКАЦИЯ ВЫДЕЛЕНИЯ — до выбора главного объекта. Раньше тип брался из
      // готовых находок, и цилиндр («Труба Ø…») с максимальным рангом выигрывал у колонны,
      // стены или балки. Теперь по форме облака определяется тип, добавляется типизированный
      // объект с правильными размерами, а ложные цилиндры/проёмы понижаются.
      var classification = null;
      if (!opts.kind) {
        try {
          classification = classifyCore(S, surfaces, ctx, { evidence: { openings: objects.filter(function (ob) { return ob.type === 'opening'; }), cylinders: cobj, ducts: dobj } });
        } catch (ec) { info.clsError = String(ec && ec.message || ec); }
      }
      if (classification) {
        info.classification = {
          type: classification.type, kind: classification.kind,
          shape: classification.object && classification.object.clsShape,
          confidence: +classification.confidence.toFixed(3),
          probabilities: classification.probabilities,
          otherProbability: +classification.otherProbability.toFixed(3),
          hypotheses: classification.hypotheses, title: classification.title,
          ms: classification.info.ms, cylinderValid: classification.info.cylinderValid,
          cylinderRelRms: classification.info.cylinderRelRms
        };
        var clsHyp = classification.hypotheses || [], clsCyl = null, clsOther = null;
        clsHyp.forEach(function (h) {
          if (h.shape === 'cylinder' && (!clsCyl || h.score > clsCyl.score)) clsCyl = h;
          if (h.shape !== 'cylinder' && (!clsOther || h.score > clsOther.score)) clsOther = h;
        });
        // ложная труба: лучшая нецилиндрическая гипотеза заметно сильнее цилиндра
        var cylBadTypes = { wall: 1, column: 1, beam: 1, opening: 1, edge: 1, panel: 1, tray: 1 };
        var cylBad = !!clsOther && cylBadTypes[classification.type] && (!clsCyl || clsOther.score > 1.35 * Math.max(1e-6, clsCyl.score));
        if (cylBad && classification.type !== 'pipe') {
          cobj.forEach(function (ob) {
            ob.clsPenalty = 0.22;
            ob.notes = (ob.notes || []).concat(['Классификатор определил «' + classification.kind + '» (уверенность ' + Math.round(100 * classification.confidence) + '%), а не трубу: подгонка цилиндра — ложная.']);
          });
          info.clsGhosts = cobj.length;
        }
        // ложный проём на гранях колонны/стены: детектор «нашёл дыру» там, где её нет
        if (classification.type !== 'opening' && classification.confidence >= 0.55) {
          objects.forEach(function (ob) { if (ob.type === 'opening' && ob.clsPenalty == null) ob.clsPenalty = 0.5; });
        }
        // типизированный объект классификатора — в находки (он же главный, если уверенно)
        var clsOb = classification.object;
        if (clsOb && classification.confidence >= 0.45) {
          var dup = objects.some(function (ob) { return ob.clsType === classification.type; });
          if (!dup) { clsOb.clsType = classification.type; objects.push(clsOb); }
        }
      }
      // Чьи это размеры. 1) Тип, выбранный человеком, пропускает только свои находки (остальные — «другое в рамке», не главные и не сохраняются).
      // 2) Указанная точка (клик по объекту) поднимает находки рядом с ней и опускает далёкие. 3) Контур объекта — чтобы видеть, что измерено.
      var kind = opts.kind || '', c0 = pre.c0;
      var fpt = opts.focus && opts.focus.length >= 3 && isFinite(opts.focus[0] + opts.focus[1] + opts.focus[2]) ? [opts.focus[0] - c0[0], opts.focus[1] - c0[1], opts.focus[2] - c0[2]] : null;
      var roleSet = {};
      objects.forEach(function (ob) {
        ob.family = familyOf(ob); ob.role = roleOf(ob); ob.onType = matchesKind(ob, kind); roleSet[ob.role] = 1;
        ob.focusDist = fpt ? distToObject(ob, fpt, ctx) : null;
        ob.rank = ob.score * (kind ? (ob.onType ? 3 : 0.7) : 1) * (fpt ? focusFactor(ob.focusDist) : 1) * (ob.clsPenalty || 1);
        try { ob.outline = outlineOf(ob, ctx); } catch (eo) { ob.outline = []; }
      });
      objects.sort(function (a, b) { return ((b.onType ? 1 : 0) - (a.onType ? 1 : 0)) || (b.rank - a.rank); });
      // координаты — обратно в систему облака
      function back(p) { return p ? [p[0] + c0[0], p[1] + c0[1], p[2] + c0[2]] : p; }
      objects.forEach(function (ob, i) {
        ob.id = i; ob.center = back(ob.center); ob.offType = !ob.onType;
        ob.dims.forEach(function (d) { d.a = back(d.a); d.b = back(d.b); d.objectId = i; });
        if (ob.cylinder) { ob.cylinder.c = back(ob.cylinder.c); }
        if (ob.duct) { ob.duct.c = back(ob.duct.c); }
        if (ob.outline) ob.outline = ob.outline.map(back);
        delete ob.raw;
      });
      var main = objects.length && objects[0].onType ? objects[0] : null;
      info.spacing = S.spacing; info.noise = S.noise; info.planes = surfaces.length; info.cylinders = cy.cylinders.length; info.floor = !!floor; info.ms = Date.now() - t0; info.c0 = c0;
      info.seeds = cy.seeds; info.families = cy.families; info.holes = holeObjs.length; info.roles = Object.keys(roleSet);
      var res = { ok: true, objects: objects, main: main, info: info, surfaces: surfaces.length, kind: kind || null };
      res.rejected = rejected.slice(0, 12).map(function (ob) { return { title: ob.title, why: (ob.ghostWhy || []).join('; '), center: back(ob.center) }; });
      if (kind && !main && objects.length) res.noMatch = { kind: kind, found: objects.slice(0, 4).map(function (ob) { return ob.title; }) };
      if (fpt) res.focus = { point: [opts.focus[0], opts.focus[1], opts.focus[2]], distance: main ? main.focusDist : null, far: !!(main && main.focusDist > 0.6) };
      return res;
    } catch (e) {
      return { ok: false, error: 'Автоматический замер не удался: ' + (e && e.message || e), objects: [], info: info, stack: e && e.stack };
    }
  }

  return {
    version: 3, analyze: analyze, classify: classify, toMeasurement: toMeasurement, nearestStandard: nearestStandard, KIND_FAMILY: KIND_FAMILY, KIND_ROLES: KIND_ROLES, roleOf: roleOf, level: level,
    CLS_DEF: CLS_DEF, CLS_PRIOR: CLS_PRIOR,
    _dedupeCylinders: dedupeCylinders, _consensusPipes: consensusPipes, _implausibleCylinders: implausibleCylinders, _hollowStats: hollowStats, _distToObject: distToObject, _floorIsReal: floorIsReal, _outlineOf: outlineOf, _focusFactor: focusFactor,
    _eig3: eig3, _prepare: prepare, _buildGrid: buildGrid, _neighbors: neighbors, _estimateSpacing: estimateSpacing, _localNormals: localNormals, _clusterDirections: clusterDirections,
    _planesFromDirection: planesFromDirection, _mergePlanes: mergePlanes, _fitPlane: fitPlane, _detectSurfaces: detectSurfaces, _splitPatches: splitPatches, _planeBasis: planeBasis,
    _buildSurfaces: buildSurfaces, _pairInfo: pairInfo, _footBasis: footBasis, _findOpenings: findOpenings, _sigmaAt: sigmaAt, _detectHoles: detectHoles,
    _slabSilhouette: slabSilhouette, _holeEdges: holeEdges, _holeOpenings: holeOpenings, _holeObject: holeObject, _guidedJambs: guidedJambs, _fitTilted: fitTilted,
    _detectCylinders: detectCylinders, _fitCylinder3D: fitCylinder3D, _fitCircle2D: fitCircle2D, _slabCircles: slabCircles, _houghPeaks: houghPeaks,
    _openingObject: openingObject, _pairObjects: pairObjects, _cylinderObject: cylinderObject, _pipePairs: pipePairs, _findFloor: findFloor, _alignDeg: alignDeg, _buildingAxes: buildingAxes,
    _classifyCore: classifyCore, _clsPeaks: _clsPeaks, _clsPlaneHyps: _clsPlaneHyps, _clsBoxHyp: _clsBoxHyp, _clsCornerHyp: _clsCornerHyp, _clsCylHyp: _clsCylHyp, _clsProbabilities: _clsProbabilities,
    _clsExtend: _clsExtend, _clsPlaneExtent: _clsPlaneExtent, _clsPt: function (P, i) { return [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]; }, _distPointPatch: function (sf, p) { return distPointPatch(sf, p); }
  };
});
