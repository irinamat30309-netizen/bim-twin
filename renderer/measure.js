/*
 * measure.js — точная математика измерений внутри облака точек.
 * Реализует набор инструментов уровня CloudCompare / Open3D:
 *   • расстояние между двумя точками (3D + ΔX/ΔY/ΔZ + горизонт./вертикаль)
 *   • длина полилинии (ломаной) с накоплением
 *   • угол в вершине (три точки)
 *   • площадь плоского полигона (метод Ньюэлла, корректен для 3D)
 *   • подгонка плоскости МНК/PCA (стена, потолок, пол) + RMS ошибка
 *   • RANSAC-подгонка плоскости (устойчива к выбросам/шуму)
 *   • габариты плоского участка (ориентированный прямоугольник: длина × высота)
 *   • наклон (dip) и ориентация нормали, классификация поверхности
 *   • точка↔плоскость расстояние (толщина, отклонение)
 *
 * Чистые функции, без внешних зависимостей. Экспорт в window.Measure и module.exports (для тестов).
 * Система координат приложения: Y — вертикаль (вверх), как в остальном движке.
 */
(function () {
  'use strict';

  // ---------- базовые векторные операции ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
  const RAD2DEG = 180 / Math.PI;

  // ---------- расстояние между двумя точками с раскладкой по осям ----------
  // Y — вертикаль: горизонтальное расстояние = в плоскости XZ, вертикальное = |ΔY|.
  function distance(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const horizontal = Math.hypot(dx, dz);
    const slope = Math.atan2(dy, horizontal) * RAD2DEG;      // угол к горизонту (со знаком), °
    return {
      d3: Math.hypot(dx, dy, dz),
      dx: dx, dy: dy, dz: dz,
      horizontal: horizontal,
      vertical: Math.abs(dy),
      slope: slope,
      grade: horizontal > 1e-9 ? (dy / horizontal) * 100 : (dy === 0 ? 0 : Infinity) // уклон, %
    };
  }

  // ---------- длина ломаной (полилинии) ----------
  // closed=true добавляет замыкающий сегмент (периметр).
  function polylineLength(pts, closed) {
    if (!pts || pts.length < 2) return { total: 0, segments: [] };
    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const s = dist3(pts[i - 1], pts[i]); segs.push(s); total += s; }
    if (closed && pts.length >= 3) { const s = dist3(pts[pts.length - 1], pts[0]); segs.push(s); total += s; }
    return { total: total, segments: segs };
  }

  // ---------- угол в вершине b между лучами b→a и b→c ----------
  function angleAt(a, b, c) {
    const u = sub(a, b), v = sub(c, b);
    const lu = len(u), lv = len(v);
    if (lu < 1e-12 || lv < 1e-12) return { deg: 0, rad: 0 };
    const cosv = clamp(dot(u, v) / (lu * lv), -1, 1);
    const rad = Math.acos(cosv);
    return { deg: rad * RAD2DEG, rad: rad, lenA: lu, lenC: lv };
  }

  // ---------- Якоби: собственные значения/векторы симметричной матрицы 3×3 ----------
  // Возвращает {values:[...], vectors:[[...],[...],[...]]} отсортированные по убыванию значения.
  function jacobiEigen3(A) {
    // A — [[a00,a01,a02],[a01,a11,a12],[a02,a12,a22]]
    const a = [A[0][0], A[1][1], A[2][2]];
    let a01 = A[0][1], a02 = A[0][2], a12 = A[1][2];
    // матрица собственных векторов (столбцы) — начинаем с единичной
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let iter = 0; iter < 50; iter++) {
      const off = Math.abs(a01) + Math.abs(a02) + Math.abs(a12);
      if (off < 1e-20) break;
      // по очереди обнуляем внедиагональные (p,q): (0,1),(0,2),(1,2)
      const rotate = (p, q, apq, getApq, setApq) => {
        if (Math.abs(apq) < 1e-300) return;
        const app = a[p], aqq = a[q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        // обновляем диагональ
        a[p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        a[q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        setApq(0);
        // обновляем оставшиеся внедиагональные, затронутые p,q
        const r = 3 - p - q; // третий индекс
        let arp, arq;
        if (p === 0 && q === 1) { arp = a02; arq = a12; a02 = c * arp - s * arq; a12 = s * arp + c * arq; }
        else if (p === 0 && q === 2) { arp = a01; arq = a12; a01 = c * arp - s * arq; a12 = s * arp + c * arq; }
        else { arp = a01; arq = a02; a01 = c * arp - s * arq; a02 = s * arp + c * arq; }
        // обновляем собственные векторы (столбцы p,q)
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      };
      rotate(0, 1, a01, () => a01, x => { a01 = x; });
      rotate(0, 2, a02, () => a02, x => { a02 = x; });
      rotate(1, 2, a12, () => a12, x => { a12 = x; });
    }
    const cols = [[V[0][0], V[1][0], V[2][0]], [V[0][1], V[1][1], V[2][1]], [V[0][2], V[1][2], V[2][2]]];
    const items = [{ v: a[0], vec: cols[0] }, { v: a[1], vec: cols[1] }, { v: a[2], vec: cols[2] }];
    items.sort((x, y) => y.v - x.v);
    return { values: items.map(i => i.v), vectors: items.map(i => norm(i.vec)) };
  }

  // ---------- центроид ----------
  function centroid(points) {
    let cx = 0, cy = 0, cz = 0; const n = points.length;
    for (let i = 0; i < n; i++) { cx += points[i][0]; cy += points[i][1]; cz += points[i][2]; }
    return [cx / n, cy / n, cz / n];
  }

  // ---------- подгонка плоскости МНК через PCA (все точки) ----------
  // Плоскость: n·x + d = 0, |n|=1. Нормаль = собственный вектор наименьшего собств. значения
  // ковариационной матрицы. RMS = среднеквадратичное расстояние точек до плоскости.
  function fitPlanePCA(points) {
    const n = points.length;
    if (n < 3) return null;
    const c = centroid(points);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let i = 0; i < n; i++) {
      const px = points[i][0] - c[0], py = points[i][1] - c[1], pz = points[i][2] - c[2];
      xx += px * px; xy += px * py; xz += px * pz; yy += py * py; yz += py * pz; zz += pz * pz;
    }
    xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;
    const eig = jacobiEigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    const normal = eig.vectors[2];         // наименьшее собств. значение → нормаль
    const e1 = eig.vectors[0], e2 = eig.vectors[1]; // главные оси в плоскости
    const d = -dot(normal, c);
    // RMS расстояния до плоскости
    let ss = 0;
    for (let i = 0; i < n; i++) { const dd = dot(normal, points[i]) + d; ss += dd * dd; }
    const rms = Math.sqrt(ss / n);
    return {
      normal: normal, d: d, centroid: c, e1: e1, e2: e2,
      eigenvalues: eig.values, rms: rms, count: n
    };
  }

  // ---------- расстояние точки до плоскости (со знаком) ----------
  function pointPlaneDist(p, plane) { return dot(plane.normal, p) + plane.d; }

  // ---------- RANSAC-подгонка плоскости (устойчива к выбросам) ----------
  // opts: { threshold, iters, minInliers, seed }. threshold — макс. расстояние инлайера (в метрах).
  function ransacPlane(points, opts) {
    opts = opts || {};
    const n = points.length;
    if (n < 3) return null;
    // порог по умолчанию — по масштабу облака (диагональ bbox * 0.004)
    let threshold = opts.threshold;
    if (!(threshold > 0)) {
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = points[i][k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
      const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
      threshold = diag * 0.004;
    }
    const iters = opts.iters || 300;
    // детерминированный ГПСЧ (для воспроизводимости/тестов)
    let s = (opts.seed || 12345) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const ri = () => Math.floor(rnd() * n);
    let best = null, bestCount = -1;
    for (let it = 0; it < iters; it++) {
      const i0 = ri(); let i1 = ri(), i2 = ri();
      if (i1 === i0) i1 = (i1 + 1) % n;
      if (i2 === i0 || i2 === i1) i2 = (i2 + 2) % n;
      const a = points[i0], b = points[i1], c = points[i2];
      const nrm = cross(sub(b, a), sub(c, a));
      const l = len(nrm);
      if (l < 1e-9) continue; // вырожденная тройка
      const N = [nrm[0] / l, nrm[1] / l, nrm[2] / l];
      const dd = -dot(N, a);
      let cnt = 0;
      for (let i = 0; i < n; i++) { const e = N[0] * points[i][0] + N[1] * points[i][1] + N[2] * points[i][2] + dd; if (e < 0 ? -e < threshold : e < threshold) cnt++; }
      if (cnt > bestCount) { bestCount = cnt; best = { normal: N, d: dd }; }
    }
    if (!best) return null;
    // собираем инлайеры лучшей модели и уточняем плоскость через PCA
    const inliers = [];
    for (let i = 0; i < n; i++) { const e = pointPlaneDist(points[i], best); if (Math.abs(e) < threshold) inliers.push(points[i]); }
    let refined = fitPlanePCA(inliers.length >= 3 ? inliers : points);
    // Второй проход: пересобираем инлайеры по уточнённой плоскости и дообучаем — устойчивее к шуму.
    let inl2 = [];
    for (let i = 0; i < n; i++) { if (Math.abs(pointPlaneDist(points[i], refined)) < threshold) inl2.push(points[i]); }
    if (inl2.length >= 3 && inl2.length >= inliers.length) refined = fitPlanePCA(inl2);
    else inl2 = inliers;
    // Медианная ошибка инлайеров — робастная оценка качества подгонки.
    const errs = inl2.map(function (p) { return Math.abs(pointPlaneDist(p, refined)); }).sort(function (x, y) { return x - y; });
    refined.inlierCount = inl2.length;
    refined.total = n;
    refined.coverage = inl2.length / n;
    refined.threshold = threshold;
    refined.medianError = errs.length ? errs[errs.length >> 1] : 0;
    refined.inliers = inl2;
    return refined;
  }

  // ---------- собственные значения/векторы симметричной 2×2 (для габаритов) ----------
  function eigen2(a, b, c) { // [[a,b],[b,c]]
    const tr = a + c, det = a * c - b * b;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    let v1;
    if (Math.abs(b) > 1e-15) v1 = norm2([l1 - c, b]);
    else v1 = (a >= c) ? [1, 0] : [0, 1];
    const v2 = [-v1[1], v1[0]];
    return { l1, l2, v1, v2 };
  }
  const norm2 = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

  // два единичных вектора в плоскости с нормалью n (для плоскостей без e1/e2 — из PrecisionSnap)
  function planeBasis(n) {
    const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = norm(cross(a, n)), e2 = norm(cross(n, e1));
    return [e1, e2];
  }
  // ---------- ориентированные габариты плоского участка (длина × высота) ----------
  // Проецируем точки на плоскость, ищем главные оси в плоскости (2D PCA) → размеры
  // ориентированного прямоугольника. Для стены = длина × высота, площадь охвата.
  // points — массив [x,y,z] ИЛИ { pos: Float32Array|Float64Array, ids: Int32Array } (индексы точек облака: без копий, для сотен тысяч точек)
  // Угол оси «1» ориентированного прямоугольника МИНИМАЛЬНОЙ площади вокруг точек (u,v). Главные оси (PCA) у плоскостей с вырезами
  // (колонна в полу, проём в стене) разворачиваются на несколько миллирадиан — габариты пола 6×4 м выходили 6,04×4,06. Рамка минимальной
  // площади ложится на сами кромки. Кандидаты — экстремумы по корзинам вдоль u и v (≤ 4·B точек), угол — перебор 0…90° и уточнение.
  function minAreaAngle(US, VS, N, th0) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < N; i++) { const a = US[i], b = VS[i]; if (a < u0) u0 = a; if (a > u1) u1 = a; if (b < v0) v0 = b; if (b > v1) v1 = b; }
    const du = u1 - u0, dv = v1 - v0;
    if (!(du > 0) || !(dv > 0) || N < 4) return th0;
    const B = 1024, ku = (B - 1e-6) / du, kv = (B - 1e-6) / dv;
    const aLo = new Float64Array(B).fill(Infinity), aHi = new Float64Array(B).fill(-Infinity), aLoU = new Float64Array(B), aHiU = new Float64Array(B);
    const bLo = new Float64Array(B).fill(Infinity), bHi = new Float64Array(B).fill(-Infinity), bLoV = new Float64Array(B), bHiV = new Float64Array(B);
    for (let i = 0; i < N; i++) {
      const a = US[i], b = VS[i], ia = ((a - u0) * ku) | 0, ib = ((b - v0) * kv) | 0;
      if (b < aLo[ia]) { aLo[ia] = b; aLoU[ia] = a; } if (b > aHi[ia]) { aHi[ia] = b; aHiU[ia] = a; }
      if (a < bLo[ib]) { bLo[ib] = a; bLoV[ib] = b; } if (a > bHi[ib]) { bHi[ib] = a; bHiV[ib] = b; }
    }
    const cx = [], cy = [];
    for (let k = 0; k < B; k++) {
      if (aLo[k] !== Infinity) { cx.push(aLoU[k], aHiU[k]); cy.push(aLo[k], aHi[k]); }
      if (bLo[k] !== Infinity) { cx.push(bLo[k], bHi[k]); cy.push(bLoV[k], bHiV[k]); }
    }
    const M = cx.length;
    const area = (th) => {
      const c = Math.cos(th), s = Math.sin(th); let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (let i = 0; i < M; i++) { const p = cx[i] * c + cy[i] * s, q = -cx[i] * s + cy[i] * c; if (p < p0) p0 = p; if (p > p1) p1 = p; if (q < q0) q0 = q; if (q > q1) q1 = q; }
      return (p1 - p0) * (q1 - q0);
    };
    const H = Math.PI / 2; let best = th0, ba = area(th0);
    const NS = 180; for (let k = 0; k < NS; k++) { const th = k * H / NS, a = area(th); if (a < ba - 1e-12) { ba = a; best = th; } }
    for (let pass = 0, st = H / NS; pass < 3; pass++, st /= 10) { const c0 = best; for (let k = -10; k <= 10; k++) { const th = c0 + k * st / 10, a = area(th); if (a < ba - 1e-12) { ba = a; best = th; } } }
    return best;
  }

  // Узкие «усы» вдоль кромок. К плоскости стены/колонны у стыка попадают точки соседнего пола или потолка, лежащие в её допуске (полоса
  // шириной 1–2 шага), и габариты вырастают на ячейку-две. Морфологическое раскрытие маски занятости (ячейки ≈ 4 шага, элемент 3×3)
  // убирает всё, что тоньше ≈ 12 шагов, и не трогает кромки настоящей поверхности. Возвращает Uint8Array «оставить точку» или null.
  function spurMask(A, Bv, N, res) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < N; i++) { const a = A[i], b = Bv[i]; if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; }
    if (!(a1 > a0) || !(b1 > b0) || !(res > 0)) return null;
    let gw = Math.floor((a1 - a0) / res) + 3, gh = Math.floor((b1 - b0) / res) + 3;
    if (gw * gh > 4e6) { res *= Math.sqrt(gw * gh / 4e6); gw = Math.floor((a1 - a0) / res) + 3; gh = Math.floor((b1 - b0) / res) + 3; }
    const occ = new Uint8Array(gw * gh), inv = 1 / res;
    const cell = new Int32Array(N);
    for (let i = 0; i < N; i++) { const c = (((Bv[i] - b0) * inv) | 0) * gw + (((A[i] - a0) * inv) | 0) + gw + 1; cell[i] = c; occ[c] = 1; }
    const er = new Uint8Array(gw * gh);
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const c = y * gw + x;
      if (occ[c] && occ[c - 1] && occ[c + 1] && occ[c - gw] && occ[c + gw] && occ[c - gw - 1] && occ[c - gw + 1] && occ[c + gw - 1] && occ[c + gw + 1]) er[c] = 1;
    }
    const op = new Uint8Array(gw * gh);
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const c = y * gw + x;
      if (er[c]) { op[c] = op[c - 1] = op[c + 1] = op[c - gw] = op[c + gw] = op[c - gw - 1] = op[c - gw + 1] = op[c + gw - 1] = op[c + gw + 1] = 1; }
    }
    const keep = new Uint8Array(N); let kept = 0;
    for (let i = 0; i < N; i++) if (op[cell[i]]) { keep[i] = 1; kept++; }
    return kept >= 8 && kept >= 0.7 * N ? keep : null;
  }

  function planeExtents(points, plane) {
    const c = plane.centroid;
    // базис в плоскости: предпочитаем «горизонтальную» ось для наглядных стен
    let u = plane.e1, v = plane.e2;
    if (!u || !v) { const bs = planeBasis(plane.normal); u = bs[0]; v = bs[1]; }
    let N, X, Y, Z;
    if (points && points.pos && points.ids) {
      const P = points.pos, ids = points.ids; N = ids.length;
      X = i => P[ids[i] * 3]; Y = i => P[ids[i] * 3 + 1]; Z = i => P[ids[i] * 3 + 2];
    } else { N = points.length; X = i => points[i][0]; Y = i => points[i][1]; Z = i => points[i][2]; }
    // проекция на (u,v)
    const US = new Float64Array(N), VS = new Float64Array(N);
    let su = 0, sv = 0;
    for (let i = 0; i < N; i++) {
      const px = X(i) - c[0], py = Y(i) - c[1], pz = Z(i) - c[2];
      const cu = px * u[0] + py * u[1] + pz * u[2], cv = px * v[0] + py * v[1] + pz * v[2];
      US[i] = cu; VS[i] = cv; su += cu; sv += cv;
    }
    su /= N; sv /= N;
    let cuu = 0, cuv = 0, cvv = 0;
    for (let i = 0; i < N; i++) { const du = US[i] - su, dv = VS[i] - sv; cuu += du * du; cuv += du * dv; cvv += dv * dv; }
    cuu /= N; cuv /= N; cvv /= N;
    const e0 = eigen2(cuu, cuv, cvv);
    // ориентация: рамка минимальной площади (не PCA); «усы» вдоль кромок отсекаются маской занятости
    const th = minAreaAngle(US, VS, N, Math.atan2(e0.v1[1], e0.v1[0]));
    const ct = Math.cos(th), st = Math.sin(th);
    const A1 = new Float64Array(N), A2 = new Float64Array(N);
    for (let i = 0; i < N; i++) { A1[i] = US[i] * ct + VS[i] * st; A2[i] = -US[i] * st + VS[i] * ct; }
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < N; i++) { if (A1[i] < a0) a0 = A1[i]; if (A1[i] > a1) a1 = A1[i]; if (A2[i] < b0) b0 = A2[i]; if (A2[i] > b1) b1 = A2[i]; }
    const sp = (plane.spacing > 0) ? plane.spacing : Math.sqrt(Math.max(1e-12, (a1 - a0) * (b1 - b0)) / Math.max(1, N));
    const keep = N >= 64 ? spurMask(A1, A2, N, 4 * sp) : null;
    // проекция на оси рамки → мин/макс → размеры
    let a1mn = Infinity, a1mx = -Infinity, a2mn = Infinity, a2mx = -Infinity;
    for (let i = 0; i < N; i++) {
      if (keep && !keep[i]) continue;
      const p1 = A1[i], p2 = A2[i];
      if (p1 < a1mn) a1mn = p1; if (p1 > a1mx) a1mx = p1;
      if (p2 < a2mn) a2mn = p2; if (p2 > a2mx) a2mx = p2;
    }
    // ось 1 — длинная сторона
    const swap = (a2mx - a2mn) > (a1mx - a1mn);
    const e = swap ? { v1: [-st, ct], v2: [-ct, -st] } : { v1: [ct, st], v2: [-st, ct] };
    if (swap) { const o1n = a1mn, o1x = a1mx, o2n = a2mn, o2x = a2mx; a1mn = o2n; a1mx = o2x; a2mn = -o1x; a2mx = -o1n; }
    // (a1mn…a1mx) — вдоль e.v1, (a2mn…a2mx) — вдоль e.v2; координаты (u,v) отсчитаны от центроида плоскости c
    const size1 = a1mx - a1mn, size2 = a2mx - a2mn;
    const m1 = (a1mn + a1mx) / 2, m2 = (a2mn + a2mx) / 2;
    // центр ориентированного прямоугольника в uv → в 3D
    const cU = e.v1[0] * m1 + e.v2[0] * m2;
    const cV = e.v1[1] * m1 + e.v2[1] * m2;
    const center3 = add(add(c, scale(u, cU)), scale(v, cV));
    // главные оси в 3D
    const axis1 = norm(add(scale(u, e.v1[0]), scale(v, e.v1[1])));
    const axis2 = norm(add(scale(u, e.v2[0]), scale(v, e.v2[1])));
    // Гравитационно-выровненные габариты стены: ширина по горизонту × высота (как в FARO/CloudCompare).
    const up = [0, 1, 0];
    let hAxis = cross(plane.normal, up);
    const hLen = len(hAxis);
    let hSpan = null, vSpan = null;
    const tiltDeg = Math.acos(clamp(Math.abs(plane.normal[1]), 0, 1)) * RAD2DEG;
    const isWall = tiltDeg > 60, isFloor = tiltDeg < 30;
    if (hLen > 1e-6) {
      hAxis = [hAxis[0] / hLen, hAxis[1] / hLen, hAxis[2] / hLen];
      const vAx = norm(cross(plane.normal, hAxis)); // ~вертикаль в плоскости стены
      let h0 = Infinity, h1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < N; i++) {
        if (keep && !keep[i]) continue;
        const px = X(i) - c[0], py = Y(i) - c[1], pz = Z(i) - c[2];
        const ph = px * hAxis[0] + py * hAxis[1] + pz * hAxis[2], pv = px * vAx[0] + py * vAx[1] + pz * vAx[2];
        if (ph < h0) h0 = ph; if (ph > h1) h1 = ph;
        if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
      }
      hSpan = h1 - h0; vSpan = v1 - v0;
    }
    return {
      length: Math.max(size1, size2),
      width: Math.min(size1, size2),
      rectArea: size1 * size2,
      center3: center3, axis1: axis1, size1: size1, axis2: axis2, size2: size2,
      hSpan: hSpan, vSpan: vSpan, tiltDeg: tiltDeg, isWall: isWall, isFloor: isFloor
    };
  }

  // ---------- площадь плоского полигона в 3D (метод Ньюэлла) ----------
  // Корректно для любого плоского многоугольника, ориентированного в пространстве.
  function polygonArea3D(pts) {
    if (!pts || pts.length < 3) return { area: 0, normal: [0, 1, 0], perimeter: 0 };
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], nxt = pts[(i + 1) % pts.length];
      nx += (cur[1] - nxt[1]) * (cur[2] + nxt[2]);
      ny += (cur[2] - nxt[2]) * (cur[0] + nxt[0]);
      nz += (cur[0] - nxt[0]) * (cur[1] + nxt[1]);
    }
    const area = 0.5 * Math.hypot(nx, ny, nz);
    const per = polylineLength(pts, true).total;
    return { area: area, normal: norm([nx, ny, nz]), perimeter: per };
  }

  // ---------- наклон и ориентация нормали (Y — вертикаль) ----------
  // dip: угол плоскости от горизонтали (0° = горизонтальная, 90° = вертикальная).
  // dipDir/azimuth: направление в плане (0..360°, 0 = +Z, по часовой к +X).
  function orientation(normal) {
    const ny = clamp(Math.abs(normal[1]), 0, 1);
    const dip = Math.acos(ny) * RAD2DEG; // 0 — горизонталь, 90 — вертикаль
    let az = Math.atan2(normal[0], normal[2]) * RAD2DEG;
    if (az < 0) az += 360;
    let kind;
    if (dip < 12) kind = 'горизонтальная (пол/потолок)';
    else if (dip > 78) kind = 'вертикальная (стена)';
    else kind = 'наклонная';
    return {
      dip: dip, azimuth: az, kind: kind,
      verticality: 90 - dip,                 // отклонение стены от вертикали, °
      levelness: dip,                        // отклонение пола/потолка от горизонтали, °
      slopePercent: Math.tan(dip / RAD2DEG) * 100
    };
  }

  // ---------- форматирование длины (м / см / мм) ----------
  function fmtLen(m) {
    const a = Math.abs(m);
    if (a < 0.01) return (m * 1000).toFixed(1) + ' мм';
    if (a < 1) return (m * 100).toFixed(1) + ' см';
    return m.toFixed(3) + ' м';
  }
  function fmtArea(m2) {
    const a = Math.abs(m2);
    if (a < 0.01) return (m2 * 10000).toFixed(1) + ' см²';
    return m2.toFixed(3) + ' м²';
  }

  // ---------- подгонка прямой (ребра) через PCA ----------
  // Линия: точка c (центроид) + направление dir (единичное). Возвращает rms поперечного отклонения.
  function fitLinePCA(points) {
    const n = points.length;
    if (n < 2) return null;
    const c = centroid(points);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let i = 0; i < n; i++) {
      const px = points[i][0] - c[0], py = points[i][1] - c[1], pz = points[i][2] - c[2];
      xx += px * px; xy += px * py; xz += px * pz; yy += py * py; yz += py * pz; zz += pz * pz;
    }
    xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;
    const eig = jacobiEigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    const dir = eig.vectors[0]; // наибольшее собств. значение = направление линии
    let ss = 0;
    for (let i = 0; i < n; i++) { const w = sub(points[i], c); const t = dot(w, dir); const perp = sub(w, scale(dir, t)); ss += dot(perp, perp); }
    return { centroid: c, dir: dir, eigenvalues: eig.values, rms: Math.sqrt(ss / n), count: n };
  }

  // ---------- классификация локальной геометрии (по признакам ковариации) ----------
  // Признаки Вайнманна: linearity=(λ0−λ1)/λ0, planarity=(λ1−λ2)/λ0, scattering=λ2/λ0.
  // kind: 'corner' | 'edge' | 'plane' | 'undefined'.
  function classifyLocal(points) {
    const n = points.length;
    if (n < 3) return { kind: 'undefined', linearity: 0, planarity: 0, scattering: 1, eigenvalues: [0, 0, 0] };
    const c = centroid(points);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let i = 0; i < n; i++) {
      const px = points[i][0] - c[0], py = points[i][1] - c[1], pz = points[i][2] - c[2];
      xx += px * px; xy += px * py; xz += px * pz; yy += py * py; yz += py * pz; zz += pz * pz;
    }
    xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;
    const eig = jacobiEigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    const l0 = Math.max(eig.values[0], 1e-20), l1 = eig.values[1], l2 = eig.values[2];
    const linearity = (l0 - l1) / l0;
    const planarity = (l1 - l2) / l0;
    const scattering = l2 / l0;
    let kind;
    if (scattering > 0.10) kind = 'corner';        // все три оси заметны → угол/стык
    else if (linearity > 0.55) kind = 'edge';      // одна ось доминирует → ребро
    else if (planarity > 0.30) kind = 'plane';     // две оси → плоскость
    else kind = 'plane';
    return { kind: kind, linearity: linearity, planarity: planarity, scattering: scattering, eigenvalues: eig.values, centroid: c, vectors: eig.vectors };
  }

  // ---------- привязка (snap) точки клика к ребру/углу/плоскости ----------
  // Даёт уточнённую позицию: на ребре — проекция на линию, на плоскости — проекция на плоскость,
  // в углу — ближайшая реальная точка скана (углы хорошо заданы измерениями).
  // Возвращает { point:[x,y,z], kind, refined:bool }.
  function snapToFeature(seed, points) {
    if (!points || points.length < 3) return { point: seed.slice ? seed.slice() : [seed[0], seed[1], seed[2]], kind: 'raw', refined: false };
    const cls = classifyLocal(points);
    if (cls.kind === 'edge') {
      const line = fitLinePCA(points);
      if (line) { const w = sub(seed, line.centroid); const t = dot(w, line.dir); const p = add(line.centroid, scale(line.dir, t)); return { point: p, kind: 'edge', refined: true, dir: line.dir, rms: line.rms }; }
    } else if (cls.kind === 'corner') {
      // ближайшая реальная точка скана к клику
      let bi = 0, bd = Infinity;
      for (let i = 0; i < points.length; i++) { const d = dist3(seed, points[i]); if (d < bd) { bd = d; bi = i; } }
      return { point: points[bi].slice(), kind: 'corner', refined: true };
    } else {
      const pl = fitPlanePCA(points);
      if (pl) { const e = pointPlaneDist(seed, pl); const p = sub(seed, scale(pl.normal, e)); return { point: p, kind: 'plane', refined: true, normal: pl.normal, rms: pl.rms }; }
    }
    return { point: seed.slice ? seed.slice() : [seed[0], seed[1], seed[2]], kind: 'raw', refined: false };
  }

  // ---------- измерение «точка → плоскость» (зазор / отклонение поверхности) ----------
  // Знак: >0 — точка со стороны нормали плоскости, <0 — с обратной стороны.
  // Возвращает расстояние, знак, точку проекции на плоскость и вектор от проекции к точке.
  function signedPointPlane(p, plane) {
    const e = pointPlaneDist(p, plane);        // расстояние со знаком
    const foot = sub(p, scale(plane.normal, e)); // основание перпендикуляра на плоскости
    return { distance: Math.abs(e), signed: e, sign: e >= 0 ? 1 : -1, foot: foot, normal: plane.normal.slice() };
  }

  // ---------- сериализация измерения в строку CSV ----------
  function measureToCsvRow(res, idx) {
    const f = v => (v === undefined || v === null) ? '' : (typeof v === 'number' ? v.toFixed(4) : String(v));
    const j = arr => arr ? arr.map(v => v.toFixed(4)).join(' ') : '';
    const r = res || {};
    let value = '', extra = '';
    switch (r.mode) {
      case 'point': value = j(r.point); break;
      case 'distance': {
        // в таблицу идёт то же число, что в окне результата: между плоскостями / рёбрами — по перпендикуляру, труба — диаметр (раньше всегда уходила длина отрезка, и сдвиг вдоль стен её завышал)
        const hl = r.perp != null && (r.perpKind === 'planes' || r.perpKind === 'edges' || r.perpKind === 'pipe' || r.perpKind === 'pipes');
        value = f(hl ? r.perp : r.d3);
        extra = (hl ? 'вид=' + ({ planes: 'между плоскостями', edges: 'между рёбрами', pipe: 'диаметр трубы', pipes: 'между осями труб' })[r.perpKind] + '; d3=' + f(r.d3) + '; ' : '') + 'гориз=' + f(r.horizontal) + '; верт=' + f(r.vertical) + '; dXYZ=' + f(r.dx) + ',' + f(r.dy) + ',' + f(r.dz);
        break;
      }
      case 'diameter': value = f(r.diameter); extra = 'радиус=' + f(r.radius) + '; ось=' + j(r.axis) + (r.sigma != null ? '; sigma_мм=' + f(r.sigma * 1000) : '') + '; RMS_мм=' + f((r.rms || 0) * 1000) + '; точек=' + f(r.count); break;
      case 'polyline': value = f(r.total); extra = 'точек=' + f(r.count); break;
      case 'angle': value = f(r.deg) + '°'; extra = 'стороны=' + f(r.lenA) + ',' + f(r.lenC); break;
      case 'area': value = f(r.area); extra = 'периметр=' + f(r.perimeter) + '; вершин=' + f(r.count); break;
      case 'plane': value = f(r.length) + '×' + f(r.width); extra = 'наклон=' + f(r.dip) + '°; RMS_мм=' + f((r.rms || 0) * 1000) + '; ' + f(r.kind); break;
      case 'deviation': value = f(r.signed); extra = 'зазор_мм=' + f((r.signed || 0) * 1000) + '; ' + (r.sign >= 0 ? 'перед плоскостью' : 'за плоскостью'); break;
      case 'corner': value = (r.angleDeg != null ? f(r.angleDeg) + '°' : ''); extra = (r.corner ? 'угол_xyz=' + j(r.corner) + '; ' : '') + (r.dir ? 'ребро_dir=' + j(r.dir) + '; ' : '') + 'плоскостей=' + f(r.planeCount || 0); break;
      default: value = '';
    }
    const unit = (r.mode === 'area') ? 'м²' : (r.mode === 'angle' || r.mode === 'corner') ? '°' : (r.mode === 'point') ? 'м(xyz)' : 'м';
    return [f(idx), r.mode || '', value, unit, r.label || '', extra].map(csvCell).join(',');
  }
  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function measurementsToCsv(list) {
    const head = ['#', 'тип', 'значение', 'ед', 'подпись', 'детали'].join(',');
    const rows = (list || []).map((m, i) => measureToCsvRow(m, i + 1));
    return [head].concat(rows).join('\n');
  }

  // Машиночитаемый отчёт Stage 8. Не выводит абсолютные пути и явно оставляет
  // CRS/единицы/допуски пустыми, если источник их не предоставил.
  function createMeasurementReport(list, meta) {
    meta = meta || {};
    const project = meta.project || {};
    const source = meta.source || {};
    const cr = meta.coordinateReference || {};
    const toleranceInput = meta.tolerances || {};
    const textOrNull = v => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    const countOrNull = v => (Number.isSafeInteger(v) && v >= 0) ? v : null;
    const optionalLimit = v => {
      if (v == null || (typeof v === 'string' && !v.trim())) return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const cloneOrNull = v => {
      if (v == null) return null;
      try { return JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
    };
    const stamp = Date.parse(meta.generatedAt);
    const measurementCopy = Array.isArray(list) ? cloneOrNull(list) : [];
    const measurements = Array.isArray(measurementCopy) ? measurementCopy : [];
    const linearTolerance = optionalLimit(toleranceInput.linear);
    const angularTolerance = optionalLimit(toleranceInput.angular);
    const hasTolerance = linearTolerance != null || angularTolerance != null;
    return {
      schema: 'bim-twin.measurement-report.v1',
      generatedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : new Date().toISOString(),
      project: {
        id: textOrNull(project.id),
        name: textOrNull(project.name),
        room: textOrNull(project.room)
      },
      source: {
        name: textOrNull(source.name),
        format: textOrNull(source.format),
        pointCount: countOrNull(source.pointCount),
        loadedPointCount: countOrNull(source.loadedPointCount)
      },
      method: {
        id: 'interactive-viewer-measurements',
        description: 'Сохранённые результаты инструментов измерения BIM Twin; подробности метода и исходные точки приведены в каждой записи.'
      },
      coordinateReference: {
        frame: textOrNull(cr.frame) || 'viewer',
        crsWkt: textOrNull(cr.crsWkt),
        units: textOrNull(cr.units),
        sourceTransform: cloneOrNull(cr.sourceTransform),
        status: textOrNull(cr.crsWkt) && textOrNull(cr.units) ? 'provided' : 'incomplete_or_not_provided'
      },
      tolerances: {
        status: hasTolerance ? 'declared_by_operator' : 'not_provided',
        linear: linearTolerance,
        linearUnits: linearTolerance == null ? null : (textOrNull(toleranceInput.units) || textOrNull(cr.units)),
        angular: angularTolerance,
        angularUnits: angularTolerance == null ? null : 'deg',
        evaluationStatus: 'not_evaluated'
      },
      author: textOrNull(meta.author),
      measurementCount: measurements.length,
      measurements: measurements
    };
  }

  // Русское название режима измерения.
  // Плоскостность (ровность) участка стены/пола: RMS + размах «пик-впадина».
  function flatness(points, plane) {
    if (!points || !points.length || !plane) return { rms: 0, peak: 0, valley: 0, pv: 0, count: 0 };
    let ss = 0, peak = -Infinity, valley = Infinity;
    for (let i = 0; i < points.length; i++) {
      const e = pointPlaneDist(points[i], plane);
      ss += e * e; if (e > peak) peak = e; if (e < valley) valley = e;
    }
    const n = points.length;
    return { rms: Math.sqrt(ss / n), peak: peak, valley: valley, pv: peak - valley, count: n };
  }

  const MODE_RU = { point: 'Точка', distance: 'Расстояние', polyline: 'Полилиния', angle: 'Угол', area: 'Площадь', plane: 'Плоскость', deviation: 'Зазор', corner: 'Ребро/Угол', diameter: 'Диаметр' };
  // Краткое человекочитаемое значение измерения (без HTML) — для Markdown/Notion.
  // Автоматический замер (renderer/auto-measure.js): одно значение с названием, погрешностью ±σ, способом и уровнем уверенности.
  const AUTO_LEVEL_RU = { high: 'высокая', medium: 'средняя', low: 'низкая' };
  function autoNum(v, d) { return (+v).toFixed(d).replace('.', ','); }
  function autoValue(au) {
    if (!au) return '';
    if (au.dimension === 'slope') return autoNum(au.value, 2) + ' %';
    const v = +au.value;
    return Math.abs(v) >= 1 ? autoNum(v, 3) + ' м' : autoNum(v * 1000, Math.abs(v) < 0.1 ? 1 : 0) + ' мм';
  }
  function autoSigma(au) {
    if (!au || !(au.sigma > 0)) return '';
    return ' \u00b1' + (au.dimension === 'slope' ? autoNum(au.sigma, 2) + ' %' : autoNum(au.sigma * 1000, au.sigma * 1000 < 10 ? 1 : 0) + ' мм');
  }
  function autoValueText(au) {
    if (!au) return '';
    return (au.label || 'Размер') + ' ' + autoValue(au) + autoSigma(au) + ' · ' + (au.how || '') + ' · уверенность: ' + (AUTO_LEVEL_RU[au.level] || au.level || '—');
  }
  function measureValueText(r) {
    if (!r) return '';
    if (r.mode === 'distance' && r.auto && typeof r.auto === 'object') return autoValueText(r.auto);
    const L = fmtLen, A = fmtArea, n = x => (x == null ? '' : (+x).toFixed(3));
    switch (r.mode) {
      case 'point': return 'X ' + n(r.point[0]) + ', Y ' + n(r.point[1]) + ', Z ' + n(r.point[2]) + ' м';
      case 'distance':
        if (r.perp != null && r.perpKind === 'pipe') return 'Ø ' + L(r.perp) + ' (диаметр трубы; отрезок ' + L(r.d3) + ')';
        if (r.perp != null && r.perpKind === 'pipes') return L(r.perp) + ' между осями труб' + (r.gap != null ? ' (зазор ' + L(Math.max(0, r.gap)) + ')' : '');
        return L(r.d3) + ' (гор. ' + L(r.horizontal) + ', верт. ' + L(r.vertical) + ')' + (r.perp != null ? ', ⊥ ' + L(r.perp) + (r.perpKind === 'edges' ? ' между рёбрами' : r.perpKind === 'planes' ? ' между плоскостями' : ' до плоскости') : '');
      case 'diameter': return 'Ø ' + L(r.diameter) + ' (радиус ' + L(r.radius) + ')';
      case 'polyline': return L(r.total) + ' (точек ' + r.count + ')';
      case 'angle': return (r.deg != null ? r.deg.toFixed(2) : '') + '°';
      case 'area': return A(r.area) + ' (периметр ' + L(r.perimeter) + ')';
      case 'plane': return L(r.length) + ' × ' + L(r.width) + ' (' + r.kind + ', наклон ' + (r.dip != null ? r.dip.toFixed(1) : '') + '°)';
      case 'deviation': return (r.sign >= 0 ? '+' : '−') + L(r.distance) + ' (' + (r.sign >= 0 ? 'перед плоскостью' : 'за плоскостью') + ')';
      case 'corner': return (r.angleDeg != null ? '∠ ' + r.angleDeg.toFixed(1) + '°' : '') + (r.corner ? ' · угол (' + n(r.corner[0]) + ', ' + n(r.corner[1]) + ', ' + n(r.corner[2]) + ')' : '');
      default: return '';
    }
  }
  // Markdown-таблица измерений, готовая для вставки в Notion.
  function measurementsToMarkdown(list, title) {
    const esc = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const head = '| # | Тип | Значение | Подпись |\n|---|---|---|---|';
    const rows = (list || []).map((m, i) => '| ' + (i + 1) + ' | ' + esc(MODE_RU[m.mode] || m.mode) + ' | ' + esc(measureValueText(m)) + ' | ' + esc(m.label || '') + ' |');
    const header = title ? ('## ' + title + '\n\n') : '';
    return header + [head].concat(rows).join('\n') + '\n';
  }

  // Двугранный угол между двумя плоскостями (0..90°, без учёта направления нормалей).
  function angleBetweenPlanes(a, b) {
    const na = norm(a.normal), nb = norm(b.normal);
    let c = Math.abs(dot(na, nb)); c = c > 1 ? 1 : c < -1 ? -1 : c;
    return { deg: Math.acos(c) * RAD2DEG, cos: c };
  }

  // Пересечение двух плоскостей → прямая (точка + направление). null если плоскости параллельны.
  // Формат плоскости: normal·x + d = 0  ⇒  normal·x = -d.
  function intersectPlanes(a, b) {
    const n1 = a.normal, n2 = b.normal;
    const u = cross(n1, n2);
    const uu = dot(u, u);
    if (uu < 1e-14) return null; // параллельны
    const c1 = -a.d, c2 = -b.d; // правые части n·x = c
    // p0 = ( c1 (n2×u) + c2 (u×n1) ) / (u·u)
    const p0 = scale(add(scale(cross(n2, u), c1), scale(cross(u, n1), c2)), 1 / uu);
    return { point: p0, dir: norm(u) };
  }

  // Пересечение трёх плоскостей → точка (точный угол комнаты). null если система вырождена.
  // Правило Крамера для [n1;n2;n3] x = [c1;c2;c3].
  function intersectThreePlanes(a, b, c) {
    const n1 = a.normal, n2 = b.normal, n3 = c.normal;
    const det = dot(n1, cross(n2, n3));
    if (Math.abs(det) < 1e-12) return null;
    const c1 = -a.d, c2 = -b.d, c3 = -c.d;
    // x = ( c1 (n2×n3) + c2 (n3×n1) + c3 (n1×n2) ) / det
    const p = scale(add(add(scale(cross(n2, n3), c1), scale(cross(n3, n1), c2)), scale(cross(n1, n2), c3)), 1 / det);
    return { point: p, det: det };
  }

  // ---------- калибровка масштаба / единиц (по эталонному отрезку) ----------
  // k = эталон / измеренное. Возвращает коэффициент, отклонение в ppm и поправку.
  function calibrate(measured, known) {
    const m = +measured, k = +known;
    if (!isFinite(m) || !isFinite(k) || m <= 0 || k <= 0)
      return { ok: false, scale: 1, ppm: 0, delta: 0, measured: m, known: k };
    const s = k / m;
    return { ok: true, scale: s, ppm: (s - 1) * 1e6, delta: k - m, measured: m, known: k };
  }

  // Применить коэффициент масштаба k к результату измерения (возвращает НОВЫЙ объект).
  // Длины × k, площади × k², углы без изменений.
  function scaleMeasurement(res, k) {
    if (!res) return res;
    const f = +k; if (!isFinite(f) || f <= 0) return Object.assign({}, res);
    const L = v => (typeof v === 'number' ? v * f : v);
    const L2 = v => (typeof v === 'number' ? v * f * f : v);
    const out = Object.assign({}, res, { calibScale: f });
    switch (res.mode) {
      case 'distance':
        out.d3 = L(res.d3); out.dx = L(res.dx); out.dy = L(res.dy); out.dz = L(res.dz);
        out.horizontal = L(res.horizontal); out.vertical = L(res.vertical);
        out.perp = L(res.perp); out.along = L(res.along); out.gap = L(res.gap); out.diameter = L(res.diameter); break;
      case 'diameter':
        out.diameter = L(res.diameter); out.radius = L(res.radius); out.sigma = L(res.sigma); out.rms = L(res.rms); break;
      case 'polyline':
        out.total = L(res.total);
        if (Array.isArray(res.segments)) out.segments = res.segments.map(L); break;
      case 'area':
        out.area = L2(res.area); out.perimeter = L(res.perimeter); break;
      case 'plane':
        out.length = L(res.length); out.width = L(res.width); out.rectArea = L2(res.rectArea);
        out.rms = L(res.rms); out.size1 = L(res.size1); out.size2 = L(res.size2); break;
      case 'deviation':
        out.distance = L(res.distance); out.signed = L(res.signed); break;
      default: break;
    }
    return out;
  }

  // ---------- подпись-выноска с координатами точки ----------
  // order: 'engine' (по умолч., Y — вверх) или 'survey' (геодезический: X, Y=план, Z=высота):
  //   survey.X = engine.X, survey.Y = -engine.Z, survey.Z = engine.Y.
  function coordLabel(p, opts) {
    opts = opts || {};
    const digits = (opts.digits == null) ? 3 : opts.digits;
    const unit = (opts.unit == null) ? ' м' : opts.unit;
    let x = p[0], y = p[1], z = p[2];
    if (opts.order === 'survey') { x = p[0]; y = -p[2]; z = p[1]; }
    const f = n => n.toFixed(digits);
    return { x: x, y: y, z: z, text: 'X ' + f(x) + ', Y ' + f(y) + ', Z ' + f(z) + unit };
  }

  const Measure = {
    sub, add, scale, dot, cross, len, norm, dist3,
    distance, polylineLength, angleAt,
    jacobiEigen3, centroid, fitPlanePCA, fitLinePCA, pointPlaneDist, ransacPlane,
    eigen2, planeBasis, planeExtents, polygonArea3D, orientation, flatness,
    classifyLocal, snapToFeature, signedPointPlane,
    angleBetweenPlanes, intersectPlanes, intersectThreePlanes,
    measureToCsvRow, measurementsToCsv, createMeasurementReport, measureValueText, autoValueText, autoValue, autoSigma, measurementsToMarkdown,
    calibrate, scaleMeasurement, coordLabel,
    fmtLen, fmtArea
  };

  if (typeof window !== 'undefined') window.Measure = Measure;
  if (typeof module !== 'undefined' && module.exports) module.exports = Measure;
})();
