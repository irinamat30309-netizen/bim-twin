'use strict';
/*
 * xbin-imu.js — r187: разбор/статистика/синхронизация IMU из .xbin (Lixel XGRIDS).
 *
 * IMU-сообщение L2 Pro (protobuf): заголовок {1: seq, 2: время (zigzag, мкс), 3: период (zigzag, мкс)};
 * поля 2..4 — accel xyz (1e-4 м/с²), 5..7 — gyro xyz (1e-4 рад/с). Температуры/статуса в сообщении нет.
 * Здесь: window(), stats(), staticBias(), syncPoses() — чистые функции для CLI и тестов.
 */

function sliceWindow(imu, t0, t1) {
  const T = imu.t, G = imu.g, A = imu.a || new Float64Array(T.length * 3);
  const out = { t: [], g: [], a: [] };
  for (let i = 0; i < T.length; i++) {
    if (T[i] < t0 || T[i] > t1) continue;
    out.t.push(T[i]);
    out.g.push(G[i * 3], G[i * 3 + 1], G[i * 3 + 2]);
    out.a.push(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]);
  }
  return { t: Float64Array.from(out.t), g: Float64Array.from(out.g), a: Float64Array.from(out.a) };
}

function median(arr) {
  if (!arr.length) return NaN;
  const b = Array.from(arr).sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : 0.5 * (b[m - 1] + b[m]);
}

function stdArr(arr) {
  const n = arr.length; if (n < 2) return 0;
  let s = 0, s2 = 0;
  for (const v of arr) { s += v; s2 += v * v; }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/** Статистика IMU-потока: частота, пропуски, диапазоны, |g|, шум (по первым разностям /√2). */
function stats(imu, opt) {
  const o = opt || {};
  const T = imu.t, G = imu.g, A = imu.a || new Float64Array(T.length * 3);
  const n = T.length;
  if (n < 2) return { samples: n, error: 'мало сэмплов' };
  const dts = [];
  let gaps = 0, gapsBig = 0, maxDt = 0, dup = 0;
  for (let i = 1; i < n; i++) { const dt = T[i] - T[i - 1]; dts.push(dt); if (dt === 0) dup++; if (dt > maxDt) maxDt = dt; }
  let minDt = Infinity; for (const dt of dts) if (dt < minDt) minDt = dt;
  const dtMed = median(dts);
  for (const dt of dts) { if (dt > dtMed * 1.5) gaps++; if (dt > dtMed * 2.5) gapsBig++; }
  const dur = T[n - 1] - T[0];
  const rate = dur > 0 ? (n - 1) / dur : 0;
  const amag = []; for (let i = 0; i < n; i++) amag.push(Math.hypot(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]));
  const axes = (arr, k) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[i * 3 + k]);
    const dif = []; for (let i = 1; i < n; i++) dif.push(out[i] - out[i - 1]);
    const noise = stdArr(dif) / Math.SQRT2;
    let mn = Infinity, mx = -Infinity, sm = 0;
    for (const v of out) { if (v < mn) mn = v; if (v > mx) mx = v; sm += v; }
    return { min: mn, max: mx, mean: sm / n, noise };
  };
  const acc = [axes(A, 0), axes(A, 1), axes(A, 2)];
  const gyr = [axes(G, 0), axes(G, 1), axes(G, 2)];
  const b = staticBias({ t: T, g: G, a: A }, o);
  return {
    samples: n, duration_s: +dur.toFixed(3), rate_hz: +rate.toFixed(2),
    dt_median_ms: +(dtMed * 1000).toFixed(3), dt_min_ms: +(minDt * 1000).toFixed(3), dt_max_ms: +(maxDt * 1000).toFixed(3),
    gaps: gaps, gaps_threshold: 'dt > 1.5 × медианы (джиттер)', gaps_big: gapsBig, gaps_big_threshold: 'dt > 2.5 × медианы (пропущенные сэмплы)', max_gap_ms: +(maxDt * 1000).toFixed(3), duplicates: dup,
    accel: { x: acc[0], y: acc[1], z: acc[2], abs_mean: amag.reduce((a, b2) => a + b2, 0) / n, abs_std: stdArr(amag),
      abs_min: amag.reduce((a, b2) => Math.min(a, b2), Infinity), abs_max: amag.reduce((a, b2) => Math.max(a, b2), -Infinity) },
    gyro: { x: gyr[0], y: gyr[1], z: gyr[2] },
    bias: b.bias || null, static: b.static, temp: null,
    period_declared_s: imu.period || null
  };
}

/** Bias гироскопа по статичным участкам (| |a|-g | < 0.25, |ω| < 0.1 рад/с, ≥0.5 с). */
function staticBias(imu, opt) {
  const o = opt || {}, T = imu.t, G = imu.g, A = imu.a;
  const n = T.length; if (!A || n < 2) return { bias: null, static: { windows: 0, duration_s: 0 } };
  const amax = o.accelTol || 0.25, wmax = o.gyroTol || 0.1, minDur = o.minStaticDur || 0.5;
  const g = 9.80665;
  let sum = [0, 0, 0], cnt = 0, windows = 0, dur = 0, start = -1;
  const flush = (iEnd) => {
    if (start >= 0) {
      const d = T[Math.min(n - 1, iEnd)] - T[start];
      if (d >= minDur) { windows++; dur += d; }
      start = -1;
    }
  };
  for (let i = 0; i < n; i++) {
    const ok = Math.abs(Math.hypot(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]) - g) < amax && Math.hypot(G[i * 3], G[i * 3 + 1], G[i * 3 + 2]) < wmax;
    if (ok) {
      if (start < 0) start = i;
      sum[0] += G[i * 3]; sum[1] += G[i * 3 + 1]; sum[2] += G[i * 3 + 2]; cnt++;
    } else { flush(i); }
  }
  flush(n - 1);
  return {
    bias: cnt ? [sum[0] / cnt, sum[1] / cnt, sum[2] / cnt] : null,
    static: { samples: cnt, windows: windows, duration_s: +dur.toFixed(3) }
  };
}

/** Позы CSV → {t, yaw} (yaw из кватерниона, развёртка). */
function posesYaw(posesText) {
  const t = [], yaw = [];
  for (const ln of String(posesText).split(/\r?\n/)) {
    const f = ln.trim().split(',');
    if (f.length < 8) continue;
    const tt = Number(f[0]); if (!Number.isFinite(tt)) continue;
    const qx = Number(f[4]), qy = Number(f[5]), qz = Number(f[6]), qw = Number(f[7]);
    if (![qx, qy, qz, qw].every(Number.isFinite)) continue;
    t.push(tt); yaw.push(Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)));
  }
  let prev = yaw[0] || 0;
  for (let i = 0; i < yaw.length; i++) { let d = yaw[i] - prev; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); yaw[i] = (i ? yaw[i - 1] : 0) + d; prev = yaw[i]; }
  return { t, yaw };
}

function interp(t, v, tt) {
  if (tt <= t[0]) return v[0];
  if (tt >= t[t.length - 1]) return v[v.length - 1];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= tt) lo = m; else hi = m; }
  const a = (tt - t[lo]) / Math.max(1e-12, t[hi] - t[lo]);
  return v[lo] * (1 - a) + v[hi] * a;
}

/**
 * Синхронизация xbin↔poses по форме интеграла гироскопа и yaw из поз:
 * ищем сдвиг shift (с), при котором корреляция максимальна (снимаем линейный тренд).
 */
function syncPoses(imu, posesText, opt) {
  const o = opt || {}, maxShift = o.maxShift || 2.0, step = o.step || 0.001, rate = o.rate || 20;
  const P = posesYaw(posesText);
  if (P.t.length < 10 || imu.t.length < 100) return { error: 'мало данных для синхронизации', shift_ms: null };
  const t0 = Math.max(imu.t[0], P.t[0]), t1 = Math.min(imu.t[imu.t.length - 1], P.t[P.t.length - 1]);
  if (!(t1 > t0 + 5)) return { error: 'нет общего окна', shift_ms: null };
  // интеграл gz (yaw-rate в проекции на вертикаль; для камеры с креном грубо, но форму ловит)
  const G = imu.g, T = imu.t;
  const yawCum = new Float64Array(T.length);
  let acc = 0;
  for (let i = 1; i < T.length; i++) { acc += 0.5 * (G[(i - 1) * 3 + 2] + G[i * 3 + 2]) * (T[i] - T[i - 1]); yawCum[i] = acc; }
  // сетка 20 Гц: imuYaw(t + shift) vs poseYaw(t)
  const N = Math.floor((t1 - t0) * rate); if (N < 100) return { error: 'короткое окно', shift_ms: null };
  const ig = new Float64Array(N), pg = new Float64Array(N);
  for (let k = 0; k < N; k++) { const tt = t0 + k / rate; pg[k] = interp(P.t, P.yaw, tt); }
  const detrend = (arr) => {
    const n = arr.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += arr[i]; sxx += i * i; sxy += i * arr[i]; }
    const den = n * sxx - sx * sx;
    const b = den ? (n * sxy - sx * sy) / den : 0, a = (sy - b * sx) / n;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[i] - (a + b * i);
    return out;
  };
  const pgd = detrend(pg);
  let best = { corr: -2, shift: 0 };
  const nSh = Math.round(2 * maxShift / step);
  const sample = new Float64Array(N);
  for (let s = -nSh; s <= nSh; s++) {
    const sh = s * step;
    let okAll = true;
    for (let k = 0; k < N; k++) {
      const tt = t0 + k / rate;
      if (tt + sh < T[0] || tt + sh > T[T.length - 1]) { okAll = false; break; }
      sample[k] = interp(T, yawCum, tt + sh);
    }
    if (!okAll) continue;
    const igd = detrend(sample);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let k = 0; k < N; k++) { const a = igd[k], b = pgd[k]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
    const va = saa / N - (sa / N) ** 2, vb = sbb / N - (sb / N) ** 2, cov = sab / N - (sa / N) * (sb / N);
    const corr = (va > 0 && vb > 0) ? cov / Math.sqrt(va * vb) : 0;
    if (corr > best.corr) best = { corr, shift: sh };
  }
  // уточнение параболой
  return { shift_ms: +(best.shift * 1000).toFixed(2), corr: +best.corr.toFixed(4), max_shift_s: maxShift, rate_hz: rate,
    note: 'корреляция формы интеграла gz и yaw из poses; shift — сколько добавить к времени xbin, чтобы совпасть с poses (минус — xbin-часы впереди poses на |shift|)' };
}

module.exports = { sliceWindow, stats, staticBias, posesYaw, syncPoses, median };
