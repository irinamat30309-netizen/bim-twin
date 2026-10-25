'use strict';
/*
 * scan2bim-mep.js — ревизия 40: инженерные сети по облаку точек (трубы, кабельные лотки, воздуховоды, кабели, балки).
 * Ревизия 41: признак «под перекрытием» (сеть без конструкции над ней в пределах 3 м — не сеть), лестничные лотки
 *  (пара боковин без сплошного дна), пучки кабелей, разбор остатка пятна, стояки (вертикальные трубы по слоям плана),
 *  соединение трасс: слияние соосных обрывков, отводы, тройники и переходы (фитинги).
 *
 * Принцип: сети под потолком идут вдоль главных направлений здания. Для каждого направления облако режется на
 * поперечные слои толщиной 0,2 м; в слое — битовая карта сечения (клетка 1,5 см, адаптивно по бюджету памяти).
 * Устойчивое сечение — клетка занята в двух из трёх соседних слоёв (подвесы, хомуты и поперечные связи отпадают).
 * Потолок и стены (серии длиннее 1 м по горизонтали и 0,6 м по вертикали) вычитаются, оставшиеся пятна:
 *  - дуга окружности (обычно нижняя половина — сканер снизу) — труба: центр и диаметр по МНК (Kasa), ряды труб,
 *    слитые в одно пятно, делятся по нижнему профилю (каждая труба — своя «чаша»);
 *  - плоское дно шириной 8 см – 1 м с невысокими бортами — кабельный лоток; с высокими бортами — воздуховод;
 *    прямоугольник, примыкающий к потолку, — балка;
 *  - пятно до 4,5 см — кабель (провод).
 * Сечения связываются по слоям в трассы (допуск 3 см + 1,5 см на пропущенный слой), трасса — полилиния (Дуглас — Пекер,
 * 2,5 см). Диаметр трубы приводится к ближайшему стандартному (ГОСТ 10704 / DN), цвет — по точкам (красный — АУПТ).
 */
const C = require('./scan2bim-core.js');

const DN = [[15, 21.3], [20, 26.9], [25, 33.7], [32, 42.4], [40, 48.3], [50, 60.3], [65, 76.1], [80, 88.9], [100, 114.3], [125, 139.7], [150, 168.3], [200, 219.1], [250, 273], [300, 323.9], [350, 355.6], [400, 406.4]];
function snapDN(d) {
  let best = null; DN.forEach((p) => { const e = Math.abs(p[1] / 1000 - d) / (p[1] / 1000); if (!best || e < best.e) best = { dn: p[0], d: p[1] / 1000, e }; });
  return best && best.e <= 0.15 ? best : null;
}

// главные направления по стенам: доминирующее, перпендикулярное и второе (если отличается больше чем на 8°)
function axesFrom(walls, opts) {
  opts = opts || {};
  const H = new Float64Array(180);
  (walls || []).forEach((w) => { if (w.kind !== 'line' || !w.a || !w.b) return; const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]); if (L < 1) return; let a = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]) * 180 / Math.PI; a = ((a % 180) + 180) % 180; H[Math.floor(a) % 180] += L; });
  const sm = (i) => { let s = 0; for (let k = -2; k <= 2; k++) s += H[(i + k + 180) % 180]; return s; };
  const peaks = []; for (let i = 0; i < 180; i++) { const v = sm(i); if (v > 0 && v >= sm((i + 1) % 180) && v > sm((i + 179) % 180)) peaks.push({ a: i + 0.5, v }); }
  peaks.sort((p, q) => q.v - p.v);
  const dd = (a, b) => { const d = Math.abs(((a - b) % 180 + 180) % 180); return Math.min(d, 180 - d); };
  const out = [];
  const push = (a) => { a = ((a % 180) + 180) % 180; if (out.every((b) => dd(a, b) > (opts.minSep || 4))) out.push(a); };
  if (!peaks.length) { push(0); push(90); }
  else {
    // уточнение угла: средневзвешенное по ±3°
    const refine = (a0) => { let s = 0, w = 0; for (let k = -3; k <= 3; k++) { const i = (Math.floor(a0) + k + 180) % 180, v = H[i]; s += (Math.floor(a0) + k + 0.5) * v; w += v; } return w ? s / w : a0; };
    const a1 = refine(peaks[0].a); push(a1); push(a1 + 90);
    const tot = peaks.reduce((s, p) => s + p.v, 0);
    const p2 = peaks.find((p) => dd(p.a, a1) > 8 && dd(p.a, a1 + 90) > 8 && p.v >= 0.12 * tot);
    if (p2) { const a2 = refine(p2.a); push(a2); push(a2 + 90); }
  }
  return out.slice(0, opts.maxAxes || 4).map((a) => a * Math.PI / 180);
}

// накопитель поперечных сечений
function mepAcc(opts) {
  opts = opts || {};
  const rect = opts.rect, zones = (opts.zones || []).filter((z) => z.h1 - z.h0 > 0.3).map((z) => Object.assign({}, z)).sort((a, b) => a.h0 - b.h0);
  const axes = (opts.axes && opts.axes.length ? opts.axes : [0, Math.PI / 2]);
  const slab = opts.slab || 0.2, budget = opts.budgetBits || 2.4e9, cc0 = 0.06;
  let cell = opts.cell || 0.015;
  const geo = (cell) => axes.map((phi) => {
    const ca = Math.cos(phi), sa = Math.sin(phi), cs = [[rect.u0, rect.v0], [rect.u1, rect.v0], [rect.u0, rect.v1], [rect.u1, rect.v1]];
    let a0 = Infinity, a1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    cs.forEach((p) => { const a = p[0] * ca + p[1] * sa, q = -p[0] * sa + p[1] * ca; a0 = Math.min(a0, a); a1 = Math.max(a1, a); q0 = Math.min(q0, q); q1 = Math.max(q1, q); });
    return { phi, ca, sa, a0, q0, nA: Math.max(1, Math.ceil((a1 - a0) / slab)), nq: Math.max(1, Math.ceil((q1 - q0) / cell)), nq5: Math.max(1, Math.ceil((q1 - q0) / cc0)) };
  });
  const zoneCells = (cell) => zones.reduce((s, z) => s + Math.ceil((z.h1 - z.h0) / cell), 0);
  let G = geo(cell), NH = zoneCells(cell), bits = G.reduce((s, g) => s + g.nA * g.nq * NH, 0);
  if (bits > budget) { cell = cell * Math.sqrt(bits / budget) * 1.02; G = geo(cell); NH = zoneCells(cell); bits = G.reduce((s, g) => s + g.nA * g.nq * NH, 0); }
  // грубая цветовая сетка — не больше colorBytes (3 байта на клетку)
  const colorBudget = opts.colorBytes || 1.2e8, cBytes = (c) => 3 * axes.length * zones.reduce((s, z) => s + Math.ceil((z.h1 - z.h0) / c), 0) * G.reduce((s, g) => Math.max(s, g.nA * Math.ceil(g.nq * cell / c)), 0);
  let cc = cc0; while (cBytes(cc) > colorBudget && cc < 0.5) cc *= 1.15;
  G.forEach((g) => { g.nq5 = Math.max(1, Math.ceil(g.nq * cell / cc)); });
  let off = 0, off5 = 0; zones.forEach((z) => { z.off = off; z.n = Math.ceil((z.h1 - z.h0) / cell); off += z.n; z.off5 = off5; z.n5 = Math.ceil((z.h1 - z.h0) / cc); off5 += z.n5; });
  const NH5 = off5;
  G.forEach((g) => { g.B = new Uint8Array(Math.ceil(g.nA * g.nq * NH / 8)); g.T = new Uint8Array(g.nA * g.nq5 * NH5); g.R = new Uint8Array(g.T.length); g.Gr = new Uint8Array(g.T.length); });
  const hmin = zones.length ? zones[0].h0 : 0, hmax = zones.length ? zones[zones.length - 1].h1 : 0;
  let n = 0;
  return {
    axes: G, zones, cell, slab, cc, NH, NH5, hmin, hmax, rect, bits,
    get points() { return n; },
    add(u, v, h, o) {
      if (h < hmin || h >= hmax || !zones.length) return;
      let z = null; for (let i = 0; i < zones.length; i++) { const zz = zones[i]; if (h >= zz.h0 && h < zz.h1) { z = zz; break; } }
      if (!z) return;
      n++;
      const ih = z.off + Math.floor((h - z.h0) / cell), ih5 = z.off5 + Math.floor((h - z.h0) / cc);
      let col = 0;
      if (o && o.r === o.r && (o.r > 0 || o.g > 0 || o.b > 0)) { const r = o.r, gg = o.g, b = o.b; col = r > gg * 1.4 + 18 && r > b * 1.3 + 18 ? 1 : (gg > r * 1.15 + 8 && gg >= b ? 2 : 3); }
      for (let k = 0; k < G.length; k++) {
        const g = G[k], a = u * g.ca + v * g.sa - g.a0, q = -u * g.sa + v * g.ca - g.q0;
        const ia = Math.floor(a / slab), iq = Math.floor(q / cell); if (ia < 0 || ia >= g.nA || iq < 0 || iq >= g.nq) continue;
        const idx = (ia * g.nq + iq) * NH + ih; g.B[idx >> 3] |= 1 << (idx & 7);
        if (col) { const ci = (ia * g.nq5 + Math.min(g.nq5 - 1, Math.floor(q / cc))) * NH5 + ih5; if (g.T[ci] < 255) { g.T[ci]++; if (col === 1 && g.R[ci] < 255) g.R[ci]++; else if (col === 2 && g.Gr[ci] < 255) g.Gr[ci]++; } }
      }
    }
  };
}

// ---------------------------------------------------------------- сечение слоя: устойчивые клетки без потолка и стен
function slabMask(acc, g, k, St, Rm) {
  const nq = g.nq, NH = acc.NH, B = g.B, N = nq * NH;
  St.fill(0); Rm.fill(0);
  const get = (kk) => { const o = new Uint8Array(N), base = kk * N; let a = 0; for (let i = 0; i < N; i++) { const idx = base + i; if (B[idx >> 3] & (1 << (idx & 7))) { o[i] = 1; a++; } } return a ? o : null; };
  const dil = (m) => { const o = new Uint8Array(N); for (let iq = 0; iq < nq; iq++) for (let r = 0; r < NH; r++) { if (!m[iq * NH + r]) continue; for (let dq = -1; dq <= 1; dq++) { const q = iq + dq; if (q < 0 || q >= nq) continue; for (let dr = -1; dr <= 1; dr++) { const rr = r + dr; if (rr >= 0 && rr < NH) o[q * NH + rr] = 1; } } } return o; };
  // устойчивое сечение: клетка занята в слое и (с допуском в клетку) в обоих соседних — 0,6 м непрерывности;
  // подвесы, хомуты и раскосы (поперёк трассы, тоньше слоя) отпадают
  const O = get(k); if (!O) return 0;
  const nb = [k - 1, k + 1].filter((x) => x >= 0 && x < g.nA).map(get);
  if (nb.some((m) => !m)) return 0;
  const D = nb.map(dil);
  let any = 0;
  for (let i = 0; i < N; i++) if (O[i] && D.every((m) => m[i])) { St[i] = 1; any++; }
  if (!any) return 0;
  // верх горизонтальных серий по столбцам — местный уровень потолка (для отсева его обрывков)
  const CT = g.cTop || (g.cTop = new Int16Array(nq)); CT.fill(-1);
  // ревизия 41: верх горизонтальных серий от 0,3 м по столбцам и зонам этажей — «над сетью есть конструкция»
  const NZ = acc.zones.length, CT2 = g.cTop2 && g.cTop2.length === nq * NZ ? g.cTop2 : (g.cTop2 = new Int16Array(nq * NZ)); CT2.fill(-1);
  const ZR = acc.zoneRow || (acc.zoneRow = (() => { const o = new Int16Array(NH).fill(-1); acc.zones.forEach((z, k) => { for (let r = z.off; r < z.off + z.n && r < NH; r++) o[r] = k; }); return o; })());
  const cell = acc.cell, LH = Math.round(1.8 / cell), LV = Math.round(0.6 / cell), LS = Math.max(4, Math.round(0.3 / cell));
  // горизонтальные серии (потолок, перекрытие) от 1,8 м — по полосе в 3 ряда, с допуском разрыва 4 клетки
  for (let ih = 0; ih < NH; ih++) {
    let s = -1, last = -10;
    const on = (iq) => St[iq * NH + ih] || (ih > 0 && St[iq * NH + ih - 1]) || (ih < NH - 1 && St[iq * NH + ih + 1]);
    for (let iq = 0; iq <= nq; iq++) {
      const o = iq < nq && on(iq);
      if (o) { if (s < 0 || iq - last > 5) { if (s >= 0) series(s, last, ih); s = iq; } last = iq; }
      if (iq === nq && s >= 0) series(s, last, ih);
    }
  }
  function series(a, b, ih) { const L = b - a + 1; if (L >= LS && ZR[ih] >= 0) { const base = ZR[ih] * nq; for (let iq = a; iq <= b; iq++) if (ih > CT2[base + iq]) CT2[base + iq] = ih; } if (L >= LH) markH(a, b, ih); }
  function markH(a, b, ih) { for (let iq = a; iq <= b; iq++) { if (ih > CT[iq]) CT[iq] = ih; for (let d = -2; d <= 2; d++) { const r = ih + d; if (r >= 0 && r < NH) Rm[iq * NH + r] = 1; } } }
  // вертикальные серии (стены) — в пределах зоны этажа
  acc.zones.forEach((z) => {
    for (let iq = 0; iq < nq; iq++) {
      let s = -1, last = -10;
      for (let r = z.off; r <= z.off + z.n; r++) {
        const on = r < z.off + z.n && St[iq * NH + r];
        if (on) { if (s < 0 || r - last > 2) { if (s >= 0 && last - s + 1 >= LV) markV(iq, s, last); s = r; } last = r; }
        if (r === z.off + z.n && s >= 0 && last - s + 1 >= LV) markV(iq, s, last);
      }
    }
  });
  function markV(iq, a, b) { for (let d = -1; d <= 1; d++) { const q = iq + d; if (q < 0 || q >= nq) continue; for (let r = a; r <= b; r++) Rm[q * NH + r] = 2; } }
  return any;
}

// пятна сечения (8-связность с перемычкой в 1 клетку)
function blobs(St, Rm, nq, NH, zones) {
  const N = nq * NH, M = new Uint8Array(N), lab = new Int32Array(N).fill(-1), out = [], st = [];
  for (let i = 0; i < N; i++) if (St[i] && !Rm[i]) M[i] = 1;
  const zoneOf = (r) => { for (let k = 0; k < zones.length; k++) if (r >= zones[k].off && r < zones[k].off + zones[k].n) return k; return -1; };
  for (let s = 0; s < N; s++) {
    if (!M[s] || lab[s] >= 0) continue;
    const id = out.length, zk = zoneOf(s % NH), z = zones[zk], cells = []; st.length = 0; st.push(s); lab[s] = id;
    let touchC = 0;
    while (st.length) {
      const c = st.pop(), iq = (c / NH) | 0, r = c - iq * NH; cells.push(iq, r);
      for (let dq = -2; dq <= 2; dq++) for (let dr = -2; dr <= 2; dr++) {
        if (!dq && !dr) continue; const q2 = iq + dq, r2 = r + dr; if (q2 < 0 || q2 >= nq || r2 < z.off || r2 >= z.off + z.n) continue;
        const c2 = q2 * NH + r2;
        if (Rm[c2] === 1 && Math.abs(dq) <= 1 && dr >= 1 && dr <= 2) touchC = 1;
        if (!M[c2] || lab[c2] >= 0) continue;
        lab[c2] = id; st.push(c2);
      }
    }
    out.push({ cells, zone: zk, touchC });
  }
  return out;
}

// ревизия 41: есть ли над сечением конструкция (горизонтальная серия от 0,3 м) в пределах 3 м — в окне ±1 м по сечению
function covered(acc, g, zk, qa, qb, top) {
  const C2 = g && g.cTop2; if (!C2 || C2.length !== g.nq * acc.zones.length) return true;
  const cell = acc.cell, w = Math.max(Math.round(1.0 / cell), qb - qa + 1), lim = 3.0 / cell, base = zk * g.nq, z = acc.zones[zk];
  // сеть у верха зоны этажа (местный потолок выше пика гистограммы) — конструкция над ней вне сечения, считается перекрытой
  if (z && (z.off + z.n - 1 - top) * cell <= 0.15) return true;
  for (let q = Math.max(0, qa - w); q <= Math.min(g.nq - 1, qb + w); q++) { const ct = C2[base + q]; if (ct > top + 1 && ct - top <= lim) return true; }
  return false;
}
// местный потолок над столбцами [qa, qb] (±20 клеток): верх длинных горизонтальных серий
function ceilTop(g, qa, qb) { if (!g || !g.cTop) return -1; let ct = -1; for (let q = Math.max(0, qa - 20); q <= Math.min(g.nq - 1, qb + 20); q++) if (g.cTop[q] > ct) ct = g.cTop[q]; return ct; }

// разбор пятна: трубы (по чашам нижнего профиля), лоток, воздуховод, балка, кабель, пучок кабелей; остаток пятна — повторно
function analyseBlob(b, acc, g, depth) {
  depth = depth || 0;
  const cell = acc.cell, z = acc.zones[b.zone], cs = b.cells, n = cs.length / 2, dets = [];
  if (n < 3) return dets;
  let q0 = Infinity, q1 = -1, r0 = Infinity, r1 = -1;
  for (let i = 0; i < n; i++) { const q = cs[i * 2], r = cs[i * 2 + 1]; if (q < q0) q0 = q; if (q > q1) q1 = q; if (r < r0) r0 = r; if (r > r1) r1 = r; }
  const W = (q1 - q0 + 1) * cell, Hh = (r1 - r0 + 1) * cell, hOf = (r) => z.h0 + (r - z.off + 0.5) * cell, qOf = (q) => (q + 0.5) * cell;
  if (W > 2.5 || Hh > 1.2) return dets;
  if (W <= 0.046 && Hh <= 0.046) { if (n >= 2) { let sq = 0, sr = 0; for (let i = 0; i < n; i++) { sq += cs[i * 2]; sr += cs[i * 2 + 1]; } dets.push({ kind: 'cable', q: qOf(sq / n), h: hOf(sr / n), r: Math.max(cell / 2, (W + Hh) / 2 - cell) / 2, n, cov: covered(acc, g, b.zone, q0, q1, r1) }); } return dets; }
  const nc = q1 - q0 + 1, hb = new Float64Array(nc).fill(Infinity), ht = new Float64Array(nc).fill(-Infinity);
  for (let i = 0; i < n; i++) { const c = cs[i * 2] - q0, r = cs[i * 2 + 1]; if (r < hb[c]) hb[c] = r; if (r > ht[c]) ht[c] = r; }
  // сглаженный нижний профиль (пустые столбцы — интерполяция)
  const hp = new Float64Array(nc); for (let c = 0; c < nc; c++) { if (hb[c] < Infinity) { hp[c] = hb[c]; continue; } let a = c - 1, d = c + 1; while (a >= 0 && hb[a] === Infinity) a--; while (d < nc && hb[d] === Infinity) d++; hp[c] = a >= 0 && d < nc ? (hb[a] + hb[d]) / 2 : (a >= 0 ? hb[a] : hb[d]); }
  // чаши: локальные минимумы, разделённые подъёмом не меньше 2 клеток и четверти расстояния между ними
  const mins = []; for (let c = 0; c < nc; c++) { const l = c > 0 ? hp[c - 1] : Infinity, rr = c < nc - 1 ? hp[c + 1] : Infinity; if (hp[c] <= l && hp[c] <= rr) { if (mins.length && c - mins[mins.length - 1] <= 1) continue; mins.push(c); } }
  const cuts = [];
  for (let i = 1; i < mins.length; i++) {
    let mx = mins[i - 1], mv = -Infinity; for (let c = mins[i - 1]; c <= mins[i]; c++) if (hp[c] > mv) { mv = hp[c]; mx = c; }
    const rise = mv - Math.max(hp[mins[i - 1]], hp[mins[i]]);
    if (rise >= Math.max(2, 0.25 * (mins[i] - mins[i - 1]))) cuts.push(mx);
  }
  const segs = []; let a = 0; cuts.forEach((c) => { segs.push([a, c]); a = c + 1; }); segs.push([a, nc - 1]);
  const P = []; const ids = [];
  segs.forEach((sg) => {
    const ca = sg[0], cb = sg[1], ws = (cb - ca + 1) * cell; if (cb - ca + 1 < 2) return;
    let hmin = Infinity, top = -Infinity; for (let c = ca; c <= cb; c++) { if (hb[c] < hmin) hmin = hb[c]; if (ht[c] > top) top = ht[c]; }
    const lim = hmin + Math.max(3, (cb - ca + 1));
    P.length = 0; ids.length = 0; let nseg = 0, sq = 0, sr = 0;
    for (let i = 0; i < n; i++) { const c = cs[i * 2] - q0, r = cs[i * 2 + 1]; if (c < ca || c > cb) continue; nseg++; sq += cs[i * 2]; sr += r; if (r > lim) continue; ids.push(ids.length); P.push(qOf(cs[i * 2]), hOf(r)); }
    if (ids.length < 5) return;
    const cov = covered(acc, g, b.zone, q0 + ca, q0 + cb, top);
    // плоское дно шире 12 см (лоток, короб) — не труба, даже если окружность ложится
    const bot0 = []; for (let c = ca; c <= cb; c++) if (hb[c] < Infinity) bot0.push(hb[c]);
    const bm0 = C.median(bot0), flat0 = bot0.filter((v) => Math.abs(v - bm0) <= 1.01).length / Math.max(1, cb - ca + 1);
    const fit = ws >= 0.12 && flat0 >= 0.9 ? null : C.circleLS(P, ids);
    let ok = false;
    if (fit && fit.r > 0.008 && fit.r < 0.36) {
      let e2 = 0, amin = Infinity, amax = -Infinity, below = 0;
      for (const i of ids) { const dq = P[i * 2] - fit.cx, dh = P[i * 2 + 1] - fit.cy, d = Math.hypot(dq, dh); e2 += (d - fit.r) * (d - fit.r); const an = Math.atan2(dh, dq); if (an < amin) amin = an; if (an > amax) amax = an; if (dh < 0) below++; }
      const rms = Math.sqrt(e2 / ids.length), span = amax - amin;
      if (rms <= Math.max(0.45 * cell, 0.12 * fit.r) && span >= 1.6 && ws >= 1.1 * fit.r && ws <= 2.3 * fit.r + 2 * cell && fit.cy > hOf(hmin) + 0.4 * fit.r) { dets.push({ kind: 'pipe', q: fit.cx, h: fit.cy, r: fit.r, rms, n: ids.length, cov }); ok = true; }
    }
    if (ok) return;
    // ревизия 41: пучок кабелей — неровное пятно до 15 см шириной и 3–15 см высотой (не окружность, не плоское дно)
    const hs0 = (top - hmin + 1) * cell;
    if (ws <= 0.15 && flat0 < 0.6 && hs0 >= 0.03 && hs0 <= 0.15 && nseg >= 6) {
      const ct = ceilTop(g, q0 + ca, q0 + cb);
      if ((ct >= 0 && (ct - top) * cell <= 0.12) || (z.ceil && hOf(top) >= z.ceil - 0.12)) return;
      dets.push({ kind: 'cable', bundle: true, q: qOf(sq / nseg), h: hOf(sr / nseg), r: Math.max(0.015, (ws + hs0) / 4 - cell / 2), n: nseg, cov });
      return;
    }
    // плоское дно: лоток / воздуховод / балка
    if (ws < 0.08) return;
    const bot = []; for (let c = ca; c <= cb; c++) if (hb[c] < Infinity) bot.push(hb[c]);
    const bm = C.median(bot), flat = bot.filter((v) => Math.abs(v - bm) <= 1.01).length / Math.max(1, cb - ca + 1);
    if (flat < 0.6) return;
    const hs = (top - bm + 1) * cell, side = Math.max(ht[ca] - hb[ca], ht[cb] - hb[cb]) * cell;
    const kind = b.touchC && hs >= 0.15 && ws >= 0.15 ? 'beam' : (hs >= 0.18 && ws >= 0.15 && side >= 0.12 ? 'duct' : 'tray');
    // обрывки потолка: тонкая плоская полоса в 12 см под местным потолком (или под потолком этажа)
    if (kind !== 'beam' && hs <= 0.1) { const ct = ceilTop(g, q0 + ca, q0 + cb); if (ct >= 0 && (ct - top) * cell <= 0.12) return; }
    if (kind !== 'beam' && hs <= 0.1 && z.ceil && hOf(top) >= z.ceil - 0.12) return;
    if (kind === 'tray' && ws > 1.2) return;
    // узкое «плоское» сечение без бортов (края ниже половины высоты) — пучок кабелей, а не лоток
    if (kind === 'tray' && ws <= 0.15 && hs >= 0.03 && hs <= 0.15 && side < 0.5 * hs) {
      if (hOf(top) >= (z.ceil || Infinity) - 0.12) return;
      dets.push({ kind: 'cable', bundle: true, q: qOf(sq / nseg), h: hOf(sr / nseg), r: Math.max(0.015, (ws + hs) / 4 - cell / 2), n: nseg, cov });
      return;
    }
    dets.push({ kind, q: qOf(q0 + (ca + cb) / 2), h: hOf(bm) - cell / 2, w: ws, hgt: Math.max(kind === 'tray' ? 0.05 : 0.1, hs), n: ids.length, cov: kind === 'beam' ? true : cov });
  });
  // ревизия 41: остаток пятна, не объяснённый найденными сечениями (труба рядом с лотком, кабель на подвесе) — разбор заново
  if (depth < 2 && n >= 8) {
    const left = [];
    for (let i = 0; i < n; i++) {
      const q = cs[i * 2], r = cs[i * 2 + 1], x = qOf(q), y = hOf(r);
      let ex = false;
      for (const d of dets) {
        if (d.kind === 'pipe' || d.kind === 'cable') { if (Math.hypot(x - d.q, y - d.h) <= d.r + 2 * cell) { ex = true; break; } }
        else if (Math.abs(x - d.q) <= d.w / 2 + cell && y >= d.h - 2 * cell && y <= d.h + d.hgt + (d.kind === 'tray' ? 0.25 : 2 * cell)) { ex = true; break; }
      }
      if (!ex) left.push(q, r);
    }
    const nl = left.length / 2;
    if (nl >= 8 && nl < n) {
      const key = new Map(); for (let i = 0; i < nl; i++) key.set(left[i * 2] * 65536 + left[i * 2 + 1], i);
      const seen = new Uint8Array(nl);
      for (let s0 = 0; s0 < nl; s0++) {
        if (seen[s0]) continue; seen[s0] = 1; const st = [s0], comp = [];
        while (st.length) { const i = st.pop(), q = left[i * 2], r = left[i * 2 + 1]; comp.push(q, r); for (let dq = -1; dq <= 1; dq++) for (let dr = -1; dr <= 1; dr++) { const j = key.get((q + dq) * 65536 + r + dr); if (j !== undefined && !seen[j]) { seen[j] = 1; st.push(j); } } }
        if (comp.length / 2 >= 8) analyseBlob({ cells: comp, zone: b.zone, touchC: b.touchC }, acc, g, depth + 1).forEach((d) => dets.push(d));
      }
    }
  }
  return dets;
}

// ревизия 41: лестничный лоток — две узкие боковины на одной высоте в разных пятнах (сплошного дна между ними нет:
// поперечины тоньше слоя и отпадают как подвесы); пятна между боковинами (кабели в лотке) — содержимое лотка
function ladderTrays(bl, acc, g) {
  const cell = acc.cell, rails = [], dets = [], used = new Set(), Hmin = 0.045, Wmax = 0.05;
  bl.forEach((b, i) => {
    const cs = b.cells, n = cs.length / 2; if (n < 3) return;
    let q0 = Infinity, q1 = -1, r0 = Infinity, r1 = -1;
    for (let k = 0; k < n; k++) { const q = cs[k * 2], r = cs[k * 2 + 1]; if (q < q0) q0 = q; if (q > q1) q1 = q; if (r < r0) r0 = r; if (r > r1) r1 = r; }
    b.bb = [q0, q1, r0, r1];
    if ((q1 - q0 + 1) * cell > 1.2 || (r1 - r0 + 1) * cell > 0.4) return;
    const nc = q1 - q0 + 1, hb = new Int32Array(nc).fill(1 << 30), ht = new Int32Array(nc).fill(-1);
    for (let k = 0; k < n; k++) { const c = cs[k * 2] - q0, r = cs[k * 2 + 1]; if (r < hb[c]) hb[c] = r; if (r > ht[c]) ht[c] = r; }
    const H = (c) => (c < 0 || c >= nc || ht[c] < 0 ? 0 : (ht[c] - hb[c] + 1) * cell);
    // боковина: узкая серия высоких столбцов, соседние столбцы заметно ниже
    for (let c = 0; c < nc; c++) {
      if (H(c) < Hmin || H(c) > 0.2) continue;
      let e = c; while (e + 1 < nc && H(e + 1) >= Hmin && H(e + 1) <= 0.2) e++;
      const w = (e - c + 1) * cell; let rb = 1 << 30, rt = -1, hm = 0;
      for (let k = c; k <= e; k++) { rb = Math.min(rb, hb[k]); rt = Math.max(rt, ht[k]); hm = Math.max(hm, H(k)); }
      if (w <= Wmax && H(c - 1) <= 0.6 * hm && H(e + 1) <= 0.6 * hm && hm >= Math.max(Hmin, 1.5 * w)) rails.push({ i, zone: b.zone, qa: q0 + c, qb: q0 + e, rb, rt });
      c = e;
    }
  });
  rails.sort((x, y) => x.qa - y.qa);
  const taken = new Set();
  for (let ii = 0; ii < rails.length; ii++) {
    const A = rails[ii]; if (taken.has(ii)) continue;
    for (let jj = ii + 1; jj < rails.length; jj++) {
      const B = rails[jj]; if (taken.has(jj) || B.zone !== A.zone || B.i === A.i) continue;
      const sep = ((B.qa + B.qb) - (A.qa + A.qb)) / 2 * cell; if (sep > 1.0) break; if (sep < 0.1) continue;
      if (Math.abs(A.rb - B.rb) * cell > 0.025 || Math.abs(A.rt - B.rt) * cell > 0.04) continue;
      const z = acc.zones[A.zone], hOf = (r) => z.h0 + (r - z.off + 0.5) * cell, rb = Math.min(A.rb, B.rb), rt = Math.max(A.rt, B.rt), top = rt + Math.round(0.25 / cell);
      // между боковинами ниже их низа ничего нет (иначе это не лоток, а две стойки над чем-то)
      let low = false; const inner = [];
      bl.forEach((c, k) => { if (!c.bb || c.zone !== A.zone || c.bb[1] < A.qa || c.bb[0] > B.qb) return; if (c.bb[0] > A.qb && c.bb[1] < B.qa && c.bb[2] < rb - 2 && c.bb[3] >= rb) low = true; if (c.bb[0] >= A.qa - 1 && c.bb[1] <= B.qb + 1 && c.bb[2] >= rb - 2 && c.bb[3] <= top) inner.push(k); });
      if (low) continue;
      taken.add(ii); taken.add(jj); inner.forEach((k) => used.add(k));
      dets.push({ kind: 'tray', ladder: true, zone: A.zone, q: (A.qa + B.qb + 1) / 2 * cell, h: hOf(rb) - cell / 2, w: (B.qb - A.qa + 1) * cell, hgt: Math.max(0.05, (rt - rb + 1) * cell), n: 0, cov: covered(acc, g, A.zone, A.qa, B.qb, rt) });
      break;
    }
  }
  return { dets, used };
}

function dp(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [i, j] = st.pop(); const A = pts[i], B = pts[j], d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1e-12;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) { const p = pts[k], t = C.clamp(((p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1] + (p[2] - A[2]) * d[2]) / L2, 0, 1); const e = Math.hypot(p[0] - A[0] - t * d[0], p[1] - A[1] - t * d[1], p[2] - A[2] - t * d[2]); if (e > bd) { bd = e; best = k; } }
    if (best >= 0) { keep[best] = 1; st.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

// ---------------------------------------------------------------- поиск: сечения → трассы → элементы
function mepFind(acc, opts) {
  opts = opts || {};
  const cell = acc.cell, slab = acc.slab, NH = acc.NH, out = [];
  const minLen = Object.assign({ pipe: 1.0, tray: 1.0, duct: 1.2, beam: 1.5, cable: 2.0 }, opts.minLen || {});
  acc.axes.forEach((g, ai) => {
    const N = g.nq * NH, St = new Uint8Array(N), Rm = new Uint8Array(N);
    const tracks = [], done = [];
    for (let k = 0; k < g.nA; k++) {
      const any = slabMask(acc, g, k, St, Rm);
      const dets = [];
      if (any) {
        let bl = blobs(St, Rm, g.nq, NH, acc.zones);
        if (opts.ladder !== false) { const lt = ladderTrays(bl, acc, g); lt.dets.forEach((d) => dets.push(d)); if (lt.used.size) bl = bl.filter((b, i) => !lt.used.has(i)); }
        bl.forEach((b) => analyseBlob(b, acc, g, 0).forEach((d) => { d.zone = b.zone; dets.push(d); }));
      }
      // связывание со вчерашними трассами: ближайшая подходящая
      const cand = [];
      tracks.forEach((t, ti) => {
        const gap = k - t.k1; if (gap > (t.kind === 'cable' ? 3 : 4)) return;
        dets.forEach((d, di) => {
          if (d.kind !== t.kind || d.zone !== t.zone) return;
          const L = t.hits[t.hits.length - 1], dq = Math.abs(d.q - L.q), dh = Math.abs(d.h - L.h);
          if (dq > 0.03 + 0.015 * (gap - 1) || dh > (t.kind === 'cable' ? 0.06 : 0.03 + 0.01 * (gap - 1))) return;
          if (t.kind === 'pipe' && Math.abs(d.r - t.rm) > Math.max(0.012, 0.35 * t.rm)) return;
          if ((t.kind === 'tray' || t.kind === 'duct' || t.kind === 'beam') && Math.abs(d.w - t.wm) > Math.max(0.05, 0.25 * t.wm)) return;
          cand.push({ ti, di, s: dq + dh });
        });
      });
      cand.sort((p, q) => p.s - q.s);
      const usedT = new Set(), usedD = new Set();
      cand.forEach((c) => { if (usedT.has(c.ti) || usedD.has(c.di)) return; usedT.add(c.ti); usedD.add(c.di); const t = tracks[c.ti], d = dets[c.di]; d.k = k; t.hits.push(d); t.k1 = k; const m = t.hits.length; if (d.r) t.rm += (d.r - t.rm) / m; if (d.w) t.wm += (d.w - t.wm) / m; });
      dets.forEach((d, di) => { if (usedD.has(di)) return; d.k = k; tracks.push({ kind: d.kind, zone: d.zone, k0: k, k1: k, hits: [d], rm: d.r || 0, wm: d.w || 0 }); });
      for (let i = tracks.length - 1; i >= 0; i--) if (k - tracks[i].k1 > 4) { done.push(tracks[i]); tracks.splice(i, 1); }
    }
    done.push.apply(done, tracks);
    // сшивка обрывков одной трассы: тот же вид и размер, разрыв до 1,5 м, смещение до 5 см
    done.sort((p, q) => p.k0 - q.k0);
    const KG = Math.round(1.5 / slab);
    for (let i = 0; i < done.length; i++) {
      const t = done[i]; if (!t || t.hits.length < 2) continue;
      let best = -1, bs = Infinity;
      for (let j = 0; j < done.length; j++) {
        const p = done[j]; if (j === i || !p || p.kind !== t.kind || p.zone !== t.zone || p.k1 >= t.k0 || t.k0 - p.k1 > KG) continue;
        const A = p.hits[p.hits.length - 1], B = t.hits[0], dq = Math.abs(A.q - B.q), dh = Math.abs(A.h - B.h);
        if (dq > 0.05 || dh > 0.05) continue;
        if (t.kind === 'pipe' && Math.abs(p.rm - t.rm) > Math.max(0.012, 0.35 * Math.max(p.rm, t.rm))) continue;
        if (t.kind !== 'pipe' && t.kind !== 'cable' && Math.abs(p.wm - t.wm) > Math.max(0.05, 0.3 * Math.max(p.wm, t.wm))) continue;
        const sc = dq + dh + 0.01 * (t.k0 - p.k1); if (sc < bs) { bs = sc; best = j; }
      }
      if (best < 0) continue;
      const p = done[best], np = p.hits.length, nt = t.hits.length;
      t.hits = p.hits.concat(t.hits); t.k0 = p.k0; t.gaps = (p.gaps || 0) + (t.gaps || 0) + 1;
      t.rm = (p.rm * np + t.rm * nt) / (np + nt); t.wm = (p.wm * np + t.wm * nt) / (np + nt);
      done[best] = null; i = -1; // повтор с начала — цепочки из многих обрывков
    }
    for (let i = done.length - 1; i >= 0; i--) if (!done[i]) done.splice(i, 1);
    done.forEach((t) => {
      const span = (t.k1 - t.k0 + 1) * slab;
      if (span < minLen[t.kind] || t.hits.length < Math.max(3, (t.gaps ? 0.3 : 0.45) * (t.k1 - t.k0 + 1))) return;
      if (t.kind === 'cable' && t.hits.length < (t.gaps ? 0.4 : 0.6) * (t.k1 - t.k0 + 1)) return;
      const H = t.hits, med = (f, i) => { const a = []; for (let j = Math.max(0, i - 2); j <= Math.min(H.length - 1, i + 2); j++) a.push(f(H[j])); return C.median(a); };
      const pts = H.map((d, i) => { const aa = g.a0 + (d.k + 0.5) * slab, q = g.q0 + med((x) => x.q, i), h = med((x) => x.h, i); return [aa * g.ca - q * g.sa, aa * g.sa + q * g.ca, h]; });
      // концы — на половину слоя дальше
      const ext = (p, p2, s) => { const d = [p[0] - p2[0], p[1] - p2[1]], L = Math.hypot(d[0], d[1]) || 1; return [p[0] + d[0] / L * s, p[1] + d[1] / L * s, p[2]]; };
      if (pts.length >= 2) { pts[0] = ext(pts[0], pts[1], slab / 2); pts[pts.length - 1] = ext(pts[pts.length - 1], pts[pts.length - 2], slab / 2); }
      const path = dp(pts, 0.025).map((p) => p.map((x) => Math.round(x * 1000) / 1000));
      let length = 0; for (let i = 1; i < path.length; i++) length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
      const el = { kind: t.kind, storey: acc.zones[t.zone].storey, axis: Math.round(g.phi * 180 / Math.PI * 10) / 10, path, length: Math.round(length * 100) / 100, hits: H.length, points: H.reduce((s, d) => s + (d.n || 0), 0) };
      if (t.kind === 'pipe' || t.kind === 'cable') {
        const d = 2 * C.median(H.map((x) => x.r)); el.d = Math.round(d * 1000) / 1000;
        if (t.kind === 'pipe') { const s = snapDN(d); if (s) { el.dn = s.dn; el.dNom = s.d; } el.rms = Math.round(C.median(H.map((x) => x.rms)) * 10000) / 10000; }
        if (t.kind === 'cable') { const nb = H.filter((x) => x.bundle).length; if (nb >= 0.5 * H.length) el.bundle = true; el.d = Math.max(0.01, Math.min(el.bundle ? 0.15 : 0.045, el.d)); }
      } else { el.w = Math.round(C.median(H.map((x) => x.w)) * 1000) / 1000; el.hgt = Math.round(C.median(H.map((x) => x.hgt)) * 1000) / 1000; if (t.kind === 'tray' && H.filter((x) => x.ladder).length >= 0.4 * H.length) el.ladder = true; }
      // ревизия 41: доля сечений, над которыми есть конструкция (перекрытие, балка, другая сеть) в пределах 3 м
      el.cover = Math.round(H.filter((x) => x.cov !== false).length / H.length * 100) / 100;
      // цвет по точкам — доля красных и зелёных в сечении
      let T = 0, R = 0, Gr = 0; const z = acc.zones[t.zone];
      H.forEach((d) => {
        const rr = d.r || 0.03, hh0 = d.r ? d.h - rr : d.h, hh1 = d.r ? d.h + rr * 0.3 : d.h + Math.min(0.1, d.hgt || 0.05);
        const qa = Math.floor((d.q - (d.r || (d.w || 0.06) / 2)) / acc.cc), qb = Math.floor((d.q + (d.r || (d.w || 0.06) / 2)) / acc.cc);
        const ra = z.off5 + Math.floor((hh0 - z.h0) / acc.cc), rb = z.off5 + Math.floor((hh1 - z.h0) / acc.cc);
        for (let q = Math.max(0, qa); q <= Math.min(g.nq5 - 1, qb); q++) for (let r = Math.max(z.off5, ra); r <= Math.min(z.off5 + z.n5 - 1, rb); r++) { const ci = (d.k * g.nq5 + q) * acc.NH5 + r; T += g.T[ci]; R += g.R[ci]; Gr += g.Gr[ci]; }
      });
      el.color = T >= 10 ? (R / T >= 0.3 ? 'red' : (Gr / T >= 0.3 ? 'green' : 'gray')) : null;
      // красное плоскодонное сечение до 0,4 м — труба пожаротушения, видимая снизу частично
      if (el.color === 'red' && (el.kind === 'tray' || el.kind === 'duct') && el.w <= 0.4 && el.hgt >= 0.5 * el.w) {
        el.kind = 'pipe'; el.d = Math.round(Math.min(el.w, el.hgt * 1.2) * 1000) / 1000; const s = snapDN(el.d); if (s) { el.dn = s.dn; el.dNom = s.d; }
        el.path = el.path.map((p) => [p[0], p[1], Math.round((p[2] + el.d / 2) * 1000) / 1000]); delete el.w; delete el.hgt; el.fromFlat = true;
      }
      if ((el.kind === 'tray' || el.kind === 'duct') && (el.length < (el.kind === 'tray' ? 1.5 : 1.2) || H.length < (t.gaps ? 0.4 : 0.6) * (t.k1 - t.k0 + 1))) return;
      // ревизия 41: сеть висит под конструкцией — без перекрытия над ней (ригели и импосты фасада, кромка кровли) не сеть
      // (красная труба — пожаротушение по цвету — сохраняется и там, где перекрытие не попало в скан)
      if (opts.needCeiling !== false && el.kind !== 'beam' && el.cover < 0.5 && el.color !== 'red') return;
      if (el.fromFlat) delete el.ladder;
      out.push(el);
    });
  });
  // дубли между близкими направлениями: оставляем элемент с большим числом сечений
  const size = (e) => e.d || e.w || 0.05;
  const distTo = (p, path) => { let best = Infinity; for (let i = 1; i < path.length; i++) { const A = path[i - 1], B = path[i], d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1e-12, t = C.clamp(((p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1] + (p[2] - A[2]) * d[2]) / L2, 0, 1); best = Math.min(best, Math.hypot(p[0] - A[0] - t * d[0], p[1] - A[1] - t * d[1], p[2] - A[2] - t * d[2])); } return best; };
  const samples = (path) => { const o = []; for (let i = 1; i < path.length; i++) { const A = path[i - 1], B = path[i], L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]), k = Math.max(1, Math.ceil(L / 0.25)); for (let j = 0; j <= k; j++) o.push([A[0] + (B[0] - A[0]) * j / k, A[1] + (B[1] - A[1]) * j / k, A[2] + (B[2] - A[2]) * j / k]); } return o; };
  out.sort((p, q) => q.hits - p.hits);
  const keep = [];
  out.forEach((e) => {
    const S = samples(e.path);
    const dup = keep.some((k) => {
      if (k.storey !== e.storey) return false;
      const tol = Math.max(0.05, 0.6 * (size(e) + size(k)) / 2 + 0.02);
      let n = 0; S.forEach((p) => { if (distTo(p, k.path) <= tol) n++; });
      return n >= 0.5 * S.length;
    });
    if (!dup) keep.push(e);
  });
  keep.sort((p, q) => (p.storey - q.storey) || p.kind.localeCompare(q.kind) || (q.length - p.length));
  keep.forEach((e, i) => { e.id = 'N' + (i + 1); });
  return keep;
}

// ================================================================ ревизия 41: стояки — вертикальные трубы
// План этажа режется на горизонтальные слои 0,2 м (от 0,15 м над полом до потолка), в слое — битовая карта плана 1,5 см
// в осях здания. Устойчивые клетки (есть в соседних слоях) без длинных прямых серий (стены, перегородки, шкафы) дают
// пятна; дуга окружности (сканер видит трубу сбоку) — сечение стояка; сечения связываются по высоте в трассу.
function riserAcc(opts) {
  opts = opts || {};
  const rect = opts.rect, phi = opts.axes && opts.axes.length ? opts.axes[0] : 0, slab = opts.slab || 0.2;
  const zones = (opts.zones || []).filter((z) => z.h1 - z.h0 >= 1.0).map((z) => Object.assign({}, z)).sort((a, b) => a.h0 - b.h0);
  const ca = Math.cos(phi), sa = Math.sin(phi);
  let a0 = Infinity, a1 = -Infinity, q0 = Infinity, q1 = -Infinity;
  [[rect.u0, rect.v0], [rect.u1, rect.v0], [rect.u0, rect.v1], [rect.u1, rect.v1]].forEach((p) => { const a = p[0] * ca + p[1] * sa, q = -p[0] * sa + p[1] * ca; a0 = Math.min(a0, a); a1 = Math.max(a1, a); q0 = Math.min(q0, q); q1 = Math.max(q1, q); });
  let off = 0; zones.forEach((z) => { z.k0 = off; z.nk = Math.ceil((z.h1 - z.h0) / slab); off += z.nk; });
  const NK = off, budget = opts.budgetBits || 1.2e9;
  let cell = opts.cell || 0.015;
  const dims = (c) => [Math.max(1, Math.ceil((a1 - a0) / c)), Math.max(1, Math.ceil((q1 - q0) / c))];
  let D = dims(cell);
  if (D[0] * D[1] * NK > budget) { cell *= Math.sqrt(D[0] * D[1] * NK / budget) * 1.02; D = dims(cell); }
  const nA = D[0], nQ = D[1], N = nA * nQ, NB = Math.ceil(N / 8);
  const B = new Uint8Array(NB * Math.max(1, NK));
  // цвет — грубая сетка плана 6 см на этаж (доли красных и зелёных точек)
  let cc = 0.06; while (3 * 2 * zones.length * Math.ceil((a1 - a0) / cc) * Math.ceil((q1 - q0) / cc) > (opts.colorBytes || 6e7) && cc < 0.5) cc *= 1.15;
  const ncA = Math.ceil((a1 - a0) / cc), ncQ = Math.ceil((q1 - q0) / cc), NC = ncA * ncQ;
  const T = new Uint16Array(NC * zones.length), R = new Uint16Array(T.length), Gr = new Uint16Array(T.length);
  const hmin = zones.length ? zones[0].h0 : 0, hmax = zones.length ? zones[zones.length - 1].h1 : 0;
  let n = 0;
  return {
    phi, ca, sa, a0, q0, nA, nQ, N, NB, B, cell, slab, zones, cc, ncA, ncQ, NC, T, R, Gr, hmin, hmax, rect,
    get points() { return n; },
    add(u, v, h, o) {
      if (h < hmin || h >= hmax) return;
      let zi = -1; for (let i = 0; i < zones.length; i++) if (h >= zones[i].h0 && h < zones[i].h1) { zi = i; break; }
      if (zi < 0) return;
      const z = zones[zi], a = u * ca + v * sa - a0, q = -u * sa + v * ca - q0, ia = Math.floor(a / cell), iq = Math.floor(q / cell);
      if (ia < 0 || iq < 0 || ia >= nA || iq >= nQ) return;
      n++;
      const k = z.k0 + Math.floor((h - z.h0) / slab), i = ia * nQ + iq;
      B[k * NB + (i >> 3)] |= 1 << (i & 7);
      if (o && o.r === o.r && (o.r > 0 || o.g > 0 || o.b > 0)) {
        const ci = zi * NC + Math.min(ncA - 1, Math.floor(a / cc)) * ncQ + Math.min(ncQ - 1, Math.floor(q / cc));
        if (T[ci] < 65535) { T[ci]++; const r = o.r, gg = o.g, b = o.b; if (r > gg * 1.4 + 18 && r > b * 1.3 + 18) R[ci]++; else if (gg > r * 1.15 + 8 && gg >= b) Gr[ci]++; }
      }
    }
  };
}

// сечения стояков одного слоя: [{a, q, r, rms, n}]
function riserSlab(acc, k, kPrev, kNext, W) {
  const { nA, nQ, NB, B, cell } = acc, base = k * NB;
  const has = (kk, ia, iq) => { if (ia < 0 || iq < 0 || ia >= nA || iq >= nQ) return false; const i = ia * nQ + iq; return (B[kk * NB + (i >> 3)] >> (i & 7)) & 1; };
  const near = (kk, ia, iq) => { for (let da = -1; da <= 1; da++) for (let dq = -1; dq <= 1; dq++) if (has(kk, ia + da, iq + dq)) return true; return false; };
  // 1) устойчивые клетки
  const S = W.S; S.length = 0;
  for (let j = 0; j < NB; j++) {
    const by = B[base + j]; if (!by) continue;
    for (let b = 0; b < 8; b++) {
      if (!((by >> b) & 1)) continue; const i = j * 8 + b; if (i >= acc.N) break;
      const ia = (i / nQ) | 0, iq = i - ia * nQ;
      if (kPrev >= 0 && !near(kPrev, ia, iq)) continue;
      if (kNext >= 0 && !near(kNext, ia, iq)) continue;
      S.push(i);
    }
  }
  const out = [];
  if (!S.length) return out;
  const St = W.St, Rm = W.Rm, lab = W.lab;
  for (const i of S) St[i] = 1;
  const touched = [];
  const rm = (i) => { if (!Rm[i]) { Rm[i] = 1; touched.push(i); } };
  // 2) длинные прямые серии вдоль осей (≥ 0,5 м, разрыв до 3 клеток) — стены, перегородки, мебель; полоса ±2 клетки
  const LR = Math.round(0.5 / cell);
  const markQ = (ia, s, e) => { for (let iq = s; iq <= e; iq++) for (let d = -2; d <= 2; d++) { const a = ia + d; if (a >= 0 && a < nA) rm(a * nQ + iq); } };
  const markA = (iq, s, e) => { for (let ia = s; ia <= e; ia++) for (let d = -2; d <= 2; d++) { const q = iq + d; if (q >= 0 && q < nQ) rm(ia * nQ + q); } };
  { let ra = -1, s = -1, last = -10;
    for (let t = 0; t <= S.length; t++) {
      const i = t < S.length ? S[t] : -1, ia = i >= 0 ? (i / nQ) | 0 : -2, iq = i >= 0 ? i - ia * nQ : 0;
      if (ia === ra && iq - last <= 4) { last = iq; continue; }
      if (ra >= 0 && last - s + 1 >= LR) markQ(ra, s, last);
      ra = ia; s = iq; last = iq;
    } }
  { const K = Float64Array.from(S, (i) => { const ia = (i / nQ) | 0; return (i - ia * nQ) * nA + ia; }).sort();
    let rq = -1, s = -1, last = -10;
    for (let t = 0; t <= K.length; t++) {
      const key = t < K.length ? K[t] : -1, iq = key >= 0 ? Math.floor(key / nA) : -2, ia = key >= 0 ? key - iq * nA : 0;
      if (iq === rq && ia - last <= 4) { last = ia; continue; }
      if (rq >= 0 && last - s + 1 >= LR) markA(rq, s, last);
      rq = iq; s = ia; last = ia;
    } }
  // 3) пятна (8-связность) и окружности
  const st = [], P = [], ids = [], lim = Math.round(0.45 / cell);
  for (const s0 of S) {
    if (Rm[s0] || lab[s0]) continue;
    const cells = []; st.length = 0; st.push(s0); lab[s0] = 1; let big = false;
    let ia0 = Infinity, ia1 = -1, iq0 = Infinity, iq1 = -1;
    while (st.length) {
      const c = st.pop(), ia = (c / nQ) | 0, iq = c - ia * nQ; cells.push(c);
      if (ia < ia0) ia0 = ia; if (ia > ia1) ia1 = ia; if (iq < iq0) iq0 = iq; if (iq > iq1) iq1 = iq;
      if (ia1 - ia0 > lim || iq1 - iq0 > lim) big = true;
      for (let da = -1; da <= 1; da++) for (let dq = -1; dq <= 1; dq++) {
        const a = ia + da, q = iq + dq; if (a < 0 || q < 0 || a >= nA || q >= nQ) continue;
        const c2 = a * nQ + q; if (!St[c2] || Rm[c2] || lab[c2]) continue; lab[c2] = 1; st.push(c2);
      }
    }
    for (const c of cells) touched.push(c);
    const nn = cells.length; if (big || nn < 6) continue;
    P.length = 0; ids.length = 0;
    cells.forEach((c, t) => { const ia = (c / nQ) | 0, iq = c - ia * nQ; P.push((ia + 0.5) * cell, (iq + 0.5) * cell); ids.push(t); });
    // окружность не меньше 5 клеток в диаметре (меньше — не отличить от шума, уступов и углов стен)
    const f = C.circleLS(P, ids); if (!f || f.r < Math.max(0.008, 2.5 * cell) || f.r > 0.17) continue;
    let e2 = 0; const ang = [];
    for (const t of ids) { const dx = P[t * 2] - f.cx, dy = P[t * 2 + 1] - f.cy, d = Math.hypot(dx, dy); e2 += (d - f.r) * (d - f.r); ang.push(Math.atan2(dy, dx)); }
    const rms = Math.sqrt(e2 / nn); if (rms > Math.max(0.45 * cell, 0.12 * f.r)) continue;
    ang.sort((x, y) => x - y); let gap = ang[0] + 2 * Math.PI - ang[ang.length - 1], aS = ang[0], aE = ang[ang.length - 1]; for (let t = 1; t < ang.length; t++) if (ang[t] - ang[t - 1] > gap) { gap = ang[t] - ang[t - 1]; aS = ang[t]; aE = ang[t - 1]; }
    // дуга от 150° (труба видна хотя бы с одной стороны целиком); скругление угла стены — четверть окружности — не стояк
    if (2 * Math.PI - gap < 2.6) continue;
    const ext = Math.max(ia1 - ia0 + 1, iq1 - iq0 + 1) * cell; if (ext > 2 * f.r + 3 * cell || ext < f.r) continue;
    // дуга с продолжением по касательной с обоих концов — скруглённый участок стены или витража, не труба
    if (2 * Math.PI - gap < 6.0) {
      const occ = (x, y) => { const ia = Math.floor(x / cell), iq = Math.floor(y / cell); for (let da = -1; da <= 1; da++) for (let dq = -1; dq <= 1; dq++) { const a2 = ia + da, q2 = iq + dq; if (a2 >= 0 && q2 >= 0 && a2 < nA && q2 < nQ && St[a2 * nQ + q2]) return 1; } return 0; };
      const cont = (an, sg) => { const ex = f.cx + f.r * Math.cos(an), ey = f.cy + f.r * Math.sin(an), tx = sg * Math.sin(an), ty = -sg * Math.cos(an); let c = 0; for (let t = 2; t <= 4; t++) c += occ(ex + tx * t * cell, ey + ty * t * cell); return c >= 2; };
      if (cont(aS, 1) && cont(aE, -1)) continue;
    }
    // прямоугольный профиль (стойка стеллажа, коробка двери): почти все клетки на сторонах рамки
    if (f.r >= 3 * cell) { let e = 0; cells.forEach((c) => { const ia = (c / nQ) | 0, iq = c - ia * nQ; if (ia <= ia0 || ia >= ia1 || iq <= iq0 || iq >= iq1) e++; }); if (e / nn > 0.85) continue; }
    out.push({ a: f.cx, q: f.cy, r: f.r, rms, n: nn });
  }
  for (const i of S) St[i] = 0;
  for (const i of touched) { Rm[i] = 0; lab[i] = 0; }
  return out;
}

function riserFind(acc, opts) {
  opts = opts || {};
  const out = [], { cell, slab } = acc, N = acc.N;
  if (!acc.zones.length) return out;
  const W = { S: [], St: new Uint8Array(N), Rm: new Uint8Array(N), lab: new Uint8Array(N) };
  const minLen = opts.minLen || 1.2;
  acc.zones.forEach((z, zi) => {
    const tracks = [], done = [];
    for (let k = 0; k < z.nk; k++) {
      const gk = z.k0 + k, dets = riserSlab(acc, gk, k > 0 ? gk - 1 : -1, k < z.nk - 1 ? gk + 1 : -1, W);
      const cand = [];
      tracks.forEach((t, ti) => {
        const gap = k - t.k1; if (gap > 3) return;
        dets.forEach((d, di) => {
          const L = t.hits[t.hits.length - 1], dd = Math.hypot(d.a - L.a, d.q - L.q);
          if (dd > 0.03 + 0.015 * (gap - 1)) return;
          if (Math.abs(d.r - t.rm) > Math.max(0.012, 0.35 * t.rm)) return;
          cand.push({ ti, di, s: dd });
        });
      });
      cand.sort((p, q) => p.s - q.s);
      const uT = new Set(), uD = new Set();
      cand.forEach((c) => { if (uT.has(c.ti) || uD.has(c.di)) return; uT.add(c.ti); uD.add(c.di); const t = tracks[c.ti], d = dets[c.di]; d.k = k; t.hits.push(d); t.k1 = k; t.rm += (d.r - t.rm) / t.hits.length; });
      dets.forEach((d, di) => { if (uD.has(di)) return; d.k = k; tracks.push({ k0: k, k1: k, hits: [d], rm: d.r }); });
      for (let i = tracks.length - 1; i >= 0; i--) if (k - tracks[i].k1 > 3) { done.push(tracks[i]); tracks.splice(i, 1); }
    }
    done.push.apply(done, tracks);
    done.forEach((t) => {
      const span = (t.k1 - t.k0 + 1) * slab;
      // стояк проходит этаж: видим не меньше чем на 60 % высоты зоны (уступы и скругления стен дают короткие обрывки)
      if (span < minLen || t.hits.length < Math.max(4, 0.55 * (t.k1 - t.k0 + 1)) || t.k1 - t.k0 + 1 < (opts.minFrac || 0.6) * z.nk) return;
      const H = t.hits, a = C.median(H.map((d) => d.a)), q = C.median(H.map((d) => d.q)), r = C.median(H.map((d) => d.r));
      // ось не должна «плыть»: разброс центров меньше радиуса
      const sd = Math.sqrt(H.reduce((s, d) => s + (d.a - a) * (d.a - a) + (d.q - q) * (d.q - q), 0) / H.length);
      if (sd > Math.max(0.6 * cell, 0.35 * r)) return;
      const A = acc.a0 + a, Q = acc.q0 + q, x = A * acc.ca - Q * acc.sa, y = A * acc.sa + Q * acc.ca;
      const zb = z.h0 + t.k0 * slab, zt = z.h0 + (t.k1 + 1) * slab;
      const el = { kind: 'pipe', riser: true, storey: z.storey, axis: null, path: [[x, y, zb], [x, y, zt]].map((p) => p.map((v) => Math.round(v * 1000) / 1000)), length: Math.round((zt - zb) * 100) / 100, hits: H.length, points: H.reduce((s, d) => s + d.n, 0) };
      const d = 2 * r; el.d = Math.round(d * 1000) / 1000; const s = snapDN(d); if (s) { el.dn = s.dn; el.dNom = s.d; }
      el.rms = Math.round(C.median(H.map((x) => x.rms)) * 10000) / 10000;
      let TT = 0, RR = 0, GG = 0; const rc = Math.ceil((r + 0.02) / acc.cc), ca0 = Math.floor(a / acc.cc), cq0 = Math.floor(q / acc.cc);
      for (let i = ca0 - rc; i <= ca0 + rc; i++) for (let j = cq0 - rc; j <= cq0 + rc; j++) { if (i < 0 || j < 0 || i >= acc.ncA || j >= acc.ncQ) continue; const ci = zi * acc.NC + i * acc.ncQ + j; TT += acc.T[ci]; RR += acc.R[ci]; GG += acc.Gr[ci]; }
      el.color = TT >= 10 ? (RR / TT >= 0.3 ? 'red' : (GG / TT >= 0.3 ? 'green' : 'gray')) : null;
      out.push(el);
    });
  });
  return out;
}

// ================================================================ ревизия 41: соединение трасс — слияние, отводы, тройники, переходы
const v3 = (a, b) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
const nrm = (d) => { const L = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / L, d[1] / L, d[2] / L]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addS = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
const r3 = (p) => p.map((x) => Math.round(x * 1000) / 1000);
function plen(P) { let s = 0; for (let i = 1; i < P.length; i++) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]); return s; }
// ближайшие точки двух прямых P + s·u и Q + t·v (u, v — единичные): { s, t, dist } или null для параллельных
function lineLine(P, u, Q, v) {
  const w = v3(Q, P), b = dot(u, v), d = dot(u, w), e = dot(v, w), den = 1 - b * b;
  if (den < 1e-6) return null;
  const s = (b * e - d) / den, t = (e - b * d) / den, X = addS(P, u, s), Y = addS(Q, v, t);
  return { s, t, dist: Math.hypot(X[0] - Y[0], X[1] - Y[1], X[2] - Y[2]), X, Y };
}
function mepConnect(list, opts) {
  opts = opts || {};
  const els = list.map((e) => Object.assign({}, e, { path: e.path.map((p) => p.slice()) }));
  const size = (e) => e.d || e.w || 0.05;
  const conn = (e) => e.kind === 'pipe' || e.kind === 'tray' || e.kind === 'duct' || e.kind === 'cable';
  // конец трассы: точка и направление наружу
  const endOf = (e, k) => { const P = e.path, n = P.length; if (n < 2) return null; const p = k ? P[n - 1] : P[0], q = k ? P[n - 2] : P[1]; return { p, u: nrm(v3(q, p)) }; };
  const same = (a, b) => a !== b && !a.dead && !b.dead && a.storey === b.storey && a.kind === b.kind && conn(a);
  const ratio = (a, b) => Math.max(size(a), size(b)) / Math.max(1e-3, Math.min(size(a), size(b)));
  // соосность: направления навстречу, разрыв −0,5…3 м вдоль оси, боковое смещение до 40 % размера (не меньше 3 см)
  const coax = (a, ka, b, kb, gmax) => {
    const A = endOf(a, ka), B = endOf(b, kb); if (!A || !B) return null;
    if (dot(A.u, B.u) > -0.985) return null;
    const w = v3(A.p, B.p), g = dot(w, A.u), lat = Math.hypot(w[0] - A.u[0] * g, w[1] - A.u[1] * g, w[2] - A.u[2] * g);
    if (g < -1.0 || g > gmax || lat > Math.max(0.03, 0.4 * Math.min(size(a), size(b)))) return null;
    // перекрытие длиннее 10 см — только у обрывков одной оси (почти нулевое смещение)
    if (g < -0.1 && lat > Math.max(0.02, 0.2 * Math.min(size(a), size(b)))) return null;
    return { g, lat, A, B };
  };
  const mergeR = (a, b) => (a.kind === 'pipe' && (a.color === 'red' || a.fromFlat || b.fromFlat) && a.color === b.color) ? 1.6 : 1.25;
  const used = new Map(); // элемент → [занят ли конец 0, конец 1]
  const isUsed = (e, k) => (used.get(e) || [0, 0])[k];
  const setUsed = (e, k) => { const u = used.get(e) || [0, 0]; u[k] = 1; used.set(e, u); };
  let merges = 0;
  // 1) слияние соосных обрывков одной трассы (тот же размер) — жадно по качеству, повтор, пока сливается
  for (let pass = 0; pass < 2000; pass++) {
    const cand = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j]; if (!same(a, b) || ratio(a, b) > mergeR(a, b)) continue;
      if (a.riser !== b.riser) continue;
      for (let ka = 0; ka < 2; ka++) for (let kb = 0; kb < 2; kb++) { const c = coax(a, ka, b, kb, 3.0); if (c) cand.push({ a, ka, b, kb, c, s: Math.max(0, c.g) + 3 * c.lat }); }
    }
    if (!cand.length) break;
    cand.sort((x, y) => x.s - y.s);
    const touched = new Set(); let n = 0;
    cand.forEach((m) => {
      if (touched.has(m.a) || touched.has(m.b) || m.a.dead || m.b.dead) return;
      touched.add(m.a); touched.add(m.b);
      const PA = m.ka ? m.a.path : m.a.path.slice().reverse(), PB = m.kb ? m.b.path.slice().reverse() : m.b.path, ua = m.c.A.u, pa = m.c.A.p;
      // точки второго обрывка дальше конца первого (перекрытие отбрасывается)
      const rest = PB.filter((p) => dot(v3(pa, p), ua) > 0.02);
      const path = PA.concat(rest.length ? rest : [PB[PB.length - 1]]);
      const la = m.a.length || plen(m.a.path), lb = m.b.length || plen(m.b.path);
      const e = m.a;
      e.path = dp(path, 0.025).map(r3); e.length = Math.round(plen(e.path) * 100) / 100;
      e.hits = (m.a.hits || 0) + (m.b.hits || 0); e.points = (m.a.points || 0) + (m.b.points || 0);
      if (e.d && m.b.d) { e.d = Math.round((m.a.d * la + m.b.d * lb) / (la + lb) * 1000) / 1000; if (e.kind === 'pipe') { const s = snapDN(e.d); if (s) { e.dn = s.dn; e.dNom = s.d; } else { delete e.dn; delete e.dNom; } } }
      if (e.w && m.b.w) { e.w = Math.round((m.a.w * la + m.b.w * lb) / (la + lb) * 1000) / 1000; e.hgt = Math.round(((m.a.hgt || 0) * la + (m.b.hgt || 0) * lb) / (la + lb) * 1000) / 1000; }
      if (lb > la) e.color = m.b.color;
      if (m.a.cover != null && m.b.cover != null) e.cover = Math.round((m.a.cover * la + m.b.cover * lb) / (la + lb) * 100) / 100;
      e.gaps = (m.a.gaps || 0) + (m.b.gaps || 0) + 1; e.merged = (m.a.merged || 1) + (m.b.merged || 1);
      m.b.dead = true; n++; merges++;
    });
    if (!n) break;
  }
  const alive = els.filter((e) => !e.dead), fittings = [];
  const setEnd = (e, k, X, s) => { const P = e.path; if (s < 0.01 && P.length >= 2) { if (k) P[P.length - 1] = r3(X); else P[0] = r3(X); } else if (k) P.push(r3(X)); else P.unshift(r3(X)); e.length = Math.round(plen(P) * 100) / 100; };
  const fit = (type, host, a, b, X, parts, extra) => fittings.push(Object.assign({ kind: 'fitting', type, host: host.kind, storey: host.storey, d: host.d, w: host.w, hgt: host.hgt, color: host.color, at: r3(X), parts: parts.map((p) => p.map(r3)), links: [a, b] }, extra || {}));
  // 2) переходы: соосные концы разного размера (до 2,3 раза), разрыв до 0,8 м
  const tc = [];
  for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
    const a = alive[i], b = alive[j]; if (!same(a, b) || a.kind === 'cable' || ratio(a, b) > 2.3) continue;
    for (let ka = 0; ka < 2; ka++) for (let kb = 0; kb < 2; kb++) { const c = coax(a, ka, b, kb, 0.8); if (c && c.g >= -0.1) tc.push({ a, ka, b, kb, c, s: c.g + 3 * c.lat }); }
  }
  tc.sort((x, y) => x.s - y.s);
  tc.forEach((m) => {
    if (isUsed(m.a, m.ka) || isUsed(m.b, m.kb)) return; setUsed(m.a, m.ka); setUsed(m.b, m.kb);
    const big = size(m.a) >= size(m.b) ? m.a : m.b, X = addS(m.c.A.p, m.c.A.u, Math.max(0, m.c.g) / 2);
    const L = Math.max(0.05, Math.max(0, m.c.g));
    fit('transition', big, m.a, m.b, X, [[m.c.A.p, addS(m.c.A.p, m.c.A.u, L)]], { d0: size(m.a), d1: size(m.b) });
  });
  // 3) отводы: два свободных конца, оси пересекаются (поворот 25–120°) рядом с обоими концами
  const ec = [];
  for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
    const a = alive[i], b = alive[j]; if (!same(a, b) || a.kind === 'cable' || ratio(a, b) > 1.6) continue;
    const m = Math.max(size(a), size(b)), reach = Math.max(0.5, 4 * m), tol = Math.max(0.04, 0.5 * m);
    for (let ka = 0; ka < 2; ka++) for (let kb = 0; kb < 2; kb++) {
      const A = endOf(a, ka), B = endOf(b, kb); if (!A || !B) continue;
      const cs = dot(A.u, B.u); if (cs < -0.906 || cs > 0.5) continue;
      const ll = lineLine(A.p, A.u, B.p, B.u); if (!ll || ll.dist > tol || ll.s < -0.1 || ll.t < -0.1 || ll.s > reach || ll.t > reach) continue;
      ec.push({ a, ka, b, kb, A, B, ll, s: ll.s + ll.t + 3 * ll.dist });
    }
  }
  ec.sort((x, y) => x.s - y.s);
  ec.forEach((m) => {
    if (isUsed(m.a, m.ka) || isUsed(m.b, m.kb)) return; setUsed(m.a, m.ka); setUsed(m.b, m.kb);
    const X = [(m.ll.X[0] + m.ll.Y[0]) / 2, (m.ll.X[1] + m.ll.Y[1]) / 2, (m.ll.X[2] + m.ll.Y[2]) / 2];
    setEnd(m.a, m.ka, X, m.ll.s); setEnd(m.b, m.kb, X, m.ll.t);
    const host = size(m.a) >= size(m.b) ? m.a : m.b, L = Math.max(0.08, 1.5 * size(host));
    fit('elbow', host, m.a, m.b, X, [[addS(X, m.A.u, -L), X, addS(X, m.B.u, -L)]], { angle: Math.round(Math.acos(Math.max(-1, Math.min(1, -dot(m.A.u, m.B.u)))) * 180 / Math.PI) });
  });
  // 4) тройники: свободный конец упирается в середину другой трассы (ответвление под углом от 45°)
  alive.forEach((a) => {
    if (a.kind === 'cable') return;
    for (let ka = 0; ka < 2; ka++) {
      if (isUsed(a, ka)) continue;
      const A = endOf(a, ka); if (!A) continue;
      let best = null;
      alive.forEach((b) => {
        if (!same(a, b) || size(b) < 0.6 * size(a)) return;
        const m = Math.max(size(a), size(b)), reach = Math.max(0.5, 4 * m), tol = Math.max(0.04, 0.5 * m);
        for (let i = 1; i < b.path.length; i++) {
          const S0 = b.path[i - 1], S1 = b.path[i], Ls = Math.hypot(S1[0] - S0[0], S1[1] - S0[1], S1[2] - S0[2]); if (Ls < 0.05) continue;
          const v = nrm(v3(S0, S1)); if (Math.abs(dot(A.u, v)) > 0.7) continue;
          const ll = lineLine(A.p, A.u, S0, v); if (!ll || ll.dist > tol || ll.s < -0.1 || ll.s > reach) continue;
          const mg = Math.max(0.5 * size(a), 0.05); if (ll.t < mg || ll.t > Ls - mg) continue;
          const sc = ll.s + 3 * ll.dist; if (!best || sc < best.sc) best = { b, ll, v, sc };
        }
      });
      if (!best) continue;
      setUsed(a, ka);
      const X = best.ll.Y; setEnd(a, ka, X, best.ll.s);
      const L = Math.max(0.08, 1.5 * size(best.b));
      fit('tee', best.b, best.b, a, X, [[addS(X, best.v, -L), addS(X, best.v, L)], [X, addS(X, A.u, -L)]]);
    }
  });
  return { list: alive, fittings, merges };
}

module.exports = { axesFrom, mepAcc, mepFind, analyseBlob, slabMask, blobs, snapDN, dp, DN, covered, ladderTrays, riserAcc, riserSlab, riserFind, mepConnect, lineLine };
