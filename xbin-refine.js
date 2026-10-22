'use strict';
/*
 * xbin-refine.js — уточнение траектории сканера по самому облаку (ревизия 25).
 *
 * Зачем: poses.csv у L2 Pro — 5 Гц. Даже с гироскопом между позами остаётся медленный уход в миллиметры, и стены «двоятся»
 * (у map.las самого Lixel толщина стены ~4 мм). Здесь траектория уточняется так же, как в SLAM, но после съёмки:
 * к позе добавляется поправка δ(t) = (θ, v) — поворот вокруг сканера и сдвиг, кусочно-линейная по узлам через 0,1 с.
 * Поправки находятся из условия «точка лежит на плоскости, построенной по точкам ДРУГИХ моментов съёмки» (|Δt| > 0,4 с —
 * другие обороты мотора и проходы): r = n·(p + θ×(p − c) + v − μ) → min Σ w·r² + λ²Σ|δ_k − δ_{k+1}|² + μ²Σ|δ_k|².
 * Система блочно-трёхдиагональная (узел связан только с соседями) — решается точно прогонкой с блоками 6×6.
 * Окна по 20 с с перекрытием 4 с: начало окна привязано к уже найденным поправкам, поэтому стыков нет.
 * Повторные проходы: к точкам окна добавляется общая карта уже уточнённых окон (по точке на воксель 4 см), и поверхность,
 * снятая через минуты, подгоняется к уже снятой — «двойные стены» от ухода траектории за время съёмки не появляются.
 * Соседи опорной точки (случайная выборка до 40 в радиусе 7 см) ищутся один раз на окно; на следующих итерациях
 * плоскость пересчитывается по тем же соседям в новых положениях — поправки малы по сравнению с радиусом.
 * Память: точки текущего окна (≈150 тыс./с) в Float32 относительно начала окна и общая карта (≈16 байт на воксель 4 см).
 */

const DEF = {
  knot: 0.1, window: 20, overlap: 4, iterations: 3,
  mapRate: 150000, regRate: 20000, thinVoxel: 0.025, thinSlot: 1.0, radius: 0.07, minDt: 0.4, minNb: 10, planar: 9, maxThick: 0.02,
  lambda: 30, prior: 0.3, maxRes: 0.05, anchor: 1000,
  targetSlot: 6,             // соседи — из карты, прореженной до точки на воксель 2,5 см за 6 с (перебор в 6 раз меньше, точность та же)
  maxNb: 40,                 // соседей на опорную точку (случайная выборка из всех в радиусе) — список строится один раз на окно
  // общая карта всей съёмки (1 точка на воксель 4 см): повторные проходы через минуты тянутся к уже уточнённым;
  // невязка до плоскости по точкам карты считается отдельно (их меньше, чем точек окна) и входит с весом 5
  // берутся только точки старше 30 с: соседние по времени окна связаны перекрытием, а карта нужна для настоящих повторных проходов
  // (иначе малые систематические ошибки дальномера передавались бы от окна к окну и копились)
  global: true, globalVoxel: 0.04, globalNb: 6, globalWeight: 5, globalMinAge: 30,
};

function grow(a, n) { if (a.length >= n) return a; const b = new a.constructor(Math.max(n, a.length * 2)); b.set(a); return b; }

// собственные значения и вектор наименьшего для симметричной 3×3 (Якоби): → [l0, l1, l2] по возрастанию, вектор l0 в out
function eig3(a00, a01, a02, a11, a12, a22, out) {
  const A = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sw = 0; sw < 10; sw++) {
    const off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2]; if (off < 1e-22) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-18) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let r = 0; r < 3; r++) { const arp = A[r][p], arq = A[r][q]; A[r][p] = c * arp - s * arq; A[r][q] = s * arp + c * arq; }
      for (let r = 0; r < 3; r++) { const apr = A[p][r], aqr = A[q][r]; A[p][r] = c * apr - s * aqr; A[q][r] = s * apr + c * aqr; }
      for (let r = 0; r < 3; r++) { const vrp = V[r][p], vrq = V[r][q]; V[r][p] = c * vrp - s * vrq; V[r][q] = s * vrp + c * vrq; }
    }
  }
  const d = [A[0][0], A[1][1], A[2][2]], o = [0, 1, 2].sort((i, j) => d[i] - d[j]);
  out[0] = V[0][o[0]]; out[1] = V[1][o[0]]; out[2] = V[2][o[0]];
  return [d[o[0]], d[o[1]], d[o[2]]];
}

// решение плотной системы 6×6 (Гаусс с выбором главного): M (36, по строкам) · X (6×m) = B (6×m), m столбцов; M и B портятся
function solve6(M, B, m) {
  for (let c = 0; c < 6; c++) {
    let pr = c, best = Math.abs(M[c * 6 + c]);
    for (let r = c + 1; r < 6; r++) { const v = Math.abs(M[r * 6 + c]); if (v > best) { best = v; pr = r; } }
    if (!(best > 1e-300)) throw new Error('уточнение траектории: вырожденная система');
    if (pr !== c) {
      for (let k = 0; k < 6; k++) { const t = M[c * 6 + k]; M[c * 6 + k] = M[pr * 6 + k]; M[pr * 6 + k] = t; }
      for (let k = 0; k < m; k++) { const t = B[c * m + k]; B[c * m + k] = B[pr * m + k]; B[pr * m + k] = t; }
    }
    const inv = 1 / M[c * 6 + c];
    for (let r = 0; r < 6; r++) {
      if (r === c) continue; const f = M[r * 6 + c] * inv; if (!f) continue;
      for (let k = c; k < 6; k++) M[r * 6 + k] -= f * M[c * 6 + k];
      for (let k = 0; k < m; k++) B[r * m + k] -= f * B[c * m + k];
    }
  }
  for (let r = 0; r < 6; r++) { const inv = 1 / M[r * 6 + r]; for (let k = 0; k < m; k++) B[r * m + k] *= inv; }
  return B;
}

/**
 * Блочно-трёхдиагональная система: D[k] (6×6), U[k] = блок (k, k+1), g[k]; блок (k+1, k) = U[k]ᵀ. → x (L·6)
 */
function solveBlockTridiag(D, U, g, L) {
  const Dp = new Float64Array(L * 36), gp = new Float64Array(L * 6), C = new Float64Array(L * 36);   // C[k] = D'[k]⁻¹ U[k]
  const tmpM = new Float64Array(36), tmpB = new Float64Array(42);
  for (let k = 0; k < L; k++) {
    // D'[k] = D[k] − U[k−1]ᵀ C[k−1];  g'[k] = g[k] − U[k−1]ᵀ y[k−1], y[k−1] = D'[k−1]⁻¹ g'[k−1] (храним в gp)
    for (let i = 0; i < 36; i++) Dp[k * 36 + i] = D[k * 36 + i];
    for (let i = 0; i < 6; i++) gp[k * 6 + i] = g[k * 6 + i];
    if (k > 0) {
      const u = (k - 1) * 36;
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
        let s = 0; for (let j = 0; j < 6; j++) s += U[u + j * 6 + r] * C[u + j * 6 + c];
        Dp[k * 36 + r * 6 + c] -= s;
      }
      for (let r = 0; r < 6; r++) { let s = 0; for (let j = 0; j < 6; j++) s += U[u + j * 6 + r] * gp[(k - 1) * 6 + j]; gp[k * 6 + r] -= s; }
    }
    // решаем D'[k] · [C[k] | y[k]] = [U[k] | g'[k]]
    tmpM.set(Dp.subarray(k * 36, k * 36 + 36));
    for (let r = 0; r < 6; r++) { for (let c = 0; c < 6; c++) tmpB[r * 7 + c] = k < L - 1 ? U[k * 36 + r * 6 + c] : 0; tmpB[r * 7 + 6] = gp[k * 6 + r]; }
    solve6(tmpM, tmpB, 7);
    for (let r = 0; r < 6; r++) { for (let c = 0; c < 6; c++) C[k * 36 + r * 6 + c] = tmpB[r * 7 + c]; gp[k * 6 + r] = tmpB[r * 7 + 6]; }
  }
  const x = new Float64Array(L * 6);
  for (let k = L - 1; k >= 0; k--) {
    for (let r = 0; r < 6; r++) {
      let s = gp[k * 6 + r];
      if (k < L - 1) for (let j = 0; j < 6; j++) s -= C[k * 36 + r * 6 + j] * x[(k + 1) * 6 + j];
      x[k * 6 + r] = s;
    }
  }
  return x;
}

// сетка вокселей с хешированием: 2^HB корзин, сортировка подсчётом за O(n). Разные клетки в одной корзине — только лишние
// кандидаты (их отсекает проверка расстояния), поэтому результат точный.
function hashCell(ix, iy, iz, mask) { return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask; }
function buildGrid(X, Y, Z, n, cell, ids) {   // ids — необязательный список номеров точек (иначе 0..n−1)
  const N = ids ? ids.length : n;
  let HB = 16; while ((1 << HB) < N && HB < 24) HB++;
  const size = 1 << HB, mask = size - 1, start = new Int32Array(size + 1), cellOf = new Int32Array(N), idx = new Int32Array(N);
  for (let k = 0; k < N; k++) { const i = ids ? ids[k] : k; const h = hashCell(Math.floor(X[i] / cell), Math.floor(Y[i] / cell), Math.floor(Z[i] / cell), mask); cellOf[k] = h; start[h + 1]++; }
  for (let h = 0; h < size; h++) start[h + 1] += start[h];
  const fill = start.slice(0, size);
  for (let k = 0; k < N; k++) idx[fill[cellOf[k]]++] = ids ? ids[k] : k;
  return { idx, start, mask, cell };
}

/**
 * refine(fd, C, opt, prog, walk) → { knots: { t0, dt, x: Float64Array(K·6) }, summary }
 *   C — контекст xbin-lidar.prepare(), walk — xbin-lidar.walk (обход точек окна с позой из C.TR).
 */
function refine(fd, C, opt, prog, walk) {
  const o = Object.assign({}, DEF, (opt && opt.refineOpt) || {});
  const T0 = C.T0, T1 = C.T1, dtK = o.knot, K = Math.ceil((T1 - T0) / dtK) + 2;
  const Xg = new Float64Array(K * 6), solved = new Uint8Array(K);
  // плотность сырых точек: байты пакетов / ~20,5 байта на точку · ~0,6 после фильтров
  const bytes = C.recs.reduce((s, r) => s + r.len, 0), rate = bytes / 20.5 * 0.6 / Math.max(1e-3, T1 - T0);
  const stepMap = Math.max(1, Math.round(rate / o.mapRate));
  const R2 = o.radius * o.radius;
  const tm = { walk: 0, grid: 0, query: 0, solve: 0 };
  const stats = { windows: 0, pairsFirst: 0, pairsLast: 0, madFirst: [], madLast: [], maxRotDeg: 0, maxShiftMm: 0, seconds: 0 };
  const started = Date.now();
  let PX = new Float32Array(1 << 20), PY = new Float32Array(1 << 20), PZ = new Float32Array(1 << 20), PT = new Float32Array(1 << 20);
  let CX = new Float32Array(1 << 20), CY = new Float32Array(1 << 20), CZ = new Float32Array(1 << 20);
  const nb = new Float64Array(3), SEEN_MASK = (1 << 24) - 1, seen = new Int32Array(1 << 24); let seenStamp = 0;
  // общая карта: координаты относительно G0 (Float32), время от T0; занятость вокселей — битовая маска по хешу (коллизии только прореживают)
  let GX = new Float32Array(1 << 20), GY = new Float32Array(1 << 20), GZ = new Float32Array(1 << 20), GT = new Float32Array(1 << 20), gn = 0, G0 = null;
  const GMASK = (1 << 28) - 1, gbits = o.global ? new Uint32Array((GMASK + 1) >>> 5) : null;
  let rnd = 0x9e3779b9; const rand = () => { rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0; return rnd; };
  stats.globalUsed = 0;
  const span = o.window - o.overlap, nWin = Math.max(1, Math.ceil((T1 - T0 - o.overlap) / span));
  for (let wi = 0; wi < nWin; wi++) {
    const a = T0 + wi * span, b = Math.min(T1, a + o.window); if (!(b > a)) break;
    let n = 0, org = null; let tq0 = Date.now();
    // карта равномерной плотности: не больше одной точки на воксель thinVoxel за thinSlot секунд (у сканера точек в сотни раз больше)
    seenStamp++;
    walk(fd, C, opt, a, b, stepMap, (x, y, z, t, I, R, cx, cy, cz) => {
      const h = (Math.imul(Math.floor(x / o.thinVoxel), 73856093) ^ Math.imul(Math.floor(y / o.thinVoxel), 19349663) ^ Math.imul(Math.floor(z / o.thinVoxel), 83492791) ^ Math.imul(Math.floor((t - a) / o.thinSlot), 2654435761)) & SEEN_MASK;
      if (seen[h] === seenStamp) return; seen[h] = seenStamp;
      if (!org) org = [x, y, z];
      if (n >= PX.length) { const m = n + 1; PX = grow(PX, m); PY = grow(PY, m); PZ = grow(PZ, m); PT = grow(PT, m); CX = grow(CX, m); CY = grow(CY, m); CZ = grow(CZ, m); }
      PX[n] = x - org[0]; PY[n] = y - org[1]; PZ[n] = z - org[2]; PT[n] = t - a; CX[n] = cx - org[0]; CY[n] = cy - org[1]; CZ[n] = cz - org[2]; n++;
    });
    tm.walk += Date.now() - tq0; stats.mapPoints = (stats.mapPoints || 0) + n;
    const ka = Math.max(0, Math.floor((a - T0) / dtK)), kb = Math.min(K - 1, Math.ceil((b - T0) / dtK) + 1), L = kb - ka + 1;
    const x = new Float64Array(L * 6);
    for (let k = 0; k < L; k++) if (solved[ka + k]) for (let j = 0; j < 6; j++) x[k * 6 + j] = Xg[(ka + k) * 6 + j];
    const anchorUntil = a + o.overlap / 2;
    if (n < 1000) { for (let k = 0; k < L; k++) solved[ka + k] = 1; stats.windows++; continue; }
    if (!G0) G0 = org.slice();
    // точки общей карты рядом с окном (до начала окна): неподвижные соседи — PT = −1e9, всегда «другой момент»
    let m = 0;
    if (o.global && gn) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < n; i++) { const X = PX[i], Y = PY[i], Z = PZ[i]; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z; }
      const mg = 0.2, dx0 = G0[0] - org[0], dy0 = G0[1] - org[1], dz0 = G0[2] - org[2], tLim = a - T0 - o.globalMinAge;
      for (let j = 0; j < gn; j++) {
        if (GT[j] >= tLim) continue;
        const X = GX[j] + dx0, Y = GY[j] + dy0, Z = GZ[j] + dz0;
        if (X < x0 - mg || X > x1 + mg || Y < y0 - mg || Y > y1 + mg || Z < z0 - mg || Z > z1 + mg) continue;
        const i = n + m;
        if (i >= PX.length) { const mm = i + 1; PX = grow(PX, mm); PY = grow(PY, mm); PZ = grow(PZ, mm); PT = grow(PT, mm); CX = grow(CX, mm); CY = grow(CY, mm); CZ = grow(CZ, mm); }
        PX[i] = X; PY[i] = Y; PZ[i] = Z; PT[i] = -1e9; CX[i] = X; CY[i] = Y; CZ[i] = Z; m++;
      }
      stats.globalUsed += m;
    }
    const nAll = n + m;
    const QX = new Float32Array(nAll), QY = new Float32Array(nAll), QZ = new Float32Array(nAll);
    QX.set(PX.subarray(n, nAll), n); QY.set(PY.subarray(n, nAll), n); QZ.set(PZ.subarray(n, nAll), n);
    const every = Math.max(1, Math.round(n / (o.regRate * (b - a))));
    const nq = Math.ceil(n / every), CAP = o.maxNb, NB = new Int32Array(nq * CAP), NC = new Uint8Array(nq);
    const CAPO = m ? 24 : 0, NBO = new Int32Array(nq * CAPO), NCO = new Uint8Array(m ? nq : 0);   // соседи из общей карты
    for (let it = 0; it < o.iterations; it++) {
      // текущие точки: p0 + θ(t)×(p0 − c) + v(t)
      for (let i = 0; i < n; i++) {
        const u = (PT[i] + a - T0) / dtK - ka; let k0 = Math.floor(u); if (k0 < 0) k0 = 0; if (k0 > L - 2) k0 = L - 2; const al = u - k0, be = 1 - al, i0 = k0 * 6, i1 = i0 + 6;
        const tx = x[i0] * be + x[i1] * al, ty = x[i0 + 1] * be + x[i1 + 1] * al, tz = x[i0 + 2] * be + x[i1 + 2] * al;
        const dx = PX[i] - CX[i], dy = PY[i] - CY[i], dz = PZ[i] - CZ[i];
        QX[i] = PX[i] + (ty * dz - tz * dy) + x[i0 + 3] * be + x[i1 + 3] * al;
        QY[i] = PY[i] + (tz * dx - tx * dz) + x[i0 + 4] * be + x[i1 + 4] * al;
        QZ[i] = PZ[i] + (tx * dy - ty * dx) + x[i0 + 5] * be + x[i1 + 5] * al;
      }
      if (it === 0) {   // соседи: случайная выборка до CAP из всех точек других моментов в радиусе (резервуар)
        tq0 = Date.now();
        let ids = null;
        if (o.targetSlot > o.thinSlot) {
          seenStamp++; let nt = 0; ids = new Int32Array(nAll);
          for (let i = 0; i < n; i++) {
            const h = (Math.imul(Math.floor(QX[i] / o.thinVoxel), 73856093) ^ Math.imul(Math.floor(QY[i] / o.thinVoxel), 19349663) ^ Math.imul(Math.floor(QZ[i] / o.thinVoxel), 83492791) ^ Math.imul(Math.floor(PT[i] / o.targetSlot), 2654435761)) & SEEN_MASK;
            if (seen[h] === seenStamp) continue; seen[h] = seenStamp; ids[nt++] = i;
          }
          for (let i = n; i < nAll; i++) ids[nt++] = i;
          ids = ids.subarray(0, nt);
        }
        const G = buildGrid(QX, QY, QZ, nAll, o.radius, ids); tm.grid += Date.now() - tq0; tq0 = Date.now();
        for (let q = 0, qi = 0; q < n; q += every, qi++) {
          const qx = QX[q], qy = QY[q], qz = QZ[q], tq = PT[q], base = qi * CAP;
          const ix = Math.floor(qx / G.cell), iy = Math.floor(qy / G.cell), iz = Math.floor(qz / G.cell);
          let seenNb = 0, seenOld = 0; const baseO = qi * CAPO;
          for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = -1; ddy <= 1; ddy++) for (let ddz = -1; ddz <= 1; ddz++) {
            const h = hashCell(ix + ddx, iy + ddy, iz + ddz, G.mask), s0 = G.start[h], e0 = G.start[h + 1];
            for (let j = s0; j < e0; j++) {
              const p = G.idx[j]; const dtq = PT[p] - tq; if (dtq < o.minDt && dtq > -o.minDt) continue;
              const ex = QX[p] - qx, ey = QY[p] - qy, ez = QZ[p] - qz; if (ex * ex + ey * ey + ez * ez > R2) continue;
              if (p >= n) { if (seenOld < CAPO) NBO[baseO + seenOld] = p; else { const r = rand() % (seenOld + 1); if (r < CAPO) NBO[baseO + r] = p; } seenOld++; continue; }
              if (seenNb < CAP) NB[base + seenNb] = p; else { const r = rand() % (seenNb + 1); if (r < CAP) NB[base + r] = p; }
              seenNb++;
            }
          }
          NC[qi] = seenNb < CAP ? seenNb : CAP; if (CAPO) NCO[qi] = seenOld < CAPO ? seenOld : CAPO;
        }
        tm.query += Date.now() - tq0;
      }
      tq0 = Date.now();
      // невязки точка-плоскость
      const res = [], rows = [];
      // плоскость по соседям из списка → невязка точки q (две плоскости: по точкам окна и по общей карте прежних проходов)
      const plane = (q, LIST, base, cnt, minNb, w) => {
        if (cnt < minNb) return;
        const qx = QX[q], qy = QY[q], qz = QZ[q];
        let m = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
        for (let k = 0; k < cnt; k++) {
          const p = LIST[base + k], ex = QX[p] - qx, ey = QY[p] - qy, ez = QZ[p] - qz;
          m++; sx += ex; sy += ey; sz += ez; sxx += ex * ex; sxy += ex * ey; sxz += ex * ez; syy += ey * ey; syz += ey * ez; szz += ez * ez;
        }
        const mx = sx / m, my = sy / m, mz = sz / m;
        const l = eig3(sxx / m - mx * mx, sxy / m - mx * my, sxz / m - mx * mz, syy / m - my * my, syz / m - my * mz, szz / m - mz * mz, nb);
        if (!(l[1] > o.planar * l[0]) || l[0] > o.maxThick * o.maxThick) return;
        const r = -(nb[0] * mx + nb[1] * my + nb[2] * mz);   // n·(q − μ), μ — относительно q
        res.push(r); rows.push(q, nb[0], nb[1], nb[2], w);
      };
      for (let q = 0, qi = 0; q < n; q += every, qi++) {
        plane(q, NB, qi * CAP, NC[qi], o.minNb, 1);
        if (CAPO) { const before = res.length; plane(q, NBO, qi * CAPO, NCO[qi], o.globalNb, o.globalWeight); if (res.length > before) stats.globalPairs = (stats.globalPairs || 0) + (it === o.iterations - 1 ? 1 : 0); }
      }
      tm.fit = (tm.fit || 0) + Date.now() - tq0; tq0 = Date.now();
      if (res.length < 200) break;
      const absr = Float64Array.from(res, Math.abs).sort(); const mad = 1.4826 * absr[absr.length >> 1];
      if (it === 0) { stats.madFirst.push(mad); stats.pairsFirst += res.length; } else if (it === o.iterations - 1) { stats.madLast.push(mad); stats.pairsLast += res.length; }
      // нормальные уравнения
      const D = new Float64Array(L * 36), U = new Float64Array(L * 36), g = new Float64Array(L * 6), J = new Float64Array(12);
      const cut = 2 * mad;
      for (let e = 0; e < res.length; e++) {
        const r = res[e]; const ar = Math.abs(r); if (ar > o.maxRes) continue;
        const q = rows[e * 5], nx = rows[e * 5 + 1], ny = rows[e * 5 + 2], nz = rows[e * 5 + 3], w = rows[e * 5 + 4] * (ar < cut ? 1 : cut / ar);
        const dx = QX[q] - CX[q], dy = QY[q] - CY[q], dz = QZ[q] - CZ[q];
        const ax = dy * nz - dz * ny, ay = dz * nx - dx * nz, az = dx * ny - dy * nx;   // (p − c) × n
        const u = (PT[q] + a - T0) / dtK - ka; let k0 = Math.floor(u); if (k0 < 0) k0 = 0; if (k0 > L - 2) k0 = L - 2; const al = u - k0, be = 1 - al;
        J[0] = ax * be; J[1] = ay * be; J[2] = az * be; J[3] = nx * be; J[4] = ny * be; J[5] = nz * be;
        J[6] = ax * al; J[7] = ay * al; J[8] = az * al; J[9] = nx * al; J[10] = ny * al; J[11] = nz * al;
        const d0 = k0 * 36, d1 = (k0 + 1) * 36;
        for (let i = 0; i < 6; i++) {
          g[k0 * 6 + i] -= w * J[i] * r; g[(k0 + 1) * 6 + i] -= w * J[6 + i] * r;
          for (let j = 0; j < 6; j++) {
            D[d0 + i * 6 + j] += w * J[i] * J[j]; D[d1 + i * 6 + j] += w * J[6 + i] * J[6 + j]; U[d0 + i * 6 + j] += w * J[i] * J[6 + j];
          }
        }
      }
      const l2 = o.lambda * o.lambda, p2 = o.prior * o.prior, a2 = o.anchor * o.anchor;
      for (let k = 0; k < L; k++) {
        const tk = T0 + (ka + k) * dtK, anchored = solved[ka + k] && tk < anchorUntil, w = anchored ? a2 : p2;
        for (let i = 0; i < 6; i++) {
          D[k * 36 + i * 7] += w;
          g[k * 6 + i] += w * ((anchored ? Xg[(ka + k) * 6 + i] : 0) - x[k * 6 + i]);
          if (k < L - 1) {
            const diff = x[k * 6 + i] - x[(k + 1) * 6 + i];
            D[k * 36 + i * 7] += l2; D[(k + 1) * 36 + i * 7] += l2; U[k * 36 + i * 7] -= l2;
            g[k * 6 + i] -= l2 * diff; g[(k + 1) * 6 + i] += l2 * diff;
          }
        }
      }
      const dx = solveBlockTridiag(D, U, g, L);
      for (let i = 0; i < x.length; i++) x[i] += dx[i];
      tm.solve += Date.now() - tq0;
      if (prog) prog((wi + (it + 1) / o.iterations) / nWin, 'Облако из .xbin: уточнение траектории по облаку (окно ' + (wi + 1) + ' из ' + nWin + ')…');
    }
    if (o.global) {   // в общую карту — точки окна в окончательных положениях до середины перекрытия со следующим окном
      const tEnd = Math.min(b, a + span + o.overlap / 2) - a, gv = o.globalVoxel, ox = org[0] - G0[0], oy = org[1] - G0[1], oz = org[2] - G0[2];
      for (let i = 0; i < n; i++) {
        if (PT[i] >= tEnd) continue;
        const u = (PT[i] + a - T0) / dtK - ka; let k0 = Math.floor(u); if (k0 < 0) k0 = 0; if (k0 > L - 2) k0 = L - 2; const al = u - k0, be = 1 - al, i0 = k0 * 6, i1 = i0 + 6;
        const tx = x[i0] * be + x[i1] * al, ty = x[i0 + 1] * be + x[i1 + 1] * al, tz = x[i0 + 2] * be + x[i1 + 2] * al;
        const dx = PX[i] - CX[i], dy = PY[i] - CY[i], dz = PZ[i] - CZ[i];
        const X = PX[i] + (ty * dz - tz * dy) + x[i0 + 3] * be + x[i1 + 3] * al + ox, Y = PY[i] + (tz * dx - tx * dz) + x[i0 + 4] * be + x[i1 + 4] * al + oy, Z = PZ[i] + (tx * dy - ty * dx) + x[i0 + 5] * be + x[i1 + 5] * al + oz;
        const h = (Math.imul(Math.floor(X / gv), 73856093) ^ Math.imul(Math.floor(Y / gv), 19349663) ^ Math.imul(Math.floor(Z / gv), 83492791)) & GMASK;
        if (gbits[h >>> 5] & (1 << (h & 31))) continue; gbits[h >>> 5] |= 1 << (h & 31);
        if (gn >= GX.length) { const mm = gn + 1; GX = grow(GX, mm); GY = grow(GY, mm); GZ = grow(GZ, mm); GT = grow(GT, mm); }
        GX[gn] = X; GY[gn] = Y; GZ[gn] = Z; GT[gn] = PT[i] + a - T0; gn++;
      }
    }
    for (let k = 0; k < L; k++) {
      const tk = T0 + (ka + k) * dtK; if (solved[ka + k] && tk < anchorUntil) continue;
      for (let j = 0; j < 6; j++) Xg[(ka + k) * 6 + j] = x[k * 6 + j]; solved[ka + k] = 1;
      stats.maxRotDeg = Math.max(stats.maxRotDeg, Math.hypot(x[k * 6], x[k * 6 + 1], x[k * 6 + 2]) * 180 / Math.PI);
      stats.maxShiftMm = Math.max(stats.maxShiftMm, Math.hypot(x[k * 6 + 3], x[k * 6 + 4], x[k * 6 + 5]) * 1000);
    }
    stats.windows++;
  }
  const med = (v) => { if (!v.length) return null; const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  stats.seconds = (Date.now() - started) / 1000;
  const summary = { windows: stats.windows, knots: K, knotStep: dtK, pairs: stats.pairsLast, residualBeforeMm: med(stats.madFirst) != null ? med(stats.madFirst) * 1000 : null,
    residualAfterMm: med(stats.madLast) != null ? med(stats.madLast) * 1000 : null, maxRotDeg: stats.maxRotDeg, maxShiftMm: stats.maxShiftMm, seconds: stats.seconds, mapStep: stepMap, mapPoints: stats.mapPoints, globalMap: gn, globalUsed: stats.globalUsed, globalPairs: stats.globalPairs || 0, timing: tm };
  return { knots: { t0: T0, dt: dtK, x: Xg }, summary };
}

// траектория с поправками: R' = Exp(θ(t))·R(t), c' = c(t) + v(t)
function correctedTrajectory(TR, knots) {
  const X = knots.x, K = X.length / 6, base = TR.poseAt, tmp = new Float64Array(16);
  function poseAt(t, out) {
    out = base(t, out || new Float64Array(16));
    let u = (t - knots.t0) / knots.dt; if (!(u >= 0)) u = 0; let k = Math.floor(u); if (k > K - 2) { k = K - 2; u = K - 1; }
    const al = u - k, be = 1 - al, i0 = k * 6, i1 = i0 + 6;
    const tx = X[i0] * be + X[i1] * al, ty = X[i0 + 1] * be + X[i1 + 1] * al, tz = X[i0 + 2] * be + X[i1 + 2] * al;
    const th = Math.hypot(tx, ty, tz);
    if (th > 1e-12) {
      const kx = tx / th, ky = ty / th, kz = tz / th, c = Math.cos(th), s = Math.sin(th), v = 1 - c;
      const r00 = c + kx * kx * v, r01 = kx * ky * v - kz * s, r02 = kx * kz * v + ky * s;
      const r10 = ky * kx * v + kz * s, r11 = c + ky * ky * v, r12 = ky * kz * v - kx * s;
      const r20 = kz * kx * v - ky * s, r21 = kz * ky * v + kx * s, r22 = c + kz * kz * v;
      for (let j = 0; j < 3; j++) {
        const a0 = out[j], a1 = out[4 + j], a2 = out[8 + j];
        tmp[j] = r00 * a0 + r01 * a1 + r02 * a2; tmp[4 + j] = r10 * a0 + r11 * a1 + r12 * a2; tmp[8 + j] = r20 * a0 + r21 * a1 + r22 * a2;
      }
      for (let j = 0; j < 3; j++) { out[j] = tmp[j]; out[4 + j] = tmp[4 + j]; out[8 + j] = tmp[8 + j]; }
    }
    out[3] += X[i0 + 3] * be + X[i1 + 3] * al; out[7] += X[i0 + 4] * be + X[i1 + 4] * al; out[11] += X[i0 + 5] * be + X[i1 + 5] * al;
    return out;
  }
  return Object.assign({}, TR, { poseAt, refined: true });
}

module.exports = { refine, correctedTrajectory, solveBlockTridiag, solve6, eig3, buildGrid, hashCell, DEF };
