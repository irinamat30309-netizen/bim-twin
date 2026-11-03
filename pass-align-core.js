'use strict';
/*
 * pass-align-core.js — «сведение проходов» (ревизия 21): исправление дрейфа траектории realtime-карты сканера.
 *
 * Почему: map.las, который пишет сканер (Lixel L2 Pro и т. п.), собран по траектории реального времени. Когда оператор
 * возвращается к уже снятому месту через 20–30 минут, накопленный дрейф 1–4 см даёт ДВЕ поверхности: стена «толстая»,
 * у арматуры, рам и проводов — ореол, окна и кирпич «пёстрые». Lixel Studio при пересчёте замыкает петли и сводит
 * проходы; по реальному скану (фасад, 271 млн точек) поздние проходы были сдвинуты на 2–3,5 см.
 *
 * Как: время точки (GPS time LAS) делится на отрезки dt (10 с). Для каждого отрезка ищется малая поправка позы
 * (поворот ω вокруг положения сканера в момент съёмки + сдвиг τ), поправка внутри отрезка — линейная по времени.
 * Связи — плоские участки, снятые в разные моменты (разница ≥ gap): в вокселе 30 см точки каждого отрезка дают плоскость,
 * расстояние между плоскостями разных проходов вдоль нормали должно быть нулём. Плюс плавность поправок во времени и
 * закрепление начала съёмки. Решается методом Гаусса — Ньютона (плотная система 6×число отрезков, Холецкий).
 * Используется выборка ~3 млн точек (один проход по файлу), поэтому размер облака на память не влияет.
 */

const TOFF = { 1: 20, 3: 20, 4: 20, 5: 20, 6: 22, 7: 22, 8: 22, 9: 22, 10: 22 };

/** Выборка точек для оценки: каждая ~stride-я точка (псевдослучайно, без «биений» со строками лидара). */
class Sampler {
  constructor(N, max, color) {
    max = Math.max(1000, max || 3000000);
    this.stride = Math.max(1, Math.floor(N / max)); const cap = Math.ceil(N / this.stride) + 1024;
    this.X = new Float64Array(cap * 3); this.T = new Float64Array(cap); this.n = 0; this.cap = cap;
    this.C = color ? new Uint16Array(cap * 3) : null;   // ревизия 21: цвет — для выравнивания экспозиции (color-balance-core)
  }
  want(i) { return this.stride === 1 || ((Math.imul(i, 2654435761) >>> 0) % this.stride) === 0; }
  add(x, y, z, t, r, g, b) {
    if (this.n >= this.cap || !Number.isFinite(t)) return;
    const k = this.n++; this.X[k * 3] = x; this.X[k * 3 + 1] = y; this.X[k * 3 + 2] = z; this.T[k] = t;
    if (this.C) { this.C[k * 3] = r; this.C[k * 3 + 1] = g; this.C[k * 3 + 2] = b; }
  }
}

// симметричная 3×3 (Якоби): собственные значения по возрастанию → ev[0..2], вектор наименьшего → v
function eigSym3(a00, a01, a02, a11, a12, a22, ev, v) {
  const A = [a00, a01, a02, a01, a11, a12, a02, a12, a22], V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sw = 0; sw < 12; sw++) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5]; if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      const apq = A[p * 3 + q]; if (Math.abs(apq) < 1e-300) continue;
      const th = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let r = 0; r < 3; r++) { const arp = A[r * 3 + p], arq = A[r * 3 + q]; A[r * 3 + p] = c * arp - s * arq; A[r * 3 + q] = s * arp + c * arq; }
      for (let r = 0; r < 3; r++) { const apr = A[p * 3 + r], aqr = A[q * 3 + r]; A[p * 3 + r] = c * apr - s * aqr; A[q * 3 + r] = s * apr + c * aqr; }
      for (let r = 0; r < 3; r++) { const vrp = V[r * 3 + p], vrq = V[r * 3 + q]; V[r * 3 + p] = c * vrp - s * vrq; V[r * 3 + q] = s * vrp + c * vrq; }
    }
  }
  const d = [A[0], A[4], A[8]], o = [0, 1, 2].sort((i, j) => d[i] - d[j]);
  ev[0] = d[o[0]]; ev[1] = d[o[1]]; ev[2] = d[o[2]];
  v[0] = V[o[0]]; v[1] = V[3 + o[0]]; v[2] = V[6 + o[0]];
}

// хеш: целый ключ (< 2^53) → номер
class KeyMap {
  constructor(cap0) { let c = 1024; while (c < cap0 * 2) c <<= 1; this.cap = c; this.mask = c - 1; this.K = new Float64Array(c).fill(-1); this.V = new Int32Array(c); this.n = 0; }
  _h(k) { return (Math.imul((k % 4294967296) >>> 0, 2654435761) ^ Math.imul(Math.floor(k / 4294967296), 40503)) & this.mask; }
  get(k, add) {
    let h = this._h(k); const K = this.K;
    while (K[h] !== -1) { if (K[h] === k) return this.V[h]; h = (h + 1) & this.mask; }
    if (!add) return -1;
    if (this.n * 2 >= this.cap) { this._grow(); return this.get(k, true); }
    K[h] = k; this.V[h] = this.n; return this.n++;
  }
  _grow() { const oK = this.K, oV = this.V; this.cap <<= 1; this.mask = this.cap - 1; this.K = new Float64Array(this.cap).fill(-1); this.V = new Int32Array(this.cap);
    for (let i = 0; i < oK.length; i++) { if (oK[i] === -1) continue; let h = this._h(oK[i]); while (this.K[h] !== -1) h = (h + 1) & this.mask; this.K[h] = oK[i]; this.V[h] = oV[i]; } }
}

// Холецкий для плотной SPD-матрицы n×n (на месте); решение H x = b → b
function choleskySolve(H, b, n) {
  for (let j = 0; j < n; j++) {
    const rj = j * n; let s = H[rj + j];
    for (let k = 0; k < j; k++) s -= H[rj + k] * H[rj + k];
    if (!(s > 0)) s = 1e-12;
    const d = Math.sqrt(s); H[rj + j] = d; const inv = 1 / d;
    for (let i = j + 1; i < n; i++) {
      const ri = i * n; let t = H[ri + j];
      for (let k = 0; k < j; k++) t -= H[ri + k] * H[rj + k];
      H[ri + j] = t * inv;
    }
  }
  for (let i = 0; i < n; i++) { const ri = i * n; let s = b[i]; for (let k = 0; k < i; k++) s -= H[ri + k] * b[k]; b[i] = s / H[ri + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= H[k * n + i] * b[k]; b[i] = s / H[i * n + i]; }
  return b;
}

/**
 * solve(sample, poseAt|null, opt) → { ok, reason?, t0, dt, S, X (Float64Array S*6: ωx ωy ωz τx τy τz), centers?, stats }
 *   sample: Sampler (X, T, n). poseAt(t, out) — положение сканера (dynamic-clean-core.makePoseAt) или null
 *   (тогда центр поворота — средняя точка отрезка).
 */
function solve(sample, poseAt, opt) {
  opt = Object.assign({ dt: 10, gap: 60, voxel: 0.3, iters: 6, lambda: 2000, anchor: 30, minPts: 8, maxRes: 0.06, planar: 6, thick: 0.02, maxPairs: 6, maxSeg: 400, maxShift: 0.5, minLinks: 300 }, opt || {});
  const n = sample.n, P0 = sample.X, T = sample.T;
  if (n < 5000) return { ok: false, reason: 'мало точек со временем' };
  let t0 = Infinity, t1 = -Infinity;
  for (let i = 0; i < n; i++) { const t = T[i]; if (t < t0) t0 = t; if (t > t1) t1 = t; }
  if (!(t1 - t0 > opt.gap)) return { ok: false, reason: 'съёмка короче ' + opt.gap + ' с — сводить нечего' };
  let dt = opt.dt; if ((t1 - t0) / dt + 2 > opt.maxSeg) dt = (t1 - t0) / (opt.maxSeg - 2);
  const S = Math.ceil((t1 - t0) / dt) + 1, NU = S * 6, G = Math.max(1, Math.round(opt.gap / dt));
  // время → узлы интерполяции
  const I0 = new Int32Array(n), W1 = new Float32Array(n), SEG = new Int32Array(n), C = new Float64Array(n * 3);
  const cen = poseAt ? null : new Float64Array(S * 3), cc = poseAt ? null : new Float64Array(S);
  const tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const f = (T[i] - t0) / dt; SEG[i] = Math.min(S - 1, Math.max(0, Math.floor(f)));
    const g = f - 0.5; let i0 = Math.floor(g); if (i0 < 0) i0 = 0; if (i0 > S - 2) i0 = S - 2; let w = g - i0; if (w < 0) w = 0; if (w > 1) w = 1;
    I0[i] = i0; W1[i] = w;
    if (poseAt) { poseAt(T[i], tmp); C[i * 3] = tmp[0]; C[i * 3 + 1] = tmp[1]; C[i * 3 + 2] = tmp[2]; }
    else { const s = SEG[i]; cen[s * 3] += P0[i * 3]; cen[s * 3 + 1] += P0[i * 3 + 1]; cen[s * 3 + 2] += P0[i * 3 + 2]; cc[s]++; }
  }
  if (!poseAt) {
    let last = null;
    for (let s = 0; s < S; s++) { if (cc[s]) { cen[s * 3] /= cc[s]; cen[s * 3 + 1] /= cc[s]; cen[s * 3 + 2] /= cc[s]; last = s; } else if (last !== null) { cen[s * 3] = cen[last * 3]; cen[s * 3 + 1] = cen[last * 3 + 1]; cen[s * 3 + 2] = cen[last * 3 + 2]; } }
    let first = -1; for (let s = 0; s < S; s++) if (cc[s]) { first = s; break; }
    for (let s = 0; s < first; s++) { cen[s * 3] = cen[first * 3]; cen[s * 3 + 1] = cen[first * 3 + 1]; cen[s * 3 + 2] = cen[first * 3 + 2]; }
    for (let i = 0; i < n; i++) { const a = I0[i], w = W1[i]; for (let k = 0; k < 3; k++) C[i * 3 + k] = cen[a * 3 + k] * (1 - w) + cen[(a + 1) * 3 + k] * w; }
  }
  const X = new Float64Array(NU), P = new Float64Array(n * 3);
  const SC = [30, 30, 30, 1, 1, 1];
  const inv = 1 / opt.voxel, OFF = 32768;
  let stats0 = null, statsLast = null;
  const evalPass = (build) => {
    // 1) поправленные координаты
    for (let i = 0; i < n; i++) {
      const a = I0[i] * 6, b = a + 6, w = W1[i], u = 1 - w;
      const wx = X[a] * u + X[b] * w, wy = X[a + 1] * u + X[b + 1] * w, wz = X[a + 2] * u + X[b + 2] * w;
      const tx = X[a + 3] * u + X[b + 3] * w, ty = X[a + 4] * u + X[b + 4] * w, tz = X[a + 5] * u + X[b + 5] * w;
      const rx = P0[i * 3] - C[i * 3], ry = P0[i * 3 + 1] - C[i * 3 + 1], rz = P0[i * 3 + 2] - C[i * 3 + 2];
      P[i * 3] = P0[i * 3] + (wy * rz - wz * ry) + tx; P[i * 3 + 1] = P0[i * 3 + 1] + (wz * rx - wx * rz) + ty; P[i * 3 + 2] = P0[i * 3 + 2] + (wx * ry - wy * rx) + tz;
    }
    // 2) группы «воксель × отрезок»: моменты
    const VM = new KeyMap(n / 8 + 16), GM = new KeyMap(n / 4 + 16);
    const gid = new Int32Array(n), vOf = [];
    for (let i = 0; i < n; i++) {
      const ix = Math.floor(P[i * 3] * inv) + OFF, iy = Math.floor(P[i * 3 + 1] * inv) + OFF, iz = Math.floor(P[i * 3 + 2] * inv) + OFF;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= 65536 || iy >= 65536 || iz >= 65536) { gid[i] = -1; continue; }
      const v = VM.get((ix * 65536 + iy) * 65536 + iz, true);
      const g = GM.get(v * S + SEG[i], true); gid[i] = g; if (g === vOf.length) vOf.push(v);
    }
    const NG = GM.n, cnt = new Float64Array(NG), M = new Float64Array(NG * 9), Mt = new Float64Array(NG), Mc = new Float64Array(NG * 3), gseg = new Int32Array(NG), org = new Float64Array(NG * 3);
    for (let i = 0; i < n; i++) {
      const g = gid[i]; if (g < 0) continue;
      if (!cnt[g]) { org[g * 3] = P[i * 3]; org[g * 3 + 1] = P[i * 3 + 1]; org[g * 3 + 2] = P[i * 3 + 2]; gseg[g] = SEG[i]; }
      const x = P[i * 3] - org[g * 3], y = P[i * 3 + 1] - org[g * 3 + 1], z = P[i * 3 + 2] - org[g * 3 + 2], o = g * 9;
      cnt[g]++; M[o] += x; M[o + 1] += y; M[o + 2] += z; M[o + 3] += x * x; M[o + 4] += x * y; M[o + 5] += x * z; M[o + 6] += y * y; M[o + 7] += y * z; M[o + 8] += z * z;
      Mt[g] += T[i]; Mc[g * 3] += C[i * 3]; Mc[g * 3 + 1] += C[i * 3 + 1]; Mc[g * 3 + 2] += C[i * 3 + 2];
    }
    // плоскость каждой группы
    const ok = new Uint8Array(NG), nrm = new Float32Array(NG * 3), ctr = new Float64Array(NG * 3), ev = [0, 0, 0], vv = [0, 0, 0];
    for (let g = 0; g < NG; g++) {
      const c = cnt[g]; if (c < opt.minPts) continue; const o = g * 9;
      const mx = M[o] / c, my = M[o + 1] / c, mz = M[o + 2] / c;
      eigSym3(M[o + 3] / c - mx * mx, M[o + 4] / c - mx * my, M[o + 5] / c - mx * mz, M[o + 6] / c - my * my, M[o + 7] / c - my * mz, M[o + 8] / c - mz * mz, ev, vv);
      if (!(ev[1] > opt.planar * Math.max(ev[0], 1e-12)) || ev[0] > opt.thick * opt.thick) continue;
      ok[g] = 1; nrm[g * 3] = vv[0]; nrm[g * 3 + 1] = vv[1]; nrm[g * 3 + 2] = vv[2];
      ctr[g * 3] = org[g * 3] + mx; ctr[g * 3 + 1] = org[g * 3 + 1] + my; ctr[g * 3 + 2] = org[g * 3 + 2] + mz;
    }
    // группы по вокселям (CSR)
    const NV = VM.n, vs = new Int32Array(NV + 1);
    for (let g = 0; g < NG; g++) if (ok[g]) vs[vOf[g] + 1]++;
    for (let v = 0; v < NV; v++) vs[v + 1] += vs[v];
    const fillp = vs.slice(0, NV), lst = new Int32Array(vs[NV]);
    for (let g = 0; g < NG; g++) if (ok[g]) lst[fillp[vOf[g]]++] = g;
    // 3) связи между проходами
    let H = null, bb = null; if (build) { H = new Float64Array(NU * NU); bb = new Float64Array(NU); }
    const J = new Float64Array(24), idx = new Int32Array(24), res = [];
    let links = 0;
    const jac = (g, sign, base) => {
      const c = cnt[g], tm = Mt[g] / c, f = (tm - t0) / dt - 0.5; let a = Math.floor(f); if (a < 0) a = 0; if (a > S - 2) a = S - 2; let w = f - a; if (w < 0) w = 0; if (w > 1) w = 1;
      return [a, w, ctr[g * 3] - Mc[g * 3] / c, ctr[g * 3 + 1] - Mc[g * 3 + 1] / c, ctr[g * 3 + 2] - Mc[g * 3 + 2] / c, sign, base];
    };
    for (let v = 0; v < NV; v++) {
      const s0 = vs[v], s1 = vs[v + 1]; if (s1 - s0 < 2) continue;
      for (let p = s0; p < s1; p++) {
        const ga = lst[p]; let made = 0;
        for (let q = s0; q < s1 && made < opt.maxPairs; q++) {
          const gb = lst[q]; if (gseg[gb] - gseg[ga] < G) continue;
          let nx = nrm[ga * 3], ny = nrm[ga * 3 + 1], nz = nrm[ga * 3 + 2];
          const d = nx * nrm[gb * 3] + ny * nrm[gb * 3 + 1] + nz * nrm[gb * 3 + 2]; if (Math.abs(d) < 0.9) continue;
          const sg = d < 0 ? -1 : 1; nx += sg * nrm[gb * 3]; ny += sg * nrm[gb * 3 + 1]; nz += sg * nrm[gb * 3 + 2];
          const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
          const e = nx * (ctr[ga * 3] - ctr[gb * 3]) + ny * (ctr[ga * 3 + 1] - ctr[gb * 3 + 1]) + nz * (ctr[ga * 3 + 2] - ctr[gb * 3 + 2]);
          if (Math.abs(e) > opt.maxRes) continue;
          made++; links++; res.push(Math.abs(e));
          if (!build) continue;
          const wgt = Math.min(cnt[ga], cnt[gb]) * Math.min(1, 0.004 / Math.max(Math.abs(e), 1e-9));
          let m = 0;
          for (const [g, sign] of [[ga, 1], [gb, -1]]) {
            const [a, w, ax, ay, az] = jac(g, sign);
            // n·(ω × r) = ω·(r × n)
            const j0 = ay * nz - az * ny, j1 = az * nx - ax * nz, j2 = ax * ny - ay * nx, jv = [j0, j1, j2, nx, ny, nz];
            for (const [kn, ww] of [[a, 1 - w], [a + 1, w]]) for (let k = 0; k < 6; k++) { J[m] = sign * ww * jv[k]; idx[m] = kn * 6 + k; m++; }
          }
          for (let r = 0; r < 24; r++) {
            const jr = J[r] * wgt; if (jr === 0) continue; const ir = idx[r] * NU;
            bb[idx[r]] -= jr * e;
            for (let c2 = 0; c2 < 24; c2++) H[ir + idx[c2]] += jr * J[c2];
          }
        }
      }
    }
    res.sort((a, b) => a - b);
    const st = { links, medRes: res.length ? res[res.length >> 1] : 0, p90Res: res.length ? res[Math.floor(res.length * 0.9)] : 0 };
    return { H, b: bb, st };
  };
  for (let it = 0; it < opt.iters; it++) {
    const { H, b, st } = evalPass(true);
    if (it === 0) stats0 = st;
    if (st.links < opt.minLinks) return { ok: false, reason: 'мало мест, снятых в разных проходах (' + st.links + ')', stats: { before: st } };
    // плавность поправок во времени, слабая тяга к нулю, закрепление начала
    for (let s = 0; s < S - 1; s++) for (let k = 0; k < 6; k++) {
      const a = s * 6 + k, c = a + 6, L = opt.lambda * SC[k] * SC[k], diff = X[a] - X[c];
      H[a * NU + a] += L; H[c * NU + c] += L; H[a * NU + c] -= L; H[c * NU + a] -= L; b[a] -= L * diff; b[c] += L * diff;
    }
    for (let a = 0; a < NU; a++) { const L = 1e-3 * SC[a % 6] * SC[a % 6]; H[a * NU + a] += L; b[a] -= L * X[a]; }
    const na = Math.max(1, Math.round(opt.anchor / dt));
    for (let s = 0; s < Math.min(S, na); s++) for (let k = 0; k < 6; k++) { const a = s * 6 + k; H[a * NU + a] += 1e7; b[a] -= 1e7 * X[a]; }
    choleskySolve(H, b, NU);
    let mx = 0; for (let a = 0; a < NU; a++) { X[a] += b[a]; if (a % 6 >= 3) mx = Math.max(mx, Math.abs(b[a])); }
    if (opt.onIter) opt.onIter(it, st, mx);
    if (mx < 2e-4) break;
  }
  statsLast = evalPass(false).st;
  let maxShift = 0, maxRot = 0;
  for (let s = 0; s < S; s++) { maxShift = Math.max(maxShift, Math.hypot(X[s * 6 + 3], X[s * 6 + 4], X[s * 6 + 5])); maxRot = Math.max(maxRot, Math.hypot(X[s * 6], X[s * 6 + 1], X[s * 6 + 2])); }
  const stats = { segments: S, dt, samples: n, before: stats0, after: statsLast, maxShift, maxRot };
  if (!(maxShift <= opt.maxShift)) return { ok: false, reason: 'поправка слишком велика (' + maxShift.toFixed(2) + ' м) — траектория не сходится', stats };
  if (!(statsLast.medRes <= stats0.medRes * 1.02)) return { ok: false, reason: 'сведение не улучшило совпадение проходов', stats };
  return { ok: true, t0, dt, S, X, centers: cen, stats };
}

/** Поправка одной точки: corr(x, y, z, t, out) → out = [x', y', z']. */
function makeCorrector(sol, poseAt) {
  const { t0, dt, S, X, centers } = sol, tmp = [0, 0, 0];
  return function corr(x, y, z, t, out) {
    if (!Number.isFinite(t)) { out[0] = x; out[1] = y; out[2] = z; return out; }
    const g = (t - t0) / dt - 0.5; let a = Math.floor(g); if (a < 0) a = 0; if (a > S - 2) a = S - 2; let w = g - a; if (w < 0) w = 0; if (w > 1) w = 1;
    const u = 1 - w, A = a * 6, B = A + 6;
    let cx, cy, cz;
    if (poseAt) { poseAt(t, tmp); cx = tmp[0]; cy = tmp[1]; cz = tmp[2]; }
    else { cx = centers[a * 3] * u + centers[a * 3 + 3] * w; cy = centers[a * 3 + 1] * u + centers[a * 3 + 4] * w; cz = centers[a * 3 + 2] * u + centers[a * 3 + 5] * w; }
    const wx = X[A] * u + X[B] * w, wy = X[A + 1] * u + X[B + 1] * w, wz = X[A + 2] * u + X[B + 2] * w;
    const rx = x - cx, ry = y - cy, rz = z - cz;
    out[0] = x + (wy * rz - wz * ry) + X[A + 3] * u + X[B + 3] * w;
    out[1] = y + (wz * rx - wx * rz) + X[A + 4] * u + X[B + 4] * w;
    out[2] = z + (wx * ry - wy * rx) + X[A + 5] * u + X[B + 5] * w;
    return out;
  };
}

module.exports = { Sampler, solve, makeCorrector, eigSym3, choleskySolve, TOFF };
