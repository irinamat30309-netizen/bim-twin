'use strict';
/*
 * color-balance-core.js — ревизия 21: «ровный цвет», как после пересчёта в Lixel Studio.
 *   Realtime-карта сканера красит точки кадрами камеры с автоэкспозицией: проход по солнечной стороне двора темнее,
 *   под навесом — светлее, и там, где проходы перекрываются, стена становится «рябой» (соседние точки из разных проходов
 *   отличаются по яркости в 1,5–2 раза). Здесь по выборке точек (та же, что для сведения проходов) подбирается усиление
 *   каждого отрезка времени (10 с, по каналам R/G/B, в логарифмах): одна и та же ячейка 15 см, увиденная в разных
 *   проходах, должна иметь один цвет; усиления меняются плавно, их среднее — 1 (общая яркость не «уезжает»).
 *   Затем — нейтральный баланс белого (серые поверхности — бетон, асфальт, штукатурка — должны быть серыми) и, если
 *   облако заметно тёмное (медиана яркости ниже 110), мягкое осветление гаммой (у Lixel медиана яркости ≈128 из 255, у realtime-карты ≈94).
 *   Ревизия 46: вместо гаммы — тоновая кривая, как у Lixel Studio (сверено по 58 тыс. ячеек 10 см фасада): тени не трогаются
 *   (до точки «тёмного» — 10-го процентиля яркости), середина — линейное усиление (до медианы ≈140, не больше ×1,4), светлые — мягкое плечо
 *   от 170 до 255. Гамма поднимала тени вдвое (54 → у Lixel 29), картинка становилась «молочной», без контраста. Кривая — по яркости
 *   (оттенок не меняется), затем цветность × saturation (в чистовой обработке 0,8: realtime-карта пестрее Lixel).
 *   Точки без цвета (0,0,0 — тёмный или пропущенный пиксель кадра) в расчёт не входят: раньше они тянули усиления проходов вниз.
 * solve(smp, opt) → модель; makeColorFix(model) → fix(t, rgb, k): правит rgb[k..k+2] (0–255) на месте.
 */

// плотный SPD-решатель: H (n×n) раскладывается на месте, B (n×nr) — правые части, решение на месте
function cholSolveMulti(H, B, n, nr) {
  for (let j = 0; j < n; j++) {
    const rj = j * n; let s = H[rj + j];
    for (let k = 0; k < j; k++) s -= H[rj + k] * H[rj + k];
    if (!(s > 0)) s = 1e-12;
    const d = Math.sqrt(s); H[rj + j] = d; const inv = 1 / d;
    for (let i = j + 1; i < n; i++) { const ri = i * n; let t = H[ri + j]; for (let k = 0; k < j; k++) t -= H[ri + k] * H[rj + k]; H[ri + j] = t * inv; }
  }
  for (let c = 0; c < nr; c++) {
    for (let i = 0; i < n; i++) { const ri = i * n; let s = B[i * nr + c]; for (let k = 0; k < i; k++) s -= H[ri + k] * B[k * nr + c]; B[i * nr + c] = s / H[ri + i]; }
    for (let i = n - 1; i >= 0; i--) { let s = B[i * nr + c]; for (let k = i + 1; k < n; k++) s -= H[k * n + i] * B[k * nr + c]; B[i * nr + c] = s / H[i * n + i]; }
  }
  return B;
}
function median(a) { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; }

/**
 * smp: { n, X (x,y,z), T, C (r,g,b в исходной шкале) }, opt: { scale (1 или 1/256), dt (10 с), voxel (0,15 м), smooth (2),
 *   exposure (true), neutral (true), brighten (true) }.
 */
function solve(smp, opt) {
  opt = Object.assign({ scale: 1, dt: 10, voxel: 0.15, smooth: 2, exposure: true, neutral: true, brighten: true, minPerEntry: 3, tone: 'curve', toneMode: 'lum', saturation: 1 }, opt || {});
  const n = smp.n, X = smp.X, T = smp.T, C = smp.C, sc = opt.scale;
  const res = { ok: false, S: 1, t0: 0, dt: opt.dt, g: new Float32Array(3), wb: [1, 1, 1], gamma: 1, tone: null, stats: { segments: 0, before: 0, after: 0, gainMin: 1, gainMax: 1 } };
  if (!C || n < 1000) { res.reason = 'мало точек с цветом'; return res; }
  // ревизия 46: точки без цвета (0,0,0) — не наблюдение цвета
  const noc = opt.skipNoColor === false ? () => false : (i) => C[i * 3] === 0 && C[i * 3 + 1] === 0 && C[i * 3 + 2] === 0;
  // ---- 1: экспозиция отрезков
  let t0 = Infinity, t1 = -Infinity;
  if (T && opt.exposure) for (let i = 0; i < n; i++) { const t = T[i]; if (t < t0) t0 = t; if (t > t1) t1 = t; }
  let dt = opt.dt, S = Number.isFinite(t0) && t1 > t0 ? Math.floor((t1 - t0) / dt) + 1 : 1;
  if (S > 2000) { dt = (t1 - t0) / 1999; S = 2000; }
  res.t0 = Number.isFinite(t0) ? t0 : 0; res.dt = dt;
  if (S >= 3) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    for (let i = 0; i < n; i++) { if (X[i * 3] < mnx) mnx = X[i * 3]; if (X[i * 3 + 1] < mny) mny = X[i * 3 + 1]; if (X[i * 3 + 2] < mnz) mnz = X[i * 3 + 2]; }
    const V = opt.voxel, vmap = new Map(), vid = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.floor((X[i * 3] - mnx) / V) + 1048576 * (Math.floor((X[i * 3 + 1] - mny) / V) + 1048576 * Math.min(8191, Math.floor((X[i * 3 + 2] - mnz) / V)));
      let v = vmap.get(k); if (v === undefined) { v = vmap.size; vmap.set(k, v); } vid[i] = v;
    }
    const m = vmap.size; vmap.clear();
    const st = new Int32Array(m + 1), ord = new Int32Array(n);
    for (let i = 0; i < n; i++) st[vid[i] + 1]++;
    for (let j = 0; j < m; j++) st[j + 1] += st[j];
    { const p = st.slice(0, m); for (let i = 0; i < n; i++) ord[p[vid[i]]++] = i; }
    // записи (ячейка × отрезок): средний логарифм цвета; ячейки, увиденные хотя бы в двух отрезках
    const slot = new Int32Array(S).fill(-1), Es = [], Ec = [], El = [], Ev = [];
    const ls = [], cs = [], segs = [];
    for (let j = 0; j < m; j++) {
      segs.length = 0;
      for (let q = st[j]; q < st[j + 1]; q++) {
        const i = ord[q]; if (noc(i)) continue;
        const s = Math.min(S - 1, Math.floor((T[i] - t0) / dt));
        let k = slot[s]; if (k < 0) { k = slot[s] = segs.length; segs.push(s); cs[k] = 0; ls[k * 3] = ls[k * 3 + 1] = ls[k * 3 + 2] = 0; }
        cs[k]++; for (let a = 0; a < 3; a++) ls[k * 3 + a] += Math.log(Math.max(4, C[i * 3 + a] * sc));
      }
      let good = 0; for (let k = 0; k < segs.length; k++) if (cs[k] >= opt.minPerEntry) good++;
      if (good >= 2) for (let k = 0; k < segs.length; k++) { if (cs[k] < opt.minPerEntry) continue; Es.push(segs[k]); Ec.push(cs[k]); Ev.push(j); for (let a = 0; a < 3; a++) El.push(ls[k * 3 + a] / cs[k]); }
      for (let k = 0; k < segs.length; k++) slot[segs[k]] = -1;
    }
    const E = Es.length;
    if (E >= 200) {
      const w = new Float64Array(E), g = new Float64Array(S * 3), rr = new Float64Array(E);
      for (let e = 0; e < E; e++) w[e] = Math.min(Ec[e], 20);
      const resid = (gg) => {   // средний по каналам |отклонение от среднего ячейки|
        for (let e0 = 0; e0 < E;) {
          let e1 = e0, W = 0; const mu = [0, 0, 0];
          while (e1 < E && Ev[e1] === Ev[e0]) { W += w[e1]; for (let a = 0; a < 3; a++) mu[a] += w[e1] * (El[e1 * 3 + a] - gg[Es[e1] * 3 + a]); e1++; }
          for (let e = e0; e < e1; e++) { let s = 0; for (let a = 0; a < 3; a++) s += Math.abs(El[e * 3 + a] - gg[Es[e] * 3 + a] - mu[a] / W); rr[e] = s / 3; }
          e0 = e1;
        }
        return rr;
      };
      const before = median(resid(g));
      const base = Float64Array.from(w);
      for (let it = 0; it < 3; it++) {
        if (it > 0) { resid(g); for (let e = 0; e < E; e++) w[e] = base[e] * (rr[e] < 0.15 ? 1 : 0.15 / rr[e]); }
        const H = new Float64Array(S * S), B = new Float64Array(S * 3);
        for (let e0 = 0; e0 < E;) {
          let e1 = e0, W = 0; const wl = [0, 0, 0];
          while (e1 < E && Ev[e1] === Ev[e0]) { W += w[e1]; for (let a = 0; a < 3; a++) wl[a] += w[e1] * El[e1 * 3 + a]; e1++; }
          for (let p = e0; p < e1; p++) {
            const sp = Es[p], wp = w[p]; H[sp * S + sp] += wp;
            for (let a = 0; a < 3; a++) B[sp * 3 + a] += wp * (El[p * 3 + a] - wl[a] / W);
            for (let q = e0; q < e1; q++) H[sp * S + Es[q]] -= wp * w[q] / W;
          }
          e0 = e1;
        }
        const dg = []; for (let s = 0; s < S; s++) if (H[s * S + s] > 1e-9) dg.push(H[s * S + s]);
        const md = median(dg) || 1, lam = opt.smooth * md, ridge = 1e-3 * md;
        for (let s = 0; s < S; s++) { H[s * S + s] += ridge; if (s + 1 < S) { H[s * S + s] += lam; H[(s + 1) * S + s + 1] += lam; H[s * S + s + 1] -= lam; H[(s + 1) * S + s] -= lam; } }
        cholSolveMulti(H, B, S, 3); g.set(B);
      }
      // среднее усиление по точкам — 1
      const cnt = new Float64Array(S); for (let i = 0; i < n; i++) cnt[Math.min(S - 1, Math.floor((T[i] - t0) / dt))]++;
      for (let a = 0; a < 3; a++) { let sw = 0, sg = 0; for (let s = 0; s < S; s++) { sw += cnt[s]; sg += cnt[s] * g[s * 3 + a]; } const mu = sg / Math.max(1, sw); for (let s = 0; s < S; s++) g[s * 3 + a] = Math.max(-0.92, Math.min(0.92, g[s * 3 + a] - mu)); }
      const after = median(resid(g));
      res.stats.before = before; res.stats.after = after; res.stats.links = E;
      if (after < before * 0.97) {
        res.S = S; res.g = new Float32Array(g); res.stats.segments = S;
        let lo = Infinity, hi = -Infinity; for (let s = 0; s < S; s++) { const v = (g[s * 3] + g[s * 3 + 1] + g[s * 3 + 2]) / 3; if (cnt[s] > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        res.stats.gainMin = Math.exp(-hi); res.stats.gainMax = Math.exp(-lo);
      } else res.stats.exposureSkipped = 'перепадов яркости между проходами нет';
    } else res.stats.exposureSkipped = 'мало повторно снятых участков';
  } else res.stats.exposureSkipped = T && opt.exposure ? 'съёмка слишком короткая' : 'нет времени точек';
  // ---- 2: баланс белого и яркость (после выравнивания экспозиции)
  if (opt.neutral || opt.brighten) {
    const fix = makeColorFix(Object.assign({}, res, { wb: [1, 1, 1], gamma: 1, tone: null })), c = [0, 0, 0];
    const step = Math.max(1, Math.floor(n / 400000)), NB = 1024, hist = [new Float64Array(NB), new Float64Array(NB), new Float64Array(NB)], hl = new Float64Array(NB);
    let nn = 0, tot = 0;
    for (let i = 0; i < n; i += step) {
      if (noc(i)) continue;
      c[0] = C[i * 3] * sc; c[1] = C[i * 3 + 1] * sc; c[2] = C[i * 3 + 2] * sc; fix(T ? T[i] : 0, c, 0);
      const L = (c[0] + c[1] + c[2]) / 3, mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]); tot++;
      if (L > 30 && L < 230 && (mx - mn) < 0.15 * L) { nn++; for (let a = 0; a < 3; a++) hist[a][Math.min(NB - 1, Math.floor(c[a] / 256 * NB))]++; }
      hl[Math.min(NB - 1, Math.floor(L / 256 * NB))]++;
    }
    const hq = (h, q) => { let s = 0, t = 0; for (const v of h) t += v; for (let b = 0; b < NB; b++) { s += h[b]; if (s >= t * q) return (b + 0.5) / NB * 256; } return 128; };
    const hmed = (h) => hq(h, 0.5);
    if (opt.neutral && nn >= 1000 && nn >= 0.02 * tot) {
      const md = hist.map(hmed), avg = (md[0] + md[1] + md[2]) / 3;
      res.wb = md.map(v => Math.max(0.85, Math.min(1.18, avg / Math.max(1, v))));
    }
    if (opt.brighten) {
      const wm = (res.wb[0] + res.wb[1] + res.wb[2]) / 3, mL = hmed(hl) * wm;
      if (opt.tone === 'gamma') { if (mL > 5 && mL < 110) res.gamma = Math.max(0.6, Math.min(1, Math.log(0.5) / Math.log(mL / 255))); }
      else if (mL > 5 && mL < 120) {
        // ревизия 46: тоновая кривая — тени как есть, середина ×gain (медиана → ≈140, не больше ×1,4: у Lixel кривая почти постоянная, ×1,36–1,38 и на фасаде, и во дворе), плечо до 255
        const gain = Math.max(1, Math.min(opt.toneGainMax || 1.4, (opt.toneTarget || 140) / mL)), dark = Math.max(6, Math.min(50, hq(hl, 0.1) * wm));
        if (gain > 1.03) res.tone = { gain: Math.round(gain * 1000) / 1000, dark: Math.round(dark * 10) / 10, knee: opt.toneKnee || 170 };
        if (res.tone) res.tone.mode = opt.toneMode === 'channel' ? 'channel' : 'lum';
      }
    }
  }
  res.stats.wb = res.wb.map(v => Math.round(v * 1000) / 1000); res.stats.gamma = Math.round(res.gamma * 1000) / 1000;
  if (res.tone) res.stats.tone = Object.assign({}, res.tone);
  // ревизия 46: насыщенность (у Lixel Studio цвет спокойнее realtime-карты: медиана цветности ячеек 10 см на фасаде и во дворе —
  // 0,77 и 0,66 от realtime, после выравнивания баланса — 0,82 и 0,75); 1 — без изменений
  if (opt.saturation > 0 && Math.abs(opt.saturation - 1) > 0.005) { res.sat = Math.max(0.3, Math.min(1.5, opt.saturation)); res.stats.sat = res.sat; }
  res.ok = res.S > 1 || res.gamma < 0.999 || !!res.tone || !!res.sat || res.wb.some(v => Math.abs(v - 1) > 0.01);
  if (!res.ok) res.reason = 'цвет уже ровный';
  return res;
}

/**
 * Ревизия 46: тоновая кривая { gain, dark, knee } → таблица 0…256 (4097 узлов): до dark — без изменений, затем наклон gain до
 * уровня knee, дальше прямая до (255, 255); изломы сглажены (скользящее среднее ±6 единиц), кривая монотонная.
 */
function toneLUT(tn) {
  const N = 4097, raw = new Float64Array(N), d = tn.dark, g = tn.gain, K = Math.max(d + 10, Math.min(240, tn.knee || 170));
  const vk = d + (K - d) / g;   // вход, на котором кривая достигает knee
  for (let k = 0; k < N; k++) {
    const v = k / 16;
    raw[k] = v <= d ? v : (v <= vk ? d + g * (v - d) : K + (255 - K) * (v - vk) / Math.max(1e-6, 256 - vk));
  }
  const L = new Float32Array(N), w = 96; let s = 0;   // ±6 единиц
  const at = (k) => k < 0 ? raw[0] + (raw[1] - raw[0]) * k : (k >= N ? raw[N - 1] + (raw[N - 1] - raw[N - 2]) * (k - N + 1) : raw[k]);
  for (let k = -w; k <= w; k++) s += at(k);
  for (let k = 0; k < N; k++) { L[k] = Math.max(0, Math.min(255, s / (2 * w + 1))); s += at(k + w + 1) - at(k - w); }
  L[0] = 0; for (let k = 1; k < N; k++) if (L[k] < L[k - 1]) L[k] = L[k - 1];
  return L;
}
// o.noTone: без тоновой кривой (её накладывает makeToneFix — после очистки цвета, ревизия 46)
function makeColorFix(sol, o) {
  const S = sol.S, g = sol.g, t0 = sol.t0, dt = sol.dt, wb = sol.wb, gm = sol.gamma;
  const LUT = new Float32Array(4097); for (let k = 0; k <= 4096; k++) LUT[k] = gm === 1 ? k / 16 : 255 * Math.pow(k / 4096, gm);
  const late = o && o.noTone ? null : makeToneFix(sol);   // кривая и насыщенность — здесь же, если их не накладывают позже
  const m = [1, 1, 1];
  return function fix(t, rgb, k) {
    if (S > 1) {
      let u = (t - t0) / dt - 0.5; if (!(u > 0)) u = 0; else if (u > S - 1) u = S - 1;
      const i0 = Math.floor(u), i1 = Math.min(S - 1, i0 + 1), f = u - i0;
      for (let a = 0; a < 3; a++) m[a] = Math.exp(-(g[i0 * 3 + a] * (1 - f) + g[i1 * 3 + a] * f)) * wb[a];
    } else { m[0] = wb[0]; m[1] = wb[1]; m[2] = wb[2]; }
    for (let a = 0; a < 3; a++) { let v = rgb[k + a] * m[a]; if (!(v > 0)) v = 0; else if (v > 255) v = 255; const q = v * 16, i = Math.floor(q); rgb[k + a] = i >= 4096 ? LUT[4096] : LUT[i] + (LUT[i + 1] - LUT[i]) * (q - i); }
    if (late) late(rgb, k);
  };
}

/**
 * Ревизия 46: тоновая кривая и насыщенность решения → fix(rgb, k) на месте; null — нечего менять.
 * mode 'lum' (по умолчанию): кривая по яркости, каналы масштабируются вместе — оттенок и цветность не меняются (по каналам
 * тени становились пёстрее: сходство с Lixel 0,2422 → 0,2397); у светлых каналов — не выше их собственной кривой, чтобы
 * голубое и белое не «выгорали» в 255. 'channel' — кривая по каждому каналу. Затем цветность × sat вокруг яркости.
 */
function makeToneFix(sol) {
  const hasTone = !!(sol && sol.tone && sol.tone.gain > 1), sat = sol && sol.sat > 0 && Math.abs(sol.sat - 1) > 0.005 ? sol.sat : 1;
  if (!hasTone && sat === 1) return null;
  const LUT = hasTone ? toneLUT(sol.tone) : null, lum = hasTone && sol.tone.mode !== 'channel';
  const at = (v) => { if (!(v > 0)) return 0; if (v > 255) v = 255; const q = v * 16, i = Math.floor(q); return i >= 4096 ? LUT[4096] : LUT[i] + (LUT[i + 1] - LUT[i]) * (q - i); };
  return function tone(rgb, k) {
    if (hasTone) {
      if (lum) {
        const L = 0.3 * rgb[k] + 0.59 * rgb[k + 1] + 0.11 * rgb[k + 2];
        if (L > 0.5) { const f = at(L) / L; for (let a = 0; a < 3; a++) { const v0 = rgb[k + a]; let v = v0 * f; if (v0 > L) { const c = at(v0); if (v > c) v = c; } rgb[k + a] = v > 255 ? 255 : (v > 0 ? v : 0); } }
      } else for (let a = 0; a < 3; a++) rgb[k + a] = at(rgb[k + a]);
    }
    if (sat !== 1) {
      const L = 0.3 * rgb[k] + 0.59 * rgb[k + 1] + 0.11 * rgb[k + 2];
      for (let a = 0; a < 3; a++) { const v = L + sat * (rgb[k + a] - L); rgb[k + a] = v > 255 ? 255 : (v > 0 ? v : 0); }
    }
  };
}

module.exports = { solve, makeColorFix, makeToneFix, cholSolveMulti, toneLUT };
