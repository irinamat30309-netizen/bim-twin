'use strict';
/*
 * scan2bim-core.js — BIM-модель по облаку точек (ревизия 40), чистые функции для потока (scan2bim-job.js) и тестов.
 *
 * Как строится модель (по мотивам Cloud2BIM, Nezerka et al., Automation in Construction 2025, и Scan-to-BIM CVPR 2024; без нейросетей):
 *   проход 1 — колонки занятости: план 5 см, у каждой клетки — битовая маска занятых полос высоты (25 см и крупнее), число точек, цвет;
 *              гистограмма высот 1 см → этажи (пики горизонтальных поверхностей с шагом этажа);
 *   разбор 1 — по каждому этажу клетки, занятые по высоте этажа не меньше чем на 60 %, — «вертикальные» (стены, колонны, витражи);
 *              связные области: мелкие и компактные — колонны, растительность (зелёный цвет, рыхлая крона) — в стороне;
 *   проход 2 — точки вертикальных клеток каждого этажа → план (renderer/auto-plan.js: грани с точностью до миллиметров, толщины, проёмы);
 *              точки колонн → сечение (круг или прямоугольник), точки кривых стен → дуги;
 *   проход 3 — «развёртка» каждой стены (вдоль × по высоте, 5 см): плотность, смещение от плоскости, цвет, интенсивность → проёмы (окна,
 *              двери, ворота — по подоконнику и высоте), витражи, материал по участкам, неровность (СКО) и отклонение от вертикали;
 *   итог — модель: этажи, стены (ось, толщина, высота, материал, точность), проёмы, перекрытия (контур по стенам), колонны, прочие объекты.
 *
 * Координаты — плановые (u — восток, v — север, h — вверх от низа облака, как у cloud-overview); отметки этажей в модели — и в h,
 * и абсолютные (z = h + cz).
 */

const DEG = Math.PI / 180;
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function median(arr) { if (!arr.length) return NaN; const s = Float64Array.from(arr).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function quant(arr, p) { if (!arr.length) return NaN; const s = Float64Array.from(arr).sort(); return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)]; }
function popc(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }

// ------------------------------------------------------------------ проход 1: колонки занятости
function columnAcc(bbox, opts) {
  opts = opts || {};
  const pad = 0.3, u0 = bbox.u0 - pad, v0 = bbox.v0 - pad, W0 = bbox.u1 - bbox.u0 + 2 * pad, D0 = bbox.v1 - bbox.v0 + 2 * pad;
  const maxCells = opts.maxCells || 9e6;
  let cell = opts.cell || 0.05;
  while ((W0 / cell) * (D0 / cell) > maxCells) cell *= 1.25;
  const nx = Math.max(1, Math.ceil(W0 / cell)), ny = Math.max(1, Math.ceil(D0 / cell)), N = nx * ny;
  const h0 = bbox.h0 - 0.05, H = Math.max(1, bbox.h1 - h0 + 0.1);
  let W = 1; while (W < 6 && H / (32 * W) > 0.25) W++;
  const NB = 32 * W, dz = Math.max(0.25, H / NB);
  const occ = new Uint32Array(N * W), cnt = new Uint32Array(N), rgb = opts.color === false ? null : new Float32Array(N * 3);
  const hs = 0.01, nh = Math.min(400000, Math.ceil(H / hs) + 1), hist = new Uint32Array(nh);
  let n = 0, colored = 0;
  return {
    u0, v0, nx, ny, cell, h0, dz, NB, W, occ, cnt, rgb, hist, hs,
    add(u, v, h, o) {
      const x = Math.floor((u - u0) / cell), y = Math.floor((v - v0) / cell); if (x < 0 || y < 0 || x >= nx || y >= ny) return;
      const c = y * nx + x; cnt[c]++; n++;
      let b = Math.floor((h - h0) / dz); if (b < 0) b = 0; else if (b >= NB) b = NB - 1;
      occ[c * W + (b >> 5)] |= 1 << (b & 31);
      const hb = Math.floor((h - h0) / hs); if (hb >= 0 && hb < nh) hist[hb]++;
      if (rgb && o && o.r === o.r) { rgb[c * 3] += o.r; rgb[c * 3 + 1] += o.g; rgb[c * 3 + 2] += o.b; colored++; }
    },
    count() { return n; },
    hasColor() { return colored > n * 0.5; }
  };
}
// доля занятых полос клетки c между h0 и h1
function coverage(A, c, ha, hb) {
  const b0 = clamp(Math.floor((ha - A.h0) / A.dz), 0, A.NB - 1), b1 = clamp(Math.ceil((hb - A.h0) / A.dz), b0 + 1, A.NB);
  let k = 0; const base = c * A.W;
  for (let b = b0; b < b1; b++) if (A.occ[base + (b >> 5)] >>> (b & 31) & 1) k++;
  return k / (b1 - b0);
}
// верхняя занятая полоса клетки (высота верха), NaN — пусто
function cellTop(A, c) {
  const base = c * A.W;
  for (let w = A.W - 1; w >= 0; w--) { const x = A.occ[base + w]; if (x) return A.h0 + (w * 32 + 31 - Math.clz32(x) + 1) * A.dz; }
  return NaN;
}
function cellBottom(A, c) {
  const base = c * A.W;
  for (let w = 0; w < A.W; w++) { const x = A.occ[base + w]; if (x) return A.h0 + (w * 32 + (31 - Math.clz32(x & -x))) * A.dz; }
  return NaN;
}
// верх сплошной колонки от низа клетки (разрывы не больше gap полос): шкаф под стрелой крана — 2,5 м, а не высота стрелы
function cellRunTop(A, c, gap) {
  gap = gap == null ? 3 : gap; const base = c * A.W; let last = -1, miss = 0;
  for (let b = 0; b < A.NB; b++) {
    if (A.occ[base + (b >> 5)] >>> (b & 31) & 1) { last = b; miss = 0; }
    else if (last >= 0 && ++miss > gap) break;
  }
  return last < 0 ? NaN : A.h0 + (last + 1) * A.dz;
}
// растительность: средний цвет клетки — зелёный (листва, трава)
function isGreen(A, c) {
  if (!A.rgb || !A.cnt[c]) return false;
  const k = A.cnt[c], r = A.rgb[c * 3] / k, g = A.rgb[c * 3 + 1] / k, b = A.rgb[c * 3 + 2] / k;
  return g > r * 1.06 && g > b * 1.04 && (Math.max(r, g, b) - Math.min(r, g, b)) > 14;
}

// ------------------------------------------------------------------ этажи
// пики гистограммы высот (горизонтальные поверхности); цепочка с шагом этажа 2,4–6 м от главного (нижнего) уровня
function histPeaks(hist, h0, hs, opts) {
  opts = opts || {};
  const nb = hist.length, sm = new Float64Array(nb), w = Math.max(1, Math.round(0.02 / hs));
  for (let i = 0; i < nb; i++) { let s = 0; for (let k = -w; k <= w; k++) { const j = i + k; if (j >= 0 && j < nb) s += hist[j]; } sm[i] = s; }
  const nz = []; for (let i = 0; i < nb; i++) if (sm[i] > 0) nz.push(sm[i]);
  const med = median(nz) || 0, R = Math.max(2, Math.round(0.15 / hs)), out = [];
  for (let i = 1; i < nb - 1; i++) {
    if (sm[i] <= med * (opts.k || 2.5)) continue;
    let ok = true; for (let k = -R; k <= R && ok; k++) { const j = i + k; if (k && j >= 0 && j < nb && (sm[j] > sm[i] || (sm[j] === sm[i] && k < 0))) ok = false; }
    if (!ok) continue;
    // уточнение: центр тяжести ±2 см
    let s = 0, m = 0; for (let k = -2 * w; k <= 2 * w; k++) { const j = i + k; if (j >= 0 && j < nb) { s += hist[j]; m += hist[j] * (j + 0.5); } }
    out.push({ h: h0 + (s ? m / s : i + 0.5) * hs, n: sm[i], rel: sm[i] / Math.max(1, med) });
  }
  return { peaks: out, median: med };
}
function storeysFrom(peaks, opts) {
  opts = opts || {};
  const top = opts.top, minH = opts.minStorey || 2.4, maxH = opts.maxStorey || 6.0;
  if (!peaks.length) return { ground: NaN, levels: [] };
  const maxN = peaks.reduce((m, p) => Math.max(m, p.n), 0);
  // нижний уровень: самый сильный пик в нижней части здания (не ниже 30 % от самого сильного)
  const strong = peaks.filter((p) => p.n >= maxN * 0.3).sort((a, b) => a.h - b.h);
  const g = opts.ground != null ? { h: opts.ground, n: maxN } : strong[0];
  const lv = [{ h: g.h, n: g.n, kind: 'floor' }];
  let cur = g.h, step = NaN;
  for (let it = 0; it < 80; it++) {
    const cand = peaks.filter((p) => p.h >= cur + minH && p.h <= cur + maxH && (!(top > 0) || p.h < top - 0.5));
    if (!cand.length) break;
    const best = cand.reduce((m, p) => p.n > m.n ? p : m, cand[0]);
    let pick = best;
    if (step === step) {
      // знакомый шаг: пик у cur + step (±0,35 м), если он не слабее 15 % сильнейшего в окне
      const near = cand.filter((p) => Math.abs(p.h - cur - step) <= 0.35 && p.n >= best.n * 0.15);
      if (near.length) pick = near.reduce((m, p) => p.n > m.n ? p : m, near[0]);
    }
    if (pick.n < maxN * (opts.minRel || 0.004)) break;
    lv.push({ h: pick.h, n: pick.n, kind: 'floor' });
    step = lv.length >= 3 ? median(lv.slice(1).map((x, i) => x.h - lv[i].h)) : pick.h - cur;
    cur = pick.h;
  }
  return { ground: g.h, levels: lv };
}

// ------------------------------------------------------------------ вертикальные клетки этажа и их области
function storeyMask(A, ha, hb, opts) {
  opts = opts || {};
  const N = A.nx * A.ny, m = new Uint8Array(N), thr = opts.cover || 0.6;
  const lo = ha + Math.min(0.3, (hb - ha) * 0.1), hi = hb - Math.min(0.3, (hb - ha) * 0.1);
  for (let c = 0; c < N; c++) {
    if (!A.cnt[c]) continue;
    if (coverage(A, c, lo, hi) >= thr) m[c] = isGreen(A, c) ? 2 : 1;
  }
  return m;
}
// связные области клеток со значением 1 (8 соседей); выход — метки и сведения
function components(mask, nx, ny, val) {
  const N = nx * ny, lab = new Int32Array(N).fill(-1), list = [], st = new Int32Array(N);
  val = val || 1;
  for (let s = 0; s < N; s++) {
    if (mask[s] !== val || lab[s] >= 0) continue;
    const id = list.length; let sp = 0, n = 0, x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    st[sp++] = s; lab[s] = id;
    while (sp) {
      const c = st[--sp], x = c % nx, y = (c - x) / nx; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= ny) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= nx) continue; const k = yy * nx + xx; if (mask[k] === val && lab[k] < 0) { lab[k] = id; st[sp++] = k; } } }
    }
    list.push({ id, n, x0, x1, y0, y1 });
  }
  return { lab, list };
}

// расширение маски на r клеток (значение val → val, прочие не трогаются)
function dilate(mask, nx, ny, r, val) {
  val = val || 1; let cur = mask;
  for (let it = 0; it < r; it++) {
    const nm = Uint8Array.from(cur);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = y * nx + x; if (cur[c] !== val) continue;
      if (x > 0 && !nm[c - 1]) nm[c - 1] = val; if (x < nx - 1 && !nm[c + 1]) nm[c + 1] = val;
      if (y > 0 && !nm[c - nx]) nm[c - nx] = val; if (y < ny - 1 && !nm[c + nx]) nm[c + nx] = val;
    }
    cur = nm;
  }
  return cur;
}
// накопитель точек (u, v) с прореживанием: при переполнении — каждая вторая, дальше каждая 2^k-я
function uvCollector(maxPts) {
  let cap = Math.min(maxPts, 1 << 16), uv = new Float32Array(cap * 2), n = 0, stride = 1, tick = 0;
  return {
    add(u, v) {
      if (stride > 1 && (++tick % stride)) return;
      if (n >= cap) {
        if (cap < maxPts) { const nc = Math.min(maxPts, cap * 2), a = new Float32Array(nc * 2); a.set(uv); uv = a; cap = nc; }
        else { let w = 0; for (let k = 0; k < n; k += 2) { uv[w * 2] = uv[k * 2]; uv[w * 2 + 1] = uv[k * 2 + 1]; w++; } n = w; stride *= 2; }
      }
      uv[n * 2] = u; uv[n * 2 + 1] = v; n++;
    },
    get() { return uv.subarray(0, n * 2); }, count() { return n; }, stride() { return stride; }
  };
}

// ------------------------------------------------------------------ примитивы плана: прямые и дуги (RANSAC + МНК)
function rng(seed) { let x = (seed >>> 0) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function lineLS(P, ids) {
  let mx = 0, my = 0; const n = ids.length; for (const i of ids) { mx += P[i * 2]; my += P[i * 2 + 1]; } mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0; for (const i of ids) { const dx = P[i * 2] - mx, dy = P[i * 2 + 1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(phi), dy: Math.sin(phi) };
}
function circleLS(P, ids) {
  // Kasa: x² + y² + D x + E y + F = 0 (центрирование для устойчивости)
  let mx = 0, my = 0; const n = ids.length; for (const i of ids) { mx += P[i * 2]; my += P[i * 2 + 1]; } mx /= n; my /= n;
  let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, b1 = 0, b2 = 0, b3 = 0;
  for (const i of ids) { const x = P[i * 2] - mx, y = P[i * 2 + 1] - my, z = -(x * x + y * y); a11 += x * x; a12 += x * y; a13 += x; a22 += y * y; a23 += y; b1 += x * z; b2 += y * z; b3 += z; }
  const M = [[a11, a12, a13], [a12, a22, a23], [a13, a23, n]], B = [b1, b2, b3];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d0 = det(M); if (!Math.abs(d0)) return null;
  const sol = [0, 1, 2].map((k) => { const m = M.map((r, ri) => r.map((v, ci) => ci === k ? B[ri] : v)); return det(m) / d0; });
  const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
  return r2 > 0 ? { cx: cx + mx, cy: cy + my, r: Math.sqrt(r2) } : null;
}
function circle3(ax, ay, bx, by, cx, cy) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}
// P — Float32Array (u, v); выход — прямые { kind:'line', a, b, n, rms } и дуги { kind:'arc', c, r, a0, a1, n, rms } (углы в радианах, против часовой)
function fitPrimitives(P, opts) {
  opts = opts || {};
  const N = (P.length / 2) | 0, tol = opts.tol || 0.02, minLen = opts.minLen || 0.3, gap = opts.gap || 0.3, arcs = opts.arcs !== false;
  const rMin = opts.rMin || 0.12, rMax = opts.rMax || 80, R = rng(opts.seed || 12345), out = [];
  const maxS = opts.maxSample || 40000, st = Math.max(1, N / maxS), S = [];
  for (let k = 0; k < N && S.length < maxS; k++) S.push(Math.floor(k * st)), k += 0;
  const idsAll = []; for (let j = 0; j < S.length; j++) idsAll.push(S[j]);
  let alive = idsAll.slice();
  const minPts = Math.max(opts.minPts || 20, Math.round(alive.length * 0.01));
  for (let model = 0; model < (opts.maxModels || 80) && alive.length >= minPts; model++) {
    const m = alive.length, H = [];
    const hs = Math.max(1, m / 1500); for (let k = 0; k < m && H.length < 1500; k++) H.push(alive[Math.floor(k * hs)]);
    let bL = null, bC = null;
    for (let it = 0; it < 220; it++) {
      const i = alive[Math.floor(R() * m)], j = alive[Math.floor(R() * m)];
      const dx = P[j * 2] - P[i * 2], dy = P[j * 2 + 1] - P[i * 2 + 1], L = Math.hypot(dx, dy); if (L < 0.12) continue;
      const nx = -dy / L, ny = dx / L, px = P[i * 2], py = P[i * 2 + 1]; let k = 0;
      for (const q of H) if (Math.abs((P[q * 2] - px) * nx + (P[q * 2 + 1] - py) * ny) < tol) k++;
      if (!bL || k > bL.k) bL = { k, px, py, dx: dx / L, dy: dy / L };
    }
    if (arcs) for (let it = 0; it < 220; it++) {
      const i = alive[Math.floor(R() * m)], j = alive[Math.floor(R() * m)], l = alive[Math.floor(R() * m)];
      const c = circle3(P[i * 2], P[i * 2 + 1], P[j * 2], P[j * 2 + 1], P[l * 2], P[l * 2 + 1]); if (!c || c.r < rMin || c.r > rMax) continue;
      let k = 0; for (const q of H) if (Math.abs(Math.hypot(P[q * 2] - c.cx, P[q * 2 + 1] - c.cy) - c.r) < tol) k++;
      if (!bC || k > bC.k) bC = Object.assign({ k }, c);
    }
    if (!bL) break;
    const useArc = bC && bC.k > bL.k * 1.2 && bC.k >= 12;
    // уточнение по всем живым точкам (два раза)
    let inl = [], model2 = useArc ? { cx: bC.cx, cy: bC.cy, r: bC.r } : { px: bL.px, py: bL.py, dx: bL.dx, dy: bL.dy };
    const dist = (q, M) => useArc ? Math.hypot(P[q * 2] - M.cx, P[q * 2 + 1] - M.cy) - M.r : (P[q * 2] - M.px) * -M.dy + (P[q * 2 + 1] - M.py) * M.dx;
    for (let rep = 0; rep < 3; rep++) {
      inl = alive.filter((q) => Math.abs(dist(q, model2)) < tol);
      if (inl.length < 8) break;
      const f = useArc ? circleLS(P, inl) : lineLS(P, inl);
      if (!f || (useArc && (f.r < rMin || f.r > rMax * 1.5))) break;
      model2 = f;
    }
    if (inl.length < 8) { alive = alive.filter((q) => Math.abs(dist(q, model2)) >= tol); continue; }
    // медиана смещений полосы ±tol/1,5 — положение грани (не центр тяжести: предметы у стены не тянут её)
    const offs = inl.map((q) => dist(q, model2)).filter((d) => Math.abs(d) < tol * 0.75), md = median(offs) || 0;
    if (useArc) model2.r += md; else { model2.px -= model2.dy * md; model2.py += model2.dx * md; }
    // параметр вдоль: длина по прямой, длина дуги по окружности; разрывы > gap делят на куски
    const tp = inl.map((q) => useArc ? Math.atan2(P[q * 2 + 1] - model2.cy, P[q * 2] - model2.cx) : (P[q * 2] - model2.px) * model2.dx + (P[q * 2 + 1] - model2.py) * model2.dy);
    let order = inl.map((q, k) => k);
    let shift = 0;
    if (useArc) {
      // поворот начала угла в самый большой разрыв окружности
      const sa = tp.slice().sort((a, b) => a - b); let bg = -1, at = sa[0];
      for (let k = 0; k < sa.length; k++) { const nx2 = k + 1 < sa.length ? sa[k + 1] : sa[0] + 2 * Math.PI, g = nx2 - sa[k]; if (g > bg) { bg = g; at = nx2; } }
      shift = at; for (let k = 0; k < tp.length; k++) { let a = tp[k] - shift; while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; tp[k] = a; }
    }
    order.sort((a, b) => tp[a] - tp[b]);
    const scale = useArc ? model2.r : 1, runs = []; let cur = [order[0]];
    for (let k = 1; k < order.length; k++) { if ((tp[order[k]] - tp[order[k - 1]]) * scale > gap) { runs.push(cur); cur = []; } cur.push(order[k]); }
    runs.push(cur);
    const dead = new Set(); let accepted = 0;
    for (const rn of runs) {
      const t0 = tp[rn[Math.floor(rn.length * 0.002)]], t1 = tp[rn[Math.min(rn.length - 1, Math.floor(rn.length * 0.998))]];
      const len = (t1 - t0) * scale;
      rn.forEach((k) => dead.add(inl[k]));
      if (len < minLen || rn.length < Math.max(8, len * (opts.minDensity || 20))) continue;
      const res = rn.map((k) => dist(inl[k], model2)), rms = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length);
      accepted++;
      if (useArc) out.push({ kind: 'arc', c: [model2.cx, model2.cy], r: model2.r, a0: t0 + shift, a1: t1 + shift, len, n: rn.length, rms });
      else out.push({ kind: 'line', a: [model2.px + model2.dx * t0, model2.py + model2.dy * t0], b: [model2.px + model2.dx * t1, model2.py + model2.dy * t1], len, n: rn.length, rms });
    }
    alive = alive.filter((q) => !dead.has(q));
    if (!accepted && dead.size < 3) break;
  }
  return { prims: out, sample: S.length, left: alive.length };
}

// ------------------------------------------------------------------ колонна по точкам: круг или прямоугольник
function hull(P, ids) {
  const pts = ids.map((i) => [P[i * 2], P[i * 2 + 1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop(); return lo.concat(up);
}
function minRect(poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L; let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const p of poly) { const s = p[0] * ux + p[1] * uy, t = -p[0] * uy + p[1] * ux; if (s < s0) s0 = s; if (s > s1) s1 = s; if (t < t0) t0 = t; if (t > t1) t1 = t; }
    const A = (s1 - s0) * (t1 - t0); if (!best || A < best.A) best = { A, ux, uy, s0, s1, t0, t1 };
  }
  if (!best) return null;
  const sc = (best.s0 + best.s1) / 2, tc = (best.t0 + best.t1) / 2;
  return { c: [sc * best.ux - tc * best.uy, sc * best.uy + tc * best.ux], w: best.s1 - best.s0, d: best.t1 - best.t0, phi: Math.atan2(best.uy, best.ux) };
}
function fitColumn(P, opts) {
  opts = opts || {};
  const n = (P.length / 2) | 0; if (n < 30) return null;
  const st = Math.max(1, n / 20000), ids = []; for (let k = 0; k < n && ids.length < 20000; k++) ids.push(Math.floor(k * st));
  const C = circleLS(P, ids);
  let circ = null;
  if (C && C.r > 0.06 && C.r < 1.2) {
    const res = ids.map((i) => Math.hypot(P[i * 2] - C.cx, P[i * 2 + 1] - C.cy) - C.r), rms = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length);
    // охват по углу: доля занятых секторов 10°
    const sec = new Uint8Array(36); ids.forEach((i) => { const a = Math.atan2(P[i * 2 + 1] - C.cy, P[i * 2] - C.cx); sec[Math.floor((a + Math.PI) / (2 * Math.PI) * 36) % 36] = 1; });
    const span = sec.reduce((s, x) => s + x, 0) * 10;
    circ = { kind: 'round', c: [C.cx, C.cy], d: 2 * C.r, rms, span };
  }
  const H = hull(P, ids), Rr = minRect(H);
  let rect = null;
  if (Rr) {
    const ux = Math.cos(Rr.phi), uy = Math.sin(Rr.phi);
    const res = ids.map((i) => { const x = P[i * 2] - Rr.c[0], y = P[i * 2 + 1] - Rr.c[1], s = Math.abs(x * ux + y * uy) - Rr.w / 2, t = Math.abs(-x * uy + y * ux) - Rr.d / 2; return Math.abs(Math.max(s, t)); });
    rect = { kind: 'rect', c: Rr.c, w: Rr.w, d: Rr.d, phi: Rr.phi, rms: Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length) };
  }
  if (circ && circ.span >= 100 && (!rect || circ.rms < rect.rms * 0.8)) return circ;
  return rect;
}

// ------------------------------------------------------------------ стены этажа из примитивов
function lineOf(p) { const dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1], L = Math.hypot(dx, dy) || 1; return { px: p.a[0], py: p.a[1], dx: dx / L, dy: dy / L, L }; }
function angD(a, b) { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }
function segX(p1, p2, q1, q2) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(q1, q2, p1), d2 = d(q1, q2, p2), d3 = d(p1, p2, q1), d4 = d(p1, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function crossed(g, t0, t1, lines) {
  const A = [g.px + g.dx * (t0 + 0.1), g.py + g.dy * (t0 + 0.1)], B = [g.px + g.dx * (t1 - 0.1), g.py + g.dy * (t1 - 0.1)];
  return lines.some((q) => { const l = lineOf(q); if (Math.abs(l.dx * g.dy - l.dy * g.dx) < Math.sin(20 * DEG)) return false; return segX(A, B, q.a, q.b); });
}
// соосные прямые (угол < 1,2°, смещение < 4 см, разрыв ≤ maxGap) — одна грань с участками spans
function mergeFaces(lines, opts) {
  opts = opts || {};
  const maxGap = opts.maxGap != null ? opts.maxGap : 6, G = [];
  lines.slice().sort((p, q) => q.len - p.len).forEach((p) => {
    const l = lineOf(p), phi = Math.atan2(l.dy, l.dx);
    let hit = null;
    for (const g of G) {
      if (angD(g.phi, phi) > 1.2 * DEG) continue;
      const da = (p.a[0] - g.px) * -g.dy + (p.a[1] - g.py) * g.dx, db = (p.b[0] - g.px) * -g.dy + (p.b[1] - g.py) * g.dx;
      if (Math.abs(da) > 0.04 || Math.abs(db) > 0.04) continue;
      let ta = (p.a[0] - g.px) * g.dx + (p.a[1] - g.py) * g.dy, tb = (p.b[0] - g.px) * g.dx + (p.b[1] - g.py) * g.dy; if (ta > tb) { const x = ta; ta = tb; tb = x; }
      const gapL = g.t0 - tb, gapR = ta - g.t1;
      if (gapL > maxGap || gapR > maxGap) continue;
      // разрыв не пересекает другую грань (стена киоска и перегородка за фасадом — не одна стена)
      const gp = gapL > 0 ? [tb, g.t0] : gapR > 0 ? [g.t1, ta] : null;
      if (gp && gp[1] - gp[0] > 0.3 && opts.cross && crossed(g, gp[0], gp[1], opts.cross)) continue;
      hit = { g, ta, tb, off: (da + db) / 2 }; break;
    }
    if (!hit) { G.push({ px: l.px, py: l.py, dx: l.dx, dy: l.dy, phi, t0: 0, t1: l.L, n: p.n, rmsS: p.rms * p.rms * p.n, spans: [[0, l.L]] }); return; }
    const g = hit.g, w = p.n / (g.n + p.n);
    g.px += -g.dy * hit.off * w; g.py += g.dx * hit.off * w;   // положение — среднее по числу точек
    g.t0 = Math.min(g.t0, hit.ta); g.t1 = Math.max(g.t1, hit.tb); g.n += p.n; g.rmsS += p.rms * p.rms * p.n; g.spans.push([hit.ta, hit.tb]);
  });
  return G.map((g) => {
    const sp = g.spans.slice().sort((a, b) => a[0] - b[0]), m = [];
    sp.forEach((x) => { if (m.length && x[0] <= m[m.length - 1][1] + 0.05) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]); else m.push(x.slice()); });
    return { kind: 'line', a: [g.px + g.dx * g.t0, g.py + g.dy * g.t0], b: [g.px + g.dx * g.t1, g.py + g.dy * g.t1], len: g.t1 - g.t0, n: g.n, rms: Math.sqrt(g.rmsS / g.n),
      spans: m.map((x) => [x[0] - g.t0, x[1] - g.t0]), phi: g.phi };
  });
}
// пары параллельных граней 6–70 см с перекрытием — стена с измеренной толщиной; остальные — односторонние (толщина по умолчанию)
function pairFaces(faces, opts) {
  opts = opts || {};
  const tMin = opts.tMin || 0.08, tMax = opts.tMax || 0.7, cand = [];
  for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
    const A = faces[i], B = faces[j]; if (A.kind !== 'line' || B.kind !== 'line' || angD(A.phi, B.phi) > 2 * DEG) continue;
    const l = lineOf(A), mb = [(B.a[0] + B.b[0]) / 2, (B.a[1] + B.b[1]) / 2], dist = Math.abs((mb[0] - l.px) * -l.dy + (mb[1] - l.py) * l.dx);
    if (dist < tMin || dist > tMax) continue;
    const ta = (B.a[0] - l.px) * l.dx + (B.a[1] - l.py) * l.dy, tb = (B.b[0] - l.px) * l.dx + (B.b[1] - l.py) * l.dy;
    const ov = Math.min(l.L, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
    // ревизия 39: длины граней одной стены сопоставимы (окно или откос в 15 см за фасадом — не вторая сторона стены)
    if (ov < 0.6 * Math.min(A.len, B.len) || ov < 0.4 || Math.min(A.len, B.len) < 0.5 * Math.max(A.len, B.len)) continue;
    cand.push({ i, j, dist, ov });
  }
  cand.sort((p, q) => p.dist - q.dist || q.ov - p.ov);
  const used = new Set(), pairs = [];
  cand.forEach((c) => { if (used.has(c.i) || used.has(c.j)) return; used.add(c.i); used.add(c.j); pairs.push(c); });
  return { pairs, single: faces.map((f, i) => i).filter((i) => !used.has(i)) };
}
// точка пересечения прямых p + s·d и q + t·e
function inter(p, d, q, e) { const den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-9) return null; const s = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den; return [p[0] + d[0] * s, p[1] + d[1] * s]; }
// стыки: конец прямой стены у другой стены (не дальше snap) — продлевается/обрезается до пересечения осей
function joinCorners(walls, snap) {
  snap = snap || 0.8;
  const L = walls.filter((w) => w.kind === 'line');
  L.forEach((w) => {
    ['a', 'b'].forEach((e) => {
      const P = w[e], d = [w.b[0] - w.a[0], w.b[1] - w.a[1]], Ld = Math.hypot(d[0], d[1]); if (Ld < 1e-6) return; const u = [d[0] / Ld, d[1] / Ld];
      let best = null;
      L.forEach((o) => {
        if (o === w) return; const od = [o.b[0] - o.a[0], o.b[1] - o.a[1]], Lo = Math.hypot(od[0], od[1]); if (Lo < 1e-6) return;
        const ou = [od[0] / Lo, od[1] / Lo]; if (Math.abs(u[0] * ou[1] - u[1] * ou[0]) < Math.sin(25 * DEG)) return;
        const X = inter(w.a, u, o.a, ou); if (!X) return;
        const dE = Math.hypot(X[0] - P[0], X[1] - P[1]); if (dE > snap) return;
        const to = (X[0] - o.a[0]) * ou[0] + (X[1] - o.a[1]) * ou[1]; if (to < -snap || to > Lo + snap) return;
        // новый конец не должен переворачивать стену
        const tn = (X[0] - w.a[0]) * u[0] + (X[1] - w.a[1]) * u[1]; if (e === 'a' ? tn > Ld - 0.2 : tn < 0.2) return;
        if (!best || dE < best.dE) best = { X, dE };
      });
      if (best) { w[e] = best.X; w.joined = (w.joined || 0) + 1; }
    });
    w.length = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  });
}
function wallsOfStorey(prims, opts) {
  opts = opts || {};
  const tDef = opts.thickness || 0.25, minLen = opts.minWall || 0.6;
  const lines = prims.filter((p) => p.kind === 'line');
  const arcs = prims.filter((p) => p.kind === 'arc' && p.r >= (opts.arcMinR || 1.5) && p.len >= (opts.arcMinLen || 1.0) && Math.abs(p.a1 - p.a0) >= 8 * DEG);
  const faces = mergeFaces(lines, Object.assign({ cross: lines.filter((p) => p.len >= 0.5) }, opts)).filter((f) => f.len >= minLen).concat(arcs.map((a) => Object.assign({}, a)));
  // внутренняя сторона одностороннего элемента — к центру тяжести стен этажа (здания)
  let cx = 0, cy = 0, sw = 0;
  faces.forEach((f) => { const m = f.kind === 'line' ? [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2] : [f.c[0] + f.r * Math.cos((f.a0 + f.a1) / 2), f.c[1] + f.r * Math.sin((f.a0 + f.a1) / 2)]; cx += m[0] * f.len; cy += m[1] * f.len; sw += f.len; });
  const ctr = opts.center || (sw ? [cx / sw, cy / sw] : [0, 0]);
  const P = pairFaces(faces, opts), walls = [];
  // односторонняя грань в пределах 0,5 м от более длинной параллельной и перекрытая ею на 60 % — откос, рама, остекление в глубине: не стена
  const covered = (i) => {
    const f = faces[i]; if (f.kind !== 'line') return false;
    return faces.some((g, j) => {
      if (j === i || g.kind !== 'line' || g.len < f.len * 1.5 || angD(g.phi, f.phi) > 3 * DEG) return false;
      const l = lineOf(g), m = [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2]; if (Math.abs((m[0] - l.px) * -l.dy + (m[1] - l.py) * l.dx) > 0.5) return false;
      const ta = (f.a[0] - l.px) * l.dx + (f.a[1] - l.py) * l.dy, tb = (f.b[0] - l.px) * l.dx + (f.b[1] - l.py) * l.dy;
      return Math.min(l.L, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) >= 0.6 * f.len;
    });
  };
  const absorbed = P.single.filter(covered);
  P.single = P.single.filter((i) => absorbed.indexOf(i) < 0);
  P.pairs.forEach((c) => {
    const A = faces[c.i], B = faces[c.j], l = lineOf(A);
    const ta = (B.a[0] - l.px) * l.dx + (B.a[1] - l.py) * l.dy, tb = (B.b[0] - l.px) * l.dx + (B.b[1] - l.py) * l.dy;
    const t0 = Math.min(0, ta, tb), t1 = Math.max(l.L, ta, tb), mb = [(B.a[0] + B.b[0]) / 2, (B.a[1] + B.b[1]) / 2];
    const sd = Math.sign((mb[0] - l.px) * -l.dy + (mb[1] - l.py) * l.dx) || 1, h = c.dist / 2;
    const nx = -l.dy * sd, ny = l.dx * sd;
    walls.push({ kind: 'line', a: [l.px + l.dx * t0 + nx * h, l.py + l.dy * t0 + ny * h], b: [l.px + l.dx * t1 + nx * h, l.py + l.dy * t1 + ny * h], thickness: c.dist, measured: true, sides: 2,
      faces: [A, B], n: A.n + B.n, rms: Math.max(A.rms, B.rms) });
  });
  P.single.forEach((i) => {
    const f = faces[i];
    if (f.kind === 'line') {
      const l = lineOf(f), m = [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2], sd = Math.sign((ctr[0] - m[0]) * -l.dy + (ctr[1] - m[1]) * l.dx) || 1, h = tDef / 2;
      walls.push({ kind: 'line', a: [f.a[0] - l.dy * sd * h, f.a[1] + l.dx * sd * h], b: [f.b[0] - l.dy * sd * h, f.b[1] + l.dx * sd * h], thickness: tDef, measured: false, sides: 1, inward: [-l.dy * sd, l.dx * sd],
        faces: [f], n: f.n, rms: f.rms });
    } else {
      const din = Math.hypot(ctr[0] - f.c[0], ctr[1] - f.c[1]) < f.r ? -1 : 1;   // центр здания внутри окружности — внутрь к центру дуги
      walls.push({ kind: 'arc', c: f.c, r: f.r + din * tDef / 2, a0: f.a0, a1: f.a1, thickness: tDef, measured: false, sides: 1, inwardSign: din, faces: [f], n: f.n, rms: f.rms });
    }
  });
  joinCorners(walls, opts.snap || 0.8);
  walls.forEach((w) => { if (w.kind === 'line') w.length = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]); else w.length = Math.abs(w.a1 - w.a0) * w.r; });
  // мусор: короткие стены в гуще других коротких (штабели, техника, леса) — не стены
  const mid = (w) => w.kind === 'line' ? [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2] : [w.c[0] + w.r * Math.cos((w.a0 + w.a1) / 2), w.c[1] + w.r * Math.sin((w.a0 + w.a1) / 2)];
  const short = walls.filter((w) => w.length < 2.5), M = short.map(mid);
  const junk = new Set();
  short.forEach((w, i) => { let k = 0; M.forEach((m, j) => { if (j !== i && Math.hypot(m[0] - M[i][0], m[1] - M[i][1]) < 1.2) k++; }); if (k >= 3) junk.add(w); });
  const kept = walls.filter((w) => w.length >= minLen && !junk.has(w));
  return { walls: kept, faces, center: ctr, absorbed: absorbed.length, junk: junk.size };
}

// ------------------------------------------------------------------ проход 3: развёртки стен
// опорная грань стены: видимая поверхность (первая грань); d > 0 — внутрь стены/здания
function refFace(w) {
  const f = w.faces && w.faces[0] ? w.faces[0] : w;
  if (f.kind === 'arc' || w.kind === 'arc') {
    const g = f.kind === 'arc' ? f : w, sgn = w.inwardSign || -1;
    return { kind: 'arc', c: g.c, r: g.r, a0: g.a0, L: Math.abs(g.a1 - g.a0) * g.r, sgn };
  }
  const dx = f.b[0] - f.a[0], dy = f.b[1] - f.a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  let nx = -uy, ny = ux;
  if (w.inward) { if (nx * w.inward[0] + ny * w.inward[1] < 0) { nx = -nx; ny = -ny; } }
  else if (w.faces && w.faces[1]) { const B = w.faces[1], m = [(B.a[0] + B.b[0]) / 2, (B.a[1] + B.b[1]) / 2]; if ((m[0] - f.a[0]) * nx + (m[1] - f.a[1]) * ny < 0) { nx = -nx; ny = -ny; } }
  return { kind: 'line', a: f.a, ux, uy, nx, ny, L };
}
function elevAcc(walls, opts) {
  opts = opts || {};
  const ds = opts.ds || 0.05, dh = opts.dh || 0.05, win = opts.win || 0.05, back = opts.back || 2.0, front = opts.front || 1.5;
  const E = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  walls.forEach((w, wi) => {
    const R = refFace(w), ns = Math.max(1, Math.ceil(R.L / ds)), hb = w.h0, nh = Math.max(1, Math.ceil((w.h1 - w.h0) / dh)), N = ns * nh;
    if (N > 4e6) return;
    E.push({ wi, R, ns, nh, hb, F: new Uint16Array(N), B: new Uint16Array(N), Fr: new Uint16Array(N), sd: new Float32Array(N), sd2: new Float32Array(N), rgb: new Float32Array(N * 3), it: new Float32Array(N) });
    const pts = sampleRef(R, 0.25);
    pts.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
  });
  const ic = 0.5; x0 -= back + 1; y0 -= back + 1; x1 += back + 1; y1 += back + 1;
  const gnx = Math.max(1, Math.ceil((x1 - x0) / ic)), gny = Math.max(1, Math.ceil((y1 - y0) / ic)), lists = new Map();
  E.forEach((e, ei) => {
    sampleRef(e.R, 0.2).forEach((p) => {
      const nrm = normalAt(e.R, p);
      for (let d = -front; d <= back + 1e-9; d += 0.2) {
        const X = p[0] + nrm[0] * d, Y = p[1] + nrm[1] * d, gx = Math.floor((X - x0) / ic), gy = Math.floor((Y - y0) / ic);
        for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
          if (xx < 0 || yy < 0 || xx >= gnx || yy >= gny) continue; const k = yy * gnx + xx; let l = lists.get(k); if (!l) { l = []; lists.set(k, l); } if (l[l.length - 1] !== ei) l.push(ei);
        }
      }
    });
  });
  let hmin = Infinity, hmax = -Infinity; E.forEach((e) => { hmin = Math.min(hmin, e.hb); hmax = Math.max(hmax, e.hb + e.nh * dh); });
  return {
    E, ds, dh, win, hmin, hmax,
    add(u, v, h, o) {
      if (h < hmin || h > hmax) return;
      const gx = Math.floor((u - x0) / ic), gy = Math.floor((v - y0) / ic); if (gx < 0 || gy < 0 || gx >= gnx || gy >= gny) return;
      const l = lists.get(gy * gnx + gx); if (!l) return;
      for (let j = 0; j < l.length; j++) {
        const e = E[l[j]], R = e.R, row = Math.floor((h - e.hb) / dh); if (row < 0 || row >= e.nh) continue;
        let s, d;
        if (R.kind === 'line') { const du = u - R.a[0], dv = v - R.a[1]; s = du * R.ux + dv * R.uy; d = du * R.nx + dv * R.ny; }
        else { const du = u - R.c[0], dv = v - R.c[1], rr = Math.hypot(du, dv); let a = Math.atan2(dv, du) - R.a0; a -= Math.floor(a / (2 * Math.PI)) * 2 * Math.PI; s = a * R.r; d = R.sgn < 0 ? R.r - rr : rr - R.r; }
        if (s < 0 || s >= R.L || d < -front || d > back) continue;
        const c = row * e.ns + Math.min(e.ns - 1, Math.floor(s / ds));
        if (d >= -win && d <= win) {
          if (e.F[c] < 65535) e.F[c]++; e.sd[c] += d; e.sd2[c] += d * d;
          if (o && o.r === o.r) { e.rgb[c * 3] += o.r; e.rgb[c * 3 + 1] += o.g; e.rgb[c * 3 + 2] += o.b; e.it[c] += o.i; }
        } else if (d > win) { if (e.B[c] < 65535) e.B[c]++; }
        else if (e.Fr[c] < 65535) e.Fr[c]++;
      }
    }
  };
}
function sampleRef(R, step) {
  const k = Math.max(1, Math.ceil(R.L / step)), out = [];
  for (let i = 0; i <= k; i++) { const s = R.L * i / k; out.push(R.kind === 'line' ? [R.a[0] + R.ux * s, R.a[1] + R.uy * s] : [R.c[0] + R.r * Math.cos(R.a0 + s / R.r), R.c[1] + R.r * Math.sin(R.a0 + s / R.r)]); }
  return out;
}
function normalAt(R, p) {
  if (R.kind === 'line') return [R.nx, R.ny];
  const dx = p[0] - R.c[0], dy = p[1] - R.c[1], L = Math.hypot(dx, dy) || 1;
  return R.sgn < 0 ? [-dx / L, -dy / L] : [dx / L, dy / L];
}

// ------------------------------------------------------------------ материал по цвету (HSV) и интенсивности
const MATERIALS = {
  brick: { name: 'Кирпич', ifc: 'Кирпич керамический', t: 0.38, color: [0.62, 0.32, 0.22] },
  concrete: { name: 'Бетон', ifc: 'Бетон', t: 0.25, color: [0.62, 0.62, 0.6] },
  plaster: { name: 'Штукатурка / окраска', ifc: 'Штукатурка окрашенная', t: 0.2, color: [0.9, 0.88, 0.84] },
  glass: { name: 'Стекло (витраж)', ifc: 'Стекло', t: 0.15, color: [0.55, 0.7, 0.8] },
  metal: { name: 'Металл', ifc: 'Сталь', t: 0.1, color: [0.5, 0.52, 0.55] },
  wood: { name: 'Дерево', ifc: 'Древесина', t: 0.12, color: [0.6, 0.45, 0.28] },
  unknown: { name: 'Не определён', ifc: 'Не определён', t: 0.25, color: [0.7, 0.7, 0.7] }
};
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let hh = 0;
  if (d > 1e-6) { if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
  return [hh, mx > 0 ? d / mx : 0, mx / 255];
}
function colorClass(r, g, b, it) {
  const [H, S, V] = hsv(r, g, b);
  if (V < 0.1) return null;
  if (S >= 0.1 && H >= 185 && H <= 255) return 'glass';
  if ((H <= 24 || H >= 340) && S >= 0.2 && V <= 0.9) return 'brick';
  if (H > 24 && H <= 48 && S >= 0.3 && V >= 0.2 && V <= 0.75) return 'wood';
  if (S < 0.12) return V >= 0.7 ? 'plaster' : (it > 0.8 ? 'metal' : 'concrete');
  if (H > 24 && H <= 34 && S >= 0.2) return 'brick';
  return 'plaster';
}

// предварительный материал: доля классов цвета по занятым клеткам
function cellClass(e, c) { const k = e.F[c]; if (!k || !(e.rgb[c * 3] > 0 || e.rgb[c * 3 + 1] > 0)) return null; return colorClass(e.rgb[c * 3] / k, e.rgb[c * 3 + 1] / k, e.rgb[c * 3 + 2] / k, e.it[c] / k); }
function prelimMaterial(e, solid, rBot, rTop) {
  const t = {}; let n = 0;
  for (let r = rBot; r <= rTop; r++) for (let x = 0; x < e.ns; x++) { const c = r * e.ns + x; if (!solid[c]) continue; const cl = cellClass(e, c); if (!cl) continue; t[cl] = (t[cl] || 0) + 1; n++; }
  if (n < 50) return null;
  const key = Object.keys(t).sort((a, b) => t[b] - t[a])[0];
  let mr = 0, mg = 0, mb = 0, m = 0;
  for (let r = rBot; r <= rTop; r++) for (let x = 0; x < e.ns; x++) { const c = r * e.ns + x; if (solid[c] && cellClass(e, c) === key) { const k = e.F[c]; mr += e.rgb[c * 3] / k; mg += e.rgb[c * 3 + 1] / k; mb += e.rgb[c * 3 + 2] / k; m++; } }
  return { key, share: t[key] / n, rgb: [mr / m, mg / m, mb / m] };
}
// «чужие» клетки: пусто или цвет не основного материала; сглаживание большинством 5×5
function foreignMask(e, solid, pre, rBot, rTop) {
  const ns = e.ns, N = ns * e.nh, raw = new Uint8Array(N), out = new Uint8Array(N);
  const red = (c) => { const k = e.F[c], r = e.rgb[c * 3] / k, g = e.rgb[c * 3 + 1] / k, b = e.rgb[c * 3 + 2] / k; return (r - (g + b) / 2) / ((r + g + b) / 3 + 1); };
  let rt = 0.1;
  if (pre.key === 'brick') {
    // порог «красноты» кирпича по Оцу (освещённость и швы меняют насыщенность, но не оттенок)
    const hb = new Float64Array(40); let n = 0;
    for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) { const c = r * ns + x; if (!solid[c] || e.F[c] < 3) continue; hb[clamp(Math.floor((red(c) + 0.2) / 0.02), 0, 39)]++; n++; }
    let best = -1, sw = 0, sm = 0, tot = 0; for (let i = 0; i < 40; i++) tot += hb[i] * i;
    for (let i = 0; i < 39; i++) { sw += hb[i]; sm += hb[i] * i; if (!sw || sw === n) continue; const m0 = sm / sw, m1 = (tot - sm) / (n - sw), v = sw * (n - sw) * (m0 - m1) * (m0 - m1); if (v > best) { best = v; rt = (i + 1) * 0.02 - 0.2; } }
    // уточнение: дно впадины между модами (Оцу смещается к большей моде)
    const ot = Math.round((rt + 0.2) / 0.02), sh = (i) => (hb[i - 1] || 0) + hb[i] + (hb[i + 1] || 0);
    let m0 = 0, m1 = 39; for (let i = 0; i < ot; i++) if (sh(i) > sh(m0)) m0 = i; for (let i = 39; i >= ot; i--) if (sh(i) >= sh(m1)) m1 = i;
    let vi = ot; for (let i = m0 + 1; i < m1; i++) if (sh(i) < sh(vi)) vi = i;
    rt = clamp(vi * 0.02 - 0.2 + 0.01, 0.03, 0.2);
  }
  for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) {
    const c = r * ns + x; if (!solid[c]) { raw[c] = 1; continue; }
    if (pre.key === 'brick') raw[c] = red(c) >= rt ? 0 : 1;
    else { const k = e.F[c]; const d = Math.abs(e.rgb[c * 3] / k - pre.rgb[0]) + Math.abs(e.rgb[c * 3 + 1] / k - pre.rgb[1]) + Math.abs(e.rgb[c * 3 + 2] / k - pre.rgb[2]); raw[c] = d > 90 ? 1 : 0; }
  }
  for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) {
    let k = 0, t = 0; for (let dy = -2; dy <= 2; dy++) { const rr = r + dy; if (rr < rBot || rr > rTop) continue; for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; if (xx < 0 || xx >= ns) continue; t++; k += raw[rr * ns + xx]; } }
    out[r * ns + x] = k * 2 > t ? 1 : 0;
  }
  // открытие квадратом 7×7 (35 см): тонкие пилястры, швы и пояса отрываются от проёмов
  return boxOpen(out, ns, e.nh, 3);
}
function boxFilt(m, ns, nh, R, isMax, horiz) {
  const o = new Uint8Array(m.length);
  for (let r = 0; r < nh; r++) for (let x = 0; x < ns; x++) {
    let v = isMax ? 0 : 1;
    for (let k = -R; k <= R; k++) {
      const xx = horiz ? x + k : x, rr = horiz ? r : r + k;
      const q = xx < 0 || xx >= ns || rr < 0 || rr >= nh ? (isMax ? 0 : 1) : m[rr * ns + xx];
      if (isMax ? q : !q) { v = isMax ? 1 : 0; break; }
    }
    o[r * ns + x] = v;
  }
  return o;
}
function boxOpen(m, ns, nh, R) {
  let a = boxFilt(m, ns, nh, R, false, true); a = boxFilt(a, ns, nh, R, false, false);
  a = boxFilt(a, ns, nh, R, true, true); return boxFilt(a, ns, nh, R, true, false);
}

// ------------------------------------------------------------------ разбор развёртки: проёмы, витраж, материал, точность
function analyseWall(e, w, opts) {
  opts = opts || {};
  const ns = e.ns, nh = e.nh, N = ns * nh, ds = opts.ds || 0.05, dh = opts.dh || 0.05;
  const nz = []; for (let c = 0; c < N; c++) if (e.F[c]) nz.push(e.F[c]);
  if (nz.length < 20) return { ok: false, points: 0 };
  const medF = median(nz), thr = Math.max(1, Math.round(medF * (opts.solidRel || 0.12)));
  let solid = new Uint8Array(N); for (let c = 0; c < N; c++) solid[c] = e.F[c] >= thr ? 1 : 0;
  // заделка одиночных дырок (шум) — клетка с 6 и более занятыми соседями
  const s2 = Uint8Array.from(solid);
  for (let r = 1; r < nh - 1; r++) for (let x = 1; x < ns - 1; x++) { const c = r * ns + x; if (solid[c]) continue; let k = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && solid[c + dy * ns + dx]) k++; if (k >= 6) s2[c] = 1; }
  solid = s2;
  // верх стены: самый высокий ряд, где занято не меньше 25 % длины
  const rowFill = new Float32Array(nh); for (let r = 0; r < nh; r++) { let k = 0; for (let x = 0; x < ns; x++) k += solid[r * ns + x]; rowFill[r] = k / ns; }
  let rTop = -1, rBot = -1; for (let r = nh - 1; r >= 0; r--) if (rowFill[r] >= 0.25) { rTop = r; break; } for (let r = 0; r < nh; r++) if (rowFill[r] >= 0.25) { rBot = r; break; }
  if (rTop < 0) return { ok: false, points: nz.length };
  const top = e.hb + (rTop + 1) * dh, bottom = e.hb + rBot * dh;
  // участки по длине: столбцы, занятые меньше чем на 8 % высоты подряд ≥ 1 м, — разрыв стены
  const colFill = new Float32Array(ns); for (let x = 0; x < ns; x++) { let k = 0; for (let r = rBot; r <= rTop; r++) k += solid[r * ns + x]; colFill[x] = k / Math.max(1, rTop - rBot + 1); }
  const parts = []; let ps = -1, gapRun = 0, gapN = Math.round((opts.breakGap || 1.0) / ds);
  for (let x = 0; x <= ns; x++) {
    const on = x < ns && colFill[x] >= 0.08;
    if (on) { if (ps < 0) ps = x; gapRun = 0; }
    else if (ps >= 0) { gapRun++; if (gapRun >= gapN || x === ns) { const pe = x - gapRun; if ((pe - ps + 1) * ds >= 0.4) parts.push([ps * ds, (pe + 1) * ds]); ps = -1; gapRun = 0; } }
  }
  // проёмы: связные области незанятых клеток внутри участков, между низом и верхом стены
  const inPart = new Uint8Array(ns); parts.forEach((p) => { for (let x = Math.floor(p[0] / ds); x < Math.min(ns, Math.ceil(p[1] / ds)); x++) inPart[x] = 1; });
  const lab = new Int32Array(N).fill(-1), comps = [], st = [];
  let openCells = 0, areaCells = 0;
  for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) { if (!inPart[x]) continue; areaCells++; if (!solid[r * ns + x]) openCells++; }
  for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) {
    const c0 = r * ns + x; if (!inPart[x] || solid[c0] || lab[c0] >= 0) continue;
    const id = comps.length; let n = 0, xa = x, xb = x, ra = r, rb = r, nB = 0, nFr = 0; st.length = 0; st.push(c0); lab[c0] = id;
    while (st.length) {
      const c = st.pop(), cx = c % ns, cr = (c - cx) / ns; n++; nB += e.B[c] ? 1 : 0; nFr += e.Fr[c] ? 1 : 0;
      if (cx < xa) xa = cx; if (cx > xb) xb = cx; if (cr < ra) ra = cr; if (cr > rb) rb = cr;
      const nb = [cx > 0 ? c - 1 : -1, cx < ns - 1 ? c + 1 : -1, cr > rBot ? c - ns : -1, cr < rTop ? c + ns : -1];
      for (const k of nb) { if (k < 0) continue; const kx = k % ns; if (!inPart[kx] || solid[k] || lab[k] >= 0) continue; lab[k] = id; st.push(k); }
    }
    comps.push({ n, xa, xb, ra, rb, nB, nFr });
  }
  const H = Math.max(dh, top - bottom), openings = [];
  const pre = prelimMaterial(e, solid, rBot, rTop);
  if (!opts.noColor && pre && pre.key !== 'glass' && pre.share >= 0.35) {
    // остеклённые проёмы заподлицо с фасадом: точки есть, но цвет чужой (стекло, рама) — ищем прямоугольники «не своего» цвета
    const fm = foreignMask(e, solid, pre, rBot, rTop);
    const fl = new Int32Array(N).fill(-1); const fc = [];
    for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) {
      const c0 = r * ns + x; if (!inPart[x] || !fm[c0] || fl[c0] >= 0) continue;
      const id = fc.length; let n = 0, xa = x, xb = x, ra = r, rb = r, nE = 0, nB = 0, nFr = 0; st.length = 0; st.push(c0); fl[c0] = id;
      while (st.length) {
        const c = st.pop(), cx = c % ns, cr = (c - cx) / ns; n++; if (!solid[c]) { nE++; nB += e.B[c] ? 1 : 0; nFr += e.Fr[c] ? 1 : 0; }
        if (cx < xa) xa = cx; if (cx > xb) xb = cx; if (cr < ra) ra = cr; if (cr > rb) rb = cr;
        const nb = [cx > 0 ? c - 1 : -1, cx < ns - 1 ? c + 1 : -1, cr > rBot ? c - ns : -1, cr < rTop ? c + ns : -1];
        for (const k of nb) { if (k < 0) continue; const kx = k % ns; if (!inPart[kx] || !fm[k] || fl[k] >= 0) continue; fl[k] = id; st.push(k); }
      }
      fc.push({ n, xa, xb, ra, rb, nB, nFr, nE, glazed: true });
    }
    // ревизия 40: окно, сросшееся с поясом цоколя или пятном (люди, предметы) через узкие перемычки, — разделяем
    // открытием квадратом 13×13 (0,65 м): узкие перемычки уходят, прямоугольники окон остаются
    const bad = fc.map((c, id) => ({ c, id })).filter(({ c }) => c.n / ((c.xb - c.xa + 1) * (c.rb - c.ra + 1)) < 0.6 || (c.xb - c.xa + 1) * ds > 6);
    if (bad.length) {
      const m2 = new Uint8Array(N); const badId = new Set(bad.map((b) => b.id));
      for (let c = 0; c < N; c++) if (fl[c] >= 0 && badId.has(fl[c])) m2[c] = 1;
      const op = boxOpen(m2, ns, nh, 6), fl2 = new Int32Array(N).fill(-1);
      for (let r = rBot; r <= rTop; r++) for (let x = 0; x < ns; x++) {
        const c0 = r * ns + x; if (!op[c0] || fl2[c0] >= 0) continue;
        let n = 0, xa = x, xb = x, ra = r, rb = r, nE = 0, nB = 0, nFr = 0; st.length = 0; st.push(c0); fl2[c0] = 1;
        while (st.length) {
          const c = st.pop(), cx = c % ns, cr = (c - cx) / ns; n++; if (!solid[c]) { nE++; nB += e.B[c] ? 1 : 0; nFr += e.Fr[c] ? 1 : 0; }
          if (cx < xa) xa = cx; if (cx > xb) xb = cx; if (cr < ra) ra = cr; if (cr > rb) rb = cr;
          const nb = [cx > 0 ? c - 1 : -1, cx < ns - 1 ? c + 1 : -1, cr > rBot ? c - ns : -1, cr < rTop ? c + ns : -1];
          for (const k of nb) { if (k < 0 || !op[k] || fl2[k] >= 0) continue; fl2[k] = 1; st.push(k); }
        }
        fc.push({ n, xa, xb, ra, rb, nB, nFr, nE, glazed: true, split: true });
      }
    }
    fc.forEach((c) => comps.push(c));
  }
  comps.forEach((c) => {
    const W = (c.xb - c.xa + 1) * ds, Hh = (c.rb - c.ra + 1) * dh, fill = c.n / ((c.xb - c.xa + 1) * (c.rb - c.ra + 1));
    if (W < (opts.minOpen || 0.4) || Hh < (opts.minOpen || 0.4) || fill < 0.6) return;
    const z0 = e.hb + c.ra * dh, z1 = e.hb + (c.rb + 1) * dh, sill = z0 - w.h0;
    if (c.glazed) {
      // пилястры и пояса во всю высоту/длину — не проёмы
      if (z1 >= top - 0.1 && (z0 <= bottom + 0.15 || W < 2.6)) return;
      if (W > 6 || Hh < 0.5) return;
      // часть, отделённая открытием, — только прямоугольник над цоколем и под верхом стены
      if (c.split && (fill < 0.75 || z0 <= bottom + 0.3 || z1 >= top - 0.1)) return;
    }
    const nEmpty = c.glazed ? c.nE : c.n;
    // тень от предмета перед стеной: перед проёмом точки, за ним — нет
    const occluded = nEmpty > c.n * 0.5 && c.nFr > c.n * 0.35 && c.nB < c.n * 0.1;
    let kind = sill <= 0.2 ? (W >= 2.6 && Hh >= 2.3 ? 'gate' : (Hh >= 1.7 ? 'door' : 'window')) : 'window';
    if (z1 >= top - 0.06 && sill > 0.2 && Hh > H * 0.85) kind = 'window';
    openings.push({ kind, s0: c.xa * ds, s1: (c.xb + 1) * ds, z0, z1, width: W, height: Hh, sill: Math.max(0, sill), fill, through: c.nB / c.n, occluded, glazed: c.glazed ? 1 - c.nE / c.n : 0 });
  });
  // пустые и «цветные» кандидаты могут перекрываться: остаётся больший (полный проём вместо пятна пустоты в окне)
  openings.sort((a, b) => b.width * b.height - a.width * a.height);
  for (let i = 0; i < openings.length; i++) for (let j = openings.length - 1; j > i; j--) {
    const A = openings[i], B = openings[j], ix = Math.min(A.s1, B.s1) - Math.max(A.s0, B.s0), iz = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
    if (ix > 0 && iz > 0 && ix * iz > 0.3 * B.width * B.height) openings.splice(j, 1);
  }
  openings.sort((a, b) => a.s0 - b.s0);
  const openFrac = areaCells ? openCells / areaCells : 0;
  // материал: классы цвета занятых клеток (вес — число точек)
  const tally = {}; let tw = 0, sd = 0, sd2 = 0, sn = 0;
  const rows = [];   // средние смещения рядов — отклонение от вертикали
  for (let r = rBot; r <= rTop; r++) {
    let rs = 0, rn = 0;
    for (let x = 0; x < ns; x++) {
      const c = r * ns + x; if (!solid[c] || !e.F[c]) continue; const k = e.F[c];
      sd += e.sd[c]; sd2 += e.sd2[c]; sn += k; rs += e.sd[c]; rn += k;
      if (e.rgb[c * 3] > 0 || e.rgb[c * 3 + 1] > 0) { const cl = colorClass(e.rgb[c * 3] / k, e.rgb[c * 3 + 1] / k, e.rgb[c * 3 + 2] / k, e.it[c] / k); if (cl) { tally[cl] = (tally[cl] || 0) + k; tw += k; } }
    }
    if (rn >= 20) rows.push([e.hb + (r + 0.5) * dh, rs / rn]);
  }
  const mean = sn ? sd / sn : 0, rms = sn ? Math.sqrt(Math.max(0, sd2 / sn - mean * mean)) : NaN;
  let plumb = NaN;
  if (rows.length >= 6) { let mx = 0, my = 0; rows.forEach((p) => { mx += p[0]; my += p[1]; }); mx /= rows.length; my /= rows.length; let sxy = 0, sxx = 0; rows.forEach((p) => { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) * (p[0] - mx); }); plumb = sxx > 0 ? sxy / sxx : NaN; }
  const shares = Object.keys(tally).map((k) => ({ key: k, share: tally[k] / tw })).sort((a, b) => b.share - a.share);
  const curtain = openFrac >= (opts.curtainFrac || 0.45) && openings.length >= 2 || (shares[0] && shares[0].key === 'glass' && shares[0].share > 0.5);
  let mat = shares[0] ? shares[0].key : 'unknown', conf = shares[0] ? shares[0].share : 0;
  if (curtain) { mat = 'glass'; conf = Math.max(conf, Math.min(0.95, openFrac + 0.3)); }
  // ревизия 40: членение по развёртке — у витража вся стена (по участкам), у окна и остеклённой двери — проём
  let grid = null;
  if (opts.grid !== false) {
    const rr0 = rBot, rr1 = rTop;
    if (curtain) {
      const gs = parts.map((p) => frameGrid(e, { x0: Math.max(0, Math.round(p[0] / ds)), x1: Math.min(ns - 1, Math.round(p[1] / ds) - 1), r0: rr0, r1: rr1, thr }, opts)).filter(Boolean);
      if (gs.length) grid = { members: [].concat.apply([], gs.map((g) => g.members)), panels: [].concat.apply([], gs.map((g) => g.panels)), bands: gs[0].bands, colored: gs.some((g) => g.colored) };
    } else {
      openings.forEach((q) => {
        if (q.occluded || q.kind === 'gate' || (q.kind === 'door' && !q.glazed)) return;
        const g = windowGrid(e, { x0: Math.max(0, Math.round(q.s0 / ds)), x1: Math.min(ns, Math.round(q.s1 / ds)), r0: Math.max(0, Math.round((q.z0 - e.hb) / dh)), r1: Math.min(nh, Math.round((q.z1 - e.hb) / dh)), thr, door: q.kind === 'door' }, opts);
        if (g) q.grid = g;
      });
    }
  }
  return { ok: true, top, bottom, parts, openings, openFrac, curtain, material: mat, materialConf: conf, materials: shares.slice(0, 4),
    offset: mean, rms, plumb, points: sn, cells: nz.length, coverage: areaCells ? 1 - openFrac : 0, grid, thr };
}

// ------------------------------------------------------------------ ревизия 40: импосты, ригели и заполнения витража / окна
// Прямоугольник развёртки (столбцы x0–x1, ряды r0–r1, клетка 5 см): тёмные клетки (яркость ниже 0,6 медианы — профиль рамы;
// без цвета — клетки плотнее полуторной медианы ряда), пустые (прозрачное стекло: лидар проходит насквозь).
// Ряды: тёмные на 45 % ширины — ригели (до 0,3 м), пустые на 35 % — зона прозрачного стекла, прочие — глухая зона (панель,
// парапет, перемычка). В каждой зоне столбцы: тёмные на половину высоты зоны (или в прозрачной зоне — занятые на 70 %) — стойки
// (импосты) шириной до 0,3 м; ширина и ось — по доле тёмных клеток (точнее клетки). Стойки соседних зон по высоте сшиваются.
// Между стойками — заполнения: прозрачное стекло (пусто от половины) или глухая панель с материалом по цвету.
function frameGrid(e, rc, opts) {
  opts = opts || {};
  const ns = e.ns, ds = opts.ds || 0.05, dh = opts.dh || 0.05, x0 = rc.x0, x1 = rc.x1, r0 = rc.r0, r1 = rc.r1, thr = rc.thr || 1;
  const W = x1 - x0 + 1, Hn = r1 - r0 + 1;
  if (W < 4 || Hn < 4) return null;
  const vOf = (c) => { const k = e.F[c]; if (!k) return NaN; const r = e.rgb[c * 3], g = e.rgb[c * 3 + 1], b = e.rgb[c * 3 + 2]; return r > 0 || g > 0 || b > 0 ? Math.max(r, g, b) / k / 255 : NaN; };
  const has = new Uint8Array(W * Hn), dark = new Uint8Array(W * Hn), Vs = [];
  let nHas = 0;
  for (let r = 0; r < Hn; r++) for (let x = 0; x < W; x++) { const c = (r0 + r) * ns + x0 + x; if (e.F[c] >= thr) { has[r * W + x] = 1; nHas++; const v = vOf(c); if (v === v) Vs.push(v); } }
  if (nHas < 0.05 * W * Hn && !rc.inOpening) return null;
  const colored = Vs.length >= Math.max(20, 0.3 * nHas), Vm = colored ? median(Vs) : NaN, vLim = Math.min(0.6 * Vm, Vm - 0.12);
  for (let r = 0; r < Hn; r++) {
    let rm = 0; if (!colored) { const fr = []; for (let x = 0; x < W; x++) if (has[r * W + x]) fr.push(e.F[(r0 + r) * ns + x0 + x]); rm = fr.length ? median(fr) : 0; }
    for (let x = 0; x < W; x++) {
      const i = r * W + x; if (!has[i]) continue; const c = (r0 + r) * ns + x0 + x;
      dark[i] = colored ? (vOf(c) < vLim ? 1 : 0) : (e.F[c] >= 1.6 * rm && rm > 0 ? 1 : 0);
    }
  }
  // ряды
  const Er = new Float32Array(Hn), Dr = new Float32Array(Hn);
  for (let r = 0; r < Hn; r++) { let k = 0, d = 0; for (let x = 0; x < W; x++) { k += has[r * W + x]; d += dark[r * W + x]; } Er[r] = 1 - k / W; Dr[r] = d / W; }
  const cls = []; for (let r = 0; r < Hn; r++) { const es = (Er[Math.max(0, r - 1)] + Er[r] + Er[Math.min(Hn - 1, r + 1)]) / 3; cls.push(Dr[r] >= 0.45 ? 'T' : (es >= 0.35 ? 'V' : 'O')); }
  let runs = []; for (let r = 0; r < Hn; r++) { if (runs.length && runs[runs.length - 1].k === cls[r]) runs[runs.length - 1].b = r; else runs.push({ k: cls[r], a: r, b: r }); }
  // ригель выше 0,3 м — глухая тёмная зона; короткие зоны (до 10 см) — к соседней
  runs.forEach((u) => { if (u.k === 'T' && (u.b - u.a + 1) * dh > 0.3) u.k = 'O'; });
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < runs.length; i++) { const u = runs[i]; if (u.k === 'T' || (u.b - u.a + 1) * dh > 0.1 + 1e-9 || runs.length < 2) continue; const nb = i > 0 && runs[i - 1].k !== 'T' ? runs[i - 1] : (i < runs.length - 1 && runs[i + 1].k !== 'T' ? runs[i + 1] : null); if (nb) u.k = nb.k; }
    const m = []; runs.forEach((u) => { if (m.length && m[m.length - 1].k === u.k) m[m.length - 1].b = u.b; else m.push(Object.assign({}, u)); }); runs = m;
  }
  const members = [], panels = [], bands = [];
  const zOf = (r) => e.hb + (r0 + r) * dh, sOf = (x) => (x0 + x) * ds;
  runs.forEach((u) => {
    if (u.k !== 'T') return; let wsum = 0; for (let r = u.a; r <= u.b; r++) wsum += Dr[r];
    const hgt = Math.max(0.04, Math.min((u.b - u.a + 1) * dh, wsum * dh)), zc = (zOf(u.a) + zOf(u.b + 1)) / 2;
    u.m = { dir: 'h', s0: sOf(0), s1: sOf(W), z0: zc - hgt / 2, z1: zc + hgt / 2 }; members.push(u.m);
  });
  // граница прозрачной и глухой зон без ригеля — рама (5 см)
  for (let i = 1; i < runs.length; i++) { const a = runs[i - 1], b = runs[i]; if (a.k !== 'T' && b.k !== 'T' && a.k !== b.k) { const z = zOf(b.a); members.push({ dir: 'h', s0: sOf(0), s1: sOf(W), z0: z - 0.025, z1: z + 0.025, edge: true }); } }
  const pieces = [];
  runs.forEach((u, bi) => {
    if (u.k === 'T') return;
    const nr = u.b - u.a + 1, Dc = new Float32Array(W), Ec = new Float32Array(W);
    for (let x = 0; x < W; x++) { let d = 0, k = 0; for (let r = u.a; r <= u.b; r++) { d += dark[r * W + x]; k += has[r * W + x]; } Dc[x] = d / nr; Ec[x] = 1 - k / nr; }
    const fc = new Uint8Array(W), eMed = u.k === 'V' ? median(Array.from(Ec)) : 0;
    for (let x = 0; x < W; x++) fc[x] = Dc[x] >= 0.5 || (u.k === 'V' && Ec[x] <= Math.min(0.45, 0.6 * eMed)) ? 1 : 0;
    // зона — от ригеля до ригеля (заполнение вплотную к профилю)
    const pu = runs[bi - 1], nu = runs[bi + 1];
    const band = { k: u.k, z0: pu && pu.m ? pu.m.z1 : zOf(u.a), z1: nu && nu.m ? nu.m.z0 : zOf(u.b + 1), bi }; bands.push(band);
    const cuts = [];
    for (let x = 0; x < W; x++) {
      if (!fc[x]) continue; let y = x; while (y + 1 < W && fc[y + 1]) y++;
      if ((y - x + 1) * ds <= 0.3 + 1e-9) {
        let ws = 0, wc = 0; for (let k = x; k <= y; k++) { const wk = Math.max(Dc[k], u.k === 'V' ? 1 - Ec[k] : 0); ws += wk; wc += wk * (k + 0.5); }
        const sc = sOf(0) + (wc / Math.max(ws, 1e-9)) * ds, wd = Math.max(0.04, Math.min((y - x + 1) * ds, ws * ds));
        cuts.push({ x, y, s: sc, w: wd }); pieces.push({ bi, s: sc, w: wd, x: x0 + x, y: x0 + y, z0: band.z0, z1: band.z1 });
      }
      x = y;
    }
    // заполнения между стойками (и краями)
    let prev = 0, prevS = sOf(0);
    cuts.concat([{ x: W, y: W, s: sOf(W), w: 0 }]).forEach((ct) => {
      const a = prev, b = ct.x - 1, ps = prevS; prev = ct.y + 1; prevS = ct.s + ct.w / 2;
      if (b - a + 1 < 2) return;
      let emp = 0, tot = 0; const tally = {};
      for (let x = a; x <= b; x++) for (let r = u.a; r <= u.b; r++) { tot++; const i = r * W + x; if (!has[i]) { emp++; continue; } const cl = cellClass(e, (r0 + r) * ns + x0 + x); if (cl) tally[cl] = (tally[cl] || 0) + 1; }
      const vision = emp >= 0.5 * tot, top = Object.keys(tally).sort((p, q) => tally[q] - tally[p])[0];
      panels.push({ kind: vision ? 'vision' : 'spandrel', mat: vision ? 'glass' : (top || 'unknown'), s0: ps, s1: ct.s - ct.w / 2, z0: band.z0, z1: band.z1, empty: tot ? emp / tot : 0 });
    });
  });
  // стойки соседних зон (через ригель) — одна стойка
  pieces.sort((p, q) => p.z0 - q.z0);
  const used = new Uint8Array(pieces.length);
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue; used[i] = 1; const ch = [pieces[i]];
    let last = pieces[i];
    for (let j = i + 1; j < pieces.length; j++) {
      if (used[j]) continue; const p = pieces[j];
      if (p.bi <= last.bi || p.z0 - last.z1 > 0.35 + 1e-9) continue;
      if (Math.abs(p.s - last.s) > Math.max(0.06, (p.w + last.w) / 2)) continue;
      used[j] = 1; ch.push(p); last = p;
    }
    let sw = 0, ss = 0, wsum = 0; ch.forEach((p) => { const h = p.z1 - p.z0; sw += h; ss += p.s * h; wsum += p.w * h; });
    members.push({ dir: 'v', s: ss / sw, w: wsum / sw, s0: ss / sw - wsum / sw / 2, s1: ss / sw + wsum / sw / 2, z0: ch[0].z0, z1: ch[ch.length - 1].z1 });
  }
  return { members, panels, bands, colored };
}

// ------------------------------------------------------------------ ревизия 40: рама, импосты и створки окна
// Проём окна (или остеклённой двери) — столбцы x0..x1-1, ряды r0..r1-1 развёртки. Профиль столбцов — медиана яркости
// (без цвета — заполненность клеток); стекло — медиана внутренних столбцов. Рама по периметру — крайние столбцы/ряды,
// отличные от стекла (1–3 клетки, не меньше 5 см). Импост — узкая (до 0,25 м) серия столбцов, отличных от стекла
// в одну сторону (светлый или тёмный профиль) не меньше чем на половине высоты; горбылёк — то же по рядам.
function windowGrid(e, rc, opts) {
  opts = opts || {};
  const ns = e.ns, ds = opts.ds || 0.05, dh = opts.dh || 0.05, x0 = rc.x0, x1 = rc.x1, r0 = rc.r0, r1 = rc.r1, thr = rc.thr || 1;
  const W = x1 - x0, Hn = r1 - r0;
  if (W < 4 || Hn < 4) return null;
  const val = new Float32Array(W * Hn).fill(NaN);
  let nHas = 0, nCol = 0;
  for (let r = 0; r < Hn; r++) for (let x = 0; x < W; x++) {
    const c = (r0 + r) * ns + x0 + x, k = e.F[c]; if (k < thr) continue; nHas++;
    const R = e.rgb[c * 3], G = e.rgb[c * 3 + 1], B = e.rgb[c * 3 + 2];
    if (R > 0 || G > 0 || B > 0) { nCol++; val[r * W + x] = Math.max(R, G, B) / k / 255; }
  }
  const fill = nHas / (W * Hn), colored = nCol >= Math.max(12, 0.5 * nHas) && fill >= 0.3;
  if (!colored) for (let r = 0; r < Hn; r++) for (let x = 0; x < W; x++) val[r * W + x] = e.F[(r0 + r) * ns + x0 + x] >= thr ? 1 : 0;
  const cell = (r, x) => val[r * W + x];
  const prof = (n, m, at) => { const out = new Float32Array(n).fill(NaN); for (let i = 0; i < n; i++) { const a = []; for (let j = 0; j < m; j++) { const v = at(i, j); if (v === v) a.push(v); } if (a.length >= Math.max(2, 0.3 * m)) out[i] = colored ? median(a) : a.reduce((p, q) => p + q, 0) / m; } return out; };
  const cm = prof(W, Hn, (x, r) => cell(r, x)), rm = prof(Hn, W, (r, x) => cell(r, x));
  const inner = (p) => { const a = []; for (let i = 2; i < p.length - 2; i++) if (p[i] === p[i]) a.push(p[i]); return a; };
  const ic = inner(cm).concat(inner(rm));
  const gm = ic.length ? median(ic) : (colored ? 0.3 : 0), mad = ic.length ? median(ic.map((v) => Math.abs(v - gm))) : 0;
  const t = colored ? Math.max(0.12, 3 * mad) : Math.max(0.4, 3 * mad);
  const dev = (v) => (v === v ? v - gm : 0);
  const edge = (p, fromEnd) => { let n = 0; for (let k = 0; k < 3; k++) { const i = fromEnd ? p.length - 1 - k : k; if (Math.abs(dev(p[i])) > 0.7 * t) n = k + 1; else break; } return clamp(Math.max(1, n) * ds, 0.05, 0.15); };
  const fL = edge(cm, false), fR = edge(cm, true), fB = edge(rm, false), fT = rc.door ? edge(rm, true) : edge(rm, true);
  const sOf = (x) => (x0 + x) * ds, zOf = (r) => e.hb + (r0 + r) * dh;
  const S0 = sOf(0), S1 = sOf(W), Z0 = zOf(0), Z1 = zOf(Hn);
  const members = [
    { dir: 'v', frame: true, s0: S0, s1: S0 + fL, s: S0 + fL / 2, w: fL, z0: Z0, z1: Z1 },
    { dir: 'v', frame: true, s0: S1 - fR, s1: S1, s: S1 - fR / 2, w: fR, z0: Z0, z1: Z1 },
    { dir: 'h', frame: true, s0: S0 + fL, s1: S1 - fR, z0: Z0, z1: Z0 + fB },
    { dir: 'h', frame: true, s0: S0 + fL, s1: S1 - fR, z0: Z1 - fT, z1: Z1 },
  ];
  // внутренние импосты: серии отличных от стекла столбцов (рядов) вне рамы
  const runsOf = (p, a, b, m, at, maxW) => {
    const res = [];
    for (let i = a; i < b; i++) {
      const d = dev(p[i]); if (Math.abs(d) <= t) continue; const sg = Math.sign(d); let j = i; while (j + 1 < b && Math.sign(dev(p[j + 1])) === sg && Math.abs(dev(p[j + 1])) > t) j++;
      if ((j - i + 1) * ds <= maxW + 1e-9) {
        let best = 0, ws = 0, wc = 0;
        for (let k = i; k <= j; k++) { let n = 0, q = 0; for (let o = 0; o < m; o++) { const v = at(k, o); if (v !== v) continue; q++; if (Math.sign(v - gm) === sg && Math.abs(v - gm) > t / 2) n++; } if (q) best = Math.max(best, n / q); const wk = Math.abs(dev(p[k])); ws += wk; wc += wk * (k + 0.5); }
        if (best >= 0.5) res.push({ c: wc / ws, n: j - i + 1 });
      }
      i = j;
    }
    return res;
  };
  // профили рамы — крайние столбцы и ряды (наличник и коробка); импост и горбылёк должны совпадать с одним из них по яркости
  // (блики и полосы отражений в стекле — нет)
  const fvs = [cm[0], cm[1], cm[W - 1], cm[W - 2], rm[0], rm[1], rm[Hn - 1], rm[Hn - 2]].filter((v) => v === v);
  const likeFrame = (u, p) => { if (!colored || !fvs.length) return true; const a = []; for (let k = Math.floor(u.c - u.n / 2); k <= Math.ceil(u.c + u.n / 2 - 1); k++) if (p[k] === p[k]) a.push(p[k]); if (!a.length) return false; const v = Math.max.apply(null, a.map((q) => Math.abs(q - gm))) + gm, mv = a.reduce((x, y) => (Math.abs(y - gm) > Math.abs(x - gm) ? y : x), a[0]); return fvs.some((f) => Math.abs(mv - f) <= Math.max(0.1, t * 0.8)) && v === v; };
  const xa = Math.round(fL / ds), xb = W - Math.round(fR / ds), ra = Math.round(fB / dh), rb = Hn - Math.round(fT / dh);
  const mulls = runsOf(cm, xa + 4, xb - 4, Hn, (x, r) => cell(r, x), 0.25).filter((u) => likeFrame(u, cm)).filter((u, i, a) => i === 0 || (u.c - a[i - 1].c) * ds >= 0.2);
  const trans = runsOf(rm, ra + 4, rb - 4, W, (r, x) => cell(r, x), 0.25).filter((u) => likeFrame(u, rm)).filter((u, i, a) => i === 0 || (u.c - a[i - 1].c) * dh >= 0.2);
  const vs = mulls.map((u) => { const s = sOf(0) + u.c * ds, w = clamp(u.n * ds, 0.05, 0.15); return { dir: 'v', s, w, s0: s - w / 2, s1: s + w / 2, z0: Z0 + fB, z1: Z1 - fT }; });
  const hs = trans.map((u) => { const z = zOf(0) + u.c * dh, h = clamp(u.n * dh, 0.05, 0.15); return { dir: 'h', s0: S0 + fL, s1: S1 - fR, z0: z - h / 2, z1: z + h / 2 }; });
  members.push.apply(members, vs.concat(hs));
  // створки (стекло) — между рамой, импостами и горбыльками
  const cs = [S0 + fL].concat([].concat.apply([], vs.map((m) => [m.s0, m.s1])), [S1 - fR]);
  const zs = [Z0 + fB].concat([].concat.apply([], hs.map((m) => [m.z0, m.z1])), [Z1 - fT]);
  const panels = [];
  for (let i = 0; i < cs.length; i += 2) for (let j = 0; j < zs.length; j += 2) if (cs[i + 1] - cs[i] > 0.04 && zs[j + 1] - zs[j] > 0.04) panels.push({ kind: 'vision', mat: 'glass', s0: cs[i], s1: cs[i + 1], z0: zs[j], z1: zs[j + 1] });
  return { members, panels, colored, fill, mullions: vs.length, transoms: hs.length };
}

module.exports = { windowGrid, frameGrid, cellRunTop, foreignMask, prelimMaterial, refFace, elevAcc, analyseWall, colorClass, hsv, MATERIALS, mergeFaces, pairFaces, joinCorners, wallsOfStorey, fitPrimitives, fitColumn, circleLS, lineLS, hull, minRect, dilate, uvCollector, columnAcc, coverage, cellTop, cellBottom, isGreen, histPeaks, storeysFrom, storeyMask, components, median, quant, clamp, popc, DEG };
