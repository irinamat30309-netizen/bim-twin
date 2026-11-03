'use strict';
/**
 * Ревизия 50: «зерно» цвета на ровных поверхностях.
 * Сверка с Lixel Studio (фасад, светлые панели 4,5 × 1,5 м): отклонение яркости точки от медианы соседних ячеек 1 см у Lixel
 * почти 0 (p90 0,1 из 255), у нашей карты после чистовой обработки — p50 4,5, p90 41, p95 66: светлые панели в тёмную
 * «крапинку», швы и стойки размыты точками. Прежняя очистка (scan-refine-core: fixSpeckles, clampColors) этого почти не
 * трогала: опорой там были ячейки 1 см и порог «не меньше 24 точек в кубе 3 × 3 × 3 см», а на фасаде в таком кубе 4–8 точек —
 * цвет оставался как есть.
 * Здесь опора — устойчивое среднее (средняя половина по яркости, веса — гаусс по расстоянию) цвета соседей в шаре радиуса radius, точка
 * приводится к ней: отклонение ограничивается ±T и уменьшается до доли keep. Чтобы не стирать провода, швы и кромки уже
 * шара, сначала считается доля (по весу) соседей похожей яркости (±tau): у одиночной «соли» их почти нет (< s0) — опора по
 * всем соседям; у линии, шва, края поверхности их много (> s1) — опора только по похожим (линия сглаживается вдоль себя и
 * остаётся резкой); между s0 и s1 — плавно. Где соседей мало (суммарный вес чужих точек < minW — редкие дальние места),
 * цвет не трогается. Густые места прореживаются по хешу координат — результат не зависит от порядка точек.
 */

class CellHash {
  constructor(cap0) { let c = 1024; while (c < cap0 * 2) c <<= 1; this.mask = c - 1; this.K = new Float64Array(c).fill(-1); this.V = new Int32Array(c); this.n = 0; }
  _h(k) { return (Math.imul((k % 4294967296) >>> 0, 2654435761) ^ Math.imul(Math.floor(k / 4294967296) | 0, 40503)) & this.mask; }
  get(k) { let h = this._h(k); while (this.K[h] !== -1) { if (this.K[h] === k) return this.V[h]; h = (h + 1) & this.mask; } return -1; }
  add(k) { let h = this._h(k); while (this.K[h] !== -1) { if (this.K[h] === k) return this.V[h]; h = (h + 1) & this.mask; } this.K[h] = k; this.V[h] = this.n; return this.n++; }
}

/** Ячейки radius: номера ячеек точек, порядок точек по ячейкам (start/ord), хеш ключей. */
function grid(X, n, alive, cell) {
  let mx = Infinity, my = Infinity, mz = Infinity;
  for (let i = 0; i < n; i++) { if (alive && !alive[i]) continue; const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2]; if (x < mx) mx = x; if (y < my) my = y; if (z < mz) mz = z; }
  const ox = Math.floor(mx / cell) - 1, oy = Math.floor(my / cell) - 1, oz = Math.floor(mz / cell) - 1, S = 1 << 20;
  const H = new CellHash(Math.max(16, n >> 1)), cid = new Int32Array(n).fill(-1), cx = [], cy = [], cz = [];
  for (let i = 0; i < n; i++) {
    if (alive && !alive[i]) continue;
    const ix = Math.floor(X[i * 3] / cell) - ox, iy = Math.floor(X[i * 3 + 1] / cell) - oy, iz = Math.floor(X[i * 3 + 2] / cell) - oz;
    if (ix >= S || iy >= S || iz >= S) continue;
    const k = ix + S * (iy + S * iz), before = H.n, j = H.add(k);
    if (j === before) { cx.push(ix); cy.push(iy); cz.push(iz); }
    cid[i] = j;
  }
  const m = H.n, start = new Int32Array(m + 1), ord = new Int32Array(n);
  for (let i = 0; i < n; i++) if (cid[i] >= 0) start[cid[i] + 1]++;
  for (let j = 0; j < m; j++) start[j + 1] += start[j];
  { const pos = start.slice(0, m); for (let i = 0; i < n; i++) { const j = cid[i]; if (j >= 0) ord[pos[j]++] = i; } }
  return { H, cid, start, ord, m, S, cx: Int32Array.from(cx), cy: Int32Array.from(cy), cz: Int32Array.from(cz) };
}

/** Взвешенная медиана v[0..k) с весами w (вставками; k — до нескольких десятков). */
function wmedian(v, w, k, idx) {
  for (let a = 0; a < k; a++) idx[a] = a;
  for (let a = 1; a < k; a++) { const t = idx[a], x = v[t]; let b = a - 1; while (b >= 0 && v[idx[b]] > x) { idx[b + 1] = idx[b]; b--; } idx[b + 1] = t; }
  let tot = 0; for (let a = 0; a < k; a++) tot += w[a];
  let acc = 0, half = tot / 2;
  for (let a = 0; a < k; a++) { acc += w[idx[a]]; if (acc >= half) { if (acc === half && a + 1 < k) return 0.5 * (v[idx[a]] + v[idx[a + 1]]); return v[idx[a]]; } }
  return v[idx[k - 1]];
}

/**
 * Опорный цвет отрезка [a0, a1] порядка idx (по яркости) с суммарным весом W: среднее средней половины по весу (квантили 0,25…0,75) —
 * устойчиво к выбросам, как медиана, но без шума отдельной точки.
 */
function trimmed(idx, a0, a1, W, w, vr, vg, vb, out) {
  const q0 = 0.25 * W, q1 = 0.75 * W; let acc = 0, s = 0, r = 0, g = 0, b = 0;
  for (let a = a0; a <= a1; a++) {
    const q = idx[a], w0 = w[q], lo = Math.max(acc, q0), hi = Math.min(acc + w0, q1); acc += w0;
    if (hi > lo) { const u = hi - lo; s += u; r += u * vr[q]; g += u * vg[q]; b += u * vb[q]; }
    if (acc >= q1) break;
  }
  if (s > 0) { out[0] = r / s; out[1] = g / s; out[2] = b / s; } else { const q = idx[(a0 + a1) >> 1]; out[0] = vr[q]; out[1] = vg[q]; out[2] = vb[q]; }
}

/**
 * degrain(X, RGB, n, alive, o) → число изменённых точек. X — координаты (м), RGB — цвет 0…255 (Float32Array, меняется на месте).
 * o: radius (м, 0,025), sigma (м, radius/2), T (предел отклонения от опоры, 8), keep (доля оставшегося отклонения, 0,3), minW (2),
 *    maxNb (не больше стольких ближайших соседей в медиане, 32), tau (похожая яркость, 25), s0/s1 (доли похожих соседей: «соль» / линия, 0,12 / 0,3).
 */
function degrain(X, RGB, n, alive, o) {
  o = o || {};
  const r = o.radius > 0 ? o.radius : 0.025, r2 = r * r, sg2 = 2 * Math.pow(o.sigma > 0 ? o.sigma : r / 2, 2);
  const T = o.T != null ? o.T : 8, keep = o.keep != null ? Math.max(0, Math.min(1, o.keep)) : 0.3, minW = o.minW != null ? o.minW : 2;
  const tau = o.tau > 0 ? o.tau : 25, s0 = o.s0 != null ? o.s0 : 0.12, s1 = o.s1 != null ? o.s1 : 0.3;
  const MAXC = Math.max(8, Math.min(128, o.maxNb > 0 ? Math.floor(o.maxNb) : 32));
  const G = grid(X, n, alive, r), { H, start, ord, S } = G;
  const hs = new Uint32Array(n);   // хеш координат (мм) — прореживание густых мест без зависимости от порядка
  for (let i = 0; i < n; i++) hs[i] = (Math.imul(Math.round(X[i * 3] * 1000) | 0, 73856093) ^ Math.imul(Math.round(X[i * 3 + 1] * 1000) | 0, 19349663) ^ Math.imul(Math.round(X[i * 3 + 2] * 1000) | 0, 83492791)) >>> 0;
  const out = new Float32Array(n * 3); out.set(RGB.subarray(0, n * 3));
  const vr = new Float32Array(MAXC), vg = new Float32Array(MAXC), vb = new Float32Array(MAXC), w = new Float64Array(MAXC), idx = new Int32Array(MAXC);
  const Lv = new Float32Array(MAXC), nbC = new Int32Array(27), ref = [0, 0, 0], rs = [0, 0, 0];
  let changed = 0;
  for (let j = 0; j < G.m; j++) {
    const x = G.cx[j], y = G.cy[j], z = G.cz[j]; let nc = 0, tot = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = (dx | dy | dz) === 0 ? j : H.get((x + dx) + S * ((y + dy) + S * (z + dz)));
      if (q >= 0) { nbC[nc++] = q; tot += start[q + 1] - start[q]; }
    }
    const stride = tot > 4 * MAXC ? Math.ceil(tot / (4 * MAXC)) : 1;   // густые места (пол у сканера): каждая stride-я по хешу
    for (let t = start[j]; t < start[j + 1]; t++) {
      const i = ord[t], px = X[i * 3], py = X[i * 3 + 1], pz = X[i * 3 + 2], Li = (RGB[i * 3] + RGB[i * 3 + 1] + RGB[i * 3 + 2]) / 3;
      let k = 0, wo = 0, ws = 0;
      for (let u = 0; u < nc; u++) {
        const q = nbC[u];
        for (let s = start[q]; s < start[q + 1]; s++) {
          const e = ord[s];
          if (e !== i && stride > 1 && (hs[e] % stride) !== 0) continue;
          const ex = X[e * 3] - px, ey = X[e * 3 + 1] - py, ez = X[e * 3 + 2] - pz, d2 = ex * ex + ey * ey + ez * ez;
          if (d2 > r2) continue;
          const ww = e === i ? 1 : Math.exp(-d2 / sg2);
          let at = k;
          if (k >= MAXC) { let mi = 0; for (let a = 1; a < MAXC; a++) if (w[a] < w[mi]) mi = a; if (!(ww > w[mi])) continue; at = mi; } else k++;
          vr[at] = RGB[e * 3]; vg[at] = RGB[e * 3 + 1]; vb[at] = RGB[e * 3 + 2]; w[at] = e === i ? 1 + 1e-9 : ww;
        }
      }
      if (k < 3) continue;
      const after = (q, xv, xr, xg) => Lv[q] > xv || (Lv[q] === xv && (vr[q] > xr || (vr[q] === xr && vg[q] > xg)));   // равная яркость — по цвету (не по порядку точек)
      // порядок по яркости (вставками); похожие по яркости соседи — сплошной отрезок [lo, hi] этого порядка
      for (let a = 0; a < k; a++) { idx[a] = a; Lv[a] = (vr[a] + vg[a] + vb[a]) / 3; }
      for (let a = 1; a < k; a++) { const tq = idx[a], xv = Lv[tq], xr = vr[tq], xg = vg[tq]; let bq = a - 1; while (bq >= 0 && after(idx[bq], xv, xr, xg)) { idx[bq + 1] = idx[bq]; bq--; } idx[bq + 1] = tq; }
      let lo = -1, hi = -1, wAll = 0, wSim = 0;
      for (let a = 0; a < k; a++) {
        const q = idx[a], self = w[q] > 1; wAll += w[q]; if (!self) wo += w[q];
        if (Math.abs(Lv[q] - Li) <= tau) { if (lo < 0) lo = a; hi = a; wSim += w[q]; if (!self) ws += w[q]; }
      }
      if (wo < minW) continue;
      trimmed(idx, 0, k - 1, wAll, w, vr, vg, vb, ref);
      const al = Math.max(0, Math.min(1, (ws / wo - s0) / (s1 - s0)));
      if (al > 0 && lo >= 0) { trimmed(idx, lo, hi, wSim, w, vr, vg, vb, rs); for (let a = 0; a < 3; a++) ref[a] += al * (rs[a] - ref[a]); }
      let ch = false;
      for (let a = 0; a < 3; a++) {
        let d = RGB[i * 3 + a] - ref[a]; if (d > T) d = T; else if (d < -T) d = -T; d *= keep;
        const v = ref[a] + d; if (Math.abs(v - RGB[i * 3 + a]) > 0.5) ch = true; out[i * 3 + a] = v;
      }
      if (ch) changed++;
    }
  }
  RGB.set(out.subarray(0, n * 3));
  return changed;
}

module.exports = { degrain, wmedian, trimmed, grid };
